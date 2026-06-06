#!/usr/bin/env node
// W4f (TIN-1869) — Command Deck breakpoint-boundary gate.
//
// The browser-RBE smoke matrix exercises a few fixed integer viewports; this tool
// closes the gap the W4 design pass flagged: the MEDIUM/WIDE grid engages on a
// min-width cascade (compact <640 / medium >=640 / wide >=1024, all gated on
// min-height:501), and a fractional or off-by-one boundary could land in a
// dead-band where neither tier's CSS applies. We drive the system Chrome with
// SwiftShader (real WebGL + fonts) across the full breakpoint set PLUS the
// integer triplets that bracket each boundary AND a DPR=2 pass (where sub-pixel
// CSS px arise), and assert at each: (1) the published `data-layout-tier` matches
// the width/height, and (2) the map canvas clears the smoke's floor
// (min(300, 0.9*vp) on both axes). Screenshots land in
// docs/ux/public-readiness/assets/shipped/breakpoints/ for visual review.
//
// Usage:  just build  &&  node scripts/capture-breakpoints.mjs   (or `just capture-breakpoints`)

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
const PORT = process.env.CAPTURE_PORT || '3057';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.CAPTURE_OUT || join(ROOT, 'docs/ux/public-readiness/assets/shipped/breakpoints');
const CHROME =
	process.env.CHROME_BIN ||
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Boundary cascade: compact <640 / medium 640-1023 / wide >=1024, each gated on
// height>=501 (short-landscape falls back to compact). The 639/640/641 and
// 1023/1024/1025 triplets bracket the integer boundaries; the dpr2 flag re-runs a
// boundary at deviceScaleFactor 2 (sub-pixel CSS px). 390-tall short-landscape
// (844x390) is compact by the min-height gate.
const VIEWPORTS = [
	{ w: 375, h: 667, tier: 'compact' }, // iPhone SE — the smallest supported screen (P6)
	{ w: 390, h: 844, tier: 'compact' },
	{ w: 639, h: 900, tier: 'compact' },
	{ w: 640, h: 900, tier: 'medium' },
	{ w: 641, h: 900, tier: 'medium' },
	{ w: 768, h: 1024, tier: 'medium' },
	{ w: 1023, h: 800, tier: 'medium' },
	{ w: 1024, h: 800, tier: 'wide' },
	{ w: 1025, h: 800, tier: 'wide' },
	{ w: 1440, h: 900, tier: 'wide' },
	{ w: 844, h: 390, tier: 'compact' }, // short-landscape -> compact float fallback
	{ w: 640, h: 900, tier: 'medium', dpr: 2 },
	{ w: 1024, h: 800, tier: 'wide', dpr: 2 },
];

function die(msg) {
	console.error(`capture-breakpoints: ${msg}`);
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
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`server not ready at ${url}`);
}

const server = spawn(process.execPath, [join(BUILD, 'index.js')], {
	env: { ...process.env, PORT, HOST: '127.0.0.1', ORIGIN: BASE, NODE_ENV: 'production' },
	stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let browser;
const failures = [];
try {
	await waitReady(`${BASE}/`);
	await mkdir(OUT, { recursive: true });
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

	for (const vp of VIEWPORTS) {
		const page = await browser.newPage({
			viewport: { width: vp.w, height: vp.h },
			deviceScaleFactor: vp.dpr ?? 1,
		});
		await page.goto(`${BASE}/`, { waitUntil: 'load' });
		// Dismiss the guided tour if it auto-opened so the chrome reads cleanly.
		await page.evaluate(() => {
			const b = [...document.querySelectorAll('button')].find((x) => /close tour|skip/i.test(x.textContent || ''));
			b?.click();
		});
		await page.waitForTimeout(1800);
		const m = await page.evaluate(() => {
			const tier = document.documentElement.dataset.layoutTier ?? '(unset)';
			const canvas =
				document.querySelector('[data-tour="map"] canvas') || document.querySelector('canvas.maplibregl-canvas');
			const cr = canvas?.getBoundingClientRect();
			return { tier, canvas: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : null };
		});
		// Stage-width floors: compact/medium use the smoke's min(300, 0.9*vp). WIDE
		// applies the §9 hard 380px floor in the roomy band (>=1366px); the laptop band
		// (1024-1365px) now enforces 300px — W5b trimmed the side columns (19rem/22rem)
		// so the 1fr stage clears ~320px at 1024 instead of the prior 240px remainder.
		const floorW = vp.tier === 'wide' ? (vp.w >= 1366 ? 380 : 300) : Math.min(300, Math.floor(vp.w * 0.9));
		const floorH = Math.min(300, Math.floor(vp.h * 0.9));
		const tierOk = m.tier === vp.tier;
		const canvasOk = m.canvas && m.canvas.w >= floorW && m.canvas.h >= floorH;
		const tag = `${vp.w}x${vp.h}${vp.dpr ? `@${vp.dpr}x` : ''}`;
		const status = tierOk && canvasOk ? 'PASS' : 'FAIL';
		if (!tierOk) failures.push(`${tag}: tier ${m.tier} != expected ${vp.tier}`);
		if (!canvasOk) failures.push(`${tag}: canvas ${JSON.stringify(m.canvas)} below floor ${floorW}x${floorH}`);
		console.log(
			`capture-breakpoints: ${tag} tier=${m.tier} canvas=${JSON.stringify(m.canvas)} floor=${floorW}x${floorH} -> ${status}`,
		);
		// The gate is the tier + canvas-floor assertions above. The screenshot is
		// supplementary (visual review) — the live MapLibre canvas never quiesces for
		// Playwright's font/stability wait, so capture it best-effort and never let a
		// screenshot timeout fail the boundary gate.
		try {
			await page.screenshot({ path: join(OUT, `${tag}.png`), timeout: 12_000, animations: 'disabled' });
		} catch (e) {
			console.log(`capture-breakpoints: ${tag} screenshot skipped (${(e?.message ?? String(e)).split('\n')[0]})`);
		}
		await page.close();
	}
} catch (err) {
	failures.push(`run error: ${err?.message ?? err}`);
} finally {
	if (browser) await browser.close().catch(() => {});
	server.kill();
}

if (failures.length) {
	console.error(`capture-breakpoints: ${failures.length} FAILURE(S):`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log('capture-breakpoints: all boundary viewports PASS (tier + canvas floor)');
process.exit(0);
