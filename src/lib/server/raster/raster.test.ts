import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { sanitizeHeaders } from './AdStripper';
import { RasterCache, RasterCacheLive } from './Cache';
import {
	RasterClient,
	RasterError,
	makeRasterClientStub,
	type RasterResponse,
	type RasterTileRequest,
} from './RasterClient';
import { bboxParam, parseTileCoord, tileBBox3857 } from './TileMath';

describe('sanitizeHeaders', () => {
	it('strips Set-Cookie and ad headers', () => {
		const input = new Headers({
			'content-type': 'image/png',
			'set-cookie': 'sid=abc; HttpOnly',
			'x-prebid-version': '7.42',
			'x-googletag-source': 'gpt',
			'x-ad-network': 'doubleclick',
		});
		const out = sanitizeHeaders(input);
		expect(out.get('content-type')).toBe('image/png');
		expect(out.get('set-cookie')).toBeNull();
		expect(out.get('x-prebid-version')).toBeNull();
		expect(out.get('x-googletag-source')).toBeNull();
		expect(out.get('x-ad-network')).toBeNull();
	});

	it('strips server-timing and x-powered-by', () => {
		const input = new Headers({
			'server-timing': 'cf-cache;dur=12',
			'x-powered-by': 'Express',
			'x-custom-ok': 'keep-me',
		});
		const out = sanitizeHeaders(input);
		expect(out.get('server-timing')).toBeNull();
		expect(out.get('x-powered-by')).toBeNull();
		expect(out.get('x-custom-ok')).toBe('keep-me');
	});
});

describe('TileMath', () => {
	it('z=0/x=0/y=0 is the whole world', () => {
		const bb = tileBBox3857({ z: 0, x: 0, y: 0 });
		expect(bb.minX).toBeCloseTo(-20037508.342789244, 5);
		expect(bb.maxX).toBeCloseTo(20037508.342789244, 5);
		expect(bb.minY).toBeCloseTo(-20037508.342789244, 5);
		expect(bb.maxY).toBeCloseTo(20037508.342789244, 5);
	});

	it('z=1/x=0/y=0 is the NW quadrant', () => {
		const bb = tileBBox3857({ z: 1, x: 0, y: 0 });
		expect(bb.minX).toBeCloseTo(-20037508.342789244, 5);
		expect(bb.maxX).toBeCloseTo(0, 5);
		expect(bb.minY).toBeCloseTo(0, 5);
		expect(bb.maxY).toBeCloseTo(20037508.342789244, 5);
	});

	it('bboxParam serializes minX,minY,maxX,maxY', () => {
		expect(bboxParam({ minX: -1, minY: -2, maxX: 3, maxY: 4 })).toBe('-1,-2,3,4');
	});

	it('parseTileCoord rejects out-of-range', () => {
		expect(() => parseTileCoord('1', '2', '0')).toThrow();
		expect(() => parseTileCoord('foo', '0', '0')).toThrow();
		expect(() => parseTileCoord('99', '0', '0')).toThrow();
	});

	it('parseTileCoord accepts valid coords', () => {
		const t = parseTileCoord('8', '74', '96');
		expect(t).toEqual({ z: 8, x: 74, y: 96 });
	});
});

describe('RasterCache', () => {
	const sample: RasterResponse = {
		contentType: 'image/png',
		body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	};
	const req: RasterTileRequest = {
		upstreamLayer: 'PostGIS:VIIRS_2019',
		tile: { z: 8, x: 74, y: 96 },
	};

	it('returns None before set and Some after', async () => {
		const program = Effect.gen(function* () {
			const cache = yield* RasterCache;
			const before = yield* cache.get(req);
			yield* cache.set(req, sample);
			const after = yield* cache.get(req);
			return { before, after };
		}).pipe(Effect.provide(RasterCacheLive));
		const { before, after } = await Effect.runPromise(program);
		expect(Option.isNone(before)).toBe(true);
		expect(Option.isSome(after)).toBe(true);
		if (Option.isSome(after)) expect(after.value.contentType).toBe('image/png');
	});

	it('keys distinctly by upstreamLayer and tile', async () => {
		const other: RasterTileRequest = { ...req, tile: { z: 8, x: 75, y: 96 } };
		const program = Effect.gen(function* () {
			const cache = yield* RasterCache;
			yield* cache.set(req, sample);
			const a = yield* cache.get(req);
			const b = yield* cache.get(other);
			return { a, b };
		}).pipe(Effect.provide(RasterCacheLive));
		const { a, b } = await Effect.runPromise(program);
		expect(Option.isSome(a)).toBe(true);
		expect(Option.isNone(b)).toBe(true);
	});
});

describe('RasterClient stub layer', () => {
	const req: RasterTileRequest = {
		upstreamLayer: 'PostGIS:VIIRS_2019',
		tile: { z: 8, x: 74, y: 96 },
	};

	it('delegates getTile to caller-supplied function', async () => {
		const sample: RasterResponse = {
			contentType: 'image/png',
			body: new Uint8Array([1, 2, 3]),
		};
		const layer = makeRasterClientStub(() => Effect.succeed(sample));
		const program = Effect.gen(function* () {
			const client = yield* RasterClient;
			return yield* client.getTile(req);
		}).pipe(Effect.provide(layer));
		const result = await Effect.runPromise(program);
		expect(result.contentType).toBe('image/png');
		expect(result.body.length).toBe(3);
	});

	it('propagates RasterError', async () => {
		const layer = makeRasterClientStub(() =>
			Effect.fail(new RasterError({ status: 503, upstream: 'https://example/' })),
		);
		const program = Effect.gen(function* () {
			const client = yield* RasterClient;
			return yield* client.getTile(req);
		}).pipe(Effect.provide(layer));
		const exit = await Effect.runPromiseExit(program);
		expect(exit._tag).toBe('Failure');
	});
});
