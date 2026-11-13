/*
 * 只读分享页启动（公开脚本）：
 *  1. 从链接的 # 片段读取令牌（浏览器不会把 # 片段发给服务器，也不会写入代理日志 / Referer），随即从地址栏移除，只保存在本标签页的 sessionStorage；
 *  2. POST /api/share/open 换取 HttpOnly 的分享会话 Cookie（最长 12 小时，且不超过链接有效期）；
 *  3. 成功后加载前端模块（main.js 以只读分享模式运行：只显示该链接的周期与范围，没有系统管理、同步、用户等功能）。
 */
(function () {
  var KEY = 'bc.share';
  var m = /^#([A-Za-z0-9_-]{43})$/.exec(location.hash || '');
  var token = m ? m[1] : null;
  try { if (token) sessionStorage.setItem(KEY, token); else token = sessionStorage.getItem(KEY); } catch (e) { /* 隐私模式：只在本次加载中使用 */ }
  if (m) history.replaceState(null, '', location.pathname + '#/overview');

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fail(title, why) {
    var app = document.getElementById('app');
    if (!app) return;
    app.className = 'share-fail';
    app.innerHTML = '<div class="share-fail-card"><div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round"><path d="M4 19V11M10 19V5M16 19v-6M22 19H2"/></svg></div>'
      + '<h1>' + esc(title) + '</h1><p>' + esc(why) + '</p><p class="muted">只读分享链接由系统管理员通过告警通知或“分享链接”生成，有效期内无需登录即可查看。如需继续查看，请联系管理员重新发送。</p></div>';
    document.title = title;
  }
  window.__TT_SHARE_FAIL__ = fail;
  if (!token) { fail('链接不完整', '请从消息中重新打开完整的链接（链接末尾的 # 及之后的内容不能缺少）。'); return; }

  fetch('/api/share/open', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function (x) {
      if (!x.ok) {
        if (x.status !== 429) { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
        fail(x.status === 429 ? '尝试次数过多' : x.j.code === 'expired' ? '链接已过期' : x.j.code === 'revoked' ? '链接已被撤销' : '链接无效', x.j.error || '无法打开该分享链接。');
        return;
      }
      window.__TT_SHARE__ = x.j;
      var s = document.createElement('script');
      s.type = 'module'; s.src = '/js/main.js';
      document.body.appendChild(s);
    })
    .catch(function () { fail('无法连接服务', '网络错误，请稍后刷新页面重试。'); });
})();
