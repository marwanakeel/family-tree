# The Family Tree backend + app in one tiny image.
#   docker build -t familytree .
#   docker run -d -p 8123:8123 -v "$PWD/.data:/data" \
#     -e ADMIN_USER=admin -e ADMIN_PASS=change-me familytree
#
# IMPORTANT: the app + server code ONLY — no family data, accounts, or secrets.
# Everything mutable (family.json, users.json, sessions.json, config.local.json)
# lives in DATA_DIR (/data), mounted from the node. Nothing personal is baked
# into the published image. server.js is zero-dependency (Node stdlib only).
FROM node:20-alpine

WORKDIR /app
COPY server.js ./
COPY index.html ./
COPY css/ ./css/
COPY js/  ./js/

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8123
EXPOSE 8123

CMD ["node", "server.js"]
