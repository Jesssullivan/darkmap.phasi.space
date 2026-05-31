/**
 * US-EPA Air Quality Index (AQI) — composite from criteria-pollutant
 * concentrations (AQ-2).
 *
 * Breakpoints per 40 CFR Part 58 Appendix G, with the 2024 PM2.5 revision
 * (effective 2024-05-06; "Good" upper bound 9.0 µg/m³). The piecewise-linear
 * sub-index for a pollutant p:
 *
 *   I_p = (I_hi − I_lo)/(C_hi − C_lo) · (C_p − C_lo) + I_lo
 *
 * over the breakpoint row containing the (truncated) concentration. The overall
 * AQI is the MAX sub-index across reported pollutants; the pollutant achieving
 * it is the "dominant" one.
 *
 * HONESTY: the EPA AQI is defined on specific averaging windows (PM 24-hr,
 * O₃/CO 8-hr, SO₂/NO₂ 1-hr). We feed the latest hourly / kernel-diffused values
 * as a surrogate, so this is an APPROXIMATION ("nowcast-ish"), not the official
 * daily AQI. Callers must label it as such. Gas breakpoints are in ppm/ppb;
 * `subIndexFor` converts from the provider unit (often µg/m³) first.
 *
 * Pure, dependency-free.
 */

export type AqiPollutant = 'pm25' | 'pm10' | 'o3' | 'no2' | 'so2' | 'co';

export interface AqiCategory {
	readonly name: string;
	readonly aqiLo: number;
	readonly aqiHi: number;
	/** US AQI category color (AirNow palette). */
	readonly color: string;
}

export const AQI_CATEGORIES: readonly AqiCategory[] = [
	{ name: 'Good', aqiLo: 0, aqiHi: 50, color: '#00e400' },
	{ name: 'Moderate', aqiLo: 51, aqiHi: 100, color: '#ffff00' },
	{ name: 'Unhealthy for sensitive groups', aqiLo: 101, aqiHi: 150, color: '#ff7e00' },
	{ name: 'Unhealthy', aqiLo: 151, aqiHi: 200, color: '#ff0000' },
	{ name: 'Very unhealthy', aqiLo: 201, aqiHi: 300, color: '#8f3f97' },
	{ name: 'Hazardous', aqiLo: 301, aqiHi: 500, color: '#7e0023' },
];

export const aqiCategory = (aqi: number): AqiCategory =>
	AQI_CATEGORIES.find((c) => aqi <= c.aqiHi) ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1];

interface Bp {
	readonly cLo: number;
	readonly cHi: number;
	readonly iLo: number;
	readonly iHi: number;
}

/** Concentration is truncated to this many decimals before the lookup (per EPA). */
interface PollutantSpec {
	/** EPA breakpoint unit: 'ugm3' (µg/m³), 'ppm', or 'ppb'. */
	readonly unit: 'ugm3' | 'ppm' | 'ppb';
	readonly truncateDecimals: number;
	/** Molar mass (g/mol) for µg/m³ → ppb conversion; omitted for PM (mass already). */
	readonly molarMass?: number;
	readonly bps: readonly Bp[];
}

// Molar volume of an ideal gas at 25 °C, 1 atm (L/mol) — EPA reference conditions.
const MOLAR_VOLUME_L = 24.45;

