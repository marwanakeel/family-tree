// server.js — zero-dependency Node backend for the Family Tree.
//
// Serves the static app AND provides accounts + server-side persistence so the
// tree is shared and durable (no more per-browser localStorage / file juggling):
//   • Viewing requires an approved account (family PII is never public).
//   • New sign-ups are "pending" until an admin approves them.
//   • Only admins can edit the tree; everyone approved can view.
//
// Data lives on disk in DATA_DIR (mounted from the node in production), never in
// the image or repo:  family.json  users.json  sessions.json  config.local.json
//
// Usage:  node server.js [port]     (env: PORT, DATA_DIR, WEB_ROOT,
//                                     ADMIN_USER, ADMIN_PASS)
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const WEB_ROOT = process.env.WEB_ROOT ? normalize(process.env.WEB_ROOT) : fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(WEB_ROOT, '.data');
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8123;

const FILES = {
  tree: join(DATA_DIR, 'family.json'),
  users: join(DATA_DIR, 'users.json'),
  sessions: join(DATA_DIR, 'sessions.json'),
  config: join(DATA_DIR, 'config.local.json'),
};
// Basenames that must NEVER be served as static files, even if WEB_ROOT and
// DATA_DIR overlap (they do in local dev, where family.json sits in the repo).
const DENY_STATIC = new Set(['users.json', 'sessions.json', 'config.local.json', 'family.json', 'family.real.json']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- file helpers
// Serialize writes per-file so concurrent saves can't interleave/corrupt.
const writeChains = new Map();
function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(obj, null, 1));
    await rename(tmp, file); // atomic replace
  }).catch((e) => { console.error('write failed', file, e); });
  writeChains.set(file, next);
  return next;
}

// ---------------------------------------------------------------- auth helpers
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
const newToken = () => randomBytes(32).toString('hex');
const uname = (s) => String(s || '').trim().toLowerCase();

// ---------------------------------------------------------------- app state
let users = readJSON(FILES.users, null);   // { [username]: {username,displayName,pass,role,approved,createdAt} }
let sessions = readJSON(FILES.sessions, {}); // { [token]: {username, createdAt} }
const loginFails = new Map();               // username -> { count, until }

function bootstrapAdmin() {
  if (!users) users = {};
  const cfg = readJSON(FILES.config, {}) || {};
  const au = uname(process.env.ADMIN_USER || (cfg.admin && cfg.admin.username));
  const ap = process.env.ADMIN_PASS || (cfg.admin && cfg.admin.password);
  const hasAdmin = Object.values(users).some((u) => u.role === 'admin');
  if (au && ap && !users[au]) {
    users[au] = { username: au, displayName: cfg.admin?.displayName || au, pass: hashPassword(ap), role: 'admin', approved: true, createdAt: Date.now() };
    writeJSON(FILES.users, users);
    console.log(`  ✓ admin account "${au}" created from config/env`);
  } else if (!hasAdmin && !au) {
    // Dev convenience only — loud warning; override in production via env/config.
    const dev = { username: 'admin', displayName: 'Admin', pass: hashPassword('admin1234'), role: 'admin', approved: true, createdAt: Date.now() };
    users.admin = dev;
    writeJSON(FILES.users, users);
    console.warn('  ⚠ no admin configured — created DEV admin  admin / admin1234  (set ADMIN_USER/ADMIN_PASS or config.local.json for production!)');
  }
}

async function ensureTree() {
  if (existsSync(FILES.tree)) return;
  // Seed from a repo-root family.json (local dev) if present, else an empty tree.
  const seed = readJSON(join(WEB_ROOT, 'family.json'), null) || { title: 'Our Family Tree', people: [], relationships: [] };
  await writeJSON(FILES.tree, seed);
}

