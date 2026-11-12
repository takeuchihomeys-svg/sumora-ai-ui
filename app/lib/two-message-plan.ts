// app/lib/two-message-plan.ts — 1つの番を何通に分けて、どの順で、どの通が何に答えるか（純関数・DB/LLM なし・画面とサーバーの両方から読める）
//
// 2026-11-05 竹内さん（KB P1 b834d9f0「返信と AIX を分けて2通で答える」＋追記「複雑な番は AIX → AIX テンプレート → 返信の3通」・
//   KB P1 cf241dbd「返信の決め方 No.42」・P1 d33e3daf「潜在意識＝満足のいく家」）:
//   お客様の質問で、返信で答えられる部分と AIX の部分は分けて答える。形は臨機応変に
//     (a) 先に返信（受け・約束・答え）→ AIX
//     (b) AIX → 2通目の AIX テンプレートで返信の部分も答える
//     (c) 複雑な番は AIX → AIX テンプレート（AIX の訴求・中身）→ 返信（質問の答え・スタッフだけが知る事の補い・サポートの約束）の3通
//   初回で画像だけ届いた番は、挨拶と約束の返信 → AIX（募集状況と最大限割引の見積書）。
// 統括の順番の表（KB P1 0dbfbc97）の「2番目（細部）の後・3番目（文の組み立て）の前」の1行＝何通・どの順・各通の受け持ち。
//   判断（どの依頼が返信か AIX か）はブレイン（turn_contract の route）＝P0 の線。ここは受け持ちの割り振りだけ（決め直さない）。
//
// ■ 物差し（竹内さんの番・2026-11-05 作業員7 が DB で数えた・読むだけ）
//   90日の竹内さんの番の形（A=AIX・T=AIX の後の訴求の通・R=返信）: R 681・A 159・AT 157・RAT 68・AR 56・RA 34・RAR 15・ATR 7・ART 3
//   10/06〜（ブレインの依頼の表がある番）: 竹内さんが AIX→返信 の番 52 のうち、ブレインの依頼に返信と AIX の両方があったのは 8。
//   返信→AIX の番 32 のうち 28 はブレインの依頼が約束（2段と同じ考え）。
//   ＝ 約束が要る番（条件・持ち込みの物件＝No.42 (b)(c)）は返信が先、返信で答えられる質問と AIX が混ざる番は AIX が先で、残りの答えは後ろの通。
//   No.41 の9番（見積書の AIX の後に空き・手数料を手で補った通）＝3通目（AIX テンプレート／返信）の席が無かった所。
//
// スイッチ: TWO_MESSAGE_PLAN（サーバー）＝既定 on（2026-11-05 統括役の決め・悪化0 tm2〜tm5・止める TWO_MESSAGE_PLAN=off・twoMessagePlanOn）。
//   NEXT_PUBLIC_TWO_MESSAGE_PLAN（画面）＝未設定は YUMA・テスト専用の会話だけ／all＝全員／off＝出さない（下の画面の関数）。
//   2026-11-12 作業員7（作業員25 の点検）: ここの「どちらも既定 off」はコードとずれていたので直した（コメントだけ・動きは同じ）。
// テスト: app/lib/__tests__/two-message-plan.test.ts

import { planIsStale } from "./conductor-replan";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function twoMessagePlanOn(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_PLAN ?? "").trim().toLowerCase() !== "off"; // 2026-11-05 統括役の決め: 悪化0（tm2〜tm5）で既定 on・止める TWO_MESSAGE_PLAN=off
}
/** 画面（NEXT_PUBLIC_ はビルドで埋まる＝呼ぶ側が値を渡す） */
/** 文を書く AIX の番は質問も AIX の文の中で1通（既定は TWO_MESSAGE_PLAN に従う・止める TWO_MESSAGE_ONE_IN_TEXT_AIX=off） */
export function oneMessageInTextAixOn(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_ONE_IN_TEXT_AIX ?? "").trim().toLowerCase() !== "off";
}
/**
 * 近い竹内さんの番の型（作業員5 conductor_turn_vectors の actual.shape・近い順）から、組み立ての参考の1行。
 *   決めるのは planMessages（参考を材料に渡すだけ・決め直さない）。近い番が2つ未満なら null
 */
export function nearShapeLine(neigh: ReadonlyArray<{ shape?: string | null; dist?: number | null }>, max = 5): { line: string; digest: string } | null {
  // 近い順（dist が小さい順・無い物は後ろ）に max 件
  const xs = neigh.filter((n) => typeof n.shape === "string" && n.shape)
    .slice().sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity)).slice(0, max);
  if (xs.length < 2) return null;
  const c = new Map<string, { n: number; best: number }>();
  for (const x of xs) { const v = c.get(x.shape!) ?? { n: 0, best: Infinity }; v.n++; v.best = Math.min(v.best, x.dist ?? Infinity); c.set(x.shape!, v); }
  // 数の多い順・同数は一番近い番がある方
  const ranked = [...c.entries()].sort((a, b) => b[1].n - a[1].n || a[1].best - b[1].best);
  const parts = ranked.map(([k, v]) => `${k} ${v.n}/${xs.length}`);
  return { line: `近い竹内さんの番の型: ${parts.join("・")}（${SHAPE_WHY[ranked[0][0]] ?? ""}）`, digest: ranked.map(([k, v]) => `${k}${v.n}`).join(",") };
}

