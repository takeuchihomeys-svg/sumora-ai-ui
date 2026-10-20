// scripts/lib/parts-eval.ts — パーツごとに測る試験（S0）の決まった計算（純関数・DB/LLM なし）
//
// 2026-10-18 竹内さん（設計知見 P0 c0884407）「安いモデルはモデルを作る研究者の発想で組む — パーツに分けて読み、つなぎと優先順位をブレインで強くして最後に生成する」
//   ＋「外れ方から癖を見つけ出し、その癖に特化して改善を繰り返す」
// 正解を4つの段で持つ:
//   ① 読む（依頼の一覧）… お客様の依頼・質問だけでなく、受け止める事（お礼・謝り・気遣い・不安・了承）も1つずつ
//   ② つなぐ（依頼ごとの道）… 返信／約束／AIX／触れない と、使う事実
//   ③ 優先 … 先に答える項目・言わない事
//   ④ 書く … 最後の文（竹内さんの実物）
// 答えの設計表の形は app/lib/turn-contract.ts の TurnContract（asks の route・answer・basis・aixKey・leadWith・mustNot）に合わせる。
// 足す欄（id・status・facts・priority・say・why）は設計の案＝まだ本番のコードに無いので、試験の側の型としてだけ持つ。
//
// 測り方（どこで落ちたか）: 正解の依頼1つずつに「最初に落ちた段」を付ける（前の段が正解だった物だけを次の段で数える＝前の段に正解を入れた時の近似）。
//   段: reader（読み手の取りこぼし）→ link（つなぎの抜け）→ priority（優先の外れ）→ writer（書く役の抜け）
//   種類（癖）: 質問の答えの抜け・受け止めの抜け・物件ごとの答えの抜け・約束の抜け・道の取り違え・AIXの種類の取り違え・言ってはいけない事・先に答える外れ・決まりが本質を上書き・触れない所に触れた
import type { AnswerRoute, ContractAsk, TurnContract } from "../../app/lib/turn-contract";
import { topicKey } from "../../app/lib/aix-catalog";

// ─── 正解の型 ────────────────────────────────────────────────────────
export type ReceiveKind = "thanks" | "apology" | "care" | "anxiety" | "agree";
export const RECEIVE_JA: Record<ReceiveKind, string> = { thanks: "お礼", apology: "謝り", care: "気遣い・共感", anxiety: "不安", agree: "了承" };
/** 正解の出どころ: spec＝今ある spec（竹内さんの実送信から作った正解）／machine＝機械の下書き（竹内さんの確認待ち） */
export type GoldStatus = "spec" | "machine";

/** ①〜③の正解の1行（TurnContract の ContractAsk に合わせ、足す欄を持つ） */
export type GoldAsk = {
  id: string;
  /** お客様の発言そのもの（伏せた物）。言い換えしか無い時は言い換え */
  quote: string;
  /** spec の言い換え（あれば。読めたかの照合にも使う） */
  label?: string | null;
  kind: ContractAsk["kind"];
  /** 受け止める事（お礼・謝り・気遣い・不安・了承）。依頼・質問なら null */
  receive: ReceiveKind | null;
  /** この依頼が指す物件（物件ごとの答え）。伏せた名前（号室の数字は伏せる） */
  properties: string[];
  route: AnswerRoute;
  /** 正解の道が2つの番（spec の routes） */
  routes: AnswerRoute[];
  answer: string | null;
  basis: ContractAsk["basis"];
  aixKey: string | null;
  // ── 足す欄（設計の案） ──
  status: GoldStatus;
  /** 使う事実（会話・資料・会社の事実のどれから何を） */
  facts: string[];
  /** 答える順（1＝先に答える）。触れない物は null */
  priority: number | null;
  /** 言う事（要点）。触れない物は null */
  say: string | null;
  why: string | null;
  /** spec の asks の何番目か（判定の結果と結ぶ）。機械で足した行は null */
  specIndex: number | null;
  // ── 20問で足した欄（2026-10-18 竹内さん「試験はまず20問・合格したら広げる」＋D案で新しく確かめる所） ──
  /** AIX の時の正解のボタン・ピッカー（aixKeyOfBrain の形＝aix-catalog の topicKey。例 "cost_breakdown"・"property_check_result/条件:mgmt_equipment"）。どれでも正解の時は複数 */
  pickers?: string[] | null;
  /** 主語・指す物の正解。one＝この物件だけ／all＝候補の全部にまとめて答える／confirm＝決め打ちせず確かめる（設計知見 311b379e「指す物が決まらない時は全部まとめて答える／確かめるが基本」） */
  referent?: { mode: "one" | "all" | "confirm"; targets: string[]; subject?: string | null } | null;
  /** 確かさ。low＝言い切らず確認の約束・スタッフへ（返信で言い切ったら「自信が低いのに言い切った」） */
  sure?: "high" | "low" | null;
};

export type GoldParts = {
  id: string;
  type: string;
  /** 道の正解（spec.accept）・道で言ってはいけない物（spec.mustNot） */
  accept: string[];
  mustNotPath: string[];
  asks: GoldAsk[];
  /** ③ 先に答える項目（GoldAsk.id）と、言ってはいけない事（spec.ng） */
  leadWith: string | null;
  mustNot: string[];
  closeOnly: boolean;
  /** ④ 最後の文（竹内さんの実送信・伏せた物） */
  finalText: string;
  /** 竹内さんの確認待ちの印（空＝確認待ち無し） */
  pending: string[];
  /** 参考（flash の指摘など・確認待ちには数えない） */
  notes?: string[];
  /** 竹内さんに「はい／いいえ」で確かめて頂く問い（gold-20.extra.json の confirm） */
  confirm?: GoldConfirm[];
  /** 原則がぶつかる番: 竹内さんの実物がどちらの原則を優先したか（docs/basic-principles-draft.md の番号 0〜35） */
  principles?: PrincipleConflict[];
  /**
   * 良い答えの幅（2026-10-18 竹内さん「1問に竹内さんの OK を複数持たせる」）。今は空でよい（まず旧の基準＝正解1通で D案の段ごとの近づきを測ってから足す）。
   * 物差しを「幅あり」（--rubric=wide|both）にした時だけ効く: code は道の正解に足し、text は④の近さの比べ先に足す。
   */
  goodAnswers?: GoodAnswer[];
  /**
   * 判定の見直しの印（竹内さん「割れた・外れた判定を竹内さんか強いモデルで見直す」）。今は空でよい。
   * 「幅あり」の物差しの時だけ、結果の判定（道・依頼・言ってはいけない事・下書き）をこの印で置き換える。
   */
  judgeReviews?: JudgeReview[];
};
/** 竹内さんが OK した別の答え（道の符号と文。どちらかだけでもよい） */
export type GoodAnswer = { id: string; code?: string | null; text?: string | null; by: "竹内さん" | "強いモデル" | "機械"; status?: GoldStatus; note?: string | null };
/** 判定の見直し: どの結果（label・回。null＝どの回にも）のどの判定を、誰がどう見直したか */
export type JudgeReview = {
  label?: string | null; rep?: number | null;
  /** path＝最終の道／essence＝本質の道／ask:<番号>＝spec の依頼／ng:<番号>＝言ってはいけない事／draft＝下書きの道／draft_ask:<番号>／draft_ng:<番号> */
  item: string;
  /** 見直した後の判定（ask・path・draft は true＝合格、ng は true＝破った） */
  verdict: boolean;
  by: "竹内さん" | "強いモデル";
  note?: string | null;
};
/** 物差し: old＝今の正解1通・今の判定／wide＝良い答えの幅と判定の見直しを入れる */
export type Rubric = "old" | "wide";
/** 「幅あり」の物差しで、正解と結果の行を広げる（old なら何もしない）。純関数・元は変えない */
export function applyRubric(g: GoldParts, r: ResultRow, rubric: Rubric): { g: GoldParts; r: ResultRow } {
  if (rubric === "old") return { g, r };
  const extraCodes = (g.goodAnswers ?? []).map((x) => String(x.code ?? "").trim()).filter(Boolean);
  const g2: GoldParts = { ...g, accept: [...new Set([...g.accept, ...extraCodes])] };
  const r2: ResultRow = JSON.parse(JSON.stringify(r)) as ResultRow;
  const hitCode = (code: string | undefined) => !!code && extraCodes.some((c) => signMatches(c, code));
  if (r2.path && r2.path.ok === false && hitCode(r2.path.code)) r2.path.ok = true;
  if (r2.essence && r2.essence.ok === false && hitCode(r2.essence.code)) r2.essence.ok = true;
  if (r2.draft && r2.draft.ok === false && hitCode(r2.draft.code)) r2.draft.ok = true;
  for (const v of g.judgeReviews ?? []) {
    if (v.label && v.label !== r.label) continue;
    if (v.rep != null && v.rep !== r.rep) continue;
    const [kind, idxS] = v.item.split(":"); const i = Number(idxS);
    if (kind === "path" && r2.path) r2.path.ok = v.verdict;
    else if (kind === "essence" && r2.essence) r2.essence.ok = v.verdict;
    else if (kind === "ask" && r2.asks?.[i]) { r2.asks[i].covered = v.verdict; r2.asks[i].route = v.verdict; }
    else if (kind === "ng" && r2.ng?.[i]) r2.ng[i].violated = v.verdict;
    else if (kind === "draft" && r2.draft) r2.draft.ok = v.verdict;
    else if (kind === "draft_ask" && r2.draft?.asks && i < r2.draft.asks.length) r2.draft.asks[i] = v.verdict;
    else if (kind === "draft_ng" && r2.draft?.ng && i < r2.draft.ng.length) r2.draft.ng[i] = v.verdict;
  }
  return { g: g2, r: r2 };
}
/** ④の近さ: 竹内さんの実物と良い答えの文のうち一番近い物（幅ありの物差し） */
export function bestFinalSim(g: GoldParts, draftText: string): number {
  const texts = [g.finalText, ...(g.goodAnswers ?? []).map((x) => String(x.text ?? "")).filter(Boolean)];
  return Math.max(...texts.map((t) => round2(dice(maskGoldText(t), maskGoldText(draftText)))));
}
/**
 * 2026-10-18 竹内さん「テストしたら何が優先なのか着目したら分かる」: 原則のぶつかりを正解に持ち、ブレインがどちらを優先したかを数える。
 *   優先順位は固定の規則にせず「基準＋ブレインの状況判断」で、試験で最善を確かめる（問題が増えるほど実際の並びが見える）。
 *   signs＝その原則を優先した時に出る道の符号（brain-exam の道の符号: "返信"・"2段"・"2段:check"・"AIX:cost_breakdown"・"AIX:物件" 等）。
 *   ブレインが原則の番号を自分で書く様になったら（設計書 7-7 の parts.asks[].principle）それを先に読む。
 */
