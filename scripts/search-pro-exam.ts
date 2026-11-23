/**
 * 統括Pro（物件検索）の段A（2026-11-21 作業員G）— 凍結した問題集を今のコードの決定論で再生して正解と比べる。費用0（LLM なし）。
 *
 *   凍結（1回だけ・軽い読み 10行＋束の一部3行）:
 *     npx tsx --env-file=.env.local scripts/search-pro-exam.ts --freeze
 *   毎晩（DB を読まない。--write-quality の時だけ quality_daily に1行）:
 *     npx tsx scripts/search-pro-exam.ts                       # 再生して正解と比べる
 *     npx tsx scripts/search-pro-exam.ts --save-baseline       # 今の結果を基準にする（main の取り置き）
 *     npx tsx --env-file=.env.local scripts/search-pro-exam.ts --write-quality   # search_pro_misjudge を quality_daily へ
 *   終了コード: 基準より悪くなった問題があれば 1（--baseline が無い時は正解と違う問題の数は見るだけ）
 *
 * 置き場所: 材料 <repo>/.claude/exam-cache/search-pro-exam/cases.json（git に入れない）・正解 scripts/search-pro-exam/truth.json
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  compareProExam, judgeCase, misjudgeRow, replayCase, stripDerived, judgeStageB, proTextFromEvidence, type StageBTruth,
  type ProExamCase, type ProExamResult, type ProExamTruth,
} from "../app/lib/search-pro-exam";

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);

function repoRoot(): string {
  const common = execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
  return resolve(dirname(resolve(common)));
}
const CACHE = join(repoRoot(), ".claude", "exam-cache", "search-pro-exam");
const CASES = join(CACHE, "cases.json");
const BASE = join(CACHE, "baseline.json");
const LAST = join(CACHE, "last.json");
const TRUTH = join(__dirname, "search-pro-exam", "truth.json");

/** 写真の届きを見る問題（束の一部も凍結する） */
const BUNDLE_KEYS = ["shot_gaps", "shot_gaps_normal", "photo_kinds", "image_match", "source", "bundle_reflect", "foundation_audit", "shots"];