/** T（AIX テンプレート＝AIX の後の訴求の通）の見分け: 同じ番の AIX の後の手打ちで、訴求の言い回しがある通（作業員7 の90日の数えと同じ決まり） */
export const TEMPLATE_PHRASE_RE = /お気に召されましたら|ご査収|御見積書となります|オススメ出来る|オススメできる|同封させて頂きました|ご案内させて頂きます|お部屋抑えさせて/;
/**
 * 1つの番（お客様の発言の後、次のお客様の発言まで）のこちらの送信を、時刻の順に並べて型にする（R=返信・A=AIX・T=AIX テンプレート）。
 *   画像・室内イメージの URL・申込フォーマット等の付き物は呼ぶ側で外す。同じ記号が続く通はまとめる（AIX の画像＋本文 → A）。
 *   isTemplate が無い時は、AIX の後の手打ちで text が TEMPLATE_PHRASE_RE に当たれば T。送信が無ければ ""
 */
export function shapeOfSends(sends: ReadonlyArray<{ isAix: boolean; aixType?: string | null; isTemplate?: boolean; text?: string | null }>): string {
  let seenAix = false;
  const ks: string[] = [];
  for (const s of sends) {
    let k: string;
    if (s.isAix) { k = "A"; seenAix = true; }
    else if (s.isTemplate === true || (s.isTemplate === undefined && seenAix && TEMPLATE_PHRASE_RE.test(String(s.text ?? "")))) k = "T";
    else k = "R";
    if (ks[ks.length - 1] !== k) ks.push(k);
  }
  return ks.join("");
}
export function twoMessagePlanUiOn(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "on";
}

export type PlanSlot = "reply" | "aix" | "aix_template";
export type PlanOrder = "single" | "reply_first" | "aix_first" | "three";
export type PlanAsk = { quote: string; route: string; answer?: string | null; aix?: string | null; about?: string | null; kind?: string | null };
export type PlannedMessage = {
  no: number;
  slot: PlanSlot;
  /** slot=aix・aix_template の時の AIX のキー */
  aix: string | null;
  /** この通が答える依頼（お客様の言葉） */
  answers: string[];
  /** この通の役目（画面の知らせ・書く役への材料） */
  role: string;
  /** この通が担う事（竹内さん 11/05「質問に答える・信頼関係を上げる・訴求できるなら訴求する」）: answer＝答える／trust＝信頼（受け止め・サポートの姿勢の約束）／appeal＝訴求（物件の良さ・割引・内覧の誘い） */
  duties: Duty[];
};
export type Duty = "answer" | "trust" | "appeal";
export const DUTY_JA: Record<Duty, string> = { answer: "答える", trust: "信頼", appeal: "訴求" };
export type TwoMessagePlan = {
  order: PlanOrder; count: number; messages: PlannedMessage[]; why: string;
  /** 竹内さんの組み合わせの型（R=返信・A=AIX・T=AIX テンプレート。例 RAT・AR・ATR）＝KB P1 3701b532 の型 */
  shape: string;
  /** 型の「なぜ」（統括と書き手が読む材料） */
  shapeWhy: string;
};

/**
 * 竹内さんの組み合わせの型と「なぜ」（KB P1 3701b532・11/05 竹内さん「AIX と返信の組み合わせ方もちゃんと理解する」）。
 *   90日の竹内さん本人の番（作業員7）: R 681・A 159・AT 157・RAT 68・AR 56・RA 34・RAR 15・ATR 等 約12
 *   型の手本（各型2〜3通）は作業員7 の表（scratchpad の two-msg-shapes.md・統括役へ）
 */
