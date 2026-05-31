/**
 * AQ cross-validation (V6-3, TIN-1755).
 *
 * Three air-quality sources describe the same column but never get lined up:
 *  1. Ground obs   — OpenAQ diffused surface PM2.5 (MEASURED at stations, then
 *     kernel-diffused to the point), bridged to an AOD550 estimate via
 *     `pm25ToAod550` (an engineering bridge, not a retrieval).
 *  2. Model        — CAMS surface PM2.5 / column AOD550 (MODELED reanalysis/
 *     forecast, Open-Meteo).
 *  3. Imagery      — GIBS MODIS AOD (IMAGERY).
 *
 * v1 HONEST SCOPE — GIBS is VISUAL-ONLY here. Point-decoding a GIBS AOD tile
 * (fetch the PNG, project lon/lat → pixel, invert the palette-indexed color
 * back through the layer colormap, reject fill/no-data) is lossy and not cheap
 * or reliable enough to trust as a number. Rather than fake a GIBS value, this
 * module compares ONLY the two sources that carry honest point numbers —
 * OpenAQ↔CAMS — and treats GIBS as a visual cross-check the user reads off the
 * map. If a calibrated point-decode lands later, add a GIBS reading to
 * {@link CrossValInputs} and a pair to {@link crossValidate}; the all-pairs
 * machinery already generalizes.
 *
 * THE central honesty rule: a comparison exists ONLY where BOTH sources carry a
 * finite value. A missing source is "no data" — never "agrees", never zero.
 * null ≠ 0. One source present → NO comparison (not a zero-bias agreement).
 *
 * Pure functions over plain numbers — unit-tested without the network, MapLibre,
 * or the Effect runtime.
 */

import { isFiniteNumber as finite } from './stats';

/** Provenance of a single source value, mirroring the model-card `kind`. */
export type SourceKind = 'measured' | 'modeled' | 'imagery';

/** Which physical quantity a pair compares. */
export type CrossValQuantity = 'pm25' | 'aod550';

/** A single source's value for one quantity. `value: null` ⇒ no data (≠ 0). */
export interface SourceReading {
	readonly id: string;
	readonly label: string;
	readonly kind: SourceKind;
	/** µg/m³ for pm25, dimensionless for aod550. Null = the source reported nothing. */
	readonly value: number | null;
}

/**
 * The point's available source readings. Any field may be null/absent — the
 * point may have OpenAQ but no CAMS, CAMS but no nearby station, or neither.
 * GIBS is intentionally absent: visual-only in v1 (see module header).
 */
export interface CrossValInputs {
	/** OpenAQ diffused surface PM2.5 at the point, µg/m³ (measured-then-diffused). */
	readonly openaqPm25: number | null;
	/** OpenAQ PM2.5 bridged to AOD550 via pm25ToAod550 (engineering bridge). */
	readonly openaqAod550FromPm25: number | null;
	/** CAMS surface PM2.5, µg/m³ (modeled). */
	readonly camsPm25: number | null;
	/** CAMS column AOD550, dimensionless (modeled). */
	readonly camsAod550: number | null;
}

/**
 * Severity of disagreement between two sources for one quantity:
 *  - 'agree'    — within the relative tolerance.
 *  - 'differ'   — outside tolerance but same broad regime.
 *  - 'conflict' — sources cross a health/clean threshold (one says clean, the
 *                 other says unhealthy) — the loud, actionable disagreement.
 */
export type DisagreementLevel = 'agree' | 'differ' | 'conflict';

export interface CrossValPair {
	readonly quantity: CrossValQuantity;
	readonly units: string;
	readonly a: SourceReading;
	readonly b: SourceReading;
	/** Signed bias a − b, in the quantity's units. */
	readonly bias: number;
	/** |a − b| / mean(|a|,|b|) as a fraction (0..); null when both are ~0. */
	readonly relDiff: number | null;
	readonly level: DisagreementLevel;
	/** Plain-language summary, honest about which source said what. */
	readonly note: string;
}

export interface CrossValResult {
	/** Only the pairs where BOTH sources had data. Empty ⇒ nothing to compare. */
	readonly pairs: readonly CrossValPair[];
	/** True when at least one pair reached 'conflict' (clean-vs-unhealthy split). */
	readonly hasConflict: boolean;
	/**
	 * Honest reason there is nothing (or little) to compare, for the empty/sparse
	 * UI state. Null when at least one pair exists.
	 */
	readonly emptyReason: string | null;
}

/**
 * Relative tolerances + conflict thresholds. These are coarse v1 engineering
 * choices, not calibrated agreement criteria — the UI says so.
 */
export interface CrossValConfig {
	/** |relDiff| at/below which a pair "agrees". */
	readonly agreeRelTol: number;
	/** PM2.5 µg/m³ above which a value is "unhealthy" (US-AQI: 35.5 = USG bound). */
	readonly pm25UnhealthyUgm3: number;
	/** PM2.5 µg/m³ below which a value is "clean"/good (US-AQI Good bound). */
	readonly pm25CleanUgm3: number;
	/** AOD550 above which the column is "hazy/turbid". */
	readonly aodTurbidThreshold: number;
	/** AOD550 below which the column is "clear". */
	readonly aodClearThreshold: number;
}

export const DEFAULT_CROSSVAL: CrossValConfig = {
	agreeRelTol: 0.35,
	pm25UnhealthyUgm3: 35.5,
	pm25CleanUgm3: 12,
	aodTurbidThreshold: 0.4,
	aodClearThreshold: 0.1,
};