// ---------------------------------------------------------------- http helpers
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}
function setSessionCookie(res, req, token) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + 60 * 60 * 24 * 30];
  if (isHttps(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', `ft_session=${token}; ${flags.join('; ')}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ft_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const publicUser = (u) => u && ({ username: u.username, displayName: u.displayName, role: u.role, approved: u.approved });
function currentUser(req) {
  const tok = parseCookies(req).ft_session;
  const sess = tok && sessions[tok];
  if (!sess) return null;
  return users[sess.username] || null;
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, path) {
  const method = req.method;
  const me = currentUser(req);

  // ---- session / identity
  if (path === '/api/me' && method === 'GET') {
    return send(res, 200, { user: publicUser(me) });
  }
  if (path === '/api/register' && method === 'POST') {
    const b = await readBody(req).catch(() => null);
    if (!b) return send(res, 400, { error: 'bad_request' });
    const username = uname(b.username);
    const password = String(b.password || '');
    const displayName = String(b.displayName || '').trim().slice(0, 60) || username;
    if (username.length < 3 || username.length > 32 || !/^[a-z0-9._-]+$/.test(username)) return send(res, 400, { error: 'bad_username' });
    if (password.length < 6) return send(res, 400, { error: 'weak_password' });
    if (users[username]) return send(res, 409, { error: 'taken' });
    const first = Object.keys(users).length === 0; // very first account becomes an approved admin
    users[username] = { username, displayName, pass: hashPassword(password), role: first ? 'admin' : 'viewer', approved: first, createdAt: Date.now() };
    await writeJSON(FILES.users, users);
    if (first) {
      const token = newToken();
      sessions[token] = { username, createdAt: Date.now() };
      await writeJSON(FILES.sessions, sessions);
      setSessionCookie(res, req, token);
      return send(res, 200, { user: publicUser(users[username]), firstAdmin: true });
    }
    return send(res, 200, { pending: true });
  }
  if (path === '/api/login' && method === 'POST') {
    const b = await readBody(req).catch(() => null);
    if (!b) return send(res, 400, { error: 'bad_request' });
    const username = uname(b.username);
    // Rate-limit per CLIENT+account (not per account alone — that would let any
    // stranger lock the family admin out), and let expired locks start fresh.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const lockKey = ip + '|' + username;
    let lock = loginFails.get(lockKey);
    if (lock && lock.until && lock.until <= Date.now()) { loginFails.delete(lockKey); lock = null; }
    if (lock && lock.until > Date.now()) return send(res, 429, { error: 'locked', retryMs: lock.until - Date.now() });
    const u = users[username];
    if (!u || !verifyPassword(String(b.password || ''), u.pass)) {
      const cur = loginFails.get(lockKey) || { count: 0 };
      cur.count++;
      if (cur.count >= 5) { cur.until = Date.now() + 15 * 60 * 1000; cur.count = 0; }
      loginFails.set(lockKey, cur);
      return send(res, 401, { error: 'invalid' });
    }
    loginFails.delete(lockKey);
    const token = newToken();
    sessions[token] = { username, createdAt: Date.now() };
    await writeJSON(FILES.sessions, sessions);
    setSessionCookie(res, req, token);
    return send(res, 200, { user: publicUser(u) });
  }
  if (path === '/api/logout' && method === 'POST') {
    const tok = parseCookies(req).ft_session;
    if (tok && sessions[tok]) { delete sessions[tok]; await writeJSON(FILES.sessions, sessions); }
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  // ---- everything below needs an approved account
  if (!me) return send(res, 401, { error: 'auth_required' });
  if (!me.approved) return send(res, 403, { error: 'pending' });

  if (path === '/api/tree' && method === 'GET') {
    const tree = readJSON(FILES.tree, { title: 'Our Family Tree', people: [], relationships: [] });
    return send(res, 200, tree);
  }
  if (path === '/api/tree' && method === 'PUT') {
    if (me.role !== 'admin') return send(res, 403, { error: 'forbidden' });
    const b = await readBody(req).catch(() => null);
    if (!b || !Array.isArray(b.people)) return send(res, 400, { error: 'bad_tree' });
    // Optimistic concurrency: a save based on a stale copy would silently erase
    // whatever another admin (or another tab) saved in between — reject it and
    // let the client reload instead of losing their edit.
    const cur = readJSON(FILES.tree, {});
    if (cur.updatedAt && b.baseUpdatedAt !== cur.updatedAt) {
      return send(res, 409, { error: 'stale', updatedAt: cur.updatedAt, updatedBy: cur.updatedBy || null });
    }
    const tree = { title: b.title || 'Our Family Tree', title_en: b.title_en || '', people: b.people, relationships: Array.isArray(b.relationships) ? b.relationships : [], updatedAt: Date.now(), updatedBy: me.username };
    await writeJSON(FILES.tree, tree);
    return send(res, 200, { ok: true, updatedAt: tree.updatedAt });
  }

  // ---- admin: user management
  if (path === '/api/users' && method === 'GET') {
    if (me.role !== 'admin') return send(res, 403, { error: 'forbidden' });
    return send(res, 200, { users: Object.values(users).map(publicUser).sort((a, b) => Number(a.approved) - Number(b.approved) || a.username.localeCompare(b.username)) });
  }
  const um = /^\/api\/users\/([a-z0-9._-]+)\/(approve|role|delete)$/.exec(path);
  if (um && method === 'POST') {
    if (me.role !== 'admin') return send(res, 403, { error: 'forbidden' });
    const target = users[um[1]];
    if (!target) return send(res, 404, { error: 'no_user' });
    const action = um[2];
    if (action === 'approve') {
      target.approved = true;
    } else if (action === 'role') {
      const b = await readBody(req).catch(() => ({}));
      const role = b.role === 'admin' ? 'admin' : 'viewer';
      if (target.username === me.username && role !== 'admin') return send(res, 400, { error: 'self_demote' });
      target.role = role;
      if (role === 'admin') target.approved = true;
    } else if (action === 'delete') {
      if (target.username === me.username) return send(res, 400, { error: 'self_delete' });
      delete users[target.username];
      for (const [tok, s] of Object.entries(sessions)) if (s.username === target.username) delete sessions[tok];
      await writeJSON(FILES.sessions, sessions);
    }
    await writeJSON(FILES.users, users);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- static
async function handleStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('Method Not Allowed'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(WEB_ROOT, urlPath));
  if (!filePath.startsWith(WEB_ROOT) || DENY_STATIC.has(basename(filePath))) { res.writeHead(404).end('Not found'); return; }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) { res.writeHead(404).end('Not found'); return; }
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    // SPA fallback for extension-less routes; genuine misses 404.
    if (!extname(urlPath)) {
      try { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(await readFile(join(WEB_ROOT, 'index.html'))); return; } catch {}
    }
    res.writeHead(404).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.startsWith('/api/')) return await handleApi(req, res, urlPath);
    return await handleStatic(req, res, urlPath);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server_error' });
    else res.end();
  }
});

await mkdir(DATA_DIR, { recursive: true });
bootstrapAdmin();
await ensureTree();
server.listen(PORT, () => {
  console.log(`\n  🌳  Family Tree (with accounts) at  http://localhost:${PORT}`);
  console.log(`      data: ${DATA_DIR}\n`);
});