async function freeze() {
  const { supabase: sb } = await import("../app/lib/supabase-server");
  const truth = JSON.parse(readFileSync(TRUTH, "utf8")) as Array<ProExamTruth & { log_id: number; with_bundle?: boolean }>;
  if (existsSync(CASES) && !flag("force")) throw new Error(`もう凍結してある: ${CASES}（作り直すのは --force）`);
  const out: ProExamCase[] = [];
  for (const t of truth) {
    const { data: row, error } = await sb.from("learn_supervisor_log").select("id, scope, created_at, meeting").eq("id", t.log_id).maybeSingle();
    if (error || !row) { console.log(`  ✗ ${t.id}: 行が無い（${error?.message ?? "なし"}）`); continue; }
    const r = row as { id: number; scope: string; created_at: string; meeting: { evidence?: unknown[] } | null };
    let bundle: Record<string, unknown> | null = null;
    if (t.with_bundle) {
      const { data: b } = await sb.from("human_learn_profile").select("id, created_at, bundle")
        .eq("scope", r.scope).lte("created_at", r.created_at).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const bb = (b as { id: number; bundle: Record<string, unknown> } | null);
      if (bb?.bundle) {
        bundle = { _bundle_id: bb.id };
        for (const k of BUNDLE_KEYS) if (k in bb.bundle) bundle[k] = bb.bundle[k];
      }
    }
    out.push({
      id: t.id, log_id: r.id, scope: r.scope, logged_at: r.created_at, frozen_at: new Date().toISOString(),
      evidence: stripDerived((r.meeting?.evidence || []) as never[]), bundle,
    });
    console.log(`  凍結 ${t.id}（log ${r.id}・${r.scope}・根拠 ${(r.meeting?.evidence || []).length}行${bundle ? `・束 ${bundle._bundle_id}` : ""}）`);
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(CASES, JSON.stringify(out));
  console.log(`凍結した: ${out.length}件 → ${CASES}`);
}

async function run() {
  if (!existsSync(CASES)) throw new Error(`問題集が無い: ${CASES}（先に --freeze）`);
  const cases = JSON.parse(readFileSync(CASES, "utf8")) as ProExamCase[];
  const truth = new Map((JSON.parse(readFileSync(TRUTH, "utf8")) as ProExamTruth[]).map((t) => [t.id, t]));
  const results: ProExamResult[] = [];
  let stageB = 0;
  for (const c of cases) {
    const t = truth.get(c.id);
    if (!t) continue;
    if (t.stage_b_only) stageB++;
    const replay = replayCase(c);
    const j = judgeCase(t, replay);
    results.push({ id: c.id, ok: j.ok, misses: j.misses, replay });
    const ly = Object.entries(replay.cause.layers).map(([k, v]) => `${k}${v}`).join("・") || "—";
    console.log(`${j.ok ? "✓" : "✗"} ${c.id}  先頭=${replay.cause.bottleneck_layer ?? "—"}  層=${ly}  F=${replay.cause.f_ids.slice(0, 5).join(",") || "—"}  土台=${replay.foundation.ok ?? "?"}/${replay.foundation.total ?? "?"}  完成度=${replay.completion ?? "?"}${replay.photo_learned != null ? `  学べた=${replay.photo_learned}` : ""}`);
    for (const m of j.misses) console.log(`     ・${m}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n正解と違う: ${bad}/${results.length}（段Bでだけ見る誤りの問題 ${stageB}件は段Aの判定に含めない）`);
  writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), results }));
  if (flag("save-baseline")) { writeFileSync(BASE, JSON.stringify({ at: new Date().toISOString(), results })); console.log(`基準にした → ${BASE}`); }
  let worseN = 0;
  if (existsSync(BASE) && !flag("save-baseline")) {
    const base = JSON.parse(readFileSync(BASE, "utf8")) as { at: string; results: ProExamResult[] };
    const cmp = compareProExam(base.results, results);
    worseN = cmp.worse.length;
    console.log(`基準（${base.at}）と比べ: 悪くなった ${cmp.worse.length}（${cmp.worse.join(",") || "—"}）・良くなった ${cmp.better.length}（${cmp.better.join(",") || "—"}）・原因の原子が変わった ${cmp.changed.length}`);
  }
  if (flag("write-quality")) {
    const { writeSearchQualityRows } = await import("../app/lib/search-quality-daily");
    const n = await writeSearchQualityRows([misjudgeRow(results, stageB)], "search-pro-exam");
    console.log(`quality_daily: ${n}行`);
  }
  process.exit(worseN > 0 ? 1 : 0);
}

/**
 * 段B の下ごしらえ（11/23 作業員G・LLM なし）: 凍結した根拠の行の中の統括Pro の文（元の答え）に段B の判定を当てる。
 *   元の誤判定を拾えれば、夜に作り直した文に同じ判定を当てる物差しとして使える。
 *   npx tsx scripts/search-pro-exam.ts --stage-b-dry
 */
async function stageBDry() {
  if (!existsSync(CASES)) throw new Error(`問題集が無い: ${CASES}`);
  const cases = JSON.parse(readFileSync(CASES, "utf8")) as ProExamCase[];
  const truth = new Map((JSON.parse(readFileSync(TRUTH, "utf8")) as StageBTruth[]).map((t) => [t.id, t]));
  let judged = 0, bad = 0;
  for (const c of cases) {
    const t = truth.get(c.id); if (!t) continue;
    const r = judgeStageB(t, proTextFromEvidence(c.evidence));
    if (!r.judged) continue;
    judged++; if (!r.ok) bad++;
    console.log(`${r.ok ? "✓" : "✗"} ${c.id}  言ってはいけない言い方: ${r.forbidHits.join(" ／ ") || "—"}${r.expectMissing.length ? `・足りない: ${r.expectMissing.join(" ／ ")}` : ""}`);
  }
  console.log(`段B（元の統括Pro の文）: 判定した ${judged}件・誤りを言っていた ${bad}件`);
}

(flag("freeze") ? freeze() : flag("stage-b-dry") ? stageBDry() : run()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
