// app/lib/property-appeal-fit.ts — 「その物件がお客様にどれだけ刺さっているか」（決定論・純関数・DB/LLM なし）
//
// 2026-10-08 竹内さん④「『刺さっているか』をちゃんと基準にする: 物件のスコアリング（条件との合い方の点）が高く、かつお客様の反応が良い
//   （その物件への前向きな言葉・質問・内覧希望・早い返事 等）なら刺さっている」。
//   使い道: すぐ来られない（今週は無理・予定が詰まって・出張）番で、刺さっている → 先にお部屋を抑える提案／
//   刺さっていない → 来週以降で内覧調整（AIX）・撮影して送ってから（気に入ったら抑える）。どちらにするかはブレインが最終判断（ここは材料）。
//
// ■ 重ねて作らない（既存の物差しをそのまま使う）
//   採点の側＝recommend-cta.appealFromPickup（verdict=pass ∧ 全部合う ∧ 外れ寄りの札なし＝strong。AD の点は使わない）。
//   反応の側＝appeal-timing の語（CUSTOMER_APPRAISAL_RE・CUSTOMER_VIEWING_WISH_RE・CUSTOMER_APPLY_INTENT_RE）＋「気になる」・物件への質問・返事の早さ。
//   物件オススメの締め（recommend-cta.resolveRecommendCta）は送る時の「刺さりそうか」、ここは送った後の「刺さっているか」（お客様の反応が入る）。
//
// ■ 線（scripts/audit-appeal-fit-hold.ts・365日・🌟の後の番。数字は下の APPEAL_FIT_LINES の注釈）
//   戻す: PROPERTY_APPEAL_FIT=off（注記を渡さない）
// テスト: app/lib/__tests__/property-appeal-fit.test.ts（実物の発言）

import { appealFromPickup, type PickupAppealRow } from "./recommend-cta";
import { CUSTOMER_APPRAISAL_RE, CUSTOMER_APPLY_INTENT_RE, CUSTOMER_VIEWING_WISH_RE } from "./appeal-timing";

export function propertyAppealFitEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return (env.PROPERTY_APPEAL_FIT ?? "").trim().toLowerCase() !== "off";
}

export type AppealMsgLite = { text: string | null | undefined; createdAt: string };

export type AppealReaction = {
  /** 前向きな評価・気になる（「いいですね」「気になります」「好条件で気になる」） */
  appraisal: boolean;
  /** その物件の内覧の希望（「内覧したい」「見に行けますか」） */
  viewingWish: boolean;
  /** 申込・抑える意思（「申込したい」「抑えてほしい」） */
  applyIntent: boolean;
  /** その物件への質問（費用・設備・入居・空き・審査 等） */
  question: boolean;
  /** 送ってから最初の返事までの分（無ければ null） */
  firstReplyMin: number | null;
  /** 懸念・見送り（「微妙」「やめておきます」「他で決まり」） */
  negative: boolean;
  /** 点（appraisal 1・viewingWish 1・applyIntent 2・question 1・早い返事 1） */
  points: number;
};

