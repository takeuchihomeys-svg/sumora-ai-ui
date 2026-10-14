// scripts/audit-aix-after-text.ts — 「AIX の後の文」（AIX を押した直後にスタッフが打った文）の材料と竹内さんの実送信の差（読むだけ・LLM なし・費用0）
//
// 2026-10-14 竹内さん「AIX の後の返信を AIX テンプレートとして・竹内さんの基準に」:
//   番 = AIX を押して送った（aix_usage_logs.sent_at）直後 15分以内・次のお客様の発言より前に、スタッフが画面で打って送った文（is_aix_generated=false・画像だけの通は除く）。
//   材料 = その文の前に画面にあった文: ✨この会話に合った文（aix_generate_log の source=aix-template-generate）／🟣テンプレの最適化（template_selection_logs.adapted_text）／
//          返信の下書き（ai_reply_examples line_reply の ai_draft・送った文と結ぶ）。一番近い物を「材料」とする。
//   物差し（竹内さんの実送信が正）: 材料があった率・直さず送れた率（空白・絵文字を除いて同じ）・似ている度（2文字組の Dice）・よく消す行／足す行（伏せた形）
//   AIX の種類ごと・竹内さん／従業員で分ける。
//   もう1つ: --split=<audit-split-reply-aix の --out> を渡すと「人の文に AIX の中身がある番」（aixByText）の下書き×送信も同じ物差しで出す
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-after-text.ts [--days=30] [--show=6] [--split=<jsonl>] [--json=<out・個人情報は伏せた行だけ>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { cleanDraft } from "../app/lib/line-watch-judge";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const SHOW = Number(arg("show", "6"));
const SPLIT = arg("split");
const JSON_OUT = arg("json");
const SINCE = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const MIN = 60_000;

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 300_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
export const normAfter = (s: string) => String(s ?? "").normalize("NFKC").replace(EMOJI, "").replace(/[\s　]+/g, "");
export function diceAfter(a: string, b: string): number {
  const x = normAfter(a), y = normAfter(b);
  if (!x || !y) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bg(x), B = bg(y); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}
const maskLine = (l: string) => String(l ?? "").replace(EMOJI, "").replace(/https?:\/\/\S+/g, "<URL>").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "<TEL>")
  .replace(/[^\s、。！!？?・「」『』（）()]{1,12}(さん|様|さま)/g, "〇〇$1").replace(/[0-9０-９][0-9０-９,，.．]*/g, "#").replace(/[\s　]+/g, " ").trim();
