/**
 * Cache-state badge derivation (#233, child of #195).
 *
 * Field users need to glance at the map and tell whether a given
 * overlay is showing fresh data, cached data, stale data, or nothing
 * at all. The bottom rail in `EphemerisGantt.svelte` already grew a
 * one-off `RangeBadge` for the twilight viewport-summary; this module
 * generalizes the same idea into a reusable contract so every overlay
 * surface — LayerRail health pills, future per-overlay chips, the
 * cache inspector — can share one taxonomy and one set of strings.
 *
 * Pure derivation: take `online`, a `CacheBadgeKind`, and (when
 * relevant) an `ageMs` timestamp; return a `CacheBadgeView` the UI
 * renders verbatim. Behavior is unit-testable against the full
 * `online × kind` matrix without instantiating Svelte.
 */

export type CacheBadgeKind =
	/** Data was just computed/fetched and is current. */
	| 'live'
	/** Data came from the local cache; expected normal cache hit. */
	| 'cached'
	/** Cache hit, but the fresh fetch failed; user is seeing a stale copy. */
	| 'stale'
	/** Fetch in flight; nothing shown yet (or showing previous). */
	| 'loading'
	/** Fetch failed; no usable data shown. */
	| 'error'
	/** Fetch succeeded; upstream said "no data for this query". */
	| 'empty';

/** Skeleton-pill color tone. Mirrors the existing `.cache-pill` tone classes. */
export type CacheBadgeTone = 'live' | 'cached' | 'stale' | 'loading' | 'error' | 'empty';

export interface CacheBadgeView {
	readonly label: string;
	readonly tone: CacheBadgeTone;
	readonly detail: string;
}

export interface CacheBadgeInputs {
	readonly online: boolean;
	readonly kind: CacheBadgeKind;
	/** Wall-clock the cached payload was stored, in ms. Used by 'cached' / 'stale' detail strings. */
	readonly storedAtMs?: number;
}

/**
 * Human "… ago" string for a stored/computed timestamp. Exported so the
 * EphemerisGantt viewport-summary pill (which this module generalizes) shares
 * one age formatter — including the >24h day rollover — instead of its own copy.
 */
export const fmtAge = (storedAtMs: number, nowMs: number): string => {
	const ageMin = Math.max(0, Math.round((nowMs - storedAtMs) / 60_000));
	if (ageMin < 1) return 'just now';
	if (ageMin < 60) return `${ageMin}m ago`;
	const ageHr = ageMin / 60;
	if (ageHr < 24) return `${Math.round(ageHr)}h ago`;
	return `${Math.round(ageHr / 24)}d ago`;
};

/**
 * Derive a badge view from inputs. `now` is injected so tests can pin
 * a deterministic clock without monkey-patching `Date`.
 *
 * Decision table:
 *
 *   kind=live + online=true   → 'live' / live tone
 *   kind=live + online=false  → 'offline live'  (unusual; freshly computed but browser flips offline)
 *   kind=cached               → 'cache' / cached tone (+ age detail if storedAtMs given)
 *                                 'offline cache' label when offline
 *   kind=stale                → 'stale' / stale tone (+ age detail)
 *                                 'offline stale' when offline
 *   kind=loading              → 'loading' (online) or 'offline' (offline) / loading tone
 *   kind=error                → 'error' / error tone — same label regardless of online
 *   kind=empty                → 'no data' / empty tone — upstream had nothing for this query
 */
export const buildCacheBadge = (inputs: CacheBadgeInputs, nowMs: number = Date.now()): CacheBadgeView => {
	const { online, kind, storedAtMs } = inputs;
	const age = storedAtMs !== undefined ? fmtAge(storedAtMs, nowMs) : undefined;

	switch (kind) {
		case 'live':
			return {
				label: online ? 'live' : 'offline live',
				tone: 'live',
				detail: online
					? 'Freshly computed for the current view.'
					: 'Result is fresh locally, but the browser reports offline — no upstream confirmation.',
			};
		case 'cached':
			return {
				label: online ? 'cache' : 'offline cache',
				tone: 'cached',
				detail: online
					? age
						? `Reused a local cache entry from ${age}.`
						: 'Reused a local cache entry.'
					: age
						? `Browser is offline; showing the local cache entry from ${age}.`
						: 'Browser is offline; showing the local cache entry.',
			};
		case 'stale':
			return {
				label: online ? 'stale' : 'offline stale',
				tone: 'stale',
				detail: online
					? age
						? `Fresh fetch failed; showing the prior cache entry from ${age}.`
						: 'Fresh fetch failed; showing the prior cache entry.'
					: age
						? `Browser is offline and the local cache entry from ${age} is the only available copy.`
						: 'Browser is offline; the local cache entry is the only available copy.',
			};
		case 'loading':
			return {
				label: online ? 'loading' : 'offline',
				tone: 'loading',
				detail: online ? 'Fetching the current view.' : 'Browser is offline; waiting for connectivity.',
			};
		case 'error':
			return {
				label: 'error',
				tone: 'error',
				detail: online
					? 'Upstream returned an error; nothing to show.'
					: 'Browser is offline and there is no cached copy to fall back to.',
			};
		case 'empty':
			return {
				label: 'no data',
				tone: 'empty',
				detail: 'Upstream returned no data for this query.',
			};
	}
};

/**
 * Map a `CacheBadgeTone` to the `.cache-pill` modifier classes used by
 * `EphemerisGantt.svelte`. Exported so a Svelte component can apply
 * the right tonal class without re-typing the union.
 */
export const cachePillToneClass = (tone: CacheBadgeTone): string => `cache-pill-${tone}`;
