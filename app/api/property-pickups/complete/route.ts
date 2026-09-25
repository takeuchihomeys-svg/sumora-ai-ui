// POST /api/property-pickups/complete  { property_customer_id, brain: true, mode?: "normal"|"staff"|"aix", trigger?: "viewed"|"sent", requested_by?: string }
// 拡張でお客様の作業を終えた時（お客様一覧の「確認」☑／リアプロの「✅ 送った」）に呼ぶ。
// そのお客様の売上サポのピックアップ（前の完了より後・最大24時間・リアプロ／itandi／レインズの全部の回）を1つのまとめ（complete_group_id）にし、
// 応答の後（waitUntil）で、まだ読んでいない物件の自動の読み取り（DeepSeek だけ）と、まとめた全件での順位・👑 の付け直しをする。
//
// 2026-09-25 竹内「スタッフモードで送った時は、拡張ツールはお客さんのところ完了ボタン押したら、リアプロと itandi の全部分析されるようにする」
// - ブレイン OFF（brain !== true）は何もしない（売上サポに届いていない）。拡張も呼ばないが、ここでも止める（二重の歯止め）
// - 冪等: 二重押し・2台の PC から同時でも、まとめ ID は同じで、行を取れるのは先に書いた方だけ（後の方は already=true・読まない）
// - 拡張は待たせない: まとめ ID を付けたら返す（読むのは後ろ）
// 2026-09-25 竹内「最後にスタッフモードで指定したお客さん…10分たてば自動的に…まとめて判定する」:
//   idle: true（拡張の chrome.alarms・送信から10分半後）は「最後に届いた行から10分、新しい行が届いていなければ」だけまとめる。
//   まだなら not_due と due_at（拡張はその時刻にもう一度呼ぶ）。本体は Cron /api/cron/pickup-auto-complete（pickup-complete-server の先頭）
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { claimCompleteGroup, finishCompleteGroup } from "@/app/lib/pickup-complete-server";
import { completeAuthOk, completeToastJa, AUTO_COMPLETE_QUIET_MS } from "@/app/lib/pickup-complete";

// 自動の読み取りは 1件 最悪 約180秒（pickup-analyze の反証）・同時3件・最大20件。始めてよい締め切りは 200秒（maxDuration 300 に収める）
export const maxDuration = 300;
const FINISH_DEADLINE_MS = 200_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(["normal", "staff", "aix"]);
const TRIGGERS = new Set(["viewed", "sent", "manual", "idle"]);

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const ok = completeAuthOk(
    { authorization: req.headers.get("authorization"), automationKey: req.headers.get("x-automation-key") },
    { internalSecret: process.env.INTERNAL_API_SECRET ?? null, automationKey: process.env.AUTOMATION_API_KEY ?? null },
  );
  if (!ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: CORS });

  const body = await req.json().catch(() => ({})) as { property_customer_id?: unknown; brain?: unknown; mode?: unknown; trigger?: unknown; requested_by?: unknown; idle?: unknown };
  const pcid = typeof body.property_customer_id === "string" ? body.property_customer_id.trim() : "";
  if (!UUID_RE.test(pcid)) return NextResponse.json({ ok: false, error: "property_customer_id が要ります" }, { status: 400, headers: CORS });
  const mode = typeof body.mode === "string" && MODES.has(body.mode) ? body.mode : null;
  const idle = body.idle === true;
  const trigger = idle ? "idle" : typeof body.trigger === "string" && TRIGGERS.has(body.trigger) ? body.trigger : null;
  const requestedBy = typeof body.requested_by === "string" ? body.requested_by.slice(0, 40) : null;
  if (body.brain !== true) {
    return NextResponse.json({ ok: true, skipped: "brain_off", claimed: 0, toast: "" }, { headers: CORS });
  }

  const claim = await claimCompleteGroup(pcid, { trigger, mode, requestedBy: requestedBy ?? (idle ? "extension" : null) }, Date.now(), idle ? { quietMs: AUTO_COMPLETE_QUIET_MS } : undefined);
  if (!claim.ok) return NextResponse.json({ ok: false, error: claim.error ?? "まとめられない" }, { status: 500, headers: CORS });

  if (claim.groupId && claim.claimedIds.length > 0) {
    const job = finishCompleteGroup({
      groupId: claim.groupId, claimedIds: claim.claimedIds, propertyCustomerId: pcid, conversationId: claim.conversationId,
      deadlineAt: Date.now() + FINISH_DEADLINE_MS,
    });
    try { waitUntil(job); } catch { /* Vercel 以外（ローカル）: 待たずに走らせる */ }
  }
  if (claim.notDue) {
    return NextResponse.json({ ok: true, not_due: true, due_at: claim.dueAt, claimed: 0, toast: "" }, { headers: CORS });
  }
  return NextResponse.json({
    ok: true,
    group_id: claim.groupId,
    claimed: claim.claimedIds.length,
    sites: claim.sites,
    batches: claim.batchIds.length,
    already: claim.already,
    // 自動（idle）は拡張の画面が無い所から呼ぶのでトーストは出さない
    toast: idle ? "" : completeToastJa({ claimed: claim.claimedIds.length, sites: claim.sites, already: claim.already }),
  }, { headers: CORS });
}
