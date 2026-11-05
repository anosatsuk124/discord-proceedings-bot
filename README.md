# discord-proceedings-bot

Discord のボイスチャンネルを録音して、議事録の材料を作る Bot です。
発言(無音で区切られたひと続きの音声)ごとに Ogg Opus で保存し、文字起こしは
[discord-proceedings-bot-recognizer](https://github.com/anosatsuk124/discord-proceedings-bot-recognizer)
が行います。

## 使い方

| コマンド          | 内容                                                         |
| ----------------- | ------------------------------------------------------------ |
| `/gijiroku start` | 実行した人がいるボイスチャンネルに入り、録音を始める         |
| `/gijiroku stop`  | 録音を終えて退出する。録音は recognizer が順に文字起こしする |

コマンドは Bot がいるサーバーごとに登録するので、招待するとすぐに使えます。
録音を始めると、チャンネルに「録音を始めました」と表示されます。録音することを参加者に伝えてから使ってください。

- ボイスチャンネルから全員(Bot を除く)が抜けると、1 分後に自動で録音を終えて退出します。
  そのあいだに誰かが戻れば続けます。
- 文字起こしが終わると、`/gijiroku start` を実行したテキストチャンネルに議事録を投稿します。
  同じ内容を、ブラウザで開く HTML、Markdown、CSV の 3 つで添付します。
- 録音(音声ファイル)は 30 日たつと消します。議事録は残します。

## 出力

```text
<DATA_DIR>/sessions/<guild_id>/<session_id>/
├── manifest.json        # 録音を終えたときに最後に書く(recognizer はこれを見て処理を始める)
├── <utterance_id>.ogg   # 発言ごとの音声(Discord から届いた Opus をそのまま Ogg に包んだもの)
├── proceedings.html     # recognizer が書く議事録(1 ファイルで完結するページ)
├── proceedings.md       # 〃 Markdown
├── proceedings.csv      # 〃 CSV(speaker, date, talk)。3 つのうち最後に書く
└── delivery.json        # 議事録を Discord に投稿した記録(これがあるセッションは投稿しない)
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

このリポジトリの `compose.yaml` で、bot と recognizer を両方動かします。recognizer は GitHub の
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
