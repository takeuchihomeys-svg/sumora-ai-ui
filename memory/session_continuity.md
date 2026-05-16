---
name: セッション継続性ドキュメント（sumora-ai-ui 物件出しツール）
description: セッションをまたいで作業文脈を引き継ぐための最重要ファイル。毎セッション開始時に読み、終了時に更新する
type: project
---

# sumora-ai-ui（物件出しツール）セッション継続

## プロジェクト概要

- **リポジトリ**: `sumora-ai-ui`（`C:\Users\竹内 悠馬\sumora-ai-ui`）
- **役割**: 物件探し中のお客様の条件管理・物件候補送付履歴・新規問い合わせ〜申込前の顧客一覧を管理する独立ツール（#41 物件出しツール部長が担当）
- **審査管理ツール**（sumora-screening-admin）とは別プロジェクト。申込後は審査ツールに転送する
- **Vercel URL**: 未確認（要確認）

## 技術スタック

- Next.js App Router（TypeScript）
- Tailwind CSS
- Supabase（接続設定済み: `app/lib/supabase.ts`）
- Vercel デプロイ

## 現在のプロジェクト状態（2026-05-17 時点）

### 実装済みのファイル構成

```
app/
  page.tsx               ← メインページ（LINEチャット系UI が実装されている状態）
  layout.tsx
  globals.css
  favicon.ico
  components/
    AixModal.tsx         ← AIXアクションモーダル
    BottomNav.tsx        ← ボトムナビ
    TemplateModal.tsx    ← テンプレートモーダル
  lib/
    notifications.ts    ← PWA通知
    supabase.ts         ← Supabase接続
    templates.ts        ← テンプレート定義
  calendar/             ← カレンダーページ（詳細未確認）
```

### 注意点
- `app/page.tsx` はLINEチャット系UIとして実装されている（物件出しツール専用UIはまだこれから）
- メモリ注入APIは正常動作確認済み（文字化け対処法: `Invoke-WebRequest` + `RawContentStream.ToArray()`）

## セッション履歴

### 2026-05-17 セッション1（初回）
- session_continuity.md と MEMORY.md を sumora-ai-ui 用に初期作成
- プロジェクトの初期ファイル構成を確認

### 2026-05-17 セッション2（現在）
- 別のClaude Codeからの引き継ぎ指示を受けて開始
- 記憶注入API（/api/memory/inject）の動作確認・文字化け対処法を確立
- VSCodeターミナルとのリンク確認済み
- プロジェクト内のファイル構成を詳細確認
- session_continuity.md・MEMORY.md を現状に合わせて更新（本作業）

## 次にやること

- 竹内悠馬から今日の作業指示を受ける
- 必要に応じてプロジェクトの現状ページをさらに詳細確認する

## 保留・持ち越し事項

- Vercel URLの確認（デプロイ状況）
- 物件出しツールとして必要な機能の開発方針確定

## セッション引き継ぎ用コマンド（次のClaude Codeに渡す）

```powershell
# 1. 竹内AI記憶注入
$headers = @{ "x-cron-secret" = "hasu-cron-secret-2024" }
Invoke-RestMethod -Uri "https://sumora-screening-admin.vercel.app/api/memory/inject" -Headers $headers

# 2. 以下をテキストで伝える
# このプロジェクトは sumora-ai-ui（物件出しツール）です。
# session_continuity.md と MEMORY.md を物件出しツール用にリセットしてください。
```
