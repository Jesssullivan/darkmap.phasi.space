<script lang="ts">
	const sections: { id: string; title: string }[] = [
		{ id: 'mission', title: 'What this tool is for' },
		{ id: 'features', title: 'Feature surface' },
		{ id: 'attribution', title: 'Sources, attribution, inspiration' },
		{ id: 'science', title: 'Scientific notes (what we measure)' },
		{ id: 'atmosphere', title: 'Atmospheric overlays + transmission' },
		{ id: 'tech', title: 'Tech stack + deployment' },
		{ id: 'contact', title: 'Contact' },
	];
</script>

<svelte:head>
	<title>darkmap — docs</title>
	<meta
		name="description"
		content="darkmap — a dark-sky, field-sensing, and astronomy planning tool. Sources, science notes, tech stack."
	/>
</svelte:head>

<article class="docs container mx-auto max-w-4xl px-6 py-12 text-sm leading-relaxed">
	<header class="mb-8">
		<h1 class="font-mono text-2xl font-bold tracking-tight">docs</h1>
		<p class="text-surface-700-300 mt-2">
			darkmap — a planning surface for instrumentation, sensor, astronomy, and low-light field work.
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
			The original problem statement was inspired by lightpollutionmap.info: a faster, calmer dark-sky planning surface
			without ad-tech or tracking. The current surface is tuned for dark-sky, spectroscopy, photography, and field
			logistics work.
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
			— a long-running public map surface for VIIRS and Falchi light-pollution data. It is an inspiration and comparison point,
			not an affiliation or primary data attribution. Scientific and software attributions are listed below:
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
			<dt class="font-semibold">Current WMS transport</dt>
			<dd>
				Selected public light-pollution rasters currently load through a public GeoServer WMS transport. We proxy
				through
				<code>/api/raster</code> to normalize caching and keep ad-tech headers out of darkmap responses.
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

	<section id="atmosphere" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">Atmospheric overlays + transmission</h2>
		<p>
			The Atmosphere section of the Layer rail surfaces four NASA GIBS raster overlays plus an OpenAQ ground-station
			PM2.5 heatmap. Drop a pin to see point-source RH / cloud cover / visibility via Open-Meteo, and tap the <code
				>i</code
			>
			chevron on any atmospheric row to open the <em>transmission widget</em>, which renders the spectral transmission
			curve T(λ) for the active inputs.
		</p>
		<h3 class="mt-5 font-mono text-sm font-bold uppercase tracking-wide opacity-70">Data sources (V1)</h3>
		<ul class="mt-2 list-disc space-y-2 pl-6">
			<li>
				<strong>NASA GIBS WMTS</strong> — clouds (MODIS Terra AM, VIIRS NOAA-20 PM), aerosol (MODIS Combined AOD @ 550 nm),
				water vapor (MODIS Terra infrared, 5 km). Public domain; "Imagery courtesy NASA EOSDIS GIBS" surfaces in the MapLibre
				attribution control when any GIBS layer is on.
			</li>
			<li>
				<strong>Open-Meteo /v1/forecast</strong> — point RH, layered cloud cover, visibility. CC-BY 4.0, no key
				required; proxied through <code>/api/atmospheric/point</code>. PWV is treated as unavailable until a supported
				point source is wired.
			</li>
			<li>
				<strong>OpenAQ v3</strong> — PM2.5 ground stations in the viewport bbox, CC-BY 4.0. Requires an
				<code>OPENAQ_API_KEY</code> env on the server; absent that, the proxy returns an empty FeatureCollection so the overlay
				renders nothing instead of throwing.
			</li>
		</ul>

		<h3 class="mt-5 font-mono text-sm font-bold uppercase tracking-wide opacity-70">Transmission methodology</h3>
		<p>
			The transmission widget interpolates a pre-baked LUT shipped at <code>/spectral-lut.json</code>. The LUT axes are
			PWV (mm), AOD<sub>550</sub>, Ångström exponent, total ozone column (DU), and zenith angle; the wavelength grid
			spans ~0.3 µm → 30 µm.
		</p>
		<p class="mt-2">
			<strong>Current LUT — <code>smarts-analog-v1</code></strong>: improved engineering model in the spirit of SMARTS.
			Bodhaine 1999 Rayleigh with depolarization factor; Pierluissi-Maragoudakis 1986 water-vapor band model with τ ∝ u<sup
				>b</sup
			>·profile (b ≈ 0.78) capturing the column-scaling saturation a pure Gaussian misses; Bass-Paur Hartley + Huggins +
			Chappuis ozone; Kasten-Young airmass. Still an engineering estimate; expected error ~5-10 % in clean-sky cases.
		</p>
		<p class="mt-2">
			<strong>V0 archive (PR-G)</strong>: simpler analytical bake — pure λ<sup>−4.09</sup> Rayleigh, Gaussian-only H₂O
			bands. The V0 model shipped first to land the LUT contract; V3a-2 swapped it for <code>smarts-analog-v1</code>
			without touching the service or widget code.
		</p>

		<h3 class="mt-5 font-mono text-sm font-bold uppercase tracking-wide opacity-70">V2: live aerosol recompute</h3>
		<p>
			The transmission widget surfaces an aerosol-type picker (Smoke / Dust / Urban / Pollen / Mixed). When a type is
			selected, the LUT-baked aerosol cell is bypassed and replaced with a live Bohren-Huffman 1983 Mie computation in
			the browser — `mie(x, n+ik)` integrated over the type's log-normal size distribution against published
			refractive-index data. The user-supplied AOD<sub>550</sub> calibrates the magnitude; the spectral shape comes from
			the Mie integration. Sources: <a href="https://doi.org/10.5194/acp-5-799-2005" class="underline">Reid 2005</a>
			(smoke), d'Almeida 1991 / OPAC (dust, mixed), Hess 1998 OPAC (urban), Griffiths 2012 (pollen). The pure-TS Mie core
			is validated against the geometric optics and Rayleigh limits.
		</p>
		<p class="mt-2">
			Source-chip in the widget reads <code>smarts-analog-v1+live-mie:&lt;type&gt;</code> when the live aerosol path is active
			— making the model lineage explicit alongside the engineering-estimate disclaimer.
		</p>
		<h3 class="mt-5 font-mono text-sm font-bold uppercase tracking-wide opacity-70">
			V3b: line-by-line for named bands
		</h3>
		<p>
			Beyond the coarse LUT, seven named astronomy bands have a high-resolution line-by-line bake at 0.01 nm sampling:
			the H₂O ρστ / Φ / ψ / Ω windows (940 / 1130 / 1380 / 1870 nm), the O₂ A-band (762 nm) and telluric O₂-X γ-band
			(628 nm), and the CO₂ ν₃ asymmetric-stretch fundamental at 4.3 µm. Clicking a band chip in the transmission widget
			opens an in-sheet detail panel showing the full Voigt profile across that window.
		</p>
		<p class="mt-2">
			Line data is curated from <a href="https://hitran.org/" class="underline" rel="noreferrer external">HITRAN2020</a>
			(Gordon et al. 2022, JQSRT 277, 107949). The full catalog is gated behind free registration; we ship a representative
			subset in <code>data/hitran/</code> with a documented regeneration workflow for users who want line-data refreshes.
			Voigt profile evaluation uses Thompson 1987 pseudo-Voigt against the Olivero-Longbothum 1977 combined HWHM — ~1 % accurate
			and fast enough for in-bake per-line per-wavelength evaluation.
		</p>
		<p class="mt-2">
			Per-band JSONs ship at <code>/spectral-lbl/[band-id].json</code> and load lazily on first zoom. Total payload across
			all 7 bands is ~1.2 MB; only the bands the user actually clicks get fetched.
		</p>

		<p class="mt-2">
			<strong>V3 next steps</strong>: the LUT JSON contract stays stable across model swaps. A future drop-in replaces
			<code>spectral-lut.json</code> with offline
			<a href="https://www.nrel.gov/grid/solar-resource/smarts.html" class="underline" rel="noreferrer external"
				>SMARTS</a
			>
			(0.3 – 4 µm) +
			<a href="https://github.com/paulricchiazzi/SBDART" class="underline" rel="noreferrer external">SBDART</a>
			(4 – 30 µm) output against the US Standard Atmosphere. V3b adds Py4CAtS / HITRAN line-by-line for the named astronomy
			bands (H₂O 940/1130/1380/1870 nm, O₂ A-band, telluric O₂-X, CO₂ 4.3 µm) — selective high-resolution overlays loaded
			on demand. Widget code stays unchanged across all generations.
		</p>

		<h3 class="mt-5 font-mono text-sm font-bold uppercase tracking-wide opacity-70">Caveats</h3>
		<ul class="mt-2 list-disc space-y-2 pl-6">
			<li>
				<strong>Engineering estimate.</strong> V1 is good to within ±10 % at clean-sky standard atmospheres in the visible
				/ NIR; the IR thermal bands beyond 5 µm get noticeably less accurate. For real instrument planning, cross-check against
				MODTRAN or libRadtran.
			</li>
			<li>
				<strong>AOD defaults to 0.15 in the widget</strong> until pixel-sampling against the MODIS Combined AOD raster lands.
				The displayed input chip shows the effective value.
			</li>
			<li>
				<strong>Zenith defaults to 30°.</strong> Solar-zenith computation from the current ephemeris time + lat / lon is a
				follow-up.
			</li>
		</ul>
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
			<li>OpenTofu and kustomize for the current deploy path. Runtime secrets stay outside the repository.</li>
		</ul>
		<p class="text-surface-700-300 mt-4 text-xs">
			See <a href="https://github.com/Jesssullivan/darkmap.phasi.space" class="underline">the repo</a> for source, issues,
			and contribution context.
		</p>
	</section>

	<section id="contact" class="mt-12">
		<h2 class="mb-3 font-mono text-lg font-bold">Contact</h2>
		<p>
			darkmap is a personal project. The fastest paths to reach a human are GitHub for code and feature work, and the
			coordinated disclosure flow for anything security-shaped.
		</p>
		<ul class="mt-3 list-disc space-y-2 pl-6">
			<li>
				<strong>Bugs, requests, questions</strong>:
				<a href="https://github.com/Jesssullivan/darkmap.phasi.space/issues" class="underline">open an issue</a> on GitHub.
			</li>
			<li>
				<strong>Security disclosures</strong>:
				<a
					href="https://github.com/Jesssullivan/darkmap.phasi.space/security/advisories/new"
					class="underline"
					rel="noopener">file a private advisory</a
				>
				— do not file public issues for vulnerabilities. See
				<a href="https://github.com/Jesssullivan/darkmap.phasi.space/blob/main/SECURITY.md" class="underline">
					SECURITY.md</a
				> for the response window and PGP key.
			</li>
			<li>
				<strong>Tinyland context</strong>: this repo is one of several static spokes under
				<a href="https://tinyland.dev" class="underline">tinyland.dev</a>; cross-repo coordination happens on the
				tinyland-inc org.
			</li>
		</ul>
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
