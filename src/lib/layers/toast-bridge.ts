/**
 * Layer-error → toast bridge (#236, child of #196).
 *
 * Before this module, MapLibre `error` events called `pushToast` inline
 * with the raw upstream message ("Failed to fetch", "HTTP 502", etc).
 * That violates #196's "Refactorable Seams" clause — UI text per layer
 * lived in Svelte markup, the toast queue had no debounce, and a burst
 * of tile errors from a single source could spam half the rail.
 *
 * The bridge is two pure pieces + one stateful debouncer:
 *
 *   - `reasonForLayer({ layerId, status, message })` — data-driven
 *     reason table keyed on (layerId-group × status × message-shape).
 *     Returns a short, user-readable explanation.
 *   - `buildToast({ layerId, status, message })` — composes the full
 *     toast payload (text + source) without touching DOM or Svelte.
 *   - `LayerErrorDebouncer` — coalesces repeated errors for the same
 *     `layerId` within a window so a 502 burst becomes one toast.
 */

import { BASEMAPS } from '$lib/basemaps';
import { LAYERS } from '$lib/layers';

export interface LayerErrorInput {
	readonly layerId: string;
	readonly status?: number;
	readonly message?: string;
}

export interface LayerToastPayload {
	readonly text: string;
	readonly source: string;
}

const labelForLayerId = (id: string): string => {
	const layer = LAYERS.find((l) => l.id === id);
	if (layer) return layer.label;
	const bm = BASEMAPS.find((b) => b.id === id);
	if (bm) return `${bm.label} basemap`;
	return id;
};

/**
 * Map a (layerId, status, message) tuple to a user-readable reason.
 * Data-driven so the toast text cannot drift across Svelte components.
 *
 * Decision order:
 *
 *   1. Known upstream-failure messages (CORS, network, abort) get
 *      explicit explanations.
 *   2. Status codes drive everything else:
 *        - 502/503/504 → "upstream temporarily unavailable"
 *        - 401/403     → "credentials missing or expired"
 *        - 404          → "no tile for this view"
 *        - 429          → "rate-limited"
 *        - 5xx (other)  → "upstream error"
 *        - 4xx (other)  → "bad request"
 *   3. Fallback when there's no status and no recognizable message →
 *      "tile load failed".
 */
export const reasonForLayer = (input: LayerErrorInput): string => {
	const msg = input.message?.toLowerCase() ?? '';
	if (msg.includes('aborted') || msg.includes('abort')) return 'request aborted (probably a rapid pan)';
	if (msg.includes('cors')) return 'upstream blocked by CORS — check the proxy';
	if (msg.includes('network')) return 'network unreachable; tiles cannot be fetched';
	if (msg.includes('econnref') || msg.includes('connection refused')) return 'upstream connection refused';

	const status = input.status ?? 0;
	if (status === 502 || status === 503 || status === 504) return 'upstream temporarily unavailable';
	if (status === 401 || status === 403) return 'credentials missing or expired';
	if (status === 404) return 'no tile for this view';
	if (status === 429) return 'upstream rate-limited; backing off';
	if (status >= 500 && status < 600) return `upstream error ${status}`;
	if (status >= 400 && status < 500) return `bad request ${status}`;

	return 'tile load failed';
};

/** Compose the full toast payload (text + source). */
export const buildToast = (input: LayerErrorInput): LayerToastPayload => {
	const label = labelForLayerId(input.layerId);
	const reason = reasonForLayer(input);
	return { text: `${label}: ${reason}`, source: input.layerId };
};

/* ----------------------------- debouncer ----------------------------- */

/**
 * Coalesce repeated errors for the same `layerId` within `windowMs` into
 * a single emit. The most recent input wins (e.g. an updated status
 * supersedes the earlier one).
 *
 * Stateful but framework-free — uses `setTimeout` so callers can swap in
 * a fake timer in tests via `vi.useFakeTimers()`.
 */
export interface LayerErrorDebouncerOptions {
	readonly windowMs?: number;
}

export class LayerErrorDebouncer {
	private pending = new Map<string, { input: LayerErrorInput; timer: ReturnType<typeof setTimeout> }>();
	private readonly emit: (payload: LayerToastPayload) => void;
	private readonly windowMs: number;

	constructor(emit: (payload: LayerToastPayload) => void, opts: LayerErrorDebouncerOptions = {}) {
		this.emit = emit;
		this.windowMs = opts.windowMs ?? 500;
	}

	/** Enqueue an error; the bridge flushes one toast per layerId per window. */
	enqueue(input: LayerErrorInput): void {
		const prior = this.pending.get(input.layerId);
		if (prior) clearTimeout(prior.timer);
		const timer = setTimeout(() => {
			const cur = this.pending.get(input.layerId);
			if (!cur) return;
			this.pending.delete(input.layerId);
			this.emit(buildToast(cur.input));
		}, this.windowMs);
		this.pending.set(input.layerId, { input, timer });
	}

	/** Cancel a pending flush for a specific layerId (e.g. layer just rendered ok). */
	cancel(layerId: string): void {
		const cur = this.pending.get(layerId);
		if (!cur) return;
		clearTimeout(cur.timer);
		this.pending.delete(layerId);
	}

	/** Cancel every pending flush. Use on component teardown. */
	dispose(): void {
		for (const { timer } of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
	}
}
