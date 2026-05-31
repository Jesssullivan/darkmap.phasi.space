import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';

const VIEWPORT = { width: 390, height: 844 };
const SMOKE_SCENARIO = process.env.DARKMAP_RBE_SMOKE_SCENARIO ?? 'shell';
const MAP_CANVAS_SELECTOR = '[data-tour="map"] canvas, canvas.maplibregl-canvas';
const TRANSPARENT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

const buildDir = findBuildDir();
const chromiumRuntimeDir = mkdtempSync(join(tmpdir(), 'darkmap-playwright-rbe-'));
ensureWritableEnvDir('HOME', join(chromiumRuntimeDir, 'home'));
ensureWritableEnvDir('XDG_CONFIG_HOME', join(chromiumRuntimeDir, 'xdg-config'));
ensureWritableEnvDir('XDG_CACHE_HOME', join(chromiumRuntimeDir, 'xdg-cache'));

const chromiumPath = findChromiumExecutable();
if (!chromiumPath) {
	console.error(
		'set GF_RBE_CHROMIUM_EXECUTABLE, GF_CHROMIUM_EXECUTABLE_PATH, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, PUPPETEER_EXECUTABLE_PATH, or CHROME_BIN',
	);
	process.exit(1);
}

const port = Number(process.env.DARKMAP_RBE_SMOKE_PORT ?? randomInt(20_000, 45_000));
const baseURL = `http://127.0.0.1:${port}`;
let stoppingServer = false;
const server = spawn(process.execPath, ['index.js'], {
	cwd: buildDir,
	env: {
		...process.env,
		HOST: '127.0.0.1',
		NODE_ENV: 'production',
		ORIGIN: baseURL,
		PORT: String(port),
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
	},
	stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));
server.on('exit', (code, signal) => {
	if (stoppingServer) return;
	if (code !== 0 && code !== null) {
		console.error(`darkmap adapter-node server exited early with code ${code}`);
	} else if (signal) {
		console.error(`darkmap adapter-node server exited with signal ${signal}`);
	}
});

let browser;
try {
	await waitForServer(baseURL);
	browser = await chromium.launch({
		executablePath: chromiumPath,
		headless: true,
		args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=swiftshader'],
	});

	const context = await browser.newContext({
		geolocation: { latitude: 42.443, longitude: -76.501 },
		viewport: VIEWPORT,
	});
	await context.grantPermissions(['geolocation'], { origin: baseURL });
	const page = await context.newPage();
	const pageErrors = [];
	const consoleErrors = [];
	page.on('pageerror', (err) => {
		pageErrors.push(err.message);
		console.log(`darkmap pageerror observed: ${err.message}`);
	});
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			consoleErrors.push(msg.text());
			console.log(`darkmap console error observed: ${msg.text()}`);
		}
	});
	await installNetworkGuards(page, baseURL);
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));

	await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	await runSmokeScenario(page, SMOKE_SCENARIO);

	if (pageErrors.length > 0) {
		throw new Error(`page errors during browser-RBE ${SMOKE_SCENARIO} smoke: ${pageErrors.join(' | ')}`);
	}
	if (consoleErrors.length > 0) {
		console.log(`darkmap ${SMOKE_SCENARIO} smoke observed console errors: ${consoleErrors.join(' | ')}`);
	}

	console.log(`darkmap Playwright ${SMOKE_SCENARIO} smoke passed with ${chromiumPath}`);
} finally {
	await browser?.close();
	await stopServer(server);
}

async function runSmokeScenario(page, scenario) {
	switch (scenario) {
		case 'shell':
			await runShellSmoke(page);
			return;
		case 'mobile-layers':
			await runMobileLayersSmoke(page);
			return;
		case 'map-canvas':
			await runMapCanvasSmoke(page);
			return;
		case 'point-readout':
			await runPointReadoutSmoke(page);
			return;
		default:
			throw new Error(`unknown DARKMAP_RBE_SMOKE_SCENARIO: ${scenario}`);
	}
}

