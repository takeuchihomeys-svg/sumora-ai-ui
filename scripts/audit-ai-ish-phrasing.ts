// scripts/audit-ai-ish-phrasing.ts
// 2026-10-02 夜 竹内さん「aiすぎる文の生成防ぐのも必要、相手に違和感出るから」: 巡ごとの「AIっぽすぎる文」の点検。読むだけ・LLM なし。
//   再生の下書き（--labels の jsonl の draft）と本番の AI の下書き（ai_reply_examples.ai_draft・--days）を、人の実送信（スタッフの手打ち・AIX を除く）と比べ、
//   ①AI の下書きに何度も出るのに人の送信にほぼ無い言い回し（文字の7連続・人の送信で 0〜1回）②硬い敬語の重ね・説明のしすぎ（1通の文の数・「させて頂き」の数）
//   を出す。直すのは入口（手本・指示）で、出口の書き換えは誤削除0の時だけ（CLAUDE.md の手順）
// 実行: npx tsx --env-file=.env.local scripts/audit-ai-ish-phrasing.ts --labels=l12-r23,l12-r23s [--days=30] [--top=25]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = 7, TOP = Number(arg("top", "25")), DAYS = Number(arg("days", "30"));
const norm = (s: string) => s.normalize("NFKC").replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/[！!]+/g, "！").replace(/\s+/g, "");
const MASK = (s: string) => s.replace(/[0-9]+/g, "#").replace(/[^\s、。！]{1,12}さん/g, "〇さん");
function grams(s: string): Set<string> { const t = MASK(norm(s)); const out = new Set<string>(); for (let i = 0; i + N <= t.length; i++) { const g = t.slice(i, i + N); if (!/[、。！？]/.test(g.slice(1, -1))) out.add(g); } return out; }
(async () => {
  // 人の実送信（180日・手打ち）
  const staff = new Map<string, number>();
  for (let f = 0; f < 60_000; f += 1000) {
    const { data } = await sb.from("messages").select("text").neq("sender", "customer").or("is_aix_generated.is.null,is_aix_generated.eq.false").gte("created_at", new Date(Date.now() - 180 * 86_400_000).toISOString()).range(f, f + 999);
    for (const m of data ?? []) for (const g of grams(String(m.text ?? ""))) staff.set(g, (staff.get(g) ?? 0) + 1);
    if ((data ?? []).length < 1000) break;
  }
  // AI の下書き（再生＋本番）
  const drafts: string[] = [];
  for (const l of arg("labels").split(",").filter(Boolean)) {
    const f = `scripts/.replay-out/${l}.jsonl`; if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").trim().split("\n")) { try { const r = JSON.parse(line) as { draft?: string }; if (r.draft) drafts.push(r.draft); } catch { /* 飛ばす */ } }
  }
  const replayN = drafts.length;
  const { data: ex } = await sb.from("ai_reply_examples").select("ai_draft").gte("created_at", new Date(Date.now() - DAYS * 86_400_000).toISOString()).not("ai_draft", "is", null).limit(1000);
  for (const r of ex ?? []) drafts.push(String(r.ai_draft));
  const ai = new Map<string, { n: number; ex: string }>();
  for (const d of drafts) for (const g of grams(d)) { const c = ai.get(g) ?? { n: 0, ex: "" }; c.n++; if (!c.ex) { const sent = d.split(/(?<=[！!。？?])|\n/).find((x) => grams(x).has(g)); c.ex = (sent ?? "").trim().slice(0, 70); } ai.set(g, c); }
  const rows = [...ai].filter(([g, c]) => c.n >= 4 && (staff.get(g) ?? 0) <= 1).sort((a, b) => b[1].n - a[1].n);
  // 近い文字列をまとめる（同じ例文から出た連続の7文字は1つに）
  const seenEx = new Set<string>(); const out: string[] = [];
  for (const [g, c] of rows) { if (seenEx.has(c.ex)) continue; seenEx.add(c.ex); out.push(`${String(c.n).padStart(3)}回（人 ${staff.get(g) ?? 0}）「${g}」 例: ${c.ex}`); if (out.length >= TOP) break; }
  console.log(`AI の下書き ${drafts.length}（再生 ${replayN}・本番 ${drafts.length - replayN}）・人の手打ち 180日の言い回しと比べた「AI にだけ多い言い回し」上位`);
  for (const o of out) console.log("  " + o);
  // 硬さ・説明のしすぎ（1通あたり）
  const stat = (ts: string[]) => { const sents = ts.map((t) => t.split(/(?<=[！!。？?])|\n/).filter((x) => x.trim().length > 2).length); const keigo = ts.map((t) => (t.match(/させて(?:頂|いただ)き/g) ?? []).length); const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2); return `文の数 ${avg(sents)}・「させて頂き」${avg(keigo)}`; };
  const { data: hs } = await sb.from("messages").select("text").neq("sender", "customer").or("is_aix_generated.is.null,is_aix_generated.eq.false").gte("created_at", new Date(Date.now() - DAYS * 86_400_000).toISOString()).limit(1000);
  console.log(`1通あたり: AI の下書き ${stat(drafts)} ／ 人の手打ち ${stat((hs ?? []).map((m) => String(m.text ?? "")))}`);
})();
