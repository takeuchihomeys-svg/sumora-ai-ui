// app/lib/estimate-records-block.ts — 送った御見積書の記録（estimate_records）をブレインの材料に（純関数・DB/LLM なし・既定 off）
//
// 2026-11-18 作業員L（統括役の毎朝の穴の割り当て 2「前回の見積の金額・割引後の見積の金額」・72時間の「分からない事」から）。
//   今の材料【御見積書 送付済み】は aix_usage_logs.estimate_sent=true の行だけで出る。30日: AIX【見積書送る】（estimate_sheet）37回は estimate_sent が1回も立たず
//   （同封の印は物件確認した の行だけ 88/138）、費用の注記（prop_cost_notes）も 0＝見積書そのものを送った番で「送った・いくら」が材料に無い。
//   estimate_records の金額は、送った物件の行に名前と号室が合った時だけ（ref-resolve の時・新しい1件だけ）付く＝持ち込みの物件・出し直した見積の前の金額は届かない。
// ここで作る: 【送った御見積書（記録・新しい順）】物件・号室・初期費用・送った日。同じ物件の出し直しは前の金額も並べる（割引の前と後）。
// スイッチ BRAIN_ESTIMATE_RECORDS=on（既定 off）。事実だけ（道の言葉は書かない）。
import { jstMD } from "./jst-date";

type Env = Record<string, string | undefined>;
export const estimateRecordsBlockOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_ESTIMATE_RECORDS ?? "").trim().toLowerCase() !== "off"; // 2026-11-21 作業員G: 既定 on（①の組 grp-brain-1121 で確かな悪化0・q159 を守りに入れて）。止める =off
export type EstimateRow = { property_name?: string | null; room_no?: string | null; initial_cost_yen?: number | string | null; created_at?: string | null; discount_yen?: number | string | null };
/**
 * 2026-11-26 作業員L（竹内さん「他にもAIXツールのブレインと連携ちゃんとさせて質上げる部分はないのか」・統括役の頼み）: 見積書ツールの中身のうち、
 *   割引の額（30日の記録 153行のうち 108行にある）がブレインの材料に届いていなかった（書き手には COMPOSE_ASKS_FACTS で届く）。
 *   BRAIN_ESTIMATE_DISCOUNT=on（既定 off）で1行ごとに「割引 N円」を足す。BRAIN_ESTIMATE_REACTION=on（既定 off）で、新しい見積の後のお客様の通の型（費用の質問・比較・家族と相談 等）を1行
 */
export const estimateDiscountOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_ESTIMATE_DISCOUNT ?? "").trim().toLowerCase() === "on";
export const estimateReactionOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_ESTIMATE_REACTION ?? "").trim().toLowerCase() === "on";
/** 見積の後のお客様の通の型（決まった語だけ・scripts/audit-deal-followup と同じ） */
export function reactionKindsOf(text: string | null | undefined): string[] {
  const t = String(text ?? "").normalize("NFKC");
  const k: string[] = [];
  if (/初期費用|費用|いくら|総額|安く|値下|割引|敷金|礼金|仲介/.test(t)) k.push("費用の質問");
  if (/比較|他の(?:物件|お部屋)|迷って|どちらが|検討/.test(t)) k.push("比較・検討");
  if (/家族|主人|夫|妻|旦那|嫁|親|相談/.test(t)) k.push("家族と相談");
  if (/内覧|内見|見学|見に行/.test(t)) k.push("内覧");
  if (/申込|申し込|契約したい|ここに(?:します|決め)/.test(t)) k.push("申込の意思");
  return k;
}
/** 新しい見積の後のお客様の反応の1行（通が無ければ「まだ返事なし」・型が無ければ空） */
export function estimateReactionLine(latestAt: string | null | undefined, msgs: ReadonlyArray<{ sender: string; text: string | null; created_at: string }>, nowMs = Date.now()): string {
  if (!latestAt) return "";
  const t0 = Date.parse(latestAt);
  const after = msgs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t0);
  const days = Math.floor((nowMs - t0) / 864e5);
  if (!after.length) return `【見積の後のお客様】${jstMD(latestAt)}の見積の後、まだ返事なし（${days}日）`;
  const kinds = [...new Set(after.flatMap((m) => reactionKindsOf(m.text)))];
  return kinds.length ? `【見積の後のお客様】${jstMD(latestAt)}の見積の後: ${kinds.join("・")}（${after.length}通）` : "";
}

