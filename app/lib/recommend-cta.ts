// app/lib/recommend-cta.ts
// AIX【物件オススメ】（1件・新着1件）と、その直後の2通目の「締め」を、刺さり具合で3つに分ける（純関数・DB 依存なし）。
//
// 2026-09-30 竹内（YUMA の実送信テストで2通目が「ファーストフィオーレ難波ウエスト901号室は…Go Palace Fukushima 203号室は
//   72,500円と、こちらの方が…私個人的にはこちらがオススメです」になったのを見て）:
//   「1件だけ オススメは特にオススメするイメージなので、内覧誘導など実際の AIX テンプレートのような文をつかう。
//    お客さんが刺さる物件の時は内覧誘導、刺さりそうやけど退去予定の物件は退去予定と伝えて申込誘導、
//    そこまで刺さらなそうならお手隙の際にご査収くださいでおくるかたち。新着物件1件を送るときも同じ」
//
//   ① 刺さる            → 内覧誘導   「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
//   ② 刺さる＋退去予定    → 退去予定を伝えて申込誘導  「N月N日退去予定のため、M月M日以降にご内覧可能です！！」＋
//                          「お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！」
//   ③ そこまで刺さらない  → 「お手隙の際にご査収ください😊！！」（退去予定ならその事実の行はそのまま残す）
//
// ■ 言い回しは創作しない（feedback_no_invented_phrases）
//   3つとも実送信（scripts/audit-recommend-cta.ts・365日・YUMA 除く・ai_reply_examples の物件オススメ1件 858通）の形そのもの:
//     ご査収           「お手隙の際にご査収ください😊！！」系 126通（最多）
//     内覧誘導         「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます」系 約70通
//     退去予定＋申込   「お気に召されましたらお申込しお部屋抑えさせて頂きます」系（退去予定110通のうち申込誘導25通＝22.7%・
//                      内覧誘導13通＝11.8%・誘導なし64通＝58.2%）
//
// ■ 実測が教える事（正直に）
//   実送信では締めの誘導が**無い通が58%**（見積書同封・退去予定の行で終わる等）。内覧誘導16.9%・ご査収17.1%・申込誘導7.7%。
//   成約側（申込以降を除く前段）は誘導なし89%。つまり「毎回誘導を付ける」は実送信の姿ではない。
//   それでも竹内さんの明示の指示（9/30）で、締めを**必ず3つのどれかにする**。押しすぎないため、迷う時は ③ に倒す。
//
// ■ 「刺さる」の判定（分からない時は ③）
//   使える材料は採点（property_pickups の verdict／reason_codes）とお客様の直近の反応（classifyCustomerResponse）。
//   purchase_signal_level は使わない（設計知見: peak は「申込した」の事後の追認）。
//   ・採点が読める時 … verdict=pass ∧ 「書いた条件に全部合う」（FIT_ALL／FIT_ALL_HALF）∧ 外れ寄りの札が1つも無い → 刺さる。
//       ⚠ 点（score）は使わない: AD（報酬）の点が入っていてお客様への刺さりではない。
//   ・採点が読めない時 … お客様の直近の反応が「前向き」（positive）なら刺さる。それ以外は ③。
//   ・お客様が懸念（concern）／条件の変更（condition_change）／断り（decline）を言っている時は、採点が良くても ③（押さない）。
//     （実測 2通目の CTA 率: concern 3.2%／condition_change 1.1%）

import { APPLY_CLOSING_LINE } from "./recommend-closing";
import { readFirstMessage } from "./aix-chain-note";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, type CustomerResponseKind } from "./reply-context";

export type RecommendCtaKind = "viewing" | "apply" | "receipt";
export type Appeal = "strong" | "weak";

/** 実送信の形（そのまま使う・創作しない） */
export const VIEWING_CLOSING_LINE = "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
export const RECEIPT_CLOSING_LINE = "お手隙の際にご査収ください😊！！";
export { APPLY_CLOSING_LINE };

const CLOSING_LINE: Record<RecommendCtaKind, string> = {
  viewing: VIEWING_CLOSING_LINE,
  apply: APPLY_CLOSING_LINE,
  receipt: RECEIPT_CLOSING_LINE,
};

