# Discord担当者メンション（別名解決・選択的通知・二重通知防止）

対象実装: `src/discord/owner-mentions.js`（新規）、`src/discord/minutes-publication.js`、`src/publication.js`、
`src/discord/bot.js`。指示書 D1〜D5 / E1 / F1 に対応する。

**この機能は既定で通知しない。** 別名辞書が無い・`notificationDefaults.enabled=false`・未検証ID・
Guildメンバー照合不可のいずれかなら、担当は本文に表示するだけでメンションしない（安全側）。

---

## 1. 役割分担

| 層 | 役割 |
|---|---|
| 議事録（v2） | `actionItems[].owner` / `deadline` / `assignment`（`explicit\|proposed\|none\|conflict`）を生成 |
| `owner-mentions.js` | 別名辞書の読込・限定正規化・完全一致解決・Guild/ID検証・担当判定の独立分類・通知計画（純粋関数） |
| `minutes-publication.js` | 本文描画（`safeText`で無害化した後に検証済みトークンだけ差し込む）・`allowedMentions`・送信 |
| `publication.js` | 公開記録への通知スナップショット保存・二重通知抑止・送信後報告の検証（純データ関数） |
| `bot.js` | 辞書読込・プレビューへのdry-run表示・編集UI（v1/v2）・安全側フォールバック |

**絶対条件（D3）:** 名前が出ただけではメンションしない。次をすべて満たす場合だけ通知候補にする。

1. v2議事録の `assignment === 'explicit'`（v1文書は通知対象外。本文表示のみ）
2. 根拠先頭発言をアプリ側で独立分類して `explicit`（LLMのassignmentを鵜呑みにしない）
3. 辞書で一意にsnowflake解決でき、`verified:true`・`enabled:true`・Guild一致・Guild在籍/username照合OK
4. 根拠発言が現行revisionで有効（失効・訂正済み・AI発言・未確定は不可）
5. 二重通知抑止に該当しない

`proposed`（担当候補の提案）・`none`・`conflict`・過去の言及（「〜と言っていた」）・否定（「〜はやらなくていい」）・
疑問形（「〜がやる？」）・曖昧（「担当はAさん？ いやBさん」）は通知しない。
自己申告（「私がやります」）だけは発話者の`userId`を候補にする（辞書とGuild在籍の検証は同じ）。

---

## 2. 別名辞書の管理

### 2.1 ファイル

- 環境変数 `WAIGAYA_MEMBER_ALIASES_FILE`（既定 `config/waigaya-member-aliases.json`）。
- **実IDを含む `config/waigaya-member-aliases.json` はコミットしない**（`.gitignore` 対象）。
  リポジトリにコミットするのは `config/waigaya-member-aliases.sample.json` のみ。
- サンプルは `guildId: null` / 各`userId: null` / `verified:false` / `enabled:false` /
  `notificationDefaults.enabled:false` であり、**そのままでは一切通知しない**。
- 辞書の変更はファイル差し替え（または内容変更）で行う。`dictionaryVersion` は内容のSHA-256先頭16桁で、
  パスや更新時刻には依存しない。公開記録にはこの版を保存するため、後から「どの辞書で誰に通知したか」を再現できる。
- 監査・ロールバック用に、辞書ファイルは変更前の版を別名で保管する（例: `config/archive/…`、git管理外）。

### 2.2 形式（schemaVersion 1）

```json
{
  "schemaVersion": 1,
  "guildId": "<対象Guildのsnowflake>",
  "notificationDefaults": {
    "enabled": true,
    "mentionOnlyExplicitAssignees": true,
    "mentionProposedAssignees": false,
    "suppressRepeatMentions": true
  },
  "members": [
    {
      "userId": "<17〜22桁のsnowflake>",
      "usernameHint": "Discord username（照合用ヒント）",
      "displayNameHint": "表示名（プレビュー用）",
      "aliases": ["会話中の呼び名"],
      "verified": true,
      "enabled": true
    }
  ]
}
```

