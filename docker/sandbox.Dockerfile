FROM node:22-bookworm AS build
WORKDIR /src
RUN npm install --global esbuild@0.28.2
COPY packages/runtime/src packages/runtime/src
COPY packages/runner/src packages/runner/src
RUN esbuild packages/runner/src/index.ts \
    --bundle --platform=node --format=esm --target=node22 \
    --alias:@factorix/runtime=./packages/runtime/src/index.ts \
    --external:@anthropic-ai/claude-agent-sdk \
    --external:@openai/codex-sdk \
    --outfile=/out/index.mjs

FROM node:22-bookworm
RUN apt-get update \
  && apt-get install --yes --no-install-recommends jq ripgrep fd-find tree sqlite3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && pip3 install --break-system-packages uv==0.9.5 \
  && corepack enable

COPY docker/sandbox/package.json /opt/factorix/package.json
RUN cd /opt/factorix && npm install --omit=dev --no-audit --no-fund
COPY --from=build /out/index.mjs /opt/factorix/runner/index.mjs
COPY docker/sandbox/factorix-git docker/sandbox/git-askpass docker/sandbox/doppler /opt/factorix/bin/
COPY docker/sandbox/prepare-commit-msg /opt/factorix/hooks/prepare-commit-msg

RUN usermod --login agent --home /workspace/.home node \
  && groupmod --new-name agent node \
  && mkdir -p /workspace/.home /workspace/.factorix /workspace/.cache /mirror \
  && chown -R agent:agent /workspace /mirror

ENV HOME=/workspace/.home \
    PATH=/opt/factorix/bin:/opt/factorix/node_modules/.bin:$PATH \
    COREPACK_HOME=/workspace/.cache/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    YARN_CACHE_FOLDER=/workspace/.cache/yarn \
    npm_config_cache=/workspace/.cache/npm \
    UV_CACHE_DIR=/workspace/.cache/uv \
    FACTORIX_WORKSPACE=/workspace \
    FACTORIX_DIR=/workspace/.factorix
USER agent
WORKDIR /workspace
CMD ["node", "/opt/factorix/runner/index.mjs"]
