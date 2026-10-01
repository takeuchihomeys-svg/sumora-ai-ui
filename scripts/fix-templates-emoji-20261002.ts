// scripts/fix-templates-emoji-20261002.ts
// 2026-10-02 竹内「絵文字は入れて良い絵文字だけにする」「🙇の絵文字入れない 😊 😌 🌟 ✨となる」「見積書の✅はのこす」:
//   スタッフの定型文（templates 表）の入れてよい物以外の絵文字を、出口と同じ関数（app/lib/emoji-allowlist.ts）で直す。
//   手で使う定型文は出口を通らないので、表そのものを直す。直す前の値は scripts/backup-templates-emoji-20261002.json に残す。
// 実行: npx tsx --env-file=.env.local scripts/fix-templates-emoji-20261002.ts [--apply]（無しは前後を出すだけ）
//   戻す時: backup の before を id ごとに書き戻す（--restore）
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { enforceEmojiAllowlist } from "../app/lib/emoji-allowlist";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const BACKUP = "scripts/backup-templates-emoji-20261002.json";
type Change = { id: string; field: "text" | "label"; label: string; before: string; after: string };
async function main() {
  if (process.argv.includes("--restore")) {
    const b = JSON.parse(fs.readFileSync(BACKUP, "utf8")) as Change[];
    for (const c of b) { const { error } = await sb.from("templates").update({ [c.field]: c.before }).eq("id", c.id); console.log("戻した", c.id, c.field, error?.message ?? "ok"); }
    return;
  }
  const { data, error } = await sb.from("templates").select("id, label, text").limit(5000);
  if (error) throw error;
  const changes: Change[] = [];
  for (const r of (data ?? []) as Array<{ id: string; label: string | null; text: string | null }>) {
    for (const field of ["text", "label"] as const) {
      const v = r[field] ?? "";
      const f = enforceEmojiAllowlist(v);
      // ラベルは画面の見出し（先頭の飾りの後ろの空白も外す）
      const after = field === "label" ? f.text.trimStart() : f.text;
      if (f.changes.length) changes.push({ id: r.id, field, label: r.label ?? "", before: v, after });
    }
  }
  for (const c of changes) console.log(`--- ${c.id} ${c.field}（${c.label}）\n  前: ${JSON.stringify(c.before)}\n  後: ${JSON.stringify(c.after)}`);
  console.log(`直す欄 ${changes.length}`);
  if (!process.argv.includes("--apply")) return;
  if (fs.existsSync(BACKUP)) throw new Error(`${BACKUP} が既にある（二重に当てない・戻すなら --restore）`);
  fs.writeFileSync(BACKUP, JSON.stringify(changes, null, 1));
  for (const c of changes) {
    const { error: e } = await sb.from("templates").update({ [c.field]: c.after }).eq("id", c.id).eq(c.field, c.before);
    console.log("更新", c.id, c.field, e?.message ?? "ok");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
