#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const REQUIRED_CREDENTIAL_INJECTION = {
	endpoint_env: 'TOFU_HA_STATE_ENDPOINT',
	region_env: 'TOFU_HA_STATE_REGION',
	access_key_env: 'TOFU_HA_STATE_ACCESS_KEY',
	secret_key_env: 'TOFU_HA_STATE_SECRET_KEY',
};

const REQUIRED_RECOVERY_FIELDS = ['versioning', 'retention_or_backup', 'restore_test'];
const REQUIRED_MAINTENANCE_FIELDS = ['restart_or_managed_maintenance', 'node_or_failure_domain'];
const REQUIRED_OBSERVABILITY_TERMS = ['failed auth', 'failed write', 'replication lag', 'delete behavior'];
const REQUIRED_SEPARATION_TERMS = ['attic', 'bazel', 'bcr', 'rbe', 'cas', 'action-cache'];
const REQUIRED_PROOF_TERMS = [
	'just ha-state-credential-boundary-check',
	'just ha-state-candidate-proof',
	'--endpoint-package',
	'--run-disposable-tofu',
	'--use-lockfile',
];
const REQUIRED_POLICY_TERMS = ['create', 'list', 'read', 'write', 'delete'];
const keyName = (...parts) => parts.join('_').toLowerCase();
const FORBIDDEN_INLINE_SECRET_KEYS = new Set([
	keyName('access', 'key'),
	keyName('secret', 'key'),
	keyName('aws', 'access', 'key', 'id'),
	keyName('aws', 'secret', 'access', 'key'),
	'password',
	'token',
	keyName('credential', 'value'),
	keyName('secret', 'value'),
]);
const envAssignment = (...parts) => `${parts.join('_')}=`;
const FORBIDDEN_INLINE_ASSIGNMENTS = [
	envAssignment('TOFU', 'HA', 'STATE', 'ACCESS', 'KEY'),
	envAssignment('TOFU', 'HA', 'STATE', 'SECRET', 'KEY'),
	envAssignment('AWS', 'ACCESS', 'KEY', 'ID'),
	envAssignment('AWS', 'SECRET', 'ACCESS', 'KEY'),
];

export class PackageError extends Error {}

const usage = () => {
	console.error(`usage:
  node ${basename(fileURLToPath(import.meta.url))} --package <path> [--allow-template]
  node ${basename(fileURLToPath(import.meta.url))} --self-test`);
};

const requireArgValue = (argv, index, arg) => {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new PackageError(`${arg} requires a value`);
	}
	return value;
};

const parseArgs = (argv) => {
	const parsed = { packagePath: undefined, allowTemplate: false, selfTest: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--package') {
			parsed.packagePath = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--allow-template') {
			parsed.allowTemplate = true;
		} else if (arg === '--self-test') {
			parsed.selfTest = true;
		} else {
			throw new PackageError(`unknown argument: ${arg}`);
		}
	}
	return parsed;
};

