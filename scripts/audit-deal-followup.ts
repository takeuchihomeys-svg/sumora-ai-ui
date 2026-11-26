// scripts/audit-deal-followup.ts — 成約データから ①追客（返事が途切れた後のこちらの一手）②見積→申込（見積の後の一手とお客様の発言の型）を、申込に届いた件と届かなかった件で比べる
// 2026-11-26 作業員L（竹内さん 11/26「地図・中長期の考え方で1つずつ土台の強化と細分化」・統括役の割り振り）。決定論・LLM なし・DeepSeek に渡さない・読むだけ。
//   読む物: deal_outcomes（段の時刻）・見積の時刻（aix_usage_logs の estimate_sheet・estimate_records）・申込より前の通（messages）と AIX の記録（aix_usage_logs）。
//   申込以降・審査の中身は読まない（申込の時刻で切る・届かなかった件は案件の終わりか今まで）。出すのは数だけ（文は出さない）。広い読み＝22時以降
//   ① 追客: 物件送り（提案中）か見積の後に、こちらの通の後でお客様の返事が N日（既定 3日）以上無かった所＝途切れ。その後のこちらの最初の一手
//      （何日後・返信か AIX か・AIX の種類・話題＝新着／費用／内覧の誘い／その他）と、その後にお客様が戻ったか・申込に届いたか
//   ② 見積→申込: 見積の時刻から申込まで（届かなかった件は見積から30日）のこちらの一手（返信／AIX の種類）とお客様の発言の型（費用の質問・比較・家族と相談・内覧・申込の意思 等）
//   行の形（作業員A の「次の石」の表 app/lib/route-next-stone に重ねる・A と決め 11/26）: { station, situation, stone: { to, reply, aix }, reached, n, takeuchi }
// 実行: npx tsx --env-file=.env.local scripts/audit-deal-followup.ts [--gap-days=3] [--out=<json>] [--limit=600]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAY = 864e5;

