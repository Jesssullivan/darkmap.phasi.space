import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { fixtureProxy, storageFault } from './real-sw-fixtures.mjs';

test('proxy preserves compiled bytes and fences all provider APIs', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; res.setHeader('content-type', 'application/javascript'); res.end('/* actual compiled worker fixture */'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await fixtureProxy(`http://127.0.0.1:${server.address().port}`);
  try {
    assert.equal(await (await fetch(proxy.origin + '/service-worker.js')).text(), '/* actual compiled worker fixture */');
    assert.equal((await (await fetch(proxy.origin + '/api/raster?operator_fixture=1')).json()).version, 1);
    assert.equal((await fetch(proxy.origin + '/api/atmospheric/openaq')).status, 503);
    assert.equal(calls, 1); assert.equal(proxy.state.hits, 1); assert.equal(proxy.state.denied, 1);
  } finally { await proxy.close(); await new Promise(resolve => server.close(resolve)); }
});

for (const mode of ['open', 'match', 'put']) test(`worker ${mode} fault restores exact original`, async () => {
  const sandbox = vm.createContext({ DOMException });
  vm.runInContext('class CacheStorage { async open() { return 7; } }; class Cache { async match() { return 8; } async put() { return 9; } }; globalThis.CacheStorage=CacheStorage; globalThis.Cache=Cache;', sandbox);
  const fault = vm.runInContext(`(${storageFault.toString()})`, sandbox);
  fault(mode);
  await assert.rejects(vm.runInContext(mode === 'open' ? 'new CacheStorage().open()' : `new Cache().${mode}()`, sandbox), { name: mode === 'put' ? 'QuotaExceededError' : 'SecurityError' });
  fault('restore');
  assert.equal(await vm.runInContext(mode === 'open' ? 'new CacheStorage().open()' : `new Cache().${mode}()`, sandbox), { open: 7, match: 8, put: 9 }[mode]);
});
