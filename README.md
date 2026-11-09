# discord-proceedings-bot

Discord のボイスチャンネルを録音して、議事録の材料を作る Bot です。
発言(無音で区切られたひと続きの音声)ごとに Ogg Opus で保存し、文字起こしは
[discord-proceedings-bot-recognizer](https://github.com/anosatsuk124/discord-proceedings-bot-recognizer)
が行います。

## 使い方

| コマンド           | 内容                                                         |
| ------------------ | ------------------------------------------------------------ |
| `/gijiroku start`  | 実行した人がいるボイスチャンネルに入り、録音を始める         |
| `/gijiroku stop`   | 録音を終えて退出する。録音は recognizer が順に文字起こしする |
| `/gijiroku report` | 録音をまとめた議事録ページを作る(下記)                       |
| `/gijiroku index`  | このサーバーの議事録の入口ページの URL を表示する            |

コマンドは Bot がいるサーバーごとに登録するので、招待するとすぐに使えます。
録音を始めると、チャンネルに「録音を始めました」と表示されます。録音することを参加者に伝えてから使ってください。

- ボイスチャンネルから全員(Bot を除く)が抜けると、1 分後に自動で録音を終えて退出します。
  そのあいだに誰かが戻れば続けます。
- 文字起こしが終わると、`/gijiroku start` を実行したテキストチャンネルに議事録を投稿します。
  同じ内容を、ブラウザで開く HTML、Markdown、CSV の 3 つで添付します。
- 録音(音声ファイル)は 30 日たつと消します。議事録は残します。

## 議事録ページ

文字起こしの CSV から、全体のまとめ、章立て、議論マップ、関連資料、文脈を踏まえて校正した全文をまとめた 1 ファイルの HTML を作り、
[simple-static-pager](https://github.com/anosatsuk124/simple-static-pager) に公開して URL をチャンネルに投稿します。
ページは本文を HTML に直接埋め込んだ静的なものなので、JS や CSS が無効でも全文を読めます。既定では無効です(`REPORT_AGENT=off`)。

`/gijiroku report` はサーバー内のどのテキストチャンネルからでも実行できます(ボイスチャンネルに入っている必要はありません)。
対象はそのサーバーの録音すべてで、別のサーバーの録音は混ざりません。

| 指定                                  | 対象                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| 指定なし、`period:pending`            | まだまとめていない録音                                              |
| `period:today` など                   | today / yesterday / recent 24h / this week / last week / this month |
| `from:2026-11-06 21:00 to:2026-11-07` | 任意の期間。`to` が日付だけならその日の終わりまで                   |

期間を指定すると、まとめ済みの録音も対象になります。タイムゾーンは `PROCEEDINGS_TIMEZONE` です。

**自動生成**: 最後の録音が終わってから `REPORT_AUTO_DELAY_HOURS` 時間たつと、まとめていない録音を 1 ページにします
(a, b がまとめ済みで c, d がまだなら c と d をまとめる)。その間に手動で生成していたらその回は作らず、残りは次の回に持ち越します。
機能を有効にする前に終わった録音は自動の対象にしないので、必要なら期間を指定して作ってください。

**入口ページ**: サーバーごとに、これまでのページの一覧を機械的に作って更新します。URL は最初の 1 回だけ、システムメッセージの
チャンネル(「〜をサーバーに追加しました」が出る場所)に投稿します。そこに投稿できないときは結果を投稿するチャンネルに投稿します。
あとから確認するには `/gijiroku index` を使います。一覧にはサーバーのすべての録音が載るので、非公開のボイスチャンネルの録音も
URL を知っている人には見えます。

### しくみ

LLM は JSON を書く部分だけを担当し、それ以外(CSV の整形、検証、HTML への変換、commit、Actions の完了待ち、URL の取得、投稿、
入口ページの更新)はすべてプログラムが行います。手順と HTML のテンプレートは `skills/proceedings-report/` の SKILL にあります。

```text
bot ──ジョブ──▶ report-worker ──▶ CSV 整形 → LLM: 章立て → LLM: 関連資料の調査 → LLM: 校正 → LLM: 議論マップ → 検証 → HTML
  ◀──report.html──┘
  ▼
GitHub の html ブランチに commit → Actions の完了を待つ → artifact から URL を取得 → 投稿 → 入口ページを更新
```

CSV を指定して HTML だけを作ることもできます: `pnpm report --csv a.csv --csv b.csv --out out.html`

### 設定

`.env.example` の「議事録ページの生成」の項目を設定します。必要なのは次の 3 つです。

1. `COMPOSE_PROFILES=report` と `REPORT_AGENT`(`claude` / `codex` / `opencode`)、`REPORT_AGENT_MODEL`、`REPORT_AGENT_EFFORT`
2. LLM の認証情報(claude なら `claude setup-token` で発行した `CLAUDE_CODE_OAUTH_TOKEN` か `ANTHROPIC_API_KEY`)
3. `PAGER_REPO`、`PAGER_BRANCH`、`PAGER_GITHUB_TOKEN`(そのリポジトリだけに権限を絞った fine-grained PAT。Contents: read and write、Actions: read)

### 安全のための分離

文字起こしは誰でも話せる内容なので、LLM への入力は信頼できないものとして扱います。

- **コンテナ**: LLM は `report-worker` コンテナだけで動きます。Discord と GitHub のトークン、録音のファイルはこのコンテナにありません。
  bot とは処理中のジョブだけを入れた named volume でやり取りします。
- **サンドボックス**: CLI は [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)(`srt`)で包みます。
  書き込めるのはタスクのディレクトリだけ、接続できるのは許可したドメインだけです。このためにこのサービスだけ、
  user namespace を許す seccomp プロファイル(`docker/report-worker-seccomp.json`)と `systempaths=unconfined` を使っています。
- **タスクの分離**: 文字起こしを読むタスク(章立て、校正、議論マップ)は LLM の API にしか接続できません。Web に出る調査タスクには文字起こしを渡さず、
  話者名を含まない一般的な調査トピックだけを渡します。文字起こしを外部に送らないためです。
- **CLI の制限**: Bash は使わせません。ファイルの操作は作業ディレクトリの中だけです。
- **出力の検証**: LLM の出力はスキーマ、行 ID、長さを検証し、話者と時刻は LLM に書かせません。資料の URL は、実際に取得したものだけを
  `https:` の通常のリンクとして載せます。

## 出力

```text
<DATA_DIR>/sessions/<guild_id>/<session_id>/
├── manifest.json        # 録音を終えたときに最後に書く(recognizer はこれを見て処理を始める)
├── <utterance_id>.ogg   # 発言ごとの音声(Discord から届いた Opus をそのまま Ogg に包んだもの)
├── proceedings.html     # recognizer が書く議事録(1 ファイルで完結するページ)
├── proceedings.md       # 〃 Markdown
├── proceedings.csv      # 〃 CSV(speaker, date, talk)。3 つのうち最後に書く
└── delivery.json        # 議事録を Discord に投稿した記録(これがあるセッションは投稿しない)

<DATA_DIR>/reports/<guild_id>/
├── guild.json           # 入口ページの URL など
└── <report_id>/         # 議事録ページごとの記録(report.json)と HTML(report.html)
```

`manifest.json` の形は `src/manifest.ts` を参照してください。recognizer 側の `src/manifest.rs` と対になっています。

## 設定(環境変数)

| 名前                       | 既定値   | 内容                                                                 |
| -------------------------- | -------- | -------------------------------------------------------------------- |
| `DISCORD_TOKEN`            | (必須)   | Bot のトークン                                                       |
| `DATA_DIR`                 | `./data` | 録音を書くディレクトリ                                               |
| `SILENCE_DURATION_MS`      | `1000`   | 発言の区切りとみなす無音の長さ(ミリ秒)                               |
| `AUTO_LEAVE_DELAY_SECONDS` | `60`     | 全員が抜けてから自動で退出するまでの秒数。`0` なら自動では退出しない |
| `RECORDING_RETENTION_DAYS` | `30`     | 録音(音声ファイル)を残す日数。`0` なら消さない                       |

## Discord 側の準備

1. [Developer Portal](https://discord.com/developers/applications) でアプリケーションを作り、Bot のトークンを発行する。
   特権インテント(Message Content など)は使わないので、有効にしなくてよい。
2. OAuth2 の URL Generator で、スコープに `bot` と `applications.commands`、権限に
   `View Channels`、`Connect`、`Send Messages`、`Attach Files` を選んでサーバーに招待する。
   (`Send Messages` と `Attach Files` は議事録の投稿に使う)

## デプロイ(Docker Compose)

このリポジトリの `compose.yaml` で、bot と recognizer(と、有効にしていれば report-worker)を動かします。recognizer は GitHub の
リポジトリ(master)から直接ビルドするので、clone するのはこのリポジトリだけで足ります。

```sh
git clone https://github.com/anosatsuk124/discord-proceedings-bot.git
cd discord-proceedings-bot
cp .env.example .env    # DISCORD_TOKEN などを書く
chmod 600 .env
mkdir -p data           # uid 1000 のユーザーが書けること
docker compose up -d
docker compose logs -f
```

更新するときは、pull して up するだけです。どちらのサービスも up のたびにビルドし直し
(`pull_policy: build`)、変わったものだけを作り直します。recognizer も、その時点の master を取ってきます。

```sh
git pull
docker compose up -d
```

初回のビルドでは recognizer が CTranslate2 と oneDNN を C++ からビルドするので時間がかかります
(優先度を最低にしてビルドするので、ほかのサービスの邪魔はしにくくなっています)。2 回目からは、
recognizer の依存(`Cargo.lock`)が変わらないかぎりキャッシュで済みます。
初回の起動時に recognizer が文字起こしのモデル(約 1.5GB)を `models` ボリュームに取ってきます。
文字起こしの設定(モデル、スレッド数など)は `.env.example` と recognizer の README を参照してください。

## 開発

ツールチェーン(Node.js、pnpm)は [mise](https://mise.jdx.dev/) で管理しています。

```sh
mise install
pnpm install
pnpm test          # node:test。ffprobe があれば Ogg の検証もする
pnpm run typecheck
pnpm run build
pnpm run dev       # .env を読んで src/main.ts をそのまま動かす
```

依存の追加は pnpm で行います。`pnpm-workspace.yaml` で、公開から 3 日経っていない版を入れない
(`minimumReleaseAge`)、信頼性が下がった版を入れない(`trustPolicy`)、依存のビルドスクリプトを
動かさない、という設定にしています。
