/* =========================================================================
 * 初始设置清单（仅管理员）：按部署步骤引导首次使用——配置访问密钥 → 首次账单同步 → 分配成本中心 → 设置预算 → 添加通知渠道 → 设置 PUBLIC_URL。
 * 步骤状态来自 /api/status 的 setup 字段（只对管理员返回）；演示模式、只读用户与分享页不显示。
 * 全部完成后自动隐藏；也可在本浏览器中手动隐藏（用户菜单可重新打开）。
 * ========================================================================= */
import { $, esc, state, app, icon, isAdmin, PROVIDERS } from './core.js';

const HIDE_KEY = 'bc.setupHide';
export function setupHidden() { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } }
export function hideSetup(hide) { try { if (hide) localStorage.setItem(HIDE_KEY, '1'); else localStorage.removeItem(HIDE_KEY); } catch { /* 存储不可用：只在本次页面中生效 */ } memHidden = hide; }
let memHidden = null; // 浏览器禁用本地存储时，隐藏操作至少在本次页面中生效
const isHidden = () => (memHidden ?? setupHidden());

/** 全部步骤（含完成状态）；不适用时（非管理员、分享页、演示模式、状态未加载）返回 null */
export function setupSteps() {
  const s = state.status, x = s?.setup;
  if (state.share || !isAdmin() || !x || s.demo) return null;
  const sy = s.sync?.bills || {}, cycles = s.data?.cycles?.length || 0;
  const provNames = x.providers.map(p => PROVIDERS[p] || p).join('、');
  const undec = Object.keys(PROVIDERS).filter(p => s.providers?.[p]?.secretState === 'undecryptable');
  const hasKeys = x.providers.length > 0;
  const tagIds = [...(state.apiKeys?.values() || [])].filter(k => k.source !== 'deleted').length;
  const steps = [
    {
      id: 'keys', icon: 'cloud', title: '配置云厂商访问密钥', done: hasKeys,
      warn: !hasKeys && undec.length ? `已保存的${undec.map(p => PROVIDERS[p]).join('、')}访问密钥无法用当前主密钥解密，请重新填写。` : '',
      desc: hasKeys ? `已配置：${provNames}` : '填写阿里云 RAM AccessKey 或腾讯云 CAM API 密钥（只需只读权限），加密保存后自动开始同步。',
      actions: hasKeys ? [{ label: '查看', go: `#/admin/${x.providers[0]}` }] : [{ label: '阿里云接入', go: '#/admin/aliyun' }, { label: '腾讯云接入', go: '#/admin/tencent' }],
    },
    {
      id: 'sync', icon: 'sync', title: '首次账单同步', done: x.billsSynced, blocked: !hasKeys && !x.billsSynced,
      busy: !x.billsSynced && !!sy.running,
      warn: !x.billsSynced && !sy.running && sy.last?.status === 'error' ? `最近一次同步失败：${sy.last.error || '未知错误'}` : '',
      desc: x.billsSynced
        ? (cycles && cycles < 12 ? `已同步 ${cycles} 个账期。如需补齐全年历史，可在“数据同步”中把回溯月数调到 12 个月后同步账单。` : '账单已同步，之后按设定的间隔自动增量同步。')
        : sy.running ? `正在同步：${sy.progress?.text || '同步中…'}`
        : !hasKeys ? '配置访问密钥后自动开始。'
        : '保存访问密钥后自动开始，按“回溯月数”（默认 3 个月）补齐历史账单；如需全年数据，可在“数据同步”中调到 12 个月。',
      actions: [{ label: '数据同步', go: '#/admin/sync' }],
    },
    {
      id: 'cc', icon: 'tag', title: '分配成本中心', done: x.taggedKeys > 0, blocked: !x.keys,
      desc: x.taggedKeys > 0 ? `已为 ${x.taggedKeys} / ${x.keys} 个 API Key 分配成本中心。`
        : x.keys ? `为 ${x.keys} 个 API Key 设置成本中心与负责人，按部门 / 项目分摊成本、筛选与推送报表。` : '同步到 API Key 列表后即可分配。',
      actions: [tagIds ? { label: x.taggedKeys > 0 ? '编辑' : '分配成本中心', act: 'setup-tags' } : { label: 'Key 分析', go: '#/keys' }],
    },
    {
      id: 'budget', icon: 'wallet', title: '设置预算', done: x.budget,
      desc: x.budget ? '已设置预算，概览中显示预算使用与月末预测。' : '设置整体月度预算、成本中心（部门）预算或单个 Key 的预算，用量达到阈值时推送提醒。',
      actions: [{ label: '预算管理', go: '#/admin/budgets' }],
    },
    {
      id: 'alerts', icon: 'bell', title: '添加通知渠道', done: x.channels > 0,
      desc: x.channels > 0 ? `已启用 ${x.channels} 个通知渠道。` : '添加钉钉 / 飞书 / 企业微信群机器人、通用 Webhook 或邮件，接收预算告警、异常提醒与日报 / 周报。',
      actions: [{ label: '告警通知', go: '#/admin/alerts' }],
    },
    {
      id: 'url', icon: 'link', title: '设置 PUBLIC_URL（消息链接与分享）', done: x.publicUrl,
      desc: x.publicUrl ? '已设置：消息可附带“查看交互报表”链接，并可生成只读分享链接。'
        : '在 .env 中设置系统对外访问地址（如 <code>PUBLIC_URL=<wbr>https://cost.example.com</code>）并重启服务，告警与报表消息才能附带交互报表链接、生成只读分享链接。',
      html: true, actions: [{ label: '查看说明', go: '#/admin/alerts' }],
    },
  ];
  const next = steps.find(st => !st.done && !st.blocked);
  if (next) next.next = true;
  return steps;
}

