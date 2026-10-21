// app/lib/customer-reaction-predict.ts — 相手の頭の中・反応の予想（D案の脳の働き ②・純関数・DB も fetch も LLM も持たない）
//
// 2026-10-21 竹内さんの決定（a5838a0b・b01d793d）: 一般の自動返信 AI と比べて足りない所 ②「相手の頭の中・反応の予想（次の一手の質）」。
//   ①今のお客様の頭の中（今ほしい物・気にしている事・温度）を、もうある決まった計算（customer-mood-flow の束・気持ちの言葉・前の提案への反応）から読む
//   ②こちらの返し方の種類ごとに「お客様が次に何と返しそうか」を、過去の実データ（お客様の束→こちらの返事→お客様の次の束）の数え表で予想する
//   ③下書きがある時は、その下書きへの反応を予想して「悪い反応の恐れ」（答えの抜け→また聞かれる・押しすぎ・止まる・不満）の信号を出す
//   → ブレインには 1〜2 行の材料だけ渡す（判断と文は竹内基準のブレイン・スタッフしか分からない事は AIX）。信号は ①自信の気づき が後で使えるように export。
//
// 数え表: customer-reaction-table-data.ts（scripts/audit-reaction-predict.ts --write-table が実データから作る・例の文は持たない＝数だけ）
// LLM: 使わない（実データで DeepSeek（伏せた文だけ）と比べた結果は scripts/audit-reaction-predict.ts の --llm を参照）
// スイッチ: BRAIN_REACTION_PREDICT=on でブレインの材料に入る（既定 off＝プロンプトは1バイトも変わらない）
// テスト: app/lib/__tests__/customer-reaction-predict.test.ts
import { customerBursts, moodSignals, proposalKindOf, resolveMoodFlow, type MoodFlow, type MoodMsg } from "@/app/lib/customer-mood-flow";
import { REACTION_TABLE, type ReactionTable } from "@/app/lib/customer-reaction-table-data";

/** お客様の束の種類（反応の種類） */
export const REACTION_CATS = ["question", "thanks", "stall", "complaint", "proceed", "silent", "other"] as const;
export type ReactionCat = (typeof REACTION_CATS)[number];
export const REACTION_JA: Record<ReactionCat, string> = {
  question: "質問", thanks: "お礼・了承", stall: "止まる・検討", complaint: "不満", proceed: "内覧・申込へ進む", silent: "返事なし", other: "その他",
};
/** 悪い反応（お客様が止まる・不満・返事が来ない） */
export const BAD_CATS: ReadonlySet<ReactionCat> = new Set<ReactionCat>(["stall", "complaint", "silent"]);

/** こちらの返し方の種類（下書きの形） */
export const DRAFT_KINDS = ["push", "property", "ask", "promise", "answer"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_JA: Record<DraftKind, string> = {
  push: "内覧・申込・見積を勧める", property: "物件を送る", ask: "こちらから聞く", promise: "確認して後で送る約束", answer: "答え・受け止めだけ",
};

const FORM_RE = /①|【ご入居の時期】|ご希望のお部屋探しご条件|生年月日|携帯番号|勤務先(?:名|所在地|電話)|年収|フリガナ|【お申込/;
const MEDIA_ONLY_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル|位置情報)[^\]]*\]/;
const QUESTION_RE = /[？?]|(?:ます|です|でしょう|ません|ある|いい|良い)か(?=[。！!\s]|$)|(?:教えて|知りたい)/;
/** 依頼（調べて頂きたい・送ってほしい・ポータルの画面の持ち込み）＝答えを求める番として質問に入れる */
const REQUEST_RE = /(?:頂き|いただき|ほしい|欲しい|お願いしたい)(?:たい|です|んです|のですが|ので|。|！|$)|(?:調べ|探し|送っ|教え)て(?:下さい|ください|頂け|いただけ|もらえ)/;
const PROCEED_RE = /内[覧見](?:を|に)?(?:し|させ|行き|希望|お願い|可能|でき)|見に行(?:き|け|っ)|見学(?:し|でき|希望)|申し?込(?:み)?(?:たい|します|お願い|させ|を(?:お願い|したい))|ここに(?:します|決め)|決めます|お願いします[^\n]{0,10}(?:内覧|申込|日)|(?:\d{1,2}|[一二三四五六七八九十]+)\s*(?:日|時)(?:の|に|から|以降|頃|で|なら|は)[^\n]{0,15}(?:大丈夫|空いて|行け|可能|お願い|都合|いけ)|(?:土日|土曜|日曜|平日|明日|明後日|今週|来週)[^\n]{0,15}(?:大丈夫|空いて|行け|可能|いけ)|\d{1,2}:\d{2}[^\n]{0,10}(?:可能|大丈夫|お願い|空いて|行け|いけ)|(?:その|この)(?:時間|日|日程|日時)で(?:お願い|大丈夫|可能)/;
const THANKS_RE = /ありがと|有難|助かり|了解|承知|かしこまり|わかりました|分かりました|よろしく|お願いします|はい|OK|おけ|大丈夫です|確認しました|👍|🙇/i;
const STALL_RE = /検討(?:し|さ|中)|考え(?:ます|たい|させ|てみ|中)|悩(?:ん|み|む)|迷(?:っ|い|う)|また(?:連絡|ご連絡)|一旦|保留|様子を?見|もう少し(?:探|考|見)|決めきれ|見送|今回は(?:大丈夫|やめ|見送|なし)|他(?:で|の(?:会社|不動産))[^。\n]{0,10}決|結構です|キャンセル/;

