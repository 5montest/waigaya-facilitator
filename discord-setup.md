# Discord設定・操作・移行

この手順は改善実装に対応する。稼働中の旧版を停止・更新するまでは旧コマンドと動作のままである。詳しい動作条件は [仕様](discord-spec.md)、受け入れ確認は [手動チェックリスト](docs/manual-acceptance.md) にある。

## 1. Botと会議サーバーを設定する

Node.js 24.17以上とOpenAIの既存キーを使う。Bot用のDiscordトークンとOpenAIキーは別物で、どちらもチャットやGitHubへ貼らない。

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作成し、Application IDを控える。
2. Botのトークンを発行し、作業フォルダーの `seacret/discord-token.txt` に値だけ1行で保存する。
3. Discordの開発者モードから利用するサーバーIDを取得する。
4. [.env.example](.env.example) を `.env.local`、[.env.discord.example](.env.discord.example) を `.env.discord` にコピーし、キーのファイルとApplication ID・サーバーIDを設定する。既存の設定ファイルは上書きせず、必要項目だけ追加する。
5. Bot・会議サーバー間の認証ファイルを用意する。

```bash
npm ci
npm run discord:auth
```

このコマンドは `seacret/discord-service-token.txt` を生成し、秘密値を表示しない。既存ファイルは上書きしない。両方の設定ファイルに次を追加する。

```dotenv
WAIGAYA_DISCORD_SERVICE_TOKEN_FILE=seacret/discord-service-token.txt
```

この認証はBotとローカルAPIの間だけで使い、参加者やブラウザには渡さない。認証設定がないBotは起動しない。登録・招待URLの表示にも、設定例を使う場合は先にこのファイルを用意する。

## 2. Discordの権限と招待

Botの最小権限は「チャンネルを見る」「メッセージを送信」「ファイルを添付」「接続」「発言」。管理者権限は不要。Privileged Gateway Intentsは全てOFFでよい。GuildsとGuildVoiceStatesを使い、通常のメッセージ本文は読まない。

```bash
# 招待URLを表示。APIを呼ばない
npm run discord:setup
```

表示されたURLで指定サーバーへ追加する。スコープは `bot` と `applications.commands`。すでに追加済みの場合も、共有先のチャンネルで添付権限を確認する。

会議操作・閲覧・共有は開始者とManage Server権限のある人が利用できる。必要な場合だけ、追加の管理担当ロールを設定する。

```dotenv
WAIGAYA_DISCORD_CONTROL_ROLE_IDS=
```

ここには許可する実際のロールIDをカンマ区切りで設定する。初期値は空。権限を追加したロールは過去会議の閲覧もできるため、会議の担当者に限る。

## 3. 起動・更新

```bash
# 会議サーバー（端末1）
npm start
# コマンド登録・更新（端末2）
npm run discord:setup -- --register
# Bot（端末2）
npm run discord
```

稼働済みのプロセスを重複起動しない。Discordへの接続に会議UIのインターネット公開は不要。Bot起動だけでは記録しない。再起動後は保存済みの会議を停止状態で参照し、必要な場合だけ `/resume` を使う。OS再起動後のプロセス自動起動は別途設定する。

更新時はBot→会議サーバーの順に停止し、コード・依存・設定を更新する。会議サーバー→コマンド登録→Botの順で起動する。終了済みの会議は再開されない。生成途中で停止した議事録は `/minutes action:再生成` で再試行する。

## 4. 会議を始める

通常のVCに参加して `/waigaya start` を使う。省略時はモード選択が表示され、選択するまでは記録しない。

| モード | 動作 |
|---|---|
| 議事録のみ | 会話を記録して議事録を作る。AI音声は常にOFF |
| 呼びかけた時だけ | 記録し、askで返答。音声は明示指定した時だけ |
| AIワイガヤ | 記録し、会話の区切りで必要な時に短く発言 |

議題は任意。`output_channel` を選ぶと、後から共有する先を固定できる。開始時には本文を投稿しない。未指定なら議事録は本人だけのプレビューとホスト保存に留まる。

記録開始前にVCのチャットへモード・送信先・保存先を通知する。音声はOpenAIへ送信し、文字起こしと議事録はホストのSQLiteへ保存する。Discordの元音声は録音ファイルにしない。途中参加者への通知はDMで、受信設定によって届かない場合がある。

