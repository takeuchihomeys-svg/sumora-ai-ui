// scripts/owner-questions.ts — 竹内さんへの質問の台帳（owner_questions）と、ブレインの分からない事（brain_unknowns）を見る・答えを入れる
//   2026-10-22 竹内さんの決定（設計知見 395e0064）: 確認事項は全部まとめて聞く → 答えを設計知見とブレインに入れる → 試験で確かめる。
//
//   npx tsx --env-file=.env.local scripts/owner-questions.ts --open                 … 未回答の質問を話題ごと・推奨つきで並べる（gold・judge は数だけ）
//   npx tsx --env-file=.env.local scripts/owner-questions.ts --answer <id> "<答え>"  … 答えを入れる。普通の質問は設計知見（P1・札 竹内さんの決定）も作る（--dry で書かずに見るだけ・答え済みには入れない）
//                                                                                     judge_check は答えを same/partial/different（同じ/一部同じ/違う も可）で
//   npx tsx --env-file=.env.local scripts/owner-questions.ts --obsolete <id> "<理由>" … 不要にする
//   npx tsx --env-file=.env.local scripts/owner-questions.ts --gold | --judge         … 正解を決めてもらう番・AI の判定の比べの一覧
//   npx tsx --env-file=.env.local scripts/owner-questions.ts --unknowns [--limit=20]  … ブレインの分からない事（多い順）
//   npx tsx --env-file=.env.local scripts/owner-questions.ts --collect-exam [--dry]   … 試験の外れの理由（手元の reasons-latest.json）を brain_unknowns に足す（同じ回は二重に足さない）
//   <id> は先頭8字でよい。書くのはサーバーの鍵（RLS 有効の表）。LINE には何も送らない。
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderOpenQuestions, kbRowForAnswer, optionsOf, VERDICT_JA, type OwnerQuestion } from "../app/lib/owner-questions";
import { aggregateUnknowns, unknownsFromExamReasons, UNKNOWN_KIND_JA, type UnknownKind } from "../app/lib/brain-unknowns";
import { upsertUnknowns } from "../app/lib/brain-unknowns-server";
import { embedKbRows } from "../app/lib/design-knowledge-rag-server";
import { normalizeTags } from "../app/lib/design-knowledge-priority";
import { mojibakeFields } from "../app/lib/design-knowledge-curation";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) { console.error("SUPABASE_SERVICE_ROLE_KEY が要ります（表は RLS 有効・公開キーでは読めない）"); process.exit(1); }
const sb = createClient(url, key);
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const arg = (f: string, d = "") => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3) ?? d;
const after = (f: string) => { const i = argv.indexOf(`--${f}`); return i < 0 ? [] : argv.slice(i + 1).filter((a) => !a.startsWith("--")); };

async function findOne(idPrefix: string): Promise<OwnerQuestion> {
  const p = idPrefix.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(p)) throw new Error(`id の形が違う: ${idPrefix}`);
  const { data, error } = await sb.from("owner_questions").select("*");
  if (error) throw new Error(error.message);
  const hits = ((data ?? []) as OwnerQuestion[]).filter((r) => r.id.startsWith(p));
  if (hits.length !== 1) throw new Error(hits.length ? `id が ${hits.length} 件に当たる（もっと長く）: ${p}` : `id が無い: ${p}`);
  return hits[0];
}

async function allRows(): Promise<OwnerQuestion[]> {
  const { data, error } = await sb.from("owner_questions").select("*").order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as OwnerQuestion[];
}

async function insertKb(row: Record<string, unknown>): Promise<string> {
  row.tags = normalizeTags(row.tags as string[]).tags;
  const mb = mojibakeFields(row as Parameters<typeof mojibakeFields>[0]);
  if (mb.length) throw new Error(`文字化けしています（${mb.join("・")}）`);
  const { data, error } = await sb.from("system_design_thinking").insert([row]).select("id");
  if (error) throw new Error(`設計知見の INSERT 失敗: ${error.message}`);
  const id = String((data as Array<{ id: string }>)[0].id);
  try { await embedKbRows(sb, { dry: false, ids: [id] }); } catch (e) { console.warn("  埋め込みに失敗（週の整理で埋める）:", e instanceof Error ? e.message : e); }
  return id;
}

const VERDICT_IN: Record<string, string> = { same: "same", partial: "partial", different: "different", 同じ: "same", 一部同じ: "partial", 違う: "different" };

