import { Context, Data, Effect, Layer } from 'effect';

export type RouteImportFormat = 'geojson' | 'gpx' | 'kml';

export interface RouteImportInput {
	readonly body: string;
	readonly sourceName: string;
	readonly contentType?: string;
	readonly maxBytes?: number;
}

export interface RoutePoint {
	readonly lat: number;
	readonly lon: number;
	readonly eleM?: number;
	readonly name?: string;
}

export interface RouteSegment {
	readonly name?: string;
	readonly points: readonly RoutePoint[];
}

export interface RouteBounds {
	readonly minLat: number;
	readonly minLon: number;
	readonly maxLat: number;
	readonly maxLon: number;
}

export interface ImportedRoute {
	readonly sourceName: string;
	readonly format: RouteImportFormat;
	readonly name: string;
	readonly segments: readonly RouteSegment[];
	readonly waypoints: readonly RoutePoint[];
	readonly bounds: RouteBounds;
	readonly distanceM: number;
	readonly pointCount: number;
}

export class RouteImportError extends Data.TaggedError('RouteImportError')<{
	readonly reason: 'empty' | 'too-large' | 'unsupported-format' | 'invalid-format' | 'invalid-coordinate';
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class RouteImportService extends Context.Tag('@darkmap/RouteImportService')<
	RouteImportService,
	{
		readonly parse: (input: RouteImportInput) => Effect.Effect<ImportedRoute, RouteImportError>;
	}
>() {}

const DEFAULT_MAX_BYTES = 2_000_000;
const EARTH_RADIUS_M = 6_371_000;

const fail = (reason: RouteImportError['reason'], message: string, cause?: unknown): never => {
	throw new RouteImportError({ reason, message, cause });
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const extensionFor = (sourceName: string): string | undefined => {
	const match = /\.([a-z0-9]+)$/i.exec(sourceName.trim());
	return match?.[1]?.toLowerCase();
};

export const detectRouteImportFormat = (input: RouteImportInput): RouteImportFormat => {
	const contentType = input.contentType?.toLowerCase() ?? '';
	const extension = extensionFor(input.sourceName);
	const body = input.body.trimStart();

	if (
		contentType.includes('geo+json') ||
		contentType.includes('json') ||
		extension === 'geojson' ||
		extension === 'json'
	) {
		return 'geojson';
	}
	if (
		contentType.includes('gpx') ||
		extension === 'gpx' ||
		/^<\?xml[\s\S]*?<gpx\b/i.test(body) ||
		/^<gpx\b/i.test(body)
	) {
		return 'gpx';
	}
	if (
		contentType.includes('kml') ||
		extension === 'kml' ||
		/^<\?xml[\s\S]*?<kml\b/i.test(body) ||
		/^<kml\b/i.test(body)
	) {
		return 'kml';
	}
	return fail('unsupported-format', `unsupported route import format for ${input.sourceName}`);
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const expectArray = (value: unknown, message: string): readonly unknown[] => {
	if (!Array.isArray(value)) return fail('invalid-coordinate', message);
	return value;
};

const expectRecord = (value: unknown, message: string): Record<string, unknown> => {
	if (!isRecord(value)) return fail('invalid-format', message);
	return value;
};

const pointFromLonLat = (lon: unknown, lat: unknown, ele?: unknown, name?: string): RoutePoint => {
	if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
		return fail('invalid-coordinate', 'route contains an invalid latitude or longitude');
	}
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
		return fail('invalid-coordinate', 'route contains an invalid latitude or longitude');
	}
	const point: RoutePoint = { lat, lon };
	if (isFiniteNumber(ele)) return { ...point, eleM: ele, name };
	return name ? { ...point, name } : point;
};

const numericTuplePoint = (coords: unknown, name?: string): RoutePoint => {
	const tuple = expectArray(coords, 'route coordinate is not an array');
	return pointFromLonLat(tuple[0], tuple[1], tuple[2], name);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const stringProperty = (value: unknown, key: string): string | undefined => {
	if (!isRecord(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
};

interface MutableRouteShape {
	name?: string;
	readonly segments: RouteSegment[];
	readonly waypoints: RoutePoint[];
}

const collectGeoJsonGeometry = (geometry: unknown, name: string | undefined, out: MutableRouteShape): void => {
	if (!isRecord(geometry)) return;
	const type = geometry.type;
	if (type === 'Point') {
		out.waypoints.push(numericTuplePoint(geometry.coordinates, name));
		return;
	}
	if (type === 'MultiPoint') {
		const coordinates = expectArray(geometry.coordinates, 'MultiPoint coordinates are invalid');
		out.waypoints.push(...coordinates.map((coords) => numericTuplePoint(coords, name)));
		return;
	}
	if (type === 'LineString') {
		const coordinates = expectArray(geometry.coordinates, 'LineString coordinates are invalid');
		out.segments.push({ name, points: coordinates.map((coords) => numericTuplePoint(coords)) });
		return;
	}
	if (type === 'MultiLineString') {
		const coordinates = expectArray(geometry.coordinates, 'MultiLineString coordinates are invalid');
		for (const line of coordinates) {
			const segment = expectArray(line, 'MultiLineString segment is invalid');
			out.segments.push({ name, points: segment.map((coords) => numericTuplePoint(coords)) });
		}
		return;
	}
	if (type === 'GeometryCollection') {
		const geometries = expectArray(geometry.geometries, 'GeometryCollection geometries are invalid');
		for (const child of geometries) collectGeoJsonGeometry(child, name, out);
	}
};

const collectGeoJson = (value: unknown, out: MutableRouteShape): void => {
	const record = expectRecord(value, 'GeoJSON root must be an object');
	const type = record.type;
	if (type === 'FeatureCollection') {
		const features = expectArray(record.features, 'GeoJSON FeatureCollection features are invalid');
		for (const feature of features) collectGeoJson(feature, out);
		return;
	}
	if (type === 'Feature') {
		const name = stringProperty(record.properties, 'name');
		if (name && !out.name) out.name = name;
		collectGeoJsonGeometry(record.geometry, name, out);
		return;
	}
	collectGeoJsonGeometry(record, undefined, out);
};

const parseGeoJson = (body: string): MutableRouteShape => {
	const out: MutableRouteShape = { segments: [], waypoints: [] };
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch (cause) {
		fail('invalid-format', 'GeoJSON could not be parsed', cause);
	}
	collectGeoJson(json, out);
	return out;
};

const decodeXmlText = (value: string): string =>
	value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');

const stripTags = (value: string): string => value.replace(/<[^>]+>/g, ' ');

const firstXmlText = (xml: string, tagName: string): string | undefined => {
	const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i').exec(xml);
	const text = match ? decodeXmlText(stripTags(match[1]).replace(/\s+/g, ' ').trim()) : '';
	return text || undefined;
};

const parseXmlAttributes = (value: string): Record<string, string> => {
	const attributes: Record<string, string> = {};
	const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	for (const match of value.matchAll(attrRe)) attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '');
	return attributes;
};

const numberFromXml = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
};

const parseGpxPoint = (attributes: string, body: string): RoutePoint => {
	const attrs = parseXmlAttributes(attributes);
	const name = firstXmlText(body, 'name');
	const ele = numberFromXml(firstXmlText(body, 'ele'));
	return pointFromLonLat(numberFromXml(attrs.lon), numberFromXml(attrs.lat), ele, name);
};

const parseGpxPoints = (xml: string, tagName: 'trkpt' | 'rtept' | 'wpt'): RoutePoint[] => {
	const points: RoutePoint[] = [];
	const tagRe = new RegExp(`<${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tagName}>)`, 'gi');
	for (const match of xml.matchAll(tagRe)) points.push(parseGpxPoint(match[1], match[2] ?? ''));
	return points;
};

const parseGpx = (body: string): MutableRouteShape => {
	const out: MutableRouteShape = {
		name: firstXmlText(body, 'name'),
		segments: [],
		waypoints: parseGpxPoints(body, 'wpt'),
	};
	const trkPoints = parseGpxPoints(body, 'trkpt');
	const rtePoints = parseGpxPoints(body, 'rtept');
	if (trkPoints.length > 0) out.segments.push({ name: out.name, points: trkPoints });
	if (rtePoints.length > 0) out.segments.push({ name: out.name, points: rtePoints });
	return out;
};

const parseKmlCoordinateTuple = (tuple: string): RoutePoint => {
	const [lon, lat, ele] = tuple.split(',').map((part) => Number(part.trim()));
	return pointFromLonLat(lon, lat, ele);
};

const parseKml = (body: string): MutableRouteShape => {
	const out: MutableRouteShape = { name: firstXmlText(body, 'name'), segments: [], waypoints: [] };
	const coordinatesRe = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/gi;
	for (const match of body.matchAll(coordinatesRe)) {
		const points = decodeXmlText(match[1]).trim().split(/\s+/).filter(Boolean).map(parseKmlCoordinateTuple);
		if (points.length === 1) out.waypoints.push(points[0]);
		if (points.length > 1) out.segments.push({ name: out.name, points });
	}
	return out;
};

const degToRad = (value: number): number => (value * Math.PI) / 180;

const distanceBetween = (a: RoutePoint, b: RoutePoint): number => {
	const dLat = degToRad(b.lat - a.lat);
	const dLon = degToRad(b.lon - a.lon);
	const lat1 = degToRad(a.lat);
	const lat2 = degToRad(b.lat);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

const distanceForSegment = (points: readonly RoutePoint[]): number =>
	points.slice(1).reduce((meters, point, index) => meters + distanceBetween(points[index], point), 0);

const boundsFor = (points: readonly RoutePoint[]): RouteBounds => {
	const first = points[0];
	return points.slice(1).reduce(
		(bounds, point) => ({
			minLat: Math.min(bounds.minLat, point.lat),
			minLon: Math.min(bounds.minLon, point.lon),
			maxLat: Math.max(bounds.maxLat, point.lat),
			maxLon: Math.max(bounds.maxLon, point.lon),
		}),
		{ minLat: first.lat, minLon: first.lon, maxLat: first.lat, maxLon: first.lon },
	);
};

const parseRouteInputSync = (input: RouteImportInput): ImportedRoute => {
	const trimmed = input.body.trim();
	if (!trimmed) fail('empty', 'route import is empty');
	if (byteLength(input.body) > (input.maxBytes ?? DEFAULT_MAX_BYTES)) {
		fail('too-large', `route import exceeds ${(input.maxBytes ?? DEFAULT_MAX_BYTES).toLocaleString()} bytes`);
	}
	const format = detectRouteImportFormat(input);
	const parsed =
		format === 'geojson' ? parseGeoJson(trimmed) : format === 'gpx' ? parseGpx(trimmed) : parseKml(trimmed);
	const allPoints = [...parsed.segments.flatMap((segment) => segment.points), ...parsed.waypoints];
	if (allPoints.length === 0) fail('empty', 'route import does not contain any supported route points');
	return {
		sourceName: input.sourceName,
		format,
		name: parsed.name ?? input.sourceName,
		segments: parsed.segments,
		waypoints: parsed.waypoints,
		bounds: boundsFor(allPoints),
		distanceM: parsed.segments.reduce((meters, segment) => meters + distanceForSegment(segment.points), 0),
		pointCount: allPoints.length,
	};
};

export const parseRouteImport = (input: RouteImportInput): Effect.Effect<ImportedRoute, RouteImportError> =>
	Effect.try({
		try: () => parseRouteInputSync(input),
		catch: (cause) =>
			cause instanceof RouteImportError
				? cause
				: new RouteImportError({ reason: 'invalid-format', message: 'route import could not be parsed', cause }),
	});

export const RouteImportServiceLive = Layer.succeed(
	RouteImportService,
	RouteImportService.of({
		parse: parseRouteImport,
	}),
);
