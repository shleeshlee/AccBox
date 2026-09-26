/* AccBox 分享页（访客端）
 * 只跟 /api/s/<token>/* 说话；访客令牌和主题偏好存在本机 localStorage。
 */
(() => {
  'use strict';
  const TOKEN = decodeURIComponent(location.pathname.replace(/^\/s\//, '').replace(/\/+$/, ''));
  const API = `/api/s/${encodeURIComponent(TOKEN)}`;
  const LS_KEY = `accbox_share_${TOKEN}`;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ---------- 主题：亮/暗自己切，四季跟主程序同一套规则（按月份） ----------
  let theme = 'dark';
  try { theme = localStorage.getItem('share_theme') || 'dark'; } catch (e) {}
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
    $('themeBtn').textContent = theme === 'light' ? '☀️' : '🌙';
  }
  function realSeason() { const m = new Date().getMonth() + 1; return m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter'; }
  document.body.setAttribute('data-season', realSeason());
  applyTheme();
  $('themeBtn').addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; try { localStorage.setItem('share_theme', theme); } catch (e) {} applyTheme(); });

  let guestToken = null;
  try { guestToken = localStorage.getItem(LS_KEY); } catch (e) {}
  let accounts = [], perms = {}, totp = {}, totpFetchedAt = 0, serverOffset = 0;
  let tickTimer = null, mailTimer = null, mailRefreshTimer = null;

  // ---------- 提示（复用主程序 .toast 样式） ----------
  const toastEl = $('toast'); let toastT;
  const say = (m, err) => { toastEl.textContent = m; toastEl.className = 'toast show' + (err ? ' error' : ''); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1800); };
  const copy = async (t, m) => {
    try { await navigator.clipboard.writeText(t); say(m || '已复制'); }
    catch (e) {
      try { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); say(m || '已复制'); }
      catch (e2) { say('复制失败，长按选中吧', true); }
    }
  };

  // ---------- 请求 ----------
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (guestToken) headers['Authorization'] = 'Bearer ' + guestToken;
    let res;
    try { res = await fetch(API + path, { ...opts, headers, credentials: 'omit' }); }
    catch (e) { throw new Error('网络不通，稍后再试'); }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) { forgetToken(); showGate('needpin'); throw new Error(data.detail || '需要口令'); }
    if (res.status === 410) { showGate('closed', data.detail); throw new Error(data.detail || '链接已关闭'); }
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '出错了');
    return data;
  }
  function forgetToken() { guestToken = null; try { localStorage.removeItem(LS_KEY); } catch (e) {} }

  // ---------- 口令屏 ----------
  let info = null;
  function showGate(state, msg) {
    stopLoops();
    $('main').hidden = true; $('gate').hidden = false; $('pinForm').hidden = true; $('lock').hidden = true;
    const desc = $('gateDesc');
    if (state === 'closed') { desc.textContent = msg || '这个链接已经关闭'; return; }
    if (state === 'missing') { desc.textContent = '链接不存在'; return; }
    if (state === 'locked') { desc.textContent = msg || '口令错太多次，等 15 分钟再试'; return; }
    desc.textContent = info ? `来自 ${info.owner} 的分享 · ${info.count} 个账号` : '';
    $('pinForm').hidden = false; $('pinErr').textContent = ''; setTimeout(() => $('pin').focus(), 50);
  }
  $('pinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = $('pin').value.trim(); if (!pin) return;
    $('pinBtn').disabled = true; $('pinErr').textContent = '';
    try {
      const res = await fetch(API + '/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 410) return showGate('closed', data.detail);
      if (res.status === 423) return showGate('locked', data.detail);
      if (!res.ok) { $('pinErr').textContent = data.detail || '口令不对'; return; }
      guestToken = data.guest_token; try { localStorage.setItem(LS_KEY, guestToken); } catch (e) {}
      $('pin').value = '';
      await enter();
    } catch (e) { $('pinErr').textContent = '网络不通，稍后再试'; }
    finally { $('pinBtn').disabled = false; }
  });

  // ---------- 主页面 ----------
  async function enter() {
    const data = await api('/accounts');
    accounts = data.accounts; perms = data.perms || {};
    $('ownerLine').innerHTML = `来自 <b>${esc(data.owner)}</b> 的分享 · ${accounts.length} 个账号`;
    $('gate').hidden = true; $('main').hidden = false; $('lock').hidden = false;
    $('mailbox').hidden = !perms.mail_codes;
    render();
    await loadTotp();
    startLoops();
    if (perms.mail_codes) { loadMail(); refreshMail(true); }
  }

  const R = 14, C = 2 * Math.PI * R;
  function render() {
    $('list').innerHTML = accounts.map(a => `
      <article class="sh-acc ${a.has_totp ? '' : 'nocode'}" data-id="${a.id}">
        <div class="sh-head"><span class="sh-flag">${esc(a.country || '🌍')}</span><span class="sh-name">${esc(a.customName || a.email)}</span>${a.type_name ? `<span class="sh-svc">${esc(a.type_icon || '')} ${esc(a.type_name)}</span>` : ''}</div>
        <div class="sh-mail"><span>${esc(a.email)}</span><button class="sh-chip" data-copy="${esc(a.email)}" title="复制邮箱">⧉</button></div>
        <div class="sh-code">
          ${a.has_totp ? `<span class="sh-num ${a.totp_type === 'steam' ? 'steam' : ''}" data-code>······</span>
          <svg class="sh-ring" viewBox="0 0 34 34" aria-hidden="true"><circle class="bg" cx="17" cy="17" r="${R}"/><circle class="fg" cx="17" cy="17" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>`
          : `<span class="sh-num">没有二步验证</span>`}
        </div>
        ${a.note ? `<div class="sh-note">${esc(a.note)}</div>` : ''}
        <div class="sh-foot">
          ${a.has_totp ? `<button class="sh-chip primary" data-copycode>复制安全码</button>` : ''}
          ${perms.edit ? `<button class="sh-chip" data-edit>${a.note ? '改备注' : '写备注'}${perms.password ? ' / 密码' : ''}</button>` : ''}
          ${perms.password ? `<span class="sh-pw">密码 <code data-pw data-real="${esc(a.password || '')}">${a.password ? '••••••••' : '（空）'}</code><button class="sh-chip" data-showpw>显示</button><button class="sh-chip" data-copy="${esc(a.password || '')}">复制</button></span>` : ''}
        </div>
        ${perms.edit ? `<div class="sh-edit">
          ${perms.password ? `<input value="${esc(a.password || '')}" aria-label="密码" placeholder="密码" data-f="password">` : ''}
          <textarea placeholder="你自己的备注" data-f="note">${esc(a.note || '')}</textarea>
          <div class="row"><button class="sh-chip" data-cancel>取消</button><button class="sh-chip primary" data-save>保存</button></div>
        </div>` : ''}
      </article>`).join('');
    tick();
  }

  // ---------- 安全码 ----------
  async function loadTotp() {
    try {
      const data = await api('/totp');
      totp = data.codes || {}; totpFetchedAt = Date.now();
      if (data.server_time) serverOffset = data.server_time * 1000 - Date.now();
      $('dot').classList.remove('off'); $('tickText').textContent = '自动刷新';
    } catch (e) { $('dot').classList.add('off'); $('tickText').textContent = e.message; }
    tick();
  }
  function tick() {
    const now = Date.now() + serverOffset;
    let minLeft = 30, needFetch = false;
    document.querySelectorAll('.sh-acc[data-id]').forEach(el => {
      const num = el.querySelector('[data-code]'); if (!num) return;
      const c = totp[el.dataset.id];
      if (!c) { num.textContent = '······'; return; }
      const period = c.period || 30;
      const elapsed = Math.floor((Date.now() - totpFetchedAt) / 1000);
      const left = c.remaining - elapsed;
      if (left <= 0) { needFetch = true; num.textContent = '······'; return; }
      minLeft = Math.min(minLeft, left);
      const code = c.code || '';
      num.textContent = code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
      num.classList.toggle('soon', left <= 5);
      const fg = el.querySelector('.fg'); fg.style.strokeDashoffset = C * (1 - left / period); fg.classList.toggle('soon', left <= 5);
    });
    const d = new Date(now);
    $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` + (Object.keys(totp).length ? ` · ${minLeft}s 后换` : '');
    if (needFetch && Date.now() - totpFetchedAt > 1500) loadTotp();
  }
  function startLoops() {
    stopLoops();
    tickTimer = setInterval(tick, 1000);
    if (perms.mail_codes) {
      mailTimer = setInterval(() => { if (!document.hidden) loadMail(); }, 15000);
      mailRefreshTimer = setInterval(() => { if (!document.hidden) refreshMail(true); }, 45000);
    }
  }
  function stopLoops() { clearInterval(tickTimer); clearInterval(mailTimer); clearInterval(mailRefreshTimer); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('main').hidden) { loadTotp(); if (perms.mail_codes) loadMail(); } });

  // ---------- 邮箱验证码 ----------
  function ago(iso) { const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000)); return s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`; }
  async function loadMail() {
    try {
      const data = await api('/mail-codes');
      const list = $('mailList');
      if (!data.codes || !data.codes.length) { list.innerHTML = '<div class="empty">最近 5 分钟没有新邮件</div>'; return; }
      list.innerHTML = data.codes.map(c => `<div class="item"><b>${esc(c.code)}</b><span class="who">${esc(c.service || '')}${c.service ? ' · ' : ''}${esc(c.account_name || c.email)}</span><span class="ago">${ago(c.created_at)}</span><button class="sh-chip" data-copy="${esc(c.code)}">复制</button></div>`).join('');
    } catch (e) {}
  }
  async function refreshMail(silent) {
    const btn = $('mailRefresh'); btn.disabled = true;
    try {
      const data = await api('/mail-refresh', { method: 'POST' });
      if (!silent) say(data.throttled ? '刚刷过，稍等几秒' : (data.new_codes && data.new_codes.length ? `收到 ${data.new_codes.length} 个新验证码` : '没有新邮件'));
      if (data.errors && data.errors.length && !silent) say(data.errors[0].message || '有邮箱收信失败', true);
      await loadMail();
    } catch (e) { if (!silent) say(e.message, true); }
    finally { btn.disabled = false; }
  }
  $('mailRefresh').addEventListener('click', () => refreshMail(false));

  // ---------- 点击 ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.copy !== undefined) { copy(b.dataset.copy); return; }
    if (b.hasAttribute('data-copycode')) { const t = b.closest('.sh-acc').querySelector('[data-code]').textContent.replace(/\s/g, ''); if (/^[·]+$/.test(t)) return say('安全码还没取到', true); copy(t, '安全码已复制 ' + t); return; }
    if (b.hasAttribute('data-showpw')) { const c = b.closest('.sh-pw').querySelector('[data-pw]'); const hidden = c.textContent.startsWith('•'); c.textContent = hidden ? (c.dataset.real || '（空）') : (c.dataset.real ? '••••••••' : '（空）'); b.textContent = hidden ? '隐藏' : '显示'; return; }
    if (b.hasAttribute('data-edit')) { b.closest('.sh-acc').querySelector('.sh-edit').classList.toggle('open'); return; }
    if (b.hasAttribute('data-cancel')) { b.closest('.sh-edit').classList.remove('open'); return; }
    if (b.hasAttribute('data-save')) {
      const acc = b.closest('.sh-acc'), ed = acc.querySelector('.sh-edit'), id = Number(acc.dataset.id);
      const cur = accounts.find(x => x.id === id) || {};
      const body = {}; ed.querySelectorAll('[data-f]').forEach(i => { if (i.value !== (cur[i.dataset.f] || '')) body[i.dataset.f] = i.value; });
      if (!Object.keys(body).length) { ed.classList.remove('open'); return say('没有改动'); }
      b.disabled = true;
      try {
        await api(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        if ('password' in body) cur.password = body.password; if ('note' in body) cur.note = body.note;
        render(); say('已保存');
      } catch (e2) { say(e2.message, true); }
      finally { b.disabled = false; }
      return;
    }
    if (b.id === 'lock') { forgetToken(); showGate('needpin'); return; }
  });

  // ---------- 启动 ----------
  (async () => {
    if (!TOKEN) return showGate('missing');
    try {
      const res = await fetch(API + '/info');
      if (res.status === 404) return showGate('missing');
      info = await res.json();
      if (info.status !== 'active') return showGate('closed');
      if (info.locked) return showGate('locked');
    } catch (e) { $('gateDesc').textContent = '网络不通，稍后再试'; return; }
    if (guestToken) {
      try { await enter(); return; } catch (e) { /* 令牌失效会自动回到口令屏 */ }
    }
    showGate('needpin');
  })();
})();