export function estimateRecordsBlock(rows: ReadonlyArray<EstimateRow>, max = 6, env?: Env): string {
  const withDisc = estimateDiscountOn(env);
  const xs = rows.flatMap((r) => {
    const name = String(r.property_name ?? "").trim();
    const cost = typeof r.initial_cost_yen === "number" ? r.initial_cost_yen : Number(String(r.initial_cost_yen ?? "").replace(/[,，円]/g, ""));
    if (!name || !r.created_at) return [];
    const disc = Number(String(r.discount_yen ?? "").replace(/[,，円]/g, ""));
    return [{ name, room: String(r.room_no ?? "").normalize("NFKC").replace(/号室?$/, "").trim(), cost: Number.isFinite(cost) && cost > 0 ? cost : null, at: r.created_at, disc: Number.isFinite(disc) && disc > 0 ? disc : null }];
  }).sort((a, b) => b.at.localeCompare(a.at));
  if (!xs.length) return "";
  const groups = new Map<string, typeof xs>();
  for (const x of xs) { const k = `${x.name}|${x.room}`; groups.set(k, [...(groups.get(k) ?? []), x]); }
  const lines = [...groups.values()].slice(0, max).map((g) => {
    const head = g[0];
    const hist = g.slice(1, 3).map((p) => `${jstMD(p.at)} ${p.cost != null ? `${p.cost.toLocaleString()}円` : "金額なし"}`);
    return `- ${head.name}${head.room ? ` ${head.room}号室` : ""}: ${jstMD(head.at)}送付・初期費用 ${head.cost != null ? `${head.cost.toLocaleString()}円` : "（記録に金額なし）"}${withDisc && head.disc != null ? `・割引 ${head.disc.toLocaleString()}円` : ""}${hist.length ? `（前の見積: ${hist.join("・")}）` : ""}`;
  });
  return `\n【送った御見積書（記録・新しい順）】\n${lines.join("\n")}`;
}

/**
 * 2026-11-26 作業員L（連携の一覧の3位「見積書ツール → 統括の入口」つないでいない・値打ち 21.7%・統括役の頼み）: 入口の統括の材料に見積の1行（純関数）。
 *   一番新しい見積の 送った日・物件・初期費用（合計）・割引（BRAIN_ESTIMATE_DISCOUNT と同じ discount_yen）と、見積の後のお客様の反応の型か「まだ返事なし（N日）」
 *   （BRAIN_ESTIMATE_REACTION と同じ estimateReactionLine の数え）。スイッチ CONDUCTOR_INTAKE_ESTIMATE=on（既定 off）。見積が無ければ空
 */
export const conductorIntakeEstimateOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_INTAKE_ESTIMATE ?? "").trim().toLowerCase() === "on";
export function intakeEstimateLine(rows: ReadonlyArray<EstimateRow>, msgs: ReadonlyArray<{ sender: string; text: string | null; created_at: string }>, nowMs = Date.now()): string {
  const num = (v: unknown) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[,，円]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  const xs = rows.filter((r) => r.created_at).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const h = xs[0]; if (!h?.created_at) return "";
  const name = String(h.property_name ?? "").trim();
  const room = String(h.room_no ?? "").normalize("NFKC").replace(/号室?$/, "").trim();
  const cost = num(h.initial_cost_yen), disc = num(h.discount_yen);
  const react = estimateReactionLine(h.created_at, msgs, nowMs).replace(/^【見積の後のお客様】/, "");
  return `【見積】${jstMD(h.created_at)}送付${name ? `・${name}${room ? ` ${room}号室` : ""}` : ""}・初期費用 ${cost != null ? `${cost.toLocaleString()}円` : "（記録に金額なし）"}${disc != null ? `・割引 ${disc.toLocaleString()}円` : ""}${xs.length > 1 ? `（見積 ${xs.length}件）` : ""}${react ? `・${react}` : ""}`;
}
