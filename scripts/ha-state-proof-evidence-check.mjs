#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import {
	PackageError,
	fixture as endpointPackageFixture,
	loadPackage,
	validateEndpointPackage,
} from './ha-state-endpoint-package-check.mjs';

const REQUIRED_PHASES = ['baseline', 'post-maintenance', 'post-failure-domain'];
const BOUNDARY_SCHEMA = 'darkmap.ha_state_credential_boundary.v1';
const SCRATCH_SCHEMA = 'darkmap.ha_state_scratch_proof.v1';
const DISPOSABLE_SCHEMA = 'darkmap.ha_state_disposable_tofu_proof.v1';
const MIGRATION_SCHEMA = 'darkmap.ha_state_protected_migration_plan.v1';
const BOUNDARY_ISSUE = 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/141';
const SCRATCH_ISSUE = 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/142';
const DISPOSABLE_ISSUE = 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/144';
const MIGRATION_ISSUE = 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/145';
const DISPOSABLE_PREFIX = 'darkmap-ha-state-proof/disposable-tofu';
const FINAL_STATE_BUCKET = 'tofu-state';
const FINAL_STATE_KEY = 'spokes/darkmap/terraform.tfstate';
const keyName = (...parts) => parts.join('_').toLowerCase();
const envName = (...parts) => parts.join('_');
const envAssignmentPattern = (...parts) => new RegExp(`${envName(...parts)}\\s*=`, 'i');
const SECRET_KEY_NAMES = new Set([
	'access_key',
	'secret_key',
	keyName('aws', 'access', 'key', 'id'),
	keyName('aws', 'secret', 'access', 'key'),
	'password',
	'token',
	'credential_value',
	'secret_value',
]);
const SECRET_TEXT_PATTERNS = [
	envAssignmentPattern('TOFU', 'HA', 'STATE', 'ACCESS', 'KEY'),
	envAssignmentPattern('TOFU', 'HA', 'STATE', 'SECRET', 'KEY'),
	envAssignmentPattern('AWS', 'ACCESS', 'KEY', 'ID'),
	envAssignmentPattern('AWS', 'SECRET', 'ACCESS', 'KEY'),
	/AKIA[0-9A-Z]{16}/,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/ENC\[AES256_GCM,/,
];
const PRIVATE_PATH_PATTERNS = [/\/Users\//, /\/private\//, /\/home\//, /nix\/secrets/i, /\.kube/i, /kubeconfig/i];

class EvidenceError extends Error {}

const usage = () => {
	console.error(`usage:
  node ${basename(fileURLToPath(import.meta.url))} --endpoint-package <path> --scratch <phase:path>... --disposable <phase:path>... [--migration-plan <path>]
  node ${basename(fileURLToPath(import.meta.url))} --endpoint-package <path> --credential-boundary <path>
  node ${basename(fileURLToPath(import.meta.url))} --self-test

Required phases: ${REQUIRED_PHASES.join(', ')}`);
};

const requireArgValue = (argv, index, arg) => {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new EvidenceError(`${arg} requires a value`);
	}
	return value;
};

const parsePhasePath = (value, arg) => {
	const delimiter = value.indexOf(':');
	if (delimiter <= 0 || delimiter === value.length - 1) {
		throw new EvidenceError(`${arg} must use <phase:path>`);
	}
	return { path: value.slice(delimiter + 1), phase: value.slice(0, delimiter) };
};

const parseArgs = (argv) => {
	const parsed = {
		credentialBoundary: undefined,
		disposable: new Map(),
		endpointPackage: undefined,
		migrationPlan: undefined,
		scratch: new Map(),
		selfTest: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--endpoint-package') {
			parsed.endpointPackage = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--credential-boundary') {
			parsed.credentialBoundary = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--scratch') {
			const entry = parsePhasePath(requireArgValue(argv, index, arg), arg);
			parsed.scratch.set(entry.phase, entry.path);
			index += 1;
		} else if (arg === '--disposable') {
			const entry = parsePhasePath(requireArgValue(argv, index, arg), arg);
			parsed.disposable.set(entry.phase, entry.path);
			index += 1;
		} else if (arg === '--migration-plan') {
			parsed.migrationPlan = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--self-test') {
			parsed.selfTest = true;
		} else {
			throw new EvidenceError(`unknown argument: ${arg}`);
		}
	}

	if (!parsed.selfTest && !parsed.endpointPackage) {
		throw new EvidenceError('--endpoint-package is required');
	}
	return parsed;
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = (path) => {
	const source = readFileSync(path, 'utf8');
	return { path, source, value: JSON.parse(source) };
};

const requireObject = (value, label) => {
	if (!isObject(value)) {
		throw new EvidenceError(`${label} must be a JSON object`);
	}
	return value;
};

const visitEntries = (value, callback, path = []) => {
	if (Array.isArray(value)) {
		value.forEach((item, index) => visitEntries(item, callback, [...path, String(index)]));
		return;
	}
	if (isObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			callback(key, child, [...path, key]);
			visitEntries(child, callback, [...path, key]);
		}
	}
};

