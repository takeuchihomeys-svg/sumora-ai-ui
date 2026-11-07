// scripts/kb-insert.ts — 設計知見を1件 INSERT する（Supabase MCP が落ちている時の経路）
// 実行: npx tsx --env-file=.env.local scripts/kb-insert.ts <JSONファイル>
//   JSON の形: { title, category, insight, rationale, context, applied_to, tags: string[], priority?: 0|1|2|3 }
//   priority（段）: 0 絶対・最優先（札「絶対・最優先」と一緒・竹内さんが決める）／1 今の決まり（竹内さんの決定）／2 実装の知見／3 事例・経緯。無ければ推定
//   category: architecture | prompt_engineering | data_model | ux | performance | ai_design
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { embedKbRows, neighborsOf } from "../app/lib/design-knowledge-rag-server";
import { sceneTagsToAdd } from "./kb-scene-tag";
import { inferPriority, normalizeTags, P0_TAG, PRIORITY_LABEL, planP0Insert, type KbPriority } from "../app/lib/design-knowledge-priority";
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
  // 2026-11-07 P0 の木（竹内さん「親5本の木にする」）: 札「絶対・最優先」でも親 P0 を選ぶ（JSON の "parent": 親の id か先頭8字）。
  //   P0 が5本以上で親が無い時は、入れた後に一番近い親 P0 の子 P1 にする。新しい親にするかは竹内さんへの確認事項（memory/rules_digest_review.md）
  const { data: p0rows } = await sb.from("system_design_thinking").select("id, title").eq("is_current", true).eq("priority", 0);
  const roots = (p0rows ?? []) as Array<{ id: string; title: string }>;
  const autoParent: boolean[] = [];
  const ownerDrafts: string[] = [];
  for (const row of rows) {
    const pg = String(row.parent ?? "").trim().toLowerCase();
    const parentGiven = pg ? (roots.find((r) => r.id.startsWith(pg))?.id ?? null) : null;
    if (pg && !parentGiven) { console.error(`parent が親 P0 にありません: ${pg}（親 P0: ${roots.map((r) => r.id.slice(0, 8)).join("・")}）`); process.exit(1); }
    const plan = planP0Insert({ priority: row.priority as KbPriority, tags: row.tags as string[] }, { p0Count: roots.length, parentGiven });
    row.priority = plan.priority; row.tags = plan.tags;
    if (plan.parent) { row.parent = plan.parent; row.parent_by = "kb-insert:P0の木"; row.parent_at = new Date().toISOString(); } else delete row.parent;
    autoParent.push(plan.autoParent);
    if (plan.note) console.log(`  🌳 ${plan.note}: ${String(row.title).slice(0, 50)}`);
    if (plan.askOwner) ownerDrafts.push(`- 【P0 にするか】「${String(row.title).slice(0, 70)}」を札「${P0_TAG}」で入れようとした。P0 の木（親5本）に合わせて子 P1 で入れた。新しい親（6本目）にするか、どれかの親と入れ替えるかは竹内さんへ。推奨: 子 P1 のまま`);
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
  // P0 の木: 親を選ばなかった「絶対・最優先」の行は、一番近い親 P0 の子にする（埋め込みの近さ・P0 は5行だけ読む）
  if (autoParent.some(Boolean) && roots.length) {
    try {
      const { data: ev } = await sb.from("system_design_thinking").select("id, embedding").in("id", [...roots.map((r) => r.id), ...ids.filter((_, i) => autoParent[i])]);
      const vec = new Map(((ev ?? []) as Array<{ id: string; embedding: string | number[] | null }>).map((r) => [r.id, typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : r.embedding]));
      const cos = (a: number[], b: number[]) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / (Math.sqrt(x * y) || 1); };
      for (let i = 0; i < ids.length; i++) {
        if (!autoParent[i]) continue;
        const me = vec.get(ids[i]);
        const best = me ? roots.map((r) => ({ r, s: vec.get(r.id) ? cos(me, vec.get(r.id)!) : -1 })).sort((a, b) => b.s - a.s)[0] : null;
        if (!best || best.s < 0) { console.warn(`  🌳 親 P0 を決められない（埋め込みが無い）: ${ids[i].slice(0, 8)} — JSON に "parent" を書いて入れ直すか、手で付ける`); continue; }
        const up = await sb.from("system_design_thinking").update({ parent: best.r.id, parent_by: `kb-insert:P0の木:${best.s.toFixed(2)}`, parent_at: new Date().toISOString() }).eq("id", ids[i]);
        if (!up.error) { rows[i].parent = best.r.id; console.log(`  🌳 一番近い親 P0 の子にした: ${ids[i].slice(0, 8)} → ${best.r.id.slice(0, 8)}「${best.r.title.slice(0, 40)}」（近さ ${best.s.toFixed(2)}）`); }
      }
    } catch (err) { console.warn("  🌳 親 P0 の付けに失敗（INSERT は済み・手で付ける）:", err instanceof Error ? err.message : err); }
  }
  if (ownerDrafts.length) {
    fs.appendFileSync("memory/rules_digest_review.md", `\n\n## 竹内さんへの確認事項の下書き（P0 の木・kb-insert・${new Date().toISOString().slice(0, 10)}）\n${ownerDrafts.join("\n")}\n`, "utf8");
    console.log(`  確認事項の下書きを memory/rules_digest_review.md に足した（${ownerDrafts.length}件）`);
  }
  // 2026-10-07 7巡目（竹内「被ったらその時におくってもらったら良い」）: 入れた行と同じ場面・同じ話題の既存の P0/P1/P2 の行で
  //   埋め込みが近い物（0.8 以上）を「被っている可能性」として並べる。**自動では退役しない**（コーディネーターがその場で竹内さんに見せる）
  try { await showOverlaps(ids, rows); } catch (err) { console.warn("  被りの確かめに失敗（INSERT は済み）:", err instanceof Error ? err.message : err); }
  // 2026-11-03 作業員6 入れる時の統括（竹内さん KB P1「設計知見そのものにも統括を作る」②）: 近さ 0.72 以上の行との関係を DeepSeek で1回ずつ決める。
  //   子 → 新しい行に parent を付ける（段の線を守る）／上書き → 退役の案（自動では退役しない）／ぶつかる → 確認事項の下書き。止める: KB_INSERT_JUDGE=off
  if ((process.env.KB_INSERT_JUDGE ?? "on").toLowerCase() !== "off") {
    try { await judgeNewRows(ids, rows); } catch (err) { console.warn("  入れる時の統括に失敗（INSERT は済み）:", err instanceof Error ? err.message : err); }
  }
}

