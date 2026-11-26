// app/lib/screening-static-texts.ts — 審査の事情の網（screeningSensitiveSignal）にかけない決まりの文（静的な文＝お客様の値を含まない）
// 2026-11-26 作業員L（統括役の急ぎ・今夜の DeepSeek の試験6本が全部「比べられない」）:
//   llm-alt-provider は messages の本文を網にかける（system は値だけの網）。ブレインの答えの形の説明（欄の決まりの文）は messages に入るので、
//   その中の語（「出所」＝出どころ・「夜職」等の例の言葉）で brain_full が止まっていた。決まりの文は system と同じ扱いにして、網にかける前に消す。
//   ここに足すのは、コードの中の定数の文（お客様の値・会話の文を含まない物）だけ。網そのもの（RULES）は緩めない。
import { NOW_VS_LATER_FIELD } from "./brain-now-later";
import { ASK_PARTS_FIELD } from "./ask-parts";
import { TURN_READ_BRAIN_FIELD } from "./turn-read";

export const SCREENING_STATIC_TEXTS: readonly string[] = [NOW_VS_LATER_FIELD, ASK_PARTS_FIELD, TURN_READ_BRAIN_FIELD].filter((s) => typeof s === "string" && s.length >= 20);

/** 網にかける前に、決まりの文をそのまま取り除く（一字でも違えば残る＝お客様の文は消えない） */
export function stripScreeningStaticTexts(text: string): string {
  let t = String(text ?? "");
  for (const s of SCREENING_STATIC_TEXTS) if (t.includes(s)) t = t.split(s).join(" ");
  return t;
}
