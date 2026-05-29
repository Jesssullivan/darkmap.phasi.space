#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PackageError,
	fixture as endpointPackageFixture,
	loadPackage,
	validateEndpointPackage,
} from './ha-state-endpoint-package-check.mjs';

const DEFAULT_STATE_BUCKET = 'tofu-state';
const DEFAULT_STATE_KEY = 'spokes/darkmap/terraform.tfstate';
const CURRENT_INTERIM_KEY = 'darkmap-tinyland-dev/terraform.tfstate';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE_BACKEND_PATH = resolve(REPO_ROOT, 'infra/tofu/backend.hcl');
const FORBIDDEN_KEY_TERMS = ['attic/', 'arc-runners/', 'tinyland-infra/'];

class MigrationPlanError extends Error {}

const usage = () => {
	console.error(`usage:
  node ${basename(fileURLToPath(import.meta.url))} --endpoint-package <path> [--state-bucket <bucket>] [--state-key <key>] [--output-backend <path>] [--checkpoint-file <path>]
  node ${basename(fileURLToPath(import.meta.url))} --self-test`);
};

const requireArgValue = (argv, index, arg) => {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new MigrationPlanError(`${arg} requires a value`);
	}
	return value;
};

const parseArgs = (argv) => {
	const parsed = {
		checkpointFile: undefined,
		endpointPackage: undefined,
		outputBackend: undefined,
		selfTest: false,
		stateBucket: DEFAULT_STATE_BUCKET,
		stateKey: DEFAULT_STATE_KEY,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--endpoint-package') {
			parsed.endpointPackage = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--state-bucket') {
			parsed.stateBucket = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--state-key') {
			parsed.stateKey = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--output-backend') {
			parsed.outputBackend = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--checkpoint-file') {
			parsed.checkpointFile = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--self-test') {
			parsed.selfTest = true;
		} else {
			throw new MigrationPlanError(`unknown argument: ${arg}`);
		}
	}

	if (!parsed.selfTest && !parsed.endpointPackage) {
		throw new MigrationPlanError('--endpoint-package is required');
	}
	return parsed;
};

const hclString = (value) => JSON.stringify(value);

const rejectUnsafeMigrationTarget = ({ pkg, stateBucket, stateKey }) => {
	if (!/^[a-z0-9][a-z0-9.-]*$/i.test(stateBucket)) {
		throw new MigrationPlanError('--state-bucket must be an S3 bucket name, not a path');
	}
	if (stateBucket === pkg.scratch_bucket) {
		throw new MigrationPlanError('protected migration target must not use the scratch proof bucket');
	}
	if (stateKey !== DEFAULT_STATE_KEY) {
		throw new MigrationPlanError(`protected migration key must be ${DEFAULT_STATE_KEY}`);
	}
	if (stateKey === CURRENT_INTERIM_KEY) {
		throw new MigrationPlanError(`protected migration key must not stay on interim key ${CURRENT_INTERIM_KEY}`);
	}
	const lowered = `${stateBucket}/${stateKey}`.toLowerCase();
	for (const term of FORBIDDEN_KEY_TERMS) {
		if (lowered.includes(term)) {
			throw new MigrationPlanError(`protected migration target must not include unrelated state prefix ${term}`);
		}
	}
};

const rejectActiveBackendOverwrite = (outputBackend) => {
	if (outputBackend && resolve(outputBackend) === ACTIVE_BACKEND_PATH) {
		throw new MigrationPlanError('refusing to overwrite infra/tofu/backend.hcl; write a reviewable temp file first');
	}
};

const renderBackendConfig = ({
	endpointUrl,
	region,
	stateBucket,
	stateKey,
}) => `bucket                      = ${hclString(stateBucket)}
key                         = ${hclString(stateKey)}
region                      = ${hclString(region)}
endpoint                    = ${hclString(endpointUrl)}
use_path_style              = true
skip_credentials_validation = true
skip_region_validation      = true
skip_metadata_api_check     = true
skip_requesting_account_id  = true
skip_s3_checksum            = true
use_lockfile                = true
`;

