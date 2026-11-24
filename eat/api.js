// Public shared pool and eaten-meals log. This handler owns only /eat/api/*; no admin/KV access.
const EAT_ICONS = ['🍜', '🍚', '🥟', '🍲', '🍔', '🍕', '🥗', '🍢', '🥪', '🍣', '🍰', '🧋', '🥣', '🥩', '🍝', '🍳', '🍛', '🥘', '🌮', '🥐', '🥯', '🦞'];
const EAT_POOL_SELECT = 'SELECT revision, shops, updated_at FROM eat_pool WHERE id = 1';
const EAT_POOL_WRITE = `INSERT INTO eat_pool (id, revision, shops, updated_at)
 SELECT 1, 1, ?, ? WHERE ? = 0
 ON CONFLICT(id) DO UPDATE SET shops = excluded.shops,
 revision = eat_pool.revision + 1, updated_at = excluded.updated_at
 WHERE eat_pool.revision = ? RETURNING revision, shops, updated_at`;
const EAT_POOL_UPDATE = `UPDATE eat_pool SET shops = ?, revision = revision + 1, updated_at = ?
 WHERE id = 1 AND revision = ? RETURNING revision, shops, updated_at`;
const EAT_MEALS_TABLE = `CREATE TABLE IF NOT EXISTS eat_meals (
 id TEXT PRIMARY KEY,
 shop_id TEXT,
 name TEXT NOT NULL,
 emoji TEXT NOT NULL,
 dish TEXT NOT NULL DEFAULT '',
 rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
 note TEXT NOT NULL DEFAULT '',
 eaten_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
)`;
const EAT_MEALS_INDEX = 'CREATE INDEX IF NOT EXISTS eat_meals_eaten_at ON eat_meals (eaten_at DESC, created_at DESC)';
const EAT_MEALS_SELECT = 'SELECT id, shop_id, name, emoji, dish, rating, note, eaten_at, created_at FROM eat_meals ORDER BY eaten_at DESC, created_at DESC LIMIT 60';
const EAT_MEALS_INSERT = 'INSERT INTO eat_meals (id, shop_id, name, emoji, dish, rating, note, eaten_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id, shop_id, name, emoji, dish, rating, note, eaten_at, created_at';
const EAT_MEAL_SELECT = 'SELECT id, shop_id, name, emoji, dish, rating, note, eaten_at, created_at FROM eat_meals WHERE id = ?';
const EAT_MEALS_UPDATE = 'UPDATE eat_meals SET shop_id = ?, name = ?, emoji = ?, dish = ?, rating = ?, note = ?, eaten_at = ? WHERE id = ? RETURNING id, shop_id, name, emoji, dish, rating, note, eaten_at, created_at';
const EAT_MEALS_DELETE = 'DELETE FROM eat_meals WHERE id = ?';
const EAT_MEALS_TRIM = 'DELETE FROM eat_meals WHERE id NOT IN (SELECT id FROM eat_meals ORDER BY eaten_at DESC, created_at DESC LIMIT 500)';
const mealsInit = new WeakMap();

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  });
}

function eatPoolData(row) {
  return row ? {
      revision: row.revision,
      shops: JSON.parse(row.shops),
      updatedAt: row.updated_at
    } :
    {
      revision: 0,
      shops: null,
      updatedAt: null
    };
}

function eatValidateShops(shops) {
  const ids = new Set();
  if (!Array.isArray(shops) || shops.length > 100) throw new Error('奖池最多 100 家店');
  return shops.map(s => {
    if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 100 || ids.has(s.id) ||
      typeof s.name !== 'string' || !s.name.trim() || s.name.length > 32 ||
      !EAT_ICONS.includes(s.emoji) || !['随时', '早餐', '午餐', '晚餐', '夜宵'].includes(s.category) ||
      typeof s.note !== 'string' || s.note.length > 80 || typeof s.enabled !== 'boolean' ||
      !(s.price === null || (Number.isInteger(s.price) && s.price >= 0 && s.price <= 9999))) {
      throw new Error('店铺信息格式不正确');
    }
    ids.add(s.id);
    return {
      id: s.id,
      name: s.name.trim(),
      emoji: s.emoji,
      category: s.category,
      price: s.price,
      note: s.note,
      enabled: s.enabled
    };
  });
}