export const SHAPE_WHY: Record<string, string> = {
  R: "返信だけ＝AI が知り得る事で答えられる番。答え・受け・約束を1通に",
  A: "送る物が主＝スタッフだけが知る事（結果・日時・物）を AIX 1通で。答えも AIX の中に",
  AT: "送る物が主＋2通目で AIX の訴求・中身（次の一手へ）。送る物と訴求を分ける",
  RA: "受け止めてから送る＝約束の返信（確認・作成・探す）→ AIX で約束を果たす（No.42 (b)(c)）",
  RAT: "受け止めてから送る＝挨拶・約束の返信 → AIX → 訴求の通（初回の画像だけ・持ち込みの物件・条件）。満足のいくお部屋までサポートする姿勢を先に",
  AR: "AIX で送る物を先に → 返信で補う（返信で答えられる質問の答え・サポートの約束）。送る物と答えを混ぜない",
  ATR: "複雑な番＝AIX → AIX の訴求・中身のテンプレート → 返信で質問の答え。テンプレートは AIX 中心・返信は答え",
  RAR: "約束の返信 → AIX → 返信（条件のお願い・サポートの約束で締める）",
};
const shapeOf = (msgs: ReadonlyArray<PlannedMessage>): string => msgs.map((m) => (m.slot === "reply" ? "R" : m.slot === "aix" ? "A" : "T")).join("");
function withShape(p: Omit<TwoMessagePlan, "shape" | "shapeWhy">): TwoMessagePlan {
  const shape = shapeOf(p.messages);
  const shapeWhy = SHAPE_WHY[shape] ?? "";
  return { ...p, shape, shapeWhy, why: shapeWhy ? `${shape}: ${shapeWhy}（${p.why}）` : p.why };
}

/** 2通目の AIX テンプレート（同じ AIX の訴求・中身の通）がある AIX。竹内さんの形 AT 157・RAT 68 の AIX */
const TEMPLATE_AIX = new Set(["estimate_sheet", "property_recommendation", "property_check_result"]);
/** AIX の中身（訴求）に寄る依頼＝テンプレートの通で答えられる（物件そのもの・費用・空き） */
//   about の値は request-ledger の RequestAbout（property_equipment・property_cost・vacancy）
/** 文を書く AIX（テンプレートの席が無く、スタッフが文を書く AIX）。竹内さん本人の90日（その AIX が番の最初の AIX）: 内覧調整 53番＝返信が先 4・AIX だけ 43／待ち合わせ 39＝3・28／
 *   全力サポート 3＝0・3／挨拶 3＝0・3／保証会社 2＝0・2／電話 7＝2・3／申込へ 18＝5・6。ヒアリング 16＝返信が先 5・AIX だけ 2（約束の返信 → AIX が多い）なので入れない */
const TEXT_AIX = new Set(["zenryoku_support", "viewing_invite", "meeting_place", "greeting_viewing", "phone_call", "cost_explain", "cost_breakdown", "guarantor_info", "application_push", "acknowledge_check", "followup_revive"]);
/** 結果が後になる約束（確認・探す・ピックアップ・交渉・撮影・見積の作成）＝AIX の文の中で果たせない＝約束の返信が先 */
const resultLaterPromise = (a: PlanAsk): boolean => /確認|探|ピックアップ|交渉|撮影|作成|見積|調べ/.test(`${a.answer ?? ""}${a.quote}`);
/**
 * 2026-11-05 統括役の決め（q330・KB P0 2e164f41）: 内覧調整・待ち合わせの AIX は、物件の募集状況の確認の約束も AIX の文の中で（「お送りいただきました物件の募集状況につきましても併せて確認させていただきます」）。
 *   竹内さん本人の90日: 内覧調整・待ち合わせの番でお客様が物件（URL・画像・空き）を送った 6番＝物件の確認の約束を別の返信にしたのは 0・AIX の文の中で約束 1・同じ番で物件確認した の AIX で結果 1・約束が要らない（見に行く物件そのもの）4。
 *   別の返信にした番が0＝返信が先（RA）の形は竹内さんに無い。探す・交渉・撮影・見積は今まで通り除く。既定 on（止める TWO_MESSAGE_VIEW_CHECK_IN_AIX=off）
 */
export function viewCheckInAixOn(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_VIEW_CHECK_IN_AIX ?? "").trim().toLowerCase() !== "off"; // 11/05 q330〜q335 の答案で組み立てを採り直して余計な2通目 55%→20%・道は変わらない（ブレインに触れない）＝既定 on
}
const VIEW_AIX = new Set(["viewing_invite", "meeting_place"]);
const laterPromiseFor = (aixKey: string) => (a: PlanAsk): boolean => {
  const t = `${a.answer ?? ""}${a.quote}`;
  if (VIEW_AIX.has(aixKey) && viewCheckInAixOn()) return /探|ピックアップ|交渉|撮影|作成|見積/.test(t);
  return resultLaterPromise(a);
};
const AIX_CONTENT_ABOUT =/^(?:property_equipment|property_cost|vacancy)$/;

const AIX_LABEL: Record<string, string> = {
  estimate_sheet: "見積書を送る", property_recommendation: "物件オススメ", property_check_result: "物件確認した",
  property_send: "物件ピックアップした", viewing_invite: "内覧調整", meeting_place: "待ち合わせ場所",
  application_push: "申込へ", condition_hearing: "ヒアリング", guarantor_info: "保証会社", phone_call: "電話",
  cost_explain: "初期費用を説明", cost_breakdown: "初期費用について", acknowledge_check: "確認します", zenryoku_support: "全力サポート",
  greeting_viewing: "挨拶", followup_revive: "追客",
};
export const aixLabelOf = (k: string | null | undefined): string => {
  const base = String(k ?? "").split("/")[0];
  return AIX_LABEL[base] ?? (base || "AIX");
};
const baseKey = (k: unknown): string | null => {
  const s = String(k ?? "").split("/")[0].trim();
  return s && s !== "null" ? s : null;
};

