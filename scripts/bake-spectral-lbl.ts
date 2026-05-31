#!/usr/bin/env tsx
/**
 * scripts/bake-spectral-lbl.ts — V3b-2 line-by-line bake.
 *
 * Reads `data/hitran/curated-lines.json`, evaluates Voigt profiles per line
 * at fine spectral resolution within each band's window, and writes one
 * JSON per band to `static/spectral-lbl/{band-id}.json`. The LBL service
 * (V3b-3) loads these lazily when the user zooms into a band.
 *
 * Reference conditions for the bake:
 *   T = 296 K, P = 1 atm, airmass = 1.
 * Output is the dimensionless absorption optical depth τ(λ) at a
 * normalized column density. The service scales τ at query time by the
 * user-supplied airmass + molecule column.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	cm1ToUm,
	HITRAN_BANDS,
	type CuratedHitranArchive,
	type HitranBand,
	type HitranLine,
	type HitranMolecule,
	umToCm1,
} from '../src/lib/spectral/hitran-bands';
import { dopplerHwhm, pressureHwhm, voigtProfile } from '../src/lib/spectral/voigt';

const T_REF = 296; // K
const P_REF = 1.0; // atm
// HITRAN reference column density [molecules / cm²] for τ-of-unity scaling.
// Chosen so the curated subset produces τ values on the order of 0.5–2
// across each band's center — enough that the chart looks alive.
const REF_COLUMN: Record<HitranMolecule, number> = {
	h2o: 5e22, // ~15 mm PWV equivalent
	o2: 4.6e24, // standard atmosphere O2 column
	co2: 8.0e21, // 400 ppmv × atm column
};

const MOLAR_MASS: Record<HitranMolecule, number> = {
	h2o: 18.015,
	o2: 31.998,
	co2: 44.01,
};

/** Spectral grid resolution inside each band window — 0.01 nm. */
const GRID_STEP_UM = 1e-5; // µm

interface LblBandOutput {
	readonly bandId: string;
	readonly molecule: HitranMolecule;
	readonly version: number;
	readonly source: string;
	readonly generatedAt: string;
	readonly wavelengthsUm: ReadonlyArray<number>;
	/** Optical depth τ(λ) at the reference column density, airmass = 1, T = 296 K. */
	readonly tau: ReadonlyArray<number>;
	readonly refColumn: number;
	readonly attribution: string;
}

const ROUND = (x: number, digits: number): number => {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
};

const bakeBand = (band: HitranBand, lines: ReadonlyArray<HitranLine>, molecule: HitranMolecule): LblBandOutput => {
	const refCol = REF_COLUMN[molecule];
	const mass = MOLAR_MASS[molecule];

	// Dense wavelength grid in µm across the band window.
	const wavelengthsUm: number[] = [];
	const lo = band.centerUm - band.halfWidthUm;
	const hi = band.centerUm + band.halfWidthUm;
	const count = Math.round((hi - lo) / GRID_STEP_UM) + 1;
	for (let i = 0; i < count; i++) {
		wavelengthsUm.push(ROUND(lo + i * GRID_STEP_UM, 6));
	}

	// Precompute per-line Doppler and Lorentz HWHMs at reference T/P.
	const lineParams = lines.map((line) => ({
		line,
		alphaD: dopplerHwhm(line.nu0, T_REF, mass),
		alphaL: pressureHwhm(line.gammaAir, P_REF, T_REF, line.nAir),
	}));

	const tau = wavelengthsUm.map((lambdaUm) => {
		const nu = umToCm1(lambdaUm);
		let absorption = 0; // cm⁻¹ per molecule / cm²
		for (const { line, alphaD, alphaL } of lineParams) {
			const profile = voigtProfile(nu - line.nu0, alphaD, alphaL);
			absorption += line.S * profile;
		}
		return ROUND(absorption * refCol, 6);
	});

	return {
		bandId: band.id,
		molecule,
		version: 1,
		source: 'voigt-lbl-v1',
		generatedAt: new Date().toISOString(),
		wavelengthsUm,
		tau,
		refColumn: refCol,
		attribution: 'HITRAN2020 (Gordon et al. 2022, JQSRT 277, 107949)',
	};
};

const main = (): void => {
	const here = fileURLToPath(import.meta.url);
	const projectRoot = resolve(dirname(here), '..');
	const curatedPath = resolve(projectRoot, 'data', 'hitran', 'curated-lines.json');
	const outDir = resolve(projectRoot, 'static', 'spectral-lbl');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const archive = JSON.parse(readFileSync(curatedPath, 'utf-8')) as CuratedHitranArchive;
	const byId = new Map(archive.bands.map((b) => [b.bandId, b]));

	let totalBytes = 0;
	for (const band of HITRAN_BANDS) {
		const cached = byId.get(band.id);
		if (!cached || cached.lines.length === 0) {
			// eslint-disable-next-line no-console
			console.warn(`skipping ${band.id} — no curated lines available`);
			continue;
		}
		const baked = bakeBand(band, cached.lines, cached.molecule);
		const outPath = resolve(outDir, `${band.id}.json`);
		const payload = JSON.stringify(baked);
		writeFileSync(outPath, payload);
		totalBytes += payload.length;
		// eslint-disable-next-line no-console
		console.log(
			`baked ${band.id}: ${baked.wavelengthsUm.length} points, ${(payload.length / 1024).toFixed(1)} KB → ${outPath}`,
		);
		// Sanity reference — confirm the bake covers the expected µm range.
		const minUm = baked.wavelengthsUm[0];
		const maxUm = baked.wavelengthsUm[baked.wavelengthsUm.length - 1];
		void cm1ToUm; // re-export kept for runtime imports
		// eslint-disable-next-line no-console
		console.log(`   range: ${minUm.toFixed(4)} – ${maxUm.toFixed(4)} µm`);
	}
	// eslint-disable-next-line no-console
	console.log(`Total LBL payload: ${(totalBytes / 1024).toFixed(1)} KB across ${HITRAN_BANDS.length} bands`);
};

main();