export const loadPackage = (path) => {
	const source = readFileSync(path, 'utf8');
	return { source, value: JSON.parse(source) };
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireObject = (value, field) => {
	if (!isObject(value[field])) {
		throw new PackageError(`${field} must be an object`);
	}
	return value[field];
};

const requireArray = (value, field) => {
	if (!Array.isArray(value[field]) || value[field].length === 0) {
		throw new PackageError(`${field} must be a non-empty array`);
	}
	return value[field];
};

const requireString = (value, field) => {
	if (typeof value[field] !== 'string' || value[field].trim() === '') {
		throw new PackageError(`${field} must be a non-empty string`);
	}
	return value[field];
};

const textBlob = (value) => JSON.stringify(value).toLowerCase();

const requireTerms = (field, value, terms) => {
	const blob = textBlob(value);
	for (const term of terms) {
		if (!blob.includes(term.toLowerCase())) {
			throw new PackageError(`${field} must mention ${term}`);
		}
	}
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

const rejectInlineSecrets = (source, value) => {
	for (const assignment of FORBIDDEN_INLINE_ASSIGNMENTS) {
		if (source.includes(assignment)) {
			throw new PackageError(`endpoint package must not include inline credential assignment: ${assignment}`);
		}
	}
	visitEntries(value, (key, child, path) => {
		if (FORBIDDEN_INLINE_SECRET_KEYS.has(key.toLowerCase()) && typeof child === 'string' && child.trim()) {
			throw new PackageError(`endpoint package must not include inline secret field: ${path.join('.')}`);
		}
	});
};

export const validateEndpointPackage = ({ source, value }, { allowTemplate = false } = {}) => {
	if (!isObject(value)) {
		throw new PackageError('endpoint package must be a JSON object');
	}
	rejectInlineSecrets(source, value);

	if (!allowTemplate && /replace-me|example\.invalid/i.test(source)) {
		throw new PackageError('endpoint package still contains template sentinel');
	}
	if (value.non_secret !== true) {
		throw new PackageError('non_secret must be true');
	}

	const endpointUrl = requireString(value, 'endpoint_url');
	if (!endpointUrl.startsWith('https://')) {
		throw new PackageError('endpoint_url must be HTTPS');
	}
	const endpointText = endpointUrl.toLowerCase();
	if (endpointText.includes('attic-rustfs') || endpointText.includes('nix-cache.svc')) {
		throw new PackageError('endpoint_url must not point at the interim RustFS singleton');
	}

	if (requireString(value, 'candidate_contract') !== 'docs/contracts/ha-opentofu-state-managed-s3-candidate.json') {
		throw new PackageError('candidate_contract must reference the selected managed S3 candidate artifact');
	}

	for (const field of [
		'name',
		'posture',
		'region',
		'network_audience',
		'credential_source',
		'rotation_owner',
		'restore_owner',
		'scratch_bucket',
		'state_locking',
	]) {
		requireString(value, field);
	}

	if (value.scratch_bucket === 'tofu-state') {
		throw new PackageError('scratch_bucket must not be the active tofu-state bucket');
	}

	const credentialInjection = requireObject(value, 'credential_injection');
	for (const [field, expected] of Object.entries(REQUIRED_CREDENTIAL_INJECTION)) {
		if (credentialInjection[field] !== expected) {
			throw new PackageError(`credential_injection.${field} must be ${expected}`);
		}
	}

	const bucketRecovery = requireObject(value, 'bucket_recovery');
	for (const field of REQUIRED_RECOVERY_FIELDS) {
		requireString(bucketRecovery, field);
	}

	const maintenanceProof = requireObject(value, 'maintenance_proof');
	for (const field of REQUIRED_MAINTENANCE_FIELDS) {
		requireString(maintenanceProof, field);
	}

	const scratchPolicy = requireArray(value, 'scratch_bucket_policy');
	const protectedDenials = requireArray(value, 'protected_state_denials');
	const observability = requireArray(value, 'observability');
	const authoritySeparation = requireArray(value, 'authority_separation');
	const proofCommands = requireArray(value, 'proof_commands');

	requireTerms('state_locking', value.state_locking, ['opentofu', 's3', 'lockfile', 'use_lockfile']);
	requireTerms('scratch_bucket_policy', scratchPolicy, REQUIRED_POLICY_TERMS);
	requireTerms('protected_state_denials', protectedDenials, ['tofu-state', 'darkmap', 'spokes/darkmap']);
	requireTerms('observability', observability, REQUIRED_OBSERVABILITY_TERMS);
	requireTerms('authority_separation', authoritySeparation, REQUIRED_SEPARATION_TERMS);
	requireTerms('proof_commands', proofCommands, REQUIRED_PROOF_TERMS);

	const scratchPolicyBlob = textBlob(scratchPolicy);
	if (scratchPolicyBlob.includes('tofu-state') && !scratchPolicyBlob.includes('deny')) {
		throw new PackageError('scratch_bucket_policy mentions tofu-state without an explicit deny');
	}

	return [`name=${value.name}`, `endpoint_url=${value.endpoint_url}`, `scratch_bucket=${value.scratch_bucket}`];
};

export const fixture = () => ({
	name: 'managed-ha-opentofu-state-proof',
	posture: 'proof_ready',
	candidate_contract: 'docs/contracts/ha-opentofu-state-managed-s3-candidate.json',
	endpoint_url: 'https://state-proof.private.tinyland.example',
	region: 'us-east-1',
	network_audience: 'tailnet operators and repo-managed proof runner only',
	credential_source: 'dedicated state-only secret authority; no Attic, Bazel, BCR, RBE, or CAS credentials',
	rotation_owner: 'Tinyland infrastructure operators',
	restore_owner: 'Tinyland infrastructure operators',
	credential_injection: REQUIRED_CREDENTIAL_INJECTION,
	scratch_bucket: 'darkmap-ha-state-proof',
	scratch_bucket_policy: [
		'allow create/list/read/write/delete for darkmap-ha-state-proof only',
		'deny tofu-state and protected stack prefixes',
	],
	protected_state_denials: [
		'deny tofu-state bucket',
		'deny tofu-state/darkmap-tinyland-dev/terraform.tfstate',
		'deny spokes/darkmap/terraform.tfstate',
	],
	bucket_recovery: {
		versioning: 'enabled',
		retention_or_backup: 'retained backup independent from Attic and Bazel cache storage',
		restore_test: 'scratch and disposable OpenTofu restore test required',
	},
	state_locking: 'OpenTofu S3 backend use_lockfile proof is required before protected state migration',
	maintenance_proof: {
		restart_or_managed_maintenance: 'managed maintenance event preserves head/list/read/write',
		node_or_failure_domain: 'managed multi-zone or equivalent failure-domain event preserves state',
	},
	observability: ['failed auth', 'failed write', 'replication lag', 'delete behavior'],
	authority_separation: [
		'Attic cache is separate',
		'Bazel cache is separate',
		'BCR mirrors are separate',
		'RBE CAS and action-cache are separate',
	],
	proof_commands: [
		'just ha-state-credential-boundary-check endpoint-package.json --checkpoint-file credential-boundary.json',
		'just ha-state-candidate-proof --endpoint-package endpoint-package.json --phase baseline --checkpoint-file scratch-proof-baseline.json',
		'just ha-state-candidate-proof --endpoint-package endpoint-package.json --run-disposable-tofu --use-lockfile',
		'just ha-state-candidate-proof --endpoint-package endpoint-package.json --keep-scratch-bucket --checkpoint-file <path>',
	],
	non_secret: true,
});

const runSelfTest = () => {
	const valid = fixture();
	validateEndpointPackage({ source: JSON.stringify(valid), value: valid });
	try {
		parseArgs(['--package']);
		throw new PackageError('self-test accepted --package without a value');
	} catch (error) {
		if (error instanceof PackageError && error.message === 'self-test accepted --package without a value') {
			throw error;
		}
		if (!(error instanceof PackageError)) {
			throw error;
		}
	}

	const invalidPackages = [
		{ ...valid, endpoint_url: 'http://state-proof.private.tinyland.example' },
		{ ...valid, endpoint_url: 'https://attic-rustfs-openebs.nix-cache.svc.cluster.local' },
		{ ...valid, scratch_bucket: 'tofu-state' },
		{ ...valid, non_secret: false },
		{ ...valid, [keyName('access', 'key')]: 'inline-secret' },
		{ ...valid, credential_injection: { ...valid.credential_injection, access_key_env: 'AWS_ACCESS_KEY_ID' } },
		{ ...valid, state_locking: 'OpenTofu S3 backend proof without lockfile' },
		{ ...valid, proof_commands: ['just ha-state-candidate-proof --endpoint-package endpoint-package.json'] },
		{ ...valid, protected_state_denials: ['deny tofu-state only'] },
	];

	for (const candidate of invalidPackages) {
		try {
			validateEndpointPackage({ source: JSON.stringify(candidate), value: candidate });
		} catch (error) {
			if (error instanceof PackageError) {
				continue;
			}
			throw error;
		}
		throw new PackageError(`self-test accepted invalid endpoint package: ${JSON.stringify(candidate)}`);
	}
	console.log('PASS: HA state endpoint package self-test');
};

const main = () => {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.selfTest) {
			runSelfTest();
			return;
		}
		if (!args.packagePath) {
			usage();
			process.exitCode = 2;
			return;
		}
		const result = validateEndpointPackage(loadPackage(args.packagePath), {
			allowTemplate: args.allowTemplate,
		});
		console.log(`PASS: HA state endpoint package ${args.packagePath}`);
		for (const line of result) {
			console.log(line);
		}
	} catch (error) {
		if (error instanceof PackageError || error instanceof SyntaxError) {
			console.error(`FAIL: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
