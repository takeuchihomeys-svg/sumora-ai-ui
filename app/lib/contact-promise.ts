// app/lib/contact-promise.ts — 入居の時期が先のお客様への「理想の流れ＋連絡の日の約束」と、連絡の日の約束をカレンダーに置く決まり（純関数・DB なし）
//
// 2026-10-08 竹内さん「連絡する期間を約束したらカレンダーに入れる。また2月に引っ越すなどなれば、物件を抑える事ができるのは1ヶ月のため、
//   1ヶ月半前から探し出す形が理想の流れと伝えて、その日に連絡するように約束後カレンダーに組み込む。言い回しなどは実際の LINE にある」
//
// ■ 実際の LINE（竹内さんの送信 staff_writer='takeuchi'・全期間。scripts/audit-contact-promise.ts）
//   06-07 きむら（入居 8/20 頃）「お部屋の抑える事が出来るのが、伸ばす事が出来て30日となりますので、7月に入ってから本格的にお部屋探しを進めて頂くのがオススメです！！
//         7月1日にきむらさんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！ 引き続き何卒よろしくお願い致します！！」（連絡の日＝入居の約50日前）
//   06-14 あい（入居 8月末）「7月下旬（7月20日）に最新の物件で あいさんにオススメ出来るお部屋ピックアップし一度お送りさせて頂きます😊！！」（約41日前）
//   06-28 Hayato（9〜11月頃）「8月から本格的にお部屋探しを進めて頂く形で、8月に入りましたら…優先的にピックアップしてお送りさせて頂きます！！」
//   07-02 友哉（9/27〜30 入居）「8月後半から物件ピックアップを開始し、9月頭のお申込み・9月27〜30日頃のご入居に向けてしっかりサポートさせて頂きます😊！！」
//         → 翌日「8月後半に友哉さんへご連絡させて頂きます！！」
//   10-06 カメ（2028年3月）「弊社では2ヶ月前からお引越しのサポートをさせて頂いております。2028年1月からお部屋探しをさせて頂ければと思います😊！！」（2ヶ月前＝今回の1ヶ月半と食い違い・報告）
//   従業員の送信（中身だけ使う）: 「お申込みから1ヶ月以内で入居日を設定いただく必要がございます」（多数）・「延ばせて40日間」（YUYA）
//   → 順番: ①抑えられる期間（1ヶ月）→ ②〇月〇日頃から本格的に探すのが理想の流れ → ③〇月〇日に〇〇さんのご条件に合ったお部屋をピックアップしお送り（約束）→ ④引き続き何卒
//   連絡の日の決め方（竹内さん 10/08）: 入居の始まりの日の1ヶ月半前（暦で1ヶ月戻して15日戻す）。土日をずらすかは竹内さんに確認中（今はずらさない）
//
// 推測しない: 日付は決まった言い方だけ読む（「来年」「春」「未定」「すぐ」は読まない）。戻す: FAR_MOVE_IN_CONTACT=off（ブレイン）・CONTACT_PROMISE_CALENDAR=off（カレンダー）
import { jstParts, JST_OFFSET_MS } from "./jst-date";

