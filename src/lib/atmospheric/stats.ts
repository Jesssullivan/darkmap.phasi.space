/**
 * Tiny numeric helpers shared across the atmospheric modules (V6 quality pass).
 * Pure + dependency-free. Extracted because `finite`/`median` were duplicated in
 * aq-crossval, viewport-summary, and the TimeSeriesChart component.
 */

/** Narrowing guard: a real, finite number (rejects null/undefined/NaN/±Infinity). */
export const isFiniteNumber = (v: number | null | undefined): v is number =>
	typeof v === 'number' && Number.isFinite(v);

/**
 * Median of a numeric array. Mean of the middle pair when the count is even;
 * NaN for an empty array (callers guard non-empty). Sorts a copy — does not
 * mutate the input.
 */
export const median = (xs: readonly number[]): number => {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};
