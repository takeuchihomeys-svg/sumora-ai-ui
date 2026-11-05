// scripts/prod-yardstick-night.ts — 本番の物差しの手元の分（読むだけ・LLM なし・費用 0）
//
// 2026-11-05 作業員8（統括役の了承の 2・3）: 場面ごとの当たりの比べは本番の cron（app/api/cron/prod-yardstick・毎晩・cron_run_logs）が回す。
//   ここは手元にしか無い物を足す: ①下がった場面の試験の問題（spec.json の会話・時刻が本番の番と同じ問題）②割れの表（本番の Claude の道 × 手元の試験の結果の行の DeepSeek の答え）。
//   結果は <置き場>/prod-yardstick/<JST の日>.json。営業時間（JST 9〜22時）は回さない（--force で手元の確かめだけ）
// 実行: npx tsx --env-file=.env.local scripts/prod-yardstick-night.ts [--days=7] [--force] [--json]
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { problemsForDrift, modelSplitTable } from "./lib/prod-yardstick";
import { runYardstick, aixFamily, type WatchRow } from "./lib/prod-yardstick-db";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const DAYS = Math.min(14, Math.max(1, Number(arg("days", "7"))));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 試験の問題（spec.json）の会話・時刻 → 本番の番 */
function problemsByScene(turns: WatchRow[]): { byScene: Map<string, string[]>; probTurn: Map<string, WatchRow> } {
  const byScene = new Map<string, string[]>(), probTurn = new Map<string, WatchRow>();
  let spec: Array<{ id: string; conv?: string; at?: string }> = [];
  try { const j = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")); spec = Array.isArray(j) ? j : (j.problems ?? Object.values(j)); } catch { /* */ }
  const idx = new Map<string, WatchRow[]>(); for (const w of turns) { const a = idx.get(w.conversation_id) ?? []; a.push(w); idx.set(w.conversation_id, a); }
  for (const p of spec) {
    if (!p.conv || !p.at) continue;
    const at = Date.parse(p.at);
    const near = (idx.get(p.conv) ?? []).find((w) => Math.abs(Date.parse(w.customer_turn_at) - at) < 10 * 60_000);
    if (!near) continue;
    probTurn.set(p.id, near);
    const k = near.scene_key ?? "（場面なし）"; byScene.set(k, [...(byScene.get(k) ?? []), p.id]);
  }
  return { byScene, probTurn };
}

/** 手元の試験の結果の行の一番新しい DeepSeek の答え（道の系統） */
function latestExamAnswers(): Map<string, string> {
  const dir = "scripts/brain-exam/results";
  const m = new Map<string, { at: string; fam: string }>();
  if (!existsSync(dir)) return new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(l) as { id: string; at?: string; model?: string; path?: { code?: string } | null; error?: string };
        if (r.error || !r.path?.code || !String(r.model ?? "").includes("deepseek")) continue;
        // 道の形: 「AIX:<種類>」→ その系統／「返信」「2段:…」→ 返信（本番の brain_action と同じ見方）
        const code = r.path.code;
        const fam = code.startsWith("AIX:") ? aixFamily(code.slice(4).split("/")[0]) : "返信";
        const prev = m.get(r.id);
        if (!prev || String(r.at) > prev.at) m.set(r.id, { at: String(r.at ?? ""), fam });
      } catch { /* */ }
    }
  }
  return new Map([...m].map(([k, v]) => [k, v.fam]));
}

(async () => {
  const now = Date.now();
  const { out: y, turns } = await runYardstick(sb, { days: DAYS, nowMs: now });
  const { byScene, probTurn } = problemsByScene(turns);
  const targets = problemsForDrift(y.drift, byScene);
  const ans = latestExamAnswers();
  const pairs = [...probTurn].filter(([id]) => ans.has(id)).map(([id, w]) => ({ scene: w.scene_key, claude: aixFamily(w.brain_action), deepseek: ans.get(id)! }));
  const split = modelSplitTable(pairs);
  const out = { ...y, drift: undefined, examTargets: targets, split: Object.fromEntries([...split].map(([k, v]) => [k, { n: v.n, agree: v.agree, rate: +v.rate.toFixed(3) }])) };
  const dir = join(examCacheRoot(), "prod-yardstick"); mkdirSync(dir, { recursive: true });
  const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(out, null, 1));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(out)); return; }
  console.log(`# 本番の物差し（見張りの番 前 ${y.turns.before} → 今 ${y.turns.after}・直近 ${DAYS}日ずつ・場面の比べは竹内さんの番だけ・LLM なし）`);
  console.log(`- はっきり下がった場面: ${y.down.length ? y.down.map((d) => `${d.scene}（${Math.round(d.pBefore * 100)}%→${Math.round(d.pAfter * 100)}%・${d.after.n}番）`).join("・") : "なし"}（少なくて待つ場面 ${y.few}）`);
  console.log(`- 試験に積む問題（下がった場面だけ）: ${targets.length ? targets.join(",") : "なし"}`);
  console.log(`- 割れの表（本番の Claude × 試験の DeepSeek・同じ番 ${pairs.length}）: ${[...split].sort((a, b) => a[1].rate - b[1].rate).slice(0, 8).map(([k, v]) => `${k} ${v.agree}/${v.n}`).join("・") || "なし"}`);
  console.log(`- 置き場: ${join(dir, `${day}.json`)}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
