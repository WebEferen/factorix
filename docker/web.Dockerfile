FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
COPY apps/web/package.json apps/web/
COPY packages/runtime/package.json packages/runtime/
COPY packages/schemas/package.json packages/schemas/
RUN yarn install --frozen-lockfile --ignore-engines --network-timeout 300000
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/runtime/src packages/runtime/src
COPY packages/schemas/src packages/schemas/src
ARG API_URL=http://api:4100
ARG FACTORIX_PUBLIC_URL=http://localhost:4101
ENV API_URL=$API_URL FACTORIX_PUBLIC_URL=$FACTORIX_PUBLIC_URL NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && ../../node_modules/.bin/next build

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=4101 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 4101
CMD ["node", "apps/web/server.js"]
