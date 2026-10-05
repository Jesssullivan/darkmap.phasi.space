import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { computedContrast } from './image-smoke-contrast.mjs';

const [appRoot, baseUrl, artifactDir, sourceSha, imageDigest] = process.argv.slice(2);
assert(appRoot && baseUrl && artifactDir, 'app_root, explicit image base URL and artifact directory required');
assert(/^[0-9a-f]{40}$/.test(sourceSha ?? ''), 'full qualified app SHA required');
assert(/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? ''), 'immutable published image digest required');
assert(process.env.CHROME_BIN, 'locked CHROME_BIN required');
const base = new URL(baseUrl);
assert(['http:', 'https:'].includes(base.protocol), 'HTTP(S) image endpoint required');
assert(!base.username && !base.password, 'credentials must not be embedded in image URL');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'image smoke must target a local container endpoint');
const require = createRequire(path.join(path.resolve(appRoot), 'package.json'));
const { chromium } = require('@playwright/test');
const output = path.resolve(artifactDir);
await mkdir(output, { recursive: true });
const evidence = {
	appSourceSha: sourceSha, publishedImageDigest: imageDigest, baseUrl: base.origin,
	startedAt: new Date().toISOString(), mode: 'published-image UI with denied provider diagnostics',
	boundaries: 'No source build/server spawn; no real provider/data availability, first-run or geographic raster proof.',
	pageErrors: [], consoleErrors: [], deniedRequests: [], screenshots: [],
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true,
	args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
	await context.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
	// Never spend provider quota, request private keys or mistake fixtures for measurements.
	await context.route('**/*', async route => {
		const url = new URL(route.request().url());
		if (url.origin !== base.origin) {
			evidence.deniedRequests.push(url.origin + url.pathname);
			return route.abort('blockedbyclient');
		}
		if (url.pathname.startsWith('/api/')) {
			evidence.deniedRequests.push(url.pathname);
			if (url.pathname.includes('/openaq')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [], degraded: true, reason: 'not-configured' }) });
			return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"operator smoke provider-denial diagnostic"}' });
		}
		return route.continue();
	});
	const health = await context.request.get(new URL('/healthz', base).href, { timeout: 15_000 });
	assert.equal(health.status(), 200, 'actual image health HTTP status');
	evidence.health = await health.json();
	assert.equal(evidence.health.status, 'ok');
	const page = await context.newPage();
	page.on('pageerror', error => evidence.pageErrors.push(error.message));
	page.on('console', message => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
	const response = await page.goto(new URL('/', base).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	assert.equal(response?.status(), 200, 'actual image homepage HTTP status');
	assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://darkmap.xoxd.ai');
	await page.locator('.maplibregl-canvas').waitFor({ state: 'visible', timeout: 30_000 });
	evidence.canvas = await page.locator('.maplibregl-canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, webgl: !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl')) }));
	assert(evidence.canvas.width > 0 && evidence.canvas.height > 0 && evidence.canvas.webgl, 'actual image MapLibre canvas/WebGL');
	const instruments = page.locator('.deck-inspector .instrument-column');
	await instruments.waitFor({ state: 'visible' });
	assert.equal(await page.locator('.instrument-column').count(), 1);
	const instrumentBox = await instruments.boundingBox();
	const stageBox = await page.locator('.stage').boundingBox();
	assert(instrumentBox && stageBox && instrumentBox.x >= stageBox.x + stageBox.width - 1, 'right inspector does not overlap stage');
	const shot = async name => { await page.screenshot({ path: path.join(output, name), fullPage: true }); evidence.screenshots.push(name); };
	await shot('desktop.png');
	await page.getByRole('button', { name: 'Detach Air and local dome' }).click();
	await page.locator('[data-instrument-panel="floating"]').waitFor({ state: 'visible' });
	assert.equal(await page.locator('.instrument-column').count(), 1);
	const detachedColors = await page.locator('[data-instrument-panel="floating"] h2').evaluate(title => {
		const backgrounds = [];
		let element = title;
		while (element) {
			backgrounds.push(getComputedStyle(element).backgroundColor);
			element = element.parentElement;
		}
		return { text: getComputedStyle(title).color, backgrounds };
	});
	evidence.detachedTitleContrast = { ...detachedColors, ...computedContrast(detachedColors.text, detachedColors.backgrounds) };
	await shot('detached.png');
	assert(evidence.detachedTitleContrast.ratio >= 4.5, 'detached title computed contrast must be at least 4.5:1');
	await page.getByRole('button', { name: 'Redock instruments' }).click();
	await page.locator('[data-instrument-panel="docked"]').waitFor({ state: 'visible' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(new URL('/#lens=air', base).href, { waitUntil: 'domcontentloaded' });
	const mobileAir = page.locator('[data-responsive-dock]').getByRole('button', { name: 'Air', exact: true });
	await mobileAir.click();
	await page.waitForFunction(() => document.querySelector('[data-responsive-dock] button[aria-label="Air"]')?.getAttribute('aria-pressed') === 'true');
	assert.equal(await mobileAir.getAttribute('aria-pressed'), 'true', 'mobile Air lens actually selected');
	evidence.mobileSelectedLens = 'air';
	await page.locator('[data-responsive-dock] .instrument-column.compact').waitFor({ state: 'visible' });
	assert.equal(await page.locator('.instrument-column').count(), 1);
	await shot('mobile.png');
	assert.deepEqual(evidence.pageErrors, [], 'unexpected application JS exceptions');
	evidence.result = 'pass';
	await context.close();
} catch (error) {
	evidence.result = 'fail';
	evidence.error = error.message;
	throw error;
} finally {
	evidence.finishedAt = new Date().toISOString();
	await writeFile(path.join(output, 'published-image-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
	await browser.close();
}
