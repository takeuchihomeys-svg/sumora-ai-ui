// app/lib/draft-repeat.ts — 下書きの文が「もう言った事」の言い直し・お客様の発言のオウム返し・同じ下書きの中の二度言いかを見る（純関数・DB/LLM なし）
//
// 2026-10-13 竹内さん「同じ事を何度も繰り返してしまう所。ブレイン基準に考えたらその文がおかしいと気づくのではないか」
//   物差しは竹内さんの実送信（scripts/audit-draft-repeat.ts）。ここは文を並べて近さを測るだけ（何を削るかは呼ぶ側）。
// テスト: app/lib/__tests__/draft-repeat.test.ts

/** 文に分ける（改行・。！!？? の後）。空は落とす */
export function splitSentencesJa(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\n+/)) {
    for (const s of line.split(/(?<=[。！!？?])(?=[^！!？?。])/)) {
      const x = s.trim();
      if (x) out.push(x);
    }
  }
  return out;
}

/** 比べるための形（絵文字・記号・空白・〇〇さん・開口語「はい」を除く） */
export function normalizeSentence(s: string): string {
  return String(s ?? "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, "")
    .replace(/[^\s、。！!？?「」]{1,12}(?:さん|様|さま)(?:に|も|の|へ)?/g, "")
    .replace(/^(?:はい|かしこまりました|承知(?:いた|致)?しました)[、。！!]*/, "")
    .replace(/[\s、。！!？?・…〜ー「」『』（）()【】\-—]/g, "")
    .replace(/いただ/g, "頂").replace(/下さい/g, "ください").replace(/致し/g, "いたし");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
/** 2文字の組の Dice（0〜1） */
export function sentenceSimilarity(a: string, b: string): number {
  const x = normalizeSentence(a), y = normalizeSentence(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

export type RepeatType = "約束" | "案内・誘い" | "確認" | "お礼・お詫び" | "定型の締め" | "挨拶" | "オウム返し" | "同じ下書きの中" | "その他";

const GREETING_RE = /お世話になっております|はじめまして|こんにちは|こんばんは|夜分遅く|おはようございます/;
const FIXED_CLOSE_RE = /何卒|全力でサポート|お気軽に|ご査収|お手隙|よろしくお願い|宜しくお願い|お気に召されましたら|ご確認(?:の程)?(?:よろしく|宜しく)|お待ちしております/;
export function repeatTypeOf(sentence: string): RepeatType {
  const s = sentence;
  if (FIXED_CLOSE_RE.test(s) && normalizeSentence(s).length <= 26) return "定型の締め";
  if (GREETING_RE.test(s) && normalizeSentence(s).length <= 22) return "挨拶";
  if (/確認/.test(s)) return "確認";
  if (/ご案内|如何でしょうか|いかがでしょうか|ご内覧|お部屋(?:を)?抑え|お申込/.test(s)) return "案内・誘い";
  if (/させて(?:頂|いただ)きます|次第|お送り|ご連絡(?:させて|いたし|致し)|作成/.test(s)) return "約束";
  if (/ありがと|感謝|申し訳|失礼いたしました|すみません/.test(s)) return "お礼・お詫び";
  return "その他";
}

/** 礼・お願いの決まり文句だけの文か（オウム返し・二度言いに数えない＝「よろしくお願いします」への「何卒よろしくお願い致します」は普通） */
export function isCourtesyOnly(s: string): boolean {
  const rest = normalizeSentence(s)
    .replace(/(?:ご連絡|ご確認|ご条件お送り|お送り|ご要望お聞かせ|お聞かせ|ご質問)?(?:頂き|いただき)?(?:誠に|本当に)?(?:ありがとう|有難う)(?:ございます|ございました)?/g, "")
    .replace(/(?:何卒|引き続き|明日|本日|当日)?(?:よろしく|宜しく)(?:お願い)?(?:いたします|致します|します|申し上げます)?/g, "")
    .replace(/この度は?|お願いいたします|お願いします|かしこまりました|承知しました|了解しました|どうぞ|です|ます/g, "");
  return rest.length < 6;
}

export type RepeatHit = {
  sentence: string;        // 下書きの文
  ref: string;             // 前にこちらが言った文／お客様の文／同じ下書きの前の文
  kind: "staff" | "parrot" | "self";
  back: number;            // 何通前のこちらの文か（オウム返し・下書きの中は 0）
  sim: number;
  type: RepeatType;
};

export const REPEAT_SIM = 0.72;
export const PARROT_SIM = 0.6;

const skipSentence = (s: string) => /https?:\/\/|🌟|^住所|^【|[0-9０-９,]+円/.test(s) || normalizeSentence(s).length < 8;

/**
 * 下書きの文のうち、前のこちらの文（新→旧・back 付き）と同じ文・お客様のこの番の発言の言い直し・同じ下書きの中の二度言いを返す。
 * 物件カード（🌟・URL・住所・金額の行）・短い文（正規化して8字未満）は見ない。
 */
export function repeatSentences(
  draft: string,
  priorStaff: ReadonlyArray<{ text: string; back: number }>,
  customer: ReadonlyArray<string> = [],
): RepeatHit[] {
  const prior: { s: string; back: number }[] = [];
  for (const p of priorStaff) for (const s of splitSentencesJa(p.text)) if (!skipSentence(s)) prior.push({ s, back: p.back });
  const cust: string[] = [];
  for (const c of customer) for (const s of splitSentencesJa(c)) if (normalizeSentence(s).length >= 8) cust.push(s);
  const out: RepeatHit[] = [];
  const seen: string[] = [];
  for (const s of splitSentencesJa(draft)) {
    if (skipSentence(s)) continue;
    const t0 = repeatTypeOf(s);
    const courtesy = t0 === "定型の締め" || t0 === "挨拶" || isCourtesyOnly(s);
    if (!courtesy) {
      const dup = seen.find((x) => sentenceSimilarity(s, x) >= REPEAT_SIM);
      if (dup) { out.push({ sentence: s, ref: dup, kind: "self", back: 0, sim: sentenceSimilarity(s, dup), type: "同じ下書きの中" }); continue; }
      seen.push(s);
    }
    let best: { s: string; back: number; sim: number } | null = null;
    for (const p of prior) {
      const sim = sentenceSimilarity(s, p.s);
      if (sim >= REPEAT_SIM && (!best || sim > best.sim + 1e-9 || (Math.abs(sim - best.sim) < 1e-9 && p.back < best.back))) best = { ...p, sim };
    }
    if (best) { out.push({ sentence: s, ref: best.s, kind: "staff", back: best.back, sim: best.sim, type: t0 }); continue; }
    if (courtesy) continue;
    let pb: { s: string; sim: number } | null = null;
    for (const c of cust) {
      const sim = sentenceSimilarity(s, c);
      if (sim >= PARROT_SIM && (!pb || sim > pb.sim)) pb = { s: c, sim };
    }
    if (pb) out.push({ sentence: s, ref: pb.s, kind: "parrot", back: 0, sim: pb.sim, type: "オウム返し" });
  }
  return out;
}

// ─── 約束の中身（言い換えの言い直しを拾う）──────────────────────────────────
export type PromiseTopic = "pickup" | "vacancy" | "estimate" | "viewing" | "mgmt" | "screening" | "contact";
const PROMISE_FORM_RE = /させて(?:頂|いただ)きます|(?:出|で)次第|あり次第|分かり次第|如何でしょうか|いかがでしょうか|(?:ご連絡|お送り|お知らせ|お届け)(?:致し|いたし|し)?ます/;
const TOPIC_RES: ReadonlyArray<[PromiseTopic, RegExp]> = [
  ["estimate", /見積/],
  ["vacancy", /募集状況|空室|空き状況|空き.{0,4}確認|1番手|一番手/],
  ["mgmt", /管理会社|オーナー/],
  ["screening", /審査/],
  ["viewing", /ご案内|ご内覧|内覧|内見|お待ち合わせ|待ち合わせ/],
  ["pickup", /ピックアップ|お探し|オススメ(?:でき|出来)るお部屋|おすすめ(?:でき|出来)るお部屋|お部屋.{0,8}(?:お送り|お届け)|新着/],
  ["contact", /(?:確認|分かり|わかり|あり)次第.{0,4}ご連絡|ご連絡させて/],
];
/** 文がこちらの約束・誘いの形なら、その中身（topic）。約束の形でない・物件カード・定型の締め（全力でサポート 等）は [] */
export function promiseTopics(sentence: string): PromiseTopic[] {
  const s = String(sentence ?? "");
  if (!PROMISE_FORM_RE.test(s) || skipSentence(s) || /全力でサポート|サポートさせて/.test(s)) return [];
  const out: PromiseTopic[] = [];
  for (const [t, re] of TOPIC_RES) if (re.test(s)) out.push(t);
  return out;
}

/** 下書きの約束のうち、前のこちらの文（新→旧）に同じ中身の約束がある物（topic ごとに1つ・一番近い前） */
export function topicRepeats(
  draft: string,
  priorStaff: ReadonlyArray<{ text: string; back: number }>,
): { topic: PromiseTopic; sentence: string; ref: string; back: number }[] {
  const prior = new Map<PromiseTopic, { ref: string; back: number }>();
  for (const p of priorStaff) for (const s of splitSentencesJa(p.text)) for (const t of promiseTopics(s)) {
    const cur = prior.get(t);
    if (!cur || p.back < cur.back) prior.set(t, { ref: s, back: p.back });
  }
  const out: { topic: PromiseTopic; sentence: string; ref: string; back: number }[] = [];
  const done = new Set<PromiseTopic>();
  for (const s of splitSentencesJa(draft)) for (const t of promiseTopics(s)) {
    const p = prior.get(t);
    if (p && !done.has(t)) { done.add(t); out.push({ topic: t, sentence: s, ref: p.ref, back: p.back }); }
  }
  return out;
}

export type AckReplyShape = "受けだけ" | "日付の締め" | "待ちの形で言い直す" | "同じ約束を言い直す" | "新しい中身";
/** 受けだけの番への返事の形（直前のこちらの文 prev に約束がある時の見方） */
export function ackReplyShape(reply: string, prev: string): AckReplyShape {
  const prevTopics = new Set(splitSentencesJa(prev).flatMap(promiseTopics));
  const ss = splitSentencesJa(reply).filter((s) => !skipSentence(s) || /次第/.test(s));
  let wait = false, same = false, date = false, other = false;
  for (const s of ss) {
    const t = promiseTopics(s);
    if (/次第/.test(s) && (t.length || /ご連絡|お送り/.test(s))) { wait = true; continue; }
    if (t.some((x) => prevTopics.has(x))) { same = true; continue; }
    if (/(?:明日|本日|当日|明後日|[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{1,2}\/[0-9０-９]{1,2}).{0,6}(?:何卒|よろしく|宜しく)/.test(s)) { date = true; continue; }
    const ty = repeatTypeOf(s);
    if (ty === "定型の締め" || ty === "挨拶" || isCourtesyOnly(s) || /お気軽に|お手隙|ごゆっくり|とんでもございません|気になる点/.test(s) || normalizeSentence(s).length < 8) continue;
    other = true;
  }
  return same ? "同じ約束を言い直す" : wait ? "待ちの形で言い直す" : other ? "新しい中身" : date ? "日付の締め" : "受けだけ";
}

/** 前のこちらの文の最後の約束の形（待ちの形＝〜次第・日付で言い終えた／言い切り＝〜させて頂きます）と中身 */
export function priorPromiseForm(prev: string): { form: "待ちの形" | "言い切り"; topic: PromiseTopic } | null {
  const ss = splitSentencesJa(prev);
  for (let i = ss.length - 1; i >= 0; i--) {
    const t = promiseTopics(ss[i]);
    if (!t.length) continue;
    const wait = /次第|(?:明日|本日|明後日|[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{1,2}\/[0-9０-９]{1,2}|月曜|火曜|水曜|木曜|金曜|土曜|日曜|月末|週明け)/.test(ss[i]);
    const topic = t.find((x) => x !== "contact") ?? t[0];
    return { form: wait ? "待ちの形" : "言い切り", topic };
  }
  return null;
}

/** お客様のこの番の発言が受けだけ（お礼・了承・お願い・スタンプ）か */
export function isAckOnlyTurn(customer: ReadonlyArray<string>): boolean {
  const ss = customer.flatMap(splitSentencesJa).filter((x) => !/^\[スタンプ\]$/.test(x.trim()));
  if (!ss.length) return true;
  return ss.every((s) => isCourtesyOnly(s) || normalizeSentence(s).length < 4 || /^(?:はい|了解|承知|OK|ok|わかりました|分かりました|かしこまりました)/i.test(normalizeSentence(s).replace(/^/, "")) && normalizeSentence(s).length < 14);
}
