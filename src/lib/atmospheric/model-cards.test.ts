import { describe, expect, it } from 'vitest';
import { LAYERS } from '$lib/layers';
import { MODEL_CARDS, modelCardFor } from './model-cards';

describe('model cards', () => {
	it('every atmospheric layer + World Atlas has a model card', () => {
		const needs = LAYERS.filter((l) => l.group === 'atmospheric' || l.group === 'world_atlas').map((l) => l.id);
		for (const id of needs) {
			expect(modelCardFor(id), `card for ${id}`).toBeDefined();
		}
	});

	it('the VIIRS family group key resolves', () => {
		expect(modelCardFor('viirs_annual')).toBeDefined();
	});

	it('every card has non-empty title / what / source and a valid https link', () => {
		for (const [id, card] of Object.entries(MODEL_CARDS)) {
			expect(card.title.trim().length, `${id} title`).toBeGreaterThan(0);
			expect(card.what.trim().length, `${id} what`).toBeGreaterThan(0);
			expect(card.source.trim().length, `${id} source`).toBeGreaterThan(0);
			expect(card.href, `${id} href`).toMatch(/^https:\/\//);
			expect(['measured', 'modeled', 'imagery'], `${id} kind`).toContain(card.kind);
		}
	});

	it('modeled layers (World Atlas, PM2.5) are tagged modeled, not measured', () => {
		expect(modelCardFor('world_atlas_2015')!.kind).toBe('modeled');
		expect(modelCardFor('smog-openaq-pm25')!.kind).toBe('modeled');
	});

	it('returns undefined for an unknown id', () => {
		expect(modelCardFor('nope')).toBeUndefined();
	});
});
