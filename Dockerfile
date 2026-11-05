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
RUN pnpm run build && mkdir data-dir

# 実行用はシェルやパッケージマネージャーを含まない distroless にして、攻撃に使える部分を減らす。
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian13
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# 録音を書く /data。recognizer と同じ uid 1000 で動かす(ホスト側の data/ もこの uid が書ける必要がある)。
COPY --from=build --chown=1000:1000 /app/data-dir /data
USER 1000:1000
VOLUME ["/data"]
# ENTRYPOINT は node
CMD ["--enable-source-maps", "dist/main.js"]
