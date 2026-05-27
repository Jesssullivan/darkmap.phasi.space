import { Context, Data, Effect, Layer } from 'effect';

/**
 * RouteImportService — parses user-supplied route files (KML, GPX, GeoJSON)
 * into a darkmap-internal `RouteFeature` model that the map layer can render
 * directly. Pure: caller hands in a string; no fetch, no DOM, no SW.
 *
 * Scope is the foundation layer for GH #104 (route import for cycling/hiking).
 * UI wiring (file picker, drop zone, MapLibre layer push) is deliberately
 * separate so the parsers can evolve under unit-test cover alone.
 *
 * Integration sketch for callers:
 *   const routes = await Effect.runPromise(
 *     Effect.gen(function* () {
 *       const svc = yield* RouteImportService;
 *       return yield* svc.import({ source, hint: 'gpx', name: file.name });
 *     }).pipe(Effect.provide(RouteImportServiceLive)),
 *   );
 */

/** Geometry kinds darkmap cares about. Polygons are out of scope today. */
export type RouteGeometry =
	| { readonly kind: 'point'; readonly coordinates: readonly [number, number, number?] }
	| { readonly kind: 'line'; readonly coordinates: readonly (readonly [number, number, number?])[] };

export interface RouteFeature {
	readonly name?: string;
	readonly geometry: RouteGeometry;
}

export interface RouteCollection {
	readonly source: 'kml' | 'gpx' | 'geojson';
	readonly sourceName?: string;
	readonly features: readonly RouteFeature[];
}

export interface RouteImportInput {
	readonly source: string;
	/** Optional explicit format. When omitted, content sniffing is used. */
	readonly hint?: 'kml' | 'gpx' | 'geojson';
	/** Original filename, preserved for the resulting collection's label. */
	readonly name?: string;
}

export type RouteParseReason =
	| 'unsupported-format'
	| 'invalid-xml'
	| 'invalid-json'
	| 'invalid-shape'
	| 'empty-geometry'
	| 'oversize';

export class RouteParseError extends Data.TaggedError('RouteParseError')<{
	readonly reason: RouteParseReason;
	readonly detail?: string;
}> {}

/**
 * Soft cap on input size. Field GPX traces from a long ride sit comfortably
 * under 5 MiB; anything larger almost certainly wants tiling or simplification
 * before render.
 */
export const ROUTE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export class RouteImportService extends Context.Tag('@darkmap/RouteImportService')<
	RouteImportService,
	{
		readonly import: (input: RouteImportInput) => Effect.Effect<RouteCollection, RouteParseError>;
	}
>() {}

/* ----------------------------- format sniff ----------------------------- */

const sniffFormat = (s: string): 'kml' | 'gpx' | 'geojson' | null => {
	const head = s.slice(0, 1024).trimStart();
	if (head.startsWith('{') || head.startsWith('[')) return 'geojson';
	if (/<gpx[\s>]/i.test(head)) return 'gpx';
	if (/<kml[\s>]/i.test(head)) return 'kml';
	if (/<\?xml/i.test(head)) {
		// XML without a clear gpx/kml root — try both bodies later.
		if (/<gpx[\s>]/i.test(s)) return 'gpx';
		if (/<kml[\s>]/i.test(s)) return 'kml';
	}
	return null;
};

/* --------------------------------- KML --------------------------------- */

/**
 * KML parser. Extracts `<Placemark>` blocks with a `<name>` and a single
 * geometry from `<Point>` / `<LineString>` / `<gx:Track>` `<coordinates>`.
 * Skips MultiGeometry and Polygons — they're not on the darkmap route layer.
 */
const parseKml = (source: string): readonly RouteFeature[] => {
	const features: RouteFeature[] = [];
	const placemarkRe = /<Placemark\b[\s\S]*?<\/Placemark>/gi;
	for (const match of source.matchAll(placemarkRe)) {
		const block = match[0];
		const name = /<name>\s*([\s\S]*?)\s*<\/name>/i.exec(block)?.[1]?.trim();

		// Track point lists used by Google Earth's gx:Track come in repeated
		// <gx:coord>lon lat alt</gx:coord> elements rather than <coordinates>.
		const gxCoords = [...block.matchAll(/<gx:coord>\s*([^<]+?)\s*<\/gx:coord>/gi)];
		if (gxCoords.length >= 2) {
			const coords = gxCoords
				.map((m) => parseCoord(m[1], ' '))
				.filter((c): c is [number, number, number?] => c !== null);
			if (coords.length >= 2) {
				features.push({
					name,
					geometry: { kind: 'line', coordinates: coords },
				});
				continue;
			}
		}

		const coordsBlock = /<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i.exec(block)?.[1];
		if (!coordsBlock) continue;
		const tuples = coordsBlock
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => parseCoord(t, ','))
			.filter((c): c is [number, number, number?] => c !== null);
		if (tuples.length === 0) continue;
		if (tuples.length === 1) {
			features.push({ name, geometry: { kind: 'point', coordinates: tuples[0] } });
		} else {
			features.push({ name, geometry: { kind: 'line', coordinates: tuples } });
		}
	}
	return features;
};

