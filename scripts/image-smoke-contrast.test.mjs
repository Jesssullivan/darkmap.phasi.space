import assert from 'node:assert/strict';
import test from 'node:test';
import { computedContrast } from './image-smoke-contrast.mjs';

test('rejects near-white title on the observed pale detached surface', () => {
	assert(computedContrast('rgb(233, 236, 243)', ['rgba(0, 0, 0, 0)', 'rgb(245, 245, 245)']).ratio < 4.5);
});
test('dark translucent detached surface retains readable title', () => {
	assert(computedContrast('rgb(233, 236, 243)', ['rgba(0, 0, 0, 0)', 'rgba(8, 10, 16, 0.94)']).ratio >= 4.5);
});
test('black and white use WCAG contrast ratio 21', () => {
	assert.equal(computedContrast('rgb(0, 0, 0)', ['rgb(255, 255, 255)']).ratio, 21);
});
