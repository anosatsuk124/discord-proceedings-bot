# レガシービルダー(BuildKit なし)でもビルドできるよう、BuildKit 専用の構文は使わない。
ARG NODE_VERSION=26
ARG PNPM_VERSION=12.16.1

FROM node:${NODE_VERSION}-trixie-slim AS base
ARG PNPM_VERSION
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 本番で使う依存だけ
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# TypeScript のビルド
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:${NODE_VERSION}-trixie-slim
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# node ユーザー(uid 1000)で動かす。録音を書く /data はこのユーザーが書ける必要がある。
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
