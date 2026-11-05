# 我ヶ谷（waigaya-facilitator）一気通貫改善 最終レポート（2026-11-06）

- 対象: `/immich/media/agent-work/20261007-ai-discussion-facilitator-recorder`（waigaya-facilitator）
- 作業ブランチ: `feat/end-to-end-quality-20261106`（基底 `b5eaf47` = 稼働中コード）
- 依頼: 添付 `waigaya_end_to_end_improvement_instructions.md` の実装（フェーズA〜G）＋
  **議事録生成LLMをGLMからDeepSeek V4.1 Flashへ変更**（指示書に未記載の追加要件）
- 状態: **実装・自動テスト・ベースライン計測・11/5議事録の未公開事後生成まで完了。
  本番デプロイ・Discord実投稿・実Guildメンション通知は未実施（意図的に未操作）。**

## 1. 何を変えたか

| 領域 | 変更 | 成果物 |
|---|---|---|
| 議事録LLM | GLM→**DeepSeek V4.1 Flash**（既存のAnthropic互換ブリッジ経由）。`WAIGAYA_MINUTES_*`を追加、旧`WAIGAYA_GLM_*`/`ANTHROPIC_*`は互換。使用量に公開単価の概算を記録（請求額と区別） | `src/models.js`, `src/minutes.js`, `.env.example` |
| 議事録品質 | v2スキーマ（`discussionTopics`/`keyFacts`/`decisionCandidates.status`/`actionItems.assignment`）、抽出→階層統合＋決定的collapseの2段以上パイプライン、カテゴリ・根拠保持、C3プロンプト、診断ログ、v1後方互換、v2 Markdown | `src/minutes.js`, `test/minutes-quality.test.js`, `docs/minutes-quality-improvement.md` |
| Discord表示 | `shortMinutes`を再設計（議論の要点を重要度・重複・論点分布で選択、各節2件固定を廃止、案・比較・理由を掲載、担当状態表示、2000字制限） | `src/discord/minutes-publication.js` |
| 担当者メンション | 別名辞書（内容ハッシュ版）・限定正規化・完全一致・Guild/userId検証、`assignment=explicit`かつ根拠先頭発言が明示担当のときだけ選択メンション、`allowedMentions.users` allowlist、二重通知防止スナップショット、dry-runプレビュー。**既定は通知無効** | `src/discord/owner-mentions.js`, `src/publication.js`, `src/discord/bot.js`, `config/waigaya-member-aliases.sample.json`, `docs/discord-owner-mentions.md` |
| 評価基盤 | 決定論的評価スクリプト（R0→R1→R2→R3の情報損失・facts/数値/根拠・STT・usage）、合成評価ケース、ベースライン計測、v1固定レンダラ | `scripts/evaluate-minutes.js`, `eval/`, `test/evaluation.test.js`, `docs/minutes-quality-baseline.md` |
| 運用 | 適用・切り戻し手順、未公開プレビュー再生成ツール | `docs/rollback-20261106.md`, `scripts/generate-minutes-preview.js` |

Codex開発ログ（10/07開発・10/23レビュー）から引き継いだ文脈は `work/codex-log-summary.md` に要約
（GLMブリッジ導入経緯、チェックポイント設計、既知の制約）。ユーザー依頼の「Codexのログを読んで改修」に対応。

## 2. 修正前 → 修正後（実測）

### 2.1 11/5実会議（112分）の段階別情報損失