const DAY = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
export type Ymd = { y: number; m: number; d: number };
export const ymdStr = (p: Ymd) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const utcOf = (p: Ymd) => Date.UTC(p.y, p.m - 1, p.d);
const fromUtc = (ms: number): Ymd => { const d = new Date(ms); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const todayOf = (iso: string | number): Ymd => { const p = jstParts(iso); return { y: p.y, m: p.m, d: p.d }; };
export const daysBetween = (a: Ymd, b: Ymd) => Math.round((utcOf(b) - utcOf(a)) / DAY);

/** お部屋を抑えられる期間（会社の事実・竹内さんの言葉「1ヶ月」） */
export const HOLD_PERIOD_LABEL = "1ヶ月";
/** 連絡の日が今日からこの日数より先の時だけ「入居の時期が先」とする（それより近ければ今から探す） */
export function farMoveInMinDays(): number {
  const n = Number(process.env.FAR_MOVE_IN_MIN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
/** NFKC＋漢数字の月（「八月」→「8月」） */
export function normalizeDateText(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").replace(/(十[一二]|[一二三四五六七八九十])月/g, (_, k: string) => `${KANJI_NUM[k]}月`).replace(/[〜～~]/g, "〜")
    // 月の幅「9〜11月」→「9月〜11月」（始まりの月を読めるように。日の幅「27〜30日」は触らない）
    .replace(/(?<![\d\/])(\d{1,2})\s*(?:〜|-|から)\s*(\d{1,2})\s*月/g, "$1月〜$2月");
}

// 日付の言い方（年・月・日・旬）。順番が大事（年つき → 月日 → M/D → 月＋旬 → 月だけ → 日だけ）
const DATE_SRC = "(?:(来年|再来年)の?)?(?:(\\d{4})\\s*[年/]\\s*)?(\\d{1,2})\\s*月\\s*(?:(\\d{1,2})\\s*日?(?!\\d)|の?(上旬|初旬|頭|初め|はじめ|前半|中旬|半ば|中頃|中ごろ|下旬|後半|末))?|(?:(\\d{4})\\s*\\/\\s*)?(\\d{1,2})\\/(\\d{1,2})(?!\\d)";
const DATE_RE_G = () => new RegExp(DATE_SRC, "g");

function partDay(y: number, m: number, part: string | undefined): number {
  const p = part ?? "";
  if (/上旬|初旬|頭|初め|はじめ|前半/.test(p)) return 1;
  if (/中旬|半ば|中頃|中ごろ/.test(p)) return 11;
  if (/後半/.test(p)) return 16;
  if (/下旬/.test(p)) return 21;
  if (/末/.test(p)) return lastDay(y, m);
  return 1;
}

/** 1つの日付の言い方 → その始まりの日（年が無い時は言った日より前の月なら来年）。読めなければ null */
function resolveMatch(mm: RegExpMatchArray, said: Ymd): { ymd: Ymd; monthOnly: boolean } | null {
  let y: number | null = null; let m: number; let d: number | null = null; let part: string | undefined;
  if (mm[3]) {
    m = Number(mm[3]);
    if (mm[2]) y = Number(mm[2]);
    if (mm[4]) d = Number(mm[4]);
    part = mm[5];
    if (!y && mm[1]) y = said.y + (mm[1] === "再来年" ? 2 : 1);
  } else if (mm[7] && mm[8]) {
    m = Number(mm[7]); d = Number(mm[8]);
    if (mm[6]) y = Number(mm[6]);
  } else return null;
  if (!(m >= 1 && m <= 12)) return null;
  if (y == null) y = m < said.m ? said.y + 1 : said.y;
  if (y < said.y || y > said.y + 3) return null;
  const day = d != null ? d : partDay(y, m, part);
  if (!(day >= 1 && day <= lastDay(y, m))) return null;
  return { ymd: { y, m, d: day }, monthOnly: d == null && !part };
}

/** 入居の始まりの1ヶ月半前（暦で1ヶ月戻して15日戻す。2/30 等は月末にそろえる） */
export function contactDateFor(moveIn: Ymd): Ymd {
  let y = moveIn.y, m = moveIn.m - 1;
  if (m < 1) { m = 12; y -= 1; }
  const d = Math.min(moveIn.d, lastDay(y, m));
  return fromUtc(utcOf({ y, m, d }) - 15 * DAY);
}

/** 「1月6日」。年は今日から300日より先の時だけ付ける（竹内さんの送信「7月1日」「2028年1月から」） */
export const mdLabel = (p: Ymd, base?: Ymd) => `${base && daysBetween(base, p) > 300 ? `${p.y}年` : ""}${p.m}月${p.d}日`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. お客様の入居・引越しの時期（お客様の発言・条件の入居時期から）
// ─────────────────────────────────────────────────────────────────────────────
const MOVE_WORD_RE = /入居|引っ?越|引越|転居|住み(?:始|替)/;
/** お部屋の入居可能日の質問・募集の話（お客様の入居の時期ではない） */
const PROPERTY_MOVE_Q_RE = /いつから(?:の)?入居|入居(?:可能|でき(?:ます|る)(?:の)?(?:でしょう)?か)|募集|退去予定|空き/;
const ASAP_RE = /すぐ|即|最短|至急|早め|早く|未定|いつでも|決まって(?:い)?ない/;

export type MoveInStart = { ymd: Ymd; evidence: string; label: string };

/** 入居時期の文（条件の move_in_time の値・お客様の1文）→ 始まりの日（幅は始まり・「9〜11月」は9月）。読めなければ null */
export function resolveMoveInStart(text: string | null | undefined, saidIso: string | number): MoveInStart | null {
  const t = normalizeDateText(text);
  if (!t.trim()) return null;
  const said = todayOf(saidIso);
  const mm = DATE_RE_G().exec(t);
  if (!mm || mm.index == null) return null;
  // 「すぐ・未定」が日付より前にあれば読まない（「すぐにでも、遅くとも3月」等は始まりが今）
  if (ASAP_RE.test(t.slice(0, mm.index))) return null;
  const r = resolveMatch(mm, said);
  if (!r) return null;
  const label = mm[0].replace(/\s+/g, "").replace(/^(来年|再来年)の?/, "$1").replace(/^(\d{4})\/(\d{1,2})月?/, "$1年$2月");
  return { ymd: r.ymd, evidence: t.trim().slice(0, 40), label };
}

/** お客様の発言（1通）から、入居・引越しの時期を言った所（無ければ null） */
export function moveInFromCustomerText(text: string | null | undefined, saidIso: string | number): MoveInStart | null {
  const t = normalizeDateText(text);
  if (!MOVE_WORD_RE.test(t)) return null;
  // 文（行・句点）ごと。入居の語のある文に日付が無ければ、すぐ次の行の日付（「引っ越そうと思ってます！\n8月20頃」）
  const parts = t.split(/[。\n！!？?]+/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!MOVE_WORD_RE.test(s) || PROPERTY_MOVE_Q_RE.test(s)) continue;
    const hit = resolveMoveInStart(s, saidIso) ?? (i + 1 < parts.length && !MOVE_WORD_RE.test(parts[i + 1]) ? resolveMoveInStart(parts[i + 1], saidIso) : null);
    if (hit) return hit;
  }
  return null;
}

export type FarMoveInPlan = {
  moveIn: Ymd; contact: Ymd; daysUntilContact: number;
  /** お客様の言い方（「2028年3月」「8月20」） */
  moveInLabel: string;
  /** 連絡の日（「7月5日」・年が今と違えば年つき） */
  contactLabel: string;
  source: "customer_text" | "condition";
  evidence: string;
};

/** 入居の始まりから、連絡の日（1ヶ月半前）が今日から minDays 以上先なら計画を返す */
export function farMoveInPlan(start: MoveInStart, nowIso: string | number, source: FarMoveInPlan["source"], minDays = farMoveInMinDays()): FarMoveInPlan | null {
  const today = todayOf(nowIso);
  const contact = contactDateFor(start.ymd);
  const days = daysBetween(today, contact);
  if (days < minDays) return null;
  return { moveIn: start.ymd, contact, daysUntilContact: days, moveInLabel: start.label, contactLabel: mdLabel(contact, today), source, evidence: start.evidence };
}

const CONDITION_FORM_RE = /【ご入居の時期】|ご希望のお部屋探しご条件|①/;
const PICKUP_ASK_RE = /(?:物件|お部屋|部屋)[^。\n]{0,10}(?:送って|探して|紹介|ピックアップ|ありますか|ありませんか)/;

/**
 * この番が「理想の流れを伝えて連絡の日を約束する返信」の番か（決定論）。
 *   ①今回のお客様の発言（連投）に入居・引越しの時期がある／条件のフォーム・物件の依頼の番で条件の入居時期が先
 *   ②連絡の日が今日から7日以上先
 *   ③こちらがまだ連絡の日を約束していない（直近のこちらの送信に未来の日付の連絡の約束が無い）
 */
export function farMoveInTurn(i: {
  customerTurn: ReadonlyArray<{ text: string | null | undefined; at: string }>;
  conditionMoveIn?: string | null;
  staffHistory: ReadonlyArray<{ text: string | null | undefined; at: string }>;
  nowIso: string;
}): FarMoveInPlan | null {
  if ((process.env.FAR_MOVE_IN_CONTACT ?? "").toLowerCase() === "off") return null;
  if (i.customerTurn.length === 0) return null;
  let plan: FarMoveInPlan | null = null;
  for (const m of [...i.customerTurn].reverse()) {
    const s = moveInFromCustomerText(m.text, m.at);
    if (s) { plan = farMoveInPlan(s, i.nowIso, "customer_text"); break; }
  }
  if (!plan && i.conditionMoveIn) {
    const asks = i.customerTurn.some((m) => CONDITION_FORM_RE.test(String(m.text ?? "")) || PICKUP_ASK_RE.test(normalizeDateText(m.text)));
    const s = asks ? resolveMoveInStart(i.conditionMoveIn, i.nowIso) : null;
    if (s) plan = farMoveInPlan(s, i.nowIso, "condition");
  }
  if (!plan) return null;
  const today = todayOf(i.nowIso);
  for (const s of i.staffHistory) {
    const p = parseContactPromise(s.text, s.at);
    if (p && daysBetween(today, p.contact) >= -1) return null;
  }
  return plan;
}

/** ブレインの返信の方向（generate-reply がこの番の下書きを書く方向） */
export function farMoveInDirection(p: FarMoveInPlan): string {
  return `入居の時期が先（${p.moveInLabel}）なので、お部屋を抑えられるのはお申込みから${HOLD_PERIOD_LABEL}のため${p.contactLabel}頃から本格的にお部屋探しを進めるのが理想の流れとお伝えし、${p.contactLabel}にご条件に合ったお部屋をピックアップしてお送りする（ご連絡する）約束をする（今は物件を送らない・AIX なし）`.slice(0, 200);
}

/** ブレインへの短い注記（材料） */
export function farMoveInBrainNote(p: FarMoveInPlan): string {
  return `【入居の時期が先（決定論）】入居の始まり ${p.moveIn.m}/${p.moveIn.d}（${p.source === "customer_text" ? "お客様の発言" : "条件の入居時期"}「${p.evidence}」）→ 連絡の日＝1ヶ月半前の ${p.contactLabel}（今日から${p.daysUntilContact}日後）。`
    + `お部屋を抑えられるのはお申込みから${HOLD_PERIOD_LABEL}なので、今は物件ピックアップ（AIX）の番ではなく、理想の流れ（${p.contactLabel}頃から探す）を伝えて連絡の日を約束する返信の番（スタッフだけが知る情報は無い）。`;
}

/** この番の本文の芯（竹内さんの実送信 06-07 きむら・06-14 あいの文の形・数字と日付だけ差し替え）。決定論 */
export function farMoveInCoreText(p: { contactLabel: string }, customerName?: string | null): string {
  const name = (customerName ?? "").trim();
  return [
    `お部屋を抑える事が出来るのが${HOLD_PERIOD_LABEL}となりますので、${p.contactLabel}頃から本格的にお部屋探しを進めて頂くのが理想の流れとなります！！`,
    `${p.contactLabel}に${name ? `${name}さん` : ""}のご条件に合ったお部屋をピックアップしお送りさせて頂きます😊！！`,
    "引き続き何卒よろしくお願い致します！！",
  ].join("\n");
}

export function farMoveInReplyLine(p: { contactLabel: string; moveInLabel: string }, customerName?: string | null): string {
  return `- 📅 入居の時期が先（${p.moveInLabel}）: この返信は「理想の流れを伝えて連絡の日を約束する」番（実際の竹内さんの LINE の型）。`
    + `本文の芯は次の3文をこの順にそのまま使う（日付・語を変えない・言い換えない）:\n「${farMoveInCoreText(p, customerName).replace(/\n/g, "／")}」\n`
    + `前に足してよいのはお客様の入居の時期の受け止め（「かしこまりました！！」「${p.moveInLabel}のご入居とのことで」等）だけ。`
    + `物件は送らない・ご条件を並べた「ピックアップさせて頂きます」「出来次第お送り」等の今の約束は書かない（約束は${p.contactLabel}の1つだけ）。抑えられる期間を「40日」「2ヶ月」等に言い換えない`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. こちらの送信の「連絡の日の約束」（カレンダーに置く）
// ─────────────────────────────────────────────────────────────────────────────
/** こちらがやる事の語（連絡・送付・ピックアップ・探しの開始/再開・再相談） */
const OUR_VERB_RE = /ご連絡(?:させて|致し|いたし|差し上げ|します)|お送り(?:させて|致し|いたし|します)|ピックアップ(?:し|して|させて|を?開始)|(?:お部屋)?探し(?:を)?(?:させて|開始させて|再開させて)|再相談|ご提案させて|サポート(?:を)?(?:開始|再開)させて/;
/** 約束でない形（お客様にお願い・条件つき・確認の約束＝別の仕組み） */
const NOT_PROMISE_RE = /お気軽にご連絡|ご連絡(?:ください|下さい|頂|いただ)|(?:頂|いただ)けましたら|(?<!入り)次第|ございましたら|ありましたら|(?:させて|て)(?:頂|いただ)きました|(?:致|いた)しました|オススメ(?:いたします|致します|です)/;
/** 日付の後ろ: 連絡の時期を言う形 */
const AFTER_OK_RE = /^[）)]?\s*(?:頃|ごろ|辺り|あたり)?\s*(?:に入りましたら|になりましたら|に入ってから|に入り次第|から|に(?!向))/;
/** 日付の後ろ: 入居・申込・内覧・退去の日（連絡の日ではない） */
const AFTER_NG_RE = /^[）)]?\s*(?:頃|ごろ)?\s*(?:の|に|まで|から|以降|中|・)*\s*(?:ご?入居|お?引っ?越|お?引越|お?申込|お?申し込|ご?内覧|ご?内見|退去|向け|まで|頃まで|迄)|^\s*から\s*\d{1,2}月[^。、]{0,8}?(?:頃|ごろ)?(?:に|の)?\s*ご?入居/;
/** 「15日頃にご連絡」（日だけ）の形 */
const DAY_ONLY_RE = /(?<![\d月\/])(\d{1,2})日(?:頃|ごろ)?に[^。\n]{0,20}ご連絡(?:させて|致し|いたし)/;

export type ContactPromise = {
  contact: Ymd; sentence: string;
  /** ピックアップ・送付の約束（pickup）か連絡だけ（contact） */
  kind: "pickup" | "contact";
  /** 送った文にある入居の時期（「11月」「9月27〜30日頃」）。無ければ null */
  moveInLabel: string | null;
};

/**
 * こちらの送信の文から「〇月〇日にご連絡・ピックアップしお送り」の約束を読む（決定論）。
 *   日付が読める時だけ・送った日から2日以上先の日だけ（明日・今日の約束は【必ず】の今の仕組み）。読めなければ null
 */
export function parseContactPromise(text: string | null | undefined, sentIso: string | number): ContactPromise | null {
  const t = normalizeDateText(text);
  if (!t.trim()) return null;
  const sent = todayOf(sentIso);
  const sentences = t.split(/[。！!？?]+|\n{2,}/).map((s) => s.replace(/\s*\n\s*/g, "")).filter(Boolean);
  let moveInLabel: string | null = null;
  for (const s of sentences) {
    for (const mm of s.matchAll(DATE_RE_G())) {
      const after = s.slice((mm.index ?? 0) + mm[0].length);
      if (AFTER_NG_RE.test(after) && /入居|引っ?越|引越/.test(after.slice(0, 8))) { moveInLabel ??= mm[0].replace(/\s+/g, ""); }
    }
    const m2 = s.match(/(\d{1,2}月[^。、\n]{0,8}?)(?:頃|ごろ)?の?ご入居とのこと/);
    if (m2) moveInLabel ??= m2[1];
  }
  for (const s of sentences) {
    if (!OUR_VERB_RE.test(s) || NOT_PROMISE_RE.test(s)) continue;
    let found: Ymd | null = null;
    for (const mm of s.matchAll(DATE_RE_G())) {
      const after = s.slice((mm.index ?? 0) + mm[0].length);
      if (AFTER_NG_RE.test(after) || !AFTER_OK_RE.test(after)) continue;
      const r = resolveMatch(mm, sent);
      if (r) { found = r.ymd; break; }
    }
    if (!found) {
      const dm = s.match(DAY_ONLY_RE);
      if (dm) {
        const d = Number(dm[1]);
        const y = d >= sent.d ? sent.y : (sent.m === 12 ? sent.y + 1 : sent.y);
        const m = d >= sent.d ? sent.m : (sent.m === 12 ? 1 : sent.m + 1);
        if (d >= 1 && d <= lastDay(y, m)) found = { y, m, d };
      }
    }
    if (!found || daysBetween(sent, found) < 2) continue;
    const kind = /ピックアップ|お送り|探し|ご提案/.test(s) ? "pickup" : "contact";
    return { contact: found, sentence: s.trim().slice(0, 120), kind, moveInLabel };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. カレンダーの行（【必ず】の約束と同じ仕組み・連絡の日の印【連絡日 YYYY-MM-DD】）
// ─────────────────────────────────────────────────────────────────────────────
/** 連絡の日の印（notes の1行目の末尾）。この日より前は待ちの約束（promise-timing.isWaitPromiseNotes）・当日からは今日の約束 */
export const CONTACT_DATE_MARK_RE = /【連絡日 (\d{4}-\d{2}-\d{2})】/;
export const contactDateMark = (p: Ymd) => `【連絡日 ${ymdStr(p)}】`;
/** 連絡の日の行の event_type（会話の画面の【必ず】から AIX【物件ピックアップした】を開く＝promise-calendar.promiseAixActionOf） */
export const CONTACT_EVENT_TYPE = "property_send";
const CONTACT_HOUR_JST = 10;

export function isContactPromiseNotes(notes: string | null | undefined): boolean {
  return CONTACT_DATE_MARK_RE.test(((notes ?? "").trimStart().split("\n")[0] ?? ""));
}
/** notes の連絡の日（YYYY-MM-DD・無ければ null） */
export function contactDateOfNotes(notes: string | null | undefined): string | null {
  const m = ((notes ?? "").trimStart().split("\n")[0] ?? "").match(CONTACT_DATE_MARK_RE);
  return m ? m[1] : null;
}

export type ContactEventRow = {
  title: string; event_type: string; customer_name: string | null; conversation_id: string;
  start_at: string; all_day: boolean; notes: string;
};

/** 約束 → カレンダーの行（title「〇〇さんに連絡（入居11月）」・連絡の日の 10:00 JST・【必ず】の約束の形） */
export function contactEventRow(p: ContactPromise, o: { customerName: string | null | undefined; conversationId: string; sentAt: string; moveInLabel?: string | null }): ContactEventRow {
  const name = (o.customerName ?? "").trim();
  const mv = (p.moveInLabel ?? o.moveInLabel ?? "").trim().slice(0, 16);
  const label = `${name ? `${name}さんに` : ""}連絡${mv ? `（入居${mv}）` : ""}`;
  const sp = jstParts(o.sentAt);
  const startAt = new Date(utcOf(p.contact) + CONTACT_HOUR_JST * 3600_000 - JST_OFFSET_MS).toISOString();
  return {
    title: label, event_type: CONTACT_EVENT_TYPE, customer_name: name || null, conversation_id: o.conversationId,
    start_at: startAt, all_day: true,
    notes: [
      `【必ず】${label}${contactDateMark(p.contact)}`,
      `約束: 「${p.sentence}」`,
      `AIX: 【物件ピックアップした】を送ったら完了（${p.contact.m}/${p.contact.d} にご連絡）`,
      `（${sp.m}/${sp.d} ${pad2(sp.hour)}:${pad2(sp.minute)} の送信から）`,
    ].join("\n"),
  };
}

export type OpenContactRow = { id: number; notes: string | null; is_done?: boolean | null };

/**
 * 送信1通での連絡の日の行の出し入れ（決定論）。
 *   閉じる: 物件・御見積書を送った（いつでも）／連絡の日の前日以降にこちらが送った（連絡した）／新しい日付の約束で置き換えた
 *   入れる: 送った文に連絡の日の約束があり、同じ日の未完了の行が無い時
 */
export function planContactPromiseSync(i: {
  open: ReadonlyArray<OpenContactRow>;
  promise: ContactPromise | null;
  sentAt: string;
  /** この送信で物件・御見積書を送った */
  delivered: boolean;
}): { closeIds: number[]; insert: boolean } {
  const open = i.open.filter((r) => !r.is_done && isContactPromiseNotes(r.notes));
  const sentDay = todayOf(i.sentAt);
  const closeIds = new Set<number>();
  const newDate = i.promise ? ymdStr(i.promise.contact) : null;
  for (const r of open) {
    const d = contactDateOfNotes(r.notes);
    if (!d) continue;
    if (newDate && d === newDate) continue; // 同じ約束の言い直し
    if (i.delivered || newDate) { closeIds.add(r.id); continue; }
    const [y, m, dd] = d.split("-").map(Number);
    if (daysBetween(sentDay, { y, m, d: dd }) <= 1) closeIds.add(r.id);
  }
  const insert = !!i.promise && !open.some((r) => contactDateOfNotes(r.notes) === newDate);
  return { closeIds: [...closeIds], insert };
}

/** 連絡の日が来ている（今日以前）未完了の行か。ターゲット一覧・要対応に「連絡の約束の日」として戻す */
export function contactDue(notes: string | null | undefined, nowMs: number): boolean {
  const d = contactDateOfNotes(notes);
  if (!d) return false;
  return d <= new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}
