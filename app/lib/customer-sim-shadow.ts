// app/lib/customer-sim-shadow.ts
// お客様役（テスト・YUMA 専用）の「影の道」: ブレインが選ばなかった方（AIX か返信の下書きか）も
// 送ったと仮定して作り、選んだ方と突き合わせてズレを見つける（純関数・DB も fetch も持たない）。
// 2026-09-27 竹内「YUMAとLINEする際AIXもくみあわせておこなう／返信もAIXも仮定して送る形でズレなくしていく／設計知見と協力しておこなっていく」
//
// 1往復の形:
//   ・AIX の番 … 実際に送るのは AIX。影は「同じお客様の発言への返信の下書き」（送らない）。
//   ・下書きの番 … 実際に送るのは下書き。影は「その発言に立つ AIX の候補」（ブレインの場面の候補・並べた AIX・決まりの AIX）。
//   影は送らない・送った記録（messages・sent_facts・aix_usage_logs・sent_properties）を作らない。
//
// ズレの種類（judgeShadowTurn）: 線はすべて本番の実送信で引いた（scripts/audit-sim-shadow.ts・数字は各定数の上）
//   draft_conflicts_aix … 下書きが AIX と別の道を宣言している（見積書送るの番に「募集状況確認させて頂きます」等）
//   draft_does_aix_job  … 下書きが AIX の送る物を文で書いている（金額・内訳・候補日時・待ち合わせの住所/時刻・保証会社名・写真・申込書類）
//                         AIX の番＝AIX と二重／下書きの番＝本来 AIX で答える事を文で答えた
//   aix_followup_missing … AIX の後にスタッフが一言添えるのが過半数の型なのに、一言が無い（実送信で過半数の型だけ）
//   aix_scene_skipped   … 下書きの番で、場面の決まり（室内写真・主のお部屋の見積もりの依頼 等）では AIX の場面（情報・ブレインの判断の見直し用）
//   ※ 送っていない AIX の成果物を送った体で書く下書き（「御見積書となります」）は final-check が既に落とす（ここでは見ない）
//
// 呼ぶ側: app/lib/customer-sim-shadow-run.ts（影の生成）→ scripts/customer-sim.ts（--shadow の時だけ）
// テスト: app/lib/__tests__/customer-sim-shadow.test.ts
import { STAFF_PICKUP_DECL_RE } from "@/app/lib/reply-context";

// ─── こちらの文が「何をしているか」（決定論） ───

export type StaffAct =
  | "check_promise"      // 募集状況・空き・入居日・管理会社への確認をこれからする宣言
  | "estimate_promise"   // 御見積書をこれから作る・送る宣言
  | "estimate_cover"     // 御見積書を送った体の文（〜の御見積書となります／お送りさせて頂きました）
  | "cost_amount"        // 初期費用・割引の具体額（円）
  | "cost_items"         // 初期費用の中身の説明（敷金・礼金・保証料…を2つ以上）
  | "pickup_promise"     // お部屋をこれから探す・ピックアップする宣言
  | "pickup_done"        // お部屋を送った体の文（ピックアップさせて頂きました）
  | "viewing_datetime"   // 内覧の具体的な候補日時
  | "viewing_date_ask"   // 内覧の日程を聞く疑問形
  | "meeting_detail"     // 待ち合わせの場所・住所
  | "photo"              // 室内の写真・撮影・動画の話
  | "guarantor_detail"   // 保証会社名・審査の通りやすさ
  | "apply_docs"         // 申込の書類（本人確認書類 等）の案内
  | "apply_form"         // 申込フォーム本体（【お申込者様記入欄】・入居希望日・氏名… の欄の並び）
  | "vacancy_assert"     // 募集中・空室の断言（確認の結果を文で言う）
  | "phone_promise";     // こちらから電話する・折り返しの時刻の約束

const nfkc = (s: string) => String(s ?? "").normalize("NFKC");

/** 確認の宣言（これから）。確認の対象の語（募集・空き・入居・管理会社…）の後ろ20字以内に「確認させて頂きます」等 */
export const CHECK_PROMISE_RE =
  /(?:募集状況|募集|空室|空き状況|空き|入居可能日|入居日|退去|管理会社|オーナー|お部屋の状況|詳細)[^\n。！!？?]{0,20}確認(?:させて(?:頂|いただ)きます|致します|いたします|します|してみます)|確認(?:でき|出来)次第[^\n。！!]{0,12}ご連絡/;
