# Cloud SWAT server: no npm dependencies, built-in SQLite (Node 22.13+)
FROM node:22-alpine
RUN apk add --no-cache su-exec
ENV NODE_ENV=production \
    DB_PATH=/data/cloud-swat.db \
    TRUST_PROXY=1
WORKDIR /app
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
EXPOSE 4747
# The volume is mounted as root: fix its ownership, then run the app as the unprivileged "node" user.
CMD ["sh", "-c", "mkdir -p \"$(dirname \"$DB_PATH\")\" && chown -R node:node \"$(dirname \"$DB_PATH\")\" && exec su-exec node node --no-warnings src/index.js"]
