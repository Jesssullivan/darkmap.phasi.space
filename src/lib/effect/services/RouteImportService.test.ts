import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	RouteImportService,
	RouteImportServiceLive,
	ROUTE_IMPORT_MAX_BYTES,
	type RouteCollection,
} from './RouteImportService';

const runImport = (source: string, hint?: 'kml' | 'gpx' | 'geojson', name?: string) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* RouteImportService;
			return yield* svc.import({ source, hint, name });
		}).pipe(Effect.provide(RouteImportServiceLive)),
	);

const expectSuccess = <A>(exit: Exit.Exit<A, unknown>): A => {
	if (exit._tag !== 'Success') throw new Error(`expected Success, got Failure: ${JSON.stringify(exit)}`);
	return exit.value;
};

const expectFailReason = (exit: Exit.Exit<unknown, unknown>): string => {
	if (exit._tag !== 'Failure') throw new Error('expected Failure');
	const cause = exit.cause as { _tag?: string; error?: { reason?: string } };
	// Effect.fail wraps in a Cause; the error is reachable via reduce/squash.
	const err = (cause as unknown as { error?: { reason?: string } }).error;
	if (err?.reason) return err.reason;
	// Fallback: walk causes for first Fail.
	const json = JSON.stringify(exit);
	const match = /"reason":"([^"]+)"/.exec(json);
	if (!match) throw new Error(`no reason in cause: ${json}`);
	return match[1];
};

describe('RouteImportService — GeoJSON', () => {
	it('parses a LineString FeatureCollection', async () => {
		const source = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: { name: 'Loop' },
					geometry: {
						type: 'LineString',
						coordinates: [
							[-73.1, 44.2],
							[-73.0, 44.3],
							[-72.9, 44.4],
						],
					},
				},
			],
		});
		const exit = await runImport(source);
		const collection = expectSuccess(exit) as RouteCollection;
		expect(collection.source).toBe('geojson');
		expect(collection.features).toHaveLength(1);
		expect(collection.features[0].name).toBe('Loop');
		expect(collection.features[0].geometry).toEqual({
			kind: 'line',
			coordinates: [
				[-73.1, 44.2],
				[-73.0, 44.3],
				[-72.9, 44.4],
			],
		});
	});

	it('parses bare Feature with Point and preserves elevation', async () => {
		const source = JSON.stringify({
			type: 'Feature',
			properties: { name: 'Camp' },
			geometry: { type: 'Point', coordinates: [-73.5, 44.1, 1240] },
		});
		const exit = await runImport(source);
		const collection = expectSuccess(exit) as RouteCollection;
		expect(collection.features[0].geometry).toEqual({
			kind: 'point',
			coordinates: [-73.5, 44.1, 1240],
		});
	});

	it('expands MultiLineString into one feature per line', async () => {
		const source = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: { name: 'Day' },
					geometry: {
						type: 'MultiLineString',
						coordinates: [
							[
								[-73.1, 44.2],
								[-73.0, 44.3],
							],
							[
								[-72.9, 44.4],
								[-72.8, 44.5],
							],
						],
					},
				},
			],
		});
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.features).toHaveLength(2);
		expect(collection.features[0].name).toBe('Day #1');
		expect(collection.features[1].name).toBe('Day #2');
	});

	it('rejects invalid JSON with invalid-json', async () => {
		const exit = await runImport('{ not json');
		expect(expectFailReason(exit)).toBe('invalid-json');
	});

	it('rejects unsupported GeoJSON root', async () => {
		const exit = await runImport(JSON.stringify({ type: 'WeirdThing', coordinates: [] }));
		expect(['invalid-shape', 'empty-geometry']).toContain(expectFailReason(exit));
	});

	it('rejects empty feature collection with empty-geometry', async () => {
		const exit = await runImport(JSON.stringify({ type: 'FeatureCollection', features: [] }));
		expect(expectFailReason(exit)).toBe('empty-geometry');
	});
});

