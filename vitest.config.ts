import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			$lib: path.resolve(__dirname, 'src/lib'),
		},
	},
	test: {
		include: ['src/**/*.test.ts', 'src/**/*.test.svelte.ts', 'scripts/**/*.test.mts'],
		environment: 'node',
		globals: true,
		// The ephemeris/astronomy-engine slices (e.g. pinEphemeris memoisation,
		// SkyCompass trajectory) do real multi-day orbital math and sit close to
		// the 5s default; under CPU contention (parallel Bazel builds, loaded CI)
		// they flake on timeout despite ~1s of actual work. 15s is ample headroom
		// while still catching a genuine hang. CI runs the Bazel path, which is
		// less contended, but the local `pnpm test:unit` fallback hit this.
		testTimeout: 15_000,
		// Allow vacuous green on empty test set (M0.4 → M0.6 ramp).
		// Set to false in M3 once content + smoke tests land.
		passWithNoTests: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			thresholds: {
				lines: 50,
				functions: 50,
				branches: 50,
				statements: 50,
			},
			include: ['src/**/*.{ts,svelte.ts}', 'scripts/**/*.mts'],
			exclude: ['**/*.test.ts', '**/*.test.mts', '**/*.test.svelte.ts'],
		},
	},
});