const rejectUnsafeEvidence = ({ source, value }, label) => {
	for (const pattern of SECRET_TEXT_PATTERNS) {
		if (pattern.test(source)) {
			throw new EvidenceError(`${label} contains secret-shaped text: ${pattern}`);
		}
	}
	for (const pattern of PRIVATE_PATH_PATTERNS) {
		if (pattern.test(source)) {
			throw new EvidenceError(`${label} contains private path-shaped text: ${pattern}`);
		}
	}
	visitEntries(value, (key, child, path) => {
		if (SECRET_KEY_NAMES.has(key.toLowerCase()) && typeof child === 'string' && child.trim()) {
			throw new EvidenceError(`${label} contains secret-shaped field: ${path.join('.')}`);
		}
	});
	if ('package_path' in value) {
		throw new EvidenceError(`${label} uses legacy package_path; rerun the proof harness to emit package_ref`);
	}
};

const requireEqual = (actual, expected, label) => {
	if (actual !== expected) {
		throw new EvidenceError(`${label} must be ${expected}, got ${actual}`);
	}
};

const requireStep = (checkpoint, name, { exitCode, status } = {}) => {
	const step = checkpoint.steps?.find((candidate) => candidate.name === name);
	if (!step) {
		throw new EvidenceError(`${checkpoint.checkpoint_schema} missing step ${name}`);
	}
	if (step.ok !== true) {
		throw new EvidenceError(`${checkpoint.checkpoint_schema} step ${name} did not record ok=true`);
	}
	if (exitCode !== undefined && step.exit_code !== exitCode) {
		throw new EvidenceError(`${checkpoint.checkpoint_schema} step ${name} exit_code must be ${exitCode}`);
	}
	if (status !== undefined && step.status !== status) {
		throw new EvidenceError(`${checkpoint.checkpoint_schema} step ${name} status must be ${status}`);
	}
	return step;
};

const requirePhaseEntries = (entries, label) => {
	for (const phase of REQUIRED_PHASES) {
		if (!entries.has(phase)) {
			throw new EvidenceError(`${label} missing ${phase} checkpoint`);
		}
	}
};

const validatePackageRef = (checkpoint, endpointPackagePath, label) => {
	requireEqual(checkpoint.package_ref, basename(endpointPackagePath), `${label}.package_ref`);
};

