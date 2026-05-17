/**
 * Bazel-driven Vitest config. Mirrors MassageIthaca's pattern: explicit
 * test file include list (no glob) keeps the bazel action's input set
 * stable + cacheable, and `oxc.tsconfig = false` prevents OXC's tsconfig
 * auto-discovery from stat-ing paths outside the bazel sandbox on Linux
 * CI (a known SvelteKit + bazel sandbox gotcha).
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const workspaceRoot = process.env.DARKMAP_BAZEL_WORKSPACE_ROOT
	? path.resolve(process.env.DARKMAP_BAZEL_WORKSPACE_ROOT)
	: process.cwd();

const resolveWorkspace = (...segments: string[]) => path.resolve(workspaceRoot, ...segments);

export default defineConfig({
	root: workspaceRoot,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vitest 4.x doesn't expose this typed yet
	oxc: { tsconfig: false } as any,
	test: {
		include: [
			'src/lib/server/raster/raster.test.ts',
			'src/lib/url-hash.test.ts',
			'src/lib/projection/static-snapshot.test.ts',
		],
		globals: true,
		environment: 'node',
		coverage: { enabled: false },
	},
	resolve: {
		alias: {
			$lib: resolveWorkspace('src/lib'),
		},
	},
});
