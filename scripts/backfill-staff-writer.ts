// scripts/backfill-staff-writer.ts — 過去のスタッフの送信に書き手（竹内さん／従業員）を付ける（2026-10-08）
//   入力: scripts/audit-staff-writer.ts --out=<jsonl>（1通1行・文の癖＋文脈の判定）
//   既定は dry-run（数えるだけ）。--apply で messages.staff_writer / staff_writer_source / staff_writer_confidence を書く
//   端末（device）・グループの発言者（group_speaker）・人（manual）で決まった行は上書きしない。文脈（style_context）は --with-context の時だけ書く
//   グループの発言者の行は migrate-schema のトリガーが入れる時に付く。過去分は下の SQL（--print-sql）で
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-staff-writer.ts --out=scripts/.replay-out/staff-writer-labels.jsonl
//   npx tsx --env-file=.env.local scripts/backfill-staff-writer.ts --in=scripts/.replay-out/staff-writer-labels.jsonl            # dry-run
//   npx tsx --env-file=.env.local scripts/backfill-staff-writer.ts --in=... --apply [--with-context]                              # 本番に書く
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const APPLY = process.argv.includes("--apply");
const WITH_CONTEXT = process.argv.includes("--with-context");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const GROUP_SQL = `-- グループの発言（過去分）: 発言者の LINE で決める
UPDATE messages SET staff_writer = 'takeuchi', staff_writer_source = 'group_speaker', staff_writer_confidence = 'sure'
  WHERE sender = 'staff' AND speaker_user_id = (SELECT value FROM hanbancyo_settings WHERE key = 'takeuchi_line_user_id');
UPDATE messages SET staff_writer = 'employee', staff_writer_source = 'group_speaker', staff_writer_confidence = 'sure'
  WHERE sender = 'staff' AND speaker_user_id = (SELECT value FROM hanbancyo_settings WHERE key = 'suzuki_line_user_id');
-- 戻す（文の癖で付けた分だけ消す）:
-- UPDATE messages SET staff_writer = NULL, staff_writer_source = NULL, staff_writer_confidence = NULL WHERE staff_writer_source IN ('style','style_context');`;

type Row = { id: string; src: string; writer: string | null; source: string | null; confidence: string };
async function main() {
  if (process.argv.includes("--print-sql")) { console.log(GROUP_SQL); return; }
  const rows: Row[] = readFileSync(arg("in", ""), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const todo = rows.filter((r) => r.writer && (r.source === "style" || (WITH_CONTEXT && r.source === "style_context")));
  const groups = new Map<string, string[]>();
  for (const r of todo) { const k = `${r.writer}|${r.source}|${r.confidence}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r.id); }
  console.log(`入力 ${rows.length}行・書く ${todo.length}行（${APPLY ? "apply" : "dry-run"}${WITH_CONTEXT ? "・文脈も" : ""}）`);
  for (const [k, ids] of groups) console.log(`  ${k.padEnd(32)} ${ids.length}`);
  console.log(`  書かない: 出所 ${[...new Set(rows.filter((r) => !r.writer).map((r) => r.src))].join("・")} の不明 ${rows.filter((r) => !r.writer).length}${WITH_CONTEXT ? "" : `・文脈 ${rows.filter((r) => r.source === "style_context").length}`}`);
  if (!APPLY) { console.log(`\n（dry-run）グループの発言の SQL は --print-sql`); return; }
  // 既に強い根拠で決まった行は上書きしない
  let done = 0;
  for (const [k, ids] of groups) {
    const [writer, source, confidence] = k.split("|");
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await sb.from("messages").update({ staff_writer: writer, staff_writer_source: source, staff_writer_confidence: confidence })
        .in("id", chunk).or("staff_writer_source.is.null,staff_writer_source.in.(style,style_context)");
      if (error) throw new Error(error.message);
      done += chunk.length;
    }
  }
  console.log(`書いた ${done}行`);
}
main().catch((e) => { console.error(e); process.exit(1); });
