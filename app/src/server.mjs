/**
 * TokenTally 大模型 API Key 费用分析（阿里云百炼 + 腾讯云 TokenHub）- Web 服务
 * 零第三方依赖：node:http + node:sqlite + node:crypto
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { Store, PROVIDERS } from './db.mjs';
import { SyncService, todayIn, addDays, addMonths, isCycleFinal, hourIn, PROVIDER_LIST } from './sync.mjs';
import { AlertService, ALERT_TYPES, EVENT_TYPES, MAX_CHANNELS, validateWebhook, cleanMobiles } from './alerts.mjs';
import { selfTest, AliyunClient, explainAliyunError, callLog, MS_REGIONS, BSS_ENDPOINTS } from './aliyun.mjs';
import { tc3SelfTest, TencentClient, explainTencentError, TC_REGIONS, TC_SITES } from './tencent.mjs';
import { seedDemo, clearDemo } from './demo.mjs';
import { PromClient, validateCalls, discover, fetchCalls, buildUsageRows, buildQuery, DEFAULT_CALLS, MAPPING_FIELDS, PROM_AUTH } from './prom.mjs';
import { loadMasterKey, hashPassword, verifyPassword, burnPasswordCheck, checkPasswordPolicy, randomPassword, maskId, sha256 } from './crypto.mjs';

const VERSION = '1.5.1';
const log = (...a) => console.log(new Date().toISOString(), ...a);

{
  const a = selfTest(), t = tc3SelfTest();
  if (process.argv.includes('--selftest')) {
    console.log(a ? 'ACS3-HMAC-SHA256（阿里云）签名自检通过' : 'ACS3-HMAC-SHA256（阿里云）签名自检失败');
    console.log(t ? 'TC3-HMAC-SHA256（腾讯云）签名自检通过' : 'TC3-HMAC-SHA256（腾讯云）签名自检失败');
    process.exit(a && t ? 0 : 1);
  }
  if (!a || !t) { console.error('云 API 签名自检失败，服务未启动'); process.exit(1); }
}

/* ===================================================================
 * 初始化：数据目录、主密钥、数据库、管理员、AccessKey
 * =================================================================== */
fs.mkdirSync(config.dataDir, { recursive: true });
const master = loadMasterKey(config.dataDir, config.masterKey);
const store = new Store(path.join(config.dataDir, 'bailian-cost.db'), master.key);
store.failStaleRuns();

const SECRET_NAMES = { aliyun: ['aliyun.accessKeyId', 'aliyun.accessKeySecret'], tencent: ['tencent.secretId', 'tencent.secretKey'] };
function secretState(p = 'aliyun') {
  try { return store.getSecret(SECRET_NAMES[p][0]) && store.getSecret(SECRET_NAMES[p][1]) ? 'ok' : 'none'; }
  catch { return 'undecryptable'; }
}
const anyConfigured = () => PROVIDER_LIST.some(p => secretState(p) === 'ok');

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
if (config.bootstrapTcId && config.bootstrapTcKey && secretState('tencent') === 'none') {
  store.setSecret('tencent.secretId', config.bootstrapTcId.trim());
  store.setSecret('tencent.secretKey', config.bootstrapTcKey.trim());
  store.audit('system', '', 'tencent.key.bootstrap', { secretId: maskId(config.bootstrapTcId) });
  log(`已从环境变量导入腾讯云 SecretId ${maskId(config.bootstrapTcId)}（已加密保存，可从环境变量中移除）`);
}
if (master.source === 'file') log('提示：未设置 APP_MASTER_KEY，主密钥保存在数据目录 .master.key。生产环境建议通过环境变量单独保管主密钥。');
for (const p of PROVIDER_LIST) if (secretState(p) === 'undecryptable') log(`警告：已保存的${PROVIDERS[p]}密钥无法用当前主密钥解密，请在“系统管理”中重新配置。`);
if (config.tencentEndpoint) log(`注意：腾讯云 API 地址已被 TENCENT_ENDPOINT_OVERRIDE 覆盖为 ${config.tencentEndpoint}（仅用于测试或私有网关）`);

if (store.getSetting('demo', false) && anyConfigured()) { clearDemo(store); log('检测到已配置云厂商访问密钥，已清除演示数据'); }
if (config.demo && !store.getSetting('demo', false) && !anyConfigured() && store.q('SELECT COUNT(*) AS n FROM bill_lines').get().n === 0) {
  seedDemo(store, todayIn(config.billTz));
  log('已生成演示数据（DEMO_DATA=true）。在“系统管理”中配置真实访问密钥后，演示数据会被自动清除。');
}
const sync = new SyncService({ store, tz: config.billTz, log, tencentEndpoint: config.tencentEndpoint, promAllowLoopback: config.promAllowLoopback });
const alerts = new AlertService({ store, tz: config.billTz, log, publicUrl: config.publicUrl, allowPrivate: config.alertAllowPrivate, providers: () => sync.configured() });
sync.onBillsSynced = () => alerts.check('bills');
sync.onRunFinished = (p, kind) => { if (kind === 'meta') alerts.check('sync'); };
sync.start();
setInterval(() => store.purgeSessions(config.sessionIdleMinutes * 60_000), 10 * 60_000).unref();
setInterval(() => store.purgeOld(), 24 * 3600_000).unref();
setInterval(() => alerts.check('schedule'), 5 * 60_000).unref(); // 报表定时 & 无同步时的兜底检查

