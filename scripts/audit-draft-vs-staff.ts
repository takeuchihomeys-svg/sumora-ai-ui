// AI の下書きは「スタッフが送るような文」になっているか（読み取りのみ）
//
// 2026-09-21 竹内「文の質が上がっていないってことは実際のスタッフが送るような文が
//   生成されていない可能性があるってこと？」
//
// ⚠ 前回の「質が変わっていない」は **最終チェックの文体の指摘を消しても、そのまま送った率が変わらなかった**
//   という意味で、「下書きがスタッフの文に似ていない」という意味ではない。別に測る。
//
// 測り方（設計知見「生成文と実送信の差分が正解データ」「AI だけが書いて人間が一度も書かない文を数える」）:
//   ① そのまま送った率・下書きと実送信の近さ を**週別の時系列**で（全体の率は過去で薄まる）
//   ② スタッフが直した時、**何を消して何を足したか**を述部で数える
//      → 消される述部＝AI だけが書く言い回し ／ 足される述部＝AI が書けていない言い回し
//   ③ 今日の直しの後のデータがどれだけあるか（正直に）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-vs-staff.ts
import { createClient } from "@supabase/supabase-js";
import { extractPhraseShapes, messageSimilarity } from "../app/lib/phrase-shape";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");
const jst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const ex = await page("ai_reply_examples",
    "id, conversation_id, ai_draft, sent_reply, was_ai_used, was_ai_modified, ai_similarity, entry_source, created_at",
    "created_at", days);
  const pairs = ex.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim());
  console.log(`=== 材料: ai_reply_examples ${ex.length}件 / 下書きと実送信が揃う ${pairs.length}件（直近${days}日）===\n`);

  // ── ① 週別の時系列 ──
  console.log(`=== ① そのまま送った率・下書きと実送信の近さ（週別・JST）===`);
  const week = (iso: string) => { const d = new Date(jst(iso)); const day = d.getUTCDay(); const m = new Date(d); m.setUTCDate(d.getUTCDate() - ((day + 6) % 7)); return m.toISOString().slice(0, 10); };
  const byWeek = new Map<string, { n: number; used: number; sims: number[] }>();
  for (const r of pairs) {
    const w = week(String(r.created_at));
    const b = byWeek.get(w) ?? { n: 0, used: 0, sims: [] };
    b.n++; if (r.was_ai_used) b.used++;
    b.sims.push(messageSimilarity(String(r.ai_draft), String(r.sent_reply)));
    byWeek.set(w, b);
  }
  console.log(`   週(月曜)      件数   そのまま送った率   下書きと実送信の近さ(中央値)`);
  for (const [w, v] of [...byWeek.entries()].sort()) {
    const s = [...v.sims].sort((a, b) => a - b);
    console.log(`   ${w}  ${String(v.n).padStart(5)}  ${pct(v.used, v.n).padStart(8)}          ${(s[Math.floor(s.length / 2)] ?? 0).toFixed(3)}`);
  }

  // ── ② スタッフが直した時、何を消して何を足したか ──
  console.log(`\n=== ② スタッフが直した時に「消した／足した」言い回し（述部で数える）===`);
  const edited = pairs.filter((r) => !r.was_ai_used || r.was_ai_modified);
  console.log(`   直した例 ${edited.length}件 / 全体 ${pairs.length}件 (${pct(edited.length, pairs.length)})\n`);
  const removed = new Map<string, { n: number; ex: string }>();
  const added = new Map<string, { n: number; ex: string }>();
  for (const r of edited) {
    const d = extractPhraseShapes(String(r.ai_draft));
    const s = extractPhraseShapes(String(r.sent_reply));
    const sp = new Set(s.map((x) => x.predicate)), dp = new Set(d.map((x) => x.predicate));
    for (const x of d) if (!sp.has(x.predicate)) { const b = removed.get(x.predicate) ?? { n: 0, ex: x.clause }; b.n++; removed.set(x.predicate, b); }
    for (const x of s) if (!dp.has(x.predicate)) { const b = added.get(x.predicate) ?? { n: 0, ex: x.clause }; b.n++; added.set(x.predicate, b); }
  }
  console.log(`   ▼ AI が書いてスタッフが**消した**言い回し 上位15（＝AI だけが書く形）`);
  for (const [k, v] of [...removed.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
    console.log(`     ${String(v.n).padStart(4)}回  ${k.padEnd(12)}  例: ${mask(v.ex).slice(0, 60)}`);
  }
  console.log(`\n   ▼ AI が書かずスタッフが**足した**言い回し 上位15（＝AI が書けていない形）`);
  for (const [k, v] of [...added.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
    console.log(`     ${String(v.n).padStart(4)}回  ${k.padEnd(12)}  例: ${mask(v.ex).slice(0, 60)}`);
  }

  // ── ③ 今日の直しの後のデータ量（正直に）──
  console.log(`\n=== ③ 今日（2026-09-21）の直しの後に溜まったデータ ===`);
  const today = pairs.filter((r) => jst(String(r.created_at)).slice(0, 10) === "2026-09-21");
  console.log(`   9/21 の下書き＋実送信が揃う例: ${today.length}件`);
  if (today.length < 20) {
    console.log(`   ⚠ **まだ判断できる量ではない**。効果は数日たってから週別の表（①）で見る。`);
  } else {
    const used = today.filter((r) => r.was_ai_used).length;
    const sims = today.map((r) => messageSimilarity(String(r.ai_draft), String(r.sent_reply))).sort((a, b) => a - b);
    console.log(`   そのまま送った率 ${pct(used, today.length)} / 近さ中央値 ${(sims[Math.floor(sims.length / 2)] ?? 0).toFixed(3)}`);
  }

  // ── ④ 近さの分布（「似ていない」が何割あるか）──
  console.log(`\n=== ④ 下書きと実送信の近さの分布（直近30日）===`);
  const recent = pairs.filter((r) => Date.now() - new Date(String(r.created_at)).getTime() < 30 * 86400_000);
  const sims = recent.map((r) => messageSimilarity(String(r.ai_draft), String(r.sent_reply)));
  const bands = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]];
  for (const [lo, hi] of bands) {
    const c = sims.filter((s) => s >= lo && s < hi).length;
    const label = lo >= 0.9 ? "ほぼ同じ" : lo >= 0.7 ? "少し直した" : lo >= 0.5 ? "半分書き直し" : lo >= 0.3 ? "大きく書き直し" : "別の文";
    console.log(`   ${lo.toFixed(1)}〜${hi >= 1 ? "1.0" : hi.toFixed(1)}  ${String(c).padStart(5)}件 (${pct(c, sims.length).padStart(6)})  ${label}  ${"█".repeat(Math.round(c / (sims.length || 1) * 40))}`);
  }

  console.log(`\n=== ⑤ 大きく書き直された実物（近さ0.3未満・5件）===`);
  const worst = recent
    .map((r) => ({ r, s: messageSimilarity(String(r.ai_draft), String(r.sent_reply)) }))
    .filter((x) => x.s < 0.3).sort((a, b) => a.s - b.s).slice(0, 5);
  for (const w of worst) {
    console.log(`${"─".repeat(74)}`);
    console.log(`   近さ ${w.s.toFixed(2)}  ${String(w.r.created_at).slice(0, 10)}  ${w.r.entry_source ?? ""}`);
    console.log(`   下書き: ${mask(String(w.r.ai_draft)).slice(0, 130)}`);
    console.log(`   実送信: ${mask(String(w.r.sent_reply)).slice(0, 130)}`);
  }
  void num;
}
main().catch((e) => { console.error(e); process.exit(1); });