/**
 * 番の組み立てを決める。
 *   asks: ブレインの turn_contract.asks（route=reply|promise|aix|none）
 *   finalAix: ブレインの最終の AIX（無ければ null）
 *   firstContact: この会話で初めての返事か（挨拶が要る）
 *   imageOnly: お客様の連投が画像だけか（初回で画像だけ＝挨拶と約束 → AIX）
 */
type PlanInput = {
  asks: ReadonlyArray<PlanAsk> | null | undefined;
  finalAix?: string | null;
  firstContact?: boolean;
  imageOnly?: boolean;
  /** 訴求できる場面か（送れる物がある・送った物件が刺さっている）。統括・ブレインが決めて渡す（ここでは決めない） */
  canAppeal?: boolean;
};
export function planMessages(i: PlanInput): TwoMessagePlan {
  const p = withShape(planCore(i));
  // 訴求できる場面なのに訴求の通（テンプレート）が無い＝最後の通に訴求の一文を担わせる（通は増やさない＝余計な2通目を作らない）
  if (i.canAppeal && !p.messages.some((m) => m.duties.includes("appeal")) && p.messages.length) {
    const last = p.messages[p.messages.length - 1];
    last.duties = [...last.duties, "appeal"];
  }
  return p;
}

/**
 * 組み合わせ全体の確かめ（竹内さん 11/05「ちゃんとお客様の質問や疑問に答える・信頼関係を上げる・訴求できるなら訴求する」）。
 *   ① 質問が全部どこかの通で答えられているか（route=reply|promise|aix の依頼・none は除く）
 *   ② 信頼の一言（受け止め・サポートの姿勢の約束）を担う通があるか（返信の通が無い＝AIX だけの番は AIX の文の中で担う物として「AIX の中で」と出す）
 *   ③ 訴求できる場面（canAppeal）で訴求を担う通があるか
 *   抜けは理由つきで返す（統括・試験の物差し）
 */