const validateScratchCheckpoint = ({ checkpoint, endpointPackagePath, label, phase, pkg }) => {
	requireObject(checkpoint, label);
	rejectUnsafeEvidence({ source: JSON.stringify(checkpoint), value: checkpoint }, label);
	requireEqual(checkpoint.checkpoint_schema, SCRATCH_SCHEMA, `${label}.checkpoint_schema`);
	requireEqual(checkpoint.issue, SCRATCH_ISSUE, `${label}.issue`);
	requireEqual(checkpoint.package_name, pkg.name, `${label}.package_name`);
	validatePackageRef(checkpoint, endpointPackagePath, label);
	requireEqual(checkpoint.phase, phase, `${label}.phase`);
	requireEqual(checkpoint.scratch_bucket, pkg.scratch_bucket, `${label}.scratch_bucket`);
	requireEqual(checkpoint.result, 'passed', `${label}.result`);
	if (!checkpoint.scratch_object_key?.startsWith(`darkmap-ha-state-proof/${phase}/`)) {
		throw new EvidenceError(`${label}.scratch_object_key must stay under darkmap-ha-state-proof/${phase}/`);
	}
	for (const step of ['list-buckets', 'head-bucket', 'put-object', 'head-object', 'get-object', 'delete-object']) {
		requireStep(checkpoint, step);
	}
	requireStep(checkpoint, 'head-object-after-delete', { status: 404 });
};

const validateBoundaryCheckpoint = ({ checkpoint, endpointPackagePath, pkg }) => {
	const label = 'credential-boundary';
	requireObject(checkpoint, label);
	rejectUnsafeEvidence({ source: JSON.stringify(checkpoint), value: checkpoint }, label);
	requireEqual(checkpoint.checkpoint_schema, BOUNDARY_SCHEMA, `${label}.checkpoint_schema`);
	requireEqual(checkpoint.issue, BOUNDARY_ISSUE, `${label}.issue`);
	requireEqual(checkpoint.package_name, pkg.name, `${label}.package_name`);
	validatePackageRef(checkpoint, endpointPackagePath, label);
	requireEqual(checkpoint.scratch_bucket, pkg.scratch_bucket, `${label}.scratch_bucket`);
	requireEqual(checkpoint.result, 'passed', `${label}.result`);
	requireStep(checkpoint, 'list-buckets-without-protected-state');
	requireStep(checkpoint, 'head-scratch-bucket');
	for (const stepName of [
		'head-active-state-bucket',
		'head-current-darkmap-state-key',
		'head-final-darkmap-state-key',
	]) {
		const step = requireStep(checkpoint, stepName);
		if (step.status !== 403 && step.status !== 404) {
			throw new EvidenceError(`${label} step ${stepName} status must be 403 or 404`);
		}
	}
};

const validateDisposableCheckpoint = ({ checkpoint, endpointPackagePath, label, phase, pkg }) => {
	requireObject(checkpoint, label);
	rejectUnsafeEvidence({ source: JSON.stringify(checkpoint), value: checkpoint }, label);
	requireEqual(checkpoint.checkpoint_schema, DISPOSABLE_SCHEMA, `${label}.checkpoint_schema`);
	requireEqual(checkpoint.issue, DISPOSABLE_ISSUE, `${label}.issue`);
	requireEqual(checkpoint.package_name, pkg.name, `${label}.package_name`);
	validatePackageRef(checkpoint, endpointPackagePath, label);
	requireEqual(checkpoint.phase, phase, `${label}.phase`);
	requireEqual(checkpoint.scratch_bucket, pkg.scratch_bucket, `${label}.scratch_bucket`);
	requireEqual(checkpoint.result, 'passed', `${label}.result`);
	requireEqual(checkpoint.use_lockfile_requested, true, `${label}.use_lockfile_requested`);
	if (
		!checkpoint.state_key?.startsWith(`${DISPOSABLE_PREFIX}/${phase}/`) ||
		!checkpoint.state_key.endsWith('/terraform.tfstate')
	) {
		throw new EvidenceError(`${label}.state_key must stay under ${DISPOSABLE_PREFIX}/${phase}/.../terraform.tfstate`);
	}
	for (const step of [
		'render-disposable-tofu-config',
		'tofu-init',
		'tofu-apply-first-write',
		'tofu-output-readback',
		'tofu-plan-no-op',
		'put-synthetic-lockfile',
		'delete-synthetic-lockfile',
		'get-state-for-restore',
		'delete-state-before-restore',
		'restore-state-object',
		'tofu-plan-after-restore',
		'cleanup-delete-state',
	]) {
		requireStep(checkpoint, step);
	}
	requireStep(checkpoint, 'tofu-plan-lock-contention', { exitCode: 1 });
	requireStep(checkpoint, 'head-state-after-delete', { status: 404 });
};

