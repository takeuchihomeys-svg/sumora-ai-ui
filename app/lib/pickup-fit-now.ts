// app/lib/pickup-fit-now.ts — 送れる候補が今の条件にも合うか（事実の1行・#821・純関数・LLM/DB なし・2026-11-27 作業員A）
//
// #821 の読みの2位の組（条件提示・質問 × 物件オススメ・ピックアップ × 材料が届いていない・13番）: 条件の言い足し（カウンターキッチン・ペット可 等）の番に、
//   送れる物件が手元にあったのに、ブレインは「新着が出次第の約束」にしていた。送れる候補（売上サポの新しい候補）が、今の条件と言い足しに合うかが見えていない。
// 条件は #820 の探す条件の1枚と同じ（pickup-search-spec.effectiveConditions＝登録の行・今回だけの上書きが無い時は登録の行のまま）。照らしは決まった計算だけ:
//   家賃（候補の要約の家賃 ≤ 上限）・間取り（候補の間取りが希望の間取りに入るか）・徒歩（≤ 希望の分）・今の通の言い足しの設備の語が候補の要約に書いてあるか（書いていない＝分からない）
// スイッチ PICKUP_FIT_NOW_LINE（既定 off・段階で読む）・印 material_marks.pickup_fit_now（字数）。送るかはブレインが決める（P0 9eb6aa9c）
import { stagedOn, STAGE_OFF } from "./switch-stage";
import { effectiveConditions, type SpecRow } from "./pickup-search-spec";

type Env = Record<string, string | undefined>;
export const pickupFitNowOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("PICKUP_FIT_NOW_LINE", env, STAGE_OFF);

/** 今の通の言い足しの設備の語（候補の要約で照らす） */
export const WANT_TERMS = ["カウンターキッチン", "独立洗面", "バストイレ別", "オートロック", "宅配ボックス", "ペット", "駐車場", "角部屋", "南向き", "2階以上", "築浅", "浴室乾燥", "追い焚き", "ウォークイン", "システムキッチン", "ロフト", "エレベーター"];
export function wantsOf(text: string): string[] { const t = String(text ?? "").normalize("NFKC"); return WANT_TERMS.filter((w) => t.includes(w)); }

export type Cand = { property_name?: string | null; room_no?: string | null; summary_text?: string | null };
/** 候補の要約（"68,000円 15,500円\n2DK 46㎡\n…徒歩3分"）から 家賃・間取り・徒歩 */
export function candFacts(c: Cand): { rent: number | null; layout: string | null; walk: number | null; text: string } {
  const t = String(c.summary_text ?? "").normalize("NFKC");
  const rent = t.match(/(\d{2,3}(?:,\d{3}))\s*円/); const layout = t.match(/\b([1-4](?:SLDK|LDK|SDK|DK|K)|1R|ワンルーム)\b/i); const walk = t.match(/徒歩\s*(\d{1,2})\s*分/);
  return { rent: rent ? Number(rent[1].replace(/,/g, "")) : null, layout: layout ? layout[1].toUpperCase().replace("ワンルーム", "1R") : null, walk: walk ? Number(walk[1]) : null, text: t };
}
const layoutsOf = (fp: string | null) => [...new Set((String(fp ?? "").normalize("NFKC").toUpperCase().match(/[1-4](?:SLDK|LDK|SDK|DK|K)|1R|ワンルーム/g) ?? []).map((x) => x.replace("ワンルーム", "1R")))];

/** 事実の1行（候補が無い・条件が無い番は空文字） */
export function pickupFitNowLine(o: { candidates: readonly Cand[]; row: SpecRow | null; customerText: string }): string {
  if (!o.candidates.length) return "";
  const e = effectiveConditions(o.row, null);
  const wants = wantsOf(o.customerText);
  const facts = o.candidates.map(candFacts);
  const parts: string[] = [];
  if (e.rent_max) parts.push(`家賃 ${Math.round(e.rent_max / 1000) / 10}万以内 ${facts.filter((f) => f.rent != null && f.rent <= (e.rent_max as number)).length}/${facts.length}`);
  const ls = layoutsOf(e.floor_plan);
  if (ls.length) parts.push(`間取り ${ls.join("・")} ${facts.filter((f) => f.layout && ls.includes(f.layout)).length}/${facts.length}`);
  if (e.walk_minutes) parts.push(`徒歩 ${e.walk_minutes}分以内 ${facts.filter((f) => f.walk != null && f.walk <= (e.walk_minutes as number)).length}/${facts.length}`);
  for (const w of wants) parts.push(`今の通の「${w}」が要約に書いてある ${facts.filter((f) => f.text.includes(w)).length}/${facts.length}（書いていない＝分からない）`);
  if (!parts.length) return "";
  return `【送れる候補が今の条件にも合うか（事実だけ・送るか、新着の約束にするかは決めるのはあなた）】候補 ${facts.length}件: ${parts.join("・")}`;
}
