import { describe, expect, it } from 'vitest';
import type { Pm25Estimate } from './pm25-diffusion';
import { DEFAULT_PWV_MM, buildTxConstituents, toTransmissionInput, type ConstituentInputs } from './tx-constituents';

const base: ConstituentInputs = {
	pwvMm: null,
	camsAod550: null,
	pm25Estimate: null,
	manualAod550: 0.15,
	manualAodActive: false,
	angstrom: 1.4,
	o3Du: 350,
	zenithDeg: 0,
	zenithDirected: false,
};

const pm25 = (over: Partial<Pm25Estimate> = {}): Pm25Estimate => ({
	valueUgm3: 18,
	confidence: 'high',
	effectiveStations: 4,
	nearestKm: 8,
	contributingStations: 5,
	...over,
});

describe('buildTxConstituents — AOD source priority', () => {
	it('uses the default slider value when nothing better is available', () => {
		const c = buildTxConstituents(base);
		expect(c.aod550.value).toBe(0.15);
		expect(c.aod550.source).toBe('default');
	});

	it('prefers measured CAMS AOD over the default', () => {
		const c = buildTxConstituents({ ...base, camsAod550: 0.27 });
		expect(c.aod550.value).toBe(0.27);
		expect(c.aod550.source).toBe('measured');
		expect(c.aod550.caption).toMatch(/CAMS/);
	});

	it('prefers measured CAMS over the modeled PM2.5 bridge', () => {
		const c = buildTxConstituents({ ...base, camsAod550: 0.27, pm25Estimate: pm25() });
		expect(c.aod550.source).toBe('measured');
		expect(c.aod550.value).toBe(0.27);
	});

	it('falls back to the modeled PM2.5 bridge when CAMS is absent', () => {
		const c = buildTxConstituents({ ...base, pm25Estimate: pm25() });
		expect(c.aod550.source).toBe('modeled');
		expect(c.aod550.confidence).toBe('high');
		expect(c.aod550.caption).toMatch(/local PM2\.5/);
	});

	it('never uses a sparse (none-confidence) PM2.5 estimate', () => {
		const c = buildTxConstituents({ ...base, pm25Estimate: pm25({ confidence: 'none', valueUgm3: null }) });
		expect(c.aod550.source).toBe('default');
	});

	it('manual override wins over everything', () => {
		const c = buildTxConstituents({
			...base,
			manualAod550: 0.5,
			manualAodActive: true,
			camsAod550: 0.27,
			pm25Estimate: pm25(),
		});
		expect(c.aod550.value).toBe(0.5);
		expect(c.aod550.source).toBe('default');
		expect(c.aod550.caption).toBe('manual');
	});
});

describe('buildTxConstituents — other fields', () => {
	it('marks PWV measured when present, default otherwise', () => {
		expect(buildTxConstituents({ ...base, pwvMm: 22 }).pwv).toMatchObject({ value: 22, source: 'measured' });
		const d = buildTxConstituents(base).pwv;
		expect(d.value).toBe(DEFAULT_PWV_MM);
		expect(d.source).toBe('default');
	});

	it('keeps O₃ a default when no climatology value is supplied', () => {
		expect(buildTxConstituents(base).o3.source).toBe('default');
		expect(buildTxConstituents(base).o3.value).toBe(350);
	});

	it('uses the van Heuklon column climatology as a modeled O₃ when supplied', () => {
		const c = buildTxConstituents({ ...base, o3ColumnDu: 328.3 });
		expect(c.o3.value).toBe(328.3);
		expect(c.o3.source).toBe('modeled');
		expect(c.o3.caption).toMatch(/van Heuklon/);
	});

	it('labels zenith by whether it is a directed boresight', () => {
		expect(buildTxConstituents({ ...base, zenithDirected: true, zenithDeg: 40 }).zenith.source).toBe('measured');
		expect(buildTxConstituents(base).zenith.source).toBe('default');
	});
});

describe('toTransmissionInput', () => {
	it('projects the constituent values into the LUT input shape', () => {
		const c = buildTxConstituents({ ...base, pwvMm: 20, camsAod550: 0.3, zenithDeg: 30, zenithDirected: true });
		expect(toTransmissionInput(c)).toEqual({ pwvMm: 20, aod550: 0.3, angstrom: 1.4, o3Du: 350, zenithDeg: 30 });
	});
});
