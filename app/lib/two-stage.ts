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
import { splitRequests } from "./request-ledger";
import { jstParts } from "./jst-date";
import { routeFix1020 } from "./brain-route-fix-1020";
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
  /** 今回のお客様の発言がお礼・了承だけか（10巡目 10/08）。false の時だけ物件の AIX を約束の返信にする（undefined＝今まで通り） */
  ackOnly?: boolean;
  /** こちらが今日（JST）すでにした約束の種類（promiseKindsToday）。同じ日の同じ件の2通目からは約束を挟まず AIX（10巡目 10/08） */
  promisedTodayKinds?: readonly TwoStageKind[];
  /** 今回お客様が物件を送ってきた（持ち込み・URL／物件の画像）。ask＝お客様の言葉（broughtPropertyAsk）・count＝件数（broughtPropertyCount）。10/07 */
  brought?: { ask: BroughtAsk; count: number; /** 10/13: 送って頂いた物件が SNS・TikTok の画面で物件名が無く題だけ（broughtTitleOnly） */ titleOnly?: boolean } | null;
  /** 室内写真の依頼の番（ブレインの S11）。atHand＝頼まれた物件の室内イメージが手元にある（room-photo-material.photoMaterialAtHand）。5巡目 10/07 */
  roomPhoto?: { atHand: boolean; why?: string } | null;
  /** 内覧の希望（日時の指定なし・内覧できるかまだ確かめていない）に、まず内覧できるかの確認の約束を挟む（viewing-check-first.viewingCheckFirst）。5巡目 10/07 */
  viewingCheckFirst?: boolean;
  /** 6巡目: 内覧を希望されたお部屋が退去予定か（viewingRoomVacating）。false（VIEWING_CHECK_VACATING_ONLY=off で今見られる部屋に確認を挟む時）は 5巡目の文 */
  viewingCheckVacating?: boolean;
  /** 2026-10-15 軸: ブレインの turn_contract の先に答える依頼の「何について」（about）。あれば確認の約束の文はこれで決める（語の網は使わない・TWO_STAGE_AXIS=off で前の形） */
  askAbout?: string | null;
  /** 2026-10-18 竹内さん 10/16: 見積もる物件の資料が届いて（こちらが送った・お客様が送った・最後に募集状況を確かめた）からの日数。7日以上なら先に最新の募集状況を確認する旨を伝える */
  estimateMaterialAgeDays?: number | null;
  /** 2026-10-21 見直し: 真の初回（スタッフがまだ何も送っていない・incremental でない）。A1 の AIX 直接の外（初回のガードは2段の後で決まるので decisionSource では見えない） */
  firstContact?: boolean;
};
/** 2026-10-18 竹内さん 10/16「古い資料（届いて7日以上）の物件の見積依頼は『一度最新の募集状況を確認させて頂きます』旨を伝えてから AIX で送る」。戻す ESTIMATE_STALE_RECHECK=off */
export const ESTIMATE_STALE_DAYS = 7;
export function estimateStaleRecheckEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ESTIMATE_STALE_RECHECK ?? "").trim().toLowerCase() !== "off";
}
/** 2026-10-15 軸の直し: 2段の約束の文をブレインの about に従わせる（既定 on） */
export function twoStageAxisEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TWO_STAGE_AXIS ?? "").trim().toLowerCase() !== "off";
}

// 2026-10-02 ⑫ 最後の確かめ（Claude）: 夜職のアリバイ会社の質問で、確認の約束の方向から「アリバイ会社の利用可否を管理会社に確認させて頂きます」と書いた（2回）。
//   実送信（お客様がアリバイ・勤務先の用意を聞いた 9番）: スタッフは「お仕事面こちらでサポートさせて頂きます😊！！」「お仕事先こちらでご用意させて頂きます」と答え、
//   線（お客様の発言で当たる 11通を目で読んだ）: 「在籍確認」は管理会社・保証会社の名前を聞く質問（確認が要る）だったので外した。「アリバイ」の語を書いた送信は全期間で 2通・「管理会社に確認」は 0 ＝ 確認の約束にしない。お仕事面のサポートを伝える返信（自動では送らない＝約束が無いので関所 ⑥-4 が人に残す）
export const WORK_SUPPORT_ASK_RE = /アリバイ|勤務先[^\n。]{0,12}(?:用意|工作|空欄)|お仕事(?:先|面)[^\n。]{0,8}(?:用意|サポート)/;
export type TwoStageVerdict = { kind: TwoStageKind; direction: string; keyTopic: string; source: string; /** 同じ返信でまとめて足した約束（TWO_STAGE_MULTI_PROMISE・10/09。10/13 からは2通目の約束だけ） */ extraPromises?: string[]; /** この返信では約束せず後に回した依頼（10/13 竹内さん・TWO_STAGE_PROMISE_SEQUENCE） */ laterPromises?: string[] };

