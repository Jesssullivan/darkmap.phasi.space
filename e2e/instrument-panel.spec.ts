import { expect, test } from '@playwright/test';

test('compact keeps the Air instrument in the readout dock', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/#lens=air');
	await expect(page.locator('[data-responsive-dock] .instrument-column.compact')).toBeVisible();
	await expect(page.locator('[data-instrument-panel="docked"]')).toBeHidden();
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
});

test('medium inspector keeps docked instruments reachable through its tab', async ({ page }) => {
	await page.setViewportSize({ width: 768, height: 900 });
	await page.goto('/');
	const panel = page.locator('[data-instrument-panel="docked"]');
	const inspectorTab = page.getByRole('button', { name: 'Collapse inspector' });
	await expect(panel).toBeVisible();
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
	await inspectorTab.click();
	await expect(panel).toBeHidden();
	await page.getByRole('button', { name: 'Expand inspector' }).click();
	await expect(panel).toBeVisible();
});

test('1024–1279px keeps the inspector panel docked without a detach control', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 });
	await page.goto('/');
	await expect(page.locator('[data-instrument-panel="docked"]')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
});

test('wide instruments detach once, redock, and return keyboard focus', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	const docked = page.locator('[data-instrument-panel="docked"]');
	const floating = page.locator('[data-instrument-panel="floating"]');
	const detach = page.getByRole('button', { name: 'Detach Air and local dome' });
	await expect(docked).toBeVisible();
	await detach.click();
	await expect(floating).toBeVisible();
	await expect(docked).toHaveCount(0);
	await expect(page.locator('.instrument-column')).toHaveCount(1);
	await expect(floating.getByRole('heading', { name: 'Air · local dome' })).toBeFocused();
	await page.getByRole('button', { name: 'Redock instruments' }).click();
	await expect(docked).toBeVisible();
	await expect(floating).toHaveCount(0);
	await expect(detach).toBeFocused();
	await detach.click();
	await expect(floating).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(docked).toBeVisible();
	await expect(detach).toBeFocused();
	await detach.press('Enter');
	await expect(floating).toBeVisible();
	await page.getByRole('button', { name: 'Redock instruments' }).click();
	await detach.press('Space');
	await expect(floating).toBeVisible();
});

test('floating panel minimizes to its header, restores, and stays within the viewport when dragged', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	await page.getByRole('button', { name: 'Detach Air and local dome' }).click();
	const floating = page.locator('[data-instrument-panel="floating"]');
	const initial = await floating.boundingBox();
	expect(initial).not.toBeNull();
	await page.getByRole('button', { name: 'Minimize instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeHidden();
	const minimized = await floating.boundingBox();
	expect(minimized).not.toBeNull();
	expect(minimized!.height).toBeLessThan(initial!.height);
	await page.getByRole('button', { name: 'Restore instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeVisible();
	const drag = floating.locator('.instrument-float-drag');
	const dragBox = await drag.boundingBox();
	expect(dragBox).not.toBeNull();
	await page.mouse.move(dragBox!.x + 30, dragBox!.y + dragBox!.height / 2);
	await page.mouse.down();
	await page.mouse.move(4000, 4000, { steps: 8 });
	await page.mouse.up();
	const bounded = await floating.boundingBox();
	expect(bounded).not.toBeNull();
	expect(bounded!.x).toBeGreaterThanOrEqual(-1);
	expect(bounded!.y).toBeGreaterThanOrEqual(-1);
	expect(bounded!.x + bounded!.width).toBeLessThanOrEqual(1441);
	expect(bounded!.y + bounded!.height).toBeLessThanOrEqual(901);
});

test('wide-to-phone resize redocks without stranding focus in a hidden panel', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	await page.getByRole('button', { name: 'Detach Air and local dome' }).click();
	await expect(page.locator('[data-instrument-panel="floating"]')).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('[data-instrument-panel="floating"]')).toHaveCount(0);
	await expect(page.locator('[data-responsive-dock] .instrument-column.compact')).toBeVisible();
	await expect(page.locator('[data-responsive-dock] .dock-tab:focus')).toHaveCount(1);
});

test('short wide viewport does not offer a panel that cannot fit', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 450 });
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
	await expect(page.locator('[data-instrument-panel="floating"]')).toHaveCount(0);
});