const SPECS: Readonly<Record<AqiPollutant, PollutantSpec>> = {
	// PM2.5 24-hr, µg/m³ (2024 revision).
	pm25: {
		unit: 'ugm3',
		truncateDecimals: 1,
		bps: [
			{ cLo: 0.0, cHi: 9.0, iLo: 0, iHi: 50 },
			{ cLo: 9.1, cHi: 35.4, iLo: 51, iHi: 100 },
			{ cLo: 35.5, cHi: 55.4, iLo: 101, iHi: 150 },
			{ cLo: 55.5, cHi: 125.4, iLo: 151, iHi: 200 },
			{ cLo: 125.5, cHi: 225.4, iLo: 201, iHi: 300 },
			{ cLo: 225.5, cHi: 325.4, iLo: 301, iHi: 500 },
		],
	},
	// PM10 24-hr, µg/m³.
	pm10: {
		unit: 'ugm3',
		truncateDecimals: 0,
		bps: [
			{ cLo: 0, cHi: 54, iLo: 0, iHi: 50 },
			{ cLo: 55, cHi: 154, iLo: 51, iHi: 100 },
			{ cLo: 155, cHi: 254, iLo: 101, iHi: 150 },
			{ cLo: 255, cHi: 354, iLo: 151, iHi: 200 },
			{ cLo: 355, cHi: 424, iLo: 201, iHi: 300 },
			{ cLo: 425, cHi: 604, iLo: 301, iHi: 500 },
		],
	},
	// O₃ 8-hr, ppm (up to index 300; EPA uses 1-hr O₃ above, omitted — we cap here).
	o3: {
		unit: 'ppm',
		truncateDecimals: 3,
		molarMass: 48.0,
		bps: [
			{ cLo: 0.0, cHi: 0.054, iLo: 0, iHi: 50 },
			{ cLo: 0.055, cHi: 0.07, iLo: 51, iHi: 100 },
			{ cLo: 0.071, cHi: 0.085, iLo: 101, iHi: 150 },
			{ cLo: 0.086, cHi: 0.105, iLo: 151, iHi: 200 },
			{ cLo: 0.106, cHi: 0.2, iLo: 201, iHi: 300 },
		],
	},
	// CO 8-hr, ppm.
	co: {
		unit: 'ppm',
		truncateDecimals: 1,
		molarMass: 28.01,
		bps: [
			{ cLo: 0.0, cHi: 4.4, iLo: 0, iHi: 50 },
			{ cLo: 4.5, cHi: 9.4, iLo: 51, iHi: 100 },
			{ cLo: 9.5, cHi: 12.4, iLo: 101, iHi: 150 },
			{ cLo: 12.5, cHi: 15.4, iLo: 151, iHi: 200 },
			{ cLo: 15.5, cHi: 30.4, iLo: 201, iHi: 300 },
			{ cLo: 30.5, cHi: 50.4, iLo: 301, iHi: 500 },
		],
	},
	// SO₂ 1-hr, ppb (≤ index 200; 201+ uses 24-hr SO₂, rows folded in per EPA TAD).
	so2: {
		unit: 'ppb',
		truncateDecimals: 0,
		molarMass: 64.07,
		bps: [
			{ cLo: 0, cHi: 35, iLo: 0, iHi: 50 },
			{ cLo: 36, cHi: 75, iLo: 51, iHi: 100 },
			{ cLo: 76, cHi: 185, iLo: 101, iHi: 150 },
			{ cLo: 186, cHi: 304, iLo: 151, iHi: 200 },
			{ cLo: 305, cHi: 604, iLo: 201, iHi: 300 },
			{ cLo: 605, cHi: 1004, iLo: 301, iHi: 500 },
		],
	},
	// NO₂ 1-hr, ppb.
	no2: {
		unit: 'ppb',
		truncateDecimals: 0,
		molarMass: 46.01,
		bps: [
			{ cLo: 0, cHi: 53, iLo: 0, iHi: 50 },
			{ cLo: 54, cHi: 100, iLo: 51, iHi: 100 },
			{ cLo: 101, cHi: 360, iLo: 101, iHi: 150 },
			{ cLo: 361, cHi: 649, iLo: 151, iHi: 200 },
			{ cLo: 650, cHi: 1249, iLo: 201, iHi: 300 },
			{ cLo: 1250, cHi: 2049, iLo: 301, iHi: 500 },
		],
	},
};

