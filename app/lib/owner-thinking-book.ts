// app/lib/owner-thinking-book.ts — 「竹内さんの考え方の本」（純関数・DB/LLM なし・作業員9・11/11）
//
// 竹内さんの決定（KB cc284695・60931c54・11/11）: 統括（入口の読み・重点）とブレインに、竹内さんの今までの細かい指摘・決定を
//   「なぜ」ごと場面で引いて渡す。1枚＝決まり（何をするか）＋なぜ＋しない（逆向きの例）。160字で切らず理由が残る長さで。
// 10/23 の失敗（brain-priority.priorityKbP1On の注・q047・q106）から決めた3つの線:
//   ① 関係の無い行を入れない: 場面の札だけ・語の点だけで引かない。今の番の状況の文との近さ（埋め込み）に下限を置く
//      （場面の札が無い行はもっと高い下限）。語の点は関係する行としない行が同じ点だった（34問で測った）
//   ② 理由を切らない: 1枚ごとに決まり・なぜ・しないを別々に切り詰める（頭の160字だけだと「AIX で送る物」の一覧だけが残った）
//   ③ 決め打ちにしない: 「当てはまる時だけ参考にする材料・状況が違えば使わない」と見出しに書く（P0 9eb6aa9c 判断はブレイン基準）
// 答えの漏れ: 今の番のお客様の文と長く重なる行（その番そのものが例として本文に入っている行）は外す（leakOverlap）。
import { rowInScene, type KbScene, KB_SCENES } from "./design-knowledge-rag";

export type BookRow = { id: string; title: string; insight: string | null; rationale: string | null; tags: string[] | null; priority: number | null; created_at: string; embedding?: number[] | null };
export type BookCard = { id8: string; rule: string; why: string; dont: string; sim: number; inScene: boolean };

/** 本に入れない札（仕組み・開発・試験・費用の行＝番の判断の材料にならない） */
const NOT_TURN_TAGS = new Set(["試験", "監査", "API費用", "費用", "画面", "cron", "DB", "RLS", "セキュリティ", "デプロイ", "管理ツール", "やることリスト", "改善のサイクル", "弱い所", "鮮度", "点検表", "静かに壊れる", "Chrome拡張", "拡張", "物件検索", "個人情報", "プロンプトキャッシュ", "作業員", "開発チーム", "AIXLINX", "グループ"]);
const NOT_TURN_TITLE = /(試験|作業員|費用を|キャッシュ|cron|監査|画面|設計知見|開発|チーム|週の整理|鍵|デプロイ|拡張|やることリスト|統括の強化|統括は|統括に|統括の|ブレインの統括|測る|物差し|異常|知らせ|YUMA|束ね|純関数|決定論|スイッチ|既定|道の直し|手打ちの型|を作る|作る」|欄|ボタンを|新ピッカー|ピッカーを|表示|入れてよい|直しを入れる|記録|学習|データベース|DB)/;
const TURN_WORDS = /(お客様|返信|AIX|内覧|申込|見積|物件|初期費用|審査|約束|ピッカー|文)/;

/** 本の候補か（P0 は別の枠で渡るので外す・仕組みの行は外す） */
export function isBookCandidate(r: BookRow): boolean {
  if ((r.priority ?? 2) === 0) return false;
  const t = r.tags ?? [];
  const scened = t.some((x) => x.startsWith("場面:"));
  if (!scened && t.some((x) => NOT_TURN_TAGS.has(x))) return false;
  if (NOT_TURN_TITLE.test(r.title)) return false;
  return TURN_WORDS.test(`${r.title}${r.insight ?? ""}`);
}

const squash = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** 題の頭の「竹内さんの決定（11/05・No.40）:」「【決定】」等を外す */
export function ruleOf(title: string): string {
  return squash(title).replace(/^【[^】]{1,12}】\s*/, "").replace(/^竹内さんの(?:決定|答え|承認|指示|訂正)(?:（[^）]{0,30}）)?\s*[:：]\s*/, "").trim();
}
const sentences = (s: string) => squash(s).split(/(?<=[。．])|(?<=」)\s|\s(?=①|②|③)/).map((x) => x.trim()).filter(Boolean);
/** なぜ: 根拠の頭（無ければ本文の「ため・から・ので」の文） */
export function whyOf(r: Pick<BookRow, "insight" | "rationale">, n = 150): string {
  const ra = squash(r.rationale);
  if (ra) return cut(sentences(ra).slice(0, 2).join(""), n);
  const s = sentences(r.insight ?? "").find((x) => /(ため|から|ので|なぜ|理由)/.test(x) && !/^竹内さん ?\d/.test(x));
  return s ? cut(s, n) : "";
}
const NEG = /(しない|入れない|言わない|ではない|使わない|書かない|返さない|付けない|並べない|挟まない|重ねない|戻らない|丸めない|外す|作らない|聞かない|出さない|送らない|切らない|決め打ちにしない)/;
/** しない（逆向きの例）: 題か本文の「〜しない」を含む句 */
export function dontOf(r: Pick<BookRow, "title" | "insight">, n = 110): string {
  // 引用の切れ端・数えの文（「」・数字の割合）は逆向きの例にしない。題の句を先に、無ければ本文の文
  const ok = (x: string) => NEG.test(x) && x.length >= 6 && x.length <= 160 && !/[「」]/.test(x) && !/\d+\/\d+|%|\d+件|\d+回/.test(x);
  const fromTitle = ruleOf(r.title).split(/\s?[—／]\s?/).map((x) => x.trim()).find(ok);
  const hit = fromTitle ?? sentences(r.insight ?? "").map((x) => x.trim()).find(ok);
  return hit ? cut(hit, n) : "";
}