- `verified:true` は「管理者が実Guildで`userId`を確認した」という意味。**未検証は通知しない。**
- `enabled:false` は一時停止。`guildId` が会議のGuildと一致しない辞書は使わない。
- 同じ`userId`の重複、17〜22桁でない`userId`、同じ別名が複数人に一致する状態は「未解決」として通知しない。
- 1文字の別名は誤一致しやすいため解決に使わない（2文字以上）。
- 表示名・username・明示された呼び名だけを候補にする。表記揺れの無制限な自動推測・部分一致・読み推定はしない。

### 2.3 限定正規化

NFKC → 英字小文字化 → 空白/句読点/括弧の除去 → 末尾の敬称（先生・さん・さま・様・くん・君・氏・ちゃん）の除去、
だけを行う。**完全一致のみ**（`鈴木` は `鈴木一郎` に一致しない）。`木村`→`孔明`のような対応は辞書の`aliases`に
明示された当該Guild限定の設定であり、他Guildへ流用しない。

### 2.4 Guild・ID照合

- 恒久キーは `guildId + userId`（snowflake）。表示名・usernameは可変なので毎回辞書の`usernameHint`と照合する。
- 対象ユーザーのみ `guild.members.fetch(userId)` で個別照合する（全メンバー収集はしない）。
- 在籍なし・照会失敗・Guild取得不可・username不一致は**未解決（通知しない）**。
- BotがGuildメンバーを取得できない環境では通知されない。手動でID登録しても、この照合が通るまで通知しない。
- `utterance.userId`（発言者）と、発言中で言及された担当者は別物として扱う。混同しない。

---

## 3. 通知方針（既定）

- 自動通知は **v2議事録の `explicit` のみ**。`mentionProposedAssignees` は将来拡張用で、既定`false`
  （現行実装は`proposed`を通知しない）。
- `mentionOnlyExplicitAssignees:true` は現行実装では常にこの挙動。
- 同一会議・同一担当者`userId`・同一根拠発言（`utteranceId@revision`）への通知は**版更新を跨いで1回だけ**。
  - 通知済み（公開済みスナップショットの`notified:true`）→ 抑止。
  - 送信結果不明（`needs_reconciliation`等）→ 再送しない（不明扱い）。
  - 根拠発言が訂正されrevisionが変わった場合 → 古い通知は取り消さず、新規扱いにもせず、不明扱いで抑止。
  - 旧形式（スナップショットなし）の公開記録に同じ根拠のアクションがある → 不明扱いで抑止。
  - 未送信が確定した記録（`failed_confirmed`）だけは再通知できる。
  - 訂正版で**新規に追加されたアクション**は通知する（既通知分は抑止）。
- 本文に表示する担当状態:
  - 通知する明示担当: `担当：<@id>（発言上の指定・未確認）`
  - ID未確認・抑止時: `担当：名前（発言上の指定・ID未確認）` 等
  - 提案: `担当候補：名前（通知しません）`
  - 不明: `担当：担当者特定不可` / `担当：担当未確定（要確認）`
- **「発言上の担当指定（AI抽出・未確認）」であり、会議全員の正式承認ではない。** 人間確認済みの決定は
  従来どおり `confirmedDecisions` / `state.decisions` のみ。

---

## 4. 誤通知防止（文字列処理・送信）

- 既存の `safeText()`（`@`→`＠`、`<`→`＜`、`>`→`＞`、Markdownエスケープ）は**解除しない**。
- 通常本文と、検証済みsnowflakeからコードが構築した `<@snowflake>` トークンだけを別ルートで組み立てる。
  文字起こし中の `@everyone`・`<@id>`・`<@&role>` は文字列として無害化される。
- 送信は次のとおり。
  - 通知対象あり: `{allowedMentions:{parse:[], users:[...本文に実在した検証済みID], repliedUser:false}}`
  - 通知対象なし: `{allowedMentions:{parse:[]}}`（従来と同じ全抑止）
- **双方向一致:** `users`に入れたIDのトークンは本文に必ず存在し、本文のトークンはすべて`users`に含まれる。
  送信直前に本文からトークンを抽出して`users`を再計算する（`applyMentionAllowlist`）。
  allowlist外のトークンは「（通知対象外）」へ置換する。
- `@everyone`・`@here`・ロールメンションは許可しない（`parse:[]`）。
- **切り捨て耐性:** アクション節に優先枠を確保する。本文長でトークンが入らない場合は、その担当の通知を抑止し
  「担当者特定不可（本文の長さ制限）」へフォールバックする。トークンを恣意的に落として別の人へ通知しない。
