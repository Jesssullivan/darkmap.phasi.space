/**
 * PM2.5 kernel-diffusion field (#275, V2 on top of #249).
 *
 * #249 made the PM2.5 overlay honest (null readings excluded, not painted
 * as clean air) but it stays a cosmetic MapLibre heatmap with no
 * interpolated concentration field and no link to the spectral
 * transmission pipeline. This module estimates a PM2.5 concentration at an
 * arbitrary query point from the sparse OpenAQ station set, with an honest
 * confidence signal, and bridges that estimate to the AOD550 input that
 * `TransmissionEstimator` consumes — so laser/EO band selection can
 * reflect the local particulate load (the recovered field-use story).
 *
 * Honesty first: this is a MODELED estimate, not measured truth. The
 * estimator never fabricates a value where no station is in range
 * (returns `null` / `confidence: 'none'`), and reports a Kish effective
 * sample size so the UI can warn when a "smooth field" actually rests on
 * one or two distant sensors.
 *
 * Pure functions over plain inputs — unit-tested without MapLibre, the
 * network, or the Effect runtime.
 */

import { AOD550_AXIS } from '$lib/spectral/transmission-axes';

/** A single ground-station observation. `value` is µg/m³, or null when the station reported no PM2.5. */
export interface Pm25Station {
	readonly lon: number;
	readonly lat: number;
	readonly value: number | null;
	/**
	 * AQ-1 — per-criteria-pollutant latest reading at this station, keyed by
	 * OpenAQ parameter name (pm25/pm10/no2/o3/so2/co). `value` mirrors
	 * `pollutants.pm25` for the existing PM2.5 paths. Absent on test stations.
	 */
	readonly pollutants?: Readonly<Record<string, number | null>>;
}

/**
 * AQ-4 — optional wind vector for anisotropic diffusion. Direction uses the
 * METEOROLOGICAL convention: the compass bearing (degrees clockwise from north)
 * the wind is blowing FROM. The downwind axis is therefore `directionDeg + 180`.
 */
export interface WindVector {
	readonly directionDeg: number;
	readonly speedMps: number;
}

export interface DiffusionParams {
	/** Gaussian kernel bandwidth σ, in km. Larger → smoother, more far-field blending. */
	readonly bandwidthKm: number;
	/** Hard cutoff: stations beyond this contribute nothing (keeps a continental viewport from blending unrelated air). */
	readonly maxRadiusKm: number;
	/** Effective-sample-size threshold at/above which the estimate is "high" confidence. */
	readonly minEffectiveStationsHigh: number;
	/**
	 * AQ-4 — optional wind. When present with `speedMps > 0`, the Gaussian
	 * kernel becomes an ellipse stretched along the downwind axis so plumes
	 * extend the way the air is actually moving. Absent / calm → isotropic,
	 * byte-for-byte identical to the original behavior.
	 */
	readonly wind?: WindVector;
	/**
	 * AQ-4 — cap on the along-wind σ multiplier (the kernel's elongation at
	 * high wind speed). σ_along grows from `bandwidthKm` (calm) toward
	 * `bandwidthKm * anisotropy` (windy). Default 2.5.
	 */
	readonly anisotropy?: number;
}

/**
 * Defaults tuned for ground-level PM2.5: a 25 km bandwidth reflects the
 * rough spatial correlation length of urban/regional aerosol, a 75 km (3σ)
 * cutoff stops cross-region bleed, and ≥3 effective stations is the bar
 * for trusting a smooth value rather than a single-sensor guess.
 */
export const DEFAULT_DIFFUSION: DiffusionParams = {
	bandwidthKm: 25,
	maxRadiusKm: 75,
	minEffectiveStationsHigh: 3,
};

export type DiffusionConfidence = 'high' | 'low' | 'none';

