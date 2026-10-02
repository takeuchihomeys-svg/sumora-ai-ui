// app/lib/two-stage.ts
// 2026-10-02 竹内さんの決定（⑫の判断待ち①）「それで大丈夫。言い回しも実際のLINEにある」:
//   送れる物がまだ無い時（物件ピックアップの物件が売上サポに無い・確認の結果が無い・御見積書が無い）は、今の一手を**約束の返信**にする
//   （「お探しします／確認させて頂きます／御見積書作成しお送りさせて頂きます」）。返信は関所が通せば自動送信の候補。
//   AIX は、その約束を送った後に既にある約束の仕組み（行動台帳の promised → brain-core の promise:*）が立てる。
// 線（本番 30日・scripts/audit-brain-vs-staff-matrix.ts）: ブレイン=物件ピックアップ 234番 → スタッフ まず手打ち 132（探す宣言 94）・その場で物件の AIX 47／
//   物件確認した 150 → 手打ち 56・物件確認した 27／見積書送る 74 → 手打ち 34・見積書 17（どれも「先に約束・後で AIX」が多数）。
//   確認の「その場で物件確認した」と「約束の返信」は時刻・平日／土日・持ち込みかで分けても入れ替わらない（平日 10〜18時の持ち込み その場で 19・約束 24・
//   scripts/audit-promise-wording.ts）＝すぐ確かめられるかはデータから決められない → いつも約束の返信を先に（結果が出たら AIX）。
// 前の決まりとのぶつかり（竹内さんの指示「送れる物が無い時だけ狭める」）:
//   ・条件の言い直し → 物件ピックアップ … 売上サポに送れる物件（未送付のピックアップ）がある時は今まで通り AIX
//   ・お客様の持ち込みの物件 → 物件確認した … 確認の約束を既にしている（promise:check・correction:check_already_declared）時は今まで通り AIX
//   ・約束を果たす AIX（promise:*）・まだ送っていないピックアップの約束（signal:pending_pickup）・締めの後の待ち（rule:closed_ack_wait）は触らない
// 言い回し（人が書いた送信だけ・AI の下書きのままの送信を除く・120日・scripts/audit-promise-wording.ts の多い形）:
//   確認: 「お部屋の募集状況確認させていただきます！！」33・「確認出来次第ご連絡させて頂きます！！」25
//   ピックアップ: 「〇〇さんご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます！！」・「〇〇さんにオススメできるお部屋ピックアップさせていただきます！！」
//   見積書: 「最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！」・「お部屋の募集状況と最大限割引させて頂いたお見積書お送りさせていただきます！！」
export type TwoStageKind = "pickup" | "check" | "estimate";
export type TwoStageInput = {
  finalAix: string | null;
  decisionSource: string | null;
  /** 売上サポに送れる物件（未送付のピックアップ）がある */
  pickupReady: boolean;
  /** 申込以降の会話 */
  postApply: boolean;
  /** お客様が今回 初期費用・見積を聞いている（確認と見積をまとめて約束する） */
  asksCost?: boolean;
  /** 見積もる物件名（主のお部屋の見積の依頼・brain-core の focusedEstimateOverride） */
  estimateTarget?: string | null;
  /** 今回のお客様の発言（お仕事面のサポートの質問かを見る） */
  customerText?: string | null;
};

// 2026-10-02 ⑫ 最後の確かめ（Claude）: 夜職のアリバイ会社の質問で、確認の約束の方向から「アリバイ会社の利用可否を管理会社に確認させて頂きます」と書いた（2回）。
//   実送信（お客様がアリバイ・勤務先の用意を聞いた 9番）: スタッフは「お仕事面こちらでサポートさせて頂きます😊！！」「お仕事先こちらでご用意させて頂きます」と答え、
//   線（お客様の発言で当たる 11通を目で読んだ）: 「在籍確認」は管理会社・保証会社の名前を聞く質問（確認が要る）だったので外した。「アリバイ」の語を書いた送信は全期間で 2通・「管理会社に確認」は 0 ＝ 確認の約束にしない。お仕事面のサポートを伝える返信（自動では送らない＝約束が無いので関所 ⑥-4 が人に残す）
export const WORK_SUPPORT_ASK_RE = /アリバイ|勤務先[^\n。]{0,12}(?:用意|工作|空欄)|お仕事(?:先|面)[^\n。]{0,8}(?:用意|サポート)/;
export type TwoStageVerdict = { kind: TwoStageKind; direction: string; keyTopic: string; source: string };

const KEEP_SOURCE_RE = /^(?:promise:|signal:pending_pickup|rule:closed_ack_wait|correction:check_already_declared)/;

export const TWO_STAGE_WORDING: Record<TwoStageKind, string> = {
  pickup: "〇〇さんご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます！！",
  check: "お部屋の募集状況確認させていただきます！！確認出来次第ご連絡させて頂きます！！",
  estimate: "最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！",
};

