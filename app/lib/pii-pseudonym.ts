// app/lib/pii-pseudonym.ts
// お客様の個人情報を「別の値に読み替えて」LLM に渡し、返ってきた文で元に戻す純関数（**可逆**）。
//
// ⚠ 既にある app/lib/pii-mask.ts（maskPII / maskForEmbedding）とは別物。使い分け:
//   ・pii-mask     … 戻さない。埋め込み（embedding）とブレインの分析用。値を「お客様」「[非表示]」に潰す
//   ・pii-pseudonym … 戻す。**お客様に送る文を作らせる**ため、文脈が壊れない普通の名前に読み替え、出口で実名に戻す
//
// 2026-09-19 竹内「マスキングする仕組みを作る、個人情報は渡さないようにする、しかし、
//   どこに何がいるか山田太郎 大阪市○○などにすれば何が必要か分かる」
//   「物件情報やお客さんが探している物件の条件はマスキング不要。
//    お客さんの本名や電話番号は絶対にマスキングするように」
//
// 【消さずに置き換える理由】
//   {{顧客名}} のような記号に潰すと文が不自然になり、質が落ちる。
//   「山田太郎さん」なら LLM から見て普通の会話なので、文脈も敬語も壊れない。
//   出口で機械的に戻せるよう、仮名は**一意**にする（同じ仮名が2つの実物を指すと戻せない）。
//
// 【線は全部、実データを数えてから引いた（2026-09-19）】
//   ・顧客名は 実送信8,391通中1,907通(22.7%)に出て、直後は「さん」が98.8%
//     → 「名前＋敬称」の形で置換する。1〜2文字の名前を裸で置換すると本文の別の場所
//       （「お住まい」の「み」等）に当たる＝実測で1文字名は12%が誤爆
//   ・電話番号は 携帯の形87種類のうち85種類が1会話だけ＝個人。
//     固定電話79種類は管理会社・物件の連絡先なので**置換しない**（置換すると案内が壊れる）
//   ・「住所：」127件は**ほぼ全部が物件の住所**（物件資料の書き起こし）。
//     → 置換するのは「現住所：」「登記住所：」だけ。竹内さん「物件情報はマスキング不要」
//
// 【置換は必ず2段階（印 → 仮名）】
//   実物を直接その場で仮名に差し替えると、後の置換が**仮名の中身に当たる**（実名「山田」が
//   仮名「山田太郎」の中に出るなど）。先に一意な印を置き、全部済んでから仮名に変える。
//
// 【使い方】
//   const m = createMasker({ conversationId, customerName, knownNames });
//   const safe = m.maskBlock(材料の塊);       // 何度呼んでも同じ実物は同じ仮名になる（1通の発言だけなら m.mask）
//   const 本文 = m.unmask(LLMの返答);
//   if (m.leftovers(本文).length > 0) → 戻し切れていないので**その下書きは使わない**（fail-closed）

import { isApplicationFormMessage } from "./application-form-detect";
import { isFilledSumoraForm } from "./condition-format";

export type MaskKind = "name" | "mobile" | "email" | "birthday" | "address" | "employer";
export type MaskEntry = { fake: string; real: string; kind: MaskKind };

// 2026-09-19 竹内「物件の情報やお客さんが探している物件の情報や要望物件検索のフォーマットは
//   ちゃんと全部のこして、お申込みに関係するお客さんの個人情報は渡らないようにする形」
//
// 申込フォームは**読み替えでは守れない**（氏名・フリガナ・生年月日・現住所・住居年数・
// 続柄・勤務先・年収・緊急連絡先・連帯保証人…と項目が多く、1つ取りこぼすと意味がない）。
// → 丸ごと落として「受け取った」という事実だけ残す。判定は既にある
//   application-form-detect.isApplicationFormMessage を使う（新しい線を引かない）。
/** 申込フォームの代わりに残す文字列 */
// 2026-09-22 竹内（みなみさん事例）「また申込ととってしまっている。言葉だけの上っ面で判断していないか」:
//   旧「[お申込み情報を受け取りました（個人情報のため非表示）]」は、こちらが受け取ったと述べる文そのもので、
//   LLM がそのまま「お申込み情報のご連絡ありがとうございます」「お申込み情報受け取りました」と返していた。
//   誰が何をしたかだけを書く（お客様が記入して送った）
export const APPLICATION_FORM_PLACEHOLDER = "[お客様が申込フォームに記入して送信（個人情報のため非表示）]";

