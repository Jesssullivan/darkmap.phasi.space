/**
 * OpenAQ v3 hourly-history shaping (TIN-1754 / V6-2). Pure + dependency-free so
 * the proxy stays thin and the gaps-stay-gaps honesty logic is unit-tested
 * against the real v3 `/sensors/{id}/hours` shape.
 *
 * Reality of OpenAQ v3 `/sensors/{id}/hours`:
 *  - returns `results[]` of HourlyData: `{ value, parameter:{name,units},
 *    period:{ datetimeFrom:{utc}, datetimeTo:{utc} }, coverage, summary }`.
 *  - hours with NO observation are simply ABSENT from the array (the API does
 *    not emit a null-valued row for an unsampled hour). We honor that: a missing
 *    hour stays a gap — we never interpolate or backfill a synthetic point.
 *
 * Honesty contract:
 *  - We render only hours the sensor actually reported. `null`/non-finite values
 *    are dropped (they are not zero). The 24-h mean is the mean OVER REAL SAMPLES
 *    ONLY — gaps shrink the sample count, they do not pull the mean toward 0.
 *  - We surface the window (from→to) and the sample count so a sparse series is
 *    visibly sparse.
 *  - Freshness: like the latest-value path, a series whose newest sample is older
 *    than the staleness window is reported `stale:true` so a years-old history is
 *    never presented as "current".
 */

export const HISTORY_POLLUTANT_NAMES = ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'] as const;
export type HistoryPollutantName = (typeof HISTORY_POLLUTANT_NAMES)[number];

/** Raw v3 `/sensors/{id}/hours` result row (only the fields we consume). */
export interface V3HourlyDateTime {
	readonly utc?: string;
}
export interface V3HourlyPeriod {
	readonly datetimeFrom?: V3HourlyDateTime | null;
	readonly datetimeTo?: V3HourlyDateTime | null;
}
export interface V3HourlyResult {
	readonly value?: number | null;
	readonly parameter?: { readonly name?: string; readonly units?: string };
	readonly period?: V3HourlyPeriod | null;
}

/** One real hourly sample. `at` is the ISO-8601 UTC end-of-hour (period.datetimeTo). */
export interface HourlyPoint {
	readonly at: string;
	readonly value: number;
}

export type TrendDirection = 'rising' | 'falling' | 'flat';

export interface HistorySeries {
	readonly parameter: HistoryPollutantName;
	readonly units: string | null;
	/** Real samples only, oldest-first. Gaps are absent — never interpolated. */
	readonly points: ReadonlyArray<HourlyPoint>;
	/** Count of real samples in `points` (so a sparse window reads as sparse). */
	readonly sampleCount: number;
	/** Mean over the real samples only (null when there are none). */
	readonly mean: number | null;
	/** Min / max over the real samples (null when none). */
	readonly min: number | null;
	readonly max: number | null;
	/** Requested window, ISO-8601 UTC. */
	readonly windowFrom: string;
	readonly windowTo: string;
	/** ISO of the newest real sample, or null when empty. */
	readonly latestAt: string | null;
	readonly latestValue: number | null;
	/**
	 * Sign of (mean of the newer half − mean of the older half) over real
	 * samples. 'flat' when fewer than 2 samples or the halves are within
	 * `flatBand` of each other.
	 */
	readonly trend: TrendDirection;
	/** Signed magnitude of the half-over-half delta (newer − older); null when undefined. */
	readonly trendDelta: number | null;
	/** True when the newest sample is older than the staleness window. */
	readonly stale: boolean;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ISO end-of-hour for a result row: prefer period.datetimeTo, else datetimeFrom. */
const pointTime = (r: V3HourlyResult): string | null => {
	const to = r.period?.datetimeTo?.utc;
	if (typeof to === 'string' && Number.isFinite(Date.parse(to))) return to;
	const from = r.period?.datetimeFrom?.utc;
	if (typeof from === 'string' && Number.isFinite(Date.parse(from))) return from;
	return null;
};

const mean = (xs: ReadonlyArray<number>): number | null =>
	xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Half-over-half trend: split the real samples (oldest→newest) into an older and
 * a newer half and compare their means. Robust to gaps because it operates on
 * sample ORDER, not wall-clock bins — we never fabricate a missing hour to keep
 * the bins even. `flatBand` is an absolute tolerance (in the pollutant's units)
 * below which a delta reads as 'flat'.
 */
export const computeTrend = (
	points: ReadonlyArray<HourlyPoint>,
	flatBand: number,
): { direction: TrendDirection; delta: number | null } => {
	if (points.length < 2) return { direction: 'flat', delta: null };
	const values = points.map((p) => p.value);
	const mid = Math.floor(values.length / 2);
	// Odd count: the middle sample is shared-neutral — exclude it from both halves.
	const older = values.slice(0, mid);
	const newer = values.slice(values.length - mid);
	const om = mean(older);
	const nm = mean(newer);
	if (om === null || nm === null) return { direction: 'flat', delta: null };
	const delta = nm - om;
	if (Math.abs(delta) <= flatBand) return { direction: 'flat', delta };
	return { direction: delta > 0 ? 'rising' : 'falling', delta };
};

export interface ShapeHistoryArgs {
	readonly results: ReadonlyArray<V3HourlyResult>;
	readonly parameter: HistoryPollutantName;
	readonly windowFrom: string;
	readonly windowTo: string;
	readonly nowMs: number;
	readonly staleAfterMs: number;
	/** Absolute tolerance for a 'flat' trend; defaults to 0 (any nonzero delta has a sign). */
	readonly flatBand?: number;
}

/**
 * Shape a v3 `/sensors/{id}/hours` payload into an honest {points, mean, trend}
 * series. Drops null/non-finite/undated rows, sorts oldest-first, and computes
 * stats over real samples only. Empty/sparse input yields an honest empty series
 * (mean=null, sampleCount=0, trend='flat'), never a zero-filled fake.
 */
export const shapeHistory = (args: ShapeHistoryArgs): HistorySeries => {
	const { results, parameter, windowFrom, windowTo, nowMs, staleAfterMs, flatBand = 0 } = args;

	let units: string | null = null;
	const points: HourlyPoint[] = [];
	for (const r of results) {
		if (!isFiniteNum(r.value)) continue; // null/non-finite → gap, not zero
		const at = pointTime(r);
		if (at === null) continue; // undatable row → drop, don't guess a slot
		if (units === null && typeof r.parameter?.units === 'string') units = r.parameter.units;
		points.push({ at, value: r.value });
	}
	points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

	const values = points.map((p) => p.value);
	const seriesMean = mean(values);
	const min = values.length ? Math.min(...values) : null;
	const max = values.length ? Math.max(...values) : null;
	const last = points.length ? points[points.length - 1] : null;
	const latestAt = last?.at ?? null;
	const latestValue = last?.value ?? null;

	const { direction: trend, delta: trendDelta } = computeTrend(points, flatBand);

	// Freshness: a series whose newest real sample is older than the window is
	// stale (years-old history must not read as "current"). Empty → stale.
	const latestMs = latestAt ? Date.parse(latestAt) : Number.NaN;
	const stale = !Number.isFinite(latestMs) || nowMs - latestMs > staleAfterMs;

	return {
		parameter,
		units,
		points,
		sampleCount: points.length,
		mean: seriesMean,
		min,
		max,
		windowFrom,
		windowTo,
		latestAt,
		latestValue,
		trend,
		trendDelta,
		stale,
	};
};