/** 見積書をこれから（「作成しお送りさせて頂きます」「お出しします」） */
export const ESTIMATE_PROMISE_RE =
  /(?:御|お)?見積(?:書|もり|り)?[^\n。！!？?]{0,16}(?:作成|お送り|送らせ|お出し|ご用意|お作り)[^\n。！!？?]{0,10}(?:させて(?:頂|いただ)きます|致します|いたします|します)/;
/** 見積書を送った体（カバー文）。「となります」「お送りさせて頂きました」「同封させて頂きました」 */
export const ESTIMATE_COVER_RE =
  /(?:御|お)?見積(?:書|もり|り)?[^\n。！!？?]{0,6}(?:となります|です！|お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ました|同封(?:させて(?:頂|いただ)き|いたし|致し|し)ました|作成(?:させて(?:頂|いただ)き|いたし|致し|し)ました)/;
/** 初期費用・割引の具体額 */
export const COST_AMOUNT_RE =
  /(?:初期費用|割引|総額|合計|お支払い?)[^\n。]{0,14}?[0-9][0-9,]{3,}\s*円|[0-9][0-9,]{3,}\s*円[^\n。]{0,6}(?:割引|お得|節約)|初期費用\s*[:：]\s*[0-9]/;
/**
 * 初期費用の中身の説明: 項目の語（敷金・礼金・仲介手数料…）が2つ以上＋「含まれ・内訳・別途・発生・かかり」等の説明の語。
 *   物件の紹介の「敷金礼金なし」・条件受付の「独立系保証会社」は説明ではない（保証会社・サポートは項目に数えない）
 */
const COST_ITEM_WORDS = ["敷金", "礼金", "仲介手数料", "保証料", "火災保険", "鍵交換", "日割", "前家賃", "クリーニング", "消毒"];
const COST_EXPLAIN_RE = /含ま|内訳|別途|発生|かかり|掛かり|込み|とは別|必要となり|お支払い/;
/** 内覧の日時（月日＋時刻・曜日＋時刻・「〇日の〇時」） */
export const VIEWING_DATETIME_RE =
  /[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}\s*日?(?:\s*[（(][日月火水木金土][)）])?[^\n。]{0,6}[0-9]{1,2}\s*(?::[0-9]{2}|時)|[日月火水木金土]曜(?:日)?[^\n。]{0,6}[0-9]{1,2}\s*(?::[0-9]{2}|時)/;
/** 内覧の日程を聞く（疑問形・「ご都合よろしいお日にち御座いますでしょうか」） */
export const VIEWING_DATE_ASK_RE =
  /ご都合[^\n]{0,12}(?:お日にち|日程|日時|お時間)[^\n]{0,12}(?:御座|ござ)いますでしょうか|(?:お日にち|日程|候補日|ご希望の日時)[^\n]{0,10}(?:お聞かせ|教えて)(?:頂|いただ)け|いつ頃(?:が)?ご都合/;
/** 待ち合わせの場所・住所（「現地エントランス」「住所:」「〇〇駅の改札」） */
export const MEETING_DETAIL_RE =
  /待ち合わせ[^\n。]{0,20}(?:場所|エントランス|改札|出口|前)|現地エントランス|住所\s*[:：]|(?:大阪府|大阪市)[^\n。]{0,12}[0-9０-９]+(?:丁目|-)/;
/** 室内の写真・撮影・動画 */
export const PHOTO_RE = /(?:室内|お部屋|部屋|内装|中)の?(?:写真|画像|動画)|(?:写真|動画)[^\n。]{0,10}撮影|撮影(?:させて|し(?:て|お送り)|致し|いたし)/;
/** 保証会社名・審査の通りやすさ（本文に書かない物・aix-taxonomy guarantor_info の forbid） */
export const GUARANTOR_DETAIL_RE =
  /全保連|日本セーフティー|ジェイリース|エポス(?:カード)?(?:の)?保証|フォーシーズ|Casa|エルズサポート|アーク|オリコ|GTN|日本賃貸保証|JID|ナップ|ホームネット|アプラス|ジャックス|セゾン|並行(?:して)?審査/i;
