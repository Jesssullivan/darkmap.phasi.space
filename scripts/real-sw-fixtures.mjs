import assert from 'node:assert/strict';
import http from 'node:http';

export async function fixtureProxy(baseUrl) {
  const base = new URL(baseUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
  assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password);
  const state = { version: 1, status: 200, hits: 0, denied: 0, upstreamFailures: [] };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/raster' && url.searchParams.get('operator_fixture') === '1') {
          state.hits++;
          res.writeHead(state.status, { 'content-type': 'application/json', 'cache-control': 'max-age=60' });
          res.end(JSON.stringify({ operatorFixture: true, version: state.version }));
        } else { state.denied++; res.writeHead(503); res.end('operator provider fence'); }
        return;
      }
      const upstream = await fetch(new URL(req.url, base), { redirect: 'manual' });
      if (!upstream.ok) state.upstreamFailures.push({ path: url.pathname, status: upstream.status });
      const headers = Object.fromEntries(upstream.headers);
      delete headers['content-encoding']; delete headers['content-length'];
      // Browser and worker external fetches are fenced, including worker fetches
      // invisible to page.route. Same-origin assets and APIs remain available.
      headers['content-security-policy'] = "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'self'; worker-src 'self' blob:";
      res.writeHead(upstream.status, headers); res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(502); res.end('local fixture proxy upstream failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

// Serialized into the ORIGINAL compiled worker after activation. No worker
// source replacement; save and restore every modified prototype descriptor.
export function storageFault(mode) {
  globalThis.__operatorStorageOriginals ??= [];
  for (const [prototype, name, descriptor] of globalThis.__operatorStorageOriginals.splice(0))
    Object.defineProperty(prototype, name, descriptor);
  if (mode === 'restore') return;
  const prototype = mode === 'open' ? CacheStorage.prototype : Cache.prototype;
  const name = mode === 'open' ? 'open' : mode;
  if (!['open', 'match', 'put'].includes(name)) throw new Error('unknown storage fault');
  globalThis.__operatorStorageOriginals.push([prototype, name, Object.getOwnPropertyDescriptor(prototype, name)]);
  Object.defineProperty(prototype, name, { configurable: true, writable: true,
    value: async () => { throw new DOMException('operator storage denial', name === 'put' ? 'QuotaExceededError' : 'SecurityError'); } });
}
