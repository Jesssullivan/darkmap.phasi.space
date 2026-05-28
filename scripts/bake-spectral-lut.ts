#!/usr/bin/env tsx
/**
 * scripts/bake-spectral-lut.ts — V0 spectral LUT bake.
 *
 * Generates `static/spectral-lut.json` from the analytical model in
 * `src/lib/spectral/analytical.ts`. Run via `pnpm bake:spectral` (or
 * `pnpm exec tsx scripts/bake-spectral-lut.ts`).
 *
 * Why a LUT for an analytical model?
 *   - Stable runtime contract — the V0 file shape matches what V1 will
 *     ship once SMARTS + SBDART runs land. Only `static/spectral-lut.json`
 *     changes; the `TransmissionEstimator` service stays put.
 *   - First-load amortizes: ~150 KB JSON parsed once, interp is O(32) per
 *     query instead of recomputing 60 Gaussian + λ⁻⁴ terms each time.
 *
 * The LUT covers the V0 axes defined in `src/lib/spectral/transmission-axes.ts`.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyticalTransmission } from '../src/lib/spectral/analytical';
import {
	ANGSTROM_AXIS,
	AOD550_AXIS,
	O3_DU_AXIS,
	PWV_MM_AXIS,
	SPECTRAL_LUT_SOURCE,
	SPECTRAL_LUT_VERSION,
	WAVELENGTH_UM_AXIS,
	ZENITH_DEG_AXIS,
	type SpectralLut,
} from '../src/lib/spectral/transmission-axes';

const ROUND = (x: number, digits = 5): number => {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
};

const main = (): void => {
	const here = fileURLToPath(import.meta.url);
	const outPath = resolve(dirname(here), '..', 'static', 'spectral-lut.json');
	if (!existsSync(dirname(outPath))) {
		mkdirSync(dirname(outPath), { recursive: true });
	}

	const totalCells =
		PWV_MM_AXIS.length * AOD550_AXIS.length * ANGSTROM_AXIS.length * O3_DU_AXIS.length * ZENITH_DEG_AXIS.length;
	const flat: number[] = new Array(totalCells * WAVELENGTH_UM_AXIS.length);
	let i = 0;
	for (const pwvMm of PWV_MM_AXIS) {
		for (const aod550 of AOD550_AXIS) {
			for (const angstrom of ANGSTROM_AXIS) {
				for (const o3Du of O3_DU_AXIS) {
					for (const zenithDeg of ZENITH_DEG_AXIS) {
						for (const lambda of WAVELENGTH_UM_AXIS) {
							flat[i++] = ROUND(analyticalTransmission(lambda, { pwvMm, aod550, angstrom, o3Du, zenithDeg }));
						}
					}
				}
			}
		}
	}

	const lut: SpectralLut = {
		version: SPECTRAL_LUT_VERSION,
		source: SPECTRAL_LUT_SOURCE,
		generatedAt: new Date().toISOString(),
		axes: {
			pwvMm: PWV_MM_AXIS,
			aod550: AOD550_AXIS,
			angstrom: ANGSTROM_AXIS,
			o3Du: O3_DU_AXIS,
			zenithDeg: ZENITH_DEG_AXIS,
		},
		wavelengthsUm: WAVELENGTH_UM_AXIS.map((x) => ROUND(x, 4)),
		transmissionFlat: flat,
	};

	const payload = JSON.stringify(lut);
	writeFileSync(outPath, payload);
	const kb = (payload.length / 1024).toFixed(1);
	// eslint-disable-next-line no-console
	console.log(
		`baked ${flat.length.toLocaleString()} values across ${totalCells.toLocaleString()} cells → ${outPath} (${kb} KB)`,
	);
};

main();
