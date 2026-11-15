// scripts/audit-situation-grasp.ts — 現状把握の物差しを試験の答案に当てる（読むだけ・LLM なし・DB なし・費用0）
//
// 2026-11-15 作業員L。答案の行（brain-exam/results/<label>.jsonl）× 問題（.claude/exam-cache/brain-exam-problems/<id>/*.json＝その番の時点の台帳の写し）
//   × 録音の入力（llm-cassette の brain_fresh）で、欄ごとに 持っていた／DB にあったのに持っていなかった／DB にも無かった／食い違い を数え、
//   竹内さん本人の番で割合を出す。その番の道の当たり（本質の道 essence.ok・最終の道 score.path）と、どの欄の把握漏れが重なるかも並べる。
// 実行: npx tsx scripts/audit-situation-grasp.ts --results=<jsonl,…> [--problems=<dir>] [--cassette=<dir>] [--json=<出力>] [--all（竹内さん以外の番も）] [--write]
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { graspOfTurn, tallyGrasp, graspLine, GRASP_FIELDS, FIELD_LABEL, type GraspRow, type ProblemLike, type Grasp } from "./lib/situation-grasp";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = resolve(__dirname, "..");
const CACHE = resolve(ROOT, "../../exam-cache");
const PROB = arg("problems", join(existsSync(CACHE) ? CACHE : resolve(ROOT, ".claude/exam-cache"), "brain-exam-problems"));
const CAS = arg("cassette", join(existsSync(CACHE) ? CACHE : resolve(ROOT, ".claude/exam-cache"), "llm-cassette"));
const txt = (x: unknown): string => (typeof x === "string" ? x : Array.isArray(x) ? x.map((p) => (p && typeof p === "object" ? String((p as { text?: unknown }).text ?? "") : "")).join("\n") : "");

type Ans = { id: string; rep?: number; llmCalls?: Array<{ key: string; action: string | null }>; essence?: { ok?: boolean | null } | null; score?: { path?: boolean | null } };
const files = arg("results").split(",").filter(Boolean).map((p) => (existsSync(resolve(process.cwd(), p)) ? resolve(process.cwd(), p) : resolve(ROOT, p)));
const rows: Ans[] = files.flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Ans]; } catch { return []; } }) : []));
const probCache = new Map<string, ProblemLike | null>();
const problemOf = (id: string) => {
  if (!probCache.has(id)) { const d = join(PROB, id); let p: ProblemLike | null = null; try { const f = readdirSync(d).find((x) => x.endsWith(".json")); if (f) p = JSON.parse(readFileSync(join(d, f), "utf8")) as ProblemLike; } catch { p = null; } probCache.set(id, p); }
  return probCache.get(id) ?? null;
};
const out: Array<GraspRow & { ess: boolean | null; fin: boolean | null; rep: number }> = [];
let noIn = 0;
const seen = new Set<string>();
for (const r of rows) {
  const k = `${r.id}#${r.rep ?? 0}`; if (seen.has(k)) continue; seen.add(k);
  const p = problemOf(r.id);
  const c = (r.llmCalls ?? []).find((x) => x.action === "brain_fresh") ?? (r.llmCalls ?? []).find((x) => x.action === "brain_full");
  const fp = c ? join(CAS, c.key.slice(0, 2), `${c.key}.json`) : "";
  if (!p || !c || !existsSync(fp)) { noIn++; continue; }
  let user = "";
  try { const e = JSON.parse(readFileSync(fp, "utf8")) as { normBody?: string }; const b = JSON.parse(e.normBody ?? "{}") as { messages?: Array<{ content?: unknown }> }; user = (b.messages ?? []).map((m) => txt(m.content)).join("\n"); } catch { noIn++; continue; }
  const g = graspOfTurn({ ...p, id: r.id }, user);
  out.push({ ...g, ess: r.essence?.ok ?? null, fin: r.score?.path ?? null, rep: r.rep ?? 0 });
}
const target = args.includes("--all") ? out : out.filter((x) => x.takeuchi);
const t = tallyGrasp(target);
const pc = (a: number, n: number) => (n ? `${a}/${n}（${Math.round((100 * a) / n)}%）` : "-");
console.log(`# 現状把握の物差し（答案 ${files.length} ファイル・番 ${out.length}・${args.includes("--all") ? "全部の番" : "竹内さん本人の番"} ${target.length}・入力の無い行 ${noIn}）`);
console.log(graspLine(t, target.length));
console.log("\n| 欄 | 持っていた | DB にあったのに持っていない（連携） | DB にも無い（土台） | 食い違い | 関係なし | 漏れの番の本質の道の外れ | 持っていた番の本質の道の外れ |");
console.log("|---|---|---|---|---|---|---|---|");
for (const k of GRASP_FIELDS) {
  const c = t[k]; const rel = c.held + c.link + c.base + c.conflict;
  const miss = target.filter((x) => ["link", "base", "conflict"].includes(x.f[k] as Grasp)), held = target.filter((x) => x.f[k] === "held");
  const e = (xs: typeof target) => { const ys = xs.filter((x) => x.ess !== null); return pc(ys.filter((x) => x.ess === false).length, ys.length); };
  console.log(`| ${FIELD_LABEL[k]} | ${pc(c.held, rel)} | ${c.link} | ${c.base} | ${c.conflict} | ${c.none} | ${e(miss)} | ${e(held)} |`);
}
if (arg("json")) writeFileSync(resolve(process.cwd(), arg("json")), JSON.stringify(target, null, 1));
// --write: cron_run_logs に cron_name=situation-grasp の1行（毎朝の拾い上げの「把握漏れの多い欄」・呼ぶのは作業員H の朝の cron か手元）
if (args.includes("--write")) {
  void (async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const now = new Date().toISOString();
    const { error } = await sb.from("cron_run_logs").insert({ cron_name: "situation-grasp", started_at: now, finished_at: now, ok: true, result_json: { summary: graspLine(t, target.length), n: target.length, tally: t } });
    console.log(error ? `書けなかった: ${error.message}` : "cron_run_logs に1行");
  })();
}
