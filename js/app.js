// app.js — wires data, rendering, navigation and editing together.
import { CONFIG, isShared } from './config.js';
import { loadData, saveData, subscribe, getMode } from './store.js';
import { computeLayout, NODE_W, NODE_H } from './layout.js';
import { STRINGS } from './i18n.js';
import { Auth } from './auth.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (sel) => document.querySelector(sel);

// ---------- Language ----------
let lang = (() => { try { return localStorage.getItem('familyTree.lang'); } catch { return null; } })() || 'ar';
if (!STRINGS[lang]) lang = 'ar';
const t = (k) => STRINGS[lang][k];

function applyLang() {
  const S = STRINGS[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = S.dir;
  document.title = S.htmlTitle;
  document.body.classList.toggle('lang-en', lang === 'en');
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = S[n.getAttribute('data-i18n')]; });
  document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = S[n.getAttribute('data-i18n-ph')]; });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = S[n.getAttribute('data-i18n-title')]; });
  const seg = $('#viewSeg'); if (seg) seg.setAttribute('aria-label', S.toggleView);
  const mb = $('#modeBadge');
  if (mb) { mb.textContent = me ? (canEdit ? S.roleAdmin : S.roleViewer) : S.local; mb.classList.toggle('admin', canEdit); if (me) mb.title = me.displayName || me.username; }
  const lb = $('#btnLang'); if (lb) lb.textContent = S.langBtn;
  const hl = $('#helpList'); if (hl) hl.innerHTML = S.helpItems.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  applyTitle();
  if (layout.nodes.length) render(); // re-draw cards in the new language
  updateViewSeg();
  updateBreadcrumbs();
  if (selectedId && byId(selectedId) && panel.classList.contains('open') && !panel.querySelector('#personForm')) openPerson(selectedId);
}