// 2026-09-19: 「申込フォーム」の語だけでは落とさない（普通の返信15件が落ちていた）。
// 2026-09-22: 材料の塊（maskBlock）では、会話の発言1通ずつに当て、さらに「項目に値が書かれた行が2行以上」の時だけ置き換える（filledFormLineCount）

/**
 * この文は「丸ごと落とす申込の個人情報」か。
 * ⚠ 物件検索のフォーマット（うちが送る条件テンプレート）は**必ず残す**ので先に見る。
 *   竹内「物件検索のフォーマットはちゃんと全部のこして、お申込みに関係する個人情報は渡らないように」
 */
const APPLY_FIELD_RE = /氏名|フリガナ|生年月日|現住所|緊急連絡先|勤務先|続柄|住居年数|保証人|年収|職業|登記住所|代表者|本社所在地|資本金/g;

export function isApplicationPayload(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (isFilledSumoraForm(t)) return false;              // 物件検索のフォーマットは落とさない
  if (!isApplicationFormMessage(t).detected) return false;
  // 語だけで中身が無い文（「申込フォームお送りします」）は落とさない
  return new Set(t.match(APPLY_FIELD_RE) ?? []).size >= 2;
}

/** こちらが送った申込フォーマット（記入欄）の代わりに残す文字列 */
export const APPLICATION_FORMAT_SENT_PLACEHOLDER = "[こちらが申込フォーマット（記入欄）を送付]";

/**
 * 値が書かれた申込の項目の行（「・氏名、フリガナ 中村七海 ヤマナカアオイ」「勤務先：株式会社〇〇」）。
 * 項目名を1行に並べただけの文（ルール・手本の「氏名・生年月日・現住所・緊急連絡先・勤務先…」）は数えない
 */
function filledFormLineCount(seg: string): number {
  let n = 0;
  for (const line of seg.split("\n")) {
    const labels = line.match(APPLY_FIELD_RE) ?? [];
    if (labels.length === 0 || labels.length >= 3) continue;            // 項目名の並び（ルールの文）は数えない
    const rest = line.replace(APPLY_FIELD_RE, "").replace(/^[\s・\-－ー•●◆■]+/, "").replace(/^[、,・\s：:（）()]+/, "").trim();
    if (rest.length >= 2 && !/^(?:の|を|は|が|と|や|に)/.test(rest)) n++;
  }
  return n;
}

/** 塊を1通ずつに分ける境目（会話履歴の「お客様: / スモラ:」・見出し「【」・空行） */
const SEG_HEAD_RE = /^(?:お客様|スモラ|顧客|スタッフ|\[(?:顧客|スタッフ|AIX)[^\]]*\])\s*[:：]?/;

/**
 * 材料の塊の中の申込フォームの記入だけを置き換える（塊そのものは落とさない）。
 * 2026-09-22 みなみさん事例: 塊に丸ごとの判定を当てると、ルールや手本の文に項目名が並んでいるだけで
 *   塊全体が「[お申込み情報を受け取りました]」の1行に差し替わり、LLM に会話もブレインの判断も届いていなかった。
 */