const INTEREST_RE = /気にな(?:り|る|って|ってい)|興味(?:が|あり)|好条件|ここ(?:が|で)?(?:いい|良い)|こちら(?:が|で)?(?:いい|良い)/;
const VIEW_WISH_FORM_RE = /したい|させて|お願い|でき(?:ます|ます)?か|出来(?:ます)?か|行きたい|見たい|行け(?:ます|る)|いけ(?:ます|る)|可能/;
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか/;
const PROPERTY_TOPIC_RE = /家賃|管理費|初期費用|費用|見積|駐車|駐輪|ペット|設備|エアコン|ネット|wifi|Wi-?Fi|日当たり|向き|階|入居|空いて|空き|審査|保証|退去|写真|室内|広さ|収納|騒音|治安|駅/i;
// 「埋まる可能性高いですかね」「出張で厳しいです」は懸念ではない（監査 2c434b28・749c5559）＝物件の値段・広さ・距離への言葉だけ
const NEGATIVE_RE = /微妙|ちょっと(?:高|遠|狭|古)|(?:家賃|費用|値段|金額|管理費)[^。\n]{0,8}高(?:い|め|く)|(?:狭|遠)い(?:です|かな|な|ので)|やめ(?:て|ます|とき)|見送|他で(?:決|契約)|今回は|結構です|合わな/;
/** 早い返事の線（分）。⚠ 監査で申込到達と関係が薄ければ点にしない（APPEAL_FIT_QUICK_MIN=0 で止める） */
export function quickReplyMin(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): number {
  const n = Number(env.APPEAL_FIT_QUICK_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** 物件を送った後のお客様の発言（古い順・今回の番を含む）から反応を読む */
export function readAppealReaction(custMsgs: ReadonlyArray<AppealMsgLite>, o: { sentAt?: string | null; env?: Record<string, string | undefined> } = {}): AppealReaction {
  const texts = custMsgs.map((m) => String(m.text ?? "").normalize("NFKC")).filter((t) => t.trim() && !/^\s*\[(?:スタンプ|画像)/.test(t));
  const all = texts.join("\n");
  const appraisal = CUSTOMER_APPRAISAL_RE.test(all) || INTEREST_RE.test(all);
  const viewingWish = texts.some((t) => CUSTOMER_VIEWING_WISH_RE.test(t) && VIEW_WISH_FORM_RE.test(t));
  const applyIntent = CUSTOMER_APPLY_INTENT_RE.test(all);
  const question = texts.some((t) => QUESTION_RE.test(t) && PROPERTY_TOPIC_RE.test(t));
  const negative = texts.some((t) => NEGATIVE_RE.test(t)) && !applyIntent;
  const sentMs = Date.parse(String(o.sentAt ?? ""));
  const firstMs = custMsgs.length ? Date.parse(custMsgs[0].createdAt) : NaN;
  const firstReplyMin = Number.isFinite(sentMs) && Number.isFinite(firstMs) ? Math.max(0, Math.round((firstMs - sentMs) / 60000)) : null;
  const q = quickReplyMin(o.env);
  const quick = q > 0 && firstReplyMin != null && firstReplyMin <= q && texts.length > 0;
  const points = (appraisal ? 1 : 0) + (viewingWish ? 1 : 0) + (applyIntent ? 2 : 0) + (question ? 1 : 0) + (quick ? 1 : 0);
  return { appraisal, viewingWish, applyIntent, question, firstReplyMin, negative, points };
}

export type AppealFitLevel = "strong" | "medium" | "weak" | "unknown";
export type AppealFit = { level: AppealFitLevel; fit: "strong" | "weak" | null; points: number; why: string };

/** 線（監査で決める・下の注釈に根拠の数字） */
//   実データ（scripts/audit-appeal-fit-hold.ts --any-turn・2026-10-08・365日・🌟の後のお客様の番 2,161・249会話・申込以降を除く・申込到達＝30日以内の deal_outcomes.applied_at）:
//   ・会話ごとの最大の反応点 → 申込到達: 0点 1/15=7%・1点 6/48=13%・2点 20/84=24%・**3点 18/38=47%**・4点 10/16=63%・5点 2/2
//     （番ごと: 2点 34% → 3点 47% → 4点 56%）。一番大きな段差は 2→3 点＝線は 3 点。
//   ・人の一手（抑える提案／内覧調整）の割合: 4点以上で 抑38/調19＝67%（3点以下は 43%）＝スタッフが抑える提案に寄るのは4点から（竹内さんへの確認事項）。
//   ・信号ごとの申込到達（あり／なし）: 内覧の希望 51%/27%（一番強い）・前向きな言葉 38/33・申込の意思 54/33・返事 10〜60分 40%（1日以上 24%）・物件への質問 34/34（差なし・竹内さんの挙げた信号なので1点のまま）
//   ・採点（property_pickups）が読めた番は 69/2,161 だけ（🌟の見出しと採点の行が合う物）。外れ寄り（weak）は 60番・14会話で申込 0 → 外れ寄りは反応だけでは刺さっていると言わない（申込の意思だけ別）。
//     全部合う（strong）は 9番・4会話（申込 1）＝少なすぎて線にしない（強める材料にはしない・弱める材料だけに使う）。
export const APPEAL_FIT_LINES = {
  /** 刺さっている＝反応の点がこの線以上（採点が weak でない時） */
  strongPoints: 3,
  /** 採点が外れ寄り（weak）の時の線（実質: 反応だけでは刺さっていると言わない。申込の意思は上で別に strong） */
  strongPointsWhenFitWeak: 99,
};

/** 採点＋反応から、刺さり具合を決める（ブレインへの材料。最終判断はブレイン） */
export function resolvePropertyAppealFit(i: { pickup?: PickupAppealRow | null; reaction: AppealReaction; decideSignal?: { strong: boolean; why: string } | null }): AppealFit {
  const f = appealFromPickup(i.pickup ?? null);
  // 2026-10-09 竹内さん「確認して問題無ければ決まる、も重要な発想」: 「〇〇なら決める」「前向き＋(a)の残り1点」（customer-mindset.decideSignalOf）は刺さりの最上位の印
  //   （120日 19通・申込30日 47%／前向きで物件が分かる決め手の残り 103番・申込 46%・普段 30%）。懸念の言葉より先に見る（「高いけど〇〇なら決める」は決める寸前）。既定 on・DECIDE_GAP=off で戻す
  if (i.decideSignal?.strong) return { level: "strong", fit: f?.appeal ?? null, points: i.reaction.points, why: `決める寸前: ${i.decideSignal.why}` };
  const fit = f?.appeal ?? null;
  const r = i.reaction;
  const sig = [r.appraisal && "前向きな言葉", r.viewingWish && "内覧の希望", r.applyIntent && "申込の意思", r.question && "物件への質問", r.firstReplyMin != null && r.firstReplyMin <= quickReplyMin() && "早い返事"].filter(Boolean).join("・") || "反応なし";
  const fitTxt = fit === "strong" ? "採点＝条件に全部合う" : fit === "weak" ? `採点＝外れ寄り（${f?.why ?? ""}）` : "採点なし";
  if (r.negative) return { level: "weak", fit, points: r.points, why: `${fitTxt}・懸念/見送りの言葉あり` };
  if (r.applyIntent) return { level: "strong", fit, points: r.points, why: `${fitTxt}・${sig}` };
  const need = fit === "weak" ? APPEAL_FIT_LINES.strongPointsWhenFitWeak : APPEAL_FIT_LINES.strongPoints;
  if (r.points >= need) return { level: "strong", fit, points: r.points, why: `${fitTxt}・${sig}（${r.points}点）` };
  if (r.points === 0 && fit == null) return { level: "unknown", fit, points: 0, why: `${fitTxt}・${sig}` };
  if (fit === "weak" && r.points <= 1) return { level: "weak", fit, points: r.points, why: `${fitTxt}・${sig}（${r.points}点）` };
  return { level: "medium", fit, points: r.points, why: `${fitTxt}・${sig}（${r.points}点）` };
}