function usableTexts(texts: ReadonlyArray<string | null | undefined>): string[] {
  return texts.map((t) => String(t ?? "")).filter((t) => t.trim() && !MEDIA_ONLY_RE.test(t) && !FORM_RE.test(t))
    .map((t) => t.replace(/https?:\/\/\S+/g, "").trim()).filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** お客様の束（連投）の種類。使える文が無ければ other（画像・フォームだけ） */
export function classifyCustomerBurst(texts: ReadonlyArray<string | null | undefined>): ReactionCat {
  const u = usableTexts(texts);
  // ポータルの物件の画面の持ち込み（画像の書き起こし）＝「ここはどうですか」の依頼
  const portal = texts.some((t) => /【物件の画面/.test(String(t ?? "")));
  if (!u.length) return portal ? "question" : "other";
  const j = u.join("\n").normalize("NFKC");
  const sig = moodSignals(u);
  if (sig.dissatisfaction) return "complaint";
  if (PROCEED_RE.test(j) || /内[覧見]したい|申し?込みたい/.test(j)) return "proceed";
  if (sig.distancing) return "stall";
  if (QUESTION_RE.test(j) || REQUEST_RE.test(j) || portal) return "question";
  if (STALL_RE.test(j)) return "stall";
  if (THANKS_RE.test(j)) return "thanks";
  return "other";
}

/** こちらの返事（下書き）の種類 */
export function draftKindOf(text: string | null | undefined): DraftKind {
  const t = String(text ?? "").normalize("NFKC");
  const p = proposalKindOf(t);
  if (p === "物件") return "property";
  if (p === "内覧" || p === "申込" || p === "見積") return "push";
  if (/確認(?:して|させて|し次第|いたし|致し)|お調べ|折り返し|お待ち(?:下さい|ください)|改めてご連絡/.test(t)) return "promise";
  if (/[？?]|いかがでしょうか|ご都合|ございますか|でしょうか|頂けますか|いただけますか/.test(t)) return "ask";
  return "answer";
}

export type Temperature = "高" | "中" | "低";
export type CustomerMind = {
  /** 今回の束の種類 */
  now: ReactionCat;
  /** 今ほしい物（決まった言い方） */
  wants: string;
  /** 気にしている事（気持ちの言葉の引用・無ければ null） */
  worry: string | null;
  temperature: Temperature;
  /** 温度の根拠（短い） */
  tempWhy: string[];
  questions: number;
  mood: MoodFlow | null;
};

const WANTS: Record<ReactionCat, string> = {
  question: "聞いた事・頼んだ事への答え", thanks: "受け止め（短いお礼・了承）", stall: "考える時間・押されない事", complaint: "不満の受け止めと直し",
  proceed: "内覧・申込の段取りを進める事", silent: "—", other: "（画像・資料だけ＝何を見てほしいか）",
};

/** 今のお客様の頭の中（最後の束がお客様の番の時だけ・そうでなければ null） */
export function readCustomerMind(msgs: ReadonlyArray<MoodMsg>): CustomerMind | null {
  if (!msgs.length || msgs[msgs.length - 1].sender !== "customer") return null;
  const bursts = customerBursts(msgs);
  const last = bursts[bursts.length - 1];
  if (!last) return null;
  const mood = resolveMoodFlow(msgs);
  const now = classifyCustomerBurst(last.texts);
  const sig = mood?.signals ?? {};
  const worry = sig.anxiety ?? sig.dissatisfaction ?? sig.hesitation ?? null;
  const why: string[] = [];
  let up = 0, down = 0;
  if (sig.positive) { up++; why.push("前向きの言葉"); }
  if (sig.urgency) { up++; why.push("急ぎ"); }
  if (now === "proceed") { up++; why.push("進む話"); }
  if (sig.distancing) { down += 2; why.push("離れかけの言葉"); }
  if (now === "stall") { down++; why.push("検討・保留"); }
  if ((mood?.downward ?? 0) >= 2) { down++; why.push("いつもより遅く・短く"); }
  const temperature: Temperature = down > up ? "低" : up > down ? "高" : "中";
  return { now, wants: WANTS[now], worry, temperature, tempWhy: why.slice(0, 2), questions: last.questions, mood };
}

export type ReactionDist = Partial<Record<ReactionCat, number>>;
export type ReactionPrediction = { likely: ReactionCat; p: number; dist: ReactionDist; n: number; level: "now+draft" | "now" | "all" };

const MIN_N = 20;
function normalize(c: Record<string, number> | undefined): { dist: ReactionDist; n: number } {
  const n = Object.values(c ?? {}).reduce((a, b) => a + b, 0);
  const dist: ReactionDist = {};
  if (n) for (const [k, v] of Object.entries(c!)) dist[k as ReactionCat] = v / n;
  return { dist, n };
}
function top(dist: ReactionDist): [ReactionCat, number] {
  let best: [ReactionCat, number] = ["other", 0];
  for (const [k, v] of Object.entries(dist) as Array<[ReactionCat, number]>) if (v > best[1]) best = [k, v];
  return best;
}

/** 次のお客様の反応の予想（数え表・数が足りなければ今回の種類だけ→全体に戻る） */
export function predictReaction(now: ReactionCat, draft: DraftKind | null, table: ReactionTable = REACTION_TABLE): ReactionPrediction {
  if (draft) {
    const a = normalize(table.byNowDraft[`${now}|${draft}`]);
    if (a.n >= MIN_N) { const [likely, p] = top(a.dist); return { likely, p, dist: a.dist, n: a.n, level: "now+draft" }; }
  }
  const b = normalize(table.byNow[now]);
  if (b.n >= MIN_N) { const [likely, p] = top(b.dist); return { likely, p, dist: b.dist, n: b.n, level: "now" }; }
  const c = normalize(table.all);
  const [likely, p] = top(c.dist);
  return { likely, p, dist: c.dist, n: c.n, level: "all" };
}

/** 気持ちの流れが下向き（迷い・不安・不満・離れかけ・いつもより遅く短く）か */
export function isDownMood(mind: CustomerMind): boolean {
  const h = mind.mood?.hint;
  return h === "迷い" || h === "不安" || h === "不満" || h === "離れかけ" || (mind.mood?.downward ?? 0) >= 2;
}
export const moodKey = (mind: CustomerMind) => (isDownMood(mind) ? "down" : "ok");
const badShare = (c: Record<string, number> | undefined): { bad: number; n: number } => {
  const n = Object.values(c ?? {}).reduce((a, b) => a + b, 0);
  return { bad: n ? [...BAD_CATS].reduce((a, k) => a + (c![k] ?? 0), 0) / n : 0, n };
};

/** 悪い反応の恐れ（①自信の気づき へ渡す小さな信号）。risk は 0〜1 */
export type ReactionRiskKind = "unanswered" | "pushy" | "stall" | "complaint";
export type ReactionRiskSignal = { risk: number; kinds: ReactionRiskKind[]; likely: ReactionCat; pBad: number; draft: DraftKind | null };

/**
 * 下書き（あれば）への反応の恐れ。決まった計算だけ:
 *   - unanswered: お客様が2つ以上聞いたのに下書きが短い（1問あたり 25字未満）かつ確認の約束でもない → また聞かれる
 *   - pushy: 迷い・不安・不満・離れかけ・下向きの流れの時に、下書きが内覧・申込・見積を勧める
 *   - stall / complaint: 数え表の「止まる・返事なし」「不満」の割合が高い返し方
 */
export function reactionRisk(mind: CustomerMind, draftText: string | null | undefined, table: ReactionTable = REACTION_TABLE): ReactionRiskSignal {
  const draft = draftText == null || !String(draftText).trim() ? null : draftKindOf(draftText);
  const pred = predictReaction(mind.now, draft, table);
  const pBad = [...BAD_CATS].reduce((a, k) => a + (pred.dist[k] ?? 0), 0);
  const kinds: ReactionRiskKind[] = [];
  let risk = pBad;
  if (draft && mind.questions >= 2 && draft !== "promise") {
    const len = String(draftText).replace(/\s/g, "").length;
    if (len < mind.questions * 25) { kinds.push("unanswered"); risk += 0.2; }
  }
  if (draft === "push" && isDownMood(mind)) {
    kinds.push("pushy");
    const pd = badShare(table.byMoodDraft?.["down|push"]);
    risk = Math.max(risk, pd.n >= MIN_N ? pd.bad : 0) + 0.1;
  }
  if ((pred.dist.stall ?? 0) + (pred.dist.silent ?? 0) >= 0.45) kinds.push("stall");
  if ((pred.dist.complaint ?? 0) >= 0.15) kinds.push("complaint");
  return { risk: Math.min(1, Math.round(risk * 100) / 100), kinds, likely: pred.likely, pBad: Math.round(pBad * 100) / 100, draft };
}

export function reactionPredictEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_REACTION_PREDICT ?? "").trim().toLowerCase() === "on";
}