/** 募集中・空室の断言（確認の宣言・条件節は除く） */
export const VACANCY_ASSERT_RE = /(?<!確認|か)(?:現在)?(?:募集中|空室|空いて(?:おり|い))(?:です|でございます|となります|御座います|ます|ました)(?!か)/;
/** こちらから電話する・時刻つきの折り返し（aix-territory の phone_call と同じ語） */
export const PHONE_PROMISE_RE = /こちらから(?:お)?電話(?:させて|致し|いたし|します|する)|[0-9]{1,2}時[^\n]{0,6}(?:に)?(?:お)?電話(?:させて|致し|いたし|します|する)/;
/** 申込フォーム本体（AIX【申込へ】が送る物）。欄の並び（・入居希望日 … ・氏名）か【…記入欄】 */
export const APPLY_FORM_RE = /記入欄】|・\s*入居希望日[\s\S]{0,40}・\s*氏名/;
/** 申込の書類・情報の案内（「こちらお申込に必要なご情報となります…本人確認書類…」＝②の案内は手打ちの一言でも普通に書く） */
export const APPLY_DOCS_RE = /(?:本人確認書類|運転免許証|マイナンバーカード|収入証明|住民票|申込(?:書|に必要なご情報)|記入欄】)/;

/** こちらの1通が何をしているか（重なりあり） */
export function staffActsOf(text: string | null | undefined): Set<StaffAct> {
  const t = nfkc(text ?? "");
  const out = new Set<StaffAct>();
  if (!t.trim()) return out;
  if (CHECK_PROMISE_RE.test(t)) out.add("check_promise");
  if (ESTIMATE_PROMISE_RE.test(t)) out.add("estimate_promise");
  if (ESTIMATE_COVER_RE.test(t)) out.add("estimate_cover");
  if (COST_AMOUNT_RE.test(t)) out.add("cost_amount");
  if (COST_ITEM_WORDS.filter((w) => t.includes(w)).length >= 2 && COST_EXPLAIN_RE.test(t) && !/🌟/.test(t)) out.add("cost_items");
  if (STAFF_PICKUP_DECL_RE.test(t)) out.add("pickup_promise");
  if (/ピックアップ(?:させて(?:頂|いただ)き|いたし|致し|し)ました|🌟/.test(t)) out.add("pickup_done");
  if (VIEWING_DATETIME_RE.test(t)) out.add("viewing_datetime");
  if (VIEWING_DATE_ASK_RE.test(t)) out.add("viewing_date_ask");
  if (MEETING_DETAIL_RE.test(t)) out.add("meeting_detail");
  if (PHOTO_RE.test(t)) out.add("photo");
  if (GUARANTOR_DETAIL_RE.test(t)) out.add("guarantor_detail");
  if (APPLY_DOCS_RE.test(t)) out.add("apply_docs");
  if (APPLY_FORM_RE.test(t)) out.add("apply_form");
  if (VACANCY_ASSERT_RE.test(t)) out.add("vacancy_assert");
  if (PHONE_PROMISE_RE.test(t)) out.add("phone_promise");
  return out;
}

export const STAFF_ACT_JA: Record<StaffAct, string> = {
  check_promise: "確認の宣言",
  estimate_promise: "見積書を送る宣言",
  estimate_cover: "見積書を送った体の文",
  cost_amount: "初期費用・割引の金額",
  cost_items: "初期費用の中身の説明",
  pickup_promise: "お部屋を探す宣言",
  pickup_done: "お部屋を送った体の文",
  viewing_datetime: "内覧の候補日時",
  viewing_date_ask: "内覧の日程を聞く",
  meeting_detail: "待ち合わせの場所・住所",
  photo: "室内の写真の話",
  guarantor_detail: "保証会社名・審査の通りやすさ",
  apply_docs: "申込の書類の案内",
  apply_form: "申込フォーム本体",
  vacancy_assert: "募集中の断言",
  phone_promise: "電話の約束",
};

// ─── AIX ごとの「送る物」と「別の道」（表・線は本番の実送信 180日・scripts/audit-sim-shadow.ts） ───

/** AIX の鍵（property_check_result は check_pattern で分ける） */
export function aixKey(action: string, checkPattern?: string | null): string {
  return action === "property_check_result" && checkPattern ? `${action}/${checkPattern}` : action;
}

/**
 * AIX が送る物＝下書きが書くと二重（AIX の番）／本来 AIX で答える事（下書きの番）。
 *   出所は aix-taxonomy の AIX_ACTION_REPLY_DIRECTION[*].forbid（ここで禁止を発明しない）と竹内さんの決まり（memory の feedback_*）。
 *   数字は scripts/audit-sim-shadow.ts（180日・場面の候補ごと・手打ちだけで返した番でその行為を手打ちで書いた率）の結果を頭に書く
 *   待ち合わせ×場所・住所は手打ちでも普通に書く（下書きの番では見ない＝DRAFT_TURN_SKIP・AIX の番の二重だけ見る）
 */
