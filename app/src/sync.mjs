/**
 * 定时同步（多云：阿里云百炼 + 腾讯云 TokenHub，各自独立调度、互不阻塞）：
 *  - 元数据（业务空间 / API Key / 描述 / 权限）：默认每 5 分钟，与云厂商保持一致，记录新增/修改/删除
 *  - 账单：
 *    阿里云：按“账期(月)”与“日”两种粒度分别拉取实例账单整体替换入库，口径与费用中心一致
 *    腾讯云：按账期拉取账单明细（按资源出账）+ TokenHub 用量（Key × 模型 × 日），按用量占比把真实账单金额分摊到 Key
 */
import { AliyunClient, normalizeBillItem } from './aliyun.mjs';
import {
  TencentClient, normalizeTencentKey, tencentBillRows, rollupMonth, allocate, parseSeries, priceTable, estimateRows,
  tcWorkspaceId, tcWorkspaceName, TC_PRODUCT_RE,
} from './tencent.mjs';

const BAILIAN_RE = /百炼|bailian|model\s*studio|dashscope|灵积/i;
export const PROVIDER_LIST = ['aliyun', 'tencent'];
export const PROVIDER_NAMES = { aliyun: '阿里云', tencent: '腾讯云' };

export function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function hourIn(tz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date())) % 24;
}
export function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function addMonths(cycle, n) {
  const [y, m] = cycle.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
export const lastDayOf = cycle => addDays(addMonths(cycle, 1) + '-01', -1);
export function daysInCycle(cycle, today) {
  const out = [];
  for (let d = cycle + '-01'; d.slice(0, 7) === cycle && d <= today; d = addDays(d, 1)) out.push(d);
  return out;
}
/** 次月 3 日后出账，4 日起视为已结算（阿里云、腾讯云均于次月初出账） */
export const isCycleFinal = (cycle, today) => today >= addDays(addMonths(cycle, 1) + '-01', 3);

export async function pool(tasks, n, onDone) {
  const results = new Array(tasks.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { ok: true, v: await tasks[i]() }; } catch (e) { results[i] = { ok: false, e }; }
      onDone?.(++done, tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, worker));
  return results;
}

const SECRET_KEYS = {
  aliyun: ['aliyun.accessKeyId', 'aliyun.accessKeySecret'],
  tencent: ['tencent.secretId', 'tencent.secretKey'],
};
const PERM_RE = /Unauthorized|OperationDenied|AuthFailure\.Unauthorized|NotAuthorized|Forbidden|NoPermission/i;

export class SyncService {
  constructor({ store, tz, log, tencentEndpoint = '' }) {
    Object.assign(this, { store, tz, log, tencentEndpoint });
    this.running = {};     // `${provider}:${kind}` → runId
    this.progress = {};
    this.lastAttempt = {};
    this.timer = null;
  }

  /** 'ok' | 'none' | 'undecryptable' */
  secretState(provider) {
    try {
      const [a, b] = SECRET_KEYS[provider];
      return this.store.getSecret(a) && this.store.getSecret(b) ? 'ok' : 'none';
    } catch { return 'undecryptable'; }
  }
  credentials(provider) {
    try {
      const [a, b] = SECRET_KEYS[provider];
      const id = this.store.getSecret(a), secret = this.store.getSecret(b);
      return id && secret ? { id, secret } : null;
    } catch { return null; }
  }
  configured() { return PROVIDER_LIST.filter(p => this.credentials(p)); }

  client(provider) {
    const c = this.credentials(provider);
    if (provider === 'tencent') {
      if (!c) throw new Error('尚未配置腾讯云 API 密钥（或主密钥变化导致无法解密），请在“系统管理 → 腾讯云接入”中配置');
      const t = this.store.tencentSettings();
      return new TencentClient({ secretId: c.id, secretKey: c.secret, region: t.region, site: t.site, endpoint: this.tencentEndpoint });
    }
    if (!c) throw new Error('尚未配置阿里云 AccessKey（或主密钥变化导致无法解密），请在“系统管理 → 阿里云接入”中配置');
    const a = this.store.aliyunSettings();
    return new AliyunClient({ accessKeyId: c.id, accessKeySecret: c.secret, msRegion: a.msRegion, bssSite: a.bssSite });
  }