// ---------- State ----------
let data = { title: 'شجرة العائلة', people: [], relationships: [] };
let layout = { nodes: [], couples: [], groups: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
let view = { x: 0, y: 0, k: 1 };
let stageRect = null; // cached stage bounds (declared early — used during init before the data await)
let focusAnim = null; // rAF id for the "center" zoom animation
let selectedId = null;
let me = null;             // the signed-in account (from Auth)
let canEdit = false;       // true only for admins — viewers are read-only
const posById = new Map(); // id -> {x,y}

// ---------- Navigation state ----------
let focusId = null;          // the centered person in focus mode
let mode = 'focus';          // 'focus' = ego/pedigree view · 'all' = full tree
const collapsed = new Set(); // ids whose descendants are folded away
let downSet = new Set();     // focus + its descendants currently shown (where folding makes sense)
let recents = (() => { try { return JSON.parse(localStorage.getItem('familyTree.recents')) || []; } catch { return []; } })();

// ---------- Browse surface (the calm complement to the canvas) ----------
let surface = 'tree';        // 'tree' = SVG canvas · 'browse' = list/families/directory
let browseTab = (() => { try { return localStorage.getItem('familyTree.browseTab'); } catch { return null; } })() || 'list';
if (!['list', 'fam', 'dir'].includes(browseTab)) browseTab = 'list';
const expandedRows = new Set(); // outline rows whose children are shown
let famId = null;               // household anchor in the families tab

// ---------- DOM ----------
const svg = $('#tree');
const stage = $('#stage');
const panel = $('#panel');
const toastEl = $('#toast');
let viewport; // <g> that everything is drawn into

// =====================================================================
// Boot
// =====================================================================
init();

async function init() {
  // Gate first: viewing requires an approved account. If not signed in / not yet
  // approved, Auth puts up the login/register/pending screen and we stop here.
  me = await Auth.gate();
  if (!me) return;
  canEdit = me.role === 'admin';
  document.body.classList.toggle('can-edit', canEdit);

  buildSvgSkeleton();
  wireToolbar();
  wirePanZoom();
  wireSearch();
  wireKeyboard();
  wireMinimap();
  wireBrowse();
  refreshStageRect();

  try {
    data = await loadData();
  } catch (e) {
    console.error(e);
    toast(t('loadFailed'));
  }
  applyTitle();
  focusId = pickInitialFocus();
  famId = focusId;
  const root0 = rootPersonId();
  if (root0) expandedRows.add(root0);
  const h0 = readHash();
  if (h0.v) { surface = 'browse'; browseTab = h0.v; }
  render();
  applyLang();
  startView();

  // One-time welcome hint for first-time family visitors.
  try {
    if (!localStorage.getItem('familyTree.hinted') && data.people.length > 1) {
      localStorage.setItem('familyTree.hinted', '1');
      setTimeout(() => toast(t('firstVisitHint')), 900);
    }
  } catch {}

  // Live updates from other family members (shared mode only).
  subscribe((incoming) => {
    data = incoming;
    applyTitle();
    render();
    if (selectedId && byId(selectedId)) openPerson(selectedId);
    toast(t('treeUpdated'));
  });
}

function buildSvgSkeleton() {
  svg.innerHTML = '';
  viewport = el('g', { id: 'viewport' });
  viewport.append(el('g', { id: 'links' }), el('g', { id: 'nodes' }));
  svg.append(viewport);
}

function applyTitle() {
  const title = lang !== 'ar' && data.title_en ? data.title_en : CONFIG.appTitle || data.title || t('htmlTitle');
  $('#appTitle').textContent = title;
  document.title = title;
}

// =====================================================================
// Data helpers
// =====================================================================
const byId = (id) => data.people.find((p) => p.id === id);
// Return a field in the current UI language: prefer p.en.<key> when not in Arabic.
function field(p, key) {
  if (lang !== 'ar' && p && p.en && p.en[key]) return p.en[key];
  return p ? p[key] || '' : '';
}
// Localize digits + date markers for display (Arabic-Indic → Latin in English mode).
function locText(s) {
  s = String(s || '');
  if (lang === 'ar') return s;
  return s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/هـ/g, ' AH').replace(/م/g, ' AD');
}
const fullName = (p) => [field(p, 'firstName'), field(p, 'lastName')].filter(Boolean).join(' ').trim() || t('unnamed');
function spousesOf(id) {
  return data.relationships.filter((r) => r.type === 'spouse' && (r.a === id || r.b === id)).map((r) => (r.a === id ? r.b : r.a)).filter(byId);
}
function childrenOf(id) {
  return data.relationships.filter((r) => r.type === 'parent' && r.parent === id).map((r) => r.child).filter(byId);
}
function parentsOf(id) {
  return data.relationships.filter((r) => r.type === 'parent' && r.child === id).map((r) => r.parent).filter(byId);
}
function siblingsOf(id) {
  const set = new Set();
  for (const par of parentsOf(id)) for (const c of childrenOf(par)) if (c !== id) set.add(c);
  return [...set];
}
// Children of the HOUSEHOLD: this data links children to one parent (usually
// the father), so a spouse with no links of their own inherits the couple's —
// clicking the wife must never make the children disappear.
function householdChildrenOf(id) {
  const own = childrenOf(id);
  if (own.length) return own;
  const set = new Set();
  for (const sp of spousesOf(id)) for (const c of childrenOf(sp)) set.add(c);
  return [...set];
}
function lifespan(p) {
  const b = locText((p.birth || '').trim());
  const d = locText((p.death || '').trim());
  if (b && d) return `${b} – ${d}`;
  return b || d || '';
}
function initials(p) {
  return ((field(p, 'firstName') || '').charAt(0) + (field(p, 'lastName') || '').charAt(0)).toUpperCase() || '?';
}
function genderClass(p) {
  return p.gender === 'male' ? 'male' : p.gender === 'female' ? 'female' : 'other';
}
function newId() {
  const rnd = (crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return 'p_' + rnd;
}
function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
// Short name for the card: leading whole words up to ~18 chars, else full name.
function cardName(p) {
  const full = fullName(p);
  const LIM = 18;
  if (full.length <= LIM) return full;
  const toks = full.split(/\s+/);
  let out = toks[0] || '';
  for (let i = 1; i < toks.length; i++) {
    if ((out + ' ' + toks[i]).length > LIM) break;
    out += ' ' + toks[i];
  }
  return out.length < full.length ? out + '…' : out;
}
// Card name over up to TWO lines — compound Arabic names are the norm here and
// a single 18-char line chopped most of them.
function nameLines(p) {
  const full = fullName(p);
  const LIM = 16;
  if (full.length <= LIM) return [full];
  const toks = full.split(/\s+/);
  let l1 = toks[0] || '', i = 1;
  while (i < toks.length && (l1 + ' ' + toks[i]).length <= LIM) { l1 += ' ' + toks[i]; i++; }
  let l2 = toks.slice(i).join(' ');
  if (l2.length > LIM) l2 = l2.slice(0, LIM - 1) + '…';
  return l2 ? [l1, l2] : [l1];
}

// =====================================================================
// Focus / pedigree navigation
// =====================================================================
// Subset for focus mode: the person's ancestor spine (all the way up) + their
// descendants down to `downDepth` (stopping at collapsed nodes) + spouses of
// everyone shown. computeLayout() then renders just this slice of the tree.
function egoData(rootId, downDepth = 3) {
  const keep = new Set();
  downSet = new Set();
  const up = (id, seen = new Set()) => {
    if (seen.has(id)) return; seen.add(id); keep.add(id);
    for (const par of parentsOf(id)) up(par, seen);
  };
  const down = (id, depth) => {
    keep.add(id); downSet.add(id);
    if (depth >= downDepth || collapsed.has(id)) return;
    for (const ch of householdChildrenOf(id)) down(ch, depth + 1);
  };
  up(rootId);
  // Married-in spouse (no recorded parents): anchor the view on the blood
  // partner's ancestor spine so the couple stays inside the family tree.
  if (!parentsOf(rootId).length) for (const sp of spousesOf(rootId)) up(sp);
  down(rootId, 0);
  for (const id of [...keep]) for (const sp of spousesOf(id)) keep.add(sp);
  const people = data.people.filter((p) => keep.has(p.id));
  const relationships = data.relationships.filter((r) =>
    r.type === 'spouse' ? keep.has(r.a) && keep.has(r.b) : keep.has(r.parent) && keep.has(r.child)
  );
  return { title: data.title, title_en: data.title_en, people, relationships };
}

const rootPersonId = () => (byId('n1') ? 'n1' : (data.people[0] ? data.people[0].id : null));

// Navigate to a person: in focus mode this re-roots the view on them.
function goTo(id) {
  if (!byId(id)) return;
  if (surface === 'browse') {
    pushRecent(id);
    if (browseTab === 'fam') { famId = id; renderBrowse(); scrollBrowseTop(); }
    else revealInBrowse(id);
    openPerson(id);
    updateHash(id);
    return;
  }
  if (mode === 'focus' && id !== focusId) { focusId = id; pushRecent(id); render(); }
  openPerson(id);
  if (mode === 'focus') frameFocus(id); else focusOn(id);
  updateHash(id);
}
function pushRecent(id) {
  recents = [id, ...recents.filter((x) => x !== id)].slice(0, 12);
  try { localStorage.setItem('familyTree.recents', JSON.stringify(recents)); } catch {}
  updateBreadcrumbs();
}
function setMode(m) {
  mode = m;
  render();
  if (mode === 'all') fit();
  else if (focusId && byId(focusId)) frameFocus(focusId);
  updateViewSeg();
  updateBreadcrumbs();
}
function goHome() {
  const root = rootPersonId();
  if (!root) return;
  if (surface === 'browse') setSurface('tree');
  mode = 'focus'; focusId = root; collapsed.clear();
  pushRecent(root); render(); frameFocus(root);
  updateViewSeg(); updateBreadcrumbs(); updateHash(root);
}
// The segmented view switcher (تركيز | كل الشجرة | تصفّح) shows WHERE YOU ARE —
// one control, current view highlighted, no label-flipping toggles.
function updateViewSeg() {
  const cur = surface === 'browse' ? 'browse' : mode; // 'focus' | 'all' | 'browse'
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) =>
    b.classList.toggle('active', b.getAttribute('data-view') === cur)
  );
}
// Hash schema: #p=<id> (tree) or #v=list|fam|dir&p=<id> (browse views).
function readHash() {
  const h = location.hash || '';
  const p = /[#&]p=([^&]+)/.exec(h);
  const v = /[#&]v=(list|fam|dir)/.exec(h);
  return { id: p ? decodeURIComponent(p[1]) : null, v: v ? v[1] : null };
}
function readHashId() { return readHash().id; }
function updateHash(id) {
  const anchor = id || (surface === 'browse' && browseTab === 'fam' ? famId : focusId);
  const v = surface === 'browse' ? 'v=' + browseTab + '&' : '';
  try { history.replaceState(null, '', '#' + v + (anchor ? 'p=' + encodeURIComponent(anchor) : '')); } catch {}
}
function pickInitialFocus() {
  const h = readHashId();
  return (h && byId(h)) ? h : rootPersonId();
}
function startView() {
  if (mode === 'focus' && focusId && byId(focusId)) {
    // A deep link opens that person's card; the plain landing stays uncluttered.
    const h = readHashId();
    if (h && byId(h)) openPerson(h);
    frameFocus(focusId);
  } else initialView();
  if (surface === 'browse') {
    setSurface('browse');
    const h = readHashId();
    if (h && byId(h) && browseTab !== 'fam') revealInBrowse(h);
  }
}

// =====================================================================
// Rendering
// =====================================================================
// Pick the deepest focus view (up to 3 generations down) that still lays out
// at a browsable width. Huge branches (the root!) land at 1 generation — the
// whole family row visible side by side — and the "+N" badges open the rest.
function focusLayout() {
  refreshStageRect();
  const maxW = Math.max(2400, (stageRect && stageRect.width ? stageRect.width : 1200) * 3.2);
  for (let depth = 3; depth >= 1; depth--) {
    const ly = computeLayout(egoData(focusId, depth));
    if (depth === 1 || ly.bbox.maxX - ly.bbox.minX <= maxW) return ly;
  }
}

function render() {
  layout = (mode === 'focus' && focusId && byId(focusId)) ? focusLayout() : computeLayout(data);
  posById.clear();
  for (const n of layout.nodes) posById.set(n.id, { x: n.x, y: n.y });

  $('#emptyState').hidden = data.people.length > 0;

  const linksG = $('#links');
  const nodesG = $('#nodes');
  linksG.innerHTML = '';
  nodesG.innerHTML = '';
  cullables = [];

  // Marriage lines.
  for (const c of layout.couples) {
    const a = posById.get(c.a);
    const b = posById.get(c.b);
    if (!a || !b) continue;
    const left = a.x < b.x ? a : b;
    const right = a.x < b.x ? b : a;
    const y = left.y + NODE_H / 2;
    const ml = el('path', { class: 'link marriage', d: `M ${left.x + NODE_W} ${y} L ${right.x} ${y}` });
    linksG.append(ml);
    cullables.push({ el: ml, x0: left.x + NODE_W, y0: y - 2, x1: right.x, y1: y + 2, shown: true });
  }

  // Parent → children connectors — smooth flowing curves.
  for (const g of layout.groups) {
    const f = posById.get(g.focus);
    if (!f) continue;
    let px, py;
    if (g.spouse && posById.get(g.spouse)) {
      const s = posById.get(g.spouse);
      px = (f.x + NODE_W / 2 + s.x + NODE_W / 2) / 2; // couple centre
    } else {
      px = f.x + NODE_W / 2;
    }
    py = f.y + NODE_H; // descend from the bottom of the parent/couple
    const childPts = g.children.map((id) => posById.get(id)).filter(Boolean);
    if (!childPts.length) continue;
    let d = '', minX = px, maxX = px, maxY = py;
    for (const c of childPts) {
      const cx = c.x + NODE_W / 2, cy = c.y;
      const midY = py + (cy - py) * 0.5;
      d += `M ${px} ${py} C ${px} ${midY} ${cx} ${midY} ${cx} ${cy} `;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
    }
    const lp = el('path', { class: 'link', d });
    linksG.append(lp);
    cullables.push({ el: lp, x0: minX, y0: py, x1: maxX, y1: maxY, shown: true });
  }

  // Person cards.
  for (const node of layout.nodes) {
    const p = byId(node.id);
    if (!p) continue;
    const card = renderCard(p, node);
    nodesG.append(card);
    cullables.push({ el: card, x0: node.x, y0: node.y, x1: node.x + NODE_W, y1: node.y + NODE_H + 3, shown: true });
  }

  updateStats();
  drawMinimap();
  updateBreadcrumbs();
  applyTransform();
  if (surface === 'browse') renderBrowse(); // keep the list in sync with edits/language
}

function toAr(n) {
  return String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]);
}
function yearNum(s) {
  const a = String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const m = /\d{3,4}/.exec(a);
  return m ? +m[0] : null;
}
// Generations of the WHOLE family (not the current focus slice) — memoized per
// data object so the header stat doesn't change as you navigate.
let _gensFor = null, _gens = 0;
function familyGens() {
  if (_gensFor === data.people) return _gens;
  _gensFor = data.people;
  const full = computeLayout(data);
  _gens = full.nodes.length ? Math.max(...full.nodes.map((n) => n.depth)) + 1 : 0;
  return _gens;
}
function updateStats() {
  const node = $('#appStats');
  if (!node) return;
  const ppl = data.people.length;
  if (!ppl) { node.textContent = ''; return; }
  const gens = familyGens();
  let minY = Infinity;
  for (const p of data.people) { const y = yearNum(p.birth); if (y) minY = Math.min(minY, y); }
  const fmt = lang === 'ar' ? toAr : (x) => String(x);
  node.textContent = STRINGS[lang].stats(fmt(ppl), fmt(gens), minY !== Infinity ? fmt(minY) : '—');
}

