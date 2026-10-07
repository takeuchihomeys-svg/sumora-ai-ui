// app/lib/text-diff-types.ts — 返信の下書きとスタッフの実送信の「文の細かい差」を型に分ける（純関数・LLM なし）
//
// なぜ（2026-10-07 7巡目・竹内「文のところちゃんと YUMA でテスト回して 徹底的に…細かい部分も」）:
//   これまでの採点（似ている度・行為の不足）は「どれだけ違うか」は出るが「どこが違うか」が出ない。
//   直す場所（手本・指示・出口）は型ごとに違うので、差を型に分けて数え、型ごとに出所を追う。
//   使う所: scripts/audit-r7-text-diff.ts（実送信の下書き×スタッフ）・scripts/yuma-r7-replay.ts（再生の採点）
//
// 型（1組に複数付く）:
//   表面: opener（1行目の型）／greeting（お世話になっております）／name_call（〇〇さんの呼びかけ）／ack_word（受けの語）
//         newline（改行・空行）／exclaim（！の数）／emoji（絵文字の種類・数）／kana_kanji（頂き/いただき 等の表記）／ending（最後の文の語尾）
//   中身: added（スタッフだけの文）／removed（AI だけの文）／paraphrase（同じ位置の文の言い換え）／order（順番）
//         number（数字）／length（長さが3割以上違う）
export const DIFF_TYPES = [
  "opener", "greeting", "name_call", "ack_word", "newline", "exclaim", "emoji", "kana_kanji", "ending",
  "added", "removed", "paraphrase", "order", "number", "length",
] as const;
export type DiffType = (typeof DIFF_TYPES)[number];
export const DIFF_TYPE_JA: Record<DiffType, string> = {
  opener: "冒頭の型", greeting: "お世話になっております", name_call: "名前の呼びかけ", ack_word: "受けの語",
  newline: "改行・空行", exclaim: "！の数", emoji: "絵文字", kana_kanji: "頂き/いただき等の表記", ending: "語尾",
  added: "スタッフだけの文（足した）", removed: "AI だけの文（消した）", paraphrase: "言い換え", order: "順番",
  number: "数字", length: "長さ（3割以上）",
};

/**
 * スタッフだけが知る事の報告（③ AIX の番）か。返信の文の物差し（一致率・書き方の多数派）から外すのに使う。
 * 例: 確認の結果（募集中・募集終了・管理会社の返事）・見積の送付・新着／オススメ1件の送付・内覧の空き枠・申込の進み・撮影した写真
 * （CLAUDE.md 絶対的な考え方: スタッフだけが知る情報は AIX）
 */
export const STAFF_ONLY_REPORT_RE = /確認(?:させて|致し|いたし)?(?:頂|いただ)?きました(?:ところ|が|！|!)|ましたところ|募集(?:中|終了|に出て(?:い|お)|が出て|して(?:お|い))(?:と|で|の|となって|しており|ござい|です|でした|ません)|(?:お)?(?:御)?見積書?(?:を)?お送り(?:させて)?(?:頂|いただ)?きました|御見積書となります|お見積書同封|初期費用：|新着で[^\n]{0,30}募集に出|募集に出ました|こちらのお部屋(?:如何|いかが)でしょうか|特に(?:オススメ|おすすめ)出?来る|かなり(?:オススメ|おすすめ)出?来る|管理会社(?:に確認|に連絡|にご連絡|より|担当|に電話|にお電話|本日|営業時間外)|とのご(?:連絡|返答|回答)が|申込み?(?:完了|番手)|審査(?:通過|承認|結果|否決|の進捗)|内覧開始|退去予定|ご案内可能(?:です|となります)|撮影し(?:て)?お送り(?:させて)?(?:頂|いただ)?きました|本日(?:は)?(?:お時間|ご内覧お越し)(?:頂|いただ)き/;
export function isStaffOnlyReport(text: string | null | undefined): boolean { return STAFF_ONLY_REPORT_RE.test(String(text ?? "").normalize("NFKC")); }

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
export function emojisOf(t: string): string[] {
  return (t.match(/\p{Extended_Pictographic}/gu) ?? []);
}

