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
  /** 今回のお客様の発言がお礼・了承だけで、こちらの最後の発言がまだ果たしていない約束（ピックアップ・確認・見積書）そのもの（3巡目 10/07） */
  ackRightAfterPromise?: boolean;
  /** 今回お客様が物件を送ってきた（持ち込み・URL／物件の画像）。ask＝お客様の言葉（broughtPropertyAsk）・count＝件数（broughtPropertyCount）。10/07 */
  brought?: { ask: BroughtAsk; count: number } | null;
  /** 室内写真の依頼の番（ブレインの S11）。atHand＝頼まれた物件の室内イメージが手元にある（room-photo-material.photoMaterialAtHand）。5巡目 10/07 */
  roomPhoto?: { atHand: boolean; why?: string } | null;
  /** 内覧の希望（日時の指定なし・内覧できるかまだ確かめていない）に、まず内覧できるかの確認の約束を挟む（viewing-check-first.viewingCheckFirst）。5巡目 10/07 */
  viewingCheckFirst?: boolean;
  /** 6巡目: 内覧を希望されたお部屋が退去予定か（viewingRoomVacating）。false（VIEWING_CHECK_VACATING_ONLY=off で今見られる部屋に確認を挟む時）は 5巡目の文 */
  viewingCheckVacating?: boolean;
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
  // 10/07: 見積の約束の手打ち（scripts/audit-estimate-promise-first.ts --wording）は「初期費用の」を入れる形が多数
  estimate: "最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！",
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
  // 2026-10-02 ⑫ 22巡の分類（B: flow2_t02）＋本番 60日（scripts/audit-pickup-promise-vs-shared.ts）:
  //   前のピックアップの約束（promise:pickup・signal:pending_pickup）で物件の AIX を出した番で、売上サポに送れる物件が無い時（120番）は、
  //   スタッフが物件の AIX を押したのは 22（18%）・手打ち 92（「〜ピックアップしてお送りさせて頂きます」の約束の言い直しが中心）。
  //   送れる物件がある時（25番）も押したのは 5＝こちらは今まで通り AIX に残す（件数が少なく線を引けない）。お客様が物件を送ってきたかでは差が無かった（18%／18%）。
  //   → 送れる物件が無い時のピックアップの約束も2段（約束の返信）にする。約束は台帳に残り、AIX要対応の取り下げも pending_pickup で止まる（brain-core）
  const pickupPromiseNotReady = /^(?:promise:pickup|signal:pending_pickup)/.test(i.decisionSource ?? "") && !i.pickupReady
    && (a === "property_send" || a === "property_recommendation" || a === "property_search");
  // 2026-10-07 3巡目（道の違いの直し）: 約束の直後のお礼・了承だけの番は約束の言い直しの返信にしない（AIX のまま＝下書きを作らず約束を果たすのを待つ）。
  //   本番 120日（scripts/audit-ack-after-promise-silent.ts）: ピックアップの約束の直後のお礼 199番＝スタッフは何も打たずに後で AIX・資料で果たす 159（80%・中央 6.4時間後）・手打ちの受け 40（20%）。
  //   10/03〜の道の違い（scripts/audit-path-gap-by-scene.ts）の短いお礼の外れ（AI=返信→人=AIX）の形。設計知見 a92ec31b「約束の後のお礼・了承だけの番は約束の AIX のまま」と同じ向き
  //   （⑫22巡の pickupPromiseNotReady は了承以外の発言も混ぜた 120番で引いた線＝了承だけの番はこちらが多数）。戻す: TWO_STAGE_ACK_WAIT=off
  if (pickupPromiseNotReady && i.ackRightAfterPromise && (typeof process === "undefined" || (process.env?.TWO_STAGE_ACK_WAIT ?? "").toLowerCase() !== "off")) return null;
  // 2026-10-07 5巡目（竹内さん「AIX を直接出す」）: 室内写真の依頼（ブレインの S11＝property_check_result/interior_photo）で、
  //   頼まれた物件の室内イメージが手元にある（こちらが送った物件＝資料がありサイトの室内イメージを送れる・既に送った室内イメージ）時は
  //   AIX【物件確認した→室内写真を確認した】を直接（2段にしない）。無い時（お客様の持ち込み・建築中・物件が分からない）は
  //   「室内のお写真撮影出来次第お送りさせて頂きます」の約束（撮影後に AIX）。線 scripts/audit-photo-material-at-hand.ts（365日 31通:
  //   手元にある 19 → スタッフの最初の返し 直接 11・撮影 4・他 4／無い 12 → 直接 2・撮影 1・他 9）。戻す: ROOM_PHOTO_AT_HAND=off（いつも約束）
  if (i.roomPhoto && a === "property_check_result" && (typeof process === "undefined" || (process.env?.ROOM_PHOTO_AT_HAND ?? "").toLowerCase() !== "off")) {
    if (i.roomPhoto.atHand) return null;
    return {
      kind: "check",
      direction: "室内の写真はスタッフが撮影してお送りする物なので、撮影の約束の返信にする（実際の送信の形「かしこまりました！！室内のお写真撮影出来次第お送りさせて頂きます😊！！」・撮影の日時は書かない・写真の有無は断定しない・建築中など物件固有の理由が会話にある時だけその理由を書く。送るのは撮影の後で AIX【物件確認した→室内写真を確認した】）",
      keyTopic: "室内のお写真撮影出来次第お送りする約束",
      source: "rule:two_stage_promise(room_photo_shoot)",
    };
  }
  if (KEEP_SOURCE_RE.test(i.decisionSource ?? "") && !pickupPromiseNotReady) return null;
  // 2026-10-07 5巡目（竹内さん「内覧できるか確認」）: 内覧の依頼（日時の指定なし）には、まず内覧できるかの確認の約束（確認後に AIX【内覧調整】）。
  //   日時の指定・変更は AIX【内覧調整】を直接（3巡目の決め・viewing-check-first が外す）。実例 9b9b81ba 10/02 19:02「こちら内覧希望です」→
  //   スタッフ「高殿サンク内覧可能か確認させていただきます！！」→ 翌日「お申込が入り、現在内覧出来ない」（ブレインは内覧調整＝候補日を出していた）。
  //   ⚠ 線（scripts/audit-viewing-wish-first-step.ts・180日 279番）: スタッフが最初に確認の約束をしたのは 8番・候補日の打診（内覧調整）は 101番＝今までの人の形とは違う（竹内さんの決め）。戻す: VIEWING_CHECK_FIRST=off
  //   6巡目（10/07 竹内さん「１退去予定ではない場合は内覧誘導する」）: 確認を挟むのは退去予定（入居中）のお部屋だけ（viewing-check-first.viewingRoomVacating）。
  //   今見られるお部屋は AIX【内覧調整】で候補日を出す＝内覧誘導（ここでは null）。文は退去予定の実送信の形（「退去予定のお部屋となり…内覧可能日確認し」「管理会社に内覧開始日確認させていただきます」）
  if (a === "viewing_invite") {
    if (!i.viewingCheckFirst) return null;
    return {
      kind: "check",
      direction: i.viewingCheckVacating === false
        ? "お客様が内覧を希望している。候補日はまだ出さず、まずそのお部屋のご内覧が可能か（募集状況・退去前か・内覧開始日）を確認すると約束する返信にする（実際の送信の形「かしこまりました😊！！〇〇（物件名）内覧可能か確認させていただきます！！確認出来次第ご連絡させて頂きます！！」・物件名は会話から分かる時だけ・日時や候補日は書かない・確認の後で AIX【内覧調整】）"
        : "お客様が内覧を希望しているが、そのお部屋は退去予定（入居中）でまだ内覧できるか分からない。候補日はまだ出さず、管理会社に内覧開始日（ご内覧可能日）を確認すると約束する返信にする（実際の送信の形「かしこまりました😊！！〇〇（物件名）退去予定のお部屋となりますので、管理会社に内覧開始日確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」・物件名は会話から分かる時だけ・退去予定日や内覧開始日・候補日は書かない（確認の後で AIX【内覧調整】））",
      keyTopic: "ご内覧可能か確認する約束",
      source: "rule:two_stage_promise(viewing_check)",
    };
  }
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
  // 2026-10-07 竹内さん（けんじじ 10/7: AI「こちらのお部屋の募集状況確認させていただきます！！」→ スタッフ「2部屋の最大限割引させていただいたお見積書お送りさせていただきます😊！！」）
  //   「物件確認のことはLINEから読み取る、募集状況確認の場合と割引の場合あるけど、基本的には募集状況と最大限割引した初期費用の御見積書を両方おくる形」。
  //   線（scripts/audit-brought-property-promise.ts・120日・申込前の持ち込み 326番）: 後で果たした形（48時間以内）は お客様の言葉が
  //   費用だけ 37/70・空きだけ 41/69・両方 37/58・言葉なし 56/129 で「両方」がどれも一番多い（費用だけでも見積だけは 14・空きだけでも確認だけは 10）
  //   → 持ち込みの番の約束は いつも「募集状況の確認＋最大限割引した初期費用の御見積書」の両方（お客様が聞いた方を先に・件数が2件以上なら「2件の」）。
  //   後で果たす AIX は 物件確認した（ピッカー「物件あった」は御見積書を同封・aix-pickers）＝ aix-task-link の確認＋見積の約束→物件確認した のまま。
  //   旧: LLM が物件確認したを選ぶと「募集状況確認」だけ・見積書送るを選ぶと「御見積書」だけの約束になった。戻す: TWO_STAGE_BROUGHT_BOTH=off
  const broughtBoth = !!i.brought && i.brought.count > 0 && (a === "property_check_result" || a === "acknowledge_check" || a === "estimate_sheet")
    && !WORK_SUPPORT_ASK_RE.test(i.customerText ?? "")
    && (typeof process === "undefined" || (process.env?.TWO_STAGE_BROUGHT_BOTH ?? "").toLowerCase() !== "off");
  if (broughtBoth && i.brought) {
    const n = i.brought.count;
    const obj = n >= 2 ? `お送り頂きました${n}件の` : "お送り頂きました物件の";
    const order = i.brought.ask === "cost" ? "（お客様が初期費用・見積を聞いているので御見積書の事を先に書いてもよい）" : "";
    return {
      kind: "check",
      direction: `お客様が送ってきた物件の募集状況を確認し、最大限割引した初期費用の御見積書と両方お送りすると約束する返信にする（結果・金額は書かない・送るのは後で AIX【物件確認した】＝御見積書同封）${order}。${n >= 2 ? `件数は「${n}件」（それぞれ）と書く。` : ""}言い方は実際の送信の形「${obj}募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！」`,
      keyTopic: n >= 2 ? `${n}件の募集状況と御見積書をお送りする約束` : "募集状況と御見積書をお送りする約束",
      source: "rule:two_stage_promise(brought_both)",
    };
  }
  if (a === "property_check_result" || a === "acknowledge_check" || (a === "guarantor_info" && WORK_SUPPORT_ASK_RE.test(i.customerText ?? ""))) {
    if (WORK_SUPPORT_ASK_RE.test(i.customerText ?? "")) {
      return {
        kind: "check",
        direction: "お仕事面は弊社でサポートさせて頂く事を伝える返信にする（実際の送信の形「お仕事面こちらでサポートさせて頂きます😊！！」）。『アリバイ』の語・管理会社に確認・審査の見込みは書かない",
        keyTopic: "お仕事面のサポート",
        source: "rule:two_stage_promise(work_support)",
      };
    }
    // 3巡目（10/07・AIX の判断のずれ A2 1468132d）: LLM が物件確認したを選んだ番でも、お客様の文が募集状況の問い・物件の持ち込みでない質問
    //   （設備・入居日・保証会社・手続き…）なら「募集状況を確認する約束」にしない＝聞かれた事の答え（資料・会話・会社の事実にあれば答える・無ければその事の確認の約束）
    //   旧は ack_to_check の時だけこの形で、LLM の物件確認したは聞かれていない募集状況の約束になった（2段の後 44番中 5番）。戻す: TWO_STAGE_CHECK_BY_QUESTION=off
    const ct = i.customerText ?? "";
    const askedOther = !i.asksCost && !/空い|空き|募集|まだ(?:あり|残)|埋ま|https?:|\[画像\]/.test(ct) && /[?？]|ですか|ますか|でしょうか|かな/.test(ct)
      && (typeof process === "undefined" || (process.env?.TWO_STAGE_CHECK_BY_QUESTION ?? "").toLowerCase() !== "off");
    if (askedOther && !/ack_to_check/.test(i.decisionSource ?? "")) {
      return {
        kind: "check",
        direction: "お客様に聞かれた事に答える返信にする。会話・物件の資料・会社の事実に答えがあればそれで答える（確認の約束にしない）。無い時だけ聞かれた事そのもの（中身を具体的に・物件の事なら物件名も）を確認すると約束する（聞かれていない募集状況は書かない・誰に確認するかは書かない・結びは「確認出来次第ご連絡させて頂きます！！」）",
        keyTopic: "聞かれた事への答え（無ければその事の確認の約束）",
        source: "rule:two_stage_promise(check_question)",
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
      direction: `${target ? `${target}の` : ""}最大限割引した初期費用の御見積書を作成しお送りすると約束する返信にする（金額は書かない・送るのは後で AIX【見積書送る】）。言い方は実際の送信の形「かしこまりました！！${target ? `${target}の` : ""}最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます😊！！」`,
      keyTopic: "御見積書を作成しお送りする約束",
      source: "rule:two_stage_promise(estimate)",
    };
  }
  return null;
}

