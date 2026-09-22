import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	oxc: { tsconfig: false },
	resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
	test: {
		include: ['src/lib/atmospheric/provider-http.test.ts', 'src/routes/api/atmospheric/**/*.test.ts'],
		environment: 'node',
		passWithNoTests: false,
	},
});
