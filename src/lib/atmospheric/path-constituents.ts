/**
 * Path-constituent aggregation (V3-10) — how a constituent field varies ALONG a
 * directed beam, not just at the origin.
 *
 * The transmission LUT is a vertical/slant-*column* model, so this does not feed
 * the curve; it answers a directed-link question the point value can't: "does the
 * aerosol load change down my beam?" Currently driven by the PM2.5
 * kernel-diffusion field sampled along the centerline — which costs no extra
 * network round-trips (the stations are already cached for the heatmap).
 *
 * Pure, dependency-free. Null samples (no station coverage at that point) are
 * skipped; an all-null path returns null rather than a fabricated zero.
 */

export interface PathProfile {
	readonly min: number;
	readonly max: number;
	readonly mean: number;
	/** Number of samples with real coverage that the profile rests on. */
	readonly samples: number;
}

/** Aggregate a sampled-along-path field. Returns null when nothing has coverage. */
export const aggregatePath = (values: ReadonlyArray<number | null>): PathProfile | null => {
	const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
	if (present.length === 0) return null;
	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	for (const v of present) {
		if (v < min) min = v;
		if (v > max) max = v;
		sum += v;
	}
	return { min, max, mean: sum / present.length, samples: present.length };
};
