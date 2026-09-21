// ブレインとセル、本当はどちらが正しかったのか（読み取りのみ）
//
// 2026-09-21 竹内「実際はブレインの判断の方が正しい形やったかな？
//   最終チェックの部分が逆にボトルネックになって文の質悪くしてた形かな？またその点は改善されているのかな？」
//
// ⚠ 前回の測定（95.7%＝セルが正しい）には**循環**がある:
//   「スタッフの実送信」に当てたが、その実送信の多くは **AI が書いた下書きをスタッフがそのまま送った物**。
//   AI はセルの必須要素に従って書いているので、「スタッフも書いていた」は当たり前になる。
//   → **スタッフが自分で書き直した分だけ**を見ないと、セルが正しいかは分からない。
//   設計知見「生成文と実送信の差分が正解データ」「手本に同じ文が1件あっても因果の向きを確かめる」
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-vs-cell-truth.ts
import { createClient } from "@supabase/supabase-js";
import { PAIR_MATRIX, mustIncludeSatisfied, type PairContext } from "../app/lib/reply-context";
import { classifyIssueScope } from "../app/lib/final-check-scope";

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
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

type Conflict = { kind?: string; ruleId?: string; element?: string; brainValue?: string; message?: string };

async function main() {
  const days = Number(process.env.DAYS ?? 90);
  const ex = await page("ai_reply_examples",
    "id, conversation_id, ai_draft, sent_reply, was_ai_used, was_ai_modified, ai_similarity, reply_context_snapshot, created_at",
    "created_at", days);
  const withSnap = ex.filter((r) => r.reply_context_snapshot && typeof r.reply_context_snapshot === "object");
  console.log(`=== 材料: ai_reply_examples ${ex.length}件 / スナップショット有り ${withSnap.length}件（直近${days}日）===\n`);

  // ══════════════════════════════════════════════════════════════
  // ① 循環を外す: 「スタッフが自分で書き直した分」だけでセルの必須要素を見る
  // ══════════════════════════════════════════════════════════════
  console.log(`=== ① セルの必須要素は、スタッフが**自分で書き直した時**にも書かれているか ===`);
  console.log(`   （AI の下書きをそのまま送った分はセルの影響を受けているので分けて数える）\n`);
  type Row = { wrote: boolean; own: boolean; cls: string; element: string; sent: string; draft: string };
  const rows: Row[] = [];
  for (const r of withSnap) {
    const snap = r.reply_context_snapshot as Record<string, unknown>;
    const tp = (snap.turnPair ?? null) as { ruleId?: string | null } | null;
    const conflicts = ((snap.cellConflicts ?? []) as Conflict[]).filter((c) => c.kind === "avoid_vs_must");
    if (!tp?.ruleId || conflicts.length === 0) continue;
    const rule = PAIR_MATRIX.find((x) => x.id === tp.ruleId);
    const sent = String(r.sent_reply ?? ""), draft = String(r.ai_draft ?? "");
    if (!sent) continue;
    // 「スタッフが自分で書いた」= AI を使っていない or 大きく直した（似ている度が低い）
    const sim = n(r.ai_similarity);
    const own = !r.was_ai_used || (!!r.was_ai_modified && sim > 0 && sim < 0.8);
    for (const c of conflicts) {
      const elem = rule?.mustInclude.find((m) => m.label === c.element);
      if (!elem) continue;
      const wrote = elem.detectFn ? elem.detect.test(sent) : mustIncludeSatisfied(elem, sent, {} as PairContext);
      rows.push({ wrote, own, cls: c.message?.match(/意味クラス:\s*([a-z_]+)/)?.[1] ?? "?", element: String(c.element), sent, draft });
    }
  }
  const all = rows.length, own = rows.filter((r) => r.own), ai = rows.filter((r) => !r.own);
  console.log(`   衝突した必須要素 ${all}個`);
  console.log(`   ├ AI の下書きをそのまま／ほぼそのまま送った  ${ai.length}個 … 書かれていた ${ai.filter((r) => r.wrote).length}個 (${pct(ai.filter((r) => r.wrote).length, ai.length)})  ← セルの影響を受けている（循環）`);
  console.log(`   └ スタッフが自分で書いた／大きく直した      ${own.length}個 … 書かれていた ${own.filter((r) => r.wrote).length}個 (${pct(own.filter((r) => r.wrote).length, own.length)})  ← **こちらが本当の答え**`);
  if (own.length > 0) {
    const r = own.filter((x) => x.wrote).length / own.length;
    console.log(`\n   → スタッフが自分で書いた時に ${pct(own.filter((x) => x.wrote).length, own.length)} 書いている`);
    console.log(`     ${r >= 0.5 ? "＝ セルの必須要素は妥当（ブレインの avoid の方が行き過ぎ）" : "＝ **ブレインの判断の方が正しい**（セルが書きすぎ）"}`);
  } else {
    console.log(`\n   ⚠ スタッフが自分で書いた分が0個。この母集団では判定できない`);
  }
  for (const r of own.slice(0, 5)) {
    console.log(`${"─".repeat(74)}`);
    console.log(`     要素: ${r.element.slice(0, 50)}  → ${r.wrote ? "書いた" : "**書かなかった**"}`);
    console.log(`     AI下書き: ${mask(r.draft).slice(0, 100)}`);
    console.log(`     実送信  : ${mask(r.sent).slice(0, 100)}`);
  }

  // ══════════════════════════════════════════════════════════════
  // ② 最終チェックはボトルネックだったか（指摘あり/なしで質を比べる）
  // ══════════════════════════════════════════════════════════════
  console.log(`\n\n=== ② 最終チェックの指摘は、文の質を上げたか下げたか ===`);
  console.log(`   ⚠ conversations.ai_draft_check は**会話の最新の1件**なので、例とは時点がずれる。`);
  console.log(`     例ごとに残っている reply_context_snapshot.finalCheckCodes を使う（時点が正しく揃う）。`);
  console.log(`   質の物差し: was_ai_used（そのまま送った率）と ai_similarity（下書きと実送信の近さ）\n`);
  type Q = { used: number; n: number; sim: number[] };
  const mk = (): Q => ({ used: 0, n: 0, sim: [] });
  const g: Record<string, Q> = { "指摘なし": mk(), "文体だけ": mk(), "事実・安全あり": mk() };
  for (const r of withSnap) {
    const snap = r.reply_context_snapshot as Record<string, unknown>;
    const codes = (snap.finalCheckCodes as string[] | undefined) ?? null;
    if (!codes) continue;                      // 検査の記録が無い例は対象外
    const parsed = codes.map((s) => String(s).split(":")[0]);
    const hasFact = parsed.some((c) => classifyIssueScope(c) !== "style");
    const k = parsed.length === 0 ? "指摘なし" : hasFact ? "事実・安全あり" : "文体だけ";
    g[k].n++;
    if (r.was_ai_used) g[k].used++;
    const s = n(r.ai_similarity); if (s > 0) g[k].sim.push(s);
  }
  console.log(`   群              件数   そのまま送った率   下書きと実送信の近さ`);
  for (const [k, v] of Object.entries(g)) {
    const avg = v.sim.length ? v.sim.reduce((a, b) => a + b, 0) / v.sim.length : 0;
    console.log(`   ${k.padEnd(14)} ${String(v.n).padStart(4)}件  ${pct(v.used, v.n).padStart(8)}          ${avg.toFixed(3)}`);
  }
  console.log(`   → 文体だけの群が劣っていれば「文体の指摘＝質を下げていた」。`);
  console.log(`     ⚠ 因果の向きに注意: 文体の指摘（感嘆符が多い・何卒の位置）は**長くて中身のある文**に出やすい。`);
  console.log(`       「指摘が出たから良い」ではなく「良い文だから指摘が出た」かもしれない。`);

  // ══════════════════════════════════════════════════════════════
  // ③ 作り直し（regen）は質を上げたか
  // ══════════════════════════════════════════════════════════════
  console.log(`\n=== ③ 作り直し（最終チェックの block で走る再生成）は質を上げたか ===`);
  console.log(`   revisionOutcome / preRevisionCodes（例ごとの記録）で見る\n`);
  const byRev = new Map<string, { n: number; used: number; sim: number[] }>();
  for (const r of withSnap) {
    const snap = r.reply_context_snapshot as Record<string, unknown>;
    const outcome = snap.revisionOutcome === undefined || snap.revisionOutcome === null
      ? "（記録なし）" : String(snap.revisionOutcome);
    const b = byRev.get(outcome) ?? { n: 0, used: 0, sim: [] };
    b.n++; if (r.was_ai_used) b.used++;
    const s = n(r.ai_similarity); if (s > 0) b.sim.push(s);
    byRev.set(outcome, b);
  }
  for (const [k, v] of [...byRev.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const avg = v.sim.length ? v.sim.reduce((a, b) => a + b, 0) / v.sim.length : 0;
    console.log(`   ${k.padEnd(18)} ${String(v.n).padStart(4)}件  そのまま送った率 ${pct(v.used, v.n).padStart(7)}  近さ ${avg.toFixed(3)}`);
  }

  // ══════════════════════════════════════════════════════════════
  // ④ 文体の指摘が出た文は、本当に「長くて中身がある」のか（因果の向きを確かめる）
  // ══════════════════════════════════════════════════════════════
  console.log(`\n=== ④ 因果の向きを確かめる: 指摘の有無と下書きの長さ ===`);
  const lenBy: Record<string, number[]> = { "指摘なし": [], "文体だけ": [], "事実・安全あり": [] };
  for (const r of withSnap) {
    const snap = r.reply_context_snapshot as Record<string, unknown>;
    const codes = (snap.finalCheckCodes as string[] | undefined) ?? null;
    if (!codes) continue;
    const parsed = codes.map((s) => String(s).split(":")[0]);
    const hasFact = parsed.some((c) => classifyIssueScope(c) !== "style");
    const k = parsed.length === 0 ? "指摘なし" : hasFact ? "事実・安全あり" : "文体だけ";
    const d = String(r.ai_draft ?? "").replace(/\s/g, "").length;
    if (d > 0) lenBy[k].push(d);
  }
  for (const [k, a] of Object.entries(lenBy)) {
    if (a.length === 0) { console.log(`   ${k.padEnd(14)} （0件）`); continue; }
    const s = [...a].sort((x, y) => x - y);
    console.log(`   ${k.padEnd(14)} ${String(a.length).padStart(4)}件  下書きの長さ 中央値 ${s[Math.floor(s.length / 2)]}字`);
  }
  console.log(`   → 文体だけの群が長ければ「長い文ほど指摘が出る」＝ 質が高いから指摘が出ていた（因果が逆）`);

  // ══════════════════════════════════════════════════════════════
  // ⑤ 【本命】AI が書いた「ぶつかった要素」を、スタッフは消したか
  //    設計知見「生成文と実送信の差分が正解データ」— 循環しない唯一の測り方
  // ══════════════════════════════════════════════════════════════
  console.log(`\n=== ⑤【本命】AI が書いた「ブレインが避けろと言った要素」を、スタッフは消したか ===`);
  console.log(`   下書きに有り → 実送信に無い ＝ スタッフが消した ＝ **ブレインが正しかった**`);
  console.log(`   下書きに有り → 実送信にも有り ＝ スタッフが残した ＝ **セルが正しかった**\n`);
  let inDraft = 0, kept = 0, removed = 0;
  const removedEx: string[] = [], keptEx: string[] = [];
  for (const r of withSnap) {
    const snap = r.reply_context_snapshot as Record<string, unknown>;
    const tp = (snap.turnPair ?? null) as { ruleId?: string | null } | null;
    const conflicts = ((snap.cellConflicts ?? []) as Conflict[]).filter((c) => c.kind === "avoid_vs_must");
    if (!tp?.ruleId || conflicts.length === 0) continue;
    const rule = PAIR_MATRIX.find((x) => x.id === tp.ruleId);
    const draft = String(r.ai_draft ?? ""), sent = String(r.sent_reply ?? "");
    if (!draft || !sent) continue;
    for (const c of conflicts) {
      const elem = rule?.mustInclude.find((m) => m.label === c.element);
      if (!elem) continue;
      const hit = (t: string) => elem.detectFn ? elem.detect.test(t) : mustIncludeSatisfied(elem, t, {} as PairContext);
      if (!hit(draft)) continue;          // AI が書いていなければ判定できない
      inDraft++;
      if (hit(sent)) {
        kept++;
        if (keptEx.length < 3) keptEx.push(`     避ける「${c.brainValue}」／要素 ${String(c.element).slice(0, 40)}\n     実送信: ${mask(sent).slice(0, 110)}`);
      } else {
        removed++;
        if (removedEx.length < 5) removedEx.push(`     避ける「${c.brainValue}」／要素 ${String(c.element).slice(0, 40)}\n     下書き: ${mask(draft).slice(0, 110)}\n     実送信: ${mask(sent).slice(0, 110)}`);
      }
    }
  }
  console.log(`   AI が書いた ${inDraft}個 … スタッフが残した ${kept}個 (${pct(kept, inDraft)}) / **消した ${removed}個 (${pct(removed, inDraft)})**`);
  if (inDraft === 0) console.log(`   ⚠ 判定できる標本が0個`);
  else if (removed / inDraft >= 0.5) console.log(`   → **ブレインの判断の方が正しかった**（半分以上をスタッフが消している）`);
  else console.log(`   → セルの必須要素の方が実送信に合っている（スタッフは残している）`);
  if (removedEx.length) { console.log(`\n   消された実物:`); for (const s of removedEx) { console.log(`${"─".repeat(74)}`); console.log(s); } }
  if (keptEx.length) { console.log(`\n   残された実物:`); for (const s of keptEx) { console.log(`${"─".repeat(74)}`); console.log(s); } }
}
main().catch((e) => { console.error(e); process.exit(1); });