const validateMigrationPlan = ({ checkpoint, endpointPackagePath, pkg }) => {
	const label = 'migration-plan';
	requireObject(checkpoint, label);
	rejectUnsafeEvidence({ source: JSON.stringify(checkpoint), value: checkpoint }, label);
	requireEqual(checkpoint.checkpoint_schema, MIGRATION_SCHEMA, `${label}.checkpoint_schema`);
	requireEqual(checkpoint.issue, MIGRATION_ISSUE, `${label}.issue`);
	requireEqual(checkpoint.package_name, pkg.name, `${label}.package_name`);
	validatePackageRef(checkpoint, endpointPackagePath, label);
	requireEqual(checkpoint.target_bucket, FINAL_STATE_BUCKET, `${label}.target_bucket`);
	requireEqual(checkpoint.target_key, FINAL_STATE_KEY, `${label}.target_key`);
	requireEqual(checkpoint.target_endpoint_url, pkg.endpoint_url, `${label}.target_endpoint_url`);
	requireEqual(checkpoint.target_region, pkg.region, `${label}.target_region`);
	requireEqual(checkpoint.use_lockfile_required, true, `${label}.use_lockfile_required`);
	for (const issue of [
		'https://github.com/Jesssullivan/darkmap.phasi.space/issues/141',
		SCRATCH_ISSUE,
		DISPOSABLE_ISSUE,
	]) {
		if (!checkpoint.proof_gates_required?.includes(issue)) {
			throw new EvidenceError(`${label}.proof_gates_required must include ${issue}`);
		}
	}
};

const validateEvidenceBundle = (args) => {
	const loadedPackage = loadPackage(args.endpointPackage);
	validateEndpointPackage(loadedPackage);
	const pkg = loadedPackage.value;
	if (args.credentialBoundary) {
		validateBoundaryCheckpoint({
			checkpoint: readJson(args.credentialBoundary).value,
			endpointPackagePath: args.endpointPackage,
			pkg,
		});
	}
	const hasProofBundle = args.scratch.size > 0 || args.disposable.size > 0 || Boolean(args.migrationPlan);
	if (!args.credentialBoundary && !hasProofBundle) {
		throw new EvidenceError('provide --credential-boundary or the full scratch/disposable proof bundle');
	}
	if (hasProofBundle) {
		requirePhaseEntries(args.scratch, 'scratch evidence');
		requirePhaseEntries(args.disposable, 'disposable evidence');
	}

	if (hasProofBundle) {
		for (const phase of REQUIRED_PHASES) {
			const scratch = readJson(args.scratch.get(phase));
			validateScratchCheckpoint({
				checkpoint: scratch.value,
				endpointPackagePath: args.endpointPackage,
				label: `scratch ${phase}`,
				phase,
				pkg,
			});
			const disposable = readJson(args.disposable.get(phase));
			validateDisposableCheckpoint({
				checkpoint: disposable.value,
				endpointPackagePath: args.endpointPackage,
				label: `disposable ${phase}`,
				phase,
				pkg,
			});
		}
	}

	if (args.migrationPlan) {
		validateMigrationPlan({
			checkpoint: readJson(args.migrationPlan).value,
			endpointPackagePath: args.endpointPackage,
			pkg,
		});
	}

	console.log('PASS: HA state proof evidence bundle');
	console.log(`scratch_phases=${hasProofBundle ? REQUIRED_PHASES.join(',') : 'omitted'}`);
	console.log(`disposable_phases=${hasProofBundle ? REQUIRED_PHASES.join(',') : 'omitted'}`);
	console.log(`credential_boundary=${args.credentialBoundary ? 'present' : 'omitted'}`);
	console.log(`migration_plan=${args.migrationPlan ? 'present' : 'omitted'}`);
};

