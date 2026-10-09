// app/lib/estimate-second-message.ts
// AIX【見積書送る】の直後に送る2通目（AIX テンプレート「見積書送る【AIX】」の ✨ 生成）の形・締め・検査（純関数・DB 依存なし）。
//
// 2026-10-01 竹内「AIXテンプレートの部分、物件オススメのところが改善されたように、見積書や他のよく使うAIXテンプレートの部分も改善する。
//   設計知見と協力して改善する」
//
// ■ 実送信を「スタッフが書いた／直した／AI のまま」に分けた（scripts/audit-aix-human-pattern.ts --type=estimate_sheet・365日・YUMA 除く）
//   見積書送る 244回 → 2通目が続いた 217回（89%）: スタッフが書いた 132 ／ AI の下書き（テンプレート）を直した 23 ／ ほぼそのまま 62
//   （ほぼそのまま 62 の多くは2枚目の見積書の本体＝🌟と金額の行。カバーの文ではない）
//   9/19 を最後にテンプレートの ✨ 生成はほぼ使われず、スタッフが手で書いている＝ここが人の書き方の一番きれいな証拠。
//   スタッフが書いた 132通: 長さ中央値 102字・4文・2段落／絵文字 1個 61%・2個以上 28%（😊79・😌70）
//     ・中身: 「最大限割引」61%・「御見積書／お見積書」82%・物件名（号室）23%・金額 12%
//     ・締め: ご査収 61%（最後の行が「お手隙の際にご査収ください！！」73/132）・申込 28%・内覧 22%
//     ・内覧の前（AIX 待ち合わせ場所より前）106通: 内覧 25%・申込 28%・ご査収 59% ／ 内覧の後 26通: 内覧 12%・申込 27%・ご査収 69%
//   AI の下書きを直した 23通: 申込 70%（下書きの指示が「CTA は申込」だった）
//
// ■ 直す前の YUMA の生成（DeepSeek・6回）: 6/6 が申込の誘い（「お気に召されましたらお申込みしお部屋抑えさせて頂きます」）。
//   「805号室、本当に良いお部屋ですよね😊！！」「気に入って頂けて嬉しいです」（評する・同調の一文）、「YUMAさん」だけの行＋空行、
//   見積書の一文が無い通（内覧の後の場面）。
//   出所（本番と同じ body で組んだ全文を読んだ）:
//     ・この種別の書き方「CTAは『お気に召されましたらお申込みしお部屋抑えさせて頂きます！！』または内覧誘導」
//     ・最後に置いた CTA の注記「申込が中心: 申込15.8% / 内覧6.3%」＋ブレインの「勝ちパターン…申込へ導く」
//     ・長さの注記「スタッフが書いているのは自分の見立て」「1通目に無い切り口を1〜2文」→ 評する一文
//     ・⭐実例2件がどちらも申込の締め・フレーズ集に煽りの文（「お部屋埋まってしまう可能性」）
//     ・system の5段落構成（設備・立地・費用）と「必ず守る2点①段落に分けて書く」
//   ＝物件オススメの2通目と同じ構造（設計知見「手本が届いていても、最後に置いた指示の言葉が勝つ」）。
//
// ■ 決まり（竹内さん）
//   ・見積書の後は「申込へ」ではない（feedback_estimate_not_apply）。申込の誘いは、スタッフが画面で「申込へ押し込む」を選んだ時だけ。
//     ⚠ スタッフが書いた2通目の 28% は申込の一文を書いている（実送信と決まりが食い違う → 竹内さんの判断に残す）
//   ・内覧のご案内が中心。内覧の誘いは「まだ内覧していない ∧ お客様がこのお部屋に前向き」の時（スタッフの内覧の前の 25%）。
//   ・総額は本文で言い直さない（金額は1通目＝見積書の本体が正）。
//   ・「お待たせ致しました」は使わない（feedback_no_omatase）。
//
// ■ 手本は創作しない（feedback_no_invented_phrases）: 下の EXAMPLES はスタッフが自分で書いて送った2通目の本文そのまま（名前だけ {{NAME}}）。

import { hasClosingSentence } from "./recommend-cta";
import { aixTakeuchiFormOn } from "./aix-takeuchi-form";

