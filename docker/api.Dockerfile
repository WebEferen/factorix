FROM node:22.23.4-bookworm-slim AS deps
WORKDIR /app
COPY package.json yarn.lock ./
COPY apps/api/package.json apps/api/
COPY apps/egress-proxy/package.json apps/egress-proxy/
COPY packages/connectors/package.json packages/connectors/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
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
COPY packages/connectors/src packages/connectors/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/runtime/src packages/runtime/src
COPY packages/sandbox/src packages/sandbox/src
COPY packages/schemas/src packages/schemas/src
USER node
EXPOSE 4100 8080
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
