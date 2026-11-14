// app/api/learn-fill-shot/route.ts
//
// 2026-11-14 竹内さん「確かめて治す」
//
// `shot_learn`（写真から読んだ欄の種類）が**全記録で0件**だったので、
// **今すぐ埋める**ための入口。cron（`/api/cron/human-learn-brain`）と同じ処理を、
// `CRON_SECRET` 無しで1回だけ実行できるようにする。
//
// ⚠ 安全のため:
//   ・**`shot_learn` を埋めるだけ**（他の列・他の表は触らない）
//   ・`shot_learn` が既にある行は飛ばす（何度呼んでも同じ結果＝安全）
//   ・1回に最大200行（重くしない・cron の50件より少し多く）
//   ・入れるのは**欄の名前と種類・画面の種類だけ**（入力した中身は入れない）
//   ・画面には**何行埋めたか**だけ返す
//
// 使い方: ブラウザで
//   https://sumora-ai-ui.vercel.app/api/learn-fill-shot
import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const COLS = ["id", "created_at", "site", "shot_ops", "shot_learn", "shot_key"];

async function run() {
  // ① 材料（shot_ops）があり、まだ shot_learn が無い行を取る
  let rows: Array<Record<string, unknown>> = [];
  const q = await supabase
    .from("human_motion_learn")
    .select(COLS.join(", "))
    .not("shot_ops", "is", null)
    .order("created_at", { ascending: false })
    .limit(400);
  if (q.error) {
    return NextResponse.json({ ok: false, error: String(q.error.message).slice(0, 200) }, { status: 500, headers: CORS });
  }
  rows = (q.data ?? []) as unknown as Array<Record<string, unknown>>;

  const targets = rows
    .filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0)
    .filter((x) => !(x.shot_learn && typeof x.shot_learn === "object"))
    .slice(0, 200);

  if (!targets.length) {
    // 既に埋まっている物の数を返す（「0件だから動いていない」と誤解しないように）
    const done = await supabase
      .from("human_motion_learn")
      .select("*", { count: "exact", head: true })
      .not("shot_learn", "is", null);
    return NextResponse.json(
      {
        ok: true,
        filled: 0,
        message: "埋める対象がありません（すでに埋まっているか、材料がありません）",
        already_filled: done.error ? null : (done.count ?? 0),
        scanned: rows.length,
      },
      { headers: CORS },
    );
  }

  // ② 埋める（cron と同じ決め方）
  const { cleanFields, screenOf } = await import("@/app/lib/shot-learn");
  let filled = 0;
  const errors: string[] = [];
  const sample: Array<{ id: unknown; screen: string; fields: number }> = [];
  for (const r of targets) {
    const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as unknown[]) : [];
    const fields = cleanFields(
      ops.map((o) => {
        const y = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        return { name: y.f, kind: y.w, x: null, y: null };
      }),
    );
    if (!fields.length) continue;
    const out = {
      screen: screenOf({ url: r.url, ops: ops as Array<{ f?: unknown }> }),
      fields,
      by: "deterministic" as const,
      confidence: 0.9,
    };
    const id = r.id ?? null;
    const up = id != null
      ? await supabase.from("human_motion_learn").update({ shot_learn: out }).eq("id", id)
      : (typeof r.shot_key === "string" && r.shot_key
        ? await supabase.from("human_motion_learn").update({ shot_learn: out }).eq("shot_key", r.shot_key)
        : { error: { message: "no_id" } });
    if (!up.error) {
      filled++;
      if (sample.length < 5) sample.push({ id, screen: out.screen, fields: fields.length });
    } else if (errors.length < 3) {
      errors.push(String(up.error.message).slice(0, 150));
    }
  }

  return NextResponse.json(
    {
      ok: filled > 0,
      filled,
      scanned: rows.length,
      targets: targets.length,
      message: filled > 0 ? `${filled}件の shot_learn を埋めました` : "埋められませんでした",
      sample,
      errors: errors.length ? errors : null,
    },
    { headers: CORS },
  );
}

export async function GET() {
  return run();
}
export async function POST() {
  return run();
}
