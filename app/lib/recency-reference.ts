// app/lib/recency-reference.ts
// 「先ほどのお部屋」「先程お送りした」等、近さの言葉で前の物件を指すのは、前の物件のやり取りが近い時だけ（純関数・DB 依存なし）。
//
// 2026-10-06 竹内（見木 響夢さん・AIX テンプレート一覧【AIX】「1件特にオススメする」→「この会話に合った文を生成」）:
//   生成「先ほどのお部屋とは別にお送りさせて頂きました！！」
//   「AIXテンプレートの部分 時系列を理解していない。先程ってかなり前にやり取りしていた物件なので、そこも踏まえて考える」
//   実物: 前の物件のやり取りは 2日半前（10/02 のスタッフの返信・物件そのものは 9/28 の物件確認）。今の通の🌟（新着1件）は数秒前。
//   プロンプトの会話には「（2日前）」の札が付いていたが、近さの言葉を使ってよい時間の線がどこにも無く、出口も無かった。
//
// ■ 実送信（365日・スタッフの送信）
//   「先ほど／先程」39通のうち、物件・お部屋・送付を指す物は5通（うち AI の下書きをそのまま送った5月の物を含む）。
//   残りは「先ほどはお電話ありがとうございました」（同じ日の電話）と「先ほどの記入欄」（直前に送った物）＝**近い物だけ**。
//   古い送付を指す時のスタッフの言い方は「以前お送りさせていただきました」（30通）・「以前お送りいただきました」（お客様の送付）。
//   → 線: 前の物件のやり取りから RECENT_REF_MAX_HOURS 以内だけ近さの言葉を許す。古い時は語を「以前」に替える（スタッフの言い方・創作しない）
//
// ■ 出口の形（誤って消さない）
//   ・語だけを替える（「先ほどお送りした」→「以前お送りした」・「先ほどの物件」→「以前お送りさせて頂きました物件」）
//   ・「先ほどのお部屋とは別にお送りさせて頂きました！！」のように、近さの言葉で前の物件と比べるだけで事実の無い行は行ごと外す
//   ・「先ほどはお電話」等、物件を指さない物は触らない

/** 近さの言葉 */
const RECENT_WORD = "(?:先ほど|先程|さきほど|さっき|今しがた)";
/** 近さの言葉の直後（同じ文の25字まで）に物件を指す語があるか。「先ほどはお電話」「先ほどお送りした項目」（条件の記入欄）は物件ではない */
const ROOM_NOUN_RE = /お部屋|物件|号室|部屋|お気に召され/;
const SEND_VERB_RE = /^(?:の|に)?(?:お送り|送らせ|ご紹介|ご提案)/;
const NOT_ROOM_RE = /お電話|電話|項目|記入欄|フォーマット|メッセージ|書類|ご質問|内容|ご条件|URL|リンク|募集/; // 募集: 「先程募集に出たばかりのお部屋」は掲載の時刻で、こちらのやり取りではない
const RECENT_WORD_G = new RegExp(RECENT_WORD, "g");
const RECENT_WORD_HEAD_RE = new RegExp(`^${RECENT_WORD}`);
/** 本文の中で、近さの言葉が物件・送付を指している位置（無ければ空） */
export function recentRoomRefs(text: string): number[] {
  const out: number[] = [];
  const src = String(text ?? "");
  for (const m of src.matchAll(RECENT_WORD_G)) {
    const at = (m.index ?? 0) + m[0].length;
    const win = src.slice(at, at + 25).split(/[。！!\n]/)[0];
    const room = win.search(ROOM_NOUN_RE);
    const notRoom = win.search(NOT_ROOM_RE);
    // 物件の語が、物件でない語（電話・項目・記入欄…）より先に来る → 物件を指している
    const byNoun = room >= 0 && (notRoom < 0 || room < notRoom);
    // 「先ほどお送りしましたエステムプラザ…5階部分が」のように物件の語が無くても、送付の語で始まり物件でない語が無い → 物件を指している
    const byVerb = SEND_VERB_RE.test(win) && notRoom < 0;
    if (byNoun || byVerb) out.push(m.index ?? 0);
  }
  return out;
}
/** 近さの言葉で物件・送付を指す形があるか */
export function hasRecentRoomRef(text: string | null | undefined): boolean {
  return recentRoomRefs(String(text ?? "")).length > 0;
}
/** 近さの言葉を許す時間（前の物件のやり取りから） */
export const RECENT_REF_MAX_HOURS = 3;
/** 今の通（AIX の1通目・画像）として扱う直前のスタッフの送信の時間 */
const CHAIN_MINUTES = 15;

export type ExchangeMsg = { sender?: string | null; text?: string | null; created_at?: string | null; rawCreatedAt?: string | null; createdAt?: string | null };

/** 物件のやり取りの通（どちらの発言でも） */
const ROOM_EXCHANGE_RE = /🌟|号室|お部屋|物件|https?:\/\/|^\s*\[画像\]/;

const timeOf = (m: ExchangeMsg): number => Date.parse(String(m.created_at ?? m.rawCreatedAt ?? m.createdAt ?? ""));

