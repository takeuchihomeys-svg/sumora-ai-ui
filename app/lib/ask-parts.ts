// app/lib/ask-parts.ts — 1つの依頼を「今言える部分」と「確認が要る部分」に分ける（turn_contract.asks[].parts・純関数）
//
// 2026-11-13 作業員7b（統括役の頼み S5・点検役の結果「1つの依頼を今言える部分と確認が要る部分に分けられていない」・竹内さん 11/13「足りない土台の強化と具体的な細分化で直す」）:
//   実例 12643: 「鍵交換は必須か」＝資料で返信／「外せるか」＝管理会社に確かめる事で AIX。12548: 色・空室＝資料で返信／白基調の代わり＝AIX。
//   1つの依頼に1つの route しか持てないと、どちらかが落ちる（全部を約束にする・全部を返信で言い切る）。
//   形: parts: [{ part, source, certainty, route }]。source の名前は作業員16 の answer_source（brain-now-later.ts ANSWER_SOURCES:
//   company_fact／material_value／staff_only／none）と同じ（作業員16: material_value は会話・資料に書いてある値を含む・ANSWER_SOURCES は変えない）。
//   staff_only は who（mgmt＝管理会社／rep＝代表・社内の判断／phone＝電話で確かめる）で分けて数える（作業員16 の勧め）。certainty は assertable（言い切れる）／basically（基本的に）／needs_check（確認が要る）＝作業員22 の compose-decided・作業員10 の compose-value-slots と同じ名前。
//   作業員10 の文の側の AnswerSource（material・company_fact・record・conversation・general・staff_only・checked_result）へは toComposeSource で読み替える（main の名前は作業員16 の方）。
//   2段の決まった計算（持ち込みの網 等）は、ブレインの parts が「全部 今言える」と言っている番では下げる（12348・12578 の当て違い・T2 と同じ線）。
//   既定 off（ASK_PARTS_SPLIT=on）。
import { ANSWER_SOURCES } from "./brain-now-later";
import { fromBrainAnswerSource, type AnswerSourceKind, type SourceHint } from "./answer-source";

type Env = Record<string, string | undefined>;
// 2026-11-13 作業員A: 11/13 束の試験で悪化0・既定 on（止める ASK_PARTS_SPLIT=off）
export function askPartsSplitOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ASK_PARTS_SPLIT ?? "on").trim().toLowerCase() !== "off";
}

export const PART_SOURCES = ANSWER_SOURCES;
export type PartSource = typeof PART_SOURCES[number];
export const PART_CERTAINTIES = ["assertable", "basically", "needs_check"] as const;
export type PartCertainty = typeof PART_CERTAINTIES[number];
export const PART_WHO = ["mgmt", "rep", "phone"] as const;
export type PartWho = typeof PART_WHO[number];
export type AskPart = { part: string; source: PartSource; certainty: PartCertainty; route: "reply" | "promise" | "aix" | "none"; /** source=staff_only の時だけ */ who?: PartWho };

/** 今言える出所（会話・資料に書いてある値・会社の事実） */
const NOW_SOURCES: ReadonlySet<string> = new Set(["material_value", "company_fact"]);

/** 出力の指定に足す欄（asks[] の中・on の時だけ） */
export const ASK_PARTS_FIELD = `"parts": [{"part": "この依頼の中の1つの部分（20字以内）", "source": "material_value|company_fact|staff_only|none（答えに使う事実の出所・material_value＝会話・資料に書いてある値・staff_only＝管理会社・代表・電話でしか分からない）", "who": "source=staff_only の時だけ mgmt|rep|phone", "certainty": "assertable|basically|needs_check（言い切れる／基本的に／確認が要る）", "route": "reply|promise|aix|none"}]（依頼の中に今言える部分と確認が要る部分が混ざる時だけ2つ以上・混ざらない時は省く）`;

/** 決まりの1行（on の時だけ・読み方と実例の1組） */
export function askPartsRule(env?: Env): string {
  if (!askPartsSplitOn(env)) return "";
  return "- ★1つの依頼の中に、今言える部分（会話・資料に書いてある値＝material_value・会社の事実＝company_fact）と、確認が要る部分（管理会社・代表・電話でしか分からない＝staff_only）が混ざる時は、asks[].parts に部分ごとに分けて書く。今言える部分は route=\"reply\" で答え、確認が要る部分だけ route=\"promise\" か \"aix\"（全部を約束にしない・全部を返信で言い切らない）。実例: 「鍵交換は必須ですか？外せますか？」＝必須かは資料（material_value・reply）／外せるかは管理会社（staff_only・who=mgmt・aix）。「白い部屋で空いてますか？」＝色と空室は資料（reply）／白基調の代わりの部屋は探す（aix）。\n";
}

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
/** ブレインの parts を整える（形が崩れた部分は落とす・最大4つ）。無い・空なら undefined */
export function normalizeAskParts(raw: unknown): AskPart[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AskPart[] = [];
  for (const p of raw.slice(0, 6)) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const part = clip(o.part, 30);
    const source = String(o.source ?? "").trim() as PartSource;
    const route = String(o.route ?? "").trim() as AskPart["route"];
    if (!part || !(PART_SOURCES as readonly string[]).includes(source) || !["reply", "promise", "aix", "none"].includes(route)) continue;
    const c = String(o.certainty ?? "").trim() as PartCertainty;
    const w = String(o.who ?? "").trim() as PartWho;
    out.push({ part, source, certainty: (PART_CERTAINTIES as readonly string[]).includes(c) ? c : (source === "staff_only" ? "needs_check" : "basically"), route, ...(source === "staff_only" && (PART_WHO as readonly string[]).includes(w) ? { who: w } : {}) });
    if (out.length >= 4) break;
  }
  return out.length ? out : undefined;
}

/** 依頼が部分に分かれていて、今言える部分と確認が要る部分の両方がある */
export function askIsSplit(parts: readonly AskPart[] | null | undefined): boolean {
  const ps = parts ?? [];
  return ps.some((p) => NOW_SOURCES.has(p.source) && p.route === "reply") && ps.some((p) => p.source === "staff_only" && (p.route === "aix" || p.route === "promise"));
}

/** ブレインの parts が、どの依頼も全部 今言える（確認が要る部分が1つも無い）と言っている。parts が1つも無い時は null（分からない＝今まで通り） */
export function partsAllNow(asks: ReadonlyArray<{ parts?: readonly AskPart[] | null }> | null | undefined): boolean | null {
  const all = (asks ?? []).flatMap((a) => a.parts ?? []);
  if (!all.length) return null;
  return all.every((p) => NOW_SOURCES.has(p.source) && p.route !== "aix" && p.route !== "promise");
}

/** 作業員10・22 の文の側の出所の名前へ読み替える（material_value→material・none→general）。2026-11-13 統括役の決め: 読み替えは app/lib/answer-source.ts の1か所（ここはそれを呼ぶだけ） */
export function toComposeSource(s: PartSource, hint?: SourceHint): AnswerSourceKind {
  return fromBrainAnswerSource(s, hint).kind;
}