- **fail-closed:** 送信後に報告される `notifiedUserIds` はスナップショットのallowlistの部分集合でなければ
  ならない。不一致なら1件も通知済みにしない（誤通知の可能性を「通知済み」と記録しない）。
- 投稿予約・照合・再送禁止の既存安全要件は変更しない。送信結果不明時は再送せず `/reconcile` で照合する。

---

## 5. dry-run運用（送信前プレビュー）

- `describeMentionPlan(state, version, dictionary, {now})` は**純粋関数**で、Discord送信・I/Oをしない。
  返す内容: 通知対象（`allowedUserIds`）／各アクションの担当判定・根拠ref・抑止理由（日本語）／
  辞書版（`dictionaryVersion`）／`enabled`・トップレベルの抑止理由。
- `/minutes` のプレビュー（ephemeral）に次を表示する（`mentionPlanPreview`）。
  - `担当メンション（dry-run・送信しません）`
  - `通知対象：表示名（根拠: 発言ID先頭8文字@rev／明示担当・未確認）`
  - `通知先ID（マスク）: ****下4桁`（生のuserIdは本文に出さない）
  - `抑止: アクションN（担当名）：理由`
  - `別名辞書：v<内容ハッシュ>／通知有効|無効`
- 「確認して投稿」画面にも同じ要約を表示し、投稿される本文のプレビューと通知対象が一致することを確認できる。
- 実Guildでの試験は、テスト用フォーラム/隔離環境で**明示許可された場合のみ**行う。本番フォーラムへ
  テスト投稿・テストメンションをしない。

### 5.1 実Guild dry-run手順（辞書は enabled:false のまま・送信なし）

本番の担当IDを辞書へ入れた直後は、**必ず `notificationDefaults.enabled:false` のまま**dry-runで
「どの名前がどの担当として解決されるか」「どの理由で通知が抑止されるか」を確認する。
この段階ではDiscord送信もメンション通知も行わず、`checkMembership:false` でGuild APIも呼ばない。

**前提**
- 辞書は `config/waigaya-member-aliases.json`（git管理外）。`verified:true` は管理者が実GuildでIDを確認した後。
- 状態JSONはローカルのみに置く（実会議本文を含むため、リポジトリ・チャット・Issue・外部へ出さない）。
  本番DBは読み取り専用。**本番DBをコピー・変更しない**。合成データか、許可されたローカルテストDBを使う。
- まずアプリ内の `/waigaya minutes` プレビュー（ephemeral・送信なし）で、
  `担当メンション：通知対象なし（辞書で通知が無効）。` と `- 抑止: アクションN（担当名）：理由` が出ることを確認する。
  ここで辞書の読込可否と辞書版（`別名辞書：v<内容ハッシュ>／通知無効`）が分かる。

**CLIで解決結果（`resolution`）まで確認する例**

辞書（`enabled:false` のまま。以下はダミーID・ダミー別名）:

```json
{"schemaVersion":1,"guildId":"123456789012345678",
 "notificationDefaults":{"enabled":false,"mentionOnlyExplicitAssignees":true,
                         "mentionProposedAssignees":false,"suppressRepeatMentions":true},
 "members":[
  {"userId":"111111111111111111","usernameHint":"user_a","displayNameHint":"担当者A","aliases":["担当者A"],"verified":true,"enabled":true},
  {"userId":"222222222222222222","usernameHint":"user_b","displayNameHint":"担当者B","aliases":["担当者B"],"verified":true,"enabled":true},
  {"userId":"333333333333333333","usernameHint":"user_c","displayNameHint":"担当者C","aliases":["担当者C"],"verified":false,"enabled":false}
 ]}
```

状態JSON（合成例。`work/dryrun-state.json` 等のgit管理外へ）:

