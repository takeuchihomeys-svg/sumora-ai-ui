// GET /api/cron/takeuchi-anatomy（Vercel Cron・毎週月曜 JST 6:00）
//   竹内さんの文の解剖（場面×趣旨で偏りなく約200通・伏せ済みの本文だけを DeepSeek で下読み・決定論の札と食い違った所に印）。
//   2026-11-03 作業員6。1回 limit 通（既定 50）・200秒で止める（残りは次の呼び出し）。営業時間（JST 9〜22時）は ?force=1 が無いと動かさない。
//   ?dry=1 … 選ぶ数と残りだけ（書かない・LLM を呼ばない）
import { NextRequest, NextResponse } from "next/server";
import { runTakeuchiAnatomy, ANATOMY_FOCUS_WINDOW_UNTIL, ANATOMY_FOCUS_COST_CAP_USD } from "@/app/lib/takeuchi-anatomy-server";
import { anatomyFocusOn } from "@/app/lib/takeuchi-anatomy";
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
  const limit = Number(sp.get("limit") ?? "50");
  // 2026-11-05 作業員5（統括役了承）: 重点を読ませる夜の枠（vercel.json の ?window=focus・JST 22:30/23:30/0:30）。止め方は3重:
  //   ①期限 ANATOMY_FOCUS_WINDOW_UNTIL を過ぎたら読まない ②TAKEUCHI_ANATOMY_FOCUS が off なら読まない ③11/05 からの reply_anatomy の費用の合計が $1 以上なら読まない（server 側）
  //   残りが0なら読む行が無いだけで戻る。11/09 の朝に vercel.json の枠を消す
  const focusWindow = sp.get("window") === "focus";
  if (focusWindow) {
    if (Date.now() >= ANATOMY_FOCUS_WINDOW_UNTIL) return NextResponse.json({ ok: true, skipped: "重点の夜の枠は期限切れ（2026-11-09 09:00 JST）" });
    if (!anatomyFocusOn()) return NextResponse.json({ ok: true, skipped: "TAKEUCHI_ANATOMY_FOCUS が off" });
  }
  const report = await runTakeuchiAnatomy({ dry: sp.get("dry") === "1", limit: Math.max(1, Math.round((Number.isFinite(limit) && limit > 0 ? limit : 50) * guard.scale)), budgetMs: Math.round(200_000 * guard.scale), ...(focusWindow ? { costCapUsd: ANATOMY_FOCUS_COST_CAP_USD } : {}) });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