// 10巡目（10/08）: rule:further_discount_daihyo＝御見積書の後の「更に安く」は AIX【確認します→代表確認（初期費用）】のまま（further-discount.ts）
const KEEP_SOURCE_RE = /^(?:promise:|signal:pending_pickup|rule:closed_ack_wait|correction:check_already_declared|rule:further_discount_daihyo)/;

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
  if (v && sameDayDirect(v, i)) return null;
  if (!v) return null;
  if (!promiseSequenceEnabled()) {
    // 旧（10/09）: 同じ連投の別の依頼を「あわせて」で最大5つ同じ返信に足す
    const extra = multiPromiseExtras(v, i);
    if (extra.length) {
      return {
        ...v,
        direction: `${v.direction}${TWO_STAGE_ALSO_ANSWER}${multiPromiseDirection(extra)}`,
        keyTopic: `${v.keyTopic}＋あわせて${extra.map((x) => x.what).join("・")}の約束`,
        extraPromises: extra.map((x) => x.kind),
      };
    }
    return { ...v, direction: `${v.direction}${TWO_STAGE_ALSO_ANSWER}` };
  }
  const plan = planPromiseSequence(v, i);
  if (!plan) return { ...v, direction: `${v.direction}${TWO_STAGE_ALSO_ANSWER}` };
  return {
    ...v,
    direction: `${v.direction}${plan.later.length ? "同じ発言の他のご質問のうち、会話・資料・会社の事実で答えられる物（例 敷金礼金・初期費用に含まれるか）にだけ一言で答える（下の後に回す依頼は除く）。" : TWO_STAGE_ALSO_ANSWER}${plan.direction}`,
    keyTopic: plan.second ? (plan.second.kind === "wish" ? `${v.keyTopic}＋2通目に${plan.second.what}` : `${v.keyTopic}＋2通目にあわせまして${plan.second.what}の約束`) : v.keyTopic,
    ...(plan.second ? { extraPromises: [plan.second.kind] } : {}),
    ...(plan.later.length ? { laterPromises: plan.later.map((x) => x.kind) } : {}),
  };
}

// ─── 2026-10-21 竹内さん A1「すぐAIXでかえす」（設計知見 5aa28356・10/02「いつも約束を先に」を改める）────────────────
//   管理会社に確かめれば分かる問い（空き状況・見積・設備・条件）は約束の返信（2段 check・estimate）を挟まず、AIX【物件確認した／見積書送る】を直接出す。
//   実送信: 空きの問いに約束を挟んだのは2回・すぐ AIX が16回（スタッフだけが知る番 91 のうち 36 がこの型）。
//   対象の2段: 持ち込み（brought_both→物件確認した・brought_estimate→見積書送る）・募集状況の確認（check）・聞かれた事の確認（check_question）・見積（estimate）。
//   対象外（約束のまま）: 初回の挨拶の番（guard:first_contact）・古い資料の見積（estimate_stale＝10/16 竹内さんの決定「最新の募集状況を確認する旨を伝えてから AIX」）・
//     室内写真の撮影・内覧できるかの確認（退去予定）・お仕事面のサポート・ピックアップ。
//   戻す: TWO_STAGE_ANSWERABLE_DIRECT=off（2段の約束の返信に戻す）
export function answerableDirectEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TWO_STAGE_ANSWERABLE_DIRECT ?? "").trim().toLowerCase() !== "off";
}
const ANSWERABLE_DIRECT_SOURCES = /^rule:two_stage_promise\((?:brought_both|brought_estimate|check|check_question|estimate)\)$/;
// 2026-10-21 見直し（本番 30日の check_question 16番: スタッフは会話・会社の事実で手打ちの答え 8・確認の約束 2・別の AIX 2・送信なし 4＝物件確認した直接は外れが多い／B4「質問内容による」）:
//   募集状況・見積でない「聞かれた事」（check_question）と、元が AIX【確認します】の聞かれた事の確認（ack_to_check・費用なし）は2段のまま
//   （答えがあれば答える・無ければその事の確認の約束）。入れる TWO_STAGE_ANSWERABLE_DIRECT_QUESTION=on
function answerableDirectQuestionEnabled(env?: Record<string, string | undefined>): boolean {
  return ((env ?? (typeof process !== "undefined" ? process.env : {})).TWO_STAGE_ANSWERABLE_DIRECT_QUESTION ?? "").trim().toLowerCase() === "on";
}
/** 2段の判定（core）が確認・見積の約束を出した番を、AIX 直接にする時の AIX のキー（しない時 null） */
export function answerableDirectAix(v: TwoStageVerdict | null, i: Pick<TwoStageInput, "decisionSource" | "firstContact" | "asksCost">, env?: Record<string, string | undefined>): string | null {
  if (!v || !answerableDirectEnabled(env)) return null;
  if (i.firstContact || /^guard:first_contact/.test(i.decisionSource ?? "")) return null;
  if (!ANSWERABLE_DIRECT_SOURCES.test(v.source)) return null;
  if (!answerableDirectQuestionEnabled(env)) {
    if (/check_question/.test(v.source)) return null;
    if (/\(check\)$/.test(v.source) && /ack_to_check/.test(i.decisionSource ?? "") && !i.asksCost) return null;
  }
  return v.kind === "estimate" ? "estimate_sheet" : "property_check_result";
}
/** brain-core が使う形: 2段の約束の返信（verdict）か、AIX 直接（direct＝AIX のキー・coreSource＝元の2段の出所）か */
export function resolveTwoStageOrDirect(i: TwoStageInput): { verdict: TwoStageVerdict | null; direct: string | null; coreSource: string | null } {
  const core = resolveTwoStageCore(i);
  const direct = answerableDirectAix(core, i);
  if (direct) return { verdict: null, direct, coreSource: core?.source ?? null };
  return { verdict: resolveTwoStage(i), direct: null, coreSource: null };
}

