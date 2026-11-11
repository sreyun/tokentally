/**
 * 阿里云百炼调用次数：百炼“监控告警”数据开启“监控数据投递”后写入云监控 Prometheus 实例，
 * 本模块通过标准 Prometheus HTTP API 读取（/api/v1/label/__name__/values、/api/v1/series、/api/v1/query_range）。
 * 百炼投递的指标名未公开，因此提供自动发现：按名称与标签打分，推荐“调用次数 / 失败次数”指标及 API Key、模型标签，
 * 管理员在页面预览确认后保存。
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { Writable, pipeline } from 'node:stream';

const METRIC_RE =/^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** 额外过滤条件：仅允许 label="v" / label!="v" / label=~"v" / label!~"v"，逗号分隔 */
const FILTER_RE = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"(?:[^"\\]|\\.)*"\s*(,\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"(?:[^"\\]|\\.)*"\s*)*$/;
export const PROM_AUTH = { none: '无', bearer: 'Bearer Token', raw: 'Authorization 头（原样）', basic: '用户名 / 密码（Basic）' };
export const DEFAULT_CALLS = { enabled: false, url: '', authType: 'bearer', username: '', metric: '', failMetric: '', keyLabel: '', modelLabel: '', aggregation: 'increase', filter: '', lookbackDays: 62 };
/** 影响数据口径的字段：修改后清空已同步的阿里云调用次数，避免新旧口径混在一起 */
export const MAPPING_FIELDS = ['url', 'metric', 'failMetric', 'keyLabel', 'modelLabel', 'aggregation', 'filter'];

/** 规范化 HTTP API 地址：去掉末尾的 / 与 /api/v1 */
export function normalizePromUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Prometheus HTTP API 地址格式不正确'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Prometheus 地址必须使用 http 或 https');
  if (u.username || u.password) throw new Error('地址中不能包含用户名或密码，请使用认证方式字段');
  u.hash = ''; u.search = '';
  return u.href.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

/** 校验并清洗配置（指标名 / 标签名 / 过滤条件），返回规范化的对象；不合法时抛出中文错误 */
export function validateCalls(c, { requireMetric = true } = {}) {
  const out = { ...DEFAULT_CALLS, ...c };
  out.authType = PROM_AUTH[out.authType] ? out.authType : 'bearer';
  out.aggregation = out.aggregation === 'sum' ? 'sum' : 'increase';
  out.url = out.url ? normalizePromUrl(out.url) : '';
  for (const k of ['metric', 'failMetric']) { out[k] = String(out[k] || '').trim(); if (out[k] && !METRIC_RE.test(out[k])) throw new Error(`指标名不合法：${out[k].slice(0, 60)}`); }
  for (const k of ['keyLabel', 'modelLabel']) { out[k] = String(out[k] || '').trim(); if (out[k] && !LABEL_RE.test(out[k])) throw new Error(`标签名不合法：${out[k].slice(0, 60)}`); }
  out.filter = String(out.filter || '').trim().slice(0, 300);
  if (out.filter && !FILTER_RE.test(out.filter)) throw new Error('过滤条件格式应为 label="value"，多个用逗号分隔');
  out.username = String(out.username || '').trim().slice(0, 100);
  out.enabled = !!out.enabled;
  const lb = Math.round(Number(out.lookbackDays));
  out.lookbackDays = Number.isFinite(lb) ? Math.min(400, Math.max(1, lb)) : DEFAULT_CALLS.lookbackDays;
  if (requireMetric && out.enabled) {
    if (!out.url) throw new Error('请填写 Prometheus HTTP API 地址');
    if (!out.metric) throw new Error('请选择调用次数指标');
    if (!out.keyLabel) throw new Error('请选择 API Key 标签');
  }
  return out;
}

/** 生成按日汇总的 PromQL：increase 适用于计数器，sum 适用于按周期写入的统计值 */
export function buildQuery({ metric, keyLabel, modelLabel, filter, aggregation }, range = '1d') {
  const sel = filter ? `${metric}{${filter}}` : metric;
  const by = [keyLabel, modelLabel].filter(Boolean).join(', ');
  return aggregation === 'sum' ? `sum by (${by}) (sum_over_time(${sel}[${range}]))` : `sum by (${by}) (increase(${sel}[${range}]))`;
}

