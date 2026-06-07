<script lang="ts">
	/**
	 * Design a link — the FSO/laser link-budget panel (S2, Links lens).
	 *
	 * The few numbers a tech brings (Tx power, aperture/gain, beam divergence, Rx
	 * sensitivity, wavelength) → a term-by-term loss ledger → received power +
	 * link MARGIN + go/no-go. The differentiator is the "Atmospheric" term: it is
	 * read off THIS beam's slant transmittance (our T(λ) curve at the operating
	 * wavelength), not approximated from visibility. Scintillation is a LABELED
	 * HV-class estimate. See docs/ux/personas-and-lenses.md §4.3.
	 */
	import type { TransmissionCurve } from '$lib/effect/services/TransmissionEstimator';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import {
		atmosphericLossDb,
		geometricSpreadLossDb,
		hufnagelValleyCn2,
		linkMargin,
		pointingLossDb,
		rytovVariance,
		sampleTransmittance,
		scintillationFadeDb,
		type LossTerm,
	} from '$lib/linkBudget';

	interface Props {
		/** Slant T(λ) curve for this pin/geometry (airmass already baked in). */
		curve: TransmissionCurve | undefined;
		/** Slant range to the receiver, km (shares the beam-footprint range). */
		rangeKm: number;
	}
	let { curve, rangeKm }: Props = $props();

	// The few numbers a tech brings — defaults describe a representative 1550 nm
	// terrestrial FSO link (100 mW, tightly-collimated 0.2 mrad beam, 20 cm Rx)
	// so a sensible margin appears immediately (no blank/discouraging cold-start).
	let txPowerDbm = $state(20);
	let txGainDbi = $state(0);
	let beamDivergenceMrad = $state(0.2);
	let rxApertureM = $state(0.2);
	let rxSensitivityDbm = $state(-30);
	let wavelengthNm = $state(1550);
	let pointingErrorMrad = $state(0);
	const AVAILABILITY = 0.99;
	const WAVELENGTHS = [850, 1064, 1310, 1550];

	const transmittance = $derived(
		curve ? sampleTransmittance(curve.wavelengthsUm, curve.transmission, wavelengthNm) : null,
	);

	const losses = $derived.by<LossTerm[]>(() => {
		const terms: LossTerm[] = [
			{ label: 'Geometric spread', db: geometricSpreadLossDb({ beamDivergenceMrad, rangeKm, rxApertureM }) },
		];
		if (transmittance !== null) terms.push({ label: 'Atmospheric (this beam)', db: atmosphericLossDb(transmittance) });
		const pl = pointingLossDb({ pointingErrorMrad, beamDivergenceMrad });
		if (pl > 0.05) terms.push({ label: 'Pointing', db: pl });
		const cn2 = hufnagelValleyCn2({ altitudeM: 0 });
		const scint = scintillationFadeDb(rytovVariance({ cn2, wavelengthNm, pathLengthKm: rangeKm }), AVAILABILITY);
		if (scint > 0.05) terms.push({ label: 'Scintillation', db: scint, estimate: true });
		return terms;
	});

	const result = $derived(linkMargin({ txPowerDbm, txGainDbi, rxSensitivityDbm, losses }));
	const maxLossDb = $derived(Math.max(1, ...losses.map((l) => l.db)));

	const fmtDb = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
	const VERDICT = {
		go: { label: 'GO', symbol: '●' },
		marginal: { label: 'MARGINAL', symbol: '◐' },
		'no-go': { label: 'NO-GO', symbol: '○' },
	} as const;
</script>

