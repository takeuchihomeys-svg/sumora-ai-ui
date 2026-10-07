// scripts/rules-review-r6-sql.ts — 6巡目の学習ルールの見直し（app/lib/rules-review-r6.ts）を本番に流す SQL を出す（DB は読むだけ・書かない）
// 竹内さんが流す。控え（ai_prompt_rules_backup_r6）を作ってから無効化・書き換え・戻し方つき。updated_at は触らない（並びを変えないため）。
// 実行: npx tsx --env-file=.env.local scripts/rules-review-r6-sql.ts [--out=scripts/.replay-out/r6-rules.sql]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { RULES_REVIEW_R6, R6_AIX_RETIRE } from "../app/lib/rules-review-r6";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "scripts/.replay-out/r6-rules.sql";
const q = (s: string) => `$r6$${s}$r6$`;

async function main() {
  const all = [...RULES_REVIEW_R6, ...R6_AIX_RETIRE];
  const { data, error } = await sb.from("ai_prompt_rules").select("id, rule_key, is_active, rule_text").in("id", all.map((d) => d.id));
  if (error) throw new Error(error.message);
  const rows = new Map(((data ?? []) as Array<{ id: string; rule_key: string; is_active: boolean; rule_text: string }>).map((r) => [r.id, r]));
  const problems: string[] = [];
  for (const d of all) {
    const r = rows.get(d.id);
    if (!r) problems.push(`無い: ${d.id} ${d.key}`);
    else if (r.rule_key !== d.key) problems.push(`rule_key が違う: ${d.id} ${r.rule_key} ≠ ${d.key}`);
    else if (!r.is_active) problems.push(`既に無効: ${d.id} ${d.key}`);
  }
  const ids = all.map((d) => `'${d.id}'`).join(",\n  ");
  const lines: string[] = [
    "-- 6巡目（2026-10-07）学習ルールの見直し（app/lib/rules-review-r6.ts・材料 scripts/audit-prompt-rules-review.ts）",
    "-- 流す前: この SQL の problems が空か確かめる。updated_at は触らない。",
    problems.length ? `-- ⚠ problems:\n${problems.map((p) => `--   ${p}`).join("\n")}` : "-- problems: なし",
    "",
    "BEGIN;",
    "-- ① 控え（戻す時に使う）",
    `CREATE TABLE IF NOT EXISTS ai_prompt_rules_backup_r6 AS SELECT * FROM ai_prompt_rules WHERE false;`,
    `INSERT INTO ai_prompt_rules_backup_r6 SELECT * FROM ai_prompt_rules WHERE id IN (\n  ${ids}\n) AND id NOT IN (SELECT id FROM ai_prompt_rules_backup_r6);`,
    "",
    "-- ② 無効にする（is_active=false）",
  ];
  for (const d of all.filter((x) => x.verdict === "retire")) lines.push(`UPDATE ai_prompt_rules SET is_active = false WHERE id = '${d.id}'; -- ${d.key}｜${d.why.replace(/\n/g, " ")}`);
  lines.push("", "-- ③ 書き換える（rule_text だけ）");
  for (const d of all.filter((x) => x.verdict === "edit")) lines.push(`-- ${d.key}｜${d.why.replace(/\n/g, " ")}\nUPDATE ai_prompt_rules SET rule_text = ${q(d.newText!)} WHERE id = '${d.id}';`);
  lines.push("COMMIT;", "",
    "-- ④（任意・別に流す）返信生成に一度も届いていない AIX の振り分けのルール（FEEDBACK-*-gr・p7）を片付ける。v2 の並びは入れないので動きは変わらない。",
    "--    週の整理（rule-organize の Opus）が毎週読む分の費用が減る。控えは同じ表に入れる。",
    "-- BEGIN;",
    "-- INSERT INTO ai_prompt_rules_backup_r6 SELECT * FROM ai_prompt_rules WHERE is_active AND action_type = 'generate_reply' AND rule_key LIKE 'FEEDBACK-%-gr' AND priority < 8 AND id NOT IN (SELECT id FROM ai_prompt_rules_backup_r6);",
    "-- UPDATE ai_prompt_rules SET is_active = false WHERE is_active AND action_type = 'generate_reply' AND rule_key LIKE 'FEEDBACK-%-gr' AND priority < 8;",
    "-- COMMIT;",
    "",
    "-- 戻し方（控えから is_active と rule_text を戻す）:",
    "-- UPDATE ai_prompt_rules a SET is_active = b.is_active, rule_text = b.rule_text FROM ai_prompt_rules_backup_r6 b WHERE a.id = b.id;",
    "-- 確かめ: SELECT count(*) FILTER (WHERE NOT a.is_active) retired, count(*) FILTER (WHERE a.rule_text <> b.rule_text) edited FROM ai_prompt_rules a JOIN ai_prompt_rules_backup_r6 b USING (id);",
  );
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`SQL: ${OUT}（無効 ${all.filter((x) => x.verdict === "retire").length}・書き換え ${all.filter((x) => x.verdict === "edit").length}）`);
  if (problems.length) { console.log(problems.join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
