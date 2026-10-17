# 2026年10月17日の修正版適用

ユーザーの適用・再起動指示に従い、開始処理と復旧処理の競合を直した `985ca8f` でBotと会議サーバーを起動した。開始時に既存のBot・会議サーバーは停止しており、稼働会議はなかった。mainへのマージは行っていない。

## 適用と保全

稼働DBは従来どおり `20261009-waigaya-fixed-ops/data/live-validation.sqlite`、認証プロファイルは `20261007-ai-discussion-facilitator-recorder`。既存キーと固定VC・フォーラム設定を継続した。会議HTTPは `127.0.0.1:8875` のみ。開始コマンドの定義変更はないため、再登録は行っていない。

反映前のDB・設定は、認証プロファイル配下の `backups/pre-apply-20261017-032131/` に保存した。SQLite backupでWALを含む整合したコピーを作り、両DBのintegrity_checkと保存データの一致を確認した。フォルダー700、DB・設定・確認結果600で保護し、Gitには追加していない。

| 対象 | 反映前後の確認 |
|---|---|
| 稼働DB | 2会議、3議事録版、2公開履歴。保存した全配列・会議ID・終了状態・終了ジョブは一致 |
| 旧ホストDB | 9会議。保存した全配列・会議ID・終了状態は一致 |
| 起動プロセス | PID 1384186、Botと会議サーバーを同一Nodeプロセスで実行。重複起動なし |
| Discord | Bot認証・固定先の権限検証・初期化成功。VC未参加 |
| 会議API | OpenAI設定あり。進行中会議0件。認証なしのDiscord会議取得は403 |

調査対象会議は終了済み・文字起こし0件・投稿省略のまま保持した。再録音、議事録の捏造、再投稿は行っていない。起動に伴う復旧用の状態・監査イベント保存はあるが、原発言・議事録版・公開済み本文は変えていない。

## 起動方法と確認範囲

端末の切断で終了しないよう、既存の起動スクリプトを独立したプロセスで実行した。元のコマンドは次のとおり。稼働中に重複実行しない。

```bash
node scripts/run-discord-test.js --profile /immich/media/agent-work/20261007-ai-discussion-facilitator-recorder --database data/live-validation.sqlite --port 8875
```

実行情報・PID・ログは作業フォルダーの `results/bot-runtime.json`、`results/bot-runtime.pid`、`results/bot-runtime-20261017.log` に保存する。これはOS起動時の自動起動や障害時の自動再起動を導入したものではない。

適用コードのローカル全体テストは176件成功。GitHub Actionsの [push](https://github.com/5montest/waigaya-facilitator/actions/runs/38998331090) と [pull_request](https://github.com/5montest/waigaya-facilitator/actions/runs/38998333520) も成功。初回ローカル実行の既存テスト1件のタイムアウトは [検証記録](validation.md) に残している。

今回確認したのは実Discord接続・権限・待機状態と会議API。人のマイク受信・音声聴取・全員退出後の議事録投稿は実通話未確認であり、[手動受け入れチェック](manual-acceptance.md) で確認する。実OpenAI生成や新しいDiscord投稿は実行していない。

復旧時はまず会議中でないことを確認し、現在のDBも保全してから通常停止する。旧コードと対応するDB・設定を組にして戻す。適用後に新しい会議や投稿があれば、更新前DBをそのまま使って再公開せず、原本と送信履歴を照合する。[管理者向けの復旧手順](../discord-setup.md) を参照。