export function checkPlan(p: TwoMessagePlan | null | undefined, i: { asks?: ReadonlyArray<PlanAsk> | null; canAppeal?: boolean }): { answered: boolean; trust: boolean; appeal: boolean | null; gaps: string[] } {
  const gaps: string[] = [];
  if (!p) return { answered: false, trust: false, appeal: null, gaps: ["組み立てが無い"] };
  const need = (i.asks ?? []).filter((a) => a && a.route !== "none").map((a) => a.quote.slice(0, 40));
  const covered = new Set(p.messages.flatMap((m) => m.answers));
  const missing = need.filter((q) => !covered.has(q));
  if (missing.length) gaps.push(`答えていない質問: ${missing.map((m) => `「${m.slice(0, 20)}」`).join("・")}`);
  const trust = p.messages.some((m) => m.duties.includes("trust"));
  if (!trust) gaps.push("信頼の一言を担う通が無い（AIX だけの番＝AIX の文の中で受け止めかサポートの姿勢を入れる）");
  const appeal = i.canAppeal ? p.messages.some((m) => m.duties.includes("appeal")) : null;
  if (appeal === false) gaps.push("訴求できる場面で訴求を担う通が無い");
  return { answered: missing.length === 0, trust, appeal, gaps };
}
function planCore(i: PlanInput): Omit<TwoMessagePlan, "shape" | "shapeWhy"> {
  const asks = (i.asks ?? []).filter((a) => a && typeof a.quote === "string");
  const q = (a: PlanAsk) => a.quote.slice(0, 40);
  const replyAsks = asks.filter((a) => a.route === "reply");
  const promiseAsks = asks.filter((a) => a.route === "promise");
  const aixAsks = asks.filter((a) => a.route === "aix");
  // AIX のキー: 依頼の中の最初の AIX（無ければ最終の AIX）
  const aixKey = baseKey(aixAsks[0]?.aix) ?? baseKey(i.finalAix);
  const hasTemplate = !!aixKey && TEMPLATE_AIX.has(aixKey);
  const aixAnswers = aixAsks.map(q);

  // ① AIX が無い番＝返信1通（受け・約束・答えを1通に）
  if (!aixKey) {
    const ans = [...replyAsks, ...promiseAsks].map(q);
    return { order: "single", count: 1, messages: [{ no: 1, slot: "reply", aix: null, answers: ans, role: "受け・答え・約束", duties: ans.length ? ["answer", "trust"] : ["trust"] }], why: "AIX の依頼が無い＝返信1通" };
  }

  const msgs: PlannedMessage[] = [];
  // 担う事: 返信＝答える（答えがあれば）＋信頼（受け止め・サポートの約束）／AIX＝答える（依頼に AIX で）／テンプレート＝訴求（＋その物件の質問の答え）
  const dutiesOf = (slot: PlanSlot, answers: string[]): Duty[] =>
    slot === "reply" ? (answers.length ? ["answer", "trust"] : ["trust"])
      : slot === "aix" ? (TEXT_AIX.has(String(aixKey)) ? ["answer", "trust"] : answers.length ? ["answer"] : []) // 文を書く AIX は文の中で受け止め（竹内さん「かしこまりました！！…ご案内させて頂きます」）
      : (answers.length ? ["appeal", "answer"] : ["appeal"]);
  const push = (slot: PlanSlot, answers: string[], role: string, aix: string | null = null) => msgs.push({ no: msgs.length + 1, slot, aix, answers, role, duties: dutiesOf(slot, answers) });

  // ② 初回で画像だけ・約束が要る番（条件・持ち込みの物件＝No.42 (b)(c)）＝返信が先（挨拶と約束）→ AIX（→ テンプレート）
  //    約束と返信の質問が両方ある番も、受けて答える返信（答え＋約束）→ AIX（KB bed48414: 竹内さんの近い番の順番＝受けて答える返信→2通目に AIX）
  // 2026-11-05 tm2 の読み（作業員7）: 文を書く AIX（内覧調整・待ち合わせ・電話・保証会社・当日の挨拶 等）の番は、約束も AIX の文の中で済ませる1通
  //   （竹内さん 7f73dc32「内覧調整の中で…物件の募集状況につきましても併せて確認させていただきます」・電話の AIX の中で審査の相談）。
  //   除く: 初回（挨拶と約束の返信が先）・ヒアリング／全力サポート（約束の返信 → AIX の RAR・RA が竹内さんの形）・不安の受け止めが要る依頼
  if (!i.firstContact && promiseAsks.length > 0 && TEXT_AIX.has(aixKey) && oneMessageInTextAixOn() && !promiseAsks.some(laterPromiseFor(aixKey))
    && !replyAsks.some((a) => a.kind === "concern" || a.kind === "feeling")) {
    push("aix", [...aixAnswers, ...promiseAsks.map(q), ...replyAsks.map(q)], "依頼に AIX で答え、約束・質問も AIX の文の中で", aixKey);
    msgs[0].duties = ["answer", "trust"];
    return { order: "single", count: 1, messages: msgs, why: "文を書く AIX＝約束も質問も AIX の文の中で1通（竹内さんの内覧調整・電話・保証会社の番）" };
  }
  if ((i.firstContact && i.imageOnly) || promiseAsks.length > 0) {
    const role = i.firstContact ? "挨拶と約束（満足のいくお部屋までサポートする姿勢）" : "受けと約束（確認・作成・探す）";
    push("reply", [...promiseAsks, ...replyAsks].map(q), role);
    push("aix", aixAnswers, "約束を果たす（スタッフが確かめた結果・物）", aixKey);
    if (hasTemplate) push("aix_template", [], "AIX の訴求・中身（次の一手へ）", aixKey);
    return { order: msgs.length >= 3 ? "three" : "reply_first", count: msgs.length, messages: msgs, why: i.firstContact && i.imageOnly ? "初回で画像だけ＝挨拶と約束の返信 → AIX（KB b834d9f0 ⑦）" : "約束が要る番＝約束の返信 → AIX（KB cf241dbd (b)(c)）" };
  }

  // ③ 返信で答えられる質問が無い＝AIX（→ 同じ AIX の訴求の通）
  if (replyAsks.length === 0) {
    push("aix", aixAnswers, "依頼に AIX で答える", aixKey);
    if (hasTemplate) push("aix_template", [], "AIX の訴求・中身（次の一手へ）", aixKey);
    return { order: "single", count: msgs.length, messages: msgs, why: "返信で答える質問が無い＝AIX で答える" };
  }

  // ④ 返信で答えられる質問＋AIX が混ざる番＝AIX が先。残りの答えは後ろの通
  //    AIX の中身に寄る質問（その物件・費用・空き）が1つだけで、テンプレートがある AIX なら 2通目のテンプレートで一緒に答える＝(b)
  //    それ以外は AIX → テンプレート（訴求）→ 返信（質問の答え）の3通＝(c)。テンプレートの無い AIX は AIX → 返信の2通
  // 2026-11-05 竹内さん「1通でよい番に余計な2通目を作らない」（作業員7 の数え・90日の竹内さんの番・質問＋AIX の番）:
  //   テンプレートの席の無い「文を書く AIX」（内覧調整・待ち合わせ・挨拶・電話・初期費用の説明・保証会社・申込 等）の番は 6〜7割が1通
  //   （AIX の文の中で答えた: 「お送りいただきました物件の募集状況につきましても併せて確認」「メジャーをお持ちして」「8日2物件ご案内」）。
  //   カードの AIX（見積書・物件確認・オススメ・ピックアップ）は1通が 1〜3割。
  //   → 文を書く AIX は、返信で答えられる質問を AIX の文の中で答える（1通）。分けるのは不安・心配の受け止めが要る依頼（kind=concern|feeling）がある時だけ（10/20 夜職の審査の番＝AR）
  if (TEXT_AIX.has(aixKey) && oneMessageInTextAixOn() && !replyAsks.some((a) => a.kind === "concern" || a.kind === "feeling")) {
    push("aix", [...aixAnswers, ...replyAsks.map(q)], "依頼に AIX で答え、返信で答えられる質問も AIX の文の中で答える", aixKey);
    msgs[0].duties = ["answer", "trust"];
    return { order: "single", count: 1, messages: msgs, why: "文を書く AIX＝質問も AIX の文の中で答える1通（竹内さんは文を書く AIX の番の 6〜7割が1通）" };
  }
  push("aix", aixAnswers, "依頼に AIX で答える（スタッフだけが知る事）", aixKey);
  const contentAsks = replyAsks.filter((a) => AIX_CONTENT_ABOUT.test(String(a.about ?? "")));
  if (hasTemplate && replyAsks.length === 1 && contentAsks.length === 1) {
    push("aix_template", replyAsks.map(q), "AIX の訴求・中身＋その物件への質問の答え", aixKey);
    return { order: "aix_first", count: 2, messages: msgs, why: "AIX の中身の質問が1つ＝2通目のテンプレートで一緒に答える（KB b834d9f0 (b)）" };
  }
  if (hasTemplate) push("aix_template", [], "AIX の訴求・中身（次の一手へ）", aixKey);
  push("reply", [...replyAsks, ...promiseAsks].map(q), "質問の答え・サポートの約束");
  return { order: msgs.length >= 3 ? "three" : "aix_first", count: msgs.length, messages: msgs, why: msgs.length >= 3 ? "返信で答える質問＋テンプレートのある AIX＝AIX → テンプレート → 返信の3通（竹内さん 11/05 追記）" : "返信で答える質問＋AIX＝AIX → 返信の2通（KB b834d9f0 (a)(b)）" };
}