/* ---------------- 自动备份：每天 BACKUP_HOUR 点生成一份，保留最近 BACKUP_KEEP 份 ---------------- */
const BACKUP_DIR = path.join(config.dataDir, 'backups');
const BACKUP_RE = /^tokentally-\d{8}-\d{6}(-manual)?\.db$/;
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs, manual: f.includes('-manual') }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
/** 同一时间只允许一个备份任务；使用 SQLite 增量备份 API，备份期间服务照常响应 */
let backupBusy = null;
async function createBackup(manual = false) {
  if (backupBusy) throw Object.assign(new Error('已有备份任务正在进行，请稍后再试'), { busy: true });
  backupBusy = (async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `tokentally-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${manual ? '-manual' : ''}.db`;
    const file = path.join(BACKUP_DIR, name);
    const tmp = file + '.partial';
    fs.rmSync(tmp, { force: true });
    try { await store.backupTo(tmp); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    fs.renameSync(tmp, file); // 写完再改名：列表中不会出现半成品
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
    // 只轮换自动备份；手动备份最多保留 10 份
    const all = listBackups();
    for (const [list, keep] of [[all.filter(b => !b.manual), Math.max(1, config.backupKeep)], [all.filter(b => b.manual), 10]]) for (const b of list.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
    return { name, size: fs.statSync(file).size };
  })();
  try { return await backupBusy; } finally { backupBusy = null; }
}
let lastAutoBackup = '';
if (config.backupKeep > 0) {
  setInterval(() => {
    const today = todayIn(config.billTz);
    if (lastAutoBackup === today || hourIn(config.billTz) !== config.backupHour) return;
    if (listBackups().some(b => !b.manual && Date.now() - b.mtime < 20 * 3600_000)) { lastAutoBackup = today; return; }
    lastAutoBackup = today;
    createBackup(false).then(r => log(`自动备份完成：${r.name}（${(r.size / 1048576).toFixed(1)} MB）`)).catch(e => log('自动备份失败：' + e.message));
  }, 10 * 60_000).unref();
}

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

/**
 * 客户端 IP：信任反向代理时取 X-Forwarded-For 从右往左第 proxyHops 个地址（由最近的可信代理追加）。
 * 最左侧的地址可由客户端任意填写（Nginx $proxy_add_x_forwarded_for 只在末尾追加），取它会让登录限流、IP 白名单与审计 IP 被伪造绕过
 */
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (config.trustProxy && req.headers['x-forwarded-for']) {
    const list = String(req.headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) ip = list[Math.max(0, list.length - config.proxyHops)];
  }
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
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
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

/** 同域其他应用可能写入非法百分号编码的 Cookie（如 a=100%）：解码失败时保留原值，不能让整个请求 500 */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const v = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(v); } catch { out[part.slice(0, i).trim()] = v; }
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
const metricHits = new Map();   // /metrics 独立计数，避免与页面访问互相影响
const loginFails = new Map();   // 登录失败：每 IP 窗口
function rateLimited(ip, limit = 600, map = ipHits) {
  const now = Date.now();
  let e = map.get(ip);
  if (!e || now - e.t > 60_000) { e = { t: now, n: 0 }; map.set(ip, e); }
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
  for (const m of [ipHits, metricHits]) for (const [k, v] of m) if (now - v.t > 60_000) m.delete(k);
  for (const [k, v] of loginFails) if (now - v.t > config.login.ipWindowMinutes * 60_000) loginFails.delete(k);
}, 60_000).unref();

/* ===================================================================
 * 业务接口
 * =================================================================== */
const parseJsonArr = s => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const keyOut = (k, tags) => {
  const t = tags?.get(k.api_key_id);
  return {
    apiKeyId: k.api_key_id, provider: k.provider || 'aliyun', apiKeyValue: k.api_key_masked, description: k.description, remark: k.remark || '', workspaceId: k.workspace_id, workspaceName: k.workspace_name,
    disabled: k.disabled == null ? null : !!k.disabled, authType: k.auth_type, allowAllModels: k.allow_all_models == null ? null : !!k.allow_all_models,
    accessibleModels: parseJsonArr(k.accessible_models), accessIps: parseJsonArr(k.access_ips), createdBy: k.created_by, gmtCreate: k.gmt_create,
    firstSeen: k.first_seen, lastSeen: k.last_seen, deletedAt: k.deleted_at, updatedAt: k.updated_at,
    costCenter: t?.cost_center || '', owner: t?.owner || '', note: t?.note || '',
  };
};
const wsOut = w => ({
  workspaceId: w.workspace_id, provider: w.provider || 'aliyun', workspaceName: w.name, region: w.region, serviceSite: w.service_site, apiHost: w.api_host, tenantId: w.tenant_id,
  gmtCreate: w.gmt_create, firstSeen: w.first_seen, lastSeen: w.last_seen, deletedAt: w.deleted_at,
});
/** API Key ID：阿里云为数字，腾讯云形如 ak-20260325-xxxxxx */
const KEY_ID_RE = /^([A-Za-z0-9][\w.-]{0,63}|__none__)$/;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
const lastDayOf = cycle => addDays(addMonths(cycle, 1) + '-01', -1);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function getData(url) {
  const today = todayIn(config.billTz);
  const mode = url.searchParams.get('mode') === 'range' ? 'range' : 'month';
  const tags = new Map(store.listKeyTags().map(t => [t.api_key_id, t]));
  const out = {
    today, tz: config.billTz, workspaces: store.listWorkspaces().map(wsOut), apiKeys: store.listApiKeys().map(k => keyOut(k, tags)),
    keyActivity: store.keyActivity(today), budgets: store.budgets(), providers: sync.configured(),
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
    out.usage = store.queryUsage(cycle + '-01', last);
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
    out.usage = store.queryUsage(from, to);
  }
  return out;
}

/* 数据范围（全表统计）按数据版本缓存：状态接口每 20 秒被每个标签页轮询一次 */
let rangeCache = { v: '', d: null };
function dataRangeCached() {
  const v = store.dataVersion();
  if (rangeCache.v !== v) rangeCache = { v, d: store.dataRange() };
  return rangeCache.d;
}
function statusOut() {
  const providers = Object.fromEntries(PROVIDER_LIST.map(p => [p, { name: PROVIDERS[p], configured: secretState(p) === 'ok', secretState: secretState(p) }]));
  return {
    version: VERSION, today: todayIn(config.billTz), tz: config.billTz,
    aliyun: providers.aliyun, providers, anyConfigured: anyConfigured(), branding: store.branding(), demo: !!store.getSetting('demo', false),
    // 调用次数数据源：阿里云需启用云监控 Prometheus（演示模式内置模拟数据）
    calls: ((c, demo) => ({ aliyun: !!c || demo, aliyunFails: !!c?.failMetric || demo }))(sync.callsConfig(), !!store.getSetting('demo', false)),
    sync: sync.status(), data: dataRangeCached(),
  };
}

function adminSettingsOut() {
  let id = '', tid = '';
  try { id = store.getSecret('aliyun.accessKeyId'); } catch { /* undecryptable */ }
  try { tid = store.getSecret('tencent.secretId'); } catch { /* undecryptable */ }
  return {
    aliyun: { ...store.aliyunSettings(), accessKeyId: maskId(id), secretState: secretState('aliyun') },
    tencent: { ...store.tencentSettings(), secretId: maskId(tid), secretState: secretState('tencent'), endpointOverride: !!config.tencentEndpoint },
    aliyunCalls: aliyunCallsOut(),
    sync: store.syncSettings(),
    alerts: alerts.out(),
    branding: store.branding(),
    backup: { keep: config.backupKeep, hour: config.backupHour, list: listBackups() },
    metrics: { enabled: !!config.metricsToken },
    options: { msRegions: MS_REGIONS, bssSites: Object.keys(BSS_ENDPOINTS), tcRegions: TC_REGIONS, tcSites: Object.keys(TC_SITES) },
    security: {
      masterKeySource: master.source, encryption: 'AES-256-GCM', passwordHash: 'scrypt (N=32768, r=8, p=1)',
      sessionIdleMinutes: config.sessionIdleMinutes, sessionMaxHours: config.sessionMaxHours, trustProxy: config.trustProxy, proxyHops: config.proxyHops,
      cookieSecure: config.cookieSecure, allowCidrs: config.allowCidrs, loginMaxFailures: config.login.maxFailuresPerUser, lockMinutes: config.login.lockMinutes,
    },
  };
}

