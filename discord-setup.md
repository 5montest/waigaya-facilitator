# Discord設定・操作・移行

PR #1の改善コードに対応する。実通話の受け入れとバックアップは本番反映前に実施する。[仕様](discord-spec.md)／[手動チェック](docs/manual-acceptance.md)

## Bot・会議サーバーを設定する

Node.js 24.17以上を使う。Discord Developer Portalでアプリ、Application ID、Botトークン、サーバーIDを用意する。Privileged Gateway Intentsは全てOFFでよく、Guilds／GuildVoiceStatesだけを使う。

```bash
npm ci
cp .env.example .env.local
cp .env.discord.example .env.discord
npm run discord:auth
```

既存設定は上書きしない。OpenAIキーは.env.localのOPENAI_API_KEY_FILEで既存ファイルを指定できる。Botトークンは.env.discordのDISCORD_BOT_TOKEN_FILEへ値だけ1行のファイルを指定し、Application IDとGuild IDを設定する。キーとトークンはチャット・GitHubへ貼らない。

Botと会議サーバーの両方に、同じ接続認証ファイルを設定する。discord:authは安全なファイルを生成し、既存値は上書き・表示しない。

```dotenv
WAIGAYA_DISCORD_SERVICE_TOKEN_FILE=seacret/discord-service-token.txt
WAIGAYA_DISCORD_CONTROL_ROLE_IDS=
```

管理ロールは必要な場合だけ実IDをカンマ区切りで設定する。このロールは過去会議の閲覧・投稿もできる。既定保存先設定と結果不明の照合はManageGuild管理者だけに許可する。

## フォーラムを保存先にする

1. 管理者が議事録用の通常フォーラムを作り、閲覧できるロールを設定する。フォーラムを利用できないサーバーでは通常テキストを使う。
2. Botに保存先のViewChannel、SendMessages、AttachFilesを許可する。同じ投稿への版更新にはSendMessagesInThreads、投稿照合にはReadMessageHistoryも必要。
3. テキストでスレッドを使う場合だけCreatePublicThreadsを許可する。アーカイブ・ロックを管理者として復帰する必要がある場合はManageThreadsを追加する。BotのAdministrator権限は不要。
4. 既存タグの議事録・確認済みを用意できる。Botはタグを新設しない。必須タグ設定なら、Botが適用できるタグを少なくとも一つ用意する。
5. 管理者が `/waigaya setup channel:#議事録` を実行する。設定はSQLiteに保存され、以後の会議の既定になる。

操作者には保存先の閲覧権限だけを要求する。投稿するのはBotであり、操作者自身のSendMessagesは必須ではない。フォーラムの投稿は親フォーラムを見られる全員に見える。会議だけの非公開投稿ではない。機密会議には専用のアクセス制限された保存先を選ぶ。[DiscordフォーラムFAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)

招待URLには閲覧・送信・添付・履歴・公開スレッド作成・スレッド送信・VC接続・発言を含める。実際のチャンネルごとの権限も確認する。

```bash
npm run discord:setup
npm run discord:setup -- --register
```

## 起動と通常の使い方

```bash
# 別々のターミナルで起動
npm start
npm run discord
```

Bot起動だけでは記録しない。稼働済みプロセスを重複起動しない。OS自動起動は別途の管理設定である。

1. 通常VCへ入り `/waigaya start` を使い、議事録のみ／呼びかけた時だけ／AIワイガヤを選ぶ。既定は議事録のみでAI音声は常にOFF。
2. この会議の保存先を上書きする時だけoutput_channelを指定する。明示先＞サーバー既定＞未設定の順で選ぶ。
3. VCのチャットで送信・保存先の通知を確認して話す。音声はOpenAIへ、文字起こしと下書きはホストへ保存し、元音声はファイルにしない。
4. `/waigaya finish` の確認で終了する。全員退出後3分でも自動終了する。
5. `/waigaya minutes` で議事録・原本・JSONを本人だけに表示・保存する。DMを閉じていても取得できる。
6. 原発言・議事録項目を訂正する。原発言の訂正後はminutesの再生成を使い、新しい版を作る。
7. 「確認して投稿」を押し、保存先、見える人の範囲、正式版、タグ、概要を最終確認する。確認すると承認を保存し、Botが直ちに投稿してURLを返す。
8. 後日訂正版も確認して投稿する。フォーラムでは同じ投稿に新しいMarkdownを返信し、過去版を残す。