const N = "{{NAME}}";

export type EstimateClosing = "receipt" | "viewing" | "apply";

/** employee＝従業員の送信（2026-10-08 竹内「竹内の方に寄せる」: AIX_TAKEUCHI_FORM が on の時は手本に出さない） */
type Example = { text: string; closing: EstimateClosing; multi: boolean; facts: string[]; employee?: boolean };

/** スタッフが自分で書いて送った2通目（本文そのまま・日付は実送信の日）。facts はその時の物件名（今回に持ち込まない語） */
export const ESTIMATE_SECOND_EXAMPLES: Example[] = [
  { // 2026-09-17
    text: "最大限割引させていただいたお見積書お送りさせていただきました😊！！\n\nお手隙の際にご査収ください😌！！",
    closing: "receipt", multi: false, facts: [],
  },
  { // 2026-09-23
    text: `${N}さんこちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！`,
    closing: "receipt", multi: false, facts: [],
  },
  { // 2026-09-30
    text: "メゾンドF02の最大限割引させていただいたお見積書お送りさせていただきました😊！！\n\n他お気に召されましたお部屋ございましたらお見積書もお送りさせていただきます！！\nお気軽にお知らせください😌！！",
    closing: "receipt", multi: false, facts: ["メゾンドF02"], employee: true,
  },
  { // 2026-09-22
    text: `${N}さんお世話になっております！！\nお送り頂きましたS-RESIDENCE堺筋本町Deuxの最大限割引しました初期費用の御見積書となります！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！\nお気軽にお申し付けください！！`,
    closing: "viewing", multi: false, facts: ["S-RESIDENCE堺筋本町Deux"],
  },
  { // 2026-09-18
    text: `${N}さん\nポーラーベアー302号室最大限割引しました初期費用の御見積書となります！！\nご入居日によって日割家賃が発生致しますので、その点あらかじめご了承ください！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！\nお気軽にお申し付けください😌！！`,
    closing: "viewing", multi: false, facts: ["ポーラーベアー"],
  },
  { // 2026-09-17
    text: "2部屋の最大限割引させていただきましたお見積書お送りさせていただきました😊！！\n\nお手隙の際にご査収ください😌！！",
    closing: "receipt", multi: true, facts: [], employee: true,
  },
  { // 2026-09-16
    text: "セレニテ南堀江エクラ902号室・セレニテ難波プリエ611号室、それぞれ最大限割引しました初期費用の御見積書となります！！\nお気に召されましたらお部屋ご案内させて頂きます😌！！",
    closing: "viewing", multi: true, facts: ["セレニテ南堀江エクラ", "セレニテ難波プリエ"],
  },
  { // 2026-09-17
    text: "お送り頂きましたお部屋の割引させて頂きました初期費用の御見積書となります😊！！\nお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\nお気軽にお申し付けください！！",
    closing: "viewing", multi: true, facts: [],
  },
  { // 2026-09-05
    text: `${N}さんお世話になっております！！\n\nグレース畑中202号室最大限割引しました初期費用の御見積書となります！！\n${N}さんお気に召されましたらお申込みしお部屋抑えさせて頂きます！！\n\nお手隙の際にご査収ください😌！！`,
    closing: "apply", multi: false, facts: ["グレース畑中"],
  },
];

/** 実送信の締めの文（そのまま使う） */
export const ESTIMATE_RECEIPT_LINE = "お手隙の際にご査収ください😌！！";
export const ESTIMATE_VIEWING_LINE = "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！";
export const ESTIMATE_APPLY_LINE = "お気に召されましたらお申込みしお部屋抑えさせて頂きます！！";

/** 見積書の本体（AIX の1通目）か。🌟割引・初期費用：・節約の行がある */
export function isEstimateCard(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return /初期費用[：:]\s*[0-9０-９,，]+円/.test(t) || (/割引させて頂き/.test(t) && /節約出来ます/.test(t)) || /御見積書|お見積書/.test(t) && /【[^】]+】/.test(t);
}