/** 採点の「外れ寄り」の札（1つでもあれば刺さるとは言わない） */
const OFF_CODE_RE = /(?:_SLIGHTLY_OVER|_OVER(?:_\d+)?|_WIDE|_LATE|_NG|_MISMATCH|_TOO_SMALL|_UNDER(?:_MIN(?:_SOFT)?)?|_BELOW_MIN|_NEAR_MIN|_FAR|_EXCLUDED|_ALT_MATCH|_2STOPS|_LARGER|_SAME_CLASS|_ONE_MISS(?:_HALF)?)$|^(?:AREA_CLOSE|RENT_ABOVE_USUAL|RENT_BAND_LOW|RENT_TARGET_FAR|PROFIT_NEGATIVE|INITIAL_COST_NOT_ZERO|INITIAL_COST_OVER_LIMIT|AGE_W_OLD|ALREADY_SENT(?:_OTHER_ROOM|_SAME_ROOM)?|FLOOR_PLAN_NEAR|SQM_SLIGHTLY_UNDER)$/;
const FIT_CODES = new Set(["FIT_ALL", "FIT_ALL_HALF"]);

export type PickupAppealRow = {
  verdict?: string | null;
  reason_codes?: readonly string[] | null;
};

/** 採点から見た刺さり具合。採点が読めなければ null（＝決められない） */
export function appealFromPickup(row: PickupAppealRow | null | undefined): { appeal: Appeal; why: string } | null {
  if (!row) return null;
  const codes = (row.reason_codes ?? []).filter((c): c is string => typeof c === "string");
  if (!row.verdict || codes.length === 0) return null;
  if (row.verdict !== "pass") return { appeal: "weak", why: `verdict=${row.verdict}` };
  if (!codes.some((c) => FIT_CODES.has(c))) return { appeal: "weak", why: "全部合うの札なし" };
  const off = codes.filter((c) => OFF_CODE_RE.test(c));
  if (off.length > 0) return { appeal: "weak", why: `外れ寄り:${off.slice(0, 3).join(",")}` };
  return { appeal: "strong", why: "pass・全部合う・外れ寄りなし" };
}

export type CustomerReaction = { kind: CustomerResponseKind | null; positiveKind: string | null };

