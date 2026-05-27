import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	detectRouteImportFormat,
	parseRouteImport,
	RouteImportError,
	RouteImportService,
	RouteImportServiceLive,
} from './RouteImportService';

const runParse = (body: string, sourceName: string, contentType?: string) =>
	Effect.runPromise(parseRouteImport({ body, sourceName, contentType }));

describe('RouteImportService', () => {
	it('detects GeoJSON, GPX, and KML inputs', () => {
		expect(detectRouteImportFormat({ body: '{}', sourceName: 'ride.geojson' })).toBe('geojson');
		expect(detectRouteImportFormat({ body: '<gpx></gpx>', sourceName: 'ride.txt' })).toBe('gpx');
		expect(detectRouteImportFormat({ body: '<kml></kml>', sourceName: 'ride.txt' })).toBe('kml');
	});

	it('parses GeoJSON line segments and waypoint features', async () => {
		const route = await runParse(
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: { name: 'Ithaca loop' },
						geometry: {
							type: 'LineString',
							coordinates: [
								[-76.501, 42.443, 120],
								[-76.49, 42.45, 130],
							],
						},
					},
					{
						type: 'Feature',
						properties: { name: 'Water stop' },
						geometry: { type: 'Point', coordinates: [-76.495, 42.447] },
					},
				],
			}),
			'ithaca.geojson',
		);

		expect(route.format).toBe('geojson');
		expect(route.name).toBe('Ithaca loop');
		expect(route.segments).toHaveLength(1);
		expect(route.waypoints).toMatchObject([{ name: 'Water stop', lat: 42.447, lon: -76.495 }]);
		expect(route.bounds).toEqual({ minLat: 42.443, minLon: -76.501, maxLat: 42.45, maxLon: -76.49 });
		expect(route.distanceM).toBeGreaterThan(1_000);
	});

	it('parses GPX tracks, routes, and self-closing waypoints', async () => {
		const route = await runParse(
			`<?xml version="1.0"?>
			<gpx>
				<metadata><name>Cascadilla ride</name></metadata>
				<wpt lat="42.441" lon="-76.498" />
				<trk><name>Morning track</name><trkseg>
					<trkpt lat="42.443" lon="-76.501"><ele>120</ele></trkpt>
					<trkpt lat="42.45" lon="-76.49"><ele>130</ele></trkpt>
				</trkseg></trk>
				<rte><rtept lat="42.451" lon="-76.489" /></rte>
			</gpx>`,
			'cascadilla.gpx',
		);

		expect(route.format).toBe('gpx');
		expect(route.name).toBe('Cascadilla ride');
		expect(route.segments).toHaveLength(2);
		expect(route.waypoints).toMatchObject([{ lat: 42.441, lon: -76.498 }]);
		expect(route.pointCount).toBe(4);
	});

	it('parses KML coordinate blocks into segments and waypoints', async () => {
		const route = await runParse(
			`<kml><Document><name>Ridge &amp; lake</name>
				<Placemark><LineString><coordinates>
					-76.501,42.443,120 -76.49,42.45,130
				</coordinates></LineString></Placemark>
				<Placemark><Point><coordinates>-76.495,42.447,0</coordinates></Point></Placemark>
			</Document></kml>`,
			'ridge.kml',
		);

		expect(route.format).toBe('kml');
		expect(route.name).toBe('Ridge & lake');
		expect(route.segments[0].points[0]).toMatchObject({ lat: 42.443, lon: -76.501, eleM: 120 });
		expect(route.waypoints).toMatchObject([{ lat: 42.447, lon: -76.495, eleM: 0 }]);
	});

	it('fails closed for oversized and unsupported inputs', async () => {
		const tooLarge = await Effect.runPromiseExit(
			parseRouteImport({ body: '{"type":"Point","coordinates":[0,0]}', sourceName: 'x.geojson', maxBytes: 4 }),
		);
		expect(tooLarge._tag).toBe('Failure');

		const unsupported = await Effect.runPromiseExit(parseRouteImport({ body: 'hello', sourceName: 'notes.txt' }));
		expect(unsupported._tag).toBe('Failure');
	});

	it('can be provided as an Effect service layer', async () => {
		const program = Effect.flatMap(RouteImportService, (service) =>
			service.parse({ body: '{"type":"Point","coordinates":[-76.5,42.4]}', sourceName: 'pin.geojson' }),
		).pipe(Effect.provide(RouteImportServiceLive));

		await expect(Effect.runPromise(program)).resolves.toMatchObject({ format: 'geojson', pointCount: 1 });
	});

	it('surfaces invalid coordinates as RouteImportError values', async () => {
		await expect(
			Effect.runPromise(
				Effect.flip(
					parseRouteImport({ body: '{"type":"Point","coordinates":[-181,42.4]}', sourceName: 'bad.geojson' }),
				),
			),
		).resolves.toMatchObject({ reason: 'invalid-coordinate' });

		const exit = await Effect.runPromiseExit(
			parseRouteImport({ body: '{"type":"Point","coordinates":[-181,42.4]}', sourceName: 'bad.geojson' }),
		);
		expect(exit._tag).toBe('Failure');
		expect(new RouteImportError({ reason: 'empty', message: 'x' })).toBeInstanceOf(Error);
	});
});
