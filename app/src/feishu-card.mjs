/**
 * 飞书群机器人消息卡片（卡片 JSON 1.0）
 *
 * 布局：标题栏（主题色 + 副标题 + 状态标签）→ 指标面板（灰底分栏）→ 趋势图（VChart 柱状图）→ 排行表（分栏对齐名称 / 金额 / 占比）
 *      → 告警条目（彩色标签）→ 操作按钮 → 备注页脚。
 *
 * 兼容性：
 *  - 只使用 1.0 结构中长期支持的组件（column_set / markdown / hr / action / note / chart）；
 *  - 不使用 Markdown 列表语法（以“1. ”“- ”开头的行在飞书 7.6 以下显示为升级占位图），排名用灰色数字单独显示；
 *  - 图表组件需要飞书 7.1+，官方未说明自定义机器人是否支持：发送方按“含图表 → 不含图表 → 简洁卡片”依次降级，内容一定送达。
 *
 * 所有动态文本已由调用方清理（clean() 去掉 Markdown / HTML 特殊字符），这里再去掉尖括号，避免破坏 <font> / <text_tag> 标记。
 */
export const FEISHU_BYTES = 28000; // 自定义机器人请求体上限 30KB，留出签名字段与余量

const TEMPLATE = { bad: 'red', warn: 'orange', good: 'green', info: 'blue' };
const COLOR = { bad: 'red', warn: 'orange', good: 'green', info: 'blue', up: 'red', down: 'green' };
const safe = s => String(s ?? '').replace(/[<>]/g, '');
const md = (content, extra = {}) => ({ tag: 'markdown', content, ...extra });
const font = (color, s) => (color ? `<font color='${color}'>${s}</font>` : s);
const tagMd = (text, level) => `<text_tag color='${COLOR[level] || 'blue'}'>${safe(text)}</text_tag>`;
const col = (weight, elements, extra = {}) => ({ tag: 'column', width: 'weighted', weight, vertical_align: 'center', elements, ...extra });

/** 涨跌：费用上涨为红色 ↑，下降为绿色 ↓（费用越低越好） */
function deltaMd(d) {
  if (!d) return '';
  const arrow = d.dir === 'up' ? '↑ ' : d.dir === 'down' ? '↓ ' : '';
  const text = d.dir ? String(d.text).replace(/^[+−-]/, '') : d.text;
  // 用量（neutral）的涨跌不代表好坏：统一用蓝色
  return `${font('grey', safe(d.label))} ${font(d.neutral ? (d.dir ? 'blue' : 'grey') : COLOR[d.dir] || 'grey', arrow + safe(text))}`;
}

/** 指标面板：灰底分栏，每栏为“标签 / 数值 / 说明”；数值较长时用小一号字体，窄屏下不折行 */
function kpiPanel(kpis) {
  const long = kpis.some(k => String(k.value).length > 9) || kpis.length > 3;
  return {
    tag: 'column_set', flex_mode: 'none', background_style: 'grey', horizontal_spacing: 'default',
    columns: kpis.map(k => col(1, [
      md(font('grey', safe(k.label)), { text_size: 'notation' }),
      md(font(COLOR[k.tone], `**${safe(k.value)}**`), { text_size: long ? 'heading-4' : 'heading-3' }),
      ...(k.delta || k.sub ? [md(k.delta ? deltaMd(k.delta) : font('grey', safe(k.sub)), { text_size: 'notation' })] : []),
    ], { vertical_align: 'top' })),
  };
}

/** 排行表头：与数据行相同的列宽，灰色小字标明单位（费用（元）/ Token 用量）与“占比” */
function headRow(head, share) {
  const h = t => md(font('grey', safe(t || '')), { text_size: 'notation' });
  return {
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'small',
    columns: [col(5, [h(head[0])]), col(3, [{ ...h(head[1]), text_align: 'right' }]), ...(share ? [col(2, [{ ...h(head[2]), text_align: 'right' }])] : [])],
  };
}
/** 排行行：名称（带灰色排名）/ 金额（右对齐加粗）/ 占比（右对齐灰色）；每行一个分栏，名称折行也不会错位 */
function rankRows(rows) {
  const share = rows.some(r => r.share);
  return rows.map((r, i) => ({
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'small',
    columns: [
      col(5, [md(`${font('grey', String(i + 1))}　${safe(r.name)}`)]),
      col(3, [md(`**${safe(r.value)}**`, { text_align: 'right' })]),
      ...(share ? [col(2, [md(font('grey', safe(r.share || '')), { text_align: 'right' })])] : []),
    ],
  }));
}

/** 条目列表（告警 / 异常提示）：彩色标签 + 粗体要点 + 说明；超出字节上限时从末尾整条删减并注明 */
function itemsMd(items, maxBytes, tail = '') {
  const lines = items.map(i => `${i.tag ? tagMd(i.tag, i.level) + ' ' : ''}${safe(i.body ?? i.text)}`);
  const sep = items.length <= 6 ? '\n\n' : '\n';
  let out = [], used = Buffer.byteLength(tail, 'utf8');
  for (let k = 0; k < lines.length; k++) {
    const n = Buffer.byteLength(lines[k], 'utf8') + sep.length;
    if (used + n + 60 > maxBytes) { out.push(font('grey', `…另有 ${lines.length - k} 项未显示，请在系统中查看`)); break; }
    out.push(lines[k]); used += n;
  }
  return out.join(sep) + tail;
}

