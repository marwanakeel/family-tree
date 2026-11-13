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

# The pod runs as uid 1000 (the image's "node" user), not root, so it must own
# the data dir to write the tree, accounts and sessions.
chown -R 1000:1000 "${DATA_DIR}"

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
      # Hardening: the pod runs as an unprivileged user with no capabilities and
      # no Kubernetes token, so a compromised app has less to escape with.
      # The hostPath data dirs must be owned by uid 1000 (the script chowns them).
      automountServiceAccountToken: false
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: web
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          env:
            - name: HOME            # uid 1000 has no home directory in the image
              value: "/tmp"
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
---
# Egress isolation: this site may reach only its own namespace, DNS and the
# public internet. It cannot open a connection to the NAS host, the LAN, the
# tailnet or any other app (Nextcloud, Immich, Portainer). Incoming traffic
# from cloudflared is untouched. Note: kube-router matches egress against a
# Service's ClusterIP, so a same-namespace Service needs its own ipBlock rule.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: site-isolation
  namespace: familytree
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector: {}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        - ipBlock:
            cidr: 172.17.0.10/32        # cluster DNS Service IP
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16]
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
