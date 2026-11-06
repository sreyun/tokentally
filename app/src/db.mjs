/**
 * SQLite 持久化（node:sqlite，无第三方依赖）
 */
import { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt, sha256, randomToken } from './crypto.mjs';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER, last_login_ip TEXT,
  pw_changed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT, ip TEXT, action TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY, name TEXT, region TEXT, service_site TEXT, api_host TEXT, tenant_id TEXT, gmt_create INTEGER,
  first_seen INTEGER, last_seen INTEGER, deleted_at INTEGER, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
  api_key_id TEXT PRIMARY KEY, api_key_masked TEXT, description TEXT, workspace_id TEXT, workspace_name TEXT,
  disabled INTEGER, auth_type TEXT, allow_all_models INTEGER, accessible_models TEXT, access_ips TEXT,
  created_by TEXT, gmt_create INTEGER,
  first_seen INTEGER, last_seen INTEGER, deleted_at INTEGER, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT,
  change TEXT NOT NULL, before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_ts ON change_log(ts);

CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY,
  granularity TEXT NOT NULL,          -- D=按日账单  M=按月(账期)账单
  period TEXT NOT NULL,               -- D: YYYY-MM-DD   M: YYYY-MM
  cycle TEXT NOT NULL,                -- 账期 YYYY-MM
  product_code TEXT NOT NULL,
  instance_id TEXT, api_key_id TEXT, workspace_id TEXT, model TEXT, io TEXT, channel TEXT, stop_flag TEXT, kind TEXT,
  billing_item TEXT, billing_item_code TEXT, commodity_code TEXT, product_detail TEXT,
  usage REAL, usage_unit TEXT, tokens REAL, list_price TEXT, list_price_unit TEXT,
  gross REAL, pretax REAL, after_discount REAL, invoice_discount REAL, coupons REAL, cash_coupons REAL, prepaid REAL, resource_pkg TEXT,
  currency TEXT, region TEXT, item TEXT, subscription_type TEXT,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bill_gp ON bill_lines(granularity, period);
CREATE INDEX IF NOT EXISTS idx_bill_cycle ON bill_lines(granularity, cycle);
CREATE INDEX IF NOT EXISTS idx_bill_key ON bill_lines(api_key_id);

CREATE TABLE IF NOT EXISTS bill_periods (
  granularity TEXT NOT NULL, period TEXT NOT NULL, product_code TEXT NOT NULL,
  cycle TEXT NOT NULL, synced_at INTEGER NOT NULL, line_count INTEGER, pretax REAL, final INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, period, product_code)
);

CREATE TABLE IF NOT EXISTS bill_cycles (
  cycle TEXT PRIMARY KEY, product_codes TEXT, synced_at INTEGER NOT NULL, final INTEGER NOT NULL DEFAULT 0, pretax REAL, gross REAL
);

