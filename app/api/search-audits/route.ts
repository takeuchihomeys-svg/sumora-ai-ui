// /api/search-audits — 検索の点検（2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする」）
//   POST  … 拡張（search-audit.js）から。phase=started／finished で1回分を入れる・足す。
//            brain!==true なら何もしない（拡張の歯止めと二重）。finished で決定論の点検 → 怪しい回だけ応答の後（waitUntil）で DeepSeek の見立て。
//   GET   … 画面（AIXツールの「🔍 検索の点検」）。?view=causes|runs|weekly&days=7（runs は &customer_id= で絞れる）
//   PATCH … 原因の状態（未対応 open／直した fixed＋版／無視 ignored）
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { completeAuthOk } from "@/app/lib/pickup-complete";
import { requireInternalAuth } from "@/app/lib/api-auth";
import {
  validRunId, recordStarted, recordFinished, runDiagnosis, listCauses, listRuns, setCauseStatus, latestWeekly,
} from "@/app/lib/search-audit-server";

export const dynamic = "force-dynamic";
// 見立て（DeepSeek 20秒×最大2回）を応答の後に走らせる
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
};

const MAX_BODY_CHARS = 64_000;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const ok = completeAuthOk(
    { authorization: req.headers.get("authorization"), automationKey: req.headers.get("x-automation-key") },
    { internalSecret: process.env.INTERNAL_API_SECRET ?? null, automationKey: process.env.AUTOMATION_API_KEY ?? null },
  );
  if (!ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: CORS });
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false, error: "too large" }, { status: 413, headers: CORS });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400, headers: CORS }); }
  // ブレインの時だけ（拡張の behavior.searchAudit と同じ線・サーバーでも見る）
  if (body.brain !== true) return NextResponse.json({ ok: true, skipped: "not_brain" }, { headers: CORS });
  if (!validRunId(body.run_id)) return NextResponse.json({ ok: false, error: "run_id が要ります" }, { status: 400, headers: CORS });

  if (body.phase === "started") {
    const r = await recordStarted(body);
    return NextResponse.json(r, { status: r.ok ? 200 : 500, headers: CORS });
  }
  if (body.phase === "finished") {
    const r = await recordFinished(body);
    if (r.ok && r.needsAi) {
      const runId = body.run_id;
      const job = runDiagnosis(runId).then((d) => { if (d.error) console.warn("[search-audits] 見立て:", d.status, d.error); }, (e) => console.warn("[search-audits] 見立ての例外:", e));
      try { waitUntil(job); } catch { /* Vercel 以外（ローカル）: 待たずに走らせる */ }
    }
    // 2026-09-27 竹内「まずピンポイント検索して、なければ広げて検索する形」: ピンポイントの回で送れる物件が0件だった時は物件が届かない（まとめが来ない）
    //   → ここで決める（送れる物件があった回はまとめの時に決める・decideWiden が rows_coming で待つ）。応答は待たせない
    if (r.ok && body.is_wide === false && body.mode !== "brain_staff" && (typeof body.property_customer_id === "string" || typeof body.property_customer_id === "number")
        && (body.site === "realpro" || body.site === "realnetpro" || body.site === "itandi")) {
      const pcid = String(body.property_customer_id);
      const site = String(body.site);
      const chain = import("@/app/lib/search-widen-chain-server")
        .then(({ maybeChainWiden }) => maybeChainWiden({ propertyCustomerId: pcid, site, trigger: "audit" }))
        .then(() => undefined, (e) => console.warn("[search-audits] 広げての判断に失敗:", e));
      try { waitUntil(chain); } catch { /* ローカル */ }
    }
    return NextResponse.json(r, { status: r.ok ? 200 : 500, headers: CORS });
  }
  return NextResponse.json({ ok: false, error: "phase は started か finished" }, { status: 400, headers: CORS });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") ?? "causes";
  const days = Math.min(Math.max(Number(sp.get("days") ?? 7) || 7, 1), 90);
  if (view === "runs") {
    const cid = sp.get("customer_id");
    const r = await listRuns(days, { customerId: cid && /^[A-Za-z0-9-]{1,64}$/.test(cid) ? cid : null, limit: Number(sp.get("limit") ?? 200) || 200 });
    return NextResponse.json({ ok: !r.error, ...r }, { status: r.error ? 500 : 200, headers: CORS });
  }
  if (view === "weekly") {
    const w = await latestWeekly();
    return NextResponse.json({ ok: !w.error, ...w }, { status: w.error ? 500 : 200, headers: CORS });
  }
  const c = await listCauses(days);
  return NextResponse.json({ ok: !c.error, days, ...c }, { status: c.error ? 500 : 200, headers: CORS });
}

export async function PATCH(req: NextRequest) {
  // 2026-09-25 反証: 書き込み（原因の状態）は画面の内部認証だけ（CORS * のままだと誰でも「直した・無視」に変えられた）
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { cause_key?: unknown; status?: unknown; fixed_in_version?: unknown; note?: unknown };
  const key = typeof body.cause_key === "string" ? body.cause_key.slice(0, 200) : "";
  const status = body.status === "open" || body.status === "fixed" || body.status === "ignored" ? body.status : null;
  if (!key || !status) return NextResponse.json({ ok: false, error: "cause_key と status（open/fixed/ignored）が要ります" }, { status: 400, headers: CORS });
  const ver = typeof body.fixed_in_version === "string" && /^\d+\.\d+\.\d+$/.test(body.fixed_in_version.trim()) ? body.fixed_in_version.trim() : null;
  const r = await setCauseStatus(key, status, ver, typeof body.note === "string" ? body.note : null);
  return NextResponse.json(r, { status: r.ok ? 200 : 400, headers: CORS });
}