/** 是否显示清单：有未完成的步骤、且未在本浏览器中隐藏 */
export function setupVisible() {
  const steps = setupSteps();
  return !!steps && steps.some(st => !st.done) && !isHidden();
}
/** 清单可用但已被隐藏（用户菜单显示“重新打开”） */
export function setupReopenable() {
  const steps = setupSteps();
  return !!steps && steps.some(st => !st.done) && isHidden();
}
/** 系统中还没有任何账单（全表统计，与所选周期无关）：首页只显示设置清单，不显示一整页 ¥0.00 */
export function noBillData() {
  const d = state.status?.data;
  return !!d && !(d.dailyLines > 0) && !(d.cycles || []).some(c => Math.abs(c.gross || 0) > 0 || Math.abs(c.pretax || 0) > 0);
}

const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

/** 清单卡片；solo 为 true 时（系统中尚无账单）代替整个概览页 */
export function setupCard(solo = false) {
  const steps = setupSteps();
  if (!steps) return '';
  const done = steps.filter(st => st.done).length, total = steps.length;
  const btn = (a, primary) => {
    const cls = `btn sm${primary ? ' primary' : a.ghost ? ' ghost' : ''}`;
    return a.act ? `<button type="button" class="${cls}" data-act="${a.act}">${esc(a.label)}</button>` : `<button type="button" class="${cls}" data-go="${esc(a.go)}">${esc(a.label)}</button>`;
  };
  const li = (st, i) => {
    const cls = st.done ? 'done' : st.next ? 'next' : st.blocked ? 'blocked' : 'todo';
    const stateText = st.done ? '已完成' : st.busy ? '进行中' : st.next ? '下一步' : st.blocked ? '需先完成前面的步骤' : '未完成';
    const mark = st.done ? icon('check') : st.busy ? `<span class="dot busy"></span>` : String(i + 1);
    const desc = st.html ? st.desc : esc(st.desc);
    return `<li class="${cls}">
      <span class="step-n" aria-hidden="true">${mark}</span>
      <div class="step-b"><b class="step-t">${esc(st.title)}</b><span class="sr-only">（${stateText}）</span>${st.next && !st.busy ? '<span class="pill info step-pill" aria-hidden="true">下一步</span>' : ''}
        <span class="step-d">${desc}</span>${st.warn ? `<span class="step-w">${icon('warn')}${esc(st.warn)}</span>` : ''}</div>
      <div class="step-a">${st.blocked ? '' : st.actions.map((a, j) => btn(st.done ? { ...a, ghost: true } : a, st.next && j === 0)).join('')}</div>
    </li>`;
  };
  const body = `<div class="setup-h">
      <div class="setup-ttl"><h3 id="setupTitle">${icon('bulb')}初始设置</h3><span class="pill ${done ? 'good' : 'neutral'}">已完成 ${done} / ${total}</span></div>
      <button type="button" class="btn ghost icon sm setup-x" data-act="setup-hide" aria-label="隐藏初始设置清单" title="在此浏览器中隐藏（可从右上角用户菜单重新打开）">${icon('x')}</button>
      <p class="hint setup-sub">按顺序完成以下步骤即可开始分析大模型 API Key 成本，完成一项勾选一项；全部完成后清单自动隐藏。</p>
    </div>
    <div class="progress" role="progressbar" aria-label="初始设置进度" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${(done / total * 100).toFixed(0)}%"></i></div>
    <ol class="setup-steps">${steps.map(li).join('')}</ol>
    ${solo ? '<p class="hint setup-foot">完成首次账单同步后，这里将显示费用概览（本期费用、预测、趋势与排行）。</p>' : ''}`;
  return `<section class="panel setup${solo ? ' solo' : ''}" id="setup" aria-labelledby="setupTitle" data-solo="${solo ? 1 : 0}" data-sig="${hash(body)}">${body}</section>`;
}

/** 状态较旧时（如刚在系统管理中保存了预算 / 渠道后回到首页）在后台刷新一次，清单随之更新 */
let inflight = false;
export function freshenStatus(maxAge = 4000) {
  if (inflight || Date.now() - (state.statusAt || 0) < maxAge) return;
  inflight = true;
  Promise.resolve(app.refreshStatus(true)).finally(() => { inflight = false; });
}

/**
 * 状态刷新后更新首页上的清单：内容变化时只替换卡片；显示 / 隐藏或“代替整页”状态变化时重绘页面
 * （对话框打开时不重绘，下次刷新再处理）
 */
export function syncSetupCard() {
  if (!state.data || state.loading) return;
  const el = $('#view #setup'), want = setupVisible();
  if (!el && !want) return;
  const solo = want && noBillData();
  if (!el || !want || (el.dataset.solo === '1') !== solo) { if (!document.querySelector('dialog[open]')) app.render(); return; }
  const html = setupCard(solo);
  const sig = /data-sig="([^"]+)"/.exec(html)?.[1];
  if (sig && el.dataset.sig !== sig) el.outerHTML = html;
}
