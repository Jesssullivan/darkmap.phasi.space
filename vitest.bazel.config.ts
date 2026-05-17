import { defineConfig } from 'vitest/config';

export default defineConfig({
	oxc: {
		// Bazel runs tests from an output-tree runfiles root. Vite 8/OXC
		// tsconfig auto-discovery can chase the generated file path back into
		// execroot/bazel-out and fail before Vitest imports the test module.
		tsconfig: false,
	},
	test: {
		include: ['src/lib/server/raster/raster.test.ts'],
		environment: 'node',
		globals: true,
		coverage: {
			enabled: false,
		},
	},
});