<section class="link-budget" aria-label="Link budget">
	<header class="lb-head">
		<h4>Design a link</h4>
		<span class="lb-sub">FSO margin from this beam's atmosphere</span>
		<p class="lb-units">
			<abbr title="decibel-milliwatts — power referenced to 1 mW">dBm</abbr> = power ·
			<abbr title="decibels-isotropic — antenna gain vs an isotropic radiator">dBi</abbr> = gain ·
			<abbr title="decibels — a power ratio; +3 dB ≈ 2×, +10 dB = 10×">dB</abbr> = ratio
		</p>
	</header>

	<div class="lb-inputs">
		<label
			>Tx power
			<input type="number" bind:value={txPowerDbm} step="1" aria-label="Transmit power, dBm" /><span class="u">dBm</span
			></label
		>
		<label
			>Tx gain
			<input type="number" bind:value={txGainDbi} step="1" aria-label="Transmit gain, dBi" /><span class="u">dBi</span
			></label
		>
		<label
			>Divergence
			<input
				type="number"
				bind:value={beamDivergenceMrad}
				step="0.1"
				min="0.01"
				aria-label="Beam divergence, mrad"
			/><span class="u">mrad</span></label
		>
		<label
			>Rx aperture
			<input type="number" bind:value={rxApertureM} step="0.05" min="0.01" aria-label="Receiver aperture, m" /><span
				class="u">m</span
			></label
		>
		<label
			>Rx sens.
			<input type="number" bind:value={rxSensitivityDbm} step="1" aria-label="Receiver sensitivity, dBm" /><span
				class="u">dBm</span
			></label
		>
		<label
			>Pointing
			<input type="number" bind:value={pointingErrorMrad} step="0.05" min="0" aria-label="Pointing error, mrad" /><span
				class="u">mrad</span
			></label
		>
		<label class="lb-wl"
			>λ
			<select bind:value={wavelengthNm} aria-label="Operating wavelength, nm">
				{#each WAVELENGTHS as nm (nm)}
					<option value={nm}>{nm} nm</option>
				{/each}
			</select></label
		>
	</div>

	<dl class="lb-ledger">
		{#each losses as term (term.label)}
			<div class="lb-term">
				<dt>
					{term.label}
					{#if term.estimate}
						<HelpTooltip
							text="Labeled estimate, not measured: a Hufnagel–Valley Cn² turbulence profile → Rytov variance → log-normal scintillation fade sized to {Math.round(
								AVAILABILITY * 100,
							)}% availability. Supply a measured Cn² to replace it."
						>
							{#snippet trigger()}<span class="est">est</span>{/snippet}
						</HelpTooltip>
					{:else if term.label.startsWith('Atmospheric')}
						<HelpTooltip
							text="Read off THIS beam's slant transmittance (our modeled T(λ) at {wavelengthNm} nm, airmass-baked) — measured atmospheric state along the real path, not a visibility approximation."
						>
							{#snippet trigger()}<span class="est">i</span>{/snippet}
						</HelpTooltip>
					{/if}
				</dt>
				<dd>
					<span class="lb-bar" style:width="{Math.min(100, (term.db / maxLossDb) * 100)}%" aria-hidden="true"></span>
					<span class="lb-db">−{term.db.toFixed(1)} dB</span>
				</dd>
			</div>
		{/each}
		<div class="lb-term lb-total">
			<dt>Total loss</dt>
			<dd><span class="lb-db">−{result.totalLossDb.toFixed(1)} dB</span></dd>
		</div>
	</dl>

	<div class="lb-result" data-verdict={result.verdict}>
		<div class="lb-margin">
			<span class="lb-prx">Prx {result.prxDbm.toFixed(1)} dBm</span>
			<span class="lb-margin-val">Margin {fmtDb(result.marginDb)} dB</span>
		</div>
		<span class="lb-badge" data-verdict={result.verdict}>
			<span class="lb-badge-sym" aria-hidden="true">{VERDICT[result.verdict].symbol}</span>
			{VERDICT[result.verdict].label}
		</span>
	</div>
</section>

<style>
	.link-budget {
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.lb-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.lb-head h4 {
		margin: 0;
		font-size: 0.85rem;
		color: var(--accent-amber);
	}
	.lb-sub {
		font-size: 0.66rem;
		opacity: 0.6;
	}
	/* Persona gloss: spell out the dB-family units a Links tech reads in the ledger. */
	.lb-units {
		margin: 0.3rem 0 0;
		font-size: 0.62rem;
		opacity: 0.55;
		line-height: 1.4;
	}
	.lb-units abbr {
		font-weight: 600;
		text-decoration-style: dotted;
		cursor: help;
	}
	.lb-inputs {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
		gap: 0.3rem 0.6rem;
		margin-bottom: 0.6rem;
	}
	.lb-inputs label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		opacity: 0.85;
		white-space: nowrap;
	}
	.lb-inputs input,
	.lb-inputs select {
		flex: 1 1 auto;
		min-width: 0;
		width: 3.2rem;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 4px;
		color: #e9ecf3;
		font: inherit;
		font-size: 0.72rem;
		padding: 0.15rem 0.3rem;
		text-align: right;
	}
	.lb-inputs select {
		text-align: left;
	}
	.lb-inputs input:focus-visible,
	.lb-inputs select:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 1px;
	}
	.lb-inputs .u {
		opacity: 0.55;
		font-size: 0.62rem;
	}
	.lb-ledger {
		margin: 0 0 0.6rem;
	}
	.lb-term {
		display: grid;
		grid-template-columns: 11rem 1fr;
		align-items: center;
		gap: 0.5rem;
		padding: 0.12rem 0;
	}
	.lb-term dt {
		margin: 0;
		font-size: 0.72rem;
		opacity: 0.85;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.lb-term dd {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.lb-bar {
		height: 0.4rem;
		border-radius: 2px;
		background: rgba(var(--accent-amber-rgb), 0.5);
		flex: 0 0 auto;
		max-width: 60%;
	}
	.lb-db {
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.est {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0 0.3rem;
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 999px;
		opacity: 0.7;
		cursor: help;
	}
	.lb-total {
		margin-top: 0.2rem;
		padding-top: 0.3rem;
		border-top: 1px dashed rgba(255, 255, 255, 0.14);
	}
	.lb-total dt {
		opacity: 1;
		font-weight: 600;
	}
	.lb-result {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.04);
	}
	.lb-margin {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
	}
	.lb-prx {
		font-size: 0.66rem;
		opacity: 0.6;
	}
	.lb-margin-val {
		font-size: 0.9rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	/* Badge distinguishes by symbol + label + border, not colour alone. */
	.lb-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		border: 1px solid currentColor;
	}
	.lb-badge[data-verdict='go'] {
		color: #66e0a3;
	}
	.lb-badge[data-verdict='marginal'] {
		color: var(--accent-amber);
	}
	.lb-badge[data-verdict='no-go'] {
		color: #ff8a8a;
	}
	.lb-result[data-verdict='no-go'] {
		background: rgba(255, 120, 120, 0.08);
	}
</style>
