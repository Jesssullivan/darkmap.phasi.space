#!/usr/bin/env tsx
/**
 * scripts/bake-spectral-lut-smarts-analog.ts — V3a-1 spectral LUT bake.
 *
 * Generates `static/spectral-lut.json` from the SMARTS-analog model in
 * `src/lib/spectral/smarts-analog.ts`. Same LUT shape and axes as the
 * V0 bake (`bake-spectral-lut.ts`); only the `source` field changes to
 * `smarts-analog-v1` and the underlying transmission values reflect the
 * improved physics.
 *
 * Run via `pnpm bake:spectral-smarts-analog`. The TransmissionEstimator
 * service does not need to change between V0 and V3a — that's the whole
 * point of the LUT contract being stable.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smartsAnalogTransmission } from '../src/lib/spectral/smarts-analog';
import {
	ANGSTROM_AXIS,
	AOD550_AXIS,
	O3_DU_AXIS,
	PWV_MM_AXIS,
	SPECTRAL_LUT_VERSION,
	WAVELENGTH_UM_AXIS,
	ZENITH_DEG_AXIS,
	type SpectralLut,
} from '../src/lib/spectral/transmission-axes';

const SMARTS_ANALOG_SOURCE = 'smarts-analog-v1' as const;

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
							flat[i++] = ROUND(smartsAnalogTransmission(lambda, { pwvMm, aod550, angstrom, o3Du, zenithDeg }));
						}
					}
				}
			}
		}
	}

	const lut: SpectralLut = {
		version: SPECTRAL_LUT_VERSION,
		source: SMARTS_ANALOG_SOURCE,
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
