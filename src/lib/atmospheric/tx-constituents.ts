/**
 * Tx constituents — the single, honest place that turns "everything we know at
 * the selected point" into the one TransmissionInput the LUT consumes, tagging
 * each field with its provenance so the sheet can show whether a value is
 * measured, modeled, or a default (V3-6).
 *
 * Before this, the AOD fed to the curve was mutated from three places (manual
 * slider, PM2.5→AOD bridge, default) with an ad-hoc caption string. This
 * centralizes the source priority and provenance as a pure, tested function.
 *
 * Honesty: surface ozone (CAMS, µg/m³) is NOT total-column Dobson, so it is
 * never auto-mapped into the O₃ LUT axis — O₃ stays a default here until a
 * validated column climatology lands. Pollen is informational (no validated
 * concentration→extinction model) and is not a constituent input.
 */

import type { TransmissionInput } from '$lib/spectral/transmission-axes';
import {
	formatNearestKm,
	formatStationCount,
	pm25ToAod550,
	type DiffusionConfidence,
	type Pm25Estimate,
} from './pm25-diffusion';

export type Provenance = 'measured' | 'modeled' | 'default';

export interface ConstituentField {
	readonly value: number;
	readonly source: Provenance;
	/** Confidence for modeled fields; 'high' for measured/default (not surfaced). */
	readonly confidence: DiffusionConfidence | 'high';
	/** Short human caption, e.g. "measured AOD₅₅₀ (CAMS)". */
	readonly caption: string;
}

export interface TxConstituents {
	readonly pwv: ConstituentField; // mm
	readonly aod550: ConstituentField; // dimensionless
	readonly angstrom: ConstituentField;
	readonly o3: ConstituentField; // Dobson
	readonly zenith: ConstituentField; // deg
}

export interface ConstituentInputs {
	/** Measured point PWV (Open-Meteo); null when the source doesn't expose it. */
	readonly pwvMm: number | null;
	/** Measured CAMS column AOD₅₅₀ at the point; null when unavailable. */
	readonly camsAod550: number | null;
	/** Local PM2.5 kernel-diffusion estimate (modeled bridge); null when off / no coverage. */
	readonly pm25Estimate: Pm25Estimate | null;
	/** The AOD slider value, and whether the user has dialed it manually. */
	readonly manualAod550: number;
	readonly manualAodActive: boolean;
	readonly angstrom: number;
	readonly o3Du: number;
	readonly zenithDeg: number;
	/** True when the zenith comes from a real boresight aim (sun/moon/manual), not the default zenith. */
	readonly zenithDirected: boolean;
}

export const DEFAULT_PWV_MM = 15;

const aodFromPm25 = (est: Pm25Estimate): ConstituentField | null => {
	if (est.confidence === 'none') return null;
	const aod = pm25ToAod550(est.valueUgm3);
	if (aod === null) return null;
	const near = formatNearestKm(est.nearestKm);
	return {
		value: aod,
		source: 'modeled',
		confidence: est.confidence,
		caption: `modeled from local PM2.5 — ${est.confidence} confidence (${formatStationCount(
			est.contributingStations,
		)}${near ? `, ${near}` : ''})`,
	};
};

/**
 * Resolve the constituents with an honest source priority. For AOD:
 *   manual override → measured CAMS → modeled PM2.5 bridge → default slider.
 * A manual drag is explicit user intent and wins; otherwise the best available
 * real/modeled value is used, falling back to the slider default.
 */
export const buildTxConstituents = (inp: ConstituentInputs): TxConstituents => {
	const pwv: ConstituentField =
		inp.pwvMm !== null
			? { value: inp.pwvMm, source: 'measured', confidence: 'high', caption: 'measured (Open-Meteo)' }
			: {
					value: DEFAULT_PWV_MM,
					source: 'default',
					confidence: 'high',
					caption: `default ${DEFAULT_PWV_MM} mm — point PWV unavailable`,
				};

	let aod550: ConstituentField;
	if (inp.manualAodActive) {
		aod550 = { value: inp.manualAod550, source: 'default', confidence: 'high', caption: 'manual' };
	} else {
		const cams: ConstituentField | null =
			inp.camsAod550 !== null
				? { value: inp.camsAod550, source: 'measured', confidence: 'high', caption: 'measured AOD₅₅₀ (CAMS)' }
				: null;
		const bridged = inp.pm25Estimate ? aodFromPm25(inp.pm25Estimate) : null;
		aod550 = cams ??
			bridged ?? {
				value: inp.manualAod550,
				source: 'default',
				confidence: 'high',
				caption: `default ${inp.manualAod550.toFixed(2)}`,
			};
	}

	const angstrom: ConstituentField = {
		value: inp.angstrom,
		source: 'default',
		confidence: 'high',
		caption: 'assumed',
	};

	// Surface O₃ (µg/m³) is not column Dobson — keep O₃ a default until a
	// validated column climatology lands. (See module header.)
	const o3: ConstituentField = {
		value: inp.o3Du,
		source: 'default',
		confidence: 'high',
		caption: 'default column (climatology TBD)',
	};

	const zenith: ConstituentField = inp.zenithDirected
		? { value: inp.zenithDeg, source: 'measured', confidence: 'high', caption: 'from boresight' }
		: { value: inp.zenithDeg, source: 'default', confidence: 'high', caption: 'local zenith' };

	return { pwv, aod550, angstrom, o3, zenith };
};

export const toTransmissionInput = (c: TxConstituents): TransmissionInput => ({
	pwvMm: c.pwv.value,
	aod550: c.aod550.value,
	angstrom: c.angstrom.value,
	o3Du: c.o3.value,
	zenithDeg: c.zenith.value,
});