const pc = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;

/**
 * ブレインへの注記（1〜2 行の材料・判断と文はブレイン）。言う事が無ければ空文字。
 *   1行目: 今ほしい物・気にしている事・温度
 *   2行目: 返し方ごとの次の反応（過去の似た番）— 悪い反応が多い返し方と少ない返し方の差がある時だけ
 */
export function buildReactionNote(mind: CustomerMind | null, table: ReactionTable = REACTION_TABLE): string {
  if (!mind || mind.now === "other") return "";
  const head = `- 今ほしい物: ${mind.wants}${mind.worry ? `／気にしている事「${mind.worry}」` : ""}／温度: ${mind.temperature}${mind.tempWhy.length ? `（${mind.tempWhy.join("・")}）` : ""}`;
  // 確認の約束は事実が材料に無い時の形（反応で選ぶ物ではない）＝比べに入れない
  const rows = DRAFT_KINDS.filter((d) => d !== "promise").map((d) => ({ d, pr: predictReaction(mind.now, d, table) })).filter((r) => r.pr.level === "now+draft");
  let second = "";
  if (rows.length >= 2) {
    const bad = (r: (typeof rows)[number]) => [...BAD_CATS].reduce((a, k) => a + (r.pr.dist[k] ?? 0), 0);
    const sorted = [...rows].sort((a, b) => bad(a) - bad(b));
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    if (bad(hi) - bad(lo) >= 0.07) {
      second = `- 似た番の次の反応（過去の実データ）: ${DRAFT_JA[lo.d]}→${REACTION_JA[lo.pr.likely]}が多い（止まる・返事なし・不満 ${pc(bad(lo))}）／${DRAFT_JA[hi.d]}→止まる・返事なし・不満 ${pc(bad(hi))}`;
    }
  }
  // 下向きの流れの時は「勧めると止まる」の差を優先して見せる（実データで勧めた番全体より悪い反応が多い）
  if (isDownMood(mind)) {
    const dp = badShare(table.byMoodDraft?.["down|push"]), da = badShare(table.byMoodDraft?.["down|answer"]);
    if (dp.n >= MIN_N && da.n >= MIN_N && dp.bad - da.bad >= 0.05) {
      second = `- 今は迷い・不安の流れ: 過去の似た流れで内覧・申込を勧めた番は 止まる・返事なし・不満 ${pc(dp.bad)}（答え・受け止めだけは ${pc(da.bad)}）＝勧める前に受け止めと答えを先にするか判断`;
    }
  }
  const qLine = mind.questions >= 2 ? `（質問が${mind.questions}つ＝答えが抜けると同じ事をまた聞かれやすい）` : "";
  return `\n【相手の頭の中・反応の予想（決まった計算・材料）】\n${head}${qLine}${second ? `\n${second}` : ""}\n`;
}

/**
 * ①自信の気づき などが使う入口: 会話（古い→新しい）と下書き（あれば）から信号だけを返す。お客様の番でなければ null。
 *   例: reactionSignalFromMessages(msgs, draft)?.risk >= 0.3 → 「お客様が止まる・不満の恐れ」の減点に使える
 */
export function reactionSignalFromMessages(msgs: ReadonlyArray<MoodMsg>, draftText?: string | null, table: ReactionTable = REACTION_TABLE): ReactionRiskSignal | null {
  const mind = readCustomerMind(msgs);
  return mind ? reactionRisk(mind, draftText ?? null, table) : null;
}
