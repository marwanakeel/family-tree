// config.js — edit this file to change how the app stores data.
//
// LOCAL MODE (default): leave `supabase.url` empty. The tree loads from
// family.json and your edits are saved in this browser. Use "Export" to
// download an updated family.json you can share or commit.
//
// SHARED MODE (optional): fill in your Supabase project URL + anon key to let
// the whole family read and edit one shared tree live. See README.md and
// supabase/schema.sql for the 2-minute setup.

export const CONFIG = {
  // Shown in the header. Override the title stored in the data file.
  appTitle: '',

  supabase: {
    url: '', // e.g. 'https://xxxxxxxx.supabase.co'  (leave empty for local mode)
    anonKey: '', // the project's public anon key
    table: 'family_documents',
    docId: 'main', // which row holds this family's tree
  },

  // Require a password before anyone can edit (add/edit/delete/relink). Viewing
  // stays open. CLIENT-SIDE deterrent only (readable here) — NOT real security.
  // Set your own value for a deployment; left empty here so the public repo ships
  // no password. (Editing in a static deploy only affects the editor's browser.)
  editPassword: '',
};

export const isShared = () => Boolean(CONFIG.supabase.url && CONFIG.supabase.anonKey);
