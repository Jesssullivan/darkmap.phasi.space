import { expect, test } from '@playwright/test';

const sizes = [
	{ width: 390, height: 844 },
	{ width: 430, height: 932 },
];

async function openCompass(page: import('@playwright/test').Page): Promise<void> {
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
	await page.goto('/');
	// Map setup opens the twilight strip after hydration; clicking its toggle
	// before that transition can close it again.
	await expect(page.locator('.command-deck')).toHaveAttribute('data-ephemeris', 'open', { timeout: 15_000 });
	await expect(page.locator('.stage .sky .phone-compass')).toBeVisible();
}

for (const viewport of sizes) {
	test(`phone compass stays clear at ${viewport.width}×${viewport.height}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.addInitScript(() => {
			Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: class {} });
		});
		await openCompass(page);
		const compass = page.locator('.stage .sky .phone-compass');
		await expect(compass).toContainText('Waiting for heading');
		await page.evaluate(() => {
			const event = new Event('deviceorientation');
			Object.defineProperties(event, { alpha: { value: 90 }, absolute: { value: true } });
			window.dispatchEvent(event);
		});
		await expect(compass).toContainText('270°');

		const compassBox = await compass.boundingBox();
		expect(compassBox).not.toBeNull();
		for (const selector of ['.toolbar', '.gantt', '.lens-switcher', '.maplibregl-ctrl-bottom-right']) {
			const box = await page.locator(selector).first().boundingBox();
			if (!box || !compassBox) continue;
			const overlaps =
				compassBox.x < box.x + box.width &&
				compassBox.x + compassBox.width > box.x &&
				compassBox.y < box.y + box.height &&
				compassBox.y + compassBox.height > box.y;
			expect(overlaps, `compass overlaps ${selector}`).toBe(false);
		}
	});
}

test('unsupported device gives an understandable phone fallback', async ({ page }) => {
	await page.setViewportSize(sizes[0]);
	await page.addInitScript(() => {
		Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: undefined });
	});
	await openCompass(page);
	await expect(page.locator('.stage .sky .phone-compass')).toContainText('Compass unavailable');
});

test('permission request is tappable and denial remains visible', async ({ page }) => {
	await page.setViewportSize(sizes[0]);
	await page.addInitScript(() => {
		Object.defineProperty(window, 'DeviceOrientationEvent', {
			configurable: true,
			value: class {
				static requestPermission = async () => 'denied';
			},
		});
	});
	await openCompass(page);
	const compass = page.locator('.stage .sky .phone-compass');
	await compass.getByRole('button', { name: 'Enable compass' }).click();
	await expect(compass).toContainText('Compass denied');
});

test('a missing update marks the heading stale and closing the dome removes its listener', async ({ page }) => {
	test.setTimeout(45_000);
	await page.setViewportSize(sizes[0]);
	await page.addInitScript(() => {
		Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: class {} });
		const observed = { added: 0, removed: 0 };
		Object.assign(window, { __compassListeners: observed });
		const add = window.addEventListener.bind(window);
		const remove = window.removeEventListener.bind(window);
		window.addEventListener = ((
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions,
		) => {
			if (type === 'deviceorientation') observed.added++;
			add(type, listener, options);
		}) as typeof window.addEventListener;
		window.removeEventListener = ((
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | EventListenerOptions,
		) => {
			if (type === 'deviceorientation') observed.removed++;
			remove(type, listener, options);
		}) as typeof window.removeEventListener;
	});
	await openCompass(page);
	const compass = page.locator('.stage .sky .phone-compass');
	await page.evaluate(() => {
		const event = new Event('deviceorientation');
		Object.defineProperties(event, { alpha: { value: 180 }, absolute: { value: true } });
		window.dispatchEvent(event);
	});
	await expect(compass).toContainText('180°');
	await expect(compass).toContainText('Heading stale', { timeout: 20_000 });
	const before = await page.evaluate(
		() => (window as Window & { __compassListeners: { added: number; removed: number } }).__compassListeners.removed,
	);
	await page.getByRole('button', { name: 'Hide twilight strip' }).click();
	await expect(page.locator('.stage .sky')).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & { __compassListeners: { added: number; removed: number } }).__compassListeners.removed,
			),
		)
		.toBeGreaterThan(before);
});