  start() {
    for (const p of PROVIDER_LIST) for (const k of ['meta', 'bills']) this.lastAttempt[`${p}:${k}`] = this.store.lastRun(k, null, p)?.started_at || 0;
    setTimeout(() => this.tick(), 5_000);
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref?.();
  }

  tick() {
    const s = this.store.syncSettings();
    const now = Date.now();
    for (const p of this.configured()) {
      const m = `${p}:meta`, b = `${p}:bills`;
      if (!this.running[m] && now - (this.lastAttempt[m] || 0) >= s.metaIntervalMin * 60_000) this.run('meta', 'schedule', { provider: p });
      if (!this.running[b] && !this.running[m] && now - (this.lastAttempt[b] || 0) >= s.billIntervalMin * 60_000) this.run('bills', 'schedule', { provider: p });
    }
  }

  /** 异步启动任务；同一厂商同类任务运行中则直接返回运行中的任务 */
  run(kind, trig, opts = {}) {
    const provider = opts.provider || 'aliyun';
    const key = `${provider}:${kind}`;
    if (this.running[key]) return { runId: this.running[key], alreadyRunning: true, provider };
    const runId = Number(this.store.startRun(kind, trig, provider));
    this.running[key] = runId;
    this.lastAttempt[key] = Date.now();
    this.progress[key] = { text: '准备中…', done: 0, total: 0 };
    const t0 = Date.now();
    (async () => {
      let client;
      try {
        client = this.client(provider);
        const detail = provider === 'tencent'
          ? (kind === 'meta' ? await this.syncTencentMeta(client) : await this.syncTencentBills(client, opts))
          : (kind === 'meta' ? await this.syncMeta(client) : await this.syncBills(client, opts));
        const status = detail.warnings?.length ? 'partial' : 'success';
        this.store.finishRun(runId, status, detail, detail.warnings?.length ? detail.warnings.slice(0, 5).join('；') : null, client.calls);
        this.log(`同步[${PROVIDER_NAMES[provider]}·${kind}] ${status} ${Date.now() - t0}ms ${client.calls} 次调用`);
        if (kind === 'bills') Promise.resolve().then(() => this.onBillsSynced?.(provider)).catch(e => this.log('账单同步后处理失败：' + e.message));
      } catch (e) {
        this.store.finishRun(runId, 'error', null, String(e.message || e).slice(0, 500), client?.calls ?? 0);
        this.log(`同步[${PROVIDER_NAMES[provider]}·${kind}] 失败: ${e.message}`);
      } finally {
        this.running[key] = null;
        this.progress[key] = null;
        this.lastAttempt[key] = Date.now();
        Promise.resolve().then(() => this.onRunFinished?.(provider, kind)).catch(() => { /* ignore */ });
        setTimeout(() => this.tick(), 1000).unref?.(); // 元数据同步完成后立即检查是否需要同步账单
      }
    })();
    return { runId, provider };
  }

  setProgress(provider, kind, text, done = 0, total = 0) { this.progress[`${provider}:${kind}`] = { text, done, total }; }

  /* ===================== 阿里云 ===================== */
  async syncMeta(c) {
    const s = this.store.syncSettings();
    const P = (t, d, n) => this.setProgress('aliyun', 'meta', t, d, n);
    P('读取业务空间…');
    const ws = await c.listAll('ListWorkspaces', {}, 'workspaces');
    P('读取 API Key…');
    const keys = new Map();
    for (const k of await c.listAll('ListApiKeys', {}, 'apiKeys')) keys.set(String(k.apiKeyId), k);
    const warnings = [];
    let complete = true;
    if (s.perWorkspaceKeys) {
      let i = 0;
      for (const w of ws) {
        P(`补全业务空间 API Key ${++i}/${ws.length}`, i, ws.length);
        try {
          for (const k of await c.listAll('ListApiKeys', { workspaceId: w.workspaceId }, 'apiKeys')) {
            const id = String(k.apiKeyId);
            const cur = keys.get(id);
            // 全局列表缺少归属信息时，用按业务空间查询的结果补全
            if (!cur) keys.set(id, k);
            else if ((!cur.workspaceId || cur.workspaceId === '-') && k.workspaceId && k.workspaceId !== '-') keys.set(id, { ...cur, workspaceId: k.workspaceId, workspaceName: k.workspaceName || cur.workspaceName });
          }
        } catch (e) {
          complete = false;
          warnings.push(`业务空间 ${w.workspaceName} 的 API Key 获取失败：${e.code || e.message}`);
        }
      }
    }
    const changes = this.store.applyMeta('aliyun', ws, [...keys.values()], { markMissing: complete });
    return { workspaces: ws.length, apiKeys: keys.size, changes, warnings };
  }

