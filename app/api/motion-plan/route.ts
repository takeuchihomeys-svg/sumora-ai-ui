// GET /api/motion-plan … 拡張（自動モード）が**検索を始める直前**に取る「このランのマウスの動き計画」
//
// 2026-11-19 竹内さん「動き方もAPIで決めていたら良いのでは」「APIこっちからも作れるように」
//   形: { ok, plan:{ v:1, plan_id, expires_at, run_seed, persona:{...} } }
//   拡張は chrome.storage の `axlx_motion_plan` に置き、content.js が MAIN world の `window.__axlxMotionPlan` へ中継。
//   pointer-ui.js が受けて persona を作り直す（plan_id が変われば新しい個性）。
//
// ・DB は読まない・書かない（軽い・営業時間でも安全・認証情報も使わない）。
// ・止める: 環境変数 MOTION_PLAN_OFF=1 → plan:null（拡張はローカルの seed で動く）。
// ・失敗しても拡張は止まらない（取れなければローカルで同等に動く＝fail-open）。
import { NextResponse } from "next/server";
import { buildMotionPlan } from "@/app/lib/motion-plan";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  if (process.env.MOTION_PLAN_OFF === "1") {
    return NextResponse.json({ ok: true, plan: null, off: true }, { headers: CORS });
  }
  return NextResponse.json({ ok: true, plan: buildMotionPlan() }, { headers: CORS });
}
