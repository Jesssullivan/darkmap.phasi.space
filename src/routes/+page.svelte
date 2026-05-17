<script lang="ts">
	const brand = {
		domain: 'darkmap.tinyland.dev',
		tagline: 'Tinyland house static-site scaffold',
		blurb:
			'Static SvelteKit, Skeleton 4.15.2, Tailwind v4, Bazel, Nix, Just, Cloudflare Pages, and projection-first Tinyland operating rules.',
		tier: 'Template — private house scaffold',
	};
</script>

<svelte:head>
	<title>darkmap.tinyland.dev — Tinyland house static-site scaffold</title>
	<meta name="description" content={brand.blurb} />
</svelte:head>

<main class="mx-auto max-w-3xl space-y-8 px-6 py-24">
	<header class="space-y-3">
		<p class="text-surface-500 text-xs tracking-widest uppercase">{brand.tier}</p>
		<h1 class="text-4xl leading-tight font-bold md:text-5xl">{brand.domain}</h1>
		<p class="text-primary-600 text-xl">{brand.tagline}</p>
	</header>
	<p class="text-surface-700 dark:text-surface-300 text-lg leading-relaxed">
		{brand.blurb}
	</p>
	<footer class="text-surface-500 pt-12 text-sm">
		Part of the Tinyland enterprise — static projection planned from
		<a class="underline" href="https://tinyland.dev">tinyland.dev</a>.
	</footer>
</main>