保存先なしでも下書きを作れる。minutesの「保存先を選ぶ」、または `/waigaya destination channel:…` で後から設定する。clear:trueで解除できる。設定を変えただけでは投稿しない。公開前に新しい先と版を確認し直す。

| 操作 | コマンド |
|---|---|
| 記録・公開・障害状態 | status |
| AIの関わり方 | mode |
| 文字回答／明示音声 | ask／ask voice:true（minutesでは音声なし） |
| 途中要約 | summary → minutesで確認。正式版としては投稿不可 |
| AIだけ黙らせる | quiet（記録継続） |
| 記録停止／明示再開 | pause／resume |
| 説明 | help |
| 旧共有操作 | publish。確認済み正式版だけ、最終確認を経て投稿 |

旧stopはAIだけ停止、autoはモード切替／AI停止、leaveは確認後に終了する互換操作として残す。以前のstart自律ON、ask音声ONの既定は変更している。

## 送信結果を照合・復旧する

Discordが権限・形式・タグ・容量の問題で未送信を明確に返した場合は、問題を直して再度確認して投稿する。タイムアウトや投稿成功後のDB保存失敗では、予約が残り二重投稿を止める。

管理者は `/waigaya reconcile` で予約の保存先を検索する。一致するBot投稿が一つ見つかれば、会議・版・本文・予約を検証して紐付ける。直接URLを指定する場合は `action:投稿URLで照合 url:…` を使う。別ギルド・別保存先・別作者・別本文には紐付けない。

一致がなくても直ちに未投稿とは判断しない。検索の完了、送信から10分、旧送信処理の停止、投稿の削除がないことを確認し、`action:未送信を確認して再試行を許可` のボタンで管理確認を記録する。その後minutesで保存先と版を確認して再試行する。検索の上限や権限・APIエラーでは再試行を許可しない。

旧版の予約には識別子がないため、投稿URLで旧添付の本文ハッシュを照合する。旧予約で未投稿を機械的に検証できない場合は、自動解除しない。元データを保持し、管理者が記録と投稿を確認する。

## 更新・バックアップ・ロールバック

この作業から本番デプロイは実行しない。実施する時は手動受け入れを済ませ、参加者へ記録停止を知らせる。

1. Bot→会議サーバーの順に正常停止する。
2. 停止後にSQLiteのbackup APIかcheckpointを使い、DB・WALを含め整合性のあるバックアップと実設定を安全なローカル保管先へ保存する。公開リポジトリに含めない。
3. 改善コードを導入しnpm ci、両方の認証設定、Bot権限を確認する。
4. 会議サーバーを起動する。既存の全文保存形式は追加テーブルへ自動移行し、原文・revision・版・監査を保持する。
5. discord:setup -- --registerでコマンドを更新し、Botを起動する。
6. 起動だけでは録音・投稿しないことを確認する。前会議を続ける時だけresumeする。pausedの会議は録音せずfinishで終了してもよい。

ロールバックは両プロセスを止め、まず更新後のDBも別に保全する。旧コードは新しい分離保存形式を読めないため、旧コード＋更新前のDBバックアップを組み合わせて戻す。更新後に増えた記録は新DB側に残し、削除・上書きしない。旧DBへ無理に書き戻さず、対応コードで再出力する。

旧Discord会議にサーバー・VC・開始者の記録がない場合は、停止・バックアップ後に実IDを指定する。開始者や時刻を推測しない。

```bash
npm run discord:migrate -- --offline --session 会議ID --guild サーバーID --voice 元VCのID --owner 開始者のID
```

## 検証と保存

```bash
npm ci
npx playwright install chromium
npm test
npm run bench:storage
```

CIはpull_requestと対象ブランチのpushで実行する。Node.js 24.17、Playwright Chromium、模擬API／Discordを使い、Secretsも実API課金も不要。

SQLiteが正本で、Markdownは確認済み版の配布用コピー。生成・音声・投稿・保存の失敗を区別する。Discord会議のHTTP／WebSocket／ファイル／履歴は認証済みローカルBotだけに許可し、LANブラウザへ機密会議を公開しない。自動削除・新しい外部連携・録音ファイル保存は追加しない。