/** 表記を1つに寄せる（kana_kanji の比べ・中身の比べの両方で使う） */
const KANA_PAIRS: Array<[RegExp, string, string]> = [
  [/頂/g, "いただ", "頂"], [/下さ(?=い|る)/g, "くださ", "下さ"], [/致(?=し|します)/g, "いた", "致"],
  [/出来(?=る|ます|次第|れ|ない|た)/g, "でき", "出来"], [/宜し/g, "よろし", "宜し"], [/御見積/g, "お見積", "御見積"],
  [/有難/g, "ありがと", "有難"], [/事(?=が|は|も|を|に)/g, "こと", "事"], [/頃/g, "ごろ", "頃"],
];
export function normalizeKana(t: string): string {
  let s = t.normalize("NFKC");
  for (const [re, to] of KANA_PAIRS) s = s.replace(re, to);
  return s;
}
/** 漢字の表記の選び方（頂/いただ 等）を数える。kana_kanji の差は「同じ語を違う表記で書いた」時だけ */
export function kanaStyleOf(t: string): Record<string, "kanji" | "kana" | "mixed"> {
  const out: Record<string, "kanji" | "kana" | "mixed"> = {};
  const checks: Array<[string, RegExp, RegExp]> = [
    ["頂", /頂(?:き|け|く|いて)/g, /いただ(?:き|け|く|いて)/g],
    ["下さい", /下さ(?:い|る)/g, /くださ(?:い|る)/g],
    ["致し", /致し/g, /いたし/g],
    ["出来", /出来(?:る|ます|次第|れ|ない|た)/g, /でき(?:る|ます|次第|れ|ない|た)/g],
    ["御見積", /御見積/g, /お見積/g],
  ];
  for (const [k, a, b] of checks) {
    const na = (t.match(a) ?? []).length, nb = (t.match(b) ?? []).length;
    if (na && nb) out[k] = "mixed"; else if (na) out[k] = "kanji"; else if (nb) out[k] = "kana";
  }
  return out;
}

/** 比べる芯（絵文字・記号・空白を外し表記を寄せる） */
export function coreOf(t: string): string {
  return normalizeKana(t).replace(EMOJI_RE, "").replace(/[\s！!？?。、,.・〜~ー…★☆♪]/g, "");
}
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
export function dice(a: string, b: string): number {
  if (!a && !b) return 1; if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return (2 * inter) / (na + nb);
}

/** 文に分ける（改行と 。！？ の後）。芯が空の物（絵文字だけ）は落とす */
export function sentencesOf(t: string): string[] {
  const out: string[] = [];
  for (const line of t.split(/\n/)) {
    const parts = line.split(/(?<=[。]|[！!？?]+(?:[\p{Extended_Pictographic}\u{FE0F}]*))(?=[^！!？?\p{Extended_Pictographic}\u{FE0F}\s])/u);
    for (const p of parts) if (coreOf(p)) out.push(p.trim());
  }
  return out;
}

export type OpenerKind = "hai" | "kashikomari" | "arigatou" | "osewa" | "name" | "apology" | "other";
export function openerKindOf(t: string): OpenerKind {
  const first = (t.trim().split(/\n/)[0] ?? "").normalize("NFKC");
  if (/^お世話になっております/.test(first)) return "osewa";
  if (/^[^\s、。！!]{1,14}(?:さん|様)[、,！!\s]*/.test(first) && !/^(?:お客様|皆様)/.test(first)) return "name";
  if (/^はい/.test(first)) return "hai";
  if (/^かしこまりました|^承知/.test(first)) return "kashikomari";
  if (/^(?:ご連絡)?(?:ありがとうございます|有難うございます)|^ご(?:返信|連絡|確認)(?:頂き|いただき)/.test(first)) return "arigatou";
  if (/^(?:大変)?(?:申し訳|失礼)/.test(first)) return "apology";
  return "other";
}
export const OPENER_JA: Record<OpenerKind, string> = { hai: "はい", kashikomari: "かしこまりました", arigatou: "ありがとうございます", osewa: "お世話になっております", name: "名前", apology: "お詫び", other: "その他" };

const GREETING_RE = /お世話になっております|お世話になります/;
const NAME_CALL_RE = /(?:^|\n)[^\s、。！!？?\n]{1,14}(?:さん|様)(?:[、,！!]|\n|$)/;
const ACK_WORDS: Array<[string, RegExp]> = [
  ["かしこまりました", /かしこまりました/], ["承知", /承知(?:いた|致)?しました/], ["はい", /(?:^|\n)はい/],
  ["ありがとうございます", /ありがとうございます|有難うございます/], ["了解", /了解/],
];
export function ackWordsOf(t: string): string[] { return ACK_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k); }

/** ！の数え方: 「！！」のまとまり・単独の「！」 */
export function exclaimOf(t: string): { double: number; single: number } {
  const s = t.normalize("NFKC").replace(/\?/g, "？");
  let double = 0, single = 0;
  for (const m of s.match(/!+/g) ?? []) { if (m.length >= 2) double++; else single++; }
  return { double, single };
}
export function newlineOf(t: string): { lines: number; blank: number } {
  const s = t.trim(); return { lines: s ? s.split(/\n/).length : 0, blank: (s.match(/\n[ \t　]*\n/g) ?? []).length };
}
function endingOf(t: string): string {
  const ss = sentencesOf(t); const last = ss[ss.length - 1] ?? "";
  return coreOf(last).slice(-6);
}
function numbersOf(t: string): string[] {
  return (t.normalize("NFKC").replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).sort();
}
const FORMULA_RE = /^(?:お世話になっております|はい|かしこまりました|承知(?:いた|致)?しました|(?:ご連絡)?ありがとうございます|[^\s、。！!]{1,14}(?:さん|様))$/;

