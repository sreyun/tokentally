/** 最近的云 API 调用记录（不含任何密钥），供管理页面排查；仅内存保存 */
export const callLog = [];
export function recordCall(entry) {
  callLog.unshift(entry);
  if (callLog.length > 300) callLog.length = 300;
}
/** 日志中的参数摘要：截断长值，避免日志过大 */
export function summarize(q) {
  return Object.entries(q || {}).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${s.length > 80 ? s.slice(0, 80) + '…' : s}`;
  }).join(' ');
}
