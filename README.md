# discord-talk

Discord のボイスチャンネルで GPT-Live (`gpt-live-1`) と通話する Bot。
コンセプトは [Discord × GPT-Live Voice Bot — Concept Specification.md](./Discord%20×%20GPT-Live%20Voice%20Bot%20—%20Concept%20Specification.md) を参照。

## セットアップ

1. Discord Developer Portal で Bot を作成し、以下を設定
   - Bot Token を取得
   - OAuth2 URL で `bot` + `applications.commands` スコープ、権限 `Connect` / `Speak` / `Use Voice Activity` でサーバーに招待
2. OpenAI API キーを用意(GPT-Live は $0.05/分、秒単位課金)。API keys ページで作る `sk-proj-…` キーを使うこと(サービスアカウントキーは Live API で弾かれる)
3. `.env.example` を `.env` にコピーして埋める
4. 実行

```sh
npm install
npm run dev      # tsx watch
# or
npm start
```

Discord 上で VC に入ってから `/join`、終了は `/leave`(ユーザーが VC を抜けても自動終了)。`/status` で直近のレイテンシを確認できる。

## Docker

- **Dev Container**: VS Code で「Reopen in Container」。Node 22 + ネイティブ依存のビルドツール + ffmpeg 入り。`node_modules` は名前付きボリューム(ホストと分離)。
- **compose**: `.env` を用意して `docker compose up --build`。`src/` をマウントして `tsx watch` で動くので編集が即反映される。
- **Dockerfile**(ルート)は本番用の軽量イメージ。

## 構成

```
src/
  index.ts                     起動・シグナル処理のみ
  config.ts / log.ts           環境変数 / ログ + [metric] レイテンシ出力
  discord/
    bot.ts                     Client 生成、イベント登録、コマンド登録
    commands/                  1コマンド=1ファイル (join / leave / status)。index.ts で登録
    events/                    interactionCreate (ディスパッチ+エラー整形), voiceStateUpdate (ユーザー退出で自動終了)
  voice/
    manager.ts                 SessionManager: guild ごとのセッション所有
    session.ts                 Discord 通話 = 1 GPT-Live セッション。配線とメトリクス
    receiver.ts                ユーザーの Opus → PCM → GPT-Live へ即時送信(無音時は無音フレーム補完)
    player.ts                  GPT-Live の PCM → Opus → Discord。Node stream の先読みバッファなし
  live/client.ts               OpenAI Live API (WebSocket) クライアント
  audio/pcm.ts                 48kHz stereo ⇄ 24kHz mono 変換 (2:1 固定比、遅延ゼロ)
```

コマンドを追加するときは `src/discord/commands/` にファイルを作り、`index.ts` の配列に足すだけ。
ユーザー向けメッセージで失敗させたいときは `UserError` を throw する(ephemeral で返る)。

### 設計上のポイント

