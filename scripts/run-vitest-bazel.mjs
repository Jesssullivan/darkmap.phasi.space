// Vitest entry point invoked by Bazel's `js_test` rule.
// Bazel runs this with `--config=ci-cached` or `--config=executor-backed`
// from the cache-attachment wrapper. The workspace root is the original
// source checkout (not the execroot), passed in via DARKMAP_BAZEL_WORKSPACE_ROOT.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startVitest } from 'vitest/node';

const workspaceRoot = process.cwd();
const configPath = resolve(workspaceRoot, 'vitest.bazel.config.ts');

if (!existsSync(configPath)) {
	console.error(`Bazel Vitest config not found: ${configPath}`);
	process.exit(1);
}

process.env.CI = 'true';
process.env.DARKMAP_BAZEL_WORKSPACE_ROOT = workspaceRoot;

const vitest = await startVitest('test', process.argv.slice(2), {
	config: configPath,
	root: workspaceRoot,
	reporters: ['default'],
	watch: false,
});

if (!vitest) process.exit(1);

await vitest.close();
const failed = vitest.state.getCountOfFailedTests();
const errors = vitest.state.getUnhandledErrors().length;
process.exit(failed > 0 || errors > 0 ? 1 : 0);