/** VChart 柱状图：按 k 分组着色（如“此前 / 昨日”“前一周 / 上周”），不使用移动端不支持的纹理 / 渐变 / 脚本 */
function chartEl(c) {
  const seen = [...new Set(c.values.map(v => v.k))];
  const palette = c.colors || {};
  return {
    tag: 'chart', aspect_ratio: '2:1', preview: true,
    chart_spec: {
      type: 'bar', data: { values: c.values }, xField: 'd', yField: 'v', seriesField: 'k', stack: true,
      color: seen.map(k => palette[k] || '#3370FF'),
      bar: { style: { cornerRadius: 2 } },
      axes: [{ orient: 'bottom', label: { style: { fontSize: 10 } } }, { orient: 'left', label: { style: { fontSize: 10 } } }],
    },
  };
}

/**
 * 生成卡片；内容超出上限时返回 null（调用方改用简洁卡片）。
 * doc：{ tags:[{text, level}], kpis / usage:[{label, value, sub, delta, tone}], notes:[], chart / tokenChart:{title, values, colors}, sections:[{title, rows|items}], items:[{text, body, tag, level}] }
 */
export function feishuCard({ title, subtitle, level = 'info', doc = {}, footer, link, links = [], buttons = null, mentions, chart = true }) {
  const E = [];
  if (doc.kpis?.length) E.push(kpiPanel(doc.kpis));
  if (doc.usage?.length) E.push(kpiPanel(doc.usage));
  for (const n of doc.notes || []) E.push(md(font('grey', safe(n)), { text_size: 'notation' }));
  const at = mentions?.all ? '\n<at id=all></at>' : '';
  if (doc.items?.length) E.push(md(itemsMd(doc.items, 16000, at)));
  for (const c of chart ? [doc.chart, doc.tokenChart] : []) if (c?.values?.length >= 3) E.push(md(`**${safe(c.title)}**`), chartEl(c));
  const secs = (doc.sections || []).filter(s => s.rows?.length || s.items?.length);
  if (secs.length && E.length) E.push({ tag: 'hr' });
  for (const s of secs) {
    // 小标题后用灰色小字说明排序依据与占比的分母，避免把占比误读为涨跌幅
    E.push(md(`**${safe(s.title)}**${s.note ? `　${font('grey', safe(s.note))}` : ''}`));
    if (s.rows?.length) { if (s.head) E.push(headRow(s.head, s.rows.some(r => r.share))); E.push(...rankRows(s.rows)); }
    else E.push(md(itemsMd(s.items, 6000)));
  }
  if (at && !doc.items?.length) E.push(md(at.trim()));
  E.push({ tag: 'hr' });
  const btns = (buttons || [link && { text: '查看详情', url: link, type: 'primary' }, ...links]).filter(Boolean).slice(0, 3);
  if (btns.length) E.push({ tag: 'action', layout: 'flow', actions: btns.map(b => ({ tag: 'button', text: { tag: 'plain_text', content: b.text }, type: b.type || 'default', url: b.url })) });
  E.push({ tag: 'note', elements: [{ tag: 'plain_text', content: safe(footer) }] });
  const header = { template: TEMPLATE[level] || 'blue', title: { tag: 'plain_text', content: safe(title) } };
  if (subtitle) header.subtitle = { tag: 'plain_text', content: safe(subtitle) };
  const tags = (doc.tags || []).filter(t => t && t.text).slice(0, 3);
  if (tags.length) header.text_tag_list = tags.map(t => ({ tag: 'text_tag', text: { tag: 'plain_text', content: safe(t.text) }, color: COLOR[t.level] || 'blue' }));
  const card = { msg_type: 'interactive', card: { config: { wide_screen_mode: true, enable_forward: true }, header, elements: E } };
  return Buffer.byteLength(JSON.stringify(card), 'utf8') <= FEISHU_BYTES ? card : null;
}

/**
 * 飞书返回的错误是否属于“卡片内容不被接受”（应降级重发）：签名 / IP 白名单 / 频率限制等错误降级也无济于事，直接报错
 * （19021 签名校验失败、19022 IP 不在白名单、11232 频率限制）。
 * 19024 关键词校验失败会降级：机器人设置了“自定义关键词”时，简洁卡片保留原有的“【品牌】标题”与正文写法，可能包含新卡片中没有的关键词
 */
export function feishuFormatError({ status, text }) {
  let j = null;
  try { j = JSON.parse(text); } catch { return false; }
  const code = Number(j?.code ?? j?.StatusCode);
  if (!Number.isFinite(code) || code === 0) return false;
  if ([19021, 19022, 11232].includes(code)) return false;
  return status === 200 || status === 400;
}