const slotLabel = (m: PlannedMessage): string =>
  m.slot === "reply" ? "返信" : m.slot === "aix" ? `AIX【${aixLabelOf(m.aix)}】` : `AIX テンプレート（${aixLabelOf(m.aix)}の続き）`;
const circled = ["①", "②", "③", "④"];

/** 従業員への知らせの1行（画面）。1通だけの番は null（出さない） */
export function planAnnounce(p: TwoMessagePlan | null | undefined): string | null {
  if (!p || p.count < 2) return null;
  const parts = p.messages.map((m, k) => {
    const ans = m.answers.length ? `：${m.answers.slice(0, 2).map((a) => `「${a.slice(0, 16)}」`).join("・")}に答える` : m.slot === "aix_template" ? "：訴求・中身" : "";
    return `${circled[k] ?? `${k + 1}.`}${slotLabel(m)}${ans}`;
  });
  return `この番は${p.count}通: ${parts.join(" → ")}`;
}

/**
 * AIX を送った後に、まだ答えていない通（AIX テンプレート／返信）。送った AIX が計画の AIX と違う時・残りが無い時は null。
 *   画面の帯・AIX の後の下書きの材料に使う（送るのはスタッフ・自動では送らない）。
 */
export function remainingAfterAix(p: TwoMessagePlan | null | undefined, sentAix: string | null | undefined): PlannedMessage[] | null {
  if (!p) return null;
  const k = baseKey(sentAix);
  const idx = p.messages.findIndex((m) => m.slot === "aix" && m.aix === k);
  if (idx < 0) return null;
  const rest = p.messages.slice(idx + 1);
  return rest.length ? rest : null;
}

/** 2通目の AIX テンプレートの書く役への材料（この通で答える質問・後ろの返信に回す質問）。渡す物が無ければ "" */
export function templateReplyPartNote(p: TwoMessagePlan | null | undefined, sentAix: string | null | undefined): string {
  const rest = remainingAfterAix(p, sentAix);
  if (!rest) return "";
  const tpl = rest.find((m) => m.slot === "aix_template");
  const reply = rest.find((m) => m.slot === "reply");
  const lines: string[] = [];
  if (tpl && tpl.answers.length) lines.push(`・この通（AIX の2通目）で、AIX の訴求・中身と一緒に次の質問にも答える: ${tpl.answers.map((a) => `「${a}」`).join("・")}（会話・資料・送った AIX の中身にある事だけ・確かめていない事は言い切らない）`);
  if (reply && reply.answers.length) lines.push(`・次の質問は、この通の後に別の返信で答える＝この通には書かない（AIX の訴求・中身を中心に書く）: ${reply.answers.map((a) => `「${a}」`).join("・")}`);
  return lines.length ? `【この番の組み立て（${p!.count}通・型 ${p!.shape}・竹内さん 11/05）】${p!.shapeWhy ? `\n・なぜ: ${p!.shapeWhy}` : ""}\n${lines.join("\n")}` : "";
}

