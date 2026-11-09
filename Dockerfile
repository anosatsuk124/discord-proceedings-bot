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

# 議事録ページを LLM で作るサービス(compose の report-worker)。LLM の CLI とサンドボックスが要るので
# bot とは別のイメージにする。LLM の認証情報のほかに秘密は持たせない。
FROM node:${NODE_VERSION}-trixie-slim AS report-worker
ARG CLAUDE_CODE_VERSION=2.1.319
ARG CODEX_VERSION=0.167.0
ARG OPENCODE_VERSION=1.4.10
ARG SANDBOX_RUNTIME_VERSION=0.0.81
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap socat ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-fund --no-audit \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}" \
        "@anthropic-ai/sandbox-runtime@${SANDBOX_RUNTIME_VERSION}"
ENV NODE_ENV=production \
    REPORT_JOBS_DIR=/report-jobs
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY skills ./skills
# ジョブの受け渡しに使う named volume の所有者になるよう、uid 1000 のディレクトリを用意する。
COPY --from=build --chown=1000:1000 /app/data-dir /report-jobs
USER 1000:1000
VOLUME ["/report-jobs"]
CMD ["node", "--enable-source-maps", "dist/report-worker/main.js"]

# 実行用はシェルやパッケージマネージャーを含まない distroless にして、攻撃に使える部分を減らす。
# このステージを最後に置く(docker build の既定のターゲットが bot になる)。
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian13
ENV NODE_ENV=production \
    DATA_DIR=/data \
    REPORT_JOBS_DIR=/report-jobs
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# index ページのテンプレートを使う。
COPY skills ./skills
# 録音を書く /data。recognizer と同じ uid 1000 で動かす(ホスト側の data/ もこの uid が書ける必要がある)。
COPY --from=build --chown=1000:1000 /app/data-dir /data
COPY --from=build --chown=1000:1000 /app/data-dir /report-jobs
USER 1000:1000
VOLUME ["/data", "/report-jobs"]
# ENTRYPOINT は node
CMD ["--enable-source-maps", "dist/main.js"]