export const AIX_DELIVERS: Readonly<Record<string, readonly StaffAct[]>> = {
  estimate_sheet: ["cost_amount"],
  cost_explain: ["cost_amount"],
  cost_breakdown: ["cost_items"],
  viewing_invite: ["viewing_datetime"],
  meeting_place: ["meeting_detail"],
  guarantor_info: ["guarantor_detail"],
  application_push: ["apply_form"],
  phone_call: ["phone_promise"],
  "property_check_result/interior_photo": ["photo"],
  "property_check_result/mgmt_guarantor": ["guarantor_detail"],
  "property_check_result/available": ["vacancy_assert"],
  property_check_result: ["vacancy_assert"],
};
/** 下書きの番で「本来 AIX」を見ない組（スタッフが手打ちでも普通に書く物） */
const DRAFT_TURN_SKIP: ReadonlySet<string> = new Set(["meeting_place:meeting_detail"]);

export function aixDelivers(action: string, checkPattern?: string | null): readonly StaffAct[] {
  const hit = AIX_DELIVERS[aixKey(action, checkPattern)];
  if (hit) return hit;
  // 管理会社の回答の型（mgmt_*・vacate_date 等）は募集中の断言と関係しない
  if (action === "property_check_result" && checkPattern) return [];
  return AIX_DELIVERS[action] ?? [];
}

/** 条件つきの見積の宣言（「お気に召されましたお部屋…御見積書」＝次の段の案内で、今の道の宣言ではない） */
const CONDITIONAL_ESTIMATE_RE = /(?:お気に召され|気になる|ございましたら|御座いましたら|ありましたら)[^\n。！!]{0,30}(?:御|お)?見積/;

/**
 * AIX の番に、下書きが宣言すると別の道になる物（実送信で線を引いた・数字は audit-sim-shadow の結果を頭に書く）。
 *   物件ピックアップした／オススメ × 見積書を送る宣言（条件つき「お気に召されましたお部屋…御見積書」は除く）
 *   見積書送る × 確認の宣言: 主のお部屋がこちらの送ったお部屋の時だけ（focused-estimate-request の決まり）。
 *     お客様の持ち込みは「募集状況確認＋見積書」が正しい
 *   待ち合わせ × 日程を聞く: 待ち合わせを送る番に日程を聞き直す
 */
export function conflictActsFor(action: string, ctx: { focusSentByUs?: boolean | null }): StaffAct[] {
  if (action === "property_send" || action === "property_recommendation") return ["estimate_promise"];
  if (action === "estimate_sheet") return ctx.focusSentByUs ? ["check_promise"] : [];
  if (action === "meeting_place") return ["viewing_date_ask"];
  return [];
}

/**
 * AIX の後にスタッフが一言添える率（AIX の送信の後10分以内・次のお客様の発言より前に手打ち・180日）。過半数の型だけ置く。
 *   見積書送る 137/164（84%・「〇〇 最大限割引した初期費用の御見積書となります！！…ご査収ください」）
 *   申込へ 47/61（77%・「こちらお申込に必要なご情報となります…」＝②の案内）
 *   物件オススメ 60/84（71%・「〇〇さんこちらのお部屋如何でしょうか！！…お気に召されましたら…」）
 *   入れない: 物件ピックアップした 161/278（58%・一押しの物件の追記が多く AIX の2通目と見分けられない）・条件を聞く（フォームと導入文の組が混ざる）
 *   それ以外（物件確認した/募集中 26/164・内覧へ 7/90・待ち合わせ 9/62）は一言を添えないのが普通
 *   画面では AIX の送信後に同じ種類のテンプレを続けて送るバナー（page.tsx B5・AIX_SUGGEST_TEMPLATE_CATEGORY）が出る＝この一言の出所
 */
export const AIX_FOLLOWUP_RATE: Readonly<Record<string, { rate: number; n: number; example: string }>> = {
  estimate_sheet: { rate: 0.84, n: 164, example: "〇〇 最大限割引した初期費用の御見積書となります！！お気に召されましたらお申込みしお部屋抑えさせて頂きます！！お手隙の際にご査収ください" },
  application_push: { rate: 0.77, n: 61, example: "こちらお申込に必要なご情報となります😊！！上記フォーマットご入力いただき…" },
  property_recommendation: { rate: 0.71, n: 84, example: "〇〇さんこちらのお部屋如何でしょうか！！…お気に召されましたらご案内させて頂きます！！" },
};

