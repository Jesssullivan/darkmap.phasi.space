/**
 * Per-layer health-state model (#196). Pure reducer over the lifecycle
 * events any of our source-fetching seams can emit:
 *
 *   - MapLayerController `mount` / `unmount`
 *   - AtmosphericTileService outcomes via debug headers
 *   - OpenAQ proxy `degraded:true` responses
 *   - MapLibre `source.error` events
 *
 * Kept as a pure function so unit tests can sweep transitions exhaustively
 * without spinning up MapLibre or the Effect runtime.
 */

export type LayerHealthTag = 'idle' | 'loading' | 'rendered' | 'empty' | 'stale' | 'error';

export interface LayerHealth {
	readonly tag: LayerHealthTag;
	/** True when the most recent successful tile came from the SW or CDN cache. */
	readonly cached?: boolean;
	/** Optional human-readable reason — surfaced by the LayerRail pill on hover. */
	readonly reason?: string;
	/** Upstream HTTP status that caused an error state, if applicable. */
	readonly status?: number;
}

export const HEALTH_IDLE: LayerHealth = Object.freeze({ tag: 'idle' });

export type HealthEvent =
	| { readonly type: 'mount' }
	| { readonly type: 'tile-ok'; readonly cached?: boolean }
	| { readonly type: 'tile-empty'; readonly reason?: string }
	| { readonly type: 'tile-stale'; readonly reason?: string }
	| { readonly type: 'tile-error'; readonly reason: string; readonly status?: number }
	| { readonly type: 'tile-abort' }
	| { readonly type: 'unmount' };

/**
 * Transition rules:
 *
 *   - `mount` → `loading` (regardless of prior state).
 *   - `unmount` → `idle` (drops all observability for the layer).
 *   - `tile-ok` → `rendered` (with optional `cached` tag).
 *   - `tile-empty` → `empty` — the source legitimately has no data for the
 *     current viewport/time. Not an error; suppresses the error pill but
 *     surfaces a degraded badge.
 *   - `tile-stale` → `stale` (served from cache while upstream is failing).
 *   - `tile-error` → `error` (only when not already `rendered` — a single
 *     transient tile failure shouldn't downgrade a working overlay).
 *     If the layer is in `error` already, accumulates the new reason.
 *   - `tile-abort` → no-op (rapid pans cancel fetches; we don't want to
 *     show "error" for our own cancellations).
 */
export const reduceHealth = (state: LayerHealth, event: HealthEvent): LayerHealth => {
	switch (event.type) {
		case 'mount':
			return { tag: 'loading' };
		case 'unmount':
			return HEALTH_IDLE;
		case 'tile-abort':
			return state;
		case 'tile-ok':
			return event.cached === true ? { tag: 'rendered', cached: true } : { tag: 'rendered' };
		case 'tile-empty':
			return event.reason ? { tag: 'empty', reason: event.reason } : { tag: 'empty' };
		case 'tile-stale':
			return event.reason ? { tag: 'stale', reason: event.reason } : { tag: 'stale' };
		case 'tile-error':
			// Don't downgrade a rendered layer on a single transient error.
			if (state.tag === 'rendered') return state;
			return { tag: 'error', reason: event.reason, status: event.status };
	}
};

/** Short label for the LayerRail pill UI. Empty for `idle`. */
export const healthLabel = (h: LayerHealth): string => {
	switch (h.tag) {
		case 'idle':
			return '';
		case 'loading':
			return 'loading';
		case 'rendered':
			return h.cached ? 'cached' : 'live';
		case 'empty':
			return 'no data';
		case 'stale':
			return 'stale';
		case 'error':
			return h.status ? `error ${h.status}` : 'error';
	}
};

/** CSS color category for the pill — matches the existing rail palette. */
export const healthTone = (h: LayerHealth): 'neutral' | 'good' | 'warn' | 'bad' => {
	switch (h.tag) {
		case 'idle':
		case 'loading':
			return 'neutral';
		case 'rendered':
			return 'good';
		case 'empty':
		case 'stale':
			return 'warn';
		case 'error':
			return 'bad';
	}
};
