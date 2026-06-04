<script lang="ts">
	/**
	 * /aq — thin redirect into the in-SPA AQ modal-popout (TIN-1871, idea ③).
	 *
	 * The air-quality dashboard used to live here as a ~820-line dedicated route.
	 * Because AQ is viewport/pin-driven it doesn't need a slug + history churn, so
	 * the dashboard body now mounts inside an in-SPA modal-popout (AqModal →
	 * AqDashboard). This route survives only as a SHAREABILITY shim: it bounces any
	 * `/aq#m=…` link into the SPA (`/#…&aq=1`), where the map page reads the `aq=1`
	 * flag on init and auto-opens the AQ modal seeded from the hash. This preserves
	 * existing shareable `/aq#m=…` links AND the aq-dashboard smoke's deep-link path.
	 *
	 * The hash is never sent to the server, so the bounce MUST happen client-side
	 * (here, on mount) rather than via a `+page.ts` load redirect.
	 */
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	// Build the SPA target: carry the incoming hash, append the `aq=1` auto-open
	// flag. Works whether or not a hash is present (bare `/aq` → `/#aq=1` opens the
	// modal seeded from the viewport centre).
	function spaTarget(): string {
		const raw = browser ? window.location.hash.replace(/^#/, '') : '';
		const hasFlag = raw.split('&').some((seg) => seg === 'aq=1' || seg === 'aq');
		const merged = raw ? (hasFlag ? raw : `${raw}&aq=1`) : 'aq=1';
		return `/#${merged}`;
	}

	onMount(() => {
		// Hard cross-document navigation to `/` (not a client `goto`): the bounce must
		// not depend on the prerendered /aq page finishing hydration / router setup —
		// `location.replace` reliably loads the SPA fresh, where the `aq=1` flag opens
		// the modal. `replace` (not `assign`) keeps /aq out of history, so Back from the
		// map lands wherever the user was before the /aq link, not on a redirect bounce.
		window.location.replace(spaTarget());
	});
</script>

<svelte:head>
	<title>Air-quality analysis · darkmap</title>
	<meta name="description" content="Point-anchored air-quality analysis — opens in the darkmap Command Deck." />
</svelte:head>

<!-- Pre-hydration / no-JS fallback: a plain link into the SPA so the page is never a
     dead end. Hydration replaces this with the immediate redirect above. -->
<noscript>
	<p style="padding:2rem;font-family:system-ui,sans-serif">
		Air-quality analysis opens in the map. <a href="/">Open the map</a>.
	</p>
</noscript>
<p class="aq-redirect" aria-live="polite">Opening air-quality analysis…</p>

<style>
	.aq-redirect {
		padding: 2rem 1.25rem;
		font-family: var(--font-sans, system-ui, sans-serif);
		font-size: 0.9rem;
		opacity: 0.7;
	}
</style>
