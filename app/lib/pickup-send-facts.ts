// app/lib/pickup-send-facts.ts
// AIX【物件ピックアップした】の入口と出口の材料（純関数・DB 依存なし）。
//
// 2026-09-24 竹内「改善する。DeepSeek でテストする」— YUMA で DeepSeek に4回作らせた実物:
//   「大阪市西区・浪速区周辺から1K・家賃7万円以内でYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！
//    お気に召されたお部屋ございましたら、駐車場の空き状況も含めて確認させて頂きます！！」
//   → 送る3件は全部 1LDK・75,000／80,000／83,000円。1K・7万円以内も駐車場の約束も、9/22 に送った**前回のピックアップの文**を写した物
//   （4回中3回で前回の送信の条件・約束を今回に当てはめた）。
// 出所を追うと:
//   ・AIX の生成は画像を読まない（image_urls は件数だけ）。今回の物件を知る道が無いので、履歴にある前回の送信の文で埋めていた
//   ・履歴（recentHistory）はスタッフ行を生のまま渡していて、前回の送付の文と今回の物件の区別が無かった
//   ・旧 UI が送った社内の説明文（【1🌟★】…AD 1ヶ月）も、同じ履歴から生のまま LLM に届いていた（文には出なかったが道が開いていた）
// 直し（設計知見「おかしな文を1通見つけたら」の順）:
//   入口（厳しくてよい）: ①今回送る物件の事実（間取り・家賃だけ。AD・利益・🌟は読まない）を渡す
//                          ②履歴の前回の送付の文に「前回の物件の話」の印を付ける ③社内の説明文は中身ごと伏せる
//   出口（本文は書き換えない＝注意だけ）: 今回の物件と食い違う間取り・家賃上限、前回の送付の約束の写しを注意に出す
//   ※出口で本文を消さないのは、「1K」を含む正しい送付（お客様の希望が1K で送る物件も1K）を誤って消さないため。
//     食い違いの判定は今回の物件の事実がある時だけ（売上サポから来た時）で、事実が無ければ何もしない

export type PickupFactRow = { summary_text?: string | null; image_lines?: readonly string[] | null };
export type PickupFact = { layout: string | null; rentYen: number | null };

const toHalf = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ．，]/g, (c) => c === "．" ? "." : c === "，" ? "," : String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const LAYOUT_RE = /(?<![0-9A-Za-z])([1-5])\s*(SLDK|LDK|SDK|DK|K|R)(?![A-Za-z])/gi;
/** 文の中の間取り（1K・1LDK・ワンルーム→1R）。大文字・半角にそろえる */
export function extractLayouts(text: string): string[] {
  const t = toHalf(String(text ?? ""));
  const out = new Set<string>();
  for (const m of t.matchAll(LAYOUT_RE)) out.add(`${m[1]}${m[2].toUpperCase()}`);
  if (/ワンルーム/.test(t)) out.add("1R");
  return [...out];
}

/**
 * ピックアップの1行（property_pickups）から、お客様に書いてよい事実（間取り・家賃）だけを読む。
 * AD・利益・🌟★・管理費は読まない（社内用）。間取りは画像の読み取り（「間取り: 1LDK[LDK11.9 x 洋4.4]」）を先に、無ければ説明文の3行目
 */
export function parsePickupFact(row: PickupFactRow): PickupFact {
  let layout: string | null = null;
  for (const l of row.image_lines ?? []) {
    const m = String(l).match(/^\s*間取り\s*[:：]\s*(.+)$/);
    if (m) { layout = extractLayouts(m[1])[0] ?? null; if (layout) break; }
  }
  const lines = String(row.summary_text ?? "").split("\n").map((s) => s.trim());
  if (!layout) {
    for (const l of lines.slice(1)) {
      if (/^(?:AD|広告)/i.test(l)) continue;
      const found = extractLayouts(l.split(/\s/)[0] ?? "")[0];
      if (found) { layout = found; break; }
    }
  }
  // 家賃: 説明文の2行目「80,000円 10,500円」の1つ目（家賃・管理費の順）。AD の行は見ない
  let rentYen: number | null = null;
  for (const l of lines.slice(1)) {
    if (/^(?:AD|広告)/i.test(l)) continue;
    const m = toHalf(l).match(/^([\d,]{4,9})\s*円/);
    if (m) { const v = parseInt(m[1].replace(/,/g, ""), 10); if (v >= 10000 && v <= 2000000) { rentYen = v; break; } }
  }
  return { layout, rentYen };
}