/**
 * 前の物件のやり取り（今の通より前）からの時間と、誰の通か。分からない時は null。
 *   今の通 = 末尾から続くスタッフの送信のうち、今から CHAIN_MINUTES 以内の物（AIX の1通目・物件の画像）
 */
export function lastRoomExchange(messages: readonly ExchangeMsg[], nowMs: number): { hours: number; by: "staff" | "customer" } | null {
  let i = messages.length - 1;
  while (i >= 0) {
    const m = messages[i];
    const t = timeOf(m);
    if (m.sender !== "customer" && Number.isFinite(t) && nowMs - t <= CHAIN_MINUTES * 60_000) { i--; continue; }
    break;
  }
  for (; i >= 0; i--) {
    const m = messages[i];
    if (!ROOM_EXCHANGE_RE.test(String(m.text ?? ""))) continue;
    const t = timeOf(m);
    if (!Number.isFinite(t)) return null;
    return { hours: Math.max(0, (nowMs - t) / 3_600_000), by: m.sender === "customer" ? "customer" : "staff" };
  }
  return null;
}

/** 近さの言葉で前の物件を指してよいか（分からない時は true＝出口を掛けない） */
export function recentReferenceOk(last: { hours: number } | null): boolean {
  return !last || last.hours <= RECENT_REF_MAX_HOURS;
}

/** 生成に渡す時系列の1行（前の物件のやり取りがいつか・近さの言葉を使ってよいか） */
export function buildRecencyNote(last: { hours: number; by: "staff" | "customer" } | null, nowMs: number): string {
  if (!last) return "";
  const at = new Date(nowMs - last.hours * 3_600_000 + 9 * 3_600_000); // JST
  const md = `${at.getUTCMonth() + 1}/${at.getUTCDate()}`;
  const ago = last.hours < 1 ? "1時間以内" : last.hours < 24 ? `${Math.round(last.hours)}時間前` : `${Math.round(last.hours / 24)}日前`;
  const who = last.by === "customer" ? "お客様から" : "こちらから";
  if (last.hours <= RECENT_REF_MAX_HOURS) return `・前の物件のやり取り（${who}）: ${ago}（${md}）`;
  return `・前の物件のやり取り（${who}）: ${ago}（${md}）→ 前の物件を「先ほど」「先程」「さっき」で指さない（${RECENT_REF_MAX_HOURS}時間以内の時だけの言葉）。触れる時はスタッフの言い方「以前お送り${last.by === "customer" ? "頂きました" : "させて頂きました"}」。今回の通は前の物件と比べずに、この物件だけの事実で書く`;
}

/** 近さの言葉で前の物件と比べるだけの行（事実を持たない）: 「先ほどのお部屋とは別にお送りさせて頂きました！！」 */
const COMPARE_ONLY_LINE_RE = new RegExp(`^[\\s　]*${RECENT_WORD}の?(?:お部屋|物件)(?:とは別に|に加えて|以外に)[^\\n0-9０-９]{0,20}(?:お送り|ご紹介|ピックアップ)(?:させて(?:頂|いただ)きま(?:す|した)|しま(?:す|した))[😊😌✨！!。\\s]*$`, "m");

/**
 * 前の物件のやり取りが古い（RECENT_REF_MAX_HOURS 超）のに近さの言葉で指していたら直す。
 *   ・比べるだけの行は行ごと外す ・それ以外は語だけ「以前」に替える
 */
export function fixRecentReference(text: string, last: { hours: number; by: "staff" | "customer" } | null): { text: string; applied: string[] } {
  const src = text ?? "";
  if (recentReferenceOk(last) || !hasRecentRoomRef(src)) return { text: src, applied: [] };
  const applied: string[] = [];
  let out = src;
  if (COMPARE_ONLY_LINE_RE.test(out)) {
    out = out.replace(new RegExp(COMPARE_ONLY_LINE_RE.source, "gm"), "");
    applied.push("recent_compare_line");
  }
  const sentBy = last?.by === "customer" ? "お送り頂きました" : "お送りさせて頂きました";
  const before = out;
  // 物件・送付を指している近さの言葉だけを替える（後ろから・位置がずれないように）
  //   「先ほどの物件」「先程のお部屋」→ 以前お送りさせて頂きました物件（お客様の送付なら お送り頂きました）
  //   「先ほどお送りした」「先程ご紹介した」「先ほどお気に召された」→ 以前〜
  for (const at of recentRoomRefs(out).reverse()) {
    const word = out.slice(at).match(RECENT_WORD_HEAD_RE)?.[0] ?? "";
    if (!word) continue;
    const rest = out.slice(at + word.length);
    const noun = rest.match(/^の(お部屋|物件)/);
    out = noun ? `${out.slice(0, at)}以前${sentBy}${noun[1]}${rest.slice(noun[0].length)}` : `${out.slice(0, at)}以前${rest}`;
  }
  if (out !== before) applied.push("recent_word");
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trim();
  if (!out) return { text: src, applied: [] };
  return applied.length ? { text: out, applied } : { text: src, applied: [] };
}
