# ワイガヤのAI記録係「我ヶ谷」

固定のDiscordボイスチャンネルで `/waigaya start` を一回使えば、会議を記録します。「ワイガヤ、さっきの2案を整理して」と声で呼ぶと短く音声で答え、呼ばれていない間は静かに記録します。全員退出から3分後にBotも退出し、議事録を固定フォーラムへ自動投稿します。終了・承認・公開の操作は普段は不要です。

投稿は **「AI生成・未確認」** です。人が内容を確認したことや、参加者全員が合意したことを意味しません。AIが整理した決定候補と、人が確認した決定を分け、発言ID・revisionの根拠を残します。後日の訂正や人の確認は別版として同じ投稿へ追記します。

音声とAI処理にはOpenAIを使い、接続・発話検知・SQLite保存はホスト端末で行います。原音声をファイル保存せず、文字起こしを保持します。フォーラムを閲覧できる全員にAI議事録が見えることを、開始前にVCチャットへ通知します。通知できなければ記録しません。

このブランチはPR #1の改善実装です。本番への反映・mainへのマージ・新版の実Discord通話検証は行っていません。固定VCとフォーラムの実ID、権限、参加者への事前告知を管理者が設定してから導入してください。

## 普段の使い方

1. 固定VCに入り `/waigaya start` を実行します。モードや保存先を選ぶ画面は出ません。
2. 普通に会議をします。必要な時だけ「ワイガヤ、これどう思う？」と呼びかけます。
3. 全員退出します。3分以内に戻れば同じ会議が続き、戻らなければ自動終了・Bot退出・議事録投稿へ進みます。

Bot起動やVC入室だけでは記録は始まりません。人が残っている無音の会議も勝手に終了しません。

## 導入とテスト

Node.js 24.17以上が必要です。既存環境の設定を上書きせず、[管理者向け設定・移行手順](discord-setup.md)に従います。

```bash
npm ci
cp .env.example .env.local
cp .env.discord.example .env.discord
npm run discord:auth
```

`.env.local` に既存のOpenAIキーファイル、両方の環境ファイルに同じBot接続認証と固定設定を指定します。Botトークンは `.env.discord` のファイル設定で読み込みます。キーをブラウザやGitHubへ渡しません。

```dotenv
DISCORD_GUILD_ID=1279446749970436236
WAIGAYA_DISCORD_VOICE_CHANNEL_ID=<管理者が確認した通常VCのID>
WAIGAYA_DISCORD_MINUTES_FORUM_ID=<管理者が確認したフォーラムのID>
WAIGAYA_DISCORD_RESPONSE_POLICY=on_call
WAIGAYA_DISCORD_EMPTY_GRACE_MS=180000
WAIGAYA_DISCORD_AUTO_PUBLISH=true
```

```bash
# サーバーを先に、Botを後に起動（稼働済みプロセスを重複起動しない）
npm run discord:setup -- --register
npm start
# 別ターミナル
npm run discord
```

固定設定が不足しているとBotは起動できません。ログイン後にもID・種別・所属・権限を検証します。原本は `data/waigaya.sqlite` に保存し、終了ジョブと投稿予約も同じDBから復元します。再起動時に録音は自動再開しません。結果不明の送信は管理者が照合するまで再送しません。

```bash
npm ci
npx playwright install chromium
npm test
npm run bench:storage
npm audit --omit=dev
```

`npm test` は単体、模擬Discord＋HTTP＋SQLite、ブラウザ、音声割り込み、復旧のテストを含みます。GitHub Actionsも秘密値なしで実行します。実OpenAI API・実Discord投稿は通常テストから呼び出しません。

## 保守操作と資料

記録を止めたい時は `pause`、再開は `resume`。AIだけ黙らせたい時は `quiet`。非常用の会議終了は `end`。旧 `stop` は従来どおりAI音声だけを止め、記録を継続します。`status` は状態確認、`minutes` は非公開取得・訂正、`reconcile` は管理者の送信結果照合に使います。日常操作は `start` だけです。

| 内容 | 資料 |
|---|---|
| 固定運用・声の呼びかけ・公開・権限 | [Discord版の仕様](discord-spec.md) |
| 固定設定、権限、導入・バックアップ・ロールバック | [Discord設定手順](discord-setup.md) |
| 今回の変更と制約 | [改善レポート](docs/improvement-report.md) |
| 実通話のリリースゲート | [手動受け入れチェック](docs/manual-acceptance.md) |
| テスト結果・測定条件 | [検証記録](docs/validation.md) |
| ブラウザ用のLAN・HTTPS設定 | [LAN設定](docs/lan-setup.md) |
| 設計・デバイス・モデル比較の経緯 | [資料一覧](docs/README.md) |

既存ブラウザは `npm start` で http://127.0.0.1:8765 を開きます。ブラウザ会議は従来の手動操作を維持し、Discordの機密記録閲覧は公開していません。固定運用以前の会議履歴も消しません。保持期間・自動削除は未実装なので、管理者がバックアップと保存を管理します。