/**
 * 2026-10-13 竹内さん（いしのまさや: 初回に TikTok の物件の画像2件＋「初期費用を安く・敷金礼金なし…良い物件ありますでしょうか？」→ 下書きが
 *   「…ご連絡させて頂きます！！ご質問ありがとうございます！！良い物件ありますでしょうか？とのことですが、北浜以外にも…ピックアップ」と約束を全部詰めた）:
 *   「約束を全部入れない。優先順位で組み立て、順序立てられる時は順に」「物件を2件送ってきたら2件確認する旨」「TikTok のタイトルの時は物件名を言わない」
 *   「要件に合わせて文を分けて送る」「まとめ方は実際の LINE を見れば分かる」。
 *   竹内さんの実送信（scripts/audit-first-turn-split.ts・150日・お客様が物件を送った番 142）:
 *     ・1通 127・2通 13・3通 2。2通に分けたのは「確認」と「探す」の両方を約束した番（初回＋条件フォーム 10番中 2番: b87d85・fb8043）で、
 *       1通目＝挨拶＋送って頂いた物件の募集状況確認、2通目＝「あわせまして／あわせて〈エリア〉周辺全域から…ご条件に合ったお部屋もピックアップ」。書いた順はいつも確認が先
 *     ・探す約束を書いたのはお客様の希望のエリア・条件が分かっている番（フォームのエリア欄・会話のエリア）。エリアが分からない番で探す約束をした実送信は無い
 *       → エリアが分からない時は探す約束をしない（確認の結果を AIX で送った後に AIX【条件ヒアリング】＝約束の続きの順番に回す・竹内さん①）
 *     ・物件2件以上 64番: 件数を言った 13（「お送り頂きました2件、募集状況確認」）・総称 22（「お送り頂きました物件全て」）。
 *       SNS・TikTok の画像 7番: 物件名を言わず総称（「TikTokの物件につきまして」「お送り頂きました物件」）
 *   → この返信で約束するのは順序の先頭（主の約束）と同じ種類だけ（確認＋御見積書は同じ流れ・件数をまとめる）。
 *     探す依頼: エリア・条件が分かれば2通目「あわせまして…」で約束、分からなければ後（条件ヒアリング）。内覧・写真・条件の確認などの別の依頼は後（約束の続きの順番）。
 *   戻す: TWO_STAGE_PROMISE_SEQUENCE=off（10/09 の「あわせて最大5つ」）／TWO_STAGE_MULTI_PROMISE=off（どちらも足さない）
 */
