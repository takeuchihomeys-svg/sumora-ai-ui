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
      if (/^(?:A\s?D|ＡＤ|広告)/i.test(l)) continue; // 社内の AD 行（「A D 250%」も）は読まない
      const found = extractLayouts(l.split(/\s/)[0] ?? "")[0];
      if (found) { layout = found; break; }
    }
  }
  // 家賃: 説明文の2行目「80,000円 10,500円」の1つ目（家賃・管理費の順）。AD の行は見ない
  let rentYen: number | null = null;
  for (const l of lines.slice(1)) {
    if (/^(?:A\s?D|ＡＤ|広告)/i.test(l)) continue; // 社内の AD 行（「A D 250%」も）は読まない
    const m = toHalf(l).match(/^([\d,]{4,9})\s*円/);
    if (m) { const v = parseInt(m[1].replace(/,/g, ""), 10); if (v >= 10000 && v <= 2000000) { rentYen = v; break; } }
  }
  return { layout, rentYen };
}

const man = (yen: number) => { const v = yen / 10000; return `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, "")}万円`; };

/**
 * 希望条件の欄（「間取り: 1K、1DK、1LDK」「希望: バストイレ別・オートロック」）を欄の名前ごとに読む（値は書かれた文字のまま）。
 * 2026-09-27 竹内さん「文字変えなくても…そのまま使う・文字抜かなくて」: 物件ピックアップの文が
 *   「間取り: 1K、1DK、1LDK」を「1K」だけに・「バストイレ別・オートロック」を「バストイレ別オートロック」にしていた（YUMA 9/27）。
 *   出所は ①下の事実のブロックの「この事実と合う間取りだけ」（希望の並びが送る物件を含む時も1Kに絞らせた）
 *   ②構成の「入れる条件は最大4個まで」（2つの設備を1つにくっつけて数を合わせた）。欄の文字のまま使わせるために欄を読む
 */
export function parseConditionFields(conditionsText: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of String(conditionsText ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：\s]{1,8})\s*[:：]\s*(.+?)\s*$/);
    if (m && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/** 希望条件の「間取り」欄の値（書かれた文字のまま）と、そこに並ぶ間取り。欄が無ければ null */
export function desiredLayoutField(conditionsText: string | null | undefined): { raw: string; layouts: string[] } | null {
  const raw = parseConditionFields(conditionsText).get("間取り");
  if (!raw) return null;
  const layouts = extractLayouts(raw);
  return layouts.length ? { raw, layouts } : null;
}

/** 送る物件の間取りが全部、希望条件の間取りの並びに入っている＝希望の並びをそのまま書いてよい */
export function desiredLayoutsCoverFacts(facts: readonly PickupFact[], conditionsText: string | null | undefined): { raw: string; layouts: string[] } | null {
  const d = desiredLayoutField(conditionsText);
  if (!d) return null;
  const factLayouts = facts.map((f) => f.layout).filter(Boolean) as string[];
  if (factLayouts.length === 0) return null;
  return factLayouts.every((l) => d.layouts.includes(l)) ? d : null;
}

/** 生成に渡す「今回送る物件」のブロック（事実が1つも無ければ空） */
export function buildPickupFactsNote(facts: readonly PickupFact[], conditionsText?: string | null): string {
  const known = facts.filter((f) => f.layout || f.rentYen);
  if (known.length === 0) return "";
  const layouts = [...new Set(known.map((f) => f.layout).filter(Boolean))] as string[];
  const rents = known.map((f) => f.rentYen).filter((v): v is number => typeof v === "number");
  const rentText = rents.length === 0 ? "" : Math.min(...rents) === Math.max(...rents) ? `家賃${man(rents[0])}` : `家賃${man(Math.min(...rents))}〜${man(Math.max(...rents))}`;
  // 2026-09-27: 希望条件の間取りの並びが送る物件の間取りを全部含む時は、並びを絞らせない（「1K、1DK、1LDK」→「1K」だけにしていた）
  const covered = desiredLayoutsCoverFacts(known, conditionsText);
  return [
    `【今回お送りする物件（${facts.length}件・資料から読んだ事実）】`,
    ...known.map((f, i) => `・${i + 1}件目: ${[f.layout, f.rentYen ? `家賃${man(f.rentYen)}` : ""].filter(Boolean).join("・")}`),
    covered
      ? `→ 希望条件の間取り「${covered.raw}」は今回の物件（${layouts.join("・")}）を含むので、間取りを書くなら希望条件の欄の文字のまま「${covered.raw}」と書く（送る物件の間取りだけに絞らない・並びも区切りも変えない）。家賃の数字を書くなら、この事実と合う物だけ${rentText ? `（${rentText}）` : ""}。`
      : `→ 間取り・家賃の数字を書くなら、この事実と合う物だけ（${[layouts.join("・"), rentText].filter(Boolean).join("／")}）。`,
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
  conditionsText?: string | null,
): string[] {
  const notes: string[] = [];
  const body = String(text ?? "");
  const factLayouts = new Set(facts.map((f) => f.layout).filter(Boolean) as string[]);
  if (factLayouts.size > 0) {
    // 希望条件の並びが送る物件を含む時は、並びの間取り（1DK・1LDK）を書いても食い違いにしない（入口で並びのまま書かせている）
    const covered = desiredLayoutsCoverFacts(facts, conditionsText);
    const wrong = extractLayouts(body).filter((l) => !factLayouts.has(l) && !(covered?.layouts.includes(l)));
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

/**
 * 出口（中黒を戻すだけ・文字は消さない）: ピックアップ行で、希望条件の欄の語「バストイレ別・オートロック」が
 * 中黒を落として「バストイレ別オートロック」になっていたら、欄の文字のまま（中黒あり）に戻す。
 * 2026-09-27 竹内さん「文字抜かなくてそのまま使う」（YUMA 9/27 の物件ピックアップ）。
 * 誤削除0: 足すのは「・」だけ（中黒を全部消すと前後で同じ文になる）。当てるのはピックアップ行・中黒を抜いた形が4文字以上の語だけ。
 * 監査 scripts/audit-condition-verbatim.ts（aix_generate_log の物件ピックアップ全件×その時の希望条件）
 */
export function restoreConditionDots(text: string, conditionsText: string | null | undefined): { text: string; restored: string[] } {
  const items: string[] = [];
  for (const v of parseConditionFields(conditionsText).values()) {
    for (const it of v.split(/[、,，\/／]/)) {
      const t = it.trim();
      if (t.includes("・") && t.replace(/・/g, "").length >= 4) items.push(t);
    }
  }
  if (items.length === 0) return { text, restored: [] };
  const restored: string[] = [];
  const lines = String(text ?? "").split("\n").map((line) => {
    if (!/ピックアップ|募集に(?:で|出)ました/.test(line)) return line;
    let out = line;
    for (const it of items) {
      const joined = it.replace(/・/g, "");
      if (out.includes(it) || !out.includes(joined)) continue;
      out = out.split(joined).join(it);
      restored.push(it);
    }
    return out;
  });
  return { text: lines.join("\n"), restored };
}