/** AIX の後の返信の下書きの材料（返信の通が残っていれば、その通が答える依頼とブレインの答えの要点）。無ければ null */
/**
 * 2026-11-06 弱い所 343 の続き（作業員7・統括役の決め）: カードの AIX（物件オススメ・見積書・物件確認した）の後の続きの通（aix_template の席）も下書きにする。
 *   竹内さん本人の90日: AIX の後に続けた手打ちの通 540 のうち、物件オススメの後 312 の 92%・見積書の後 125 の 94% がテンプレートの言い回し
 *   （「最大限割引しました初期費用の御見積書となります」「お気に召されましたら…ご案内」＝信頼と訴求）。答える通は 37%。
 *   既定 off（TWO_MESSAGE_AFTER_AIX_T_DRAFT=on の時だけ・off は今と同じ＝返信の席だけ）
 */
export function afterAixTemplateDraftOn(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_AFTER_AIX_T_DRAFT ?? (env.NEXT_PUBLIC_TWO_MESSAGE_AFTER_AIX_T_DRAFT ?? "")).trim().toLowerCase() === "on";
}
export function afterAixReplyBrief(p: TwoMessagePlan | null | undefined, sentAix: string | null | undefined, asks: ReadonlyArray<PlanAsk> | null | undefined, env: Env = envOf()): { answers: Array<{ quote: string; answer: string | null }>; role: string; template?: boolean } | null {
  const rest = remainingAfterAix(p, sentAix);
  const reply = rest?.find((m) => m.slot === "reply");
  if ((!reply || !reply.answers.length) && afterAixTemplateDraftOn(env)) {
    const t = rest?.find((m) => m.slot === "aix_template");
    if (t) { const byQ = new Map((asks ?? []).map((a) => [a.quote.slice(0, 40), a.answer ?? null] as const)); return { answers: t.answers.map((qq) => ({ quote: qq, answer: byQ.get(qq) ?? null })), role: t.role, template: true }; }
  }
  if (!reply || !reply.answers.length) return null;
  const byQuote = new Map((asks ?? []).map((a) => [a.quote.slice(0, 40), a.answer ?? null] as const));
  return { answers: reply.answers.map((qq) => ({ quote: qq, answer: byQuote.get(qq) ?? null })), role: reply.role };
}

/** digest に残す短い形（例 "three:A>T>R"）。統括の「使った順番」の記録 */
export function planDigest(p: TwoMessagePlan | null | undefined): string | null {
  if (!p) return null;
  return `${p.order}:${p.messages.map((m) => (m.slot === "reply" ? "R" : m.slot === "aix" ? "A" : "T")).join(">")}`;
}

/**
 * 画面の知らせを出すか（2026-11-05 竹内さん「最初は YUMA だけで出して、画面で見てから全員に広げる」）。
 *   NEXT_PUBLIC_TWO_MESSAGE_PLAN: 未設定＝YUMA・テスト専用の会話だけ／all＝全員／off＝出さない
 */
export function twoMessageAnnounceVisible(v: string | null | undefined, isTestConv: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "off") return false;
  if (s === "all") return true;
  return isTestConv;
}
/**
 * 2026-11-06 弱い所 305（作業員7・統括役の決め 案A）: AIX を送った後に返信が残る番で、画面が下書きを1回自動で作るか。
 *   竹内さんの30日: AIX の後に続けた手打ちの返信 40 のうち 28 が下書きなし。送信はしない（下書き欄に入るだけ・打ち始めていたら作らない）。
 *   NEXT_PUBLIC_TWO_MESSAGE_AFTER_AIX_AUTO: 既定 off／on＝YUMA・テスト専用の会話だけ（全員に広げるのは竹内さんの確認の後）
 */
export function twoMessageAfterAixAutoOn(v: string | null | undefined, isTestConv: boolean): boolean {
  return (v ?? "").trim().toLowerCase() === "on" && isTestConv;
}

