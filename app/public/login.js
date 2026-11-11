'use strict';
(function () {
  try {
    const t = localStorage.getItem('bc.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* ignore */ }
  const form = document.getElementById('loginForm');
  const err = document.getElementById('err');
  const btn = document.getElementById('btnLogin');
  const user = document.getElementById('username');
  const pw = document.getElementById('password');
  const toggle = document.getElementById('togglePw');
  const caps = document.getElementById('caps');
  // 品牌名称（管理员可在“系统管理 → 品牌与备份”中修改）
  fetch('/api/branding', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).then(b => {
    if (!b) return;
    var acc = ['indigo', 'violet', 'teal', 'graphite'].indexOf(b.accent) >= 0 ? b.accent : '';
    if (acc) document.documentElement.dataset.accent = acc; else delete document.documentElement.dataset.accent;
    try { localStorage.setItem('bc.accent', acc || 'blue'); } catch (e) { /* ignore */ }
    if (!b.name) return;
    document.title = '登录 · ' + b.name;
    const h = document.getElementById('loginBrand');
    if (h) h.textContent = b.name;
  }).catch(() => { /* ignore */ });
  try {
    const m = sessionStorage.getItem('bc.loginMsg');
    if (m) { err.textContent = m.slice(0, 120); sessionStorage.removeItem('bc.loginMsg'); }
  } catch { /* ignore */ }
  const capsCheck = e => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
  pw.addEventListener('keydown', capsCheck);
  pw.addEventListener('keyup', capsCheck);
  pw.addEventListener('blur', () => { caps.hidden = true; });
  toggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    pw.focus();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    if (!user.value.trim() || !pw.value) { err.textContent = '请输入用户名和密码'; (user.value.trim() ? pw : user).focus(); return; }
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: user.value.trim(), password: pw.value }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '登录失败，请稍后重试');
      location.replace('/' + (location.hash || ''));
    } catch (ex) {
      err.textContent = ex.message;
      pw.value = '';
      pw.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });
})();