/** 見積書の本体の【物件名 号室】（金額の見出しではない物だけ） */
export function estimatePropertiesOf(first: string | null | undefined): string[] {
  return [...String(first ?? "").matchAll(/【([^】]{1,40})】/g)]
    .map((m) => m[1].trim())
    .filter((s) => s && !/希望|ご入居|家賃|間取り|築年数|エリア|駅名|徒歩|初期費用|その他|広さ|御見積|お見積/.test(s));
}

/**
 * 締めを決める（スタッフの選択 → 内覧の段階 → お客様の反応）。
 *   ・スタッフが画面で選んだ（訴求方法を選択する）→ その締め（申込はここだけ）
 *   ・まだ内覧していない ∧ お客様がこのお部屋に前向き（positive）→ 内覧のご案内＋ご査収
 *   ・それ以外 → ご査収だけ（押さない・迷ったらこちら）
 */
export function resolveEstimateClosing(i: {
  ctaPreference?: "viewing" | "apply" | null;
  /** この会話で内覧をした・内覧の待ち合わせを送った（AIX 待ち合わせ場所の後） */
  viewed: boolean;
  /** お客様の直近の発言の分類（recommend-cta.readCustomerReaction の kind） */
  reactionKind?: string | null;
  /** 見積書のお部屋の採点から見た刺さり具合（estimateAppealOf）。採点が読めない時は null／省略 */
  appeal?: "strong" | "weak" | null;
  /** 刺さるお部屋がまだご内覧頂けない（退去予定・居住中） */
  notViewable?: boolean;
  /** お客様が直近（3日）にこのお部屋の見積・初期費用を頼んだ（customer-mindset.customerAskedEstimate） */
  customerAsked?: boolean;
}): { closing: EstimateClosing; reason: string } {
  if (i.ctaPreference === "apply") return { closing: "apply", reason: "スタッフが「申込へ押し込む」を選んだ" };
  if (i.ctaPreference === "viewing") return { closing: "viewing", reason: "スタッフが「内覧に誘う」を選んだ" };
  if (i.viewed) return { closing: "receipt", reason: "内覧の後（申込の話はブレインがお客様の反応で決める）" };
  // 2026-10-09 竹内さん「初期費用の見積を頼む＝その物件に興味がある。費用に納得できれば内覧や申込につなげられる。見積書の文には今まで通り内覧訴求や申込訴求を加え、
  //   お客様に次の方向を示しつつ待つ形（未内覧で空室なら内覧訴求が主）。代表確認を一度に出さない（further-discount の線は変えない）」。
  //   竹内さんの実送信（120日・頼まれた見積・内覧の前 98通）: 内覧 36%・申込 33%・ご査収だけ 32%（＝7割が訴求を添えている）。既定 off・ESTIMATE_ASKED_APPEAL=on で入る
  if (i.customerAsked && estimateAskedAppealOn() && !(i.reactionKind && HOLD_BACK.has(i.reactionKind))) {
    return i.notViewable ? { closing: "apply", reason: "お客様が頼んだ見積・まだ見られない（申込訴求）" } : { closing: "viewing", reason: "お客様が頼んだ見積・内覧の前・空室（内覧訴求が主）" };
  }
  // 2026-10-08 竹内「刺さる条件（スコアリング的に刺さる条件）なら内覧または申込誘導する。空室なら内覧誘導」:
  //   採点で刺さる → 今見られるなら内覧誘導・退去予定なら申込誘導（recommend-cta.resolveRecommendCta と同じ線）／刺さらない → ご査収。
  //   お客様が懸念・条件の変更・断りを言っている時は押さない。戻すのは ESTIMATE_CLOSING_BY_APPEAL=off（旧＝反応だけで決める）
  if (estimateClosingByAppealOn()) {
    if (i.reactionKind && HOLD_BACK.has(i.reactionKind)) return { closing: "receipt", reason: `お客様が${i.reactionKind}を言っている（押さない）` };
    if (i.appeal === "strong") return i.notViewable ? { closing: "apply", reason: "採点で刺さる・退去予定（申込誘導）" } : { closing: "viewing", reason: "採点で刺さる・今見られる（内覧誘導）" };
    if (i.appeal === "weak") return { closing: "receipt", reason: "採点で刺さると言えない（ご査収）" };
    if (i.reactionKind === "positive") return i.notViewable ? { closing: "apply", reason: "採点なし・お客様が前向き・退去予定" } : { closing: "viewing", reason: "採点なし・内覧の前・お客様が前向き" };
    return { closing: "receipt", reason: `採点なし・お客様の反応=${i.reactionKind ?? "-"}（押さない）` };
  }
  if (i.reactionKind === "positive") return { closing: "viewing", reason: "内覧の前・お客様が前向き" };
  return { closing: "receipt", reason: `内覧の前・お客様の反応=${i.reactionKind ?? "-"}（押さない）` };
}
const HOLD_BACK: ReadonlySet<string> = new Set(["concern", "condition_change", "decline"]);
/** お客様が頼んだ見積に内覧・申込の訴求を添えるか。ESTIMATE_ASKED_APPEAL=off で旧（採点・反応だけで決める） */
export function estimateAskedAppealOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ESTIMATE_ASKED_APPEAL ?? "").trim().toLowerCase() === "on"; // 2026-10-09 試験・YUMA で確かめるまで既定 off（on で入る）
}
/** 見積書の締めを採点の刺さり具合で決めるか（呼ぶ時に読む）。ESTIMATE_CLOSING_BY_APPEAL=off で旧（お客様の反応だけ） */
export function estimateClosingByAppealOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ESTIMATE_CLOSING_BY_APPEAL ?? "on").trim() !== "off";
}
/**
 * 見積書のお部屋（1件以上）の刺さり具合をまとめる。
 *   どれか1件でも刺さる → strong（notViewable は刺さるお部屋が全部まだ見られない時だけ true＝今見られる刺さる部屋があれば内覧誘導）
 *   採点が読めたが刺さる部屋が無い → weak ／ 1件も採点が読めない → null（＝決められない）
 */