```json
{"state":{"id":"dryrun","guildId":"123456789012345678",
  "utterances":[
    {"id":"u1","revision":1,"text":"担当者Aさんが確認してください。","final":true,"source":"discord"},
    {"id":"u2","revision":1,"text":"担当者Bさんに聞いてみようか？","final":true,"source":"discord"},
    {"id":"u3","revision":1,"text":"担当者Cさんが確認してください。","final":true,"source":"discord"}],
  "publications":[],"minutesHistory":[]},
 "version":{"version":1,"kind":"minutes","metadata":{},"confirmedDecisions":[],
  "document":{"schemaVersion":2,"overview":[],"discussionTopics":[],"decisionCandidates":[],
    "openIssues":[],"keyFacts":[],
    "actionItems":[
      {"text":"確認する。","owner":"担当者A","deadline":null,"assignment":"explicit","evidence":[{"utteranceId":"u1","revision":1}]},
      {"text":"聞いてみる。","owner":"担当者B","deadline":null,"assignment":"proposed","evidence":[{"utteranceId":"u2","revision":1}]},
      {"text":"未検証の担当。","owner":"担当者C","deadline":null,"assignment":"explicit","evidence":[{"utteranceId":"u3","revision":1}]}]}}}
```

実行（リポジトリルートで。`enabled:false` のためDiscord送信・Guild API呼び出しはない）:

```bash
export WAIGAYA_MEMBER_ALIASES_FILE=config/waigaya-member-aliases.json
export WAIGAYA_DRYRUN_STATE_FILE=work/dryrun-state.json

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { loadAliasDictionary, describeMentionPlan, mentionPlanPreview } from "./src/discord/owner-mentions.js";
const { state, version } = JSON.parse(readFileSync(process.env.WAIGAYA_DRYRUN_STATE_FILE, "utf8"));
const { dictionary, error } = loadAliasDictionary();
if (!dictionary) { console.log("辞書を読み込めません:", error); process.exit(0); }
const plan = describeMentionPlan(state, version, dictionary, {
  guildId: state.guildId,
  checkMembership: false, // enabled:false の dry-run ではGuild APIを呼ばない
  now: 0,
});
console.log(mentionPlanPreview(plan));
console.log(JSON.stringify(plan.actions.map(action => ({
  actionIndex: action.actionIndex,
  assignment: action.assignment,
  owner: action.owner,
  resolution: action.resolution,
  notify: action.notify,
  suppressReason: action.suppressReason,
  ownerUserId: action.ownerUserId ? "****" + action.ownerUserId.slice(-4) : null,
})), null, 2));
'
```

上記の合成例で実際に得られる出力（2026-11-06にローカルで確認）:

```
担当メンション：通知対象なし（辞書で通知が無効）。
- 抑止: アクション1 （担当者A）：辞書で通知が無効
- 抑止: アクション2 （担当者B）：担当候補の提案のみ
- 抑止: アクション3 （担当者C）：管理者がIDを未検証
別名辞書：v0eb1ec2d721392fb／通知無効
[
  {"actionIndex":0,"assignment":"explicit","owner":"担当者A","resolution":"resolved","notify":false,"suppressReason":"notifications_disabled","ownerUserId":"****1111"},
  {"actionIndex":1,"assignment":"proposed","owner":"担当者B","resolution":"assignment_proposed","notify":false,"suppressReason":"assignment_proposed","ownerUserId":null},
  {"actionIndex":2,"assignment":"explicit","owner":"担当者C","resolution":"unverified","notify":false,"suppressReason":"unverified","ownerUserId":"****3333"}
]
```

**確認ポイント**
- `resolution:"resolved"` の担当だけが「辞書で一意に解決できた」候補。
  `unregistered` / `ambiguous` / `unverified` / `disabled` / `guild_mismatch` / `identity_mismatch` は通知対象外
  （理由が日本語で表示される）。
- `assignment` が `proposed` / `none` / `conflict` のアクションは、名前が解決できても通知対象外
  （辞書が `enabled:false` の間は、通知対象になり得る明示担当も `notifications_disabled` で抑止される）。
- `ownerUserId` はマスク（下4桁）で表示される。期待する人と一致するか表示名と下4桁で確認する。不一致なら辞書を修正する。
- 出力・状態JSON・辞書に含まれる実会議本文・実ユーザーIDは、画面共有・チャット・Issueへ貼らない。

**Guild在籍・username照合まで確認する場合（任意・管理者の明示許可がある隔離Guildのみ）**
- `enabled:true` / `verified:true` にした**テスト用Guild専用の辞書**で、`/waigaya minutes` プレビュー
  （`checkMembership:true` 経路）を確認する。本番Guildでは先に有効化しない。