async function main() {
  if (has("open")) {
    console.log(renderOpenQuestions(await allRows()));
    return;
  }
  if (has("answer")) {
    const [id, ...rest] = after("answer");
    const answer = rest.join(" ").trim();
    if (!id || !answer) throw new Error('使い方: --answer <id> "<答え>"');
    const q = await findOne(id);
    if (q.status !== "open") throw new Error(`この質問は ${q.status}（答え済み・不要）です。設計知見を二重に作らないため止めます: ${q.id.slice(0, 8)}`);
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: "answered", answer, answered_at: now, updated_at: now };
    if (q.kind === "judge_check") {
      const v = VERDICT_IN[answer.split(/[\s（(]/)[0]];
      if (!v) throw new Error("judge_check の答えは same / partial / different（同じ・一部同じ・違う）で始める");
      patch.owner_verdict = v;
    } else if (q.kind === "gold") {
      patch.owner_verdict = answer;
    }
    if (has("dry")) {
      // 書かずに、入る物だけ見せる
      if (q.kind === "question") { const kb = kbRowForAnswer(q, answer, now); kb.tags = normalizeTags(kb.tags as string[]).tags; console.log("設計知見に入る行（dry）:", JSON.stringify(kb, null, 2)); }
      console.log(`台帳の更新（dry・書いていません）: ${q.id.slice(0, 8)}（${q.kind}）`, JSON.stringify(patch));
      return;
    }
    if (q.kind === "question") {
      patch.kb_id = await insertKb(kbRowForAnswer(q, answer, now));
      console.log(`設計知見を作りました: ${String(patch.kb_id).slice(0, 8)}`);
    }
    const { error } = await sb.from("owner_questions").update(patch).eq("id", q.id);
    if (error) throw new Error(error.message);
    console.log(`答えを入れました: ${q.id.slice(0, 8)}（${q.kind}）${q.question.slice(0, 60)} → ${answer}`);
    return;
  }
  if (has("obsolete")) {
    const [id, ...rest] = after("obsolete");
    if (!id) throw new Error('使い方: --obsolete <id> "<理由>"');
    const q = await findOne(id);
    const now = new Date().toISOString();
    const { error } = await sb.from("owner_questions").update({ status: "obsolete", answer: rest.join(" ").trim() || "不要", answered_at: now, updated_at: now }).eq("id", q.id);
    if (error) throw new Error(error.message);
    console.log(`不要にしました: ${q.id.slice(0, 8)} ${q.question.slice(0, 60)}`);
    return;
  }
  if (has("gold") || has("judge")) {
    const kind = has("gold") ? "gold" : "judge_check";
    const rows = (await allRows()).filter((r) => r.kind === kind && r.status === "open");
    console.log(`${kind === "gold" ? "正解を決めてもらう番" : "AI の判定の比べ"}（未回答 ${rows.length}件）`);
    rows.forEach((r, i) => {
      const ref = r.ref_exam_qid ? `試験 ${r.ref_exam_qid}` : r.ref_watch_turn_id ? `見張りの番 #${r.ref_watch_turn_id}` : "";
      const ai = r.ai_verdict ? `・AI の判定: ${VERDICT_JA[r.ai_verdict] ?? r.ai_verdict}` : "";
      console.log(`${i + 1}. ${r.question}（${ref}${ai}）`);
      const opts = optionsOf(r);
      if (opts.length) console.log(`   選択: ${opts.join(" ／ ")}`);
      if (r.recommended) console.log(`   → オススメ: ${r.recommended}`);
      console.log(`   [id ${r.id.slice(0, 8)}]`);
    });
    return;
  }
  if (has("unknowns")) {
    const limit = Math.max(1, Number(arg("limit", "20")) || 20);
    const { data, error } = await sb.from("brain_unknowns").select("kind, key, label, count, last_at, linked_question_id").order("count", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    console.log("ブレインの分からない事（多い順）");
    for (const r of (data ?? []) as Array<{ kind: UnknownKind; key: string; label: string | null; count: number; last_at: string; linked_question_id: string | null }>) {
      console.log(`- [${UNKNOWN_KIND_JA[r.kind] ?? r.kind}] ${r.label ?? r.key}: ${r.count}件（最後 ${r.last_at.slice(0, 10)}）${r.linked_question_id ? `・質問 ${r.linked_question_id.slice(0, 8)}` : ""}`);
    }
    return;
  }
  if (has("collect-exam")) {
    const dir = join(process.cwd(), ".claude", "exam-cache", "exam-brain", "conductor");
    const file = [join(dir, "reasons-latest.json"), join(process.cwd(), "..", "..", "..", ".claude", "exam-cache", "exam-brain", "conductor", "reasons-latest.json")].find((p) => existsSync(p));
    if (!file) { console.log("試験の外れの理由のファイルが無い（reasons-latest.json）"); return; }
    const rec = JSON.parse(readFileSync(file, "utf8")) as { label?: string; reasons?: Array<{ id: string; kind: string }> };
    // 同じ回（label）を二重に足さない: 既にその label を例に持つ型があれば止める
    const { data } = await sb.from("brain_unknowns").select("sample_ref").eq("kind", "exam_miss_type");
    const done = ((data ?? []) as Array<{ sample_ref: Array<{ exam_label?: string }> | null }>).some((r) => (r.sample_ref ?? []).some((s) => s.exam_label === rec.label));
    if (done) { console.log(`この回（${rec.label}）は足し済み`); return; }
    const aggs = aggregateUnknowns(unknownsFromExamReasons(rec));
    console.log(`試験 ${rec.label}: ${aggs.map((a) => `${a.key} ${a.n}`).join("・") || "外れの理由なし"}`);
    if (has("dry")) return;
    const r = await upsertUnknowns(sb, aggs);
    console.log(`brain_unknowns に足しました: ${r.rows}行・${r.hits}件`);
    return;
  }
  console.log(readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