| 指標 | 修正前（v1実測） | 修正後（v2事後生成・未確認） | 根拠/制約 |
|---|---:|---:|---|
| 議事録の項目数 | 41 | **102（2.49倍）** | 同一原本・事後生成 |
| 議事録の本文量（Markdown） | 2,298字 | **7,714字** | R2実物 vs 事後生成 |
| Discord本文量 | 566字（8/41項目=19.5%、案・比較は非掲載） | **1,461字（20/102項目=19.6%）** | 修正前はロジック再現値 |
| 理由・制約・反対・事実のカテゴリ | **0件（器が無い）** | **reason5 / constraint7 / disagreement4 / fact15（verification 0）** | v1は6配列のみ |
| 根拠evidenceの被覆 | 83参照/72発言（確定1,817件の3.96%） | **572参照/311発言（17.1%、文字被覆37.4%）** | 形式検証のみ |
| 既知facts保持（11語） | 9/10（R0で確認できた語） | **10/10（Discord短縮版は8/10）** | 匿名ラベルF1〜F11 |
| 数値トークン保持 | 13（金額7、19.4%/38.9%） | **45（金額16、67.2%/88.9%）** | distinct、意味は未判定 |
| 討議過程マーカー（語彙） | 理由2/条件1/懸念1/比較3/検証3 | **理由8/条件5/懸念7/比較18/検証26** | 意味の正しさではない |
| 議事録生成コール数 | 21（GLM） | **12（DeepSeek V4.1 Flash）** | 抽出8＋統合4 |
| 生成時間（終了→完成） | 311.2秒 | **707.6秒（2.27倍）** | 事後生成の実測値 |
| 生成費用 | 未測定（estimatedUsd=null） | **概算$0.285（公開単価、請求額ではない）** | GLMは費用未算定 |

### 2.2 同一入力でのプロンプトAB（ライブ実測・11/5先頭チャンク）

| 指標 | 旧v1プロンプト | 新v2プロンプト | 倍率 |
|---|---:|---:|---:|
| 項目数 | 23 | 70 | 3.04倍 |
| 本文量 | 752字 | 2,574字 | 3.42倍 |
| evidence参照/発言被覆 | 46/33発言（15.6%） | 178/74発言（34.9%） | 3.87倍/2.24倍 |
| 数値recall | 25.9% | 70.4% | 2.72倍 |
| 討議カテゴリ（理由・制約・反対・検証・事実） | 出現せず | 出現 | — |
| 呼び出し時間 | 34.2秒 | 146.6秒 | 4.28倍 |
| 出力トークン | 4,791 | 20,282 | 4.23倍 |
| 概算費用/チャンク | $0.009155 | $0.027983 | 3.06倍 |

条件: model=deepseek-v4.1-flash, effort=high, max_tokens=24,000, 同一入力（212発言・24,010字）。
2コール合計の概算は $0.037138（公開単価概算、請求額ではない）。思考トークンはブリッジのusageで分離できず未測定。
新v2の生JSONにはcategory enum違反2件があり、アプリの正規化（別名補正）で吸収された（診断ログに記録）。

### 2.3 自動テスト・回帰（最終実行）

- `node --test --test-concurrency=1 test/*.test.js`: **306テスト中304 pass / 2 fail**。
- 失敗2件は `test/browser.test.js` のChromium音声経路テストのみ。**未修正の基底コード `b5eaf47`（本番worktree）で同じ2件が同様に失敗することを確認済み**（環境のChromium/音声デバイス制約による既知の失敗で、今回の変更による回帰ではない）。
- 新規テスト: `test/minutes-quality.test.js` 22、`test/owner-mentions.test.js` 22、`test/publication-mentions.test.js` 17、`test/evaluation.test.js` 25、`test/forum-runtime.test.js` への追加分。
- `npm run eval:minutes` 自己検証、`node --test test/evaluation.test.js` 25/25 pass。
- 既存テストはv1文書の描画・公開検証・owner/deadline補正・予約/照合/再送禁止・blind publish防止を維持（弱めていない）。

### 2.4 実APIコスト（概算の積み上げ）

| 用途 | コール数 | 概算費用 |
|---|---:|---:|
| プロンプトAB（旧/新 各1、11/5先頭チャンク） | 2 | $0.037 |
| 統合収束不具合の再現・修正確認（smoke、失敗分含む） | 10程度 | 約$0.15 |
| 11/5全件 未公開プレビュー生成（本番相当） | 12 | $0.285 |
| 合計（概算・公開単価） | — | **約$0.47** |

いずれもDeepSeek V4.1 Flashの公開ピーク単価による概算換算であり、OpenCode Go経由の実請求額は未測定。
実測できた範囲（AB 2コール + 本生成12コール）は $0.3222。残り（smoke・収束不具合の再現分）はログからの積み上げ概算。
v1（GLM）の実費用は未測定のため、比較は「概算換算」であることに注意。失敗時の再試行は最小限に留めた。