function renderCard(p, node) {
  const g = el('g', {
    class: `node ${genderClass(p)}${p.death ? ' deceased' : ''}${p.id === selectedId ? ' selected' : ''}`,
    transform: `translate(${node.x}, ${node.y})`,
    'data-id': p.id,
  });

  g.append(el('rect', { class: 'card-shadow', x: 0, y: 3, width: NODE_W, height: NODE_H, rx: 13 }));
  g.append(el('rect', { class: 'card', x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 13 }));
  g.append(el('rect', { class: 'stripe', x: NODE_W - 6, y: 0, width: 6, height: NODE_H, rx: 0 }));

  // One <defs> holding the text clip (so names never spill outside the card)
  // and, if needed, the round photo clip.
  const defs = el('defs', {});
  const tclipId = 'tc_' + p.id;
  const tclip = el('clipPath', { id: tclipId });
  tclip.append(el('rect', { x: 10, y: 0, width: NODE_W - 74, height: NODE_H }));
  defs.append(tclip);

  // Avatar (right side for RTL Arabic layout).
  const cx = NODE_W - 38, cy = NODE_H / 2, r = 24;
  if (p.photo) {
    const clipId = 'clip_' + p.id;
    const clip = el('clipPath', { id: clipId });
    clip.append(el('circle', { cx, cy, r }));
    defs.append(clip);
    g.append(defs);
    g.append(el('circle', { class: 'avatar-ring', cx, cy, r: r + 1.5 }));
    g.append(el('image', { href: p.photo, x: cx - r, y: cy - r, width: r * 2, height: r * 2, 'clip-path': `url(#${clipId})`, preserveAspectRatio: 'xMidYMid slice' }));
  } else {
    g.append(defs);
    g.append(el('circle', { class: 'avatar-ring', cx, cy, r }));
    g.append(text('avatar-initials', cx, cy + 5.5, initials(p)));
  }

  const tx = NODE_W - 70; // text right-aligned (see .node text-anchor in CSS)
  const clipped = (cls, y, str) => {
    const t = text(cls, tx, y, str);
    t.setAttribute('clip-path', `url(#${tclipId})`);
    g.append(t);
  };
  const lines = nameLines(p);
  const two = lines.length > 1;
  clipped('name', two ? 28 : 36, lines[0]);
  if (two) clipped('name', 46, lines[1]);
  const span = lifespan(p);
  if (span) clipped('dates', two ? 64 : 55, truncate(span, 18));
  if (p.birthPlace) clipped('place', two ? 80 : 72, truncate(p.birthPlace, 20));

  // Branch toggle (focus mode). Three cases:
  //   children rendered → "−" folds the branch
  //   collapsed         → "+N" reopens it
  //   cut by the depth limit → "+N" re-roots on this person to reveal them.
  // Without the third case, 3rd-generation cards with children looked childless.
  if (mode === 'focus' && downSet.has(p.id)) {
    const kidCount = householdChildrenOf(p.id).length;
    const isCollapsed = collapsed.has(p.id);
    const hasRenderedKids = !isCollapsed && householdChildrenOf(p.id).some((c) => posById.has(c));
    if (kidCount) {
      const tg = el('g', { class: 'toggle', transform: `translate(${NODE_W / 2}, ${NODE_H})` });
      if (hasRenderedKids) {
        tg.append(el('circle', { class: 'toggle-bg', cx: 0, cy: 0, r: 9 }));
        tg.append(text('toggle-sign', 0, 4.5, '−'));
      } else {
        const label = '+' + (lang === 'ar' ? toAr(kidCount) : kidCount);
        const w = Math.max(24, 12 + label.length * 8);
        tg.append(el('rect', { class: 'toggle-bg', x: -w / 2, y: -10, width: w, height: 20, rx: 10 }));
        tg.append(text('toggle-sign', 0, 4.5, label));
      }
      const tip = el('title', {});
      tip.textContent = hasRenderedKids ? t('collapse') : t('expand');
      tg.append(tip);
      tg.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hasRenderedKids) { collapsed.add(p.id); render(); }
        else if (isCollapsed) { collapsed.delete(p.id); render(); }
        else goTo(p.id); // depth-cut: re-root here so the hidden generations open up
      });
      g.append(tg);
    }
  }

  g.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panned) return; // ignore the click that ends a drag
    goTo(p.id);
  });
  return g;
}

// =====================================================================
// Pan / zoom
// =====================================================================
function refreshStageRect() { stageRect = stage.getBoundingClientRect(); }

// Coalesce rapid pan/zoom updates into one transform write per animation frame.
let _rafPending = false;
function scheduleTransform() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => { _rafPending = false; applyTransform(); });
}

function applyTransform() {
  if (!stageRect) refreshStageRect();
  viewport.setAttribute('transform', `translate(${view.x}, ${view.y}) scale(${view.k})`);
  // Semantic zoom: drop detail when far out (CSS-driven, cheap).
  svg.classList.toggle('lod-far', view.k < 0.4);
  svg.classList.toggle('lod-mid', view.k >= 0.4 && view.k < 0.8);
  cull();
  updateMinimapView();
}
function clampK(k) {
  // Floor low enough that fit() can truly frame the ~16k-px-wide full tree even
  // on a phone (LOD + the minimap keep the far-out view navigable).
  return Math.max(0.03, Math.min(2.6, k));
}
function zoomAt(px, py, factor) {
  const k2 = clampK(view.k * factor);
  const ratio = k2 / view.k;
  view.x = px - (px - view.x) * ratio;
  view.y = py - (py - view.y) * ratio;
  view.k = k2;
  applyTransform(); // discrete zoom (button/wheel/pinch) — apply now; pan uses rAF batching
}

