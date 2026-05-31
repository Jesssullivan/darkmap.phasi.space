import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	bandContainingWavelength,
	cm1ToUm,
	findHitranBand,
	HITRAN_BAND_IDS,
	HITRAN_BANDS,
	umToCm1,
	type CuratedHitranArchive,
} from './hitran-bands';

describe('HITRAN band manifest', () => {
	it('covers all seven named astronomy bands', () => {
		expect(HITRAN_BAND_IDS).toEqual([
			'h2o-940nm',
			'h2o-1130nm',
			'h2o-1380nm',
			'h2o-1870nm',
			'o2-a-band-762nm',
			'o2-x-band-628nm',
			'co2-43um',
		]);
	});

	for (const band of HITRAN_BANDS) {
		it(`${band.id}: has a sensible wavelength window`, () => {
			expect(band.centerUm).toBeGreaterThan(0.3);
			expect(band.centerUm).toBeLessThan(30);
			expect(band.halfWidthUm).toBeGreaterThan(0);
			expect(band.halfWidthUm).toBeLessThan(band.centerUm);
			expect(['h2o', 'o2', 'co2']).toContain(band.molecule);
			expect(band.description.length).toBeGreaterThan(20);
		});
	}

	it('findHitranBand round-trips by id', () => {
		for (const band of HITRAN_BANDS) {
			expect(findHitranBand(band.id)).toBe(band);
		}
		expect(findHitranBand('not-a-band')).toBeUndefined();
	});
});

describe('bandContainingWavelength', () => {
	it('returns the band when λ falls inside its window', () => {
		expect(bandContainingWavelength(0.94)?.id).toBe('h2o-940nm');
		expect(bandContainingWavelength(0.762)?.id).toBe('o2-a-band-762nm');
		expect(bandContainingWavelength(4.3)?.id).toBe('co2-43um');
	});

	it('returns undefined outside any band window', () => {
		expect(bandContainingWavelength(0.5)).toBeUndefined();
		expect(bandContainingWavelength(3.0)).toBeUndefined();
		expect(bandContainingWavelength(15)).toBeUndefined();
	});

	it('matches near the window edge (subject to floating-point precision)', () => {
		const band = HITRAN_BANDS[0];
		const justInside = band.centerUm + band.halfWidthUm - 1e-6;
		expect(bandContainingWavelength(justInside)?.id).toBe(band.id);
	});
});

describe('wavenumber conversions', () => {
	it('umToCm1 and cm1ToUm round-trip', () => {
		for (const lambda of [0.4, 0.94, 1.38, 4.3]) {
			expect(cm1ToUm(umToCm1(lambda))).toBeCloseTo(lambda, 6);
		}
	});

	it('matches canonical values: 1 µm → 10000 cm⁻¹', () => {
		expect(umToCm1(1)).toBeCloseTo(10_000, 6);
		expect(cm1ToUm(10_000)).toBeCloseTo(1, 6);
	});
});

describe('curated HITRAN archive', () => {
	const path = resolve(process.cwd(), 'data', 'hitran', 'curated-lines.json');
	const archive = JSON.parse(readFileSync(path, 'utf-8')) as CuratedHitranArchive;

	it('archive matches the schema version', () => {
		expect(archive.version).toBe(1);
		expect(archive.attribution).toMatch(/HITRAN2020/);
	});

	it('every manifest band has at least one cached line entry', () => {
		const cached = new Map(archive.bands.map((b) => [b.bandId, b]));
		for (const band of HITRAN_BANDS) {
			const entry = cached.get(band.id);
			expect(entry).toBeDefined();
			expect(entry!.molecule).toBe(band.molecule);
			expect(entry!.lines.length).toBeGreaterThan(0);
		}
	});

	it('each cached line has physically plausible HITRAN parameters', () => {
		for (const cachedBand of archive.bands) {
			for (const line of cachedBand.lines) {
				expect(line.nu0).toBeGreaterThan(0);
				expect(line.S).toBeGreaterThan(0);
				expect(line.gammaAir).toBeGreaterThan(0);
				expect(line.gammaAir).toBeLessThan(1);
				expect(line.gammaSelf).toBeGreaterThan(0);
				expect(line.gammaSelf).toBeLessThan(1);
				expect(line.Elower).toBeGreaterThanOrEqual(0);
				expect(line.nAir).toBeGreaterThan(0);
				expect(line.nAir).toBeLessThan(1.5);
			}
		}
	});

	it('cached line centers fall within their declared band windows', () => {
		const bandsById = new Map(HITRAN_BANDS.map((b) => [b.id, b]));
		for (const cachedBand of archive.bands) {
			const band = bandsById.get(cachedBand.bandId);
			if (!band) continue;
			for (const line of cachedBand.lines) {
				const lambdaUm = cm1ToUm(line.nu0);
				const delta = Math.abs(lambdaUm - band.centerUm);
				expect(delta).toBeLessThanOrEqual(band.halfWidthUm * 1.5);
			}
		}
	});
});
