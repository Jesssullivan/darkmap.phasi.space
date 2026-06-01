/**
 * Orbit pass-prediction (S3 — Orbit lens).
 *
 * TLE → SGP4 → ground-station look angles, with the differentiator: each pass
 * is gated by the REAL DEM HORIZON (terrain occlusion), not the flat 0° math
 * horizon — so AOS/LOS reflect when the satellite actually clears the ridgeline
 * for this site, the thing flat-horizon pass predictors get wrong.
 *
 * Honesty (the V6 bar): passes are PREDICTED (SGP4) — we surface the TLE epoch
 * age (SGP4 drifts ~1–3 km/day, and the cross-track keyhole widens with age).
 * Pure module: SGP4 via satellite.js; the terrain horizon via an INLINED
 * interpolation (with a type-only HorizonPolygon import) so this stays a
 * self-contained root_lib_test slice — no cross-package value dependency.
 */
import {
	dopplerFactor,
	ecfToLookAngles,
	eciToEcf,
	geodeticToEcf,
	gstime,
	propagate,
	twoline2satrec,
} from 'satellite.js';
import type { SatRec } from 'satellite.js';
import type { HorizonPolygon } from '$lib/ephemeris/horizonAtAzimuth';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const MS_PER_DAY = 86_400_000;

/**
 * Terrain horizon altitude (deg) at an azimuth — inlined mirror of
 * `$lib/ephemeris/horizonAtAzimuth` (kept local to avoid a cross-package value
 * import; the type is imported type-only). Empty/absent ⇒ flat 0°.
 */
function horizonAltitudeDeg(polygon: HorizonPolygon | undefined, azimuthDeg: number): number {
	if (!polygon || polygon.length === 0) return 0;
	const az = ((azimuthDeg % 360) + 360) % 360;
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];
		const aAz = a.azimuthDeg;
		const bAz = b.azimuthDeg <= aAz ? b.azimuthDeg + 360 : b.azimuthDeg;
		if (az >= aAz && az <= bAz) {
			const t = (az - aAz) / Math.max(1e-9, bAz - aAz);
			return a.altitudeDeg + t * (b.altitudeDeg - a.altitudeDeg);
		}
	}
	return polygon[0].altitudeDeg;
}

export interface Observer {
	readonly latitudeDeg: number;
	readonly longitudeDeg: number;
	/** Site height above the ellipsoid, km (default 0). */
	readonly heightKm?: number;
}

export interface ParsedTle {
	readonly satrec: SatRec;
	/** TLE epoch (UTC) — the instant the elements describe. */
	readonly epoch: Date;
	readonly name?: string;
}

/** Parse a TLE pair into an SGP4 satrec + its epoch. Epoch is read straight off line 1. */
export function parseTle(line1: string, line2: string, name?: string): ParsedTle {
	const satrec = twoline2satrec(line1, line2);
	return { satrec, epoch: tleEpoch(line1), name };
}

/** Decode the TLE line-1 epoch (cols 19–32: 2-digit year + fractional day-of-year) to a UTC Date. */
export function tleEpoch(line1: string): Date {
	const yy = Number.parseInt(line1.slice(18, 20), 10);
	const dayOfYear = Number.parseFloat(line1.slice(20, 32));
	const year = yy < 57 ? 2000 + yy : 1900 + yy; // TLE convention: <57 ⇒ 21st century
	const jan1 = Date.UTC(year, 0, 1);
	return new Date(jan1 + (dayOfYear - 1) * MS_PER_DAY);
}

/** Age of the elements at `now`, in days (now − epoch). Surfaced to flag SGP4 drift. */
export function epochAgeDays(epoch: Date, now: Date): number {
	return (now.getTime() - epoch.getTime()) / MS_PER_DAY;
}

export interface TleSet {
	readonly name?: string;
	readonly line1: string;
	readonly line2: string;
}

/**
 * Split raw Celestrak/Space-Track TLE text into name/line1/line2 sets. Accepts
 * 2-line (no name) and 3-line (named) records, blank lines, and CRLF. A set is
 * any `1 …` line immediately followed by a `2 …` line; the preceding non-TLE
 * line, if any, is the satellite name.
 */
export function parseTleSets(text: string): TleSet[] {
	const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
	const sets: TleSet[] = [];
	for (let i = 0; i < lines.length - 1; i++) {
		const l1 = lines[i];
		const l2 = lines[i + 1];
		if (l1.startsWith('1 ') && l2.startsWith('2 ')) {
			const prev = i > 0 ? lines[i - 1].trim() : '';
			const name = prev && !prev.startsWith('1 ') && !prev.startsWith('2 ') ? prev : undefined;
			sets.push({ name, line1: l1, line2: l2 });
			i++; // consume line 2
		}
	}
	return sets;
}

export interface LookSample {
	/** Azimuth, degrees clockwise from north [0, 360). */
	readonly azDeg: number;
	/** Elevation above the math horizon, degrees. */
	readonly elDeg: number;
	/** Slant range, km. */
	readonly rangeKm: number;
}

/** Geometric look angle (az/el/range) of the satellite from the observer at `date`, or null on SGP4 error / no fix. */
export function lookAngleAt(satrec: SatRec, observer: Observer, date: Date): LookSample | null {
	const pv = propagate(satrec, date);
	if (!pv || !pv.position) return null;
	const gmst = gstime(date);
	const ecf = eciToEcf(pv.position, gmst);
	const observerGd = {
		longitude: observer.longitudeDeg * RAD,
		latitude: observer.latitudeDeg * RAD,
		height: observer.heightKm ?? 0,
	};
	const la = ecfToLookAngles(observerGd, ecf);
	return { azDeg: (((la.azimuth * DEG) % 360) + 360) % 360, elDeg: la.elevation * DEG, rangeKm: la.rangeSat };
}