export function estimateAppealOf(rows: ReadonlyArray<{ appeal: "strong" | "weak" | null; notViewable: boolean }>): { appeal: "strong" | "weak" | null; notViewable: boolean } {
  const strong = rows.filter((r) => r.appeal === "strong");
  if (strong.length > 0) return { appeal: "strong", notViewable: strong.every((r) => r.notViewable) };
  if (rows.some((r) => r.appeal === "weak")) return { appeal: "weak", notViewable: false };
  return { appeal: null, notViewable: false };
}
/** 見積書の見出し「建物名 号室」→ { name, room }（号室が読めなければ null） */
export function estimateHeadOf(label: string): { name: string; room: string } | null {
  const m = String(label ?? "").normalize("NFKC").trim().match(/^(.*?)[\s　]*([0-9]{2,4})(?:号室)?$/);
  return m && m[1].trim().length >= 2 ? { name: m[1].trim(), room: m[2] } : null;
}

/** 手本の名前を今回のお客様の名前に。名前が分からない時は呼びかけごと落とす */
function render(text: string, name: string): string {
  if (name) return text.split(N).join(name);
  return text.replace(/\{\{NAME\}\}さん(?:お世話になっております！！)?\n?/g, "").replace(/^\n+/, "");
}

export type EstimateSecondInput = {
  name: string;
  properties: string[];
  closing: EstimateClosing;
  /** 今日すでにこちらから送っている（挨拶の行を書かない） */
  staffSentToday: boolean;
};

/**
 * 2通目の形（最後に置く・ここより前の指示と食い違う所はこちらが正）。
 * 手本は締めが同じ物を先に・件数（1件／複数）が同じ物を先に。
 */
