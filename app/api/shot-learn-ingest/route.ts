/**
 * 手元 Vision の結果を本番 DB に書き戻す入口
 * （本番 Vercel に LLM キーが無い時の迂回路・2026-11-16）
 *
 * POST JSON: { items: [{ id: number, shot_learn: object }] }
 * ⚠ shot_learn の中身だけ更新。入力した中身は入れない前提。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400, headers: CORS });
  }
  const items = (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items))
    ? (body as { items: Array<Record<string, unknown>> }).items
    : [];
  if (!items.length) {
    return NextResponse.json({ ok: false, error: "no_items" }, { status: 400, headers: CORS });
  }
  const max = Math.min(40, items.length);
  let saved = 0;
  const errors: string[] = [];
  for (let i = 0; i < max; i++) {
    const it = items[i];
    const id = Number(it.id);
    const sl = it.shot_learn;
    if (!Number.isFinite(id) || !sl || typeof sl !== "object") {
      errors.push(`bad_item_${i}`);
      continue;
    }
    const payload = { ...(sl as object), from: "shot-learn-ingest", by: (sl as { by?: string }).by || "vision" };
    const up = await supabase.from("human_motion_learn").update({ shot_learn: payload }).eq("id", id);
    if (up.error) errors.push(String(up.error.message).slice(0, 100));
    else saved++;
  }
  return NextResponse.json({ ok: saved > 0, saved, tried: max, errors: errors.length ? errors.slice(0, 5) : null }, { headers: CORS });
}
