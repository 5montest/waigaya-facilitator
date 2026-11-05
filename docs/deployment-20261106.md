# 2026年11月6日の本番反映記録（議事録v2・DeepSeek V4.1 Flash・担当メンション）

ユーザーの明示指示（「マージ頼む。本番反映も」）に基づき、`main` のマージと稼働中`waigaya.service`への
反映を実施した。Discordフォーラムへの実投稿・実メンション通知・実会議は行っていない。

## 1. 反映内容

- ブランチ: `feat/end-to-end-quality-20261106`（6コミット）→ `main` へ fast-forward マージ
- 反映コミット: `200ecec`（基点 `b5eaf47`）
  - `70d758a` 議事録LLMをGLM→DeepSeek V4.1 Flashへ変更
  - `2fe6c1f` ロールバック手順・未公開プレビュー再生成ツール
  - `78e3b20` 議事録v2パイプライン（カテゴリ・根拠保持、v1後方互換）
  - `29cbd6d` Discord表示再設計・選択的担当者メンション・二重通知防止
  - `7bc5fff` 決定論的評価器・11/5ベースライン計測
  - `200ecec` 最終レポート・README・資料一覧
- GitHub: `origin/main` を `933722d..200ecec` に更新（push成功）。
- 本番worktree: `/immich/media/agent-work/20261009-waigaya-fixed-ops`
  ブランチ `fix/review-voice-minutes-20261023` を `b5eaf47` → `200ecec` へ fast-forward。

## 2. 事前バックアップ

| 項目 | 値 |
|---|---|
| バックアップ先 | `backups/pre-deploy-20261106-20261106-021124/`（本番worktree内・git管理外） |
| DBコピー | `live-validation.sqlite`（`VACUUM INTO`、42,520,576 bytes、sha256 `20211779eb8a75e3...`） |
| integrity_check | `ok` |
| 件数（コピー時点） | sessions 5 / events 94,952 / session_parts 16,392 / guild_settings 1 / minutes_checkpoints 39 |

## 3. 反映前ゲート

- 単体・結合テスト（本番worktreeで実行）: `node --test --test-concurrency=1 test/*.test.js`
  → **306テスト中304 pass / 2 fail**。
- 失敗2件は `test/browser.test.js` のChromium音声経路テストのみ。**未修正の基点 `b5eaf47` でも
  同じ2件が同じタイムアウトで失敗することを事前確認済み**（環境のChromium/音声デバイス制約）。
  今回の変更による回帰ではない。
- モジュール読込確認（本番worktree）: `minutesModel() = deepseek-v4.1-flash`、
  `minutesEndpoint() = http://127.0.0.1:7684/v1/messages`、v2エクスポート群の読込OK。

## 4. 再起動と起動確認（2026-11-06 02:15:53 JST）

| 項目 | 反映前 | 反映後 |
|---|---|---|
| MainPID | 1657 | **3,551,358** |
| ActiveState / SubState | active / running | active / running（NRestarts=0） |
| 起動時刻 | 2026-10-26 07:58:56 | **2026-11-06 02:15:53** |
| HTTP `127.0.0.1:8875` | 200 | 200 |
| LLMブリッジ `127.0.0.1:7684` | 応答あり | 応答あり（400=リクエスト検証エラーで稼働中） |

journaldの起動ログ:

```
担当者メンションの別名辞書を読み込めないため、担当者への通知は行いません。config/waigaya-member-aliases.sample.json を参考に設定してください。
テスト用Botがオンラインです。会議開始は固定VCの /waigaya start だけです。HTTPは端末内のみ、ポート8875。
Discord Botを起動しました。起動だけでは記録しません。固定VCで /start を使ってください。
```

- 再起動後のDB: integrity_check `ok`。件数 sessions 5 / events 94,967 / session_parts 16,392 /
  guild_settings 1 / minutes_checkpoints 39（再起動に伴うイベント追加分のみ。会議データは不変）。
- 別名辞書警告は想定どおり。実Guildの`guildId`/確認済み`userId`を持つ
  `config/waigaya-member-aliases.json`（git管理外）を配置し、
  `notificationDefaults.enabled=true`にするまで担当者への通知は行わない（安全な既定）。

## 5. 反映後の設定

- 議事録LLM: 既定で **DeepSeek V4.1 Flash**（`deepseek-v4.1-flash`）。既存`.env.local`の
  `ANTHROPIC_BASE_URL`／`ANTHROPIC_API_KEY`を互換フォールバックとして使用（設定変更なし）。
  明示上書きする場合は`WAIGAYA_MINUTES_MODEL`／`WAIGAYA_MINUTES_BASE_URL`／`WAIGAYA_MINUTES_API_KEY`／
  `WAIGAYA_MINUTES_EFFORT`を`.env.local`へ設定可能。
- 担当者メンション: 既定無効（辞書未配置のため）。有効化は辞書配置＋`enabled:true`＋Bot再起動が必要。
- 既存のv1議事録は引き続き表示・検証・公開対象。新規生成からv2になる。
- `src/models.js`等の新規依存はなし（node_modules更新不要）。

## 6. 既知の制約・未実施

- 実会議での動作確認、実Discordフォーラムへの投稿、実メンション通知、モバイル表示は**未実施**。
- 次回の実会議で、v2議事録の生成時間・費用（概算$0.285/112分の実測はあるが請求額は未測定）、
  Discord本文の可読性、担当判定の精度を確認すること。
- 実Guild受け入れはテスト用フォーラム/隔離環境で、本人同意のうえ実施する。
- 失敗2件のブラウザ音声経路テストは環境要因。CIや実機ブラウザでの確認は別途必要。

## 7. ロールバック

[ロールバック・適用手順](rollback-20261106.md)を参照。概要:

```bash
cd /immich/media/agent-work/20261009-waigaya-fixed-ops
git merge --ff-only b5eaf47     # 旧HEADへ戻す（またはgit reset --hard b5eaf47）
sudo systemctl restart waigaya
# DBを戻す場合は backups/pre-deploy-20261106-20261106-021124/live-validation.sqlite から復元（承認時のみ）
```

- 反映後にv2で生成した議事録の下書きは旧コードでは検証できないため、切り戻し後は再生成する。
- 既に公開済みのv1議事録は不変。