/* 敏感操作二次验证：校验当前登录密码，连续错误达到上限后强制退出该用户全部会话 */
const pwFails = new Map(); // userId -> 连续输错次数
async function confirmCurrentPassword(ctx, password, action, msg) {
  const u = store.userById(ctx.user.id);
  if (u && (await verifyPassword(String(password || ''), u.pass_hash))) { pwFails.delete(u.id); return u; }
  const max = config.login.maxFailuresPerUser;
  const n = (pwFails.get(ctx.user.id) || 0) + 1;
  if (n >= max) {
    pwFails.delete(ctx.user.id);
    store.deleteUserSessions(ctx.user.id);
    store.audit(ctx.user.username, ctx.ip, action + '.lock', `当前密码连续错误 ${n} 次，已强制退出全部会话`);
    throw new HttpError(401, '密码错误次数过多，已强制退出登录', 'Unauthorized');
  }
  pwFails.set(ctx.user.id, n);
  store.audit(ctx.user.username, ctx.ip, action + '.fail', `当前密码错误（${n}/${max}）`);
  throw new HttpError(403, `${msg}（还可尝试 ${max - n} 次）`);
}

const AK_ID_RE = /^[A-Za-z0-9]{12,64}$/;
const AK_SECRET_RE = /^[A-Za-z0-9]{16,64}$/;
const TC_ID_RE = /^[A-Za-z0-9]{16,128}$/;
const TC_KEY_RE = /^[A-Za-z0-9]{16,128}$/;
const int = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));
function callsSecretSet() {
  try { return !!(store.getSecret('aliyunCalls.token') || store.getSecret('aliyunCalls.password')); } catch { return true; }
}
/**
 * 发现 / 预览用的 Prometheus 客户端：使用页面上填写的地址与认证；未填写 Token 时，只有地址与已保存地址一致才使用已保存的 Token，
 * 避免把已保存的 Token 发往新填写的地址
 */
