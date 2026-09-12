# AIX 構造倉庫 — 変更前に必ず読む

## 概要
AIX は LINE返信画面の右下ボタンから起動するアクションシステム。
メニュー（ボトムシート） → 各アクション固有のモーダル（AixModal.tsx）の2段構成。

---

## 🔒 死守ルール（変更時チェックリスト）

1. **「確認」ボタンは全アイテム共通で必ず表示する**
   - `AIX_INSPECT` に説明が登録されているアイテムは全て「確認」→パネル表示
   - 展開式（内覧へ！）も例外なく「確認」ボタンを持つ
2. **`AixActionType` を追加したら必ず4箇所セットで更新する**
   - `AixModal.tsx`: `AixActionType` union型
   - `AixModal.tsx`: `AIX_TEMPLATES`（ルール＋テンプレート）
   - `AixModal.tsx`: `CONFIG`（title/emoji/requiresImage等）
   - `AixModal.tsx`: `ACTION_TO_STATE`（送信後のステータス）
   - `page.tsx`: `AIX_ACTION_META`（label/color/templateCategory）
   - `page.tsx`: `AIX_INSPECT`（確認パネル用説明）
   - `page.tsx`: メニュー配列（ボトムシートのボタン）
3. **`canGenerate` に新アクション分岐を追加する**（忘れるとボタンが常にグレー）
4. **展開式アイテム（内覧へ！）はメインボタンとは別に「確認」ボタンを維持する**

---

## メニュー構造（page.tsx: showAixMenu ボトムシート）

| ラベル | color | actionType | 起動方法 | 備考 |
|--------|-------|------------|----------|------|
| 物件オススメ | #2196F3 | property_recommendation | openAixWithImagePicker | 画像必須 |
| 物件送る | #00897B | property_send | openAixDirect | |
| 物件確認した | #4CAF50 | property_check_result | openAixDirect | guideToCheckResult時ハイライト |
| 見積書送る | #FF9800 | estimate_sheet | openAixWithImagePicker | 画像必須 |
| 初期費用を説明 | #2E7D32 | cost_explain | openAixDirect | 2026-09-12 追加。報酬・還元額を入力→テンプレ生成（AI不使用） |
| 内覧へ！ | #9C27B0 | — | 展開式トグル | サブメニュー親（直接モーダル開かない） |
| └ 日程調整する | #9C27B0 | viewing_invite | openAixDirect | 内覧へ！のサブ |
| └ 待ち合わせ | #00838F | meeting_place | openAixDirect | 内覧へ！のサブ |
| 申込へ！ | #E53935 | application_push | triggerAixOneTap | ワンタップ生成 |

### 展開state
- `aixViewingExpanded` (boolean): 内覧へ！のサブメニュー開閉
- メニューを閉じる（✕ ボタン）時は `setAixViewingExpanded(false)` も必ず呼ぶ

---

## AixModal.tsx 構造

### アクション別 generate() の処理パターン

| actionType | 生成方法 | API |
|-----------|----------|-----|
| property_recommendation | OCR → Claude API | /api/aix/action |
| property_send | 会話+条件 → Claude API | /api/aix/action |
| viewing_invite | カレンダー+会話 → Claude API | /api/aix/action |
| application_push | 会話 → Claude API | /api/aix/action |
| estimate_sheet | 物件+間取り → Claude API | /api/aix/action |
| property_check_result | パターン選択 → Claude API | /api/aix/action |
| **meeting_place** | **クライアント側テンプレート生成（AI不使用）** | なし |
| **cost_explain** | **クライアント側テンプレート生成（AI不使用・app/lib/cost-explain-text.ts）** | なし |

### cost_explain（初期費用を説明）— 2026-09-12 竹内・あや事例
- 使う場面: 費用の安さを不審に思われた・安い理由を聞かれた時（値引きの相談・金額の質問は別）
- state: `costNoFee`（貸主から手数料なし）/ `costFeeLabel`（家賃1ヶ月分等）/ `costFeeYen` / `costRefundYen`（直近の AIX 見積書の「🌟〇〇円割引」を初期値）/ `costSavingYen`（「より〇〇円節約」を初期値）
- 文: 仕組み（仲介手数料0円・オーナー様からの広告料を還元・金額差は還元の有無）＋具体額（貸主から〇〇円頂き〇〇円を〇〇さんの初期費用に還元・利益も残る）を1通。お客様が仲介手数料に触れていれば「仲介手数料は0円で大丈夫です！！」から
- ブレイン: 場面の証拠 S8_cost_doubt（`customerDoubtsCheapness`）→ 見積書送る/確認します/AIXなし を cost_explain に（decision_source=signal:scene_S8_cost_doubt）
- AIX種別を足す時の登録先の全体像は、この節の上の4箇所セット＋ aix-taxonomy（AIX_STAFF_NOTES がブレインの検査を兼ねる）・brain-core（能力マップ・PHASE_ACTION_CANDIDATES・AIX_LABEL_JP）・action-ledger（AIX_KIND）・log-aix-usage・学習の一覧

### meeting_place 専用state
```
meetingPropertyFile, meetingPropertyPreview  — OCR用画像
meetingPropertyName, meetingPropertyAddress  — OCR結果（手動編集可）
meetingDate   — 必須。直近スタッフメッセージから自動プリセット
meetingTime   — 任意。空 = 時間未定（都合確認文）/ 値あり = 確定文
meetingOcrLoading  — OCR中フラグ
meetingPropertyInputRef  — 画像input ref
```

### 生成文パターン（meeting_place）
**時間あり：**
```
かしこまりました！！
{meetingDate}ご案内させて頂きます！！

{meetingDate}{meetingTime}に{meetingPropertyName}
現地エントランスお待ち合わせで何卒よろしくお願い致します！！
住所: {meetingPropertyAddress}  ← addressが空なら省略
```

**時間未定：**
```
かしこまりました！！
{meetingDate}ご案内させて頂きます！！

{meetingPropertyName}
現地エントランスお待ち合わせのお時間ご都合如何でしょうか！！
住所: {meetingPropertyAddress}  ← addressが空なら省略
```

### 日程自動検出ロジック
`useEffect([actionType])` 内で `recentMessages` の最新スタッフメッセージをスキャン。
正規表現: `/(\d{1,2})[\/月](\d{1,2})(?:日)?(?:[（(]([月火水木金土日])[）)])?/`
- 日程: `mo/day（wd）` 形式で合成
- 時間: `/(\d{1,2})[時:](\d{2})?/` で検出 → HH:MM形式

---

## AIX_INSPECT（確認パネル）の登録

page.tsx の IIFE 内 `AIX_INSPECT` オブジェクト。
**新アクションを追加したら必ずここに説明を追記する。**

現在登録済み: 物件オススメ / 物件送る / 物件確認した / 見積書送る / 初期費用を説明 / 内覧へ！ / 申込へ！ / 待ち合わせ

---

## 過去バグ記録

| 日付 | バグ | 原因 | 教訓 |
|------|------|------|------|
| 2026-06-21 | 内覧へ！の「確認」ボタンが消えた | 展開式に変更時 `{!isViewing && ...}` で確認ボタンを除外した | 展開式でも確認ボタンは全アイテム共通で維持する |
| 2026-06-21 | 待ち合わせボタンがメニューに表示されなかった | Vercel CLIが正常動作せずデプロイが反映されていなかった | `vercel deploy --prod` を使う（`vercel --prod` はプラグインに干渉される） |
