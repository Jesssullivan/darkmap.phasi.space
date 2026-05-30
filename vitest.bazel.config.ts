import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	oxc: {
		// Bazel runs tests from an output-tree runfiles root. Vite 8/OXC
		// tsconfig auto-discovery can chase the generated file path back into
		// execroot/bazel-out and fail before Vitest imports the test module.
		tsconfig: false,
	},
	resolve: {
		// Mirror vitest.config.ts so flywheel-enrolled slices that reach for
		// `$lib/...` resolve identically under Bazel's runfiles root.
		alias: {
			$lib: path.resolve(__dirname, 'src/lib'),
		},
	},
	test: {
		// Each vitest_test target narrows to its own file(s) via positional CLI
		// args; this include just bounds the candidate set to the enrolled,
		// node-safe (no DOM/maplibre) slices.
		include: ['src/lib/**/*.test.ts'],
		environment: 'node',
		globals: true,
		coverage: {
			enabled: false,
		},
	},
});
