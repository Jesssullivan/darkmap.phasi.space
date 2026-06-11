/**
 * Viewport sampling helpers.
 *
 * The twilight viewport-summary (born as the EphemerisGantt's range
 * pill; its TimeHelix successor defers the pill UI) samples ephemeris at a
 * 4×4 grid of points inside the visible viewport. The math is in a
 * pure helper here so it can be unit-tested independently from the
 * Svelte component — which matters because the bug it fixes (silent
 * wrong sampling when the viewport straddles the antimeridian) is
 * invisible in normal UI testing.
 */

export interface ViewportBounds {
	readonly north: number;
	readonly south: number;
	readonly east: number;
	readonly west: number;
}

export interface GridPoint {
	readonly lat: number;
	readonly lon: number;
}

const canonicalizeLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * Emit an N×N grid of points inside the viewport, antimeridian-aware.
 * Returns the empty array for degenerate viewports (zero or negative
 * span on either axis).
 *
 * Caller picks N (the viewport summary uses 4 for ephemeris range
 * sampling — 16 calls is cheap and covers the variability that
 * matters for state-scale viewports).
 */
export const viewportGridPoints = (bounds: ViewportBounds, samples: number): readonly GridPoint[] => {
	if (samples < 1) return [];
	const dlat = bounds.north - bounds.south;
	const dlon = bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east - bounds.west + 360;
	if (dlat <= 0 || dlon <= 0) return [];

	const out: GridPoint[] = [];
	for (let i = 0; i < samples; i++) {
		for (let j = 0; j < samples; j++) {
			const lat = bounds.south + ((i + 0.5) / samples) * dlat;
			const rawLon = bounds.west + ((j + 0.5) / samples) * dlon;
			out.push({ lat, lon: canonicalizeLon(rawLon) });
		}
	}
	return out;
};
