/* 账单明细：逐条账单（与云厂商费用中心账单对应），用于核对与导出 */
import { $, esc, state, ui, money, moneyFine, intFmt, numFmt, sum, num, METRICS, keyShort, keyDesc, wsName, channelLabel, filterLines, aggAll, totalTokens, icon, help, segCtl, periodTag, DIMS, NONE_KEY, app, copyBtn, PROVIDERS, provTag, multiCloud, dimLink, NO_WS } from '../core.js';
/** 行内“追加筛选”链接：保留其余筛选，只增加 / 替换该维度 */
const fLink = (patch, text, tip) => `<button type="button" class="lnk" data-fpatch="${esc(JSON.stringify(patch))}" title="${esc(tip)}">${esc(text)}</button>`;
import { table } from '../table.js';

export function render(v) {
  const lines = filterLines();
  const a = aggAll(lines);
  const month = ui.period.mode === 'month';
  v.innerHTML = `
    <div class="stat-strip">
      <div><span>账单条数</span><b>${lines.length.toLocaleString()}</b></div>
      <div><span>原价</span><b>${money(a.gross)}</b></div>
      <div><span>折扣</span><b>${money(a.gross - a.after)}</b></div>
      <div><span>优惠后金额（未扣券）</span><b>${money(a.after)}</b></div>
      <div><span>优惠券抵扣</span><b>${money(a.after - a.pretax)}</b></div>
      <div><span>应付金额</span><b>${money(a.pretax)}</b></div>
      <div><span>Token</span><b>${intFmt(totalTokens(a))}</b></div>
    </div>
    <section class="panel">
      <div class="panel-h"><h3>${month ? '账期账单明细' : '按日账单明细'}</h3>${help(`阿里云：每行对应费用中心一条${month ? '账期（月）' : '按日'}实例账单（${month ? '账期' : '日'} × API Key × 业务空间 × 模型 × 计费项 × 渠道）。腾讯云：账单明细按 日 × 资源 × 模型 × 计费项 合并，并按 TokenHub 用量占比拆分到 API Key（标记“分摊”）。导出 CSV 含全部字段（实例/资源 ID、单价、优惠、各类抵扣、商品 Code 等）。`)}
        <span class="sub">共 ${lines.length.toLocaleString()} 条 · ${METRICS[ui.f.metric]}合计 ${money(a.cost)} · 点击 Key / 业务空间 / 模型查看详情，点击计费项 / 渠道追加筛选</span>
        <div class="actions">${segCtl('density', { normal: '标准', compact: '紧凑' })}<button class="btn sm" id="csv">${icon('download')}导出全部字段</button></div></div>
      <div id="tbl"></div>
    </section>`;
  const t = table('detail', $('#tbl', v), {
    sort: 'pretax', pageSize: 100, caption: '账单明细',
    columns: [
      { key: 'desc', label: 'API Key', fmt: (x, r) => `<span class="sw" style="background:${DIMS.key.color(r.apiKeyId || NONE_KEY)}"></span>${r.apiKeyId ? dimLink('key', r.apiKeyId, x) : esc(x)}${provTag(r.provider)}${r.alloc === 1 ? '<span class="tag" title="按 TokenHub 用量占比分摊">分摊</span>' : r.alloc === 2 ? '<span class="tag warn" title="按目录价估算">估算</span>' : ''}<span class="sub mono">${esc(r.apiKeyId || '—')}</span>`, csv: r => keyDesc(r.apiKeyId) },
      { key: 'date', label: month ? '账期' : '日期', fmt: x => (!month && /^\d{4}-\d{2}-\d{2}$/.test(x) ? `<button type="button" class="lnk" data-day="${esc(x)}" title="查看当日明细（沿用当前筛选）">${esc(x)}</button>` : esc(x)) },
      { key: 'wsName', label: '业务空间', fmt: (x, r) => dimLink('ws', r.wsKey || NO_WS, x) },
      { key: 'model', label: '模型', cls: 'mono', fmt: x => dimLink('model', x, x) },
      { key: 'itemLabel', label: '计费项', fmt: (x, r) => `${r.io && !ui.f.item ? fLink({ item: r.io }, x, `只看计费项：${x}`) : esc(x)}${r.io ? `<span class="sub mono">${esc(r.io)}</span>` : ''}` },
      { key: 'chLabel', label: '渠道', fmt: (x, r) => (ui.f.channel === '__all' ? fLink({ channel: r.channel }, x, `只看渠道：${x}`) : esc(x)) },
      { key: 'usage', label: '用量', align: 'r', fmt: (x, r) => (x == null ? '-' : `${numFmt(x, 4)}<span class="sub">${esc(r.usageUnit)}</span>`), sortVal: r => r.usage ?? -1 },
      { key: 'tokens', label: 'Token', align: 'r', fmt: x => (x == null ? '-' : intFmt(x)), sortVal: r => r.tokens ?? -1 },
      { key: 'listPrice', label: '单价', align: 'r', fmt: (x, r) => (x !== '' ? `${esc(x)}<span class="sub">${esc(r.listPriceUnit)}</span>` : '-'), sortVal: r => num(r.listPrice) },
      { key: 'gross', label: '原价', align: 'r', fmt: x => moneyFine(x) },
      { key: 'discountAll', label: '优惠与券', align: 'r', fmt: x => moneyFine(x) },
      { key: 'pretax', label: '应付金额', align: 'r', fmt: x => `<b style="font-weight:600">${moneyFine(x)}</b>` },
      { key: 'stopFlag', label: '用完即停', fmt: x => (x === '1' ? '已开启' : x === '0' ? '未开启' : '-') },
      { key: 'instanceId', label: multiCloud() ? '实例 / 资源 ID' : '实例ID', cls: 'mono', fmt: x => (x ? `${esc(x)}${copyBtn(x, '复制实例ID')}` : '—') },
    ],
    csvExtra: [
      { label: '云厂商', val: r => PROVIDERS[r.provider] || r.provider }, { label: '费用口径', val: r => (r.alloc === 1 ? '按用量分摊' : r.alloc === 2 ? '目录价估算' : '账单直接归属') }, { label: 'API Key ID', val: r => r.apiKeyId }, { label: '业务空间ID', val: r => r.workspaceId }, { label: '计费项编码', val: r => r.io }, { label: '渠道编码', val: r => r.channel },
      { label: '用量单位', val: r => r.usageUnit }, { label: '单价单位', val: r => r.listPriceUnit }, { label: '优惠金额', val: r => r.discount }, { label: '优惠券抵扣', val: r => r.coupons },
      { label: '代金券抵扣', val: r => r.cashCoupons }, { label: '储值卡抵扣', val: r => r.prepaid }, { label: '资源包抵扣', val: r => r.resourcePkg }, { label: '优惠后金额', val: r => r.after },
      { label: '商品名称', val: r => r.productDetail }, { label: '商品Code', val: r => r.commodityCode }, { label: '账单计费项', val: r => r.billingItem }, { label: '地域', val: r => r.region }, { label: '币种', val: r => r.currency },
    ],
    footer: rs => ['合计', `${rs.length.toLocaleString()} 条`, '', '', '', '', '', intFmt(sum(rs, r => r.tokens || 0)), '', moneyFine(sum(rs, r => r.gross)), moneyFine(sum(rs, r => r.discountAll)), `<b>${moneyFine(sum(rs, r => r.pretax))}</b>`, '', ''],
  }).setRows(lines.map(l => ({ ...l, desc: keyShort(l.apiKeyId || NONE_KEY), wsName: wsName(l.wsKey), itemLabel: l.ioi.label, chLabel: channelLabel(l.channel), discountAll: l.gross - l.pretax })));
  $('#csv', v).onclick = () => t.csv(`账单明细_${periodTag()}.csv`);
}
