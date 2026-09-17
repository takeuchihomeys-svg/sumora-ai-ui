// app/lib/reply-phrasing.ts
// 返信の言い回しの掃除（純関数・DB 依存なし）。
//
// 2026-09-17 竹内（あや事例）:
//   ①「ご案内させて頂きますとは、意味がわからない文なので、いれない。お部屋案内とかなら良いけど、こんな感じで無理やり入れない」
//   ②「最後の文は前にも使ってるので、出来る限り全く同じ文を言わない（使っていたら）コピペと思われてしまう為」
//
// 何が起きたか（あやさんの会話・実データ）:
//   9/16 17:42 スタッフ「はい😊！！／ごゆっくりご検討頂けますと幸いです！！／
//     **お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますので**いつでもお気軽にご連絡ください😌！！」
//   9/16 22:17 AI 下書き「はい😊！！／ごゆっくりご検討頂けますと幸いです！！／
//     気になる点等出てきましたら**ご案内させて頂きますので**、いつでもお気軽にご連絡ください😌！！」
//   → 17:42 の文から「お部屋お気に召されましたら」「実際にお部屋」（＝案内する対象）だけを落として
//     「気になる点等出てきましたら」に接ぎ木したため、何を案内するのか分からない文になった。
//   スタッフの実送信（22:17）は「あやさん気になる点等出てきましたら何時でもお気軽にご連絡ください！！」＝「ご案内」を削っている。
//
// 実データ（1年・スタッフ実送信）:
//   「ご案内させて頂きます」755通。条件節つき（〜たら／れば）は全て「お気に召されましたら」「よろしければ」＝
//   **お客様が物件を気に入ったら**が条件で、案内する対象（お部屋・物件名・お日にち・時刻）が必ずある。
//   「ご案内」と「ご連絡ください」が同じ文にあり、対象の語が1つも無い文は **0件**（＝この形はスタッフが書かない）。
import { normalizeForDup, diceSimilarity } from "./closed-ack";