async function runShellSmoke(page) {
	await page.getByRole('button', { name: /open layers/i }).waitFor({ timeout: 20_000 });
	await page.getByRole('button', { name: /take the guided tour/i }).waitFor({ timeout: 20_000 });
	await page
		.getByText(/daylight|night|civil twilight|nautical twilight|astronomical twilight/i)
		.first()
		.waitFor({ timeout: 20_000 });

	const mapCanvasCount = await page.locator('canvas.maplibregl-canvas').count();
	console.log(`darkmap shell smoke observed ${mapCanvasCount} MapLibre canvas node(s)`);
}

async function runMobileLayersSmoke(page) {
	const toggle = page.getByRole('button', { name: /open layers/i });
	await toggle.waitFor({ timeout: 20_000 });

	const beforeExpanded = await toggle.getAttribute('aria-expanded');
	if (beforeExpanded !== 'false') {
		throw new Error(`expected mobile layer drawer to start collapsed, got aria-expanded=${beforeExpanded}`);
	}

	await toggle.click();
	const closeToggle = page.getByRole('button', { name: /close layers/i });
	await closeToggle.waitFor({ timeout: 20_000 });

	const rail = page.locator('[data-tour="rail"].open').first();
	await rail.waitFor({ state: 'attached', timeout: 20_000 });
	await page.waitForFunction(
		() => {
			const node = document.querySelector('[data-tour="rail"].open');
			if (!(node instanceof HTMLElement)) return false;
			const rect = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			return style.display !== 'none' && style.visibility !== 'hidden' && rect.left >= -2 && rect.right > 120;
		},
		null,
		{ timeout: 20_000 },
	);

	const metrics = await rail.evaluate((node) => {
		const rect = node.getBoundingClientRect();
		const style = getComputedStyle(node);
		return {
			display: style.display,
			height: rect.height,
			left: rect.left,
			right: rect.right,
			transform: style.transform,
			visibility: style.visibility,
			width: rect.width,
		};
	});
	if (metrics.width < 280 || metrics.height < 500) {
		throw new Error(`mobile layer drawer opened with unexpected geometry: ${JSON.stringify(metrics)}`);
	}

	await rail.getByRole('radiogroup', { name: /basemap/i }).waitFor({ timeout: 20_000 });
	await rail.getByRole('button', { name: /light pollution/i }).waitFor({ timeout: 20_000 });
	await rail.getByRole('button', { name: /atmosphere/i }).waitFor({ timeout: 20_000 });
	await rail.getByRole('slider', { name: /viirs opacity/i }).waitFor({ timeout: 20_000 });

	await closeToggle.click();
	await page.locator('[data-tour="rail"].open').waitFor({ state: 'detached', timeout: 20_000 });
	await page.getByRole('button', { name: /open layers/i }).waitFor({ timeout: 20_000 });

	console.log(`darkmap mobile-layers smoke opened drawer with ${JSON.stringify(metrics)}`);
}