- 本番フォーラムへのテスト投稿・テストメンションは禁止。実送信が必要な受け入れ試験は、テスト用フォーラムで
  明示許可された場合だけ行う。
- 通知を有効化した後も、投稿前の「確認して投稿」画面で通知対象・根拠・抑止理由を再確認できる。

### スナップショット（公開記録）

`state.publications[].mentions` に保存する（旧記録は`null`補完。後方互換）。

```json
{
  "schemaVersion": 1,
  "guildId": "...",
  "dictionaryVersion": "内容ハッシュ16桁",
  "resolvedAt": 1234567890,
  "enabled": true,
  "reason": null,
  "allowedUserIds": ["..."],
  "actions": [{
    "actionIndex": 0,
    "assignment": "explicit",
    "owner": "議事録上の担当文字列",
    "displayName": "辞書の表示名",
    "ownerUserId": "...",
    "resolution": "resolved",
    "suppressReason": null,
    "notify": true,
    "notified": true,
    "notifiedAt": 1234567890,
    "assignmentEvidence": {"utteranceId": "...", "revision": 1},
    "evidence": [{"utteranceId": "...", "revision": 1}],
    "utteranceIds": ["..."],
    "textDigest": "actionTextの正規化ハッシュ"
  }]
}
```

- `publication_reserve` の `mentions` は**送信前の候補**。サーバー側（`applyPublication`）で二重通知抑止を
  最終適用してから保存する。
- `publication` の `notifiedUserIds` は**本文に実在したトークンのみ**。検証に通った分だけ`notified:true`にする。
- `publication_link`（照合で復旧）は「配信済みの可能性」を優先し、`notify:true`のエントリを通知済みとして
  記録して以後の再通知を抑止する。
- `normalizePublications()` は起動時・保存時に形を正規化する（旧記録は`mentions:null`）。

---

## 6. 障害復旧

| 症状 | 挙動 | 対応 |
|---|---|---|
| 辞書ファイルが無い/壊れている | 起動時に警告ログ（ID・パス以外の秘密は出さない）。通知しない | `WAIGAYA_MEMBER_ALIASES_FILE` を確認し、サンプルを基に実ファイルを作成 |
| `notificationDefaults.enabled=false` | 本文表示のみ・通知しない | 管理者が`verified/enabled`を確認してから`enabled:true`へ |
| Guildメンバー取得不可・在籍不明 | その担当は未解決（通知しない） | BotのGuild権限・Intent・接続を確認。不明のまま通知しない |
| 辞書のusernameHintと実username不一致 | `identity_mismatch`で通知しない | 実Guildのusernameを確認して辞書を更新（IDの取り違え防止） |
| 投稿後に結果保存が失敗（送信結果不明） | `needs_reconciliation`。スナップショットは`notified:false`のまま、以後の版でも不明扱いで抑止 | `/reconcile` で投稿を照合（`publication_link`で通知済み扱いにして再送しない）。未送信が確認できた場合のみ再試行 |
| メンション計画の内部エラー | 投稿は止めず、通知なしで続行（`mention_plan_failed`相当） | ログを確認。辞書を無効化して安全側運用に切替可能 |
| 原発言の訂正で根拠revisionが変化 | 旧根拠は失効。新議事録版を生成し、旧通知記録は改ざんしない（不明扱いで抑止） | 必要なら管理者が新規割当として再確認（自動では再通知しない） |

- 実送信の有無が不明なときは**勝手に再送しない**（既存の投稿予約・照合・再送禁止の要件どおり）。
- 通知の失敗で会議記録・議事録本文を失わない。本文と添付は保持する。

---

## 7. ロールバック

1. **通知だけ止める（最短）**: `notificationDefaults.enabled` を`false`にする、または
   `WAIGAYA_MEMBER_ALIASES_FILE` を未設定/空にしてBotを再起動。本文表示・投稿は従来どおり。
2. **辞書だけ戻す**: 変更前の辞書ファイルへ差し替え。`dictionaryVersion`が変わるため、以後の通知判定は
   新しい版で行われる（過去の公開記録は不変。過去分の再通知はしない）。
