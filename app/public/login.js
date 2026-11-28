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
  /**
   * 公开演示站点：服务端返回演示账号（只读）时，在登录按钮下方显示用户名与密码，并可一键填入。
   * 用 textContent 写入（不拼接 HTML），用户名 / 密码来自部署配置
   */
  function showDemo(d) {
    if (document.getElementById('demoLogin')) return;
    const box = document.createElement('div');
    box.className = 'demo-login';
    box.id = 'demoLogin';
    const t = document.createElement('div');
    t.className = 'demo-t';
    t.textContent = '演示账号（只读，数据为虚构的演示数据）';
    const row = (label, value) => {
      const r = document.createElement('div');
      r.className = 'demo-r';
      const k = document.createElement('span'); k.textContent = label;
      const v = document.createElement('code'); v.textContent = value;
      r.append(k, v);
      return r;
    };
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'btn sm';
    fill.textContent = '填入演示账号';
    fill.addEventListener('click', () => { user.value = d.username; pw.value = d.password || ''; err.textContent = ''; btn.focus(); });
    box.append(t, row('用户名', d.username), row('密码', d.password || ''), fill);
    form.after(box);
    const sub = document.querySelector('.login-card > p');
    if (sub) sub.textContent = '可使用下方的演示账号直接登录体验';
  }
  // 品牌名称（管理员可在“系统管理 → 品牌与备份”中修改）
  fetch('/api/branding', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).then(b => {
    if (!b) return;
    var acc = ['indigo', 'violet', 'teal', 'graphite'].indexOf(b.accent) >= 0 ? b.accent : '';
    if (acc) document.documentElement.dataset.accent = acc; else delete document.documentElement.dataset.accent;
    try { localStorage.setItem('bc.accent', acc || 'blue'); } catch (e) { /* ignore */ }
    if (b.demoLogin && b.demoLogin.username) showDemo(b.demoLogin);
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