/** AIX の後の返信の下書きを作る時の指定（generate-reply の replyHint＝スタッフが押した指定）。材料が無ければ "" */
export function afterAixDraftHint(brief: ReturnType<typeof afterAixReplyBrief>, sentAix: string | null | undefined): string {
  if (brief?.template) {
    const qs0 = brief.answers.map((a) => `「${a.quote}」${a.answer ? `（要点: ${a.answer}）` : ""}`).join("・");
    return `【AIX の後に続けて送る通（この番の組み立て・竹内さん 11/05）】先に AIX【${aixLabelOf(sentAix)}】を送った。この通は AIX の続き: 送った物の受け止めと信頼（竹内さんの形「〇〇号室最大限割引しました初期費用の御見積書となります！！」「お送りさせて頂きましたお部屋の中でも〇〇号室が…オススメのお部屋となります！！」）と、訴求（「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」）を短く。${qs0 ? `次の質問にも答える: ${qs0}。` : ""}AIX で送った金額・日時・資料に無い事は書かない。挨拶は入れない（同じ番の続き）。`;
  }
  if (!brief || !brief.answers.length) return "";
  const qs = brief.answers.map((a) => `「${a.quote}」${a.answer ? `（要点: ${a.answer}）` : ""}`).join("・");
  return `【AIX の後に続けて送る返信（この番の組み立て・竹内さん 11/05）】先に AIX【${aixLabelOf(sentAix)}】を送った。この返信は次の質問だけに答える: ${qs}。AIX で送った事（物件・金額・日時）は繰り返さない。挨拶は入れない（同じ番の続き）。`;
}

// ── 統括へのつなぎ（11/05 竹内さん「組み合わせを決めるのは統括」・作業員5の FOCUS_ORDER と合わせる案）───────────────
//   統括の順番の表の compose の段の先頭に役「combine」（判断の turn_contract＋重点 → 何通・どの順・各通の受け持ち）を置き、統括がこれを呼ぶ。
//   結果は meta.two_message_plan に1つだけ置き（1つの正）、テンプレート・画面・書き手は読むだけ（無い時だけ自分で作る＝今の形）。
//   重点（作業員5 conductor-focus の Focus）は「訴求できる場面か」を決める材料にだけ使う（決め直さない）。
/** 重点から訴求できる場面か（決めに行く・物件を出す・約束を果たす＝送る物がある）。それ以外は呼ぶ側が渡した値 */
export function canAppealFromFocus(focus: string | null | undefined, fallback = false): boolean {
  if (focus === "close" || focus === "propose" || focus === "promise_keep") return true;
  if (focus === "ease" || focus === "relation" || focus === "promise_make") return false;
  return fallback;
}
/** 統括が呼ぶ形（meta.two_message_plan に入れる物・短い） */
export function planForConductor(i: PlanInput & { focus?: string | null }): { plan: TwoMessagePlan; check: ReturnType<typeof checkPlan>; digest: string | null } {
  const canAppeal = i.canAppeal ?? canAppealFromFocus(i.focus ?? null);
  const plan = planMessages({ ...i, canAppeal });
  return { plan, check: checkPlan(plan, { asks: i.asks, canAppeal }), digest: planDigest(plan) };
}
/** 統括が meta.two_message_plan に置いた組み立てを読む（形が合わなければ null＝呼ぶ側が自分で作る） */
/** 計画が古いか（作業員5 conductor-replan.planIsStale をそのまま使う・KB ea2a9405②） */
export function twoMessagePlanStale(seen: string | null | undefined, latest: string | null | undefined): boolean {
  return planIsStale(seen, latest);
}
export function planFromMeta(meta: unknown, latestCustomerAt?: string | null): TwoMessagePlan | null {
  const v = (meta as { two_message_plan?: unknown } | null | undefined)?.two_message_plan;
  // 統括が置いた seen_customer_at（その組み立てが見た一番新しいお客様の発言の時刻）より新しいお客様の発言があれば使わない＝呼ぶ側が作り直す
  if (latestCustomerAt !== undefined && v && typeof v === "object") {
    const seen = (v as { seen_customer_at?: string | null }).seen_customer_at;
    if (twoMessagePlanStale(seen, latestCustomerAt)) return null;
  }
  const p = v && typeof v === "object" && "plan" in (v as object) ? (v as { plan: unknown }).plan : v;
  if (!p || typeof p !== "object") return null;
  const o = p as Partial<TwoMessagePlan>;
  if (!Array.isArray(o.messages) || !o.messages.length || typeof o.order !== "string") return null;
  const ok = o.messages.every((m) => m && (m.slot === "reply" || m.slot === "aix" || m.slot === "aix_template") && Array.isArray(m.answers));
  if (!ok) return null;
  const messages = o.messages.map((m, k) => ({ ...m, no: k + 1, aix: m.aix ?? null, role: String(m.role ?? ""), duties: Array.isArray(m.duties) ? m.duties : [] }));
  const shape = typeof o.shape === "string" ? o.shape : shapeOf(messages);
  return { order: o.order as PlanOrder, count: messages.length, messages, why: String(o.why ?? ""), shape, shapeWhy: String(o.shapeWhy ?? SHAPE_WHY[shape] ?? "") };
}
