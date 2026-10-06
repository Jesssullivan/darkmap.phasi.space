import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureProxy, storageFault } from './real-sw-fixtures.mjs';

const [appRoot, baseUrl, artifactDir, sourceSha, imageDigest] = process.argv.slice(2);
assert(/^[0-9a-f]{40}$/.test(sourceSha ?? '') && /^sha256:[0-9a-f]{64}$/.test(imageDigest ?? ''));
assert(appRoot && artifactDir && process.env.CHROME_BIN);
const { chromium } = createRequire(path.join(path.resolve(appRoot), 'package.json'))('@playwright/test');
await mkdir(artifactDir, { recursive: true });
const result = { sourceSha, imageDigest, startedAt: new Date().toISOString(),
  boundary: 'Actual image compiled SW; controlled synthetic local raster bytes, not provider/scientific measurement proof.', checks: [] };
let proxy, browser, context, worker, page;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  proxy = await fixtureProxy(baseUrl);
  const original = await fetch(new URL('/service-worker.js', baseUrl));
  assert.equal(original.status, 200);
  const bytes = Buffer.from(await original.arrayBuffer());
  result.workerSha256 = hash(bytes);
  assert.match(original.headers.get('content-type') ?? '', /javascript/);
  assert.equal(hash(Buffer.from(await (await fetch(proxy.origin + '/service-worker.js')).arrayBuffer())), result.workerSha256);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ serviceWorkers: 'allow' });
  result.console = []; result.pageErrors = []; result.requestFailures = []; result.workerEvents = [];
  context.on('serviceworker', value => result.workerEvents.push({ url: value.url(), at: new Date().toISOString() }));
  context.on('requestfailed', request => result.requestFailures.push({ url: new URL(request.url()).pathname, error: request.failure()?.errorText, worker: !!request.serviceWorker() }));
  await context.addInitScript(() => {
    globalThis.__operatorRegistration = [];
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const original = sw.register.bind(sw);
    sw.register = (...args) => {
      const event = { url: String(args[0]), at: Date.now(), state: 'called' };
      globalThis.__operatorRegistration.push(event);
      // Observe the application's call; never register independently or change arguments.
      return original(...args).then(reg => { event.state = 'resolved'; return reg; }, error => {
        event.state = 'rejected'; event.error = String(error); throw error;
      });
    };
  });
  result.workerFixtureRequests = 0;
  context.on('request', request => {
    if (request.url().includes('/api/raster?') && request.url().includes('operator_fixture=1') && request.serviceWorker())
      result.workerFixtureRequests++;
  });
  await context.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
  await context.route('**/*', route => new URL(route.request().url()).origin === proxy.origin ? route.continue() : route.abort('blockedbyclient'));
  page = await context.newPage();
  page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.goto(proxy.origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 45000 });
  result.controller = await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready;
    return { url: navigator.serviceWorker.controller.scriptURL, state: registration.active.state }; });
  assert.equal(result.controller.url, proxy.origin + '/service-worker.js');
  assert.equal(result.controller.state, 'activated');
  worker = context.serviceWorkers().find(value => value.url() === result.controller.url);
  assert(worker, 'original activated worker available');
  result.registrationOnly = process.env.SW_REGISTRATION_DIAGNOSTIC === '1';
  if (!result.registrationOnly) {
  const url = '/api/raster?operator_fixture=1&z=0&x=0&y=0';
  const reordered = '/api/raster?y=0&x=0&z=0&operator_fixture=1';
  const get = value => page.evaluate(async value => { const response = await fetch(value);
    return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) }; }, value);
  const expire = () => page.evaluate(async value => { const cache = await caches.open('darkmap-raster-tile');
    const keys = await cache.keys(); const key = keys.find(key => key.url.includes('operator_fixture=1'));
    if (!key) throw new Error('actual runtime cache entry missing');
    const response = await cache.match(key); const headers = new Headers(response.headers);
    headers.set('x-darkmap-cached-at', String(Date.now() - 120000));
    await cache.put(key, new Response(await response.arrayBuffer(), { headers }));
    return headers.get('x-darkmap-cached-at'); }, url);
  assert.equal((await get(url)).body.version, 1);
  const fresh = await get(reordered);
  assert.equal(fresh.body.version, 1); assert.equal(fresh.headers['x-darkmap-runtime-cache'], 'fresh'); assert.equal(proxy.state.hits, 1);
  result.checks.push('normalized fresh hit');
  await context.setOffline(true); assert.equal((await get(url)).body.version, 1);
  const expiredAt = await expire(); const stale = await get(url);
  assert.equal(stale.headers['x-darkmap-runtime-cache'], 'stale'); assert.match(stale.headers.warning, /110/);
  assert.equal(stale.headers['x-darkmap-cached-at'], expiredAt); assert(Number(stale.headers.age) >= 120);
  result.checks.push('warm offline and expired stale age/write-time');
  await context.setOffline(false); proxy.state.version = 2;
  const before = proxy.state.hits; const refreshed = await Promise.all([get(url), get(reordered)]);
  assert(refreshed.every(value => value.body.version === 2)); assert.equal(proxy.state.hits - before, 1);
  result.checks.push('normalized concurrent refresh coalescing');
  const failedRefreshAt = await expire(); proxy.state.status = 503;
  const failedRefresh = await get(url);
  assert.equal(failedRefresh.body.version, 2);
  assert.equal(failedRefresh.headers['x-darkmap-runtime-cache'], 'stale');
  assert.equal(failedRefresh.headers['x-darkmap-cached-at'], failedRefreshAt);
  result.checks.push('failed refresh preserves stale bytes/time');
  proxy.state.status = 200;
  const stored = () => page.evaluate(async () => { const cache = await caches.open('darkmap-raster-tile');
    const key = (await cache.keys()).find(key => key.url.includes('operator_fixture=1'));
    const response = await cache.match(key); return { body: await response.json(), at: response.headers.get('x-darkmap-cached-at') }; });
  for (const mode of ['open', 'match', 'put']) {
    await expire(); proxy.state.version++;
    const prior = await stored();
    await worker.evaluate(storageFault, mode);
    try { assert.equal((await get(url)).body.version, proxy.state.version); }
    finally { await worker.evaluate(storageFault, 'restore'); }
    if (mode === 'put') assert.deepEqual(await stored(), prior, 'quota denial preserves prior stored bytes/time');
    result.checks.push(`${mode} denial keeps successful network bytes`);
  }
  await worker.evaluate(storageFault, 'open');
  try { assert.equal((await page.goto(proxy.origin, { waitUntil: 'domcontentloaded' })).status(), 200); }
  finally { await worker.evaluate(storageFault, 'restore'); }
  result.checks.push('navigation storage denial preserves actual image HTML');
  await expire(); proxy.state.version++;
  assert.equal((await get(url)).body.version, proxy.state.version);
  await context.setOffline(true); assert.equal((await get(url)).body.version, proxy.state.version);
  const miss = await page.evaluate(async () => { try { await fetch('/api/raster?operator_fixture=1&z=1&x=1&y=1'); return false; } catch { return true; } });
  assert(miss, 'offline uncached miss must fail truthfully');
  result.checks.push('storage recovery and truthful offline miss');
  assert(result.workerFixtureRequests > 0, 'fixture network requests genuinely originated in actual service worker');
  }
  result.fixtureCounts = { ...proxy.state }; result.passed = true;
} catch (error) { result.passed = false; result.error = error.stack; process.exitCode = 1; }
finally {
  if (page) result.registrationDiagnostic = await page.evaluate(async () => ({
    secureContext: window.isSecureContext, controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
    appCalls: globalThis.__operatorRegistration, registrations: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map(reg => ({
      scope: reg.scope, installing: reg.installing?.state, waiting: reg.waiting?.state, active: reg.active?.state,
      script: (reg.active ?? reg.installing ?? reg.waiting)?.scriptURL })) : [],
  })).catch(error => ({ error: String(error) }));
  if (proxy) result.fixtureCounts = { ...proxy.state };
  if (worker) await worker.evaluate(storageFault, 'restore').catch(() => {});
  if (context) await context.setOffline(false).catch(() => {});
  if (browser) await browser.close(); if (proxy) await proxy.close();
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifactDir, 'real-sw-result.json'), JSON.stringify(result, null, 2) + '\n');
}
