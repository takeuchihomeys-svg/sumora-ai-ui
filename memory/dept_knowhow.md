---
name: 売上番長 #22 倉庫
description: Sumoraプロジェクト群の技術ノウハウ・設計パターン・チーム構成の蓄積。物件出しツール等の売上直結機能アイデアも管理。新プロジェクト立ち上げ時の参照用。
type: reference
originSessionId: 6727b3b0-9e5d-4101-a578-0d80233cfd6b
---
# 売上番長 #22 倉庫

最終更新: 2026-05-03

---

## 0. 物件出しツール 機能アイデア（2026-05-03 竹内AI・スモ山より）

新ツール（物件出し管理ツール）の機能要件。フェーズ別に整理済み。

### フェーズ1（必須コア）
| # | 機能 | 概要 |
|---|------|------|
| ① | 条件カード一覧 | 1顧客1カード。エリア・賃料・間取り・こだわり・NGポイントを開かずに全部見える |
| ② | 対応優先度の色分け | 🔴今日必須（新規・返信待ち）/ 🟡明日でもOK（探し中・見学希望）/ ⚪完了 |
| ③ | 物件候補メモ欄 | 「この物件確認中」「△△には送済み」を残す。担当変わっても引き継ぎ即完了 |
| ④ | 担当者アサイン | 誰がこのお客さんを持っているか明示。複数アカウント・複数スタッフで混線しない |

### フェーズ2（効率化）
| # | 機能 | 概要 |
|---|------|------|
| ⑤ | 朝のLINE自動通知 | 「今日対応すべき顧客〇名・内容リスト」を毎朝自動送信（Cronジョブ） |
| ⑥ | 条件フォーマットAI自動解析 | LINEで来た条件文をAIがカードに自動変換。入力作業ゼロを目指す |
| ⑦ | 送付物件の履歴記録 | どの物件URLをいつ送ったか記録。同じ物件を2回送るミスをなくす |

### フェーズ3（連携・拡張）
| # | 機能 | 概要 |
|---|------|------|
| ⑧ | 審査ツールとの連携 | 物件出し → 気に入った → 審査申込へそのまま流せる。入力二度手間なし |

### LINEリッチメニュー（4ボタン構成）
1. ① 物件条件入力（基本条件＋追加条件）
2. ② 見積書作成
3. ③ 物件条件一発表示
4. ④ 売上番長ボタン

### 自動引き継ぎルール
- ✅チェック済み → 3日連絡なければ自動完了
- 見学希望 → 翌日も一覧に残す
- 物件なし☑ → 翌日も一覧に残す
- 新規問い合わせ → 常に一番上に表示

---

## 1. チーム構成・プロジェクト立ち上げ

### AGENTS.md 雛形
- `sumora-screening-admin/AGENTS.md` が最新の雛形
- 新プロジェクトはそのままコピーして使う
- プロジェクト固有部分（管理ファイルパス・機能説明）だけ書き換える

### 最低限必要な部署（新プロジェクト）
```
#1 統括PM / #2 レビュアー / #3 デザイン担当 / #6 コード倉庫
#7 博士 / #9 デプロイ長 / #18 秘書 / #20 プロンプト担当
#22 共通ノウハウ担当（このファイルを持ち込む）
```

### 新プロジェクト立ち上げチェックリスト
```
□ create-next-app（TypeScript・Tailwind・App Router選択）
□ AGENTS.md コピー & カスタマイズ
□ memory/dept_knowhow.md コピー（ノウハウ持ち込み）
□ .env.local 設定（Supabase・Anthropic・LINE等）
□ Supabase新プロジェクト作成 & テーブル設計
□ Vercel新プロジェクト作成 & 環境変数登録
□ vercel.json 作成（Cronジョブがあれば）
□ npx tsc --noEmit が通る状態で初回コミット
```

---

## 2. Excel / OOXML操作（JSZip）

### 基本パターン
```typescript
// テンプレート読み込み
const resp = await fetch('/templates/xxxx_template.xlsx');
const buf = await resp.arrayBuffer();
const zip = await JSZip.loadAsync(buf);
let s1 = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
let ss = await zip.file('xl/sharedStrings.xml')!.async('text');

// 書き換え後に再セット
zip.file('xl/worksheets/sheet1.xml', s1);
zip.file('xl/sharedStrings.xml', ss);

// ダウンロード
const outBuf = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
const blob = new Blob([outBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
```

### セル書き換え（setCellInXml）
- 文字列 → `t="inlineStr"` + `<is><t>値</t></is>`
- 数値 → `<v>値</v>`
- null/空 → 自己閉じタグ `<c r="XX"/>`
- 既存スタイル（s="数字"）は必ず保持する

### SharedStrings（SS）の注意点
- テンプレートのチェックボックス系（●/□）は sharedStrings のインデックスで管理
- チェック状態の切り替え = SSインデックスの差し替え（テンプレートで事前調査必須）
- 調査スクリプト（check-facilities*.mjs）で `<v>インデックス</v>` の場所を特定してから実装
- 自己閉じセル `<c r="AU34" s="601"/>` が regex の罠になる → `indexOf` で直接検索する

### ぶつかりやすいバグ
- `<c\b([^>]*)>([\s\S]*?)<\/c>` のregexは自己閉じセルで次のセルまでマッチしてしまう
- 解決: `s2.indexOf('<v>インデックス</v>', pos)` で直接位置を特定する

---

## 3. LINE連携

