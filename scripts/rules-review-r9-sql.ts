// scripts/rules-review-r9-sql.ts — 9巡目の学習ルールの総点検（app/lib/rules-review-r9.ts）を本番に流す SQL を出す（DB は読むだけ・書かない）
// 親が竹内さんに見せてから流す。控え（ai_prompt_rules_backup_r9）を作ってから無効化・書き換え・掃除。戻し方つき。updated_at は触らない（並びを変えないため）。
// ask（竹内さんに聞く）は SQL に入れず、コメントで案だけ出す。
// 流す順は2回: --stage=1（返信・global・永久・AIX の文とぶつかる物＋掃除）→ YUMA でブレインの振り分けを確かめる → --stage=2（AIX の振り分けの写し）
// 実行: npx tsx --env-file=.env.local scripts/rules-review-r9-sql.ts --stage=1|2 [--out=scripts/.replay-out/r9-rules-<段>.sql] [--no-sweep]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { RULES_REVIEW_R9, R9_SWEEP_WHERE } from "../app/lib/rules-review-r9";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const STAGE = Number(process.argv.find((a) => a.startsWith("--stage="))?.slice(8) ?? "1");
if (STAGE !== 1 && STAGE !== 2) throw new Error("--stage=1 か --stage=2");
const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? `scripts/.replay-out/r9-rules-${STAGE}.sql`;
const SWEEP = STAGE === 1 && !process.argv.includes("--no-sweep");
const q = (s: string) => `$r9$${s}$r9$`;
const one = (s: string) => s.replace(/\s*\n\s*/g, " ");

