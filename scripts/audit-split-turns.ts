// scripts/audit-split-turns.ts — 同じ場面で竹内さんの一手が割れる番を、時間・状況の欄で並べて、返信と AIX の分かれ目を探す（台帳 #744・読むだけ・LLM なし・夜の読み）
// 2026-11-25 作業員A（竹内さん 11/25 夜「なんで返信にしていて、なんでAIXで回答しているか時間、状況等ちゃんと見たらより理由が分かるはず、ここ細かく調査して必要なら土台作るか連携させる」）
//   対象: audit-aix-turn-judgment の json の竹内さん本人の番のうち、形「前24時間にお客様が物件を送ってきた」（割れ: 返信が先 23／物件確認した 18・n49）
//   欄: お客様の通の時刻（曜日・時間帯・営業時間 9〜22時の内外・電話の19時まで）・通から竹内さんの最初の一手までの分・送ってきた物件の数と種類（URL／画像・同じ建物か）
//       ・その物件の確認の結果が手元にあったか（3日以内の確認・タスクの結果）・開いている約束・直前のこちらの一手・お客様の聞き方（募集状況を聞いた／送っただけ）
//       ・その時間帯の込み具合（前後30分にスタッフが全会話で送った通の数）・書き手（竹内さん本人だけ）
//   欄ごとに、返信が先／AIX が先の数（n＜5 の升は「言えない」）。本文・名前は出さない（会話の頭8字・数だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-split-turns.ts --json=<audit-aix-turn-judgment の json> [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { BROUGHT_SHAPE_RE } from "../app/lib/metric-map";
import { detectAvailabilityCheckContext, AVAILABILITY_URL_RE } from "../app/lib/aix-scene-evidence";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { id: number; conv: string; cls: string; tk: string | null; prevPromise?: string[]; burst?: string; mat?: { checked?: number; taskResult?: number; openTasks?: number } | null };
type Msg = { sender: string; text: string | null; created_at: string; image_url: string | null; is_aix_generated: boolean | null };
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
const jst = (ms: number) => new Date(ms + 9 * 3_600_000);
const WD = ["日", "月", "火", "水", "木", "金", "土"];