async function judgeNewRows(ids: string[], rows: Array<Record<string, unknown>>) {
  const { judgeKbRelation, canBeParent, KB_JUDGE_MIN_SIM } = await import("../app/lib/kb-insert-judge");
  const drafts: string[] = [];
  let calls = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]; const row = rows[i] ?? {};
    const me = { id, title: String(row.title ?? ""), insight: String(row.insight ?? ""), priority: (row.priority as number | null) ?? 2, created_at: new Date().toISOString() };
    const nb = (await neighborsOf(sb, id, 6, KB_JUDGE_MIN_SIM)).filter((n) => n.id !== id);
    if (!nb.length) continue;
    const { data } = await sb.from("system_design_thinking").select("id, title, insight, priority, created_at, is_current").in("id", nb.map((n) => n.id));
    const byId = new Map(((data ?? []) as Array<{ id: string; title: string; insight: string; priority: number | null; created_at: string; is_current: boolean | null }>).map((r) => [r.id, r]));
    let parentSet = !!row.parent; // P0 の木で親 P0 を付けた行は上書きしない
    for (const n of nb) {
      const old = byId.get(n.id); if (!old || old.is_current === false) continue;
      const j = await judgeKbRelation(me, old, n.similarity); calls++;
      if (!j) continue;
      const tag = `P${old.priority ?? 2} ${old.id.slice(0, 8)}（近さ ${n.similarity.toFixed(2)}）${old.title.slice(0, 60)}`;
      if (j.rel === "child" && !parentSet && canBeParent(me, old)) {
        const up = await sb.from("system_design_thinking").update({ parent: old.id, parent_by: `kb-insert:deepseek:${n.similarity.toFixed(2)}`, parent_at: new Date().toISOString() }).eq("id", id);
        if (!up.error) { parentSet = true; console.log(`  🌳 親を付けた: ${id.slice(0, 8)} → ${tag}（${j.why}）`); }
      } else if (j.rel === "same") console.log(`  ＝ 同じ: ${tag}（${j.why}）→ どちらかを退役する案: npx tsx --env-file=.env.local scripts/kb-retire.ts --id=${old.id} --by=${id} --reason=同じ`);
      else if (j.rel === "supersede") console.log(`  ↻ 上書き: ${tag}（${j.why}）→ 退役の案（竹内さんの判断の後）: npx tsx --env-file=.env.local scripts/kb-retire.ts --id=${old.id} --by=${id} --reason=<理由>`);
      else if (j.rel === "conflict") {
        console.log(`  ⚡ ぶつかる: ${tag}（${j.why}）解き方: ${j.resolve ?? "―"}`);
        drafts.push(`- 【設計知見のぶつかり】新しい行 ${id.slice(0, 8)}「${me.title.slice(0, 50)}」と ${old.id.slice(0, 8)}「${old.title.slice(0, 50)}」: ${j.why}。推奨: ${j.resolve ?? "新しい決定を先にする"}`);
      }
    }
  }
  console.log(`  入れる時の統括: DeepSeek ${calls}回（約 $${(calls * 0.0006).toFixed(4)}）`);
  if (drafts.length) {
    const f = "memory/rules_digest_review.md";
    fs.appendFileSync(f, `\n\n## 竹内さんへの確認事項の下書き（kb-insert・${new Date().toISOString().slice(0, 10)}）\n${drafts.join("\n")}\n`, "utf8");
    console.log(`  確認事項の下書きを ${f} に足した（${drafts.length}件）`);
  }
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