export function promiseSequenceEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TWO_STAGE_PROMISE_SEQUENCE ?? "").toLowerCase() !== "off";
}
/** お客様の自分の言葉（画像の書き起こし・URL を除く）に希望のエリア・駅が書いてあるか（条件フォームのエリア欄・「〇〇区」「〇〇駅」「〇〇周辺」） */
export function customerAreaKnown(turn: string | null | undefined): boolean {
  const own = String(turn ?? "").normalize("NFKC").split(/\n+/).filter((l) => !/https?:\/\/|^\s*\[(?:画像|ファイル)\]/.test(l)).join("\n");
  if (/【ご希望のエリア[^】]*】\s*⇒\s*[^\s⑥【]/.test(own)) return true;
  return /[\p{Script=Han}\p{Script=Katakana}ぁ-ん]{1,8}(?:区|市|駅|線|周辺|エリア|沿線|方面)(?:[でにのあらか]|$|\s|、|・)/u.test(own.replace(/【[^】]*】/g, ""));
}
export type PromiseSequencePlan = {
  second: { kind: "pickup" | "wish"; what: string } | null;
  later: Array<{ kind: "pickup_hearing" | "viewing" | "photo" | "confirm" | "check"; what: string }>;
  direction: string;
};
export function planPromiseSequence(v: TwoStageVerdict, i: TwoStageInput): PromiseSequencePlan | null {
  if (typeof process !== "undefined" && (process.env?.TWO_STAGE_MULTI_PROMISE ?? "").toLowerCase() === "off") return null;
  if (/work_support|room_photo_shoot|viewing_check/.test(v.source)) return null;
  const items = splitRequests([String(i.customerText ?? "")], new Date(0).toISOString()).filter((x) => !x.deferred && x.topic !== "other");
  const topics = new Set(items.map((x) => x.topic));
  const brought = !!i.brought?.count;
  // 物件の確認の流れ（持ち込み・募集状況・見積）が主の時の「探す」依頼（フォーム・「良い物件ありますか」「他にも」）
  // 条件フォーム（①【ご入居の時期】・【ご希望のエリア】）を送ってきた＝探す依頼（splitRequests はフォームを読まない）
  const wantsPickup = topics.has("pickup") || /良い物件|いい物件|良いお部屋|他にも|ほかにも|他の物件|探して|①|【ご希望のエリア/.test(String(i.customerText ?? ""));
  const checkFlow = v.kind === "check" || v.kind === "estimate";
  let second: PromiseSequencePlan["second"] = null;
  const later: PromiseSequencePlan["later"] = [];
  if (checkFlow && wantsPickup) {
    if (customerAreaKnown(i.customerText)) second = { kind: "pickup", what: "お部屋のピックアップ" };
    else later.push({ kind: "pickup_hearing", what: "ご希望のご条件（エリア等）のヒアリング→ピックアップ" });
  }
  // 10/13 竹内さん②（いしのまさや）: 探す約束を2通目にしない番で、お客様が初期費用・敷金礼金の希望を書いた時は、2通目でその希望を受ける一言
  //   （「1通目 挨拶＋2件の確認と御見積書／2通目 初期費用を安く・敷金礼金なしのご希望を受ける一言」・言い回しは実送信 b87d85・fb8043・631f99・fb8ab8 の
  //    「初期費用も最大限割引させて頂き、〇〇さんのお引越しにかかる費用を出来る限り抑えさせて頂きます！！」）。戻す TWO_STAGE_WISH_BUBBLE=off
  if (!second && checkFlow && brought && wishWords(i.customerText).length && (typeof process === "undefined" || (process.env?.TWO_STAGE_WISH_BUBBLE ?? "").toLowerCase() !== "off")) {
    second = { kind: "wish", what: `ご希望（${wishWords(i.customerText).join("・")}）を受ける一言` };
  }
  if (v.kind === "pickup" && (topics.has("vacancy") || brought)) later.push({ kind: "check", what: "送って頂いた物件の募集状況の確認" });
  if (topics.has("viewing") && !/内覧/.test(v.direction)) later.push({ kind: "viewing", what: "ご内覧の日程" });
  if (topics.has("photo") && !/写真/.test(v.direction)) later.push({ kind: "photo", what: "室内のお写真" });
  if ((topics.has("equipment") || topics.has("contract")) && v.kind !== "check") later.push({ kind: "confirm", what: "聞かれた条件・設備" });
  if (!second && !later.length && !brought) return null;
  const parts: string[] = [];
  const n = i.brought?.count ?? 0;
  if (brought) {
    parts.push(i.brought?.titleOnly
      ? `送って頂いた物件は SNS・TikTok 等の画面で、物件名ではなく題（駅名・キャッチ）しか書かれていない。物件名・駅名・題の言葉で呼ばず「お送り頂きました${n >= 2 ? `${n}件の` : ""}物件」と書く（「〇〇以外にも」等、題の駅名を条件として扱わない）。`
      : n >= 2 ? `送って頂いた物件は${n}件。件数を書く（「お送り頂きました${n}件の物件の募集状況確認させて頂きます」）。` : "");
  }
  if (second?.kind === "wish") {
    parts.push(`【2通に分けて書く（竹内さんの形）】1通目＝挨拶（初回なら）＋送って頂いた物件の募集状況の確認と最大限割引の初期費用の御見積書の約束まで。空行を1つ挟み、2通目は「初期費用も」から書き出し、お客様が書いたご希望（${wishWords(i.customerText).join("・")}）を一言で受ける（実際の送信の形「初期費用も最大限割引させて頂き、〇〇さんのお引越しにかかる費用を出来る限り抑えさせて頂きます！！」。お客様の言葉（敷金礼金なし等）はそのまま使ってよい・新しい決まり文句を作らない・できる／含まれると断定しない）。`);
  } else if (second) {
    parts.push(`【2通に分けて書く（竹内さんの形）】1通目＝${v.kind === "estimate" ? "御見積書" : "送って頂いた物件の募集状況の確認（と最大限割引の初期費用の御見積書）"}の約束まで。空行を1つ挟み、2通目は「あわせまして」から書き出し、お客様のご希望のエリア・ご条件（お客様が書いた物だけ・具体的に）に合ったお部屋もピックアップしお送りする約束（実際の送信の形「あわせまして〈エリア〉周辺全域から、〇〇さんご希望のご条件に合ったお部屋もピックアップしてお送りさせて頂きます！！」）。`);
  }
  if (later.length) {
    parts.push(`【この返信では約束しない（順番の後ろ・確認の結果を AIX で送った後に AIX で順に進める）】${later.map((x) => x.what).join("・")}。この返信ではこれらに触れない（「〜とのことですが」と問いを繰り返さない・「〇〇以外にも」等の探す約束を書かない）。`);
  }
  return { second, later, direction: parts.filter(Boolean).join("") };
}

