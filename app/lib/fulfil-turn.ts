// app/lib/fulfil-turn.ts — 約束を果たす番の見分け（純関数・作業員M・2026-11-21・台帳 #405・既定 off）
//
// 外れの型（#405 の入口の表 ③ 2d7548d5・作業員K2 の試験の問題 q447・q448 と同じ型）:
//   こちらが直前の通で「ピックアップしてお送りさせて頂きます」「御見積書を作成しお送りさせて頂きます」「リンクをお送りします」と約束し、
//   お客様は「お願いします」「かしこまりました」「こちらこそ宜しくお願いいたします」と了承しただけの番。
//   竹内さんは約束を言い直さず、約束した物を AIX で送って果たした（q447・q448・2d7548d5）。ブレインは約束の返信を繰り返した（2段）か、送った体の返信を書いた。
// 線（P0 ca55d42b・KB efe46361「約束の結果が手元に揃った後のお礼は、受けだけの返信ではなく約束の結果を AIX で送るタイミング」）:
//   送る物がスタッフの手元で作れる約束（物件探し・見積書・資料の送付）だけ。確認（管理会社の答え待ち）は結果がまだ無いので入れない。
//   道を書くのはブレイン＝ここは事実の1行（何を約束し、お客様は了承しただけ）と「この番に果たす物」を材料に渡すだけ。
// スイッチ BRAIN_FULFIL_TURN（既定 off）。off の時は空文字＝プロンプトは1バイトも変わらない。
// テスト: app/lib/__tests__/fulfil-turn.test.ts
import type { OpenPromise, PromiseKind } from "./promise-tracker";

type Env = Record<string, string | undefined>;
export function brainFulfilTurnOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_FULFIL_TURN ?? "").trim().toLowerCase() === "on";
}

/** その場で果たせる約束の種類 → 果たす AIX（名前は aix-catalog の action） */
export const FULFIL_AIX_OF: Readonly<Partial<Record<PromiseKind, { aix: string; ja: string }>>> = {
  "物件探し": { aix: "property_send", ja: "物件をピックアップして送る（AIX【物件を送る】）" },
  "見積書": { aix: "estimate_sheet", ja: "最大限割引の御見積書を送る（AIX【見積書送る】）" },
  "資料の送付": { aix: "property_check_result", ja: "約束した資料・リンクを送る（AIX【物件確認した】の資料の送付）" },
};
/** 約束から何時間までを「直前の約束」とみるか（了承の返事が来るまで・竹内さんの番は 0.3〜18時間） */
export const FULFIL_MAX_H = 24;

/** 了承だけの番（短い・問いと依頼が無い・了承の語がある）。previous-send-note.isShortAckOnly より広い（物件名つきの「〇〇かしこまりました」・「こちらこそ宜しくお願いいたします」を入れる・q447 q448） */
export function isFulfilAck(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t || Array.from(t).length > 40) return false;
  if (/[?？]|ですか|でしょうか|ますか|探して|送って|教えて|ください|下さい|頂けますか|いただけますか/.test(t)) return false;
  return /かしこまり|お願い|宜しく|よろしく|ありがとう|了解|承知|わかりました|分かりました|助かります|^はい/.test(t);
}
export type FulfilTurn = { kind: PromiseKind; aix: string; quote: string; elapsedH: number };
/** お客様の今の番が了承だけで、直前の約束がその場で果たせる物なら、その約束（無ければ null） */
export function fulfilTurnOf(i: { shortAck?: boolean; customerText?: string | null; open: readonly OpenPromise[] }): FulfilTurn | null {
  if (!(i.shortAck ?? isFulfilAck(i.customerText))) return null;
  const cands = i.open
    .filter((p) => FULFIL_AIX_OF[p.kind] && p.elapsedH <= FULFIL_MAX_H && p.status !== "待ち（新着・審査の結果次第）")
    .sort((a, b) => a.elapsedH - b.elapsedH);
  const p = cands[0];
  if (!p) return null;
  return { kind: p.kind, aix: FULFIL_AIX_OF[p.kind]!.aix, quote: Array.from(p.sentence.replace(/\s+/g, " ").trim()).slice(0, 50).join(""), elapsedH: p.elapsedH };
}
/** ブレインの材料の1塊（off・該当なしは空文字） */
export function fulfilTurnBrainText(i: { shortAck?: boolean; customerText?: string | null; open: readonly OpenPromise[] }, env?: Env): string {
  if (!brainFulfilTurnOn(env)) return "";
  const f = fulfilTurnOf(i);
  if (!f) return "";
  const h = f.elapsedH < 1 ? `${Math.max(1, Math.round(f.elapsedH * 60))}分前` : `${Math.round(f.elapsedH)}時間前`;
  return `\n【約束を果たす番（事実）】こちらは${h}に「${f.quote}」と約束し、お客様は今の番で了承しただけ（新しい依頼・問いは無い）。`
    + `\n・この約束はスタッフの手元で果たせる物＝${FULFIL_AIX_OF[f.kind]!.ja}。竹内さんは同じ形の番で約束を言い直さず、約束した物を送って果たしている（実送信）。`
    + `\n・約束の言い直し・「お送りさせて頂きました」と送った体の返信だけにしない。今すぐ送れない事情が会話にある時だけ、いつ送るかを返信で伝える。`;
}
