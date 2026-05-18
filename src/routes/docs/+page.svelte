<script lang="ts">
	const sections: { id: string; title: string }[] = [
		{ id: 'mission', title: 'What this tool is for' },
		{ id: 'features', title: 'Feature surface' },
		{ id: 'attribution', title: 'Sources, attribution, inspiration' },
		{ id: 'science', title: 'Scientific notes (what we measure)' },
		{ id: 'tech', title: 'Tech stack + deployment' },
	];
</script>

<svelte:head>
	<title>darkmap.tinyland.dev — docs</title>
	<meta
		name="description"
		content="darkmap.tinyland.dev — an ad-free, tailnet-hosted dark-sky / sensor / astronomy planning tool. Sources, science notes, tech stack."
	/>
</svelte:head>

<article class="docs container mx-auto max-w-4xl px-6 py-12 text-sm leading-relaxed">
	<header class="mb-8">
		<h1 class="font-mono text-2xl font-bold tracking-tight">docs</h1>
		<p class="text-surface-700-300 mt-2">
			darkmap.tinyland.dev — a tailnet-only planning surface for instrumentation, sensor, and astronomy field work.
		</p>
	</header>

	<nav class="mb-10 flex flex-wrap gap-3 text-xs" aria-label="On-page navigation">
		{#each sections as s (s.id)}
			<a href="#{s.id}" class="hover:text-primary-500 underline-offset-2 hover:underline">{s.title}</a>
		{/each}
	</nav>

	<section id="mission" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">What this tool is for</h2>
		<p class="mb-3">
			darkmap is a planning + readout surface for night-dependent measurement work — instrumentation and sensor
			calibration, ground-based astronomy and astrophotography, satellite-overhead windows, temperature- and
			night-dependent radar campaigns, and dark-sky-site logistics.
		</p>
		<p>
			The original problem statement was "lightpollutionmap.info but without the ads and the latency." We solved that
			and kept going. The current surface is squarely tuned for our needs and the needs of the dark-sky / spectroscopy
			community on this tailnet.
		</p>
	</section>

	<section id="features" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">Feature surface</h2>
		<ul class="list-disc space-y-2 pl-6">
			<li>
				<strong>VIIRS DNB radiance</strong> — annual composites 2012-2019 + monthly composites Apr 2012 → Apr 2026 (169 months)
				with a play / scrub time slider
			</li>
			<li>
				<strong>Falchi 2016 World Atlas</strong> — both the styled visualization and the raw mcd/m² grid (with Bortle / class
				mapping in the point-query readout)
			</li>
			<li>
				<strong>Per-view ephemeris</strong> — sun + moon position, twilight gantt (astro / nautical / civil), sky compass
				with sun trajectory arc + moon position + atmospheric airmass
			</li>
			<li>
				<strong>Real-terrain horizon</strong> — 36-ray, 10-distance raycast over AWS Mapzen Terrarium tiles; sun / moon altitude
				is reported relative to the local horizon polygon at its azimuth, and event times can be refined to true-horizon crossings
			</li>
			<li>
				<strong>Per-viewport range pill</strong> — 4×4 grid sampling across the visible viewport so e.g. civil dusk "Δ 26
				min" surfaces the spread when you're looking at a state-sized region
			</li>
			<li>
				<strong>Geocoder</strong> — search for a place (typo-tolerant), or paste coords as decimal / DMS / DMM
			</li>
			<li>
				<strong>Shareable URLs</strong> — the hash captures view + active layers + basemap + ephemeris cursor + monthly slider
				position + autoplay flag
			</li>
		</ul>
	</section>

	<section id="attribution" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">Sources, attribution, inspiration</h2>
		<p class="mb-3">
			darkmap was originally inspired by Jurij Stare's
			<a href="https://www.lightpollutionmap.info" class="underline">lightpollutionmap.info</a>
			— the canonical web map for the underlying VIIRS / Falchi datasets. We have since broadened scope significantly (per-view
			ephemeris, real-terrain horizon raycasting, instrumented sensor and astrophotography workflows) and now stand on our
			own. We acknowledge the original idea + the upstream GeoServer that hosts publicly available scientific data:
		</p>
		<dl class="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_1fr]">
			<dt class="font-semibold">NASA VIIRS DNB</dt>
			<dd>
				Suomi-NPP Visible Infrared Imaging Radiometer Suite Day/Night Band. Composites by NOAA NCEI + the Earth
				Observation Group.
			</dd>
			<dt class="font-semibold">Falchi 2016 World Atlas</dt>
			<dd>
				Falchi et al., Sci. Adv. 2 (2016) — <em>"The new world atlas of artificial night sky brightness"</em>. mcd/m²
				radiance grid + classification.
			</dd>
			<dt class="font-semibold">lightpollutionmap.info GeoServer</dt>
			<dd>
				Public WMS at <code>www2.lightpollutionmap.info/geoserver</code>. We proxy through
				<code>/api/raster</code> to strip Prebid + ad-tracking headers and inject sane caching.
			</dd>
			<dt class="font-semibold">AWS Mapzen Terrarium</dt>
			<dd>
				Free, global, RGB-encoded elevation tiles at <code>s3://elevation-tiles-prod/terrarium/</code>
				— the input to the horizon-polygon raycaster.
			</dd>
			<dt class="font-semibold">Photon (komoot)</dt>
			<dd>
				Typo-tolerant OSM-backed geocoder; data © OpenStreetMap contributors, ODbL. Proxied through
				<code>/api/geocode</code>.
			</dd>
			<dt class="font-semibold">astronomy-engine</dt>
			<dd>
				cosinekitty's high-precision VSOP87 + lunar ephemeris, validated against USNO MICA to ~1 arcsec. The sun / moon
				/ twilight math is theirs.
			</dd>
			<dt class="font-semibold">Carto Dark Matter / ESRI / OpenStreetMap</dt>
			<dd>The three basemap options.</dd>
		</dl>
	</section>

	<section id="science" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">Scientific notes</h2>
		<h3 class="mt-4 mb-2 font-mono text-base font-semibold">VIIRS units</h3>
		<p class="mb-3">
			VIIRS DNB radiance is reported in nW · cm⁻² · sr⁻¹ on the upstream rasters. The styled composites apply a NOAA
			color ramp; the raw GRAY_INDEX values are what feed our Bortle-class mapping in the point-readout panel.
		</p>
		<h3 class="mt-4 mb-2 font-mono text-base font-semibold">Falchi class boundaries</h3>
		<p class="mb-3">
			Falchi's six-class scheme — Pristine / Wilderness / Rural / Suburban / Urban / Inner City — maps onto mcd/m²
			thresholds. We surface the class label in the readout next to the raw radiance.
		</p>
		<h3 class="mt-4 mb-2 font-mono text-base font-semibold">Airmass</h3>
		<p class="mb-3">
			The X chip in the sky compass uses Kasten &amp; Young (1989) — better than plane-parallel sec(z) below ~30°
			altitude where atmospheric curvature dominates.
		</p>
		<h3 class="mt-4 mb-2 font-mono text-base font-semibold">Horizon raycaster</h3>
		<p>
			Default 36 rays × 10 distance samples (250 m → 25 km). Each sample uses a refraction-adjusted earth-curvature drop
			(R_eff = 7/6 · R) when computing angular elevation. Polygon results are cached per (lat, lon) rounded to ~0.001° +
			options key; revisit is instant.
		</p>
	</section>

	<section id="tech" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">Tech stack</h2>
		<ul class="list-disc space-y-2 pl-6">
			<li>SvelteKit (adapter-node), Svelte 5 runes, Skeleton 4.15.2, Tailwind v4</li>
			<li>MapLibre GL JS 5 for the map surface</li>
			<li>Effect.ts service layers — RasterClient, EphemerisClient, HorizonProvider, GeocoderClient</li>
			<li>astronomy-engine (cosinekitty) for sun / moon math</li>
			<li>
				Bazel 8 + Bzlmod via tinyland-inc/bazel-registry, with the MassageIthaca cache-attachment-contract pattern for
				RBE
			</li>
			<li>
				OpenTofu, kustomize, Tailscale operator on the blahaj RKE2 cluster. State in rustfs S3. Tailnet-only via CIDR
				whitelist on nginx ingress.
			</li>
		</ul>
		<p class="text-surface-700-300 mt-4 text-xs">
			See <a href="https://github.com/Jesssullivan/darkmap.tinyland.dev" class="underline">the repo</a> for AGENTS.md, README.md,
			and the full deploy runbook.
		</p>
	</section>
</article>

<style>
	.docs :global(h2) {
		scroll-margin-top: 6rem;
	}
	.docs :global(a) {
		color: inherit;
	}
	.docs :global(a):hover {
		text-decoration: underline;
	}
	.docs :global(code) {
		background: rgba(255, 255, 255, 0.06);
		padding: 0.1em 0.35em;
		border-radius: 3px;
		font-size: 0.85em;
	}
</style>
