// scripts/restore-templates-checkmark-20261002.ts — 2026-10-02 夜 竹内さん「✅はつける」: 10/02 に外した templates の ✅ だけを戻す（他の外した絵文字はそのまま）。元に戻す前の値は scripts/backup-templates-checkmark-restore-20261002.json
// 実行: npx tsx --env-file=.env.local scripts/restore-templates-checkmark-20261002.ts [--dry]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { enforceEmojiAllowlist } from "../app/lib/emoji-allowlist";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DRY = process.argv.includes("--dry");
(async () => {
  const rows = JSON.parse(readFileSync("scripts/backup-templates-emoji-20261002.json", "utf8")) as Array<{ id: string; field: string; label: string; before: string; after: string }>;
  const targets = rows.filter((r) => r.before.includes("✅"));
  const backup: unknown[] = [];
  for (const r of targets) {
    const { data } = await sb.from("templates").select(`id, ${r.field}`).eq("id", r.id).maybeSingle();
    const cur = (data as Record<string, string> | null)?.[r.field];
    const restored = enforceEmojiAllowlist(r.before).text;
    const okCur = cur === r.after;
    console.log(`${r.label} | 今が10/02の後のまま: ${okCur} | ✅ ${(restored.match(/✅/g) ?? []).length}個に戻す`);
    if (!okCur) { console.log("   今の文が違うので触らない"); continue; }
    backup.push({ id: r.id, field: r.field, current: cur });
    if (!DRY) { const u = await sb.from("templates").update({ [r.field]: restored }).eq("id", r.id); console.log("   ", u.error?.message ?? "戻した"); }
  }
  if (!DRY) writeFileSync("scripts/backup-templates-checkmark-restore-20261002.json", JSON.stringify(backup, null, 1));
})();