function eatMealRow(row) {
  return {
    id: row.id,
    shopId: row.shop_id ?? null,
    name: row.name,
    emoji: row.emoji,
    dish: row.dish || '',
    rating: row.rating ?? null,
    note: row.note || '',
    eatenAt: Number(row.eaten_at)
  };
}

function eatValidateMeal(input, requireId = false) {
  if (!input || typeof input !== 'object') throw new Error('记录格式不正确');
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : (requireId ? '' : crypto.randomUUID());
  if (!id || id.length > 100) throw new Error('记录标识不正确');
  const shopId = input.shopId === null || input.shopId === undefined || input.shopId === '' ? null : String(input.shopId).trim();
  if (shopId !== null && shopId.length > 100) throw new Error('关联店铺不正确');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 32) throw new Error('请输入食物或店铺名称');
  if (!EAT_ICONS.includes(input.emoji)) throw new Error('请选择有效的美味标记');
  const dish = typeof input.dish === 'string' ? input.dish.trim() : '';
  if (dish.length > 48) throw new Error('菜品名称过长');
  const rating = input.rating === null || input.rating === undefined || input.rating === '' ? null : Number(input.rating);
  if (!(rating === null || (Number.isInteger(rating) && rating >= 1 && rating <= 5))) throw new Error('评分需为 1 至 5 星');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 120) throw new Error('评价备注过长');
  const eatenAt = input.eatenAt === undefined || input.eatenAt === null || input.eatenAt === '' ? Date.now() : Number(input.eatenAt);
  if (!Number.isFinite(eatenAt) || eatenAt <= 0 || eatenAt > 8640000000000000) throw new Error('用餐时间不正确');
  return {
    id,
    shopId,
    name: input.name.trim(),
    emoji: input.emoji,
    dish,
    rating,
    note,
    eatenAt: Math.trunc(eatenAt)
  };
}

async function ensureMealsTable(binding, db) {
  if (!mealsInit.has(binding)) {
    const ready = (async () => {
      const tableStmt = db.prepare(EAT_MEALS_TABLE);
      if (typeof tableStmt.run === 'function') {
        await tableStmt.run();
        await db.prepare(EAT_MEALS_INDEX).run();
      } else if (typeof tableStmt.first === 'function') {
        await tableStmt.first();
        await db.prepare(EAT_MEALS_INDEX).first();
      }
    })();
    mealsInit.set(binding, ready);
    ready.catch(() => mealsInit.delete(binding));
  }
  await mealsInit.get(binding);
}