const boundaryFixture = (pkg) => ({
	checkpoint_schema: BOUNDARY_SCHEMA,
	completed_at: '2026-05-29T00:00:00.000Z',
	issue: BOUNDARY_ISSUE,
	package_name: pkg.name,
	package_ref: 'endpoint-package.json',
	result: 'passed',
	scratch_bucket: pkg.scratch_bucket,
	started_at: '2026-05-29T00:00:00.000Z',
	steps: [
		{ name: 'list-buckets-without-protected-state', ok: true, status: 200 },
		{ name: 'head-scratch-bucket', ok: true, status: 200 },
		{ name: 'head-active-state-bucket', ok: true, status: 403 },
		{ name: 'head-current-darkmap-state-key', ok: true, status: 404 },
		{ name: 'head-final-darkmap-state-key', ok: true, status: 403 },
	],
});

const scratchFixture = ({ phase, pkg }) => ({
	checkpoint_schema: SCRATCH_SCHEMA,
	completed_at: '2026-05-29T00:00:00.000Z',
	issue: SCRATCH_ISSUE,
	package_name: pkg.name,
	package_ref: 'endpoint-package.json',
	phase,
	result: 'passed',
	scratch_bucket: pkg.scratch_bucket,
	scratch_object_key: `darkmap-ha-state-proof/${phase}/proof.json`,
	started_at: '2026-05-29T00:00:00.000Z',
	steps: [
		{ name: 'list-buckets', ok: true, status: 200 },
		{ name: 'head-bucket', ok: true, status: 200 },
		{ name: 'put-object', ok: true, status: 200 },
		{ name: 'head-object', ok: true, status: 200 },
		{ name: 'get-object', ok: true, status: 200 },
		{ name: 'delete-object', ok: true, status: 204 },
		{ name: 'head-object-after-delete', ok: true, status: 404 },
	],
});

const disposableFixture = ({ phase, pkg }) => ({
	checkpoint_schema: DISPOSABLE_SCHEMA,
	completed_at: '2026-05-29T00:00:00.000Z',
	issue: DISPOSABLE_ISSUE,
	package_name: pkg.name,
	package_ref: 'endpoint-package.json',
	phase,
	result: 'passed',
	scratch_bucket: pkg.scratch_bucket,
	started_at: '2026-05-29T00:00:00.000Z',
	state_key: `${DISPOSABLE_PREFIX}/${phase}/proof/terraform.tfstate`,
	steps: [
		{ name: 'render-disposable-tofu-config', ok: true },
		{ name: 'tofu-init', ok: true, exit_code: 0 },
		{ name: 'tofu-apply-first-write', ok: true, exit_code: 0 },
		{ name: 'tofu-output-readback', ok: true, exit_code: 0 },
		{ name: 'tofu-plan-no-op', ok: true, exit_code: 0 },
		{ name: 'put-synthetic-lockfile', ok: true, status: 200 },
		{ name: 'tofu-plan-lock-contention', ok: true, exit_code: 1 },
		{ name: 'delete-synthetic-lockfile', ok: true, status: 204 },
		{ name: 'get-state-for-restore', ok: true, status: 200 },
		{ name: 'delete-state-before-restore', ok: true, status: 204 },
		{ name: 'head-state-after-delete', ok: true, status: 404 },
		{ name: 'restore-state-object', ok: true, status: 200 },
		{ name: 'tofu-plan-after-restore', ok: true, exit_code: 0 },
		{ name: 'cleanup-delete-state', ok: true, status: 204 },
	],
	use_lockfile_requested: true,
});