/** お客様の直近の発言の分類（返信生成・CTA の判断と同じ classifyCustomerResponse）。読めなければ null */
export function readCustomerReaction(
  recent: ReadonlyArray<{ sender?: string | null; text?: string | null; rawCreatedAt?: string | null }> | null | undefined,
): CustomerReaction | null {
  try {
    const list = Array.isArray(recent) ? recent : [];
    const lastCust = [...list].reverse().find((m) => m.sender === "customer" && (m.text ?? "").trim());
    if (!lastCust) return null;
    const idx = list.lastIndexOf(lastCust);
    const prevStaff = [...list.slice(0, idx)].reverse().find((m) => m.sender === "staff" && (m.text ?? "").trim());
    const staffTurn = classifyLastStaffTurn(prevStaff?.text ?? "", { lastStaffAt: prevStaff?.rawCreatedAt ?? null });
    const sub = analyzeSubstance(lastCust.text ?? "", undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
    const cr = classifyCustomerResponse(sub, staffTurn);
    return { kind: cr.kind, positiveKind: cr.positive?.kind ?? null };
  } catch {
    return null;
  }
}

/** 押してはいけない反応 */
const HOLD_BACK_KINDS: ReadonlySet<string> = new Set(["concern", "condition_change", "decline"]);

export type RecommendCtaDecision = {
  kind: RecommendCtaKind;
  appeal: Appeal;
  notViewable: boolean;
  /** 判断の根拠（ログ・監査用） */
  reason: string;
};

/**
 * 締めの種類を決める（1通目・2通目が同じ関数を見る）。
 *   刺さる ∧ 内覧できる → viewing／刺さる ∧ 退去予定 → apply／それ以外 → receipt
 */
export function resolveRecommendCta(input: {
  pickup?: PickupAppealRow | null;
  reaction?: CustomerReaction | null;
  /** まだご内覧頂けない（退去予定・解禁日が明日以降）。ブレインの判断（property-send-state） */
  notViewable: boolean;
}): RecommendCtaDecision {
  const p = appealFromPickup(input.pickup);
  const r = input.reaction ?? null;
  let appeal: Appeal = "weak";
  let reason: string;
  if (r?.kind && HOLD_BACK_KINDS.has(r.kind)) {
    reason = `お客様が${r.kind}を言っている（押さない）`;
  } else if (p) {
    appeal = p.appeal;
    reason = `採点: ${p.why}`;
  } else if (r?.kind === "positive") {
    appeal = "strong";
    reason = `採点なし・お客様が前向き(${r.positiveKind ?? "positive"})`;
  } else {
    reason = `採点なし・お客様の反応=${r?.kind ?? "-"}（決められない→ご査収）`;
  }
  const kind: RecommendCtaKind = appeal === "weak" ? "receipt" : input.notViewable ? "apply" : "viewing";
  return { kind, appeal, notViewable: input.notViewable, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文の側（1通目の出口・2通目の材料）
// ─────────────────────────────────────────────────────────────────────────────

/** 文の締めの種類を読む（無ければ null）。最後の段落の中身で決める */
export function readClosingKind(text: string | null | undefined): RecommendCtaKind | null {
  const paras = paragraphs(text ?? "");
  const last = paras[paras.length - 1] ?? "";
  return closingKindOfParagraph(last);
}

/** 文全体に、その種類の締めが（どの段落にでも）あるか。2通目が1通目の締めを重ねないための確認 */
export function hasClosingKind(text: string | null | undefined, kind: RecommendCtaKind): boolean {
  return paragraphs(text ?? "").some((p) => closingKindOfParagraph(p) === kind);
}

const paragraphs = (t: string) => t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

const RECEIPT_PARA_RE = /^お手隙の際に(?:ごゆっくり)?(?:ご査収|ご確認|ご検討)(?:ください|下さい)[^\n]{0,6}$/;
const VIEWING_PARA_RE = /^[^\n]{0,20}?お気に召(?:され|し)(?:まし)?たら?[^\n]{0,60}?(?:ご案内|ご内覧)(?:させて(?:頂|いただ)き|いたし|致し)(?:ます|ましたら)[^\n]{0,8}$/;
const APPLY_PARA_RE = /^[^\n]{0,20}?お気に召(?:され|し)(?:まし)?たら?[^\n]{0,40}?(?:申込|抑え|押さえ)[^\n]{0,24}$/;
/** 2通目の定番の受けの一文（実送信・「気になる点があればいつでもお気軽にご連絡ください」）。CTA はこの前に入れる */
const SOFT_TAIL_RE = /^(?:気になる点|ご不明点|ご不明な点)[^\n]{0,30}(?:お気軽に|いつでも)[^\n]{0,24}ご連絡[^\n]{0,10}$/;

function closingKindOfParagraph(p: string): RecommendCtaKind | null {
  const s = p.trim();
  if (!s || s.length > 90 || /\d{2,}/.test(s.replace(/[０-９]/g, "0"))) return null; // 金額・号室を含む段落は締めではない
  if (RECEIPT_PARA_RE.test(s)) return "receipt";
  if (APPLY_PARA_RE.test(s)) return "apply";
  if (VIEWING_PARA_RE.test(s)) return "viewing";
  return null;
}

export type SetClosingResult = { text: string; applied: string[] };

/**
 * 締めを決めた種類に揃える（出口）。
 * ・最後の段落が「締めの定型だけ」（ご査収／内覧誘導／申込誘導）なら、それを決めた種類の定型に差し替える。
 * ・最後が定型でなければ**何も消さず**、決めた定型を最後の段落として足す（2通目の受けの一文「気になる点があれば…」の前に入れる）。
 * ・既に同じ定型なら何もしない。
 * ⚠ 消すのは「定型だけの最後の段落」に限る（金額・号室を含む段落・90字超の段落は締めと見ない）＝本文の中身は落とさない。
 *   建築中（「※こちらのお部屋は建築中のため…のみで締める」）は呼び出し側で除く（skipReason を返す）。
 */
export function setRecommendClosing(
  text: string,
  kind: RecommendCtaKind,
  o: { skipIfUnderConstruction?: boolean } = {},
): SetClosingResult {
  const src = (text ?? "").trim();
  if (!src) return { text: text ?? "", applied: [] };
  if (o.skipIfUnderConstruction !== false && /建築中|新築未完成|竣工予定/.test(src)) return { text: text, applied: ["skip:under_construction"] };
  const line = CLOSING_LINE[kind];
  const paras = paragraphs(src);
  const last = paras[paras.length - 1] ?? "";
  if (last === line) return { text: text, applied: [] };
  // 2026-09-30 YUMA の2通目: 最後の段落が「退去予定のお部屋となります！！⏎お気に召されましたらお申込し…」の2行で、
  //   段落まるごとは締めと見なされず、同じ締めがもう1回足された（同じ文が2回）。最後の段落の**最後の行**が締めの定型ならそこを見る
  const lastLines = last.split("\n").map((x) => x.trim()).filter(Boolean);
  const tailLine = lastLines[lastLines.length - 1] ?? "";
  if (lastLines.length >= 2) {
    if (tailLine === line) return { text: text, applied: [] };
    const tailKind = closingKindOfParagraph(tailLine);
    if (tailKind) {
      lastLines[lastLines.length - 1] = line;
      paras[paras.length - 1] = lastLines.join("\n");
      return { text: paras.join("\n\n"), applied: [`closing:${tailKind}->${kind}`] };
    }
  }
  const lastKind = closingKindOfParagraph(last);
  if (lastKind) {
    paras[paras.length - 1] = line;
    return { text: paras.join("\n\n"), applied: [`closing:${lastKind}->${kind}`] };
  }
  if (SOFT_TAIL_RE.test(last)) {
    // 受けの一文の前に入れる（その手前が既に同種の締めなら差し替え）
    const prevKind = paras.length >= 2 ? closingKindOfParagraph(paras[paras.length - 2]) : null;
    if (prevKind) { paras[paras.length - 2] = line; return { text: paras.join("\n\n"), applied: [`closing:${prevKind}->${kind}`] }; }
    paras.splice(paras.length - 1, 0, line);
    return { text: paras.join("\n\n"), applied: [`closing:added(${kind})`] };
  }
  paras.push(line);
  return { text: paras.join("\n\n"), applied: [`closing:added(${kind})`] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口（プロンプトに渡す材料）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1通目（AIX 物件オススメ）に渡す指示。締めの定型は実送信の形そのもの。
 * 締め以外（冒頭・見出し・設備・費用）は触らない。
 */
export function buildFirstMessageCtaNote(d: RecommendCtaDecision, o: { viewableFrom?: string | null } = {}): string {
  const L: string[] = ["【この通の締め（刺さり具合で決まる・この形で締める）】"];
  if (d.kind === "viewing") {
    L.push(`・このお部屋はお客様に刺さる物件（${d.reason}）で、今ご内覧頂ける → 締めは内覧の誘導「${VIEWING_CLOSING_LINE}」`);
  } else if (d.kind === "apply") {
    L.push(`・このお部屋はお客様に刺さりそうだが退去予定でまだご内覧頂けない${o.viewableFrom ? `（${o.viewableFrom}以降にご内覧可能）` : ""}（${d.reason}）`
      + ` → 退去予定であることを伝える一文の後に、申込の誘導「${APPLY_CLOSING_LINE}」で締める（内覧の誘導は書かない）`);
  } else {
    L.push(`・そこまで刺さるとは言い切れない（${d.reason}） → 押さず、「${RECEIPT_CLOSING_LINE}」で締める`
      + (d.notViewable ? `。退去予定の事実（退去予定日・ご内覧可能日）の一文は残す` : ""));
  }
  L.push("・締めの一文は上の定型のまま（言い回しを足さない・変えない）。「埋まってしまう前に」等の煽りは書かない");
  return L.join("\n");
}

/**
 * 2通目（AIX の直後に送るテンプレート）に渡す指示。1通目が既に同じ締めを持っていれば重ねない。
 * ⚠ 別の物件を持ち出して比べない・していない約束を足さない（呼び出し側の chain-note と同じ線）。
 */
export function buildSecondMessageCtaNote(
  d: RecommendCtaDecision,
  o: { firstMessage?: string | null; viewableFrom?: string | null } = {},
): string {
  const already = hasClosingKind(o.firstMessage, d.kind);
  const L: string[] = ["【この2通目の締め（1件を特にオススメする通・刺さり具合で決まる。上の CTA の指示より優先）】"];
  if (already) {
    L.push(`・1通目が既に同じ締め（${d.kind === "viewing" ? "内覧の誘導" : d.kind === "apply" ? "申込の誘導" : "ご査収"}）で終わっている → **2通目では重ねない**。`
      // 2026-09-30 竹内「言い回しが AI くさい」: 「見立てを1つだけ添えて」と書くと評論の一文（〜ならではの強みです）が作られた → 指示の語から外す
      + `オススメの文で終わる（誘導・ご査収を繰り返さない）。`);
  } else if (d.kind === "viewing") {
    L.push(`・お客様に刺さる物件（${d.reason}）で、今ご内覧頂ける → 締めは内覧の誘導 1文。実送信の形「${VIEWING_CLOSING_LINE}」のまま`);
  } else if (d.kind === "apply") {
    L.push(`・刺さりそうだが退去予定でまだご内覧頂けない${o.viewableFrom ? `（${o.viewableFrom}以降にご内覧可能）` : ""}（${d.reason}） → 退去予定と伝えて、申込の誘導 1文。実送信の形「${APPLY_CLOSING_LINE}」のまま（内覧の誘導は書かない）`);
  } else {
    L.push(`・そこまで刺さるとは言い切れない（${d.reason}） → 押さず、実送信の形「${RECEIPT_CLOSING_LINE}」で締める`);
  }
  L.push("・締めの一文は上の形のまま（言い回しを足さない・変えない）。締めの後に別の一文（「気になる点があれば〜」等）を足さない");
  L.push("・1通目に出ている物件だけを書く。**別の物件を持ち出して比べない**（「こちらの方が」「私個人的には」も書かない）。していない約束を足さない");
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2通目: 1通目の物件に当たる採点の行を選ぶ
// ─────────────────────────────────────────────────────────────────────────────

export type PickupLookupRow = PickupAppealRow & { property_name?: string | null; room_no?: string | null; created_at?: string | null };

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const roomNo = (s: string) => s.normalize("NFKC").replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/**
 * 1通目の本文（見出し「🌟建物名 号室」）に当たる採点の行を1つ選ぶ。号室が一致し、建物名の頭6字が互いに含まれる行だけ。
 * 複数あれば新しい行。1つも無ければ null（＝決められない→ご査収に倒れる）。別の建物・別の号室の採点は絶対に使わない。
 */
export function pickupForFirstMessage(rows: ReadonlyArray<PickupLookupRow>, head: { name: string; room: string } | null): PickupLookupRow | null {
  if (!head) return null;
  const hn = norm(head.name).slice(0, 6);
  const hr = roomNo(head.room);
  if (!hn || !hr) return null;
  const hits = rows.filter((r) => {
    if (!r.property_name || !r.room_no) return false;
    const rn = norm(r.property_name);
    return roomNo(r.room_no) === hr && (rn.includes(hn) || norm(head.name).includes(rn.slice(0, 6)));
  });
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0];
}

/** 1通目の本文から見出し（建物名・号室）を読む（aix-chain-note の読み取りと同じ）。読めなければ null */
export function headOfFirstMessage(firstMessage: string | null | undefined): { name: string; room: string } | null {
  const first = readFirstMessage(firstMessage);
  const label = first.propertyLabels[0];
  if (!label) return null;
  const m = label.match(/^(.*)\s(\d{2,4})号室$/);
  return m ? { name: m[1], room: m[2] } : null;
}
