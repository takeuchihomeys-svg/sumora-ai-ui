/**
 * 人間（通常）と自動の近さ差分を測る（2026-11-17 統括Pro）
 *
 *   npx tsx --env-file=.env.local scripts/human-nearness.ts
 *   npx tsx --env-file=.env.local scripts/human-nearness.ts --hours=24
 *
 * 許可線: 近さ≥70・短間隔≤12%・human帯≥50%（app/lib/human-nearness.ts）
 * 土台: F29_human_nearness（foundation-audit）／統括束 human_nearness
 */
import { createClient } from "@supabase/supabase-js";
import { computeHumanNearness, NEARNESS_ALLOW } from "../app/lib/human-nearness";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("missing supabase env");
  process.exit(1);
}
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const hours = hoursArg ? Math.max(1, Number(hoursArg.replace("--hours=", "")) || 48) : 48;
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
const sb = createClient(url, key);

async function main() {
  const normalGaps: number[] = [];
  const autoGaps: number[] = [];
  let fetched = 0;
  for (let i = 0; i < 3000; i += 1000) {
    const { data, error } = await sb
      .from("human_motion_learn")
      .select("mode,shot_ops")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (error) {
      console.error(error.message);
      process.exit(1);
    }
    if (!data?.length) break;
    fetched += data.length;
    for (const r of data) {
      const m = String(r.mode || "").toLowerCase();
      const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
      for (const o of ops) {
        const g = Number(o.g);
        if (!(Number.isFinite(g) && g >= 0)) continue;
        if (m === "aix" || m === "auto") autoGaps.push(g);
        else if (m === "normal") normalGaps.push(g);
      }
    }
    if (data.length < 1000) break;
  }

  const n = computeHumanNearness({ normalGaps, autoGaps });
  console.log("─".repeat(60));
  console.log(`【人間との近さ】直近${hours}h  fetched=${fetched}`);
  console.log(`許可線: 近さ≥${NEARNESS_ALLOW.scoreMin}・短間隔≤${NEARNESS_ALLOW.fast400MaxPct}%・human帯≥${NEARNESS_ALLOW.humanBandMinPct}%`);
  console.log(n.line);
  console.log(`  スコア内訳: 短間隔${n.score.fastScore}・human帯${n.score.hbScore}・p50 ${n.score.p50Score}・CV ${n.score.cvScore}`);
  if (n.gaps.length) console.log(`  未達: ${n.gaps.join("／")}`);
  console.log(`  判定: ${n.allowed ? "許可OK（自動に渡せる差分まで縮まった）" : "未達（改善・再測が必要）"}`);
  console.log("─".repeat(60));
  console.log("次: npx tsx --env-file=.env.local scripts/foundation-audit.ts  （F29）");
  console.log("    束更新後: scripts/supervisor-pro.ts --scope=realpro  （根拠「人間との差分」）");
}

void main();