// Viewport culling — hide nodes/links outside the visible world-rect so the
// browser only paints what's on screen. Coords come from `layout` (no DOM reads).
let cullables = []; // { el, x0, y0, x1, y1, shown }
function cull() {
  // If the stage has no measured size yet (initial load / hidden tab), don't
  // cull — leave everything visible rather than blanking the tree.
  if (!stageRect || !stageRect.width || !stageRect.height || !cullables.length) return;
  const m = 280; // world-unit margin so panning reveals neighbours early
  const vx0 = (-view.x) / view.k - m, vy0 = (-view.y) / view.k - m;
  const vx1 = (stageRect.width - view.x) / view.k + m, vy1 = (stageRect.height - view.y) / view.k + m;
  for (const c of cullables) {
    const vis = c.x1 >= vx0 && c.x0 <= vx1 && c.y1 >= vy0 && c.y0 <= vy1;
    if (vis !== c.shown) { c.el.style.display = vis ? '' : 'none'; c.shown = vis; }
  }
}
// ---- Minimap (overview + click-to-jump; shown in full-tree mode) ----
let mmT = null; // {scale, offX, offY} world → minimap-canvas mapping
function drawMinimap() {
  const wrap = $('#minimap'), cv = $('#minimapCanvas');
  if (!wrap || !cv) return;
  if (mode !== 'all') { wrap.hidden = true; return; }
  wrap.hidden = false;
  const { minX, minY, maxX, maxY } = layout.bbox;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const W = cv.width, H = cv.height, pad = 6;
  const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const offX = pad + (W - pad * 2 - w * scale) / 2 - minX * scale;
  const offY = pad + (H - pad * 2 - h * scale) / 2 - minY * scale;
  mmT = { scale, offX, offY };
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = (getComputedStyle(document.body).getPropertyValue('--accent') || '#15715f').trim();
  for (const n of layout.nodes) ctx.fillRect(n.x * scale + offX, n.y * scale + offY, Math.max(1.5, NODE_W * scale), Math.max(1.5, NODE_H * scale));
  updateMinimapView();
}
function updateMinimapView() {
  const wrap = $('#minimap'), box = $('#minimapView');
  if (!wrap || wrap.hidden || !box || !mmT || !stageRect) return;
  const vx0 = (-view.x) / view.k, vy0 = (-view.y) / view.k;
  box.style.left = (vx0 * mmT.scale + mmT.offX) + 'px';
  box.style.top = (vy0 * mmT.scale + mmT.offY) + 'px';
  box.style.width = (stageRect.width / view.k * mmT.scale) + 'px';
  box.style.height = (stageRect.height / view.k * mmT.scale) + 'px';
}
function wireMinimap() {
  const cv = $('#minimapCanvas'); if (!cv) return;
  let dragging = false;
  // Center the main view on the world point under the minimap pointer.
  const jump = (e) => {
    if (!mmT || !stageRect) return;
    const r = cv.getBoundingClientRect();
    const wx = (e.clientX - r.left - mmT.offX) / mmT.scale;
    const wy = (e.clientY - r.top - mmT.offY) / mmT.scale;
    view.x = stageRect.width / 2 - wx * view.k;
    view.y = stageRect.height / 2 - wy * view.k;
    applyTransform();
  };
  // Press-and-drag to scrub the viewport around the whole canvas continuously.
  cv.addEventListener('pointerdown', (e) => {
    dragging = true;
    cv.classList.add('dragging');
    try { cv.setPointerCapture(e.pointerId); } catch {}
    jump(e);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
  const end = (e) => {
    dragging = false;
    cv.classList.remove('dragging');
    try { cv.releasePointerCapture(e.pointerId); } catch {}
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

// ---- Breadcrumbs (ancestor spine root → the current anchor) ----
// Anchor = the focused person on the canvas, or the current household in the
// families tab. The outline/directory tabs don't need a trail.
function updateBreadcrumbs() {
  const bar = $('#breadcrumbs'); if (!bar) return;
  const anchor = surface === 'browse'
    ? (browseTab === 'fam' ? famId : null)
    : (mode === 'focus' ? focusId : null);
  if (!anchor || !byId(anchor)) { bar.hidden = true; bar.innerHTML = ''; return; }
  const chain = []; let cur = anchor; const seen = new Set();
  while (cur && !seen.has(cur)) { seen.add(cur); chain.push(cur); cur = parentsOf(cur)[0]; }
  chain.reverse();
  bar.hidden = false;
  bar.innerHTML = chain
    .map((id) => `<button class="crumb${id === anchor ? ' current' : ''}" data-goto="${escapeAttr(id)}">${escapeHtml(cardName(byId(id)))}</button>`)
    .join('<span class="crumb-sep">›</span>');
  bar.querySelectorAll('[data-goto]').forEach((c) => (c.onclick = () => goTo(c.getAttribute('data-goto'))));
}
// =====================================================================
// Browse surface — outline / families / directory
// =====================================================================
function setSurface(s, tab) {
  surface = s;
  if (tab) browseTab = tab;
  document.body.classList.toggle('browsing', s === 'browse');
  $('#browse').hidden = s !== 'browse';
  if (s === 'browse') {
    try { localStorage.setItem('familyTree.browseTab', browseTab); } catch {}
    renderBrowse();
  }
  updateViewSeg();
  updateBreadcrumbs();
  updateHash();
}
const scrollBrowseTop = () => { const bb = $('#browseBody'); if (bb) bb.scrollTop = 0; };

function renderBrowse() {
  const body = $('#browseBody'); if (!body || surface !== 'browse') return;
  $('#browse').querySelectorAll('.browse-tabs button').forEach((b) =>
    b.classList.toggle('active', b.getAttribute('data-tab') === browseTab)
  );
  if (browseTab === 'list') renderOutline(body);
  else if (browseTab === 'fam') renderFam(body);
  else renderDir(body);
}

// --- outline (قائمة): the family as a collapsible table of contents ---
function renderOutline(body) {
  const root = rootPersonId();
  if (!root) { body.innerHTML = ''; return; }
  const cnt = (n) => (lang === 'ar' ? toAr(n) : String(n));
  let html = `<div class="browse-actions">
      <button data-act="expandAll">${t('expandAll')}</button>
      <button data-act="collapseAll">${t('collapseAll')}</button>
    </div>`;
  const seen = new Set(); // guard against cycles in imported data
  // `guides[a]` = does the ancestor whose connector column is `a` still have
  // siblings below? (draws the continuous │ lines); `isLast` picks ├ vs └.
  const addRow = (id, depth, guides, isLast) => {
    const p = byId(id); if (!p || seen.has(id)) return;
    seen.add(id);
    const kids = childrenOf(id);
    const open = expandedRows.has(id);
    const guideHtml = guides.map((on, a) => (on ? `<i class="bguide" style="--g:${a}"></i>` : '')).join('');
    // Whole ROW toggles the branch (the intuitive tap); ⓘ opens the person card.
    html += `<div class="brow${id === selectedId ? ' sel' : ''}${depth ? ' sub' : ''}${isLast ? ' lastkid' : ''}${kids.length ? ' haskids' : ''}"
        data-id="${escapeAttr(id)}" ${kids.length ? 'data-kids="1"' : ''} style="--d:${depth}">
      ${guideHtml}
      ${kids.length
        ? `<span class="btwist${open ? ' open' : ''}" title="${t(open ? 'collapse' : 'expand')}"><i class="chev">▾</i>${cnt(kids.length)}</span>`
        : '<span class="btwist leaf"></span>'}
      <span class="bdot ${genderClass(p)}"></span>
      <span class="bname">${escapeHtml(fullName(p))}</span>
      <span class="bmeta">${escapeHtml(lifespan(p))}</span>
      <button class="binfo" title="${t('personCard')}">ⓘ</button>
      <button class="btree" title="${t('showInTree')}">🌳</button>
    </div>`;
    if (open) {
      const childGuides = depth ? [...guides, !isLast] : [];
      kids.forEach((c, i) => addRow(c, depth + 1, childGuides, i === kids.length - 1));
    }
  };
  addRow(root, 0, [], true);
  body.innerHTML = html;
}
// Expand every ancestor of `id`, re-render, then scroll its row into view.
// Married-in spouses have no outline row of their own — their place in the
// family IS their spouse's row, so fall back to it.
function revealInBrowse(id) {
  const rowTarget = () => $('#browseBody').querySelector(`[data-id="${CSS.escape(id)}"]`)
    || spousesOf(id).map((s) => $('#browseBody').querySelector(`[data-id="${CSS.escape(s)}"]`)).find(Boolean);
  if (browseTab === 'list') {
    const expandUp = (from) => {
      let cur = from;
      const seen = new Set();
      while (cur && !seen.has(cur)) { seen.add(cur); const par = parentsOf(cur)[0]; if (par) expandedRows.add(par); cur = par; }
    };
    expandUp(id);
    if (!parentsOf(id).length) for (const s of spousesOf(id)) { expandUp(s); const par = parentsOf(s)[0]; if (par) expandedRows.add(par); }
  }
  renderBrowse();
  const row = rowTarget();
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  }
}

// --- families (عائلات): one household per screen, tap a child to drill in ---
function renderFam(body) {
  if (!famId || !byId(famId)) famId = rootPersonId();
  const p = byId(famId);
  if (!p) { body.innerHTML = ''; return; }
  const pars = parentsOf(famId), spouses = spousesOf(famId);
  const kids = householdChildrenOf(famId); // the couple's children, whichever partner carries the links
  const cnt = (n) => (lang === 'ar' ? toAr(n) : String(n));
  const kidCard = (cid) => {
    const c = byId(cid);
    const n = childrenOf(cid).length;
    return `<div class="fam-kid ${genderClass(c)}" data-id="${escapeAttr(cid)}" data-drill="${escapeAttr(cid)}">
      <div class="fk-name">${escapeHtml(fullName(c))}</div>
      <div class="fk-meta">${escapeHtml(lifespan(c))}</div>
      <div class="fk-foot">
        ${n ? `<span class="bcount" title="${t('children')}">👨‍👩‍👧 ${cnt(n)}</span>` : '<span></span>'}
        <button class="binfo" title="${t('personCard')}">ⓘ</button>
      </div>
    </div>`;
  };
  body.innerHTML = `
    ${pars.length ? `<button class="fam-up" data-drill="${escapeAttr(pars[0])}">↑ ${t('upToParent')}: ${escapeHtml(cardName(byId(pars[0])))}</button>` : ''}
    <div class="fam-head" data-id="${escapeAttr(famId)}">
      <div class="avatar ${genderClass(p)}">${initials(p)}</div>
      <div style="min-width:0">
        <h3>${escapeHtml(fullName(p))}</h3>
        <div class="sub">${escapeHtml(lifespan(p) || field(p, 'occupation') || '')}</div>
      </div>
      <button class="btree" title="${t('showInTree')}">🌳</button>
    </div>
    ${spouses.length ? `<div class="fam-sp"><span class="bmeta">${t('spouse')}: </span>${spouses.map((s) => `<span class="chip" data-id="${escapeAttr(s)}">${escapeHtml(fullName(byId(s)))}</span>`).join('')}</div>` : ''}
    <h4 class="section-h">${t('children')}${kids.length ? ` (${cnt(kids.length)})` : ''}</h4>
    ${kids.length ? `<div class="fam-kids">${kids.map(kidCard).join('')}</div>` : `<p class="hint">${t('noChildren')}</p>`}`;
}
function famGo(id) {
  if (!byId(id)) return;
  famId = id;
  pushRecent(id);
  renderBrowse();
  scrollBrowseTop();
  updateBreadcrumbs();
  updateHash(id);
}

// --- directory (دليل): everyone, A–Z, with the father shown to tell the
// --- sixty-one أحمدs apart ---
function renderDir(body) {
  const coll = new Intl.Collator(lang === 'ar' ? 'ar' : 'en');
  const rows = data.people.map((p) => ({ p, name: fullName(p) })).sort((a, b) => coll.compare(a.name, b.name));
  const groups = new Map();
  for (const r of rows) {
    const L = norm(r.name).charAt(0) || '؟';
    if (!groups.has(L)) groups.set(L, []);
    groups.get(L).push(r);
  }
  const letters = [...groups.keys()];
  const fatherOf = (p) => {
    const f = parentsOf(p.id)[0];
    if (!f) return '';
    const rel = p.gender === 'female' ? t('daughterOf') : p.gender === 'male' ? t('sonOf') : t('childOf');
    return `${rel} ${escapeHtml(cardName(byId(f)))}`;
  };
  body.innerHTML =
    `<div class="dir-letters">${letters.map((l) => `<button data-letter="${escapeAttr(l)}">${escapeHtml(l)}</button>`).join('')}</div>` +
    letters.map((l) =>
      `<h4 class="dir-h" data-letter="${escapeAttr(l)}">${escapeHtml(l)}</h4>` +
      groups.get(l).map(({ p }) => `<div class="brow dir-row" data-id="${escapeAttr(p.id)}">
        <span class="bdot ${genderClass(p)}"></span>
        <span class="bname">${escapeHtml(fullName(p))}</span>
        <span class="bmeta">${fatherOf(p)}</span>
        <span class="bmeta">${escapeHtml(lifespan(p))}</span>
        <button class="btree" title="${t('showInTree')}">🌳</button>
      </div>`).join('')
    ).join('');
}

// Everything in the browse surface routes through one delegated handler.
function wireBrowse() {
  $('#browse').querySelectorAll('.browse-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      browseTab = b.getAttribute('data-tab');
      try { localStorage.setItem('familyTree.browseTab', browseTab); } catch {}
      renderBrowse();
      scrollBrowseTop();
      updateBreadcrumbs();
      updateHash();
    })
  );
  $('#browseBody').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.getAttribute('data-act') === 'expandAll') {
        const seen = new Set();
        const walk = (id) => {
          if (seen.has(id)) return;
          seen.add(id);
          const kids = childrenOf(id);
          if (kids.length) expandedRows.add(id);
          for (const c of kids) walk(c);
        };
        const root = rootPersonId(); if (root) walk(root);
      } else { expandedRows.clear(); const root = rootPersonId(); if (root) expandedRows.add(root); }
      renderBrowse();
      return;
    }
    const letter = e.target.closest('button[data-letter]');
    if (letter) {
      const h = $('#browseBody').querySelector(`.dir-h[data-letter="${CSS.escape(letter.getAttribute('data-letter'))}"]`);
      if (h) h.scrollIntoView({ block: 'start' });
      return;
    }
    const row = e.target.closest('[data-id]');
    if (e.target.closest('.btree') && row) { jumpToTree(row.getAttribute('data-id')); return; }
    if (e.target.closest('.binfo') && row) { openPerson(row.getAttribute('data-id')); return; }
    const drill = e.target.closest('[data-drill]');
    if (drill) { famGo(drill.getAttribute('data-drill')); return; }
    if (row) {
      const id = row.getAttribute('data-id');
      // Outline rows with children: tapping the row opens/closes the branch —
      // the thing everyone tries first. Person details live behind ⓘ.
      if (row.hasAttribute('data-kids')) {
        if (expandedRows.has(id)) expandedRows.delete(id); else expandedRows.add(id);
        renderBrowse();
      } else openPerson(id);
    }
  });
}
// Leave the browse surface and land on this person in the canvas.
function jumpToTree(id) {
  setSurface('tree');
  goTo(id);
}

