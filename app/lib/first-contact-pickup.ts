// app/lib/first-contact-pickup.ts
// 真の初回（スタッフの送信が1件も無い会話）で、ブレインが「action は出さない（初回の挨拶下書きが最優先）」代わりに
// 残す「最初の一手」（first_contact_pickup）を決める純関数。brain-core の初回ガード（decision_source=guard:first_contact）から呼ぶ。
//
// 2026-09-23 課題③（竹内「順に改善する。実際の成約データや直近のLINEを参考にずれをなくす」）:
//   audit-brain-funnel で「最初の段階でブレインが AIX を出していない 43.5%」→ 正体は LLM の判断ではなく、この初回ガードが
//   LLM の AIX を捨てたうえで first_contact_pickup を条件フォームの時にしか残さず、しかも brain_decision_logs には
//   first_contact_pickup が書かれていなかった（測り方の穴）。監査: scripts/audit-first-move.ts F（09-12 以降の初回ガード 44会話）
//
// 【実送信で引いた線】（必須にしてよいのは過半数が守っている形だけ）
//   1) 条件フォーム → property_send:
//        要対応 15/17・返信したスタッフの最初の返信はピックアップ宣言 14/14・押した AIX は property_send 10/12 → 原則（現行のまま）
//   2) 物件の画像／URL を送ってきた（業者 DM 以外）→ property_check_result（募集状況の確認。見積は物件が届いて確認してから）:
//        返信した会話の最初の返信は募集状況確認の宣言 3/4・押した AIX は estimate_sheet 3/3（property_check_result 0・監査 F の数字）。
//        09-12 以前の同じ場面も同じ。ガードの行には scene_evidence（S1_vacancy・property_nomination・property_by=image）が
//        既に入っているのに捨てていた（fresh 層は mode=incremental でガードを通らないので、1分後の行にだけ AIX が付いていた）
//        → 新規。check_pattern は null（募集状況の確認）
//   3) 初回に AIX【条件ヒアリング】: 実送信の初回返信で条件のお願いは 4.6%・会話ごとの最初の AIX が condition_hearing は 8.6%
//        → 線が引けない（20%帯にも届かない）。挨拶下書き（first_reply ガイド「条件が無ければお聞かせ」）が受け持つので null のまま【入れない】
//   4) 業者 DM（「公式LINEへ突然失礼します」等）・既存入居者・入金相談: scene_evidence が無く条件フォームでもない → null（要対応を立てない）
//   5) LLM が estimate_sheet 等を選んでも scene の物件指名が無ければ null（見積る物件が届いていない）
//
// 【触らない物】「物件送付直後の反応待ち aix:null」「お客様が自分で送る予告だけ aix:null」は初回ガードとは別の場面（この関数は通らない）。

export type FirstContactPickup = "property_send" | "property_check_result" | null;

/** brain-aix-feedback.compactSceneEvidence の形（brain_decision_logs.scene_evidence にもこの形で入っている） */
export type FirstContactSceneLite = { scene?: string | null; reason?: string | null; property_by?: string | null } | null | undefined;

export type FirstContactPickupInput = {
  /** LLM／規則が選んだ AIX（初回ガードで捨てる前の値）。property_send / property_search の時だけ材料にする */
  finalAix: string | null;
  /** 初回の顧客発言のどれかが条件フォーム（reply-context.isConditionFormMessage） */
  custSentConditionForm: boolean;
  /** 今回の顧客発言の場面の証拠（決定論）。無ければ null */
  sceneEvidence: FirstContactSceneLite;
  /** 初回の顧客画像の種類（messages.image_type・Vision の分類。読み取り前は null） */
  imageType?: string | null;
};

/**
 * 画像の指名でも「物件の画像ではない」と分かっている種類は募集状況の確認にしない（反証者が120日を全件当てて見つけた1件:
 * 電子契約完了画面のスクショ＋名乗りで契約段階のお客様に要対応が立つ）。
 * ⚠ other は除外しない（TikTok のスクショは other で、直る4件の3件がそれ）。null（未読み取り）も除外しない
 */
const NON_PROPERTY_IMAGE_TYPES = new Set(["id_document", "estimate"]);

/** 物件の画像／URL で物件を指名してきた（S1 空室確認・property_nomination）。文の物件名だけ（property_word・room_no）は初回では材料にしない */
export function isFirstContactPropertyNomination(scene: FirstContactSceneLite): boolean {
  if (!scene) return false;
  if (scene.reason !== "property_nomination") return false;
  return scene.property_by === "image" || scene.property_by === "url";
}

export function resolveFirstContactPickup(i: FirstContactPickupInput): FirstContactPickup {
  // 1) 条件フォーム（または LLM が物件送付／検索を選んだ）→ 物件ピックアップ（2026-09-12 竹内方針・現行のまま）
  if (i.custSentConditionForm || i.finalAix === "property_send" || i.finalAix === "property_search") return "property_send";
  // 2) 物件の画像／URL の指名 → 募集状況の確認（2026-09-23 追加）
  //    ⚠ 線は薄い（n=3〜6）: 最初の返信は募集状況確認の宣言 3/4 だが、押した AIX は estimate_sheet 3/3（property_check_result 0）。
  //      設計知見「費用を聞かれても実務は先に募集状況の確認を報告してから見積書」に沿って要対応は「物件確認した」にし、
  //      効いたかは aix_action_items.done_matched で測る（反証者の指摘: brain_decision_logs.matched では測れない）
  if (isFirstContactPropertyNomination(i.sceneEvidence)) {
    if (i.sceneEvidence?.property_by === "image" && NON_PROPERTY_IMAGE_TYPES.has((i.imageType ?? "").trim().toLowerCase())) return null;
    return "property_check_result";
  }
  // 3)〜5) それ以外は null（挨拶下書きだけ）。condition_hearing は線が引けないので足さない（監査で止めた判断）
  return null;
}

/**
 * brain_decision_logs に残す suggested_action。action が無い初回ガードの行は first_contact_pickup を書く
 * （2026-09-23: これが無かったので「提案なし」に数えられていた。decision_source=guard:first_contact で見分けられる）
 */
export function firstContactSuggestedAction(action: string | null | undefined, pickup: string | null | undefined): string | null {
  if (typeof action === "string" && action) return action;
  if (typeof pickup === "string" && pickup) return pickup;
  return null;
}
