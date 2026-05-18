import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Cheap liveness/readiness endpoint.
 *
 * Returns 200 + a small JSON body. Used by the deployment's
 * livenessProbe + readinessProbe instead of `/` so the kubelet
 * isn't rendering the SvelteKit homepage every 20 seconds, and
 * so HTML-200 from a broken raster proxy doesn't lull the probe
 * into a false-positive (a future ticket can add a separate
 * /readyz that pings upstream).
 *
 * Body shape is stable and machine-readable:
 *   { status: 'ok', timestamp: '<iso>', uptime_s: <number> }
 */
export const GET: RequestHandler = () => {
	return json(
		{
			status: 'ok',
			timestamp: new Date().toISOString(),
			uptime_s: Math.round(process.uptime()),
		},
		{
			headers: {
				'cache-control': 'no-store',
			},
		},
	);
};
