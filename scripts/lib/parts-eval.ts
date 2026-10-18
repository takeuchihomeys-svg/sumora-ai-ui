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
};

// ─── 伏せる（号室の数字・電話・メール）。名前は問題を作る時に YUMA に伏せ済み ──────────
export function maskGoldText(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g, "（電話番号）")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "yuma@example.com")
    .replace(/https?:\/\/[^\s　]+/g, "（URL）")
    .replace(/[0-9０-９]{2,5}(?=\s*号室)/g, "◯")
    .replace(/([A-Za-zァ-ヶー一-龠ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ・．.]{2,})[\s　]*([0-9０-９]{3,4})(?![0-9０-９]|[円万㎡帖畳分階件年月日時])/g, "$1 ◯");
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
  | "言ってはいけない事" | "先に答える外れ" | "決まりが本質を上書き" | "触れない所に触れた";
export const HABIT_KINDS: HabitKind[] = ["質問の答えの抜け", "受け止めの抜け", "物件ごとの答えの抜け", "約束の抜け", "道の取り違え", "AIXの種類の取り違え", "言ってはいけない事", "先に答える外れ", "決まりが本質を上書き", "触れない所に触れた"];

/** brain-exam の結果の1行（使う所だけ） */
export type ResultRow = {
  id: string; rep: number; label: string; model?: string;
  brain?: { reply_direction?: string; turn_contract?: { asks?: Array<{ quote?: string; kind?: string; route?: string; answer?: string | null; property?: string | null }>; lead_with?: number | null; must_not?: string[]; feeling?: { kind?: string | null; acknowledge?: boolean } | null } | null } | null;
  path?: { code?: string; ok?: boolean; mustNotHit?: string | null } | null;
  essence?: { code?: string; ok?: boolean } | null;
  asks?: Array<{ q: string; covered: boolean; route?: boolean }> | null;
  ng?: Array<{ text: string; violated: boolean }> | null;
  draft?: { text?: string; code?: string; ok?: boolean; asks?: boolean[]; ng?: boolean[] } | null;
};
export type Miss = { stage: Stage; kind: HabitKind; askId: string | null; note: string };
export type RowScore = {
  id: string; rep: number; label: string;
  /** 依頼ごとの最初に落ちた段（null＝最後まで正解・"skip"＝触れないが正解で読まなくてよい） */
  items: Array<{ askId: string; firstFail: Stage | null }>;
  misses: Miss[];
  /** 段ごと（前の段が正解だった物だけを分母にする） */
  stage: Record<Stage, { ok: number; n: number }>;
  finalSim: number | null;
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
export function scoreRow(g0: GoldParts, r: ResultRow, opts: { includeMachine?: boolean } = {}): RowScore {
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
      misses.push({ stage: "link", kind: "道の取り違え", askId: a.id, note: `正解=${a.routes.join("|")}・ブレイン=${br}` });
      items.push({ askId: a.id, firstFail: "link" }); brainAllOk = false; continue;
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
    for (const x of r.ng ?? []) if (x.violated) { misses.push({ stage: "priority", kind: "言ってはいけない事", askId: null, note: x.text.slice(0, 30) }); ok = false; }
    if (r.path && r.path.ok === false) {
      if (r.essence?.ok) misses.push({ stage: "priority", kind: "決まりが本質を上書き", askId: null, note: `本質=${r.essence.code}→最終=${r.path.code}` });
      else misses.push({ stage: "priority", kind: pathKind(g, r.path.code ?? ""), askId: null, note: `最終の道=${r.path.code}・正解=${g.accept.join("|")}` });
      ok = false;
    }
    if (ok) st.priority.ok++; else brainAllOk = false;
  } else {
    // 前の段で落ちた番でも、道と言ってはいけない事は癖として数える（段は前の段に付ける）
    if (r.path && r.path.ok === false && !pathAlready) misses.push({ stage: r.essence?.ok ? "priority" : "link", kind: r.essence?.ok ? "決まりが本質を上書き" : pathKind(g, r.path.code ?? ""), askId: null, note: `最終の道=${r.path.code}` });
    for (const x of r.ng ?? []) if (x.violated) misses.push({ stage: "priority", kind: "言ってはいけない事", askId: null, note: x.text.slice(0, 30) });
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
    for (const [i, v] of (r.draft!.ng ?? []).entries()) if (v) { misses.push({ stage: "writer", kind: "言ってはいけない事", askId: null, note: `下書き: ${String(g.mustNot[i] ?? "").slice(0, 30)}` }); ok = false; }
    if (r.draft!.ok === false) { misses.push({ stage: "writer", kind: pathKind(g, r.draft!.code ?? ""), askId: null, note: `下書きの道=${r.draft!.code}` }); ok = false; }
    if (ok) st.writer.ok++;
  } else if (hasDraft) {
    // ブレインで落ちた番の下書きの外れは「前の段のせい」なので書く役には数えない（癖の表には出さない）
  }
  return { id: r.id, rep: r.rep, label: r.label, items, misses, stage: st, finalSim: hasDraft ? round2(dice(g.finalText, maskGoldText(draftText))) : null };
}
function pathKind(g: GoldParts, code: string): HabitKind {
  const wantAix = g.accept.filter((a) => a.startsWith("AIX"));
  if (code.startsWith("AIX") && wantAix.length) return "AIXの種類の取り違え";
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