function fit() {
  const { minX, minY, maxX, maxY } = layout.bbox;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const rect = stage.getBoundingClientRect();
  const pad = 70;
  const k = clampK(Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h, 1.3));
  view.k = k;
  view.x = (rect.width - w * k) / 2 - minX * k;
  // Center vertically when the tree is shorter than the viewport, else top-align.
  view.y = h * k < rect.height - pad * 2 ? (rect.height - h * k) / 2 - minY * k : pad - minY * k;
  applyTransform();
}

// Opening view: readable zoom centered on the root, NOT fit-to-all (which makes
// a big tree microscopic). "Fit" stays available for the overview.
function initialView() {
  const root = posById.get('n1') || [...layout.nodes].sort((a, b) => a.y - b.y)[0];
  if (!root) return fit();
  const rect = stage.getBoundingClientRect();
  // If the whole tree already fits comfortably at a readable scale, just fit it.
  const w = layout.bbox.maxX - layout.bbox.minX;
  if (w * 1 < rect.width - 140 && layout.nodes.length <= 14) return fit();
  view.k = 1;
  view.x = rect.width / 2 - (root.x + NODE_W / 2) * view.k;
  view.y = 90 - root.y * view.k;
  applyTransform();
}

let panned = false;
function wirePanZoom() {
  const pts = new Map(); // active pointers, for pinch
  let panning = false, sx = 0, sy = 0, ox = 0, oy = 0, pinchDist = 0;

  svg.addEventListener('pointerdown', (e) => {
    if (focusAnim) { cancelAnimationFrame(focusAnim); focusAnim = null; }
    refreshStageRect();
    pts.set(e.pointerId, e);
    if (pts.size === 1) {
      panning = true; panned = false;
      sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y;
      svg.classList.add('grabbing');
    } else {
      panning = false; // a second finger means pinch-zoom, not pan
    }
  });

  // Track moves/ups on window so a drag keeps working past the SVG edge.
  // We intentionally do NOT use setPointerCapture: capturing on the <svg>
  // retargets the follow-up `click` to the <svg>, which swallowed card clicks.
  window.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, e);
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchDist) {
        if (!stageRect) refreshStageRect();
        zoomAt((a.clientX + b.clientX) / 2 - stageRect.left, (a.clientY + b.clientY) / 2 - stageRect.top, dist / pinchDist);
      }
      pinchDist = dist;
      panned = true;
      return;
    }
    if (!panning) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) panned = true;
    if (panned) { view.x = ox + dx; view.y = oy + dy; scheduleTransform(); }
  });

  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchDist = 0;
    if (pts.size === 0) { panning = false; svg.classList.remove('grabbing'); }
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  svg.addEventListener('click', (e) => {
    if (e.target === svg || e.target.id === 'viewport') deselect();
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (focusAnim) { cancelAnimationFrame(focusAnim); focusAnim = null; }
    if (!stageRect) refreshStageRect();
    const factor = Math.exp(-e.deltaY * 0.0016);
    zoomAt(e.clientX - stageRect.left, e.clientY - stageRect.top, factor);
  }, { passive: false });

  window.addEventListener('resize', () => { refreshStageRect(); applyTransform(); });
}

// =====================================================================
// Selection + side panel
// =====================================================================
function deselect() {
  selectedId = null;
  panel.classList.remove('open');
  document.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
}

// Smoothly tween the view to (tx, ty, tk). Cancelled if the user pans/zooms.
function animateView(tx, ty, tk, ms = 480) {
  if (focusAnim) cancelAnimationFrame(focusAnim);
  const x0 = view.x, y0 = view.y, k0 = view.k;
  const dx = tx - x0, dy = ty - y0, dk = tk - k0;
  if (!dx && !dy && !dk) { focusAnim = null; return; }
  // Hidden/background tabs don't run requestAnimationFrame — just snap there.
  if (document.hidden) { view.x = tx; view.y = ty; view.k = tk; applyTransform(); focusAnim = null; return; }
  const t0 = performance.now();
  const ease = (u) => 1 - Math.pow(1 - u, 3); // easeOutCubic
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms), e = ease(u);
    view.x = x0 + dx * e; view.y = y0 + dy * e; view.k = k0 + dk * e;
    applyTransform();
    focusAnim = u < 1 ? requestAnimationFrame(step) : null;
  };
  focusAnim = requestAnimationFrame(step);
}

// The part of the stage NOT covered by the open side panel (RTL: panel overlays
// the inline-start = right edge; LTR: the left). Centering inside this rect
// keeps the person visible instead of hidden behind their own card panel.
function visibleRect() {
  refreshStageRect();
  const w = stageRect.width, h = stageRect.height;
  const pw = panel.classList.contains('open') && w > 700 ? Math.min(380, w * 0.92) : 0;
  const rtl = STRINGS[lang].dir === 'rtl';
  return { x0: rtl ? 0 : pw, w: w - pw, h };
}

// "Center" on a person — pan to them AND zoom to a readable level so the name
// is legible. Keeps the user's zoom if they're already closer in.
function focusOn(id) {
  const pos = posById.get(id);
  if (!pos) return;
  const vr = visibleRect();
  const k = clampK(Math.max(view.k, 1.15));
  const tx = vr.x0 + vr.w / 2 - (pos.x + NODE_W / 2) * k;
  const ty = vr.h / 2 - (pos.y + NODE_H / 2) * k;
  animateView(tx, ty, k);
}

