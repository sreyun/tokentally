/* =========================================================================
 * 中文描述：审计日志的操作与详情、云 API 接口与参数、IP 归属地
 * 原始数据（操作代码、JSON 详情、接口参数）仍保留在悬停提示与 CSV 导出中，便于排查
 * ========================================================================= */
import { esc, money, state, p2, keyShort } from './core.js';

/* ---------------- 审计操作 ---------------- */
export const ACT = {
  'login.success': '登录成功', 'login.fail': '登录失败', logout: '退出登录', 'password.change': '修改密码', 'password.change.fail': '修改密码失败', 'password.change.lock': '改密错误过多强制退出',
  'user.create': '创建用户', 'user.update': '修改用户', 'user.delete': '删除用户', 'user.bootstrap': '初始化管理员', 'settings.update': '修改设置',
  'aliyun.ak.update': '更新阿里云 AccessKey', 'aliyun.ak.update.fail': '更新 AccessKey 验证失败', 'aliyun.ak.update.lock': '更新 AccessKey 多次验证失败', 'aliyun.ak.bootstrap': '导入阿里云 AccessKey', 'aliyun.test': '测试阿里云连接',
  'aliyun.calls.secret': '修改调用次数 Prometheus 地址 / 认证', 'aliyun.calls.secret.fail': '修改 Prometheus 认证验证失败', 'aliyun.calls.secret.lock': '修改 Prometheus 认证多次验证失败', 'aliyun.calls.sync': '同步阿里云调用次数',
  'tencent.key.update': '更新腾讯云密钥', 'tencent.key.update.fail': '更新腾讯云密钥验证失败', 'tencent.key.update.lock': '更新腾讯云密钥多次验证失败', 'tencent.key.bootstrap': '导入腾讯云密钥', 'tencent.test': '测试腾讯云连接',
  'sync.trigger': '触发同步', 'budgets.update': '修改预算', 'keytags.update': '修改成本中心 / 负责人', 'alert.update': '修改告警设置', 'alert.test': '发送测试消息', 'alert.test.fail': '测试消息发送失败',
  'alert.sent': '告警 / 报表已发送', 'alert.report.send': '手动发送报表', 'backup.create': '创建备份', 'backup.download': '下载备份', 'backup.download.fail': '下载备份验证失败', 'backup.download.lock': '下载备份多次验证失败', 'demo.clear': '清除演示数据',
  'network.update': '修改客户端 IP 来源', 'network.update.fail': '修改客户端 IP 来源验证失败', 'network.update.lock': '修改客户端 IP 来源多次验证失败', 'user.unlock.cli': '命令行解除锁定',
  'smtp.update': '修改邮件服务器（SMTP）', 'smtp.update.fail': '修改邮件服务器验证失败', 'smtp.update.lock': '修改邮件服务器多次验证失败', 'smtp.test': '发送测试邮件', 'smtp.test.fail': '测试邮件发送失败',
  'user.promote.fail': '设为管理员验证失败', 'user.promote.lock': '设为管理员多次验证失败', 'user.reset.fail': '重置密码验证失败', 'user.reset.lock': '重置密码多次验证失败', 'user.create.fail': '创建管理员验证失败', 'user.create.lock': '创建管理员多次验证失败',
};
/** 未登记的操作：按后缀给出“验证失败 / 多次验证失败”，其余显示代码 */
export const actLabel = a => ACT[a] || (/\.lock$/.test(a) && ACT[a.replace(/\.lock$/, '')] ? `${ACT[a.replace(/\.lock$/, '')]}（多次验证失败）` : /\.fail$/.test(a) && ACT[a.replace(/\.fail$/, '')] ? `${ACT[a.replace(/\.fail$/, '')]}（验证失败）` : a);
export const actBad = a => /(^|\.)(fail|lock)$/.test(a);