export type SentAlign = { d: string; s: string; sim: number }[];
export type TextDiff = {
  same: boolean;              // 完全一致（前後の空白だけ違う物を含む）
  sameCore: boolean;          // 芯が同じ（表面だけ違う）
  sim: number;                // 全体の芯の Dice
  types: DiffType[];
  detail: {
    opener: [OpenerKind, OpenerKind];
    emoji: [string[], string[]];
    exclaim: [{ double: number; single: number }, { double: number; single: number }];
    newline: [{ lines: number; blank: number }, { lines: number; blank: number }];
    kana: Array<{ key: string; d: string; s: string }>;
    added: string[]; removed: string[]; paraphrase: SentAlign; numbers: [string[], string[]];
    len: [number, number];
  };
};

/** 下書き d とスタッフの実送信 s の差を型に分ける */
export function diffTexts(dRaw: string, sRaw: string): TextDiff {
  const d = String(dRaw ?? "").replace(/\r/g, "").trim(), s = String(sRaw ?? "").replace(/\r/g, "").trim();
  const types = new Set<DiffType>();
  const op: [OpenerKind, OpenerKind] = [openerKindOf(d), openerKindOf(s)];
  if (op[0] !== op[1]) types.add("opener");
  if (GREETING_RE.test(d) !== GREETING_RE.test(s)) types.add("greeting");
  if (NAME_CALL_RE.test(d) !== NAME_CALL_RE.test(s)) types.add("name_call");
  const aw = [ackWordsOf(d), ackWordsOf(s)];
  if (aw[0].join() !== aw[1].join()) types.add("ack_word");
  const nl: [ReturnType<typeof newlineOf>, ReturnType<typeof newlineOf>] = [newlineOf(d), newlineOf(s)];
  if (nl[0].lines !== nl[1].lines || nl[0].blank !== nl[1].blank) types.add("newline");
  const ex: [ReturnType<typeof exclaimOf>, ReturnType<typeof exclaimOf>] = [exclaimOf(d), exclaimOf(s)];
  if (ex[0].double !== ex[1].double || ex[0].single !== ex[1].single) types.add("exclaim");
  const em: [string[], string[]] = [emojisOf(d), emojisOf(s)];
  if (em[0].join() !== em[1].join()) types.add("emoji");
  const ka = kanaStyleOf(d), kb = kanaStyleOf(s); const kana: Array<{ key: string; d: string; s: string }> = [];
  for (const k of Object.keys(ka)) if (kb[k] && ka[k] !== kb[k]) kana.push({ key: k, d: ka[k], s: kb[k] });
  if (kana.length) types.add("kana_kanji");
  if (endingOf(d) !== endingOf(s)) types.add("ending");
  const nums: [string[], string[]] = [numbersOf(d), numbersOf(s)];
  if (nums[0].join() !== nums[1].join()) types.add("number");
  const cd = coreOf(d), cs = coreOf(s);
  if (Math.abs(cd.length - cs.length) > 0.3 * Math.max(cd.length, cs.length, 1)) types.add("length");

  // 文を並べて合わせる（貪欲・芯の Dice）。定型（はい・かしこまりました・お世話に・名前）は足した/消したに数えない
  const ds = sentencesOf(d), ss = sentencesOf(s);
  const used = new Set<number>(); const pairs: Array<{ di: number; si: number; sim: number }> = [];
  const cand: Array<{ di: number; si: number; sim: number }> = [];
  ds.forEach((x, di) => ss.forEach((y, si) => { const v = dice(coreOf(x), coreOf(y)); if (v >= 0.45) cand.push({ di, si, sim: v }); }));
  cand.sort((a, b) => b.sim - a.sim);
  const usedD = new Set<number>();
  for (const c of cand) { if (usedD.has(c.di) || used.has(c.si)) continue; usedD.add(c.di); used.add(c.si); pairs.push(c); }
  const isFormula = (x: string) => FORMULA_RE.test(coreOf(x));
  const removed = ds.filter((x, i) => !usedD.has(i) && !isFormula(x));
  const added = ss.filter((x, i) => !used.has(i) && !isFormula(x));
  const paraphrase = pairs.filter((p) => p.sim < 0.9).map((p) => ({ d: ds[p.di], s: ss[p.si], sim: Math.round(p.sim * 100) / 100 }));
  if (removed.length) types.add("removed");
  if (added.length) types.add("added");
  if (paraphrase.length) types.add("paraphrase");
  const ord = [...pairs].sort((a, b) => a.di - b.di).map((p) => p.si);
  if (ord.some((v, i) => i > 0 && v < ord[i - 1])) types.add("order");
  const same = d === s;
  return {
    same, sameCore: cd === cs, sim: Math.round(dice(cd, cs) * 100) / 100,
    types: same ? [] : DIFF_TYPES.filter((t) => types.has(t)),
    detail: { opener: op, emoji: em, exclaim: ex, newline: nl, kana, added, removed, paraphrase, numbers: nums, len: [cd.length, cs.length] },
  };
}
