#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import {
	fixture as endpointPackageFixture,
	loadPackage,
	validateEndpointPackage,
} from './ha-state-endpoint-package-check.mjs';

const DEFAULT_STATUS_PATH = 'docs/contracts/ha-opentofu-state-live-candidate-status.json';
const STATUS_SCHEMA = 'darkmap.ha_state_live_candidate_status.v1';
const NO_CANDIDATE_STATUS = 'NO_LIVE_HA_STATE_CANDIDATE';
const READY_STATUS = 'LIVE_HA_STATE_ENDPOINT_PACKAGE_READY';
const ISSUE = 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/141';
const UMBRELLA_ISSUE = 'https://github.com/Jesssullivan/darkmap.phasi.space/issues/139';
const CANDIDATE_CONTRACT = 'docs/contracts/ha-opentofu-state-managed-s3-candidate.json';
const REQUIRED_LINEAR_TICKETS = ['TIN-1026', 'TIN-1012'];
const REQUIRED_FORBIDDEN_TERMS = ['rustfs', 'minio', 'tcfs', 'attic', 'bazel', 'bcr', 'rbe', 'cas', 'action-cache'];
const REQUIRED_NEXT_EVIDENCE_TERMS = [
	'just ha-state-endpoint-package-check',
	'just ha-state-credential-boundary-check',
	'scratch',
	'disposable OpenTofu',
	'just ha-state-proof-evidence-check',
	'just ha-state-migration-plan',
];
const keyName = (...parts) => parts.join('_').toLowerCase();
const envAssignment = (...parts) => `${parts.join('_')}=`;
const FORBIDDEN_INLINE_SECRET_KEYS = new Set([
	keyName('access', 'key'),
	keyName('secret', 'key'),
	keyName('aws', 'access', 'key', 'id'),
	keyName('aws', 'secret', 'access', 'key'),
	'password',
	'token',
	keyName('credential', 'value'),
	keyName('secret', 'value'),
	keyName('secret', 'store', 'path'),
	'kubeconfig',
]);
const FORBIDDEN_INLINE_ASSIGNMENTS = [
	envAssignment('TOFU', 'HA', 'STATE', 'ACCESS', 'KEY'),
	envAssignment('TOFU', 'HA', 'STATE', 'SECRET', 'KEY'),
	envAssignment('AWS', 'ACCESS', 'KEY', 'ID'),
	envAssignment('AWS', 'SECRET', 'ACCESS', 'KEY'),
];

export class ReadinessError extends Error {}

const usage = () => {
	console.error(`usage:
  node ${basename(fileURLToPath(import.meta.url))} [--status <path>] [--expect-interim]
  node ${basename(fileURLToPath(import.meta.url))} --status <path> --endpoint-package <path>
  node ${basename(fileURLToPath(import.meta.url))} --self-test`);
};

const requireArgValue = (argv, index, arg) => {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) {
		throw new ReadinessError(`${arg} requires a value`);
	}
	return value;
};

const parseArgs = (argv) => {
	const parsed = {
		endpointPackage: undefined,
		expectInterim: false,
		selfTest: false,
		statusPath: DEFAULT_STATUS_PATH,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--status') {
			parsed.statusPath = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--endpoint-package') {
			parsed.endpointPackage = requireArgValue(argv, index, arg);
			index += 1;
		} else if (arg === '--expect-interim') {
			parsed.expectInterim = true;
		} else if (arg === '--self-test') {
			parsed.selfTest = true;
		} else {
			throw new ReadinessError(`unknown argument: ${arg}`);
		}
	}
	if (parsed.expectInterim && parsed.endpointPackage) {
		throw new ReadinessError('--expect-interim cannot be combined with --endpoint-package');
	}
	return parsed;
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireObject = (value, label) => {
	if (!isObject(value)) {
		throw new ReadinessError(`${label} must be an object`);
	}
};

const requireString = (value, field) => {
	if (typeof value[field] !== 'string' || value[field].trim() === '') {
		throw new ReadinessError(`${field} must be a non-empty string`);
	}
	return value[field];
};

const requireArray = (value, field) => {
	if (!Array.isArray(value[field]) || value[field].length === 0) {
		throw new ReadinessError(`${field} must be a non-empty array`);
	}
	return value[field];
};

const requireEqual = (actual, expected, field) => {
	if (actual !== expected) {
		throw new ReadinessError(`${field} must be ${expected}`);
	}
};