function dropApplicationSegments(block: string): { text: string; dropped: number } {
  const lines = block.split("\n");
  const segs: string[][] = [];
  for (const line of lines) {
    if (segs.length === 0 || SEG_HEAD_RE.test(line) || /^【/.test(line) || !line.trim()) segs.push([line]);
    else segs[segs.length - 1].push(line);
  }
  let dropped = 0;
  const out = segs.map((seg) => {
    const text = seg.join("\n");
    // 置き換えるのは会話の発言（お客様: / スモラ:）とお客様の最新メッセージの欄だけ。
    //   手本・ナレッジ（「💡 類似ケース（申込に至った実例パターン）」277行など）は申込の流れを説明するので項目と値の形を含むが、
    //   置き換えると「お客様が申込フォームを送った」という偽の事実を渡すことになる（書き出した実物で確認）。
    //   そこに出る名前・電話・生年月日・住所・勤務先は下の読み替えで伏せる
    const isTurn = SEG_HEAD_RE.test(seg[0]) || /^【(?:参考[：:])?お客様の(?:最新|直近)メッセージ/.test(seg[0]);
    if (!isTurn || !isApplicationPayload(text) || filledFormLineCount(text) < 2) return text;
    dropped++;
    const head = seg[0].match(SEG_HEAD_RE)?.[0] ?? (seg[0].startsWith("【") ? seg[0] : "");
    const staff = /スモラ|スタッフ|AIX/.test(head);
    return `${head}${head ? " " : ""}${staff ? APPLICATION_FORMAT_SENT_PLACEHOLDER : APPLICATION_FORM_PLACEHOLDER}`;
  });
  return { text: dropped ? out.join("\n") : block, dropped };
}
export type MaskerOptions = {
  /** 仮名を決定論的に選ぶ種。同じ会話なら毎回同じ仮名になる（キャッシュが効く・ログで追える） */
  conversationId: string;
  /** この会話のお客様の呼び名（LINE の表示名） */
  customerName?: string | null;
  /** 事例（他のお客様の会話）に出てくる名前。正解集合を明示して照合する */
  knownNames?: ReadonlyArray<string>;
  /** 「裸の西暦が生年月日か」を決める基準の年（既定は今年）。テストを固定するために外から渡せる */
  thisYear?: number;
};

/** 仮名の候補。実在しそうで、かつ会話に紛れ込まない普通の名前 */
const FAKE_NAMES = [
  "山田太郎", "佐藤花子", "鈴木一郎", "高橋直美", "田中健太",
  "伊藤美咲", "渡辺大輔", "中村七海", "小林拓也", "加藤陽子",
  "吉田翔太", "山本結衣", "松本和也", "井上彩香", "木村涼介",
] as const;

/** 会話 ID から決定論的に開始位置を決める（毎回同じ仮名になる） */
function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const RE_MOBILE = /0[789]0[-ー－\s]?\d{4}[-ー－\s]?\d{4}/g;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 生年月日は3つの形でしか拾わない。裸の「2026年11月26日」を拾うと
// **入居希望日・入社日まで伏せて条件が壊れる**（実データの監査で見つけた誤爆）。
/** ①「生年月日」ラベルの直後 */
const RE_BIRTHDAY_LABELED = /(生年月日|生年月)(\s*[:：]?\s*)((?:昭和|平成|令和|西暦)?\s*\d{1,4}\s*年[^\n年]{0,12}?\d{1,2}\s*月\s*\d{1,2}\s*日生?)/g;
/** ②「◯年◯月◯日生」＝末尾が「生」（免許証・申込フォームの形） */
const RE_BIRTHDAY_SUFFIX = /(?:昭和|平成|令和|西暦)?\s*\d{1,4}\s*年[^\n年]{0,12}?\d{1,2}\s*月\s*\d{1,2}\s*日生/g;
/** ③ 昭和・平成の元号つき（令和は入れない。入居日・交付日に当たるため） */
const RE_BIRTHDAY_ERA = /(?:昭和|平成)\s*\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g;
/** ④ 裸の西暦は「十分に昔」の時だけ生年月日とみなす（入居希望日・入社日は今年前後なので当たらない） */
const RE_BIRTHDAY_BARE = /(\d{4})\s*年[^\n年]{0,12}?\d{1,2}\s*月\s*\d{1,2}\s*日/g;
/** 生年月日とみなす西暦の上限（この年数より前なら生年月日。賃貸の契約者は成人なので十分に安全） */
const BIRTH_YEAR_MARGIN = 15;
/** お客様の住所だけ。「住所：」は物件の住所なので**対象にしない** */
const RE_HOME_ADDRESS = /(現住所|登記住所|旧住所|前住所)(\s*[:：]\s*)([^\n]{4,60})/g;
/** 勤務先・お勤め先はラベル付きのみ（会社名は形で見分けられないため） */
const RE_EMPLOYER = /(勤務先名|勤務先|お勤め先|勤め先|会社名|法人名)(\s*[:：]\s*)([^\n]{1,40})/g;
/** 住所のうち市区町村までは残す（「どこに住んでいるか」は返信に要る） */
const RE_CITY_PREFIX = /^(?:[^\n]{0,8}?[都道府県])?[^\n]{0,12}?[市区町村]/;
/** 敬称（実データで98.8%が「さん」） */
const HONORIFIC = "(?:さん|さま|様|サン)";