/** こちらの通の話題（決まった語だけ） */
export function staffTopicOf(text: string | null | undefined): "新着" | "費用" | "内覧の誘い" | "確認の結果" | "その他" {
  const t = String(text ?? "").normalize("NFKC");
  if (/新着|新しく(?:出|募集)|出てきました|ピックアップ/.test(t)) return "新着";
  if (/初期費用|見積|割引|費用|お値下|減額/.test(t)) return "費用";
  if (/内覧|ご案内|見に行|ご都合の良い日/.test(t)) return "内覧の誘い";
  if (/確認(?:させて頂き|致し|いたし|し)ましたところ|との(?:事|こと)|募集(?:中|終了)/.test(t)) return "確認の結果";
  return "その他";
}
/** お客様の発言の型（見積の後） */
export function custTypeAfterEstimate(text: string | null | undefined): string[] {
  const t = String(text ?? "").normalize("NFKC");
  const k: string[] = [];
  if (/初期費用|費用|いくら|総額|安く|値下|割引|敷金|礼金|仲介/.test(t)) k.push("費用の質問");
  if (/比較|他の(?:物件|お部屋)|迷って|どちらが|検討/.test(t)) k.push("比較・検討");
  if (/家族|主人|夫|妻|旦那|嫁|親|相談/.test(t)) k.push("家族と相談");
  if (/内覧|内見|見学|見に行/.test(t)) k.push("内覧");
  if (/申込|申し込|契約したい|ここに(?:します|決め)/.test(t)) k.push("申込の意思");
  if (/[?？]|ですか|ますか/.test(t) && !k.length) k.push("ほかの質問");
  if (!k.length) k.push(/ありがとう|承知|了解|わかりました|お願いします/.test(t) ? "あいづち" : "その他");
  return k;
}
/** 作業員A の次の石の表（app/lib/route-next-stone の STONE_TOOLS）と同じ語に: 返信の締めの型（ACT_TARGET の reply: の後ろ）・AIX は親の種類。to は A の NEXT_STONE で駅から埋める（ここでは空） */
export const TOPIC_REPLY: Readonly<Record<string, string>> = { "新着": "propose", "費用": "answer_cost", "内覧の誘い": "invite_viewing", "確認の結果": "answer", "その他": "other" };
export function stoneOf(move: string): { to: string[]; reply: string[]; aix: string[] } {
  if (move.startsWith("AIX:")) return { to: [], reply: [], aix: [move.slice(4).split("/")[0]] };
  if (move.startsWith("返信・")) return { to: [], reply: [TOPIC_REPLY[move.slice(3)] ?? "other"], aix: [] };
  return { to: [], reply: [], aix: [] };
}
export type Row = { station: string; situation: string; stone: { to: string[]; reply: string[]; aix: string[] }; move: string; reached: number; n: number; takeuchi: number };
/** 束ねて表の行にする（純関数） */
export function rowsOf(items: ReadonlyArray<{ station: string; situation: string; stone: string; reached: boolean; takeuchi: boolean }>): Row[] {
  const m = new Map<string, Row>();
  for (const x of items) {
    const k = `${x.station}|${x.situation}|${x.stone}`;
    const r = m.get(k) ?? { station: x.station, situation: x.situation, stone: stoneOf(x.stone), move: x.stone, reached: 0, n: 0, takeuchi: 0 };
    r.n++; if (x.reached) r.reached++; if (x.takeuchi) r.takeuchi++;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
const daysBucket = (d: number) => (d < 3 ? "3日未満" : d < 7 ? "3〜6日" : d < 14 ? "7〜13日" : "14日以上");

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const gapDays = Number(arg("gap-days", "3"));
  const { data, error } = await sb.from("deal_outcomes").select("id, conversation_id, first_contact_at, property_sent_at, applied_at, ended_at, result").not("property_sent_at", "is", null).limit(Number(arg("limit", "600")));
  if (error) throw new Error(error.message);
  const deals = ((data ?? []) as Array<{ id: number; conversation_id: string; first_contact_at: string | null; property_sent_at: string; applied_at: string | null; ended_at: string | null; result: string }>).filter((d) => !isTestConversation(d.conversation_id));
  const follow: Array<{ station: string; situation: string; stone: string; reached: boolean; takeuchi: boolean; cameBack: boolean }> = [];
  const est: Array<{ station: string; situation: string; stone: string; reached: boolean; takeuchi: boolean }> = [];
  for (const d of deals) {
    const start = Date.parse(d.property_sent_at);
    const end = d.applied_at ? Date.parse(d.applied_at) : d.ended_at ? Date.parse(d.ended_at) : Date.now();
    if (!(end > start)) continue;
    const [{ data: m }, { data: a }, { data: e }] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", d.conversation_id).gte("created_at", new Date(start - 60e3).toISOString()).lt("created_at", new Date(end).toISOString()).order("created_at").limit(800),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", d.conversation_id).gte("created_at", new Date(start - 60e3).toISOString()).lt("created_at", new Date(end).toISOString()).limit(400),
      sb.from("aix_usage_logs").select("created_at").eq("conversation_id", d.conversation_id).eq("aix_type", "estimate_sheet").gte("created_at", new Date(start - 60e3).toISOString()).lt("created_at", new Date(end).toISOString()).order("created_at").limit(1),
    ]);
    const msgs = (m ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null }>;
    const aix = ((a ?? []) as Array<{ aix_type: string; sent_at: string | null; created_at: string }>).map((x) => ({ t: Date.parse(x.sent_at ?? x.created_at), type: x.aix_type }));
    const moveOf = (x: { created_at: string; is_aix_generated: boolean | null; text: string | null }) => {
      if (!x.is_aix_generated) return `返信・${staffTopicOf(x.text)}`;
      const t = Date.parse(x.created_at);
      const hit = aix.filter((y) => Math.abs(y.t - t) <= 180_000).sort((p, q) => Math.abs(p.t - t) - Math.abs(q.t - t))[0];
      return `AIX:${hit?.type ?? "不明"}`;
    };
    const estAt = (e ?? [])[0] ? Date.parse((e as Array<{ created_at: string }>)[0].created_at) : NaN;
    // ① 途切れ: こちらの通の後、次のお客様の通まで gapDays 以上
    for (let i = 0; i < msgs.length; i++) {
      const x = msgs[i];
      if (x.sender !== "staff") continue;
      const nextCust = msgs.slice(i + 1).find((y) => y.sender === "customer");
      const lastOurs = Date.parse(x.created_at);
      const gapEnd = nextCust ? Date.parse(nextCust.created_at) : end;
      if ((gapEnd - lastOurs) / DAY < gapDays) continue;
      // 途切れの中のこちらの最初の追い（同じ日のまとめ送りは除く＝こちらの通から 12時間以上あと）
      const fu = msgs.slice(i + 1).find((y) => y.sender === "staff" && Date.parse(y.created_at) - lastOurs >= 12 * 36e5 && Date.parse(y.created_at) < gapEnd);
      const station = Number.isFinite(estAt) && estAt <= lastOurs ? "estimate" : "proposing";
      if (!fu) { follow.push({ station, situation: `返事が途切れた（${gapDays}日以上）`, stone: "追いなし", reached: !!d.applied_at, takeuchi: false, cameBack: !!nextCust }); }
      else {
        const dd = (Date.parse(fu.created_at) - lastOurs) / DAY;
        follow.push({ station, situation: `返事が途切れた（${gapDays}日以上）・追いは ${daysBucket(dd)}`, stone: moveOf(fu), reached: !!d.applied_at, takeuchi: fu.staff_writer === "takeuchi", cameBack: !!nextCust });
      }
      // 1つの途切れにつき1つ（次の途切れはお客様の通の後から）
      const j = nextCust ? msgs.indexOf(nextCust) : msgs.length;
      i = j;
    }
    // ② 見積→申込（届かなかった件は見積から30日）
    if (Number.isFinite(estAt)) {
      const lim = d.applied_at ? end : Math.min(end, estAt + 30 * DAY);
      const win = msgs.filter((x) => Date.parse(x.created_at) > estAt && Date.parse(x.created_at) < lim);
      const custKinds = [...new Set(win.filter((x) => x.sender === "customer").flatMap((x) => custTypeAfterEstimate(x.text)))];
      const firstOurs = win.find((x) => x.sender === "staff");
      for (const k of custKinds.length ? custKinds : ["返事なし"]) est.push({ station: "estimate", situation: `見積の後のお客様: ${k}`, stone: firstOurs ? moveOf(firstOurs) : "一手なし", reached: !!d.applied_at, takeuchi: firstOurs?.staff_writer === "takeuchi" });
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  const fr = rowsOf(follow), er = rowsOf(est);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  console.log(`# ①追客（物件送りか見積の後に返事が途切れた所・${gapDays}日以上・${follow.length}か所・戻った ${follow.filter((x) => x.cameBack).length}）\n`);
  console.log("| 駅 | 場面 | 次の石（こちらの一手） | 件 | 申込に届いた | 竹内さん本人 |\n|---|---|---|---|---|---|");
  for (const r of fr.slice(0, 25)) console.log(`| ${r.station} | ${r.situation} | ${r.move} | ${r.n} | ${r.reached}（${pct(r.reached, r.n)}） | ${r.takeuchi} |`);
  console.log(`\n# ②見積→申込（見積のあった案件 ${new Set(est.map((x) => x)).size ? "" : ""}・型ごと）\n`);
  console.log("| 駅 | 場面 | 次の石（見積の後のこちらの最初の一手） | 件 | 申込に届いた | 竹内さん本人 |\n|---|---|---|---|---|---|");
  for (const r of er.slice(0, 25)) console.log(`| ${r.station} | ${r.situation} | ${r.move} | ${r.n} | ${r.reached}（${pct(r.reached, r.n)}） | ${r.takeuchi} |`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ at: new Date().toISOString(), gapDays, followup: fr, estimate: er }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