/** Doppler shift (Hz) at `date` for a carrier `carrierHz`; +ve when the satellite is approaching. Null on SGP4 error. */
export function dopplerShiftHz(satrec: SatRec, observer: Observer, date: Date, carrierHz: number): number | null {
	const pv = propagate(satrec, date);
	if (!pv || !pv.position || !pv.velocity) return null;
	const gmst = gstime(date);
	const posEcf = eciToEcf(pv.position, gmst);
	const velEcf = eciToEcf(pv.velocity, gmst);
	const observerGd = {
		longitude: observer.longitudeDeg * RAD,
		latitude: observer.latitudeDeg * RAD,
		height: observer.heightKm ?? 0,
	};
	const observerEcf = geodeticToEcf(observerGd);
	const factor = dopplerFactor(observerEcf, posEcf, velEcf);
	// factor = f_observed / f_source; +ve shift ⇒ approaching (factor > 1).
	return (factor - 1) * carrierHz;
}

export interface PassSample {
	readonly t: Date;
	readonly azDeg: number;
	readonly elDeg: number;
	readonly rangeKm: number;
	/** Terrain horizon altitude at this azimuth, deg (0 when flat). */
	readonly horizonDeg: number;
	readonly dopplerHz?: number;
}

export interface Pass {
	/** Acquisition of signal — first instant the satellite clears the (terrain) horizon. */
	readonly aos: Date;
	/** Loss of signal — drops back below the horizon. */
	readonly los: Date;
	readonly culmination: Date;
	readonly maxElevationDeg: number;
	readonly aosAzDeg: number;
	readonly losAzDeg: number;
	readonly durationSec: number;
	readonly track: readonly PassSample[];
	/** True when the terrain horizon raised the AOS/LOS bar above the flat 0° math horizon. */
	readonly terrainGated: boolean;
}

export interface FindPassesInput {
	readonly satrec: SatRec;
	readonly observer: Observer;
	readonly start: Date;
	readonly windowHours: number;
	/** Sample step, seconds (default 30). */
	readonly stepSec?: number;
	/** DEM horizon polygon; absent ⇒ flat 0° horizon. */
	readonly horizon?: HorizonPolygon;
	/** Extra hard elevation floor on top of the terrain (e.g. an antenna mask), deg. */
	readonly minElevationDeg?: number;
	/** Carrier frequency (Hz) for per-sample Doppler; omit to skip Doppler. */
	readonly carrierHz?: number;
	/** Cap on returned passes (default 50). */
	readonly maxPasses?: number;
}

/**
 * Find satellite passes over the window, each gated by the effective horizon
 * = max(terrain altitude at that azimuth, minElevationDeg). A sample counts as
 * "up" only when its elevation exceeds that bar — so a ridge to the east delays
 * AOS exactly as it does in the field.
 */
export function findPasses(input: FindPassesInput): Pass[] {
	const { satrec, observer, start, windowHours, horizon, carrierHz } = input;
	const stepSec = input.stepSec ?? 30;
	const minEl = input.minElevationDeg ?? 0;
	const maxPasses = input.maxPasses ?? 50;
	const stepMs = stepSec * 1000;
	const endMs = start.getTime() + windowHours * 3_600_000;

	const passes: Pass[] = [];
	let current: PassSample[] | null = null;

	const sampleAt = (tMs: number): PassSample | null => {
		const date = new Date(tMs);
		const look = lookAngleAt(satrec, observer, date);
		if (!look) return null;
		const horizonDeg = horizonAltitudeDeg(horizon, look.azDeg);
		const sample: PassSample = { t: date, azDeg: look.azDeg, elDeg: look.elDeg, rangeKm: look.rangeKm, horizonDeg };
		if (carrierHz !== undefined) {
			const d = dopplerShiftHz(satrec, observer, date, carrierHz);
			if (d !== null) return { ...sample, dopplerHz: d };
		}
		return sample;
	};
	const isUp = (s: PassSample): boolean => s.elDeg > Math.max(minEl, s.horizonDeg);

	const closePass = () => {
		if (!current || current.length === 0) {
			current = null;
			return;
		}
		const track = current;
		let peak = track[0];
		for (const s of track) if (s.elDeg > peak.elDeg) peak = s;
		const aos = track[0];
		const los = track[track.length - 1];
		passes.push({
			aos: aos.t,
			los: los.t,
			culmination: peak.t,
			maxElevationDeg: peak.elDeg,
			aosAzDeg: aos.azDeg,
			losAzDeg: los.azDeg,
			durationSec: (los.t.getTime() - aos.t.getTime()) / 1000,
			track,
			// Terrain raised the bar if the horizon at AOS or LOS azimuth exceeds the flat 0°.
			terrainGated: aos.horizonDeg > 0.01 || los.horizonDeg > 0.01,
		});
		current = null;
	};

	for (let tMs = start.getTime(); tMs <= endMs && passes.length < maxPasses; tMs += stepMs) {
		const s = sampleAt(tMs);
		if (s && isUp(s)) {
			if (current) current.push(s);
			else current = [s];
		} else if (current) {
			closePass();
		}
	}
	closePass();
	return passes;
}
