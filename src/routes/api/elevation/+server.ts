import type { RequestHandler } from './$types';

/**
 * Proxy AWS Mapzen Terrarium elevation tiles. Public S3 bucket, no
 * auth required. We proxy via this endpoint so the browser doesn't
 * eat a CORS preflight on every tile and so we can layer caching
 * later.
 *
 * Path: /api/elevation?z=<z>&x=<x>&y=<y>
 */
const UPSTREAM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

export const GET: RequestHandler = async ({ url, fetch }) => {
	const z = url.searchParams.get('z');
	const x = url.searchParams.get('x');
	const y = url.searchParams.get('y');
	if (!z || !x || !y || !/^\d+$/.test(z) || !/^-?\d+$/.test(x) || !/^-?\d+$/.test(y)) {
		return new Response('bad request: z, x, y required (integers)', { status: 400 });
	}
	const upstreamUrl = `${UPSTREAM}/${z}/${x}/${y}.png`;
	const res = await fetch(upstreamUrl);
	if (!res.ok) {
		return new Response(`upstream ${res.status}`, { status: res.status });
	}
	const buf = await res.arrayBuffer();
	return new Response(buf, {
		status: 200,
		headers: {
			'content-type': 'image/png',
			// Terrarium tiles never change; long-cache aggressively.
			'cache-control': 'public, max-age=86400, immutable',
		},
	});
};