export type PrincipleConflict = { id: string; pair: [number, number]; winner: number; why: string; signs: Record<string, string[]>; status?: GoldStatus };
/** 原則の短い名前（docs/basic-principles-draft.md の見出しを縮めた物・表の見出し用） */
export const PRINCIPLE_JA: Record<number, string> = {
  0: "AIXと連携の3択", 1: "嘘・推測で書かない", 2: "会社の答えは言い切る", 3: "安心の言い切りを足さない", 4: "スタッフしか知らない事はAIX", 5: "物件ごとに違う事は確認の約束",
  6: "一つ一つに答える", 7: "困りごとは受け止めてから", 8: "答えた事を繰り返さない", 9: "資料・会社の事実は即答", 10: "一般的な事は保留しない", 11: "なぜを具体的に", 12: "目安は逆算で",
  13: "お客様が主役", 14: "断りの直後は営業しない", 15: "刺さっていない時は誘わない", 16: "相談の時は簡単に締める", 17: "書く事が無い時は書かない",
  18: "審査はかけてみる", 19: "審査の不安を諦めさせない", 20: "迷う時は申込で抑える", 21: "申込前の背中を押す", 22: "より抑えた見積を約束", 23: "約束は果たす", 24: "受け身で待たせない",
  25: "返事は早く", 26: "返しやすい次の一手", 27: "プロの意見を理由つきで", 28: "理解してから書く", 29: "書き方は竹内さんの手打ち", 30: "名前で呼ぶ", 31: "語尾と絵文字", 32: "要件ごとに優先順に", 33: "検討中は閉じる",
  34: "判断はブレイン・決まりは網", 35: "決まりに無い時は原則で考える",
};
export const principleLabel = (n: number) => `${n}.${PRINCIPLE_JA[n] ?? "?"}`;
/** 道の符号が原則の印に当たるか（"2段" は 2段:*、"AIX:物件" は物件の4種、細目なしの AIX は細目つきにも当たる） */
export function signMatches(sign: string, code: string): boolean {
  const s = sign.trim(), c = String(code ?? "").trim();
  if (!s || !c) return false;
  if (s === c || c.startsWith(`${s}:`) || c.startsWith(`${s}/`)) return true;
  if (s === "AIX:物件") return /^AIX:property_(?:send|recommendation|pickup|search)\b/.test(c) || c === "AIX:物件" || c === "AIX:左右";
  return false;
}
/** 道の符号から、ぶつかった2つの原則のどちらを優先したか（読めない時は null） */
export function principleChoice(pc: PrincipleConflict, code: string | null | undefined): number | null {
  const hits = pc.pair.filter((p) => (pc.signs[String(p)] ?? []).some((s) => signMatches(s, String(code ?? ""))));
  return hits.length === 1 ? hits[0] : null;
}
/** 竹内さんへの確認（はい／いいえ・短い例つき） */
export type GoldConfirm = { id: string; q: string; yes: string; no: string; example?: string | null };

// ─── 伏せる（号室の数字・電話・メール）。名前は問題を作る時に YUMA に伏せ済み ──────────
export function maskGoldText(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g, "（電話番号）")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "yuma@example.com")
    .replace(/https?:\/\/[^\s　]+/g, "（URL）")
    .replace(/(代表取締役)[ 　]*[^\s　]+(?:[ 　][^\s　]+)?/g, "$1（名前）")
    .replace(/[0-9０-９]{2,5}(?=\s*号室)/g, "◯")
    .replace(/([A-Za-zァ-ヶー一-龠ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ・．.]{2,})[\s　]*([0-9０-９]{3,4})(?![0-9０-９]|[,，.．円万㎡帖畳分階件年月日時])/g, "$1 ◯");
}

// ─── 受け止める事を見つける（語の網＝下書き用。正解は人が見る） ──────────────────────
/** 並び＝1つの行に複数ある時に採る順（謝り＞お礼＞不安＞気遣い＞了承） */
const RECEIVE_RES: Array<[ReceiveKind, RegExp]> = [
  ["apology", /すみません|すいません|申し訳|ごめん|恐縮/],
  ["thanks", /ありがと|有難|感謝/],
  ["anxiety", /不安|心配|難しい(?:な|か)|思っちゃ|💦|😭|🥲/],
  ["care", /うるうる|残念|そうなんですね|悲し|ショック/],
  ["agree", /承知|分かりました|わかりました|了解|かしこまり/],
];
/** 文の中の受け止める事（重複は1つ） */
export function receiveKindsOf(text: string): ReceiveKind[] {
  const out: ReceiveKind[] = [];
  for (const [k, re] of RECEIVE_RES) if (re.test(text) && !out.includes(k)) out.push(k);
  return out;
}
/** 受け止めの語が含む部分（行）だけを抜く */
export function receiveLineOf(text: string, kind: ReceiveKind): string {
  const re = RECEIVE_RES.find(([k]) => k === kind)![1];
  const parts = String(text).split(/\n|(?<=[！!。？?])/).map((x) => x.trim()).filter(Boolean);
  return parts.find((x) => re.test(x)) ?? text.trim().slice(0, 30);
}
/** 竹内さんの文がその受け止めに応えているか（返していなければ正解は「触れない」） */
const RECEIVE_REPLY_RES: Record<ReceiveKind, RegExp> = {
  thanks: /ありがとうございます|とんでもない|こちらこそ/,
  apology: /大丈夫|とんでもない|お気になさら|全然/,
  anxiety: /ご安心|大丈夫|全力|最善|尽くさ|お気持ち/,
  care: /ご安心|残念|お気持ち/,
  agree: /(?:^|\n)(?:はい|かしこまりました)/,
};
export function takeuchiReceives(finalText: string, kind: ReceiveKind): boolean {
  return RECEIVE_REPLY_RES[kind].test(finalText);
}

