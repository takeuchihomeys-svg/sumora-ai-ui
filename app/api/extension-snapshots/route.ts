// /api/extension-snapshots — 拡張の「今の画面」と心拍（2026-09-29 竹内「なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」）
//   GET  ?poll=1&install_id=…   … 拡張（1分ごと）。心拍（x-snap-state ヘッダーの JSON）を書き、この PC がまだ答えていない頼まれの id を返す
//   POST action=result           … 拡張。撮った物（写真 最大3枚・ページの文字・拡張の状態・ログの末尾）を置く
//   POST action=request          … 画面（AIXツール「🔍 検索の点検」→「📷 拡張の画面」）・scripts。「今の画面を撮る」を頼む
//   GET  ?view=latest&limit=     … 画面・scripts。PC ごとの心拍と最新の撮った物（&request_id= でその頼まれへの答えだけ）
// 認証: 拡張は x-automation-key（/api/search-audits と同じ completeAuthOk）。画面・scripts は Bearer INTERNAL_API_SECRET（requireInternalAuth・写真にお客様の名前が入るため必須）
import { NextRequest, NextResponse } from "next/server";
import { completeAuthOk } from "@/app/lib/pickup-complete";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { parseStateHeader, validateResultBody, validInstallId, BODY_MAX_CHARS } from "@/app/lib/extension-snapshots";
import { heartbeatAndPoll, saveResult, createRequest, latestView } from "@/app/lib/extension-snapshots-server";
import manifest from "@/chrome-extension/manifest.json";
import { waitUntil } from "@vercel/functions";

/** 見張り（C4）に掛けるきっかけ（止まり・1回の検索の上限・待ちの時間切れ） */
const WATCH_TRIGGERS = new Set(["stall", "pass_deadline", "fill_timeout", "waiter_timeout"]);

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 今の拡張の版（この配備の manifest）。PC の心拍の版がこれより古ければ画面で赤く出す（再読み込み漏れの見分け）
const LATEST_EXT_VERSION: string | null = typeof (manifest as { version?: unknown }).version === "string" ? (manifest as { version: string }).version : null;

function extAuthOk(req: NextRequest): boolean {
  return completeAuthOk(
    { authorization: req.headers.get("authorization"), automationKey: req.headers.get("x-automation-key") },
    { internalSecret: process.env.INTERNAL_API_SECRET ?? null, automationKey: process.env.AUTOMATION_API_KEY ?? null },
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("poll") === "1") {
    if (!extAuthOk(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const installId = sp.get("install_id");
    if (!validInstallId(installId)) return NextResponse.json({ ok: false, error: "install_id が要ります" }, { status: 400 });
    const r = await heartbeatAndPoll(installId, parseStateHeader(req.headers.get("x-snap-state")));
    // 失敗しても拡張は次の1分でまた来る（500 にすると拡張のログが埋まるので 200 で error を返す）
    return NextResponse.json({ ok: r.ok, requests: r.requests.map((id) => ({ id })), error: r.error ?? null });
  }
  if (sp.get("view") === "latest") {
    const authError = requireInternalAuth(req);
    if (authError) return authError;
    const reqIdRaw = sp.get("request_id");
    const reqId = reqIdRaw && /^\d{1,12}$/.test(reqIdRaw) ? Number(reqIdRaw) : null;
    const r = await latestView({ limit: Number(sp.get("limit") ?? 5) || 5, installId: sp.get("install_id"), requestId: reqId, latestVersion: LATEST_EXT_VERSION });
    return NextResponse.json({ ok: !r.error, ...r }, { status: r.error ? 500 : 200 });
  }
  return NextResponse.json({ ok: false, error: "poll=1 か view=latest" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > BODY_MAX_CHARS) return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }); }

  if (body.action === "request") {
    const authError = requireInternalAuth(req);
    if (authError) return authError;
    const r = await createRequest(typeof body.requested_by === "string" ? body.requested_by : null, typeof body.install_id === "string" ? body.install_id : null);
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  if (body.action === "result") {
    if (!extAuthOk(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const v = validateResultBody(body);
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
    const r = await saveResult(v.value);
    // 2026-09-29 見張り（C4 動きが無い時）: 止まりの写真が置けたら、その文字（と帯を塗った写真）で見張りを1回（応答は待たせない・失敗しても何も止めない）
    if (r.ok && r.id != null && WATCH_TRIGGERS.has(v.value.trigger)) {
      const st = (v.value.stall ?? {}) as { why?: unknown; watch?: { site?: unknown; waitingFor?: unknown; lastProgressAt?: unknown; customerId?: unknown; commandId?: unknown; runId?: unknown } };
      const w = st.watch ?? {};
      const last = typeof w.lastProgressAt === "number" ? w.lastProgressAt : null;
      const job = import("@/app/lib/screen-watch-server").then(({ runCheckpoint }) => runCheckpoint({
        checkpoint: "stall", snapshotId: r.id, stallKind: v.value.trigger, installId: v.value.install_id,
        runId: v.value.audit_run_id ?? (typeof w.runId === "string" ? w.runId : null), commandId: v.value.batch_command_id,
        customerId: v.value.property_customer_id, site: typeof w.site === "string" ? w.site : null,
        waitingFor: typeof w.waitingFor === "string" ? w.waitingFor : null, idleMin: last ? Math.round((Date.now() - last) / 60000) : null,
      })).then(({ followUp }) => followUp).catch((e) => console.warn("[extension-snapshots] 見張りに失敗:", e instanceof Error ? e.message : String(e)));
      try { waitUntil(job); } catch { /* ローカル */ }
    }
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  return NextResponse.json({ ok: false, error: "action は result か request" }, { status: 400 });
}