/** Relative difference |a−b| / mean(|a|,|b|); null when both are ~0 (no scale). */
const relativeDiff = (a: number, b: number): number | null => {
	const scale = (Math.abs(a) + Math.abs(b)) / 2;
	if (scale < 1e-9) return null;
	return Math.abs(a - b) / scale;
};

/**
 * Does the pair straddle a clean/unhealthy split — one source clean, the other
 * unhealthy? That is the loud "CAMS says clean, stations say unhealthy" case.
 */
const crossesThreshold = (a: number, b: number, cleanBelow: number, unhealthyAbove: number): boolean => {
	const aClean = a < cleanBelow;
	const bClean = b < cleanBelow;
	const aBad = a > unhealthyAbove;
	const bBad = b > unhealthyAbove;
	return (aClean && bBad) || (bClean && aBad);
};

const fmt = (v: number, q: CrossValQuantity): string => (q === 'pm25' ? v.toFixed(1) : v.toFixed(2));

const buildNote = (
	a: SourceReading,
	b: SourceReading,
	q: CrossValQuantity,
	units: string,
	level: DisagreementLevel,
): string => {
	const av = `${a.label} ${fmt(a.value as number, q)}${units ? ` ${units}` : ''}`;
	const bv = `${b.label} ${fmt(b.value as number, q)}${units ? ` ${units}` : ''}`;
	if (level === 'agree') return `${av} ≈ ${bv}`;
	if (level === 'conflict') {
		const higher = (a.value as number) >= (b.value as number) ? a : b;
		const lower = higher === a ? b : a;
		return `${higher.label} reads ${q === 'pm25' ? 'unhealthy' : 'turbid'} while ${lower.label} reads ${
			q === 'pm25' ? 'clean' : 'clear'
		} (${av} vs ${bv})`;
	}
	return `${av} vs ${bv}`;
};

/**
 * Compare one quantity across two sources. Returns null when EITHER source
 * lacks a finite value — there is then simply no comparison (NOT a zero-bias
 * "agreement"). This null is how the all-null / one-source case stays honest.
 */
export const comparePair = (
	a: SourceReading,
	b: SourceReading,
	quantity: CrossValQuantity,
	units: string,
	config: CrossValConfig = DEFAULT_CROSSVAL,
): CrossValPair | null => {
	if (!finite(a.value) || !finite(b.value)) return null;
	const av = a.value;
	const bv = b.value;
	const bias = av - bv;
	const relDiff = relativeDiff(av, bv);

	const cleanBelow = quantity === 'pm25' ? config.pm25CleanUgm3 : config.aodClearThreshold;
	const unhealthyAbove = quantity === 'pm25' ? config.pm25UnhealthyUgm3 : config.aodTurbidThreshold;

	let level: DisagreementLevel;
	if (crossesThreshold(av, bv, cleanBelow, unhealthyAbove)) {
		level = 'conflict';
	} else if (relDiff !== null && relDiff <= config.agreeRelTol) {
		level = 'agree';
	} else if (relDiff === null) {
		// Both ~0 → both clean, agreement.
		level = 'agree';
	} else {
		level = 'differ';
	}

	return {
		quantity,
		units,
		a,
		b,
		bias,
		relDiff,
		level,
		note: buildNote(a, b, quantity, units, level),
	};
};

/**
 * Cross-validate the available AQ sources at a point. Builds a pair ONLY where
 * both sources carry a finite value; a missing source contributes nothing and
 * is never read as agreement. v1 pairs are OpenAQ↔CAMS for PM2.5 and AOD550
 * (GIBS is visual-only — see module header).
 */
export const crossValidate = (inputs: CrossValInputs, config: CrossValConfig = DEFAULT_CROSSVAL): CrossValResult => {
	const openaqPm25: SourceReading = {
		id: 'openaq',
		label: 'Stations',
		kind: 'measured',
		value: finite(inputs.openaqPm25) ? inputs.openaqPm25 : null,
	};
	const camsPm25: SourceReading = {
		id: 'cams',
		label: 'CAMS',
		kind: 'modeled',
		value: finite(inputs.camsPm25) ? inputs.camsPm25 : null,
	};
	const openaqAod: SourceReading = {
		id: 'openaq-bridge',
		label: 'Stations→AOD',
		kind: 'modeled', // a bridge from a measurement; not a measured AOD
		value: finite(inputs.openaqAod550FromPm25) ? inputs.openaqAod550FromPm25 : null,
	};
	const camsAod: SourceReading = {
		id: 'cams',
		label: 'CAMS',
		kind: 'modeled',
		value: finite(inputs.camsAod550) ? inputs.camsAod550 : null,
	};

	const pairs: CrossValPair[] = [];
	const pm25Pair = comparePair(openaqPm25, camsPm25, 'pm25', 'µg/m³', config);
	if (pm25Pair) pairs.push(pm25Pair);
	const aodPair = comparePair(openaqAod, camsAod, 'aod550', '', config);
	if (aodPair) pairs.push(aodPair);

	const hasConflict = pairs.some((p) => p.level === 'conflict');

	let emptyReason: string | null = null;
	if (pairs.length === 0) {
		const haveAny =
			openaqPm25.value !== null || camsPm25.value !== null || openaqAod.value !== null || camsAod.value !== null;
		emptyReason = haveAny
			? 'Only one source has data here — nothing to cross-check (a missing source is no data, not agreement).'
			: 'No air-quality source has data at this point.';
	}

	return { pairs, hasConflict, emptyReason };
};
