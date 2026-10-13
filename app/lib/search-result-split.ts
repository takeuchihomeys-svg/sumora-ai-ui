// app/lib/search-result-split.ts — 物件を探す番の AIX を「物件あった場合｜物件なかった場合」の左右に分けて並べる（純関数・画面とサーバーの共用・依存なし）
//
// 2026-10-13 竹内さん（会話「KAORI」の画面: 締めた後に AIX【全力サポート】（上・橙）と【物件ピックアップ】（下・緑）が縦に2つ）:
//   「左右にボタンを分ける。物件あった場合と物件なかった場合と上に小さく記載。複数あった場合が物件ピックアップ、1件の場合が物件オススメ、
//    物件なかった場合が全力サポートとなる。そうすれば分かりやすいしスタッフも押しやすい」
//   「物件あった場合のところは横並びではなくて縦並びにする」「レイアウトもスマホで使いやすいようにする」
//    物件あった場合            │ 物件なかった場合
//    [物件ピックアップ（複数）] │ [AIX 全力サポート]
//    [物件オススメ（1件）]      │
//   背景: 新着があるかどうかは探したスタッフにしか分からない（P0 4b744a33 スタッフだけが知る事は AIX）→ ブレインがどちらかに決め打ちせず、
//   3つを分かりやすく並べてスタッフが検索の結果で押す。
//
// ブレイン基準（P0 9eb6aa9c・P1 0593a0aa）: 出す・出さないはブレインの判断だけで決める＝ブレインの一手（action）が物件を探す番の AIX
//   （物件ピックアップした・物件オススメ・物件を探す・全力サポート）の時。語・件数・出し切りの印で画面が独自に決めない。
//   2択（AIX か返信か two_choice_mode）は別のカードのまま。
// サーバー側（brain-core）: 出し切りの印で一手を【全力サポート】に書き換えていた所（search-exhausted.applySearchExhausted）は、
//   この左右の形が出る時は書き換えずに、一手をブレインの物件の AIX のままにして【全力サポート】を2つ目に並べる（applySearchSplit）。
// 戻す: 画面 NEXT_PUBLIC_SEARCH_SPLIT_CHOICE=off（今まで通りの縦並び）／サーバー SEARCH_SPLIT_CHOICE=off（出し切りで全力サポートに書き換える旧の動き）
// テスト: app/lib/__tests__/search-result-split.test.ts

/** 物件を探す番の AIX（ブレインの一手がこのどれかなら左右の形） */
export const SPLIT_TRIGGER_AIX: ReadonlySet<string> = new Set(["property_send", "property_recommendation", "property_search", "zenryoku_support"]);
/** 左右の形に並べる3つ（これ以外の2つ目の AIX は下に今まで通り並べる） */
export const SPLIT_OWN_AIX: ReadonlySet<string> = new Set(["property_send", "property_recommendation", "zenryoku_support", "property_search"]);

export type SplitButton = {
  action: "property_send" | "property_recommendation" | "zenryoku_support";
  /** ボタンの1行目（大きい字） */
  label: string;
  /** ボタンの2行目（小さい字・どの時に押すか） */
  sub: string;
  /** ブレインの一手と同じボタンか（並びも色も変えない。記録・テスト用） */
  isBrain: boolean;
};

export type SearchSplitView = {
  /** 左の見出し */
  foundHeading: string;
  /** 右の見出し */
  notFoundHeading: string;
  /** 左（縦並び）: 物件ピックアップ（複数）・物件オススメ（1件） */
  found: [SplitButton, SplitButton];
  /** 右: 全力サポート */
  notFound: SplitButton;
  /** 左右の3つ以外の2つ目の AIX（下に今まで通り並べる） */
  others: string[];
};

export function searchSplitViewEnabled(off?: boolean): boolean {
  return !off;
}

export function searchSplitServerEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SEARCH_SPLIT_CHOICE ?? "").trim().toLowerCase() !== "off";
}

/** ブレインの一手が物件を探す番か（左右の形を出すか）。2択（AIX か返信か）の判断は別のカード */
export function isSearchSplitTurn(o: { brainAction: string | null | undefined; twoChoiceMode?: boolean | null; off?: boolean }): boolean {
  if (!searchSplitViewEnabled(o.off)) return false;
  if (o.twoChoiceMode) return false;
  return !!o.brainAction && SPLIT_TRIGGER_AIX.has(o.brainAction);
}

