// scripts/conductor-weights-load.ts — 作業員2の竹内さんの合い方の表から conductor_weights に basis='takeuchi' の行を入れる（作業員1・11/04）
//   件数が足りる場面だけ・source='record'・decides=false（統括は意見を出すだけ）。決める側（decides=true）・p0／p1 の行には触らない（ON CONFLICT の WHERE）。
//   サーバーの鍵があれば --apply で upsert。無ければ流す SQL を出すだけ（MCP 等で流す）。全件読みはしない（表のファイルを読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/conductor-weights-load.ts --file=<table-YYYYMMDD.json> [--apply]
import { readFileSync } from "node:fs";
import { weightsFromFitTable, weightsUpsertSql, type FitTable } from "../app/lib/conductor-weights";

const file = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
if (!file) { console.error("--file=<table-YYYYMMDD.json> が要る"); process.exit(1); }
const t = JSON.parse(readFileSync(file, "utf8")) as FitTable;
const { rows, skipped } = weightsFromFitTable(t);
console.log(`表 ${t.date}: 入れる行 ${rows.length}・外した ${skipped.length}${skipped.length ? `（${skipped.join("・")}）` : ""}`);
(async () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.argv.includes("--apply") && key) {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key, { auth: { persistSession: false } });
    // 決める側・p0/p1 の行は上書きしない: 先に今の行を読んで外す
    const { data } = await sb.from("conductor_weights").select("scene, brain, answer_kind, basis, decides, source").eq("basis", "takeuchi");
    const keep = new Set(((data ?? []) as Array<{ scene: string; brain: string; answer_kind: string; decides: boolean; source: string }>).filter((r) => r.decides || r.source !== "record").map((r) => `${r.scene}|${r.brain}|${r.answer_kind}`));
    const up = rows.filter((r) => !keep.has(`${r.scene}|${r.brain}|${r.answer_kind}`)).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { error } = await sb.from("conductor_weights").upsert(up, { onConflict: "scene,brain,answer_kind,basis" });
    if (error) throw new Error(error.message);
    console.log(`書いた: ${up.length}行（触らなかった ${rows.length - up.length}行）`);
  } else {
    console.log(weightsUpsertSql(rows));
  }
})().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