## 5. 会議中の操作

| 操作 | コマンド |
|---|---|
| 状態・保存先・障害を確認 | `/waigaya status` |
| モードを変更 | `/waigaya mode mode:…` |
| AIに文字回答を頼む | `/waigaya ask` |
| 明示的な音声回答 | `/waigaya ask voice:true`（議事録のみでは音声なし） |
| ここまでの要約 | `/waigaya summary` → `/minutes` で取得 |
| AIだけ黙らせる | `/waigaya quiet`。記録は続く |
| 記録を一時停止 | `/waigaya pause`。新しい音声は送らない |
| 記録を再開 | `/waigaya resume`。新しい発言から記録 |
| AI発言を再開 | `/waigaya mode` でモードを選び直す |
| 会議を終了 | `/waigaya finish` → 60秒以内に確認 |

全員が退出すると新しい音声を記録せず、3分待つ。戻れば同じ会議が続く。一時停止していた場合は停止のまま。誰も戻らなければ自動終了して議事録を作る。

## 6. 議事録を確認・訂正・共有する

1. `/waigaya minutes` で現在または直近の会議を確認する。`meeting` は最近の会議の候補から選べる。
2. 本人だけに表示される `minutes-vN.md`、`minutes-vN.json`、`transcript.md` を保存する。
3. 必要なら「原発言を訂正」で発言を選び、本文を直す。長い発言は部分ごとに選ぶ。訂正履歴が残り、旧議事録は要再確認になる。
4. 原発言を訂正した場合は `/waigaya minutes action:再生成` を使う。元の記録は消えず、新しい版になる。
5. 「項目を訂正」で議事録本文も編集できる。根拠参照は保持し、編集版は未承認に戻る。
6. 最新の版を読んで「この版を確認済みにする」を押す。これは議事録の確認であり、全員の合意や決定候補の承認ではない。
7. 共有する場合は `/waigaya publish` を使い、公開先と版を確認してボタンを押す。

同じ版・同じ先へ二重投稿しない。送信結果が不明な場合は自動再送しない。開始時に公開先を選ばなかった会議は、この版では共有コマンドを使えない。ファイルを本人が保存するか、次の会議で公開先を選ぶ。

## 7. 旧版からの変更

旧版の `start` は自律発言ONだった。改善版の既定は議事録のみ。従来の動作にしたい場合はAIワイガヤを選ぶ。`ask` も文字回答が既定となり、音声は `voice:true` で明示する。

| 旧コマンド | 互換動作・推奨操作 |
|---|---|
| `stop` | AIだけ停止。記録は継続。新操作は `quiet` |
| `auto enabled:true` | AIワイガヤへ切替・再開。新操作は `mode` |
| `auto enabled:false` | AI音声・自律発言停止。新操作は `quiet` |
| `leave` | 確認後に終了・議事録生成。新操作は `finish` |

旧版の会議にはサーバー・VC・開始者の情報が保存されていない。実際のIDを人が指定するまで、内容を保護してDiscordの一覧には出さない。移行する場合はBotと会議サーバーを停止し、SQLiteをバックアップしてから実行する。

```bash
npm run discord:migrate -- --offline --session 会議ID --guild サーバーID --voice 元VCのID --owner 開始者のユーザーID
```

実際に取得したIDを指定する。会議ID・原発言・イベントは保持し、議事録のみ・記録停止状態へ移す。開始時刻を推定で補わない。移行後は `/minutes` から閲覧・再生成できる。記録を続ける場合だけ、担当者が同じVCで `/resume` を操作する。

## 8. 失敗時と保存

STT・AI回答・音声・議事録生成・ファイル出力・Discord送信・SQLite保存を区別する。まず `status` を確認する。議事録生成だけ失敗した場合は原本を保持し、`minutes` から再生成する。保存に失敗した場合は直近の更新が保存できたと確認できず、入力を停止する。

保存先は `data/waigaya.sqlite`。イベント履歴には訂正前の内容が残る。自動削除はしない。Bot・サーバーのログへ会議本文や秘密値は出さない。キー、トークン、実設定、SQLite、API結果はGit管理から除外する。

Discord会議はBotの認証済み接続だけから取得でき、LANブラウザへは公開しない。独立したブラウザ会議は従来どおり許可LANから利用するため、共有LANへの公開には別途認証設計が必要である。