/* --------------------------------- GPX --------------------------------- */

/**
 * GPX parser. Pulls `<trk>` / `<rte>` line geometries and `<wpt>` points.
 * Each `<trkseg>` becomes its own line feature so multi-segment tracks
 * don't visually splice across gaps.
 */
const parseGpx = (source: string): readonly RouteFeature[] => {
	const features: RouteFeature[] = [];

	const trkRe = /<trk\b[\s\S]*?<\/trk>/gi;
	for (const m of source.matchAll(trkRe)) {
		const trk = m[0];
		const baseName = /<name>\s*([\s\S]*?)\s*<\/name>/i.exec(trk)?.[1]?.trim();
		const segs = [...trk.matchAll(/<trkseg\b[\s\S]*?<\/trkseg>/gi)];
		segs.forEach((segMatch, i) => {
			const coords = extractLatLonElPoints(segMatch[0], /trkpt/);
			if (coords.length < 2) return;
			features.push({
				name: segs.length > 1 ? `${baseName ?? 'track'} #${i + 1}` : baseName,
				geometry: { kind: 'line', coordinates: coords },
			});
		});
	}

	const rteRe = /<rte\b[\s\S]*?<\/rte>/gi;
	for (const m of source.matchAll(rteRe)) {
		const rte = m[0];
		const name = /<name>\s*([\s\S]*?)\s*<\/name>/i.exec(rte)?.[1]?.trim();
		const coords = extractLatLonElPoints(rte, /rtept/);
		if (coords.length < 2) continue;
		features.push({ name, geometry: { kind: 'line', coordinates: coords } });
	}

	const wptRe = /<wpt\b([^>]*)(?:\/>|>([\s\S]*?)<\/wpt>)/gi;
	for (const m of source.matchAll(wptRe)) {
		const attrs = m[1];
		const body = m[2] ?? '';
		const lat = Number(/lat="([^"]+)"/i.exec(attrs)?.[1]);
		const lon = Number(/lon="([^"]+)"/i.exec(attrs)?.[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		const ele = Number(/<ele>\s*([\d.+\-eE]+)\s*<\/ele>/i.exec(body)?.[1]);
		const name = /<name>\s*([\s\S]*?)\s*<\/name>/i.exec(body)?.[1]?.trim();
		const coord: [number, number, number?] = Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
		features.push({ name, geometry: { kind: 'point', coordinates: coord } });
	}

	return features;
};

const extractLatLonElPoints = (block: string, tag: RegExp): [number, number, number?][] => {
	const re = new RegExp(`<${tag.source}\\b([^>]*)(?:/>|>([\\s\\S]*?)</${tag.source}>)`, 'gi');
	const out: [number, number, number?][] = [];
	for (const m of block.matchAll(re)) {
		const lat = Number(/lat="([^"]+)"/i.exec(m[1])?.[1]);
		const lon = Number(/lon="([^"]+)"/i.exec(m[1])?.[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		const body = m[2] ?? '';
		const ele = Number(/<ele>\s*([\d.+\-eE]+)\s*<\/ele>/i.exec(body)?.[1]);
		out.push(Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat]);
	}
	return out;
};

/* ------------------------------- GeoJSON ------------------------------- */

