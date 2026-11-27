// scripts/switch-life.ts — 台帳 #816「スイッチの一生の台帳」（LLM なし・費用0・DB は台帳と設計知見の軽い読みだけ）
// 2026-11-27 作業員L（竹内さん 11/27「ブレインの管理を任せる土台」・統括役の頼み）。計算は scripts/lib/switch-life.ts
//   材料: コードの既定（app/lib・app/api）・本番の env（係が控える <exam-cache>/exam-queue/prod-env.json）・段階の名簿（STAGED_SWITCHES）・
//         台帳（work_items の switch_name）・印（SWITCH_TARGET_MARK・SWITCH_REACH）・試験の辞書（<exam-cache>/exam-dictionary.json）・
//         RAG（--rag=<exam-problem-rag の --out>・--pf=<昼の届きの確かめの json,...>）・前の回（--results=<brain-exam/results>）・設計知見（名前の出る現行の行の id だけ）
//   既定は一覧を出すだけ。--ledger で「試す／退役」の候補を台帳に積む（題で重ねない）。--json で表を書く。--morning で朝の1枚の1行だけ
// 実行: npx tsx --env-file=.env.local scripts/switch-life.ts [--write] [--results=<dir>] [--rag=<json>] [--pf=<json,...>] [--json=<file>] [--ledger] [--morning]
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { scanCodeDefaults } from "./lib/rule-code-drift";
import { SWITCH_REACH, onSwitchesOfMeta } from "./lib/exam-switch-reach";
import { SWITCH_TARGET_MARK } from "./lib/exam-snapshot-need";
import { STAGED_SWITCHES } from "../app/lib/switch-stage";
import { stageText } from "../app/lib/rollout";
import type { ExamDictionary } from "./lib/exam-dictionary";
import { readRunsWithMarks } from "./build-exam-dictionary";
import { lifeLedgerTitle, lifeLine, lifeMorningLine, lifeRowOf, ownerPurposeFromCode, type LifeLedger, type LifeRow } from "./lib/switch-life";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => process.argv.includes(`--${k}`);
export const SWITCH_LIFE_FILE = () => join(examCacheRoot(), "switch-life.json");
const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return null; } };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();
  const code = scanCodeDefaults(["app/lib", "app/api"]);
  const prodEnv = readJson<{ env?: Record<string, string> }>(join(examCacheRoot(), "exam-queue", "prod-env.json"))?.env ?? {};
  const staged = new Map(STAGED_SWITCHES.map((s) => [s.name, stageText(s.defaultStage)]));
  // 台帳（switch_name のある行・数百行）
  const { data: wi, error: wiErr } = await sb.from("work_items").select("id, title, stage, owner, switch_name, switch_default, exam_result, exam_labels, kb_ids, next_step, blocker, requested_at").not("switch_name", "is", null).limit(3000);
  if (wiErr) throw new Error(`work_items: ${wiErr.message}`);
  const ledgerOf = new Map<string, LifeLedger>(); for (const r of (wi ?? []) as Array<LifeLedger & { switch_name: string }>) { const prev = ledgerOf.get(r.switch_name); if (!prev || r.id > prev.id) ledgerOf.set(r.switch_name, r); }
  // 対象: コードで既定 off／段階 の物と、台帳で既定 off／記録だけ の物
  const names = [...new Set([...[...code.defaults].filter(([, d]) => d === "off" || d === "staged").map(([n]) => n), ...[...ledgerOf.values()].filter((l) => l.switch_default !== "on").map((l) => (l as LifeLedger & { switch_name: string }).switch_name)])].sort();
  // 設計知見: 名前の出る現行の行の id（題と本文から名前で絞る・id と名前だけ持ち帰る）
  const kbOf = new Map<string, string[]>();
  for (let i = 0; i < names.length; i += 40) {
    const part = names.slice(i, i + 40);
    const or = part.map((n) => `title.ilike.%${n}%,insight.ilike.%${n}%`).join(",");
    const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, priority, created_at").eq("is_current", true).or(or).order("created_at", { ascending: false }).limit(400);
    if (error) { console.warn(`[life] 設計知見を読めない: ${error.message}`); break; }
    for (const r of (data ?? []) as Array<{ id: string; title: string | null; insight: string | null; priority: number | null }>) {
      const t = `${r.title ?? ""} ${r.insight ?? ""}`;
      for (const n of part) if (new RegExp(`(^|[^A-Z0-9_])${n}([^A-Z0-9_]|$)`).test(t)) { const xs = kbOf.get(n) ?? []; if (xs.length < 3) xs.push(r.id.slice(0, 8)); kbOf.set(n, xs); }
    }
  }
  // 試験の辞書・RAG・昼の届きの確かめ
  const dict = readJson<ExamDictionary>(join(examCacheRoot(), "exam-dictionary.json"));
  const rag = arg("rag") ? readJson<{ results?: Record<string, { reached?: string[] }> }>(arg("rag")) : null;
  const pfReached = new Map<string, Set<string>>();
  for (const f of arg("pf").split(",").filter(Boolean)) for (const [sw, v] of Object.entries(readJson<{ results?: Record<string, { reached?: string[] }> }>(f)?.results ?? {})) { const s = pfReached.get(sw) ?? new Set<string>(); for (const id of v.reached ?? []) s.add(id); pfReached.set(sw, s); }
  // 前の回: meta の on のスイッチと日（同時の on が 3 以下の組）・印の出た問題
  const resultsDir = arg("results", join("scripts", "brain-exam", "results"));
  const lastExam = new Map<string, { label: string; at: string }>();
  const reachedOf = new Map<string, Set<string>>();
  if (resultsDir && existsSync(resultsDir)) {
    for (const f of readdirSync(resultsDir)) {
      if (!f.endsWith(".meta.json") || f.startsWith("main-")) continue;
      const m = readJson<{ startedAt?: string; envFp?: { pairs?: Record<string, string> } }>(join(resultsDir, f)); if (!m?.startedAt) continue;
      // 束ねた組（on が 4 以上）も「試験はあった」と数える（届きの数は下で 3 以下の組だけ）
      const on = onSwitchesOfMeta(m); if (!on.length) continue;
      for (const sw of on) { const prev = lastExam.get(sw); if (!prev || prev.at < m.startedAt) lastExam.set(sw, { label: f.replace(/\.meta\.json$/, ""), at: m.startedAt }); }
    }
    for (const r of readRunsWithMarks(resultsDir).runs) {
      if (r.switches.length > 3) continue;
      for (const sw of r.switches) { const marks = [SWITCH_TARGET_MARK[sw], (SWITCH_REACH[sw] as { mark?: string } | undefined)?.mark].filter(Boolean) as string[]; const s = reachedOf.get(sw) ?? new Set<string>(); for (const row of r.rowsFull) if (marks.some((k) => Number(row.marks?.[k] ?? 0) > 0)) s.add(row.id); reachedOf.set(sw, s); }
    }
  }
  // 台帳の exam_labels → 係の結果（<exam-cache>/exam-queue/results/<label>.json の at）。無ければ名前の4桁（MMDD）
  const queueDir = join(examCacheRoot(), "exam-queue", "results");
  const labelAt = (label: string): string | null => {
    const j = readJson<{ at?: string }>(join(queueDir, `${label}.json`)); if (j?.at) return j.at;
    const m = label.match(/(?:^|[^0-9])(1[0-2]|0[1-9])([0-3][0-9])(?:[^0-9]|$)/); if (!m) return null;
    const y = Number(nowIso.slice(0, 4)) - (Number(m[1]) > Number(nowIso.slice(5, 7)) ? 1 : 0); return `${y}-${m[1]}-${m[2]}T12:00:00.000Z`;
  };
  for (const [sw, l] of ledgerOf) for (const label of l.exam_labels ?? []) { const at = labelAt(label); if (!at) continue; const prev = lastExam.get(sw); if (!prev || prev.at < at) lastExam.set(sw, { label, at }); }
  const srcCache = new Map<string, string>(); const src = (f: string) => { if (!srcCache.has(f)) { try { srcCache.set(f, readFileSync(f, "utf8")); } catch { srcCache.set(f, ""); } } return srcCache.get(f)!; };
  const rows: LifeRow[] = names.map((sw) => {
    const where = code.where.get(sw) ?? [];
    const ops = where.map((f) => ownerPurposeFromCode(src(f), sw));
    const op = ops.find((x) => x.owner) ?? { owner: null, purpose: null };
    const madeAt = ops.map((x) => x.madeAt).filter((x): x is string => !!x).sort()[0] ?? null;
    // コードの既定が見つからない名前は、どこに出るかを git grep で（app のどこか・scripts だけ・どこにも無い）。app が cron だけなら cron の物
    let seen: "app" | "scripts" | "none" | undefined; let cronOnly = false;
    if (!where.length) {
      const g = (paths: string[]) => { try { return execFileSync("git", ["grep", "-l", "-w", sw, "--", ...paths], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean); } catch { return []; } };
      const inApp = g(["app"]).filter((x) => !x.includes("__tests__"));
      seen = inApp.length ? "app" : g(["scripts", "chrome-extension"]).length ? "scripts" : "none";
      cronOnly = inApp.length > 0 && inApp.every((x) => x.startsWith("app/api/cron/"));
    }
    const def = SWITCH_REACH[sw] as { mark?: string; eff?: string[]; notExam?: string } | undefined;
    const ledger = ledgerOf.get(sw) ?? null;
    const ragSet = new Set([...(rag?.results?.[sw]?.reached ?? []), ...(pfReached.get(sw) ?? [])]);
    return lifeRowOf({
      sw, code: code.defaults.get(sw) ?? null, where, prod: prodEnv[sw] ?? null, staged: staged.get(sw) ?? null, revert: code.revert.has(sw),
      cron: cronOnly || (where.length > 0 && where.every((w) => w.includes("app/api/cron/"))), notExam: def?.notExam ?? null, seen, madeAt,
      ledger, codeOwner: op.owner, codePurpose: op.purpose,
      mark: SWITCH_TARGET_MARK[sw] ?? def?.mark ?? null, dictN: dict?.switches[sw]?.withMaterial?.length ?? 0, effN: def?.eff?.length ?? 0, ragN: ragSet.size,
      lastExam: lastExam.get(sw) ?? null, reachedN: reachedOf.has(sw) ? reachedOf.get(sw)!.size : null,
      kbIds: [...new Set([...(ledger?.kb_ids ?? []).map((x) => String(x).slice(0, 8)), ...(kbOf.get(sw) ?? [])])],
    }, nowIso);
  });
  // 作った日: 候補の行だけ git の pickaxe（-S・1つ 6〜8秒）で名前が最初に入った commit の日を引き、<exam-cache>/switch-life-born.json に覚える（2回目からは読むだけ）。
  //   コメントの日（madeAt）は同じ塊の古い決めの日を拾う＝作った日より古く出る（ACK_SOFT_NEXT が 11/27 に作ったのに候補になった）
  const bornFile = join(examCacheRoot(), "switch-life-born.json");
  const born = readJson<Record<string, string | null>>(bornFile) ?? {};
  let bornNew = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k]; if (!r.candidate || flag("no-born")) continue;
    if (!(r.sw in born)) { try { const out = execFileSync("git", ["log", "--format=%cI", "-S", r.sw, "--", "app"], { encoding: "utf8", maxBuffer: 1 << 24 }).trim().split(/\r?\n/).filter(Boolean); born[r.sw] = out.length ? new Date(out[out.length - 1]).toISOString() : null; } catch { born[r.sw] = null; } bornNew++; if (bornNew % 10 === 0) writeFileSync(bornFile, JSON.stringify(born)); }
    const b = born[r.sw]; if (b) { const { state, owner, purpose, daysSinceExam, candidate, why, ...inp } = r; void state; void owner; void purpose; void daysSinceExam; void candidate; void why; rows[k] = lifeRowOf({ ...inp, madeAt: b }, nowIso); }
  }
  if (bornNew) writeFileSync(bornFile, JSON.stringify(born));
  const line = lifeMorningLine(rows);
  if (flag("morning")) { console.log(line); return; }
  const by = (s: string) => rows.filter((r) => r.state === s).length;
  console.log(`${line}\n状態: off ${by("off")}・記録だけ ${by("記録だけ")}・段階 ${by("段階")}・on ${by("on")}・凍結 ${by("凍結")}・退役 ${by("退役")}・戻し口 ${by("戻し口")}（全 ${rows.length}）`);
  for (const k of ["試す", "退役", "印が先"] as const) { const xs = rows.filter((r) => r.candidate === k); console.log(`\n── ${k}の候補 ${xs.length} ──`); for (const r of xs) console.log(lifeLine(r)); }
  if (flag("all")) { console.log("\n── 全部 ──"); for (const r of rows) console.log(lifeLine(r)); }
  // --write: 朝の1枚（self-improve）が読む置き場 <exam-cache>/switch-life.json に（晩の費用0の仕事）
  const jsonOut = arg("json") || (flag("write") ? SWITCH_LIFE_FILE() : "");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: nowIso, line, rows: rows.map(({ where, ...r }) => ({ ...r, where: where.slice(0, 2) })) }, null, 1));
  if (flag("ledger")) {
    const { data: open } = await sb.from("work_items").select("title").like("title", "【スイッチの一生】%").limit(2000);
    const have = new Set(((open ?? []) as Array<{ title: string }>).map((r) => r.title)); let n = 0;
    // 印が先は数が多い（印の無い部品の全部）＝ --ledger-mark の時だけ積む
    for (const r of rows.filter((x) => x.candidate && (x.candidate !== "印が先" || flag("ledger-mark")))) {
      const title = lifeLedgerTitle(r); if (have.has(title)) continue;
      const { error } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: "土台", owner: r.owner ?? "統括役", priority: r.candidate === "試す" ? 10 : r.candidate === "退役" ? 5 : 3, next_step: `${r.why}${r.ledger ? `・元の台帳 #${r.ledger.id}` : ""}（scripts/switch-life.ts・#816）` });
      if (!error) { n++; have.add(title); } else console.warn(`[life] 積めない ${r.sw}: ${error.message}`);
    }
    console.log(`\n台帳に積んだ: ${n}`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