async function readJsonBody(request, maxBytes) {
  if (Number(request.headers.get('Content-Length')) > maxBytes) {
    const err = new Error('TOO_LARGE');
    err.status = 413;
    throw err;
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error('MISSING');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      const err = new Error('TOO_LARGE');
      err.status = 413;
      throw err;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function eatMealsAPI(request, env) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return json({
    error: '不支持的请求方法'
  }, 405, {
    'Allow': 'GET, POST, PUT, DELETE'
  });
  if (!env.EAT_DB) return json({
    error: '共享数据库尚未连接，请配置 EAT_DB 绑定',
    code: 'NOT_CONFIGURED'
  }, 503);
  if (request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({
      error: '请从本站修改美食足迹'
    }, 403);
  }
  let payload, targetId;
  if (request.method === 'DELETE') {
    targetId = (new URL(request.url).searchParams.get('id') || '').trim();
    if (!targetId || targetId.length > 100) return json({ error: '缺少有效的记录标识' }, 400);
  } else if (request.method === 'POST' || request.method === 'PUT') {
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({
      error: '需要 JSON 数据'
    }, 415);
    try {
      const raw = await readJsonBody(request, 24000);
      payload = eatValidateMeal(raw, request.method === 'PUT');
    } catch (error) {
      if (error.status === 413) return json({ error: '数据过大' }, 413);
      return json({ error: error.message && error.message !== 'MISSING' ? error.message : '请求数据不正确，请检查美食记录' }, 400);
    }
  }
  try {
    const db = env.EAT_DB.withSession('first-primary');
    await ensureMealsTable(env.EAT_DB, db);
    const listMeals = async () => {
      const stmt = db.prepare(EAT_MEALS_SELECT);
      const rows = typeof stmt.all === 'function' ? ((await stmt.all())?.results || []) : [];
      return rows.map(eatMealRow);
    };
    if (request.method === 'GET') {
      const meals = await listMeals();
      return json({ meals });
    }
    if (request.method === 'POST') {
      const now = Date.now();
      let row = await db.prepare(EAT_MEALS_INSERT)
        .bind(payload.id, payload.shopId, payload.name, payload.emoji, payload.dish, payload.rating, payload.note, payload.eatenAt, now)
        .first();
      if (!row) {
        row = await db.prepare(EAT_MEAL_SELECT).bind(payload.id).first();
        if (!row) throw new Error('Meal disappeared during retry');
        const stored = eatMealRow(row);
        if (Object.keys(payload).some(key => stored[key] !== payload[key])) {
          return json({ error: '这条记录已经保存，请在清单中编辑已有记录', code: 'ALREADY_EXISTS', meals: await listMeals() }, 409);
        }
        return json({ meal: stored, meals: await listMeals() });
      }
      const trimStmt = db.prepare(EAT_MEALS_TRIM);
      if (typeof trimStmt.run === 'function') await trimStmt.run();
      else if (typeof trimStmt.first === 'function') await trimStmt.first();
      return json({ meal: eatMealRow(row), meals: await listMeals() });
    }
    if (request.method === 'PUT') {
      const row = await db.prepare(EAT_MEALS_UPDATE)
        .bind(payload.shopId, payload.name, payload.emoji, payload.dish, payload.rating, payload.note, payload.eatenAt, payload.id)
        .first();
      if (!row) return json({ error: '这条记录已被删除', code: 'NOT_FOUND', meals: await listMeals() }, 404);
      return json({ meal: eatMealRow(row), meals: await listMeals() });
    }
    const delStmt = db.prepare(EAT_MEALS_DELETE).bind(targetId);
    if (typeof delStmt.run === 'function') await delStmt.run();
    else if (typeof delStmt.first === 'function') await delStmt.first();
    return json({ deleted: targetId, meals: await listMeals() });
  } catch (error) {
    console.error('Eat meals database operation failed');
    return json({
      error: '共享数据库暂不可用，请检查绑定和数据表，稍后重试',
      code: 'DATABASE_UNAVAILABLE'
    }, 503);
  }
}
export async function eatPoolAPI(request, env) {
  if (!['GET', 'PUT'].includes(request.method)) return json({
    error: '不支持的请求方法'
  }, 405, {
    'Allow': 'GET, PUT'
  });
  if (!env.EAT_DB) return json({
    error: '共享数据库尚未连接，请配置 EAT_DB 绑定',
    code: 'NOT_CONFIGURED'
  }, 503);
  let body;
  if (request.method === 'PUT') {
    const origin = request.headers.get('Origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({
      error: '请从本站修改奖池'
    }, 403);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({
      error: '需要 JSON 数据'
    }, 415);
    try {
      body = await readJsonBody(request, 100000);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('缺少有效的菜单版本');
      body.shops = eatValidateShops(body.shops);
    } catch (error) {
      if (error.status === 413) return json({ error: '数据过大' }, 413);
      return json({
        error: error.message === 'MISSING' ? '缺少请求数据' : '请求数据不正确，请检查店铺信息'
      }, 400)
    }
  }
  try {
    const db = env.EAT_DB.withSession('first-primary');
    if (request.method === 'GET') {
      const data = eatPoolData(await db.prepare(EAT_POOL_SELECT).first());
      const etag = `"eat-pool-${data.revision}"`;
      // Always check D1 for freshness; only skip sending an unchanged menu body.
      if (request.headers.get('If-None-Match') === etag) return new Response(null, {
        status: 304,
        headers: { 'ETag': etag, 'Cache-Control': 'no-store' }
      });
      return json(data, 200, { 'ETag': etag })
    }
    const now = new Date().toISOString(),
      encoded = JSON.stringify(body.shops);
    const row = body.revision === 0 ?
      await db.prepare(EAT_POOL_WRITE).bind(encoded, now, 0, 0).first() :
      await db.prepare(EAT_POOL_UPDATE).bind(encoded, now, body.revision).first();
    if (!row) return json({
      error: '奖池刚被其他人修改，请查看最新内容后再保存',
      code: 'CONFLICT',
      ...eatPoolData(await db.prepare(EAT_POOL_SELECT).first())
    }, 409);
    return json(eatPoolData(row));
  } catch (error) {
    console.error('Eat database operation failed');
    return json({
      error: '共享数据库暂不可用，请检查绑定和数据表，稍后重试',
      code: 'DATABASE_UNAVAILABLE'
    }, 503);
  }
}