/**
 * 画面のブレインのカードを左右の形で出すなら、その中身。出さない番は null（今まで通りの縦並び）。
 *   ボタンの順と色は一手に関係なく固定（左上＝物件ピックアップ・左下＝物件オススメ・右＝全力サポート）。押し間違えないよう位置を毎回同じにする。
 */
export function searchSplitView(o: { brainAction: string | null | undefined; altActions?: ReadonlyArray<string> | null; twoChoiceMode?: boolean | null; off?: boolean }): SearchSplitView | null {
  if (!isSearchSplitTurn(o)) return null;
  const a = o.brainAction ?? "";
  const others = (o.altActions ?? []).filter((x, i, arr) => x !== a && !SPLIT_OWN_AIX.has(x) && arr.indexOf(x) === i);
  return {
    foundHeading: "物件あった場合",
    notFoundHeading: "物件なかった場合",
    found: [
      { action: "property_send", label: "AIX 物件ピックアップ", sub: "複数あった時", isBrain: a === "property_send" || a === "property_search" },
      { action: "property_recommendation", label: "AIX 物件オススメ", sub: "1件の時", isBrain: a === "property_recommendation" },
    ],
    notFound: { action: "zenryoku_support", label: "AIX 全力サポート", sub: "新着が出次第お送り", isBrain: a === "zenryoku_support" },
    others,
  };
}

/** 左右の形の番のブレインのメモに付ける一文（決め打ちしない言い方） */
export const SEARCH_SPLIT_NOTE = "（検索の結果で押す: 物件あった場合＝複数は AIX【物件ピックアップ】・1件は AIX【物件オススメ】／物件なかった場合＝AIX【全力サポート】）";
/** 出し切りの印がある時に足す一文（前に送った物件の印がある＝新着が無ければ右。決め打ちはしない） */
export const SEARCH_SPLIT_EXHAUSTED_NOTE = "（前に今の条件の物件を送っている＝新着が見つからなければ右の AIX【全力サポート】）";
/** 返信（ピックアップの約束）を AIX の番に移した時の返信の方向（AIX の番なので下書きは作らないが、記録・本質の材料に残す） */
export const SEARCH_SPLIT_DIRECTION = "検索の結果で決める番: 送れる物件があれば物件の AIX（複数＝物件ピックアップ・1件＝物件オススメ）、今の条件に合うお部屋が無ければ AIX【全力サポート】（新着が出次第お送りする約束）";

/**
 * brain-core の出し切りの所に当てる（applySearchExhausted の代わり）。
 *   出し切りの印がある番で、ブレインの一手が物件の AIX → 一手はそのまま・【全力サポート】を2つ目に足す（書き換えない）。
 *   ブレインが返信（2段のピックアップの約束・条件の言い直しへの返信）にしていた番 → 検索の結果はスタッフだけが知るので AIX の番にし、
 *     一手は LLM が最初に選んだ物件の AIX（無ければ物件ピックアップ）・【全力サポート】を2つ目（旧はここで一手を【全力サポート】に決め打ちしていた）。
 *   申込以降・出し切りでない・SEARCH_SPLIT_CHOICE=off は何もしない（呼ぶ側が旧の applySearchExhausted を使う）。
 */
export function applySearchSplit(o: {
  finalAix: string | null;
  /** ブレインが返信にしていた番（2段の pickup の約束・条件の言い直しへの返信） */
  fromReply: boolean;
  /** LLM が最初に選んだ AIX（決定論の規則で変わる前・llm_raw.action） */
  llmAix?: string | null;
  altActions: string[] | undefined;
  exhausted: boolean;
  postApply: boolean;
  env?: Record<string, string | undefined>;
}): { applies: boolean; finalAix: string | null; altActions: string[] | undefined; toAix: boolean } {
  const keep = { applies: false, finalAix: o.finalAix, altActions: o.altActions, toAix: false };
  if (!searchSplitServerEnabled(o.env) || o.postApply || !o.exhausted) return keep;
  const PROP = ["property_send", "property_recommendation", "property_search"];
  let finalAix = o.finalAix;
  let toAix = false;
  if (o.fromReply && !finalAix) {
    finalAix = o.llmAix && PROP.includes(o.llmAix) ? o.llmAix : "property_send";
    toAix = true;
  }
  if (!finalAix || !PROP.includes(finalAix)) return keep;
  const alts = [...(o.altActions ?? []).filter((x) => x !== finalAix && x !== "zenryoku_support"), "zenryoku_support"];
  return { applies: true, finalAix, altActions: alts, toAix };
}
