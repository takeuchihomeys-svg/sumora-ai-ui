// scripts/kb-insert.ts — 設計知見を1件 INSERT する（Supabase MCP が落ちている時の経路）
// 実行: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>
//   JSON の形: { title, category, insight, rationale, context, applied_to, tags: string[], priority?: 0|1|2|3 }
//   priority（段）: 0 絶対・最優先（札「絶対・最優先」と一緒・竹内さんが決める）／1 今の決まり（竹内さんの決定）／2 実装の知見／3 事例・経緯。無ければ推定
//   category: architecture | prompt_engineering | data_model | ux | performance | ai_design
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { embedKbRows, neighborsOf } from "../app/lib/design-knowledge-rag-server";
import { sceneTagsToAdd } from "./kb-scene-tag";
import { inferPriority, normalizeTags, P0_TAG, PRIORITY_LABEL } from "../app/lib/design-knowledge-priority";
import { mojibakeFields } from "../app/lib/design-knowledge-curation";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const file = process.argv[2];
// 確かめ用: 既存の行の被りだけを出す（INSERT しない）: npx tsx --env-file=.env.local scripts/kb-insert.ts --overlaps-of=<id>
const overlapsOf = process.argv.find((a) => a.startsWith("--overlaps-of="))?.slice(14);
if (overlapsOf) {
  (async () => {
    const { data } = await sb.from("system_design_thinking").select("id, title, tags").eq("id", overlapsOf).maybeSingle();
    if (!data) { console.error("行が無い"); process.exit(1); }
    await showOverlaps([data.id as string], [data as Record<string, unknown>]);
  })().catch((e) => { console.error(e); process.exit(1); });
} else if (!file) { console.error("使い方: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>"); process.exit(1); }

async function main() {
  // 2026-09-20: 1セッションで複数の知見が出る事が多いので配列も受ける（1件の時は今まで通りオブジェクト）
  const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown> | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    for (const k of ["title", "category", "insight", "rationale"]) {
      if (!row[k]) { console.error(`必須の項目がありません: ${k}（${String(row.title ?? "無題")}）`); process.exit(1); }
    }
    // 2026-10-08 竹内さん「文字化けでないようにする」: 「????」・置換文字の入った行は入れない（JSON を Windows の既定の文字コードで書いた等）。
    //   JSON は UTF-8 で書く（PowerShell なら Out-File -Encoding utf8・Set-Content -Encoding utf8）。REST に直接 POST しない（PowerShell 5.1 の Invoke-RestMethod は本文を Latin-1 で送る）
    const mb = mojibakeFields(row as Parameters<typeof mojibakeFields>[0]);
    if (mb.length) { console.error(`文字化けしています（${mb.join("・")}）: ${String(row.title ?? "").slice(0, 60)} — JSON を UTF-8 で書き直してください`); process.exit(1); }
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
  // 2026-10-07 7巡目（竹内「被ったらその時におくってもらったら良い」）: 入れた行と同じ場面・同じ話題の既存の P0/P1/P2 の行で
  //   埋め込みが近い物（0.8 以上）を「被っている可能性」として並べる。**自動では退役しない**（コーディネーターがその場で竹内さんに見せる）
  try { await showOverlaps(ids, rows); } catch (err) { console.warn("  被りの確かめに失敗（INSERT は済み）:", err instanceof Error ? err.message : err); }
}

/** 被りの表示の線（近さ・題の並べ方）。迷ったら多めに出す側（見せるだけなので） */
const OVERLAP_MIN = Number(process.env.KB_OVERLAP_MIN ?? "0.8");
async function showOverlaps(ids: string[], rows: Array<Record<string, unknown>>) {
  const lines: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]; const row = rows[i] ?? {};
    const myTags = new Set(((row.tags as string[] | undefined) ?? []));
    const myScenes = [...myTags].filter((t) => t.startsWith("場面:"));
    const nb = (await neighborsOf(sb, id, 10, OVERLAP_MIN)).filter((n) => n.id !== id);
    if (!nb.length) continue;
    const { data } = await sb.from("system_design_thinking").select("id, title, tags, priority, is_current").in("id", nb.map((n) => n.id));
    const byId = new Map(((data ?? []) as Array<{ id: string; title: string; tags: string[] | null; priority: number | null; is_current: boolean | null }>).map((r) => [r.id, r]));
    const hits: string[] = [];
    for (const n of nb) {
      const r = byId.get(n.id); if (!r || r.is_current === false) continue;
      const p = r.priority ?? 2; if (p > 2) continue; // P3（事例）は被っても良い
      const tags = r.tags ?? [];
      const sameScene = myScenes.length > 0 && tags.some((t) => myScenes.includes(t));
      const shared = tags.filter((t) => myTags.has(t) && !t.startsWith("場面:") && !["汎用", "点検表"].includes(t));
      if (!sameScene && !shared.length && n.similarity < 0.85) continue; // 場面も話題（札）も違い、近さも 0.85 未満なら被りとは言わない
      const why = [sameScene ? "同じ場面" : "", shared.length ? `札 ${shared.slice(0, 3).join("・")}` : "", `近さ ${n.similarity.toFixed(2)}`].filter(Boolean).join("・");
      hits.push(`    - P${p} ${r.id.slice(0, 8)}（${why}）${r.title.slice(0, 80)}`);
    }
    if (hits.length) lines.push(`  ⚠ 被っている可能性: 新しい行 ${id.slice(0, 8)}「${String(row.title).slice(0, 60)}」\n${hits.join("\n")}\n    → 古い方を退役するなら（竹内さんの判断の後）: npx tsx --env-file=.env.local scripts/kb-retire.ts --id=<古い id> --by=${id} --reason=<理由>`);
  }
  if (lines.length) { console.log("\n===== 被っている可能性（自動では退役しない・竹内さんに見せる） ====="); for (const l of lines) console.log(l); }
  else console.log("  被っている可能性: なし（同じ場面・話題の P0〜P2 で近さ " + OVERLAP_MIN + " 以上の行は無い）");
}
if (!overlapsOf) main().catch((e) => { console.error(e); process.exit(1); });