  async detectCodes(c, cycle, warnings) {
    const fixed = (this.store.aliyunSettings().productCode || '').split(/[,\s]+/).filter(Boolean);
    if (fixed.length) return fixed;
    try {
      const r = await c.call('bss', 'QueryBillOverview', { BillingCycle: cycle });
      const items = Array.isArray(r.Data?.Items) ? r.Data.Items : (r.Data?.Items?.Item || []);
      return [...new Set(items.filter(it => BAILIAN_RE.test(it.ProductName || '') || /^sfm/i.test(it.ProductCode || '') || /^sfm/i.test(it.PipCode || ''))
        .map(it => it.ProductCode).filter(Boolean))];
    } catch (e) {
      warnings.push(`${cycle} 账单总览获取失败，按默认产品代码 sfm 拉取：${e.code || e.message}`);
      return ['sfm'];
    }
  }

  needDay(day, code, today, final) {
    const p = this.store.getPeriod('aliyun', 'D', day, code);
    if (!p) return true;
    if (p.final) return false;
    if (final) return true;                         // 账期已出账：再同步一次并标记为终版
    if (day >= addDays(today, -3)) return true;      // 最近 3 天账单仍会持续入账
    return Date.now() - p.synced_at > 12 * 3600_000; // 其余未出账日每 12 小时校正一次
  }

  cyclesToSync(opts) {
    const s = this.store.syncSettings();
    const cur = todayIn(this.tz).slice(0, 7);
    const back = Math.min(18, Math.max(1, s.backfillMonths || 3));
    return (opts.cycles?.length ? opts.cycles : Array.from({ length: back }, (_, i) => addMonths(cur, -i))).filter(x => /^\d{4}-\d{2}$/.test(x) && x <= cur);
  }

  async syncBills(c, opts = {}) {
    const s = this.store.syncSettings();
    const today = todayIn(this.tz);
    const warnings = [];
    const summary = { cycles: [], warnings };
    const P = (t, d, n) => this.setProgress('aliyun', 'bills', t, d, n);
    for (const cycle of this.cyclesToSync(opts)) {
      const final = isCycleFinal(cycle, today);
      const known = this.store.getCycle(cycle, 'aliyun');
      if (final && known?.final && !opts.force) { summary.cycles.push({ cycle, skipped: '已出账且已同步' }); continue; }
      P(`${cycle}：识别百炼产品代码…`);
      const codes = await this.detectCodes(c, cycle, warnings);
      let monthly = 0, daily = 0, failedDays = 0;
      for (const code of codes) {
        P(`${cycle}：拉取账期（月）账单…`);
        const m = await c.describeInstanceBill({ BillingCycle: cycle, ProductCode: code, Granularity: 'MONTHLY', IsBillingItem: true });
        this.store.replaceBillPeriod('aliyun', 'M', cycle, cycle, code, m.map(normalizeBillItem), final);
        monthly += m.length;
        const days = daysInCycle(cycle, today).filter(d => opts.force || this.needDay(d, code, today, final));
        const res = await pool(days.map(day => async () => {
          const items = await c.describeInstanceBill({ BillingCycle: cycle, ProductCode: code, Granularity: 'DAILY', BillingDate: day, IsBillingItem: true });
          this.store.replaceBillPeriod('aliyun', 'D', day, cycle, code, items.map(normalizeBillItem), final);
          return items.length;
        }), Math.min(6, Math.max(1, s.concurrency || 3)), (d, t) => P(`${cycle}：拉取按日账单 ${d}/${t}`, d, t));
        for (const r of res) { if (r.ok) daily += r.v; else failedDays++; }
        if (failedDays) warnings.push(`${cycle} 有 ${failedDays} 天的日账单拉取失败：${res.find(r => !r.ok).e.code || res.find(r => !r.ok).e.message}`);
      }
      try {
        P(`${cycle}：百炼账单接口对账…`);
        const r = await c.call('modelstudio', 'GetBillingOverview', { billMonth: cycle, groupBy: [{ code: 'API_KEY_ID' }], topNum: 20, zeroFilter: true, locale: 'zh-CN' });
        this.store.replaceMsOverview(cycle, 'API_KEY_ID', r.data?.groups || []);
      } catch (e) {
        warnings.push(`${cycle} 百炼账单汇总接口（对账）不可用：${e.code || e.message}`);
      }
      this.store.markCycle('aliyun', cycle, codes, final && !failedDays);
      summary.cycles.push({ cycle, codes, monthly, daily, final });
    }
    return summary;
  }