(async () => {
  const rows = JSON.parse(readFileSync(arg("json"), "utf8")) as Row[];
  const { data: wt } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at").in("id", rows.map((r) => r.id));
  const W = new Map(((wt ?? []) as Array<{ id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null }>).map((w) => [w.id, w]));
  const out: Array<Record<string, string | number | boolean | null> & { move: string; id: number; conv: string }> = [];
  for (const r of rows) {
    const w = W.get(r.id); if (!w) continue;
    const first = Date.parse(w.customer_turn_at), last = Date.parse(w.customer_last_at ?? w.customer_turn_at);
    const { data } = await sb.from("messages").select("sender, text, created_at, image_url, is_aix_generated").eq("conversation_id", w.conversation_id)
      .gte("created_at", new Date(first - 86_400_000).toISOString()).lte("created_at", new Date(last + 24 * 3_600_000).toISOString()).order("created_at").limit(800);
    const ms = (data ?? []) as Msg[];
    const isProp = (m: Msg) => m.sender === "customer" && (BROUGHT_SHAPE_RE.test(String(m.text ?? "")) || !!m.image_url);
    const brought = ms.filter((m) => isProp(m) && Date.parse(m.created_at) <= last + 1000 && last - Date.parse(m.created_at) <= 86_400_000);
    if (!brought.length) continue;
    const burst = ms.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= first && Date.parse(m.created_at) <= last + 1000);
    const burstTxt = burst.map((m) => m.text ?? "").join("\n");
    const firstMove = ms.find((m) => m.sender !== "customer" && Date.parse(m.created_at) > last);
    const prevStaff = [...ms].reverse().find((m) => m.sender !== "customer" && Date.parse(m.created_at) < first);
    const t = jst(last);
    const h = t.getUTCHours();
    const lagMin = firstMove ? Math.round((Date.parse(firstMove.created_at) - last) / 60000) : null;
    // 込み具合: 前後30分に全会話でスタッフが送った通の数
    const { count } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("sender", "staff")
      .gte("created_at", new Date(last - 30 * 60_000).toISOString()).lte("created_at", new Date(last + 30 * 60_000).toISOString());
    const urls = brought.filter((m) => AVAILABILITY_URL_RE.test(String(m.text ?? ""))).length;
    const move = r.cls === "reply" || r.cls === "two_stage" ? "返信が先" : `AIX が先`;
    out.push({
      id: r.id, conv: r.conv, move, kind: move === "AIX が先" ? String(r.tk ?? "?") : "返信",
      曜日: WD[t.getUTCDay()], 時間帯: h < 9 ? "朝（〜9時）" : h < 13 ? "午前（9〜13時）" : h < 19 ? "午後（13〜19時）" : h < 22 ? "夜（19〜22時・電話の後）" : "深夜（22時〜）",
      営業時間: h >= 9 && h < 22 ? "内" : "外",
      一手までの分: lagMin == null ? "一手なし" : lagMin < 5 ? "5分未満" : lagMin < 30 ? "5〜30分" : lagMin < 120 ? "30分〜2時間" : "2時間以上",
      送ってきた物件: brought.length >= 3 ? "3件以上" : `${brought.length}件`, 物件の種類: urls === brought.length ? "URL だけ" : urls ? "URL と画像" : "画像だけ",
      今の通に物件: burst.some(isProp) ? "今の通" : "前の通",
      確認の結果が手元に: (r.mat?.checked ?? 0) > 0 || (r.mat?.taskResult ?? 0) > 0 ? "あり" : "なし",
      開いている約束: (r.prevPromise ?? []).length ? (r.prevPromise ?? []).join("+") : "なし",
      直前のこちらの一手: !prevStaff ? "なし（初回）" : prevStaff.is_aix_generated ? "AIX" : /確認させて頂きます|確認出来次第|確認でき次第/.test(String(prevStaff.text ?? "")) ? "確認の約束の文" : "ほかの文",
      聞き方: detectAvailabilityCheckContext(burstTxt) ? "募集状況を聞いた" : burst.some(isProp) ? "送っただけ" : String(r.burst ?? "other"),
      込み具合: (count ?? 0) >= 20 ? "20通以上" : (count ?? 0) >= 8 ? "8〜19通" : "7通以下",
    });
  }
  const fields = ["時間帯", "曜日", "営業時間", "一手までの分", "送ってきた物件", "物件の種類", "今の通に物件", "確認の結果が手元に", "開いている約束", "直前のこちらの一手", "聞き方", "込み具合"];
  const nR = out.filter((o) => o.move === "返信が先").length, nA = out.length - nR;
  console.log(`■ 前24時間にお客様が物件を送ってきた竹内さん本人の番 ${out.length}（返信が先 ${nR}・AIX が先 ${nA}）\n`);
  const summary: Array<{ field: string; gap: number; rows: Array<{ v: string; reply: number; aix: number; say: boolean }> }> = [];
  for (const f of fields) {
    const vs = [...new Set(out.map((o) => String(o[f])))].sort();
    const rs = vs.map((v) => { const xs = out.filter((o) => String(o[f]) === v); const a = xs.filter((o) => o.move === "AIX が先").length; return { v, reply: xs.length - a, aix: a, say: xs.length >= 5 }; });
    // 分かれ目の強さ: 言える升（n≥5）の AIX の割合の最大と最小の差
    const said = rs.filter((x) => x.say).map((x) => x.aix / (x.reply + x.aix));
    const gap = said.length >= 2 ? Math.round((Math.max(...said) - Math.min(...said)) * 100) : 0;
    summary.push({ field: f, gap, rows: rs });
    console.log(`${f}（言える升の AIX の割合の差 ${gap}ポイント）: ${rs.map((x) => `${x.v} 返信 ${x.reply}・AIX ${x.aix}${x.say ? "" : "（言えない）"}`).join("／")}`);
  }
  console.log(`\n分かれ目の強い順: ${[...summary].sort((a, b) => b.gap - a.gap).slice(0, 5).map((s) => `${s.field} ${s.gap}`).join("・")}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ rows: out, summary }, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
