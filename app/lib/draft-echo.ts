// app/lib/draft-echo.ts
// 下書きがお客様の発言をそのまま返していないか（出口の安全の線・純関数・依存なし）。
//
// 2026-10-20 竹内さん（設計知見 P1 d3fe3a9f）: 見積を送った直後にお客様「他はないですか？」、同じ分にスタッフの送信が重なった後の
//   AI の下書きが『他はないですか？』（お客様の文そのまま・要確認・最終チェック指摘1件）だった。
//   本番の記録（10/19 08:07 generate-reply q98d9）: ブレインの判断はスタッフの送信と重なって捨てられ（brain:write-skip staff_sent_during_analysis）、
//   ✨の前の待ち（brain:before-generate）も25秒で切れて T3。画面が足す「お客様の文から拾った手がかり」（【条件変更/ピックアップ依頼…】＋お客様の文）が
//   本質の無い番では「指定生成モード（通常の生成ルールをすべて上書き）…指定内容: 他はないですか？」になり、指定内容＝お客様の文を本文に書いた。
//   根っこは generate-reply の手がかりの扱い（REPLY_HINT_AUTO_MATERIAL）で直し、ここは「それでもお客様の文と同じ下書きは出さない」最後の線。
//   判断（何を返すか・AIX の3択）はブレインの仕事。ここは文字の一致だけを見る（P0 9eb6aa9c: 規則は安全の線だけ）。
//
// 戻す: サーバー DRAFT_ECHO_GUARD=off／画面 NEXT_PUBLIC_DRAFT_ECHO_GUARD=off

/** 比べる前にそろえる: 空白・句読点・感嘆符・疑問符・括弧・絵文字・記号を外し、全角英数を半角に */
export function normalizeForEcho(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[。、，,．.！!？?・…‥「」『』（）()【】［］\[\]〜~ー－\-―'"“”‘’:：;；]/g, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .toLowerCase();
}

/**
 * 下書きがお客様の発言（どれか1通、または未返信の通をつないだ物）とほぼ同じなら true。
 *   - そろえた後で同じ
 *   - お客様の文（4字以上）を含み、それ以外に足した字が少ない（お客様の文の長さの3割＋4字まで）＝「オウム返し」
 * 下書きが空・お客様の文が無い時は false（判定できない＝止めない）。
 */
export function isCustomerEcho(draft: string | null | undefined, customerTexts: ReadonlyArray<string | null | undefined>): boolean {
  const d = normalizeForEcho(draft);
  if (!d) return false;
  const cands = new Set<string>();
  const norm = customerTexts.map((t) => normalizeForEcho(t)).filter((t) => t.length > 0);
  for (const t of norm) cands.add(t);
  if (norm.length > 1) cands.add(norm.join(""));
  for (const c of cands) {
    if (d === c) return true;
    if (c.length >= 4 && d.includes(c) && d.length - c.length <= Math.ceil(c.length * 0.3) + 4) return true;
  }
  return false;
}

/** 旗（既定 on） */
export function draftEchoGuardEnabled(flag: string | undefined | null): boolean {
  return (flag ?? "on").trim().toLowerCase() !== "off";
}