// ─── 影の候補（下書きの番に並べる AIX） ───

export type ShadowCandidate = { action: string; checkPattern: string | null; source: "brain" | "scene" | "alt" };

/** 竹内さんの決まりで AIX に振る場面（下書きで答えると「本来 AIX」）: memory の feedback_* */
export const RULE_AIX_KEYS: ReadonlySet<string> = new Set([
  "property_check_result/interior_photo", // 2026-09-23 室内写真は AIX【物件確認した】→室内写真確認した
  "cost_breakdown",                        // 2026-09-15 初期費用の中身は AIX【初期費用について】
  "cost_explain",                          // 2026-09-12 安さへの不審は AIX【初期費用を説明】
  "guarantor_info",                        // 2026-09-15 保証会社名は AIX【保証会社について】
  "estimate_sheet",                        // 2026-09-12/27 見積の依頼・総額の確認は AIX【見積書送る】
  "phone_call",                            // 2026-09-15 電話のご依頼は AIX【電話をかける】
]);

export type ShadowMetaLike = {
  action?: string | null; reply_mode?: string | null; check_pattern?: string | null;
  scene_evidence?: { candidate?: string | null; check_pattern?: string | null } | null;
  alt_actions?: ReadonlyArray<string> | null;
} | null | undefined;

/**
 * 下書きの番の影の候補: ブレインが action を持つのに reply_mode が aix でない時の action ／ 場面の証拠の候補 ／ 並べた AIX（alt_actions）。
 * 重複は1つ。選んだ AIX（AIX の番）は除く。
 */
export function shadowAixCandidates(meta: ShadowMetaLike, exclude?: { action: string; checkPattern: string | null } | null): ShadowCandidate[] {
  const out: ShadowCandidate[] = [];
  const seen = new Set<string>();
  const push = (action: string | null | undefined, checkPattern: string | null | undefined, source: ShadowCandidate["source"]) => {
    const a = String(action ?? "").trim();
    if (!a) return;
    const cp = checkPattern ?? null;
    const k = aixKey(a, cp);
    if (exclude && aixKey(exclude.action, exclude.checkPattern) === k) return;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ action: a, checkPattern: cp, source });
  };
  if (meta?.reply_mode !== "aix") push(meta?.action, meta?.check_pattern, "brain");
  push(meta?.scene_evidence?.candidate, meta?.scene_evidence?.check_pattern, "scene");
  for (const a of meta?.alt_actions ?? []) push(a, null, "alt");
  return out;
}

// ─── ズレの判定 ───

export type ShadowKind = "draft_conflicts_aix" | "draft_does_aix_job" | "aix_followup_missing" | "aix_scene_skipped";
export type ShadowFinding = { kind: ShadowKind; aix: string; detail: string };

const SHADOW_KIND_JA: Record<ShadowKind, string> = {
  draft_conflicts_aix: "下書きが AIX と別の道",
  draft_does_aix_job: "下書きが AIX の送る物を書いた",
  aix_followup_missing: "AIX の後の一言が無い",
  aix_scene_skipped: "決まりでは AIX の場面",
};
export function shadowKindJa(k: ShadowKind): string { return SHADOW_KIND_JA[k]; }
export const SHADOW_KINDS = Object.keys(SHADOW_KIND_JA) as ShadowKind[];

export type ShadowTurnInput = {
  /** ブレインが選んだ道（実際に送った方） */
  chosen: "aix" | "draft";
  /** AIX の番: 選んだ AIX（text は送った文・送っていなければ null） */
  aix?: { action: string; checkPattern: string | null; text: string | null } | null;
  /** 下書きの番: 影の候補 */
  candidates?: ReadonlyArray<ShadowCandidate>;
  /** AIX の番＝影の下書き（送らない）／下書きの番＝送った下書き */
  draftText: string | null;
  /** 主のお部屋がこちらの送ったお部屋か（customer-state の focus の sentByUs） */
  focusSentByUs?: boolean | null;
  /** AIX の番: AIX の後にこちらが一言送ったか（お客様役は送らない＝false） */
  followupSent?: boolean;
};

/**
 * 1往復の影の突き合わせ（純関数・決定論）。
 *   AIX の番: 影の下書き × 選んだ AIX … 別の道（conflictActsFor）・二重（aixDelivers）／AIX の後の一言（AIX_FOLLOWUP_RATE）
 *   下書きの番: 送った下書き × 影の候補 … 本来 AIX（aixDelivers・DRAFT_TURN_SKIP を除く）／決まりの場面なのに下書き（RULE_AIX_KEYS）
 */