const migrationFixture = (pkg) => ({
	checkpoint_schema: MIGRATION_SCHEMA,
	issue: MIGRATION_ISSUE,
	package_name: pkg.name,
	package_ref: 'endpoint-package.json',
	planned_at: '2026-05-29T00:00:00.000Z',
	proof_gates_required: [
		'https://github.com/Jesssullivan/darkmap.phasi.space/issues/141',
		SCRATCH_ISSUE,
		DISPOSABLE_ISSUE,
	],
	source_backend_file: 'infra/tofu/backend.hcl',
	source_key: 'darkmap-tinyland-dev/terraform.tfstate',
	target_bucket: FINAL_STATE_BUCKET,
	target_endpoint_url: pkg.endpoint_url,
	target_key: FINAL_STATE_KEY,
	target_region: pkg.region,
	use_lockfile_required: true,
});

const requireSelfTestThrow = (label, run) => {
	try {
		run();
	} catch (error) {
		if (error instanceof EvidenceError || error instanceof PackageError) {
			return;
		}
		throw error;
	}
	throw new EvidenceError(`self-test accepted invalid case: ${label}`);
};

const runSelfTest = () => {
	const pkg = endpointPackageFixture();
	const tmpRoot = mkdtempSync(join(tmpdir(), 'darkmap-ha-state-proof-evidence-'));
	try {
		const packagePath = join(tmpRoot, 'endpoint-package.json');
		writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
		const credentialBoundary = join(tmpRoot, 'credential-boundary.json');
		writeFileSync(credentialBoundary, `${JSON.stringify(boundaryFixture(pkg), null, 2)}\n`);
		const scratch = new Map();
		const disposable = new Map();
		for (const phase of REQUIRED_PHASES) {
			const scratchPath = join(tmpRoot, `scratch-${phase}.json`);
			const disposablePath = join(tmpRoot, `disposable-${phase}.json`);
			writeFileSync(scratchPath, `${JSON.stringify(scratchFixture({ phase, pkg }), null, 2)}\n`);
			writeFileSync(disposablePath, `${JSON.stringify(disposableFixture({ phase, pkg }), null, 2)}\n`);
			scratch.set(phase, scratchPath);
			disposable.set(phase, disposablePath);
		}
		const migrationPlan = join(tmpRoot, 'migration-plan.json');
		writeFileSync(migrationPlan, `${JSON.stringify(migrationFixture(pkg), null, 2)}\n`);
		validateEvidenceBundle({ credentialBoundary, disposable, endpointPackage: packagePath, migrationPlan, scratch });
		validateEvidenceBundle({
			credentialBoundary,
			disposable: new Map(),
			endpointPackage: packagePath,
			scratch: new Map(),
		});

		requireSelfTestThrow('missing phase', () =>
			validateEvidenceBundle({
				credentialBoundary,
				disposable,
				endpointPackage: packagePath,
				migrationPlan,
				scratch: new Map([...scratch].filter(([phase]) => phase !== 'post-maintenance')),
			}),
		);
		requireSelfTestThrow('boundary protected access succeeded', () =>
			validateBoundaryCheckpoint({
				checkpoint: {
					...boundaryFixture(pkg),
					steps: boundaryFixture(pkg).steps.map((step) =>
						step.name === 'head-active-state-bucket' ? { ...step, status: 200 } : step,
					),
				},
				endpointPackagePath: packagePath,
				pkg,
			}),
		);
		requireSelfTestThrow('legacy package_path', () =>
			validateScratchCheckpoint({
				checkpoint: { ...scratchFixture({ phase: 'baseline', pkg }), package_path: '/Users/example/private.json' },
				endpointPackagePath: packagePath,
				label: 'scratch baseline',
				phase: 'baseline',
				pkg,
			}),
		);
	} finally {
		rmSync(tmpRoot, { force: true, recursive: true });
	}
	console.log('PASS: HA state proof evidence self-test');
};

const main = () => {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.selfTest) {
			runSelfTest();
			return;
		}
		validateEvidenceBundle(args);
	} catch (error) {
		if (error instanceof EvidenceError || error instanceof PackageError || error instanceof SyntaxError) {
			console.error(`FAIL: ${error.message}`);
			usage();
			process.exitCode = 1;
			return;
		}
		throw error;
	}
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