## 3. 未測定・制約（推測で成功と書かない）

- **人手Gold set・意味的な重要命題再現率・根拠支持率は未測定**。評価は決定論的な代理指標（facts/数値/英数字/討議語彙/evidence被覆）のみ。
- **音声原本が保存されていないため、STTのWER/CER・話者別誤認識率は測定不能**。11/5はSTT失敗575/3,767回、gaps 586件、`health.stt=failed`。
- 実Guildでのメンション到達・実Discord投稿・モバイル表示は未実施（禁止・未承認のため）。
- 12名→6名などの名寄せ精度は実会議データで未確認。画像のメンバー一覧は出席証明に使っていない。
- 11/5事後生成の議事録は**未公開プレビュー**であり、内容の人手確認・参加者合意を示さない。元フォーラムへ再投稿していない。
- DeepSeek V4.1 Flashの費用は公開単価による概算。OpenCode Go経由の実請求額とは一致しない可能性がある。
- v2文書は旧コードでは検証できない（ロールバック時の注意は `docs/rollback-20261106.md`）。

## 4. 安全・プライバシー

- 実会議本文・実DiscordユーザーID・実辞書IDは `work/`（git対象外）にのみ保存。コミット対象・docs・レポートには集計値と匿名ラベルだけを記載。
- 本番DBは読み取り専用で参照。本番フォーラムへの投稿、Bot再起動、実メンション通知、デプロイは行っていない。
- メンションは既定で無効。辞書が無い/未検証/曖昧/他Guild/照合不能なら通知しない（fail-closed）。`@everyone`・ロール・本文中の`<@id>`文字列は無害化。
- 懸念・未確認は `docs/minutes-quality-baseline.md` / `docs/minutes-quality-improvement.md` / `docs/discord-owner-mentions.md` に明記。

## 5. 再現・検証コマンド

```bash
node --test --test-concurrency=1 test/*.test.js   # 自動テスト（外部API・実Discordなし）
npm run eval:minutes                              # 評価基盤の自己検証
node scripts/evaluate-minutes.js --db <本番DB> --session <11/5セッション> --renderer legacy-v1 \
  --probes work/baseline/probes.json --json /tmp/baseline.json   # 修正前ベースライン再計算
# 未公開プレビューの再生成（実API・実会議本文はローカルのみ）
node --env-file=.env.local scripts/generate-minutes-preview.js --db <本番DB> --session <11/5セッション> --out work/preview-20261106
```

## 6. Definition of Done への対応

| 指示書の完了条件 | 状態 |
|---|---|
| 記録原本・部分要約・最終Markdown・Discord表示の情報損失を分類・測定 | 達成（11/5実測、`docs/minutes-quality-baseline.md`） |
| 議事録が議論過程（理由・比較・懸念・条件）を保持 | 実装・構造テスト・AB実測で確認。意味的品質の人手確認は未測定 |
| 根拠・revision・決定の確認状態・旧版/承認/投稿の不変条件を保持 | 達成（既存テスト＋新規テスト、v1後方互換） |
| 部分要約の分類損失を解消し長時間会議の回帰試験 | 達成（カテゴリ保持・collapse復元・600発言級テスト） |
| 技術用語・STT品質は音声有無と評価結果を明示 | 達成（音声なし→WER/CER不可と明記） |
| 6名の名寄せヒントを取り込み、実ID確認なしのメンションをしない | 達成（サンプル辞書・検証済みのみ通知・既定無効） |
| 担当の明示・提案・名前言及・否定・曖昧を区別 | 達成（D5の14ケース＋独立分類） |
| 許可された担当者のみ選択的メンション、誤通知・二重通知抑止 | 達成（allowlist・双方向一致・スナップショット抑止） |
| dry-runと回帰テスト、変更前後の品質・コスト・制約を提示 | 達成（dry-run、テスト、ABと事後生成の実測） |
| 本番環境・公開フォーラム・通知を無断操作していない | 達成（未実施） |