// Frame a person's IMMEDIATE family — them + spouses + children — instead of
// centering one lonely card. This is the landing/navigation view in focus mode:
// zoomed to keep names readable, the focus card in the upper third so the
// children's generation shows below it.
function frameFocus(id) {
  const pos = posById.get(id);
  if (!pos) return;
  const group = [id, ...spousesOf(id), ...householdChildrenOf(id)].filter((x) => posById.has(x));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const gid of group) {
    const gp = posById.get(gid);
    minX = Math.min(minX, gp.x);
    maxX = Math.max(maxX, gp.x + NODE_W);
    minY = Math.min(minY, gp.y);
    maxY = Math.max(maxY, gp.y + NODE_H);
  }
  const vr = visibleRect();
  const pad = 36;
  const fitK = (vr.w - pad * 2) / Math.max(1, maxX - minX);
  const k = clampK(Math.min(1.15, Math.max(0.55, fitK)));
  // If the family row fits, center the row; if it's wider than the screen,
  // center on the focus card and let the row spill off both edges (the partial
  // cards at the edges are the hint that there's more to pan to).
  const cxWorld = fitK >= 0.55 ? (minX + maxX) / 2 : pos.x + NODE_W / 2;
  const tx = vr.x0 + vr.w / 2 - cxWorld * k;
  const ty = vr.h * 0.46 - ((minY + maxY) / 2) * k;
  animateView(tx, ty, k);
}

function openPerson(id) {
  const p = byId(id);
  if (!p) return;
  selectedId = id;
  document.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
  const card = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add('selected');

  const gc = genderClass(p);
  const avatarStyle = p.photo ? `style="background-image:url('${escapeAttr(p.photo)}')"` : '';
  const bioText = field(p, 'bio') || p.notes || '';

  const genderTxt = p.gender === 'male' ? t('genderMale') : p.gender === 'female' ? t('genderFemale') : t('genderUnknown');
  const personal = [];
  if (p.birth) personal.push([t('birth'), escapeHtml(locText(p.birth))]);
  if (p.death) personal.push([t('death'), escapeHtml(locText(p.death))]);
  if (field(p, 'occupation')) personal.push([t('occupation'), escapeHtml(field(p, 'occupation'))]);
  if (field(p, 'birthPlace')) personal.push([t('birthPlace'), escapeHtml(field(p, 'birthPlace'))]);
  if (field(p, 'livingIn')) personal.push([t('livingIn'), escapeHtml(field(p, 'livingIn'))]);
  if (p.gender) personal.push([t('gender'), genderTxt]);

  const contact = [];
  if (p.email) contact.push([t('email'), `<a href="mailto:${escapeAttr(p.email)}" dir="ltr">${escapeHtml(p.email)}</a>`]);
  if (p.phone) contact.push([t('phone'), `<a href="tel:${escapeAttr(p.phone.replace(/[^+\d]/g, ''))}" dir="ltr">${escapeHtml(p.phone)}</a>`]);
  if (p.address) contact.push([t('address'), escapeHtml(p.address)]);
  if (p.website) {
    const href = /^https?:\/\//i.test(p.website) ? p.website : 'https://' + p.website;
    contact.push([t('website'), `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" dir="ltr">${escapeHtml(p.website)}</a>`]);
  }

  // Values here are already escaped / safe HTML, so we don't re-escape them.
  const factList = (arr) =>
    `<ul class="facts">${arr.map(([k, v]) => `<li><span class="k">${k}</span><span class="v">${v}</span></li>`).join('')}</ul>`;
  const rel = (label, ids) =>
    ids.length
      ? `<h4>${label}</h4>${ids.map((rid) => `<span class="chip" data-goto="${escapeAttr(rid)}">${escapeHtml(fullName(byId(rid)))}</span>`).join('')}`
      : '';

  panel.innerHTML = `
    <header>
      <h2>${t('personCard')}</h2>
      <button class="close" data-action="close" title="${t('close')}">×</button>
    </header>
    <div class="body">
      <div class="person-head">
        <div class="avatar ${gc}" ${avatarStyle}>${p.photo ? '' : initials(p)}</div>
        <div class="meta">
          <h3>${escapeHtml(fullName(p))}</h3>
          <div class="sub">${escapeHtml(lifespan(p) || field(p, 'occupation') || '')}</div>
        </div>
      </div>
      ${personal.length ? factList(personal) : `<p class="hint">${t('noDetails')}</p>`}
      ${contact.length ? `<h4 class="section-h">${t('contact')}</h4>${factList(contact)}` : ''}
      ${bioText ? `<h4 class="section-h">${t('bio')}</h4><p class="bio-text">${escapeHtml(bioText)}</p>` : ''}
      <div class="relations">
        ${rel(t('parents'), parentsOf(id))}
        ${rel(t('spouse'), spousesOf(id))}
        ${rel(t('siblings'), siblingsOf(id))}
        ${rel(t('children'), householdChildrenOf(id))}
      </div>
      <div class="actions">
        <button data-action="focus">${t('center')}</button>
        <button data-action="share">🔗 ${t('shareLink')}</button>
        ${canEdit ? `<button data-action="edit" class="primary">${t('edit')}</button>` : ''}
      </div>
      ${canEdit ? `
      <div class="actions">
        <button data-action="add-child">${t('addChild')}</button>
        <button data-action="add-spouse">${t('addSpouse')}</button>
        <button data-action="add-parent">${t('addParent')}</button>
      </div>
      <div class="actions">
        <button data-action="relations">${t('editLinks')}</button>
      </div>
      <div class="actions">
        <button data-action="delete" class="danger">${t('deletePerson')}</button>
      </div>` : ''}
    </div>`;
  panel.classList.add('open');

  panel.querySelectorAll('[data-goto]').forEach((c) =>
    c.addEventListener('click', () => goTo(c.getAttribute('data-goto')))
  );
  panel.querySelector('[data-action="close"]').onclick = deselect;
  panel.querySelector('[data-action="focus"]').onclick = () => goTo(id);
  panel.querySelector('[data-action="share"]').onclick = async () => {
    const url = location.origin + location.pathname + '#p=' + encodeURIComponent(id);
    try { await navigator.clipboard.writeText(url); toast(t('linkCopied')); }
    catch { prompt(t('shareLink'), url); }
  };
  if (canEdit) {
    panel.querySelector('[data-action="edit"]').onclick = () => requireEdit(() => openForm('edit', p));
    panel.querySelector('[data-action="add-child"]').onclick = () => requireEdit(() => openForm('child', null, id));
    panel.querySelector('[data-action="add-spouse"]').onclick = () => requireEdit(() => openForm('spouse', null, id));
    panel.querySelector('[data-action="add-parent"]').onclick = () => requireEdit(() => openForm('parent', null, id));
    panel.querySelector('[data-action="relations"]').onclick = () => requireEdit(() => openRelations(id));
    panel.querySelector('[data-action="delete"]').onclick = () => requireEdit(() => removePerson(id));
  }
}

