// scripts/kb-insert.ts — 設計知見を1件 INSERT する（Supabase MCP が落ちている時の経路）
// 実行: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>
//   JSON の形: { title, category, insight, rationale, context, applied_to, tags: string[], priority?: 0|1|2|3 }
//   priority（段）: 0 絶対・最優先（札「絶対・最優先」と一緒・竹内さんが決める）／1 今の決まり（竹内さんの決定）／2 実装の知見／3 事例・経緯。無ければ推定
//   category: architecture | prompt_engineering | data_model | ux | performance | ai_design
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { embedKbRows } from "../app/lib/design-knowledge-rag-server";
import { sceneTagsToAdd } from "./kb-scene-tag";
import { inferPriority, normalizeTags, P0_TAG, PRIORITY_LABEL } from "../app/lib/design-knowledge-priority";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const file = process.argv[2];
if (!file) { console.error("使い方: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>"); process.exit(1); }

async function main() {
  // 2026-09-20: 1セッションで複数の知見が出る事が多いので配列も受ける（1件の時は今まで通りオブジェクト）
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    for (const k of ["title", "category", "insight", "rationale"]) {
      if (!row[k]) { console.error(`必須の項目がありません: ${k}（${String(row.title ?? "無題")}）`); process.exit(1); }
    }
  }
  // 2026-10-07（3巡目）題が返信の場面に当たる行には札「場面:〇〇」を足す（kb.ts --scene で引く入口）
  for (const row of rows) { const add = sceneTagsToAdd({ title: String(row.title), tags: (row.tags as string[] | undefined) ?? [] }); if (add.length) row.tags = [...((row.tags as string[] | undefined) ?? []), ...add]; }
  // 2026-10-07 段（priority）: 0 絶対・最優先／1 今の決まり／2 実装の知見／3 事例・経緯。JSON に無ければ決まった目印から推定して付ける（推定は画面に出す）。
  //   P0 は札「絶対・最優先」と一緒の時だけ（竹内さんが決める）。札の表記ゆれもここで直す（CLAUDE.md「タグの書き方」）
  for (const row of rows) {
    row.tags = normalizeTags((row.tags as string[] | undefined) ?? []).tags;
    const given = row.priority;
    if (given === undefined || given === null || given === "") {
      const g = inferPriority({ title: String(row.title), insight: String(row.insight), context: (row.context as string | undefined) ?? null, tags: row.tags as string[] });
      row.priority = g.priority;
      console.log(`  段を推定: ${PRIORITY_LABEL[g.priority]}（${g.reason}）— 違えば JSON に "priority": 0〜3 を書く: ${String(row.title).slice(0, 50)}`);
    } else {
      const p = Number(given);
      if (![0, 1, 2, 3].includes(p)) { console.error(`priority は 0〜3: ${String(given)}（${String(row.title)}）`); process.exit(1); }
      if (p === 0 && !(row.tags as string[]).includes(P0_TAG)) { console.error(`P0 は札「${P0_TAG}」と一緒の時だけ（竹内さんが決める）: ${String(row.title)}`); process.exit(1); }
      row.priority = p;
    }
  }
  let { data, error } = await sb.from("system_design_thinking").insert(rows).select("id");
  if (error && /priority/.test(error.message)) {
    // 本番に priority 列がまだ無い（ALTER 前）: 段を外して入れる（並びは推定で効く・後で kb-priority.ts が付ける）
    console.warn("  priority 列がまだ無いので段を外して入れます");
    ({ data, error } = await sb.from("system_design_thinking").insert(rows.map(({ priority: _p, ...rest }) => rest)).select("id"));
  }
  if (error) { console.error("INSERT 失敗:", error.message); process.exit(1); }
  for (const row of rows) console.log(`設計知見を INSERT しました: ${row.title}（P${String(row.priority)}）`);
  // 2026-10-06（⑯・RAG）入れたその場で埋め込みを作る（scripts/kb.ts --q の自然文の引き方に載る）。失敗しても INSERT は残る（週の整理が埋める）
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  try {
    const e = await embedKbRows(sb, { dry: false, ids });
    console.log(`  埋め込み: ${e.embedded}行（$${e.usd.toFixed(5)}）`);
  } catch (err) { console.warn("  埋め込みに失敗（週の整理で埋める）:", err instanceof Error ? err.message : err); }
}
main().catch((e) => { console.error(e); process.exit(1); });
