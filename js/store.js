// store.js — load/save the family tree via the server backend (server.js).
// The tree is shared and durable server-side; edits by an admin are persisted
// for everyone. (Legacy Supabase support is kept for anyone who configures it.)
import { CONFIG, isShared } from './config.js';
import { SEED } from './seed.js';

let _client = null;
async function client() {
  if (_client) return _client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  _client = createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey);
  return _client;
}

export function getMode() {
  return isShared() ? 'shared' : 'server';
}

function normalize(data) {
  return {
    title: (data && data.title) || 'Our Family Tree',
    title_en: (data && data.title_en) || '',
    people: Array.isArray(data && data.people) ? data.people : [],
    relationships: Array.isArray(data && data.relationships) ? data.relationships : [],
  };
}

export async function loadData() {
  if (isShared()) {
    try {
      const sb = await client();
      const { data, error } = await sb
        .from(CONFIG.supabase.table)
        .select('data')
        .eq('id', CONFIG.supabase.docId)
        .maybeSingle();
      if (error) throw error;
      if (data && data.data) return normalize(data.data);
      const seeded = normalize(structuredClone(SEED));
      await saveData(seeded);
      return seeded;
    } catch (e) {
      console.warn('Supabase load failed; using seed instead:', e);
      return normalize(structuredClone(SEED));
    }
  }
  // Server mode: the tree comes from the authenticated backend. Remember the
  // server's updatedAt so saves can detect a concurrent edit (409 = stale).
  const res = await fetch('/api/tree', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('tree_load_' + res.status);
  const raw = await res.json();
  baseUpdatedAt = raw.updatedAt || null;
  return normalize(raw);
}

let baseUpdatedAt = null; // updatedAt of the copy this browser is editing on top of

export async function saveData(data) {
  const clean = normalize(data);
  if (isShared()) {
    const sb = await client();
    const { error } = await sb
      .from(CONFIG.supabase.table)
      .upsert({ id: CONFIG.supabase.docId, data: clean, updated_at: new Date().toISOString() });
    if (error) throw error;
    return;
  }
  const res = await fetch('/api/tree', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...clean, baseUpdatedAt }),
  });
  if (!res.ok) {
    const err = new Error('tree_save_' + res.status);
    err.status = res.status; // 409 = someone else saved first (stale baseline)
    throw err;
  }
  try { baseUpdatedAt = (await res.json()).updatedAt || baseUpdatedAt; } catch {}
}

// Kept for API compatibility with app.js; no per-browser cache in server mode.
export function resetLocal() {}

// Shared (Supabase) mode: live updates from other members. No-op in server mode
// (a light poll could be added later if desired).
export async function subscribe(onChange) {
  if (!isShared()) return () => {};
  try {
    const sb = await client();
    const ch = sb
      .channel('family-doc')
      .on('postgres_changes', { event: '*', schema: 'public', table: CONFIG.supabase.table, filter: `id=eq.${CONFIG.supabase.docId}` },
        (payload) => { if (payload.new && payload.new.data) onChange(normalize(payload.new.data)); })
      .subscribe();
    return () => sb.removeChannel(ch);
  } catch (e) {
    console.warn('Realtime subscribe failed:', e);
    return () => {};
  }
}