/**
 * 2026-10-06 ⑫ 竹内さん（ゆいと 10/03「ここは最短11月中旬でしょうか？」「10月後半くらいに入れるところとかありますか？」）:
 *   「11月中旬か聞かれていて、資料には11月中旬が入居時期とかかれているので、11月中旬が入居と伝える事と、10月後半入居できる物件探す旨を伝える形」。
 *   2段（ピックアップの約束）にした番で、約束の材料と別のお客様の質問（「〜でしょうか？」）を必須の話題に足す（答えは会話にある事実で）。
 *   実送信（10/03 06:40）は「…最短で11月中旬でのご入居となります！！／かしこまりました！！10月後半ご入居可能なお部屋も…ピックアップ」＝質問に先に答えていた
 */
export function twoStageOtherQuestions(customerTurn: string | null | undefined, kind: TwoStageKind): string[] {
  const sents = String(customerTurn ?? "").split(/\n+|(?<=[？?])/).map((x) => x.trim()).filter((x) => /[？?]$/.test(x));
  // 約束が答えになる問い（ピックアップ＝「〜ところありますか」・確認＝「空いてますか」）は除く
  // 10/07: 確認の約束は持ち込み・費用の質問で御見積書もまとめて約束する（brought_both・asksCost）ので、確認の時も費用の問いは約束が答え
  const promiseQ = kind === "pickup" ? /(?:ところ|お部屋|部屋|物件)[^？?]{0,10}(?:あり|ない)|ありますか|ないですか/ : kind === "check" ? /空い|空き|募集|見積|初期費用|いくら/ : /見積|初期費用|いくら/;
  return sents.filter((x) => !promiseQ.test(x)).slice(0, 2).map((q) => `お客様の質問「${q.slice(0, 30)}」への答え（会話・資料にある事実で。無ければ確認の約束）`);
}

