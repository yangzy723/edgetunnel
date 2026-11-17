import { DRAW_DEFAULTS, validateDrawConfig, pickDrawGift } from './model.js';

const VISITOR_COOKIE = '__Host-draw_visitor';
const visitorToken = request => (request.headers.get('Cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(VISITOR_COOKIE+'='))?.slice(VISITOR_COOKIE.length+1);
const COOKIE = '__Host-draw_admin';
const SELECT = 'SELECT revision, config, updated_at FROM draw_config WHERE id = 1';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}
});
const data = row => ({revision:row.revision,config:validateDrawConfig(JSON.parse(row.config)),updatedAt:row.updated_at});
const initialized = new WeakMap();

async function database(binding) {
  if (!binding) throw Error('DATABASE');
  const db = binding.withSession('first-primary');
  if (!initialized.has(binding)) {
    const ready = (async () => {
      await db.prepare('CREATE TABLE IF NOT EXISTS draw_config (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
      await db.prepare('CREATE TABLE IF NOT EXISTS draw_visitors (id TEXT PRIMARY KEY, result TEXT)').run();
      await db.prepare('CREATE TABLE IF NOT EXISTS draw_auth_attempts (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL)').run();
      await db.prepare('INSERT OR IGNORE INTO draw_config (id, revision, config, updated_at) VALUES (1, 1, ?, ?)')
        .bind(JSON.stringify(DRAW_DEFAULTS),new Date().toISOString()).run();
    })();
    initialized.set(binding, ready);
    ready.catch(() => initialized.delete(binding));
  }
  await initialized.get(binding);
  return db;
}
async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw Error('JSON');
  const reader = request.body?.getReader();
  if (!reader) throw Error('JSON');
  let length = 0; const chunks = [];
  while (true) {
    const {done,value} = await reader.read(); if(done) break;
    length += value.byteLength;
    if(length > 24000) { await reader.cancel(); throw Error('TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for(const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
const encode = value => new TextEncoder().encode(value);
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2,'0')).join('');
async function digest(text) { return hex(await crypto.subtle.digest('SHA-256',encode(text))); }
function equal(a,b) {
  if(a.length !== b.length) return false;
  let diff = 0; for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff === 0;
}
async function signature(password,message) {
  const key = await crypto.subtle.importKey('raw',encode(password),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encode('draw-admin-v1:' + message)));
}
async function authorized(request,password) {
  const token = (request.headers.get('Cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token || token.length > 160) return false;
  const [expiry,nonce,mac,...rest] = token.split('.');
  const now = Math.floor(Date.now()/1000);
  if(rest.length || !/^\d{10}$/.test(expiry) || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(mac || '') || Number(expiry) <= now || Number(expiry) > now+1800) return false;
  return equal(mac,await signature(password,expiry+'.'+nonce));
}
function cookie(value,age=1800) { return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`; }
function pick(count) {
  const random = new Uint32Array(1), limit = Math.floor(4294967296/count)*count;
  do { crypto.getRandomValues(random); } while(random[0]>=limit);
  return random[0]%count;
}

export async function drawAPI(request,env) {
  const path = new URL(request.url).pathname, method = request.method;
  const methods = path === '/draw/api/config' ? ['GET','PUT'] : path === '/draw/api/auth' ? ['GET','POST','DELETE'] : path === '/draw/api/draw' ? ['POST'] : path === '/draw/api/participation' ? ['GET'] : [];
  if(!methods.length) return json({error:'接口不存在'},404);
  if(!methods.includes(method)) return json({error:'不支持的请求方法'},405,{Allow:methods.join(', ')});
  if(method !== 'GET') {
    const origin = request.headers.get('Origin');
    if((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({error:'请从本站操作'},403);
  }
  if(path === '/draw/api/auth' && method === 'DELETE') return json({authenticated:false},200,{'Set-Cookie':cookie('',0)});
  try {
    let password;
    if(path === '/draw/api/auth' || method === 'PUT') {
      password = env.DRAW_ADMIN_PASSWORD;
      if(typeof password !== 'string' || !password.length) return json({error:'管理密码尚未配置，请在变量和密钥中设置 DRAW_ADMIN_PASSWORD',code:'AUTH_NOT_CONFIGURED'},503);
      if(method !== 'POST') {
        const authenticated = await authorized(request,password);
        if(path === '/draw/api/auth') return json({authenticated});
        if(!authenticated) return json({error:'管理验证已失效，请重新输入密码',code:'UNAUTHORIZED'},401);
      }
    }
    const db = await database(env.DRAW_DB || env.EAT_DB);
    if(path === '/draw/api/auth') {
      const attempt = await body(request);
      if(typeof attempt?.password !== 'string' || attempt.password.length > 256) return json({error:'请输入有效的管理密码'},400);
      const now = Math.floor(Date.now()/1000), id = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
      await db.prepare('DELETE FROM draw_auth_attempts WHERE expires <= ?').bind(now).run();
      const row = await db.prepare('INSERT INTO draw_auth_attempts (id, attempts, expires) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1 RETURNING attempts')
        .bind(id,now+900).first();
      if(row.attempts > 10) return json({error:'尝试次数过多，请 15 分钟后再试'},429,{'Retry-After':'900'});
      if(!equal(await digest(attempt.password),await digest(password))) return json({error:'管理密码不正确'},401);
      await db.prepare('DELETE FROM draw_auth_attempts WHERE id = ?').bind(id).run();
      const message = (now+1800)+'.'+hex(crypto.getRandomValues(new Uint8Array(16)));
      return json({authenticated:true},200,{'Set-Cookie':cookie(message+'.'+await signature(password,message))});
    }
    if(method === 'PUT') {
      const input = await body(request);
      if(!Number.isSafeInteger(input?.revision) || input.revision < 1) return json({error:'缺少有效的奖池版本'},400);
      let config;
      try { config = validateDrawConfig(input.config); } catch(error) { return json({error:error.message},400); }
      const row = await db.prepare('UPDATE draw_config SET config = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING revision, config, updated_at')
        .bind(JSON.stringify(config),new Date().toISOString(),input.revision).first();
      if(!row) return json({error:'其他管理员已更新奖池。你的修改已保留，请加载最新版后再修改。',code:'CONFLICT',...data(await db.prepare(SELECT).first())},409);
      return json(data(row));
    }
    let visitor, visitorId;
    if(path === '/draw/api/participation' || path === '/draw/api/draw') {
      const token = visitorToken(request);
      if(/^[a-f0-9]{64}$/.test(token || '')) {
        visitorId = await digest(token);
        visitor = await db.prepare('SELECT result FROM draw_visitors WHERE id = ?').bind(visitorId).first();
      }
      if(path === '/draw/api/participation') {
        if(visitor) return json({result:visitor.result ? JSON.parse(visitor.result) : null});
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        await db.prepare('INSERT INTO draw_visitors (id, result) VALUES (?, NULL)').bind(await digest(token)).run();
        return json({result:null},200,{'Set-Cookie':`${VISITOR_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`});
      }
      if(!visitor) return json({error:'请允许本站 Cookie，并刷新页面后再试',code:'VISITOR_REQUIRED'},401);
    }
    const current = data(await db.prepare(SELECT).first());
    if(path === '/draw/api/draw') {
      if(visitor.result) return json({...current,...JSON.parse(visitor.result),alreadyDrawn:true});
      if(!current.config.activityEnabled) return json({error:'活动已暂停，请稍后再来',code:'PAUSED',...current},409);
      const gifts = current.config.gifts.filter(gift => gift.enabled);
      if(!gifts.length) return json({error:'好礼正在准备中，请稍后再来',code:'EMPTY',...current},409);
      const result = {winner:pickDrawGift(gifts,pick),time:Date.now(),showQuantity:current.config.showQuantity};
      // Only one concurrent request may claim this anonymous credential.
      const claimed = await db.prepare('UPDATE draw_visitors SET result = ? WHERE id = ? AND result IS NULL RETURNING result')
        .bind(JSON.stringify(result),visitorId).first();
      const stored = claimed || await db.prepare('SELECT result FROM draw_visitors WHERE id = ?').bind(visitorId).first();
      return json({...current,...JSON.parse(stored.result),alreadyDrawn:!claimed});
    }
    const etag = `"draw-config-weighted-v1-${current.revision}"`;
    if(request.headers.get('If-None-Match') === etag) return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'no-store'}});
    return json(current,200,{ETag:etag});
  } catch(error) {
    if(error.message === 'TOO_LARGE') return json({error:'数据过大'},413);
    if(error.message === 'JSON' || error instanceof SyntaxError) return json({error:'请求数据格式不正确'},400);
    return json({error:'云端服务暂不可用，请检查 D1 绑定和管理密码配置并重试',code:'UNAVAILABLE'},503);
  }
}
