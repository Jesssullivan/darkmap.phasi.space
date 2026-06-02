#!/usr/bin/env node
// Packet v2 — shipped-UI capture tool.
//
// The CI browser-RBE proof cell and the gstack `/browse` headless Chromium both
// lack WebGL *and* system fonts, so neither can render the MapLibre canvas — the
// map is blank in every automated capture we have. This tool closes that gap for
// the public-readiness packet: it serves the local adapter-node bundle, launches
// the system Google Chrome with SwiftShader (software WebGL) + real fonts, drives
// each persona lens through the reactive switcher, and writes per-lens captures
// of the *fully rendered* shipped UI (map + dossier + rail + toolbar) to
// docs/ux/public-readiness/assets/shipped/.
//
// Usage:
//   just build            # produce build/index.js (adapter-node) first
//   node scripts/capture-shipped-ui.mjs
//
// Env:
//   CHROME_BIN     path to a Chrome/Chromium with SwiftShader (default: macOS Google Chrome)
//   CAPTURE_PORT   local server port (default 3056)
//   CAPTURE_OUT    output dir (default docs/ux/public-readiness/assets/shipped)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const PORT = process.env.CAPTURE_PORT || '3056';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.CAPTURE_OUT || join(ROOT, 'docs/ux/public-readiness/assets/shipped');
const CHROME =
	process.env.CHROME_BIN ||
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const LENSES = [
	{ id: 'sky', label: 'Sky' },
	{ id: 'air', label: 'Air' },
	{ id: 'links', label: 'Links' },
	{ id: 'orbit', label: 'Orbit' },
];

function die(msg) {
	console.error(`capture-shipped-ui: ${msg}`);
	process.exit(1);
}

if (!existsSync(join(BUILD, 'index.js'))) die('no adapter-node build at build/index.js — run `just build` first');
if (!existsSync(CHROME)) die(`Chrome not found at ${CHROME} — set CHROME_BIN`);

async function waitReady(url, tries = 80) {
	for (let i = 0; i < tries; i++) {
		try {
			const r = await fetch(url);
			if (r.ok) return;
		} catch {
			/* server not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`server not ready at ${url}`);
}

// 1. Serve the adapter-node bundle (mirrors `just smoke-local`).
const server = spawn(process.execPath, [join(BUILD, 'index.js')], {
	env: { ...process.env, PORT, HOST: '127.0.0.1' },
	stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let browser;
let failed = false;
try {
	await waitReady(`${BASE}/`);
	await mkdir(OUT, { recursive: true });

	// 2. Launch the system Chrome with SwiftShader so the MapLibre canvas paints.
	browser = await chromium.launch({
		executablePath: CHROME,
		args: [
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--use-angle=swiftshader',
			'--ignore-gpu-blocklist',
			'--enable-webgl',
		],
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

	await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
	const webgl = await page.evaluate(() => {
		const c = document.createElement('canvas');
		return !!(c.getContext('webgl') || c.getContext('webgl2'));
	});
	console.log(`capture-shipped-ui: WebGL ${webgl ? 'OK' : 'MISSING (captures will show a blank map)'}`);

	// Start from a clean preference so each lens is driven purely by its hash.
	await page.evaluate(() => localStorage.removeItem('darkmap-lens'));

	// 3. Per lens: load FRESH from the `#lens=` deep-link (a reload re-runs
	//    lensStore.init off the hash, so the rail auto-expands only this lens's
	//    groups — no expand-state carryover from the previous lens). Then let
	//    tiles settle and capture the full shipped chrome over the live map.
	for (const lens of LENSES) {
		// `load` not `networkidle`: the live map keeps fetching tiles, so
		// networkidle can never settle and times out the reload.
		await page.goto(`${BASE}/#lens=${lens.id}`, { waitUntil: 'load' });
		await page.reload({ waitUntil: 'load' });
		// Dismiss the guided tour if it auto-opened, so the map reads cleanly.
		await page.evaluate(() => {
			const b = [...document.querySelectorAll('button')].find((x) => /close tour|skip/i.test(x.textContent || ''));
			b?.click();
		});
		await page.waitForTimeout(2500); // tile fetch + paint
		const active = await page.evaluate(() => {
			const d = document.querySelector('.readout[data-scope]');
			return d?.getAttribute('data-lens') ?? 'unknown';
		});
		const out = join(OUT, `lens-${lens.id}.png`);
		await page.screenshot({ path: out });
		console.log(`capture-shipped-ui: wrote ${out} (active lens: ${active})`);
	}

	// 4. The /docs launchpad (above the fold).
	await page.goto(`${BASE}/docs`, { waitUntil: 'load' });
	await page.waitForTimeout(500);
	const docsOut = join(OUT, 'docs-launchpad-full.png');
	await page.screenshot({ path: docsOut });
	console.log(`capture-shipped-ui: wrote ${docsOut}`);

	console.log('capture-shipped-ui: DONE');
} catch (err) {
	failed = true;
	console.error(`capture-shipped-ui: FAILED — ${err?.message ?? err}`);
} finally {
	if (browser) await browser.close().catch(() => {});
	server.kill();
}
process.exit(failed ? 1 : 0);