describe('RouteImportService — GPX', () => {
	it('parses a single-segment track', async () => {
		const source = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <name>Mt. Marcy</name>
    <trkseg>
      <trkpt lat="44.112" lon="-73.923"><ele>1500</ele></trkpt>
      <trkpt lat="44.113" lon="-73.924"><ele>1520</ele></trkpt>
      <trkpt lat="44.114" lon="-73.925"><ele>1540</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.source).toBe('gpx');
		expect(collection.features).toHaveLength(1);
		expect(collection.features[0].name).toBe('Mt. Marcy');
		expect(collection.features[0].geometry.kind).toBe('line');
		const line = collection.features[0].geometry as { kind: 'line'; coordinates: readonly (readonly number[])[] };
		expect(line.coordinates).toHaveLength(3);
		expect(line.coordinates[0]).toEqual([-73.923, 44.112, 1500]);
	});

	it('splits multi-segment tracks into separate features', async () => {
		const source = `<gpx>
  <trk><name>Two-day</name>
    <trkseg>
      <trkpt lat="44.1" lon="-73.9"/>
      <trkpt lat="44.2" lon="-73.8"/>
    </trkseg>
    <trkseg>
      <trkpt lat="44.3" lon="-73.7"/>
      <trkpt lat="44.4" lon="-73.6"/>
    </trkseg>
  </trk>
</gpx>`;
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.features).toHaveLength(2);
		expect(collection.features[0].name).toBe('Two-day #1');
		expect(collection.features[1].name).toBe('Two-day #2');
	});

	it('parses route + waypoint mix', async () => {
		const source = `<gpx>
  <wpt lat="44.0" lon="-73.0"><name>Trailhead</name><ele>500</ele></wpt>
  <rte><name>Approach</name>
    <rtept lat="44.05" lon="-73.05"/>
    <rtept lat="44.10" lon="-73.10"/>
  </rte>
</gpx>`;
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.features).toHaveLength(2);
		const point = collection.features.find((f) => f.geometry.kind === 'point');
		const line = collection.features.find((f) => f.geometry.kind === 'line');
		expect(point?.name).toBe('Trailhead');
		expect(line?.name).toBe('Approach');
	});

	it('rejects non-GPX XML as invalid-xml', async () => {
		const exit = await runImport('<?xml version="1.0"?><svg/>', 'gpx');
		expect(expectFailReason(exit)).toBe('invalid-xml');
	});

	it('rejects a GPX with no valid points as empty-geometry', async () => {
		const exit = await runImport('<gpx><trk><trkseg></trkseg></trk></gpx>');
		expect(expectFailReason(exit)).toBe('empty-geometry');
	});
});

describe('RouteImportService — KML', () => {
	it('parses a Placemark LineString', async () => {
		const source = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Loop</name>
      <LineString>
        <coordinates>
          -73.1,44.2,0 -73.0,44.3,0 -72.9,44.4,0
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.source).toBe('kml');
		expect(collection.features).toHaveLength(1);
		const geom = collection.features[0].geometry as { kind: 'line'; coordinates: readonly (readonly number[])[] };
		expect(geom.coordinates).toHaveLength(3);
		expect(geom.coordinates[0]).toEqual([-73.1, 44.2, 0]);
	});

	it('parses gx:Track coordinates', async () => {
		const source = `<kml><Placemark><name>Ride</name>
  <gx:Track>
    <gx:coord>-73.1 44.2 0</gx:coord>
    <gx:coord>-73.0 44.3 0</gx:coord>
    <gx:coord>-72.9 44.4 0</gx:coord>
  </gx:Track>
</Placemark></kml>`;
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.features).toHaveLength(1);
		expect(collection.features[0].geometry.kind).toBe('line');
	});

	it('treats a single-coordinate Placemark as a Point', async () => {
		const source = `<kml><Placemark><name>Camp</name>
  <Point><coordinates>-73.5,44.1</coordinates></Point>
</Placemark></kml>`;
		const collection = expectSuccess(await runImport(source)) as RouteCollection;
		expect(collection.features[0].geometry.kind).toBe('point');
	});
});

describe('RouteImportService — sniff + guardrails', () => {
	it('sniffs format from content when hint is omitted', async () => {
		const exit = await runImport('<gpx><wpt lat="1" lon="2"/></gpx>');
		expect(expectSuccess(exit).source).toBe('gpx');
	});

	it('returns unsupported-format for unknown bytes', async () => {
		const exit = await runImport('this is just text');
		expect(expectFailReason(exit)).toBe('unsupported-format');
	});

	it('returns oversize over the byte cap', async () => {
		const oversize = 'a'.repeat(ROUTE_IMPORT_MAX_BYTES + 1);
		const exit = await runImport(oversize, 'geojson');
		expect(expectFailReason(exit)).toBe('oversize');
	});

	it('preserves sourceName when provided', async () => {
		const exit = await runImport(
			JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }),
			'geojson',
			'camp.geojson',
		);
		expect(expectSuccess(exit).sourceName).toBe('camp.geojson');
	});
});
