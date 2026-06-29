# 🌳 Family Tree

A simple, self-hosted family tree website. Your family's data lives in one
plain **`family.json`** file (easy to read, edit, back up, and share). The page
is pure HTML/CSS/JavaScript — **no build step, no framework, no dependencies** —
so it runs anywhere you can serve a folder of files, including your TrueNAS box.

- **View** a clean, interactive tree — drag to pan, scroll/pinch to zoom.
- **Edit** in the browser — add people and link parents, spouses and children.
- **Share** by sending the `family.json` file, or by hosting the site for the
  whole family. Optionally use **Supabase** so everyone edits one live tree.

![Local mode badge](https://img.shields.io/badge/data-family.json-117c6f) ![No build](https://img.shields.io/badge/build-none-blue)

---

## Quick start (try it on your computer)

You need [Node.js](https://nodejs.org) installed (any recent version).

```bash
cd FamilyTree
npm start          # serves at http://localhost:8080
```

Or pick any port: `node serve.js 9000`. Then open the URL in your browser.

> **Why a server and not just double-clicking `index.html`?**
> The app loads `family.json` and uses JavaScript modules, which browsers block
> when you open a file directly (`file://`). Any static server fixes this —
> `npm start`, `python3 -m http.server`, VS Code Live Server, nginx, etc.
> (If you *do* double-click it, it still loads with built-in sample data and
> saves your edits in that browser — you just can't read/write `family.json`.)

---

## Using the app

| Action | How |
| --- | --- |
| Add the first people | **+ Person** (top right) |
| Add a relative | Click a person → **+ Child / + Spouse / + Parent** |
| Edit or delete | Click a person → **Edit** / **Delete person** |
| Find someone | Type in the **Search** box |
| Move around | Drag to pan · scroll or pinch to zoom · **Fit** to recenter |
| Save a shareable copy | **Export** → downloads `family.json` |
| Load a file | **Import** → choose a `family.json` |

Keyboard: <kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>f</kbd> fit · <kbd>Esc</kbd> close panels.

### How sharing works (local mode — the default)

In local mode, your edits are saved in **your browser**. To share the tree:

1. Click **Export** to download an updated `family.json`.
2. Replace the `family.json` in the website folder with that file (and/or send
   it to family members, who can **Import** it).

This is great for a tree that one or two people maintain. If you want the whole
family to edit the **same live tree**, set up shared mode below.

---

## 🏠 Deploy on TrueNAS (or any Docker host)

TrueNAS SCALE can run this as a **Custom App** (Docker Compose). Two options:

### Option A — bind-mount the folder (simplest, easiest to update)

1. Copy this whole project into a dataset, e.g. `/mnt/tank/apps/familytree`
   (via an SMB share, `git clone`, or the file manager).
2. Edit [`docker-compose.yml`](docker-compose.yml) and set the path on the left
   side of the `volumes:` lines to that dataset path.
3. TrueNAS SCALE → **Apps → Discover Apps → Custom App** (or *Install via YAML*)
   → paste the compose file → deploy.
4. Open **`http://<truenas-ip>:8088`**.

To update the site later, just edit the files in that dataset — no rebuild.

### Option B — build a self-contained image

```bash
docker build -t familytree .
docker run -d -p 8088:80 --restart unless-stopped --name familytree familytree
```

(or set `build: .` in the compose file instead of `image:` + `volumes:`).

### Plain Docker / other NAS

Anything that serves static files works. Quick test with nginx:

```bash
docker run -d -p 8088:80 -v "$PWD":/usr/share/nginx/html:ro nginx:alpine
```

> **Tip:** to reach it by name on your home network, give it a hostname in your
> router/DNS, or use TrueNAS reverse-proxy / Tailscale for remote family access.

---

## 👨‍👩‍👧‍👦 Shared mode (optional) — one live tree for the whole family

By default the tree is local to each browser. Supabase (free tier is plenty)
lets everyone read and edit **one shared tree**, with live updates. Supabase can
be the hosted cloud service **or self-hosted on your TrueNAS** — either works.

1. Create a project at [supabase.com](https://supabase.com) (or self-host).
2. In **SQL Editor**, run the contents of [`supabase/schema.sql`](supabase/schema.sql).
3. In **Project Settings → API**, copy the **Project URL** and the **anon public** key.
4. Open [`js/config.js`](js/config.js) and fill them in:

   ```js
   supabase: {
     url: 'https://YOURPROJECT.supabase.co',
     anonKey: 'eyJ...your anon key...',
     table: 'family_documents',
     docId: 'main',
   },
   ```
5. Reload. The badge in the header switches to **Shared**. Edits now save to
   Supabase and sync live to everyone viewing the page.

The first load seeds the shared tree from `family.json`, so you keep your
starting data.

> **Security note:** the included policies let anyone with the anon key read and
> write — fine for a private tree on your home network. If you expose the site
> publicly, switch to authenticated-only policies and turn on Supabase Auth.

There's also a light **edit password** option in `js/config.js` (`editPassword`)
that prompts before any edit — a small deterrent, not real security.

---

## The data format

`family.json` is intentionally simple. People are a flat list; relationships
connect them by `id`:

```json
{
  "title": "The Hefny Family",
  "people": [
    { "id": "m3", "firstName": "Marwan", "lastName": "Hefny",
      "gender": "male", "birth": "1986", "death": "",
      "birthPlace": "Cairo, Egypt", "occupation": "Software Engineer",
      "livingIn": "Dubai, UAE", "email": "marwan@example.com",
      "phone": "+20 100 000 0000", "website": "example.com",
      "bio": "Loves building things.", "photo": "" }
  ],
  "relationships": [
    { "type": "spouse", "a": "m3", "b": "s4" },
    { "type": "parent", "parent": "m3", "child": "k3" }
  ]
}
```

- **`people[]`** — `id` (any unique string) is required; every other field is optional:
  - **Basics:** `firstName`, `lastName`, `gender` (`male`/`female`/`other`),
    `birth`, `death` (free text — `"1986"`, `"1986-04-02"`, `"c. 1900"` all work),
    `birthPlace`, `photo` (image URL).
  - **Personal:** `occupation`, `livingIn` (current city/country).
  - **Contact:** `email`, `phone`, `address`, `website` (shown as clickable links).
  - **Bio:** `bio` (a free-text life story). *(Older files may use `notes`; it still
    displays, and is migrated to `bio` when you next edit that person.)*
- **`relationships[]`** — `spouse` links two partners; `parent` links one parent
  to one child. A child of a couple simply has two `parent` rows (one per parent),
  which the editor adds for you automatically.

You can hand-edit this file in any text editor, or let the in-app editor manage
it and use **Export**. (We chose JSON over YAML because browsers parse it
natively with zero extra code — but it's still perfectly human-readable.)

---

## Project layout

```
FamilyTree/
├── index.html          # the page
├── family.json         # ← your family's data (edit / replace this)
├── css/style.css       # styling (light + dark)
├── js/
│   ├── app.js          # UI: rendering, navigation, editing
│   ├── layout.js       # tree geometry (pure, no DOM)
│   ├── store.js        # load/save (local file or Supabase)
│   ├── config.js       # ← settings: Supabase, title, edit password
│   └── seed.js         # sample data fallback for file:// use
├── serve.js            # tiny local dev server (npm start)
├── Dockerfile          # build a static nginx image
├── docker-compose.yml  # TrueNAS / Docker deployment
├── nginx.conf          # nginx config used by the image
└── supabase/schema.sql # optional shared-mode setup
```

## FAQ

**My photos don't show.** `photo` must be a URL the browser can load (e.g. an
image hosted somewhere, or a `data:` URL). Local file paths won't work unless
the file is served by the site.

**I edited `family.json` but the site shows old data.** In local mode your
browser remembers your edits and shows those instead of the file. Use the
in-app **Import**, or clear the site's storage, to load the file fresh.
(Shared/Supabase mode always shows the live shared data.)

**Can I have multiple separate trees?** Yes — run another copy of the folder
(different port), or in shared mode give each its own `docId` in `config.js`.

---

Made to be simple enough to fork and tweak. Replace the sample Hefny family with
your own and you're off. 🌳