// ---- Relationship editor: fix/unlink/link EXISTING people ----
function openRelations(id) {
  const focus = byId(id);
  if (!focus) return;
  selectedId = id;

  const sectionHtml = (label, kind, ids) => {
    const chips = ids
      .map((rid) => `<span class="chip rel-chip" data-goto="${escapeAttr(rid)}">${escapeHtml(fullName(byId(rid)))}<button class="unlink" data-unlink="${escapeAttr(kind + '|' + rid)}" title="${t('unlink')}">×</button></span>`)
      .join('');
    const hint = { parent: t('linkParentHint'), spouse: t('linkSpouseHint'), child: t('linkChildHint') }[kind];
    return `<h4>${label}</h4>
      <div class="rel-chips">${chips || `<span class="hint">${t('none')}</span>`}</div>
      <div class="linker">
        <input class="link-input" data-link="${kind}" placeholder="${t('linkPlaceholder')}" title="${hint}" autocomplete="off" />
        <div class="link-results" hidden></div>
      </div>`;
  };

  panel.innerHTML = `
    <header>
      <h2>${t('relationships')}</h2>
      <button class="close" data-action="back" title="${t('close')}">×</button>
    </header>
    <div class="body">
      <p class="hint">${escapeHtml(fullName(focus))}</p>
      ${sectionHtml(t('parents'), 'parent', parentsOf(id))}
      ${sectionHtml(t('spouse'), 'spouse', spousesOf(id))}
      ${sectionHtml(t('children'), 'child', childrenOf(id))}
      <div class="actions"><button data-action="back" class="primary">${t('done')}</button></div>
    </div>`;
  panel.classList.add('open');

  const back = () => openPerson(id);
  panel.querySelectorAll('[data-action="back"]').forEach((b) => (b.onclick = back));
  // navigate to a linked person (chip body)
  panel.querySelectorAll('.rel-chip[data-goto]').forEach((c) =>
    c.addEventListener('click', (e) => { if (e.target.closest('.unlink')) return; goTo(c.getAttribute('data-goto')); })
  );
  // unlink
  panel.querySelectorAll('[data-unlink]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const [kind, rid] = b.getAttribute('data-unlink').split('|');
      if (kind === 'parent') unlinkParent(rid, id);
      else if (kind === 'child') unlinkParent(id, rid);
      else if (kind === 'spouse') unlinkSpouse(id, rid);
      persist(t('unlinked'));
      openRelations(id);
    })
  );
  // link an existing person
  panel.querySelectorAll('.link-input').forEach((input) => {
    const kind = input.getAttribute('data-link');
    const box = input.nextElementSibling;
    const exclude = () => [id, ...parentsOf(id), ...spousesOf(id), ...childrenOf(id)];
    const close = () => { box.hidden = true; box.innerHTML = ''; };
    input.addEventListener('input', () => {
      const res = searchPeople(input.value, exclude());
      if (!res.length) return close();
      box.innerHTML = res
        .map((r) => `<div class="item" data-pick="${escapeAttr(r.id)}"><span>${escapeHtml(fullName(r))}</span><small>${escapeHtml(lifespan(r))}</small></div>`)
        .join('');
      box.hidden = false;
      box.querySelectorAll('[data-pick]').forEach((it) =>
        it.addEventListener('click', () => {
          const pid = it.getAttribute('data-pick');
          if (kind === 'parent') {
            if (isAncestorOf(id, pid)) return toast(t('cycleErr'));
            addParent(pid, id);
          } else if (kind === 'child') {
            if (isAncestorOf(pid, id)) return toast(t('cycleErr'));
            addParent(id, pid);
          } else if (kind === 'spouse') {
            addSpouse(id, pid);
          }
          persist(t('linked'));
          openRelations(id);
        })
      );
    });
    input.addEventListener('blur', () => setTimeout(close, 180));
  });
}

// =====================================================================
// Forms (add / edit)
// =====================================================================
// mode: 'new' | 'edit' | 'child' | 'spouse' | 'parent'
// For relation modes, `relTo` is the id we're attaching to.
function openForm(mode, person, relTo) {
  const p = person || { firstName: '', lastName: '', gender: '', birth: '', death: '', birthPlace: '', photo: '', occupation: '', livingIn: '', email: '', phone: '', address: '', website: '', bio: '' };
  const titles = { new: t('formNew'), edit: t('formEdit'), child: t('formChild'), spouse: t('formSpouse'), parent: t('formParent') };
  let context = '';
  if (relTo) {
    const rp = fullName(byId(relTo));
    context = { child: t('ctxChild')(rp), spouse: t('ctxSpouse')(rp), parent: t('ctxParent')(rp) }[mode];
  }

  panel.innerHTML = `
    <header>
      <h2>${titles[mode]}</h2>
      <button class="close" data-action="cancel" title="${t('close')}">×</button>
    </header>
    <div class="body">
      ${context ? `<p class="hint">${escapeHtml(context)}</p>` : ''}
      <form id="personForm">
        <div class="field"><label>${t('fullName')}</label><input name="firstName" value="${escapeAttr(p.firstName)}" autofocus /></div>
        <div class="field">
          <label>${t('gender')}</label>
          <select name="gender">
            <option value="" ${!p.gender ? 'selected' : ''}>—</option>
            <option value="male" ${p.gender === 'male' ? 'selected' : ''}>${t('genderMale')}</option>
            <option value="female" ${p.gender === 'female' ? 'selected' : ''}>${t('genderFemale')}</option>
            <option value="other" ${p.gender === 'other' ? 'selected' : ''}>${t('genderUnknown')}</option>
          </select>
        </div>
        <div class="field-row">
          <div class="field"><label>${t('birth')}</label><input name="birth" value="${escapeAttr(p.birth)}" placeholder="${t('phBirth')}" /></div>
          <div class="field"><label>${t('death')}</label><input name="death" value="${escapeAttr(p.death)}" placeholder="${t('phDied')}" /></div>
        </div>
        <div class="field"><label>${t('birthPlace')}</label><input name="birthPlace" value="${escapeAttr(p.birthPlace)}" /></div>
        <div class="field"><label>${t('photo')}</label><input name="photo" value="${escapeAttr(p.photo)}" placeholder="https://…" dir="ltr" /></div>

        <div class="form-section">${t('secPersonal')}</div>
        <div class="field"><label>${t('occupation')}</label><input name="occupation" value="${escapeAttr(p.occupation)}" placeholder="${t('phOccupation')}" /></div>
        <div class="field"><label>${t('livingIn')}</label><input name="livingIn" value="${escapeAttr(p.livingIn)}" placeholder="${t('phLiving')}" /></div>

        <div class="form-section">${t('secContact')}</div>
        <div class="field-row">
          <div class="field"><label>${t('email')}</label><input name="email" type="email" value="${escapeAttr(p.email)}" dir="ltr" /></div>
          <div class="field"><label>${t('phone')}</label><input name="phone" value="${escapeAttr(p.phone)}" dir="ltr" /></div>
        </div>
        <div class="field"><label>${t('address')}</label><input name="address" value="${escapeAttr(p.address)}" /></div>
        <div class="field"><label>${t('socialWebsite')}</label><input name="website" value="${escapeAttr(p.website)}" placeholder="https://…" dir="ltr" /></div>

        <div class="form-section">${t('secBio')}</div>
        <div class="field"><label>${t('biography')}</label><textarea name="bio" placeholder="${t('phBio')}">${escapeHtml(p.bio || p.notes || '')}</textarea></div>
        <div class="form-actions">
          <button type="button" data-action="cancel">${t('cancel')}</button>
          <button type="submit" class="primary">${t('save')}</button>
        </div>
      </form>
    </div>`;
  panel.classList.add('open');

  const cancel = () => (selectedId && byId(selectedId) ? openPerson(selectedId) : deselect());
  panel.querySelectorAll('[data-action="cancel"]').forEach((b) => (b.onclick = cancel));

  panel.querySelector('#personForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const fields = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v).trim()]));

    if (mode === 'edit') {
      Object.assign(byId(p.id), fields);
      persist(t('saved'));
      openPerson(p.id);
      return;
    }
    const id = newId();
    data.people.push({ id, ...fields });
    if (mode === 'child') {
      addParent(relTo, id);
      for (const sp of spousesOf(relTo)) addParent(sp, id);
    } else if (mode === 'spouse') {
      addSpouse(relTo, id);
    } else if (mode === 'parent') {
      addParent(id, relTo);
    }
    persist(t('added')(fullName(fields) || ''));
    openPerson(id);
    focusOn(id);
  });
}

// =====================================================================
// Mutations
// =====================================================================
function addSpouse(a, b) {
  if (!data.relationships.some((r) => r.type === 'spouse' && ((r.a === a && r.b === b) || (r.a === b && r.b === a))))
    data.relationships.push({ type: 'spouse', a, b });
}
function addParent(parent, child) {
  if (parent === child) return;
  if (!data.relationships.some((r) => r.type === 'parent' && r.parent === parent && r.child === child))
    data.relationships.push({ type: 'parent', parent, child });
}
function unlinkParent(parent, child) {
  data.relationships = data.relationships.filter((r) => !(r.type === 'parent' && r.parent === parent && r.child === child));
}
function unlinkSpouse(a, b) {
  data.relationships = data.relationships.filter(
    (r) => !(r.type === 'spouse' && ((r.a === a && r.b === b) || (r.a === b && r.b === a)))
  );
}
// is aId an ancestor of bId? (used to prevent creating loops)
function isAncestorOf(aId, bId) {
  const stack = parentsOf(bId).slice();
  const seen = new Set();
  while (stack.length) {
    const x = stack.pop();
    if (x === aId) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...parentsOf(x));
  }
  return false;
}
// Normalize Arabic for matching so phone-typed queries find people:
// unify hamza/alef forms (أإآٱ→ا), ى→ي, ة→ه, ؤ→و, ئ→ي, strip tashkeel/tatweel.
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}
// people matching a query in either script, excluding given ids
function searchPeople(q, exclude) {
  q = norm(q.trim());
  if (!q) return [];
  const ex = new Set(exclude || []);
  return data.people
    .filter((p) => !ex.has(p.id))
    .filter((p) => norm(`${p.firstName || ''} ${p.lastName || ''} ${(p.en && p.en.firstName) || ''}`).includes(q))
    .slice(0, 8);
}
function removePerson(id) {
  const p = byId(id);
  if (!p) return;
  if (!confirm(t('deleteConfirm')(fullName(p)))) return;
  data.people = data.people.filter((x) => x.id !== id);
  data.relationships = data.relationships.filter(
    (r) => r.a !== id && r.b !== id && r.parent !== id && r.child !== id
  );
  deselect();
  persist(t('deleted')(fullName(p)));
}

