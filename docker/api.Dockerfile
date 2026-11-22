# Only the package.json of each plugin, so changing a plugin's code does not reinstall dependencies.
FROM node:22.23.4-bookworm-slim AS plugin-manifests
WORKDIR /app
COPY plugins plugins
RUN find plugins -type f ! -name package.json -delete

FROM node:22.23.4-bookworm-slim AS deps
WORKDIR /app
COPY package.json yarn.lock ./
COPY --from=plugin-manifests /app/plugins plugins
COPY apps/api/package.json apps/api/
COPY apps/egress-proxy/package.json apps/egress-proxy/
COPY apps/plugin-host/package.json apps/plugin-host/
COPY apps/preview-gateway/package.json apps/preview-gateway/
COPY apps/remote-runner/package.json apps/remote-runner/
COPY packages/connectors/package.json packages/connectors/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/schemas/package.json packages/schemas/
RUN yarn install --frozen-lockfile --production --ignore-engines --network-timeout 300000

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY apps/api/src apps/api/src
COPY apps/egress-proxy/src apps/egress-proxy/src
COPY apps/plugin-host/src apps/plugin-host/src
COPY apps/preview-gateway/src apps/preview-gateway/src
COPY apps/remote-runner/src apps/remote-runner/src
COPY packages/connectors/src packages/connectors/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/plugin-sdk/src packages/plugin-sdk/src
COPY packages/runtime/src packages/runtime/src
COPY packages/sandbox/src packages/sandbox/src
COPY packages/schemas/src packages/schemas/src
COPY plugins plugins
USER node
EXPOSE 4100 4102 4110 8080
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