/** 今の一手を約束の返信にするか（する時は返信の方向と必須の話題）。しない時は null（AIX のまま） */
// 2026-10-02 ⑫ 19巡（flow18_t10）: 「こちらも一緒にお願いします。10/7水曜の午前中であれば助かります」に、約束の方向（募集状況の確認）だけを書いて
//   内覧の日時のご希望に触れなかった。同じ発言の他のご希望・質問にも一言ずつ応える（約束の中身は変えない・答えの事実は作らない）
export const TWO_STAGE_ALSO_ANSWER = "同じ発言の他のご希望・ご質問（内覧の日時のご希望など）にも一言ずつ応える（例: ご希望の日時でご案内出来るよう合わせて確認する）。";
export function resolveTwoStage(i: TwoStageInput): TwoStageVerdict | null {
  const v = resolveTwoStageCore(i);
  return v ? { ...v, direction: `${v.direction}${TWO_STAGE_ALSO_ANSWER}` } : null;
}
function resolveTwoStageCore(i: TwoStageInput): TwoStageVerdict | null {
  const a = (i.finalAix ?? "").trim();
  if (!a || i.postApply) return null;
  if (KEEP_SOURCE_RE.test(i.decisionSource ?? "")) return null;
  if (a === "property_send" || a === "property_recommendation" || a === "property_search") {
    if (i.pickupReady) return null;
    return {
      kind: "pickup",
      direction: "新しいご条件（言い直し・追加があればその条件を具体的に）でお部屋をピックアップしてお送りすると約束する返信にする（物件名・家賃は書かない・送るのは後で AIX）。言い方は実際の送信の形「〇〇さんご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます！！」",
      keyTopic: "お部屋ピックアップしお送りする約束",
      source: "rule:two_stage_promise(pickup)",
    };
  }
  // 2026-10-02 ⑫ 20巡（other_45）: 同じアリバイの質問にブレインが AIX【保証会社について】を選んだ（本番の押下は 200日で 0・スタッフはお仕事面のサポートの手打ち）
  if (a === "property_check_result" || a === "acknowledge_check" || (a === "guarantor_info" && WORK_SUPPORT_ASK_RE.test(i.customerText ?? ""))) {
    if (WORK_SUPPORT_ASK_RE.test(i.customerText ?? "")) {
      return {
        kind: "check",
        direction: "お仕事面は弊社でサポートさせて頂く事を伝える返信にする（実際の送信の形「お仕事面こちらでサポートさせて頂きます😊！！」）。『アリバイ』の語・管理会社に確認・審査の見込みは書かない",
        keyTopic: "お仕事面のサポート",
        source: "rule:two_stage_promise(work_support)",
      };
    }
    return {
      kind: "check",
      // 2026-10-02 ⑫ 17巡: 元が AIX【確認します】（ack_to_check）の時は物件の募集状況とは限らない（夜職の審査・設備・ペットの可否など）。
      //   「募集状況確認させて頂きます」に寄せると聞かれていない事を約束し、管理会社に聞くべきでない事（アリバイ会社など）まで
      //   「管理会社に確認」と書いた（16巡 other_45）→ 聞かれた事そのものを確認する約束に（言い方の結びは同じ実送信の形）
      direction: /ack_to_check/.test(i.decisionSource ?? "") && !i.asksCost
        ? "お客様に聞かれた事（その中身を具体的に・物件の事なら物件名も）を確認すると約束する返信にする（結果は書かない・聞かれていない募集状況は書かない・誰に確認するかは書かない）。結びは実際の送信の形「確認出来次第ご連絡させて頂きます！！」"
        : i.asksCost
        ? "お送り頂いた物件の募集状況と最大限割引した初期費用の御見積書をお送りすると約束する返信にする（結果・金額は書かない）。言い方は実際の送信の形「お部屋の募集状況と最大限割引させて頂いたお見積書お送りさせていただきます！！」"
        : "物件の募集状況を確認すると約束する返信にする（結果は書かない・確かめた後で AIX【物件確認した】）。言い方は実際の送信の形「お部屋の募集状況確認させていただきます！！確認出来次第ご連絡させて頂きます！！」",
      keyTopic: i.asksCost ? "募集状況と御見積書をお送りする約束" : /ack_to_check/.test(i.decisionSource ?? "") ? "聞かれた事を確認する約束" : "募集状況を確認する約束",
      source: "rule:two_stage_promise(check)",
    };
  }
  if (a === "estimate_sheet") {
    const target = (i.estimateTarget ?? "").trim();
    return {
      kind: "estimate",
      direction: `${target ? `${target}の` : ""}最大限割引した初期費用の御見積書を作成しお送りすると約束する返信にする（金額は書かない・送るのは後で AIX【見積書送る】）。言い方は実際の送信の形「最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！」`,
      keyTopic: "御見積書を作成しお送りする約束",
      source: "rule:two_stage_promise(estimate)",
    };
  }
  return null;
}
