import { describe, expect, it } from 'vitest';
import type { Pm25Station } from '$lib/atmospheric/pm25-diffusion';
import { aqiCategory } from '$lib/atmospheric/aqi';
import { buildAqiField, type FieldBbox } from './aqi-field';

// A bbox ~0.4° across centred on (lon -100, lat 40) — small enough that every
// cell is well within the 75 km diffusion cutoff of a central station.
const bbox: FieldBbox = { west: -100.2, south: 39.8, east: -99.8, north: 40.2 };

const alphaAt = (f: { rgba: Uint8ClampedArray; width: number }, col: number, row: number) =>
	f.rgba[(row * f.width + col) * 4 + 3];

describe('buildAqiField', () => {
	it('paints every cell when a station covers the whole bbox', () => {
		const stations: Pm25Station[] = [{ lon: -100, lat: 40, value: 20, pollutants: { pm25: 20 } }];
		const f = buildAqiField(stations, bbox, 8, 8, { alpha: 140 });
		expect(f.width).toBe(8);
		expect(f.height).toBe(8);
		expect(f.painted).toBe(64);
		// Centre cell carries the PM2.5=20 → AQI 71 (Moderate) colour at the set alpha.
		const [r, g, b] = hexToRgbLocal(aqiCategory(71).color);
		const idx = (4 * 8 + 4) * 4;
		expect(f.rgba[idx]).toBe(r);
		expect(f.rgba[idx + 1]).toBe(g);
		expect(f.rgba[idx + 2]).toBe(b);
		expect(f.rgba[idx + 3]).toBe(140);
	});

	it('leaves cells with no station in range fully transparent (no fabrication)', () => {
		// Station ~500 km south — outside the 75 km cutoff for the whole bbox.
		const stations: Pm25Station[] = [{ lon: -100, lat: 35, value: 80, pollutants: { pm25: 80 } }];
		const f = buildAqiField(stations, bbox, 6, 6, {});
		expect(f.painted).toBe(0);
		for (let k = 0; k < f.width * f.height; k++) expect(f.rgba[k * 4 + 3]).toBe(0);
	});

	it('empty station set → all transparent', () => {
		const f = buildAqiField([], bbox, 4, 4, {});
		expect(f.painted).toBe(0);
	});

	it('row 0 is the north edge (a north-only station paints the top, not the bottom)', () => {
		// Station just north of the bbox centre line; with a tight bandwidth the
		// southern rows fall out of range while northern rows stay covered.
		const stations: Pm25Station[] = [{ lon: -100, lat: 40.2, value: 30, pollutants: { pm25: 30 } }];
		const f = buildAqiField(stations, bbox, 4, 4, {
			params: { bandwidthKm: 10, maxRadiusKm: 20, minEffectiveStationsHigh: 3 },
		});
		// Top row (north) should have more painted cells than the bottom row (south).
		let topPainted = 0;
		let botPainted = 0;
		for (let c = 0; c < f.width; c++) {
			if (alphaAt(f, c, 0) > 0) topPainted++;
			if (alphaAt(f, c, f.height - 1) > 0) botPainted++;
		}
		expect(topPainted).toBeGreaterThan(botPainted);
	});

	it('colours by composite AQI — a hazardous PM2.5 station paints the hazardous band', () => {
		const stations: Pm25Station[] = [{ lon: -100, lat: 40, value: 260, pollutants: { pm25: 260 } }];
		const f = buildAqiField(stations, bbox, 4, 4, {});
		const [r, g, b] = hexToRgbLocal(aqiCategory(400).color); // PM2.5 260 → ~Hazardous
		const idx = (1 * 4 + 1) * 4;
		expect([f.rgba[idx], f.rgba[idx + 1], f.rgba[idx + 2]]).toEqual([r, g, b]);
	});
});

// Local copy of the field's hex parse so the test asserts against the same values.
function hexToRgbLocal(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
