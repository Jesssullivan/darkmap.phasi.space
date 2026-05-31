import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';

const VIEWPORT = { width: 390, height: 844 };
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

	const context = await browser.newContext({ viewport: VIEWPORT });
	const page = await context.newPage();
	const pageErrors = [];
	const consoleErrors = [];
	page.on('pageerror', (err) => pageErrors.push(err.message));
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push(msg.text());
	});
	await installNetworkGuards(page, baseURL);
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));

	await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	await page.getByRole('button', { name: /open layers/i }).waitFor({ timeout: 20_000 });
	await page.getByRole('button', { name: /take the guided tour/i }).waitFor({ timeout: 20_000 });
	await page.getByText(/daylight|night|civil twilight|nautical twilight|astronomical twilight/i).waitFor({
		timeout: 20_000,
	});

	const mapCanvasCount = await page.locator('canvas.maplibregl-canvas').count();
	console.log(`darkmap shell smoke observed ${mapCanvasCount} MapLibre canvas node(s)`);

	if (pageErrors.length > 0) {
		throw new Error(`page errors during browser-RBE smoke: ${pageErrors.join(' | ')}`);
	}
	if (consoleErrors.length > 0) {
		console.log(`darkmap shell smoke observed console errors: ${consoleErrors.join(' | ')}`);
	}

	console.log(`darkmap Playwright local-route smoke passed with ${chromiumPath}`);
} finally {
	await browser?.close();
	await stopServer(server);
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
