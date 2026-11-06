/**
 * 定时同步：
 *  - 元数据（业务空间 / API Key / 描述 / 权限）：默认每 5 分钟，与阿里云保持一致，记录新增/修改/删除
 *  - 账单：按“账期(月)”与“日”两种粒度分别拉取阿里云账单整体替换入库，
 *          查询按账期时用月账单、按日期时用日账单，口径与阿里云费用中心一致
 */
import { AliyunClient, normalizeBillItem } from './aliyun.mjs';

const BAILIAN_RE = /百炼|bailian|model\s*studio|dashscope|灵积/i;

export function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
export function daysInCycle(cycle, today) {
  const out = [];
  for (let d = cycle + '-01'; d.slice(0, 7) === cycle && d <= today; d = addDays(d, 1)) out.push(d);
  return out;
}
/** 阿里云次月 3 日后出账，4 日起视为已结算 */
export const isCycleFinal = (cycle, today) => today >= addDays(addMonths(cycle, 1) + '-01', 3);

async function pool(tasks, n, onDone) {
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

export class SyncService {
  constructor({ store, tz, log }) {
    this.store = store;
    this.tz = tz;
    this.log = log;
    this.running = { meta: null, bills: null };
    this.progress = { meta: null, bills: null };
    this.lastAttempt = { meta: 0, bills: 0 };
    this.timer = null;
  }

  credentials() {
    try {
      const id = this.store.getSecret('aliyun.accessKeyId');
      const secret = this.store.getSecret('aliyun.accessKeySecret');
      return id && secret ? { id, secret } : null;
    } catch {
      return null;
    }
  }

  client() {
    const c = this.credentials();
    if (!c) throw new Error('尚未配置阿里云 AccessKey（或主密钥变化导致无法解密），请在“系统管理”中配置');
    const a = this.store.aliyunSettings();
    return new AliyunClient({ accessKeyId: c.id, accessKeySecret: c.secret, msRegion: a.msRegion, bssSite: a.bssSite });
  }

  start() {
    const lm = this.store.lastRun('meta');
    const lb = this.store.lastRun('bills');
    this.lastAttempt.meta = lm?.started_at || 0;
    this.lastAttempt.bills = lb?.started_at || 0;
    setTimeout(() => this.tick(), 5_000);
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref?.();
  }

  tick() {
    if (!this.credentials()) return;
    const s = this.store.syncSettings();
    const now = Date.now();
    if (!this.running.meta && now - this.lastAttempt.meta >= s.metaIntervalMin * 60_000) this.run('meta', 'schedule');
    if (!this.running.bills && !this.running.meta && now - this.lastAttempt.bills >= s.billIntervalMin * 60_000) this.run('bills', 'schedule');
  }

  /** 异步启动任务；同类任务运行中则直接返回运行中的任务 */
  run(kind, trig, opts = {}) {
    if (this.running[kind]) return { runId: this.running[kind], alreadyRunning: true };
    const runId = Number(this.store.startRun(kind, trig));
    this.running[kind] = runId;
    this.lastAttempt[kind] = Date.now();
    this.progress[kind] = { text: '准备中…', done: 0, total: 0 };
    const t0 = Date.now();
    (async () => {
      let client;
      try {
        client = this.client();
        const detail = kind === 'meta' ? await this.syncMeta(client) : await this.syncBills(client, opts);
        const status = detail.warnings?.length ? 'partial' : 'success';
        this.store.finishRun(runId, status, detail, detail.warnings?.length ? detail.warnings.slice(0, 5).join('；') : null, client.calls);
        this.log(`同步[${kind}] ${status} ${Date.now() - t0}ms ${client.calls} 次调用`);
      } catch (e) {
        this.store.finishRun(runId, 'error', null, String(e.message || e).slice(0, 500), client?.calls ?? 0);
        this.log(`同步[${kind}] 失败: ${e.message}`);
      } finally {
        this.running[kind] = null;
        this.progress[kind] = null;
        this.lastAttempt[kind] = Date.now();
        setTimeout(() => this.tick(), 1000).unref?.(); // 元数据同步完成后立即检查是否需要同步账单
      }
    })();
    return { runId };
  }

  setProgress(kind, text, done = 0, total = 0) { this.progress[kind] = { text, done, total }; }

  async syncMeta(c) {
    const s = this.store.syncSettings();
    this.setProgress('meta', '读取业务空间…');
    const ws = await c.listAll('ListWorkspaces', {}, 'workspaces');
    this.setProgress('meta', '读取 API Key…');
    const keys = new Map();
    for (const k of await c.listAll('ListApiKeys', {}, 'apiKeys')) keys.set(String(k.apiKeyId), k);
    const warnings = [];
    let complete = true;
    if (s.perWorkspaceKeys) {
      let i = 0;
      for (const w of ws) {
        this.setProgress('meta', `补全业务空间 API Key ${++i}/${ws.length}`, i, ws.length);
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
    const changes = this.store.applyMeta(ws, [...keys.values()], { markMissing: complete });
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
    const p = this.store.getPeriod('D', day, code);
    if (!p) return true;
    if (p.final) return false;
    if (final) return true;                         // 账期已出账：再同步一次并标记为终版
    if (day >= addDays(today, -3)) return true;      // 最近 3 天账单仍会持续入账
    return Date.now() - p.synced_at > 12 * 3600_000; // 其余未出账日每 12 小时校正一次
  }

  async syncBills(c, opts = {}) {
    const s = this.store.syncSettings();
    const today = todayIn(this.tz);
    const cur = today.slice(0, 7);
    const back = Math.min(18, Math.max(1, s.backfillMonths || 3));
    const cycles = (opts.cycles?.length ? opts.cycles : Array.from({ length: back }, (_, i) => addMonths(cur, -i)))
      .filter(x => /^\d{4}-\d{2}$/.test(x) && x <= cur);
    const warnings = [];
    const summary = { cycles: [], warnings };
    for (const cycle of cycles) {
      const final = isCycleFinal(cycle, today);
      const known = this.store.getCycle(cycle);
      if (final && known?.final && !opts.force) { summary.cycles.push({ cycle, skipped: '已出账且已同步' }); continue; }
      this.setProgress('bills', `${cycle}：识别百炼产品代码…`);
      const codes = await this.detectCodes(c, cycle, warnings);
      let monthly = 0, daily = 0, failedDays = 0;
      for (const code of codes) {
        this.setProgress('bills', `${cycle}：拉取账期（月）账单…`);
        const m = await c.describeInstanceBill({ BillingCycle: cycle, ProductCode: code, Granularity: 'MONTHLY', IsBillingItem: true });
        this.store.replaceBillPeriod('M', cycle, cycle, code, m.map(normalizeBillItem), final);
        monthly += m.length;
        const days = daysInCycle(cycle, today).filter(d => opts.force || this.needDay(d, code, today, final));
        const res = await pool(days.map(day => async () => {
          const items = await c.describeInstanceBill({ BillingCycle: cycle, ProductCode: code, Granularity: 'DAILY', BillingDate: day, IsBillingItem: true });
          this.store.replaceBillPeriod('D', day, cycle, code, items.map(normalizeBillItem), final);
          return items.length;
        }), Math.min(6, Math.max(1, s.concurrency || 3)), (d, t) => this.setProgress('bills', `${cycle}：拉取按日账单 ${d}/${t}`, d, t));
        for (const r of res) { if (r.ok) daily += r.v; else failedDays++; }
        if (failedDays) warnings.push(`${cycle} 有 ${failedDays} 天的日账单拉取失败：${res.find(r => !r.ok).e.code || res.find(r => !r.ok).e.message}`);
      }
      try {
        this.setProgress('bills', `${cycle}：百炼账单接口对账…`);
        const r = await c.call('modelstudio', 'GetBillingOverview', { billMonth: cycle, groupBy: [{ code: 'API_KEY_ID' }], topNum: 20, zeroFilter: true, locale: 'zh-CN' });
        this.store.replaceMsOverview(cycle, 'API_KEY_ID', r.data?.groups || []);
      } catch (e) {
        warnings.push(`${cycle} 百炼账单汇总接口（对账）不可用：${e.code || e.message}`);
      }
      this.store.markCycle(cycle, codes, final && !failedDays);
      summary.cycles.push({ cycle, codes, monthly, daily, final });
    }
    return summary;
  }

  status() {
    const s = this.store.syncSettings();
    const one = kind => {
      const last = this.store.lastRun(kind);
      const ok = this.store.lastRun(kind, 'success') || this.store.lastRun(kind, 'partial');
      const interval = (kind === 'meta' ? s.metaIntervalMin : s.billIntervalMin) * 60_000;
      return {
        running: !!this.running[kind], progress: this.progress[kind],
        last: last ? { id: last.id, status: last.status, startedAt: last.started_at, finishedAt: last.finished_at, error: last.error } : null,
        lastSuccessAt: ok?.finished_at || null,
        nextAt: this.credentials() ? Math.max(Date.now(), this.lastAttempt[kind] + interval) : null,
        intervalMin: kind === 'meta' ? s.metaIntervalMin : s.billIntervalMin,
      };
    };
    return { meta: one('meta'), bills: one('bills') };
  }
}
