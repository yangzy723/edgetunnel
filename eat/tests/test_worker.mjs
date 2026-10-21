import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.PYTHON || 'python3';
const build = (mode, out) => execFileSync(python, [join(root, 'eat/build.py'), '--mode', mode, '--out', out]);

async function fixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'eat-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, mode);
  build(mode, out);
  return { dir, out, modules: join(out, '_worker.js') };
}

 test('combined build keeps upstream byte-identical and is repeatable', async t => {
  const { out, modules } = await fixture(t, 'combined');
  const original = await readFile(join(root, '_worker.js'));
  assert.deepEqual(await readFile(join(modules, 'upstream.js')), original);
  const files = await readdir(modules);
  const initial = await Promise.all(files.map(name => readFile(join(modules, name))));
  build('combined', out);
  assert.deepEqual(await readdir(modules), files);
  assert.deepEqual(await Promise.all(files.map(name => readFile(join(modules, name)))), initial);
  assert.deepEqual(await readFile(join(root, '_worker.js')), original);
  // Import the real upstream bundle with the production adapter, without calling proxy code.
  const { default: worker } = await import(pathToFileURL(join(modules, 'index.js')));
  for (const path of ['/eat', '/eat/']) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), {}, {});
    assert.equal(response.status, 200);
    assert.match(await response.text(), /大家的美味奖池/);
  }
  const head = await worker.fetch(new Request('https://example.test/eat', { method: 'HEAD' }), {}, {});
  assert.equal(await head.text(), '');
  const api = await worker.fetch(new Request('https://example.test/eat/api/pool'), {}, {});
  assert.equal(api.status, 503);
  assert.equal((await api.json()).code, 'NOT_CONFIGURED');
  const mealsApi = await worker.fetch(new Request('https://example.test/eat/api/meals'), {}, {});
  assert.equal(mealsApi.status, 503);
  assert.equal((await mealsApi.json()).code, 'NOT_CONFIGURED');
});

 test('adapter forwards untouched requests and preserves upstream exports/handlers', async t => {
  const { modules } = await fixture(t, 'combined');
  // A future upstream may rename variables or export a separate object: no source rewriting needed.
  await writeFile(join(modules, 'upstream.js'), `
    export class FutureBinding {};
    const service = {
      marker: 42,
      scheduled() { return 123; },
      async fetch(request, env, ctx) {
        if (this !== service) throw Error('Lost upstream receiver');
        env.received = {request, ctx};
        return env.result;
      }
    };
    export default service;
  `);
  const imported = await import(pathToFileURL(join(modules, 'index.js')));
  const worker = imported.default;
  assert.equal(typeof imported.FutureBinding, 'function');
  assert.equal(worker.scheduled(), 123);
  for (const [path, method, headers] of [
    ['/admin', 'GET'], ['/admin/config.json', 'POST'], ['/sub?token=x', 'GET'],
    ['/eatery', 'GET'], ['/eat/assets/missing', 'GET'], ['/eat', 'POST'],
    ['/eat', 'GET', { Upgrade: 'websocket' }],
    ['/eat/api/pool', 'GET', { Upgrade: 'websocket' }],
    ['/draw', 'GET'], ['/draw/', 'GET'], ['/draw/api/config', 'GET'],
    ['/draw/api/draw', 'POST'], ['/music', 'GET'], ['/music/Test-A/', 'GET'],
    ['/Test-A', 'GET'], ['/drawing', 'GET'], ['/draw/assets/missing', 'GET'], ['/draw', 'POST'],
    ['/draw', 'GET', { Upgrade: 'websocket' }],
  ]) {
    const request = new Request(`https://example.test${path}`, { method, headers, body: method === 'POST' ? 'unchanged' : undefined });
    const result = new Response('upstream');
    const env = { result }, ctx = {};
    assert.equal(await worker.fetch(request, env, ctx), result);
    assert.equal(env.received.request, request);
    assert.equal(env.received.ctx, ctx);
    if (method === 'POST') assert.equal(await request.text(), 'unchanged');
  }
});

 test('standalone output has no upstream dependency and serves its own root', async t => {
  const { modules } = await fixture(t, 'standalone');
  assert.ok(!(await readdir(modules)).includes('upstream.js'));
  const { default: worker } = await import(pathToFileURL(join(modules, 'index.js')));
  const rootResponse = await worker.fetch(new Request('https://example.test/'), {}, {});
  assert.equal(rootResponse.status, 302);
  assert.equal(rootResponse.headers.get('Location'), 'https://example.test/eat');
  assert.equal((await worker.fetch(new Request('https://example.test/eat'), {}, {})).status, 200);
  assert.equal((await worker.fetch(new Request('https://example.test/admin'), {}, {})).status, 404);
});