async function runMapCanvasSmoke(page) {
	await page.locator('[data-tour="map"]').waitFor({ state: 'attached', timeout: 20_000 });
	try {
		await page.locator(MAP_CANVAS_SELECTOR).first().waitFor({ state: 'attached', timeout: 30_000 });
		await page.waitForFunction(
			(selector) => {
				const map = document.querySelector('[data-tour="map"]');
				const canvas = document.querySelector(selector);
				if (!(map instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return false;
				const mapRect = map.getBoundingClientRect();
				const canvasRect = canvas.getBoundingClientRect();
				return mapRect.width > 300 && mapRect.height > 500 && canvasRect.width > 300 && canvasRect.height > 500;
			},
			MAP_CANVAS_SELECTOR,
			{ timeout: 30_000 },
		);
	} catch (err) {
		const diagnostics = await collectMapDiagnostics(page);
		throw new Error(
			`MapLibre canvas did not attach: ${err?.message ?? err}; diagnostics=${JSON.stringify(diagnostics)}`,
		);
	}

	const metrics = await page.evaluate(() => {
		const map = document.querySelector('[data-tour="map"]');
		const canvas = document.querySelector('[data-tour="map"] canvas, canvas.maplibregl-canvas');
		const mapRect = map instanceof HTMLElement ? map.getBoundingClientRect() : null;
		const canvasRect = canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect() : null;
		const gl =
			canvas instanceof HTMLCanvasElement
				? (canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl'))
				: null;
		return {
			canvasBackingHeight: canvas instanceof HTMLCanvasElement ? canvas.height : 0,
			canvasBackingWidth: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
			canvasClass: canvas instanceof HTMLElement ? canvas.className : '',
			canvasHeight: canvasRect?.height ?? 0,
			canvasWidth: canvasRect?.width ?? 0,
			controlCount: document.querySelectorAll('.maplibregl-ctrl').length,
			glContextAvailable: Boolean(gl),
			mapHeight: mapRect?.height ?? 0,
			mapWidth: mapRect?.width ?? 0,
		};
	});
	if (metrics.canvasBackingWidth <= 0 || metrics.canvasBackingHeight <= 0) {
		throw new Error(`MapLibre canvas has no backing store: ${JSON.stringify(metrics)}`);
	}

	console.log(`darkmap map-canvas smoke observed ${JSON.stringify(metrics)}`);
}

async function runPointReadoutSmoke(page) {
	await runMapCanvasSmoke(page);

	const canvas = page.locator(MAP_CANVAS_SELECTOR).first();
	await canvas.click({ position: { x: Math.round(VIEWPORT.width / 2), y: Math.round(VIEWPORT.height / 2) } });

	const readout = page.getByRole('dialog', { name: /point readout/i });
	await readout.waitFor({ timeout: 20_000 });
	await readout.getByText(/VIIRS pixel/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/PostGIS:VIIRS_2019/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/World Atlas radiance/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/0\.08\s*mcd\/m²/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/Atmosphere \(Open-Meteo\)/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/12\.3\s*mm/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/24\.0\s*km/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/Pollen & air quality/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/Grass pollen/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout.getByText(/AOD₅₅₀/i).waitFor({ state: 'attached', timeout: 20_000 });
	await readout
		.getByRole('button', { name: /open spectral transmission analysis/i })
		.waitFor({ state: 'attached', timeout: 20_000 });

	const metrics = await readout.evaluate((node) => {
		const rect = node.getBoundingClientRect();
		return {
			height: rect.height,
			left: rect.left,
			top: rect.top,
			width: rect.width,
		};
	});
	console.log(`darkmap point-readout smoke observed ${JSON.stringify(metrics)}`);
}

async function collectMapDiagnostics(page) {
	return page.evaluate(() => {
		const map = document.querySelector('[data-tour="map"]');
		const mapRect = map instanceof HTMLElement ? map.getBoundingClientRect() : null;
		const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas) => {
			const rect = canvas.getBoundingClientRect();
			return {
				className: canvas.className,
				height: rect.height,
				id: canvas.id,
				width: rect.width,
			};
		});
		return {
			bodyText: document.body.innerText.slice(0, 500),
			canvasCount: canvases.length,
			canvases,
			mapClass: map instanceof HTMLElement ? map.className : '',
			mapHeight: mapRect?.height ?? 0,
			mapHtml: map instanceof HTMLElement ? map.innerHTML.slice(0, 500) : '',
			mapWidth: mapRect?.width ?? 0,
			scriptCount: document.scripts.length,
		};
	});
}

function findBuildDir() {
	const candidates = [
		resolve('build'),
		process.env.TEST_SRCDIR && process.env.TEST_WORKSPACE
			? join(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE, 'build')
			: undefined,
		process.env.RUNFILES_DIR && process.env.TEST_WORKSPACE
			? join(process.env.RUNFILES_DIR, process.env.TEST_WORKSPACE, 'build')
			: undefined,
	].filter(Boolean);

	for (const candidate of candidates) {
		if (existsSync(join(candidate, 'index.js')) && existsSync(join(candidate, 'handler.js'))) {
			return candidate;
		}
	}

	console.error(`darkmap Playwright smoke requires adapter-node build output; checked: ${candidates.join(', ')}`);
	process.exit(1);
}

async function waitForServer(url) {
	const deadline = Date.now() + 30_000;
	let lastError;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`adapter-node server exited before readiness with code ${server.exitCode}`);
		}
		try {
			const res = await fetch(url, { redirect: 'manual' });
			if (res.status >= 200 && res.status < 500) return;
			lastError = new Error(`unexpected HTTP ${res.status}`);
		} catch (err) {
			lastError = err;
		}
		await delay(250);
	}
	throw new Error(`adapter-node server did not become ready at ${url}: ${lastError?.message ?? lastError}`);
}

