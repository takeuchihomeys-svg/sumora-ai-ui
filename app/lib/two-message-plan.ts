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
// スイッチ: TWO_MESSAGE_PLAN=on（サーバー）・NEXT_PUBLIC_TWO_MESSAGE_PLAN=on（画面）— どちらも既定 off＝今と1文字も変わらない。
// テスト: app/lib/__tests__/two-message-plan.test.ts

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function twoMessagePlanOn(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_PLAN ?? "").trim().toLowerCase() === "on";
}
/** 画面（NEXT_PUBLIC_ はビルドで埋まる＝呼ぶ側が値を渡す） */
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
};
export type TwoMessagePlan = { order: PlanOrder; count: number; messages: PlannedMessage[]; why: string };

/** 2通目の AIX テンプレート（同じ AIX の訴求・中身の通）がある AIX。竹内さんの形 AT 157・RAT 68 の AIX */
const TEMPLATE_AIX = new Set(["estimate_sheet", "property_recommendation", "property_check_result"]);
/** AIX の中身（訴求）に寄る依頼＝テンプレートの通で答えられる（物件そのもの・費用・空き） */
//   about の値は request-ledger の RequestAbout（property_equipment・property_cost・vacancy）
const AIX_CONTENT_ABOUT = /^(?:property_equipment|property_cost|vacancy)$/;

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
export function planMessages(i: {
  asks: ReadonlyArray<PlanAsk> | null | undefined;
  finalAix?: string | null;
  firstContact?: boolean;
  imageOnly?: boolean;
}): TwoMessagePlan {
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
    return { order: "single", count: 1, messages: [{ no: 1, slot: "reply", aix: null, answers: [...replyAsks, ...promiseAsks].map(q), role: "受け・答え・約束" }], why: "AIX の依頼が無い＝返信1通" };
  }

  const msgs: PlannedMessage[] = [];
  const push = (slot: PlanSlot, answers: string[], role: string, aix: string | null = null) => msgs.push({ no: msgs.length + 1, slot, aix, answers, role });

  // ② 初回で画像だけ・約束が要る番（条件・持ち込みの物件＝No.42 (b)(c)）＝返信が先（挨拶と約束）→ AIX（→ テンプレート）
  if ((i.firstContact && i.imageOnly) || (promiseAsks.length > 0 && replyAsks.length === 0)) {
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
  return lines.length ? `【この番の組み立て（${p!.count}通・竹内さん 11/05）】\n${lines.join("\n")}` : "";
}

/** AIX の後の返信の下書きの材料（返信の通が残っていれば、その通が答える依頼とブレインの答えの要点）。無ければ null */
export function afterAixReplyBrief(p: TwoMessagePlan | null | undefined, sentAix: string | null | undefined, asks: ReadonlyArray<PlanAsk> | null | undefined): { answers: Array<{ quote: string; answer: string | null }>; role: string } | null {
  const rest = remainingAfterAix(p, sentAix);
  const reply = rest?.find((m) => m.slot === "reply");
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

/** AIX の後の返信の下書きを作る時の指定（generate-reply の replyHint＝スタッフが押した指定）。材料が無ければ "" */
export function afterAixDraftHint(brief: ReturnType<typeof afterAixReplyBrief>, sentAix: string | null | undefined): string {
  if (!brief || !brief.answers.length) return "";
  const qs = brief.answers.map((a) => `「${a.quote}」${a.answer ? `（要点: ${a.answer}）` : ""}`).join("・");
  return `【AIX の後に続けて送る返信（この番の組み立て・竹内さん 11/05）】先に AIX【${aixLabelOf(sentAix)}】を送った。この返信は次の質問だけに答える: ${qs}。AIX で送った事（物件・金額・日時）は繰り返さない。挨拶は入れない（同じ番の続き）。`;
}
