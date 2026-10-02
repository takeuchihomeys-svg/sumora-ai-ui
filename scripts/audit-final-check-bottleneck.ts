// scripts/audit-final-check-bottleneck.ts — 最終チェックはボトルネックか・生成と比べて邪魔をしていないか（読み取りのみ・LLM なし）
//
// 2026-10-02 竹内「また最終チェックがボトルネックになってる部分あるのか、生成のところとくらべて邪魔になっている部分も調査」
//   ① 待ち時間: 下書き1通ごとに 生成（reply_generate）と 最終チェック（3パス＋照合＋書き直し＋再検査）の時間・p50/p90・最終チェックの方が長い割合
//      （llm_usage_logs 本番・created_at は呼び出しの終わり。最終チェックの呼び出しには会話 id が無いので「直前に終わった生成」に結び付ける）
//   ② 費用の割合: 生成 vs 最終チェック（温め込み）vs ブレイン
//   ③ 良い下書きを止めた回: 最終チェックが block を残したのに、スタッフがほぼそのまま送った（送った例の記録）
//   ④ 書き直しは近づけたか: 書き直しがあった回となかった回で、下書き→実送信の近さ（bigram）を比べる。
//      影の記録（tpo_debug.finalCheckGate.draftIn＝書き直し前の本文）がある回は 生成→書き直し後→実送信 を直接比べる
//   ⑤ 文体だけの書き直し（2026-10-02 に止めた物）の過去の回数と、その回の実送信
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-bottleneck.ts [--from=2026-09-29] [--detail]
import { createClient } from "@supabase/supabase-js";
import { claudeUsageUsd, altUsageUsd } from "../app/lib/llm-price";
import { classifyIssueScope, isStyleOnlyNoError } from "../app/lib/final-check-scope";
import { isRevisable, type CheckIssue } from "../app/lib/final-check";
import { bigramSim, classifyEdit } from "../app/lib/edit-diff";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const FROM = arg("from", "2026-09-29T00:00:00+09:00");
const EX_FROM = arg("ex-from", "2026-09-10");
const DETAIL = process.argv.includes("--detail");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function page(table: string, select: string, build: (q: any) => any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(sb.from(table).select(select)).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const one = (s: string, n = 120) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const usd = (r: Record<string, unknown>) => (String(r.model ?? "").startsWith("claude") ? claudeUsageUsd(r as never) : altUsageUsd(r as never));

async function main() {
  // ── ①② llm_usage_logs ──
  const logs = await page("llm_usage_logs", "created_at, action, model, conversation_id, duration_ms, route, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens",
    (b) => b.eq("env", "production").gte("created_at", new Date(FROM).toISOString()).order("created_at"));
  const days = Math.max(1, (Date.now() - new Date(FROM).getTime()) / 86400_000);
  const isFc = (a: string) => a.startsWith("final_check_") && !a.startsWith("final_check_warm_");
  type Draft = { conv: string; genEnd: number; genMs: number; fc: Array<{ a: string; start: number; end: number }>; regen: boolean };
  const drafts: Draft[] = [];
  for (const l of logs) {
    const a = String(l.action ?? "");
    const end = Date.parse(l.created_at), dur = Number(l.duration_ms ?? 0);
    if (a === "reply_generate" && l.route === "/api/generate-reply") {
      const conv = String(l.conversation_id ?? "");
      if (conv === YUMA) continue;
      // 同じ会話で直前の下書きの最終チェックの後 60 秒以内の生成＝フィードバック再生成（同じ下書きの一部）
      const prev = [...drafts].reverse().find((d) => d.conv === conv);
      const prevEnd = prev ? Math.max(prev.genEnd, ...prev.fc.map((f) => f.end)) : 0;
      if (prev && end - dur - prevEnd < 60_000 && prev.fc.length) { prev.regen = true; prev.fc.push({ a: "regen_generate", start: end - dur, end }); continue; }
      drafts.push({ conv, genEnd: end, genMs: dur, fc: [], regen: false });
    } else if (isFc(a) && l.route === "/api/generate-reply") {
      const start = end - dur;
      const d = [...drafts].reverse().find((x) => x.genEnd <= start + 200);
      if (d && start - d.genEnd < 120_000) d.fc.push({ a, start, end });
    }
  }
  const withFc = drafts.filter((d) => d.fc.length);
  const genMs = withFc.map((d) => d.genMs);
  const fcMs = withFc.map((d) => Math.max(...d.fc.map((f) => f.end)) - d.genEnd);
  const passMs = withFc.map((d) => { const p = d.fc.filter((f) => /rule_check|anomaly_scan|context_check/.test(f.a)); return p.length ? Math.max(...p.map((f) => f.end)) - d.genEnd : 0; });
  const fixMs = withFc.map((d, i) => fcMs[i] - passMs[i]);
  const revised = withFc.filter((d) => d.fc.some((f) => f.a === "final_check_revision"));
  console.log(`=== ① 待ち時間（本番 ${FROM.slice(0, 10)}〜・下書き ${withFc.length}通・YUMA を除く）===`);
  console.log(`   生成（DeepSeek）           p50 ${q(genMs, 0.5)}ms  p90 ${q(genMs, 0.9)}ms`);
  console.log(`   最終チェック（全部）       p50 ${q(fcMs, 0.5)}ms  p90 ${q(fcMs, 0.9)}ms`);
  console.log(`     うち3パス（並列）        p50 ${q(passMs, 0.5)}ms  p90 ${q(passMs, 0.9)}ms`);
  console.log(`     うち照合・書き直し・再検査・作り直し p50 ${q(fixMs, 0.5)}ms  p90 ${q(fixMs, 0.9)}ms（書き直しあり ${revised.length}通 ${pct(revised.length, withFc.length)}・作り直し ${withFc.filter((d) => d.regen).length}通）`);
  const dom = withFc.filter((d, i) => fcMs[i] > d.genMs).length;
  console.log(`   最終チェックの方が生成より長い: ${dom}/${withFc.length}（${pct(dom, withFc.length)}）／ 合計に占める最終チェックの割合 p50 ${Math.round(q(withFc.map((d, i) => fcMs[i] / (fcMs[i] + d.genMs)), 0.5) * 100)}%`);
  const slowPass = new Map<string, number>();
  for (const d of withFc) { const p = d.fc.filter((f) => /rule_check|anomaly_scan|context_check/.test(f.a)); if (!p.length) continue; const last = p.reduce((a, b) => (b.end > a.end ? b : a)); slowPass.set(last.a, (slowPass.get(last.a) ?? 0) + 1); }
  console.log(`   3パスで一番遅かった段: ${[...slowPass].map(([k, v]) => `${k.replace("final_check_", "")} ${v}`).join("・")}`);
  const longFc = withFc.map((d, i) => ({ d, ms: fcMs[i] })).filter((x) => x.ms > 15000);
  for (const x of longFc.slice(0, 8)) console.log(`     15秒超: ${String(x.d.conv).slice(0, 8)} 生成 ${x.d.genMs}ms 最終チェック ${x.ms}ms [${x.d.fc.map((f) => `${f.a.replace("final_check_", "")}:${f.end - f.start}`).join(" ")}]`);

  const cost = new Map<string, { n: number; usd: number }>();
  for (const l of logs) {
    const a = String(l.action ?? "null");
    const k = a === "reply_generate" ? "生成（reply_generate）" : a.startsWith("final_check_warm_") ? "最終チェックの温め" : a.startsWith("final_check_") ? "最終チェック" : a.startsWith("brain") ? "ブレイン" : null;
    if (!k) continue;
    const c = cost.get(k) ?? { n: 0, usd: 0 }; c.n++; c.usd += usd(l); cost.set(k, c);
  }
  const tot = [...cost.values()].reduce((s, c) => s + c.usd, 0);
  console.log(`\n=== ② 費用の割合（本番・${days.toFixed(1)}日）===`);
  for (const [k, c] of [...cost].sort((a, b) => b[1].usd - a[1].usd)) console.log(`   ${k.padEnd(20)} ${String(c.n).padStart(5)}回  $${(c.usd / days).toFixed(2)}／日  ${pct(c.usd, tot)}`);
  const fcByAction = new Map<string, number>();
  for (const l of logs) { const a = String(l.action ?? ""); if (a.startsWith("final_check_")) fcByAction.set(a, (fcByAction.get(a) ?? 0) + usd(l)); }
  console.log(`   最終チェックの内訳: ${[...fcByAction].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace("final_check_", "")} $${(v / days).toFixed(2)}`).join("・")}`);

  // ── ③④⑤ 送った例の記録 ──
  const ex = await page("ai_reply_examples", "id, conversation_id, created_at, sent_reply, ai_draft, customer_message, reply_context_snapshot", (b) => b.gte("created_at", EX_FROM).order("created_at"));
  type R = { id: string; conv: string; at: string; draft: string; sent: string; cust: string; pre: string[]; fin: string[]; outcome: string; gate: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rs: R[] = [];
  for (const e of ex) {
    const s = e.reply_context_snapshot as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!s?.preRevisionCodes) continue;
    if (String(e.conversation_id) === YUMA) continue;
    rs.push({ id: String(e.id), conv: String(e.conversation_id), at: String(e.created_at), draft: String(e.ai_draft ?? "").trim() || String(s.draftHead ?? "").trim(), sent: String(e.sent_reply ?? "").trim(), cust: String(e.customer_message ?? ""),
      pre: s.preRevisionCodes ?? [], fin: s.finalCheckCodes ?? [], outcome: String(s.revisionOutcome ?? ""), gate: s.finalCheckGate ?? null });
  }
  const real = (codes: string[]) => codes.filter((x) => { const [c, sev] = x.split(":"); return sev === "block" && classifyIssueScope(c) !== "style" && c !== "UNCHECKED_AUTO_SEND"; });
  const blocked = rs.filter((r) => real(r.fin).length);
  const goodBlocked = blocked.filter((r) => r.sent && (classifyEdit(r.draft, r.sent).amount === "none" || classifyEdit(r.draft, r.sent).amount === "tiny"));
  console.log(`\n=== ③ 良い下書きを止めた回（送った例 ${rs.length}回・${EX_FROM}〜）===`);
  console.log(`   最終チェックが block を残した ${blocked.length}回 → スタッフがほぼそのまま送った ${goodBlocked.length}回（${pct(goodBlocked.length, blocked.length)}）`);
  for (const r of goodBlocked) console.log(`     ${r.at.slice(0, 10)} ${real(r.fin).join(",")} 客「${one(r.cust, 40)}」案「${one(r.draft, 90)}」`);

  // ④ 書き直しの有無で実送信への近さ。修正前に「直す指摘」があり最終の指摘が減った＝書き直し（か照合で消えた）と見なす
  const revisable = (codes: string[]) => codes.filter((x) => { const [c, sev] = x.split(":"); return sev !== "info" && !c.startsWith("TYPO_") && isRevisable({ code: c, severity: sev as CheckIssue["severity"] } as CheckIssue); });
  const groups = { 書き直しの指摘なし: [] as number[], 指摘あり_残った: [] as number[], 指摘あり_消えた: [] as number[] };
  for (const r of rs) {
    if (!r.sent || !r.draft) continue;
    const sim = bigramSim(r.draft, r.sent);
    const pre = revisable(r.pre), fin = revisable(r.fin);
    if (!pre.length) groups.書き直しの指摘なし.push(sim);
    else if (fin.length < pre.length) groups.指摘あり_消えた.push(sim);
    else groups.指摘あり_残った.push(sim);
  }
  console.log(`\n=== ④ 下書き→実送信の近さ（bigram・送った例）===`);
  for (const [k, v] of Object.entries(groups)) console.log(`   ${k.padEnd(14)} ${String(v.length).padStart(4)}回  近さ p50 ${q(v, 0.5).toFixed(3)}  そのまま率 ${pct(v.filter((x) => x >= 0.95).length, v.length)}`);
  const withIn = rs.filter((r) => r.gate?.draftIn && r.sent);
  if (withIn.length) {
    let closer = 0, farther = 0;
    for (const r of withIn) { const a = bigramSim(r.gate!.draftIn, r.sent), b = bigramSim(r.draft, r.sent); if (b > a + 0.02) closer++; else if (a > b + 0.02) farther++; if (DETAIL) console.log(`     生成→実 ${a.toFixed(2)} ／ 書き直し後→実 ${b.toFixed(2)}  前「${one(r.gate!.draftIn, 70)}」後「${one(r.draft, 70)}」`); }
    console.log(`   影の記録（書き直し前の本文あり）${withIn.length}回: 書き直しで実送信に近づいた ${closer} ／ 遠ざかった ${farther} ／ ほぼ同じ ${withIn.length - closer - farther}`);
  } else console.log(`   書き直し前の本文の記録（tpo_debug.finalCheckGate.draftIn・10/02〜）はまだ無い＝生成→書き直し後→実送信の直接比較はこれから溜まる`);

  // ⑤ 文体だけの書き直し（10/02 に止めた）
  const styleOnly = rs.filter((r) => { const pre = revisable(r.pre); return pre.length > 0 && !r.pre.some((x) => x.endsWith(":block")) && isStyleOnlyNoError(pre.map((x) => ({ code: x.split(":")[0], severity: x.split(":")[1] }))); });
  const styleAny = rs.filter((r) => { const pre = revisable(r.pre); return pre.length > 0 && !r.pre.some((x) => x.endsWith(":block")) && pre.every((x) => classifyIssueScope(x.split(":")[0]) === "style"); });
  console.log(`\n=== ⑤ 書き直しを止めた回（直す指摘が「文に間違いの無い文体」だけ・warning のみ）===`);
  console.log(`   ${styleOnly.length}/${rs.length}回（${pct(styleOnly.length, rs.length)}）／ 参考: 文体全体だと ${styleAny.length}回（間違いを含む文体＝二重敬語・主語のずれ等は今までどおり書き直す）`);
  const codes = new Map<string, number>();
  for (const r of styleOnly) for (const x of revisable(r.pre)) codes.set(x, (codes.get(x) ?? 0) + 1);
  console.log(`   指摘: ${[...codes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  const sims = styleOnly.filter((r) => r.sent).map((r) => bigramSim(r.draft, r.sent));
  console.log(`   その回の下書き→実送信: 近さ p50 ${q(sims, 0.5).toFixed(3)}・そのまま率 ${pct(sims.filter((x) => x >= 0.95).length, sims.length)}`);
  const perRevision = ((fcByAction.get("final_check_revision") ?? 0) + (fcByAction.get("final_check_recheck") ?? 0)) / Math.max(1, logs.filter((l) => l.action === "final_check_revision").length);
  const draftsPerDay = withFc.length / days;
  console.log(`   書き直し1回 $${perRevision.toFixed(4)} × 1日 ${draftsPerDay.toFixed(1)}通 × ${pct(styleOnly.length, rs.length)} ＝ 1日 約 $${(perRevision * draftsPerDay * styleOnly.length / Math.max(1, rs.length)).toFixed(2)}・待ち 書き直し＋再検査 約 ${q(fixMs.filter((x) => x > 0), 0.5)}ms`);
  if (DETAIL) for (const r of styleOnly) console.log(`     [${revisable(r.pre).join(",")}] 客「${one(r.cust, 36)}」案「${one(r.draft, 80)}」${r.sent && r.sent !== r.draft ? ` 実「${one(r.sent, 80)}」` : "（そのまま）"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