/** Normalize a provider unit string to a canonical token. */
const canonUnit = (units: string | undefined): 'ugm3' | 'mgm3' | 'ppm' | 'ppb' | 'unknown' => {
	if (!units) return 'unknown';
	const u = units.toLowerCase().replace(/\s+/g, '');
	if (u === 'ppm') return 'ppm';
	if (u === 'ppb') return 'ppb';
	if (u === 'mg/m³' || u === 'mg/m3' || u === 'mgm3') return 'mgm3';
	if (u === 'µg/m³' || u === 'ug/m³' || u === 'µg/m3' || u === 'ug/m3' || u === 'ugm3' || u === 'µgm3') return 'ugm3';
	return 'unknown';
};

/**
 * Convert a provider concentration to the EPA breakpoint unit for `pollutant`.
 * Returns null when the conversion is unsupported (e.g. unknown units for a gas
 * — we will not guess and fabricate an index).
 */
export const toEpaUnit = (pollutant: AqiPollutant, value: number, units: string | undefined): number | null => {
	if (!Number.isFinite(value) || value < 0) return null;
	const spec = SPECS[pollutant];
	const u = canonUnit(units);

	if (spec.unit === 'ugm3') {
		// PM — mass concentration. Accept µg/m³ (or unknown, assumed µg/m³ for PM);
		// upconvert mg/m³.
		if (u === 'mgm3') return value * 1000;
		if (u === 'ugm3' || u === 'unknown') return value;
		return null; // a gas unit on a PM channel is nonsensical
	}

	// Gas: EPA wants ppm or ppb. Convert from mass if needed.
	const mw = spec.molarMass!;
	let ppb: number | null = null;
	if (u === 'ppb') ppb = value;
	else if (u === 'ppm') ppb = value * 1000;
	else if (u === 'ugm3') ppb = (value * MOLAR_VOLUME_L) / mw;
	else if (u === 'mgm3') ppb = (value * 1000 * MOLAR_VOLUME_L) / mw;
	else return null; // unknown units for a gas → no honest conversion
	return spec.unit === 'ppm' ? ppb / 1000 : ppb;
};

const truncate = (v: number, decimals: number): number => {
	const f = 10 ** decimals;
	return Math.floor(v * f) / f;
};

/**
 * Sub-index for one pollutant from a provider concentration + units. Returns
 * null when units can't be resolved or the concentration is above the table
 * (off the defined scale — better to omit than clamp dishonestly).
 */
export const subIndexFor = (pollutant: AqiPollutant, value: number, units: string | undefined): number | null => {
	const epa = toEpaUnit(pollutant, value, units);
	if (epa === null) return null;
	const spec = SPECS[pollutant];
	const c = truncate(epa, spec.truncateDecimals);
	for (const bp of spec.bps) {
		if (c >= bp.cLo && c <= bp.cHi) {
			return Math.round(((bp.iHi - bp.iLo) / (bp.cHi - bp.cLo)) * (c - bp.cLo) + bp.iLo);
		}
	}
	return null; // below first cLo is impossible (≥0); above last cHi → off-scale
};

export interface AqiReading {
	readonly pollutant: AqiPollutant;
	readonly value: number;
	readonly units?: string;
}

export interface AqiResult {
	readonly aqi: number;
	readonly dominant: AqiPollutant;
	readonly category: AqiCategory;
	/** Per-pollutant sub-indices that resolved. */
	readonly subIndices: Partial<Record<AqiPollutant, number>>;
}

/**
 * Composite US-EPA AQI = max sub-index across the readings that resolve.
 * Returns null when none resolve (no honest index to report).
 */
export const computeAqi = (readings: readonly AqiReading[]): AqiResult | null => {
	const subIndices: Partial<Record<AqiPollutant, number>> = {};
	let aqi = -1;
	let dominant: AqiPollutant | null = null;
	for (const r of readings) {
		const si = subIndexFor(r.pollutant, r.value, r.units);
		if (si === null) continue;
		subIndices[r.pollutant] = si;
		if (si > aqi) {
			aqi = si;
			dominant = r.pollutant;
		}
	}
	if (dominant === null) return null;
	return { aqi, dominant, category: aqiCategory(aqi), subIndices };
};
