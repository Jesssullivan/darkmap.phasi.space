/**
 * Viewport (area) summary for the AQ dashboard (V6-4). A lightweight, honest
 * rollup of the OpenAQ stations the dashboard already fetched in a bbox around
 * the selected point — NOT a region-aggregation model. It states what it is:
 * how many stations reported, the AQI spread across the PM2.5 readings, and how
 * many stations carry each criteria pollutant.
 *
 * Honesty:
 *  - the AQI spread is computed ONLY over stations that actually report PM2.5;
 *    null when none do (no PM2.5 → nothing to summarise, not "clean").
 *  - station counts are raw observed counts in the bbox; the caption states the
 *    bbox + that stations are server-filtered to the freshness window. We do not
 *    invent a freshness timestamp here (the per-station collection carries none).
 *  - null ≠ 0: a station whose value is null is counted as present-but-no-PM2.5,
 *    never folded in as 0 µg/m³.
 */

import { type AqiCategory, type AqiPollutant, aqiCategory, subIndexFor } from './aqi';

/** Criteria pollutants we tally, in display order. */
export const SUMMARY_POLLUTANTS: readonly AqiPollutant[] = ['pm25', 'pm10', 'o3', 'no2', 'so2', 'co'];

/** Minimal station shape — matches the dashboard's `Pm25Station`. */
export interface SummaryStation {
	/** PM2.5 µg/m³ for this station; null when not reported. */
	readonly value: number | null;
	/** Per-criteria-pollutant latest value; null/absent when not reported. */
	readonly pollutants?: Record<string, number | null | undefined>;
}

export interface AqiSpread {
	readonly min: number;
	readonly median: number;
	readonly max: number;
	/** Category of the worst (max) sub-index — the headline for the area. */
	readonly maxCategory: AqiCategory;
}

export interface PollutantCount {
	readonly pollutant: AqiPollutant;
	readonly count: number;
}

export interface ViewportSummary {
	/** Stations returned in the bbox (after the proxy's freshness filter). */
	readonly stationCount: number;
	/** Of those, how many report a finite PM2.5 value. */
	readonly pm25StationCount: number;
	/** PM2.5 AQI sub-index spread across the reporting stations; null when none. */
	readonly aqi: AqiSpread | null;
	/** How many stations carry each criteria pollutant (finite value). */
	readonly pollutantCounts: readonly PollutantCount[];
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Median of a non-empty numeric array (sorted copy; mean of the middle pair when even). */
const median = (xs: readonly number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

/**
 * Build the area summary from the stations in the bbox. Pure: no fetch, no
 * clock — the caller passes the already-fetched collection.
 */
export const buildViewportSummary = (stations: ReadonlyArray<SummaryStation>): ViewportSummary => {
	const pm25SubIndices: number[] = [];
	for (const s of stations) {
		if (!finite(s.value)) continue;
		const si = subIndexFor('pm25', s.value, 'µg/m³');
		if (si !== null) pm25SubIndices.push(si);
	}

	const pollutantCounts: PollutantCount[] = SUMMARY_POLLUTANTS.map((pollutant) => {
		let count = 0;
		for (const s of stations) {
			if (pollutant === 'pm25') {
				if (finite(s.value)) count++;
			} else if (finite(s.pollutants?.[pollutant])) {
				count++;
			}
		}
		return { pollutant, count };
	}).filter((c) => c.count > 0);

	const aqi: AqiSpread | null =
		pm25SubIndices.length > 0
			? {
					min: Math.min(...pm25SubIndices),
					median: Math.round(median(pm25SubIndices)),
					max: Math.max(...pm25SubIndices),
					maxCategory: aqiCategory(Math.max(...pm25SubIndices)),
				}
			: null;

	return {
		stationCount: stations.length,
		pm25StationCount: pm25SubIndices.length,
		aqi,
		pollutantCounts,
	};
};
