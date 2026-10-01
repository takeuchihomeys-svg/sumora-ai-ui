// app/lib/aix-template-source.ts
// テンプレート一覧の【AIX】カテゴリで「✨ この会話に合った文を生成」を押した時に、/api/aix-template-generate に渡す「直前に AIX で送った1通目」を決める（純関数）。
//
// 2026-10-01 竹内さん「テンプレート一覧の【AIX】→『1件特にオススメする』で『✨この会話に合った文を生成』を押した場合、今改善している AIX テンプレートの質になってるのかな？」
//   ／「✨この会話に合った文を生成のところをこの改善したようにする」:
//   ✨の生成は postAixContext.sentMessage（AIX を送った直後に同じ画面で開いた時だけある）しか渡していなかった。
//   テンプレート一覧を下のメニュー・ツールバーから後で開くと sentMessage が null → サーバーの isRecSecond が false になり、
//   物件オススメの2通目の直し（場面の手本・資料の事実・締め・出口の検査）が1つもかからなかった。
//   同じ画面の「AIで最適化」（handleAdapt）は「postAixContext の本文 → 今の会話の履歴の最後のスタッフの AIX（isAix）」で補っている → 同じ補い方にする。
//   ⚠ 履歴は今の会話だけ（別のお客様の物は混ざらない）。履歴の最後の AIX が選んだカテゴリの種類と違う形（物件オススメを選んだのに最後の AIX が見積書 等）の時は渡さない
//     （種類の違う1通目を「直前の1通目」として渡すと、別の AIX の続きを書く）。古い AIX（24時間より前）も渡さない。

import { isFirstRecommendation } from "./first-message-style";

export type TemplateSourceMessage = { sender: string; text?: string | null; isAix?: boolean; rawCreatedAt?: string | null };

/** カテゴリの種類ごとの「その AIX の本文の形」（本文だけで種類を見分ける。分からない種類は補わない） */
const SHAPE: Record<string, (t: string) => boolean> = {
  property_recommendation: (t) => isFirstRecommendation(t),
  property_send: (t) => /ピックアップ/.test(t) && !isFirstRecommendation(t),
  estimate_sheet: (t) => /御見積|見積書/.test(t),
};

export const TEMPLATE_SOURCE_MAX_AGE_MS = 24 * 3600_000;

export function resolveTemplateSentMessage(i: {
  actionType: string | null | undefined;
  /** AIX を送った直後に同じ画面で開いた時の本文（あればそれが正） */
  postAixSent?: string | null;
  /** 今の会話の履歴（古い順） */
  recent?: ReadonlyArray<TemplateSourceMessage> | null;
  nowMs?: number;
}): { text: string | null; source: "post_aix" | "history" | null } {
  const post = String(i.postAixSent ?? "").trim();
  if (post) return { text: post, source: "post_aix" };
  const shape = i.actionType ? SHAPE[i.actionType] : undefined;
  if (!shape) return { text: null, source: null };
  const list = Array.isArray(i.recent) ? i.recent : [];
  const last = [...list].reverse().find((m) => m.sender === "staff" && m.isAix && String(m.text ?? "").trim() && !/^\[(?:画像|動画|ファイル)\]$/.test(String(m.text).trim()));
  if (!last) return { text: null, source: null };
  const at = Date.parse(String(last.rawCreatedAt ?? ""));
  if (Number.isFinite(at) && (i.nowMs ?? Date.now()) - at > TEMPLATE_SOURCE_MAX_AGE_MS) return { text: null, source: null };
  const text = String(last.text).trim();
  return shape(text) ? { text, source: "history" } : { text: null, source: null };
}

/** 画面の「訴求方法を選択する！！」（🏃内覧に誘う／🚀申込へ押し込む）→ 2通目の締めの種類（recommend-cta の kind） */
export function ctaPreferenceOf(purpose: string | null | undefined): "viewing" | "apply" | null {
  return purpose === "内覧" ? "viewing" : purpose === "申込" ? "apply" : null;
}
