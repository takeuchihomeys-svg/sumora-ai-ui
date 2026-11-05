// scripts/prod-yardstick-night.ts — 本番の記録を毎晩の物差しにする（読むだけ・LLM なし・費用 0）
//
// 2026-11-05 作業員8（統括役の了承の 2・3「本番の記録を毎晩の物差しにする（下がった場面だけ試験）」・割れの表）:
//   ① 竹内さんの番の当たり（ブレインの道の系統＝最初の一手の系統）を、前の窓（--days 日・既定 7）と今の窓で場面ごとに比べ、はっきり下がった場面を出す
//      （scripts/lib/prod-yardstick.ts・Wilson の幅が重ならない時だけ・5番未満は待つ）。竹内さんと違っても原則で良い番は「超えた候補」（原則の見方が付いた番だけ）
//   ② 下がった場面の試験の問題（spec.json の会話・時刻が本番の番と同じ問題）と回帰の必須を、係に積める id の並びで出す
//   ③ 割れの表: 同じ番で、本番の Claude の答え（brain_decision_logs の道）と試験の DeepSeek の答え（試験の結果の行）が同じ系統か（場面ごと）
//   結果は <置き場>/prod-yardstick/<JST の日>.json に残す（係・統括役が読む）。営業時間（JST 9〜22時）は回さない（--force で手元の確かめだけ）
// 実行: npx tsx --env-file=.env.local scripts/prod-yardstick-night.ts [--days=7] [--force] [--json]
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestConversation } from "../app/lib/test-conversations";
import { staffFirstMove, aixLogsFromWatch } from "../app/lib/staff-first-move";
import { examCacheRoot } from "./lib/llm-cassette";
import { countByScene, sceneDrift, problemsForDrift, beyondCandidates, modelSplitTable, type YardTurn } from "./lib/prod-yardstick";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const DAYS = Math.min(14, Math.max(1, Number(arg("days", "7"))));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** AIX の系統（audit-prod-as-exam と同じ見方・あちらは読むとすぐ走るので写す） */
export function aixFamily(k: string | null | undefined): string {
  const s = String(k ?? "");
  if (!s) return "返信";
  if (/property_check|acknowledge_check/.test(s)) return "確認";
  if (/estimate|cost_/.test(s)) return "見積";
  if (/property_send|property_recommend|new_arrival/.test(s)) return "物件";
  if (/viewing|meeting/.test(s)) return "内覧";
  if (/application|apply/.test(s)) return "申込";
  if (/zenryoku|support/.test(s)) return "サポート";
  return s;
}

type W = { id: number; conversation_id: string; customer_turn_at: string; scene_key: string | null; brain_action: string | null; decision_id: string | null; staff_aix: Array<{ aix_type?: string; at?: string; check_pattern?: string | null }> | null; verdict: string | null };

async function readTurns(sinceIso: string): Promise<W[]> {
  const out: W[] = [];
  for (let i = 0; ; i += 1000) { // 1000行ずつの頁（点検表 3）
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, brain_action, decision_id, staff_aix, verdict")
      .gte("customer_turn_at", sinceIso).order("customer_turn_at", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000 || out.length >= 10000) break;
  }
  return out.filter((w) => !isTestConversation(w.conversation_id) && w.verdict && w.verdict !== "na");
}

async function readStaffMsgs(convs: string[], sinceIso: string): Promise<Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>> {
  const m = new Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>();
  for (let i = 0; i < convs.length; i += 100) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated").in("conversation_id", convs.slice(i, i + 100))
        .neq("sender", "customer").gte("created_at", sinceIso).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = m.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), writer: (r.staff_writer as string | null) ?? null, isAix: !!r.is_aix_generated });
        m.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  return m;
}

/** 試験の問題（spec.json）の会話・時刻 → 場面（本番の番の scene_key） */
function problemsByScene(turns: W[]): { byScene: Map<string, string[]>; probTurn: Map<string, W> } {
  const byScene = new Map<string, string[]>(), probTurn = new Map<string, W>();
  let spec: Array<{ id: string; conv?: string; at?: string }> = [];
  try { const j = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")); spec = Array.isArray(j) ? j : (j.problems ?? Object.values(j)); } catch { /* */ }
  const idx = new Map<string, W[]>(); for (const w of turns) { const a = idx.get(w.conversation_id) ?? []; a.push(w); idx.set(w.conversation_id, a); }
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

/** 試験の DeepSeek の答え（今日までの結果の行の一番新しい答え・道の系統） */
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
  const cut = new Date(now - DAYS * 86_400_000).toISOString();
  const since = new Date(now - 2 * DAYS * 86_400_000).toISOString();
  const turns = await readTurns(since);
  const msgs = await readStaffMsgs([...new Set(turns.map((w) => w.conversation_id))], since);
  const toYard = (w: W): YardTurn => {
    const fm = staffFirstMove(Date.parse(w.customer_turn_at), msgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    return { scene: w.scene_key, brain: aixFamily(w.brain_action), staff: aixFamily(fm?.kind === "aix" ? fm.aix : null), writer: fm?.writer ?? "unknown", at: w.customer_turn_at, principleOk: null };
  };
  const before = turns.filter((w) => w.customer_turn_at < cut).map(toYard), after = turns.filter((w) => w.customer_turn_at >= cut).map(toYard);
  const drift = sceneDrift(countByScene(before), countByScene(after));
  const { byScene, probTurn } = problemsByScene(turns);
  const targets = problemsForDrift(drift, byScene);
  // 割れの表: 試験の問題になっている本番の番で、本番の Claude の道（brain_action）と試験の DeepSeek の答え
  const ans = latestExamAnswers();
  const pairs = [...probTurn].filter(([id]) => ans.has(id)).map(([id, w]) => ({ scene: w.scene_key, claude: aixFamily(w.brain_action), deepseek: ans.get(id)! }));
  const split = modelSplitTable(pairs);
  const out = {
    at: new Date().toISOString(), days: DAYS, turns: { before: before.length, after: after.length },
    down: drift.filter((d) => d.verdict === "down").map((d) => ({ scene: d.scene, before: d.before, after: d.after, pBefore: +d.pBefore.toFixed(3), pAfter: +d.pAfter.toFixed(3) })),
    few: drift.filter((d) => d.verdict === "few").length,
    examTargets: targets, beyond: beyondCandidates(after).length,
    split: Object.fromEntries([...split].map(([k, v]) => [k, { n: v.n, agree: v.agree, rate: +v.rate.toFixed(3) }])),
  };
  const dir = join(examCacheRoot(), "prod-yardstick"); mkdirSync(dir, { recursive: true });
  const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(out, null, 1));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(out)); return; }
  console.log(`# 本番の物差し（竹内さんの番・前 ${before.length}番 → 今 ${after.length}番・直近 ${DAYS}日ずつ・LLM なし）`);
  console.log(`- はっきり下がった場面: ${out.down.length ? out.down.map((d) => `${d.scene}（${Math.round(d.pBefore * 100)}%→${Math.round(d.pAfter * 100)}%・${d.after.n}番）`).join("・") : "なし"}（少なくて待つ場面 ${out.few}）`);
  console.log(`- 試験に積む問題（下がった場面だけ）: ${targets.length ? targets.join(",") : "なし"}`);
  console.log(`- 割れの表（本番の Claude × 試験の DeepSeek・同じ番 ${pairs.length}）: ${[...split].sort((a, b) => a[1].rate - b[1].rate).slice(0, 8).map(([k, v]) => `${k} ${v.agree}/${v.n}`).join("・") || "なし"}`);
  console.log(`- 置き場: ${join(dir, `${day}.json`)}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
