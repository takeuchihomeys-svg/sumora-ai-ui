// app/lib/closed-ack.ts
// 「こちらが締めた後のお礼」＝返信しないで連絡を待つ場面と、送った文と同じ内容の下書きの判定（純関数・DB 依存なし）。
//
// 2026-09-15 竹内（朱莉事例）「前に送ってる文と同じ内容を生成しない。ここは返信せずに、連絡を待つ形なので、
//   物件ピックアップと物件オススメの AIX をセットしておく」:
//   AIX 物件ピックアップ送付（19:12）→ お客様「ありがとうございます！確認してみます！」→ こちら「はい😊！！朱莉さん気になる点出てきましたら
//   何時でもお気軽にご連絡ください😌！！」→ お客様「ありがとうございます！」→ 下書き「はい😊！！朱莉さん気になる点等出てきましたらいつでも
//   お気軽にご連絡ください！！」（直前にこちらが送った文とほぼ同じ）。ブレインは「感謝を受け取り待ちの姿勢で締める」・AIX なし。
//   実データ（8月〜・こちらの締めの後のお客様のお礼だけ 10件）: 返信しなかった 8（うち4件は後でこちらから物件を AIX で送った）・
//   返信した 2（どちらも新しい内容。締めの繰り返しは0件）。

/**
 * こちらの締めの一文（扉を開けて待つ）。reply-context の OPEN_DOOR_RE（受け身締めの検査用・「いつでも」のみ）より広い:
 * 「何時でも」「お気軽にお申し付けください」「ご不明点ございましたらご連絡ください」も締め。
 * OPEN_DOOR_RE は PASSIVE_CLOSER の検査と生成の扉（何時でも…ご連絡ください）の区別に使っているので変えない
 */
// 「お待ちしております」は連絡を待つ形だけ（「10時半頃のお電話お待ちしております」「ご来店お待ちしております」は約束・予定で締めではない。
//   120日の実データで yasuki 9/14 のお電話の約束が当たっていた）
export const STAFF_CLOSING_DOOR_RE = /(?:いつでも|何時でも)?(?:お気軽に)?(?:ご連絡|お知らせ|ご相談|お申し付け|お声がけ|お問い合わせ)(?:ください|下さい)|(?:ご連絡|ご返信|お返事)(?:を)?(?:心より)?お待ちしております/;

const MEDIA_ONLY_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]$/;

/** こちらの文が締めで終わっているか（締めの一文が最後の2行にあり、最後がお客様への質問でない） */
export function staffClosedTheDoor(text: string | null | undefined): boolean {
  const lines = (text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const tail = lines.slice(-2).join("\n");
  if (!STAFF_CLOSING_DOOR_RE.test(tail)) return false;
  // 最後がお客様への質問（「〜でしょうか？」）ならお客様の返事を待っている＝お礼だけでも答えになっていない
  if (/[？?]\s*[😊😌✨！!]*$/.test(lines[lines.length - 1])) return false;
  return true;
}

export type ClosedAckVerdict = { closed: boolean; staffLine: string; reason: string };

/**
 * 返信しないで連絡を待つ場面か: お客様の最後の連投がお礼・了承だけ（isAckOnly・呼び出し側の判定を渡す）で、
 * その直前のこちらの文字の発言が締めで終わっている。messages は古い順
 */
export function resolveClosedAck(
  messagesOldestFirst: ReadonlyArray<{ sender: string; text?: string | null }>,
  customerAckOnly: boolean,
): ClosedAckVerdict {
  const no = (reason: string): ClosedAckVerdict => ({ closed: false, staffLine: "", reason });
  if (!customerAckOnly) return no("customer_not_ack");
  const last = messagesOldestFirst[messagesOldestFirst.length - 1];
  if (!last || last.sender !== "customer") return no("last_not_customer");
  // お客様の連投の前の、こちらの文字の発言（画像だけの通は飛ばす）
  let i = messagesOldestFirst.length - 1;
  while (i >= 0 && messagesOldestFirst[i].sender === "customer") i--;
  while (i >= 0 && messagesOldestFirst[i].sender === "staff" && MEDIA_ONLY_RE.test((messagesOldestFirst[i].text ?? "").trim())) i--;
  const staff = i >= 0 ? messagesOldestFirst[i] : null;
  if (!staff || staff.sender !== "staff") return no("no_staff_before");
  const t = (staff.text ?? "").trim();
  if (!staffClosedTheDoor(t)) return no("staff_not_closing");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  return { closed: true, staffLine: lines[lines.length - 1] ?? "", reason: "ack_after_staff_close" };
}

/** 比べるための正規化（絵文字・記号・空白を落とし、表記ゆれをそろえる） */
export function normalizeForDup(text: string): string {
  return (text ?? "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/何時でも/g, "いつでも")
    .replace(/下さい/g, "ください")
    .replace(/(頂|戴)/g, "いただ")
    .replace(/御座/g, "ござ")
    .replace(/(?<=点|事|こと)等/g, "")
    .replace(/[\s！!？?。、，,．.・…〜~「」『』（）()【】]/g, "");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const cps = [...s];
  for (let i = 0; i < cps.length - 1; i++) { const b = cps[i] + cps[i + 1]; m.set(b, (m.get(b) ?? 0) + 1); }
  return m;
}
/** 文字の2つ組の重なり（Dice 係数 0〜1） */
export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  if (na === 0 || nb === 0) return a === b && a.length > 0 ? 1 : 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / (na + nb);
}

/** 文中の数字（全角→半角）。号室・金額・日付が違えば別の内容 */
function numbersOf(text: string): string {
  return ((text ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).match(/\d+/g) ?? []).join(",");
}

/**
 * 下書きが最近こちらが送った文とほぼ同じか（正規化して12字以上・Dice 0.85 以上・文中の数字が全て同じ）。sentTexts はこちらの最近の文字の発言。
 * 実送信60日で計測: スタッフの文字の発言 3,988通のうち直前3件（48時間）とこの判定で同じになったのは29通。数字の条件を足す前は
 * 別の号室・金額の御見積書カード（304号室／302号室）が 0.89〜0.91 で同じと判定されていた
 */
export const DUP_SIMILARITY_THRESHOLD = 0.85;
export function findNearDuplicateSent(draft: string, sentTexts: readonly string[]): { dup: boolean; score: number; matched: string | null } {
  const d = normalizeForDup(draft);
  if ([...d].length < 12) return { dup: false, score: 0, matched: null };
  const dNums = numbersOf(draft);
  let best = 0, matched: string | null = null;
  for (const s of sentTexts) {
    const n = normalizeForDup(s);
    if ([...n].length < 12) continue;
    if (numbersOf(s) !== dNums) continue;
    const score = diceSimilarity(d, n);
    if (score > best) { best = score; matched = s; }
  }
  return { dup: best >= DUP_SIMILARITY_THRESHOLD, score: Math.round(best * 100) / 100, matched: best >= DUP_SIMILARITY_THRESHOLD ? matched : null };
}
