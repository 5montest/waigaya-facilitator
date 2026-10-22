# Botの常駐管理と2026年10月22日の復旧

## 今回の原因と復旧

Discordで「アプリケーションが応答しませんでした」と表示されたため、10月22日21時台に調査した。Botと会議サーバーのプロセスが存在せず、127.0.0.1:8875も閉じていた。コマンドを受け取るBotが停止している状態だった。保存済み会議は2件とも終了済みで、新しい会議の作成履歴はなかった。

前回は端末から独立したNodeプロセスとして起動していたが、停止時の再起動を管理していなかった。最後のログは10月17日の起動完了までで、終了理由・終了コード・停止時刻の記録は残っていない。調査できたカーネルログに該当プロセスのOOM終了の記録はなかった。直接の停止理由は不明であり、OS再起動やメモリ不足と断定していない。

会議が進行していないことを確認し、DBをバックアップしたうえで、OSのシステムサービス `waigaya.service` として再起動した。Botと会議サーバーを一つのNodeプロセスで管理する。アプリの録音・音声・議事録処理は、mainの `933722d` から変更していない。

## 適用済みのサービス設定

- 実行ユーザーは既存の `maeda`。rootとしてBotを動かさない。
- systemdの `/system.slice/waigaya.service` で管理し、ログイン・端末の存続に依存しない。
- プロセス終了時は10秒待って自動再起動する。管理者が `systemctl stop` で停止した場合は再起動しない。
- OS起動時の自動起動を有効化した。OS自体の再起動テストは実施していない。
- 記録は従来どおり127.0.0.1:8875と `data/live-validation.sqlite`。従来の認証プロファイル・キー・固定VC／フォーラムを引き継ぐ。
- ログはjournalへ保存し、終了理由と再起動回数を確認できる。unitファイルにキー・トークンの値を入れない。

再起動はBotのログインを復旧する操作であり、会議の新規作成や録音開始ではない。会議の開始は引き続き人の `/waigaya start` が必要。途中で停止した会議は、既存の復旧処理に従い、自動で録音再開しない。

## 実際に確認した内容

設定を適用してDiscord初期化・固定先の権限検査・認証付き会議APIを確認した。進行中会議が0件の待機状態で、実プロセスへSIGKILLを送り、systemdの自動復旧を確認した。

| 項目 | 結果 |
|---|---|
| 自動復旧 | PID 3033847から3034180へ変わり、約14.4秒でDiscordの初期化完了 |
| 再起動回数 | `NRestarts=1` |
| 会議の自動作成・録音 | なし。終了済み会議は2件のまま |
| データ | 稼働DBの既存原文・議事録・公開履歴と、旧DBの9会議を保持。integrity_checkは両DBともok |
| API認証 | 認証付き取得は成功、認証なしのDiscord会議取得は403 |
| 元音声・新しい議事録投稿 | 保存・作成していない |

この確認は、実プロセスの異常終了と復旧を試したもの。ユーザーのスラッシュコマンドをBot自身が代行実行したり、人の実マイク・音声聴取を確認したものではない。

## 管理者の操作

現在のPIDや稼働状態は、保存してある古いPIDファイルではなくsystemdで確認する。

```bash
sudo systemctl status waigaya.service --no-pager
sudo systemctl show waigaya.service -p MainPID -p NRestarts -p ActiveState -p SubState
sudo journalctl -u waigaya.service --since today --no-pager
```

更新・停止は、進行中会議と終了処理がないことを確認してから行う。

```bash
sudo systemctl stop waigaya.service
# DBをバックアップしてからコード・依存関係・設定を更新
sudo systemctl start waigaya.service
# 停止・起動をまとめて行う場合
sudo systemctl restart waigaya.service
```

常駐サービスの稼働中に `npm start`、`npm run discord`、`npm run discord:test` を別途実行しない。Bot・会議サーバー・SQLiteの二重起動を避ける。サービスを止めても保存済みの原本や議事録は削除しない。

今回の起動元は `20261009-waigaya-fixed-ops`、認証プロファイルは `20261007-ai-discussion-facilitator-recorder`。`results/bot-runtime.json` は導入時点の記録であり、現在のPIDの正本ではない。ログは `journalctl -u waigaya.service` で取得する。従来の `results/bot-runtime.pid` は廃止した。

## 別のホストへ導入する場合

テンプレートは [deploy/waigaya.service.example](../deploy/waigaya.service.example)。`@USER@`、`@GROUP@`、`@WORKSPACE@`、`@NODE@`、`@PROFILE@`、`@DATABASE@` をそのホストの実値へ置換する。作業ディレクトリとDBは既存のものを明示し、別の空DBへ切り替えない。認証ファイルの設定と読み取り権限を確認する。

置換したファイルを `waigaya.service` として保存し、検査後に登録する。

```bash
systemd-analyze verify waigaya.service
sudo install -o root -g root -m 0644 waigaya.service /etc/systemd/system/waigaya.service
sudo systemctl daemon-reload
sudo systemctl enable --now waigaya.service
```

インストール前に、既存のBotプロセスや会議サーバーが動作していないことを確認する。systemdの起動成功だけで判定せず、Discord初期化のログ、認証付き会議API、録音なしの待機状態も確認する。

## バックアップ・切り戻し

今回の反映前DBは、認証プロファイル配下の `backups/pre-service-20261022-120357/` にSQLite backupで保存した。フォルダー700、ファイル600で保護し、Gitへ追加していない。検証結果は同じ場所の `post-service.json` に保存した。

常駐管理を取り消す場合は会議がないことを確認し、`sudo systemctl disable --now waigaya.service` で停止する。停止後のDBも保全してから、従来の起動へ戻す。今回の変更でDBスキーマは変えていないため、サービス設定を取り消すためだけに過去のDBへ戻す必要はない。反映後の記録や公開履歴を失わないようにする。