// ─── 似ている度合い（文字2つ組の Dice・0〜1） ─────────────────────────────
function bigrams(s: string): Map<string, number> {
  const t = String(s ?? "").replace(/[\s　、。！!？?・…〜~()（）「」【】\[\]💦😭🥲🙇🏻‍♀️😊😌✨]/gu, "");
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
export function dice(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}
/** 片方がもう片方の一部か、似ている（短い方の2つ組の何割が長い方にあるか） */
export function quoteOverlap(gold: string, have: string): number {
  const A = bigrams(gold), B = bigrams(have);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  const small = Math.min(na, nb);
  return small ? inter / small : 0;
}

// ─── 正解の下書き（spec ＋ 問題 → 4段） ────────────────────────────────
export type SpecAsk = { q: string; route: AnswerRoute; point: string; routes?: AnswerRoute[] };
export type SpecRow = { id: string; type: string; accept: string[]; mustNot?: string[]; asks?: SpecAsk[]; ng?: string[]; why?: string };
export type ProblemRow = { id: string; customer: string; staffText: string; context?: Array<{ s: string; t: string; aix?: boolean }> };

const PROPERTY_RE = /([A-Za-zＡ-Ｚａ-ｚァ-ヶー一-龠ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ・．.＆&']{3,}(?:[\s　]?[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ0-9０-９]+(?:号館)?)?)(?=の|は|も|と|[\s　]*[0-9０-９]+(?:階|号室|LDK|DK|K)|$)/gm;
const NOT_PROPERTY = /^(?:YUMA|SUUMO|スーモ|お部屋|こちら|物件|ところ|エリア|内覧|内見|大人|子ども|小型犬|猫|代理契約|管理会社|募集|お風呂|赤ちゃん)/;
/** 依頼の文に出る物件名（下書き・人が見る） */
export function propertiesOf(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text).matchAll(PROPERTY_RE)) {
    const nm = maskGoldText(m[1].trim());
    if (nm.length >= 4 && !NOT_PROPERTY.test(nm) && /[ァ-ヶーA-Za-zＡ-Ｚ]{2,}/.test(nm) && !out.includes(nm)) out.push(nm);
  }
  return out;
}
/** 竹内さんの文の中で、その要点の言葉が最初に出る位置（先に答える順の下書き） */
export function firstPositionIn(finalText: string, say: string): number {
  const t = String(finalText);
  const g = [...bigrams(say).keys()];
  let best = Number.POSITIVE_INFINITY;
  for (const k of g) { const i = t.indexOf(k); if (i >= 0 && i < best) best = i; }
  return best;
}

/** 発言を部分に分ける（文の終わりで分け、行は受け止めだけの行がある時だけ分ける＝1文の途中の改行では分けない） */
export function splitParts(text: string): string[] {
  const chunks = String(text ?? "").split(/(?<=[！!。？?][✨😊😌🙇💦]*)(?![！!。？?✨😊😌🙇💦])/u).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const c of chunks) {
    const lines = c.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (lines.length > 1 && lines.some((l) => receiveKindsOf(l).length > 0)) out.push(...lines); else out.push(c.replace(/\s*\n\s*/g, " "));
  }
  return out.filter((x) => x.replace(/[\s。、！!？?]/g, "").length >= 2);
}
/** 受け止めだけの部分なら、その種類（語を除いた中身が 8字以下） */
export function partReceive(p: string): ReceiveKind | null {
  const kinds = receiveKindsOf(p);
  if (!kinds.length) return null;
  const content = p.replace(/ありがとうございます|ありがとう|すみません|すいません|申し訳(?:ありません|ございません)?|承知しました|分かりました|わかりました|了解(?:です|しました)?|そうなんですね|うるうる|ぺこり|[！!。、,，\s💦😭🥲🙇🏻‍♀️✨😊😌(（)）m_…]/gu, "");
  return content.length <= 8 ? kinds[0] : null;
}
function receiveAsk(id: string, quote: string, k: ReceiveKind, finalText: string, why: string): GoldAsk {
  const answered = takeuchiReceives(finalText, k);
  return {
    id, quote: maskGoldText(quote), kind: "feeling", receive: k, properties: [], route: answered ? "reply" : "none", routes: [answered ? "reply" : "none"],
    answer: answered ? `${RECEIVE_JA[k]}を一言で受ける` : null, basis: answered ? "conversation" : null, aixKey: null,
    status: "machine", facts: [], priority: null, say: answered ? `${RECEIVE_JA[k]}を受ける` : null,
    why: `${why}・${answered ? "竹内さんの文が受けている" : "竹内さんの文は受けていない＝触れない"}`, specIndex: null,
  };
}

export function deriveGold(spec: SpecRow, prob: ProblemRow): GoldParts {
  const finalText = maskGoldText(prob.staffText);
  const asks: GoldAsk[] = [];
  const pending: string[] = [];
  let n = 0;
  const nextId = () => `a${++n}`;
  const customerParts = splitParts(prob.customer);
  for (const [i, a] of (spec.asks ?? []).entries()) {
    // spec の引用がお客様の発言そのもの（長い連投）なら、発言の部分に分けて見る。言い換え（要約）ならそのまま
    const fromCustomer = a.q.length >= 15 && quoteOverlap(a.q, prob.customer) >= 0.8;
    const parts = fromCustomer ? customerParts.filter((p) => quoteOverlap(p, a.q) >= 0.6) : splitParts(a.q);
    const recvParts = parts.filter((p) => partReceive(p));
    const contentParts = parts.filter((p) => !partReceive(p));
    const point = maskGoldText(a.point);
    // 受け止めだけの依頼（「ありがとうございます💦」）・中身があっても要点が受け止めの返し（「全然大丈夫」）＝その依頼自体が受け止め
    const rk = receiveKindsOf(a.q);
    const selfReceive = !contentParts.length ? (partReceive(parts[0] ?? a.q) ?? rk[0] ?? null)
      : rk.find((k) => a.route === "reply" && RECEIVE_REPLY_RES[k].test(point) && k !== "agree") ?? null;
    // 中身の部分が複数＝要点に一番近い物をこの依頼にし、残りは機械の行（確認待ち）
    let mainQuote = a.q;
    const rest: string[] = [];
    if (fromCustomer && contentParts.length) {
      const ranked = contentParts.map((p, k) => ({ p, k, sc: dice(p, point) + (k === contentParts.length - 1 ? 0.05 : 0) })).sort((x, y) => y.sc - x.sc);
      mainQuote = contentParts.length === 1 ? contentParts[0] : ranked[0].p;
      for (const p of contentParts) if (p !== mainQuote) rest.push(p);
    } else if (fromCustomer && !contentParts.length) mainQuote = parts.join(" ");
    else if (!fromCustomer) {
      // spec が言い換え＝お客様の発言の中で一番近い部分を引用にする（読めたかの照合は発言の言葉で行う）
      const best = customerParts.map((p) => ({ p, sc: Math.max(dice(p, a.q), quoteOverlap(a.q, p) * 0.8) })).sort((x, y) => y.sc - x.sc)[0];
      if (best && best.sc >= 0.35) mainQuote = best.p;
    }
    asks.push({
      id: nextId(), quote: maskGoldText(mainQuote), label: fromCustomer || mainQuote === a.q ? null : maskGoldText(a.q), kind: selfReceive ? "feeling" : a.route === "reply" && /か[？?]?$|ですか|でしょうか|ますか/.test(mainQuote) ? "question" : a.route === "reply" ? "report" : "request",
      receive: selfReceive, properties: propertiesOf(a.q), route: a.route, routes: [...new Set([a.route, ...(a.routes ?? [])])], answer: point.slice(0, 60),
      basis: null, aixKey: a.route === "aix" ? aixKeyOf(spec.accept) : null,
      status: "spec", facts: [], priority: null, say: point, why: null, specIndex: i,
    });
    if (!selfReceive) for (const p of recvParts) {
      asks.push(receiveAsk(nextId(), p, partReceive(p)!, finalText, "spec の依頼から受け止めを分けた"));
      pending.push(`${asks[asks.length - 1].id}: 受け止め（${RECEIVE_JA[asks[asks.length - 1].receive!]}）を spec の依頼から分けた`);
    }
    for (const p of rest) {
      asks.push({ id: nextId(), quote: maskGoldText(p), kind: /[？?]|ですか|ますか/.test(p) ? "question" : "report", receive: null, properties: propertiesOf(p), route: "none", routes: ["none"], answer: null, basis: null, aixKey: null, status: "machine", facts: [], priority: null, say: null, why: "spec の依頼の中の別の部分（竹内さんの文は答えていない＝触れない？）", specIndex: null });
      pending.push(`${asks[asks.length - 1].id}: 「${p.slice(0, 16)}」は触れないで良いか`);
    }
  }
  // spec の依頼の外にある受け止め（お客様の発言の部分から・もう行にある物は飛ばす）
  for (const p of customerParts) {
    const k = partReceive(p); if (!k) continue;
    if (asks.some((a) => quoteOverlap(p, a.quote) >= 0.6)) continue;
    asks.push(receiveAsk(nextId(), p, k, finalText, "発言から足した"));
    pending.push(`${asks[asks.length - 1].id}: 受け止め（${RECEIVE_JA[k]}）を発言から足した`);
  }
  // ③ 答える順＝竹内さんの文で要点の言葉が最初に出る順（触れない物は順なし）
  const order = asks.filter((a) => a.route !== "none" && a.say).map((a) => ({ a, pos: firstPositionIn(finalText, a.say!) })).sort((x, y) => x.pos - y.pos);
  order.forEach((o, i) => { o.a.priority = i + 1; });
  const lead = order.find((o) => o.a.receive === null) ?? order[0];
  if (order.filter((o) => o.a.receive === null).length > 1) pending.push(`先に答える項目（${lead?.a.id ?? "-"}）は竹内さんの文の順から機械で決めた`);
  return {
    id: spec.id, type: spec.type, accept: spec.accept, mustNotPath: spec.mustNot ?? [], asks,
    leadWith: lead?.a.id ?? null, mustNot: (spec.ng ?? []).map(maskGoldText),
    closeOnly: asks.length > 0 && asks.filter((a) => a.route !== "none").every((a) => a.route === "reply" && (a.receive !== null || /締め|いつでも|お気軽にご連絡/.test(a.say ?? "") && !/内覧|手続き/.test(a.say ?? ""))),
    finalText, pending,
  };
}
function aixKeyOf(accept: string[]): string | null {
  const a = accept.find((x) => x.startsWith("AIX:"));
  return a ? a.slice(4) : null;
}

