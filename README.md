# ワイガヤのAI進行・記録係「我ヶ谷」

複数人の話し合いを文字起こしし、必要な時に短い整理や質問をするMVPです。Discordでは会話の区切りで自律的に発言します。ブラウザ版では発言候補を確認してから読み上げます。

AI処理はOpenAIのみです。ホスト端末がDiscord接続・発話検知・記録保存を担当し、文字起こし・議論の検討・音声生成はクラウドで行います。Jetsonは必須ではありません。

## 資料

| 読みたい内容 | 資料 |
|---|---|
| Discordで何ができるか、いつ発言するか | [Discord版の現行仕様](discord-spec.md) |
| Botの登録・招待・起動・コマンド操作 | [Discord設定手順](discord-setup.md) |
| LAN公開・HTTPS・既存キーの設定 | [LAN設定](docs/lan-setup.md) |
| 確認済みの動作と残る評価 | [検証記録の要約](docs/validation.md) |
| 設計方針・デバイス・他社を含むモデル比較 | [参考資料一覧](docs/README.md) |

現行仕様の更新日は2026年10月9日です。参考資料には将来の構想も含まれます。

## 起動

Node.js 24.17以上を使います。プロジェクトのルートで実行してください。

```bash
npm ci
cp .env.example .env.local
```

`.env.local` に `OPENAI_API_KEY_FILE`（ワークスペース内のキーファイル）または `OPENAI_API_KEY` を設定します。既存ファイルを指定すればキーを複製せずに利用できます。ブラウザへキーは渡しません。SonioxやGoogleの登録は不要です。

```bash
# 会議サーバーを起動
npm start
```

既定のブラウザ画面は http://127.0.0.1:8765 です。別端末のマイクを使う場合は [LAN設定](docs/lan-setup.md) に従ってHTTPSを設定します。稼働済みの環境ではプロセスを重複起動しないでください。

Discordを使う場合は、[.env.discord.example](.env.discord.example) を `.env.discord` へコピーし、Application ID・サーバーID・Botトークンのファイルを指定します。

```bash
# 招待URLを表示
npm run discord:setup
# 同名のスラッシュコマンドを登録・更新
npm run discord:setup -- --register
# 会議サーバーとは別プロセスでBotを起動
npm run discord
```

Botには「チャンネルを見る」「メッセージを送信」「接続」「発言」の権限を付けます。管理者権限やMessage Content Intentは不要です。詳しい画面設定は [Discord設定手順](discord-setup.md) にあります。

## Discordでの操作

Botと同じボイスチャンネルから操作します。

| コマンド | 動作 |
|---|---|
| `/waigaya start` | 通話へ参加し、記録と自律進行を開始 |
| `/waigaya ask` | 依頼時点までの会話から回答を作り、音声で返す |
| `/waigaya stop` | 読み上げと自律発言を停止。記録は継続 |
| `/waigaya auto enabled:true` | 自律発言を再開 |
| `/waigaya auto enabled:false` | 自律発言を停止 |
| `/waigaya leave` | 記録を終えて退出 |

自律検討は、新しい対象発言が3件または合計60文字増え、発話終了後1.8秒以上経過した時に行います。検討の間隔は最短45秒です。モデルが発言不要と判断した場合は黙ります。人が話し始めたらAIの読み上げを止め、中断した文の残りは自動再開しません。

`ask` は生成後、人の発話終了から1秒待って読み上げます。依頼者だけに表示される文字返信とは別に、音声はボイスチャンネル全員に届きます。

## 現行のモデルと保存内容

| 役割 | Discord版の設定 |
|---|---|
| 文字起こし | `gpt-transcribe` |
| 整理・質問の検討 | `gpt-6.1-sol` |
| 音声生成 | `gpt-4o-mini-tts`、既定の声は `marin` |

文字起こし・会議状態・変更履歴・再生履歴は `data/waigaya.sqlite` に保存します。Discordの元音声を録音ファイルとして保存する機能はありません。費用は使用量からの推定値で、請求額との一致は保証しません。

ブラウザ版は文字入力、発言の修正、人が確認した決定の記録、Markdown保存にも対応します。キーがなくても記録の編集と保存は利用できます。

## 検証と制限

```bash
npx playwright install chromium
npm test

# 設定と比較対象の表示。APIは呼ばない
npm run compare
# 実APIを呼ぶ比較・接続確認。料金が発生する
npm run compare -- --run
npm run smoke:openai
```

制御・保存・HTTP/WebSocket・ブラウザ操作など57件のテストが通過しています。模擬応答・模擬音声を含みます。実Discordでの2人分の文字起こし、再生開始、人の発話による中断と、実APIによる165発言の自律判断を確認しています。自律発言を参加者が最後まで聞けることは、修正後の実通話での確認が残っています。

同時に扱えるDiscord会議は1つです。Stage・DM通話・完成した議事録の自動生成・長い会議の段階的な要約は未実装です。現行の割り込み判定は音量に基づくため、相づちや雑音でも読み上げを止めることがあります。

## プロジェクトの構成

| 場所 | 内容 |
|---|---|
| `src/discord/` | Bot接続・音声入出力・自律検討 |
| `src/` | 会議サーバー・状態制御・モデル接続・記録保存 |
| `public/` | ブラウザ画面と音声入力 |
| `scripts/` | Discord設定・モデル比較・接続確認 |
| `test/` / `eval/` | 自動テストと比較用の会話 |
| `docs/` | 設計・選定資料、LAN設定、検証の要約 |

`.env.local`・`.env.discord`、`seacret/`・`secrets/`、`data/`、`results/`、証明書・秘密鍵はGit管理から除外します。会議記録とAPI応答の原本はホスト端末に保存し、GitHubへ送信しません。
