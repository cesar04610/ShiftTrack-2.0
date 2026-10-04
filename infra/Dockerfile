FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npm_ca \
    if [ -s /run/secrets/npm_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --fetch-retries=1 --fetch-timeout=30000; \
    else npm ci --fetch-retries=1 --fetch-timeout=30000; fi
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
COPY tsconfig.json ./
RUN npx tsc -p apps/api/tsconfig.json
RUN npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules node_modules
COPY --chown=node:node --from=build /app/dist dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/apps/api/src/server.js"]
