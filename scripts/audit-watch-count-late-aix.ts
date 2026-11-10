// scripts/audit-watch-count-late-aix.ts — 見張りの数え方の直し（後で送った AIX・お礼の番の約束の果たし）の前後を場面ごとに1表で（読むだけ・LLM なし・書かない）
//   2026-11-07 作業員1（統括役の頼み）: ①番の後 STAFF_LATE_AIX_MIN 分以上たって送った AIX は外れに入れない ②お礼・了承の番で30分以内に約束を果たす AIX はスタッフの番
//   線の根拠: 竹内さん本人の最初の一手が AIX だった番の、番からの分の分かれ（--lines で見る）
// 実行: npx tsx --env-file=.env.local scripts/audit-watch-count-late-aix.ts [--days=90] [--writer=takeuchi] [--late=90] [--cache=<path.json>] [--lines]
//   営業時間（JST 9〜22時）は DB を読まない（--cache の2回目は読める）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readWatchTurns, readStaffMsgs, aixFamily, type WatchRow } from "./lib/prod-yardstick-db";
import { staffFirstMove, aixLogsFromWatch, staffMoveExclusion, ackSceneOf } from "../app/lib/staff-first-move";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
// 2026-11-10: 作業ツリーの .env.local にサーバーの鍵が無い時は --env2=<.env.local の道>（値は出さない・読み込むだけ）
if (arg("env2", "") && !process.env.SUPABASE_SERVICE_ROLE_KEY) process.loadEnvFile(arg("env2", ""));
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !(arg("cache", "") && existsSync(arg("cache", "")))) { console.error("サーバーの鍵がありません（--env2=<鍵のある .env.local> か、鍵のある作業ツリーで動かす）"); process.exit(1); }
const DAYS = Number(arg("days", "90")), WRITER = arg("writer", "takeuchi"), LATE = Number(arg("late", "90")), CACHE = arg("cache", "");
type Row = WatchRow & { tpo_label?: string | null };
(async () => {
  let turns: Row[], msgs: Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>;
  if (CACHE && existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, "utf8")); turns = c.turns; msgs = new Map(c.msgs);
  } else {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
    if (h >= 9 && h < 22) { console.log(`営業時間（JST ${h}時）は DB を読まない（--cache の2回目だけ）`); return; }
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    turns = await readWatchTurns(sb, since, 20000);
    msgs = await readStaffMsgs(sb, [...new Set(turns.map((w) => w.conversation_id))], since);
    if (CACHE) writeFileSync(CACHE, JSON.stringify({ turns, msgs: [...msgs] }));
  }
  const recs = turns.map((w) => {
    const t = Date.parse(w.customer_turn_at);
    const fm = staffFirstMove(t, msgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    return { w, fm, t, ack: ackSceneOf(w.scene_key, w.tpo_label), brain: aixFamily(w.brain_action), staff: aixFamily(fm?.kind === "aix" ? fm.aix : null) };
  }).filter((r) => r.fm && r.fm.writer === WRITER);
  if (process.argv.includes("--lines")) {
    const b = [10, 30, 60, 90, 120, 180, 240, 480, 1440];
    console.log(`■ ${WRITER} の最初の一手（${recs.length}番）: 番からの分 × AIX/返信 と、AIX の時のブレインの当たり`);
    let lo = 0;
    for (const hi of b) {
      const inB = recs.filter((r) => { const m = (r.fm!.at - r.t) / 60000; return m >= lo && m < hi; });
      const ax = inB.filter((r) => r.fm!.kind === "aix");
      console.log(`  ${String(lo).padStart(4)}〜${String(hi).padStart(4)}分: AIX ${String(ax.length).padStart(3)}・返信 ${String(inB.length - ax.length).padStart(3)}・AIX の番でブレインも同じ系統 ${ax.filter((r) => r.brain === r.staff).length}/${ax.length}`);
      lo = hi;
    }
  }
  const scenes = new Map<string, { n0: number; h0: number; n1: number; h1: number; late: number; ack: number }>();
  for (const r of recs) {
    const k = r.w.scene_key ?? "（場面なし）";
    const v = scenes.get(k) ?? { n0: 0, h0: 0, n1: 0, h1: 0, late: 0, ack: 0 };
    const hit = r.brain === r.staff;
    v.n0++; if (hit) v.h0++;
    const ex = staffMoveExclusion(r.t, r.fm, { ackOnly: r.ack, lateMin: LATE });
    if (ex === "late_aix") v.late++; else if (ex === "ack_fulfil_aix") v.ack++; else { v.n1++; if (hit) v.h1++; }
    scenes.set(k, v);
  }
  const pc = (h: number, n: number) => (n ? `${((100 * h) / n).toFixed(0)}%` : "-");
  console.log(`\n■ 場面ごとの当たり（${WRITER}・${DAYS}日・後の AIX の線 ${LATE}分）: 前＝今の数え／後＝直した数え（外した番は別に数える）`);
  console.log("| 場面 | 前 当たり/番 | 後 当たり/番 | 後で送った AIX | お礼の番の約束の果たし |");
  console.log("|---|---|---|---|---|");
  const tot = { n0: 0, h0: 0, n1: 0, h1: 0, late: 0, ack: 0 };
  for (const [k, v] of [...scenes].sort((a, b) => b[1].n0 - a[1].n0)) {
    for (const f of Object.keys(tot) as Array<keyof typeof tot>) tot[f] += v[f];
    if (v.n0 < 5) continue;
    console.log(`| ${k} | ${v.h0}/${v.n0}（${pc(v.h0, v.n0)}） | ${v.h1}/${v.n1}（${pc(v.h1, v.n1)}） | ${v.late} | ${v.ack} |`);
  }
  console.log(`| 計 | ${tot.h0}/${tot.n0}（${pc(tot.h0, tot.n0)}） | ${tot.h1}/${tot.n1}（${pc(tot.h1, tot.n1)}） | ${tot.late} | ${tot.ack} |`);
})();