export const toUnit = (v: ReadonlyArray<number>): number[] => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
/** 今の番の文と行の本文の長い重なり（その番が例として本文に入っている＝答えの漏れ） */
export function leakOverlap(rowText: string, turnText: string, win = 14): boolean {
  const a = squash(rowText).replace(/[\s　]/g, ""), b = squash(turnText).replace(/[\s　]/g, "");
  if (b.length < win) return false;
  for (let i = 0; i + win <= b.length; i += 3) if (a.includes(b.slice(i, i + win))) return true;
  return false;
}

export const CROSS_SCENE_TAGS = new Set(["場面:物件を送る", "場面:その他"]);
export type PickOpts = { scene: string | null; turnEmb: ReadonlyArray<number>; turnText: string; max?: number; minSim?: number; minSimNoScene?: number; maxChars?: number; before?: string | null };
export const BOOK_MAX = 3;
// 下限は 11/11 の解き直し 198番の「お客様の文＋直前のこちら」の埋め込みで決めた（場面の札の行の近さ p90 0.527・札の無い行 p90 0.454）
export const BOOK_MIN_SIM = 0.52;
export const BOOK_MIN_SIM_NO_SCENE = 0.56;
export const SHORT_TURN = 20;
export const SHORT_EXTRA = 0.06;
export const BOOK_MAX_CHARS = 1100;

/** 引く（純）: 場面の札の行（＋場面の札の無い行は高い下限）から、近さの下限を越えた上位 max 枚。rows の embedding は単位にしておく */
export function pickBook(rows: ReadonlyArray<BookRow>, o: PickOpts): BookCard[] {
  const ks = (o.scene && o.scene in KB_SCENES && o.scene !== "other" ? o.scene : null) as KbScene | null;
  // 短い文（よろしく・ありがとう）は埋め込みが場面を選ばず近く出る（11/11 の見本: 了承の番に駅名の決まりが当たった）＝場面の札の無い行の下限を上げる
  const short = squash(o.turnText).length < SHORT_TURN;
  const minS = o.minSim ?? BOOK_MIN_SIM, minN = (o.minSimNoScene ?? BOOK_MIN_SIM_NO_SCENE) + (short ? SHORT_EXTRA : 0);
  const scored: Array<{ r: BookRow; sim: number; inScene: boolean }> = [];
  for (const r of rows) {
    if (!r.embedding || !isBookCandidate(r)) continue;
    if (o.before && r.created_at >= o.before) continue;
    const inScene = ks ? rowInScene(r, ks) : false;
    // 「場面:物件を送る」（こちらから物件を送る番・11/11 追加）は返信の場面に無い＝場面の札の無い行と同じ扱い（高い下限で横断）
    const scened = (r.tags ?? []).some((x) => x.startsWith("場面:") && !CROSS_SCENE_TAGS.has(x));
    if (scened && !inScene) continue; // 別の場面の札の行は入れない
    const sim = dot(o.turnEmb, r.embedding);
    if (sim < (inScene ? minS : minN)) continue;
    if (leakOverlap(`${r.title}${r.insight ?? ""}${r.rationale ?? ""}`, o.turnText)) continue;
    scored.push({ r, sim, inScene });
  }
  scored.sort((a, b) => b.sim + (b.inScene ? 0.03 : 0) - (a.sim + (a.inScene ? 0.03 : 0)));
  const out: BookCard[] = [];
  let chars = 0;
  for (const s of scored) {
    if (out.length >= (o.max ?? BOOK_MAX)) break;
    const c: BookCard = { id8: s.r.id.slice(0, 8), rule: cut(ruleOf(s.r.title), 150), why: whyOf(s.r), dont: dontOf(s.r), sim: Math.round(s.sim * 1000) / 1000, inScene: s.inScene };
    const len = c.rule.length + c.why.length + c.dont.length + 20;
    if (chars + len > (o.maxChars ?? BOOK_MAX_CHARS)) continue;
    chars += len; out.push(c);
  }
  return out;
}

/** 入口の統括・ブレインに渡す1塊（無ければ空） */
export function bookBlock(cards: ReadonlyArray<BookCard>): string {
  if (!cards.length) return "";
  const lines = cards.map((c, i) => `${i + 1}. 決まり: ${c.rule}${c.why ? `\n   なぜ: ${c.why}` : ""}${c.dont ? `\n   しない: ${c.dont}` : ""}`);
  return `【竹内さんの考え方（この場面に近い過去の指摘・決定。今の番に当てはまる時だけ参考にする・状況が違えば使わない）】\n${lines.join("\n")}`;
}
