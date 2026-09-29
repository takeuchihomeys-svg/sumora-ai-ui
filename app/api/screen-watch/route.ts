// /api/screen-watch — 見張り（2026-09-29 竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」）
//   POST checkpoint=filled|results … 拡張（ブレインモードの時だけ・x-automation-key／completeAuthOk）。C1 条件を入れた後・C2 検索結果（C1 の約4秒後）の
//        ページの文字と読み戻しを送り、決定論の答え {label, action, reason, stop_site} をすぐ返す（LLM と行の記録は応答の後の waitUntil）。
//        stop_site が付いた時だけ、拡張は次のお客様の境目でそのサイトの残りを見送る（再読み込み・再試行・クリックはしない）
//   POST action=re_search_temp        … 見張りの画面のボタン（内部認証）。裁定の抜けをこの回だけ足して1回だけ検索を積む（1人1日1回・1日5回まで）
//   GET  ?view=live                   … 見張りの画面（内部認証・20秒ごと）
// 失敗しても 200 で ok:false を返す（拡張の検索を止めない）
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { completeAuthOk } from "@/app/lib/pickup-complete";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { runCheckpoint, liveView, reSearchTemp } from "@/app/lib/screen-watch-server";
import type { WatchDom } from "@/app/lib/screen-watch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_CHARS = 64_000;

const s = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 拡張の dom（snapshot-core.readDom の形）→ 見張りの材料（長さを切る・知らない欄は捨てる） */
function domOf(v: unknown): WatchDom | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  return {
    url: s(d.url, 500), title: s(d.title, 120), count_text: s(d.count_text, 80), count_number: n(d.count_number), page_text: s(d.page_text, 40),
    alert_text: s(d.alert_text, 120), modal_text: s(d.modal_text, 300), text_head: s(d.text_head, 300), band_text: s(d.band_text, 200), visibility: s(d.visibility, 20),
  };
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }); }

  if (body.action === "re_search_temp") {
    const authError = requireInternalAuth(req);
    if (authError) return authError;
    const id = n(body.event_id);
    if (id == null) return NextResponse.json({ ok: false, error: "event_id が要ります" }, { status: 400 });
    const r = await reSearchTemp(id, s(body.requested_by, 40));
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }

  const ok = completeAuthOk(
    { authorization: req.headers.get("authorization"), automationKey: req.headers.get("x-automation-key") },
    { internalSecret: process.env.INTERNAL_API_SECRET ?? null, automationKey: process.env.AUTOMATION_API_KEY ?? null },
  );
  if (!ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (body.brain !== true) return NextResponse.json({ ok: true, skipped: "not_brain", label: "normal", action: "none" });
  const cp = body.checkpoint === "filled" || body.checkpoint === "results" ? body.checkpoint : null;
  if (!cp) return NextResponse.json({ ok: false, error: "checkpoint は filled か results" }, { status: 400 });
  const filled = body.filled && typeof body.filled === "object" && !Array.isArray(body.filled) ? body.filled as Record<string, unknown> : null;
  const { decision, followUp } = await runCheckpoint({
    checkpoint: cp,
    runId: s(body.run_id, 80), commandId: s(body.command_id, 64), installId: s(body.install_id, 64), customerId: s(body.property_customer_id, 64),
    site: s(body.site, 20), dom: domOf(body.dom), domError: s(body.dom_error, 200), filled, error: s(body.error, 500),
  });
  try { waitUntil(followUp); } catch { /* ローカル: 待たずに走らせる */ }
  return NextResponse.json({ ok: true, ...decision });
}

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  if (req.nextUrl.searchParams.get("view") !== "live") return NextResponse.json({ ok: false, error: "view=live" }, { status: 400 });
  const r = await liveView();
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
