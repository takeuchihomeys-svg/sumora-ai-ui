// app/lib/customer-property-inquiry.ts
// お客様が自分で見つけた物件（SUUMO 等の URL・物件の画像）を送って「ここはどうでしょうか」と聞いた時の次の一手（純関数・DB 依存なし）。
//
// 2026-10-01 竹内（和樹事例）「ここは物件確認したから送る形なので、そのようにする。またこのような判断基準のズレの部分を改善していく」:
//   10/1 12:45 お客様「ＭＡＩＳＯＮ ＬＵＮＡ 1階 https://suumo.jp/chintai/bc_100500564435/ by SUUMO」＋「ここはどうでしょうか？」
//   → ブレインは AIX【確認します】（acknowledge_check）・画面の赤帯は 9/30 の約束「引き続き新着で…ピックアップしお送り」の 物件ピックアップ が一番上。
//   正解は AIX【物件確認した】: スタッフが管理会社に募集状況・条件を確認し、その結果を（多くは最大限割引の御見積書を同封して）送る。
//   同じ会話の 9/30 21:34 の初芝の URL でも、スタッフは 10/1 11:32 に 物件確認した（available・御見積書同封）を押していた。
//
// 出所（穴:G3 判断）: ブレインのプロンプトの aix キー基準が「顧客が物件URL・物件名を送ってきて空室/募集状況が未確認の時 → acknowledge_check」と
//   教えていた。acknowledge_check は管理会社・オーナー宛ての確認依頼の文を作るボタンで、お客様への次の一手としてはほとんど押されていない。
//   しかも cron/brain-aix-eval が acknowledge_check と property_check_result を同じ扱いで一致にしていたので、このズレは一致率に出なかった。
//
// 実送信で引いた線（scripts/audit-customer-property-inquiry.ts・読み取りのみ）:
//   ・お客様がポータルの URL を送ってきた後に最初に押された AIX（7/17〜10/1・131回）: 物件確認した 109・見積書送る 21・確認します 0
//   ・AIX【確認します】が押されたのは 150日で全体でも 6回
//   ・ブレインが場面 S1（物件の持ち込み・URL/画像）で 確認します を出した後、スタッフが次に押した AIX: 物件確認した 22・見積書送る 8・確認します 0
//     見積書送るだった回はお客様が「初期費用」「見積」を聞いた時（「この物件達の初期費用っていくらになりますか？」「空いていて初期費用申し分なければ」）
//
// 入口か出口か: ブレインの判断の補正（本文は書き換えない）。直すのは「確認します」を選んだ時だけで、LLM が 物件確認した・見積書送る・
//   物件ピックアップ（「こんなかんじがいいです！」＋URL＝条件の例示）を選んだ時は触らない（ブレインの判断のまま）。

import { normalizeCustomerText } from "./reply-context";

/** ポータル以外の URL（広告・通販・SNS の招待）。物件の持ち込みではない（実例: temu の招待 URL に 確認します が出ていた） */
const NON_PROPERTY_URL_RE = /https?:\/\/[^\s]*(?:temu\.com|amazon\.|amzn\.|shein\.|aliexpress\.|qoo10\.|item\.rakuten|shopping\.yahoo|line\.me|lin\.ee|paypay\.ne)/i;
const ANY_URL_RE = /https?:\/\/\S+/gi;
/** 言葉が物件を指している（画像の持ち込みの確かめ） */
const PROPERTY_POINT_RE = /物件|お?部屋|お家|マンション|アパート|ハイツ|ここ|こちら|この|そちら|空(?:き|いて|室)|募集|気にな|どう(?:です|でしょう)|いかが|初期費用|見積/;
/** お客様が費用そのもの（初期費用・見積）を聞いている（実送信: この時は 見積書送る が先） */
const COST_ASK_RE = /初期費用|見積/;

export type InquirySceneLite = {
  scene?: string | null;
  propertySpecifiedBy?: string | null;
} | null | undefined;

/** お客様が物件そのもの（ポータルの URL・物件の画像）を持ち込んだターンか（場面の証拠 S1 ＋ 根拠が URL / 画像） */
export function isCustomerBroughtProperty(o: { scene: InquirySceneLite; customerTurn: string | null | undefined }): boolean {
  const s = o.scene;
  if (!s || s.scene !== "S1_vacancy") return false;
  // 画像は物件とは限らない（実例 ae3ffecb: 勤務先とのやり取りのスクショ＋「給料明細なのですが…」で S1 に当たっていた）。
  //   お客様の言葉が無い（画像だけ＝物件写真・間取り図の判定は場面の側）か、言葉が物件を指している時だけ持ち込みとみなす
  if (s.propertySpecifiedBy === "image") {
    const words = normalizeCustomerText(o.customerTurn).trim();
    return !words || PROPERTY_POINT_RE.test(words);
  }
  if (s.propertySpecifiedBy !== "url") return false;
  const urls = (o.customerTurn ?? "").match(ANY_URL_RE) ?? [];
  // URL が全部ポータル以外（広告・通販）なら持ち込みではない
  return urls.length === 0 || urls.some((u) => !NON_PROPERTY_URL_RE.test(u));
}

/**
 * ブレインが 確認します（acknowledge_check）を選んだ時、お客様の物件の持ち込みなら 物件確認した に直す。
 * お客様が初期費用・見積を聞いている時は 見積書送る（実送信の向き）。それ以外の AIX・持ち込みでない場面は null（変えない）。
 */
export function correctCustomerPropertyInquiryAix(o: {
  finalAix: string | null | undefined;
  scene: InquirySceneLite;
  customerTurn: string | null | undefined;
}): { action: "property_check_result" | "estimate_sheet"; decisionSource: string } | null {
  if (o.finalAix !== "acknowledge_check") return null;
  if (!isCustomerBroughtProperty({ scene: o.scene, customerTurn: o.customerTurn })) return null;
  // 費用の問いはお客様の言葉だけで見る（画像の読み取り文＝ポータルの画面の「初期費用」等は発言ではない・設計知見 Hina 事例）
  const words = normalizeCustomerText(o.customerTurn).replace(ANY_URL_RE, " ");
  if (COST_ASK_RE.test(words)) return { action: "estimate_sheet", decisionSource: "correction:customer_property_cost" };
  return { action: "property_check_result", decisionSource: "correction:customer_property_inquiry" };
}
