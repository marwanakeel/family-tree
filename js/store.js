// store.js — load/save the family data. Local-first, optional Supabase.
import { CONFIG, isShared } from './config.js';
import { SEED } from './seed.js';

const LS_KEY = 'familyTree.data.v1';
const VER_KEY = 'familyTree.data.ver';
// Bump this whenever the shipped family.json changes materially. A cached copy
// from an older version is treated as stale and the file is reloaded instead,
// so structural corrections aren't hidden behind a browser's saved snapshot.
const DATA_VERSION = '2026-07-04-fixes2';

let _client = null;
async function client() {
  if (_client) return _client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  _client = createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey);
  return _client;
}

export function getMode() {
  return isShared() ? 'shared' : 'local';
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
      // No row yet: seed it from family.json so the family starts with content.
      const seeded = await loadLocalSource();
      await saveData(seeded);
      return seeded;
    } catch (e) {
      console.warn('Supabase load failed; using local source instead:', e);
    }
  }
  // Local mode: prefer this browser's saved edits — but only if they're from the
  // current data version. An older/absent stamp means we shipped a corrected
  // family.json, so reload the file instead of showing the stale cached copy.
  const local = localStorage.getItem(LS_KEY);
  const ver = localStorage.getItem(VER_KEY);
  if (local && ver === DATA_VERSION) {
    try {
      return normalize(JSON.parse(local));
    } catch {
      /* fall through */
    }
  }
  const fresh = await loadLocalSource();
  try { localStorage.removeItem(LS_KEY); localStorage.setItem(VER_KEY, DATA_VERSION); } catch {}
  return fresh;
}

async function loadLocalSource() {
  try {
    const res = await fetch('family.json', { cache: 'no-store' });
    if (res.ok) return normalize(await res.json());
  } catch {
    /* file:// or missing — use the embedded seed */
  }
  return normalize(structuredClone(SEED));
}

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
  localStorage.setItem(LS_KEY, JSON.stringify(clean));
  try { localStorage.setItem(VER_KEY, DATA_VERSION); } catch {}
}

// Local mode only: forget this browser's edits and reload family.json.
export function resetLocal() {
  localStorage.removeItem(LS_KEY);
}

// Shared mode: call onChange whenever another family member saves. Returns an
// unsubscribe function. No-op in local mode.
export async function subscribe(onChange) {
  if (!isShared()) return () => {};
  try {
    const sb = await client();
    const ch = sb
      .channel('family-doc')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: CONFIG.supabase.table,
          filter: `id=eq.${CONFIG.supabase.docId}`,
        },
        (payload) => {
          if (payload.new && payload.new.data) onChange(normalize(payload.new.data));
        }
      )
      .subscribe();
    return () => sb.removeChannel(ch);
  } catch (e) {
    console.warn('Realtime subscribe failed:', e);
    return () => {};
  }
}