test('pool revalidation returns no menu body and new food icons survive saves', async t => {
  const { modules } = await fixture(t, 'standalone');
  const { eatPoolAPI } = await import(pathToFileURL(join(modules, 'api.js')));
  let row = { revision: 3, shops: '[]', updated_at: 'today' };
  const env = { EAT_DB: { withSession() { return { prepare(query) {
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async first() {
        if (query.startsWith('UPDATE')) row = { ...row, revision: row.revision + 1, shops: this.args[0] };
        return row;
      }
    };
  } }; } } };
  const url = 'https://example.test/eat/api/pool';
  const first = await eatPoolAPI(new Request(url), env);
  assert.equal(first.headers.get('ETag'), '"eat-pool-3"');
  assert.equal((await first.json()).revision, 3);
  const unchanged = await eatPoolAPI(new Request(url, { headers: { 'If-None-Match': '"eat-pool-3"' } }), env);
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(unchanged.headers.get('Cache-Control'), 'no-store');
  const shops = ['🥣', '🥩', '🍝', '🍳', '🍛', '🥘', '🌮', '🥐', '🥯', '🦞'].map((emoji, i) => ({
    id: String(i), name: '美味 ' + i, emoji, category: '随时', price: null, note: '', enabled: true
  }));
  const saved = await eatPoolAPI(new Request(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 3, shops })
  }), env);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).shops, shops);
  const changed = await eatPoolAPI(new Request(url, { headers: { 'If-None-Match': '"eat-pool-3"' } }), env);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('ETag'), '"eat-pool-4"');
});

test('HTML revalidation skips unchanged content and sends the current page for stale tags', async t => {
  const { modules } = await fixture(t, 'standalone');
  const { default: worker } = await import(pathToFileURL(join(modules, 'index.js')));
  const request = (headers = {}, method = 'GET') => new Request('https://example.test/eat', { headers, method });
  const first = await worker.fetch(request(), {}, {});
  const html = await first.text();
  const etag = first.headers.get('ETag');
  assert.equal(etag, '"eat-page-' + createHash('sha256').update(html).digest('hex').slice(0, 24) + '"');
  for (const tag of [etag, `W/${etag}`, `"older", ${etag}`]) {
    const cached = await worker.fetch(request({ 'If-None-Match': tag }), {}, {});
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
    assert.equal(cached.headers.get('Cache-Control'), 'no-cache');
    assert.equal(cached.headers.get('ETag'), etag);
  }
  const changed = await worker.fetch(request({ 'If-None-Match': '"previous-build"' }), {}, {});
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), html);
  const head = await worker.fetch(request({}, 'HEAD'), {}, {});
  assert.equal(head.headers.get('ETag'), etag);
  assert.equal(await head.text(), '');
});

test('rebuilding removes retired activity assets and excludes activity modules', async t => {
  const { out, modules } = await fixture(t, 'standalone');
  for (const name of ['draw', 'music']) {
    await mkdir(join(out, name), { recursive: true });
    await writeFile(join(out, name, 'old.html'), 'retired activity');
  }
  build('standalone', out);
  const files = await readdir(out);
  assert.ok(!files.includes('draw') && !files.includes('music'));
  assert.deepEqual((await readdir(modules)).sort(), ['api.js', 'index.js', 'page.js', 'worker.js']);
  assert.deepEqual(JSON.parse(await readFile(join(out, '_routes.json'), 'utf8')).exclude, []);
  const { default: worker } = await import(pathToFileURL(join(modules, 'index.js')));
  for (const path of ['/draw', '/draw/api/config', '/music', '/music/Test-A/', '/Test-A']) {
    assert.equal((await worker.fetch(new Request('https://example.test' + path), {}, {})).status, 404);
  }
});
