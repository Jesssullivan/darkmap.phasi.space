/**
 * Bohren-Huffman 1983 Appendix A Mie scattering for a homogeneous sphere.
 *
 * Pure functions over complex arithmetic. The MieScatteringService wrapper
 * (V2-C) lifts these into Effect for composition with the LUT-backed gas
 * absorption from the spectral plane. Kept as pure functions here so they're
 * trivial to test against published reference outputs (Wiscombe MIEV0).
 *
 * References:
 *
 *   Bohren, C.F. & Huffman, D.R. (1983) "Absorption and Scattering of Light
 *     by Small Particles." Wiley. Appendix A, eq. A.16, pp. 477-482.
 *
 *   Wiscombe, W.J. (1979) "Mie Scattering Calculations: Advances in Technique
 *     and Fast, Vector-Speed Computer Codes." NCAR Tech Note TN-140+STR.
 *     Truncation N = round(x + 4.05·x^(1/3) + 2); downward recursion start
 *     for the logarithmic derivative D_n(mx).
 */

export interface Complex {
	readonly re: number;
	readonly im: number;
}

export interface MieResult {
	/** Extinction efficiency factor Q_ext (dimensionless). */
	readonly qExt: number;
	/** Scattering efficiency factor Q_sca. */
	readonly qSca: number;
	/** Backscatter efficiency factor Q_back. */
	readonly qBack: number;
	/** Asymmetry parameter g = ⟨cos θ⟩, in [-1, 1]. */
	readonly g: number;
}

const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const cMul = (a: Complex, b: Complex): Complex => ({
	re: a.re * b.re - a.im * b.im,
	im: a.re * b.im + a.im * b.re,
});
const cDiv = (a: Complex, b: Complex): Complex => {
	const d = b.re * b.re + b.im * b.im;
	return {
		re: (a.re * b.re + a.im * b.im) / d,
		im: (a.im * b.re - a.re * b.im) / d,
	};
};
const cAbs2 = (z: Complex): number => z.re * z.re + z.im * z.im;
const cFromReal = (re: number): Complex => ({ re, im: 0 });

/**
 * Build a complex number from `n + ki` parts. Convenience over object literal;
 * callers pass `k` (the absorptive part) as a positive number.
 */
export const complex = (re: number, im = 0): Complex => ({ re, im });

/**
 * Mie efficiency factors for a homogeneous sphere of size parameter `x` and
 * complex refractive index `m = n + ik` (k ≥ 0 for absorbing media).
 *
 * `x = 2π · r / λ` — `r` and `λ` in the same units. Typical atmospheric range
 * is x ∈ [0.01, 100]; the algorithm is well-conditioned across that span.
 */