/** 文に分ける（。！！？と改行で切る。区切り文字は前の文に残す） */
export function splitSentences(text: string): string[] {
  return (text ?? "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！!？?]+)(?=[^。！!？?\s])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── ①案内する対象が無い「ご案内させて頂きます」を落とす ───
/** 「ご案内させて頂きます」（丁寧形のゆれ） */
const GUIDANCE_RE = /ご案内(?:させて頂き|させていただき|いたし|致し)ます/;
/**
 * 案内する対象・場面の語。1つでもあれば正しい使い方なので触らない
 * （実データで「ご案内」を含む実送信のうち、この語が1つも無い文と「ご連絡ください」が同居する例は0件）
 */
const GUIDANCE_OBJECT_RE = /気に召|よろしけれ|ご希望|ご覧|内覧|お部屋|物件|号室|マンション|お日にち|ご都合|現地|書類|ご来店|一緒|改めて|[0-9０-９]/;
/** お客様に連絡を促す締め。「ご案内」がこの文に混ざるのが今回の誤り（文の主動詞はこちら側にある） */
const ASK_CONTACT_RE = /(?:ご連絡|お知らせ|お申し付け|ご相談|お声がけ|お問い合わせ)ください/;
/** 落とす節（「ご案内させて頂きますので、」だけを抜き、条件節と締めは残す） */
const GUIDANCE_CLAUSE_RE = /ご案内(?:させて頂き|させていただき|いたし|致し)ます(?:ので)?[、,]?\s*/g;

/**
 * 案内する対象が無いのに「ご案内させて頂きます」が入っている節を落とす。
 * 落とすのは「お客様に連絡を促す締めの文（ご連絡ください等）の中に混ざっている」時だけ＝
 * 「お気に召されましたらご案内させて頂きます」「15:00よりご案内させて頂きます」のような正しい文は触らない。
 */
export function stripPointlessGuidance(text: string): string {
  const src = text ?? "";
  if (!GUIDANCE_RE.test(src)) return src;
  let changed = false;
  const out = splitSentences(src).map((s) => {
    if (!GUIDANCE_RE.test(s) || !ASK_CONTACT_RE.test(s) || GUIDANCE_OBJECT_RE.test(s)) return s;
    const stripped = s.replace(GUIDANCE_CLAUSE_RE, "").trim();
    if (!stripped || stripped === s) return s;
    changed = true;
    return stripped;
  });
  if (!changed) return src;
  // 元の改行の形（1文1行）を保つ。元が1行なら1行に戻す
  return src.includes("\n") ? out.join("\n") : out.join("");
}

// ─── ②この会話で既に使った文を繰り返さない ───
/** ほぼ同じ文とみなす閾値（0.92＝言い回しの揺れだけの違い）。findNearDuplicateSent（全文 0.85）より厳しくする */
export const REPEAT_SIMILARITY_THRESHOLD = 0.92;
/**
 * 繰り返しても構わない文（相槌・挨拶・AIX や見積書の定型・箇条書き）。ここを「前に使った」と言うと、
 * 送るたびに出る定型まで変えさせてしまう。
 * 実データ（180日・同じ会話で2回以上使われた文）の上位はすべてこの型:
 *   お手隙の際にご査収ください 145会話／※ご入居日によって日割家賃が発生致します 69／何卒よろしくお願い致します 49／
 *   ・敷金礼金なしのため初期費用を…（物件カードの箇条書き）38／🌟最大限割引しました初期費用の御見積書同封させて頂きました 27／
 *   現地エントランスお待ち合わせで… 15
 */
const REPEAT_SKIP_RE = /^(?:はい|かしこまりました|承知|お世話になっております|ありがとうございます|何卒|引き続き|それでは|[・※🌟【（(])|お手隙の際にご査収ください|御見積書同封させて頂きました|御見積書となります|日割家賃|現地エントランス|よろしくお願い(?:致します|いたします|します)|お待ちしております/;
/** 比べる長さ（これ未満の文は型として短すぎる） */
const REPEAT_MIN_CHARS = 14;

/** 繰り返しを避けたい文を、こちらの最近の発言から集める（新しい順・重複は1つ） */
export function recentUsedSentences(staffTextsOldestFirst: readonly string[], opts: { messages?: number; limit?: number } = {}): string[] {
  const messages = opts.messages ?? 6;
  const limit = opts.limit ?? 6;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...staffTextsOldestFirst].slice(-messages).reverse()) {
    for (const s of splitSentences(t)) {
      if (REPEAT_SKIP_RE.test(s)) continue;
      const n = normalizeForDup(s);
      if ([...n].length < REPEAT_MIN_CHARS || seen.has(n)) continue;
      seen.add(n);
      out.push(s);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 締めの文（末尾から、定型・相槌・短い文を飛ばして最初に見つかる文）。
 * 竹内さんの指摘は「**最後の文**は前にも使ってる」なので、繰り返しを見るのはここだけにする
 * （本文の途中の定型まで見ると、送るたびに出る文（お手隙の際にご査収ください等）が全部ひっかかる）
 */
export function closingSentence(text: string): string | null {
  const sents = splitSentences(text);
  for (let i = sents.length - 1; i >= 0; i--) {
    const s = sents[i];
    if (REPEAT_SKIP_RE.test(s)) continue;
    if ([...normalizeForDup(s)].length < REPEAT_MIN_CHARS) continue;
    return s;
  }
  return null;
}

/** 下書きの締めの文が、既に送った文とほぼ同じか（材料で防ぎ切れなかった分を検査で出す） */
export function findRepeatedClosing(draft: string, used: readonly string[]): { sentence: string; matched: string; score: number } | null {
  const closing = closingSentence(draft);
  if (!closing) return null;
  const hits = findRepeatedSentences(closing, used);
  return hits[0] ?? null;
}

/** 下書きの中で、既に使った文とほぼ同じ文（締めだけを見る findRepeatedClosing が呼ぶ本体） */
export function findRepeatedSentences(draft: string, used: readonly string[]): Array<{ sentence: string; matched: string; score: number }> {
  const hits: Array<{ sentence: string; matched: string; score: number }> = [];
  const usedNorm = used.map((u) => ({ raw: u, n: normalizeForDup(u) })).filter((u) => [...u.n].length >= REPEAT_MIN_CHARS);
  if (usedNorm.length === 0) return hits;
  for (const s of splitSentences(draft)) {
    if (REPEAT_SKIP_RE.test(s)) continue;
    const n = normalizeForDup(s);
    if ([...n].length < REPEAT_MIN_CHARS) continue;
    let best = 0, matched = "";
    for (const u of usedNorm) {
      const score = diceSimilarity(n, u.n);
      if (score > best) { best = score; matched = u.raw; }
    }
    if (best >= REPEAT_SIMILARITY_THRESHOLD) hits.push({ sentence: s, matched, score: Math.round(best * 100) / 100 });
  }
  return hits;
}

/** 生成の材料（同じ言い回しを繰り返さない）。使った文が無ければ空 */
export function buildAvoidRepeatNote(used: readonly string[]): string {
  if (used.length === 0) return "";
  return [
    "",
    "",
    "【この会話で既に送った言い回し（コピペに見えるので、同じ文をそのまま繰り返さない）】",
    ...used.map((s) => `・${s}`),
    "※同じ用件でも言葉を変える（例: 「気になる点出てきましたらご連絡ください」を既に使ったなら「ご不明点あればいつでもお申し付けください」等）。",
    "※ただし挨拶・相槌（「はい！！」「かしこまりました！！」）と決まった締め（「何卒よろしくお願い致します」）はそのままでよい。",
  ].join("\n");
}
