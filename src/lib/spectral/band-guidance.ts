/**
 * Band guidance (atmospheric UX, PR4).
 *
 * The transmission widget plots T(λ) but leaves the user to read the
 * chart and decide what to do. For the field use-story (pick a laser /
 * EO band that gets through tonight's atmosphere), we distill the curve
 * into a plain-language takeaway: the clearest spectral window to work
 * in, and the worst absorption dip to avoid. Derived purely from the
 * (modeled) curve — the widget already shows the engineering-estimate
 * disclaimer, so this is guidance, not a guarantee.
 *
 * Pure functions over the curve arrays; unit-tested without the widget.
 */

import { bandContainingWavelength } from './hitran-bands';

export interface TransmissionCurveLike {
	readonly wavelengthsUm: ReadonlyArray<number>;
	readonly transmission: ReadonlyArray<number>;
}

export interface ClearestWindow {
	readonly loUm: number;
	readonly hiUm: number;
	readonly meanT: number;
}

export interface WorstBand {
	readonly centerUm: number;
	readonly minT: number;
	/** HITRAN band label if the dip sits in a named band, else a wavelength string. */
	readonly label: string;
}

export interface BandGuidance {
	readonly clearest: ClearestWindow | null;
	readonly worst: WorstBand | null;
	readonly takeaway: string;
}

export interface BandGuidanceOptions {
	/** A sample counts as "clear" if its T is within this margin of the curve max. */
	readonly clearMargin?: number;
}

const fmtUm = (x: number): string => `${x.toFixed(2)} µm`;

/** Zip the two arrays into finite (λ, T) pairs, defensively (mismatched lengths → min). */
const pairs = (curve: TransmissionCurveLike): Array<{ um: number; t: number }> => {
	const n = Math.min(curve.wavelengthsUm.length, curve.transmission.length);
	const out: Array<{ um: number; t: number }> = [];
	for (let i = 0; i < n; i++) {
		const um = curve.wavelengthsUm[i];
		const t = curve.transmission[i];
		if (Number.isFinite(um) && Number.isFinite(t)) out.push({ um, t });
	}
	return out;
};

/**
 * Distill a transmission curve into clearest-window + worst-dip guidance.
 *
 * - **Clearest**: the longest contiguous run of samples whose T is within
 *   `clearMargin` (default 0.05) of the curve's maximum — i.e. the widest
 *   stretch that transmits about as well as it gets.
 * - **Worst**: the single lowest-T sample, labeled with its HITRAN band
 *   when it falls in one (e.g. the 1.38 µm H₂O band).
 */
export const bandGuidance = (curve: TransmissionCurveLike, opts: BandGuidanceOptions = {}): BandGuidance => {
	const pts = pairs(curve);
	if (pts.length < 2) {
		return { clearest: null, worst: null, takeaway: 'Not enough spectral data to summarize.' };
	}

	const margin = opts.clearMargin ?? 0.05;
	const maxT = Math.max(...pts.map((p) => p.t));
	const threshold = maxT - margin;

	// Longest contiguous clear run.
	let best: { start: number; end: number } | null = null;
	let runStart = -1;
	for (let i = 0; i < pts.length; i++) {
		const clear = pts[i].t >= threshold;
		if (clear && runStart < 0) runStart = i;
		const runEnds = !clear || i === pts.length - 1;
		if (runStart >= 0 && runEnds) {
			const end = clear ? i : i - 1;
			if (!best || end - runStart > best.end - best.start) best = { start: runStart, end };
			runStart = -1;
		}
	}
	let clearest: ClearestWindow | null = null;
	if (best) {
		const slice = pts.slice(best.start, best.end + 1);
		const meanT = slice.reduce((s, p) => s + p.t, 0) / slice.length;
		clearest = { loUm: slice[0].um, hiUm: slice[slice.length - 1].um, meanT };
	}

	// Worst single dip.
	let worstPt = pts[0];
	for (const p of pts) if (p.t < worstPt.t) worstPt = p;
	const band = bandContainingWavelength(worstPt.um);
	const worst: WorstBand = {
		centerUm: worstPt.um,
		minT: worstPt.t,
		label: band ? band.label : fmtUm(worstPt.um),
	};

	const pct = (t: number) => `${Math.round(t * 100)}%`;
	const parts: string[] = [];
	if (clearest) {
		parts.push(`Clearest window ${fmtUm(clearest.loUm)}–${fmtUm(clearest.hiUm)} (T≈${pct(clearest.meanT)}).`);
	}
	parts.push(`Worst absorption near ${worst.label} (T≈${pct(worst.minT)}).`);
	parts.push('Choose a working band inside the clear window.');

	return { clearest, worst, takeaway: parts.join(' ') };
};
