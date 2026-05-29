import { describe, expect, it } from 'vitest';
import {
	ATMOSPHERIC_CAPABILITIES,
	capabilityFor,
	defaultTimeForCapability,
	expandAtmosphericUrl,
	isAtmosphericLayer,
	isImmutableTime,
	type AtmosphericCapability,
} from './atmospheric-capabilities';
import { LAYERS, rasterUrlTemplate, VIIRS_YEARS, type LayerGroup, type RasterLayerDef } from './layers';

/* ------------------------------------------------------------------------ */
/* #235a — Layer manifest invariants.                                       */
/*                                                                          */
/* Parent #196 calls for "stable IDs, source kind, max zoom/time capability */
/* metadata, and attribution for every listed layer." These tests pin the   */
/* shape of `LAYERS` + `ATMOSPHERIC_CAPABILITIES` so a casual edit to a     */
/* row cannot quietly break a contract the rest of the app depends on.     */
/* ------------------------------------------------------------------------ */

const VALID_GROUPS: ReadonlyArray<LayerGroup> = ['viirs_annual', 'world_atlas', 'world_atlas_raw', 'atmospheric'];

const ID_RE = /^[a-z][a-z0-9_-]*$/;

const sourceKindOf = (
	layer: RasterLayerDef,
): 'upstream-layer' | 'upstream-url-template' | 'point-source-url' | 'invalid' => {
	const have = [
		layer.upstreamLayer !== undefined,
		layer.upstreamUrlTemplate !== undefined,
		layer.pointSourceUrl !== undefined,
	];
	const count = have.filter(Boolean).length;
	if (count !== 1) return 'invalid';
	if (layer.upstreamLayer !== undefined) return 'upstream-layer';
	if (layer.upstreamUrlTemplate !== undefined) return 'upstream-url-template';
	return 'point-source-url';
};

describe('LAYERS — base invariants', () => {
	it('has at least one entry per non-atmospheric group', () => {
		const byGroup = new Set(LAYERS.map((l) => l.group));
		for (const g of ['viirs_annual', 'world_atlas', 'world_atlas_raw', 'atmospheric'] as LayerGroup[]) {
			expect(byGroup.has(g)).toBe(true);
		}
	});

	it('every entry has a stable id (lowercase / hyphens / underscores only)', () => {
		for (const layer of LAYERS) {
			expect(layer.id, `layer ${layer.id} id shape`).toMatch(ID_RE);
		}
	});

	it('ids are unique across the manifest', () => {
		const ids = LAYERS.map((l) => l.id);
		const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
		expect(dupes).toEqual([]);
	});

	it('label + description are non-empty for every layer', () => {
		for (const layer of LAYERS) {
			expect(layer.label.trim().length, `${layer.id} label`).toBeGreaterThan(0);
			expect(layer.description.trim().length, `${layer.id} description`).toBeGreaterThan(0);
		}
	});

	it('group is one of the declared LayerGroup values', () => {
		for (const layer of LAYERS) {
			expect(VALID_GROUPS, `${layer.id} group`).toContain(layer.group);
		}
	});

	it('opacity is in [0, 1] for every layer', () => {
		for (const layer of LAYERS) {
			expect(layer.opacity, `${layer.id} opacity`).toBeGreaterThanOrEqual(0);
			expect(layer.opacity, `${layer.id} opacity`).toBeLessThanOrEqual(1);
		}
	});

	it('exactly one of upstreamLayer / upstreamUrlTemplate / pointSourceUrl is set per layer', () => {
		for (const layer of LAYERS) {
			expect(sourceKindOf(layer), `${layer.id} source-kind`).not.toBe('invalid');
		}
	});

	it('maxNativeZoom (when present) is a positive integer ≤ 22', () => {
		for (const layer of LAYERS) {
			if (layer.maxNativeZoom === undefined) continue;
			expect(Number.isInteger(layer.maxNativeZoom), `${layer.id} maxNativeZoom integer`).toBe(true);
			expect(layer.maxNativeZoom).toBeGreaterThan(0);
			expect(layer.maxNativeZoom).toBeLessThanOrEqual(22);
		}
	});

	it('defaultEnabled is a boolean — at most one default-on per group', () => {
		const onByGroup = new Map<LayerGroup, number>();
		for (const layer of LAYERS) {
			expect(typeof layer.defaultEnabled).toBe('boolean');
			if (layer.defaultEnabled) onByGroup.set(layer.group, (onByGroup.get(layer.group) ?? 0) + 1);
		}
		for (const [g, n] of onByGroup) {
			expect(n, `group ${g} default-on count`).toBeLessThanOrEqual(1);
		}
	});
});