/** 置換の途中で使う印。通常の文には絶対に出ない制御文字で挟む */
const MARK_OPEN = "";
const MARK_CLOSE = "";
const RE_MARK = /(\d+)/g;

export type Masker = {
  /** 文の中の個人情報を仮名に置き換える（同じ実物は必ず同じ仮名）。**1通の発言**用: 申込フォームの記入は丸ごと置き換える */
  mask(text: string | null | undefined): string;
  /**
   * 材料の塊（会話履歴・手本・ルール・ブレインの判断がまとめて入った文字列）用。**塊を丸ごと置き換えない**。
   * 2026-09-22 みなみさん事例: 塊に mask を当てると、ルールや手本の文に項目名が並んでいるだけで塊全体が
   *   「[お申込み情報を受け取りました]」の1行に差し替わり、LLM に会話もブレインの判断も届いていなかった
   *   （DeepSeek の入力が会話を問わず同じ・動的部分32トークン）。申込の項目の値だけを伏せる
   */
  maskBlock(text: string | null | undefined): string;
  /** 仮名を実物に戻す */
  unmask(text: string | null | undefined): string;
  /** 戻し切れていない仮名（1つでもあれば、その文は使ってはいけない） */
  leftovers(text: string | null | undefined): string[];
  /** 置換表（監査用。ログにも DB にも残さないこと） */
  table(): MaskEntry[];
  /** 丸ごと落とした申込フォームの数（監査用。往復の対象外） */
  droppedCount(): number;
};