/** 正解を TurnContract の形に写す（足す欄は extra に入れる＝本番の型は変えない） */
export function goldToContract(g: GoldParts): TurnContract & { extra: Array<Pick<GoldAsk, "id" | "status" | "facts" | "priority" | "say" | "why" | "receive" | "properties">> } {
  const asks = g.asks;
  return {
    asks: asks.map((a) => ({ quote: a.quote, topic: "other" as ContractAsk["topic"], kind: a.kind, route: a.route, answer: a.answer, basis: a.basis, aixKey: a.aixKey })),
    leadWith: g.leadWith ? asks.findIndex((a) => a.id === g.leadWith) : null,
    closeOnly: g.closeOnly, mustNot: g.mustNot, proposals: [], alreadySaid: [], settled: [],
    feeling: { kind: asks.some((a) => a.receive === "anxiety") ? "anxious" : asks.some((a) => a.receive === "apology") ? "apologetic" : null, acknowledge: asks.some((a) => a.receive && a.route !== "none") },
    humanChecks: [], source: "brain",
    extra: asks.map((a) => ({ id: a.id, status: a.status, facts: a.facts, priority: a.priority, say: a.say, why: a.why, receive: a.receive, properties: a.properties })),
  };
}

// ─── 採点（結果の1行 × 正解） ─────────────────────────────────────────
export type Stage = "reader" | "link" | "priority" | "writer";
export const STAGE_JA: Record<Stage, string> = { reader: "読み手の取りこぼし", link: "つなぎの抜け", priority: "優先の外れ", writer: "書く役の抜け" };
export const STAGES: Stage[] = ["reader", "link", "priority", "writer"];
export type HabitKind =
  | "質問の答えの抜け" | "受け止めの抜け" | "物件ごとの答えの抜け" | "約束の抜け" | "道の取り違え" | "AIXの種類の取り違え"
  | "言ってはいけない事" | "先に答える外れ" | "決まりが本質を上書き" | "触れない所に触れた"
  // 2026-10-18 20問で足した（D案で新しく確かめる所）
  | "AIXの判断の外れ" | "ピッカーの選び違い" | "主語・指す物の取り違え" | "自信が低いのに言い切った";
export const HABIT_KINDS: HabitKind[] = ["質問の答えの抜け", "受け止めの抜け", "物件ごとの答えの抜け", "約束の抜け", "道の取り違え", "AIXの判断の外れ", "AIXの種類の取り違え", "ピッカーの選び違い", "主語・指す物の取り違え", "自信が低いのに言い切った", "言ってはいけない事", "先に答える外れ", "決まりが本質を上書き", "触れない所に触れた"];

// ─── 脳の働きの型（設計書 8節「働きの型（数える箱）」・段と種類から機械で写す） ───────────────
// 竹内さん「人間の脳として足りていない部分も見つけ出す形で」。写せない物は「どれにも当たらない」（5件以上溜まったら新しい働きの候補として竹内さんに見せる）。
export type BrainFunction = "感じ取る" | "注意" | "記憶" | "相手の頭の中" | "予想" | "自信の気づき" | "気持ち" | "慣れ／じっくり" | "つなぐ" | "決める" | "体で覚える" | "どれにも当たらない";
export const BRAIN_FUNCTIONS: BrainFunction[] = ["感じ取る", "注意", "記憶", "相手の頭の中", "予想", "自信の気づき", "気持ち", "慣れ／じっくり", "つなぐ", "決める", "体で覚える", "どれにも当たらない"];
/** 外れ（段×種類）→ 働きの型 */
export function brainFunctionOf(stage: Stage, kind: HabitKind): BrainFunction {
  if (kind === "受け止めの抜け") return "気持ち";
  if (kind === "主語・指す物の取り違え") return "注意";
  if (kind === "自信が低いのに言い切った") return "自信の気づき";
  if (kind === "触れない所に触れた") return "記憶";            // もう済んだ・頼まれていない所にまた約束・AIX を立てた
  if (kind === "決まりが本質を上書き") return "慣れ／じっくり";  // 慣れた決まりで速く決め、じっくり読んだ本質を消した
  if (kind === "言ってはいけない事") return stage === "writer" ? "予想" : "相手の頭の中"; // 頼まれていない誘い等＝相手の受け取りを読めていない
  if (stage === "writer") return "体で覚える";                 // 竹内さんの言い回し・形の外れ（書く役）
  if (stage === "reader") return "感じ取る";                   // 読み手の取りこぼし
  if (kind === "AIXの判断の外れ" || kind === "AIXの種類の取り違え" || kind === "ピッカーの選び違い" || kind === "先に答える外れ") return "決める";
  if (kind === "道の取り違え" || kind === "質問の答えの抜け" || kind === "物件ごとの答えの抜け" || kind === "約束の抜け") return "つなぐ";
  return "どれにも当たらない";
}

/** brain-exam の結果の1行（使う所だけ） */
export type ResultRow = {
  id: string; rep: number; label: string; model?: string;
  brain?: { reply_direction?: string; reply_mode?: string | null; action?: string | null; check_pattern?: string | null; current_property?: string | null; turn_contract?: { asks?: Array<{ quote?: string; kind?: string; route?: string; answer?: string | null; property?: string | null; aix?: string | null }>; lead_with?: number | null; must_not?: string[]; feeling?: { kind?: string | null; acknowledge?: boolean } | null } | null } | null;
  path?: { code?: string; ok?: boolean; mustNotHit?: string | null } | null;
  essence?: { code?: string; ok?: boolean } | null;
  asks?: Array<{ q: string; covered: boolean; route?: boolean }> | null;
  ng?: Array<{ text: string; violated: boolean }> | null;
  draft?: { text?: string; code?: string; ok?: boolean; asks?: boolean[]; ng?: boolean[] } | null;
};
export type Miss = { stage: Stage; kind: HabitKind; askId: string | null; note: string };

/** ブレインの AIX のボタン・ピッカーを正解の pickers と同じ形にする（物件確認した は check_pattern まで・aix-catalog の topicKey） */
export function aixKeyOfBrain(action: string | null | undefined, checkPattern: string | null | undefined): string | null {
  const a = String(action ?? "").trim();
  if (!a) return null;
  if (a === "property_check_result" || a === "acknowledge_check") return topicKey(`property_check_result${checkPattern ? `/${String(checkPattern).trim()}` : ""}`);
  return a;
}
const aixFamilyOfKey = (k: string) => k.split("/")[0];
/** 正解の pickers に当たるか: ok／ピッカーだけ違う（同じボタン）／ボタンが違う */
export function pickerVerdict(gold: ReadonlyArray<string>, have: string | null): "ok" | "picker" | "button" | null {
  if (!gold.length || !have) return null;
  if (gold.includes(have)) return "ok";
  // 正解が「ボタンだけ」（物件確認した の細目を問わない）の時はボタンが合えば正解
  if (gold.some((g) => !g.includes("/") && g === aixFamilyOfKey(have))) return "ok";
  return gold.some((g) => aixFamilyOfKey(g) === aixFamilyOfKey(have)) ? "picker" : "button";
}
/** 物件の名前が文に出るか（号室・空白・記号の揺れは同じ） */
export function propertyNamed(name: string, text: string): boolean {
  const norm = (x: string) => String(x ?? "").normalize("NFKC").replace(/号室|号館/g, "").replace(/[\s　・･\-ー〜~◯○0-9()（）]/g, "").toLowerCase();
  const n = norm(name), t = norm(text);
  if (n.length < 2 || !t) return false;
  if (t.includes(n)) return true;
  return n.length >= 4 && t.includes(n.slice(0, Math.max(4, Math.ceil(n.length * 0.6))));
}
/** 指す物の正解に対して、ブレイン（か下書き）が名指しした物件が外れているか（外れの説明。合っている・分からない時は null） */
export function referentMiss(ref: NonNullable<GoldAsk["referent"]>, said: string): string | null {
  const s = String(said ?? "").trim();
  if (!s || !ref.targets.length) return null;
  const hit = ref.targets.filter((t) => propertyNamed(t, s));
  if (ref.mode === "one") return hit.length && !hit.includes(ref.targets[0]) ? `正解=${ref.targets[0]}・名指し=${hit.join("／")}` : null;
  // all／confirm: 候補が2つ以上なのに1つだけに決め打ちした
  if (ref.targets.length >= 2 && hit.length === 1) return `正解=${ref.mode === "all" ? "全部にまとめて" : "確かめる"}（${ref.targets.join("／")}）・名指し=${hit[0]}だけ`;
  return null;
}
const ASSERT_NG = /言い切/;
export type RowScore = {
  id: string; rep: number; label: string;
  /** 依頼ごとの最初に落ちた段（null＝最後まで正解・"skip"＝触れないが正解で読まなくてよい） */
  items: Array<{ askId: string; firstFail: Stage | null }>;
  misses: Miss[];
  /** 段ごと（前の段が正解だった物だけを分母にする） */
  stage: Record<Stage, { ok: number; n: number }>;
  finalSim: number | null;
  /** 原則のぶつかり: 正解の勝ち・ブレインの本質（決まりで直す前）の勝ち・最終の勝ち（null＝読めない） */
  principles?: Array<{ id: string; pair: [number, number]; gold: number; brain: number | null; final: number | null }>;
};

