<script lang="ts">
	/**
	 * AqDashboard — air-quality analysis dashboard body (V6-4, TIN-1756; TIN-1871).
	 *
	 * A point-anchored surface that answers "is the air getting better/worse, and
	 * do the sources agree?" by pulling together the pieces V6 built across the
	 * map's floating panels:
	 *   • time-series history (V6-2) — the trend,
	 *   • multi-pollutant + US-EPA AQI (V5) — what's in the air now,
	 *   • OpenAQ↔CAMS source cross-validation (V6-3) — do the sources agree.
	 *
	 * TIN-1871 — this body was extracted verbatim from `routes/aq/+page.svelte`
	 * so it can mount inside the in-SPA AQ modal-popout (AqModal) instead of a
	 * dedicated route. The data path (Effect services, the charts, the cross-val,
	 * the geocoder, the provenance/coverage/honesty rules) is UNCHANGED — this is
	 * a move, not a rewrite. Selection is seeded from a `seed` prop (the pinned
	 * point/hash) AND the self-contained geocoder; every series carries its
	 * provenance + coverage; gaps stay gaps; a missing source is "no data", never
	 * agreement or clean air.
	 */

	import { onMount, untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { Effect } from 'effect';

	import GeocoderSearch from '$lib/components/GeocoderSearch.svelte';
	import TimeSeriesChart from '$lib/components/charts/TimeSeriesChart.svelte';
	import { encodeHash } from '$lib/url-hash';

	import {
		OpenAQService,
		OpenAQServiceLive,
		type OpenAQSensorCollection,
		type PollutantName,
	} from '$lib/effect/services/OpenAQService';
	import {
		AirQualityService,
		AirQualityServiceLive,
		type AirQualityPointReading,
	} from '$lib/effect/services/AirQualityService';
	import { OpenAQHistoryService, OpenAQHistoryServiceLive } from '$lib/effect/services/OpenAQHistoryService';

	import {
		DEFAULT_DIFFUSION,
		estimatePollutantAt,
		pm25ToAod550,
		type Pm25Estimate,
		type Pm25Station,
	} from '$lib/atmospheric/pm25-diffusion';
	import { computeAqi, type AqiPollutant, type AqiResult } from '$lib/atmospheric/aqi';
	import { crossValidate, type CrossValResult } from '$lib/atmospheric/aq-crossval';
	import { type HistorySeries, type HistoryPollutantName } from '$lib/atmospheric/openaq-history-shape';
	import { buildViewportSummary, type ViewportSummary } from '$lib/atmospheric/viewport-summary';
	import { modelCardFor } from '$lib/atmospheric/model-cards';

	/** A point + time seed handed in by the host (the pinned map point / shared hash). */
	export interface AqSeed {
		readonly lat: number;
		readonly lon: number;
		readonly label?: string | null;
		readonly time?: Date;
	}

	interface Props {
		/**
		 * Seed point/time (from the pinned map point or the shareable hash). When
		 * present the dashboard analyses it immediately; a later geocoder pick
		 * supersedes it. Null/absent ⇒ the "pick a location" empty state.
		 */
		seed?: AqSeed | null;
		/** Optional "View on map" link target; the modal host passes a closer instead. */
		onViewOnMap?: () => void;
	}

	let { seed = null, onViewOnMap }: Props = $props();

	interface Selected {
		readonly lat: number;
		readonly lon: number;
		readonly label: string | null;
		readonly time: Date;
	}

	const POLLUTANT_LABELS: Record<AqiPollutant, string> = {
		pm25: 'PM2.5',
		pm10: 'PM10',
		o3: 'O₃',
		no2: 'NO₂',
		so2: 'SO₂',
		co: 'CO',
	};
	const HISTORY_PARAMS: readonly HistoryPollutantName[] = ['pm25', 'pm10', 'o3', 'no2', 'so2', 'co'];
	const WINDOWS: readonly { hours: number; label: string }[] = [
		{ hours: 24, label: '24 h' },
		{ hours: 72, label: '72 h' },
		{ hours: 168, label: '7 d' },
	];
	/** Half-width of the station bbox sampled around the point (degrees). */
	const BBOX_HALF_DEG = 0.75;

	let selected = $state<Selected | null>(null);

	// Point readings (one generation per selection; a newer pick wins). The
	// generation guard blocks stale STATE writes; the AbortController also cancels
	// the stale in-flight HTTP requests (mirrors the map page's readout fetch).
	let gen = 0;
	let pointController: AbortController | undefined;
	let loadingPoint = $state(false);
	let stations = $state<Pm25Station[]>([]);
	let pollutantUnits = $state<Record<string, string>>({});
	let openaqDegraded = $state(false);
	let openaqReached = $state(false);
	let cams = $state<AirQualityPointReading | null>(null);
	let camsReached = $state(false);

	// History (its own generation: pollutant + window are independently selectable).
	let histGen = 0;
	let historyController: AbortController | undefined;
	let historyParam = $state<HistoryPollutantName>('pm25');
	let historyHours = $state(24);
	let history = $state<HistorySeries | null>(null);
	let historyLoading = $state(false);

	// ---- Derived analysis (pure; over the tested shaping modules) ----

	// Diffuse every criteria pollutant at the point in ONE pass; pm25Estimate and
	// perPollutant both read from it. estimatePollutantAt(...,'pm25') maps
	// `value: s.value` then calls estimatePm25At, so it equals the PM2.5 estimate.
	const pollutantEstimates = $derived.by<{ pollutant: AqiPollutant; est: Pm25Estimate }[]>(() => {
		const sel = selected;
		if (!sel || stations.length === 0) return [];
		return HISTORY_PARAMS.map((p) => ({
			pollutant: p as AqiPollutant,
			est: estimatePollutantAt(stations, sel.lon, sel.lat, p as PollutantName, DEFAULT_DIFFUSION),
		}));
	});

	const pm25Estimate = $derived<Pm25Estimate | null>(
		pollutantEstimates.find((r) => r.pollutant === 'pm25')?.est ?? null,
	);

	const perPollutant = $derived.by(() =>
		pollutantEstimates
			.filter((r) => r.est.valueUgm3 !== null)
			.map((r) => ({ pollutant: r.pollutant, est: r.est, units: pollutantUnits[r.pollutant] })),
	);

	const aqiResult = $derived.by<AqiResult | null>(() =>
		computeAqi(perPollutant.map((r) => ({ pollutant: r.pollutant, value: r.est.valueUgm3 as number, units: r.units }))),
	);

	const viewportSummary = $derived.by<ViewportSummary | null>(() =>
		openaqReached ? buildViewportSummary(stations) : null,
	);

	const crossVal = $derived.by<CrossValResult | null>(() => {
		if (!selected || !openaqReached || !camsReached) return null;
		const openaqPm25 = pm25Estimate?.valueUgm3 ?? null;
		return crossValidate({
			openaqPm25,
			openaqAod550FromPm25: openaqPm25 !== null ? pm25ToAod550(openaqPm25) : null,
			camsPm25: cams?.pm25 ?? null,
			camsAod550: cams?.aod550 ?? null,
		});
	});

	// ---- Selection ----

	function selectPoint(sel: Selected): void {
		selected = sel;
		void loadPoint(sel);
		void loadHistory(sel);
	}

	function onGeocode(s: { lat: number; lon: number; label: string }): void {
		selectPoint({ lat: s.lat, lon: s.lon, label: s.label, time: selected?.time ?? new Date() });
	}

	// ---- Data loads (isolated; each failure degrades its own panel only, and a
	//      new selection aborts the prior load's in-flight requests) ----

	async function loadPoint(sel: Selected): Promise<void> {
		const my = ++gen;
		pointController?.abort(); // cancel the previous point's in-flight requests
		const controller = new AbortController();
		pointController = controller;
		const { signal } = controller;
		loadingPoint = true;
		openaqReached = false;
		camsReached = false;
		const bbox = {
			west: sel.lon - BBOX_HALF_DEG,
			south: sel.lat - BBOX_HALF_DEG,
			east: sel.lon + BBOX_HALF_DEG,
			north: sel.lat + BBOX_HALF_DEG,
		};
		const [openaqExit, camsExit] = await Promise.all([
			Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* OpenAQService;
					return yield* svc.getSensors(bbox, { signal });
				}).pipe(Effect.provide(OpenAQServiceLive)),
			),
			Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* AirQualityService;
					return yield* svc.getReading({ lat: sel.lat, lon: sel.lon, time: sel.time }, { signal });
				}).pipe(Effect.provide(AirQualityServiceLive)),
			),
		]);
		if (my !== gen || signal.aborted) return;

		if (openaqExit._tag === 'Success') {
			const fc: OpenAQSensorCollection = openaqExit.value;
			stations = fc.features.map((f) => ({
				lon: f.geometry.coordinates[0],
				lat: f.geometry.coordinates[1],
				value: f.properties.value,
				pollutants: Object.fromEntries(
					Object.entries(f.properties.pollutants ?? {}).map(([name, r]) => [name, r?.value ?? null]),
				),
			}));
			const units: Record<string, string> = {};
			for (const f of fc.features) {
				for (const [name, r] of Object.entries(f.properties.pollutants ?? {})) {
					if (r?.units && !units[name]) units[name] = r.units;
				}
			}
			pollutantUnits = units;
			openaqDegraded = !!fc.degraded;
			openaqReached = true;
		} else {
			stations = [];
			openaqDegraded = false;
			openaqReached = true; // reached the boundary; just no data
		}

		cams = camsExit._tag === 'Success' ? camsExit.value : null;
		camsReached = true;
		loadingPoint = false;
	}

	async function loadHistory(sel: Selected): Promise<void> {
		const my = ++histGen;
		historyController?.abort(); // cancel the previous param/window's in-flight request
		const controller = new AbortController();
		historyController = controller;
		const { signal } = controller;
		history = null;
		historyLoading = true;
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OpenAQHistoryService;
				return yield* svc.getHistory(
					{ lat: sel.lat, lon: sel.lon, param: historyParam, hours: historyHours },
					{ signal },
				);
			}).pipe(Effect.provide(OpenAQHistoryServiceLive)),
		);
		if (my !== histGen || signal.aborted) return;
		history = exit._tag === 'Success' ? exit.value.series : null;
		historyLoading = false;
	}

	function setHistoryParam(p: HistoryPollutantName): void {
		historyParam = p;
		if (selected) void loadHistory(selected);
	}
	function setHistoryHours(h: number): void {
		historyHours = h;
		if (selected) void loadHistory(selected);
	}

	// Seed-driven selection. The host (the AQ modal) re-seeds when a fresh point is
	// piped in (a new pin or a shared `/aq#m=…` deep-link), so analyse whenever the
	// seed coordinate/time changes. untrack() keeps the load off the derived graph.
	$effect(() => {
		const s = seed;
		if (!s) return;
		untrack(() => {
			const cur = selected;
			const t = s.time ?? cur?.time ?? new Date();
			// Re-seed only on an actual coordinate/time change — a no-op seed must not
			// re-fire the fetch (and re-abort an in-flight one) on every render.
			if (cur && cur.lat === s.lat && cur.lon === s.lon && cur.time.getTime() === t.getTime()) return;
			selectPoint({ lat: s.lat, lon: s.lon, label: s.label ?? null, time: t });
		});
	});

	onMount(() => () => {
		// The modal unmounts this on close; cancel any in-flight loads so a stale
		// response can't resolve into a torn-down component.
		pointController?.abort();
		historyController?.abort();
	});

	// ---- Formatting helpers ----

	const fmtCoord = (n: number): string => n.toFixed(4);
	const fmtTimeUtc = (d: Date): string => `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
	const fmtNearest = (km: number | null): string => (km === null ? '' : ` · nearest ${km.toFixed(km < 10 ? 1 : 0)} km`);
	const confLabel: Record<Pm25Estimate['confidence'], string> = { high: 'high', low: 'low', none: 'none' };

	// The shareable "view on map" href, kept for the no-host fallback (a hosting
	// modal supplies onViewOnMap which closes + recentres instead of navigating).
	const mapHref = $derived(
		browser && selected
			? `/${encodeHash({ view: { lat: selected.lat, lon: selected.lon, zoom: 9 }, time: selected.time })}`
			: '/',
	);
</script>

<div class="aq">
	<header class="aq-header">
		<div class="title-row">
			<h1 class="h3">Air-quality analysis</h1>
			{#if selected}
				{#if onViewOnMap}
					<button type="button" class="map-link" onclick={onViewOnMap}>← View on map</button>
				{:else}
					<a class="map-link" href={mapHref}>← View on map</a>
				{/if}
			{/if}
		</div>
		<div class="search">
			<GeocoderSearch inline placeholder="Search a place or paste coordinates…" onSelect={onGeocode} />
		</div>
		{#if selected}
			<p class="loc">
				<span class="loc-name">{selected.label ?? 'Selected point'}</span>
				<span class="loc-coord">{fmtCoord(selected.lat)}, {fmtCoord(selected.lon)}</span>
				<span class="loc-time">{fmtTimeUtc(selected.time)}</span>
			</p>
		{/if}
	</header>

	{#if !selected}
		<section class="empty-state" aria-live="polite">
			<p class="empty-lead">Pick a location to analyze its air quality.</p>
			<p class="empty-sub">Search above, or pin a point on the map and choose “Air-quality dashboard”.</p>
		</section>
	{:else}
		<div class="panels">
			<!-- Multi-pollutant + AQI -->
			<section class="card">
				<div class="card-head">
					<h2 class="h5">Multi-pollutant · AQI</h2>
					<span class="card-info" title={modelCardFor('smog-openaq-pm25')?.what}>ⓘ</span>
				</div>
				{#if loadingPoint && !openaqReached}
					<p class="muted">Loading stations…</p>
				{:else if !aqiResult}
					<p class="muted">
						No criteria-pollutant coverage near this point{openaqDegraded ? ' (OpenAQ unavailable)' : ''}. Nothing to
						index — shown as no data, not clean air.
					</p>
				{:else}
					{@const cat = aqiResult.category}
					<div class="aqi-badge" style={`--cat:${cat.color}`}>
						<span class="aqi-num">{aqiResult.aqi}</span>
						<span class="aqi-meta">
							<span class="aqi-cat">{cat.name}</span>
							<span class="aqi-dom">dominant {POLLUTANT_LABELS[aqiResult.dominant]}</span>
						</span>
					</div>
					<ul class="pollutant-list">
						{#each perPollutant as r (r.pollutant)}
							<li>
								<span class="p-name">{POLLUTANT_LABELS[r.pollutant]}</span>
								<span class="p-val"
									>{r.est.valueUgm3?.toFixed(r.est.valueUgm3 < 10 ? 1 : 0)}<span class="unit">
										{r.units ?? 'µg/m³'}</span
									></span
								>
								<span class="p-sub"
									>{r.est.contributingStations} stn · {confLabel[r.est.confidence]}{fmtNearest(r.est.nearestKm)}</span
								>
							</li>
						{/each}
					</ul>
					<p class="provenance">
						OpenAQ ground stations, diffused to the point (modeled). AQI ≈ instantaneous nowcast, not the official
						averaging windows.
					</p>
				{/if}
			</section>

			<!-- Time-series history -->
			<section class="card">
				<div class="card-head">
					<h2 class="h5">History</h2>
					<span class="card-info" title={modelCardFor('openaq-pm25-history')?.what}>ⓘ</span>
				</div>
				<div class="controls">
					<div class="seg" role="group" aria-label="Pollutant">
						{#each HISTORY_PARAMS as p (p)}
							<button type="button" class:active={historyParam === p} onclick={() => setHistoryParam(p)}>
								{POLLUTANT_LABELS[p as AqiPollutant]}
							</button>
						{/each}
					</div>
					<div class="seg" role="group" aria-label="Window">
						{#each WINDOWS as w (w.hours)}
							<button type="button" class:active={historyHours === w.hours} onclick={() => setHistoryHours(w.hours)}>
								{w.label}
							</button>
						{/each}
					</div>
				</div>
				{#if historyLoading}
					<p class="muted">Loading history…</p>
				{:else if !history || history.sampleCount === 0}
					<p class="muted">
						No hourly samples for {POLLUTANT_LABELS[historyParam as AqiPollutant]} at the nearest station in this window.
					</p>
				{:else}
					<TimeSeriesChart
						points={history.points}
						units={history.units}
						ariaLabel={`${POLLUTANT_LABELS[historyParam as AqiPollutant]} hourly history`}
					/>
					<div class="hist-stats">
						<span class="hist-mean">
							{#if history.mean === null}<span class="muted">—</span>{:else}{history.mean.toFixed(
									history.mean < 10 ? 1 : 0,
								)}{/if}
							<span class="unit">{history.units ?? 'µg/m³'}</span>
							<span class="trend trend-{history.trend}" aria-hidden="true">
								{history.trend === 'rising' ? '↑' : history.trend === 'falling' ? '↓' : '→'}
							</span>
						</span>
						<span class="hist-sub"
							>mean · {history.sampleCount} samples{history.stale
								? ` · stale (${history.latestAt?.slice(0, 10)})`
								: ''}</span
						>
					</div>
					<p class="provenance">
						OpenAQ nearest station, {history.windowFrom.slice(0, 16).replace('T', ' ')}–{history.windowTo.slice(
							11,
							16,
						)}Z. Only reported hours are drawn; gaps are left as gaps.
					</p>
				{/if}
			</section>

			<!-- Source cross-validation -->
			<section class="card">
				<div class="card-head">
					<h2 class="h5">Source cross-check</h2>
					<span class="card-info" title={modelCardFor('aq-crossval')?.what}>ⓘ</span>
				</div>
				{#if !crossVal}
					<p class="muted">Loading sources…</p>
				{:else if crossVal.pairs.length === 0}
					<p class="muted">{crossVal.emptyReason ?? 'Not enough overlapping data to compare.'}</p>
				{:else}
					<ul class="xval-list">
						{#each crossVal.pairs as pair (pair.quantity)}
							<li class="xval xval-{pair.level}">
								<div class="xval-top">
									<span class="xval-q">{pair.quantity === 'pm25' ? 'PM2.5' : 'AOD550'}</span>
									<span class="xval-level">{pair.level}</span>
								</div>
								<div class="xval-vals">
									<span>{pair.a.label}: {pair.a.value?.toFixed(2)}</span>
									<span>{pair.b.label}: {pair.b.value?.toFixed(2)} {pair.units}</span>
								</div>
								<p class="xval-note">{pair.note}</p>
							</li>
						{/each}
					</ul>
					<p class="provenance">
						Numeric compare is OpenAQ (measured, diffused) ↔ CAMS (modeled) only. GIBS MODIS AOD stays a visual
						cross-check on the map. Sources are compared only where both reported a value.
					</p>
				{/if}
			</section>

			<!-- Area overview (the bbox the point was diffused from) -->
			<section class="card">
				<div class="card-head">
					<h2 class="h5">Area overview</h2>
					<span
						class="card-info"
						title="OpenAQ stations within ±0.75° of the point (server-filtered to recent readings).">ⓘ</span
					>
				</div>
				{#if loadingPoint && !openaqReached}
					<p class="muted">Loading stations…</p>
				{:else if !viewportSummary || viewportSummary.stationCount === 0}
					<p class="muted">No OpenAQ stations in this area{openaqDegraded ? ' (OpenAQ unavailable)' : ''}.</p>
				{:else}
					<p class="area-count">
						<strong>{viewportSummary.stationCount}</strong> station{viewportSummary.stationCount === 1 ? '' : 's'}
						· <strong>{viewportSummary.pm25StationCount}</strong> reporting PM2.5
					</p>
					{#if viewportSummary.aqi}
						{@const a = viewportSummary.aqi}
						<div class="spread" aria-label={`PM2.5 AQI spread ${a.min} to ${a.max}`}>
							<span class="spread-end">{a.min}</span>
							<span class="spread-bar">
								<span class="spread-fill" style={`--cat:${a.maxCategory.color}`}></span>
								<span class="spread-median" title={`median ${a.median}`}>{a.median}</span>
							</span>
							<span class="spread-end" style={`color:${a.maxCategory.color}`}>{a.max}</span>
						</div>
						<p class="muted area-cat">PM2.5 AQI · worst {a.maxCategory.name}</p>
					{:else}
						<p class="muted">No PM2.5 readings to index across the area.</p>
					{/if}
					<ul class="pollutant-counts">
						{#each viewportSummary.pollutantCounts as c (c.pollutant)}
							<li><span class="p-name">{POLLUTANT_LABELS[c.pollutant]}</span><span class="p-c">{c.count}</span></li>
						{/each}
					</ul>
					<p class="provenance">
						Raw station counts within ±0.75° of the point — an observed sample, not full-area coverage. Stations are
						server-filtered to recent readings; sparse areas read as sparse.
					</p>
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	.aq {
		max-width: 64rem;
		margin: 0 auto;
		padding: 0.25rem 0 0.5rem;
	}
	.aq-header {
		margin-bottom: 1.25rem;
	}
	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.map-link {
		font: inherit;
		font-size: 0.8rem;
		color: var(--accent-amber);
		text-decoration: none;
		white-space: nowrap;
		background: transparent;
		border: 0;
		padding: 0;
		cursor: pointer;
	}
	.map-link:hover {
		text-decoration: underline;
	}
	.search {
		margin: 0.85rem 0 0.5rem;
		max-width: 32rem;
	}
	.loc {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.85rem;
		margin: 0.35rem 0 0;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}
	.loc-name {
		font-weight: 600;
	}
	.loc-coord,
	.loc-time {
		opacity: 0.7;
	}
	.empty-state {
		margin-top: 3rem;
		text-align: center;
	}
	.empty-lead {
		font-size: 1.05rem;
		margin: 0 0 0.4rem;
	}
	.empty-sub {
		font-size: 0.85rem;
		opacity: 0.7;
		margin: 0;
	}
	.panels {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
		gap: 1rem;
		align-items: start;
	}
	.card {
		background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.03));
		border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
		border-radius: 10px;
		padding: 0.9rem 1rem 1rem;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.6rem;
	}
	.card-info {
		cursor: help;
		opacity: 0.5;
		font-size: 0.85rem;
	}
	.muted {
		font-size: 0.82rem;
		opacity: 0.65;
		margin: 0;
	}
	.provenance {
		margin: 0.6rem 0 0;
		font-size: 0.68rem;
		opacity: 0.55;
		line-height: 1.35;
	}
	.unit {
		opacity: 0.6;
		font-size: 0.85em;
	}

	/* AQI badge */
	.aqi-badge {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.55rem 0.7rem;
		border-radius: 8px;
		border-left: 4px solid var(--cat);
		background: color-mix(in srgb, var(--cat) 14%, transparent);
	}
	.aqi-num {
		font-size: 1.6rem;
		font-weight: 700;
		font-family: var(--font-mono, ui-monospace, monospace);
		line-height: 1;
	}
	.aqi-meta {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
	}
	.aqi-cat {
		font-weight: 600;
		font-size: 0.85rem;
	}
	.aqi-dom {
		font-size: 0.72rem;
		opacity: 0.7;
	}
	.pollutant-list {
		list-style: none;
		margin: 0.7rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.3rem;
	}
	.pollutant-list li {
		display: grid;
		grid-template-columns: 3rem 1fr auto;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.8rem;
	}
	.p-name {
		font-weight: 600;
	}
	.p-val {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.p-sub {
		font-size: 0.68rem;
		opacity: 0.6;
		text-align: right;
	}

	/* Area overview */
	.area-count {
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
	}
	.spread {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}
	.spread-bar {
		position: relative;
		flex: 1 1 auto;
		height: 0.5rem;
		border-radius: 999px;
		background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
		overflow: visible;
	}
	.spread-fill {
		position: absolute;
		inset: 0;
		border-radius: 999px;
		background: linear-gradient(to right, #00e400, var(--cat));
		opacity: 0.55;
	}
	.spread-median {
		position: absolute;
		top: -1.1rem;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.65rem;
		opacity: 0.7;
	}
	.spread-end {
		font-weight: 600;
	}
	.area-cat {
		margin: 0.35rem 0 0;
	}
	.pollutant-counts {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.5rem;
		margin: 0.7rem 0 0;
		padding: 0;
	}
	.pollutant-counts li {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
		font-size: 0.72rem;
		padding: 0.15rem 0.45rem;
		border-radius: 5px;
		background: light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.06));
	}
	.pollutant-counts .p-c {
		font-family: var(--font-mono, ui-monospace, monospace);
		opacity: 0.7;
	}

	/* History controls + stats */
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
		margin-bottom: 0.7rem;
	}
	.seg {
		display: inline-flex;
		gap: 0.15rem;
		flex-wrap: wrap;
	}
	.seg button {
		font: inherit;
		font-size: 0.72rem;
		padding: 0.18rem 0.45rem;
		border-radius: 5px;
		border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.seg button.active {
		border-color: var(--accent-amber);
		color: var(--accent-amber);
		background: rgba(var(--accent-amber-rgb), 0.12);
	}
	.hist-stats {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.hist-mean {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 1.05rem;
		font-weight: 600;
	}
	.hist-sub {
		font-size: 0.7rem;
		opacity: 0.6;
	}
	.trend-rising {
		color: #ff7e00;
	}
	.trend-falling {
		color: #00b050;
	}
	.trend-flat {
		opacity: 0.6;
	}

	/* Cross-validation */
	.xval-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.xval {
		border-radius: 7px;
		padding: 0.5rem 0.6rem;
		border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
	}
	.xval-conflict {
		border-color: #ff0000;
		background: rgba(255, 0, 0, 0.06);
	}
	.xval-differ {
		border-color: #ff7e00;
		background: rgba(255, 126, 0, 0.06);
	}
	.xval-top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.xval-q {
		font-weight: 600;
		font-size: 0.82rem;
	}
	.xval-level {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.7;
	}
	.xval-vals {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.75rem;
		margin-top: 0.2rem;
	}
	.xval-note {
		margin: 0.3rem 0 0;
		font-size: 0.72rem;
		opacity: 0.8;
		line-height: 1.35;
	}
</style>