  /* ===================== 腾讯云 TokenHub ===================== */
  async syncTencentMeta(c) {
    const t = this.store.tencentSettings();
    const warnings = [];
    this.setProgress('tencent', 'meta', '读取 TokenHub API Key…');
    const keys = await c.listApiKeys();
    try {
      this.setProgress('tencent', 'meta', '读取推理服务（接入点）…');
      const eps = await c.listEndpoints();
      this.store.setSetting('tencent.endpoints', eps.filter(e => e.EndpointId).map(e => [String(e.EndpointId), String(e.ModelId || e.ModelName || '')]));
    } catch (e) {
      warnings.push(`推理服务列表获取失败（不影响 Key 同步）：${e.code || e.message}`);
    }
    const ws = [{ workspaceId: tcWorkspaceId(t.region), workspaceName: tcWorkspaceName(t.region), region: t.region, serviceSite: t.site }];
    const changes = this.store.applyMeta('tencent', ws, keys.map(k => normalizeTencentKey(k, t.region)), { markMissing: true });
    return { workspaces: 1, apiKeys: keys.length, changes, warnings };
  }

  async detectTencentCodes(c, cycle, warnings) {
    const fixed = (this.store.tencentSettings().businessCode || '').split(/[,\s]+/).filter(Boolean);
    if (fixed.length) return fixed;
    const r = await c.billSummary(cycle);
    if (r.Ready === 0) warnings.push(`${cycle} 腾讯云账单数据准备中（首次出账约需 10 分钟），稍后自动重试`);
    return [...new Set((r.SummaryOverview || []).filter(x => TC_PRODUCT_RE.test(`${x.BusinessCodeName || ''} ${x.BusinessCode || ''}`)).map(x => x.BusinessCode).filter(Boolean))];
  }