/** 主の約束に「あわせて」で足す約束の上限（2026-10-09 竹内さん「念のため、あわせて最大5つ」・旧の形＝TWO_STAGE_PROMISE_SEQUENCE=off の時だけ） */
export const TWO_STAGE_MULTI_PROMISE_MAX = 5;
type ExtraPromise = { kind: "check" | "estimate" | "viewing" | "pickup" | "photo" | "confirm"; what: string; wording: string };
// 旧（10/09・TWO_STAGE_PROMISE_SEQUENCE=off）: 同じ連投の別の依頼を同じ返信に「あわせて」で足す
function multiPromiseExtras(v: TwoStageVerdict, i: TwoStageInput): ExtraPromise[] {
  if (typeof process !== "undefined" && (process.env?.TWO_STAGE_MULTI_PROMISE ?? "").toLowerCase() === "off") return [];
  if (/work_support|room_photo_shoot|viewing_check/.test(v.source)) return [];
  const items = splitRequests([String(i.customerText ?? "")], new Date(0).toISOString()).filter((x) => !x.deferred && x.topic !== "other");
  if (items.length < 2) return [];
  const topics = new Set(items.map((x) => x.topic));
  const dir = v.direction;
  const covers = (re: RegExp) => re.test(dir) || re.test(v.keyTopic);
  const out: ExtraPromise[] = [];
  const propertyInPlay = !!i.brought?.count || v.kind === "check" || v.kind === "estimate" || !!(i.estimateTarget ?? "").trim();
  if (topics.has("vacancy") && !covers(/募集状況/)) out.push({ kind: "check", what: "募集状況の確認", wording: "お部屋の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！" });
  if (topics.has("cost") && propertyInPlay && !covers(/御?見積/)) out.push({ kind: "estimate", what: "御見積書", wording: "最大限割引させて頂いた初期費用の御見積書もあわせてお送りさせて頂きます！！" });
  if (topics.has("viewing") && !covers(/内覧/)) out.push({ kind: "viewing", what: "ご内覧の日程", wording: "ご内覧のお日にちもあわせて調整させて頂きます！！" });
  if (topics.has("pickup") && v.kind !== "pickup") out.push({ kind: "pickup", what: "お部屋のピックアップ", wording: "あわせて、〇〇さんご希望のご条件に合ったお部屋もピックアップしてお送りさせて頂きます！！" });
  if (topics.has("photo") && !covers(/写真/)) out.push({ kind: "photo", what: "室内のお写真", wording: "室内のお写真もあわせてお送りさせて頂きます！！" });
  if ((topics.has("equipment") || topics.has("contract")) && v.kind !== "check") {
    out.push({ kind: "confirm", what: "聞かれた条件・設備", wording: "（資料・会話に答えがあればその答え。無ければ）〇〇（聞かれた事）もあわせて確認させて頂きます！！" });
  }
  return out.slice(0, TWO_STAGE_MULTI_PROMISE_MAX);
}
function multiPromiseDirection(extra: readonly ExtraPromise[]): string {
  return `【同じ連投の別の依頼も同じ返信でまとめて約束する（竹内さんの形＝1通にまとめて「あわせて」でつなぐ・結果や金額や日時は書かない・送るのは後で AIX を1つずつ）】${extra.map((x, n) => `${n + 1}. ${x.what}: 「${x.wording}」`).join(" ")}。物件名は会話から分かる時だけ。約束の順は お客様が聞いた順でよい。`;
}

/**
 * 2026-10-08 10巡目（竹内さん「約束の返信を入れて AIX にした方が一貫性があって良い。1日に何度も送ってきている場合は、2通目から直接（AIX）にするなどして分ける」）:
 *   基本は約束の返信→後で AIX のまま。同じお客様が同じ日（JST）に同じ件（確認・見積）でもう一度送ってきた時は、2通目からは約束を挟まず AIX を直接。
 *   「同じ件」＝こちらが今日すでに同じ種類の約束（確認・見積書）をしている。対象は募集状況の確認（持ち込み・空き）と見積書の約束だけ
 *   （聞かれた事への答え check_question・お仕事面・室内写真の撮影・内覧の確認・ピックアップは対象外＝ピックアップは条件の番で約束が 96%）。
 *   戻す: TWO_STAGE_SAME_DAY_DIRECT=off
 */
const SAME_DAY_SOURCES = /^rule:two_stage_promise\((?:check|brought_both|brought_estimate|estimate|estimate_stale)\)$/;
function sameDayDirect(v: TwoStageVerdict, i: TwoStageInput): boolean {
  if (typeof process !== "undefined" && (process.env?.TWO_STAGE_SAME_DAY_DIRECT ?? "").toLowerCase() === "off") return false;
  if (!SAME_DAY_SOURCES.test(v.source)) return false;
  // 2026-10-16 竹内悠馬（10/16 の画面の事例 e・実送信 21:25「本日は管理会社の営業時間が終了しておりますので、明日一番で確認しご連絡させて頂きます」）:
  //   管理会社の営業時間外（18時〜翌9時・日本時間）は今は確認も結果の AIX も送れない＝2通目でも約束の返信のまま（AIX は明日）。戻す TWO_STAGE_SAME_DAY_NIGHT=off
  if ((typeof process === "undefined" || (process.env?.TWO_STAGE_SAME_DAY_NIGHT ?? "").toLowerCase() !== "off")) {
    const h = jstParts().hour;
    if (h >= 18 || h < 9) return false;
  }
  const kinds = i.promisedTodayKinds ?? [];
  return v.kind === "estimate" ? kinds.includes("estimate") : kinds.includes("check") || (v.source.includes("brought_both") && kinds.includes("estimate"));
}

