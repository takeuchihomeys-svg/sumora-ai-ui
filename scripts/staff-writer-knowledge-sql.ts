// scripts/staff-writer-knowledge-sql.ts — 従業員の直しから学んだ「言い回し・文体」のナレッジを外す SQL を作る（DB は読むだけ・書くのは竹内さん）
//   2026-10-08 竹内「竹内のLINEか従業員のLINEかで考える方がかなり分析の質が変わる」: 返信の書き方の基準は竹内さん。
//   ai_reply_knowledge のうち出所の例（source_example_id）が従業員の直し（app/lib/staff-writer.writerFromEdit）で、
//   category が phrase／style の行を対象にする。構成（pattern）・原則（principle）は中身なので残す。
//   既定: hypothesis（仮説）だけ rejected に（rejection_reason='employee_style_20261008'）。--include-confirmed で確定の行も
//   出力: --out（既定 scripts/.replay-out/staff-writer-knowledge.sql）。控えの表 ai_reply_knowledge_backup_writer と戻し方つき
// 実行: npx tsx --env-file=.env.local scripts/staff-writer-knowledge-sql.ts [--include-confirmed] [--out=...]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { writerFromEdit } from "../app/lib/staff-writer";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = arg("out", "scripts/.replay-out/staff-writer-knowledge.sql");
const WITH_CONFIRMED = process.argv.includes("--include-confirmed");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function main() {
  const kn: Array<{ id: string; category: string; hypothesis_status: string | null; source_example_id: string; content: string | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("ai_reply_knowledge").select("id, category, hypothesis_status, source_example_id, content").in("category", ["phrase", "style"]).not("source_example_id", "is", null).range(i, i + 999);
    if (error) throw new Error(error.message);
    kn.push(...((data ?? []) as typeof kn)); if ((data ?? []).length < 1000) break;
  }
  const ids = [...new Set(kn.map((k) => k.source_example_id))];
  const ex = new Map<string, { ai_draft: string | null; sent_reply: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, ai_draft, sent_reply").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const e of (data ?? []) as Array<{ id: string; ai_draft: string | null; sent_reply: string | null }>) ex.set(e.id, e);
  }
  const target = kn.filter((k) => {
    const e = ex.get(k.source_example_id); if (!e) return false;
    if (writerFromEdit(e.ai_draft, e.sent_reply).writer !== "employee") return false;
    if (k.hypothesis_status === "rejected") return false;
    return WITH_CONFIRMED ? true : k.hypothesis_status !== "confirmed";
  });
  const by = new Map<string, number>(); for (const k of target) by.set(`${k.category}|${k.hypothesis_status ?? "-"}`, (by.get(`${k.category}|${k.hypothesis_status ?? "-"}`) ?? 0) + 1);
  console.log(`対象 ${target.length}行: ${[...by].map(([k, v]) => `${k} ${v}`).join("・")}`);
  for (const k of target.slice(0, 8)) console.log(`  例 ${k.category} ${String(k.content ?? "").replace(/\n/g, " ").slice(0, 90)}`);
  const list = target.map((k) => `'${k.id}'`).join(",");
  const sql = `-- 従業員の直しから学んだ言い回し・文体のナレッジを外す（${new Date().toISOString().slice(0, 10)}・${target.length}行・scripts/staff-writer-knowledge-sql.ts）
CREATE TABLE IF NOT EXISTS ai_reply_knowledge_backup_writer AS SELECT * FROM ai_reply_knowledge WHERE false;
INSERT INTO ai_reply_knowledge_backup_writer SELECT * FROM ai_reply_knowledge WHERE id IN (${list || "NULL"});
UPDATE ai_reply_knowledge SET hypothesis_status = 'rejected', rejection_reason = 'employee_style_20261008' WHERE id IN (${list || "NULL"});
-- 戻す:
-- UPDATE ai_reply_knowledge k SET hypothesis_status = b.hypothesis_status, rejection_reason = b.rejection_reason FROM ai_reply_knowledge_backup_writer b WHERE k.id = b.id;
`;
  mkdirSync("scripts/.replay-out", { recursive: true });
  writeFileSync(OUT, sql);
  console.log(`書き出し ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