  async syncTencentBills(c, opts = {}) {
    const s = this.store.syncSettings(), t = this.store.tencentSettings();
    const today = todayIn(this.tz);
    const warnings = [];
    const summary = { cycles: [], warnings };
    const P = (x, d, n) => this.setProgress('tencent', 'bills', x, d, n);
    const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dayOf = ts => fmtDay.format(new Date(Number(ts) * 1000));
    const ws = tcWorkspaceId(t.region);
    for (const cycle of this.cyclesToSync(opts)) {
      const final = isCycleFinal(cycle, today);
      const known = this.store.getCycle(cycle, 'tencent');
      if (final && known?.final && !opts.force) { summary.cycles.push({ cycle, skipped: '已出账且已同步' }); continue; }
      const days = daysInCycle(cycle, today);
      if (!days.length) continue;
      const from = days[0], to = days[days.length - 1];
      const start = `${from}T00:00:00+08:00`, end = `${addDays(to, 1)}T00:00:00+08:00`;

      // 1) 用量：Key × 模型 × 日（精确值，用于分摊与请求数分析）
      let usage, usageOk = true;
      try {
        P(`${cycle}：读取 TokenHub 用量排行…`);
        const active = await c.usageKeys(start, end);
        for (const k of active) this.store.ensureGhostKey('tencent', String(k.Key || ''), k.Name, ws);
        const res = await pool(active.map(k => async () => {
          const u = await c.usageOfKey(String(k.Key), start, end);
          const rows = [];
          for (const it of u.items) for (const r of parseSeries(u.timestamps, it.Series, dayOf)) if (r.day >= from && r.day <= to) rows.push({ ...r, api_key_id: String(k.Key), model: String(it.Key || '(未知模型)') });
          return rows;
        }), Math.min(4, Math.max(1, s.concurrency || 3)), (d, n) => P(`${cycle}：读取 API Key 用量 ${d}/${n}`, d, n));
        const failed = res.filter(r => !r.ok);
        if (failed.length) { usageOk = false; warnings.push(`${cycle} 有 ${failed.length} 个 API Key 的用量获取失败：${failed[0].e.code || failed[0].e.message}`); }
        usage = res.filter(r => r.ok).flatMap(r => r.v);
        if (usageOk) this.store.replaceUsage('tencent', from, to, usage);
        else { const stored = this.store.usageRows('tencent', from, to); if (stored.length) usage = stored; }
      } catch (e) {
        usageOk = false;
        warnings.push(`${cycle} TokenHub 用量获取失败，费用暂无法分摊到 API Key：${e.code || e.message}`);
        usage = this.store.usageRows('tencent', from, to);
      }
      // 早于用量统计保留期的已出账账期：用量接口不会再有数据，不能因此每小时重复拉取，按已有用量定稿
      if (!usageOk && final && to < addDays(today, -60)) {
        usageOk = true;
        warnings.push(`${cycle} 已超出 TokenHub 用量统计保留期，按本地已保存的用量分摊并定稿`);
      }

      // 2) 账单：识别 BusinessCode → 拉取明细（无费用权限时可按目录价估算）
      let rows = null, codes = [], estimated = false;
      try {
        P(`${cycle}：识别 TokenHub 产品代码…`);
        codes = await this.detectTencentCodes(c, cycle, warnings);
        const raw = [];
        for (const code of codes) { P(`${cycle}：拉取账单明细（${code}）…`); raw.push(...await c.billDetail(cycle, code)); }
        const keyIds = new Set(this.store.listApiKeys().filter(k => k.provider === 'tencent').map(k => k.api_key_id));
        rows = tencentBillRows(raw, { region: t.region, endpointModel: new Map(this.store.getSetting('tencent.endpoints', []) || []), keyIds });
      } catch (e) {
        if (PERM_RE.test(e.code || '') && t.estimate) {
          try {
            P(`${cycle}：无费用中心权限，按模型目录价估算…`);
            rows = estimateRows(usage, priceTable(await c.listModels()), t.region, id => this.keyWs(id));
            estimated = true; codes = ['estimate'];
            warnings.push(`${cycle} 缺少腾讯云费用中心只读权限，已按 TokenHub 目录价估算费用（不含折扣与阶梯价）`);
          } catch (e2) { warnings.push(`${cycle} 目录价估算失败：${e2.code || e2.message}`); }
        } else warnings.push(`${cycle} 腾讯云账单获取失败：${e.code || e.message}`);
      }
      if (!rows) { summary.cycles.push({ cycle, failed: true }); continue; }

      // 3) 拆分到日并按用量分摊：先用当日用量，未匹配到的再用整月用量
      const keyWs = id => this.keyWs(id) || ws;
      const monthUsage = new Map();
      for (const u of usage) {
        const k = u.api_key_id + '\u0001' + u.model;
        const m = monthUsage.get(k) || { api_key_id: u.api_key_id, model: u.model, input_tokens: 0, output_tokens: 0, cache_tokens: 0, total_tokens: 0 };
        for (const f of ['input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens']) m[f] += u[f] || 0;
        monthUsage.set(k, m);
      }
      const usageByDay = new Map();
      for (const u of usage) { if (!usageByDay.has(u.day)) usageByDay.set(u.day, []); usageByDay.get(u.day).push(u); }
      const byDay = new Map();
      for (const r of rows) {
        const day = r.day >= from && r.day <= to ? r.day : (r.day < from ? from : to);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(r);
      }
      const dayRows = new Map();
      let allocated = 0, unassigned = 0;
      for (const [day, list] of byDay) {
        const first = estimated ? list : allocate(list, usageByDay.get(day) || [], keyWs);
        const rest = first.filter(r => !r.api_key_id);
        const out = [...first.filter(r => r.api_key_id), ...(rest.length ? allocate(rest, [...monthUsage.values()], keyWs) : [])];
        for (const r of out) { if (r.alloc === 1) allocated += r.pretax; else if (!r.api_key_id) unassigned += r.pretax; }
        dayRows.set(day, out);
      }
      const monthRows = rollupMonth([...dayRows.values()].flat());
      this.store.replaceBillCycle('tencent', cycle, estimated ? 'estimate' : (codes.join('+') || 'tokenhub'), dayRows, days, monthRows, final && !estimated && usageOk);
      this.store.markCycle('tencent', cycle, codes, final && !estimated && usageOk);
      if (unassigned > 0.005 && usage.length) warnings.push(`${cycle} 有 ¥${unassigned.toFixed(2)} 的腾讯云费用未匹配到 API Key 用量（计入“无 API Key”）`);
      summary.cycles.push({ cycle, codes, lines: monthRows.length, usage: usage.length, allocated: +allocated.toFixed(4), unassigned: +unassigned.toFixed(4), estimated, final });
    }
    return summary;
  }
  keyWs(id) {
    if (!this._wsCache || Date.now() - this._wsCache.t > 5000) this._wsCache = { t: Date.now(), m: new Map(this.store.listApiKeys().map(k => [k.api_key_id, k.workspace_id])) };
    return this._wsCache.m.get(id) || '';
  }

