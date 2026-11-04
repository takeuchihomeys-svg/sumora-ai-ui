// scripts/unknowns-ingest.ts — 分からない事の3つの表（brain_unknowns・brain_weaknesses・owner_questions）へ、手元にある物を入れる台本
//
// 2026-11-05 竹内さんの決定（KB P1 3892c30c「分からない部分・知識の足りない部分は DB の3つの表に必ず集める」）・統括役の指示 ③④⑤・作業員1。
//   読むだけの元から表の行を作る（LLM なし・$0）。サーバーの鍵（SUPABASE_SERVICE_ROLE_KEY）があれば書く。無ければ SQL を出す（--sql-out=<file>）
//   ＝表は RLS が有効で公開キーでは書けない。SQL は MCP の execute_sql 等で流す。
//
//   ③ --exam-regressions   … 試験の係の結果（.claude/exam-cache/exam-queue/results/*.json）の「確かな悪化」（worseSure）→ brain_unknowns kind=exam_regression
//                             （入れた結果は exam-queue/results/.unknowns-ingested.json に控え、同じ結果を二度数えない）
//   ④ --owner-questions=<json> … Docs の確認事項のページの開いている問い（[{topic, question, recommended?, why?, source_ref, priority?}]）→ owner_questions
//                             （dedupe_key は "docs:" + source_ref。同じ問いは足さない）
//   ⑤ --weaknesses=<json>   … memory の弱い所・知識の穴の一覧の開いている物（[{key, title, area, symptom?, root_cause?, status?}]）→ brain_weaknesses
//      --unknowns=<json>    … 同じく分からない事（[{kind, key, label, ref?}]）→ brain_unknowns
// 実行: npx tsx --env-file=.env.local scripts/unknowns-ingest.ts --exam-regressions [--since=2026-11-04] [--sql-out=<file>] [--dry]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { aggregateUnknowns, type UnknownHit, type UnknownAgg } from "../app/lib/brain-unknowns";
import { examRegressionHits, type ExamResultLite } from "../app/lib/unknowns-intake";
import { weaknessHitsFromUnknownAggs, aggregateWeaknessHits, type WeaknessHit } from "../app/lib/brain-weaknesses";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const DRY = flag("dry");
const SQL_OUT = arg("sql-out");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const sb = url && key ? createClient(url, key) : null;

const q = (s: unknown) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const j = (o: unknown) => `${q(JSON.stringify(o))}::jsonb`;
const sql: string[] = [];

/** 分からない事のまとめ → SQL（数は足す・例は新しい物を前に・最後の時刻は大きい方） */
export function unknownsSql(aggs: ReadonlyArray<UnknownAgg>, nowIso: string): string[] {
  return aggs.map((a) => `insert into brain_unknowns (kind, key, label, sample_ref, count, first_at, last_at) values (${q(a.kind)}, ${q(a.key)}, ${q(a.label)}, ${j(a.refs)}, ${a.n}, ${q(a.lastAt ?? nowIso)}, ${q(a.lastAt ?? nowIso)})
on conflict (kind, key) do update set count = brain_unknowns.count + excluded.count, label = excluded.label, last_at = greatest(brain_unknowns.last_at, excluded.last_at), sample_ref = (select jsonb_agg(x) from (select x from jsonb_array_elements(excluded.sample_ref || coalesce(brain_unknowns.sample_ref, '[]'::jsonb)) x limit 5) s);`);
}
/** 弱い所 → SQL（数は足す・状態は今のまま・証拠は足す） */
export function weaknessesSql(hits: ReadonlyArray<WeaknessHit & { root_cause?: string; status?: string }>, nowIso: string): string[] {
  return hits.map((h) => `insert into brain_weaknesses (key, title, area, symptom, root_cause, status, evidence, occurrences, first_seen, last_seen) values (${q(h.key)}, ${q(h.title)}, ${q(h.area)}, ${q(h.symptom ?? null)}, ${q(h.root_cause ?? null)}, ${q(h.status ?? "open")}, ${j(h.evidence ?? {})}, ${h.n ?? 1}, ${q(h.at ?? nowIso)}, ${q(h.at ?? nowIso)})
on conflict (key) do update set occurrences = brain_weaknesses.occurrences + excluded.occurrences, last_seen = greatest(brain_weaknesses.last_seen, excluded.last_seen), evidence = brain_weaknesses.evidence || excluded.evidence, updated_at = now();`);
}

