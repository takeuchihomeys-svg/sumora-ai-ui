# #42 見積書ツール部署 倉庫

> 更新者: #42-W / 最終更新: 2026-05-31

---

## 現在の機能状態（ベースライン）

| 機能 | 状態 | 担当ファイル |
|------|------|------------|
| AI画像読み取り（OCR） | ✅ 稼働中 | extract-estimate-info/route.ts |
| 手動入力モード | ✅ 稼働中 | estimate/page.tsx |
| Excel ダウンロード | ✅ 稼働中（Vercel対応済み） | fill-estimate/route.ts |
| LINE用テキスト生成 | ✅ 2026-05-31 追加 | estimate/page.tsx (generateLineText) |
| 特別割引 常時表示 | ✅ 2026-05-31 追加 | estimate/page.tsx |
| 仲介手数料→消費税 自動計算 | ✅ 2026-05-31 追加 | estimate/page.tsx (updateItem) |
| アカウント別手数料デフォルト | ✅ スモラ:2980円 / 他:0円 | estimate/page.tsx |
| 見積書履歴 | ❌ 未実装（APIはある） | generate-estimate/route.ts (GET) |
| 顧客名の自動引き継ぎ（LINEから） | ❌ 未実装 | — |

---

## アカウント設定（変更禁止・スモ山確認必須）

| アカウント | 仲介手数料（税抜） | 消費税 | テンプレートファイル |
|-----------|-----------------|--------|------------------|
| スモラ | ¥2,980 | ¥298 | sumora-estimate.xls |
| イエヤス | ¥0 | ¥0 | ieyasu-estimate.xls |
| ギガ賃貸 | ¥0 | ¥0 | giga-estimate.xls |

---

## 過去バグ記録（#42-LN 蓄積）

### バグ1: 仲介手数料を0にしても消費税が残る
- **日付**: 2026-05-31 修正済み ✅
- **原因**: `updateItem("commission", 0)` が `commissionTax` を連動更新していなかった
- **修正**: `updateItem()` 内で `commission` 変更時に `commissionTax = Math.round(value × 0.1)` を自動設定
- **教訓**: 税抜・消費税の2フィールドは常にセットで更新する。片方だけ変えると乖離が生まれる
- **次回の予防**: 金額×税率のフィールドペアを新設する場合は必ず `updateItem()` の連動処理を追加する

### バグ2: Vercel本番でExcelテンプレートが見つからない
- **日付**: 2026-05-XX 修正済み ✅
- **原因**: Vercel Serverless では `process.cwd()` が `/var/task` になりパスが変わる
- **修正**: `findTemplatePath()` で複数候補パスを試す + `outputFileTracingIncludes` でバンドル指定
- **教訓**: Next.js API Routes でのファイル読み込みは複数パス候補を持つこと
- **次回の予防**: テンプレート追加時は `findTemplatePath()` の候補パスを確認してから追加する

---

## 設計上の重要な仕様（罠に注意）

### toEditable() は初期化専用
`toEditable(extractedData, account)` は AI抽出後の初期化にのみ使用する。
ユーザーが編集した後に再呼び出し **禁止**。ユーザー編集は `updateItem()` が正とする。

```
AI抽出 → toEditable() で初期化（commission=0→デフォルト適用）
         ↓
         ユーザーが commission を手動変更 → updateItem() で state 更新
         ↓ ← ここで toEditable() を再度呼ぶとユーザー編集が消える（禁止）
```

### 2つのAPIの使い分け

| API | 用途 | 入力形式 |
|-----|------|---------|
| `fill-estimate` | Excelテンプレート埋め込み | 全項目（金額絶対値） |
| `generate-estimate` | 計算＋LINE文＋DB保存 | 家賃×ヶ月数方式 |
| `extract-estimate-info` | 画像OCR抽出 | 画像/PDF base64 |

現在のUIは **fill-estimate** を使用。generate-estimate の LINE文章生成はUIに未接続（代わりにclient-side generateLineText()を使用）。

### generateLineText() の節約額計算
```typescript
standardCommission = rent × 1.1  // 業界標準1ヶ月+税
actualCommission = commission + commissionTax
savings = Math.max(0, standardCommission - actualCommission) + discountAmount
```
節約額がマイナスにならないよう `Math.max(0, ...)` を使用。

---

## プロンプト記録（#42-PR 管理）

### extract-estimate-info systemPrompt
- **最終更新**: セッション初期設定時
- **精度の懸念点**: 仲介手数料が税込で書かれている場合、AIが税抜/消費税を正しく分離できないことがある（プロンプトに「÷1.1で税抜計算」と指示済みだが精度にばらつき）

### generateLineText() ACCOUNT_SAVINGS_TEMPLATE
```
スモラ:  "スモラなら一般的な不動産業者より{n}円節約出来ます！！"
イエヤス: "イエヤスなら一般的な不動産業者より{n}円節約出来ます！！"
ギガ賃貸: "ギガ賃貸なら一般的な不動産業者より{n}円節約出来ます！！"
```
- **最終更新**: 2026-05-31

---

## 実装履歴

| 日付 | 変更内容 | 担当 |
|------|---------|------|
| 2026-05-31 | LINE用テキスト生成ボタン・モーダル追加 | #42-SZ |
| 2026-05-31 | 特別割引の常時表示行を追加 | #42-SZ |
| 2026-05-31 | アカウント別仲介手数料デフォルト追加（スモラ2980円） | #42-SZ |
| 2026-05-31 | 仲介手数料変更時の消費税自動計算バグ修正 | #42-SZ |
| 2026-05-31 | 手動入力ボタン追加（makeBlankItems） | #42-SZ |
| 2026-05-31 | Vercel対応: findTemplatePath()・outputFileTracingIncludes | #42-SZ |
| 2026-05-31 | Excel書き出し: setCellValue の !ref 拡張 | #42-SZ |

---

## 未完了タスク・次回優先事項

| 優先 | タスク | 備考 |
|------|--------|------|
| 高 | 見積書履歴一覧UI | generate-estimate GET は完成済み・UIのみ |
| 中 | 入居日未入力の警告表示 | moveInDate空のとき日割りが全部0になるが警告なし |
| 低 | LINEからの顧客名自動引き継ぎ | #41物件出しツールとの連携が必要 |

---

## 引き継ぎ事項

- **2026-05-31**: 見積書ツールの主要機能が完成。Excel+LINEテキストの二本柱が揃った
- `estimates` テーブルへの書き込みは `generate-estimate` API が担当しているが UIからは未接続
- Vercel本番環境でのExcelエラーが修正済みだが、実際に本番で確認はまだ