function itemKind(a: GoldAsk): HabitKind {
  if (a.receive) return "受け止めの抜け";
  if (a.properties.length) return "物件ごとの答えの抜け";
  if (a.route === "promise") return "約束の抜け";
  return "質問の答えの抜け";
}
const BRAIN_ROUTE_ALIASES: Record<string, AnswerRoute> = { reply: "reply", promise: "promise", aix: "aix", none: "none" };
/** ブレインの依頼の中から、正解の依頼に当たる物を探す（引用の重なり 0.5 以上で一番重なる物） */
export function matchBrainAsk(gold: GoldAsk, brainAsks: ReadonlyArray<{ quote?: string; kind?: string; route?: string }>): number {
  let best = -1, bestScore = 0;
  for (const [i, b] of brainAsks.entries()) {
    const sc = Math.max(quoteOverlap(gold.quote, String(b.quote ?? "")), gold.label ? quoteOverlap(gold.label, String(b.quote ?? "")) : 0);
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  if (bestScore >= 0.5) return best;
  // 受け止めは、ブレインが気持ちとして持っていれば読めた事にする（引用を分けない書き方がある）
  if (gold.receive) {
    const fb = brainAsks.findIndex((b) => b.kind === "feeling" || receiveKindsOf(String(b.quote ?? "")).includes(gold.receive!));
    if (fb >= 0) return fb;
  }
  return -1;
}
const DRAFT_RECEIVE_RES: Record<ReceiveKind, RegExp> = {
  thanks: /ありがとうございます|とんでもない|こちらこそ/,
  apology: /大丈夫|とんでもない|お気になさら|全然/,
  anxiety: /ご安心|大丈夫|全力|中心に|お調べ|サポート/,
  care: /ご安心|大丈夫|全力|かしこまりました|残念/,
  agree: /はい|かしこまりました/,
};

/** includeMachine=false（既定）＝確認待ち（機械の下書き）の行は数えない＝竹内さんが確かめた正解だけで数える */
export function scoreRow(gIn: GoldParts, rIn: ResultRow, opts: { includeMachine?: boolean; rubric?: Rubric } = {}): RowScore {
  const { g: g0, r } = applyRubric(gIn, rIn, opts.rubric ?? "old");
  const g: GoldParts = opts.includeMachine ? g0 : { ...g0, asks: g0.asks.filter((a) => a.status !== "machine") };
  if (g.leadWith && !g.asks.some((a) => a.id === g.leadWith)) g.leadWith = null;
  const misses: Miss[] = [];
  const items: RowScore["items"] = [];
  const st: RowScore["stage"] = { reader: { ok: 0, n: 0 }, link: { ok: 0, n: 0 }, priority: { ok: 0, n: 0 }, writer: { ok: 0, n: 0 } };
  const tc = r.brain?.turn_contract ?? null;
  const bAsks = tc?.asks ?? [];
  const hasDraft = !!r.draft && typeof r.draft.text === "string";
  const draftText = r.draft?.text ?? "";
  let brainAllOk = true;
  const matchIdx = new Map<string, number>();
  for (const a of g.asks) {
    // ① 読む（触れないが正解の物は読めなくてよい）
    const mi = matchBrainAsk(a, bAsks);
    matchIdx.set(a.id, mi);
    if (a.route === "none") {
      const b = mi >= 0 ? bAsks[mi] : null;
      const br = b ? BRAIN_ROUTE_ALIASES[String(b.route ?? "")] : undefined;
      if (br === "promise" || br === "aix") { misses.push({ stage: "link", kind: "触れない所に触れた", askId: a.id, note: `正解=触れない・ブレイン=${br}` }); items.push({ askId: a.id, firstFail: "link" }); brainAllOk = false; }
      else items.push({ askId: a.id, firstFail: null });
      continue;
    }
    st.reader.n++;
    const judge = a.specIndex != null ? r.asks?.[a.specIndex] ?? null : null;
    if (mi < 0 && !(judge?.covered)) {
      misses.push({ stage: "reader", kind: itemKind(a), askId: a.id, note: `読めていない「${a.quote.slice(0, 20)}」` });
      items.push({ askId: a.id, firstFail: "reader" }); brainAllOk = false; continue;
    }
    st.reader.ok++;
    // ② つなぐ（道と中身）
    st.link.n++;
    const b = mi >= 0 ? bAsks[mi] : null;
    const br = b ? BRAIN_ROUTE_ALIASES[String(b.route ?? "")] : undefined;
    const judgeCovered = judge?.covered === true;
    // 受け止めの依頼は、ブレインが「触れない」でも締めの一言で返していれば合う（判定が見る）
    const brainRouteOk = br ? (a.routes.includes(br) || (!!a.receive && br === "none")) : null;
    if (!judgeCovered && brainRouteOk === false) {
      // 種類: 自信が低いのに返信で言い切った ＞ AIX で送るかの判断の外れ ＞ 道の取り違え
      const kind: HabitKind = a.sure === "low" && br === "reply" ? "自信が低いのに言い切った"
        : (br === "aix" && !a.routes.includes("aix")) || (br !== "aix" && a.routes.every((x) => x === "aix")) ? "AIXの判断の外れ" : "道の取り違え";
      misses.push({ stage: "link", kind, askId: a.id, note: `正解=${a.routes.join("|")}・ブレイン=${br}` });
      items.push({ askId: a.id, firstFail: "link" }); brainAllOk = false; continue;
    }
    // AIX のボタン・ピッカー（正解に pickers がある依頼で、ブレインが AIX にした時だけ）
    if (a.pickers?.length && br === "aix") {
      const have = aixKeyOfBrain(b?.aix ?? r.brain?.action ?? null, r.brain?.check_pattern ?? null);
      const pv = pickerVerdict(a.pickers, have);
      if (pv === "picker" || pv === "button") {
        misses.push({ stage: "link", kind: pv === "picker" ? "ピッカーの選び違い" : "AIXの種類の取り違え", askId: a.id, note: `正解=${a.pickers.join("|")}・ブレイン=${have}` });
        items.push({ askId: a.id, firstFail: "link" }); brainAllOk = false; continue;
      }
    }
    // 主語・指す物（正解に referent がある依頼）: ブレインがこの依頼に付けた物件（無ければ今の番の物件）
    if (a.referent) {
      const rm = referentMiss(a.referent, String(b?.property ?? r.brain?.current_property ?? ""));
      if (rm) {
        misses.push({ stage: "link", kind: "主語・指す物の取り違え", askId: a.id, note: rm });
        items.push({ askId: a.id, firstFail: "link" }); brainAllOk = false; continue;
      }
    }
    if (!judgeCovered && judge && judge.route === false) {
      // 依頼の道は合う（か読めない）が、番の答えとしては道が外れた＝最終の道の外れ（決まりの上書きか、番の道の取り違え）
      const over = !!r.essence?.ok && r.path?.ok === false;
      misses.push({ stage: over ? "priority" : "link", kind: over ? "決まりが本質を上書き" : pathKind(g, r.path?.code ?? ""), askId: a.id, note: r.path?.ok ? `依頼の道=${br ?? "?"}（正解=${a.routes.join("|")}・番の道は合う）` : `依頼の道=${br ?? "?"}・最終の道=${r.path?.code ?? "?"}` });
      items.push({ askId: a.id, firstFail: over ? "priority" : "link" }); brainAllOk = false; continue;
    }
    if (judge && !judgeCovered) {
      misses.push({ stage: "link", kind: itemKind(a), askId: a.id, note: `道は合うが要点が抜け「${(a.say ?? "").slice(0, 20)}」` });
      items.push({ askId: a.id, firstFail: "link" }); brainAllOk = false; continue;
    }
    st.link.ok++;
    items.push({ askId: a.id, firstFail: null });
  }
  // ③ 優先（番ごと）: 先に答える項目・言ってはいけない事・道（決まりの上書き）
  const linkAllOk = items.every((x) => x.firstFail === null);
  const pathAlready = misses.some((m) => m.kind === "道の取り違え" || m.kind === "AIXの種類の取り違え" || m.kind === "決まりが本質を上書き");
  if (linkAllOk) {
    st.priority.n++;
    let ok = true;
    if (g.leadWith && tc && typeof tc.lead_with === "number") {
      const want = matchIdx.get(g.leadWith) ?? -1;
      const leadGold = g.asks.find((a) => a.id === g.leadWith)!;
      // 受け止めを先に言うのは外れにしない（竹内さんも受けてから答える）
      const leadAsk = bAsks[tc.lead_with];
      const leadIsReceive = leadAsk && (leadAsk.kind === "feeling" || receiveKindsOf(String(leadAsk.quote ?? "")).length > 0 && quoteOverlap(leadGold.quote, String(leadAsk.quote ?? "")) < 0.5);
      if (want >= 0 && tc.lead_with !== want && !leadIsReceive) { misses.push({ stage: "priority", kind: "先に答える外れ", askId: g.leadWith, note: `正解=${g.leadWith}・ブレイン=${tc.lead_with}` }); ok = false; }
    }
    for (const x of r.ng ?? []) if (x.violated) { misses.push({ stage: "priority", kind: ASSERT_NG.test(x.text) ? "自信が低いのに言い切った" : "言ってはいけない事", askId: null, note: x.text.slice(0, 30) }); ok = false; }
    if (r.path && r.path.ok === false) {
      if (r.essence?.ok) misses.push({ stage: "priority", kind: "決まりが本質を上書き", askId: null, note: `本質=${r.essence.code}→最終=${r.path.code}` });
      else misses.push({ stage: "priority", kind: pathKind(g, r.path.code ?? ""), askId: null, note: `最終の道=${r.path.code}・正解=${g.accept.join("|")}` });
      ok = false;
    }
    if (ok) st.priority.ok++; else brainAllOk = false;
  } else {
    // 前の段で落ちた番でも、道と言ってはいけない事は癖として数える（段は前の段に付ける）
    if (r.path && r.path.ok === false && !pathAlready) misses.push({ stage: r.essence?.ok ? "priority" : "link", kind: r.essence?.ok ? "決まりが本質を上書き" : pathKind(g, r.path.code ?? ""), askId: null, note: `最終の道=${r.path.code}` });
    for (const x of r.ng ?? []) if (x.violated) misses.push({ stage: "priority", kind: ASSERT_NG.test(x.text) ? "自信が低いのに言い切った" : "言ってはいけない事", askId: null, note: x.text.slice(0, 30) });
  }
  // ④ 書く（ブレインまで全部正解だった番だけを分母に）
  if (hasDraft && brainAllOk) {
    st.writer.n++;
    let ok = true;
    for (const a of g.asks) {
      if (a.route === "none") continue;
      if (a.specIndex != null && r.draft!.asks && r.draft!.asks[a.specIndex] === false) {
        misses.push({ stage: "writer", kind: itemKind(a), askId: a.id, note: `下書きで抜け「${(a.say ?? "").slice(0, 20)}」` });
        const it = items.find((x) => x.askId === a.id); if (it && it.firstFail === null) it.firstFail = "writer";
        ok = false;
      } else if (a.receive && a.specIndex == null && !DRAFT_RECEIVE_RES[a.receive].test(draftText)) {
        misses.push({ stage: "writer", kind: "受け止めの抜け", askId: a.id, note: `下書きが${RECEIVE_JA[a.receive]}を受けていない` });
        const it = items.find((x) => x.askId === a.id); if (it && it.firstFail === null) it.firstFail = "writer";
        ok = false;
      }
    }
    // 主語・指す物: 全部にまとめて答える／確かめる番で、下書きが候補の1つだけを名指しした
    for (const a of g.asks) {
      if (a.route === "none" || !a.referent || a.referent.mode === "one") continue;
      const rm = referentMiss(a.referent, draftText);
      if (rm) { misses.push({ stage: "writer", kind: "主語・指す物の取り違え", askId: a.id, note: `下書き: ${rm}` }); const it = items.find((x) => x.askId === a.id); if (it && it.firstFail === null) it.firstFail = "writer"; ok = false; }
    }
    for (const [i, v] of (r.draft!.ng ?? []).entries()) if (v) { const t = String(g.mustNot[i] ?? ""); misses.push({ stage: "writer", kind: ASSERT_NG.test(t) ? "自信が低いのに言い切った" : "言ってはいけない事", askId: null, note: `下書き: ${t.slice(0, 30)}` }); ok = false; }
    if (r.draft!.ok === false) { misses.push({ stage: "writer", kind: pathKind(g, r.draft!.code ?? ""), askId: null, note: `下書きの道=${r.draft!.code}` }); ok = false; }
    if (ok) st.writer.ok++;
  } else if (hasDraft) {
    // ブレインで落ちた番の下書きの外れは「前の段のせい」なので書く役には数えない（癖の表には出さない）
  }
  // 原則のぶつかり（確認待ち＝機械の下書きの物は includeMachine の時だけ）。ブレインの判断＝本質の道（無ければ最終の道）
  const principles = (g0.principles ?? []).filter((pc) => opts.includeMachine || pc.status !== "machine").map((pc) => ({
    id: pc.id, pair: pc.pair, gold: pc.winner,
    brain: principleChoice(pc, r.essence?.code ?? r.path?.code ?? null),
    final: principleChoice(pc, r.path?.code ?? null),
  }));
  return { id: r.id, rep: r.rep, label: r.label, items, misses, stage: st, finalSim: hasDraft ? (opts.rubric === "wide" ? bestFinalSim(g0, draftText) : round2(dice(g.finalText, maskGoldText(draftText)))) : null, principles };
}
export function pathKind(g: Pick<GoldParts, "accept" | "asks">, code: string): HabitKind {
  const isAix = (c: string) => c.startsWith("AIX") || c.startsWith("右:");
  const wantAix = g.accept.filter(isAix);
  const c = String(code ?? "");
  // 自信が低い番（確認の約束が正解）で返信にした＝言い切った
  if (c === "返信" && !g.accept.includes("返信") && g.asks.some((a) => a.sure === "low" && a.route !== "none")) return "自信が低いのに言い切った";
  // AIX で送るかの判断: 正解に AIX が無いのに AIX／正解が AIX だけなのに AIX でない
  if ((isAix(c) && !wantAix.length) || (!isAix(c) && c && wantAix.length > 0 && wantAix.length === g.accept.length)) return "AIXの判断の外れ";
  if (isAix(c) && wantAix.length) {
    // 同じボタン（物件確認した 等）で細目だけ違う＝ピッカーの選び違い
    const fam = (x: string) => x.replace(/^AIX:/, "").split("/")[0];
    const sub = (x: string) => x.replace(/^AIX:/, "").split("/")[1] ?? "";
    if (sub(c) && wantAix.some((w) => fam(w) === fam(c) && sub(w) && sub(w) !== sub(c))) return "ピッカーの選び違い";
    return "AIXの種類の取り違え";
  }
  return "道の取り違え";
}
function round2(x: number) { return Math.round(x * 100) / 100; }

// ─── 癖の表（段×種類 を モデル×回 で並べる） ───────────────────────────────
export type HabitTable = {
  columns: string[];                       // "sonnet#1" 等
  rows: Array<{ stage: Stage; kind: HabitKind; counts: number[]; total: number }>;
  stageRate: Array<{ column: string; reader: string; link: string; priority: string; writer: string }>;
};
export function habitTable(scored: ReadonlyArray<RowScore & { column: string }>, columnsOrder?: string[]): HabitTable {
  const columns = columnsOrder ?? [...new Set(scored.map((s) => s.column))];
  const key = (s: Stage, k: HabitKind) => `${s}|${k}`;
  const m = new Map<string, number[]>();
  for (const s of scored) for (const x of s.misses) {
    const kk = key(x.stage, x.kind);
    if (!m.has(kk)) m.set(kk, columns.map(() => 0));
    const ci = columns.indexOf(s.column); if (ci >= 0) m.get(kk)![ci]++;
  }
  const rows: HabitTable["rows"] = [];
  for (const stg of STAGES) for (const k of HABIT_KINDS) { const c = m.get(key(stg, k)); if (c) rows.push({ stage: stg, kind: k, counts: c, total: c.reduce((a, b) => a + b, 0) }); }
  const stageRate = columns.map((col) => {
    const ss = scored.filter((s) => s.column === col);
    const f = (stg: Stage) => { const ok = ss.reduce((a, s) => a + s.stage[stg].ok, 0), n = ss.reduce((a, s) => a + s.stage[stg].n, 0); return n ? `${ok}/${n}（${Math.round((ok / n) * 100)}%）` : "-"; };
    return { column: col, reader: f("reader"), link: f("link"), priority: f("priority"), writer: f("writer") };
  });
  return { columns, rows, stageRate };
}
export function habitTableText(t: HabitTable): string {
  const head = `| 段 | 種類 | ${t.columns.join(" | ")} | 計 |`;
  const sep = `|---|---|${t.columns.map(() => "---:").join("|")}|---:|`;
  const body = t.rows.map((r) => `| ${STAGE_JA[r.stage]} | ${r.kind} | ${r.counts.join(" | ")} | ${r.total} |`);
  const rate = ["", "| 列 | ①読む | ②つなぐ | ③優先 | ④書く |", "|---|---|---|---|---|", ...t.stageRate.map((s) => `| ${s.column} | ${s.reader} | ${s.link} | ${s.priority} | ${s.writer} |`)];
  return [head, sep, ...body, ...rate].join("\n");
}
/** 働きの型ごとの外れの数（列＝案:モデル#回） */
export type FunctionTable = { columns: string[]; rows: Array<{ fn: BrainFunction; counts: number[]; total: number }> };
export function functionTable(scored: ReadonlyArray<RowScore & { column: string }>, columnsOrder?: string[]): FunctionTable {
  const columns = columnsOrder ?? [...new Set(scored.map((s) => s.column))];
  const m = new Map<BrainFunction, number[]>();
  for (const s of scored) for (const x of s.misses) {
    const fn = brainFunctionOf(x.stage, x.kind);
    if (!m.has(fn)) m.set(fn, columns.map(() => 0));
    const ci = columns.indexOf(s.column); if (ci >= 0) m.get(fn)![ci]++;
  }
  return { columns, rows: BRAIN_FUNCTIONS.filter((f) => m.has(f)).map((fn) => ({ fn, counts: m.get(fn)!, total: m.get(fn)!.reduce((a, b) => a + b, 0) })) };
}
export function functionTableText(t: FunctionTable): string {
  return [`| 働きの型 | ${t.columns.join(" | ")} | 計 |`, `|---|${t.columns.map(() => "---:").join("|")}|---:|`, ...t.rows.map((r) => `| ${r.fn} | ${r.counts.join(" | ")} | ${r.total} |`)].join("\n");
}

/**
 * 「原則の組 × どちらが勝ったか」の表。行＝原則の組（小さい番号が先）。列ごとに「正解と合った数／読めた数」と、ブレインがそれぞれを勝たせた数。
 * 最後に、竹内さんの実物（正解）とブレインで、各原則が勝った回数・負けた回数を並べる（問題が増えるほど実際の優先の並びが見える）。
 */
export function principleTable(scored: ReadonlyArray<RowScore & { column: string }>, columnsOrder?: string[]): string {
  const columns = columnsOrder ?? [...new Set(scored.map((s) => s.column))];
  const key = (p: [number, number]) => { const [a, b] = [...p].sort((x, y) => x - y); return `${a}-${b}`; };
  const pairs = new Map<string, { pair: [number, number]; ids: Set<string>; goldWins: Map<number, Set<string>>; cols: Array<{ ok: number; read: number; n: number; wins: Map<number, number>; finalOk: number }> }>();
  const winLoss = new Map<string, Map<number, { w: number; l: number }>>(); // 列 or 正解 → 原則 → 勝ち・負け
  const bump = (who: string, win: number, lose: number) => {
    const m = winLoss.get(who) ?? new Map(); winLoss.set(who, m);
    const a = m.get(win) ?? { w: 0, l: 0 }; a.w++; m.set(win, a);
    const b = m.get(lose) ?? { w: 0, l: 0 }; b.l++; m.set(lose, b);
  };
  const goldSeen = new Set<string>();
  for (const s of scored) for (const p of s.principles ?? []) {
    const k = key(p.pair);
    const sorted = [...p.pair].sort((x, y) => x - y) as [number, number];
    const e = pairs.get(k) ?? { pair: sorted, ids: new Set(), goldWins: new Map(), cols: columns.map(() => ({ ok: 0, read: 0, n: 0, wins: new Map(), finalOk: 0 })) };
    pairs.set(k, e);
    e.ids.add(s.id);
    const gw = e.goldWins.get(p.gold) ?? new Set(); gw.add(s.id); e.goldWins.set(p.gold, gw);
    const gk = `${s.id}/${p.id}`;
    if (!goldSeen.has(gk)) { goldSeen.add(gk); bump("正解（竹内さん）", p.gold, p.pair.find((x) => x !== p.gold)!); }
    const ci = columns.indexOf(s.column); if (ci < 0) continue;
    const c = e.cols[ci]; c.n++;
    if (p.brain != null) { c.read++; c.wins.set(p.brain, (c.wins.get(p.brain) ?? 0) + 1); if (p.brain === p.gold) c.ok++; bump(s.column, p.brain, p.pair.find((x) => x !== p.brain)!); }
    if (p.final === p.gold) c.finalOk++;
  }
  if (!pairs.size) return "（原則のぶつかりの正解がまだ無い）";
  const out: string[] = [];
  out.push(`| 原則の組 | 問題 | 正解の勝ち | ${columns.map((c) => `${c} 合った/読めた（本質）・最終で合った・ブレインの勝ち`).join(" | ")} |`, `|---|---|---|${columns.map(() => "---").join("|")}|`);
  for (const e of [...pairs.values()].sort((x, y) => x.pair[0] - y.pair[0] || x.pair[1] - y.pair[1])) {
    const gold = [...e.goldWins.entries()].map(([w, ids]) => `${principleLabel(w)}×${ids.size}`).join("・");
    out.push(`| ${principleLabel(e.pair[0])} × ${principleLabel(e.pair[1])} | ${[...e.ids].join(",")} | ${gold} | ${e.cols.map((c) => c.n ? `${c.ok}/${c.read}（読めない ${c.n - c.read}）・最終 ${c.finalOk}/${c.n}・${[...c.wins.entries()].map(([w, n]) => `${w}勝${n}`).join(" ") || "-"}` : "-").join(" | ")} |`);
  }
  out.push("", "### 各原則の勝ち・負け（多く勝った順＝実際の優先の並び）", "", "| 誰の判断 | 並び（原則 勝ち-負け） |", "|---|---|");
  for (const [who, m] of winLoss) out.push(`| ${who} | ${[...m.entries()].sort((a, b) => (b[1].w - b[1].l) - (a[1].w - a[1].l) || b[1].w - a[1].w).map(([p, x]) => `${principleLabel(p)} ${x.w}-${x.l}`).join("／")} |`);
  return out.join("\n");
}

// ─── 正解に足す（gold-20.extra.json: 足した4問の AIX のピッカー・指す物・確かさ・竹内さんへの確認） ─────────
export type GoldExtraAsk = Partial<Pick<GoldAsk, "pickers" | "referent" | "sure" | "route" | "routes" | "say" | "facts" | "basis" | "status" | "why" | "properties" | "priority">>;
export type GoldExtra = {
  /** 依頼ごとの足し（キー＝GoldAsk.id・"spec:<specIndex>"・"q:<引用の言葉>"） */
  asks?: Record<string, GoldExtraAsk>;
  /** 無ければ足す行（引用＋足す欄） */
  addAsks?: Array<GoldExtraAsk & { quote: string }>;
  mustNot?: string[];
  leadWith?: string | null;
  confirm?: GoldConfirm[];
  principles?: PrincipleConflict[];
  goodAnswers?: GoodAnswer[];
  judgeReviews?: JudgeReview[];
};
function findExtraAsk(g: GoldParts, key: string): GoldAsk | undefined {
  return key.startsWith("spec:") ? g.asks.find((x) => x.specIndex === Number(key.slice(5))) : key.startsWith("q:") ? g.asks.find((x) => x.quote.includes(key.slice(2))) : g.asks.find((x) => x.id === key);
}
export function applyGoldExtra(g: GoldParts, extra: GoldExtra | null | undefined): GoldParts {
  if (!extra) return g;
  let routeChanged = false;
  // 無ければ足す行（flash の補いは揺れるので、確かめたい部分は言葉で必ず持つ）。もう似た行があれば足さない（下の asks の "q:" で直す）
  for (const ad of extra.addAsks ?? []) {
    const q = maskGoldText(ad.quote);
    if (g.asks.some((a) => a.quote.includes(q) || quoteOverlap(q, a.quote) >= 0.5)) continue;
    const route = ad.route ?? "reply";
    g.asks.push({ id: `a${g.asks.length + 1}`, quote: q, kind: route === "promise" ? "request" : "question", receive: null, properties: [], route, routes: ad.routes ?? [route], answer: ad.say ? maskGoldText(ad.say).slice(0, 60) : null, basis: null, aixKey: null, status: "machine", facts: ad.facts ?? [], priority: null, say: route === "none" ? null : ad.say ? maskGoldText(ad.say) : null, why: ad.why ?? "足した行", specIndex: null, pickers: ad.pickers ?? null, referent: ad.referent ?? null, sure: ad.sure ?? null });
    g.pending.push(`${g.asks[g.asks.length - 1].id}: 「${q.slice(0, 20)}」を足した（道=${route}）`);
    routeChanged = true;
  }
  for (const [key, v] of Object.entries(extra.asks ?? {})) {
    // キー: "spec:<番号>"＝spec の依頼／"q:<言葉>"＝引用にその言葉を含む行（flash が足した行は番号が揺れるので言葉で当てる）／id
    const a = findExtraAsk(g, key);
    if (!a) { g.pending.push(`足しの行が見つからない: ${key}`); continue; }
    const before = a.route;
    Object.assign(a, v);
    if (v.route && !v.routes) a.routes = [...new Set([v.route, ...a.routes.filter((x) => x !== before)])];
    if (v.route && v.route !== before) routeChanged = true;
  }
  if (routeChanged) reorderPriority(g);
  // 順を言葉で決めた行（竹内さんの文の順）は最後に上書き
  const fixedOrder = Object.entries(extra.asks ?? {}).filter(([, v]) => v.priority != null).length > 0;
  if (fixedOrder) for (const [key, v] of Object.entries(extra.asks ?? {})) { if (v.priority == null) continue; const a = findExtraAsk(g, key); if (a) a.priority = v.priority; }
  if (extra.mustNot?.length) g.mustNot = [...new Set([...g.mustNot, ...extra.mustNot.map(maskGoldText)])];
  if (extra.leadWith !== undefined) {
    // 先に答える項目を決めた（竹内さんの文と spec の why から）＝機械の順の確認待ちは消し、その項目を1番にする
    g.leadWith = extra.leadWith;
    g.pending = g.pending.filter((p) => !p.startsWith("先に答える項目"));
    const lead = g.asks.find((a) => a.id === extra.leadWith);
    if (lead && lead.priority != null && !fixedOrder) {
      const others = g.asks.filter((a) => a !== lead && a.priority != null).sort((x, y) => x.priority! - y.priority!);
      lead.priority = 1; others.forEach((a, i) => { a.priority = i + 2; });
    }
  }
  // 良い答えの幅・判定の見直し（今は空でよい・幅ありの物差しの時だけ効く）
  g.goodAnswers = [...(g.goodAnswers ?? []), ...(extra.goodAnswers ?? []).map((x) => ({ ...x, text: x.text ? maskGoldText(x.text) : x.text ?? null }))];
  g.judgeReviews = [...(g.judgeReviews ?? []), ...(extra.judgeReviews ?? [])];
  if (extra.principles?.length) {
    g.principles = [...(g.principles ?? []), ...extra.principles.map((p) => ({ ...p, why: maskGoldText(p.why), status: p.status ?? "machine" as GoldStatus }))];
    for (const p of extra.principles) if ((p.status ?? "machine") === "machine") g.pending.push(`${p.id}: 原則 ${principleLabel(p.winner)} ＞ ${principleLabel(p.pair.find((x) => x !== p.winner)!)} でよいか（はい／いいえ＝逆が勝つ）`);
  }
  if (extra.confirm?.length) {
    g.confirm = [...(g.confirm ?? []), ...extra.confirm.map((c) => ({ ...c, q: maskGoldText(c.q), yes: maskGoldText(c.yes), no: maskGoldText(c.no), example: c.example ? maskGoldText(c.example) : null }))];
    for (const c of extra.confirm) g.pending.push(`${c.id}: ${maskGoldText(c.q)}`);
  }
  return g;
}

// ─── 案ごとに並べる（A＝今の Sonnet・C＝flash の判断だけ（1回／3回の多数決）・D＝読み手 flash＋核 Claude） ───────────
// 2026-10-18 竹内さんの案 D:「パーツの読み手は flash、まとめる核（優先順位と最終の判断）は Claude。核にはパーツのまとめ＋お客様の今回の文そのものを渡す」
//   どの案の答えも ResultRow（brain.turn_contract・path・essence・asks・ng・draft）の形で出せば、同じ問題・同じ段の物差しで並ぶ。
//   列の名前は「案:モデル#回」（例 "A:sonnet#1"・"C:flash#maj3"・"D:flash+claude#1"）。癖の表は「#」より前でまとめる。
/** 3回の多数決を1行にする（道・依頼・言ってはいけない事・下書きを項目ごとに過半数で） */
export function majorityRow(rows: ReadonlyArray<ResultRow>, label: string): ResultRow | null {
  if (!rows.length) return null;
  const half = rows.length / 2;
  const maj = (xs: Array<boolean | undefined | null>) => xs.filter((x) => x === true).length > half;
  const pick = <T>(xs: T[]) => { const m = new Map<string, { v: T; n: number }>(); for (const x of xs) { const k = JSON.stringify(x); const e = m.get(k) ?? { v: x, n: 0 }; e.n++; m.set(k, e); } return [...m.values()].sort((a, b) => b.n - a.n)[0].v; };
  const base = rows[0];
  const nAsk = Math.max(0, ...rows.map((r) => r.asks?.length ?? 0));
  const nNg = Math.max(0, ...rows.map((r) => r.ng?.length ?? 0));
  const drafts = rows.filter((r) => r.draft);
  // 読み手の答え（turn_contract）は、最終の道が多数派の回のうち最初の物を代表にする
  const pathOk = maj(rows.map((r) => r.path?.ok));
  const rep = rows.find((r) => !!r.path?.ok === pathOk) ?? base;
  return {
    id: base.id, rep: 0, label, model: base.model,
    brain: rep.brain ?? null,
    path: { code: pick(rows.map((r) => r.path?.code ?? "")), ok: pathOk, mustNotHit: rep.path?.mustNotHit ?? null },
    essence: { code: pick(rows.map((r) => r.essence?.code ?? "")), ok: maj(rows.map((r) => r.essence?.ok)) },
    asks: base.asks ? Array.from({ length: nAsk }, (_, i) => ({ q: base.asks![i]?.q ?? "", covered: maj(rows.map((r) => r.asks?.[i]?.covered)), route: maj(rows.map((r) => r.asks?.[i]?.route ?? r.asks?.[i]?.covered)) })) : null,
    ng: base.ng ? Array.from({ length: nNg }, (_, i) => ({ text: base.ng![i]?.text ?? "", violated: maj(rows.map((r) => r.ng?.[i]?.violated)) })) : null,
    draft: drafts.length ? {
      text: (drafts.find((r) => !!r.draft!.ok === maj(drafts.map((d) => d.draft!.ok))) ?? drafts[0]).draft!.text,
      code: pick(drafts.map((r) => r.draft!.code ?? "")), ok: maj(drafts.map((r) => r.draft!.ok)),
      asks: Array.from({ length: Math.max(0, ...drafts.map((r) => r.draft!.asks?.length ?? 0)) }, (_, i) => maj(drafts.map((r) => r.draft!.asks?.[i]))),
      ng: Array.from({ length: Math.max(0, ...drafts.map((r) => r.draft!.ng?.length ?? 0)) }, (_, i) => maj(drafts.map((r) => r.draft!.ng?.[i]))),
    } : null,
  };
}
/** 「案=結果の label[:maj3]」の並びを読む（例 "A=mc1018-sonnet,C=mc1018-flash,Cmaj=mc1018-flash:maj3"） */
/** label は「+」でつなぐと同じ列に入る（例 "A=mc1018-sonnet2+mc1018-sonnet2-add4"＝16問の回と足した4問の回を1列に） */
export type RunSpec = { plan: string; label: string; majority: boolean };
export function parseRuns(s: string): RunSpec[] {
  return String(s).split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [plan, rest] = x.includes("=") ? x.split("=") : [x, x];
    const [label, opt] = rest.split(":");
    return { plan, label, majority: opt === "maj3" || opt === "maj" };
  });
}
/** 列の名前（案:モデル#回） */
export function columnOf(plan: string, label: string, rep: number | "maj"): string {
  const model = label.replace(/^mc\d+-/, "");
  return `${plan}:${model}#${rep === "maj" ? "maj" : rep}`;
}

