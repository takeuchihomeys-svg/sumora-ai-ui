// scripts/audit-trust-b4b5.ts — 信頼の土台（#55）B4（不利な結果を伏せない）・B5（もう答えた事を聞き直さない）の数え（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員N。決まりは app/lib/trust-b4b5.ts（テスト app/lib/__tests__/trust-b4b5.test.ts）。
//   番: line_watch_turns（見張りの番）。下書き（draft_first）と、こちらの実送信（staff_texts）の両方を数える。
//   実送信の書き手は messages.staff_writer（送信の時刻の前後60秒）で 竹内さん／従業員 に分ける（正解の基準は竹内さん KB 41dadfe6・下書きと比べる）。
//   B4: 番の前24時間のこちらの通（AIX の確認の結果など）に不利な事実（申込あり・募集終了・2番手）がある番で、返信が伏せたか（hid／told／not_about）
//   B5: 番より前30日のお客様の文で答えた条件を、返信の問いがまた聞いたか
// 出すのは数と見張りの番の id だけ（お客様の文・名前は出さない）。DB を読むので 22時〜8時に1本だけ流す（昼は --limit で数件だけ試す）。
// 実行: npx tsx --env-file=.env.local scripts/audit-trust-b4b5.ts [--days=30] [--limit=0] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { unfavorableFactsOf, hideVerdictOf, reaskedKeysOf, type HideVerdict } from "../app/lib/trust-b4b5";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

type Turn = { id: number; conversation_id: string; customer_turn_at: string; draft_first: string | null; staff_texts: Array<{ at?: string; text?: string }> | null };
type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "30")) || 30;
  const limit = Number(arg("limit", "0")) || 0;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns: Turn[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from("line_watch_turns").select("id,conversation_id,customer_turn_at,draft_first,staff_texts")
      .gte("customer_turn_at", since).not("draft_first", "is", null).order("id").range(from, from + 499);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as Turn[]));
    if ((data ?? []).length < 500 || (limit && turns.length >= limit)) break;
  }
  const use = limit ? turns.slice(0, limit) : turns;
  const byConv = new Map<string, Turn[]>();
  for (const t of use) { const a = byConv.get(t.conversation_id) ?? []; a.push(t); byConv.set(t.conversation_id, a); }

  type Who = "draft" | "takeuchi" | "employee" | "unknown";
  const b4: Record<Who, Record<HideVerdict, number>> = { draft: { hid: 0, told: 0, not_about: 0 }, takeuchi: { hid: 0, told: 0, not_about: 0 }, employee: { hid: 0, told: 0, not_about: 0 }, unknown: { hid: 0, told: 0, not_about: 0 } };
  const b4Hid: Record<Who, number[]> = { draft: [], takeuchi: [], employee: [], unknown: [] };
  const b5: Record<Who, { asked: number; reask: number; keys: Record<string, number>; ids: number[] }> = {
    draft: { asked: 0, reask: 0, keys: {}, ids: [] }, takeuchi: { asked: 0, reask: 0, keys: {}, ids: [] }, employee: { asked: 0, reask: 0, keys: {}, ids: [] }, unknown: { asked: 0, reask: 0, keys: {}, ids: [] },
  };
  let b4Turns = 0;
  const qRe = /[?？]|でしょうか|ますか|ですか/;
  for (const [conv, ts] of byConv) {
    const tMin = Math.min(...ts.map((t) => Date.parse(t.customer_turn_at))) - 30 * 86_400_000;
    const tMax = Math.max(...ts.map((t) => Date.parse(t.customer_turn_at))) + 6 * 3_600_000;
    const { data, error } = await sb.from("messages").select("sender,text,created_at,is_aix_generated,staff_writer").eq("conversation_id", conv)
      .gte("created_at", new Date(tMin).toISOString()).lte("created_at", new Date(tMax).toISOString()).order("created_at").limit(3000);
    if (error) throw new Error(error.message);
    const ms = (data ?? []) as Msg[];
    for (const t of ts) {
      const at = Date.parse(t.customer_turn_at);
      const before = ms.filter((m) => Date.parse(m.created_at) <= at);
      const ourPrev = before.filter((m) => m.sender === "staff" && at - Date.parse(m.created_at) <= 24 * 3_600_000).map((m) => String(m.text ?? ""));
      const facts = ourPrev.flatMap(unfavorableFactsOf);
      const custPrior = before.filter((m) => m.sender === "customer").map((m) => String(m.text ?? ""));
      // 実送信の書き手
      const sends = (t.staff_texts ?? []).filter((s) => s.text);
      const writerOf = (s: { at?: string }) => {
        const u = Date.parse(String(s.at ?? ""));
        const w = new Set(ms.filter((m) => m.sender === "staff" && Math.abs(Date.parse(m.created_at) - u) <= 60_000 && m.staff_writer).map((m) => String(m.staff_writer)));
        return (w.size === 1 ? [...w][0] : "unknown") as Who;
      };
      const replies: Array<[Who, string]> = [["draft", String(t.draft_first ?? "")]];
      if (sends.length) { const w = writerOf(sends[0]); replies.push([w === "takeuchi" || w === "employee" ? w : "unknown", sends.map((s) => s.text).join("\n")]); }
      if (facts.length) b4Turns++;
      for (const [who, text] of replies) {
        if (facts.length) { const v = hideVerdictOf(text, facts); b4[who][v]++; if (v === "hid" && b4Hid[who].length < 12) b4Hid[who].push(t.id); }
        if (qRe.test(text)) {
          b5[who].asked++;
          const ks = reaskedKeysOf(text, custPrior);
          if (ks.length) { b5[who].reask++; for (const k of ks) b5[who].keys[k] = (b5[who].keys[k] ?? 0) + 1; if (b5[who].ids.length < 12) b5[who].ids.push(t.id); }
        }
      }
    }
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  console.log(`信頼の土台 B4・B5（${days}日・見張りの番 ${use.length}・会話 ${byConv.size}）`);
  console.log(`B4 不利な結果（申込あり・募集終了・2番手）が番の前24時間にある番: ${b4Turns}`);
  for (const w of ["takeuchi", "employee", "draft", "unknown"] as const) {
    const r = b4[w]; const n = r.hid + r.told + r.not_about;
    if (n) console.log(`- ${w}: ${n}番｜触れた ${r.told}（${pct(r.told, n)}）・伏せて誘った ${r.hid}（${pct(r.hid, n)}）・そのお部屋に触れない ${r.not_about}｜伏せた例 ${b4Hid[w].join(",")}`);
  }
  console.log("B5 もう答えた条件を問いでまた聞いた（問いのある返信のうち）");
  for (const w of ["takeuchi", "employee", "draft", "unknown"] as const) {
    const r = b5[w];
    if (r.asked) console.log(`- ${w}: 問いのある返信 ${r.asked}｜聞き直し ${r.reask}（${pct(r.reask, r.asked)}）・鍵 ${JSON.stringify(r.keys)}｜例 ${r.ids.join(",")}`);
  }
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify({ days, turns: use.length, b4Turns, b4, b4Hid, b5 }, null, 1));
}

if (process.argv[1]?.endsWith("audit-trust-b4b5.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