- **Real-time first**: 録音→認識→生成→合成の直列処理はない。20ms フレーム単位で双方向に流し続ける。
- **GPT-Live は full-duplex**: 聞きながら喋る。ターン判定・割り込み判断はモデル側。Realtime API と違い `turn_detection` や `response.cancel` は存在しない。
- **再生バッファは自前キューのみ** (`LivePlayer.queue`)。`highWaterMark: 0` の objectMode Readable で Node stream 側の先読みをゼロにし、キューが空なら Opus 無音フレームを流す。ただしジッタ吸収のため、キューが尽きた後は「観測したチャンクサイズ + 60ms(+ underrun ごとに 40ms)」溜まるまで再生を再開しない(120〜800ms)。モデルは 1 デルタに 100〜300ms 入れて送ってくるので、固定の小さいバッファだとチャンク境界ごとに音切れする。underrun 回数は `/status` で見える。
- **受信側の無音フィラーは「遅れが 60ms 溜まったときだけ」**入れる(`receiver.ts`)。「20ms パケットが来なければ無音」だと、Discord のパケット揺らぎがそのまま単語の途中の無音になってモデルに届く。
- **デバッグ用の音声ダンプ**: `DUMP_AUDIO_DIR=dumps` で、OpenAI から届いた生音声(`*-out.wav`)とマイク音声(`*-in.wav`)を 24k mono WAV に落とす。「VC で変に聞こえる」時に、モデル由来か再生経路由来かを切り分ける。割り込み時は `flush()` でキューを即破棄(安全網。モデルは自分で止まるし、リアルタイム配信ではキューはほぼ 1 フレームなので実際に捨てるものはほぼ無い)。
- **出力音声は無音込みで流れ続ける**: GPT-Live は喋っていない間も `session.output_audio.delta` を実時間ペースで送ってくる(Pipecat の実装で確認)。なので「AI が喋っているか」はデルタの有無ではなく **サンプルの振幅**で判定する(`isSilence`、ピーク ≤20 を無音扱い、350ms 無音で「止まった」)。メトリクスと barge-in 判定はすべてこれ基準。
- **メトリクス** (`[metric]` ログ):
  - `response_latency`: ユーザー発話終了 → AI の最初の音声がキューに入るまで
  - `interrupt_stop`: ユーザーの割り込み開始 → AI 音声の出力が止まるまで(+ 破棄した先読み ms)

## 初回起動で確認すること(未検証項目)

Live API のドキュメントから組んでいる。WebSocket の疎通(`session.start` → `session.started` → `session.close` → `session.closed`)は 2026-09-14 に実 API で確認済み。以下は未検証。

- ~~WebSocket URL で `session.started` が返るか~~ → 確認済み。URL は `wss://api.openai.com/v1/live/sessions`(`/v1/live` は別のアルファ入口で `OpenAI-Alpha` ヘッダーを要求し `session.start` を拒否する)。キーは API keys ページで作る `sk-proj-…` を使う。`sk-svcacct-…`(サービスアカウント)は Live API で 401 `token_invalidated` になる。
- ~~`session.output_audio.delta` の音声フィールド名~~ → `delta`(Pipecat の `events.py` で確認。`start_ms`/`end_ms` は転写デルタにのみ付く)。`audio` もフォールバックで受ける。
- 出力が本当に「無音込みで連続」か(Pipecat のコメントが根拠。Azure docs は「範囲間のギャップは省略された無音」とも書いており、長い沈黙は省かれるかもしれない)。振幅判定はどちらでも壊れない。
- 割り込み時、モデル側が実際に何 ms で止まるか(`interrupt_stop`)と、ローカル flush がバックチャネル(「うん」等)を壊さないか。Pipecat はローカル割り込み処理を一切していない。

## チューニング対象

優先順位は spec の通り: テンポ > 割り込み > 発話終了判定 > 安定性 > 音質 > 回答品質。

- `voice/session.ts` の `INSTRUCTIONS`(短く話す/相槌/譲る)
- `VOICE_STOP_MS`, `SPEAKING_END_DELAY_MS`(メトリクス判定)、`SILENCE_PEAK`(`audio/pcm.ts`)
- `PRIME_MIN_MS` / `JITTER_MS` / `UNDERRUN_STEP_MS`(`voice/player.ts`)、`FILL_TOLERANCE_MS`(`voice/receiver.ts`)
- 割り込み時のローカル flush の要否(full-duplex モデルの挙動を見て判断)
- `audio/pcm.ts` のリサンプラ(音質が問題になったら差し替え)

## 参考実装

- [Pipecat `OpenAILiveLLMService`](https://github.com/pipecat-ai/pipecat/pull/5688)(`src/pipecat/services/openai/live/{llm.py,events.py}`)— 実 API で検証された最も詳しい実装。イベント型定義はここが正。
- [LiveKit Agents `GPTLiveModel`](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/)
- [OpenAI パートナー一覧](https://developers.openai.com/api/docs/guides/live-partner-integrations)