async function main() {
  const dupIds = RULES_REVIEW_R9.map((d) => d.id).filter((id, i, a) => a.indexOf(id) !== i);
  const all = RULES_REVIEW_R9.filter((d) => (d.stage ?? 1) === STAGE);
  // .in() に数百の id を1回で渡すと URL が長すぎる（設計知見【汎用】）→ 100ずつ
  const fetched: Array<{ id: string; rule_key: string; is_active: boolean; rule_text: string; is_permanent: boolean }> = [];
  for (let i = 0; i < all.length; i += 100) {
    const { data, error } = await sb.from("ai_prompt_rules").select("id, rule_key, is_active, rule_text, is_permanent").in("id", all.slice(i, i + 100).map((d) => d.id));
    if (error) throw new Error(error.message);
    fetched.push(...((data ?? []) as typeof fetched));
  }
  const rows = new Map(fetched.map((r) => [r.id, r]));
  const problems: string[] = dupIds.map((id) => `一覧に2回: ${id}`);
  for (const d of all) {
    const r = rows.get(d.id);
    if (!r) problems.push(`無い: ${d.id} ${d.key}`);
    else if (r.rule_key !== d.key) problems.push(`rule_key が違う: ${d.id} ${r.rule_key} ≠ ${d.key}`);
    else if (!r.is_active) problems.push(`既に無効: ${d.id} ${d.key}`);
    else if (!!r.is_permanent !== !!d.permanent) problems.push(`永久の印が違う: ${d.id} ${d.key}（DB ${r.is_permanent}）`);
    if (d.verdict === "edit" && !d.newText) problems.push(`edit なのに新しい文が無い: ${d.id}`);
  }
  const { count: sweepN } = await sb.from("ai_prompt_rules").select("id", { count: "exact", head: true })
    .eq("is_active", true).eq("action_type", "generate_reply").eq("is_permanent", false).lt("priority", 8).or("rule_key.like.FEEDBACK-%-gr,rule_key.like.WEEKLY-%");
  const act = all.filter((d) => d.verdict !== "ask");
  const ids = act.map((d) => `'${d.id}'`).join(",\n  ");
  const retire = act.filter((d) => d.verdict === "retire");
  const edit = act.filter((d) => d.verdict === "edit");
  const asks = all.filter((d) => d.verdict === "ask");
  const lines: string[] = [
    `-- 9巡目（2026-10-08）学習ルールの総点検・段 ${STAGE}/2（app/lib/rules-review-r9.ts・材料 scripts/audit-prompt-rules-r9.ts・scripts/audit-r9-phrases.ts）`,
    `-- 無効 ${retire.length}本（うち永久 ${retire.filter((d) => d.permanent).length}）・書き換え ${edit.length}本（うち永久 ${edit.filter((d) => d.permanent).length}）・竹内さんに聞く ${asks.length}本（SQL に入れない）` + (SWEEP ? `・掃除（届いていない -gr／WEEKLY p<8）${sweepN ?? "?"}本` : ""),
    "-- 流す前: problems が空か確かめる。updated_at は触らない。",
    problems.length ? `-- ⚠ problems:\n${problems.map((p) => `--   ${p}`).join("\n")}` : "-- problems: なし",
    "",
    "BEGIN;",
    "-- ① 控え（戻す時に使う）",
    "CREATE TABLE IF NOT EXISTS ai_prompt_rules_backup_r9 AS SELECT * FROM ai_prompt_rules WHERE false;",
    `INSERT INTO ai_prompt_rules_backup_r9 SELECT * FROM ai_prompt_rules WHERE id IN (\n  ${ids}\n) AND id NOT IN (SELECT id FROM ai_prompt_rules_backup_r9);`,
    "",
    "-- ② 無効にする（is_active=false）",
  ];
  for (const d of retire) lines.push(`UPDATE ai_prompt_rules SET is_active = false WHERE id = '${d.id}'; -- [${d.at}${d.permanent ? "・永久" : ""}] ${d.key}｜${one(d.why)}`);
  lines.push("", "-- ③ 書き換える（rule_text だけ）");
  for (const d of edit) lines.push(`-- [${d.at}${d.permanent ? "・永久" : ""}] ${d.key}｜${one(d.why)}\nUPDATE ai_prompt_rules SET rule_text = ${q(d.newText!)} WHERE id = '${d.id}';`);
  if (SWEEP) {
    lines.push("", "-- ④ 掃除（どの経路にも届いていない generate_reply の FEEDBACK-*-gr／WEEKLY の p8 未満。動きは変わらない・週の整理の読み込みが減る）",
      `INSERT INTO ai_prompt_rules_backup_r9 SELECT * FROM ai_prompt_rules WHERE ${R9_SWEEP_WHERE} AND id NOT IN (SELECT id FROM ai_prompt_rules_backup_r9);`,
      `UPDATE ai_prompt_rules SET is_active = false WHERE ${R9_SWEEP_WHERE};`);
  }
  lines.push("COMMIT;", "");
  if (asks.length) {
    lines.push("-- ⑤ 竹内さんに聞く（流さない・答えが出たら案のとおりに足す）");
    for (const d of asks) lines.push(`--   ${d.id} [${d.at}] ${d.key}｜${one(d.why)}${d.newText ? `\n--     案の文: ${one(d.newText)}` : ""}`);
    lines.push("");
  }
  lines.push(
    "-- 戻し方（控えから is_active と rule_text を戻す）:",
    "-- UPDATE ai_prompt_rules a SET is_active = b.is_active, rule_text = b.rule_text FROM ai_prompt_rules_backup_r9 b WHERE a.id = b.id;",
    "-- 確かめ: SELECT count(*) FILTER (WHERE NOT a.is_active) retired, count(*) FILTER (WHERE a.rule_text <> b.rule_text) edited FROM ai_prompt_rules a JOIN ai_prompt_rules_backup_r9 b USING (id);",
  );
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`SQL: ${OUT}（無効 ${retire.length}・書き換え ${edit.length}・聞く ${asks.length}${SWEEP ? `・掃除 ${sweepN}` : ""}）`);
  if (problems.length) { console.log(problems.join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
