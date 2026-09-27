import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { accessibilityPlugin } from '@tummycrypt/vite-plugin-a11y';
import { skeletonColorUtilities } from '@tummycrypt/vite-plugin-skeleton-colors';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		skeletonColorUtilities(),
		tailwindcss(),
		accessibilityPlugin({
			wcagLevel: 'AA',
			failOnError: false,
		}),
		sveltekit(),
	],
	build: {
		reportCompressedSize: true,
		chunkSizeWarningLimit: 250,
		cssCodeSplit: true,
	},
});