const parseGeoJsonShape = (raw: unknown): readonly RouteFeature[] => {
	if (!raw || typeof raw !== 'object') throw new Error('not an object');
	const obj = raw as Record<string, unknown>;
	const features: RouteFeature[] = [];
	const collect = (feature: Record<string, unknown>) => {
		const geom = feature.geometry as { type?: string; coordinates?: unknown } | undefined;
		if (!geom) return;
		const name = ((feature.properties as Record<string, unknown> | undefined)?.name ?? undefined) as string | undefined;
		switch (geom.type) {
			case 'Point': {
				const c = toTuple(geom.coordinates);
				if (c) features.push({ name, geometry: { kind: 'point', coordinates: c } });
				return;
			}
			case 'LineString': {
				const coords = toTupleList(geom.coordinates);
				if (coords.length >= 2) features.push({ name, geometry: { kind: 'line', coordinates: coords } });
				return;
			}
			case 'MultiLineString': {
				const groups = Array.isArray(geom.coordinates) ? (geom.coordinates as unknown[]) : [];
				groups.forEach((line, i) => {
					const coords = toTupleList(line);
					if (coords.length >= 2)
						features.push({
							name: name ? `${name} #${i + 1}` : undefined,
							geometry: { kind: 'line', coordinates: coords },
						});
				});
				return;
			}
			case 'MultiPoint': {
				const points = Array.isArray(geom.coordinates) ? (geom.coordinates as unknown[]) : [];
				points.forEach((p) => {
					const c = toTuple(p);
					if (c) features.push({ name, geometry: { kind: 'point', coordinates: c } });
				});
				return;
			}
		}
	};

	if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
		for (const f of obj.features as unknown[]) {
			if (f && typeof f === 'object') collect(f as Record<string, unknown>);
		}
	} else if (obj.type === 'Feature') {
		collect(obj);
	} else if (typeof obj.type === 'string') {
		// Bare geometry object — wrap so collect() can read it.
		collect({ geometry: obj });
	} else {
		throw new Error('unsupported GeoJSON root');
	}

	return features;
};

const toTuple = (raw: unknown): [number, number, number?] | null => {
	if (!Array.isArray(raw) || raw.length < 2) return null;
	const lon = Number(raw[0]);
	const lat = Number(raw[1]);
	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
	if (raw.length >= 3) {
		const ele = Number(raw[2]);
		if (Number.isFinite(ele)) return [lon, lat, ele];
	}
	return [lon, lat];
};

const toTupleList = (raw: unknown): [number, number, number?][] => {
	if (!Array.isArray(raw)) return [];
	const out: [number, number, number?][] = [];
	for (const p of raw) {
		const t = toTuple(p);
		if (t) out.push(t);
	}
	return out;
};

/* ------------------------------- helpers ------------------------------- */

const parseCoord = (raw: string, sep: ',' | ' '): [number, number, number?] | null => {
	const parts = raw.split(sep === ',' ? /\s*,\s*/ : /\s+/);
	if (parts.length < 2) return null;
	const lon = Number(parts[0]);
	const lat = Number(parts[1]);
	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
	if (parts.length >= 3) {
		const ele = Number(parts[2]);
		if (Number.isFinite(ele)) return [lon, lat, ele];
	}
	return [lon, lat];
};

const byteSize = (s: string): number => {
	if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
	return new TextEncoder().encode(s).length;
};

/* -------------------------------- Live --------------------------------- */

export const RouteImportServiceLive = Layer.succeed(
	RouteImportService,
	RouteImportService.of({
		import: (input) =>
			Effect.gen(function* () {
				if (byteSize(input.source) > ROUTE_IMPORT_MAX_BYTES) {
					return yield* Effect.fail(new RouteParseError({ reason: 'oversize' }));
				}
				const format = input.hint ?? sniffFormat(input.source);
				if (!format) {
					return yield* Effect.fail(new RouteParseError({ reason: 'unsupported-format' }));
				}

				let features: readonly RouteFeature[];
				if (format === 'geojson') {
					let parsed: unknown;
					try {
						parsed = JSON.parse(input.source);
					} catch (cause) {
						return yield* Effect.fail(
							new RouteParseError({ reason: 'invalid-json', detail: (cause as Error).message }),
						);
					}
					try {
						features = parseGeoJsonShape(parsed);
					} catch (cause) {
						return yield* Effect.fail(
							new RouteParseError({ reason: 'invalid-shape', detail: (cause as Error).message }),
						);
					}
				} else if (format === 'kml') {
					if (!/<kml[\s>]/i.test(input.source) && !/<Placemark\b/i.test(input.source)) {
						return yield* Effect.fail(new RouteParseError({ reason: 'invalid-xml' }));
					}
					features = parseKml(input.source);
				} else {
					if (!/<gpx[\s>]/i.test(input.source) && !/<(trkpt|rtept|wpt)\b/i.test(input.source)) {
						return yield* Effect.fail(new RouteParseError({ reason: 'invalid-xml' }));
					}
					features = parseGpx(input.source);
				}

				if (features.length === 0) {
					return yield* Effect.fail(new RouteParseError({ reason: 'empty-geometry' }));
				}
				return { source: format, sourceName: input.name, features };
			}),
	}),
);
