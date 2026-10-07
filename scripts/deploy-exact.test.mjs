import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./deploy-exact.sh', import.meta.url));
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const image = `ghcr.io/jesssullivan/darkmap.phasi.space@${digest}`;
const prior = 'ghcr.io/jesssullivan/darkmap.phasi.space:previous';

function run({ readChange, patchChange, containers } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), 'darkmap-deploy-cas-test-'));
	try {
		const deployment = {
			metadata: { uid: 'recorded-uid', resourceVersion: '42', ...readChange },
			spec: {
				template: {
					spec: {
						containers: containers ?? [
							{ name: 'sidecar', image: 'sidecar:1' },
							{ name: 'app', image: prior },
						],
					},
				},
			},
		};
		writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(deployment));
		const cli = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const name = require('node:path').basename(process.argv[1]);
if (name === 'git') { if (args[0] === 'rev-parse') console.log(process.env.TEST_SHA); process.exit(0); }
if (name === 'skopeo') { console.log(process.env.TEST_SHA); process.exit(0); }
if (args[0] === 'config') { console.log('honey'); process.exit(0); }
const d = JSON.parse(fs.readFileSync(process.env.TEST_DIR + '/fixture.json'));
if (args.includes('patch')) {
  fs.writeFileSync(process.env.TEST_DIR + '/patch-attempt', '1');
  const ops = JSON.parse(args[args.indexOf('-p') + 1]);
  if (process.env.TEST_PATCH_CHANGE) {
    const [field, value] = process.env.TEST_PATCH_CHANGE.split('=');
    if (field === 'image') d.spec.template.spec.containers[1].image = value;
    else d.metadata[field] = value;
  }
  for (const op of ops) {
    const keys = op.path.slice(1).split('/');
    let parent = d;
    for (const key of keys.slice(0, -1)) parent = parent[key];
    const key = keys.at(-1);
    if (op.op === 'test' && parent[key] !== op.value) process.exit(1);
    if (op.op === 'replace') parent[key] = op.value;
  }
  fs.writeFileSync(process.env.TEST_DIR + '/accepted-patch.json', JSON.stringify(ops));
  fs.writeFileSync(process.env.TEST_DIR + '/fixture.json', JSON.stringify(d));
  process.exit(0);
}
if (args.includes('rollout')) { fs.writeFileSync(process.env.TEST_DIR + '/rollout', '1'); process.exit(0); }
if (args.includes('pods')) { console.log('pod sha256:test ready=true'); process.exit(0); }
if (args.includes('json')) console.log(JSON.stringify(d));
else console.log(d.spec.template.spec.containers.find(c => c.name === 'app')?.image ?? '');
`;
		for (const name of ['git', 'kubectl', 'skopeo']) writeFileSync(path.join(dir, name), cli, { mode: 0o700 });
		const result = spawnSync('bash', [script, sha, digest, 'recorded-uid', prior, '42'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				TEST_DIR: dir,
				TEST_SHA: sha,
				TEST_PATCH_CHANGE: patchChange ?? '',
			},
		});
		const exists = (file) => {
			try {
				return readFileSync(path.join(dir, file), 'utf8');
			} catch {
				return null;
			}
		};
		return {
			result,
			patch: exists('accepted-patch.json'),
			attempted: exists('patch-attempt'),
			rollout: exists('rollout'),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('patches only the named app at its actual index after atomic state tests', () => {
	const { result, patch, rollout } = run();
	assert.equal(result.status, 0, result.stderr);
	const ops = JSON.parse(patch);
	assert.deepEqual(
		ops.map((op) => op.op),
		['test', 'test', 'test', 'test', 'replace'],
	);
	assert.equal(ops[2].path, '/spec/template/spec/containers/1/name');
	assert.equal(ops[4].value, image);
	assert.equal(rollout, '1');
});

for (const [label, readChange] of [
	['UID', { uid: 'replacement-uid' }],
	['resourceVersion', { resourceVersion: '43' }],
]) {
	test(`refuses changed ${label} before attempting patch`, () => {
		const { result, attempted, rollout } = run({ readChange });
		assert.notEqual(result.status, 0);
		assert.equal(attempted, null);
		assert.equal(rollout, null);
	});
}

for (const patchChange of ['uid=replacement-uid', 'resourceVersion=43', 'image=other:deployment']) {
	test(`atomic patch refuses concurrent ${patchChange.split('=')[0]} change`, () => {
		const { result, patch, attempted, rollout } = run({ patchChange });
		assert.notEqual(result.status, 0);
		assert.equal(attempted, '1');
		assert.equal(patch, null);
		assert.equal(rollout, null);
	});
}

for (const containers of [
	[],
	[
		{ name: 'app', image: prior },
		{ name: 'app', image: prior },
	],
	[{ name: 'app', image: 'other:deployment' }],
]) {
	test(`refuses missing/duplicate app or changed prior image: ${JSON.stringify(containers)}`, () => {
		const { result, attempted } = run({ containers });
		assert.notEqual(result.status, 0);
		assert.equal(attempted, null);
	});
}