export function buildEstimateSecondNote(i: EstimateSecondInput): string {
  const nm = i.name.trim();
  const multi = i.properties.length >= 2;
  const label = i.properties.length === 1 ? i.properties[0] : multi ? `${i.properties.length}部屋` : "";
  const score = (e: Example) => (e.closing === i.closing ? 2 : 0) + (e.multi === multi ? 1 : 0);
  const picked = [...ESTIMATE_SECOND_EXAMPLES].filter((e) => !(e.employee && aixTakeuchiFormOn()))
    .filter((e) => i.closing === "apply" || e.closing !== "apply")
    .sort((a, b) => score(b) - score(a)).slice(0, 5);
  const L: string[] = [];
  L.push("【この2通目の形（見積書の直後。ここより前の指示・実例・ブレインの方針と食い違う所はこちらが正）】");
  L.push(`場面: 1通目で御見積書（${label || "物件名は1通目の見出し"}）を送った直後の2通目。スタッフはこの場面で、御見積書を送った事を伝える短い文を送っている（中央値102字・2段落）。`);
  L.push("下の実物と同じ形・同じ言い回しで書く（言い回しを自分で作らない）。");
  L.push("");
  L.push("■ 形");
  L.push(`・1文目: 御見積書を送った事。「${i.properties.length === 1 ? `${i.properties[0]}` : multi ? `${i.properties.length}部屋の` : ""}最大限割引しました初期費用の御見積書となります！！」か「最大限割引させていただいたお見積書お送りさせていただきました😊！！」の形。`);
  if (multi) L.push(`・お部屋が${i.properties.length}つの時は「${i.properties.length}部屋の」「それぞれ」でまとめる（物件名を並べるなら1通目の見出しの名前のまま）。`);
  L.push("・金額（初期費用・割引額・節約額）は書かない（1通目の御見積書に載っている。言い直さない）。");
  L.push("・物件を評する文・気持ちの文（「良いお部屋ですよね」「嬉しいです」「魅力です」「好条件です」「かと思います」）は書かない。設備・立地・費用の段落も書かない。");
  L.push("・号室だけで呼ばない（「805号室、」とは書かない。物件名から書く）。");
  L.push("・「お送り頂きました（お部屋）」は、お客様がそのお部屋を送ってくれた（URL・画像）事が会話履歴にある時だけ書く。");
  if (i.closing === "receipt") {
    L.push(`・締めは「${ESTIMATE_RECEIPT_LINE}」の1文だけ。内覧・申込の誘いは書かない。`);
  } else if (i.closing === "viewing") {
    L.push(`・締めは内覧のご案内「${ESTIMATE_VIEWING_LINE}」と「${ESTIMATE_RECEIPT_LINE}」（または「お気軽にお申し付けください！！」）。申込の誘いは書かない。`);
  } else {
    L.push(`・締めは「${ESTIMATE_APPLY_LINE}」と「${ESTIMATE_RECEIPT_LINE}」（刺さるお部屋でまだご内覧頂けない・またはスタッフが申込を選んだ）。`);
  }
  L.push(i.staffSentToday
    ? "・今日はもうこちらから送っている: 挨拶の行（お世話になっております）は書かない。「お待たせ致しました」も書かない。"
    : `・今日はじめての連絡: 書き出しは「${nm ? `${nm}さん` : ""}お世話になっております！！」でよい。「お待たせ致しました」は書かない。`);
  L.push(`・呼びかけ: ${nm ? `入れるなら「${nm}さん」を文の頭に（実送信の3割）。名前だけの行の後に空行を入れない` : "名前は書かない"}。`);
  L.push("・絵文字は1個（多くて2個）。置く所は文の最後の「！！」の直前だけ。同じ絵文字を2回使わない。文の終わりは「！！」。");
  L.push("・長さは40〜110字・2〜4行。");
  L.push("");
  L.push("■ この場面でスタッフが実際に書いて送った2通目（本文そのまま。物件名はその時の物なので今回の文に持ち込まない）");
  // 今日もう送っている時は、手本の挨拶（お世話になっております）を外して見せる（指示と手本が食い違わないように・本文はそのまま）
  const shown = (t: string) => (i.staffSentToday ? t.replace(/お世話になっております！！\n*/g, "").replace(/^\n+/, "") : t);
  picked.forEach((e, k) => { L.push(`--- 実物${k + 1} ---`); L.push(shown(render(e.text, nm))); });
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 出口の検査（作り直し1回の判定・本文は書き換えない）
// ─────────────────────────────────────────────────────────────────────────────

const APPLY_RE = /お申込み?し(?:て)?お部屋[をも]?(?:抑え|押さえ)|お申込みでお部屋[をも]?(?:抑え|押さえ)|お部屋のお申込みさせて|お申し?込み(?:も)?させて(?:頂|いただ)きます/;
/** スタッフが書いた2通目 132通・直した 23通で 0通の語（監査: scripts/audit-estimate-second.ts） */
const EVAL_RE = /本当に良い|良いお部屋ですよね|嬉しいです|うれしいです|魅力(?:です|的)|好条件です|かと思います|ならでは|強みです|お値打ち|ぴったり/;
const AMOUNT_RE = /[0-9０-９][0-9０-９,，]{2,}円/;

export type EstimateSecondHit = { key: string; match: string };

/**
 * 2通目の検査。当たった物を返す（無ければ空）。
 *   apply   … 締めが申込でないのに申込の誘いを書いた
 *   eval    … 評する・同調の一文
 *   amount  … 1通目の金額を言い直した（1通目に無い金額も含む）
 *   room    … 号室だけで呼んだ（「805号室、」）
 */
export function findEstimateSecondProblems(text: string | null | undefined, o: { closing: EstimateClosing; first?: string | null }): EstimateSecondHit[] {
  const t = String(text ?? "");
  const out: EstimateSecondHit[] = [];
  if (o.closing !== "apply") { const m = t.match(APPLY_RE); if (m) out.push({ key: "apply", match: m[0] }); }
  { const m = t.match(EVAL_RE); if (m) out.push({ key: "eval", match: m[0] }); }
  // 金額は「1通目（見積書の本体）にある金額を言い直した」時だけ。スタッフは1通目に無い金額（代表の追加割引・敷金・礼金の別途）を
  //   自分の知っている事として書く（スタッフが書いた 132通で 15通）＝ AI には材料が無いので書けないが、検査で止める物ではない
  //   見るのは1通目の「初期費用：〇円」（総額）だけ（feedback_estimate_total_recheck「本文で総額を言わない」）。
  //   割引額の言い直し（「合計で88,000円割引させて頂きます」）はスタッフも書く（7通）ので当てない
  const firstAmounts = new Set([...String(o.first ?? "").matchAll(/初期費用[：:]\s*([0-9０-９][0-9０-９,，]{2,}円)/g)].map((m) => normYen(m[1])));
  for (const m of t.matchAll(new RegExp(AMOUNT_RE.source, "g"))) {
    if (firstAmounts.has(normYen(m[0]))) { out.push({ key: "amount", match: m[0] }); break; }
  }
  // 号室だけで呼ぶ（「805号室、本当に…」）。号室を並べる「302号室、202号室、702号室」は当てない（スタッフの文に1通）
  { const m = t.match(/(?:^|[\n。！!])[\s　]*([0-9０-９]{2,4})[\s　]*号室(?:[、,](?![\s　]*[0-9０-９]{2,4}[\s　]*号室)|は)/); if (m) out.push({ key: "room", match: m[0].replace(/^[\n、。！!\s　]+/, "") }); }
  return out;
}

/**
 * 出口（足すだけ・消さない）: 決めた締めの文が無ければ足す（設計知見「決定論で決めた文は出口でも保証する」）。
 *   receipt … 「お手隙の際にご査収ください😌！！」が無ければ最後に足す
 *   viewing … 内覧のご案内が無ければ、最後の「ご査収／お気軽に」の行の前（無ければ最後）に足す
 *   apply   … 申込の一文が無ければ同じ位置に足す（スタッフが選んだ時だけ）
 */
export function ensureEstimateClosing(text: string, closing: EstimateClosing): { text: string; added: string | null } {
  const src = String(text ?? "").trim();
  if (!src) return { text: src, added: null };
  if (closing === "receipt") {
    if (hasClosingSentence(src, "receipt")) return { text: src, added: null };
    return { text: `${src}\n\n${ESTIMATE_RECEIPT_LINE}`, added: ESTIMATE_RECEIPT_LINE };
  }
  const kind = closing === "viewing" ? "viewing" : "apply";
  if (hasClosingSentence(src, kind)) return { text: src, added: null };
  const line = closing === "viewing" ? ESTIMATE_VIEWING_LINE : ESTIMATE_APPLY_LINE;
  const lines = src.split("\n");
  let k = lines.length - 1;
  while (k >= 0 && !lines[k].trim()) k--;
  if (k >= 0 && /^(?:お手隙の際に|お気軽に)/.test(lines[k].trim())) {
    lines.splice(k, 0, line);
    return { text: lines.join("\n"), added: line };
  }
  return { text: `${src}\n${line}`, added: line };
}

const normYen =(s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, "");
