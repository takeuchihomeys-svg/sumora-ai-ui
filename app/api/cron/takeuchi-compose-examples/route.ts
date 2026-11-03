// GET /api/cron/takeuchi-compose-examples（Vercel Cron・毎週月曜 JST 5:40）
//   文の指示役の場面の RAG（竹内さん本人の返信を場面×趣旨で・その後の反応の重み付き）を takeuchi_compose_examples に足す。
//   2026-11-03 作業員6。会話由来の文は倉庫に置かず DB に（RLS・サーバーの鍵だけ）。
//   1回 最大 limit 通（既定 300）・200秒で止めて next を返す（続きは ?after=<next>。無ければ表の一番新しい送信の後から）。
//   営業時間（JST 9〜22時）は ?force=1 が無いと動かさない（11/03 10:31〜10:45 の DB の混雑）。?dry=1 … 数だけ（書かない・埋め込みも作らない）
import { NextRequest, NextResponse } from "next/server";
import { runTakeuchiComposeExamples } from "@/app/lib/takeuchi-compose-examples-server";
import { decideBatchRunFromEnv } from "@/app/lib/batch-daytime-guard";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  // 2026-11-03 昼の守り（batch-daytime-guard.ts）: 昼は本番の調子が良い時だけ・量を半分・間を2倍。BATCH_DAYTIME_GUARD=strict で今まで通り（昼は ?force=1 だけ）
  const guard = await decideBatchRunFromEnv(sp.get("force") === "1");
  if (!guard.run) return NextResponse.json({ ok: true, skipped: guard.reason, daytime: guard.daytime });
  const after = sp.get("after");
  const limit = Number(sp.get("limit") ?? "300");
  const report = await runTakeuchiComposeExamples({
    dry: sp.get("dry") === "1",
    afterIso: after && Number.isFinite(Date.parse(after)) ? new Date(after).toISOString() : null,
    limit: Math.max(1, Math.round((Number.isFinite(limit) && limit > 0 ? limit : 300) * guard.scale)), budgetMs: Math.round(200_000 * guard.scale), pauseMs: Math.round(80 * guard.pauseScale),
  });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