export function judgeShadowTurn(input: ShadowTurnInput): ShadowFinding[] {
  const f: ShadowFinding[] = [];
  const acts = staffActsOf(input.draftText);
  if (input.chosen === "aix" && input.aix) {
    const { action, checkPattern } = input.aix;
    const key = aixKey(action, checkPattern);
    if (input.draftText) {
      for (const a of conflictActsFor(action, { focusSentByUs: input.focusSentByUs })) {
        if (!acts.has(a)) continue;
        if (a === "estimate_promise" && CONDITIONAL_ESTIMATE_RE.test(nfkc(input.draftText))) continue;
        f.push({ kind: "draft_conflicts_aix", aix: key, detail: `AIX【${key}】の番に下書きが「${STAFF_ACT_JA[a]}」` });
      }
      for (const a of aixDelivers(action, checkPattern)) {
        if (acts.has(a)) f.push({ kind: "draft_does_aix_job", aix: key, detail: `AIX【${key}】が送る「${STAFF_ACT_JA[a]}」を下書きも書いた（二重）` });
      }
    }
    const fu = AIX_FOLLOWUP_RATE[action];
    if (fu && input.aix.text && input.followupSent === false) {
      f.push({ kind: "aix_followup_missing", aix: key, detail: `実送信では ${Math.round(fu.rate * 100)}%（n=${fu.n}）が AIX の後に一言添える（例「${fu.example.slice(0, 40)}…」）` });
    }
  }
  if (input.chosen === "draft") {
    for (const c of input.candidates ?? []) {
      const key = aixKey(c.action, c.checkPattern);
      if (input.draftText) {
        for (const a of aixDelivers(c.action, c.checkPattern)) {
          if (DRAFT_TURN_SKIP.has(`${c.action}:${a}`)) continue;
          if (acts.has(a)) f.push({ kind: "draft_does_aix_job", aix: key, detail: `候補 AIX【${key}】（${c.source}）が送る「${STAFF_ACT_JA[a]}」を下書きが文で書いた（本来 AIX）` });
        }
      }
      if (c.source !== "alt" && RULE_AIX_KEYS.has(key)) {
        f.push({ kind: "aix_scene_skipped", aix: key, detail: `場面（${c.source}）は決まりで AIX【${key}】の所をブレインは下書きにした` });
      }
    }
  }
  return f;
}

/** 影の検査の要約（種類ごとの件数） */
export function summarizeShadow(rows: ReadonlyArray<{ shadowFindings?: ReadonlyArray<ShadowFinding> | null }>): Array<{ kind: ShadowKind; label: string; count: number }> {
  return SHADOW_KINDS.map((k) => ({ kind: k, label: SHADOW_KIND_JA[k], count: rows.reduce((n, r) => n + (r.shadowFindings ?? []).filter((x) => x.kind === k).length, 0) }));
}

// ─── 影の下書きを「書かない」で作る鍵（generate-reply の body の欄名・四者同名） ───

/**
 * generate-reply の body にこの欄を true で渡すと、テスト用の会話（isTestConversation）の時だけ
 * 会話・ログに何も書かない（ai_draft・ai_draft_check・draft_pending_at・reply_mode_shadow_logs・closing_strategy_logs・
 * body_block_code・古い判断の再分析・keep-warm の記録・申込期間のまとめ）。費用の記録（llm_usage_logs）は残る。
 * ⚠ generate-reply がこの欄を読むようになるまで、影の下書きは作らない（customer-sim-shadow-run.generateReplyAcceptsShadow）
 */
export const SHADOW_NO_WRITE_FIELD = "shadowNoWrite";

// ─── generate-reply の応答（1行目のメタ＋本文＋内部タグ）を読む ───

/** 1行目の JSON（メタ）と本文。内部タグ（<<<SUGGESTED_AIX:…>>> 等）は外す */
export function parseGenerateReplyStream(raw: string): { meta: Record<string, unknown> | null; text: string } {
  const s = String(raw ?? "");
  const nl = s.indexOf("\n");
  let meta: Record<string, unknown> | null = null;
  let body = s;
  if (nl >= 0) {
    try {
      const j = JSON.parse(s.slice(0, nl)) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) { meta = j as Record<string, unknown>; body = s.slice(nl + 1); }
    } catch { /* 1行目が本文 */ }
  }
  return { meta, text: body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim() };
}
