import { describe, expect, it } from 'vitest';
import { bandGuidance, type TransmissionCurveLike } from './band-guidance';

describe('bandGuidance', () => {
	it('finds the worst dip and labels it with the HITRAN band when one applies', () => {
		// High transmission everywhere except a sharp dip at the 1.38 µm H₂O band.
		const wavelengthsUm = [0.5, 0.7, 1.0, 1.2, 1.38, 1.6, 2.0];
		const transmission = [0.9, 0.92, 0.94, 0.93, 0.08, 0.9, 0.91];
		const g = bandGuidance({ wavelengthsUm, transmission });
		expect(g.worst).not.toBeNull();
		expect(g.worst!.centerUm).toBeCloseTo(1.38, 5);
		expect(g.worst!.minT).toBeCloseTo(0.08, 5);
		expect(g.worst!.label).toMatch(/H₂O/);
		expect(g.takeaway).toMatch(/Worst absorption near/);
	});

	it('clearest window excludes the dip and reports a high mean T', () => {
		const wavelengthsUm = [0.5, 0.7, 1.0, 1.2, 1.38, 1.6, 2.0];
		const transmission = [0.9, 0.92, 0.94, 0.93, 0.08, 0.9, 0.91];
		const g = bandGuidance({ wavelengthsUm, transmission });
		expect(g.clearest).not.toBeNull();
		// The clear run must not span across the 1.38 dip.
		expect(g.clearest!.loUm).toBeGreaterThanOrEqual(0.5);
		expect(g.clearest!.hiUm).toBeLessThanOrEqual(1.2); // longest clear run is the 0.5–1.2 side
		expect(g.clearest!.meanT).toBeGreaterThan(0.8);
	});

	it('a flat high curve yields a full-range clear window', () => {
		const wavelengthsUm = [0.5, 1.0, 1.5, 2.0];
		const transmission = [0.9, 0.9, 0.9, 0.9];
		const g = bandGuidance({ wavelengthsUm, transmission });
		expect(g.clearest!.loUm).toBeCloseTo(0.5, 5);
		expect(g.clearest!.hiUm).toBeCloseTo(2.0, 5);
		expect(g.clearest!.meanT).toBeCloseTo(0.9, 5);
	});

	it('labels the worst dip by wavelength when it is not in a named band', () => {
		const wavelengthsUm = [0.5, 0.55, 0.6];
		const transmission = [0.8, 0.4, 0.82];
		const g = bandGuidance({ wavelengthsUm, transmission });
		expect(g.worst!.label).toMatch(/µm/); // fell back to a wavelength label
	});

	it('returns a graceful summary for too-short curves', () => {
		expect(bandGuidance({ wavelengthsUm: [], transmission: [] }).clearest).toBeNull();
		expect(bandGuidance({ wavelengthsUm: [1], transmission: [0.5] }).takeaway).toMatch(/Not enough/);
	});

	it('handles mismatched array lengths defensively', () => {
		const curve: TransmissionCurveLike = { wavelengthsUm: [0.5, 1.0, 1.5], transmission: [0.9, 0.9] };
		const g = bandGuidance(curve);
		expect(g.clearest).not.toBeNull(); // used the 2 valid pairs, didn't throw
	});

	it('takeaway always ends with the actionable instruction', () => {
		const g = bandGuidance({ wavelengthsUm: [0.5, 1.0, 1.5], transmission: [0.9, 0.5, 0.92] });
		expect(g.takeaway).toMatch(/Choose a working band inside the clear window\.$/);
	});
});