async function persist(message) {
  render();
  try {
    await saveData(data);
    if (message) toast(message);
  } catch (e) {
    console.error(e);
    // 401/403 = session ended or rights lost; 409 = someone else saved first —
    // reload rather than silently overwrite their edit.
    if (e && (e.status === 401 || e.status === 403)) { toast(t('sessionEnded')); setTimeout(() => location.reload(), 1500); }
    else if (e && e.status === 409) { toast(t('treeConflict')); setTimeout(() => location.reload(), 1800); }
    else toast(t('saveFailed'));
  }
}

// =====================================================================
// Toolbar, search, keyboard
// =====================================================================
function wireToolbar() {
  $('#btnAdd').onclick = () => requireEdit(() => openForm('new'));
  const addEmpty = $('#btnAddEmpty');
  if (addEmpty) addEmpty.onclick = () => requireEdit(() => openForm('new'));
  $('#btnFit').onclick = fit;
  $('#btnFit2').onclick = fit;
  const bh = $('#btnHome'); if (bh) bh.onclick = goHome;
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) => {
    b.onclick = () => {
      const v = b.getAttribute('data-view');
      if (v === 'browse') setSurface('browse');
      else { if (surface !== 'tree') setSurface('tree'); setMode(v); }
    };
  });
  $('#btnZoomIn').onclick = () => zoomAt(centerX(), centerY(), 1.2);
  $('#btnZoomOut').onclick = () => zoomAt(centerX(), centerY(), 1 / 1.2);
  $('#btnExport').onclick = exportJson;          // admin-only backup download
  $('#btnHelp').onclick = () => $('#helpDialog').showModal();
  const ba = $('#btnAdmin'); if (ba) ba.onclick = openAdmin;
  const bo = $('#btnLogout'); if (bo) bo.onclick = () => Auth.logout();
  $('#btnHelpClose').onclick = () => $('#helpDialog').close();
  // Mobile "⋯" — the secondary tools live in a dropdown there.
  const more = $('#btnMore');
  if (more) {
    const tb = more.closest('.toolbar');
    more.onclick = (e) => { e.stopPropagation(); tb.classList.toggle('more-open'); };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.toolbar')) tb.classList.remove('more-open');
    });
    $('#moreGroup').addEventListener('click', () => tb.classList.remove('more-open'));
  }
  $('#btnLang').onclick = () => {
    lang = lang === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('familyTree.lang', lang); } catch {}
    applyLang();
  };
}
const centerX = () => { if (!stageRect) refreshStageRect(); return stageRect.width / 2; };
const centerY = () => { if (!stageRect) refreshStageRect(); return stageRect.height / 2; };

function exportJson() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'family.json';
  a.click();
  URL.revokeObjectURL(url);
  toast(t('downloaded'));
}

// =====================================================================
// Admin: family member accounts (approve / role / remove)
// =====================================================================
async function openAdmin() {
  if (!canEdit) return;
  selectedId = null;
  panel.innerHTML = `
    <header>
      <h2>${t('adminTitle')}</h2>
      <button class="close" data-action="close" title="${t('close')}">×</button>
    </header>
    <div class="body"><p class="hint">${t('adminLoading')}</p></div>`;
  panel.classList.add('open');
  panel.querySelector('[data-action="close"]').onclick = deselect;

  const { ok, data: d } = await Auth.listUsers();
  const body = panel.querySelector('.body');
  if (!ok) { body.innerHTML = `<p class="hint">${t('adminError')}</p>`; return; }
  const list = d.users || [];
  const pending = list.filter((u) => !u.approved);
  const active = list.filter((u) => u.approved);

  const card = (u) => {
    const isMe = me && u.username === me.username;
    return `<div class="user-row" data-u="${escapeAttr(u.username)}">
      <div class="user-meta">
        <span class="user-name">${escapeHtml(u.displayName || u.username)}${isMe ? ` <small>(${t('you')})</small>` : ''}</span>
        <span class="user-sub" dir="ltr">@${escapeHtml(u.username)} · <b class="role-${u.role}">${u.role === 'admin' ? t('roleAdmin') : t('roleViewer')}</b></span>
      </div>
      <div class="user-acts">
        ${!u.approved ? `<button class="primary" data-act="approve">${t('approve')}</button>` : ''}
        ${u.approved && !isMe && u.role !== 'admin' ? `<button data-act="makeAdmin">${t('makeAdmin')}</button>` : ''}
        ${u.approved && !isMe && u.role === 'admin' ? `<button data-act="makeViewer">${t('makeViewer')}</button>` : ''}
        ${!isMe ? `<button class="danger" data-act="remove" title="${t('removeUser')}">🗑</button>` : ''}
      </div>
    </div>`;
  };

  body.innerHTML = `
    ${pending.length ? `<h4 class="section-h">${t('pendingApproval')} (${pending.length})</h4><div class="user-list pending">${pending.map(card).join('')}</div>` : ''}
    <h4 class="section-h">${t('members')} (${active.length})</h4>
    <div class="user-list">${active.map(card).join('') || `<p class="hint">${t('none')}</p>`}</div>`;

  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const u = btn.closest('[data-u]').getAttribute('data-u');
      const act = btn.getAttribute('data-act');
      btn.disabled = true;
      let r;
      if (act === 'approve') r = await Auth.approve(u);
      else if (act === 'makeAdmin') r = await Auth.setRole(u, 'admin');
      else if (act === 'makeViewer') r = await Auth.setRole(u, 'viewer');
      else if (act === 'remove') { if (!confirm(t('removeConfirm')(u))) { btn.disabled = false; return; } r = await Auth.remove(u); }
      if (r && r.ok) { toast(t('saved')); openAdmin(); }
      else { toast(t('adminError')); btn.disabled = false; }
    };
  });
}

function wireSearch() {
  const input = $('#searchInput');
  const results = $('#searchResults');
  let active = -1;
  let matches = [];

  const close = () => { results.hidden = true; active = -1; };
  const run = () => {
    const q = norm(input.value.trim());
    if (!q) return close();
    matches = data.people
      .filter((p) => {
        const hay = norm(`${p.firstName || ''} ${p.lastName || ''} ${(p.en && p.en.firstName) || ''} ${p.birthPlace || ''}`);
        return hay.includes(q);
      })
      .slice(0, 8);
    if (!matches.length) { results.innerHTML = `<div class="item"><span>${t('noMatches')}</span></div>`; results.hidden = false; return; }
    results.innerHTML = matches
      .map((p, i) => `<div class="item${i === active ? ' active' : ''}" data-id="${escapeAttr(p.id)}"><span>${escapeHtml(fullName(p))}</span><small>${escapeHtml(lifespan(p))}</small></div>`)
      .join('');
    results.hidden = false;
    results.querySelectorAll('.item[data-id]').forEach((it) =>
      it.addEventListener('click', () => { pick(it.getAttribute('data-id')); })
    );
  };
  const pick = (id) => { close(); input.value = ''; goTo(id); };

  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  input.addEventListener('keydown', (e) => {
    if (results.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); run(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); run(); e.preventDefault(); }
    else if (e.key === 'Enter' && matches[active]) { pick(matches[active].id); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) close(); });
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
    const k = e.key;
    if (k === 'Escape') { deselect(); $('#helpDialog').open && $('#helpDialog').close(); return; }
    if (k === 'Home') { goHome(); e.preventDefault(); return; } // works everywhere (leaves browse)
    if (surface !== 'tree') return; // zoom/fit/arrow shortcuts drive the canvas only
    if (k === '+' || k === '=') { zoomAt(centerX(), centerY(), 1.2); return; }
    if (k === '-' || k === '_') { zoomAt(centerX(), centerY(), 1 / 1.2); return; }
    if (k === 'f' || k === 'F') { fit(); return; }
    // Relative navigation with the arrow keys (needs a selected person).
    if (!selectedId || !byId(selectedId)) return;
    let target = null;
    if (k === 'ArrowUp') target = parentsOf(selectedId)[0];
    else if (k === 'ArrowDown') target = householdChildrenOf(selectedId)[0];
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const par = parentsOf(selectedId)[0];
      const sibs = par ? childrenOf(par) : [];
      const i = sibs.indexOf(selectedId);
      if (i >= 0) target = sibs[k === 'ArrowLeft' ? i + 1 : i - 1]; // RTL: → toward eldest
    } else return;
    if (target && byId(target)) { goTo(target); }
    e.preventDefault();
  });
}

// =====================================================================
// Misc utilities
// =====================================================================
// Editing is role-gated now (server-enforced too). Viewers never see the edit
// buttons; this is the belt-and-braces guard for anything that slips through.
function requireEdit(fn) {
  if (canEdit) return fn();
  toast(t('viewOnly'));
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function el(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}
function text(cls, x, y, content) {
  const t = el('text', { class: cls, x, y });
  t.textContent = content;
  return t;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
