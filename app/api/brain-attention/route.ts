import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { loadAttentionMap } from "@/app/lib/brain-attention-server";

// お客様一覧の画面（app/customers/page.tsx）の「要対応」と並びの元（読むだけ）。
// 2026-10-08 竹内さん「その形でおねがい」: 要対応＝ブレインの判断（AIX要対応 pending・今の AIX・物件出しの約束）＋手で付けた印、
//   並び＝AIX要対応 → ①内覧済み ②審査落ち → ③新規 → ④物件検索中（会話の画面・グループのターゲット一覧と同じ brain-attention の判定）
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await loadAttentionMap(supabase);
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
