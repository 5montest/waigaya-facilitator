# 資料一覧

普段の使い方は [Discord利用マニュアル](user-manual.md) を参照する。動作条件の詳細は [Discord版の現行仕様](../discord-spec.md)、管理者の導入手順は [設定手順](../discord-setup.md) に記載している。

| 資料 | 内容 | HTML版 |
|---|---|---|
| [Discord利用マニュアル](user-manual.md) | 開始・声の質問・自動終了／投稿、訂正、困ったときの操作 | — |
| [2026年10月13日の実環境検証](live-validation-20261013.md) | 合成音声の実API、VC送信、フォーラム投稿、修正した使いにくさ | — |
| [改善実装の差分](improvement-report.md) | 固定VC・音声呼びかけ・自動退出／投稿、互換性、制約 | — |
| [実通話の受け入れチェック](manual-acceptance.md) | 開始一回・声の応答・全員退出・未確認公開・復旧の手動確認 | — |
| [全体設計](ai-waigaya-design.md) | 継続的な会話状態、発言制御、段階的な実装方針 | [HTML](ai-waigaya-design.html) |
| [デバイス選定](ai-waigaya-devices.md) | PC・スマホ・Jetsonと処理の配置 | [HTML](ai-waigaya-devices.html) |
| [モデル選定](ai-waigaya-models.md) | 他社も含む品質・費用の比較とOpenAIのみのMVP | [HTML](ai-waigaya-models.html) |
| [LAN設定](lan-setup.md) | 現在のIP・HTTPS・キー設定 | — |
| [検証記録の要約](validation.md) | 今回の自動テスト、保存・配信ベンチマーク、過去の接続確認 | — |

全体設計・選定資料は2026年10月7〜8日の検討資料で、未実装の構想も含む。現行Discord版の仕様と異なる場合は現行仕様を参照する。モデルの料金・提供状況は資料作成時点の情報である。

検証の元ファイルはローカルの `results/` に保存する。会議本文や話者情報を含むためGitHubには載せず、共有する確認結果は要約にまとめている。