/** こちらが今日（JST・今の番より前）にした約束の種類（確認・見積書・ピックアップ）。brain-core が今日のこちらの文から作って渡す */
const TODAY_CHECK_RE = /(?:募集状況|募集|空室|空き状況|空き|入居可能日|入居日|退去|管理会社|オーナー|お部屋の状況|詳細)[^\n。！!？?]{0,20}確認(?:させて(?:頂|いただ)きます|致します|いたします|します)|確認(?:でき|出来)次第[^\n。！!]{0,12}ご連絡/;
const TODAY_ESTIMATE_RE = /(?:御|お)?見積(?:書|もり|り)?[^\n。！!？?]{0,16}(?:作成|お送り|送らせ|お出し|ご用意|お作り)[^\n。！!？?]{0,10}(?:させて(?:頂|いただ)きます|致します|いたします|します)/;
const TODAY_PICKUP_RE = /ピックアップ[^\n。！!]{0,16}(?:させて(?:頂|いただ)きます|致します|いたします)|お部屋[^\n。！!]{0,20}お送りさせて(?:頂|いただ)きます/;
export function promiseKindsToday(staffMsgs: ReadonlyArray<{ text: string | null; createdAt: string }>, nowMs: number): TwoStageKind[] {
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const today = day(nowMs);
  const out = new Set<TwoStageKind>();
  // 2026-10-15（q155）: 「同じ件」＝今日の約束がまだ続いている物だけ。後のこちらの送信で果たした約束（御見積書を送った・確認の結果を伝えた）は数えない
  //   （別の物件の見積の約束を1分後に果たした日に、お客様が新しい物件の URL を送った番が「2通目」と読まれ、確認の約束を飛ばして AIX になっていた）。
  //   戻す TWO_STAGE_SAME_DAY_OPEN_ONLY=off
  const openOnly = typeof process === "undefined" || (process.env?.TWO_STAGE_SAME_DAY_OPEN_ONLY ?? "").toLowerCase() !== "off";
  const timed = staffMsgs.map((m) => ({ at: Date.parse(m.createdAt), t: String(m.text ?? "").normalize("NFKC") })).filter((m) => Number.isFinite(m.at) && m.at <= nowMs);
  const fulfilledAfter = (at: number, re: RegExp) => openOnly && timed.some((m) => m.at > at && re.test(m.t));
  for (const m of timed) {
    if (day(m.at) !== today) continue;
    if (TODAY_ESTIMATE_RE.test(m.t) && !fulfilledAfter(m.at, ESTIMATE_DELIVERED_RE)) out.add("estimate");
    if (TODAY_CHECK_RE.test(m.t) && !fulfilledAfter(m.at, CHECK_REPORTED_RE)) out.add("check");
    if (TODAY_PICKUP_RE.test(m.t)) out.add("pickup");
  }
  return [...out];
}
/** 御見積書を送った（金額つきの見積の束・「御見積書となります」・「お見積書お送りさせて頂きました」の過去形。打ち間違い「いたままきました」も） */
const ESTIMATE_DELIVERED_RE = /初期費用[:：]\s*[0-9０-９][0-9０-９,，]*円|(?:御|お)見積(?:書|もり)?(?:と|に)なります|(?:御|お)見積(?:書|もり)?[^\n。！!？?]{0,12}(?:お送り|送ら)させて[^\n。！!？?]{0,6}ました/;
/** 確認の結果を伝えた（「確認しましたところ」「確認が取れました」「募集中です／募集終了となって」） */
const CHECK_REPORTED_RE = /確認(?:致し|いたし|させて(?:頂|いただ)き)?ましたところ|確認(?:が)?取れました|(?:募集中|空室|募集終了|募集が終了)(?:です|でした|となって|との事|とのこと)/;
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
  // 2026-10-21 竹内さん A2「AIXでおくる」: ピックアップの約束の後のお礼・了承だけの番は、台帳の最後が約束でなくても（約束の後に別の話を挟んだ 等）約束の言い直しの返信にせず物件の AIX。
  //   戻す ACK_AFTER_PROMISE_REPLY=on（決定 C）
  if (pickupPromiseNotReady && i.ackOnly === true && (typeof process === "undefined" || (process.env?.ACK_AFTER_PROMISE_REPLY ?? "").trim().toLowerCase() !== "on")) return null;
  // 2026-10-09 試験の (d) 型（q095 q100 q105）: こちらが約束した直後のお客様の「よろしく」等の番で、LLM が約束を果たす AIX（見積書送る・物件確認した）を
  //   選んだのに、下の2段が約束の返信に戻していた（もう約束は済んでいる＝言い直しになる・竹内さんは黙って AIX で果たす）。この番は AIX のまま。戻す TWO_STAGE_ACK_FULFIL=off
  if (i.ackRightAfterPromise && (a === "estimate_sheet" || a === "property_check_result" || a === "acknowledge_check")
    && (typeof process === "undefined" || (process.env?.TWO_STAGE_ACK_FULFIL ?? "").toLowerCase() !== "off")) return null;
  // 2026-10-08 10巡目（竹内さん「返信か AIX の判断を先に完全に」）: 物件の AIX（ピックアップ・オススメ・探す）は、お客様の今の発言がお礼・了承だけ
  //   でない番では、売上サポに候補があっても（pickupReady）・前の約束・合図（promise:pickup・signal:pending_pickup）でも、まず約束の返信にする。
  //   線（scripts/audit-r10-path-truth.ts・6/26〜 の全部の番・ピックアップの約束か物件の AIX か）: 条件の番 竹内さん 約束 126／AIX 5・従業員 106／4、
  //   質問 19／11（AIX の 9 は1時間超後）・費用 12／2・内覧 7／2・検討中 7／1・申込 4／0。お礼・了承の番だけ 物件の AIX が多い（竹内さん 39／28＝黙って後で果たす）。
  //   10/02〜の止めすぎ（返信の番に AIX）18番のうち 11番がこの形（LLM の property_send 6・pending_pickup 5＝内覧のキャンセル・内覧のお礼・検討中・エアコンの件など別の話の番）。
  //   お礼・了承の番は今まで通り（AIX のまま＝黙って後で果たす）。戻す: TWO_STAGE_PICKUP_UNLESS_ACK=off
  const pickupUnlessAck = i.ackOnly === false && (a === "property_send" || a === "property_recommendation" || a === "property_search")
    && !/^promise:(?:estimate|check)/.test(i.decisionSource ?? "")
    && (typeof process === "undefined" || (process.env?.TWO_STAGE_PICKUP_UNLESS_ACK ?? "").toLowerCase() !== "off");
  if (pickupUnlessAck) {
    return {
      kind: "pickup",
      direction: "お客様の今の発言（質問・ご希望・ご事情）に先に一言で応え、物件のご紹介が要る時だけ、新しいご条件（言い直し・追加があればその条件を具体的に）でお部屋をピックアップしてお送りすると約束する返信にする（物件名・家賃は書かない・送るのは後で AIX）。言い方は実際の送信の形「〇〇さんご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます！！」",
      keyTopic: "お客様の発言への答え（物件のご紹介が要る時はピックアップしお送りする約束）",
      source: "rule:two_stage_promise(pickup_unless_ack)",
    };
  }
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
    // 2026-10-20 試験の道の外れ（q183・q184・BRAIN_ROUTE_FIX_1020 brought_estimate）: 持ち込みで費用・見積だけを頼んだ番は見積の2段
    //   （竹内さんの実送信「2件とも最大限割引した御見積書を作成しお送り」→ AIX【見積書送る】）。空きも聞いた・言葉なしは今まで通り両方（brought_both）
    //   2026-10-22（いしのまさや 10/08・実送信は「2件の物件の募集状況確認…御見積書とあわせて」＝両方）: 費用の語が
    //   ご希望だけ（「初期費用を安く抑えたい」「敷金礼金なし」）で金額・見積を頼んでいない番は今まで通り両方（broughtCostWishOnly・
    //   戻す BROUGHT_ESTIMATE_WISH_BOTH=off）
    if (i.brought.ask === "cost" && routeFix1020("brought_estimate") && !broughtCostWishOnly(i.customerText)) {
      const obj = n >= 2 ? `お送り頂きました${n}件とも` : "お送り頂きましたお部屋の";
      return {
        kind: "estimate",
        direction: `お客様が送ってきた物件の初期費用・御見積を頼まれている。最大限割引した初期費用の御見積書を作成しお送りすると約束する返信にする（金額は書かない・募集状況は御見積書と一緒に確かめる・送るのは後で AIX【見積書送る】）。${n >= 2 ? `件数は「${n}件」（それぞれ）と書く。` : ""}言い方は実際の送信の形「かしこまりました！！${obj}最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます😊！！」`,
        keyTopic: n >= 2 ? `${n}件とも御見積書を作成しお送りする約束` : "御見積書を作成しお送りする約束",
        source: "rule:two_stage_promise(brought_estimate)",
      };
    }
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
    // 2026-10-15 軸: ブレインが「何について」を決めていればそれで分ける（空き・募集状況＝募集状況の約束／費用＝見積と一緒／それ以外＝聞かれた事に答える）
    //   語の網（空い・募集…）は about が無い時の予備
    const about = twoStageAxisEnabled() ? (i.askAbout ?? null) : null;
    const askedOtherByAxis = about ? !["vacancy", "property_cost"].includes(about) && !i.asksCost : null;
    const askedOther = (askedOtherByAxis ?? (!i.asksCost && !/空い|空き|募集|まだ(?:あり|残)|埋ま|https?:|\[画像\]/.test(ct) && /[?？]|ですか|ますか|でしょうか|かな/.test(ct)))
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
    if (estimateStaleRecheckEnabled() && typeof i.estimateMaterialAgeDays === "number" && i.estimateMaterialAgeDays >= ESTIMATE_STALE_DAYS) {
      return {
        kind: "estimate",
        direction: `${target ? `${target}の` : ""}資料は届いてから${Math.floor(i.estimateMaterialAgeDays)}日たっている（${ESTIMATE_STALE_DAYS}日以上）→ 先に一度最新の募集状況を確認する旨を伝え、最大限割引した初期費用の御見積書を作成しお送りすると約束する返信にする（結果・金額は書かない・送るのは後で AIX【見積書送る】）。言い方「かしこまりました！！一度最新の募集状況を確認させて頂き、${target ? `${target}の` : ""}最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます😊！！」（竹内さん 10/16・実送信 7/09「弊社で最新の募集状況を確認させて頂きます」）`,
        keyTopic: "最新の募集状況の確認と御見積書をお送りする約束",
        source: "rule:two_stage_promise(estimate_stale)",
      };
    }
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
  // 10/13 竹内さん（いしのまさや）: 確認・見積の約束の番の「良い物件ありますか」「他にも」「内覧」「写真」は順番の後ろ（planPromiseSequence）＝必須の話題にしない
  //   （「良い物件ありますでしょうか？とのことですが、北浜以外にも…」と問いを繰り返して探す約束を詰めた）。戻す TWO_STAGE_PROMISE_SEQUENCE=off
  const laterQ = kind !== "pickup" && promiseSequenceEnabled() ? /(?:物件|お部屋|部屋|ところ)[^？?]{0,10}(?:あり|ない)|ありますか|ないですか|他にも|ほかにも|内[覧見]|写真/ : null;
  return sents.filter((x) => !promiseQ.test(x) && !(laterQ && laterQ.test(x))).slice(0, 2).map((q) => `お客様の質問「${q.slice(0, 30)}」への答え（会話・資料にある事実で。無ければ確認の約束）`);
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
/** 金額・見積を頼む言葉（q183「見積もり出して」・q184「どれくらい」・「初期費用出して」） */
const BROUGHT_ESTIMATE_REQUEST_RE = /見積|いくら|幾ら|どれ[くぐ]らい|どの[くぐ]らい|総額|金額|費用[^\n。？?]{0,8}(?:出し|出せ|教え|知り|計算|算出|わかり|分かり)/;
/**
 * 2026-10-22: 持ち込みの番の費用の語がご希望（wishWords: 初期費用を抑えたい・敷金礼金なし）だけで、金額・見積を頼む言葉が無いか。
 *   true の時は brought_estimate（見積だけの2段）にせず両方（brought_both）。お客様が打った文（画像・URL の行を除く）だけを見る。
 *   戻す BROUGHT_ESTIMATE_WISH_BOTH=off
 */
