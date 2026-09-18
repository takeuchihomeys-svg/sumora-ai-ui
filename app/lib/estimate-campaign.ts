// app/lib/estimate-campaign.ts
// 見積書に添えるキャンペーンの1文（純関数・DB 依存なし）。
//
// 2026-09-18 竹内「見積書のところにキャンペーン内容の枠をいれる。キャンペーン内容入れると
//   このように2通目にキャンペーンの内容が入った文が送られるようにする」
//
// 実送信（2026-09-18 11:20・竹内さんが画像で示した形）:
//   「こちら初期費用の御見積書となります！！
//     9月中のお申込は礼金キャンペーン中となり、敷金礼金0円でご入居出来ますので初期費用をかなり抑える事が出来ます😊！！
//     お気に召されましたらお部屋ご案内させて頂きます😌！！」
//
// 実データ（365日・スタッフ実送信 11,712通）で骨組みを取った。「キャンペーン」を含むのは42通:
//   ・「9月中のお申込は礼金キャンペーン中となり、敷金礼金0円でご入居出来ますので初期費用をかなり抑える事が出来ます😊！！」
//   ・「初回保証料免除のキャンペーン中ですので初期費用かなり抑える事ができます！！」
//   ・「現在礼金0円キャンペーン中となりますので初期費用抑える事が出来ます😊！！」
//   ・「11月末まで家賃無料のキャンペーン中となります！！」
//   ・「今月お申込のキャンペーンで初期費用をかなり抑える事が出来るお部屋となります！！」
//   ・「8月末までにお申込した場合貸主のキャンペーンで・初回保証料（26,000円分）・鍵交換費用（18,000円分）が免除となります！！」
//   共通の骨組み＝「〜キャンペーン中と〜ので初期費用を〜抑える事が出来ます！！」
//
// 設計知見「新しい型の文は実データにある物だけを骨組みにする。足りない場合は『スタッフが自分で書く』を
//   用意して、こちらは文を作らない」に従う: **中身はスタッフの言葉をそのまま**、骨組みだけ実送信の形に揃える。
//   キャンペーンの内容（いつまで・何が無料か）を知っているのは人だけなので、こちらで作らない。

/** キャンペーンの語（本文に既に入っているかの判定に使う） */
const CAMPAIGN_WORD_RE = /キャンペーン|フリーレント|無料|免除|0円|ゼロ円/;
/** 既に文として完成しているか（末尾が丁寧語で終わる） */
const COMPLETE_SENTENCE_RE = /(?:ます|ました|です|ません|下さい|ください)[！!。]*$/;
/** 実送信の骨組み（キャンペーンの中身だけ入力された時に当てはめる） */
const CAMPAIGN_FRAME = (body: string) => `${body}のキャンペーン中となりますので初期費用をかなり抑える事が出来ます😊！！`;

/** 入力欄のプレースホルダー（実送信の例をそのまま見せる） */
export const CAMPAIGN_PLACEHOLDER =
  "例: 9月中のお申込は礼金キャンペーン中となり、敷金礼金0円でご入居出来ますので初期費用をかなり抑える事が出来ます";

export type CampaignLineResult = { line: string; source: "as_is" | "framed" };

/**
 * スタッフが入れたキャンペーン内容を、送る1文にする。
 * ・既に文として完成していればそのまま使う（スタッフの言葉を書き換えない）
 * ・中身だけ（「礼金0円」「初回保証料免除」）なら実送信の骨組みに当てはめる
 * ・空なら null（何も足さない）
 */
export function buildCampaignLine(raw: string | null | undefined): CampaignLineResult | null {
  const t = (raw ?? "").trim().replace(/\s+/g, " ");
  if (t.length < 2) return null;
  if (COMPLETE_SENTENCE_RE.test(t)) {
    // 末尾の感嘆符を実送信の形（！！）に揃えるだけ
    const line = t.replace(/[！!]+$/, "").replace(/。$/, "") + "！！";
    return { line, source: "as_is" };
  }
  // 「〜の」「〜、」で終わっていたら整えてから骨組みに入れる
  const body = t.replace(/[のでが、,。]+$/, "").trim();
  if (body.length < 2) return null;
  return { line: CAMPAIGN_FRAME(body), source: "framed" };
}

/** 生成の指示（カバーレターの材料に入れる） */
export function buildCampaignNote(raw: string | null | undefined): string {
  const built = buildCampaignLine(raw);
  if (!built) return "";
  return [
    "【この見積書のキャンペーン（スタッフが入力・この内容だけを使う）】",
    built.line,
    "・この1文を本文に必ず入れる（言い換え・要約・金額の足し引きをしない）",
    "・スタッフが入力していない特典・期限・金額を書き足さない",
  ].join("\n");
}

/**
 * 出口の保証: カバーレターにキャンペーンの1文が入っていなければ足す。
 * 実送信の並び（御見積書の案内 → キャンペーン → 締め）に合わせ、**締めの直前**に入れる。
 * 設計知見「指示だけでは落ちる・出口だけでも落ちる」（決定論で足した文は出口でも保証する）
 */
const CLOSING_LINE_RE = /^(?:お気に召され|お手隙の際|ご確認|ご査収|何卒|引き続き)/;

export function ensureCampaignLine(text: string, raw: string | null | undefined): { text: string; added: boolean } {
  const built = buildCampaignLine(raw);
  const src = text ?? "";
  if (!built || !src.trim()) return { text: src, added: false };
  // 既にキャンペーンの話が入っていれば触らない（LLM が入力を踏まえて書いた場合）
  if (CAMPAIGN_WORD_RE.test(src)) return { text: src, added: false };

  const lines = src.split("\n");
  // 締めの行（お気に召されましたら／お手隙の際に…）の直前に入れる。無ければ末尾
  let at = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CLOSING_LINE_RE.test(lines[i].trim())) { at = i; break; }
  }
  lines.splice(at, 0, built.line);
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), added: true };
}