export interface Pm25Estimate {
	/** Weighted-mean PM2.5 (µg/m³), or null when no station with a reading is within `maxRadiusKm`. */
	readonly valueUgm3: number | null;
	readonly confidence: DiffusionConfidence;
	/** Kish effective sample size: (Σw)² / Σ(w²). ~1 when one station dominates; grows as support broadens. */
	readonly effectiveStations: number;
	/** Distance to the nearest contributing (non-null, in-range) station, km — null when none. */
	readonly nearestKm: number | null;
	/** Count of non-null stations within `maxRadiusKm`. */
	readonly contributingStations: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two lon/lat points, in km. */
export const haversineKm = (aLon: number, aLat: number, bLon: number, bLat: number): number => {
	const dLat = toRad(bLat - aLat);
	const dLon = toRad(bLon - aLon);
	const lat1 = toRad(aLat);
	const lat2 = toRad(bLat);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

const hasReading = (s: Pm25Station): s is Pm25Station & { value: number } =>
	typeof s.value === 'number' && Number.isFinite(s.value);

/** Default cap on along-wind elongation when `anisotropy` is unspecified. */
const DEFAULT_ANISOTROPY = 2.5;

/**
 * Wind speed (m/s) at which the along-wind σ reaches its full elongation cap.
 * A light ~6 m/s breeze already stretches the plume to the cap; below that the
 * elongation ramps linearly. This is an engineering heuristic, not a calibrated
 * dispersion length scale.
 */
const WIND_FULL_SCALE_MPS = 6;

/**
 * AQ-4 — along-wind σ multiplier as a function of wind speed: 1 (calm) ramping
 * linearly to `anisotropy` at/above {@link WIND_FULL_SCALE_MPS}.
 */
const alongWindScale = (speedMps: number, anisotropy: number): number =>
	1 + (anisotropy - 1) * Math.min(1, Math.max(0, speedMps) / WIND_FULL_SCALE_MPS);

/**
 * AQ-4 — build the per-station Gaussian-weight kernel. Without usable wind this
 * is the original isotropic `exp(-0.5 (d/σ)²)`. With wind it is an elliptical
 * kernel: the station's local east/north offset (equirectangular approximation
 * about the query latitude) is rotated into along-wind / cross-wind components,
 * and each axis gets its own σ — cross-wind keeps `bandwidthKm`, along-wind is
 * stretched by {@link alongWindScale}. The downwind axis points toward
 * `directionDeg + 180` (meteorological "blows from" convention), so a station
 * sitting downwind of the query point is weighted more heavily than an equally
 * distant crosswind station.
 *
 * Honest caveat: this is an engineering heuristic to make plumes lean the way
 * the wind blows, NOT a calibrated Gaussian-plume dispersion model. The σ values
 * are spatial-correlation bandwidths, not physical dispersion coefficients.
 */
const makeKernel = (
	lon: number,
	lat: number,
	params: DiffusionParams,
): ((stationLon: number, stationLat: number, d: number) => number) => {
	const sigma = params.bandwidthKm;
	const wind = params.wind;
	if (!wind || !(wind.speedMps > 0)) {
		return (_sLon, _sLat, d) => Math.exp(-0.5 * (d / sigma) ** 2);
	}

	const anisotropy = params.anisotropy ?? DEFAULT_ANISOTROPY;
	const sigmaCross = sigma;
	const sigmaAlong = sigma * alongWindScale(wind.speedMps, anisotropy);

	// Downwind unit vector in (east, north) from the meteorological direction.
	const downwindDeg = wind.directionDeg + 180;
	const downwindRad = toRad(downwindDeg);
	// Compass bearing → (east = sin, north = cos), clockwise from north.
	const eHat = Math.sin(downwindRad);
	const nHat = Math.cos(downwindRad);
	const cosLat = Math.cos(toRad(lat));

	return (stationLon, stationLat) => {
		// Local equirectangular offsets, km.
		const dNorthKm = (stationLat - lat) * 111.32;
		const dEastKm = (stationLon - lon) * 111.32 * cosLat;
		// Project onto along-wind (parallel to downwind axis) and cross-wind axes.
		const along = dEastKm * eHat + dNorthKm * nHat;
		const cross = -dEastKm * nHat + dNorthKm * eHat;
		const dSq = (along / sigmaAlong) ** 2 + (cross / sigmaCross) ** 2;
		return Math.exp(-0.5 * dSq);
	};
};

/**
 * Estimate PM2.5 at (lon, lat) from the station set using a Gaussian
 * distance kernel. Null-valued stations are excluded entirely — they are
 * "no reading", never zero pollution.
 *
 * AQ-4 — when `params.wind` is supplied with a positive speed the kernel is an
 * ellipse oriented downwind (see {@link makeKernel}); absent/calm wind keeps the
 * original isotropic behavior unchanged. The `maxRadiusKm` cutoff and the Kish
 * effective-N confidence are applied to the raw great-circle distance either way.
 */
export const estimatePm25At = (
	stations: readonly Pm25Station[],
	lon: number,
	lat: number,
	params: DiffusionParams = DEFAULT_DIFFUSION,
): Pm25Estimate => {
	const kernel = makeKernel(lon, lat, params);
	let sumW = 0;
	let sumWsq = 0;
	let sumWV = 0;
	let nearestKm: number | null = null;
	let contributing = 0;

	for (const station of stations) {
		if (!hasReading(station)) continue;
		const d = haversineKm(lon, lat, station.lon, station.lat);
		if (d > params.maxRadiusKm) continue;
		contributing += 1;
		if (nearestKm === null || d < nearestKm) nearestKm = d;
		const w = kernel(station.lon, station.lat, d);
		sumW += w;
		sumWsq += w * w;
		sumWV += w * station.value;
	}

	if (contributing === 0 || sumW === 0) {
		return { valueUgm3: null, confidence: 'none', effectiveStations: 0, nearestKm: null, contributingStations: 0 };
	}

	const effectiveStations = (sumW * sumW) / sumWsq;
	const confidence: DiffusionConfidence = effectiveStations >= params.minEffectiveStationsHigh ? 'high' : 'low';

	return {
		valueUgm3: sumWV / sumW,
		confidence,
		effectiveStations,
		nearestKm,
		contributingStations: contributing,
	};
};

/**
 * AQ-1 — kernel-diffuse an arbitrary criteria pollutant at a point by reusing
 * the same Gaussian estimator over each station's reading for that pollutant.
 * `valueUgm3` carries the pollutant's value (in its native units); confidence /
 * coverage are pollutant-specific (a station may report PM2.5 but not O₃).
 */
export const estimatePollutantAt = (
	stations: readonly Pm25Station[],
	lon: number,
	lat: number,
	pollutant: string,
	params: DiffusionParams = DEFAULT_DIFFUSION,
): Pm25Estimate => {
	const view: Pm25Station[] = stations.map((s) => ({
		lon: s.lon,
		lat: s.lat,
		value: pollutant === 'pm25' ? s.value : (s.pollutants?.[pollutant] ?? null),
	}));
	return estimatePm25At(view, lon, lat, params);
};

/**
 * First-order PM2.5 (µg/m³) → aerosol optical depth at 550 nm.
 *
 * AOD is a column-integrated quantity; surface PM2.5 maps to it only
 * approximately and varies with boundary-layer height + hygroscopic
 * growth. We use a single documented conversion factor as a V1 estimate
 * (literature puts the dry-conversion in the ~0.01 AOD per µg/m³ range for
 * a ~1 km mixed layer; treat as an engineering estimate, surfaced as such
 * in the widget). The result is clamped to the LUT's AOD550 axis range so
 * downstream quadrilinear interpolation never extrapolates off-grid.
 */
export const PM25_TO_AOD550_FACTOR = 0.012;

const AOD550_MAX = AOD550_AXIS[AOD550_AXIS.length - 1];

export const pm25ToAod550 = (pm25Ugm3: number | null): number | null => {
	if (pm25Ugm3 === null || !Number.isFinite(pm25Ugm3)) return null;
	const aod = Math.max(0, pm25Ugm3) * PM25_TO_AOD550_FACTOR;
	return Math.min(AOD550_MAX, aod);
};

/** US-AQI PM2.5 category label (µg/m³ breakpoints) — plain-language context. */
export const pm25AqiCategory = (v: number): string => {
	if (v < 12) return 'Good';
	if (v < 35.5) return 'Moderate';
	if (v < 55.5) return 'Unhealthy for sensitive groups';
	if (v < 150.5) return 'Unhealthy';
	if (v < 250.5) return 'Very unhealthy';
	return 'Hazardous';
};

/**
 * Shared phrasing for the PM2.5 coverage captions, so the transmission-widget
 * AOD source line and the point readout round + pluralize identically. Each
 * caller supplies its own separator (comma vs middot) around these fragments.
 */
export const formatStationCount = (n: number): string => `${n} station${n === 1 ? '' : 's'}`;

/** "nearest <1 km" / "nearest N km", or null when no station is in range. */
export const formatNearestKm = (km: number | null): string | null =>
	km === null ? null : `nearest ${km < 1 ? '<1' : Math.round(km)} km`;