export function broughtCostWishOnly(turn: string | null | undefined): boolean {
  if (typeof process !== "undefined" && (process.env?.BROUGHT_ESTIMATE_WISH_BOTH ?? "").toLowerCase() === "off") return false;
  if (!wishWords(turn).length) return false;
  const own = String(turn ?? "").normalize("NFKC").split(/\n+/).filter((l) => !/https?:\/\/|^\s*\[(?:画像|ファイル)\]/.test(l)).join("\n");
  return !BROUGHT_ESTIMATE_REQUEST_RE.test(own);
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

/**
 * 2026-10-13 竹内さん「物件名ではなく TikTok のタイトル等が書かれている時は、物件名を言わずに『お送り頂きました物件の募集状況確認させて頂きます』の形」:
 *   送って頂いた物件（持ち込みの通）が全部 SNS・広告の画面（画像の見出し【物件の画面（SNS・広告）】・image-label.ts）＝物件名ではなく題・キャッチしか無い。
 *   URL（ポータルの物件ページ）・資料・ポータルの画面が1つでもあれば false（物件名が分かる）。
 *   実物 61219753（いしのまさや 10/08）: 「【物件の画面（SNS・広告）】SUMORA 初期費用最安値に…「北浜」駅徒歩2分」→ 下書きが「北浜以外にも」と題の駅名を条件にした
 */
export function broughtTitleOnly(propertyMsgs: readonly string[]): boolean {
  if (!propertyMsgs.length) return false;
  return propertyMsgs.every((t) => !/https?:\/\/(?!mypage)/.test(t.replace(/\[画像\][\s\S]*/, "")) && /^\s*\[画像\]\s*【物件の画面（SNS・広告）】/.test(t));
}

/** お客様の自分の言葉にある初期費用の希望（「初期費用を安く」「敷金礼金なし」）。画像の書き起こし・URL は見ない */
export function wishWords(turn: string | null | undefined): string[] {
  const own = String(turn ?? "").normalize("NFKC").split(/\n+/).filter((l) => !/https?:\/\/|^\s*\[(?:画像|ファイル)\]/.test(l)).join("\n");
  const out: string[] = [];
  if (/初期費用[^\n。]{0,12}(?:安く|抑え|少な|お得)/.test(own)) out.push("初期費用を抑えたい");
  if (/敷金[^\n。]{0,4}礼金[^\n。]{0,6}(?:なし|無し|ゼロ|0)|敷礼[^\n。]{0,4}(?:なし|無し|ゼロ|0)/.test(own)) out.push("敷金礼金なし");
  return out;
}

/**
 * 2026-10-13 竹内さん（いしのまさや）: 初回（スタッフの送信が無い）の物件の持ち込みは brain-core の初回ガードで AIX を外すので2段が立たず、
 *   ブレイン（Claude）の方向「…御見積書をお送りする約束で受ける。条件に合うお部屋もピックアップする」で下書きが約束を全部詰めた（試験 q138 の Claude 1回）。
 *   初回で今回の連投に物件（URL・物件の画像）がある時は、持ち込みの2段（brought_both）と同じ約束の順を使う。
 *   propertyMsgs＝今回の連投の物件の通。物件が無ければ null。戻す TWO_STAGE_PROMISE_SEQUENCE=off（初回は今まで通りブレインの方向）
 */
export function firstContactCheckTwoStage(propertyMsgs: readonly string[], customerText: string): TwoStageVerdict | null {
  if (!promiseSequenceEnabled()) return null;
  const n = broughtPropertyCount([...propertyMsgs]);
  if (n <= 0) return null;
  return resolveTwoStage({
    finalAix: "property_check_result", decisionSource: "guard:first_contact", pickupReady: false, postApply: false,
    customerText, asksCost: /初期費用|見積|いくら|費用/.test(customerText), ackOnly: false,
    brought: { ask: broughtPropertyAsk(customerText), count: n, titleOnly: broughtTitleOnly(propertyMsgs) },
  });
}
