/**
 * Token 数量的显示单位：按量自动换算——千（K）/ 百万（M）/ 十亿（B），不足 1 千时显示整数。
 * 小用量用 K，常规计费与月度用量用 M，超大用量用 B；报表消息（飞书 / 钉钉 / 企业微信 / 邮件）统一使用。
 *
 * 阈值按显示精度取整后的值判断：999,960 显示为 1.00 M，而不是 1,000.0 K。
 * 同一组数值（排行、趋势图）由调用方按组内最大值取一次单位，避免同一区块里 K 与 M 混用。
 * 字母单位旁注明中文：正文为“12.34 M（百万）”，指标卡与排行表头为“Token（百万）”，图表标题与排行说明为“M = 百万”
 */
const ONE = { div: 1, unit: '', name: '个', dec: 0 };
const K = { div: 1e3, unit: 'K', name: '千', dec: 1 };
const M = { div: 1e6, unit: 'M', name: '百万', dec: 2 };
const B = { div: 1e9, unit: 'B', name: '十亿', dec: 2 };

export function tokUnit(max) {
  const n = Math.abs(Number(max) || 0);
  if (n < 999.5) return ONE;
  if (n < 999.95e3) return K;
  if (n < 999.995e6) return M;
  return B;
}
/** 按指定单位显示：12.34 M、850.2 K、999 */
export const tokIn = (n, u) => (Number(n || 0) / u.div).toLocaleString('zh-CN', { minimumFractionDigits: u.dec, maximumFractionDigits: u.dec }) + (u.unit ? ' ' + u.unit : '');
/** 单个数值：按自身大小取单位 */
export const tok = n => tokIn(n, tokUnit(n));
/** 单个数值并注明中文单位：12.34 M（百万）；不足 1 千时没有单位 */
export const tokZh = n => { const u = tokUnit(n); return tokIn(n, u) + (u.unit ? `（${u.name}）` : ''); };
/** 单位说明（图表标题、排行说明）：“M = 百万”；不足 1 千时为“个” */
export const tokUnitLabel = u => (u.unit ? `${u.unit} = ${u.name}` : '个');
/** 同一处出现多种单位时的图例 */
export const TOK_LEGEND = 'K = 千，M = 百万，B = 十亿';