### Webhook受信パターン
```typescript
// 署名検証（必須）
const sig = req.headers.get('x-line-signature');
const body = await req.text();
const hmac = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET!);
hmac.update(body);
const expected = hmac.digest('base64');
if (sig !== expected) return new Response('Unauthorized', { status: 401 });
```

### Push通知
```typescript
await fetch('https://api.line.me/v2/bot/message/push', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
  },
  body: JSON.stringify({
    to: process.env.LINE_PUSH_TARGET_ID,
    messages: [{ type: 'text', text: 'メッセージ' }],
  }),
});
```

### LINEメッセージルール（スモラトーン）
- 書き出し: `〇〇様`
- 末尾: `スモラ 担当`
- 絵文字なし・自然な丁寧語・スマホで読みやすい長さ

---

## 4. Supabase

### 基本構成
```typescript
// lib/supabase.ts
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

### テーブル設計の原則
- `id` は必ず `text` 型（`dt_` + UUID形式 or Supabaseデフォルトのuuid）
- `created_at` / `updated_at` は全テーブルに持たせる
- RLSは本番前に必ず設定する（現状sumora-screening-adminは未設定・要対応）

### CRUD基本パターン
```typescript
// 取得
const { data, error } = await supabase.from('table').select('*').order('created_at', { ascending: false });

// 挿入
const { error } = await supabase.from('table').insert({ ...fields });

// 更新
const { error } = await supabase.from('table').update({ field: value }).eq('id', id);

// 削除
const { error } = await supabase.from('table').delete().eq('id', id);
```

---

## 5. Vercel デプロイ

### 基本コマンド
```bash
vercel --prod          # 本番デプロイ（sumora-screening-adminは常にこれ）
vercel env pull        # 環境変数をローカルに同期
npx tsc --noEmit       # デプロイ前に必ず型チェック
```

### vercel.json（Cronジョブ）
```json
{
  "crons": [
    { "path": "/api/cron/secretary",       "schedule": "0 0 * * *" },
    { "path": "/api/cron/daily-reminder",  "schedule": "0 1 * * *" }
  ]
}
```
- スケジュールはUTC（JST-9時間）
- Cron認証: `Authorization: Bearer ${CRON_SECRET}` をヘッダーで検証

### 必須環境変数テンプレート
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
ANTHROPIC_API_KEY=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
LINE_PUSH_TARGET_ID=
CRON_SECRET=
```

---

## 6. AI連携（Claude API）

### プロンプト設計の原則
- 出力は必ず**JSON固定フォーマット**にする
- systemプロンプトに「禁止事項」を必ず含める
- `max_tokens` を明示する（デフォルトは小さい）
- モデル: `claude-sonnet-4-6`（現時点での推奨）

### 基本パターン
```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const msg = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 2048,
  system: 'システムプロンプト（禁止事項含む）',
  messages: [{ role: 'user', content: 'ユーザー入力' }],
});

const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
const json = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
```

### エラー処理
- JSON.parseは必ずtry/catchで囲む
- API route では `Response.json({ error: '...' }, { status: 500 })` で返す

---

## 7. UI/UXパターン（Tailwind v4）

### カラーパレット
- ベース: `slate` 系
- アクセント: `blue-600`（アクション）/ `emerald-500`（完了）/ `orange-500`（警告）
- アカウントバッジ色は `ACCOUNT_CONFIG`（`lib/status-config.ts`）で一元管理

### コンポーネント規約
- モーダル: `rounded-2xl shadow-2xl max-h-[94vh] overflow-y-auto`
- ボタン: `rounded-lg` / `rounded-xl`（大きいもの）
- 入力欄: `rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500`
- アニメーション: `transition-colors` のみ（過剰なアニメーション禁止）
- `'use client'` が必要なコンポーネントには必ず宣言

### モーダル基本構造
```tsx
<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
  onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
  <div className="flex w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl max-h-[94vh]">
    {/* ヘッダー */}
    {/* スクロールエリア */}
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
    {/* フッター */}
  </div>
</div>
```

---

## 8. コミット・デプロイルール

- コミットメッセージ: 日本語・「何を追加／修正したか」を簡潔に
- デプロイ前: 必ず `npx tsc --noEmit` を通す
- `.env.local` は絶対にコミットしない（`.gitignore` 確認）
- デプロイは常に `vercel --prod`（sumora-screening-adminの場合）

---

## 9. よく使うデバッグ手法

### Excel調査スクリプト（check-facilities*.mjs）
新しいExcelテンプレートを調査するときのパターン:
```javascript
import { readFileSync } from 'fs';
import JSZip from 'jszip';
const buf = readFileSync('public/templates/xxxx_template.xlsx');
const zip = await JSZip.loadAsync(buf);
const ss = await zip.file('xl/sharedStrings.xml').async('text');
const s2 = await zip.file('xl/worksheets/sheet2.xml').async('text');
const siEntries = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)];

// SSインデックス → テキスト
function ssText(idx) {
  return siEntries[idx]?.[0]?.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() || '';
}

// SSインデックスがどのセルにあるか（indexOf方式・regex不使用）
function findSS(idx) {
  const results = [];
  let pos = 0;
  while(true) {
    const vIdx = s2.indexOf(`<v>${idx}</v>`, pos);
    if (vIdx < 0) break;
    const cStart = s2.lastIndexOf('<c ', vIdx);
    const addr = s2.substring(cStart, cStart+80).match(/r="([^"]+)"/)?.[1];
    results.push(addr);
    pos = vIdx + 1;
  }
  return results;
}
```