const PROV = { aliyun: '阿里云', tencent: '腾讯云' };
const SYNC_KIND = { meta: 'API Key 与业务空间', bills: '账单' };
const ROLE = { admin: '管理员', viewer: '只读用户' };
const CH_TYPE = { dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信', generic: '通用 Webhook', email: '邮件' };
const SMTP_FIELD = { host: 'SMTP 服务器', port: '端口', security: '加密方式', username: '用户名', fromAddr: '发件人邮箱', fromName: '发件人名称', password: '密码 / 授权码', 'password.clear': '清除密码' };
export const EVENT = { budget: '预算告警', anomaly: '费用异常', sync: '同步故障', keyChange: 'Key 变更', daily: '日报', weekly: '周报', monthly: '月报' };
const RULE = { pct: '达到预警阈值', over: '超出预算', forecast: '预计月末超出总预算', keys: '包含 API Key 预算' };
const TRIGGER = { sync: 'Key 同步后检查', bills: '账单同步后检查', schedule: '定时检查', budgets: '修改预算后检查', config: '修改告警设置后检查' };
const USER_FIELD = { password: '密码', must_change: '下次登录须修改密码', role: '角色', disabled: '启用 / 禁用', locked_until: '解除锁定', failed_count: '清零失败次数' };
const SETTING = {
  'aliyun.msRegion': '百炼地域', 'aliyun.bssSite': '费用中心站点', 'aliyun.productCode': '阿里云账单产品代码', 'aliyun.accessKey': '阿里云 AccessKey',
  'tencent.region': 'TokenHub 地域', 'tencent.site': '腾讯云站点', 'tencent.businessCode': '腾讯云账单产品代码', 'tencent.estimate': '缺少费用权限时按目录价估算', 'tencent.secretKey': '腾讯云 SecretId / SecretKey',
  'aliyunCalls.enabled': '调用次数统计开关', 'aliyunCalls.url': 'Prometheus 地址', 'aliyunCalls.authType': 'Prometheus 认证方式', 'aliyunCalls.username': 'Prometheus 用户名',
  'aliyunCalls.metric': '调用次数指标', 'aliyunCalls.failMetric': '失败次数指标', 'aliyunCalls.keyLabel': 'API Key 标签', 'aliyunCalls.modelLabel': '模型标签',
  'aliyunCalls.aggregation': '聚合方式', 'aliyunCalls.filter': '附加过滤条件', 'aliyunCalls.lookbackDays': '回溯天数',
  'aliyunCalls.token': 'Prometheus Token', 'aliyunCalls.password': 'Prometheus 密码', 'aliyunCalls.secret': '清除 Prometheus 认证', 'aliyunCalls.cleared': '口径变化，已清空调用次数',
  'branding.name': '产品名称', 'branding.subtitle': '副标题', 'branding.accent': '主题色',
  'sync.metaIntervalMin': 'Key 同步间隔', 'sync.billIntervalMin': '账单同步间隔', 'sync.backfillMonths': '账单回溯月数', 'sync.perWorkspaceKeys': '按业务空间查询 Key', 'sync.concurrency': '同步并发数',
};
const KEY_LABEL = { username: '用户', role: '角色', name: '名称', channel: '渠道', type: '类型', kind: '类型', count: '数量', error: '错误', url: '地址', size: '大小', fields: '修改项', providers: '云厂商', cycles: '账期', force: '强制', accessKeyId: 'AccessKey ID', secretId: 'SecretId' };

const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const list = (a, f = x => x) => (Array.isArray(a) ? a.map(f).filter(Boolean).join('、') : '');
const ipSrc = o => (!o ? '-' : o.ipSource === 'xff' ? `X-Forwarded-For（可信代理 ${o.hops || 1} 层）` : { env: '跟随环境变量 TRUST_PROXY', direct: '直连（使用连接地址）', realip: 'X-Real-IP' }[o.ipSource] || o.ipSource);
const keyName = id => { try { const k = state.apiKeys.get(id); return k?.description ? `${k.description}（${id}）` : keyShort(id); } catch { return id; } };
/** 告警渠道密钥变更项：“渠道名.webhook / .secret / .secret.clear / .secret.reset / .removed” */
function chField(f) {
  const m = String(f).match(/^(.*)\.(webhook|secret\.clear|secret\.reset|secret|removed)$/);
  if (!m) return f;
  return { webhook: `${m[1]} 更换 Webhook`, secret: `${m[1]} 更换加签密钥`, 'secret.clear': `${m[1]} 清除加签密钥`, 'secret.reset': `${m[1]} 更换机器人，已清除旧密钥`, removed: `删除渠道 ${m[1]}` }[m[2]];
}
const val = v => (v == null || v === '' ? '-' : typeof v === 'boolean' ? (v ? '是' : '否') : Array.isArray(v) ? v.map(val).join('、') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** 各操作的详情：[[标签, 文本], ...]；标签为空表示整句说明 */
const DESC = {
  'sync.trigger': d => [['同步内容', SYNC_KIND[d.kind] || d.kind], ['云厂商', list(d.providers, p => PROV[p] || p) || '全部'], d.cycles?.length && ['账期', list(d.cycles)], d.force && ['方式', '强制重新拉取']],
  'network.update': d => [['IP 来源', `${ipSrc(d.from)} → ${ipSrc(d.to)}`]],
  'backup.create': d => [['文件', d.name], d.size != null && ['大小', fmtSize(d.size)]],
  'backup.download': d => [['文件', d.name]],
  'settings.update': d => [['修改项', list(d.fields, f => SETTING[f] || f)]],
  'user.create': d => [['用户', d.username], ['角色', ROLE[d.role] || d.role]],
  'user.update': d => [['用户', d.username], ['修改', list(d.fields, f => (f === 'pw_changed_at' ? '' : USER_FIELD[f] || f)) || '-']],
  'user.delete': d => [['用户', d.username]],
  'user.bootstrap': d => [['用户', d.username]],
  'user.unlock.cli': d => [['用户', d.username]],
  'aliyun.ak.update': d => [['AccessKey ID', d.accessKeyId]],
  'aliyun.ak.bootstrap': d => [['AccessKey ID', d.accessKeyId], ['', '来自环境变量']],
  'aliyun.test': d => [['AccessKey ID', d.accessKeyId]],
  'tencent.key.update': d => [['SecretId', d.secretId]],
  'tencent.key.bootstrap': d => [['SecretId', d.secretId], ['', '来自环境变量']],
  'tencent.test': d => [['SecretId', d.secretId]],
  'aliyun.calls.secret': d => [['Prometheus 地址', d.url || '（未设置）']],
  'budgets.update': d => [['月度总预算', d.monthly == null ? '未设置' : money(d.monthly)], d.alertPct != null && ['预警阈值', `${d.alertPct}%`], d.keyBudgets != null && ['API Key 预算', `${d.keyBudgets} 个`]],
  'keytags.update': d => [['Key 数量', `${d.count ?? (d.keys || []).length} 个`], d.keys?.length && ['涉及', list(d.keys.slice(0, 5), keyName) + ((d.count || d.keys.length) > 5 ? ` 等 ${d.count || d.keys.length} 个` : '')]],
  'alert.update': d => [
    ['通知渠道', (d.channels || []).length ? d.channels.map(c => `${c.name}（${CH_TYPE[c.type] || c.type}${c.enabled ? '' : '，已停用'}${c.scope ? `，范围：${c.scope.type === 'key' ? 'API Key' : '业务空间'} ${c.scope.n} 个` : ''}）：${list(c.events, e => EVENT[e] || e) || '未订阅事件'}`).join('；') : '无'],
    d.rules && ['预算规则', list(Object.keys(d.rules).filter(k => d.rules[k]), k => RULE[k] || k) || '全部关闭'],
    d.anomaly && ['费用异常', `日费用达到前 7 日日均的 ${d.anomaly.ratio} 倍且增量 ≥ ${money(d.anomaly.minAmount, 0)}${d.anomaly.keys ? '，含单个 API Key' : ''}`],
    d.reportHour != null && ['报表发送', `每天 ${p2(d.reportHour)}:00`],
    d.fields?.length && ['密钥变更', list(d.fields, chField)],
  ],
  'alert.test': d => [['渠道', `${d.channel || '-'}（${CH_TYPE[d.type] || d.type}）`]],
  'alert.test.fail': d => [['渠道类型', CH_TYPE[d.type] || d.type], ['错误', d.error]],
  'alert.sent': d => [['事件', EVENT[d.event] || d.event], ['渠道', d.channel], d.items != null && ['条目', `${d.items} 条`], d.trigger && ['触发', TRIGGER[d.trigger] || d.trigger]],
  'alert.report.send': d => [['报表', EVENT[d.kind] || d.kind], ['渠道', d.channel]],
  'smtp.update': d => [['修改项', list(d.fields, f => SMTP_FIELD[f] || f)]],
  'smtp.test': d => [['收件人', d.to]],
  'smtp.test.fail': d => [['收件人', d.to], ['错误', d.error]],
};

/** 审计详情 → [[标签, 文本], ...]（已是中文说明的字符串直接返回） */
export function auditPairs(action, raw) {
  if (raw == null || raw === '') return [];
  let d;
  try { d = JSON.parse(raw); } catch { return [['', String(raw)]]; }
  if (d == null) return [];
  if (typeof d !== 'object') return [['', String(d)]];
  const f = DESC[action];
  if (f) { try { return f(d).filter(Boolean).map(([k, v]) => [k, val(v)]); } catch { /* 结构不符时按通用格式显示 */ } }
  return Object.entries(d).map(([k, v]) => [KEY_LABEL[k] || k, val(v)]);
}
export const auditText = (action, raw) => auditPairs(action, raw).map(([k, v]) => (k ? `${k}：${v}` : v)).join('；');
export function auditHtml(action, raw) {
  const pairs = auditPairs(action, raw);
  if (!pairs.length) return '<span class="muted">—</span>';
  return `<div class="ad">${pairs.map(([k, v]) => `<span class="ad-i">${k ? `<em>${esc(k)}</em>` : ''}${esc(v)}</span>`).join('')}</div>`;
}

/* ---------------- 用户操作日志 ---------------- */
export const OP_CAT = { view: '页面访问', query: '数据查询', export: '导出与下载', config: '配置变更', alert: '告警通知', sync: '同步操作', user: '用户管理', auth: '登录与账号', denied: '权限拒绝' };
export const OP_ACT = {
  'page.view': '访问页面', 'export.csv': '导出 CSV', 'export.print': '打印 / 导出 PDF', 'link.copy': '复制链接', 'drill.down': '下钻查看',
  'data.query': '查询账单数据', 'auth.login': '登录', 'auth.login.fail': '登录失败', 'auth.logout': '退出登录', 'account.password': '修改密码',
  'settings.update': '修改系统设置', 'provider.test': '测试云厂商连接', 'sync.trigger': '触发同步', 'calls.discover': '发现调用次数指标', 'calls.preview': '预览调用次数', 'calls.sync': '同步调用次数',
  'budget.update': '修改预算', 'keytags.update': '修改成本中心 / 负责人', 'alert.update': '修改告警设置', 'alert.test': '发送测试消息', 'alert.report': '预览 / 发送报表',
  'smtp.update': '修改邮件服务器', 'smtp.test': '发送测试邮件', 'backup.create': '创建备份', 'backup.download': '下载备份', 'network.update': '修改客户端 IP 来源',
  'user.create': '创建用户', 'user.update': '修改用户', 'user.delete': '删除用户', 'access.denied': '无权限访问', 'oplog.throttled': '操作上报过于频繁',
};
const OP_KEY = { page: '页面', period: '周期', filters: '筛选', metric: '口径', rows: '行数', fields: '修改项', provider: '云厂商', cycles: '账期', force: '强制', send: '立即发送', role: '角色', count: '数量', monthly: '月度预算', keys: 'Key 预算', ipSource: 'IP 来源', hops: '代理层数', error: '失败原因' };
const OP_VAL = { metric: { gross: '原价', after: '优惠后' }, provider: { all: '全部', aliyun: '阿里云', tencent: '腾讯云' }, role: { admin: '管理员', viewer: '只读用户' } };
/** 操作详情 → [[标签, 文本], ...] */
export function opPairs(raw) {
  let d; try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return raw ? [['', String(raw)]] : []; }
  if (!d || typeof d !== 'object') return [];
  return Object.entries(d).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => [OP_KEY[k] || k, OP_VAL[k]?.[v] ?? (k === 'fields' && Array.isArray(v) ? v.join('、') : val(v))]);
}
/** User-Agent → “浏览器 · 系统” */
export function uaText(ua) {
  const s = String(ua || '');
  if (!s) return '';
  const b = /Edg\//.test(s) ? 'Edge' : /DingTalk/i.test(s) ? '钉钉' : /Lark|Feishu/i.test(s) ? '飞书' : /wxwork/i.test(s) ? '企业微信' : /MicroMessenger/i.test(s) ? '微信' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl|python|node|axios|go-http/i.test(s) ? '脚本 / 程序' : '其他';
  const o = /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
}

