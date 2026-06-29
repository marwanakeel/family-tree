# Deploy the Family Tree on TrueNAS k3s → family.l3tz.com

Serves the static site from the TrueNAS **k3s** cluster, exposed at
`https://family.l3tz.com` by **reusing the cluster's existing cloudflared tunnel**
(same pattern as the dfsa project, minus the database/LLM/auth).

```
Browser ─HTTPS→ Cloudflare ─existing tunnel→ cloudflared ─→ <nodeIP>:30086 (familytree)
 family.l3tz.com
```

**Privacy by design:** the Docker image is the **app shell only** — it contains
no family data. `family.json` lives on the node and is mounted in, so personal
data is never pushed to the (public) registry. Updating the tree = replace that
one file; nginx serves it live, no rebuild.

> ⚠️ Run every `kubectl` on the TrueNAS as `k3s kubectl ...` (not the Mac kubeconfig).

## Files
| File | Resource |
|---|---|
| `00-namespace.yaml` | `familytree` namespace |
| `20-app.yaml` | Deployment + Service (NodePort **30086**); mounts `family.json` from the node |
| `deploy.sh` | one-paste deployer for the TrueNAS Shell |

---

## 1 — Build & push the image (from the Mac)
The TrueNAS node is `linux/amd64`; the Mac is arm64, so build for amd64. The
image has **no family data**, so it's safe as a public repo:
```bash
cd ~/Desktop/FamilyTree
docker buildx build --platform linux/amd64 -t docker.io/marwanhefny/familytree:v1 --push .
```
(Requires `docker login` to Docker Hub. `--push` builds + uploads in one step.)

## 2 — Put the data on the node (private)
Copy the current `family.json` to the node (one time + whenever the tree changes):
```bash
# from the Mac
scp ~/Desktop/FamilyTree/family.json admin@<truenas>:"/mnt/Big Tank/containers/familytree/family.json"
```
(or upload it to that dataset via the TrueNAS web UI). To update the tree later,
just replace this file — nginx serves it live, no redeploy needed.

## 3 — Deploy (TrueNAS Shell)
Edit the vars at the top of `deploy.sh` if needed, then run it:
```bash
bash deploy.sh
k3s kubectl -n familytree get pods     # familytree pod Running
```

## 4 — Expose at family.l3tz.com (one-time tunnel hostname)
Add a **Public Hostname** to the existing cloudflared tunnel:
- **Cloudflare Zero Trust → Networks → Tunnels →** *(your tunnel)* **→ Public Hostname → Add a public hostname**
  - **Subdomain:** `family`  · **Domain:** `l3tz.com`
  - **Service:** `HTTP` → `<nodeIP>:30086` (often `localhost:30086` if cloudflared runs on the node)

Cloudflare auto-creates the `family.l3tz.com` DNS record. Open **https://family.l3tz.com**.

---

## Access / editing
- **Viewing is open** to anyone with the link.
- **Editing is gated** by `editPassword` in `js/config.js` (currently
  `laithi-admin-2026`) — add/edit/delete/relink prompt for it. It's a client-side
  deterrent only; in this static deploy an edit affects just that viewer's own
  browser. To change it: edit `js/config.js`, rebuild with a new tag, redeploy.
- Want a real gate on viewing too? Put **Cloudflare Access** (email allow-list)
  in front of `family.l3tz.com` — no app change needed.

## Maintenance
- **Update the tree:** replace `${DATA_DIR}/family.json` on the node. Done.
- **Update the app (code/CSS):** rebuild with a **new tag** (`:v1` → `:v2`; never
  re-push the same tag with `IfNotPresent`), then
  `k3s kubectl -n familytree set image deploy/familytree web=docker.io/marwanhefny/familytree:v2`.
- **No database / no persistent app state.** For live multi-user editing instead
  of per-browser edits, configure Supabase in `js/config.js`.

## Caveats (TrueNAS-managed k3s)
- Manually-applied resources won't show in the TrueNAS Apps UI.
- Keep NodePort **30086** distinct from dfsa's 30085.
- Pod `Pending` on the volume → wrong `DATA_DIR` pool path.
