// scripts/shadow-scene-table.ts — 影の自動返信の場面選びの表（本番の見張りの番を場面ごとに・読むだけ・LLM なし・書かない）
//   2026-11-12 作業員1（統括役の頼み・memory project_shadow_auto_reply）。決まりは scripts/lib/shadow-scene.ts、数え方は prod-yardstick の今の通／後の通。
// 実行: npx tsx --env-file=.env.local scripts/shadow-scene-table.ts [--cache=<path.json>] [--env2=<鍵のある .env.local>]
//   営業時間（JST 9〜22時）は DB を読まない（--cache の2回目は読める）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readWatchTurns, readStaffMsgs, readDecisionSources, aixFamily, type WatchRow } from "./lib/prod-yardstick-db";
import { brainFrames, staffFrames, judgeTwoFrames } from "./lib/prod-yardstick";
import { staffFirstMove, aixLogsFromWatch } from "../app/lib/staff-first-move";
import { sceneTable, sceneRowLine, type ShadowTurn } from "./lib/shadow-scene";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (arg("env2", "") && !process.env.SUPABASE_SERVICE_ROLE_KEY) process.loadEnvFile(arg("env2", ""));
const CACHE = arg("cache", "");
(async () => {
  let turns: WatchRow[], msgs: Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>, src: Map<string, string | null>;
  const now = Date.now();
  if (CACHE && existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, "utf8")); turns = c.turns; msgs = new Map(c.msgs); src = new Map(c.src);
  } else {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
    if (h >= 9 && h < 22) { console.log(`営業時間（JST ${h}時）は DB を読まない（--cache の2回目だけ）`); return; }
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const since = new Date(now - 28 * 86_400_000).toISOString();
    turns = await readWatchTurns(sb, since, 20000);
    msgs = await readStaffMsgs(sb, [...new Set(turns.map((w) => w.conversation_id))], since);
    src = await readDecisionSources(sb, [...new Set(turns.map((w) => w.decision_id).filter((x): x is string => !!x))]);
    if (CACHE) writeFileSync(CACHE, JSON.stringify({ turns, msgs: [...msgs], src: [...src] }));
  }
  const rows: ShadowTurn[] = turns.flatMap((w) => {
    const tAt = Date.parse(w.customer_turn_at);
    const ms = msgs.get(w.conversation_id) ?? [];
    const logs = aixLogsFromWatch(w.staff_aix);
    const fm = staffFirstMove(tAt, ms, logs);
    if (!fm) return [];
    const moves = ms.filter((m) => m.at >= tAt).map((m) => ({ at: m.at, family: m.isAix ? aixFamily(logs.filter((a) => Math.abs(a.at - m.at) <= 10 * 60_000).sort((a, b) => Math.abs(a.at - m.at) - Math.abs(b.at - m.at))[0]?.aixType ?? "aix_unknown") : "返信" }));
    const b = brainFrames(aixFamily(w.brain_action), w.decision_id ? src.get(String(w.decision_id)) ?? null : null);
    const s = staffFrames(tAt, moves);
    const j = judgeTwoFrames(b, s);
    return [{ scene: w.scene_key, at: tAt, writer: fm.writer === "takeuchi" ? "takeuchi" : "staff", nowHit: j.now === "hit", staffReply: (s.now ?? "返信") === "返信", brainReply: b.now === "返信", laterBad: j.later === "miss" || j.later === "brain_only" }];
  });
  const table = sceneTable(rows, now);
  console.log(`番 ${rows.length}（28日）・場面 ${new Set(table.map((r) => r.scene)).size}`);
  console.log("| 場面 | 書き手 | 14日の番 | 14日の当たり | 28日の番 | 28日の当たり | 返信の番の割合 | 後の通の外れ | 判定 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of table.filter((x) => x.writer !== "all" || x.verdict === "候補")) console.log(sceneRowLine(r));
  console.log(`\n候補: ${table.filter((r) => r.verdict === "候補").map((r) => `${r.scene}（${r.writer}）`).join("・") || "なし"}`);
})();
