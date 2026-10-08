// scripts/audit-grasp-gaps.ts — 把握の足りない所を実データで数える（10/08 竹内「細かい部分に対応できるように、ブレインに足りていない部分があれば追加していく形で。
//   今ある TPO の把握や日にちの把握みたいな形で」）。読むだけ・LLM なし。
//   材料: 7巡目の差の組（scripts/audit-r7-text-diff.ts --out= の jsonl＝AI の下書き × スタッフの実送信）＋その会話の messages。
//   番ごとに「把握の候補」（同じ日の何通目・連投の束・お客様の予定・時期・遠方・同行者・他社・前に伝えた事の繰り返し・スタッフの直前の行動・時間帯…）の印を決定論で付け、
//   印ごとに 件数・似ている度・中身の差（足した／消した文）のある率、と「その印に関係する差」（例: 前に伝えた事を AI が繰り返して人が消した）を数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-grasp-gaps.ts [--in=scripts/.replay-out/grasp-r7diff-40d.jsonl] [--days=45] [--show=<印>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { repeatedFromBefore, sameDayStaffCountBefore, customerCircumstances, staffActionJustBefore } from "../app/lib/grasp-notes";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = arg("in", "scripts/.replay-out/grasp-r7diff-40d.jsonl");
const DAYS = Number(arg("days", "45"));
const SHOW = arg("show", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type Pair = { cid: string; at: string; sub: string; customer: string; draft: string; staff: string; sim: number; added?: string[]; removed?: string[]; staffOnly?: boolean };
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };

async function main() {
  const pairs = readFileSync(IN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Pair).filter((p) => !p.staffOnly);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: Msg[] = [];
  for (let i = 0; i < 300_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as Msg[]));
    if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, Msg[]>();
  for (const m of msgs) { const k = m.conversation_id.slice(0, 8); if (!by.has(k)) by.set(k, []); by.get(k)!.push(m); }
  type Agg = { n: number; sim: number; content: number; related: number; ex: string[] };
  const agg = new Map<string, Agg>();
  const tag = (k: string, p: Pair, related: boolean, note = "") => {
    const a = agg.get(k) ?? { n: 0, sim: 0, content: 0, related: 0, ex: [] };
    a.n++; a.sim += p.sim; if ((p.added ?? []).length || (p.removed ?? []).length) a.content++;
    if (related) { a.related++; if (a.ex.length < 8) a.ex.push(`${p.at.slice(5, 16)} ${p.cid.slice(0, 6)} ${p.sub} sim=${p.sim}｜客:${p.customer.replace(/\s+/g, " ").slice(-90)}｜${note}`); }
    agg.set(k, a);
  };
  for (const p of pairs) {
    tag("（全体）", p, false);
    const list = by.get(p.cid.slice(0, 8)) ?? [];
    const T = Date.parse(p.at);
    const before = list.filter((m) => Date.parse(m.created_at) < T - 1000);
    const staffBefore = before.filter((m) => m.sender !== "customer").map((m) => ({ text: m.text ?? "", createdAt: m.created_at, aix: !!m.is_aix_generated }));
    // ① 前に伝えた事の繰り返し: AI の下書きの文が、この会話でこちらが前（14日以内）に送った文とほぼ同じで、人は送らなかった
    const rep = repeatedFromBefore(p.removed ?? [], staffBefore, T);
    const repAll = repeatedFromBefore(p.draft.split(/\n+/), staffBefore, T);
    if (repAll.length) tag("前に伝えた事を下書きが繰り返す", p, rep.length > 0, `人が消した繰り返し: ${rep.slice(0, 2).join(" / ").slice(0, 120)}`);
    // ② 同じ日（JST）にこちらが既に送った通の数
    const sd = sameDayStaffCountBefore(staffBefore, T);
    tag(sd === 0 ? "同じ日: こちらの1通目" : sd <= 2 ? "同じ日: こちらの2〜3通目" : "同じ日: こちらの4通目以降", p, false);
    // ③ 連投の束（お客様の番の通の数・問いの数）
    const nq = (p.customer.match(/[？?]/g) ?? []).length;
    tag(nq >= 2 ? "お客様の問い 2つ以上" : nq === 1 ? "お客様の問い 1つ" : "お客様の問い なし", p, false);
    // ④ お客様の事情（予定・時期・遠方・同行者・他社・体調）— 今回の発言
    for (const c of customerCircumstances(p.customer)) {
      const used = c.staffEcho.test(p.staff);
      const aiUsed = c.staffEcho.test(p.draft);
      tag(`事情: ${c.kind}`, p, used && !aiUsed, `人は触れた・AI は触れない（${c.hit}）人:${p.staff.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    // ④' お客様の事情（前の発言・14日以内）が残っている
    const custBefore = before.filter((m) => m.sender === "customer" && T - Date.parse(m.created_at) <= 14 * 86_400_000).map((m) => m.text ?? "").join("\n");
    for (const c of customerCircumstances(custBefore)) {
      const used = c.staffEcho.test(p.staff); const aiUsed = c.staffEcho.test(p.draft);
      tag(`前の発言の事情: ${c.kind}`, p, used && !aiUsed, `人は触れた・AI は触れない（${c.hit}）人:${p.staff.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    // ⑤ スタッフの直前の行動（電話・内覧・資料）＝お客様の番の前のこちらの行い
    const act = staffActionJustBefore(staffBefore, T, before.filter((m) => m.sender === "customer").map((m) => ({ text: m.text ?? "", createdAt: m.created_at })));
    if (act) {
      const used = act.staffEcho.test(p.staff); const aiUsed = act.staffEcho.test(p.draft);
      tag(`直前の行動: ${act.kind}`, p, used && !aiUsed, `人は触れた・AI は触れない 人:${p.staff.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    // ⑥ 時間帯（JST）
    const h = new Date(T + 9 * 3600_000).getUTCHours();
    const dow = new Date(T + 9 * 3600_000).getUTCDay();
    tag(h >= 21 || h < 9 ? "時間帯: 夜21時〜朝9時" : "時間帯: 9〜21時", p, false);
    tag(dow === 0 || dow === 6 ? "曜日: 土日" : dow === 3 ? "曜日: 水曜（管理会社の休み多い）" : "曜日: 平日", p, false);
  }
  const all = agg.get("（全体）")!;
  console.log(`組 ${pairs.length}（③スタッフだけの報告を除く）・全体 似ている度 ${(all.sim / all.n).toFixed(2)}・中身の差 ${Math.round((all.content / all.n) * 100)}%`);
  for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].related - x[1].related || y[1].n - x[1].n)) {
    if (k === "（全体）") continue;
    console.log(`  ${k.padEnd(28)} n=${String(a.n).padStart(3)} 似 ${(a.sim / a.n).toFixed(2)} 中身の差 ${String(Math.round((a.content / a.n) * 100)).padStart(3)}% 関係する差 ${a.related}`);
  }
  if (SHOW) for (const [k, a] of agg) if (k.includes(SHOW)) { console.log(`\n== ${k}`); for (const e of a.ex) console.log("  " + e); }
}
main().catch((e) => { console.error(e); process.exit(1); });