/** モデルごとに一番多い癖（上位 n） */
export function topHabitsByModel(t: HabitTable, n = 3): Array<{ model: string; top: Array<{ stage: Stage; kind: HabitKind; count: number }> }> {
  const models = [...new Set(t.columns.map((c) => c.split("#")[0]))];
  return models.map((md) => {
    const idx = t.columns.map((c, i) => (c.split("#")[0] === md ? i : -1)).filter((i) => i >= 0);
    const list = t.rows.map((r) => ({ stage: r.stage, kind: r.kind, count: idx.reduce((a, i) => a + r.counts[i], 0) })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
    return { model: md, top: list.slice(0, n) };
  });
}

// ─── 案 D の材料（道具だけ・今は流さない） ────────────────────────────────
/** 読み手（flash）が出すパーツの答え＝①②の表（GoldAsk と同じ欄。status は使わない） */
export type PartsReaderAsk = Pick<GoldAsk, "id" | "quote" | "kind" | "receive" | "properties" | "route" | "facts" | "say">;
/** 核（Claude）に渡す材料: パーツのまとめ（答えの設計表の材料）＋お客様の今回の文そのもの。核は③（先に答える・言わない事）と最終の道を決める */
export function buildCoreInput(parts: ReadonlyArray<PartsReaderAsk>, customerText: string): string {
  const lines = parts.map((p) => `- ${p.id}「${p.quote}」種類=${p.receive ? `受け止め:${RECEIVE_JA[p.receive]}` : p.kind}${p.properties.length ? `・物件=${p.properties.join("／")}` : ""}・道の案=${p.route}${p.facts.length ? `・事実=${p.facts.join("／")}` : ""}${p.say ? `・言う事の案=${p.say}` : ""}`);
  return `【お客様の今回の文（そのまま）】\n${customerText}\n\n【読み手のまとめ（依頼と受け止めの一覧）】\n${lines.join("\n") || "（なし）"}\n\n【あなた（核）が決める事】\n①依頼ごとの道（返信／約束／AIX／触れない）の最終 ②先に答える項目（id）③言ってはいけない事 ④この番の道`;
}

/** 答える順を竹内さんの文から付け直す（行を足した後） */
export function reorderPriority(g: GoldParts): void {
  for (const a of g.asks) a.priority = null;
  const order = g.asks.filter((a) => a.route !== "none" && a.say).map((a) => ({ a, pos: firstPositionIn(g.finalText, a.say!) })).sort((x, y) => x.pos - y.pos);
  order.forEach((o, i) => { o.a.priority = i + 1; });
}