  /* ===================== 状态 ===================== */
  one(provider, kind) {
    const s = this.store.syncSettings();
    const key = `${provider}:${kind}`;
    const last = this.store.lastRun(kind, null, provider);
    const ok = this.store.lastRun(kind, 'success', provider), part = this.store.lastRun(kind, 'partial', provider);
    const okAt = Math.max(ok?.finished_at || 0, part?.finished_at || 0) || null;
    const interval = (kind === 'meta' ? s.metaIntervalMin : s.billIntervalMin) * 60_000;
    return {
      running: !!this.running[key], progress: this.progress[key] || null,
      last: last ? { id: last.id, status: last.status, startedAt: last.started_at, finishedAt: last.finished_at, error: last.error } : null,
      lastSuccessAt: okAt,
      nextAt: this.credentials(provider) ? Math.max(Date.now(), (this.lastAttempt[key] || 0) + interval) : null,
      intervalMin: kind === 'meta' ? s.metaIntervalMin : s.billIntervalMin,
    };
  }
  /** 合并状态：任一厂商运行中即运行中；最近成功取最早（数据新鲜度以最旧者为准）；changedAt 取最新（用于前端轮询刷新） */
  status() {
    const conf = this.configured();
    const providers = Object.fromEntries(PROVIDER_LIST.map(p => [p, { name: PROVIDER_NAMES[p], configured: conf.includes(p), secretState: this.secretState(p), meta: this.one(p, 'meta'), bills: this.one(p, 'bills') }]));
    const merge = kind => {
      const list = (conf.length ? conf : ['aliyun']).map(p => ({ p, x: providers[p][kind] }));
      const runningOne = list.find(o => o.x.running);
      const lasts = list.map(o => o.x.last).filter(Boolean).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      const bad = list.map(o => o.x.last).filter(l => l && l.status === 'error');
      const succ = list.map(o => o.x.lastSuccessAt);
      return {
        running: !!runningOne,
        progress: runningOne ? { ...runningOne.x.progress, text: (conf.length > 1 ? PROVIDER_NAMES[runningOne.p] + '：' : '') + (runningOne.x.progress?.text || '同步中…') } : null,
        last: bad[0] || lasts.find(l => l.status === 'partial') || lasts[0] || null,
        lastSuccessAt: succ.some(v => !v) ? null : Math.min(...succ),
        changedAt: Math.max(0, ...succ.map(v => v || 0)) || null,
        nextAt: Math.min(...list.map(o => o.x.nextAt || Infinity)) === Infinity ? null : Math.min(...list.map(o => o.x.nextAt || Infinity)),
        intervalMin: list[0].x.intervalMin,
      };
    };
    return { meta: merge('meta'), bills: merge('bills'), providers, configured: conf };
  }
}
