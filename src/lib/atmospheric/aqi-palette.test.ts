import { describe, expect, it } from 'vitest';
import {
	AQI_CATEGORIES,
	DECK_BG,
	aqiCategory,
	colorFor,
	contrastRatio,
	cvdSeparation,
	paletteColorFor,
	paletteRamp,
	relLuminance,
} from './aqi';

// WCAG AA for non-text UI (graphical objects) is 3:1 — the dot/legend swatch
// must clear this against the near-black deck to read on dark.
const MIN_CONTRAST = 3;
// The ColorVision ramp's adjacent steps must clear this under a deuteranopia
// simulation. The measured min is 24.17 (Unhealthy↔Very-unhealthy); 18 leaves
// headroom while still being well above the AirNow worst link (11.81).
const MIN_CVD_SEPARATION = 18;

describe('relLuminance / contrastRatio — WCAG reference points', () => {
	it('black has 0 luminance, white has 1', () => {
		expect(relLuminance('#000000')).toBeCloseTo(0, 6);
		expect(relLuminance('#ffffff')).toBeCloseTo(1, 6);
	});
	it('black-on-white is the maximal 21:1 contrast', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
	});
	it('contrast is order-independent', () => {
		expect(contrastRatio(DECK_BG, '#f6e15a')).toBeCloseTo(contrastRatio('#f6e15a', DECK_BG), 6);
	});
});

describe('contrast vs the deck — both palettes are legible enough to read', () => {
	// (a) The ColorVision ramp — the palette this feature justifies — clears the
	// 3:1 graphical-contrast bar for EVERY category on the near-black deck.
	for (const cat of AQI_CATEGORIES) {
		it(`colorvision "${cat.name}" ≥ ${MIN_CONTRAST}:1 vs deck`, () => {
			const c = contrastRatio(paletteColorFor(cat, 'colorvision'), DECK_BG);
			expect(c).toBeGreaterThanOrEqual(MIN_CONTRAST);
		});
	}
	// The default AirNow ramp is the canonical EPA standard — its "Hazardous"
	// maroon (#7e0023) is genuinely dark (1.76:1) and we will NOT alter the
	// standard color. We assert only that the five non-maroon AirNow categories
	// clear the bar, so the ColorVision swap is a strict legibility improvement
	// on the deck (its worst, 4.33:1, beats AirNow's worst non-maroon).
	for (const cat of AQI_CATEGORIES.filter((c) => c.name !== 'Hazardous')) {
		it(`airnow "${cat.name}" ≥ ${MIN_CONTRAST}:1 vs deck`, () => {
			expect(contrastRatio(cat.color, DECK_BG)).toBeGreaterThanOrEqual(MIN_CONTRAST);
		});
	}
});

describe('CVD distinguishability — the property that justifies the feature', () => {
	const cv = paletteRamp('colorvision');
	const airnow = paletteRamp('airnow');

	const minAdjacent = (ramp: readonly string[]): number => {
		let mn = Infinity;
		for (let i = 0; i < ramp.length - 1; i++) mn = Math.min(mn, cvdSeparation(ramp[i], ramp[i + 1]));
		return mn;
	};

	// (b) Every adjacent ColorVision pair stays apart under deuteranopia.
	for (let i = 0; i < cv.length - 1; i++) {
		it(`colorvision "${AQI_CATEGORIES[i].name}" ↔ "${AQI_CATEGORIES[i + 1].name}" CVD-separable`, () => {
			expect(cvdSeparation(cv[i], cv[i + 1])).toBeGreaterThanOrEqual(MIN_CVD_SEPARATION);
		});
	}

	it('colorvision strictly out-separates AirNow on the weakest adjacent link', () => {
		// AirNow's USG→Unhealthy (orange→red) nearly merges under deutan; the
		// whole point of the ColorVision ramp is to never have a link that bad.
		expect(minAdjacent(cv)).toBeGreaterThan(minAdjacent(airnow));
	});
});

describe('paletteColorFor / colorFor — correct hex per (category, mode)', () => {
	it('defaults to the AirNow ramp (back-compat with cat.color)', () => {
		for (const cat of AQI_CATEGORIES) {
			expect(paletteColorFor(cat)).toBe(cat.color);
		}
	});
	it('airnow mode returns the canonical EPA category color', () => {
		expect(paletteColorFor(aqiCategory(0), 'airnow')).toBe('#00e400');
		expect(paletteColorFor(aqiCategory(500), 'airnow')).toBe('#7e0023');
	});
	it('colorvision mode returns the CVD-safe ramp', () => {
		expect(paletteColorFor(aqiCategory(0), 'colorvision')).toBe('#4a90d9');
		expect(paletteColorFor(aqiCategory(500), 'colorvision')).toBe('#b452a8');
	});
	it('colorFor maps a raw AQI through category lookup + palette swap', () => {
		// AQI 75 → Moderate.
		expect(colorFor(75, 'airnow')).toBe('#ffff00');
		expect(colorFor(75, 'colorvision')).toBe('#7fd0e0');
		// AQI 175 → Unhealthy.
		expect(colorFor(175, 'colorvision')).toBe('#f29e2e');
	});
});
