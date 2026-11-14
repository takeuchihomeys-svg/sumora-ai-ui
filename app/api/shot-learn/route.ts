// app/api/shot-learn/route.ts
//
// 2026-11-14 竹内さん「今日のさっきの分読み取る。通常モードでやった分」
//
// なぜ要るか:
//   ⚠ `human_motion_learn` は **RLS 有効**なので、公開キーでは読めない（実測: 0件）。
//     手元のスクリプト（`serverSupabaseKey()` が公開キーに落ちる環境）では
//     **写真を1枚も見つけられなかった**（＝「読む物がありません」）。
//   → **サーバー（Service Role キーがある所）で**写真を探す・読む・書き戻す。
//
// 使い方（ブラウザでも curl でも）:
//   GET  /api/shot-learn?mode=normal&days=1&limit=5&dry=1   … 何枚あるか・読むだけ（書かない）
//   GET  /api/shot-learn?mode=normal&days=1&limit=50        … 実際に読んで書き戻す
//   GET  /api/shot-learn?count=1                           … 数えるだけ（費用0）
//
// ⚠ 費用がかかる（1枚 約0.03円）。**必ず limit で上限**を切る（既定5・最大60）。
// ⚠ 読むのは欄の種類・名前・画面の種類だけ（入力した中身は読ませない）。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { readShotFields } from "@/app/lib/shot-learn-server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = (sp.get("mode") || "").trim();          // normal / aix / （空＝全部）
  const days = Math.max(1, Math.min(30, Number(sp.get("days") || "1")));
  const limit = Math.max(1, Math.min(60, Number(sp.get("limit") || "5")));
  const dry = sp.get("dry") === "1";
  const countOnly = sp.get("count") === "1";

  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let q = supabase
    .from("human_motion_learn")
    .select("id, shot_key, mode, ext_version, shot_taken, shot_learn, created_at")
    .gte("created_at", since)
    .eq("shot_taken", true)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (mode) q = q.eq("mode", mode);
  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: String(error.message).slice(0, 200) }, { status: 500, headers: CORS });
  }
  /**
   * ⚠ `shot_learn` は JSONB。**null の物だけ**を対象にする（もう読んだ物を二度読まない＝費用を無駄にしない）。
   */
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pending = rows.filter((r) => !!r.shot_key && !r.shot_learn);
  const base = {
    ok: true,
    mode: mode || "(全部)",
    days,
    shots_total: rows.length,
    pending: pending.length,
    already_learned: rows.length - pending.length,
  };
  if (countOnly) return NextResponse.json({ ...base, count_only: true }, { headers: CORS });

  const targets = pending.slice(0, limit);
  const out = {
    ...base,
    limit,
    dry_run: dry,
    tried: 0,
    learned: 0,
    saved: 0,
    skipped: 0,
    fields: 0,
    samples: [] as Array<Record<string, unknown>>,
    errors: [] as string[],
  };
  for (const t of targets) {
    out.tried++;
    const key = String(t.shot_key);
    const sl = await readShotFields(key);
    if (!sl) { out.skipped++; continue; }
    out.learned++;
    out.fields += sl.fields.length;
    if (out.samples.length < 3) {
      out.samples.push({
        at: String(t.created_at).slice(11, 19),
        screen: sl.screen,
        by: sl.by,
        confidence: sl.confidence,
        fields: sl.fields.slice(0, 6).map((f) => `${f.name}:${f.kind}`),
      });
    }
    if (dry) continue;
    const up = await supabase.from("human_motion_learn").update({ shot_learn: sl }).eq("id", t.id);
    if (up.error) out.errors.push(String(up.error.message).slice(0, 120));
    else out.saved++;
  }
  return NextResponse.json(out, { headers: CORS });
}
