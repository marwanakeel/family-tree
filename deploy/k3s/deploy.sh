#!/usr/bin/env bash
# Deploy the Family Tree (static site) onto TrueNAS k3s, exposed at
# family.l3tz.com by REUSING the cluster's existing cloudflared tunnel.
#
#   Browser ─HTTPS→ Cloudflare ─existing tunnel→ cloudflared ─→ <nodeIP>:30086 (familytree)
#    family.l3tz.com
#
# The published image is the APP SHELL ONLY — family.json is NOT in it. The data
# lives on the node at ${DATA_DIR}/family.json and is mounted in (so no personal
# data is ever pushed to the registry, and updates are just replacing that file).
#
# Run IN THE TRUENAS SHELL (uses `k3s kubectl`). Edit the vars, then: bash deploy.sh
set -euo pipefail

# ============================== EDIT THIS ==============================
IMAGE="docker.io/marwanhefny/familytree:v4"          # bump this tag every app change (mutable tags don't re-pull)
DATA_DIR="/mnt/Big Tank/containers/familytree"        # holds family.json (matches your /mnt/Big Tank/containers/<app> convention)
NODEPORT="30086"                                      # must match the cloudflared tunnel target; distinct from dfsa (30085)
# =======================================================================

command -v k3s >/dev/null || { echo "ERROR: k3s not found — run this on the TrueNAS host shell."; exit 1; }

mkdir -p "${DATA_DIR}"
if [ ! -f "${DATA_DIR}/family.json" ]; then
  echo "!! ${DATA_DIR}/family.json is missing — copy it there (see README step 2)."
  echo "   The site will show the built-in sample until you do."
fi

k3s kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: familytree
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: familytree
  namespace: familytree
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: familytree
  template:
    metadata:
      labels:
        app: familytree
    spec:
      containers:
        - name: web
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8123
          readinessProbe:
            httpGet:
              path: /
              port: 8123
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /
              port: 8123
            initialDelaySeconds: 10
            periodSeconds: 30
          resources:
            requests:
              memory: "32Mi"
              cpu: "10m"
            limits:
              memory: "192Mi"
              cpu: "300m"
          volumeMounts:
            - name: data
              mountPath: /data       # writable: tree + accounts + sessions
      volumes:
        - name: data
          hostPath:
            path: "${DATA_DIR}"
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: familytree
  namespace: familytree
spec:
  type: NodePort
  selector:
    app: familytree
  ports:
    - port: 80
      targetPort: 8123
      nodePort: ${NODEPORT}
EOF

echo "=== applied — watching rollout ==="
k3s kubectl -n familytree rollout status deploy/familytree --timeout=120s || true
k3s kubectl -n familytree get pods -o wide
echo
echo ">> Data dir ${DATA_DIR}: put family.json there; the app creates users.json/"
echo ">>   sessions.json on first run. Add ${DATA_DIR}/config.local.json with the"
echo ">>   first admin:  {\"admin\":{\"username\":\"you\",\"password\":\"...\"}}"
echo ">> Exposure (existing cloudflared tunnel): family.l3tz.com -> http://<nodeIP>:${NODEPORT}"
echo ">> Then open https://family.l3tz.com"
