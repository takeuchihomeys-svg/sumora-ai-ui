// scripts/near-opinion-timing.ts — 入口の意見（nearOpinionForTurn）の段ごとの時間を測る（読むだけ・埋め込みは1回目だけ・約 $0.00001）
//   2026-11-15 作業員H（統括役の頼み 5: match_conductor_focus の時間切れ nop9o-1 の原因）。
//   brain-core は nearOpinionForTurn 全体を 2秒で切る。どの段（状況の文の読み・埋め込み・RPC・状況の文・近い返信の文・手本の文）が重いかを分け、
//   NEAR_OPINION_PARALLEL の off と on を交互に回して比べる。
//   使い方: npx tsx --env-file=<.env.local> scripts/near-opinion-timing.ts --conv=<id> --at=<ISO> [--n=3]
import { createClient } from "@supabase/supabase-js";
import { nearOpinionForTurn, type NearOpinionTrace } from "../app/lib/conductor-near-opinion-server";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
(async () => {
  const conv = arg("conv"), at = arg("at"), n = Number(arg("n") ?? "3");
  if (!conv || !at) { console.error("--conv と --at が要る"); process.exit(1); }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  for (let i = 0; i < n; i++) {
    for (const mode of ["off", "on"]) {
      process.env.NEAR_OPINION_PARALLEL = mode;
      const trace: NearOpinionTrace = { stage: "start", ms: {} };
      const t0 = Date.now();
      const r = await nearOpinionForTurn(sb, { conversationId: conv, propertyCustomerId: null, turnAt: at, scene: "other", customerTurn: "" }, trace);
      console.log(JSON.stringify({ i, parallel: mode, total_ms: Date.now() - t0, stage: trace.stage, ms: trace.ms, inBand: r?.inBand ?? null, op: r?.op ? `${r.op.move}:${r.op.share}` : null }));
    }
  }
})();
