import { browser } from '$app/environment';

/**
 * Mobile/browser-permutation diagnostics store (device-in-the-loop). Captures the
 * REAL viewport / visualViewport / dock geometry across iOS browser permutations
 * so the dock-stranding fix is evidence-led, not modeled — the symptom (A1: iOS
 * URL-bar dynamic-toolbar resize) cannot be reproduced in headless WebKit.
 *
 * Gate: `?diag=1` (persists to localStorage `darkmap-diag`; `?diag=0` clears it).
 * When OFF the store never starts, attaches no listeners, and `record()` is a
 * no-op — zero impact on the default bundle path. Mirrors `lens.svelte.ts`.
 */

export interface DiagEvent {
	/** ms since store init. */
	t: number;
	kind: string;
	data: Record<string, number | string | boolean | null>;
}

const MAX_EVENTS = 500;

function detectPermutation(ua: string): string {
	if (/CriOS/.test(ua)) return 'chrome-ios';
	if (/FxiOS/.test(ua)) return 'firefox-ios';
	if (/EdgiOS/.test(ua)) return 'edge-ios';
	if (/iPhone|iPad|iPod/.test(ua)) return /Safari/.test(ua) ? 'safari-ios' : 'webview-ios';
	if (/Android/.test(ua) && /Chrome/.test(ua)) return 'chrome-android';
	return 'desktop-or-other';
}

class DiagnosticsStore {
	enabled = $state(false);
	events = $state<DiagEvent[]>([]);
	permutation = $state('');
	private t0 = 0;
	private started = false;

	/** Resolve the gate + (if enabled) attach the permutation listeners. Call from onMount. */
	init(): void {
		if (!browser || this.started) return;
		const q = new URLSearchParams(window.location.search).get('diag');
		if (q === '1') localStorage.setItem('darkmap-diag', '1');
		else if (q === '0') localStorage.removeItem('darkmap-diag');
		this.enabled = localStorage.getItem('darkmap-diag') === '1';
		if (!this.enabled) return;

		this.started = true;
		this.t0 = performance.now();
		this.permutation = detectPermutation(navigator.userAgent);

		const snap = (kind: string) => () => this.record(kind, this.viewportSnapshot());
		const vv = window.visualViewport;
		if (vv) {
			vv.addEventListener('resize', snap('vv-resize'));
			vv.addEventListener('scroll', snap('vv-scroll'));
		}
		window.addEventListener('resize', snap('win-resize'));
		window.addEventListener('orientationchange', snap('orientation'));
		window.addEventListener('pageshow', snap('pageshow'));
		this.record('init', { ...this.viewportSnapshot(), ua: navigator.userAgent, permutation: this.permutation });
	}

	/** Push a tagged event (no-op when disabled — safe to call from hot paths). */
	record(kind: string, data: DiagEvent['data']): void {
		if (!this.enabled) return;
		const evt: DiagEvent = { t: Math.round(performance.now() - this.t0), kind, data };
		this.events = [...this.events, evt].slice(-MAX_EVENTS);
	}

	/** Live read of the measured viewport/visualViewport/dock geometry (no fabricated values). */
	viewportSnapshot(): DiagEvent['data'] {
		if (!browser) return {};
		const vv = window.visualViewport;
		const root = document.documentElement;
		const rail = document.querySelector<HTMLElement>('.dock-rail');
		const cs = getComputedStyle(root);
		return {
			winW: window.innerWidth,
			winH: window.innerHeight,
			vvW: vv ? Math.round(vv.width) : null,
			vvH: vv ? Math.round(vv.height) : null,
			vvOffTop: vv ? Math.round(vv.offsetTop) : null,
			vvScale: vv ? Number(vv.scale.toFixed(2)) : null,
			clientH: root.clientHeight,
			vvhVar: cs.getPropertyValue('--vvh').trim() || null,
			vvBottomVar: cs.getPropertyValue('--vv-bottom').trim() || null,
			dpr: window.devicePixelRatio,
			railScrollTop: rail ? Math.round(rail.scrollTop) : null,
			railScrollH: rail ? Math.round(rail.scrollHeight) : null,
			railClientH: rail ? Math.round(rail.clientHeight) : null,
		};
	}

	/** Copy the full capture to the clipboard so the operator can paste it back. */
	async exportJSON(): Promise<boolean> {
		const text = JSON.stringify(
			{ ua: browser ? navigator.userAgent : '', permutation: this.permutation, events: this.events },
			null,
			2,
		);
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			console.log('[diag export — clipboard blocked, copy from here]\n' + text);
			return false;
		}
	}

	clear(): void {
		this.events = [];
	}
}

export const diagnostics = new DiagnosticsStore();
