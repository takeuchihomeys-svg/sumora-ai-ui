// /api/line-watch — LINE の見張り（1段目 2026-10-01・2段目 同日 竹内「見張りの2段目おこなう」・設計 line-watch-design.md §6）
//   GET  … 見張りの画面（/watch）。読むだけ（書き込み・送信・LLM なし）。
//          ?test=1 で YUMA（テスト用の会話）も出す ／ ?days=1〜7 で「AI の案と実際」の日数 ／ ?live=1 で場面ごとの一致率・最終チェックを今の控えから計算
//   POST … 判定への👍／✋（竹内さん・スタッフが物差しを直す印）。書くのは line_watch_turns の verdict_review* の列だけ
//          body: { turnId: number, review: "agree" | "disagree" | null, verdict?: "same"|"same_meaning"|"partial"|"different"|"na", rule?: 同じ値, note?: string }
//   認証: 画面の内部認証（Authorization: Bearer NEXT_PUBLIC_INTERNAL_API_SECRET）。お客様の名前・下書きの文が載るので付ける
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { supabase } from "@/app/lib/supabase";
import { loadLineWatch } from "@/app/lib/line-watch-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VERDICTS = new Set(["same", "same_meaning", "partial", "different", "na"]);

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const sp = req.nextUrl.searchParams;
  const includeTest = sp.get("test") === "1";
  const days = Number(sp.get("days") ?? "1");
  try {
    const data = await loadLineWatch(supabase, { includeTest, turnDays: Number.isFinite(days) ? days : 1, live: sp.get("live") === "1" });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: "JSON が読めない" }, { status: 400 }); }
  const turnId = Number(body.turnId);
  if (!Number.isInteger(turnId) || turnId <= 0) return NextResponse.json({ ok: false, error: "turnId が無い" }, { status: 400 });
  const review = body.review === null ? null : String(body.review ?? "");
  if (review !== null && review !== "agree" && review !== "disagree") return NextResponse.json({ ok: false, error: "review は agree／disagree／null" }, { status: 400 });
  const verdict = body.verdict == null || body.verdict === "" ? null : String(body.verdict);
  if (verdict !== null && !VERDICTS.has(verdict)) return NextResponse.json({ ok: false, error: "verdict が違う" }, { status: 400 });
  const rule = body.rule == null ? null : String(body.rule);
  if (rule !== null && !VERDICTS.has(rule)) return NextResponse.json({ ok: false, error: "rule が違う" }, { status: 400 });
  const note = body.note == null ? null : String(body.note).slice(0, 200);
  const patch = review === null
    ? { verdict_review: null, verdict_review_verdict: null, verdict_review_rule: null, verdict_review_note: null, verdict_reviewed_at: null }
    : { verdict_review: review, verdict_review_verdict: review === "disagree" ? verdict : null, verdict_review_rule: rule, verdict_review_note: note, verdict_reviewed_at: new Date().toISOString() };
  const { data, error } = await supabase.from("line_watch_turns").update(patch).eq("id", turnId).select("id");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ ok: false, error: "その番が無い" }, { status: 404 });
  return NextResponse.json({ ok: true, turnId, review });
}