const lines = (s: string) => String(s ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
type Press = { id: string; conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string; sent_at: string | null };
type Gen = { conversation_id: string; action_type: string; generated_text: string | null; created_at: string };
type Tsl = { conversation_id: string; created_at: string; aix_action_type: string | null; adapted_text: string | null; final_sent_text: string | null };
type Ex = { conversation_id: string; ai_draft: string | null; sent_reply: string | null; sent_at: string | null; created_at: string };
type Pair = { aix: string; writer: string; sent: string; mat: string | null; matKind: string; d: number; same: boolean; conv: string; at: string };

function summarize(label: string, ps: Pair[]) {
  const withMat = ps.filter((p) => p.mat);
  const same = withMat.filter((p) => p.same).length;
  const dAvg = withMat.length ? withMat.reduce((s, p) => s + p.d, 0) / withMat.length : NaN;
  const pct = (a: number, b: number) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : `${a}/0`);
  return `${label.padEnd(38)} 番 ${String(ps.length).padStart(3)}｜材料あり ${pct(withMat.length, ps.length)}｜直さず ${pct(same, withMat.length)}｜似ている度 ${Number.isFinite(dAvg) ? dAvg.toFixed(2) : "-"}｜材料: ${[...new Set(withMat.map((p) => p.matKind))].map((k) => `${k} ${withMat.filter((p) => p.matKind === k).length}`).join("・")}`;
}
function lineDiff(ps: Pair[], show: number) {
  const removed = new Map<string, number>(), added = new Map<string, number>();
  for (const p of ps) {
    if (!p.mat) continue;
    const ml = lines(p.mat), sl = lines(p.sent);
    for (const l of ml) if (!sl.some((s) => diceAfter(s, l) >= 0.8)) removed.set(maskLine(l), (removed.get(maskLine(l)) ?? 0) + 1);
    for (const l of sl) if (!ml.some((s) => diceAfter(s, l) >= 0.8)) added.set(maskLine(l), (added.get(maskLine(l)) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, show).map(([k, v]) => `      ${String(v).padStart(2)} ${k.slice(0, 90)}`).join("\n");
  return `    消した行（材料にあって竹内さんが送らなかった）:\n${top(removed) || "      -"}\n    足した行（竹内さんだけが書いた）:\n${top(added) || "      -"}`;
}

(async () => {
  const since3 = new Date(ms(SINCE) - 3 * 86_400_000).toISOString();
  const [presses, gens, tsls, exs] = await Promise.all([
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, aix_type, check_pattern, created_at, sent_at").gte("created_at", SINCE).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<Gen>((f, t) => sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, created_at").gte("created_at", since3).eq("conditions_snapshot->>source", "aix-template-generate").not("generated_text", "is", null).order("created_at").range(f, t)),
    readAll<Tsl>((f, t) => sb.from("template_selection_logs").select("conversation_id, created_at, aix_action_type, adapted_text, final_sent_text").gte("created_at", since3).order("created_at").range(f, t)),
    readAll<Ex>((f, t) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, sent_at, created_at").in("entry_source", ["line_reply", "aix_action"]).gte("created_at", since3).order("created_at").range(f, t)),
  ]);
  const convs = [...new Set(presses.map((p) => p.conversation_id).filter((c) => c && !isTestConversation(c)))];
  const msgs: Msg[] = [];
  for (let i = 0; i < convs.length; i += 60) {
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated, staff_writer").in("conversation_id", convs.slice(i, i + 60)).gte("created_at", SINCE).order("created_at").order("id").range(f, t)));
  }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), gBy = by(gens), tBy = by(tsls), eBy = by(exs), pBy = by(presses);
  const pairs: Pair[] = [];
  const usedMsg = new Set<string>();
  for (const p of presses) {
    if (!p.conversation_id || isTestConversation(p.conversation_id)) continue;
    const at = ms(p.sent_at ?? p.created_at);
    const mm = mBy.get(p.conversation_id) ?? [];
    const nextCust = mm.find((m) => m.sender === "customer" && ms(m.created_at) > at)?.created_at;
    const nextPress = (pBy.get(p.conversation_id) ?? []).find((q) => q.id !== p.id && ms(q.sent_at ?? q.created_at) > at)?.sent_at;
    const hi = Math.min(at + 15 * MIN, nextCust ? ms(nextCust) : Infinity, nextPress ? ms(nextPress) : Infinity);
    const after = mm.filter((m) => m.sender !== "customer" && !m.is_aix_generated && ms(m.created_at) > at + 1000 && ms(m.created_at) < hi && (m.text ?? "").trim() && !/^\[(?:画像|動画|スタンプ)\]$/.test((m.text ?? "").trim()) && !usedMsg.has(m.id));
    if (!after.length) continue;
    after.forEach((m) => usedMsg.add(m.id));
    const sent = after.map((m) => m.text ?? "").join("\n");
    const first = ms(after[0].created_at);
    const writer = after[0].staff_writer ?? "unknown";
    const cands: Array<{ kind: string; text: string }> = [];
    for (const g of gBy.get(p.conversation_id) ?? []) if (ms(g.created_at) >= at - 30 * MIN && ms(g.created_at) <= first + 30_000 && g.generated_text) cands.push({ kind: "✨テンプレ", text: g.generated_text });
    for (const t of tBy.get(p.conversation_id) ?? []) if (ms(t.created_at) >= at - 30 * MIN && ms(t.created_at) <= first + 2 * MIN && t.adapted_text) cands.push({ kind: "🟣最適化", text: t.adapted_text });
    for (const e of eBy.get(p.conversation_id) ?? []) {
      const ea = ms(e.sent_at ?? e.created_at);
      const d = cleanDraft(e.ai_draft).text;
      if (d && Math.abs(ea - first) < 3 * MIN && diceAfter(String(e.sent_reply ?? ""), sent) >= 0.6) cands.push({ kind: "下書き", text: d });
    }
    const best = cands.map((c) => ({ ...c, d: diceAfter(c.text, sent) })).sort((a, b) => b.d - a.d)[0] ?? null;
    pairs.push({ aix: `${p.aix_type}${p.check_pattern ? `/${p.check_pattern}` : ""}`, writer, sent, mat: best?.text ?? null, matKind: best?.kind ?? "なし", d: best?.d ?? 0, same: !!best && normAfter(best.text) === normAfter(sent), conv: p.conversation_id, at: after[0].created_at });
  }
  console.log(`# AIX の後の文（直近${DAYS}日・AIX を送った直後15分以内にスタッフが打った文）`);
  console.log(summarize("全体", pairs));
  console.log(summarize("竹内さん", pairs.filter((p) => p.writer === "takeuchi")));
  console.log(summarize("従業員", pairs.filter((p) => p.writer === "employee")));
  const tk = pairs.filter((p) => p.writer === "takeuchi");
  console.log(`\n## AIX の種類ごと（竹内さん・番 n>=2）`);
  const keys = [...new Set(tk.map((p) => p.aix.split("/")[0]))].sort((a, b) => tk.filter((p) => p.aix.startsWith(b)).length - tk.filter((p) => p.aix.startsWith(a)).length);
  for (const k of keys) { const xs = tk.filter((p) => p.aix.split("/")[0] === k); if (xs.length >= 2) console.log(summarize(k, xs)); }
  console.log(`\n## よく直されている言い回し（竹内さん・材料あり）`);
  for (const k of keys.slice(0, 4)) { const xs = tk.filter((p) => p.aix.split("/")[0] === k && p.mat); if (xs.length >= 2) { console.log(`  ■ ${k}（${xs.length}）`); console.log(lineDiff(xs, SHOW)); } }
  console.log(`\n## 材料なしの番の竹内さんの文（伏せた1行目・種類ごと上位）`);
  for (const k of keys.slice(0, 5)) {
    const xs = tk.filter((p) => p.aix.split("/")[0] === k && !p.mat);
    if (!xs.length) continue;
    const m = new Map<string, number>(); for (const p of xs) for (const l of lines(p.sent).slice(0, 3)) m.set(maskLine(l), (m.get(maskLine(l)) ?? 0) + 1);
    console.log(`  ■ ${k}（材料なし ${xs.length}）: ${[...m].sort((a, b) => b[1] - a[1]).slice(0, SHOW).map(([l, v]) => `${v}×「${l.slice(0, 40)}」`).join(" ")}`);
  }

  if (SPLIT) {
    type SRow = { aixByText?: boolean; writer: string; draft: string | null; sent: string | null; replyKind: string | null; truthKey: string };
    const rows: SRow[] = readFileSync(SPLIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const at = rows.filter((r) => r.aixByText);
    console.log(`\n# 人の文に AIX の中身がある番（${SPLIT.split(/[\\/]/).pop()}）: ${at.length}番（竹内さん ${at.filter((r) => r.writer === "takeuchi").length}）`);
    const kinds = new Map<string, number>(); for (const r of at) kinds.set(String(r.replyKind), (kinds.get(String(r.replyKind)) ?? 0) + 1);
    console.log(`  下書き: ${[...kinds].map(([k, v]) => `${k} ${v}`).join("・")}`);
    const wd = at.filter((r) => r.draft && r.sent);
    console.log(`  下書き×送信 ${wd.length}: 直さず ${wd.filter((r) => normAfter(r.draft!) === normAfter(r.sent!)).length}・似ている度 ${wd.length ? (wd.reduce((s, r) => s + diceAfter(r.draft!, r.sent!), 0) / wd.length).toFixed(2) : "-"}`);
    const k2 = new Map<string, number>(); for (const r of at) k2.set(r.truthKey, (k2.get(r.truthKey) ?? 0) + 1);
    console.log(`  中身の型: ${[...k2].map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(pairs.map((p) => ({ ...p, sent: lines(p.sent).map(maskLine).join("\n"), mat: p.mat ? lines(p.mat).map(maskLine).join("\n") : null })), null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