/**
 * 売上サポに「今送れる」ピックアップがあるか（3巡目・2026-10-07・AIX の判断のずれの調査 096fe0ed／竹内さん「１それで大丈夫」）。
 *   旧は property_pickups の pending の有無だけ＝スタッフが選ばなかった候補が pending のまま溜まり（2,347行・98会話・80会話は一番新しい候補が3日超）、
 *   一度ピックアップした会話ではずっと「送れる物がある」になって2段（約束の返信）が効かなかった（2段の後の物件の AIX 11番すべて）。
 *   → 新しさで決める: expired_at なし・最後に物件を送った時刻より後に作った・作ってから PICKUP_FRESH_DAYS 日以内。戻す: PICKUP_READY_FRESH=off
 */
export const PICKUP_FRESH_DAYS = 3;
export function freshPickupReady(rows: ReadonlyArray<{ created_at: string; expired_at?: string | null }>, o: { lastPropertiesSentAt: string | null; nowMs: number; env?: Record<string, string | undefined> }): boolean {
  if (((o.env ?? (typeof process !== "undefined" ? process.env : {})).PICKUP_READY_FRESH ?? "").toLowerCase() === "off") return rows.length > 0;
  const sentMs = o.lastPropertiesSentAt ? Date.parse(o.lastPropertiesSentAt) : NaN;
  return rows.some((r) => {
    if (r.expired_at) return false;
    const c = Date.parse(r.created_at);
    if (!Number.isFinite(c) || o.nowMs - c > PICKUP_FRESH_DAYS * 86_400_000) return false;
    return !Number.isFinite(sentMs) || c > sentMs;
  });
}

