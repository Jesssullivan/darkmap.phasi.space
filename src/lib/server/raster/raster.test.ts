import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { sanitizeHeaders } from './AdStripper';
import { RasterCache, RasterCacheLive } from './Cache';
import { RasterClient, RasterError, makeRasterClientStub, type RasterQuery, type RasterResponse } from './RasterClient';

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

describe('RasterCache', () => {
	const sample: RasterResponse = {
		contentType: 'image/png',
		body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	};
	const q: RasterQuery = { layer: 'viirs_2021', qt: 'tile', qd: '1,2,3' };

	it('returns None before set and Some after', async () => {
		const program = Effect.gen(function* () {
			const cache = yield* RasterCache;
			const before = yield* cache.get(q);
			yield* cache.set(q, sample);
			const after = yield* cache.get(q);
			return { before, after };
		}).pipe(Effect.provide(RasterCacheLive));
		const { before, after } = await Effect.runPromise(program);
		expect(Option.isNone(before)).toBe(true);
		expect(Option.isSome(after)).toBe(true);
		if (Option.isSome(after)) expect(after.value.contentType).toBe('image/png');
	});

	it('keys distinctly by (layer, qt, qd)', async () => {
		const q2: RasterQuery = { ...q, qd: '9,9,9' };
		const program = Effect.gen(function* () {
			const cache = yield* RasterCache;
			yield* cache.set(q, sample);
			const a = yield* cache.get(q);
			const b = yield* cache.get(q2);
			return { a, b };
		}).pipe(Effect.provide(RasterCacheLive));
		const { a, b } = await Effect.runPromise(program);
		expect(Option.isSome(a)).toBe(true);
		expect(Option.isNone(b)).toBe(true);
	});
});

describe('RasterClient stub layer', () => {
	it('delegates query to caller-supplied function', async () => {
		const sample: RasterResponse = {
			contentType: 'image/png',
			body: new Uint8Array([1, 2, 3]),
		};
		const layer = makeRasterClientStub(() => Effect.succeed(sample));
		const program = Effect.gen(function* () {
			const client = yield* RasterClient;
			return yield* client.query({ layer: 'viirs_2017', qt: 'tile', qd: '0,0,0' });
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
			return yield* client.query({ layer: 'viirs_2017', qt: 'tile', qd: '0,0,0' });
		}).pipe(Effect.provide(layer));
		const exit = await Effect.runPromiseExit(program);
		expect(exit._tag).toBe('Failure');
	});
});
