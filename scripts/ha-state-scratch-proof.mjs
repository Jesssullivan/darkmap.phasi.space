#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PackageError,
	fixture as endpointPackageFixture,
	loadPackage,
	validateEndpointPackage,
} from './ha-state-endpoint-package-check.mjs';

const OPTIONAL_SESSION_TOKEN_ENV = 'TOFU_HA_STATE_SESSION_TOKEN';
const DEFAULT_PHASE = 'baseline';
const DISPOSABLE_TOFU_PREFIX = 'darkmap-ha-state-proof/disposable-tofu';
const PROTECTED_BUCKETS = new Set(['tofu-state']);
const PROTECTED_KEY_TERMS = ['terraform.tfstate', 'spokes/darkmap', 'darkmap-tinyland-dev'];
const PROTECTED_DISPOSABLE_KEY_TERMS = ['spokes/darkmap', 'darkmap-tinyland-dev'];
const TOFU_ACCESS_ENV = ['AWS', 'ACCESS', 'KEY', 'ID'].join('_');
const TOFU_SIGNING_ENV = ['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_');
const TOFU_SESSION_ENV = ['AWS', 'SESSION', 'TOKEN'].join('_');

class ProofError extends Error {}

const usage = () => {
	console.error(`usage:
  node ${basename(fileURLToPath(import.meta.url))} --endpoint-package <path> [--phase <name>] [--checkpoint-file <path>]
  node ${basename(fileURLToPath(import.meta.url))} --endpoint-package <path> --run-disposable-tofu --use-lockfile [--phase <name>] [--checkpoint-file <path>]
  node ${basename(fileURLToPath(import.meta.url))} --endpoint-package <path> --dry-run
  node ${basename(fileURLToPath(import.meta.url))} --self-test

Runtime credentials are read from the endpoint package credential_injection
environment names. Optional session credentials use ${OPTIONAL_SESSION_TOKEN_ENV}.`);
};

const requireArgValue = (argv, index, arg) => {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new ProofError(`${arg} requires a value`);
	}
	return value;
};

const parseArgs = (argv) => {
	const parsed = {
		checkpointFile: undefined,
		dryRun: false,
		endpointPackage: undefined,
		keepScratchObject: false,
		phase: DEFAULT_PHASE,
		runDisposableTofu: false,
		selfTest: false,
		useLockfile: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--endpoint-package') {
			parsed.endpointPackage = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--checkpoint-file') {
			parsed.checkpointFile = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--phase') {
			parsed.phase = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (arg === '--self-test') {
			parsed.selfTest = true;
		} else if (arg === '--keep-scratch-object') {
			parsed.keepScratchObject = true;
		} else if (arg === '--keep-scratch-bucket') {
			// The scratch proof does not create or delete buckets. Accept this
			// flag so the candidate-proof command can keep a stable contract.
		} else if (arg === '--use-lockfile') {
			parsed.useLockfile = true;
		} else if (arg === '--run-disposable-tofu') {
			parsed.runDisposableTofu = true;
		} else {
			throw new ProofError(`unknown argument: ${arg}`);
		}
	}

	if (!parsed.selfTest && !parsed.endpointPackage) {
		throw new ProofError('--endpoint-package is required');
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(parsed.phase)) {
		throw new ProofError('--phase must be an alphanumeric label with optional dot, underscore, or dash');
	}
	if (parsed.runDisposableTofu && !parsed.useLockfile) {
		throw new ProofError('--run-disposable-tofu requires --use-lockfile for the #144 lockfile proof');
	}
	return parsed;
};

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const hmacHex = (key, value) => createHmac('sha256', key).update(value).digest('hex');
const encodeRfc3986 = (value) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const normalizeHeaderValue = (value) => String(value).trim().replace(/\s+/g, ' ');

const signingKey = ({ signingMaterial, dateStamp, region }) => {
	const kDate = hmac(`AWS4${signingMaterial}`, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, 's3');
	return hmac(kService, 'aws4_request');
};

