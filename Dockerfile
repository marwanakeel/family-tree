# Build a tiny, self-contained image that serves the family tree with nginx.
#   docker build -t familytree .
#   docker run -d -p 8088:80 -v "$PWD/family.json:/data/family.json:ro" familytree
#
# IMPORTANT: the app SHELL only — family.json is NOT baked in. The data lives on
# the host (mounted at /data, served as /family.json by nginx) so the published
# image carries no family/personal data. See deploy/k3s/.
FROM nginx:1.27-alpine

COPY index.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/  /usr/share/nginx/html/js/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