const man = (yen: number) => { const v = yen / 10000; return `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, "")}万円`; };

/** 生成に渡す「今回送る物件」のブロック（事実が1つも無ければ空） */
export function buildPickupFactsNote(facts: readonly PickupFact[]): string {
  const known = facts.filter((f) => f.layout || f.rentYen);
  if (known.length === 0) return "";
  const layouts = [...new Set(known.map((f) => f.layout).filter(Boolean))] as string[];
  const rents = known.map((f) => f.rentYen).filter((v): v is number => typeof v === "number");
  const rentText = rents.length === 0 ? "" : Math.min(...rents) === Math.max(...rents) ? `家賃${man(rents[0])}` : `家賃${man(Math.min(...rents))}〜${man(Math.max(...rents))}`;
  return [
    `【今回お送りする物件（${facts.length}件・資料から読んだ事実）】`,
    ...known.map((f, i) => `・${i + 1}件目: ${[f.layout, f.rentYen ? `家賃${man(f.rentYen)}` : ""].filter(Boolean).join("・")}`),
    `→ 間取り・家賃の数字を書くなら、この事実と合う物だけ（${[layouts.join("・"), rentText].filter(Boolean).join("／")}）。`,
    "　希望条件・会話・前回の送付の文にある間取りや「家賃〇万円以内」が、この事実と食い違う時はその数字を書かない（送る物件と違う間取り・送る物件の家賃より低い上限は誤り）。",
    "　構成にある他の文（条件を広げた旨の説明・退去予定 等）はこれまでどおり書く（この事実は数字の照合だけに使う）。",
  ].join("\n");
}

/** 履歴の前回の物件送付の文（こちらが物件と一緒に送った導入文） */
const PAST_PICKUP_SEND_RE = /ピックアップ(?:し|して)?させて(?:頂|いただ)きました|募集に(?:で|出)ました/;
/** 社内用の物件説明文（売上番長グループ向け・AD＝弊社の報酬入り）。先頭の「【1🌟★】」、または行頭の AD n ヶ月 */
const INTERNAL_CARD_HEAD_RE = /^\s*【\d+[^】]{0,4}】[^\n]*\n[^\n]*\d[\d,]*\s*円/;
const INTERNAL_AD_LINE_RE = /(?:^|\n)\s*(?:AD|ＡＤ)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:ヶ月|ヵ月|カ月|か月|ケ月|%|％|円)/i;

export function isInternalPropertyCard(text: string): boolean {
  const t = String(text ?? "");
  return INTERNAL_CARD_HEAD_RE.test(t) || INTERNAL_AD_LINE_RE.test(t);
}
export function isPastPickupSend(sender: string, text: string): boolean {
  return sender === "staff" && PAST_PICKUP_SEND_RE.test(text ?? "") && /ご査収/.test(text ?? "");
}

export const INTERNAL_CARD_PLACEHOLDER = "[社内用の物件説明文（AD 等を含む・お客様向けの文ではない。中身は使わない）]";
export const PAST_PICKUP_SEND_LABEL = "【前回の物件送付の文（その時に送った物件の話。今回の物件の間取り・家賃・約束には使わない）】";

/**
 * 履歴の1行を LLM に渡す形にする（入口）。
 *  ・社内用の説明文（スタッフ行）→ 中身ごと伏せる
 *  ・前回の物件送付の文（スタッフ行）→ 印を付ける（エリアはお客様の希望として読めるので本文は残す）
 *  ・それ以外・お客様の行はそのまま（お客様が貼った資料の OCR は触らない）
 */
export function labelHistoryTextForAix(sender: string, text: string, opts?: { labelPastPickup?: boolean }): string {
  if (sender !== "staff") return text;
  if (isInternalPropertyCard(text)) return INTERNAL_CARD_PLACEHOLDER;   // 社内の説明文は全 AIX で伏せる
  // 前回の送付の印は「今回の物件を送る」AIX（物件ピックアップ・物件オススメ）だけ。
  //   物件確認した・内覧・見積書などは、前回送った物件そのものが話題になるので印を付けない（2026-09-24 反証）
  if ((opts?.labelPastPickup ?? true) && isPastPickupSend(sender, text)) return `${PAST_PICKUP_SEND_LABEL}${text}`;
  return text;
}