/* ---------------- 时区与自然日 ---------------- */
function tzOffsetMs(ts, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const g = t => Number(p.find(x => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ts;
}
/** 账单时区中某自然日 00:00 对应的 Unix 秒 */
export function dayStartSec(day, tz) {
  const utc = Date.parse(day + 'T00:00:00Z');
  const guess = utc - tzOffsetMs(utc, tz);
  return Math.round((utc - tzOffsetMs(guess, tz)) / 1000);
}
const nextDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);

/**
 * 读取 [from, to] 每个自然日的调用次数（及失败次数）。
 * 已结束的自然日：每日 24:00 处求值 [1d] 窗口（时区无夏令时变化时用一次 query_range，否则逐日即时查询）；
 * 今天：从 0 点到当前时刻的窗口。返回 [{ day, keyValue, model, requests, fails }]
 */
export async function fetchCalls(client, cfg, { from, to, tz, nowSec = Math.floor(Date.now() / 1000) }) {
  const days = [];
  for (let d = from; d <= to; d = nextDay(d)) days.push(d);
  const full = days.filter(d => dayStartSec(nextDay(d), tz) <= nowSec);
  const today = days.find(d => !full.includes(d) && dayStartSec(d, tz) < nowSec);
  const cells = new Map();
  const put = (day, keyValue, model, field, v) => {
    const k = day + '\u0001' + keyValue + '\u0001' + model;
    const c = cells.get(k) || { day, keyValue, model, requests: 0, fails: 0 };
    c[field] += v; cells.set(k, c);
  };
  const metrics = [['requests', cfg.metric], ...(cfg.failMetric ? [['fails', cfg.failMetric]] : [])];
  for (const [field, metric] of metrics) {
    const q = { ...cfg, metric };
    if (full.length) {
      const ends = full.map(d => dayStartSec(nextDay(d), tz));
      const byEnd = new Map(ends.map((t, i) => [t, full[i]]));
      const uniform = ends.every((t, i) => !i || t - ends[i - 1] === 86400);
      if (uniform) {
        // 按 31 天分段查询：长回读窗口一次查询的响应在内存中会膨胀数十倍；
        // 返回点按最近的日终时刻（±12 小时）对应到自然日：部分后端（如 VictoriaMetrics、带缓存的查询前端）会把步长对齐到 UTC 零点
        const dayAt = t => { const i = Math.round((t - ends[0]) / 86400); return i >= 0 && i < full.length && Math.abs(t - ends[i]) <= 43200 ? full[i] : byEnd.get(Math.round(t)); };
        for (let i = 0; i < ends.length; i += 31) {
          const seg = ends.slice(i, i + 31);
          const data = await client.queryRange(buildQuery(q), seg[0], seg[seg.length - 1], 86400);
          for (const r of parseDaily(data, { ...cfg, dayOf: dayAt })) put(r.day, r.keyValue, r.model, field, r.value);
        }
      } else {
        for (const d of full) {
          const s = dayStartSec(d, tz), e = dayStartSec(nextDay(d), tz);
          const data = await client.query(buildQuery(q, `${e - s}s`), e);
          for (const r of parseDaily(data, { ...cfg, dayOf: () => d })) put(r.day, r.keyValue, r.model, field, r.value);
        }
      }
    }
    if (today && nowSec - dayStartSec(today, tz) >= 60) {
      const data = await client.query(buildQuery(q, `${nowSec - dayStartSec(today, tz)}s`), nowSec);
      for (const r of parseDaily(data, { ...cfg, dayOf: () => today })) put(r.day, r.keyValue, r.model, field, r.value);
    }
  }
  return [...cells.values()];
}

/* 目标地址校验：云监控 Prometheus 的 VPC 内网地址可能解析到 10.x / 100.64.x 等私网段，因此只拦截
 * 云服务器元数据地址（100.100.100.200、169.254.0.0/16）、本机回环、未指定与组播地址，连接时校验（防 DNS 重绑定） */
const BLOCKED = new net.BlockList();
BLOCKED.addAddress('100.100.100.200', 'ipv4');
for (const [a, p] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, p, 'ipv6');
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4'); LOOPBACK.addAddress('::1', 'ipv6');
export function promBlocked(ip, allowLoopback = false) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) ip = m[1];
  const fam = net.isIP(ip), t = fam === 6 ? 'ipv6' : 'ipv4';
  if (!fam) return true;
  return BLOCKED.check(ip, t) || (!allowLoopback && LOOPBACK.check(ip, t));
}
function guardedLookup(allowLoopback) {
  return (hostname, options, cb) => dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find(a => promBlocked(a.address, allowLoopback));
    if (!addrs.length || bad) return cb(Object.assign(new Error(`目标地址 ${bad?.address || hostname} 不允许访问（元数据 / 本机 / 保留地址）`), { code: 'EBLOCKED' }));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
const MAX_BODY = 32 * 1024 * 1024;

export class PromClient {
  constructor({ url, authType = 'none', token = '', username = '', password = '', allowLoopback = false, timeoutMs = 20_000 }) {
    this.base = normalizePromUrl(url);
    this.allowLoopback = allowLoopback;
    this.timeoutMs = timeoutMs;
    this.calls = 0;
    this.headers = { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'tokentally' };
    if (authType === 'bearer' && token) this.headers.Authorization = /^(bearer|basic)\s/i.test(token) ? token : `Bearer ${token}`;
    else if (authType === 'raw' && token) this.headers.Authorization = token;
    else if (authType === 'basic' && (username || password)) this.headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }
  /**
   * 原始 GET：返回 { status, text }；仅 http/https，不跟随重定向，限制大小与超时。
   * 响应体用 stream.pipeline 读取：gzip 响应中途断开（代理超时、Prometheus 重启）时也会报错，而不是让 Promise 永远挂起、
   * 进而卡住整个账单同步；另设总时限，不依赖套接字空闲超时
   */
  raw(u) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && promBlocked(host, this.allowLoopback)) return Promise.reject(Object.assign(new Error(`目标地址 ${host} 不允许访问（元数据 / 本机 / 保留地址）`), { code: 'EBLOCKED' }));
    const mod = u.protocol === 'https:' ? https : http;
    this.calls++;
    return new Promise((resolve, reject) => {
      let done = false, req = null;
      const finish = (err, v) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (err) { req?.destroy(); reject(err); } else resolve(v);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })), Math.max(60_000, this.timeoutMs * 3));
      timer.unref?.();
      req = mod.request(u, { method: 'GET', headers: this.headers, timeout: this.timeoutMs, lookup: guardedLookup(this.allowLoopback) }, res => {
        const chunks = []; let size = 0;
        const sink = new Writable({
          write(c, _enc, cb) {
            size += c.length;
            if (size > MAX_BODY) return cb(new Error('Prometheus 响应过大，请缩小查询范围或增加过滤条件'));
            chunks.push(c); cb();
          },
        });
        const streams = /gzip/i.test(res.headers['content-encoding'] || '') ? [res, zlib.createGunzip(), sink] : [res, sink];
        pipeline(...streams, err => (err ? finish(err.code === 'ERR_STREAM_PREMATURE_CLOSE' ? Object.assign(new Error('响应中断'), { code: 'ECONNRESET' }) : err)
          : finish(null, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
      req.on('error', e => finish(e));
      req.end();
    });
  }
  async get(path, params = {}) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) u.searchParams.append(k, String(x));
    let res;
    try { res = await this.raw(u); } catch (e) { throw new Error(e.code === 'EBLOCKED' ? e.message : `无法连接 Prometheus：${e.code || e.message}`); }
    if (res.status >= 300 && res.status < 400) throw new Error(`Prometheus 返回重定向（HTTP ${res.status}），请填写最终的 HTTP API 地址`);
    if (res.status === 401 || res.status === 403) throw new Error(`Prometheus 认证失败（HTTP ${res.status}），请检查认证方式与 Token`);
    let j;
    try { j = JSON.parse(res.text); } catch { throw new Error(`Prometheus 返回的不是 JSON（HTTP ${res.status}），请确认填写的是 HTTP API 地址`); }
    if (j.status !== 'success') throw new Error(`Prometheus 查询失败：${[j.errorType, j.error].filter(Boolean).join(' ') || 'HTTP ' + res.status}`.slice(0, 300));
    return j.data;
  }
  /** 即时查询（time 为 Unix 秒） */
  query(query, time) { return this.get('/api/v1/query', { query, time }); }
  metricNames() { return this.get('/api/v1/label/__name__/values'); }
  async series(metric, start, end, limit = 200) {
    const d = await this.get('/api/v1/series', { 'match[]': metric, start, end, limit });
    return Array.isArray(d) ? d.slice(0, limit) : [];
  }
  queryRange(query, start, end, step) { return this.get('/api/v1/query_range', { query, start, end, step }); }
}