const checkpointFor = ({ args, pkg }) => ({
	checkpoint_schema: 'darkmap.ha_state_protected_migration_plan.v1',
	issue: 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/145',
	package_name: pkg.name,
	package_path: args.endpointPackage,
	planned_at: new Date().toISOString(),
	proof_gates_required: [
		'https://github.com/Jesssullivan/darkmap.phasi.space/issues/141',
		'https://github.com/Jesssullivan/darkmap.phasi.space/issues/142',
		'https://github.com/Jesssullivan/darkmap.phasi.space/issues/144',
	],
	source_backend_file: 'infra/tofu/backend.hcl',
	source_key: CURRENT_INTERIM_KEY,
	target_bucket: args.stateBucket,
	target_endpoint_url: pkg.endpoint_url,
	target_key: args.stateKey,
	target_region: pkg.region,
	use_lockfile_required: true,
});

const writeCheckpoint = (path, checkpoint) => {
	if (path) {
		writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
	}
};

const createMigrationPlan = ({ args, pkg }) => {
	rejectUnsafeMigrationTarget({ pkg, stateBucket: args.stateBucket, stateKey: args.stateKey });
	rejectActiveBackendOverwrite(args.outputBackend);

	const backendConfig = renderBackendConfig({
		endpointUrl: pkg.endpoint_url,
		region: pkg.region,
		stateBucket: args.stateBucket,
		stateKey: args.stateKey,
	});
	const checkpoint = checkpointFor({ args, pkg });

	if (args.outputBackend) {
		writeFileSync(args.outputBackend, backendConfig);
	}
	writeCheckpoint(args.checkpointFile, checkpoint);

	console.log(`PASS: HA state protected migration plan for ${args.stateBucket}/${args.stateKey}`);
	if (args.outputBackend) {
		console.log(`backend_config=${args.outputBackend}`);
	}
	return { backendConfig, checkpoint };
};

const requireSelfTestThrow = (label, run) => {
	try {
		run();
	} catch (error) {
		if (error instanceof MigrationPlanError || error instanceof PackageError) {
			return;
		}
		throw error;
	}
	throw new MigrationPlanError(`self-test accepted invalid case: ${label}`);
};

const runSelfTest = () => {
	const pkg = endpointPackageFixture();
	validateEndpointPackage({ source: JSON.stringify(pkg), value: pkg });
	requireSelfTestThrow('missing endpoint package', () => parseArgs([]));
	requireSelfTestThrow('missing output value', () => parseArgs(['--endpoint-package', 'pkg.json', '--output-backend']));
	requireSelfTestThrow('scratch bucket target', () =>
		rejectUnsafeMigrationTarget({ pkg, stateBucket: pkg.scratch_bucket, stateKey: DEFAULT_STATE_KEY }),
	);
	requireSelfTestThrow('non-final state key', () =>
		rejectUnsafeMigrationTarget({ pkg, stateBucket: DEFAULT_STATE_BUCKET, stateKey: CURRENT_INTERIM_KEY }),
	);
	requireSelfTestThrow('active backend overwrite', () => rejectActiveBackendOverwrite('infra/tofu/backend.hcl'));

	const tmpRoot = mkdtempSync(join(tmpdir(), 'darkmap-ha-state-migration-plan-'));
	try {
		const outputBackend = join(tmpRoot, 'backend.hcl');
		const checkpointFile = join(tmpRoot, 'migration-plan.json');
		const args = {
			checkpointFile,
			endpointPackage: 'self-test-endpoint-package.json',
			outputBackend,
			stateBucket: DEFAULT_STATE_BUCKET,
			stateKey: DEFAULT_STATE_KEY,
		};
		const { backendConfig, checkpoint } = createMigrationPlan({ args, pkg });
		const writtenBackend = readFileSync(outputBackend, 'utf8');
		const writtenCheckpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
		if (backendConfig !== writtenBackend || !backendConfig.includes('use_lockfile                = true')) {
			throw new MigrationPlanError('self-test did not render lockfile-enabled backend config');
		}
		if (
			checkpoint.target_key !== DEFAULT_STATE_KEY ||
			writtenCheckpoint.checkpoint_schema !== 'darkmap.ha_state_protected_migration_plan.v1'
		) {
			throw new MigrationPlanError('self-test did not render expected migration checkpoint');
		}
	} finally {
		rmSync(tmpRoot, { force: true, recursive: true });
	}

	console.log('PASS: HA state migration plan self-test');
};

const main = () => {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.selfTest) {
			runSelfTest();
			return;
		}
		const loaded = loadPackage(args.endpointPackage);
		validateEndpointPackage(loaded);
		createMigrationPlan({ args, pkg: loaded.value });
	} catch (error) {
		if (error instanceof MigrationPlanError || error instanceof PackageError || error instanceof SyntaxError) {
			console.error(`FAIL: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
};

main();