/** 前回の送付の印を付ける AIX（今回の物件を新しく送る物だけ） */
export function labelsPastPickupFor(action: string | null | undefined): boolean {
  return action === "property_send" || action === "property_recommendation";
}

/** 前回の送付の文が履歴にある時にプロンプトへ足す一文 */
export const PAST_PICKUP_HISTORY_NOTE = `【履歴の${PAST_PICKUP_SEND_LABEL.replace(/[【】]/g, "")}の扱い】前回お送りした物件の時の文。書かれた間取り・家賃・設備・約束（「〇〇も確認させて頂きます」等）を今回の文に写さない。エリアの呼び方は使ってよい`;

/**
 * ピックアップ行の「駐車場の空き状況も含めて」＝今回の物件で確かめたとは分からない事を、確かめた事として書いた句（YUMA・DeepSeek 実測 2026-09-24）。
 * お客様の事情（駐車場）が糸口にあると、会話を合わせる経路がピックアップ行に混ぜる。行ごと消すと芯（ピックアップの行）が無くなるので注意だけ
 */
const UNCHECKED_CLAIM_RE = /(?:駐車場|駐輪場|バイク置場|ペット|保証会社|審査)[^\n。！!、]{0,6}(?:の)?(?:空き状況|可否|確認)(?:も)?(?:含め|踏まえ|確認し|確認済)/;
export function findUncheckedClaimInPickupLine(text: string): string | null {
  for (const line of String(text ?? "").split("\n")) {
    if (!/ピックアップ|募集に(?:で|出)ました/.test(line)) continue;
    const m = line.match(UNCHECKED_CLAIM_RE);
    if (m) return m[0];
  }
  return null;
}

const norm = (s: string) => toHalf(s).replace(/[\s　！!。、，,😊😌]/gu, "");
const PROMISE_LINE_RE = /(?:確認|交渉|サポート|お調べ|手配)させて(?:頂|いただ)きます/;

/**
 * 出口（注意だけ・本文は書き換えない）: 今回の物件の事実と食い違う書き方・前回の送付の約束の写しを見つける。
 * facts が空なら間取り・家賃は見ない（売上サポから来ていない＝今回の物件が分からない）
 */
export function findPickupSendConflicts(
  text: string,
  facts: readonly PickupFact[],
  pastSendTexts: readonly string[] = [],
  allowedPromiseLines: readonly string[] = [],
): string[] {
  const notes: string[] = [];
  const body = String(text ?? "");
  const factLayouts = new Set(facts.map((f) => f.layout).filter(Boolean) as string[]);
  if (factLayouts.size > 0) {
    const wrong = extractLayouts(body).filter((l) => !factLayouts.has(l));
    if (wrong.length) notes.push(`文の間取り（${wrong.join("・")}）が今回お送りする物件（${[...factLayouts].join("・")}）と違います`);
  }
  const rents = facts.map((f) => f.rentYen).filter((v): v is number => typeof v === "number");
  if (rents.length > 0) {
    const min = Math.min(...rents);
    for (const m of toHalf(body).matchAll(/家賃(?:・?管理費込み?)?\s*(\d+(?:\.\d+)?)\s*万(?:円)?\s*(?:以内|以下|まで)/g)) {
      const cap = parseFloat(m[1]) * 10000;
      if (cap < min) { notes.push(`文の「${m[0]}」は今回お送りする物件（家賃${man(min)}〜）と合いません`); break; }
    }
  }
  const unchecked = findUncheckedClaimInPickupLine(body);
  if (unchecked) notes.push(`「${unchecked}」は今回の物件で確かめた事が入力に無いまま書いています。確かめていなければ消してから送信してください`);
  if (pastSendTexts.length > 0) {
    const pastLines = new Set(pastSendTexts.flatMap((t) => String(t).split("\n")).filter((l) => PROMISE_LINE_RE.test(l)).map(norm).filter((l) => l.length >= 8));
    const allowed = new Set(allowedPromiseLines.map(norm));
    for (const line of body.split("\n")) {
      if (!PROMISE_LINE_RE.test(line)) continue;
      const n = norm(line);
      if (allowed.has(n)) continue;
      if (pastLines.has(n)) { notes.push(`「${line.trim()}」は前回の物件送付の文と同じ約束です。今回の物件にも当てはまるか確認してください`); break; }
    }
  }
  return notes;
}
