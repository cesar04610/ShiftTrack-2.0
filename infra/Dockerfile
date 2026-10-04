FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
ARG NPM_CA_BASE64
RUN if [ -n "$NPM_CA_BASE64" ]; then \
      printf '%s' "$NPM_CA_BASE64" | base64 -d > /tmp/npm-ca.pem && \
      NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem npm ci --fetch-retries=1 --fetch-timeout=30000 && \
      rm /tmp/npm-ca.pem; \
    else npm ci --fetch-retries=1 --fetch-timeout=30000; fi
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY apps/web apps/web
COPY packages packages
COPY scripts/migrate.ts scripts/provision.ts scripts/
COPY tsconfig.json ./
RUN NODE_ENV=production npx vite build --config apps/web/vite.config.ts
RUN npx tsc -p apps/api/tsconfig.json
RUN npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules node_modules
COPY --chown=node:node --from=build /app/dist dist
COPY --chown=node:node --from=build /app/apps/web/dist apps/web/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/database/migrations packages/database/migrations
COPY --chown=node:node infra/runtime-role.sql infra/runtime-role.sql
ENV WEB_DIST_DIR=/app/apps/web/dist
EXPOSE 8080
ENTRYPOINT ["node", "dist/apps/api/src/entrypoint.js"]
CMD ["dist/apps/api/src/server.js"]
