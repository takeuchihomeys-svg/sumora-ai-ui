# #42 見積書ツール部署 倉庫

> 更新者: #42-W / 最終更新: 2026-06-03

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
| Excel書式・画像・キャラ完全保持 | ✅ 2026-06-03 完成 | fill-estimate/route.ts（exceljs移行） |
| Excel節約金額 動的書き換え | ✅ 2026-06-03 完成 | fill-estimate/route.ts（drawing2.xml/JSZip） |
| Step1 入居日選択→日割り自動計算 | ✅ 2026-06-03 完成 | estimate/page.tsx |
| 月初（1日）入居は日割りなし | ✅ 2026-06-03 完成 | estimate/page.tsx |
| その他費用 プレビュー編集可能 | ✅ 2026-06-03 完成 | estimate/page.tsx |
| 作成日を今日の日付で自動セット | ✅ 2026-06-03 完成 | estimate/page.tsx |
| お客様名をExcel B3に書き込み | ✅ 2026-06-03 完成 | fill-estimate/route.ts |
| 翌月水道費をExcelに反映 | ✅ 2026-06-03 完成 | fill-estimate/route.ts |
| その他費用は税込金額をそのまま反映 | ✅ 2026-06-03 完成 | fill-estimate/route.ts（÷1.1しない） |
| 家賃変更時に翌月家賃も連動 | ✅ 2026-06-03 完成 | estimate/page.tsx |
| 賃貸保証料率（%）入力→自動計算 | 🚧 実装中（未コミット） | estimate/page.tsx (guaranteeRate) |
| 0円項目の非表示（UI・Excel） | ✅ 2026-07-22 完成 | estimate/page.tsx + fill-estimate/route.ts |
| 火災保険0円→「別途支払い」表示 | ✅ 2026-07-22 完成 | estimate/page.tsx + fill-estimate/route.ts |
| 毎月費用/初回費用の区切り行 | ✅ 2026-07-22 完成 | estimate/page.tsx + fill-estimate/route.ts |
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

## テンプレートファイル形式（重要）

**2026-06-03 に .xls → .xlsx に完全移行済み**

| アカウント | ファイル名 | 形式 |
|-----------|-----------|------|
| スモラ | sumora-estimate.xlsx | xlsx（exceljs対応） |
| イエヤス | ieyasu-estimate.xlsx | xlsx（exceljs対応） |
| ギガ賃貸 | giga-estimate.xlsx | xlsx（exceljs対応） |

> ⚠️ 旧 .xls ファイルは削除済み。fill-estimate/route.ts の findTemplatePath() は .xlsx を参照している。

---

## 過去バグ記録（#42-LN 蓄積）

### バグ1: 仲介手数料を0にしても消費税が残る
- **日付**: 2026-05-31 修正済み ✅
- **原因**: `updateItem("commission", 0)` が `commissionTax` を連動更新していなかった
- **修正**: `updateItem()` 内で `commission` 変更時に `commissionTax = Math.round(value × 0.1)` を自動設定
- **教訓**: 税抜・消費税の2フィールドは常にセットで更新する。片方だけ変えると乖離が生まれる
- **次回の予防**: 金額×税率のフィールドペアを新設する場合は必ず `updateItem()` の連動処理を追加する

### バグ3: Excel黒画面・画像消える・書式崩れ（2026-06-03 修正済み）
- **原因**: xlsx ライブラリが数式削除時にスタイルを破壊・drawing XML を正しく扱えない
- **修正**: exceljs に完全移行。xlsx→xlsx 変換パイプラインで書式・画像・drawing を保持
- **教訓**: xlsx ライブラリはスタイル保持が不安定。テンプレート操作は exceljs が安全
- **次回の予防**: テンプレートに画像・図形が含まれる場合は必ず exceljs を使う

### バグ4: Excel節約金額・キャラ画像が drawing 競合で消える（2026-06-03 修正済み）
- **原因**: drawing ファイルを新規作成すると既存の drawing XML と rId が競合
- **修正**: 既存 drawing XML の rId を保持し Target のみ書き換える方式に変更（JSZip で直接操作）
- **教訓**: Excel の drawing 操作は既存 rId を必ず保持する。新規作成禁止
- **次回の予防**: 節約金額を書き換える場合は drawing2.xml の `r:id` を読んでから Target だけ変える