const textBlob = (value) => JSON.stringify(value).toLowerCase();

const requireTerms = (field, value, terms) => {
	const blob = textBlob(value);
	for (const term of terms) {
		if (!blob.includes(term.toLowerCase())) {
			throw new ReadinessError(`${field} must mention ${term}`);
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
			throw new ReadinessError(`live candidate status must not include inline credential assignment: ${assignment}`);
		}
	}
	visitEntries(value, (key, child, path) => {
		if (FORBIDDEN_INLINE_SECRET_KEYS.has(key.toLowerCase()) && typeof child === 'string' && child.trim()) {
			throw new ReadinessError(`live candidate status must not include inline secret field: ${path.join('.')}`);
		}
	});
};

const loadStatus = (path) => {
	const source = readFileSync(path, 'utf8');
	return { source, value: JSON.parse(source) };
};

export const validateLiveCandidateStatus = ({ source, value }, { endpointPackage, expectInterim = false } = {}) => {
	requireObject(value, 'live candidate status');
	rejectInlineSecrets(source, value);
	requireEqual(value.status_schema, STATUS_SCHEMA, 'status_schema');
	requireEqual(value.issue, ISSUE, 'issue');
	requireEqual(value.umbrella_issue, UMBRELLA_ISSUE, 'umbrella_issue');
	requireEqual(value.accepted_candidate_contract, CANDIDATE_CONTRACT, 'accepted_candidate_contract');
	if (value.non_secret !== true) {
		throw new ReadinessError('non_secret must be true');
	}

	const linearTickets = requireArray(value, 'linear_tickets');
	for (const ticket of REQUIRED_LINEAR_TICKETS) {
		if (!linearTickets.includes(ticket)) {
			throw new ReadinessError(`linear_tickets must include ${ticket}`);
		}
	}

	const status = requireString(value, 'status');
	if (status === NO_CANDIDATE_STATUS) {
		requireTerms('current_authority', requireString(value, 'current_authority'), ['rustfs']);
		requireTerms('current_authority_posture', requireString(value, 'current_authority_posture'), [
			'interim',
			'not an HA candidate',
		]);
		requireTerms('forbidden_live_candidate_classes', requireArray(value, 'forbidden_live_candidate_classes'), [
			...REQUIRED_FORBIDDEN_TERMS,
		]);
		requireTerms('required_next_evidence', requireArray(value, 'required_next_evidence'), REQUIRED_NEXT_EVIDENCE_TERMS);
		if (value.endpoint_package_path !== null) {
			throw new ReadinessError('endpoint_package_path must be null while no live candidate exists');
		}
		if (endpointPackage) {
			throw new ReadinessError('status says no live candidate, but --endpoint-package was provided');
		}
		if (!expectInterim) {
			throw new ReadinessError(
				`${NO_CANDIDATE_STATUS}: current RustFS is interim-only; run with --expect-interim to acknowledge TIN-1026 is still externally blocked`,
			);
		}
		return [
			`status=${NO_CANDIDATE_STATUS}`,
			`current_authority=${value.current_authority}`,
			`accepted_candidate_contract=${value.accepted_candidate_contract}`,
			'mode=interim_expected',
		];
	}

	if (status === READY_STATUS) {
		if (expectInterim) {
			throw new ReadinessError('status is live-ready but --expect-interim was provided');
		}
		const packagePath = endpointPackage ?? value.endpoint_package_path;
		if (typeof packagePath !== 'string' || packagePath.trim() === '') {
			throw new ReadinessError('endpoint package path is required when live candidate status is ready');
		}
		if (!existsSync(packagePath)) {
			throw new ReadinessError(`endpoint package does not exist: ${packagePath}`);
		}
		const packageResult = validateEndpointPackage(loadPackage(packagePath));
		return [`status=${READY_STATUS}`, `endpoint_package=${packagePath}`, ...packageResult];
	}

	throw new ReadinessError(`unknown live candidate status: ${status}`);
};

