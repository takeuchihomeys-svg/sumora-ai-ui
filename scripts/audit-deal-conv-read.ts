// scripts/audit-deal-conv-read.ts — 台帳 #728 ②: 申込に届いた会話を1件ずつ、申込までの流れで読む（決定論・LLM なし・DeepSeek に渡さない・読むだけ）
// 2026-11-25 作業員L（統括役の頼み・竹内さん 11/25「成約データは過去の申込まで行ったの全部見れば強化できる」）
//   読む物: 申込より前の通（messages）と AIX の記録（aix_usage_logs）だけ。申込以降・審査の中身は読まない（申込の時刻で切る）。
//   1件ごとに: 段の型（deal-flow の path）・お客様の発言の型の数・スタッフの一手（返信か AIX か・どの AIX か）・申込の直前の3手。
//   まとめ: 申込の直前の3手の型・最後の一手・型（path）ごとの一手の多さ。出すのは数と会話の頭8字だけ（文は出さない）。22時以降に回す（会話ごとの軽い読み・間を空ける）
// 実行: npx tsx --env-file=.env.local scripts/audit-deal-conv-read.ts [--out=<json>] [--limit=300]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { dealFlowOf, conditionKindsOf, FLOW_STAGES, type DealRow } from "./lib/deal-flow";
import { isTestConversation } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

/** お客様の発言の型（決まった語だけ・1通に複数あり） */
export function customerTypesOf(text: string | null | undefined): string[] {
  const t = String(text ?? "").normalize("NFKC");
  const k: string[] = [];
  if (conditionKindsOf(t).length >= 2) k.push("条件");
  if (/suumo|homes\.co\.jp|athome|chintai|https?:\/\//i.test(t)) k.push("物件の持ち込み");
  if (/内覧|内見|見学|見に行/.test(t)) k.push("内覧");
  if (/初期費用|見積|費用|いくら|総額/.test(t)) k.push("費用");
  if (/申込|申し込|申込み|契約したい|ここに(します|決め)/.test(t)) k.push("申込の意思");
  if (/空いて|空室|募集|まだあります/.test(t)) k.push("空き");
  if (/[?？]|ですか|ますか/.test(t)) k.push("質問");
  if (!k.length) k.push(/ありがとう|お願いします|承知|了解|わかりました/.test(t) ? "あいづち" : "その他");
  return k;
}

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const cols = ["id", "conversation_id", ...FLOW_STAGES.map((s) => s.key).filter((k) => k !== "estimate_at")].join(", ");
  const { data, error } = await sb.from("deal_outcomes").select(cols).not("applied_at", "is", null).limit(2000);
  if (error) throw new Error(error.message);
  const deals = ((data ?? []) as unknown as DealRow[]).filter((d) => !isTestConversation(d.conversation_id)).slice(0, Number(arg("limit", "300")));
  const out: Array<{ conv8: string; path: string; custTypes: Record<string, number>; moves: number; aixMoves: Record<string, number>; last3: string[]; lastCust: string[] }> = [];
  for (const d of deals) {
    const end = d.applied_at as string;
    const start = d.first_contact_at ? new Date(Date.parse(d.first_contact_at) - 60e3).toISOString() : "1970-01-01T00:00:00Z";
    const [{ data: m }, { data: a }] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", d.conversation_id).gte("created_at", start).lt("created_at", end).order("created_at").limit(600),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", d.conversation_id).gte("created_at", start).lt("created_at", end).limit(300),
    ]);
    const msgs = (m ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>;
    const aix = ((a ?? []) as Array<{ aix_type: string; sent_at: string | null; created_at: string }>).map((x) => ({ type: x.aix_type, t: Date.parse(x.sent_at ?? x.created_at) }));
    const custTypes: Record<string, number> = {};
    const moves: string[] = [];
    let lastCust: string[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const x = msgs[i];
      if (x.sender === "customer") { const ts = customerTypesOf(x.text); for (const k of ts) custTypes[k] = (custTypes[k] ?? 0) + 1; lastCust = ts; continue; }
      if (x.sender !== "staff") continue;
      // 続けて送った通（2分以内）は1手にまとめる
      if (i > 0 && msgs[i - 1].sender === "staff" && Date.parse(x.created_at) - Date.parse(msgs[i - 1].created_at) <= 120_000) continue;
      if (x.is_aix_generated) {
        const t = Date.parse(x.created_at);
        const hit = aix.filter((y) => Math.abs(y.t - t) <= 180_000).sort((p, q) => Math.abs(p.t - t) - Math.abs(q.t - t))[0];
        moves.push(`AIX:${hit?.type ?? "不明"}`);
      } else moves.push("返信");
    }
    const aixMoves: Record<string, number> = {};
    for (const mv of moves) if (mv.startsWith("AIX:")) aixMoves[mv] = (aixMoves[mv] ?? 0) + 1;
    const f = dealFlowOf(d);
    out.push({ conv8: d.conversation_id.slice(0, 8), path: f.path.filter((p) => p !== "成約").join("→"), custTypes, moves: moves.length, aixMoves, last3: moves.slice(-3), lastCust });
    await new Promise((r) => setTimeout(r, 200)); // 試験の係と DB が重ならないように
  }
  const tally = (xs: string[]) => { const mm = new Map<string, number>(); for (const x of xs) mm.set(x, (mm.get(x) ?? 0) + 1); return [...mm].sort((p, q) => q[1] - p[1]); };
  console.log(`# 申込に届いた会話の流れ（${out.length}件・申込より前の通だけ・決定論）\n`);
  console.log("## 申込の直前の3手（多い順・上位12）");
  for (const [k, n] of tally(out.map((o) => o.last3.join(" → ") || "（手なし）")).slice(0, 12)) console.log(`- ${k}: ${n}`);
  console.log("\n## 申込の直前の一手");
  for (const [k, n] of tally(out.map((o) => o.last3[o.last3.length - 1] ?? "（手なし）")).slice(0, 10)) console.log(`- ${k}: ${n}`);
  console.log("\n## 申込の直前のお客様の発言の型");
  for (const [k, n] of tally(out.flatMap((o) => o.lastCust)).slice(0, 10)) console.log(`- ${k}: ${n}`);
  console.log("\n## お客様の発言の型（申込までの全部・件数＝その型が1回でもあった会話）");
  for (const [k, n] of tally(out.flatMap((o) => Object.keys(o.custTypes)))) console.log(`- ${k}: ${n}件`);
  console.log("\n## 段の型ごとの一手（会話の数・手の中央・AIX の多い種類）");
  const byPath = new Map<string, typeof out>();
  for (const o of out) byPath.set(o.path || "（段なし）", [...(byPath.get(o.path || "（段なし）") ?? []), o]);
  for (const [p, xs] of [...byPath].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    const med = [...xs.map((x) => x.moves)].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const ax = tally(xs.flatMap((x) => Object.entries(x.aixMoves).flatMap(([k, n]) => Array(n).fill(k)))).slice(0, 3).map(([k, n]) => `${k} ${n}`).join("・");
    console.log(`- ${p}: ${xs.length}件・手 ${med}・${ax || "AIX なし"}`);
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ at: new Date().toISOString(), n: out.length, rows: out }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