export function createMasker(opts: MaskerOptions): Masker {
  const entries: MaskEntry[] = [];
  const byReal = new Map<string, number>();   // kind\0real → entries の添字
  const counters: Record<MaskKind, number> = { name: 0, mobile: 0, email: 0, birthday: 0, address: 0, employer: 0 };
  const nameOffset = seedFrom(opts.conversationId || "x");

  /** 実物に印を割り当てる（初めて見た物には新しい仮名を用意する） */
  function markFor(real: string, kind: MaskKind, cityPrefix = ""): string {
    const key = `${kind} ${real}`;
    const hit = byReal.get(key);
    if (hit !== undefined) return `${MARK_OPEN}${hit}${MARK_CLOSE}`;
    const n = counters[kind]++;
    let fake: string;
    switch (kind) {
      case "name":     fake = FAKE_NAMES[(nameOffset + n) % FAKE_NAMES.length]; break;
      case "mobile":   fake = `090-0000-${String(n + 1).padStart(4, "0")}`; break;
      case "email":    fake = `sample${n + 1}@example.com`; break;
      case "birthday": fake = `1990年${(n % 12) + 1}月1日生`; break;
      // 市区町村までは残し、その先だけ伏せる（竹内「大阪市○○などにすれば何が必要か分かる」）
      case "address":  fake = `${cityPrefix}○○${n > 0 ? n : ""}`; break;
      case "employer": fake = `○○${n > 0 ? n : ""}（勤務先）`; break;
    }
    while (entries.some((e) => e.fake === fake)) fake += "・"; // 万一の衝突（候補が一周した等）
    const idx = entries.push({ fake, real, kind }) - 1;
    byReal.set(key, idx);
    return `${MARK_OPEN}${idx}${MARK_CLOSE}`;
  }

  /** この会話の呼び名＋事例に出る他のお客様の名前。長い順に当てる（短い名前が先に食わないように） */
  const names = [...new Set([opts.customerName ?? "", ...(opts.knownNames ?? [])]
    .map((s) => (s ?? "").trim()).filter((s) => s.length >= 1))]
    .sort((a, b) => b.length - a.length);

  let dropped = 0;

  function mask(input: string | null | undefined, block = false): string {
    let t = input ?? "";
    if (!t) return "";
    if (block) {
      // 塊は落とさない。塊の中の申込フォームの記入（1通ずつ）だけを置き換える
      const d = dropApplicationSegments(t);
      dropped += d.dropped;
      t = d.text;
    } else

    // ⓪ 申込に関わる個人情報は丸ごと落とす（読み替えでは項目が多すぎて守れない）。
    //    物件検索のフォーマットは isApplicationPayload の中で先に除外している。
    if (isApplicationPayload(t)) { dropped++; return APPLICATION_FORM_PLACEHOLDER; }

    // ① 名前。実データで98.8%が「◯◯さん」なので敬称つきを先に当てる。
    //    1〜2文字の名前は**敬称つきの時だけ**（裸で置換すると本文の別の場所に当たる。実測で1文字名は12%誤爆）
    for (const nm of names) {
      const esc = escapeRe(nm);
      t = t.replace(new RegExp(`${esc}(?=\\s*${HONORIFIC})`, "g"), () => markFor(nm, "name"));
      if (nm.length >= 3) t = t.replace(new RegExp(esc, "g"), () => markFor(nm, "name"));
    }
    // ② 携帯番号（固定電話は管理会社・物件の連絡先なので触らない）
    t = t.replace(RE_MOBILE, (m0) => markFor(m0, "mobile"));
    // ③ メールアドレス
    t = t.replace(RE_EMAIL, (m0) => markFor(m0, "email"));
    // ④ 生年月日（ラベル / 「〜日生」 / 元号 / 十分に昔の西暦 の4つの形だけ。
    //    裸の「2026年11月26日」を拾うと入居希望日・入社日まで伏せて条件が壊れる）
    const cutoffYear = (opts.thisYear ?? new Date().getFullYear()) - BIRTH_YEAR_MARGIN;
    t = t.replace(RE_BIRTHDAY_LABELED, (_m, label: string, sep: string, date: string) =>
      `${label}${sep}${markFor(date, "birthday")}`);
    t = t.replace(RE_BIRTHDAY_SUFFIX, (m0) => markFor(m0, "birthday"));
    t = t.replace(RE_BIRTHDAY_ERA, (m0) => markFor(m0, "birthday"));
    t = t.replace(RE_BIRTHDAY_BARE, (m0, y: string) =>
      Number(y) <= cutoffYear ? markFor(m0, "birthday") : m0);
    // ⑤ お客様の住所（ラベル付きのみ。「住所：」＝物件の住所は触らない）
    t = t.replace(RE_HOME_ADDRESS, (_m, label: string, sep: string, addr: string) => {
      const city = (addr.match(RE_CITY_PREFIX)?.[0] ?? "").trim();
      return `${label}${sep}${markFor(addr, "address", city)}`;
    });
    // ⑥ 勤務先（ラベル付きのみ）
    t = t.replace(RE_EMPLOYER, (_m, label: string, sep: string, name: string) =>
      `${label}${sep}${markFor(name, "employer")}`);

    // 印 → 仮名（ここまで実物は仮名に触れていないので、仮名の中身が再置換されることはない）
    return t.replace(RE_MARK, (_m, i: string) => entries[Number(i)]?.fake ?? "");
  }

  function unmask(input: string | null | undefined): string {
    let t = input ?? "";
    if (!t) return "";
    // 長い仮名から戻す（短い仮名が長い仮名の一部を食わないように）
    for (const e of [...entries].sort((a, b) => b.fake.length - a.fake.length)) {
      t = t.split(e.fake).join(e.real);
    }
    return t;
  }

  function leftovers(input: string | null | undefined): string[] {
    const t = input ?? "";
    if (!t) return [];
    const out: string[] = [];
    for (const e of entries) {
      if (t.includes(e.fake)) { out.push(e.fake); continue; }
      // LLM は「山田太郎さん」を「山田さん」と姓だけで書くことがある。戻せていないので拾う
      if (e.kind === "name" && e.fake.length >= 4) {
        const sei = e.fake.slice(0, 2);
        if (new RegExp(`${escapeRe(sei)}\\s*${HONORIFIC}`).test(t)) out.push(sei);
      }
    }
    return [...new Set(out)];
  }

  return { mask: (s) => mask(s), maskBlock: (s) => mask(s, true), unmask, leftovers, table: () => entries.slice(), droppedCount: () => dropped };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
