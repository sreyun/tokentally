/**
 * 百炼 API Key 费用分析 - Web 服务
 * 零第三方依赖：node:http + node:sqlite + node:crypto
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { Store } from './db.mjs';
import { SyncService, todayIn, addDays, addMonths, isCycleFinal } from './sync.mjs';
import { selfTest, AliyunClient, explainAliyunError, callLog, MS_REGIONS, BSS_ENDPOINTS } from './aliyun.mjs';
import { loadMasterKey, hashPassword, verifyPassword, burnPasswordCheck, checkPasswordPolicy, randomPassword, maskId, sha256 } from './crypto.mjs';

const VERSION = '1.0.0';
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (process.argv.includes('--selftest')) {
  const ok = selfTest();
  console.log(ok ? 'ACS3-HMAC-SHA256 签名自检通过' : '签名自检失败');
  process.exit(ok ? 0 : 1);
}
if (!selfTest()) { console.error('ACS3-HMAC-SHA256 签名自检失败，服务未启动'); process.exit(1); }

/* ===================================================================
 * 初始化：数据目录、主密钥、数据库、管理员、AccessKey
 * =================================================================== */
fs.mkdirSync(config.dataDir, { recursive: true });
const master = loadMasterKey(config.dataDir, config.masterKey);
const store = new Store(path.join(config.dataDir, 'bailian-cost.db'), master.key);
store.failStaleRuns();

function secretState() {
  try { return store.getSecret('aliyun.accessKeyId') && store.getSecret('aliyun.accessKeySecret') ? 'ok' : 'none'; }
  catch { return 'undecryptable'; }
}

if (store.countUsers() === 0) {
  const generated = !config.adminPassword;
  const pw = config.adminPassword || randomPassword();
  const err = generated ? '' : checkPasswordPolicy(pw, config.adminUsername);
  if (err) { console.error(`ADMIN_PASSWORD 不符合密码策略：${err}`); process.exit(1); }
  store.createUser({ username: config.adminUsername, passHash: await hashPassword(pw), role: 'admin', mustChange: generated });
  store.audit('system', '', 'user.bootstrap', { username: config.adminUsername });
  log(`已创建管理员账号：${config.adminUsername}`);
  if (generated) {
    log('==================================================================');
    log(`初始管理员密码（仅显示一次，首次登录后必须修改）：${pw}`);
    log('==================================================================');
  }
}
if (config.bootstrapAkId && config.bootstrapAkSecret && secretState() === 'none') {
  store.setSecret('aliyun.accessKeyId', config.bootstrapAkId.trim());
  store.setSecret('aliyun.accessKeySecret', config.bootstrapAkSecret.trim());
  store.audit('system', '', 'aliyun.ak.bootstrap', { accessKeyId: maskId(config.bootstrapAkId) });
  log(`已从环境变量导入 AccessKey ${maskId(config.bootstrapAkId)}（已加密保存，可从环境变量中移除）`);
}
if (master.source === 'file') log('提示：未设置 APP_MASTER_KEY，主密钥保存在数据目录 .master.key。生产环境建议通过环境变量单独保管主密钥。');
if (secretState() === 'undecryptable') log('警告：已保存的 AccessKey 无法用当前主密钥解密，请在“系统管理”中重新配置。');

const sync = new SyncService({ store, tz: config.billTz, log });
sync.start();
setInterval(() => store.purgeSessions(config.sessionIdleMinutes * 60_000), 10 * 60_000).unref();
setInterval(() => store.purgeOld(), 24 * 3600_000).unref();

/* ===================================================================
 * 静态资源
 * =================================================================== */
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_ROUTES = { '/login': 'login.html', '/login.js': 'login.js', '/app.css': 'app.css', '/favicon.svg': 'favicon.svg' };
const PRIVATE_ROUTES = { '/': 'index.html', '/index.html': 'index.html' };
/** 前端 ES 模块：仅允许 /js/xxx.js 与 /js/views/xxx.js，需登录 */
const MODULE_RE = /^\/js\/(?:views\/)?[a-z0-9-]+\.js$/;
const fileCache = new Map();
const DEV = process.env.NODE_ENV !== 'production';
function getFile(name) {
  let f = fileCache.get(name);
  if (!f || DEV) {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, name));
    f = { body, gz: zlib.gzipSync(body), type: TYPES[path.extname(name)] || 'application/octet-stream', etag: '"' + sha256(body).slice(0, 16) + '"' };
    fileCache.set(name, f);
  }
  return f;
}