/**
 * お客様が物件を送ってきた（持ち込み）番で、お客様の言葉が何を聞いているか（2026-10-07 竹内さん「物件確認のことはLINEから読み取る、
 *   募集状況確認の場合と割引の場合あるけど、基本的には募集状況と最大限割引した初期費用の御見積書を両方おくる形」）。
 *   cost＝初期費用・見積・割引だけ／vacancy＝空き・募集・取り扱いだけ／both＝両方／none＝どちらも言っていない（URL・画像だけ・「ここどうですか」）
 */
export type BroughtAsk = "cost" | "vacancy" | "both" | "none";
const BROUGHT_COST_RE = /初期費用|見積|いくら|費用|割引|安く|総額/;
const BROUGHT_VACANCY_RE = /空い|空き|空室|募集|まだ(?:あり|残|大丈夫)|埋ま|取り?扱|紹介(?:して|でき|可能)|住め|入れ(?:ます|る)|申し?込(?:め|み(?:たい|でき))|内[覧見]/;
export function broughtPropertyAsk(turn: string | null | undefined): BroughtAsk {
  // URL・画像の読み取りの文（物件の資料に「初期費用」「募集」の語がある）は除いてお客様の言葉だけを見る
  const own = String(turn ?? "").split(/\n+/).filter((l) => !/https?:\/\/|^\s*\[(?:画像|ファイル)\]/.test(l) && !/^by SUUMO|^\s*[-・]|：|:/.test(l)).join("\n");
  const c = BROUGHT_COST_RE.test(own), v = BROUGHT_VACANCY_RE.test(own);
  return c && v ? "both" : c ? "cost" : v ? "vacancy" : "none";
}
/** 持ち込みの件数（URL・画像の通の数。同じ URL は1件） */
export function broughtPropertyCount(turnMsgs: readonly string[]): number {
  const urls = new Set<string>();
  let images = 0;
  for (const t of turnMsgs) {
    for (const u of t.match(/https?:\/\/[^\s]+/g) ?? []) urls.add(u.replace(/[?#].*$/, ""));
    if (/^\s*\[画像\]/.test(t)) images++;
  }
  return urls.size + images;
}

/**
 * お客様が今回 条件を言い直した・足した番か（5巡目 10/07・竹内さん「条件が変わった時は約束の文を先に出す」）。
 *   ブレインの condition_change_type（ピックアップの依頼 pickup_request は除く）か、場面の判定（reply-scene の conditions）。
 *   true の時は売上サポの候補（前の条件で作った物）が新しくても「今送れる物」にしない（brain-core の pickupReady）
 */
export function conditionChangedThisTurn(conditionChangeType: string | null | undefined, replyScene: string | null | undefined): boolean {
  return /^(?:area_change|rent_change|layout_change|equip_add|condition_relax|multi)$/.test(String(conditionChangeType ?? "")) || replyScene === "conditions";
}