const buildPath = (endpointPath, bucket, key) => {
	const base = endpointPath && endpointPath !== '/' ? endpointPath.replace(/\/+$/g, '') : '';
	if (!bucket) {
		return base || '/';
	}
	const keySegments = key ? key.split('/').filter(Boolean) : [];
	const suffix = [bucket, ...keySegments].map(encodeRfc3986).join('/');
	return `${base}/${suffix}`;
};

const signRequest = ({ accessId, body = '', endpoint, method, path, region, sessionToken, signingMaterial }) => {
	const payloadHash = sha256Hex(body);
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	const dateStamp = amzDate.slice(0, 8);
	const headers = {
		host: endpoint.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': amzDate,
	};
	if (sessionToken) {
		headers['x-amz-security-token'] = sessionToken;
	}

	const headerEntries = Object.entries(headers)
		.map(([key, value]) => [key.toLowerCase(), normalizeHeaderValue(value)])
		.sort(([left], [right]) => left.localeCompare(right));
	const canonicalHeaders = headerEntries.map(([key, value]) => `${key}:${value}\n`).join('');
	const signedHeaders = headerEntries.map(([key]) => key).join(';');
	const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
	const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
	const signature = hmacHex(signingKey({ signingMaterial, dateStamp, region }), stringToSign);

	return {
		...Object.fromEntries(headerEntries),
		authorization: `AWS4-HMAC-SHA256 Credential=${accessId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
};

const s3Request = async ({ body = '', bucket, config, key, method }) => {
	const endpoint = new URL(config.endpointUrl);
	const path = buildPath(endpoint.pathname, bucket, key);
	endpoint.pathname = path;
	endpoint.search = '';
	const headers = signRequest({
		accessId: config.accessId,
		body,
		endpoint,
		method,
		path,
		region: config.region,
		sessionToken: config.sessionToken,
		signingMaterial: config.signingMaterial,
	});

	const response = await fetch(endpoint, {
		body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : body,
		headers,
		method,
		redirect: 'manual',
	});
	const text = method === 'HEAD' ? '' : await response.text();
	return {
		body: text,
		contentLength: response.headers.get('content-length'),
		path,
		status: response.status,
		statusText: response.statusText,
	};
};

const requireOk = (step, response) => {
	if (response.status < 200 || response.status > 299) {
		throw new ProofError(`${step} failed with HTTP ${response.status} ${response.statusText}`);
	}
};

const rejectUnsafeScratchTarget = (bucket, key) => {
	if (PROTECTED_BUCKETS.has(bucket)) {
		throw new ProofError(`scratch bucket must not be protected bucket ${bucket}`);
	}
	const target = `${bucket}/${key}`.toLowerCase();
	for (const term of PROTECTED_KEY_TERMS) {
		if (target.includes(term)) {
			throw new ProofError(`scratch target must not include protected state term ${term}`);
		}
	}
};

const rejectUnsafeDisposableTarget = (bucket, key) => {
	if (PROTECTED_BUCKETS.has(bucket)) {
		throw new ProofError(`disposable backend bucket must not be protected bucket ${bucket}`);
	}
	if (!key.startsWith(`${DISPOSABLE_TOFU_PREFIX}/`) || !key.endsWith('/terraform.tfstate')) {
		throw new ProofError(`disposable backend key must stay under ${DISPOSABLE_TOFU_PREFIX}/.../terraform.tfstate`);
	}
	const target = `${bucket}/${key}`.toLowerCase();
	for (const term of PROTECTED_DISPOSABLE_KEY_TERMS) {
		if (target.includes(term)) {
			throw new ProofError(`disposable backend key must not include protected state term ${term}`);
		}
	}
};

const resolveRuntimeConfig = (pkg, env, { requireCredentials }) => {
	const injection = pkg.credential_injection;
	const endpointUrl = env[injection.endpoint_env] || pkg.endpoint_url;
	const region = env[injection.region_env] || pkg.region;

	if (env[injection.endpoint_env] && env[injection.endpoint_env] !== pkg.endpoint_url) {
		throw new ProofError(`${injection.endpoint_env} must match endpoint_url from the endpoint package`);
	}
	if (env[injection.region_env] && env[injection.region_env] !== pkg.region) {
		throw new ProofError(`${injection.region_env} must match region from the endpoint package`);
	}

	const accessId = env[injection.access_key_env];
	const signingMaterial = env[injection.secret_key_env];
	if (requireCredentials && (!accessId || !signingMaterial)) {
		throw new ProofError(`missing proof credentials; set ${injection.access_key_env} and ${injection.secret_key_env}`);
	}

	return {
		accessId: accessId || 'dry-run-access-id',
		endpointUrl,
		region,
		sessionToken: env[OPTIONAL_SESSION_TOKEN_ENV] || '',
		signingMaterial: signingMaterial || 'dry-run-signing-material',
	};
};

const checkpointBase = ({ args, objectKey, packagePath, pkg }) => ({
	checkpoint_schema: 'darkmap.ha_state_scratch_proof.v1',
	issue: 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/142',
	package_name: pkg.name,
	package_path: packagePath,
	phase: args.phase,
	scratch_bucket: pkg.scratch_bucket,
	scratch_object_key: objectKey,
	started_at: new Date().toISOString(),
	steps: [],
	use_lockfile_requested: args.useLockfile,
});

const writeCheckpoint = (path, checkpoint) => {
	if (!path) {
		return;
	}
	writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
};

const recordCommand = (checkpoint, name, result, ok = result.status === 0) => {
	checkpoint.steps.push({
		name,
		ok,
		exit_code: result.status,
		signal: result.signal,
	});
};

const runTofuCommand = ({ args, cwd, env, expectedExitCodes = [0], name }) => {
	const result = spawnSync('tofu', args, {
		cwd,
		encoding: 'utf8',
		env,
		maxBuffer: 2 * 1024 * 1024,
	});
	if (result.error) {
		throw new ProofError(`${name} failed to start: ${result.error.message}`);
	}
	if (!expectedExitCodes.includes(result.status)) {
		throw new ProofError(`${name} failed with exit code ${result.status}`);
	}
	return result;
};

const runScratchProof = async ({ args, packagePath, pkg }) => {
	const config = resolveRuntimeConfig(pkg, process.env, { requireCredentials: !args.dryRun });
	const objectKey = `darkmap-ha-state-proof/${args.phase}/${new Date()
		.toISOString()
		.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
	rejectUnsafeScratchTarget(pkg.scratch_bucket, objectKey);

	const checkpoint = checkpointBase({ args, objectKey, packagePath, pkg });
	const body = JSON.stringify({
		issue: 142,
		nonce: randomUUID(),
		package_name: pkg.name,
		phase: args.phase,
		written_at: new Date().toISOString(),
	});

	const record = (name, response, ok = true) => {
		checkpoint.steps.push({
			name,
			ok,
			path: response?.path,
			status: response?.status,
			status_text: response?.statusText,
		});
	};

	if (args.dryRun) {
		checkpoint.completed_at = new Date().toISOString();
		checkpoint.result = 'dry_run';
		writeCheckpoint(args.checkpointFile, checkpoint);
		console.log(`PASS: HA state scratch proof dry run for ${pkg.scratch_bucket}`);
		console.log(`required_access_key_env=${pkg.credential_injection.access_key_env}`);
		console.log(`required_secret_key_env=${pkg.credential_injection.secret_key_env}`);
		return checkpoint;
	}

	let putSucceeded = false;
	try {
		const listBuckets = await s3Request({ config, method: 'GET' });
		record('list-buckets', listBuckets);
		requireOk('list-buckets', listBuckets);
		if (!listBuckets.body.includes(`<Name>${pkg.scratch_bucket}</Name>`)) {
			throw new ProofError(`list-buckets did not include scratch bucket ${pkg.scratch_bucket}`);
		}

		const headBucket = await s3Request({ bucket: pkg.scratch_bucket, config, method: 'HEAD' });
		record('head-bucket', headBucket);
		requireOk('head-bucket', headBucket);

		const putObject = await s3Request({
			body,
			bucket: pkg.scratch_bucket,
			config,
			key: objectKey,
			method: 'PUT',
		});
		record('put-object', putObject);
		requireOk('put-object', putObject);
		putSucceeded = true;

		const headObject = await s3Request({ bucket: pkg.scratch_bucket, config, key: objectKey, method: 'HEAD' });
		record('head-object', headObject);
		requireOk('head-object', headObject);

		const getObject = await s3Request({ bucket: pkg.scratch_bucket, config, key: objectKey, method: 'GET' });
		record('get-object', getObject);
		requireOk('get-object', getObject);
		if (getObject.body !== body) {
			throw new ProofError('get-object body did not match the scratch proof payload');
		}

		const deleteObject = await s3Request({ bucket: pkg.scratch_bucket, config, key: objectKey, method: 'DELETE' });
		record('delete-object', deleteObject);
		requireOk('delete-object', deleteObject);
		putSucceeded = false;

		const headAfterDelete = await s3Request({
			bucket: pkg.scratch_bucket,
			config,
			key: objectKey,
			method: 'HEAD',
		});
		record('head-object-after-delete', headAfterDelete, headAfterDelete.status === 404);
		if (headAfterDelete.status !== 404) {
			throw new ProofError(`head-object-after-delete expected HTTP 404, got HTTP ${headAfterDelete.status}`);
		}

		checkpoint.completed_at = new Date().toISOString();
		checkpoint.result = 'passed';
		console.log(`PASS: HA state scratch proof ${args.phase} for bucket ${pkg.scratch_bucket}`);
		return checkpoint;
	} finally {
		if (putSucceeded && !args.keepScratchObject) {
			try {
				const cleanup = await s3Request({
					bucket: pkg.scratch_bucket,
					config,
					key: objectKey,
					method: 'DELETE',
				});
				record('cleanup-delete-object', cleanup, cleanup.status >= 200 && cleanup.status <= 299);
			} catch (error) {
				checkpoint.cleanup_error = error instanceof Error ? error.message : String(error);
			}
		}
		if (!checkpoint.completed_at) {
			checkpoint.completed_at = new Date().toISOString();
			checkpoint.result = 'failed';
		}
		writeCheckpoint(args.checkpointFile, checkpoint);
	}
};

const hclString = (value) => JSON.stringify(value);

const renderDisposableBackendConfig = ({
	config,
	pkg,
	stateKey,
	useLockfile,
}) => `bucket                      = ${hclString(pkg.scratch_bucket)}
key                         = ${hclString(stateKey)}
region                      = ${hclString(config.region)}
endpoint                    = ${hclString(config.endpointUrl)}
use_path_style              = true
skip_credentials_validation = true
skip_region_validation      = true
skip_metadata_api_check     = true
skip_requesting_account_id  = true
skip_s3_checksum            = true
use_lockfile                = ${useLockfile ? 'true' : 'false'}
`;

const disposableMainTf = `terraform {
  required_version = ">= 1.6.0"
  backend "s3" {}
}

variable "proof_nonce" {
  type = string
}

variable "proof_phase" {
  type = string
}

output "proof_nonce" {
  value = var.proof_nonce
}

output "proof_phase" {
  value = var.proof_phase
}

output "proof_stack" {
  value = "darkmap-ha-state-disposable"
}
`;

const disposableCheckpointBase = ({ args, packagePath, pkg, stateKey }) => ({
	checkpoint_schema: 'darkmap.ha_state_disposable_tofu_proof.v1',
	issue: 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/144',
	package_name: pkg.name,
	package_path: packagePath,
	phase: args.phase,
	scratch_bucket: pkg.scratch_bucket,
	started_at: new Date().toISOString(),
	steps: [],
	state_key: stateKey,
	use_lockfile_requested: args.useLockfile,
});

const makeDisposableTofuEnv = (config, dataDir) => {
	const env = {
		...process.env,
		[TOFU_ACCESS_ENV]: config.accessId,
		[TOFU_SIGNING_ENV]: config.signingMaterial,
		TF_DATA_DIR: dataDir,
	};
	if (config.sessionToken) {
		env[TOFU_SESSION_ENV] = config.sessionToken;
	}
	return env;
};

const runDisposableTofuProof = async ({ args, packagePath, pkg }) => {
	const config = resolveRuntimeConfig(pkg, process.env, { requireCredentials: !args.dryRun });
	const stateKey = `${DISPOSABLE_TOFU_PREFIX}/${args.phase}/${new Date()
		.toISOString()
		.replace(/[:.]/g, '-')}-${randomUUID()}/terraform.tfstate`;
	const lockKey = `${stateKey}.tflock`;
	rejectUnsafeDisposableTarget(pkg.scratch_bucket, stateKey);

	const checkpoint = disposableCheckpointBase({ args, packagePath, pkg, stateKey });
	const recordS3 = (name, response, ok = true) => {
		checkpoint.steps.push({
			name,
			ok,
			path: response?.path,
			status: response?.status,
			status_text: response?.statusText,
		});
	};

	if (args.dryRun) {
		checkpoint.completed_at = new Date().toISOString();
		checkpoint.result = 'dry_run';
		checkpoint.steps.push(
			{ name: 'validate-disposable-backend-target', ok: true },
			{ name: 'render-disposable-tofu-config', ok: true },
			{ name: 'require-lockfile-config', ok: args.useLockfile },
		);
		writeCheckpoint(args.checkpointFile, checkpoint);
		console.log(`PASS: HA state disposable OpenTofu proof dry run for ${pkg.scratch_bucket}`);
		console.log(`state_key=${stateKey}`);
		return checkpoint;
	}

	const tmpRoot = mkdtempSync(join(tmpdir(), 'darkmap-ha-state-disposable-tofu-'));
	const tofuEnv = makeDisposableTofuEnv(config, join(tmpRoot, '.tofu-data'));
	const vars = ['-var', `proof_nonce=${randomUUID()}`, '-var', `proof_phase=${args.phase}`];
	let stateWasWritten = false;
	let lockWasWritten = false;
	let cleanupFailed = false;

	try {
		writeFileSync(
			join(tmpRoot, 'backend.hcl'),
			renderDisposableBackendConfig({ config, pkg, stateKey, useLockfile: args.useLockfile }),
		);
		writeFileSync(join(tmpRoot, 'main.tf'), disposableMainTf);
		checkpoint.steps.push({ name: 'render-disposable-tofu-config', ok: true });

		const init = runTofuCommand({
			args: ['init', '-input=false', '-backend-config=backend.hcl'],
			cwd: tmpRoot,
			env: tofuEnv,
			name: 'tofu-init',
		});
		recordCommand(checkpoint, 'tofu-init', init);

		const apply = runTofuCommand({
			args: ['apply', '-input=false', '-auto-approve', ...vars],
			cwd: tmpRoot,
			env: tofuEnv,
			name: 'tofu-apply-first-write',
		});
		stateWasWritten = true;
		recordCommand(checkpoint, 'tofu-apply-first-write', apply);

		const readOutput = runTofuCommand({
			args: ['output', '-json'],
			cwd: tmpRoot,
			env: tofuEnv,
			name: 'tofu-output-readback',
		});
		recordCommand(checkpoint, 'tofu-output-readback', readOutput);
		const outputs = JSON.parse(readOutput.stdout);
		if (outputs.proof_phase?.value !== args.phase || typeof outputs.proof_nonce?.value !== 'string') {
			throw new ProofError('tofu-output-readback did not contain expected disposable proof outputs');
		}

		const noOpPlan = runTofuCommand({
			args: ['plan', '-input=false', '-detailed-exitcode', ...vars],
			cwd: tmpRoot,
			env: tofuEnv,
			expectedExitCodes: [0],
			name: 'tofu-plan-no-op',
		});
		recordCommand(checkpoint, 'tofu-plan-no-op', noOpPlan);

		const lockBody = JSON.stringify({
			created_at: new Date().toISOString(),
			operation: 'darkmap-disposable-tofu-proof',
			path: `${pkg.scratch_bucket}/${stateKey}`,
		});
		const putLock = await s3Request({
			body: lockBody,
			bucket: pkg.scratch_bucket,
			config,
			key: lockKey,
			method: 'PUT',
		});
		lockWasWritten = true;
		recordS3('put-synthetic-lockfile', putLock);
		requireOk('put-synthetic-lockfile', putLock);

		const lockedPlan = runTofuCommand({
			args: ['plan', '-input=false', '-lock-timeout=1s', ...vars],
			cwd: tmpRoot,
			env: tofuEnv,
			expectedExitCodes: [1],
			name: 'tofu-plan-lock-contention',
		});
		recordCommand(checkpoint, 'tofu-plan-lock-contention', lockedPlan, true);

		const deleteLock = await s3Request({
			bucket: pkg.scratch_bucket,
			config,
			key: lockKey,
			method: 'DELETE',
		});
		lockWasWritten = false;
		recordS3('delete-synthetic-lockfile', deleteLock);
		requireOk('delete-synthetic-lockfile', deleteLock);

		const getState = await s3Request({ bucket: pkg.scratch_bucket, config, key: stateKey, method: 'GET' });
		recordS3('get-state-for-restore', getState);
		requireOk('get-state-for-restore', getState);
		if (!getState.body.includes('"version"') || !getState.body.includes('"outputs"')) {
			throw new ProofError('get-state-for-restore did not return an OpenTofu state-shaped object');
		}

		const deleteState = await s3Request({ bucket: pkg.scratch_bucket, config, key: stateKey, method: 'DELETE' });
		stateWasWritten = false;
		recordS3('delete-state-before-restore', deleteState);
		requireOk('delete-state-before-restore', deleteState);

		const headDeletedState = await s3Request({ bucket: pkg.scratch_bucket, config, key: stateKey, method: 'HEAD' });
		recordS3('head-state-after-delete', headDeletedState, headDeletedState.status === 404);
		if (headDeletedState.status !== 404) {
			throw new ProofError(`head-state-after-delete expected HTTP 404, got HTTP ${headDeletedState.status}`);
		}

		const restoreState = await s3Request({
			body: getState.body,
			bucket: pkg.scratch_bucket,
			config,
			key: stateKey,
			method: 'PUT',
		});
		stateWasWritten = true;
		recordS3('restore-state-object', restoreState);
		requireOk('restore-state-object', restoreState);

		const restoredNoOpPlan = runTofuCommand({
			args: ['plan', '-input=false', '-detailed-exitcode', ...vars],
			cwd: tmpRoot,
			env: tofuEnv,
			expectedExitCodes: [0],
			name: 'tofu-plan-after-restore',
		});
		recordCommand(checkpoint, 'tofu-plan-after-restore', restoredNoOpPlan);

		checkpoint.completed_at = new Date().toISOString();
		checkpoint.result = 'passed';
		console.log(`PASS: HA state disposable OpenTofu proof ${args.phase} for bucket ${pkg.scratch_bucket}`);
		return checkpoint;
	} finally {
		if (lockWasWritten) {
			try {
				const cleanupLock = await s3Request({
					bucket: pkg.scratch_bucket,
					config,
					key: lockKey,
					method: 'DELETE',
				});
				recordS3('cleanup-delete-lockfile', cleanupLock, cleanupLock.status >= 200 && cleanupLock.status <= 299);
				cleanupFailed = cleanupFailed || cleanupLock.status < 200 || cleanupLock.status > 299;
			} catch (error) {
				cleanupFailed = true;
				checkpoint.cleanup_error = error instanceof Error ? error.message : String(error);
			}
		}
		if (stateWasWritten && !args.keepScratchObject) {
			try {
				const cleanupState = await s3Request({
					bucket: pkg.scratch_bucket,
					config,
					key: stateKey,
					method: 'DELETE',
				});
				recordS3('cleanup-delete-state', cleanupState, cleanupState.status >= 200 && cleanupState.status <= 299);
				cleanupFailed = cleanupFailed || cleanupState.status < 200 || cleanupState.status > 299;
			} catch (error) {
				cleanupFailed = true;
				checkpoint.cleanup_error = error instanceof Error ? error.message : String(error);
			}
		}
		rmSync(tmpRoot, { force: true, recursive: true });
		if (!checkpoint.completed_at) {
			checkpoint.completed_at = new Date().toISOString();
			checkpoint.result = 'failed';
		} else if (checkpoint.result === 'passed' && cleanupFailed) {
			checkpoint.result = 'failed';
		}
		writeCheckpoint(args.checkpointFile, checkpoint);
	}
};

const withSelfTestProofEnv = async (pkg, run) => {
	const injection = pkg.credential_injection;
	const names = [
		injection.endpoint_env,
		injection.region_env,
		injection.access_key_env,
		injection.secret_key_env,
		OPTIONAL_SESSION_TOKEN_ENV,
	];
	const previous = new Map(names.map((name) => [name, process.env[name]]));
	process.env[injection.endpoint_env] = pkg.endpoint_url;
	process.env[injection.region_env] = pkg.region;
	delete process.env[injection.access_key_env];
	delete process.env[injection.secret_key_env];
	delete process.env[OPTIONAL_SESSION_TOKEN_ENV];

	try {
		return await run();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
};

const requireSelfTestThrow = (label, run) => {
	try {
		run();
	} catch (error) {
		if (error instanceof ProofError || error instanceof PackageError) {
			return;
		}
		throw error;
	}
	throw new ProofError(`self-test accepted invalid case: ${label}`);
};

const runSelfTest = async () => {
	const pkg = endpointPackageFixture();
	validateEndpointPackage({ source: JSON.stringify(pkg), value: pkg });
	const config = resolveRuntimeConfig(
		pkg,
		{
			TOFU_HA_STATE_ENDPOINT: pkg.endpoint_url,
			TOFU_HA_STATE_REGION: pkg.region,
		},
		{ requireCredentials: false },
	);
	if (config.endpointUrl !== pkg.endpoint_url || config.region !== pkg.region) {
		throw new ProofError('self-test failed to resolve package endpoint config');
	}
	rejectUnsafeScratchTarget(pkg.scratch_bucket, 'darkmap-ha-state-proof/baseline/proof.json');

	requireSelfTestThrow('protected tofu-state target', () =>
		rejectUnsafeScratchTarget('tofu-state', 'darkmap-tinyland-dev/terraform.tfstate'),
	);
	requireSelfTestThrow('protected state key term', () =>
		rejectUnsafeScratchTarget(pkg.scratch_bucket, 'spokes/darkmap/terraform.tfstate'),
	);
	requireSelfTestThrow('disposable tofu requires lockfile', () =>
		parseArgs(['--endpoint-package', 'endpoint-package.json', '--run-disposable-tofu']),
	);
	requireSelfTestThrow('missing phase value', () =>
		parseArgs(['--endpoint-package', 'endpoint-package.json', '--phase']),
	);
	rejectUnsafeDisposableTarget(
		pkg.scratch_bucket,
		`${DISPOSABLE_TOFU_PREFIX}/self-test/${randomUUID()}/terraform.tfstate`,
	);
	requireSelfTestThrow('disposable tofu rejects protected bucket', () =>
		rejectUnsafeDisposableTarget('tofu-state', `${DISPOSABLE_TOFU_PREFIX}/self-test/proof/terraform.tfstate`),
	);
	requireSelfTestThrow('disposable tofu rejects protected darkmap key', () =>
		rejectUnsafeDisposableTarget(pkg.scratch_bucket, `${DISPOSABLE_TOFU_PREFIX}/spokes/darkmap/terraform.tfstate`),
	);

	const tmpRoot = mkdtempSync(join(tmpdir(), 'darkmap-ha-state-scratch-proof-'));
	try {
		const checkpointFile = join(tmpRoot, 'checkpoint.json');
		const checkpoint = await withSelfTestProofEnv(pkg, () =>
			runScratchProof({
				args: {
					checkpointFile,
					dryRun: true,
					keepScratchObject: false,
					phase: 'self-test',
					useLockfile: false,
				},
				packagePath: 'self-test-endpoint-package.json',
				pkg,
			}),
		);
		const checkpointSource = readFileSync(checkpointFile, 'utf8');
		const checkpointValue = JSON.parse(checkpointSource);
		if (checkpoint.result !== 'dry_run' || checkpointValue.result !== 'dry_run') {
			throw new ProofError('self-test dry-run checkpoint did not record dry_run result');
		}
		if (
			checkpointSource.includes('dry-run-signing-material') ||
			checkpointSource.includes('dry-run-access-id') ||
			checkpointSource.includes(OPTIONAL_SESSION_TOKEN_ENV)
		) {
			throw new ProofError('self-test dry-run checkpoint leaked credential-shaped values');
		}
		const disposableCheckpointFile = join(tmpRoot, 'disposable-checkpoint.json');
		const disposableCheckpoint = await withSelfTestProofEnv(pkg, () =>
			runDisposableTofuProof({
				args: {
					checkpointFile: disposableCheckpointFile,
					dryRun: true,
					keepScratchObject: false,
					phase: 'self-test',
					useLockfile: true,
				},
				packagePath: 'self-test-endpoint-package.json',
				pkg,
			}),
		);
		const disposableCheckpointSource = readFileSync(disposableCheckpointFile, 'utf8');
		if (disposableCheckpoint.result !== 'dry_run' || JSON.parse(disposableCheckpointSource).result !== 'dry_run') {
			throw new ProofError('self-test disposable dry-run checkpoint did not record dry_run result');
		}
		if (
			disposableCheckpointSource.includes('dry-run-signing-material') ||
			disposableCheckpointSource.includes('dry-run-access-id') ||
			disposableCheckpointSource.includes(OPTIONAL_SESSION_TOKEN_ENV)
		) {
			throw new ProofError('self-test disposable dry-run checkpoint leaked credential-shaped values');
		}
	} finally {
		rmSync(tmpRoot, { force: true, recursive: true });
	}

	console.log('PASS: HA state scratch proof self-test');
};

const main = async () => {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.selfTest) {
			await runSelfTest();
			return;
		}

		const loaded = loadPackage(args.endpointPackage);
		validateEndpointPackage(loaded);
		if (args.runDisposableTofu) {
			await runDisposableTofuProof({ args, packagePath: args.endpointPackage, pkg: loaded.value });
			return;
		}
		await runScratchProof({ args, packagePath: args.endpointPackage, pkg: loaded.value });
	} catch (error) {
		if (error instanceof PackageError || error instanceof ProofError || error instanceof SyntaxError) {
			console.error(`FAIL: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
};

main();