async function installNetworkGuards(page, baseURL) {
	const localOrigin = new URL(baseURL).origin;
	await page.route('**/*', async (route) => {
		const request = route.request();
		const url = new URL(request.url());

		if (url.origin === localOrigin) {
			if (url.pathname === '/api/featureinfo') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						viirs: { layer: 'PostGIS:VIIRS_2019', red: 5, green: 5, blue: 5, alpha: 255 },
						worldAtlas: { grayIndex: 0.08 },
					}),
				});
				return;
			}
			if (url.pathname === '/api/atmospheric/point') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						matchedTime: '2026-05-30T12:00',
						pwv: 12.3,
						rh: 55,
						cloudLow: 10,
						cloudMid: 5,
						cloudHigh: 0,
						visibility: 24000,
					}),
				});
				return;
			}
			if (url.pathname === '/api/atmospheric/airquality') {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						matchedTime: '2026-05-30T12:00',
						pollen: { alder: null, birch: null, grass: 12, mugwort: null, olive: null, ragweed: null },
						aod550: 0.14,
						dust: 2.1,
						ozone: 72,
						pm10: null,
						pm25: null,
					}),
				});
				return;
			}
			if (url.pathname === '/api/raster') {
				await route.fulfill({
					status: 200,
					headers: { 'content-type': 'image/png', 'x-darkmap-atmospheric-outcome': 'ok' },
					body: TRANSPARENT_PNG,
				});
				return;
			}
			await route.continue();
			return;
		}

		if (request.resourceType() === 'stylesheet') {
			await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
			return;
		}
		if (request.resourceType() === 'image' || /\.(png|jpe?g|webp)$/i.test(url.pathname)) {
			await route.fulfill({ status: 200, contentType: 'image/png', body: TRANSPARENT_PNG });
			return;
		}
		await route.abort('blockedbyclient');
	});
}

function findChromiumExecutable() {
	const candidates = [
		process.env.GF_RBE_CHROMIUM_EXECUTABLE,
		process.env.GF_CHROMIUM_EXECUTABLE_PATH,
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
		process.env.CHROME_BIN,
		'/bin/chromium',
	].filter(Boolean);

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return '';
}

function ensureWritableEnvDir(name, fallback) {
	const current = process.env[name];
	if (current && isWritableDirectory(current)) return current;

	mkdirSync(fallback, { recursive: true });
	process.env[name] = fallback;
	return fallback;
}

function isWritableDirectory(path) {
	try {
		if (!existsSync(path) || !statSync(path).isDirectory()) return false;
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

async function stopServer(child) {
	if (child.exitCode !== null) return;
	stoppingServer = true;
	child.kill('SIGTERM');
	const deadline = Date.now() + 5_000;
	while (child.exitCode === null && Date.now() < deadline) {
		await delay(100);
	}
	if (child.exitCode === null) child.kill('SIGKILL');
}