/* ---------------- 自动发现 ---------------- */
const SCORE = [
  [/bailian|dashscope|model_?studio|modelstudio|百炼/i, 6], [/llm|model|maas|inference|token/i, 2],
  [/call|invoc|invok|request|req_|_req|count|total/i, 3],
];
const keyLabelScore = l => (/^(api_?key_?id|apikey_?id|apikeyid)$/i.test(l) ? 10 : /api_?key|apikey/i.test(l) ? 7 : /access_?key|key_?id|^key$/i.test(l) ? 4 : 0);
const modelLabelScore = l => (/^(model|model_?name|model_?id|model_?code)$/i.test(l) ? 10 : /model/i.test(l) ? 6 : 0);
const failScore = n => (/fail|error|err_|_err|exception/i.test(n) ? 1 : 0);

/** 从指标名中挑选候选，并读取样例序列的标签，给出推荐映射 */
export async function discover(client, { now = Math.floor(Date.now() / 1000) } = {}) {
  const names = await client.metricNames();
  const scored = (names || []).map(n => ({ name: n, score: SCORE.reduce((s, [re, w]) => s + (re.test(n) ? w : 0), 0) }))
    .filter(x => x.score >= 3 && !/^(up|scrape_|prometheus_|go_|process_|node_)/.test(x.name))
    .sort((a, b) => b.score - a.score).slice(0, 25);
  const candidates = [];
  for (const c of scored) {
    let labels = [], sample = {};
    try {
      const ser = await client.series(c.name, now - 7 * 86400, now, 50);
      labels = [...new Set(ser.flatMap(s => Object.keys(s)).filter(l => l !== '__name__'))].sort();
      sample = ser[0] || {};
    } catch { /* 个别指标读取失败不影响其他 */ }
    const kl = labels.map(l => [l, keyLabelScore(l)]).sort((a, b) => b[1] - a[1])[0];
    const ml = labels.map(l => [l, modelLabelScore(l)]).sort((a, b) => b[1] - a[1])[0];
    candidates.push({
      name: c.name, labels, keyLabel: kl && kl[1] ? kl[0] : '', modelLabel: ml && ml[1] ? ml[0] : '',
      sample: Object.fromEntries(Object.entries(sample).filter(([k]) => k !== '__name__').slice(0, 8)),
      score: c.score + (kl && kl[1] ? 5 : 0) + (ml && ml[1] ? 2 : 0), fail: !!failScore(c.name),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const main = candidates.find(c => !c.fail && c.keyLabel) || candidates.find(c => !c.fail) || null;
  const fail = main ? candidates.find(c => c.fail && c.keyLabel === main.keyLabel && c.name !== main.name) : null;
  const guess = main ? {
    metric: main.name, failMetric: fail?.name || '', keyLabel: main.keyLabel, modelLabel: main.modelLabel,
    aggregation: /_total$|_count$|counter/i.test(main.name) ? 'increase' : 'sum',
  } : null;
  return { totalMetrics: (names || []).length, candidates, guess };
}

/** 查询结果（matrix / vector）→ { day, keyValue, model, value }；dayOf(t) 把求值时间映射到自然日，无法映射的样本忽略 */
export function parseDaily(data, { keyLabel, modelLabel, dayOf }) {
  const out = [];
  for (const s of data?.result || []) {
    const keyValue = String(s.metric?.[keyLabel] ?? ''), model = modelLabel ? String(s.metric?.[modelLabel] ?? '') : '';
    for (const [t, v] of s.values || (s.value ? [s.value] : [])) {
      const n = Number(v), day = dayOf(Number(t));
      if (!day || !Number.isFinite(n)) continue;
      const value = Math.round(n); // increase() 外推可能得到 0.3 这样的值：四舍五入为 0 的不生成“0 次调用”的行
      if (value <= 0) continue;
      out.push({ day, keyValue, model, value });
    }
  }
  return out;
}

/** 阿里云计费项 io → Token 方向（与前端 ioInfo 一致）：in / out / emb / other，以及是否缓存命中 */
export function ioClass(io) {
  let s = String(io || '');
  const m = s.match(/^context_([^_]+)_(.+)$/); if (m) s = m[2];
  if (/^thinking_/.test(s)) s = s.slice(9);
  s = s.replace(/_(offpeak|peak)$/, '');
  const dir = /^output/.test(s) ? 'out' : /^input/.test(s) ? 'in' : /^embedding/.test(s) ? 'emb' : 'other';
  return { dir, hit: /cache/.test(s) && !/cache_creation/.test(s) };
}
export const normModel = s => String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '');

/**
 * 把调用次数单元格映射为用量行：标签值 → Key ID；模型名按规范化名称对齐账单；Token 取同日同 Key 同模型的账单 Token，
 * 使“单次平均 Token / 费用”与账单口径一致。返回 { rows, unmatched: Map(标签值 → 调用次数), firstDay }
 */
export function buildUsageRows(cells, { keys, billTokens }) {
  const map = keyMapper(keys);
  const tok = new Map(), tokKey = new Map(), names = new Map();
  for (const b of billTokens) {
    const c = ioClass(b.io), t = Number(b.tokens) || 0;
    if (!t) continue;
    for (const [m, k] of [[tok, `${b.day}\u0001${b.api_key_id || ''}\u0001${normModel(b.model)}`], [tokKey, `${b.day}\u0001${b.api_key_id || ''}`]]) {
      const a = m.get(k) || { input: 0, output: 0, cache: 0, total: 0 };
      a.total += t;
      if (c.dir === 'in') { a.input += t; if (c.hit) a.cache += t; } else if (c.dir === 'out') a.output += t;
      m.set(k, a);
    }
    if (b.model) names.set(normModel(b.model), b.model);
  }
  const rows = new Map(), unmatched = new Map();
  let firstDay = '';
  for (const c of cells) {
    if (!firstDay || c.day < firstDay) firstDay = c.day;
    const r = map(c.keyValue);
    if (!r.matched) { unmatched.set(c.keyValue, (unmatched.get(c.keyValue) || 0) + c.requests); continue; }
    const nm = normModel(c.model), model = c.model ? (names.get(nm) || c.model) : '';
    const k = `${c.day}\u0001${r.id}\u0001${model}`;
    const row = rows.get(k) || { day: c.day, api_key_id: r.id, model, requests: 0, fails: 0, input_tokens: 0, output_tokens: 0, cache_tokens: 0, total_tokens: 0 };
    row.requests += c.requests; row.fails += Math.min(c.fails, c.requests);
    rows.set(k, row);
  }
  // 模型名对不上的行：把该 Key 当日未被其他模型认领的账单 Token 按调用次数比例分给它们，保证 Key 级单次平均与账单一致。
  // 没有模型名的行（未配置模型标签，或个别序列缺少该标签）只有在该 Key 当日没有其他带模型名的行时才取整个 Key 的 Token，
  // 否则与模型行重复计算，按剩余未认领的 Token 分配
  const withModel = new Set();
  for (const row of rows.values()) if (row.model) withModel.add(`${row.day}\u0001${row.api_key_id}`);
  const pending = new Map(), claimedBy = new Map();
  for (const row of rows.values()) {
    const dk = `${row.day}\u0001${row.api_key_id}`;
    const a = row.model ? tok.get(`${dk}\u0001${normModel(row.model)}`) : (withModel.has(dk) ? null : tokKey.get(dk));
    if (a) {
      Object.assign(row, { input_tokens: a.input, output_tokens: a.output, cache_tokens: a.cache, total_tokens: a.total });
      const c = claimedBy.get(dk) || { input: 0, output: 0, cache: 0, total: 0 };
      c.input += a.input; c.output += a.output; c.cache += a.cache; c.total += a.total; claimedBy.set(dk, c);
    } else if (row.model || withModel.has(dk)) { if (!pending.has(dk)) pending.set(dk, []); pending.get(dk).push(row); }
  }
  for (const [k, list] of pending) {
    const all = tokKey.get(k);
    if (!all) continue;
    const claimed = claimedBy.get(k) || { input: 0, output: 0, cache: 0, total: 0 };
    const rest = { input: all.input - claimed.input, output: all.output - claimed.output, cache: all.cache - claimed.cache, total: all.total - claimed.total };
    if (rest.total <= 0) continue;
    // 权重合计必须为 1：按调用次数分配；全部为 0 次时平均分配
    const req = list.reduce((s, r) => s + r.requests, 0);
    for (const row of list) {
      const w = req > 0 ? row.requests / req : 1 / list.length;
      Object.assign(row, { input_tokens: Math.max(0, rest.input * w), output_tokens: Math.max(0, rest.output * w), cache_tokens: Math.max(0, rest.cache * w), total_tokens: rest.total * w });
    }
  }
  return { rows: [...rows.values()], unmatched, firstDay };
}

/** 标签值 → 阿里云 API Key ID：ID 直接匹配，其次脱敏 Key 值、唯一描述 */
export function keyMapper(keys) {
  const ids = new Set(keys.map(k => k.api_key_id));
  const masked = new Map(keys.filter(k => k.api_key_masked).map(k => [k.api_key_masked, k.api_key_id]));
  const descCount = new Map();
  for (const k of keys) if (k.description) descCount.set(k.description, (descCount.get(k.description) || 0) + 1);
  const desc = new Map(keys.filter(k => k.description && descCount.get(k.description) === 1).map(k => [k.description, k.api_key_id]));
  return v => {
    const s = String(v || '').trim();
    if (!s) return { id: '', matched: true };
    if (ids.has(s)) return { id: s, matched: true };
    if (masked.has(s)) return { id: masked.get(s), matched: true };
    if (desc.has(s)) return { id: desc.get(s), matched: true };
    return { id: s, matched: false };
  };
}