/* ---------------- IP 与归属地 ---------------- */
export const LOC_RESERVED = new Set(['本机', '内网', '运营商级 NAT', '链路本地', '未指定地址', '测试网段', '组播地址', '保留地址', '文档示例地址']);
/** IP + 归属地两行显示；内网等保留地址显示为灰色标签 */
export function ipHtml(ip, loc) {
  if (!ip) return '<span class="muted">—</span>';
  const tag = loc ? (LOC_RESERVED.has(loc) ? `<span class="ip-loc lan">${esc(loc)}</span>` : `<span class="ip-loc">${esc(loc)}</span>`) : '<span class="ip-loc none">未知归属地</span>';
  return `<span class="ip-cell"><span class="mono">${esc(ip)}</span>${tag}</span>`;
}
export const ipText = (ip, loc) => (ip ? (loc ? `${ip}（${loc}）` : ip) : '');

/* ---------------- 云 API 接口与参数 ---------------- */
export const API = {
  DescribeInstanceBill: '查询实例账单', QueryBillOverview: '查询账单总览', ListWorkspaces: '查询业务空间列表', ListApiKeys: '查询 API Key 列表', GetBillingOverview: '查询百炼账单汇总',
  DescribeApiKeyList: '查询 API Key 列表', DescribeModelEndpointList: '查询推理服务列表', DescribeModelList: '查询模型列表', DescribeUsageRankList: '查询用量排行',
  DescribeBillSummaryByProduct: '按产品汇总账单', DescribeBillDetail: '查询账单明细',
};
const PARAM = {
  BillingCycle: '账期', billMonth: '账期', Month: '账期', BeginTime: '开始账期', EndTime: '结束', StartTime: '开始', BillingDate: '账单日期', Granularity: '粒度',
  MaxResults: '每页', maxResults: '每页', Limit: '每页', Offset: '偏移', NextToken: '翻页标记', nextToken: '翻页标记', Context: '翻页标记', ProductCode: '产品代码', BusinessCode: '产品代码',
  workspaceId: '业务空间', Platform: '平台', Dimension: '维度', MetricType: '指标', Period: '周期', Anchor: 'API Key', ShowAll: '显示全部', groupBy: '分组', topNum: '前 N 项', zeroFilter: '过滤零值', locale: '语言',
};
const PARAM_VAL = {
  Granularity: { DAILY: '按天', MONTHLY: '按月' }, Dimension: { apikey: 'API Key', model: '模型' }, MetricType: { tokens: 'Token 用量', apikey_usage: 'Key 用量' },
  Period: { 86400: '按天', 3600: '按小时' }, ShowAll: { true: '是', false: '否' }, zeroFilter: { true: '是', false: '否' },
};
/** 接口参数摘要 “k=v k=v …”（值可能含空格的翻页标记已被截断）→ 中文 */
export function apiParams(q) {
  const out = [];
  for (const m of String(q || '').matchAll(/(\w+)=(.*?)(?=\s+\w+=|$)/g)) {
    const [, k, v] = m;
    if (k === 'locale') continue;
    const label = PARAM[k] || k;
    const vv = /token|Context/i.test(k) ? '（续页）' : PARAM_VAL[k]?.[v] ?? (k === 'groupBy' ? v.replace(/.*"code":"([^"]+)".*/, '$1') : v);
    out.push([label, vv]);
  }
  return out;
}
