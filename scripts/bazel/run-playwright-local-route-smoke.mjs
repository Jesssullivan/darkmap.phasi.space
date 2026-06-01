import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';

const DEFAULT_VIEWPORT = { width: 390, height: 844 };
const SMOKE_SCENARIO = process.env.DARKMAP_RBE_SMOKE_SCENARIO ?? 'shell';
const SMOKE_VIEWPORTS = parseViewportList(process.env.DARKMAP_RBE_SMOKE_VIEWPORTS);
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

	for (const viewport of SMOKE_VIEWPORTS) {
		const viewportLabel = `${viewport.width}x${viewport.height}`;
		const context = await browser.newContext({
			geolocation: { latitude: 42.443, longitude: -76.501 },
			viewport,
		});
		await context.grantPermissions(['geolocation'], { origin: baseURL });
		const page = await context.newPage();
		const pageErrors = [];
		const consoleErrors = [];
		page.on('pageerror', (err) => {
			pageErrors.push(err.message);
			console.log(`darkmap pageerror observed at ${viewportLabel}: ${err.message}`);
		});
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text());
				console.log(`darkmap console error observed at ${viewportLabel}: ${msg.text()}`);
			}
		});
		await installNetworkGuards(page, baseURL);
		await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));

		try {
			await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
			await runSmokeScenario(page, SMOKE_SCENARIO);

			if (pageErrors.length > 0) {
				throw new Error(
					`page errors during browser-RBE ${SMOKE_SCENARIO} smoke at ${viewportLabel}: ${pageErrors.join(' | ')}`,
				);
			}
			if (consoleErrors.length > 0) {
				console.log(
					`darkmap ${SMOKE_SCENARIO} smoke observed console errors at ${viewportLabel}: ${consoleErrors.join(' | ')}`,
				);
			}

			console.log(`darkmap Playwright ${SMOKE_SCENARIO} smoke passed at ${viewportLabel} with ${chromiumPath}`);
		} finally {
			await context.close();
		}
	}
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
		case 'mobile-hud':
			await runMobileHudSmoke(page);
			return;
		case 'lens':
			await runLensSmoke(page);
			return;
		case 'toolbar-labels':
			await runToolbarLabelsSmoke(page);
			return;
		case 'lens-reweight':
			await runLensReweightSmoke(page);
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
	const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
	const minCanvasWidth = Math.min(300, Math.floor(viewport.width * 0.9));
	const minCanvasHeight = Math.min(300, Math.floor(viewport.height * 0.9));
	try {
		await page.locator(MAP_CANVAS_SELECTOR).first().waitFor({ state: 'attached', timeout: 30_000 });
		await page.waitForFunction(
			({ selector, minCanvasWidth, minCanvasHeight }) => {
				const map = document.querySelector('[data-tour="map"]');
				const canvas = document.querySelector(selector);
				if (!(map instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return false;
				const mapRect = map.getBoundingClientRect();
				const canvasRect = canvas.getBoundingClientRect();
				return (
					mapRect.width >= minCanvasWidth &&
					mapRect.height >= minCanvasHeight &&
					canvasRect.width >= minCanvasWidth &&
					canvasRect.height >= minCanvasHeight
				);
			},
			{ selector: MAP_CANVAS_SELECTOR, minCanvasWidth, minCanvasHeight },
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
	const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
	await canvas.click({ position: { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) } });

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

async function runMobileHudSmoke(page) {
	await runMapCanvasSmoke(page);
	await page.locator('.gantt').waitFor({ state: 'visible', timeout: 20_000 });
	await page.locator('.toolbar').waitFor({ state: 'visible', timeout: 20_000 });

	const canvas = page.locator(MAP_CANVAS_SELECTOR).first();
	const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
	await canvas.click({ position: { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) } });

	const readout = page.getByRole('dialog', { name: /point readout/i });
	await readout.waitFor({ state: 'visible', timeout: 20_000 });
	console.log(`darkmap mobile-hud readout-open precheck ${JSON.stringify(await collectHudMetrics(page))}`);
	await readout.getByText(/VIIRS pixel/i).waitFor({ state: 'visible', timeout: 20_000 });
	await readout
		.getByRole('button', { name: /open spectral transmission analysis/i })
		.waitFor({ state: 'visible', timeout: 20_000 });
	await assertHudBoxesDoNotOverlap(page, 'point-readout-open', [
		['.readout[role="dialog"]', '.toolbar'],
		['.readout[role="dialog"]', '.gantt'],
	]);

	await readout.getByRole('button', { name: /open spectral transmission analysis/i }).click();
	const sheet = page.getByRole('dialog', { name: /atmospheric transmission widget/i });
	await sheet.waitFor({ state: 'visible', timeout: 20_000 });
	console.log(`darkmap mobile-hud transmission-open precheck ${JSON.stringify(await collectHudMetrics(page))}`);
	await sheet.getByText(/for -?\d+\.\d+°,\s*-?\d+\.\d+°/).waitFor({ state: 'visible', timeout: 20_000 });
	const readoutCount = await page.locator('.readout[role="dialog"]').count();
	if (readoutCount !== 0) {
		throw new Error(`point readout remained mounted while transmission sheet was open: count=${readoutCount}`);
	}
	await assertHudBoxesDoNotOverlap(page, 'transmission-open', [
		['.sheet', '.toolbar'],
		['.sheet', '.gantt'],
	]);

	await page.getByRole('button', { name: /Close transmission sheet/i }).click();
	await sheet.waitFor({ state: 'hidden', timeout: 20_000 });
	await readout.waitFor({ state: 'visible', timeout: 20_000 });

	const metrics = await collectHudMetrics(page);
	console.log(`darkmap mobile-hud smoke observed ${JSON.stringify(metrics)}`);
}

async function runLensSmoke(page) {
	// The lens switch only re-weights derived surfaces and writes the hash via
	// scheduleHashWrite, which no-ops until the map is up — so wait for the
	// canvas (mapInstance ready) before asserting hash writes.
	await runMapCanvasSmoke(page);

	const nav = page.getByRole('navigation', { name: 'Map lens' });
	await nav.waitFor({ timeout: 20_000 });
	const chip = (name) => nav.getByRole('button', { name });
	const sky = chip('Sky');
	const air = chip('Air');
	const links = chip('Links');
	const orbit = chip('Orbit');

	const ariaPressed = (locator) => locator.getAttribute('aria-pressed');
	const hashOf = () => page.evaluate(() => window.location.hash);
	const seg = (hash, key) => {
		const m = new RegExp(`(?:^#|&)${key}=([^&]*)`).exec(hash);
		return m ? m[1] : null;
	};

	// Cold start: Sky active (default), and the default is omitted from the hash.
	await sky.waitFor({ timeout: 20_000 });
	if ((await ariaPressed(sky)) !== 'true') {
		throw new Error(`expected Sky lens active on load, got aria-pressed=${await ariaPressed(sky)}`);
	}

	// Click Air → active toggles, hash gains lens=air, the map view is serialized.
	await air.click();
	await page.waitForFunction(() => window.location.hash.includes('lens=air'), null, { timeout: 20_000 });
	if ((await ariaPressed(air)) !== 'true' || (await ariaPressed(sky)) !== 'false') {
		throw new Error('Air chip did not become the sole active lens');
	}
	const mapView = seg(await hashOf(), 'm');
	if (!mapView) throw new Error('expected scheduleHashWrite to serialize the map view (m=) on lens switch');

	// Number key 3 → Links; the map view must be untouched by a lens switch.
	await page.keyboard.press('3');
	await page.waitForFunction(() => window.location.hash.includes('lens=links'), null, { timeout: 20_000 });
	if ((await ariaPressed(links)) !== 'true') throw new Error('number key 3 did not activate Links');
	const afterKey = seg(await hashOf(), 'm');
	if (afterKey !== mapView) throw new Error(`lens switch moved the map view: ${mapView} -> ${afterKey}`);

	// Number key 1 → back to Sky → the default lens drops out of the hash.
	await page.keyboard.press('1');
	await page.waitForFunction(() => !/(?:^#|&)lens=/.test(window.location.hash), null, { timeout: 20_000 });
	if ((await ariaPressed(sky)) !== 'true') throw new Error('number key 1 did not return to Sky');

	// Never-gate: every chip stays enabled + named regardless of the active lens.
	for (const [name, locator] of [
		['Sky', sky],
		['Air', air],
		['Links', links],
		['Orbit', orbit],
	]) {
		const disabled = await locator.getAttribute('aria-disabled');
		if (disabled === 'true' || !(await locator.isEnabled())) {
			throw new Error(`lens chip "${name}" must never be gated (aria-disabled=${disabled})`);
		}
	}

	console.log('darkmap lens smoke verified Sky→Air→Links→Sky (chip + keys 1–4), map view preserved, never-gated');
}

async function runToolbarLabelsSmoke(page) {
	const toolbar = page.locator('.toolbar');
	await toolbar.waitFor({ state: 'visible', timeout: 20_000 });

	// Every tool stays reachable by its full accessible name (aria-label) at
	// every viewport — what AT and the existing role-name queries depend on.
	await page.getByRole('button', { name: /twilight strip/i }).waitFor({ timeout: 20_000 });
	await page.getByRole('button', { name: /take the guided tour/i }).waitFor({ timeout: 20_000 });

	const width = (page.viewportSize() ?? { width: 0 }).width;
	// No hover is issued before this read — the mouse sits at its default
	// position. The contract is font-independent: the desktop media query
	// renders the label (display != none, real text), ≤820px collapses it to
	// display:none. We deliberately do NOT assert pixel width — the headless
	// proof container can lack system fonts (zero glyph advance), which would
	// false-fail a width check though the label renders fine on real devices.
	const labels = await page.evaluate(() =>
		Array.from(document.querySelectorAll('.toolbar .tool')).map((btn) => {
			const span = btn.querySelector('.tool-label');
			return {
				aria: btn.getAttribute('aria-label') ?? '',
				text: span ? (span.textContent ?? '').trim() : '',
				display: span ? getComputedStyle(span).display : 'missing',
			};
		}),
	);
	if (labels.length < 4) throw new Error(`expected at least 4 toolbar tools, saw ${labels.length}`);

	if (width > 820) {
		for (const l of labels) {
			if (l.display === 'none' || l.text.length === 0) {
				throw new Error(`toolbar label not rendered without hover at ${width}px: ${JSON.stringify(l)}`);
			}
		}
		const texts = labels.map((l) => l.text);
		for (const expected of ['Twilight', 'Follow', 'Tour']) {
			if (!texts.includes(expected)) {
				throw new Error(`expected a "${expected}" toolbar label at ${width}px, saw ${JSON.stringify(texts)}`);
			}
		}
		console.log(`darkmap toolbar-labels smoke: labels rendered without hover at ${width}px ${JSON.stringify(texts)}`);
	} else {
		for (const l of labels) {
			if (l.display !== 'none') {
				throw new Error(
					`toolbar label must collapse to icon-only <=820px, got display=${l.display}: ${JSON.stringify(l)}`,
				);
			}
			if (l.aria.length === 0) throw new Error(`toolbar button lost its accessible name at ${width}px`);
		}
		console.log(`darkmap toolbar-labels smoke: compact icon-only + named at ${width}px`);
	}
}

async function runLensReweightSmoke(page) {
	// Open the readout over the mocked point (viirs + worldAtlas + atmospheric).
	await runMapCanvasSmoke(page);
	const canvas = page.locator(MAP_CANVAS_SELECTOR).first();
	const vp = page.viewportSize() ?? DEFAULT_VIEWPORT;
	await canvas.click({ position: { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) } });
	const readout = page.getByRole('dialog', { name: /point readout/i });
	await readout.waitFor({ timeout: 20_000 });
	await readout.getByText(/World Atlas radiance/i).waitFor({ state: 'attached', timeout: 20_000 });

	// Scope to `.readout[data-lens]` — SkyCompass also uses a `.readout` class,
	// so a bare `.readout` selector can hit the wrong element.
	const setLens = async (key, name) => {
		await page.keyboard.press(key);
		await page.waitForFunction(
			(want) => document.querySelector('.readout[data-lens]')?.getAttribute('data-lens') === want,
			name,
			{ timeout: 10_000 },
		);
	};
	// Snapshot every present section's id/tier/computed order+opacity+interactivity.
	const snap = () =>
		page.evaluate(() => {
			const byId = {};
			for (const s of document.querySelectorAll('.readout[data-lens] > [data-section]')) {
				const cs = getComputedStyle(s);
				byId[s.getAttribute('data-section')] = {
					tier: s.getAttribute('data-tier'),
					order: cs.order,
					opacity: Number(cs.opacity),
					display: cs.display,
					pointerEvents: cs.pointerEvents,
					ariaDisabled: s.getAttribute('aria-disabled'),
				};
			}
			return { hasBortleLead: !!document.querySelector('.readout[data-lens] .bortle-lead'), byId };
		});
	const tierOf = (snapshot, id) => snapshot.byId[id]?.tier;
	const expect = (cond, msg) => {
		if (!cond) throw new Error(`lens-reweight: ${msg}`);
	};
	// Re-weight, never gate — assert on every snapshot.
	const assertNeverGated = (snapshot, lens) => {
		for (const [id, s] of Object.entries(snapshot.byId)) {
			if (s.display === 'none' || s.pointerEvents === 'none' || s.ariaDisabled === 'true') {
				throw new Error(`lens-reweight: ${lens} gated section "${id}": ${JSON.stringify(s)}`);
			}
		}
	};

	// Sky → Bortle headline leads; sky sections are full, AQ sinks (if present).
	await setLens('1', 'sky');
	let s = await snap();
	expect(s.hasBortleLead, 'Sky must show the Bortle lead headline');
	expect(tierOf(s, 'ephemeris') === '1', `Sky ephemeris should be Tier-1, got ${tierOf(s, 'ephemeris')}`);
	expect(tierOf(s, 'viirs') === '2', `Sky viirs should be Tier-2, got ${tierOf(s, 'viirs')}`);
	assertNeverGated(s, 'sky');

	// Air → night-lights dim (Tier-3); no Bortle headline.
	await setLens('2', 'air');
	s = await snap();
	expect(!s.hasBortleLead, 'Air must NOT show the Bortle lead');
	expect(tierOf(s, 'viirs') === '3', `Air viirs should dim to Tier-3, got ${tierOf(s, 'viirs')}`);
	expect(tierOf(s, 'worldAtlas') === '3', `Air worldAtlas should dim to Tier-3, got ${tierOf(s, 'worldAtlas')}`);
	expect(s.byId.viirs.opacity < 1, `Air Tier-3 viirs should be visually dimmed, opacity=${s.byId.viirs?.opacity}`);
	assertNeverGated(s, 'air');

	// Links → atmosphere leads (Tier-1, floated up via negative order); viirs dims.
	await setLens('3', 'links');
	s = await snap();
	expect(tierOf(s, 'atmosphere') === '1', `Links atmosphere should be Tier-1, got ${tierOf(s, 'atmosphere')}`);
	expect(Number(s.byId.atmosphere.order) < 0, `Links atmosphere should float up, order=${s.byId.atmosphere?.order}`);
	expect(tierOf(s, 'viirs') === '3', `Links viirs should dim to Tier-3, got ${tierOf(s, 'viirs')}`);
	assertNeverGated(s, 'links');

	// Orbit → ephemeris leads.
	await setLens('4', 'orbit');
	s = await snap();
	expect(tierOf(s, 'ephemeris') === '1', `Orbit ephemeris should be Tier-1, got ${tierOf(s, 'ephemeris')}`);
	assertNeverGated(s, 'orbit');

	console.log('darkmap lens-reweight smoke: Bortle lead (Sky), section tiers + order per lens, never-gated');
}

async function assertHudBoxesDoNotOverlap(page, label, pairs) {
	const results = await page.evaluate((inputPairs) => {
		const boxFor = (selector) => {
			const node = document.querySelector(selector);
			if (!(node instanceof HTMLElement)) return null;
			const style = getComputedStyle(node);
			const rect = node.getBoundingClientRect();
			if (
				style.display === 'none' ||
				style.visibility === 'hidden' ||
				rect.width <= 0 ||
				rect.height <= 0 ||
				rect.bottom <= 0 ||
				rect.right <= 0 ||
				rect.top >= window.innerHeight ||
				rect.left >= window.innerWidth
			) {
				return null;
			}
			return {
				bottom: rect.bottom,
				height: rect.height,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				width: rect.width,
			};
		};
		return inputPairs.map(([aSelector, bSelector]) => {
			const a = boxFor(aSelector);
			const b = boxFor(bSelector);
			const overlap =
				a !== null &&
				b !== null &&
				!(a.right <= b.left + 2 || b.right <= a.left + 2 || a.bottom <= b.top + 2 || b.bottom <= a.top + 2);
			return { a, aSelector, b, bSelector, overlap };
		});
	}, pairs);

	for (const result of results) {
		if (!result.a || !result.b) {
			throw new Error(`missing visible HUD box for ${label}: ${JSON.stringify(result)}`);
		}
		if (result.overlap) {
			throw new Error(`overlapping HUD boxes for ${label}: ${JSON.stringify(result)}`);
		}
	}
}

async function collectHudMetrics(page) {
	return page.evaluate(() => {
		const selectors = [
			'.readout[role="dialog"]',
			'.readout h4',
			'.sheet',
			'.sheet .point-coords',
			'.toolbar',
			'.gantt',
			'.attribution',
		];
		return {
			viewport: { height: window.innerHeight, width: window.innerWidth },
			boxes: Object.fromEntries(
				selectors.map((selector) => {
					const node = document.querySelector(selector);
					if (!(node instanceof HTMLElement)) return [selector, null];
					const rect = node.getBoundingClientRect();
					const style = getComputedStyle(node);
					return [
						selector,
						{
							bottom: rect.bottom,
							display: style.display,
							height: rect.height,
							left: rect.left,
							right: rect.right,
							top: rect.top,
							visibility: style.visibility,
							width: rect.width,
						},
					];
				}),
			),
		};
	});
}

function parseViewportList(raw) {
	if (!raw?.trim()) return [DEFAULT_VIEWPORT];

	return raw.split(',').map((item) => {
		const trimmed = item.trim();
		const match = /^(\d+)x(\d+)$/.exec(trimmed);
		if (!match) {
			throw new Error(`invalid DARKMAP_RBE_SMOKE_VIEWPORTS entry "${trimmed}"; expected WIDTHxHEIGHT`);
		}
		const width = Number(match[1]);
		const height = Number(match[2]);
		if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
			throw new Error(`invalid DARKMAP_RBE_SMOKE_VIEWPORTS dimensions "${trimmed}"`);
		}
		return { width, height };
	});
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
			if (url.pathname === '/api/elevation') {
				await route.fulfill({
					status: 200,
					contentType: 'image/png',
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