const noCandidateFixture = () => ({
	status_schema: STATUS_SCHEMA,
	status: NO_CANDIDATE_STATUS,
	issue: ISSUE,
	umbrella_issue: UMBRELLA_ISSUE,
	linear_tickets: REQUIRED_LINEAR_TICKETS,
	recorded_on: '2026-05-29',
	current_authority: 'interim RustFS singleton at attic-rustfs-hl.nix-cache.svc:9000',
	current_authority_posture: 'interim-only; guarded by retry wrappers and drift checks; not an HA candidate',
	accepted_candidate_contract: CANDIDATE_CONTRACT,
	endpoint_package_path: null,
	proof_credential_status: 'not present in this public repo',
	forbidden_live_candidate_classes: [
		'current interim RustFS singleton',
		'staging MinIO or other staging-only S3 service',
		'TCFS/search-adjacent storage',
		'Attic cache',
		'Bazel cache',
		'BCR/Bzlmod mirror storage',
		'RBE CAS or action-cache storage',
	],
	required_next_evidence: [
		'filled non-secret endpoint package validated by just ha-state-endpoint-package-check',
		'scoped proof credentials from the private secret authority',
		'just ha-state-credential-boundary-check checkpoint',
		'scratch proof checkpoints for baseline, post-maintenance, and post-failure-domain',
		'disposable OpenTofu proof checkpoints for baseline, post-maintenance, and post-failure-domain',
		'just ha-state-proof-evidence-check bundle validation',
		'reviewed protected migration plan from just ha-state-migration-plan',
	],
	non_secret: true,
});

const requireSelfTestThrow = (label, callback) => {
	try {
		callback();
	} catch (error) {
		if (error instanceof ReadinessError) {
			return;
		}
		throw error;
	}
	throw new ReadinessError(`self-test accepted invalid case: ${label}`);
};

const runSelfTest = () => {
	const validNoCandidate = noCandidateFixture();
	validateLiveCandidateStatus(
		{ source: JSON.stringify(validNoCandidate), value: validNoCandidate },
		{ expectInterim: true },
	);
	requireSelfTestThrow('no candidate without expect-interim', () =>
		validateLiveCandidateStatus({ source: JSON.stringify(validNoCandidate), value: validNoCandidate }),
	);
	requireSelfTestThrow('no candidate with endpoint package path', () =>
		validateLiveCandidateStatus({
			source: JSON.stringify({ ...validNoCandidate, endpoint_package_path: 'endpoint-package.json' }),
			value: { ...validNoCandidate, endpoint_package_path: 'endpoint-package.json' },
		}),
	);
	requireSelfTestThrow('missing forbidden candidate class', () =>
		validateLiveCandidateStatus(
			{
				source: JSON.stringify({ ...validNoCandidate, forbidden_live_candidate_classes: ['current RustFS only'] }),
				value: { ...validNoCandidate, forbidden_live_candidate_classes: ['current RustFS only'] },
			},
			{ expectInterim: true },
		),
	);
	requireSelfTestThrow('inline credential assignment', () =>
		validateLiveCandidateStatus(
			{
				source: `${JSON.stringify(validNoCandidate)}\n${envAssignment('AWS', 'ACCESS', 'KEY', 'ID')}example`,
				value: validNoCandidate,
			},
			{ expectInterim: true },
		),
	);

	const tmpRoot = mkdtempSync(join(tmpdir(), 'darkmap-ha-state-live-candidate-status-'));
	try {
		const packagePath = join(tmpRoot, 'endpoint-package.json');
		writeFileSync(packagePath, `${JSON.stringify(endpointPackageFixture(), null, 2)}\n`);
		const ready = {
			...validNoCandidate,
			status: READY_STATUS,
			current_authority: 'managed HA S3-compatible state endpoint',
			current_authority_posture: 'HA endpoint package is present and ready for proof credentials',
			endpoint_package_path: packagePath,
		};
		validateLiveCandidateStatus({ source: JSON.stringify(ready), value: ready });
		requireSelfTestThrow('ready status with expect-interim', () =>
			validateLiveCandidateStatus({ source: JSON.stringify(ready), value: ready }, { expectInterim: true }),
		);
	} finally {
		rmSync(tmpRoot, { force: true, recursive: true });
	}

	console.log('PASS: HA state live candidate status self-test');
};

const main = () => {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.selfTest) {
			runSelfTest();
			return;
		}
		const result = validateLiveCandidateStatus(loadStatus(args.statusPath), {
			endpointPackage: args.endpointPackage,
			expectInterim: args.expectInterim,
		});
		console.log(`PASS: HA state live candidate status ${args.statusPath}`);
		for (const line of result) {
			console.log(line);
		}
	} catch (error) {
		if (error instanceof ReadinessError || error instanceof SyntaxError) {
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