function callsClientFrom(b) {
  const cur = store.aliyunCallsSettings();
  let cfg;
  try { cfg = validateCalls({ ...cur, ...pick(b, Object.keys(DEFAULT_CALLS)), enabled: false }); } catch (e) { throw new HttpError(400, e.message); }
  if (!cfg.url) throw new HttpError(400, '请填写 Prometheus HTTP API 地址');
  const token = typeof b.token === 'string' ? b.token.trim() : '', password = typeof b.password === 'string' ? b.password : '';
  let auth = { token, password };
  if (!token && !password && cfg.authType !== 'none') {
    if (cfg.url !== cur.url || cfg.authType !== cur.authType) throw new HttpError(400, '地址或认证方式与已保存的不同，请重新填写 Token / 密码');
    try { auth = { token: store.getSecret('aliyunCalls.token'), password: store.getSecret('aliyunCalls.password') }; } catch { throw new HttpError(400, '已保存的认证信息无法解密，请重新填写'); }
  }
  return { cfg, client: new PromClient({ url: cfg.url, authType: cfg.authType, username: cfg.username, ...auth, allowLoopback: config.promAllowLoopback }) };
}
function aliyunCallsOut() {
  const c = store.aliyunCallsSettings();
  return { ...c, secretSet: callsSecretSet(), last: store.getSetting('aliyunCalls.last', null), authTypes: PROM_AUTH, query: c.metric && c.keyLabel ? buildQuery(c) : '' };
}

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
    const id = typeof a.accessKeyId === 'string' ? a.accessKeyId.trim() : '';
    const secret = typeof a.accessKeySecret === 'string' ? a.accessKeySecret.trim() : '';
    if (id || secret) {
      if (id && !AK_ID_RE.test(id)) throw new HttpError(400, 'AccessKey ID 格式不正确');
      if (secret && !AK_SECRET_RE.test(secret)) throw new HttpError(400, 'AccessKey Secret 格式不正确');
      if (id && !secret) throw new HttpError(400, '更换 AccessKey ID 时必须同时填写 AccessKey Secret');
      if (!id && secret && secretState() !== 'ok') throw new HttpError(400, '请同时填写 AccessKey ID');
      // 敏感操作二次验证：更换 AccessKey 须输入当前登录密码
      if (!a.confirmPassword) throw new HttpError(400, '更换 AccessKey 需要输入当前登录密码确认');
      await confirmCurrentPassword(ctx, a.confirmPassword, 'aliyun.ak.update', '当前登录密码不正确');
    }
    store.setSetting('aliyun', next);
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changed.push(`aliyun.${k}`);
    if (id || secret) {
      if (store.getSetting('demo', false)) { clearDemo(store); store.audit(ctx.user.username, ctx.ip, 'demo.clear', null); }
      if (id) store.setSecret('aliyun.accessKeyId', id);
      store.setSecret('aliyun.accessKeySecret', secret);
      changed.push('aliyun.accessKey');
      store.audit(ctx.user.username, ctx.ip, 'aliyun.ak.update', { accessKeyId: maskId(id || store.getSecret('aliyun.accessKeyId')) });
      sync.run('meta', 'ak-changed', { provider: 'aliyun' });
    }
  }
  if (body.tencent) {
    const t = body.tencent;
    const cur = store.tencentSettings();
    const next = {
      region: TC_REGIONS.includes(t.region) ? t.region : cur.region,
      site: TC_SITES[t.site] ? t.site : cur.site,
      businessCode: typeof t.businessCode === 'string' ? t.businessCode.replace(/[^A-Za-z0-9_,\-]/g, '').slice(0, 100) : cur.businessCode,
      estimate: t.estimate == null ? cur.estimate : !!t.estimate,
    };
    const id = typeof t.secretId === 'string' ? t.secretId.trim() : '';
    const key = typeof t.secretKey === 'string' ? t.secretKey.trim() : '';
    if (id || key) {
      if (id && !TC_ID_RE.test(id)) throw new HttpError(400, 'SecretId 格式不正确');
      if (key && !TC_KEY_RE.test(key)) throw new HttpError(400, 'SecretKey 格式不正确');
      if (id && !key) throw new HttpError(400, '更换 SecretId 时必须同时填写 SecretKey');
      if (!id && key && secretState('tencent') !== 'ok') throw new HttpError(400, '请同时填写 SecretId');
      if (!t.confirmPassword) throw new HttpError(400, '更换腾讯云 API 密钥需要输入当前登录密码确认');
      await confirmCurrentPassword(ctx, t.confirmPassword, 'tencent.key.update', '当前登录密码不正确');
    }
    store.setSetting('tencent', next);
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changed.push(`tencent.${k}`);
    if (id || key) {
      if (store.getSetting('demo', false)) { clearDemo(store); store.audit(ctx.user.username, ctx.ip, 'demo.clear', null); }
      if (id) store.setSecret('tencent.secretId', id);
      store.setSecret('tencent.secretKey', key);
      changed.push('tencent.secretKey');
      store.audit(ctx.user.username, ctx.ip, 'tencent.key.update', { secretId: maskId(id || store.getSecret('tencent.secretId')) });
    }
    if ((id || key || next.region !== cur.region || next.site !== cur.site) && secretState('tencent') === 'ok') sync.run('meta', 'key-changed', { provider: 'tencent' });
  }
  if (body.aliyunCalls) {
    const c = body.aliyunCalls, cur = store.aliyunCallsSettings();
    let next;
    try { next = validateCalls({ ...cur, ...pick(c, Object.keys(DEFAULT_CALLS)) }); } catch (e) { throw new HttpError(400, e.message); }
    const token = typeof c.token === 'string' ? c.token.trim() : '';
    const password = typeof c.password === 'string' ? c.password : '';
    if (token.length > 4096 || /[\r\n]/.test(token)) throw new HttpError(400, 'Token 格式不正确');
    if (password.length > 512 || /[\r\n]/.test(password)) throw new HttpError(400, '密码格式不正确');
    // 更换认证信息或地址都属于敏感操作：地址变化后原 Token 会发往新地址，因此同样需要二次验证
    const secretChange = token || password || c.clearToken || (next.url !== cur.url && cur.url && callsSecretSet());
    if (secretChange) {
      if (!c.confirmPassword) throw new HttpError(400, '修改 Prometheus 地址或认证信息需要输入当前登录密码确认');
      await confirmCurrentPassword(ctx, c.confirmPassword, 'aliyun.calls.secret', '当前登录密码不正确');
    }
    const mappingChanged = MAPPING_FIELDS.some(k => (next[k] || '') !== (cur[k] || ''));
    store.setSetting('aliyunCalls', next);
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changed.push(`aliyunCalls.${k}`);
    if (c.clearToken) { store.setSecret('aliyunCalls.token', ''); store.setSecret('aliyunCalls.password', ''); changed.push('aliyunCalls.secret'); }
    if (token) { store.setSecret('aliyunCalls.token', token); changed.push('aliyunCalls.token'); }
    if (password) { store.setSecret('aliyunCalls.password', password); changed.push('aliyunCalls.password'); }
    if (secretChange) store.audit(ctx.user.username, ctx.ip, 'aliyun.calls.secret', { url: next.url });
    if (mappingChanged && (cur.metric || cur.url)) { store.clearUsage('aliyun'); store.setSetting('aliyunCalls.last', null); changed.push('aliyunCalls.cleared'); }
  }
  if (body.branding) {
    const b = body.branding, cur = store.branding();
    const txt = (v, max, d) => (typeof v === 'string' ? v.replace(/[<>"'`\\\u0000-\u001f]/g, '').trim().slice(0, max) || d : d);
    const next = { name: txt(b.name, 24, cur.name), subtitle: txt(b.subtitle, 48, '') };
    store.setSetting('branding', next);
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changed.push(`branding.${k}`);
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

async function testTencent(body) {
  let client;
  const t = store.tencentSettings();
  if (body.secretId || body.secretKey) {
    if (!TC_ID_RE.test(body.secretId || '') || !TC_KEY_RE.test(body.secretKey || '')) throw new HttpError(400, '请填写完整有效的 SecretId 与 SecretKey');
    client = new TencentClient({ secretId: body.secretId.trim(), secretKey: body.secretKey.trim(), region: t.region, site: t.site, endpoint: config.tencentEndpoint });
  } else {
    try { client = sync.client('tencent'); } catch (e) { throw new HttpError(400, e.message); }
  }
  const today = todayIn(config.billTz), cycle = today.slice(0, 7);
  const tests = [
    ['TokenHub · API Key 列表（DescribeApiKeyList）', async () => { const r = await client.call('tokenhub', 'DescribeApiKeyList', { Platform: 'maas', Limit: 1 }); return `${r.TotalCount ?? 0} 个 API Key`; }],
    ['TokenHub · 推理服务（DescribeModelEndpointList）', async () => { const r = await client.call('tokenhub', 'DescribeModelEndpointList', { Limit: 1 }); return `${r.TotalCount ?? 0} 个模型接入点`; }],
    ['TokenHub · 用量排行（DescribeUsageRankList）', async () => { const r = await client.call('tokenhub', 'DescribeUsageRankList', { Dimension: 'apikey', StartTime: `${addDays(today, -6)}T00:00:00+08:00`, EndTime: `${addDays(today, 1)}T00:00:00+08:00`, ShowAll: true }); return `近 7 天 ${r.Total ?? 0} 个 Key 有用量，合计 ${Number(r.TotalStats?.TotalToken || 0).toLocaleString()} Token`; }],
    ['计费 · 产品费用分布（DescribeBillSummaryByProduct）', async () => {
      const r = await client.call('billing', 'DescribeBillSummaryByProduct', { BeginTime: cycle, EndTime: cycle });
      const hit = (r.SummaryOverview || []).filter(x => /tokenhub|大模型|混元|hunyuan/i.test(`${x.BusinessCodeName} ${x.BusinessCode}`));
      return hit.length ? `本月大模型产品：${hit.map(x => `${x.BusinessCodeName}（${x.BusinessCode}）¥${Number(x.RealTotalCost || 0).toFixed(2)}`).join('；')}` : '可访问（本月暂无 TokenHub 账单）';
    }],
    ['计费 · 账单明细（DescribeBillDetail）', async () => { const r = await client.call('billing', 'DescribeBillDetail', { Month: cycle, Offset: 0, Limit: 1 }); return `可访问（本月明细 ${(r.DetailSet || []).length ? '有数据' : '暂无'}）`; }],
  ];
  const out = [];
  for (const [name, fn] of tests) {
    try { out.push({ name, ok: true, detail: await fn() }); }
    catch (e) { out.push({ name, ok: false, error: `${e.code || ''} ${e.aliMessage || e.message}`.trim(), hint: explainTencentError(e), requestId: e.requestId || '' }); }
  }
  return out;
}

async function testConnection(body) {
  if (body.provider === 'tencent') return testTencent(body);
  let client;
  const a = store.aliyunSettings();
  if (body.accessKeyId || body.accessKeySecret) {
    if (!AK_ID_RE.test(body.accessKeyId || '') || !AK_SECRET_RE.test(body.accessKeySecret || '')) throw new HttpError(400, '请填写完整有效的 AccessKey ID 与 Secret');
    client = new AliyunClient({ accessKeyId: body.accessKeyId.trim(), accessKeySecret: body.accessKeySecret.trim(), msRegion: a.msRegion, bssSite: a.bssSite });
  } else {
    try { client = sync.client('aliyun'); } catch (e) { throw new HttpError(400, e.message); }
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
  const u = await confirmCurrentPassword(ctx, oldPassword, 'password.change', '原密码不正确');
  const err = checkPasswordPolicy(newPassword, u.username);
  if (err) throw new HttpError(400, err);
  if (oldPassword === newPassword) throw new HttpError(400, '新密码不能与原密码相同');
  store.updateUser(u.id, { pass_hash: await hashPassword(newPassword), must_change: 0, pw_changed_at: Date.now() });
  store.deleteUserSessions(u.id, ctx.session.id_hash);
  store.audit(u.username, ctx.ip, 'password.change', null);
  return json(req, res, 200, { ok: true });
}, { allowMustChange: true });

route('GET', '/api/status', async (req, res) => json(req, res, 200, statusOut()));
/* 分析数据：按“数据版本 + 日期 + 查询参数”生成 ETag，数据未变化时返回 304，避免轮询刷新时重复下载 */
/* 同一 ETag 的响应体（JSON + gzip）缓存在内存中：多个用户 / 标签页、轮询刷新时不再重复查询与压缩（LRU，最多 8 份） */
const dataCache = new Map();
function cachedData(etag, url) {
  let c = dataCache.get(etag);
  if (c) { dataCache.delete(etag); dataCache.set(etag, c); return c; }
  const body = Buffer.from(JSON.stringify(getData(url)));
  c = { body, gz: body.length > 1024 ? zlib.gzipSync(body) : null };
  dataCache.set(etag, c);
  while (dataCache.size > 8) dataCache.delete(dataCache.keys().next().value);
  return c;
}
route('GET', '/api/data', async (req, res, ctx) => {
  const etag = 'W/"' + sha256([VERSION, store.dataVersion(), todayIn(config.billTz), sync.configured().join(','), ctx.url.search].join('|')).slice(0, 32) + '"';
  const headers = { 'Cache-Control': 'private, no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const c = cachedData(etag, ctx.url);
  const gzip = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? c.gz : c.body;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': out.length, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}), Vary: 'Accept-Encoding', ...headers });
  return res.end(req.method === 'HEAD' ? undefined : out);
});
route('GET', '/api/changes', async (req, res) => json(req, res, 200, { changes: store.listChanges(2000) }));
/* 品牌信息：登录页使用，无敏感内容 */
route('GET', '/api/branding', async (req, res) => json(req, res, 200, store.branding()), { public: true });

route('GET', '/api/admin/settings', async (req, res) => json(req, res, 200, adminSettingsOut()), { admin: true });
route('PUT', '/api/admin/settings', async (req, res, ctx) => json(req, res, 200, await putSettings(await readJson(req), ctx)), { admin: true });
route('POST', '/api/admin/test', async (req, res, ctx) => {
  const body = await readJson(req);
  if (body.provider === 'tencent') store.audit(ctx.user.username, ctx.ip, 'tencent.test', body.secretId ? { secretId: maskId(body.secretId) } : null);
  else store.audit(ctx.user.username, ctx.ip, 'aliyun.test', body.accessKeyId ? { accessKeyId: maskId(body.accessKeyId) } : null);
  return json(req, res, 200, { results: await testConnection(body) });
}, { admin: true });
route('POST', '/api/admin/sync', async (req, res, ctx) => {
  const b = await readJson(req);
  const kind = b.kind === 'bills' ? 'bills' : 'meta';
  const conf = sync.configured();
  if (!conf.length) throw new HttpError(400, '请先在“系统管理”中配置阿里云或腾讯云的访问密钥');
  let targets;
  if (PROVIDER_LIST.includes(b.provider)) {
    if (!conf.includes(b.provider)) throw new HttpError(400, `尚未配置${PROVIDERS[b.provider]}访问密钥`);
    targets = [b.provider];
  } else targets = conf;
  const cycles = Array.isArray(b.cycles) ? b.cycles.filter(c => typeof c === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(c)).slice(0, 18) : undefined;
  const runs = targets.map(p => sync.run(kind, `manual:${ctx.user.username}`, { provider: p, cycles, force: !!b.force }));
  store.audit(ctx.user.username, ctx.ip, 'sync.trigger', { kind, providers: targets, cycles, force: !!b.force });
  return json(req, res, 200, { runs, runId: runs[0].runId, alreadyRunning: runs.every(r => r.alreadyRunning) });
}, { admin: true });
/* 阿里云调用次数：发现指标 / 预览 / 立即同步 */
route('POST', '/api/admin/aliyun-calls/discover', async (req, res) => {
  const { client } = callsClientFrom(await readJson(req));
  try { return json(req, res, 200, await discover(client)); } catch (e) { throw new HttpError(502, e.message); }
}, { admin: true });
route('POST', '/api/admin/aliyun-calls/preview', async (req, res) => {
  const b = await readJson(req);
  const { cfg, client } = callsClientFrom(b);
  if (!cfg.metric || !cfg.keyLabel) throw new HttpError(400, '请先选择调用次数指标与 API Key 标签');
  const days = int(b.days, 1, 31, 7), today = todayIn(config.billTz), from = addDays(today, -(days - 1));
  let cells;
  try { cells = await fetchCalls(client, cfg, { from, to: today, tz: config.billTz }); } catch (e) { throw new HttpError(502, e.message); }
  const keys = store.listApiKeys().filter(k => k.provider === 'aliyun');
  const { rows, unmatched } = buildUsageRows(cells, { keys, billTokens: store.billTokenCells('aliyun', from, today) });
  const agg = new Map();
  for (const r of rows) {
    const k = r.api_key_id + '\u0001' + r.model;
    const a = agg.get(k) || { apiKeyId: r.api_key_id, model: r.model, requests: 0, fails: 0, tokens: 0, days: 0 };
    a.requests += r.requests; a.fails += r.fails; a.tokens += r.total_tokens; a.days++;
    agg.set(k, a);
  }
  const names = new Map(keys.map(k => [k.api_key_id, k.description || '']));
  const list = [...agg.values()].map(a => ({ ...a, name: names.get(a.apiKeyId) || '' })).sort((x, y) => y.requests - x.requests);
  const byDay = new Map();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + r.requests);
  return json(req, res, 200, {
    from, to: today, query: buildQuery(cfg), calls: client.calls,
    total: list.reduce((s, a) => s + a.requests, 0), fails: list.reduce((s, a) => s + a.fails, 0),
    days: [...byDay.entries()].sort().map(([day, requests]) => ({ day, requests })),
    rows: list.slice(0, 200), more: Math.max(0, list.length - 200),
    unmatched: [...unmatched.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 20).map(([value, requests]) => ({ value: String(value).slice(0, 80), requests })),
    unmatchedTotal: [...unmatched.values()].reduce((s, n) => s + n, 0),
  });
}, { admin: true });
route('POST', '/api/admin/aliyun-calls/sync', async (req, res, ctx) => {
  if (!sync.callsConfig()) throw new HttpError(400, '请先保存并启用调用次数配置');
  store.audit(ctx.user.username, ctx.ip, 'aliyun.calls.sync', null);
  try { return json(req, res, 200, await sync.syncAliyunCalls()); } catch (e) { throw new HttpError(502, e.message); }
}, { admin: true });
/* 预算管理页：已保存的预算 + 上月按 Key 的应付金额（与页面当前选择的统计周期无关） */
route('GET', '/api/admin/budgets', async (req, res) => {
  const lastCycle = addMonths(todayIn(config.billTz).slice(0, 7), -1);
  const lastMonth = {};
  for (const r of store.monthByKey(lastCycle)) lastMonth[r.id || '__none__'] = (lastMonth[r.id || '__none__'] || 0) + (r.cost || 0);
  return json(req, res, 200, { budgets: store.budgets(), lastCycle, lastMonth });
}, { admin: true });
route('PUT', '/api/admin/budgets', async (req, res, ctx) => {
  const b = await readJson(req);
  const money = v => (v === '' || v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e10 ? Math.round(Number(v) * 100) / 100 : NaN));
  const monthly = money(b.monthly);
  if (Number.isNaN(monthly)) throw new HttpError(400, '月度总预算金额无效');
  const alertPct = int(b.alertPct, 1, 100, 80);
  const keys = {};
  for (const [id, v] of Object.entries(b.keys || {})) {
    if (!KEY_ID_RE.test(id)) continue;
    const m = money(v);
    if (Number.isNaN(m)) throw new HttpError(400, `API Key ${id} 的预算金额无效`);
    if (m != null) keys[id] = m;
  }
  if (Object.keys(keys).length > 2000) throw new HttpError(400, '预算条目过多');
  const next = { monthly, alertPct, keys };
  store.setSetting('budgets', next);
  store.audit(ctx.user.username, ctx.ip, 'budgets.update', { monthly, alertPct, keyBudgets: Object.keys(keys).length });
  alerts.check('budgets');
  return json(req, res, 200, next);
}, { admin: true });

/* 成本中心 / 负责人 / 备注（本地标签，不回写云厂商） */
route('PUT', '/api/admin/key-tags', async (req, res, ctx) => {
  const b = await readJson(req, 256 * 1024);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, '没有需要保存的标签');
  if (items.length > 2000) throw new HttpError(400, '一次最多保存 2000 条');
  const out = {};
  store.tx(() => {
    for (const it of items) {
      const id = String(it.id || '');
      if (!KEY_ID_RE.test(id) || id === '__none__') throw new HttpError(400, `API Key ID 无效：${id.slice(0, 40)}`);
      out[id] = store.setKeyTag(id, { costCenter: it.costCenter, owner: it.owner, note: it.note }, ctx.user.username);
    }
  });
  store.audit(ctx.user.username, ctx.ip, 'keytags.update', { count: items.length, keys: Object.keys(out).slice(0, 20) });
  return json(req, res, 200, { ok: true, tags: out });
}, { admin: true });

/* ---------------- 告警通知（多渠道） ---------------- */
route('PUT', '/api/admin/alerts', async (req, res, ctx) => {
  const b = await readJson(req, 64 * 1024);
  const cur = alerts.settings();
  const curById = new Map(cur.channels.map(c => [c.id, c]));
  const list = Array.isArray(b.channels) ? b.channels : cur.channels;
  if (list.length > MAX_CHANNELS) throw new HttpError(400, `最多配置 ${MAX_CHANNELS} 个通知渠道`);
  const rules = Object.fromEntries(Object.keys(cur.rules).map(k => [k, b.rules?.[k] == null ? cur.rules[k] : !!b.rules[k]]));
  const anomaly = {
    ratio: Math.min(20, Math.max(1.2, Number(b.anomaly?.ratio) || cur.anomaly.ratio)),
    minAmount: Math.min(1e7, Math.max(0, Number.isFinite(Number(b.anomaly?.minAmount)) ? Number(b.anomaly.minAmount) : cur.anomaly.minAmount)),
    keys: b.anomaly?.keys == null ? cur.anomaly.keys : !!b.anomaly.keys,
  };
  const reportHour = int(b.reportHour, 0, 23, cur.reportHour);
  const used = new Set(), plan = [], fields = [];
  for (const raw of list) {
    const old = raw.id && curById.get(raw.id);
    const id = old ? old.id : 'c' + crypto.randomBytes(4).toString('hex');
    if (used.has(id)) throw new HttpError(400, '渠道 ID 重复');
    used.add(id);
    const type = ALERT_TYPES[raw.type] ? raw.type : old?.type;
    if (!type) throw new HttpError(400, '不支持的通知类型');
    const name = String(raw.name || '').replace(/[<>"'`\\\u0000-\u001f]/g, '').trim().slice(0, 30) || ALERT_TYPES[type].label;
    const sec = old ? alerts.secretsOf(id) : { webhook: '', secret: '' };
    const webhookIn = typeof raw.webhook === 'string' ? raw.webhook.trim() : '';
    const secretIn = typeof raw.secret === 'string' ? raw.secret.trim() : '';
    if (secretIn.length > 256) throw new HttpError(400, `渠道「${name}」的加签密钥过长`);
    let webhook = '';
    if (webhookIn) {
      try { webhook = validateWebhook(type, webhookIn, { allowPrivate: config.alertAllowPrivate }); } catch (e) { throw new HttpError(400, `渠道「${name}」：${e.message}`); }
    } else if (sec.webhook && old && type !== old.type) {
      throw new HttpError(400, `渠道「${name}」已更换通知类型，请同时填写对应的 Webhook 地址`); // 不同渠道的地址与密钥不能混用
    }
    if (!webhook && !sec.webhook) throw new HttpError(400, `渠道「${name}」请填写 Webhook 地址`);
    const events = Object.fromEntries(Object.keys(EVENT_TYPES).map(k => [k, raw.events?.[k] == null ? (old?.events?.[k] ?? false) : !!raw.events[k]]));
    plan.push({ ch: { id, name, type, enabled: !!raw.enabled, events, atAll: !!raw.atAll, atMobiles: cleanMobiles(raw.atMobiles) }, webhook, secretIn, clearSecret: !!raw.clearSecret, sec, isNew: !old });
  }
  // 校验全部通过后再落库，避免部分保存
  for (const p of plan) {
    const id = p.ch.id;
    if (p.webhook) { store.setSecret(`alerts.ch.${id}.webhook`, p.webhook); fields.push(`${p.ch.name}.webhook`); }
    if (p.clearSecret) { store.setSecret(`alerts.ch.${id}.secret`, ''); fields.push(`${p.ch.name}.secret.clear`); }
    else if (p.secretIn) { store.setSecret(`alerts.ch.${id}.secret`, p.secretIn); fields.push(`${p.ch.name}.secret`); }
    else if (p.webhook && p.webhook !== p.sec.webhook && p.sec.secret) { store.setSecret(`alerts.ch.${id}.secret`, ''); fields.push(`${p.ch.name}.secret.reset`); } // 换了机器人，旧密钥不再适用
  }
  for (const old of cur.channels) {
    if (used.has(old.id)) continue;
    store.setSecret(`alerts.ch.${old.id}.webhook`, ''); store.setSecret(`alerts.ch.${old.id}.secret`, '');
    fields.push(`${old.name}.removed`);
  }
  const next = { channels: plan.map(p => p.ch), rules, anomaly, reportHour };
  store.setSetting('alerts', next);
  store.audit(ctx.user.username, ctx.ip, 'alert.update', { channels: next.channels.map(c => ({ name: c.name, type: c.type, enabled: c.enabled, events: Object.keys(c.events).filter(k => c.events[k]) })), rules, anomaly, reportHour, fields });
  const check = next.channels.some(c => c.enabled) ? await alerts.check('config') : null;
  return json(req, res, 200, { ...alerts.out(), check });
}, { admin: true });
route('POST', '/api/admin/alerts/test', async (req, res, ctx) => {
  const b = await readJson(req, 8192);
  const saved = alerts.settings().channels.find(c => c.id === b.channelId);
  const type = ALERT_TYPES[b.type] ? b.type : saved?.type;
  if (!type) throw new HttpError(400, '请选择通知类型');
  const sec = saved ? alerts.secretsOf(saved.id) : { webhook: '', secret: '' };
  const webhookIn = typeof b.webhook === 'string' ? b.webhook.trim() : '';
  if (!webhookIn && !sec.webhook) throw new HttpError(400, '请先填写 Webhook 地址');
  if (!webhookIn && saved && type !== saved.type) throw new HttpError(400, '已更换通知类型，请填写对应的 Webhook 地址后再测试');
  let webhook;
  try { webhook = validateWebhook(type, webhookIn || sec.webhook, { allowPrivate: config.alertAllowPrivate }); }
  catch (e) { throw new HttpError(400, e.message); }
  const secretIn = typeof b.secret === 'string' ? b.secret.trim().slice(0, 256) : '';
  const secret = secretIn || (webhook === sec.webhook ? sec.secret : '');
  const ch = { id: saved?.id || 'test', name: saved?.name || ALERT_TYPES[type].label, type, atAll: !!b.atAll, atMobiles: cleanMobiles(b.atMobiles) };
  try { await alerts.test(ch, { webhook, secret }); }
  catch (e) {
    store.audit(ctx.user.username, ctx.ip, 'alert.test.fail', { type, error: String(e.message).slice(0, 200) });
    throw new HttpError(502, '发送失败：' + e.message);
  }
  store.audit(ctx.user.username, ctx.ip, 'alert.test', { type, channel: ch.name });
  return json(req, res, 200, { ok: true });
}, { admin: true });
/* 报表预览 / 立即发送（不影响定时发送记录） */
route('POST', '/api/admin/alerts/report', async (req, res, ctx) => {
  const b = await readJson(req, 4096);
  const kind = ['daily', 'weekly', 'monthly'].includes(b.kind) ? b.kind : 'daily';
  const r = alerts.report(kind);
  if (b.send) {
    const ch = alerts.settings().channels.find(c => c.id === b.channelId);
    if (!ch) throw new HttpError(400, '请选择已保存的通知渠道');
    const sec = alerts.secretsOf(ch.id);
    if (!sec.webhook) throw new HttpError(400, '该渠道尚未配置 Webhook 地址');
    try { await alerts.send(ch, sec, { title: r.title + '（手动发送）', level: r.level, lines: r.lines }); }
    catch (e) { throw new HttpError(502, '发送失败：' + e.message); }
    store.audit(ctx.user.username, ctx.ip, 'alert.report.send', { kind, channel: ch.name });
  }
  return json(req, res, 200, { title: r.title, lines: r.lines, empty: !!r.empty, sent: !!b.send });
}, { admin: true });

/* ---------------- 数据备份 ---------------- */
route('GET', '/api/admin/backups', async (req, res) => json(req, res, 200, { keep: config.backupKeep, hour: config.backupHour, list: listBackups() }), { admin: true });
route('POST', '/api/admin/backups', async (req, res, ctx) => {
  let r;
  try { r = await createBackup(true); } catch (e) { if (e.busy) throw new HttpError(409, e.message); throw e; }
  store.audit(ctx.user.username, ctx.ip, 'backup.create', r);
  return json(req, res, 200, { ...r, list: listBackups() });
}, { admin: true });
/* 下载备份须再次验证登录密码（备份包含加密后的密钥与密码哈希） */
route('POST', '/api/admin/backups/download', async (req, res, ctx) => {
  const b = await readJson(req, 4096);
  const name = String(b.name || '');
  if (!BACKUP_RE.test(name)) throw new HttpError(400, '备份文件名无效');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, '备份文件不存在');
  await confirmCurrentPassword(ctx, b.password, 'backup.download', '当前登录密码不正确');
  store.audit(ctx.user.username, ctx.ip, 'backup.download', { name });
  const st = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  // 读流出错（如文件在下载过程中被轮换删除）时中断连接，而不是让未处理的 error 事件导致进程退出
  const rs = fs.createReadStream(file);
  rs.on('error', e => { log('备份下载中断：' + e.message); res.destroy(e); });
  res.on('close', () => rs.destroy());
  rs.pipe(res);
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

/* Prometheus 文本格式指标（不含任何密钥与 Key 描述） */
function metricsText() {
  const st = sync.status(), today = todayIn(config.billTz), cycle = today.slice(0, 7);
  const L = [], g = (name, help, rows) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); for (const [labels, v] of rows) L.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`); };
  const lb = o => '{' + Object.entries(o).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '')}"`).join(',') + '}';
  g('tokentally_info', '版本信息', [[lb({ version: VERSION }), 1]]);
  g('tokentally_provider_configured', '云厂商访问密钥是否已配置', PROVIDER_LIST.map(p => [lb({ provider: p }), secretState(p) === 'ok' ? 1 : 0]));
  const sy = [], ok = [], run = [];
  for (const p of PROVIDER_LIST) for (const k of ['meta', 'bills']) {
    const x = st.providers[p][k];
    sy.push([lb({ provider: p, kind: k }), x.last?.status === 'error' ? 0 : 1]);
    ok.push([lb({ provider: p, kind: k }), x.lastSuccessAt ? Math.floor(x.lastSuccessAt / 1000) : 0]);
    run.push([lb({ provider: p, kind: k }), x.running ? 1 : 0]);
  }
  g('tokentally_sync_last_ok', '最近一次同步是否成功（1 成功/部分成功，0 失败）', sy);
  g('tokentally_sync_last_success_timestamp_seconds', '最近一次成功同步的 Unix 时间', ok);
  g('tokentally_sync_running', '同步任务是否运行中', run);
  const month = store.monthByKey(cycle), byProv = new Map();
  for (const r of month) byProv.set(r.provider, (byProv.get(r.provider) || 0) + (r.cost || 0));
  g('tokentally_cost_month_to_date', '本账期应付金额（元）', [...byProv.entries()].map(([p, v]) => [lb({ provider: p, cycle }), +v.toFixed(4)]));
  const b = store.budgets(), total = [...byProv.values()].reduce((s, v) => s + v, 0);
  if (b.monthly) g('tokentally_budget_usage_ratio', '月度总预算使用率', [[lb({ cycle }), +(total / b.monthly).toFixed(4)]]);
  const keys = store.listApiKeys();
  g('tokentally_api_keys', 'API Key 数量', PROVIDER_LIST.map(p => [lb({ provider: p, state: 'active' }), keys.filter(k => k.provider === p && !k.deleted_at).length]));
  const al = alerts.out();
  g('tokentally_alert_channel_error', '告警渠道最近一次发送是否失败', al.channels.map(c => [lb({ channel: c.name, type: c.type }), c.lastError && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt) ? 1 : 0]));
  g('tokentally_sessions_active', '有效登录会话数', [['', store.countSessions()]]);
  return L.join('\n') + '\n';
}

/* ===================================================================
 * 请求处理
 * =================================================================== */
async function handle(req, res) {
  const ip = clientIp(req);
  securityHeaders(req, res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(req, res, 400, 'Bad Request', 'text/plain'); }
  const p = url.pathname;
  // 健康检查不受 IP 白名单限制（容器 HEALTHCHECK 来自 127.0.0.1），且不返回任何业务信息
  if (p === '/healthz') return send(req, res, 200, 'ok', 'text/plain', { 'Cache-Control': 'no-store' });
  if (p === '/readyz') {
    try { store.q('SELECT 1').get(); return send(req, res, 200, 'ready', 'text/plain', { 'Cache-Control': 'no-store' }); }
    catch { return send(req, res, 503, 'database unavailable', 'text/plain', { 'Cache-Control': 'no-store' }); }
  }
  if (allowList && (!net.isIP(ip) || !allowList.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4'))) return send(req, res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  if (p === '/metrics') {
    if (!config.metricsToken) return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
    if (rateLimited(ip, 120, metricHits)) return send(req, res, 429, 'Too Many Requests', 'text/plain');
    const auth = String(req.headers.authorization || '');
    if (!safeEqual(auth, `Bearer ${config.metricsToken}`)) return send(req, res, 401, 'Unauthorized', 'text/plain', { 'WWW-Authenticate': 'Bearer' });
    return send(req, res, 200, metricsText(), 'text/plain; version=0.0.4; charset=utf-8', { 'Cache-Control': 'no-store' });
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(req, res, 405, 'Method Not Allowed', 'text/plain', { Allow: 'GET, HEAD, POST, PUT, DELETE' });
  if (rateLimited(ip)) return json(req, res, 429, { error: '请求过于频繁' });

  const token = sessionToken(req);
  // 前端后台轮询带 X-Background: 1，不刷新空闲计时：无人操作的页面会按 SESSION_IDLE_MINUTES 正常过期
  const session = token ? store.getSession(token, config.sessionIdleMinutes * 60_000, req.headers['x-background'] !== '1') : null;

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
server.listen(config.port, config.host, () => log(`TokenTally 大模型费用分析服务 v${VERSION} 已启动：http://${config.host}:${config.port}  数据目录：${config.dataDir}  账单时区：${config.billTz}`));

server.on('error', e => {
  log(`HTTP 服务启动失败：${e.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用` : e.code === 'EACCES' ? `没有权限监听端口 ${config.port}` : e.message}`);
  process.exit(1);
});

let exiting = false;
const shutdown = (sig, code = 0) => {
  if (exiting) return;
  exiting = true;
  log(`收到 ${sig}，正在退出…`);
  server.close(() => { try { store.db.close(); } catch { /* ignore */ } process.exit(code); });
  setTimeout(() => process.exit(code), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 未处理的异步异常只记录不退出；同步未捕获异常说明状态可能已不一致，记录后优雅退出（由容器 restart 策略拉起）
process.on('unhandledRejection', e => log('未处理的异步异常：', e?.stack || e));
process.on('uncaughtException', e => { log('未捕获异常：', e?.stack || e); shutdown('uncaughtException', 1); });