/* ===================================================================
 * HTTP 工具
 * =================================================================== */
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }

const allowList = (() => {
  if (!config.allowCidrs.length) return null;
  const bl = new net.BlockList();
  for (const c of config.allowCidrs) {
    const [addr, prefix] = c.split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (prefix) bl.addSubnet(addr, Number(prefix), type); else bl.addAddress(addr, type);
  }
  return bl;
})();

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (config.trustProxy && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
}
const isHttps = req => !!req.socket.encrypted || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
const cookieSecure = req => (config.cookieSecure === 'true' ? true : config.cookieSecure === 'false' ? false : isHttps(req));

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function send(req, res, status, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzip = buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? zlib.gzipSync(buf) : buf;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': out.length, ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}), ...extra });
  res.end(req.method === 'HEAD' ? undefined : out);
}
const json = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

function sendFile(req, res, name) {
  const f = getFile(name);
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ETag: f.etag }); return res.end(); }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gzip ? f.gz : f.body;
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': body.length, ETag: f.etag, 'Cache-Control': 'no-cache', ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookieName = secure => (secure ? '__Host-bcs' : 'bcs');
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = cookieSecure(req);
  res.setHeader('Set-Cookie', `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
function sessionToken(req) { const c = parseCookies(req); return c['__Host-bcs'] || c.bcs || ''; }

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.headers['content-length'] && Number(req.headers['content-length']) > limit) return reject(new HttpError(413, '请求体过大'));
    const ct = String(req.headers['content-type'] || '');
    if (req.headers['content-length'] !== '0' && ct && !ct.startsWith('application/json')) return reject(new HttpError(415, '仅支持 application/json'));
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(new HttpError(400, 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    return new URL(origin).host === String(host).split(',')[0].trim();
  } catch { return false; }
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* 简易限流 */
const ipHits = new Map();       // 全局：每 IP 每分钟
const loginFails = new Map();   // 登录失败：每 IP 窗口
function rateLimited(ip, limit = 600) {
  const now = Date.now();
  let e = ipHits.get(ip);
  if (!e || now - e.t > 60_000) { e = { t: now, n: 0 }; ipHits.set(ip, e); }
  return ++e.n > limit;
}
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  return !!e && Date.now() - e.t < config.login.ipWindowMinutes * 60_000 && e.n >= config.login.maxAttemptsPerIp;
}
function noteLoginFail(ip) {
  const now = Date.now();
  let e = loginFails.get(ip);
  if (!e || now - e.t > config.login.ipWindowMinutes * 60_000) { e = { t: now, n: 0 }; loginFails.set(ip, e); }
  e.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipHits) if (now - v.t > 60_000) ipHits.delete(k);
  for (const [k, v] of loginFails) if (now - v.t > config.login.ipWindowMinutes * 60_000) loginFails.delete(k);
}, 60_000).unref();

/* ===================================================================
 * 业务接口
 * =================================================================== */
const parseJsonArr = s => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const keyOut = k => ({
  apiKeyId: k.api_key_id, apiKeyValue: k.api_key_masked, description: k.description, workspaceId: k.workspace_id, workspaceName: k.workspace_name,
  disabled: k.disabled == null ? null : !!k.disabled, authType: k.auth_type, allowAllModels: k.allow_all_models == null ? null : !!k.allow_all_models,
  accessibleModels: parseJsonArr(k.accessible_models), accessIps: parseJsonArr(k.access_ips), createdBy: k.created_by, gmtCreate: k.gmt_create,
  firstSeen: k.first_seen, lastSeen: k.last_seen, deletedAt: k.deleted_at, updatedAt: k.updated_at,
});
const wsOut = w => ({
  workspaceId: w.workspace_id, workspaceName: w.name, region: w.region, serviceSite: w.service_site, apiHost: w.api_host, tenantId: w.tenant_id,
  gmtCreate: w.gmt_create, firstSeen: w.first_seen, lastSeen: w.last_seen, deletedAt: w.deleted_at,
});
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
const lastDayOf = cycle => addDays(addMonths(cycle, 1) + '-01', -1);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function getData(url) {
  const today = todayIn(config.billTz);
  const mode = url.searchParams.get('mode') === 'range' ? 'range' : 'month';
  const out = {
    today, tz: config.billTz, workspaces: store.listWorkspaces().map(wsOut), apiKeys: store.listApiKeys().map(keyOut),
    keyActivity: store.keyActivity(today), budgets: store.budgets(),
  };
  if (mode === 'month') {
    const cycle = url.searchParams.get('cycle') || today.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(cycle)) throw new HttpError(400, '账期格式应为 YYYY-MM');
    const last = lastDayOf(cycle);
    const isCurrent = cycle === today.slice(0, 7);
    const to = isCurrent ? today : last;
    const pc = addMonths(cycle, -1);
    const c = store.getCycle(cycle);
    out.period = {
      mode, cycle, from: cycle + '-01', to, daysInPeriod: daysBetween(cycle + '-01', last), elapsedDays: Math.max(0, daysBetween(cycle + '-01', to)),
      isCurrent, final: isCycleFinal(cycle, today), syncedAt: c?.synced_at || null, prevLabel: pc,
    };
    out.lines = store.queryLines('M', cycle, cycle);
    out.daily = store.queryLines('D', cycle + '-01', last, true);
    out.prev = store.queryAgg('M', pc, pc);
    out.prevDaily = store.queryLines('D', pc + '-01', lastDayOf(pc), true);
    if (isCurrent) {
      const n = Number(today.slice(8, 10));
      const pLast = lastDayOf(pc);
      const pTo = `${pc}-${String(Math.min(n, Number(pLast.slice(8, 10)))).padStart(2, '0')}`;
      out.prevMtd = store.queryAgg('D', pc + '-01', pTo);
      out.period.prevMtdLabel = `${pc}-01 ~ ${pTo}`;
    }
    out.recon = store.msOverview(cycle);
    out.history = store.queryLines('M', addMonths(cycle, -11), cycle, true);
  } else {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, '日期范围无效');
    const len = daysBetween(from, to);
    if (len > 400) throw new HttpError(400, '日期范围不能超过 400 天');
    const pFrom = addDays(from, -len), pTo = addDays(from, -1);
    out.period = { mode, from, to, daysInPeriod: len, elapsedDays: Math.max(0, daysBetween(from, to < today ? to : today)), isCurrent: to >= today, prevLabel: `${pFrom} ~ ${pTo}` };
    out.lines = store.queryLines('D', from, to);
    out.daily = null;
    out.prev = store.queryAgg('D', pFrom, pTo);
    out.prevDaily = store.queryLines('D', pFrom, pTo, true);
    const endCycle = to.slice(0, 7);
    out.history = store.queryLines('M', addMonths(endCycle, -11), endCycle, true);
  }
  return out;
}

function statusOut() {
  return {
    version: VERSION, today: todayIn(config.billTz), tz: config.billTz,
    aliyun: { configured: secretState() === 'ok', secretState: secretState() },
    sync: sync.status(), data: store.dataRange(),
  };
}

function adminSettingsOut() {
  let id = '';
  try { id = store.getSecret('aliyun.accessKeyId'); } catch { /* undecryptable */ }
  return {
    aliyun: { ...store.aliyunSettings(), accessKeyId: maskId(id), secretState: secretState() },
    sync: store.syncSettings(),
    options: { msRegions: MS_REGIONS, bssSites: Object.keys(BSS_ENDPOINTS) },
    security: {
      masterKeySource: master.source, encryption: 'AES-256-GCM', passwordHash: 'scrypt (N=32768, r=8, p=1)',
      sessionIdleMinutes: config.sessionIdleMinutes, sessionMaxHours: config.sessionMaxHours, trustProxy: config.trustProxy,
      cookieSecure: config.cookieSecure, allowCidrs: config.allowCidrs, loginMaxFailures: config.login.maxFailuresPerUser, lockMinutes: config.login.lockMinutes,
    },
  };
}

const AK_ID_RE = /^[A-Za-z0-9]{12,64}$/;
const AK_SECRET_RE = /^[A-Za-z0-9]{16,64}$/;
const int = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

async function putSettings(body, ctx) {
  const changed = [];
  if (body.aliyun) {
    const a = body.aliyun;
    const cur = store.aliyunSettings();
    const next = {
      msRegion: MS_REGIONS.includes(a.msRegion) ? a.msRegion : cur.msRegion,
      bssSite: BSS_ENDPOINTS[a.bssSite] ? a.bssSite : cur.bssSite,
      productCode: typeof a.productCode === 'string' ? a.productCode.replace(/[^A-Za-z0-9_,\-]/g, '').slice(0, 100) : cur.productCode,
    };
    store.setSetting('aliyun', next);
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changed.push(`aliyun.${k}`);
    const id = typeof a.accessKeyId === 'string' ? a.accessKeyId.trim() : '';
    const secret = typeof a.accessKeySecret === 'string' ? a.accessKeySecret.trim() : '';
    if (id || secret) {
      if (id && !AK_ID_RE.test(id)) throw new HttpError(400, 'AccessKey ID 格式不正确');
      if (secret && !AK_SECRET_RE.test(secret)) throw new HttpError(400, 'AccessKey Secret 格式不正确');
      if (id && !secret) throw new HttpError(400, '更换 AccessKey ID 时必须同时填写 AccessKey Secret');
      if (!id && secret && secretState() !== 'ok') throw new HttpError(400, '请同时填写 AccessKey ID');
      if (id) store.setSecret('aliyun.accessKeyId', id);
      store.setSecret('aliyun.accessKeySecret', secret);
      changed.push('aliyun.accessKey');
      store.audit(ctx.user.username, ctx.ip, 'aliyun.ak.update', { accessKeyId: maskId(id || store.getSecret('aliyun.accessKeyId')) });
      sync.run('meta', 'ak-changed');
    }
  }
  if (body.sync) {
    const s = body.sync, cur = store.syncSettings();
    const next = {
      metaIntervalMin: int(s.metaIntervalMin, 1, 1440, cur.metaIntervalMin),
      billIntervalMin: int(s.billIntervalMin, 10, 1440, cur.billIntervalMin),
      backfillMonths: int(s.backfillMonths, 1, 18, cur.backfillMonths),
      perWorkspaceKeys: s.perWorkspaceKeys == null ? cur.perWorkspaceKeys : !!s.perWorkspaceKeys,
      concurrency: int(s.concurrency, 1, 6, cur.concurrency),
    };
    store.setSetting('sync', next);
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changed.push(`sync.${k}`);
  }
  if (changed.length) store.audit(ctx.user.username, ctx.ip, 'settings.update', { fields: changed });
  return adminSettingsOut();
}

async function testConnection(body) {
  let client;
  const a = store.aliyunSettings();
  if (body.accessKeyId || body.accessKeySecret) {
    if (!AK_ID_RE.test(body.accessKeyId || '') || !AK_SECRET_RE.test(body.accessKeySecret || '')) throw new HttpError(400, '请填写完整有效的 AccessKey ID 与 Secret');
    client = new AliyunClient({ accessKeyId: body.accessKeyId.trim(), accessKeySecret: body.accessKeySecret.trim(), msRegion: a.msRegion, bssSite: a.bssSite });
  } else {
    try { client = sync.client(); } catch (e) { throw new HttpError(400, e.message); }
  }
  const cycle = todayIn(config.billTz).slice(0, 7);
  const tests = [
    ['百炼 · 业务空间列表（ListWorkspaces）', async () => { const r = await client.call('modelstudio', 'ListWorkspaces', { maxResults: 10 }); return `${r.totalCount ?? (r.workspaces || []).length} 个业务空间`; }],
    ['百炼 · API Key 列表（ListApiKeys）', async () => { const r = await client.call('modelstudio', 'ListApiKeys', { maxResults: 10 }); return `${r.totalCount ?? (r.apiKeys || []).length} 个 API Key`; }],
    ['百炼 · 账单汇总（GetBillingOverview）', async () => { const r = await client.call('modelstudio', 'GetBillingOverview', { billMonth: cycle, groupBy: [{ code: 'MAAS_TYPE' }], locale: 'zh-CN' }); return `本月合计 ${Number(r.data?.totalAmount || 0).toFixed(2)} 元`; }],
    ['费用中心 · 账单总览（QueryBillOverview）', async () => {
      const r = await client.call('bss', 'QueryBillOverview', { BillingCycle: cycle });
      const items = Array.isArray(r.Data?.Items) ? r.Data.Items : (r.Data?.Items?.Item || []);
      const hit = items.filter(it => /百炼/.test(it.ProductName || '') || /^sfm/i.test(it.ProductCode || ''));
      return hit.length ? `百炼产品代码：${[...new Set(hit.map(x => x.ProductCode))].join(', ')}` : '本月暂无百炼账单';
    }],
    ['费用中心 · 实例账单（DescribeInstanceBill）', async () => { const r = await client.call('bss', 'DescribeInstanceBill', { BillingCycle: cycle, Granularity: 'MONTHLY', MaxResults: 1, IsBillingItem: true }); return `可访问（本月账单 ${r.Data?.TotalCount ?? 0} 条）`; }],
  ];
  const out = [];
  for (const [name, fn] of tests) {
    try { out.push({ name, ok: true, detail: await fn() }); }
    catch (e) { out.push({ name, ok: false, error: `${e.code || ''} ${e.aliMessage || e.message}`.trim(), hint: explainAliyunError(e), requestId: e.requestId || '' }); }
  }
  return out;
}

const USER_RE = /^[A-Za-z0-9_.@-]{3,32}$/;
const userOut = u => ({
  id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, mustChange: !!u.must_change, locked: !!(u.locked_until && u.locked_until > Date.now()),
  lastLoginAt: u.last_login_at, lastLoginIp: u.last_login_ip, pwChangedAt: u.pw_changed_at, createdAt: u.created_at, sessions: u.sessions ?? 0,
});

/* ===================================================================
 * 路由
 * =================================================================== */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, opts });

route('POST', '/api/login', async (req, res, ctx) => {
  if (loginBlocked(ctx.ip)) return json(req, res, 429, { error: '登录尝试过于频繁，请稍后再试' });
  const { username, password } = await readJson(req, 4096);
  const fail = msg => json(req, res, 401, { error: msg || '用户名或密码错误（连续失败将临时锁定账号）' });
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password || username.length > 64 || password.length > 256) {
    noteLoginFail(ctx.ip);
    return json(req, res, 400, { error: '请输入用户名和密码' });
  }
  const u = store.userByName(username.trim());
  const now = Date.now();
  if (!u) {
    await burnPasswordCheck(password); noteLoginFail(ctx.ip);
    store.audit(username.trim().slice(0, 64), ctx.ip, 'login.fail', '用户不存在');
    return fail();
  }
  if (u.locked_until && u.locked_until > now) {
    await burnPasswordCheck(password); noteLoginFail(ctx.ip);
    store.audit(u.username, ctx.ip, 'login.fail', '账号锁定中');
    return fail();
  }
  const ok = await verifyPassword(password, u.pass_hash);
  if (!ok || u.disabled) {
    noteLoginFail(ctx.ip);
    if (!ok) {
      const n = u.failed_count + 1;
      const lock = n >= config.login.maxFailuresPerUser;
      store.updateUser(u.id, { failed_count: lock ? 0 : n, locked_until: lock ? now + config.login.lockMinutes * 60_000 : u.locked_until });
      store.audit(u.username, ctx.ip, 'login.fail', lock ? `密码错误，账号锁定 ${config.login.lockMinutes} 分钟` : `密码错误（${n}/${config.login.maxFailuresPerUser}）`);
    } else store.audit(u.username, ctx.ip, 'login.fail', '账号已禁用');
    return fail();
  }
  const old = sessionToken(req);
  if (old) store.deleteSession(sha256(old));
  store.updateUser(u.id, { failed_count: 0, locked_until: null, last_login_at: now, last_login_ip: ctx.ip });
  const { token } = store.createSession(u.id, ctx.ip, req.headers['user-agent'], config.sessionMaxHours * 3600_000);
  setSessionCookie(req, res, token, config.sessionMaxHours * 3600);
  store.audit(u.username, ctx.ip, 'login.success', null);
  return json(req, res, 200, { ok: true, mustChange: !!u.must_change });
}, { public: true });

route('POST', '/api/logout', async (req, res, ctx) => {
  store.deleteSession(ctx.session.id_hash);
  setSessionCookie(req, res, '', 0);
  store.audit(ctx.user.username, ctx.ip, 'logout', null);
  return json(req, res, 200, { ok: true });
}, { allowMustChange: true });

route('GET', '/api/me', async (req, res, ctx) => json(req, res, 200, {
  user: { id: ctx.user.id, username: ctx.user.username, role: ctx.user.role, mustChange: !!ctx.user.mustChange },
  csrf: ctx.session.csrf, tz: config.billTz, today: todayIn(config.billTz), sessionIdleMinutes: config.sessionIdleMinutes,
}), { allowMustChange: true });

route('POST', '/api/me/password', async (req, res, ctx) => {
  const { oldPassword, newPassword } = await readJson(req, 4096);
  const u = store.userById(ctx.user.id);
  if (!(await verifyPassword(String(oldPassword || ''), u.pass_hash))) {
    store.audit(u.username, ctx.ip, 'password.change.fail', '原密码错误');
    throw new HttpError(400, '原密码不正确');
  }
  const err = checkPasswordPolicy(newPassword, u.username);
  if (err) throw new HttpError(400, err);
  if (oldPassword === newPassword) throw new HttpError(400, '新密码不能与原密码相同');
  store.updateUser(u.id, { pass_hash: await hashPassword(newPassword), must_change: 0, pw_changed_at: Date.now() });
  store.deleteUserSessions(u.id, ctx.session.id_hash);
  store.audit(u.username, ctx.ip, 'password.change', null);
  return json(req, res, 200, { ok: true });
}, { allowMustChange: true });

route('GET', '/api/status', async (req, res) => json(req, res, 200, statusOut()));
route('GET', '/api/data', async (req, res, ctx) => json(req, res, 200, getData(ctx.url)));
route('GET', '/api/changes', async (req, res) => json(req, res, 200, { changes: store.listChanges(2000) }));

route('GET', '/api/admin/settings', async (req, res) => json(req, res, 200, adminSettingsOut()), { admin: true });
route('PUT', '/api/admin/settings', async (req, res, ctx) => json(req, res, 200, await putSettings(await readJson(req), ctx)), { admin: true });
route('POST', '/api/admin/test', async (req, res, ctx) => {
  const body = await readJson(req);
  store.audit(ctx.user.username, ctx.ip, 'aliyun.test', body.accessKeyId ? { accessKeyId: maskId(body.accessKeyId) } : null);
  return json(req, res, 200, { results: await testConnection(body) });
}, { admin: true });
route('POST', '/api/admin/sync', async (req, res, ctx) => {
  const b = await readJson(req);
  const kind = b.kind === 'bills' ? 'bills' : 'meta';
  if (secretState() !== 'ok') throw new HttpError(400, '请先配置阿里云 AccessKey');
  const cycles = Array.isArray(b.cycles) ? b.cycles.filter(c => /^\d{4}-\d{2}$/.test(c)).slice(0, 18) : undefined;
  const r = sync.run(kind, `manual:${ctx.user.username}`, { cycles, force: !!b.force });
  store.audit(ctx.user.username, ctx.ip, 'sync.trigger', { kind, cycles, force: !!b.force });
  return json(req, res, 200, r);
}, { admin: true });
route('PUT', '/api/admin/budgets', async (req, res, ctx) => {
  const b = await readJson(req);
  const money = v => (v === '' || v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e10 ? Math.round(Number(v) * 100) / 100 : NaN));
  const monthly = money(b.monthly);
  if (Number.isNaN(monthly)) throw new HttpError(400, '月度总预算金额无效');
  const alertPct = int(b.alertPct, 1, 100, 80);
  const keys = {};
  for (const [id, v] of Object.entries(b.keys || {})) {
    if (!/^(\d{1,20}|__none__)$/.test(id)) continue;
    const m = money(v);
    if (Number.isNaN(m)) throw new HttpError(400, `API Key ${id} 的预算金额无效`);
    if (m != null) keys[id] = m;
  }
  if (Object.keys(keys).length > 2000) throw new HttpError(400, '预算条目过多');
  const next = { monthly, alertPct, keys };
  store.setSetting('budgets', next);
  store.audit(ctx.user.username, ctx.ip, 'budgets.update', { monthly, alertPct, keyBudgets: Object.keys(keys).length });
  return json(req, res, 200, next);
}, { admin: true });
route('GET', '/api/admin/runs', async (req, res) => json(req, res, 200, { runs: store.listRuns(200) }), { admin: true });
route('GET', '/api/admin/calls', async (req, res) => json(req, res, 200, { calls: callLog }), { admin: true });
route('GET', '/api/admin/audit', async (req, res) => json(req, res, 200, { audit: store.listAudit(1000) }), { admin: true });
route('GET', '/api/admin/users', async (req, res) => json(req, res, 200, { users: store.listUsers().map(userOut) }), { admin: true });
route('POST', '/api/admin/users', async (req, res, ctx) => {
  const { username, password, role } = await readJson(req, 4096);
  if (!USER_RE.test(username || '')) throw new HttpError(400, '用户名需为 3-32 位字母、数字或 _ . @ -');
  if (!['admin', 'viewer'].includes(role)) throw new HttpError(400, '角色无效');
  if (store.userByName(username)) throw new HttpError(409, '用户名已存在');
  const err = checkPasswordPolicy(password, username);
  if (err) throw new HttpError(400, err);
  const id = store.createUser({ username, passHash: await hashPassword(password), role, mustChange: true });
  store.audit(ctx.user.username, ctx.ip, 'user.create', { username, role });
  return json(req, res, 200, { id: Number(id) });
}, { admin: true });
route('PUT', '/api/admin/users/:id', async (req, res, ctx) => {
  const u = store.userById(ctx.params.id);
  if (!u) throw new HttpError(404, '用户不存在');
  const b = await readJson(req, 4096);
  const self = u.id === ctx.user.id;
  const fields = {};
  if (b.role != null) {
    if (!['admin', 'viewer'].includes(b.role)) throw new HttpError(400, '角色无效');
    if (self && b.role !== 'admin') throw new HttpError(400, '不能降低自己的权限');
    if (u.role === 'admin' && b.role !== 'admin' && store.countAdmins() <= 1) throw new HttpError(400, '至少需要保留一个管理员');
    fields.role = b.role;
  }
  if (b.disabled != null) {
    if (self && b.disabled) throw new HttpError(400, '不能禁用自己');
    if (b.disabled && u.role === 'admin' && store.countAdmins() <= 1) throw new HttpError(400, '至少需要保留一个启用的管理员');
    fields.disabled = b.disabled ? 1 : 0;
  }
  if (b.unlock) { fields.locked_until = null; fields.failed_count = 0; }
  if (b.password != null) {
    const err = checkPasswordPolicy(b.password, u.username);
    if (err) throw new HttpError(400, err);
    fields.pass_hash = await hashPassword(b.password);
    fields.must_change = self ? 0 : 1;
    fields.pw_changed_at = Date.now();
  }
  store.updateUser(u.id, fields);
  if (fields.disabled || fields.pass_hash || fields.role) store.deleteUserSessions(u.id, self ? ctx.session.id_hash : '');
  store.audit(ctx.user.username, ctx.ip, 'user.update', { username: u.username, fields: Object.keys(fields).map(f => (f === 'pass_hash' ? 'password' : f)) });
  return json(req, res, 200, { ok: true });
}, { admin: true });
route('DELETE', '/api/admin/users/:id', async (req, res, ctx) => {
  const u = store.userById(ctx.params.id);
  if (!u) throw new HttpError(404, '用户不存在');
  if (u.id === ctx.user.id) throw new HttpError(400, '不能删除自己');
  if (u.role === 'admin' && store.countAdmins() <= 1) throw new HttpError(400, '至少需要保留一个管理员');
  store.deleteUser(u.id);
  store.audit(ctx.user.username, ctx.ip, 'user.delete', { username: u.username });
  return json(req, res, 200, { ok: true });
}, { admin: true });

/* ===================================================================
 * 请求处理
 * =================================================================== */
async function handle(req, res) {
  const ip = clientIp(req);
  securityHeaders(req, res);
  if (allowList && !allowList.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')) return send(req, res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(req, res, 400, 'Bad Request', 'text/plain'); }
  const p = url.pathname;
  if (p === '/healthz') return send(req, res, 200, 'ok', 'text/plain', { 'Cache-Control': 'no-store' });
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(req, res, 405, 'Method Not Allowed', 'text/plain', { Allow: 'GET, HEAD, POST, PUT, DELETE' });
  if (rateLimited(ip)) return json(req, res, 429, { error: '请求过于频繁' });

  const token = sessionToken(req);
  const session = token ? store.getSession(token, config.sessionIdleMinutes * 60_000) : null;

  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_ROUTES[p]) {
    if (p === '/login' && session) { res.writeHead(302, { Location: '/' }); return res.end(); }
    return sendFile(req, res, PUBLIC_ROUTES[p]);
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && PRIVATE_ROUTES[p]) {
    if (!session) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return sendFile(req, res, PRIVATE_ROUTES[p]);
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && MODULE_RE.test(p)) {
    if (!session) return send(req, res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
    if (!fs.existsSync(path.join(PUBLIC_DIR, p.slice(1)))) return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
    return sendFile(req, res, p.slice(1));
  }
  if (!p.startsWith('/api/')) return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');

  const r = routes.find(x => x.method === req.method && x.re.test(p));
  if (!r) return json(req, res, 404, { error: '接口不存在' });
  const ctx = { ip, url, params: p.match(r.re).groups || {}, session };
  if (req.method !== 'GET' && !sameOrigin(req)) return json(req, res, 403, { error: '跨站请求被拒绝' });
  if (!r.opts.public) {
    if (!session) return json(req, res, 401, { error: '未登录或会话已过期', code: 'Unauthorized' });
    ctx.user = { id: session.user_id, username: session.username, role: session.role, mustChange: !!session.must_change };
    if (req.method !== 'GET' && !safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(req, res, 403, { error: 'CSRF 校验失败，请刷新页面', code: 'CsrfFailed' });
    if (ctx.user.mustChange && !r.opts.allowMustChange) return json(req, res, 403, { error: '请先修改初始密码', code: 'MustChangePassword' });
    if (r.opts.admin && ctx.user.role !== 'admin') return json(req, res, 403, { error: '需要管理员权限', code: 'Forbidden' });
  }
  return r.handler(req, res, ctx);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (e instanceof HttpError) return json(req, res, e.status, { error: e.message, code: e.code });
    log('请求处理异常', req.method, req.url, e.stack || e);
    if (!res.headersSent) json(req, res, 500, { error: '服务器内部错误' });
    else res.end();
  });
});
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, config.host, () => log(`百炼费用分析服务 v${VERSION} 已启动：http://${config.host}:${config.port}  数据目录：${config.dataDir}  账单时区：${config.billTz}`));

const shutdown = sig => {
  log(`收到 ${sig}，正在退出…`);
  server.close(() => { try { store.db.close(); } catch { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