export function mie(x: number, m: Complex): MieResult {
	if (!Number.isFinite(x) || x <= 0) {
		throw new Error(`mie: x must be a positive finite number (got ${x})`);
	}
	if (!Number.isFinite(m.re) || !Number.isFinite(m.im) || m.re <= 0) {
		throw new Error(`mie: refractive index must have finite re > 0 (got ${m.re} + ${m.im}i)`);
	}

	const mx: Complex = { re: m.re * x, im: m.im * x };

	// Wiscombe truncation — number of terms in the partial-wave sum.
	const N = Math.round(x + 4.05 * Math.cbrt(x) + 2);

	// Downward-recursion start for the logarithmic derivative D_n(mx) of the
	// Riccati-Bessel function ψ_n(mx). Wiscombe shows N + 15 is sufficient even
	// for large |mx|; using max(N, |mx|) + 15 covers absorbing media.
	const nStart = Math.max(N, Math.round(Math.sqrt(cAbs2(mx)))) + 15;

	// D_{n-1} = n/mx - 1 / (D_n + n/mx). Seed D_{nStart} = 0; only D[0..N] are
	// consumed downstream. Indexing here is `D[n] = D_n(mx)`.
	const D: Complex[] = new Array(N + 2);
	D[nStart] = cFromReal(0);
	for (let n = nStart; n > 0; n--) {
		const nOverMx = cDiv(cFromReal(n), mx);
		const denom = cAdd(D[n], nOverMx);
		D[n - 1] = cSub(nOverMx, cDiv(cFromReal(1), denom));
	}

	// Upward recursion for the real-valued Riccati-Bessel functions ψ_n(x) and
	// χ_n(x). ξ_n(x) = ψ_n(x) − i χ_n(x).
	//   ψ_{-1} =  cos x, ψ_0 = sin x
	//   χ_{-1} = -sin x, χ_0 = cos x
	//   ψ_n = ((2n-1)/x) ψ_{n-1} - ψ_{n-2}   (same recurrence for χ)
	let psiPrev = Math.cos(x);
	let psi = Math.sin(x);
	let chiPrev = -Math.sin(x);
	let chi = Math.cos(x);

	let qExtSum = 0;
	let qScaSum = 0;
	let backRe = 0;
	let backIm = 0;
	// Asymmetry numerator: sum of two terms per BH eq 4.62.
	let gSum = 0;

	let aPrev: Complex | null = null;
	let bPrev: Complex | null = null;

	for (let n = 1; n <= N; n++) {
		const psiNew = ((2 * n - 1) / x) * psi - psiPrev;
		const chiNew = ((2 * n - 1) / x) * chi - chiPrev;
		psiPrev = psi;
		psi = psiNew;
		chiPrev = chi;
		chi = chiNew;

		// ξ_n = ψ_n - i χ_n   (and ξ_{n-1} from the previous step)
		const xi: Complex = { re: psi, im: -chi };
		const xiPrev: Complex = { re: psiPrev, im: -chiPrev };

		// a_n = [(D_n/m + n/x) ψ_n - ψ_{n-1}] / [(D_n/m + n/x) ξ_n - ξ_{n-1}]
		const dOverM = cDiv(D[n], m);
		const aBracket = cAdd(dOverM, cFromReal(n / x));
		const aNum = cSub(cMul(aBracket, cFromReal(psi)), cFromReal(psiPrev));
		const aDen = cSub(cMul(aBracket, xi), xiPrev);
		const a = cDiv(aNum, aDen);

		// b_n = [(m D_n + n/x) ψ_n - ψ_{n-1}] / [(m D_n + n/x) ξ_n - ξ_{n-1}]
		const bBracket = cAdd(cMul(m, D[n]), cFromReal(n / x));
		const bNum = cSub(cMul(bBracket, cFromReal(psi)), cFromReal(psiPrev));
		const bDen = cSub(cMul(bBracket, xi), xiPrev);
		const b = cDiv(bNum, bDen);

		const factor = 2 * n + 1;
		qExtSum += factor * (a.re + b.re);
		qScaSum += factor * (cAbs2(a) + cAbs2(b));

		// Q_back = (1/x²) |Σ (2n+1) (-1)^n (a_n - b_n)|²
		const sign = (n & 1) === 0 ? 1 : -1;
		backRe += sign * factor * (a.re - b.re);
		backIm += sign * factor * (a.im - b.im);

		// Asymmetry (BH eq 4.62):
		//   g · Q_sca = (4/x²) · Σ { n(n+2)/(n+1) · Re(a_n a*_{n+1} + b_n b*_{n+1})
		//                          + (2n+1)/(n(n+1)) · Re(a_n b*_n) }
		// We compute the (n-1) cross term once `a_{n-1}` is in hand.
		if (aPrev !== null && bPrev !== null) {
			const wCross = ((n - 1) * (n + 1)) / n;
			const reAAprev = aPrev.re * a.re + aPrev.im * a.im; // Re(a_{n-1} conj(a_n))
			const reBBprev = bPrev.re * b.re + bPrev.im * b.im;
			gSum += wCross * (reAAprev + reBBprev);
		}
		const wAB = (2 * n + 1) / (n * (n + 1));
		const reABconj = a.re * b.re + a.im * b.im; // Re(a_n conj(b_n))
		gSum += wAB * reABconj;

		aPrev = a;
		bPrev = b;
	}

	const factor = 2 / (x * x);
	const qExt = factor * qExtSum;
	const qSca = factor * qScaSum;
	const qBack = (backRe * backRe + backIm * backIm) / (x * x);
	const g = qSca > 0 ? (4 / (x * x * qSca)) * gSum : 0;

	return { qExt, qSca, qBack, g };
}

/**
 * Spectral Mie sweep: evaluate `mie(x, m)` at each wavelength using the
 * radius (µm) and refractive index n+ik values supplied per wavelength.
 * Returns the matching arrays so callers can integrate the cross section
 * over a size distribution.
 */
export interface MieSpectrumInput {
	/** Particle radius in µm. */
	readonly radiusUm: number;
	/** Wavelength grid in µm. */
	readonly wavelengthsUm: ReadonlyArray<number>;
	/**
	 * Refractive indices `n + ik` paired with `wavelengthsUm` — one entry per λ.
	 * Callers interpolate from their tabulated aerosol data.
	 */
	readonly refractiveIndex: ReadonlyArray<Complex>;
}

export interface MieSpectrumResult {
	readonly wavelengthsUm: ReadonlyArray<number>;
	readonly qExt: ReadonlyArray<number>;
	readonly qSca: ReadonlyArray<number>;
	readonly qBack: ReadonlyArray<number>;
	readonly g: ReadonlyArray<number>;
}

export function mieSpectrum(input: MieSpectrumInput): MieSpectrumResult {
	const { radiusUm, wavelengthsUm, refractiveIndex } = input;
	if (wavelengthsUm.length !== refractiveIndex.length) {
		throw new Error(
			`mieSpectrum: wavelengthsUm.length (${wavelengthsUm.length}) must equal refractiveIndex.length (${refractiveIndex.length})`,
		);
	}
	const qExt: number[] = [];
	const qSca: number[] = [];
	const qBack: number[] = [];
	const g: number[] = [];
	for (let i = 0; i < wavelengthsUm.length; i++) {
		const x = (2 * Math.PI * radiusUm) / wavelengthsUm[i];
		const result = mie(x, refractiveIndex[i]);
		qExt.push(result.qExt);
		qSca.push(result.qSca);
		qBack.push(result.qBack);
		g.push(result.g);
	}
	return { wavelengthsUm, qExt, qSca, qBack, g };
}
