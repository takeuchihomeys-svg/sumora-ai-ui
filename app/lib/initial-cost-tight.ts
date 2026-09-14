// app/lib/initial-cost-tight.ts
// お客様が「初期費用を抑えたい」かの判定（純関数・依存なし）。ブレインの避ける話題・返信の必須要素（reply-context）が同じ関数を使う。
//
// 2026-09-14 竹内（くれあ事例）: 条件フォームの ⑦【初期費用の限度額】⇒10〜20（＝10万〜20万円）・②家賃 15〜17万。
//   限度額が家賃の3倍未満なので「初期費用を抑える」旨の一文（初期費用も最大限割引させて頂き…費用を出来る限り抑えさせて頂きます）を入れる。
//   旧: ブレインのルール②（費用の質問が無ければ avoid_topics に「見積書」「初期費用」）が一律に効き、実例の検索からも「初期費用」を含む
//   返信が除外（excludeReplyRe）され、下書きに入らなかった（スタッフが手で足した）。
//   実データ（条件フォームへのスタッフの返信 118件）: ⑦が家賃の3倍未満 22/29（76%）・「なるべく安く」等の言葉 6/7（86%）で
//   この一文を入れていた（未定・空欄は 18/48＝38%）
//   「見積書」は別概念（特定物件の費用の証拠がある時だけ）なので、この判定では避ける話題から外さない

/** 「初期費用を抑える」一文の検出（返信側） */
export const INITIAL_COST_SAVE_DECL_RE = /初期費用[^。！!\n]{0,25}(?:割引|抑え)|費用を?(?:出来る|できる)限り抑え/;
/** 必須要素の修正案リテラル（事実を含まない自社方針の文。{name} は reply-context の fillNameSlot が埋める） */
export const INITIAL_COST_SAVE_LITERAL = "初期費用も最大限割引させて頂き{name}のお引越しにかかる費用を出来る限り抑えさせて頂きます！！";

/**
 * 下書きに「初期費用を抑える」一文が無い時、締め（全力でサポート／何卒）の行の前に入れる（無ければ末尾）。
 * 生成への必須要素の指示だけでは3回中1回しか書かれなかった（YUMA 再現）ため、挨拶の固定と同じく決定論で入れる。
 * リテラルは金額・物件を含まない自社方針の文（顧客名だけを埋める）なので、足しても創作にならない。
 */
export function insertInitialCostSave(draft: string, customerName: string | null | undefined): { text: string; inserted: boolean } {
  if (!draft.trim() || INITIAL_COST_SAVE_DECL_RE.test(draft)) return { text: draft, inserted: false };
  const name = (customerName ?? "").trim();
  const sentence = name ? INITIAL_COST_SAVE_LITERAL.replace("{name}", `${name}さん`) : INITIAL_COST_SAVE_LITERAL.replace("{name}の", "");
  const lines = draft.split("\n");
  const closeIdx = lines.findIndex((l, i) => i > 0 && /全力で(?:お部屋探し)?サポート|^\s*何卒/.test(l));
  if (closeIdx >= 0) lines.splice(closeIdx, 0, sentence);
  else lines.push(sentence);
  return { text: lines.join("\n"), inserted: true };
}

const WANTS_LOW_RE =/安く|安い|安ければ|抑え|なるべく|できるだけ|出来るだけ|少なく|低く|最低限|格安/;

export type InitialCostTightVerdict = {
  tight: boolean;
  reason: "ratio_under_3" | "months_3_or_less" | "wants_low" | null;
  /** 限度額（万円） */
  limitMan: number | null;
  /** 家賃の下限（万円） */
  rentMinMan: number | null;
  evidence: string;
};
const NONE: InitialCostTightVerdict = { tight: false, reason: null, limitMan: null, rentMinMan: null, evidence: "" };

/** 条件フォームの項目の値（「⑦【初期費用の限度額】⇒10〜20」→「10〜20」）。見出しの記号は NFKC で数字に変わるので元の文字で探す */
function formValue(text: string, mark: string): string | null {
  const m = text.match(new RegExp(`${mark}[^⇒→:：\\n]{0,40}[⇒→:：]\\s*([^\\n]*)`));
  if (!m) return null;
  return m[1].split(/[①-⑩]/)[0].trim();
}

/** 金額（万円）の配列。「10〜20」「15万〜17万」「4万5000円以内」「70,000〜120,000」。単位なしの 1〜300 は万円、1000 以上は円とみなす */
export function manAmounts(value: string): number[] {
  const t = value.normalize("NFKC").replace(/[,，]/g, "");
  const out: number[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*万\s*(\d{1,4})?|(\d+(?:\.\d+)?)/g)) {
    if (m[1]) { out.push(Number(m[1]) + (m[2] ? Number(m[2]) / 10000 : 0)); continue; }
    const v = Number(m[3]);
    if (v >= 1000) out.push(v / 10000);
    else if (v >= 1 && v <= 300) out.push(v);
  }
  return out;
}

/**
 * 今回のお客様の連投（条件フォーム）から「初期費用を抑えたい」かを判定する。
 * ⑦の値が ①家賃の3倍未満の金額 ②家賃の3ヶ月（倍）以内 ③「なるべく安く」等の言葉 のどれかなら tight。
 * ⑦が無い・未定・空欄なら判定しない（tight=false）。
 */
export function resolveInitialCostTight(customerTurn: string | null | undefined): InitialCostTightVerdict {
  const text = customerTurn ?? "";
  const cost = formValue(text, "⑦");
  if (!cost) return NONE;
  const evidence = `⑦${cost.slice(0, 30)}`;
  const months = cost.normalize("NFKC").match(/(\d+(?:\.\d+)?)\s*(?:倍|ヶ月|ケ月|か月|カ月|ヵ月)/);
  if (months) {
    const n = Number(months[1]);
    return n <= 3 ? { tight: true, reason: "months_3_or_less", limitMan: null, rentMinMan: null, evidence } : { ...NONE, evidence };
  }
  const limits = manAmounts(cost);
  const limitMan = limits.length ? Math.max(...limits) : null;
  const rentValue = formValue(text, "②");
  const rents = rentValue ? manAmounts(rentValue) : [];
  const rentMinMan = rents.length ? Math.min(...rents) : null;
  if (limitMan !== null && rentMinMan !== null && rentMinMan > 0 && limitMan < rentMinMan * 3) {
    return { tight: true, reason: "ratio_under_3", limitMan, rentMinMan, evidence: `${evidence}／②${(rentValue ?? "").slice(0, 20)}` };
  }
  if (WANTS_LOW_RE.test(cost)) return { tight: true, reason: "wants_low", limitMan, rentMinMan, evidence };
  return { ...NONE, limitMan, rentMinMan, evidence };
}
