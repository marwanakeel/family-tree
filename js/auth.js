// auth.js — talks to the server backend and puts up the login/register/pending
// gate. The app only boots once there's an APPROVED session, so viewing is
// never public. `credentials: same-origin` carries the HttpOnly session cookie.
import { STRINGS } from './i18n.js';

let lang = (() => { try { return localStorage.getItem('familyTree.lang'); } catch { return null; } })() || 'ar';
if (!STRINGS[lang]) lang = 'ar';
const t = (k) => (STRINGS[lang] && STRINGS[lang][k]) || k;

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

export const Auth = {
  me: null,
  async fetchMe() {
    const { data } = await api('/api/me');
    this.me = data.user || null;
    return this.me;
  },
  login: (username, password) => api('/api/login', 'POST', { username, password }),
  register: (username, password, displayName) => api('/api/register', 'POST', { username, password, displayName }),
  async logout() { await api('/api/logout', 'POST'); location.reload(); },
  listUsers: () => api('/api/users'),
  approve: (u) => api(`/api/users/${encodeURIComponent(u)}/approve`, 'POST'),
  setRole: (u, role) => api(`/api/users/${encodeURIComponent(u)}/role`, 'POST', { role }),
  remove: (u) => api(`/api/users/${encodeURIComponent(u)}/delete`, 'POST'),

  // Resolve to an approved user, or keep the gate up and resolve null.
  async gate() {
    const me = await this.fetchMe();
    if (me && me.approved) return me;
    renderGate(me && !me.approved ? 'pending' : 'login', me);
    return null;
  },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderGate(view, me) {
  let g = document.getElementById('authGate');
  if (!g) { g = document.createElement('div'); g.id = 'authGate'; document.body.appendChild(g); }
  const S = STRINGS[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = S.dir;
  document.body.classList.toggle('lang-en', lang === 'en');

  if (view === 'pending') {
    g.innerHTML = `
      <div class="auth-card">
        <div class="auth-logo">🌳</div>
        <h1>${esc(t('authPendingTitle'))}</h1>
        <p class="auth-sub">${esc(t('authPendingDesc'))}</p>
        <button class="primary" id="authLogout">${esc(t('logout'))}</button>
      </div>`;
    g.querySelector('#authLogout').onclick = () => Auth.logout();
    return;
  }

  const isReg = view === 'register';
  g.innerHTML = `
    <div class="auth-card">
      <div class="auth-logo">🌳</div>
      <h1>${esc(t('appTitleFallback'))}</h1>
      <p class="auth-sub">${esc(isReg ? t('authRegSub') : t('authLoginSub'))}</p>
      <form id="authForm">
        ${isReg ? `<label>${esc(t('authDisplayName'))}<input name="displayName" autocomplete="name" required /></label>` : ''}
        <label>${esc(t('authUsername'))}<input name="username" autocomplete="username" required dir="ltr" /></label>
        <label>${esc(t('authPassword'))}<input name="password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" required dir="ltr" /></label>
        <div class="auth-err" id="authErr" hidden></div>
        <button class="primary" type="submit">${esc(isReg ? t('authRegister') : t('authLogin'))}</button>
      </form>
      <p class="auth-switch">
        ${esc(isReg ? t('authHaveAccount') : t('authNoAccount'))}
        <button class="linkbtn" id="authSwitch">${esc(isReg ? t('authLogin') : t('authRegister'))}</button>
      </p>
      <button class="linkbtn auth-lang" id="authLang">${esc(S.langName === 'العربية' ? 'English' : 'العربية')}</button>
    </div>`;

  const err = (msg) => { const e = g.querySelector('#authErr'); e.textContent = msg; e.hidden = false; };
  g.querySelector('#authSwitch').onclick = () => renderGate(isReg ? 'login' : 'register');
  g.querySelector('#authLang').onclick = () => {
    lang = lang === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('familyTree.lang', lang); } catch {}
    renderGate(view);
  };
  g.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (isReg) {
        const r = await Auth.register(f.username, f.password, f.displayName);
        if (!r.ok) return err(t('authErr_' + (r.data.error || 'generic')) || t('authErr_generic'));
        if (r.data.firstAdmin) return location.reload();
        renderGate('pending');
      } else {
        const r = await Auth.login(f.username, f.password);
        if (!r.ok) return err(r.data.error === 'locked' ? t('authErr_locked') : t('authErr_invalid'));
        location.reload();
      }
    } catch {
      err(t('authErr_network'));
    } finally {
      btn.disabled = false;
    }
  };
}
