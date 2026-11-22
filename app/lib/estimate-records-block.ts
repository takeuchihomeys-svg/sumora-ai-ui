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
export type EstimateRow = { property_name?: string | null; room_no?: string | null; initial_cost_yen?: number | string | null; created_at?: string | null };

export function estimateRecordsBlock(rows: ReadonlyArray<EstimateRow>, max = 6): string {
  const xs = rows.flatMap((r) => {
    const name = String(r.property_name ?? "").trim();
    const cost = typeof r.initial_cost_yen === "number" ? r.initial_cost_yen : Number(String(r.initial_cost_yen ?? "").replace(/[,，円]/g, ""));
    if (!name || !r.created_at) return [];
    return [{ name, room: String(r.room_no ?? "").normalize("NFKC").replace(/号室?$/, "").trim(), cost: Number.isFinite(cost) && cost > 0 ? cost : null, at: r.created_at }];
  }).sort((a, b) => b.at.localeCompare(a.at));
  if (!xs.length) return "";
  const groups = new Map<string, typeof xs>();
  for (const x of xs) { const k = `${x.name}|${x.room}`; groups.set(k, [...(groups.get(k) ?? []), x]); }
  const lines = [...groups.values()].slice(0, max).map((g) => {
    const head = g[0];
    const hist = g.slice(1, 3).map((p) => `${jstMD(p.at)} ${p.cost != null ? `${p.cost.toLocaleString()}円` : "金額なし"}`);
    return `- ${head.name}${head.room ? ` ${head.room}号室` : ""}: ${jstMD(head.at)}送付・初期費用 ${head.cost != null ? `${head.cost.toLocaleString()}円` : "（記録に金額なし）"}${hist.length ? `（前の見積: ${hist.join("・")}）` : ""}`;
  });
  return `\n【送った御見積書（記録・新しい順）】\n${lines.join("\n")}`;
}
