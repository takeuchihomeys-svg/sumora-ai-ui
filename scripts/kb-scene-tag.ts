// scripts/kb-scene-tag.ts — 設計知見に返信の場面の札「場面:〇〇」を付ける（3巡目・10/07 竹内「的確なRAG検索できるように」）
//   候補は題の語の型（design-knowledge-rag.ts KB_SCENES.titleRe＝本文には当てない）。既に付いている札は触らない・足すだけ。
//   既定は数えるだけ（dry）。--apply で書き込み、前の札を --backup=<file> に控える（戻す: --restore=<file>）。書いた行は埋め込みを作り直す。
// 実行: npx tsx --env-file=.env.local scripts/kb-scene-tag.ts [--apply --backup=<file>] [--show=<場面>] [--restore=<file>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { KB_SCENES, rowInScene, type KbScene } from "../app/lib/design-knowledge-rag";
import { embedKbRows } from "../app/lib/design-knowledge-rag-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const APPLY = process.argv.includes("--apply");

/** 行に足す場面の札（題の型で当たる場面のうち、まだ付いていない物） */
export function sceneTagsToAdd(r: { title: string; tags: string[] | null }): string[] {
  const out: string[] = [];
  for (const s of Object.keys(KB_SCENES) as KbScene[]) {
    if (s === "other") continue;
    const tag = KB_SCENES[s].tag;
    if ((r.tags ?? []).includes(tag)) continue;
    if (rowInScene({ title: r.title, tags: [] }, s)) out.push(tag);
  }
  return out;
}

async function main() {
  const restore = arg("restore");
  if (restore) {
    const bk = JSON.parse(readFileSync(restore, "utf8")) as Array<{ id: string; tags: string[] | null }>;
    for (const b of bk) { const { error } = await sb.from("system_design_thinking").update({ tags: b.tags }).eq("id", b.id); if (error) throw new Error(error.message); }
    const e = await embedKbRows(sb, { dry: false, ids: bk.map((b) => b.id) });
    console.log(`戻した: ${bk.length}行・埋め込み ${e.embedded}（$${e.usd.toFixed(5)}）`);
    return;
  }
  const rows: Array<{ id: string; title: string; tags: string[] | null }> = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, tags").eq("is_current", true).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const plan = rows.map((r) => ({ r, add: sceneTagsToAdd(r) })).filter((x) => x.add.length);
  const by = new Map<string, number>();
  for (const x of plan) for (const t of x.add) by.set(t, (by.get(t) ?? 0) + 1);
  console.log(`現行 ${rows.length}行・札を足す ${plan.length}行: ${[...by].map(([t, n]) => `${t} ${n}`).join("・")}`);
  const show = arg("show");
  if (show) for (const x of plan.filter((p) => p.add.includes(KB_SCENES[show as KbScene]?.tag ?? show))) console.log(`  ${x.r.id.slice(0, 8)} ${x.r.title.slice(0, 90)}`);
  if (!APPLY) return;
  const backup = arg("backup");
  if (!backup) throw new Error("--apply には --backup=<file> が要る（戻すため）");
  writeFileSync(backup, JSON.stringify(plan.map((x) => ({ id: x.r.id, tags: x.r.tags }))));
  for (const x of plan) {
    const { error } = await sb.from("system_design_thinking").update({ tags: [...(x.r.tags ?? []), ...x.add] }).eq("id", x.r.id);
    if (error) throw new Error(`${x.r.id}: ${error.message}`);
  }
  const e = await embedKbRows(sb, { dry: false, ids: plan.map((x) => x.r.id) });
  console.log(`書いた: ${plan.length}行（控え ${backup}）・埋め込み ${e.embedded}（$${e.usd.toFixed(5)}）`);
}
if (process.argv[1]?.includes("kb-scene-tag")) main().catch((e) => { console.error(e); process.exit(1); });