CREATE TABLE IF NOT EXISTS ms_overview (
  cycle TEXT NOT NULL, group_code TEXT NOT NULL, key TEXT NOT NULL, name TEXT, amount REAL, article_codes TEXT, synced_at INTEGER,
  PRIMARY KEY (cycle, group_code, key)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, trig TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
  status TEXT NOT NULL, detail TEXT, error TEXT, api_calls INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_kind ON sync_runs(kind, started_at);
`;

export const LINE_COLS = [
  'period', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'stop_flag', 'kind', 'usage', 'usage_unit', 'tokens',
  'list_price', 'list_price_unit', 'gross', 'pretax', 'after_discount', 'invoice_discount', 'coupons', 'cash_coupons', 'prepaid',
  'resource_pkg', 'currency', 'billing_item', 'commodity_code', 'product_detail', 'instance_id', 'region', 'item',
];
const SLIM_COLS = ['period', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'kind', 'usage', 'usage_unit', 'tokens', 'list_price', 'list_price_unit', 'gross', 'pretax', 'after_discount'];
const INSERT_COLS = ['granularity', 'period', 'cycle', 'product_code', 'instance_id', 'api_key_id', 'workspace_id', 'model', 'io', 'channel', 'stop_flag', 'kind',
  'billing_item', 'billing_item_code', 'commodity_code', 'product_detail', 'usage', 'usage_unit', 'tokens', 'list_price', 'list_price_unit',
  'gross', 'pretax', 'after_discount', 'invoice_discount', 'coupons', 'cash_coupons', 'prepaid', 'resource_pkg', 'currency', 'region', 'item', 'subscription_type', 'synced_at'];

export const DEFAULT_ALIYUN = { msRegion: 'cn-beijing', bssSite: 'cn', productCode: '' };
export const DEFAULT_SYNC = { metaIntervalMin: 5, billIntervalMin: 60, backfillMonths: 3, perWorkspaceKeys: true, concurrency: 3 };

const n0 = v => (v == null || v === '' ? null : v);
const shiftDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const DEFAULT_BUDGETS = { monthly: null, alertPct: 80, keys: {} };
/** 阿里云对未归属业务空间的 Key 可能返回 "-"，统一视为空 */
const clean = v => (v == null || v === '-' ? '' : String(v));
const jsonOrNull = v => (v == null ? null : JSON.stringify(v));

export class Store {
  constructor(file, masterKey) {
    this.db = new DatabaseSync(file);
    this.key = masterKey;
    this.stmts = new Map();
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v < 1) { this.db.exec(SCHEMA_V1); this.db.exec('PRAGMA user_version = 1'); }
    if (v < 2) {
      // v2：阿里云用 "-" 表示空业务空间，统一清洗为空字符串
      this.db.exec(`UPDATE bill_lines SET workspace_id = '' WHERE workspace_id = '-';
        UPDATE api_keys SET workspace_id = '' WHERE workspace_id = '-';
        UPDATE api_keys SET workspace_name = '' WHERE workspace_name = '-';
        PRAGMA user_version = 2;`);
    }
  }

  /* ---------------- settings ---------------- */
  getSetting(k, d = null) {
    const r = this.q('SELECT v FROM settings WHERE k = ?').get(k);
    if (!r || r.v == null) return d;
    try { return JSON.parse(r.v); } catch { return d; }
  }
  setSetting(k, v) {
    this.q('INSERT INTO settings(k, v, updated_at) VALUES(?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
      .run(k, JSON.stringify(v), Date.now());
  }
  /** 加密字段：AES-256-GCM，AAD 绑定字段名 */
  getSecret(k) {
    const blob = this.getSetting(k, null);
    if (!blob) return '';
    return decrypt(this.key, blob, k);
  }
  setSecret(k, v) { this.setSetting(k, v ? encrypt(this.key, v, k) : null); }
  aliyunSettings() { return { ...DEFAULT_ALIYUN, ...(this.getSetting('aliyun', {}) || {}) }; }
  syncSettings() { return { ...DEFAULT_SYNC, ...(this.getSetting('sync', {}) || {}) }; }
  budgets() { return { ...DEFAULT_BUDGETS, ...(this.getSetting('budgets', {}) || {}) }; }

  /* ---------------- users / sessions ---------------- */
  countUsers() { return this.q('SELECT COUNT(*) AS n FROM users').get().n; }
  countAdmins() { return this.q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n; }
  userByName(u) { return this.q('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(u)); }
  userById(id) { return this.q('SELECT * FROM users WHERE id = ?').get(Number(id)); }
  listUsers() {
    return this.q(`SELECT u.id, u.username, u.role, u.disabled, u.must_change, u.locked_until, u.last_login_at, u.last_login_ip, u.pw_changed_at, u.created_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions FROM users u ORDER BY u.id`).all(Date.now());
  }
  createUser({ username, passHash, role, mustChange }) {
    const now = Date.now();
    return this.q('INSERT INTO users(username, pass_hash, role, must_change, created_at, updated_at, pw_changed_at) VALUES(?,?,?,?,?,?,?)')
      .run(username, passHash, role, mustChange ? 1 : 0, now, now, now).lastInsertRowid;
  }
  updateUser(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    this.db.prepare(`UPDATE users SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => fields[c]), Date.now(), Number(id));
  }
  deleteUser(id) { this.q('DELETE FROM users WHERE id = ?').run(Number(id)); }

  createSession(userId, ip, ua, maxMs) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const now = Date.now();
    this.q('INSERT INTO sessions(id_hash, user_id, csrf, created_at, last_seen, expires_at, ip, ua) VALUES(?,?,?,?,?,?,?,?)')
      .run(sha256(token), userId, csrf, now, now, now + maxMs, ip || '', String(ua || '').slice(0, 200));
    return { token, csrf };
  }
  getSession(token, idleMs) {
    if (!token) return null;
    const s = this.q(`SELECT s.id_hash, s.user_id, s.csrf, s.last_seen, s.expires_at, u.username, u.role, u.disabled, u.must_change
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(sha256(token));
    const now = Date.now();
    if (!s || s.disabled || s.expires_at <= now || s.last_seen + idleMs <= now) {
      if (s) this.q('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash);
      return null;
    }
    if (now - s.last_seen > 60_000) this.q('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(now, s.id_hash);
    return s;
  }
  deleteSession(idHash) { this.q('DELETE FROM sessions WHERE id_hash = ?').run(idHash); }
  deleteUserSessions(userId, exceptHash = '') { this.q('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?').run(Number(userId), exceptHash); }
  purgeSessions(idleMs) { this.q('DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?').run(Date.now(), Date.now() - idleMs); }

  audit(username, ip, action, detail) {
    this.q('INSERT INTO audit_log(ts, username, ip, action, detail) VALUES(?,?,?,?,?)')
      .run(Date.now(), username || '', ip || '', action, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  }
  listAudit(limit = 500) { return this.q('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit); }
  purgeOld() {
    const yearAgo = Date.now() - 365 * 864e5;
    this.q('DELETE FROM audit_log WHERE ts < ?').run(yearAgo);
    this.q('DELETE FROM sync_runs WHERE started_at < ?').run(Date.now() - 90 * 864e5);
  }

  /* ---------------- 业务空间 / API Key 同步 ---------------- */
  logChange(entity, id, name, change, before, after) {
    this.q('INSERT INTO change_log(ts, entity, entity_id, name, change, before_json, after_json) VALUES(?,?,?,?,?,?,?)')
      .run(Date.now(), entity, id, name || '', change, jsonOrNull(before), jsonOrNull(after));
  }

  /**
   * 写入一次完整的元数据同步结果，记录新增/修改/删除/恢复。
   * markMissing=true 时，本次未出现的记录标记为已删除（保留历史，账单仍可关联描述）。
   */
  applyMeta(wsList, keyList, { markMissing }) {
    const now = Date.now();
    let changes = 0;
    const diff = (cur, row, fields) => {
      const b = {}, a = {};
      for (const f of fields) if (String(cur[f] ?? '') !== String(row[f] ?? '')) { b[f] = cur[f]; a[f] = row[f]; }
      return Object.keys(a).length ? [b, a] : null;
    };
    this.tx(() => {
      const seenWs = new Set();
      const WS_FIELDS = ['name', 'region', 'service_site', 'api_host'];
      for (const w of wsList) {
        const id = String(w.workspaceId || '');
        if (!id) continue;
        seenWs.add(id);
        const row = {
          name: w.workspaceName || '', region: w.region || '', service_site: w.serviceSite || '', api_host: w.apiHost || '',
          tenant_id: w.tenantId == null ? '' : String(w.tenantId), gmt_create: Number(w.gmtCreate) || null,
        };
        const cur = this.q('SELECT * FROM workspaces WHERE workspace_id = ?').get(id);
        if (!cur) {
          this.q(`INSERT INTO workspaces(workspace_id, name, region, service_site, api_host, tenant_id, gmt_create, first_seen, last_seen, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, row.name, row.region, row.service_site, row.api_host, row.tenant_id, row.gmt_create, now, now, now);
          this.logChange('workspace', id, row.name, 'create', null, row); changes++;
          continue;
        }
        const d = diff(cur, row, WS_FIELDS);
        if (d) { this.logChange('workspace', id, row.name, 'update', d[0], d[1]); changes++; }
        if (cur.deleted_at) { this.logChange('workspace', id, row.name, 'restore', null, null); changes++; }
        this.q(`UPDATE workspaces SET name=?, region=?, service_site=?, api_host=?, tenant_id=?, gmt_create=?, last_seen=?, deleted_at=NULL,
          updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE workspace_id=?`)
          .run(row.name, row.region, row.service_site, row.api_host, row.tenant_id, row.gmt_create, now, d || cur.deleted_at ? 1 : 0, now, id);
      }
      if (markMissing) {
        for (const cur of this.q('SELECT workspace_id, name FROM workspaces WHERE deleted_at IS NULL').all()) {
          if (seenWs.has(cur.workspace_id)) continue;
          this.q('UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE workspace_id = ?').run(now, now, cur.workspace_id);
          this.logChange('workspace', cur.workspace_id, cur.name, 'delete', null, null); changes++;
        }
      }

      const seenKeys = new Set();
      const KEY_FIELDS = ['api_key_masked', 'description', 'workspace_id', 'workspace_name', 'disabled', 'auth_type', 'allow_all_models', 'accessible_models', 'access_ips'];
      for (const k of keyList) {
        const id = String(k.apiKeyId ?? '');
        if (!id) continue;
        seenKeys.add(id);
        const auth = k.auth || {};
        const scope = auth.modelAccessScope || {};
        const dis = k.disabled;
        const row = {
          api_key_masked: k.apiKeyValue || '', description: k.description || '', workspace_id: clean(k.workspaceId), workspace_name: clean(k.workspaceName),
          disabled: dis == null ? null : (dis === true || dis === 1 || dis === '1' || dis === 'true') ? 1 : 0,
          auth_type: auth.type || '', allow_all_models: scope.allowAllModels == null ? null : (scope.allowAllModels ? 1 : 0),
          accessible_models: JSON.stringify([...(scope.accessibleModels || [])].sort()), access_ips: JSON.stringify(auth.accessIps || []),
          created_by: k.createdBy == null ? '' : String(k.createdBy), gmt_create: Number(k.gmtCreate) || null,
        };
        const cur = this.q('SELECT * FROM api_keys WHERE api_key_id = ?').get(id);
        if (!cur) {
          this.q(`INSERT INTO api_keys(api_key_id, api_key_masked, description, workspace_id, workspace_name, disabled, auth_type, allow_all_models,
            accessible_models, access_ips, created_by, gmt_create, first_seen, last_seen, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, row.api_key_masked, row.description, row.workspace_id, row.workspace_name, row.disabled, row.auth_type, row.allow_all_models,
              row.accessible_models, row.access_ips, row.created_by, row.gmt_create, now, now, now);
          this.logChange('api_key', id, row.description, 'create', null, { description: row.description, workspace_name: row.workspace_name }); changes++;
          continue;
        }
        const d = diff(cur, row, KEY_FIELDS);
        if (d) { this.logChange('api_key', id, row.description, 'update', d[0], d[1]); changes++; }
        if (cur.deleted_at) { this.logChange('api_key', id, row.description, 'restore', null, null); changes++; }
        this.q(`UPDATE api_keys SET api_key_masked=?, description=?, workspace_id=?, workspace_name=?, disabled=?, auth_type=?, allow_all_models=?,
          accessible_models=?, access_ips=?, created_by=?, gmt_create=?, last_seen=?, deleted_at=NULL,
          updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE api_key_id=?`)
          .run(row.api_key_masked, row.description, row.workspace_id, row.workspace_name, row.disabled, row.auth_type, row.allow_all_models,
            row.accessible_models, row.access_ips, row.created_by, row.gmt_create, now, d || cur.deleted_at ? 1 : 0, now, id);
      }
      if (markMissing) {
        for (const cur of this.q('SELECT api_key_id, description FROM api_keys WHERE deleted_at IS NULL').all()) {
          if (seenKeys.has(cur.api_key_id)) continue;
          this.q('UPDATE api_keys SET deleted_at = ?, updated_at = ? WHERE api_key_id = ?').run(now, now, cur.api_key_id);
          this.logChange('api_key', cur.api_key_id, cur.description, 'delete', null, null); changes++;
        }
      }
    });
    return changes;
  }

  listWorkspaces() { return this.q('SELECT * FROM workspaces ORDER BY gmt_create').all(); }
  listApiKeys() { return this.q('SELECT * FROM api_keys ORDER BY CAST(api_key_id AS INTEGER) DESC').all(); }
  listChanges(limit = 1000) { return this.q('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(limit); }

  /* ---------------- 账单 ---------------- */
  getPeriod(gran, period, code) {
    return this.q('SELECT * FROM bill_periods WHERE granularity = ? AND period = ? AND product_code = ?').get(gran, period, code);
  }
  getCycle(cycle) { return this.q('SELECT * FROM bill_cycles WHERE cycle = ?').get(cycle); }
  listCycles() { return this.q('SELECT * FROM bill_cycles ORDER BY cycle DESC').all(); }

  /** 以“账期/日 + 产品”为单位整体替换，保证与阿里云账单一致（含金额回调、出账修正） */
  replaceBillPeriod(gran, period, cycle, code, rows, final) {
    const now = Date.now();
    const ins = this.q(`INSERT INTO bill_lines(${INSERT_COLS.join(',')}) VALUES(${INSERT_COLS.map(() => '?').join(',')})`);
    this.tx(() => {
      this.q('DELETE FROM bill_lines WHERE granularity = ? AND period = ? AND product_code = ?').run(gran, period, code);
      let pretax = 0;
      for (const r of rows) {
        pretax += r.pretax || 0;
        ins.run(gran, period, cycle, code, r.instance_id, r.api_key_id, r.workspace_id, r.model, r.io, r.channel, r.stop_flag, r.kind,
          r.billing_item, r.billing_item_code, r.commodity_code, r.product_detail, n0(r.usage), r.usage_unit, n0(r.tokens), r.list_price, r.list_price_unit,
          r.gross, r.pretax, r.after_discount, r.invoice_discount, r.coupons, r.cash_coupons, r.prepaid, r.resource_pkg, r.currency, r.region, r.item,
          r.subscription_type, now);
      }
      this.q(`INSERT INTO bill_periods(granularity, period, product_code, cycle, synced_at, line_count, pretax, final) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(granularity, period, product_code) DO UPDATE SET synced_at=excluded.synced_at, line_count=excluded.line_count, pretax=excluded.pretax, final=excluded.final`)
        .run(gran, period, code, cycle, now, rows.length, pretax, final ? 1 : 0);
    });
  }
  markCycle(cycle, codes, final) {
    const t = this.q("SELECT COALESCE(SUM(pretax),0) AS p, COALESCE(SUM(gross),0) AS g FROM bill_lines WHERE granularity = 'M' AND cycle = ?").get(cycle);
    this.q(`INSERT INTO bill_cycles(cycle, product_codes, synced_at, final, pretax, gross) VALUES(?,?,?,?,?,?)
      ON CONFLICT(cycle) DO UPDATE SET product_codes=excluded.product_codes, synced_at=excluded.synced_at, final=excluded.final, pretax=excluded.pretax, gross=excluded.gross`)
      .run(cycle, codes.join(','), Date.now(), final ? 1 : 0, t.p, t.g);
  }
  replaceMsOverview(cycle, groupCode, groups) {
    const now = Date.now();
    this.tx(() => {
      this.q('DELETE FROM ms_overview WHERE cycle = ? AND group_code = ?').run(cycle, groupCode);
      for (const g of groups) {
        this.q('INSERT INTO ms_overview(cycle, group_code, key, name, amount, article_codes, synced_at) VALUES(?,?,?,?,?,?,?)')
          .run(cycle, groupCode, String(g.key ?? ''), String(g.name ?? ''), parseFloat(g.amount) || 0, JSON.stringify(g.articleCodes || []), now);
      }
    });
  }
  msOverview(cycle, groupCode = 'API_KEY_ID') {
    return this.q('SELECT key, name, amount, article_codes, synced_at FROM ms_overview WHERE cycle = ? AND group_code = ? ORDER BY amount DESC').all(cycle, groupCode);
  }

  /** 返回紧凑数组：{ cols, rows }；slim=true 时只返回趋势/对比所需的列 */
  queryLines(gran, from, to, slim = false) {
    const cols = slim ? SLIM_COLS : LINE_COLS;
    const rows = this.q(`SELECT ${cols.join(',')} FROM bill_lines WHERE granularity = ? AND period >= ? AND period <= ? ORDER BY period`).all(gran, from, to);
    return { cols, rows: rows.map(r => cols.map(c => r[c])) };
  }
  /** 同比/环比用：按维度聚合的上期数据 */
  queryAgg(gran, from, to) {
    const cols = ['api_key_id', 'workspace_id', 'model', 'io', 'channel', 'kind', 'gross', 'pretax', 'after_discount', 'tokens', 'usage_unit'];
    const rows = this.q(`SELECT api_key_id, workspace_id, model, io, channel, kind, SUM(gross) AS gross, SUM(pretax) AS pretax, SUM(after_discount) AS after_discount,
      SUM(tokens) AS tokens, usage_unit FROM bill_lines WHERE granularity = ? AND period >= ? AND period <= ?
      GROUP BY api_key_id, workspace_id, model, io, channel, kind, usage_unit`).all(gran, from, to);
    return { cols, rows: rows.map(r => cols.map(c => r[c])) };
  }
  /** 每个 Key 的最近消费日、近 7/30 天应付金额（基于日账单） */
  keyActivity(today) {
    const d7 = shiftDay(today, -6), d30 = shiftDay(today, -29);
    const recent = this.q(`SELECT api_key_id AS id, SUM(CASE WHEN period >= ? THEN pretax ELSE 0 END) AS c7, SUM(pretax) AS c30, COUNT(DISTINCT period) AS days30
      FROM bill_lines WHERE granularity = 'D' AND period >= ? GROUP BY api_key_id`).all(d7, d30);
    const last = this.q(`SELECT api_key_id AS id, MAX(period) AS lastDay FROM bill_lines WHERE granularity = 'D' AND (pretax > 0 OR gross > 0 OR tokens > 0) GROUP BY api_key_id`).all();
    const out = new Map();
    for (const r of last) out.set(r.id || '', { apiKeyId: r.id || '', lastDay: r.lastDay, c7: 0, c30: 0, days30: 0 });
    for (const r of recent) out.set(r.id || '', { ...(out.get(r.id || '') || { apiKeyId: r.id || '', lastDay: null }), c7: r.c7 || 0, c30: r.c30 || 0, days30: r.days30 || 0 });
    return [...out.values()];
  }
  dataRange() {
    const d = this.q("SELECT MIN(period) AS min, MAX(period) AS max, COUNT(*) AS n FROM bill_lines WHERE granularity = 'D'").get();
    return { minDay: d.min, maxDay: d.max, dailyLines: d.n, cycles: this.listCycles() };
  }

  /* ---------------- 同步任务 ---------------- */
  startRun(kind, trig) {
    return this.q("INSERT INTO sync_runs(kind, trig, started_at, status) VALUES(?,?,?,'running')").run(kind, trig, Date.now()).lastInsertRowid;
  }
  finishRun(id, status, detail, error, calls) {
    this.q('UPDATE sync_runs SET finished_at = ?, status = ?, detail = ?, error = ?, api_calls = ? WHERE id = ?')
      .run(Date.now(), status, jsonOrNull(detail), error || null, calls ?? null, id);
  }
  lastRun(kind, status) {
    return status
      ? this.q('SELECT * FROM sync_runs WHERE kind = ? AND status = ? ORDER BY id DESC LIMIT 1').get(kind, status)
      : this.q("SELECT * FROM sync_runs WHERE kind = ? AND status <> 'running' ORDER BY id DESC LIMIT 1").get(kind);
  }
  listRuns(limit = 100) { return this.q('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit); }
  failStaleRuns() { this.q("UPDATE sync_runs SET status = 'error', error = '服务重启，任务中断', finished_at = ? WHERE status = 'running'").run(Date.now()); }
}