describe('LAYERS — viirs_annual group', () => {
	it('every viirs_annual entry has a year in 2012-2019 with matching upstreamLayer', () => {
		const viirs = LAYERS.filter((l) => l.group === 'viirs_annual');
		expect(viirs.length).toBeGreaterThan(0);
		for (const layer of viirs) {
			expect(layer.year, `${layer.id} year`).toBeDefined();
			expect(layer.year!).toBeGreaterThanOrEqual(2012);
			expect(layer.year!).toBeLessThanOrEqual(2019);
			expect(layer.upstreamLayer).toBe(`PostGIS:VIIRS_${layer.year}`);
		}
	});

	it('VIIRS_YEARS export is sorted descending by year', () => {
		const years = VIIRS_YEARS.map((l) => l.year!);
		const sortedDesc = [...years].sort((a, b) => b - a);
		expect(years).toEqual(sortedDesc);
	});
});

describe('LAYERS — atmospheric group', () => {
	it('every atmospheric raster layer carries attribution + maxNativeZoom + an upstream URL template', () => {
		const atm = LAYERS.filter((l) => l.group === 'atmospheric' && l.upstreamUrlTemplate !== undefined);
		expect(atm.length).toBeGreaterThan(0);
		for (const layer of atm) {
			expect(layer.attribution?.length, `${layer.id} attribution`).toBeGreaterThan(0);
			expect(layer.maxNativeZoom, `${layer.id} maxNativeZoom`).toBeDefined();
			expect(layer.upstreamUrlTemplate, `${layer.id} template`).toMatch(/\{z\}/);
			expect(layer.upstreamUrlTemplate).toMatch(/\{x\}/);
			expect(layer.upstreamUrlTemplate).toMatch(/\{y\}/);
		}
	});

	it('each atmospheric raster layer has a matching ATMOSPHERIC_CAPABILITIES row with the same maxNativeZoom', () => {
		const atm = LAYERS.filter((l) => l.group === 'atmospheric' && l.upstreamUrlTemplate !== undefined);
		for (const layer of atm) {
			const cap = capabilityFor(layer.id);
			expect(cap, `${layer.id} capability row`).toBeDefined();
			expect(cap!.maxNativeZoom, `${layer.id} cap maxNativeZoom`).toBe(layer.maxNativeZoom);
		}
	});

	it('atmospheric point layers carry attribution + pointSourceUrl', () => {
		const pts = LAYERS.filter((l) => l.group === 'atmospheric' && l.pointSourceUrl !== undefined);
		for (const layer of pts) {
			expect(layer.attribution?.length, `${layer.id} attribution`).toBeGreaterThan(0);
			expect(layer.pointSourceUrl, `${layer.id} pointSourceUrl`).toMatch(/^\//);
		}
	});

	it('isAtmosphericLayer narrows correctly for raster atmospheric layers only', () => {
		for (const layer of LAYERS) {
			const expected = layer.group === 'atmospheric' && typeof layer.upstreamUrlTemplate === 'string';
			expect(isAtmosphericLayer(layer), `${layer.id}`).toBe(expected);
		}
	});
});

describe('ATMOSPHERIC_CAPABILITIES — table invariants', () => {
	it('every row has a positive maxNativeZoom, a known dateCadence, and a publicationLagHours in [0, 24]', () => {
		for (const [id, cap] of Object.entries(ATMOSPHERIC_CAPABILITIES)) {
			expect(cap.maxNativeZoom, `${id} maxNativeZoom`).toBeGreaterThan(0);
			expect(['daily', 'static']).toContain(cap.dateCadence);
			expect(cap.publicationLagHours, `${id} lag`).toBeGreaterThanOrEqual(0);
			expect(cap.publicationLagHours, `${id} lag`).toBeLessThanOrEqual(24);
		}
	});

	it('every capability row corresponds to an atmospheric layer in LAYERS', () => {
		const atmIds = new Set(LAYERS.filter((l) => l.group === 'atmospheric').map((l) => l.id));
		for (const id of Object.keys(ATMOSPHERIC_CAPABILITIES)) {
			expect(atmIds, `capability ${id} → LAYERS`).toContain(id);
		}
	});
});

describe('atmospheric capability helpers', () => {
	const dailyCap: AtmosphericCapability = { maxNativeZoom: 9, dateCadence: 'daily', publicationLagHours: 6 };
	const staticCap: AtmosphericCapability = { maxNativeZoom: 9, dateCadence: 'static', publicationLagHours: 0 };

	it('defaultTimeForCapability returns "default" for static cadence', () => {
		expect(defaultTimeForCapability(staticCap)).toBe('default');
	});

	it('defaultTimeForCapability picks today after publication, yesterday before it', () => {
		// Pin a deterministic clock: 2026-05-15T10:00:00Z, lag = 6h → past threshold → today.
		const afterLag = new Date(Date.UTC(2026, 4, 15, 10, 0, 0));
		expect(defaultTimeForCapability(dailyCap, afterLag)).toBe('2026-05-15');

		// 2026-05-15T03:00:00Z, lag = 6h → not yet past threshold → step back.
		const beforeLag = new Date(Date.UTC(2026, 4, 15, 3, 0, 0));
		expect(defaultTimeForCapability(dailyCap, beforeLag)).toBe('2026-05-14');
	});

	it('isImmutableTime is false for "default", true for dates older than 48h', () => {
		const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
		expect(isImmutableTime('default', now)).toBe(false);
		expect(isImmutableTime('2026-05-12', now)).toBe(true); // 3 days back
		expect(isImmutableTime('2026-05-14', now)).toBe(false); // 1 day back
		expect(isImmutableTime('not-a-date', now)).toBe(false);
	});

	it('expandAtmosphericUrl substitutes every slot, including repeated {z}', () => {
		const template = 'https://example/{z}/{x}/{y}-{z}.png?d={TIME}';
		expect(expandAtmosphericUrl(template, 4, 5, 6, '2026-05-15')).toBe('https://example/4/5/6-4.png?d=2026-05-15');
	});
});

describe('rasterUrlTemplate', () => {
	it('emits the proxy path with the layer id encoded', () => {
		const url = rasterUrlTemplate('viirs_2019');
		expect(url).toContain('/api/raster?layer=viirs_2019');
		expect(url).toContain('z={z}');
		expect(url).toContain('x={x}');
		expect(url).toContain('y={y}');
	});

	it('tags atmospheric layers with kind=atmospheric so the SW buckets them correctly', () => {
		const atm = LAYERS.find((l) => l.group === 'atmospheric' && l.upstreamUrlTemplate !== undefined);
		expect(atm, 'expected at least one atmospheric raster layer').toBeDefined();
		expect(rasterUrlTemplate(atm!.id)).toContain('&kind=atmospheric');
	});

	it('does NOT tag non-atmospheric layers with kind=atmospheric', () => {
		expect(rasterUrlTemplate('viirs_2019')).not.toContain('kind=');
		expect(rasterUrlTemplate('world_atlas_2015')).not.toContain('kind=');
	});
});