3. **コードを戻す**: `src/discord/owner-mentions.js` を削除し、`minutes-publication.js`/`publication.js`/
   `bot.js` を旧版へ戻す。公開記録の`mentions`は未知フィールドとして無視されるだけで、既存の
   予約・照合・再送防止・版管理には影響しない（`normalizePublications`は`mentions:null`補完のみ）。
   `allowedMentions`が`{parse:[]}`に戻るため、通知は完全に止まる。
4. 旧DBのまま再起動しても、`mentions`を持つ記録はそのまま読める（非破壊）。DBマイグレーションは不要。
5. 実送信結果が不明な記録が残っている場合は、ロールバック後も `/reconcile` で照合してから再投稿する。

---

## 8. テスト

ネットワーク・実Discordなしで完結する（ダミーsnowflakeのみ使用）。

- `test/owner-mentions.test.js`
  - 限定正規化・完全一致・部分一致禁止、辞書の未設定/破損/schema違い/不正ID
  - 辞書版の内容ハッシュ、別名衝突・未検証・無効・他Guild・在籍不明・username不一致
  - Guildメンバーの個別照合（取得不可/不明/照会失敗の区別）、自己申告のuserId検証
  - 担当分類（明示/提案/過去の言及/否定/矛盾/自己申告）
  - **D5の14ケース**（通知可否・解決ID・抑止理由）
  - v1非通知、根拠失効・欠落、根拠先頭発言に担当名が無い場合
  - 二重通知抑止（already_notified / prior_delivery_unknown / prior_revision_changed / prior_state_unknown /
    failed_confirmed再通知可 / 訂正版の新規割当のみ通知）
  - `notifiedUserIds`の部分集合検証（fail-closed）、スナップショット再現性、dry-runプレビュー
- `test/publication-mentions.test.js`
  - v1/v2の`shortMinutes`描画（議論の要点・カテゴリ・担当状態・2000字制限・`@everyone`/`<@id>`/`<@&id>`無害化）
  - トークンと`allowedMentions.users`の双方向一致、allowlist外トークンの除去
  - 辞書無効/未検証/曖昧/他Guild/Guild照合不可で通知なし（従来の`{parse:[]}`）
  - 訂正版で既通知を抑止し新規割当のみ通知、根拠訂正・旧形式・照合復旧時の再通知抑止
  - 切り捨て時の通知抑止と「担当者特定不可」フォールバック
  - 送信後報告のfail-closed、dry-run要約、旧記録の後方互換
- `test/forum-runtime.test.js`: v1/v2の編集UI（`wg:item`は`path`、v2の`discussionTopics` entry編集）
- 既存の安全テスト（`test/forum.test.js`, `test/fixed.test.js`, `test/fixed-runtime.test.js`,
  `test/fixed-recovery.test.js`, `test/runtime-faults.test.js`）を維持。

実行例（変更したテストだけ実行する）:

```bash
node --test test/owner-mentions.test.js test/publication-mentions.test.js
node --test test/forum.test.js test/forum-runtime.test.js test/fixed.test.js
```

---

## 9. 既知の制約・未測定

- **実Guild・実Discord送信・実メンション通知は未実施**（本作業では禁止）。通知の実到達、モバイル表示、
  サーバー通知設定は未測定。
- 実会議の別名（呼び名）の網羅性・誤解決率は未測定。実データでの精度確認には、同意を得た隔離Guildでの
  受け入れ試験が必要。
- 辞書の`usernameHint`は可変。username変更時は`identity_mismatch`で通知が止まる（安全側）。運用で辞書更新が必要。
- 担当分類は決定的なヒューリスティック（明示/提案/過去/否定/矛盾）。口語の複雑な照応・皮肉・多重否定は
  取りこぼす可能性があり、その場合は「通知しない」側に倒れる（誤通知より抑止を優先）。
- `mentionProposedAssignees:true`（提案への通知）は未実装。既定`false`のまま運用する。
- Discord APIの`allowed_mentions.users`上限・投稿長は、本文長制限（1900字）と最大8アクションの範囲で
  余裕がある想定だが、実測はしていない。
- 実会議本文・実ユーザーID・実snowflakeはコード・テスト・本書に含めない（ダミー値のみ）。