async function writeUnknowns(hits: UnknownHit[], what: string): Promise<void> {
  const aggs = aggregateUnknowns(hits);
  const nowIso = new Date().toISOString();
  console.log(`${what}: 分からない事 ${hits.length}件 → ${aggs.length}行（${aggs.slice(0, 8).map((a) => `${a.kind}/${a.key}×${a.n}`).join("・")}${aggs.length > 8 ? " …" : ""}）`);
  if (DRY || !aggs.length) return;
  const wk = aggregateWeaknessHits(weaknessHitsFromUnknownAggs(aggs, () => undefined));
  if (sb) {
    const { upsertUnknowns } = await import("../app/lib/brain-unknowns-server");
    const { upsertWeaknessHits } = await import("../app/lib/brain-weaknesses-server");
    const r = await upsertUnknowns(sb, aggs, nowIso);
    const w = await upsertWeaknessHits(sb, weaknessHitsFromUnknownAggs(aggs, r.idOf));
    console.log(`  書いた: brain_unknowns ${r.rows}行・brain_weaknesses ${w.rows}行`);
  } else {
    sql.push(...unknownsSql(aggs, nowIso), ...weaknessesSql(wk, nowIso));
    console.log(`  サーバーの鍵が無い → SQL ${aggs.length + wk.length}文（--sql-out）`);
  }
}

async function examRegressions(): Promise<void> {
  const root = join(execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim(), "..", ".claude", "exam-cache", "exam-queue", "results");
  const doneFile = join(root, ".unknowns-ingested.json");
  const done = new Set<string>(existsSync(doneFile) ? (JSON.parse(readFileSync(doneFile, "utf8")) as string[]) : []);
  const since = arg("since", "2026-11-01");
  const hits: UnknownHit[] = [], took: string[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith(".json") && !x.startsWith("."))) {
    let r: ExamResultLite & { at?: string; runner?: string } | null = null;
    try { r = JSON.parse(readFileSync(join(root, f), "utf8")); } catch { continue; }
    if (!r?.label || !r.at || r.at < since || !r.worseSure?.length) continue;
    const id = `${r.label}@${r.at}`;
    if (done.has(id)) continue;
    hits.push(...examRegressionHits(r)); took.push(id);
  }
  await writeUnknowns(hits, `③ 試験の悪化（${took.length}本の結果）`);
  if (!DRY && took.length && (sb || SQL_OUT)) writeFileSync(doneFile, JSON.stringify([...done, ...took], null, 1));
}

async function ownerQuestions(file: string): Promise<void> {
  const items = JSON.parse(readFileSync(file, "utf8")) as Array<{ topic: string; question: string; recommended?: string; why?: string; source_ref: string; priority?: number; options?: string[] }>;
  const rows = items.filter((x) => x.question && x.source_ref).map((x) => ({ kind: "question", topic: x.topic ?? "その他", question: x.question, options: x.options ?? null, recommended: x.recommended ?? null, why: x.why ?? null,
    source_kind: "docs", source_ref: x.source_ref, status: "open", priority: x.priority ?? 2, dedupe_key: `docs:${x.source_ref}` }));
  console.log(`④ 確認事項のページ: 開いている問い ${rows.length}`);
  if (DRY || !rows.length) return;
  if (sb) {
    const { error } = await sb.from("owner_questions").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    console.log(`  書いた: owner_questions ${rows.length}行（同じ dedupe_key は足さない）`);
  } else {
    for (const r of rows) sql.push(`insert into owner_questions (kind, topic, question, options, recommended, why, source_kind, source_ref, status, priority, dedupe_key) values ('question', ${q(r.topic)}, ${q(r.question)}, ${r.options ? j(r.options) : "null"}, ${q(r.recommended)}, ${q(r.why)}, 'docs', ${q(r.source_ref)}, 'open', ${r.priority}, ${q(r.dedupe_key)}) on conflict (dedupe_key) do nothing;`);
  }
}

async function weaknessesFile(file: string): Promise<void> {
  const items = JSON.parse(readFileSync(file, "utf8")) as Array<WeaknessHit & { root_cause?: string; status?: string }>;
  console.log(`⑤ 弱い所: ${items.length}行`);
  if (DRY || !items.length) return;
  sql.push(...weaknessesSql(items.map((x) => ({ ...x, evidence: x.evidence ?? {}, n: x.n ?? 1 })), new Date().toISOString()));
  if (sb) console.log("  （弱い所の手入れはサーバーの鍵があっても SQL で出す＝状態・根を人が書いた物なので scripts/brain-weaknesses.ts の決まった計算と混ぜない）");
}

async function unknownsFile(file: string): Promise<void> {
  const items = JSON.parse(readFileSync(file, "utf8")) as UnknownHit[];
  await writeUnknowns(items.map((x) => ({ ...x, ref: x.ref ?? {} })), "⑤ 分からない事");
}

(async () => {
  if (flag("exam-regressions")) await examRegressions();
  if (arg("owner-questions")) await ownerQuestions(arg("owner-questions"));
  if (arg("weaknesses")) await weaknessesFile(arg("weaknesses"));
  if (arg("unknowns")) await unknownsFile(arg("unknowns"));
  if (sql.length) {
    if (SQL_OUT) { writeFileSync(SQL_OUT, sql.join("\n") + "\n"); console.log(`SQL ${sql.length}文 → ${SQL_OUT}`); }
    else console.log(`SQL ${sql.length}文（--sql-out=<file> で書き出す）`);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
