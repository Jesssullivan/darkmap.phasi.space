/**
 * AQI density field (AQ-3) — the rendered interpolated field that replaces the
 * MapLibre heatmap-blur-over-points.
 *
 * Evaluate the kernel-diffusion estimate (the same honest Gaussian as the point
 * readout, optionally wind-anisotropic) on a regular lon/lat grid over the
 * viewport, composite a US-EPA AQI per cell, and emit an RGBA raster the caller
 * paints to a canvas → MapLibre `image` source. Cells with NO station coverage
 * (`confidence: none`) are left fully transparent — the field only colours where
 * there is real support, never a fabricated value.
 *
 * Pure + DOM-free (returns a pixel buffer, not a canvas) so it unit-tests
 * without MapLibre. The pollutant list is inlined to avoid pulling the
 * Effect-based OpenAQService into this module's runtime/test slice.
 */

import { estimatePollutantAt, type DiffusionParams, type Pm25Station } from '$lib/atmospheric/pm25-diffusion';
import { computeAqi, type AqiReading } from '$lib/atmospheric/aqi';
import { CRITERIA_POLLUTANTS } from '$lib/atmospheric/pollutants';

export interface FieldBbox {
	readonly west: number;
	readonly south: number;
	readonly east: number;
	readonly north: number;
}

export interface AqiField {
	readonly width: number;
	readonly height: number;
	/** RGBA, length width·height·4, row-major from the NORTH edge (row 0) southward. */
	readonly rgba: Uint8ClampedArray;
	/** Number of cells that resolved to an AQI (had coverage). */
	readonly painted: number;
}

export interface BuildFieldOptions {
	/** Per-pollutant units (for the AQI gas conversions); PM defaults to µg/m³. */
	readonly units?: Record<string, string>;
	/** Diffusion params (e.g. with a wind vector for an anisotropic field). */
	readonly params?: DiffusionParams;
	/** Fill alpha for painted cells, 0–255 (default 140 — semi-transparent over the basemap). */
	readonly alpha?: number;
}

const hexToRgb = (hex: string): [number, number, number] => {
	const h = hex.replace('#', '');
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/**
 * Build an `width × height` AQI raster over `bbox`. Row 0 is the north edge so
 * the buffer drops straight into a MapLibre `image` source whose coordinates are
 * [[W,N],[E,N],[E,S],[W,S]].
 */
export const buildAqiField = (
	stations: readonly Pm25Station[],
	bbox: FieldBbox,
	width: number,
	height: number,
	opts: BuildFieldOptions = {},
): AqiField => {
	const w = Math.max(1, Math.floor(width));
	const h = Math.max(1, Math.floor(height));
	const alpha = opts.alpha ?? 140;
	const units = opts.units ?? {};
	const rgba = new Uint8ClampedArray(w * h * 4);
	let painted = 0;

	const lonSpan = bbox.east - bbox.west;
	const latSpan = bbox.north - bbox.south;

	for (let j = 0; j < h; j++) {
		// Cell centre latitude, north (row 0) → south.
		const lat = bbox.north - ((j + 0.5) / h) * latSpan;
		for (let i = 0; i < w; i++) {
			const lon = bbox.west + ((i + 0.5) / w) * lonSpan;
			const readings: AqiReading[] = [];
			for (const p of CRITERIA_POLLUTANTS) {
				const est = estimatePollutantAt(stations, lon, lat, p, opts.params);
				if (est.confidence === 'none' || est.valueUgm3 === null) continue;
				readings.push({ pollutant: p, value: est.valueUgm3, units: units[p] });
			}
			const idx = (j * w + i) * 4;
			const aqi = readings.length > 0 ? computeAqi(readings) : null;
			if (!aqi) {
				rgba[idx + 3] = 0; // no coverage → transparent, never a fabricated colour
				continue;
			}
			const [r, g, b] = hexToRgb(aqi.category.color);
			rgba[idx] = r;
			rgba[idx + 1] = g;
			rgba[idx + 2] = b;
			rgba[idx + 3] = alpha;
			painted++;
		}
	}

	return { width: w, height: h, rgba, painted };
};