### バグ5: その他費用を÷1.1して税抜計算していた（2026-06-03 修正済み）
- **原因**: fill-estimate で otherItems の金額を税抜扱いで ÷1.1 していた
- **修正**: その他費用は税込金額をそのまま Excel に書き込む（÷1.1しない）
- **教訓**: otherItems はユーザーが入力した税込金額。commission 系とは別扱い

### バグ6: 月初（1日）入居なのに日割りが発生する（2026-06-03 修正済み）
- **原因**: moveInDay=1 でも proratedDays の計算が走っていた
- **修正**: moveInDay <= 1 のとき proratedDays=0 で確定（Excel と同じ挙動）
- **教訓**: 1日入居 = 日割りなし がルール。calcProratedDays() の先頭で必ずチェック

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
| 2026-07-22 | 0円項目非表示: UIプレビュー・画像化・Excel（E11〜E14/E28/E29は0のとき空欄）。仲介手数料・消費税・賃貸保証料の alwaysShow を削除 | #42-W |
| 2026-07-22 | Excel行25（抗菌施工費/アクト安心ライフ=cleaningフィールド）: 0円のときB25/E25/F25を空欄化。行26（賃貸保証料）も同様 | #42-W |
| 2026-07-22 | 火災保険（insurance・Excel行27）: 0円のときUI/画像/Excelとも「別途支払い」とテキスト表示 | #42-W |
| 2026-07-22 | 毎月費用（日割り・翌月水道代）と初回のみ費用（鍵交換代等）の間に区切り: UIは破線行、Excelは動的行15〜24内に空行1行 | #42-W |
| 2026-06-03 | exceljs移行・Excel黒画面・書式崩れ・画像消えを根絶 | #42-SZ |
| 2026-06-03 | Excel節約金額を drawing2.xml + JSZip で動的書き換え | #42-SZ |
| 2026-06-03 | drawing rId 保持方式に変更・キャラ画像消えを修正 | #42-SZ |
| 2026-06-03 | Step1に入居日選択欄追加・Step2に引き継ぎ | #42-SZ |
| 2026-06-03 | 月初（1日）入居は日割りなし・二重払い防止 | #42-SZ |
| 2026-06-03 | その他費用 プレビュー編集可能に・追加直後に編集欄表示 | #42-SZ |
| 2026-06-03 | 作成日を今日の日付で自動セット | #42-SZ |
| 2026-06-03 | お客様名を Excel B3 に書き込み・M9 #REF! クリア | #42-SZ |
| 2026-06-03 | 翌月水道費を Excel に反映 | #42-SZ |
| 2026-06-03 | その他費用は税込金額をそのまま反映（÷1.1しない） | #42-SZ |
| 2026-06-03 | 家賃変更時に翌月家賃も連動 | #42-SZ |
| 2026-06-03 | テンプレートを .xls → .xlsx に完全移行 | #42-SZ |
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
| 🚧 最優先 | 賃貸保証料率（%）→自動計算の実装完了 | 未コミット・guaranteeRate フィールドは追加済み。updateItem() での自動計算ロジック・Excel書き込みが未完 |
| 高 | 見積書履歴一覧UI | generate-estimate GET は完成済み・UIのみ |
| 低 | LINEからの顧客名自動引き継ぎ | #41物件出しツールとの連携が必要 |

---

## 引き継ぎ事項

- **2026-06-03**: Excel周りを exceljs に完全移行。書式・画像・節約金額・キャラクター画像が全て正しく出力される状態になった
- **2026-06-03**: テンプレートファイルを .xls → .xlsx に移行済み。`findTemplatePath()` は .xlsx を参照している
- **2026-06-03**: 賃貸保証料率（%）入力→自動計算機能を実装中（未コミット）。`guaranteeRate` フィールドと `PERCENT_KEYS` は追加済みだが、`updateItem()` の連動ロジックと `fill-estimate` への反映が未完
- `estimates` テーブルへの書き込みは `generate-estimate` API が担当しているが UIからは未接続
