# 管理者向け：固定Discord運用の設定・移行

対象：PR #1 / `feat/meeting-lifecycle-minutes`。利用者は固定VCで開始するだけ。管理者が固定VC・フォーラム・閲覧ロール・参加者への事前告知を導入時に設定する。本書の反映手順はリリースゲートであり、開発作業中に本番Botの更新や投稿は行っていない。

## 設定を一度だけ行う

Node.js 24.17以上を用意する。既存の `.env.local` / `.env.discord` を上書きしない。新規環境だけ例からコピーする。

```bash
npm ci
cp .env.example .env.local
cp .env.discord.example .env.discord
npm run discord:auth
```

`.env.local` に `OPENAI_API_KEY_FILE`、`.env.discord` に `DISCORD_BOT_TOKEN_FILE` を指定する。値だけ一行の既存キーファイルを再利用できる。両プロセスへ同じ `WAIGAYA_DISCORD_SERVICE_TOKEN_FILE` を設定する。キーやトークンの値をGit・ログ・チャットに載せない。`discord:auth` は既存ファイルを上書き・表示しない。

```dotenv
# .env.discord（既存アプリ・サーバーを維持）
DISCORD_APPLICATION_ID=1557731232727441429
DISCORD_GUILD_ID=1279446749970436236
DISCORD_BOT_TOKEN_FILE=seacret/discord-token.txt
WAIGAYA_DISCORD_SERVICE_TOKEN_FILE=seacret/discord-service-token.txt

# この固定設定とGuild IDは .env.local にも同じ値を指定する
WAIGAYA_DISCORD_VOICE_CHANNEL_ID=<実際の通常VCのID>
WAIGAYA_DISCORD_MINUTES_FORUM_ID=<実際の議事録フォーラムのID>
WAIGAYA_DISCORD_RESPONSE_POLICY=on_call
WAIGAYA_DISCORD_EMPTY_GRACE_MS=180000
WAIGAYA_DISCORD_AUTO_PUBLISH=true
# 任意・Bot側だけ。STT表記揺れの呼称をカンマ区切り
WAIGAYA_DISCORD_ADDRESS_NAMES=ワイガヤ,わいがや,我ヶ谷,我が谷
WAIGAYA_DISCORD_CONTROL_ROLE_IDS=
```

固定VC・フォーラムの実IDは未設定の例示であり、チャンネル名から推測しない。Discordの開発者モードから「IDをコピー」で確認する。文字列 `<...>` を実値に置き換える。通常VCとGuildForumだけに対応し、ステージや通常テキストを固定先として指定できない。

Bot側は固定IDが必須。会議サーバー側にも指定すれば、Botとの不一致を登録時に拒否する。サーバー側で省略した場合だけ、認証済みBotが実チャンネル検査後にポリシーをSQLiteへ登録する。登録・履歴は再起動後も残る。旧setupやDBの既定保存先より固定設定を優先する。固定設定の変更は導入作業として行い、旧未処理ジョブを新しい公開先へ無断移送しない。

`on_call` は議事録＋声の呼びかけ応答、`minutes` は音声一切なし、`facilitator` は任意の自律進行。毎回のモード選択は不要。`auto_publish=false` は管理用の非公開保存運用で、人の確認が必要な旧ポリシーを保つ。

## Discord権限と告知

Privileged Gateway IntentsはOFFでよい。Guilds / GuildVoiceStatesを使う。BotのAdministratorは不要。

| 固定先 | Botの必要権限 |
|---|---|
| 通常VC | ViewChannel / Connect / Speak / SendMessages（VCチャット通知） |
| 議事録フォーラム | ViewChannel / SendMessages / AttachFiles / SendMessagesInThreads / ReadMessageHistory |
| 任意のアーカイブ・ロック復帰 | 実際に必要な場合だけManageThreads |

Botはログイン後と開始前に存在・種別・所属ギルド・権限を確認する。投稿直前にも公開先の権限を検査する。必須タグを使うなら `議事録` や `未確認` など、AI未確認版に適用できる既存タグを設定する。「確認済み」しか使えないフォーラムでは投稿しない。Botはタグを新設しない。

**議事録は親フォーラムを見られる全員に公開される。会議専用の非公開スレッドではない。** 管理者が閲覧ロールを設定し、固定VCに参加する全員へクラウドSTT、原音声非保存、文字起こし保持、AI未確認議事録の自動公開を事前に知らせる。VCチャットの開始通知はその告知を補う。途中参加者へDMでも通知するが、DM拒否では本人通知が届かないので、サーバールールやVC説明にも掲示する。Botの存在だけを同意の代用にしない。

[DiscordフォーラムFAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)、[discord.js ForumChannel](https://discord.js.org/docs/packages/discord.js/main/ForumChannel%3AClass)

## コマンド登録と起動

```bash
npm run discord:setup
npm run discord:setup -- --register
# サーバーを先に起動
npm start
# 別ターミナルでBotを起動
npm run discord
```

固定設定のコマンド登録で、古いモード選択・保存先変更などを通常一覧から隠す。登録後も古いsetup / destinationの要求は固定先を変更できない。通常はstart一回→声で質問→全員退出だけ。非常時はend、記録停止はpause、再開はresume、AIだけ停止はquiet。旧stopは記録を止めない。

Botを起動してもVCへ入らず録音しない。再起動後、終了途中のジョブはVC接続せずに続行する。録音中だった会議に人が戻っていても停止を維持し、resumeで明示再開する。無人なら同一会議の退出猶予から最終処理を進める。

## 訂正・障害時だけ使う操作

- `minutes` は開始者・管理者・管理ロールが元VCの閲覧権限を持つ場合にだけ、議事録・原文・JSONを非公開取得できる。原発言訂正は要再確認と再生成、議事録項目訂正は新しい未確認版を作り、同じ投稿へ追記する。
- 「人の確認を付けて追記」は任意。実際の確認者と時刻を別版へ保存する。旧AI未確認版を書き換えず、個別決定の全員合意にも変換しない。
- 生成失敗は `minutes action:retry` で再生成する。元データは削除しない。
- 権限・必須タグ・容量など未送信が明確な失敗は設定を直す。自動試行は最大3回なので、停止後はminutesから再生成して新しい版の処理を進められる。
- 結果不明は管理者が `reconcile action:inspect`。既存投稿が見つかれば紐付ける。直接見つけたURLは `action:link url:<Discord投稿URL>`。完全照合で未投稿を確認できた場合のみ `action:retry` の最終確認を使う。10分の待機や探索上限があり、無条件再送しない。

通知は開始者へのDMに会議IDと分類だけ。本文を付けない。DMを閉じている場合はstatus / minutesから状態を確認する。Discordが削除されてもSQLite原本、版、公開予約は残る。記録全欠損・空会議は通常の議事録投稿と区別する。

## 本番反映・バックアップ・ロールバック

本番反映は管理者の明示的な作業として行う。新版の実通話受け入れを先に別のテスト環境で済ませ、[チェックリスト](docs/manual-acceptance.md)に結果を記入する。

1. 会議中でないことを確認し、旧Botを通常停止、次に旧会議サーバーを停止する。終了途中・送信結果不明の会議は事前に記録する。
2. 停止したDB、設定、旧コミット、Node版を保存する。SQLiteの一貫したバックアップ例：

```bash
mkdir -p backups/pre-fixed-ops
python3 - <<'PY'
import sqlite3
with sqlite3.connect('data/waigaya.sqlite') as source:
    with sqlite3.connect('backups/pre-fixed-ops/waigaya.sqlite') as target:
        source.backup(target)
PY
```

3. バックアップを別の検証用ディレクトリへ復元し、旧原発言・revision・議事録・監査・公開履歴を新版で読めることを確認する。秘密値付き設定・DB・バックアップはGitへ追加しない。
4. 新しい固定ID・権限・告知を設定し、対象コミットを取得して `npm ci` とコマンド再登録を行う。サーバーを先に、Botを後に起動する。初回起動は手動で監視する。
5. 自動録音が始まらないことを確認し、テスト会議を明示開始して受け入れを行う。

今回のDB変更は既存JSONへの固定ポリシー・終了ジョブ・確認属性の追加と、既存 `session_parts` への `voiceRequests` 配列保存。DROPや履歴削除はない。前PRの旧全文スナップショットからの追加移行も維持している。ただし旧コードは新フィールドを含むDBの読み取りを保証しないので、**ロールバックは旧コードと更新前DBを組にする**。

不具合時は新Bot、次に新サーバーを停止し、更新後DBも別名で保全する。旧コード・旧依存関係・旧設定・更新前バックアップを戻し、旧コマンドを再登録、旧サーバー→旧Botの順で起動する。更新後の会議を消さず保全し、Discordに投稿された版と予約を照合してから運用を再開する。公開済み投稿があるのに更新前DBだけで再公開しない。

保存期限・自動削除、OSによる常駐監視は未実装。管理者の保存・バックアップ方針を定める。
