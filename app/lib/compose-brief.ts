// app/lib/compose-brief.ts — 文の統括の指示書（COMPOSE_BRIEF）・書いた後の確かめ（疑いの印）・文の自信の印・書き手との連携の表
//   純関数・DB/LLM なし・既定 off（off＝何も作らない／shadow・on＝記録だけ・書き手への指示文にも本文にも足さない＝出口は増やさない）
//   作業員10・2026-11-12 統括役（竹内さん「ブレインの統括の質のように、返信の質の統括も上げていく。細部まで」）
//
// ■ ブレインの統括（作業員22 の CONDUCTOR_BRIEF・conductor-brief.ts / conductor-doubt.ts）と同じ形にそろえる:
//   指示書（何を書くかを1か所に）→ 確かめる段（下の役＝書き手の答えを指示書と突き合わせる・決め直さない）→ 自信の印（high/mid/low）
//   名前: 未＝BRIEF_NONE「未」・疑いは { kind, why }・確かさは "high" | "mid" | "low"・線は SURE_LINE と同じ形
//
// ■ ① 指示書の欄（ComposeBrief）
//   roles     この通の役目の並び（主→従・takeuchi-anatomy-roles の13種）……compose-sentence-plan の設計図
//   aim       この通の役目の行（compose-vocab の COMPOSE_AIM_TABLE の id）……主の役目＋誘導先（NEXT_DEST）
//   values    各文に入れる値（差し込み表・compose-value-slots）
//   facts     使う事実の id と出所（f1… は turn_contract.asks の答え・v:<欄> は資料から読んだ値・cb:<n> はブレインの統括の facts）
//   keyPoint  押さえる要点（7つの欄の key_point → judge_basis.key_point → main_point）
//   closing   締め（compose-value-slots の決め表・COMPOSE_CLOSING の名前）
//   dates     期日の言葉（材料にある日付・時期の言葉だけ。無ければ「期日を書かない」＝OMIT deadline_promise と同じ線）
//   skeleton  言い方の骨（要素ごとの言葉の型の id・答えの出所の書き方）
//   shape     長さ（文の数）・絵文字（😊 😌 🌟 ✨ だけ・feedback_emoji_allowlist）
//   propertyName 物件名を出すか（compose-order-table の propertyNameRule）
// ■ ② 書いた後の確かめ（draftDoubts）: 下書きを指示書と突き合わせて疑いの印を記録（本文は書き換えない）
// ■ ③ 文の自信の印（composeSure）: 書き手の外れやすい型・値が材料に無い・骨が無い・疑いの数
// ■ ④ 連携の表（COMPOSE_WRITER_LINK・linkReport）: 指示書のどの欄が書き手の指示文のどの行に届くか・届いたか

import type { SentenceRole } from "./takeuchi-anatomy-roles";
import type { SentencePlan, SevenFields } from "./compose-sentence-plan";
import { aimOf, type ComposeAimId } from "./compose-vocab";
import { toNextDest, type NextDest } from "./next-move-types";
import { appealValuePlan, readValues, decideClosing, toComposeClosing, answerSourceOf, applyStrengthFromFacts, hookOf, type ClosingDecision, type AnswerSource } from "./compose-value-slots";
import { pickElementTypes, elementCuesOf, propertyNameRule } from "./compose-order-table";
import { classifySentence } from "./writing-blueprint";

type Env = Record<string, string | undefined>;
export type ComposeBriefMode = "off" | "shadow";
export function composeBriefMode(env: Env = typeof process !== "undefined" ? process.env : {}): ComposeBriefMode {
  const v = String(env.COMPOSE_BRIEF ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}
export const BRIEF_NONE = "未" as const;
type Missing<T> = T | typeof BRIEF_NONE;

export type BriefFactRef = { id: string; value: string; from: "会話" | "資料" | "会社の事実" | "一般" | "物件の記録" | "ブレインの統括" | "要確認" };
export type ComposeBrief = {
  roles: Array<{ rank: "main" | "sub"; role: SentenceRole }>;
  aim: Missing<{ id: ComposeAimId; dest: NextDest | null }>;
  values: Missing<string[][]>;
  facts: BriefFactRef[];
  keyPoint: Missing<string>;
  closing: { name: ReturnType<typeof toComposeClosing>; why: string[] };
  dates: string[];
  skeleton: { elements: string[]; answerSource: AnswerSource | null };
  shape: { sentences: number; emoji: readonly string[] };
  propertyName: Missing<{ say: boolean; why: string }>;
  /** ブレインの統括の指示書（meta.conductor_brief）から受け取った欄 */
  fromConductor: string[];
  notYet: string[];
};
export const EMOJI_ALLOW = ["😊", "😌", "🌟", "✨"] as const;

/** ブレインの統括の指示書（作業員22 CONDUCTOR_BRIEF）から受け取る欄の表 */
export const BRIEF_INTAKE: ReadonlyArray<{ conductor: string; compose: keyof ComposeBrief; how: string }> = [
  { conductor: "main（主の要件）", compose: "roles", how: "主の行の役目を決める材料（設計図が既に turn_contract から作る・食い違いは疑いの印へ）" },
  { conductor: "facts（答えに使う事実と出所）", compose: "facts", how: "cb:<n> の id で事実の一覧に足す（出所はそのまま）" },
  { conductor: "aim.keyPoint（押さえる要点）", compose: "keyPoint", how: "7つの欄の要点が無い時だけ使う" },
  { conductor: "next（次の一手・dest/strength）", compose: "closing", how: "締めの誘い（内覧・申込）の行き先と強さ" },
  { conductor: "type（確認の順番の型）", compose: "roles", how: "従の並び（compose-order-table の順の表）" },
  { conductor: "doubts（疑いの印）", compose: "notYet", how: "ブレインの側の疑いがある番は文の自信を下げる（③）" },
  { conductor: "sure（番の確かさ）", compose: "notYet", how: "low の番は文の自信も low にする（③）" },
];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const BASIS_FROM: Record<string, BriefFactRef["from"]> = { conversation: "会話", material: "資料", company_fact: "会社の事実", general: "一般" };
/** 期日の言葉（材料にある物だけを拾う型） */
export const DATE_WORD_RE = /本日中|明日中?|明後日|今週中|来週中?|今月中|来月|\d{1,2}月(?:\d{1,2}日|上旬|中旬|下旬|末|頃|ごろ)?|\d{1,2}日(?:\([^)]\))?|[月火水木金土日]曜日?/g;
export function dateWordsOf(text: string): string[] {
  return [...new Set((String(text ?? "").normalize("NFKC").match(DATE_WORD_RE) ?? []).map((x) => x.trim()))];
}

export type BriefInput = { plan: SentencePlan; s7: SevenFields; meta: unknown; scene: string | null; customerText: string; materialText: string; recentStaffTexts: string[]; firstContact?: boolean };
export function buildComposeBrief(i: BriefInput): ComposeBrief {
  const m = obj(i.meta) ?? {};
  const notYet: string[] = [];
  const roles = i.plan.rows.map((r) => ({ rank: r.rank, role: r.role }));
  const main = roles.find((r) => r.rank === "main")?.role ?? roles[0]?.role ?? null;
  const dest = toNextDest(i.s7.leadTo ?? null, "lead_to");
  const aimRow = main ? aimOf({ role: main }, dest) : null;
  if (!aimRow) notYet.push("aim");
  // 事実
  const tc = obj(m.turn_contract);
  const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map(obj).filter((a): a is Record<string, unknown> => !!a) : [];
  const facts: BriefFactRef[] = [];
  asks.forEach((a, k) => { const v = str(a.answer, 50); if (v) facts.push({ id: `f${k + 1}`, value: v, from: a.route === "promise" ? "要確認" : BASIS_FROM[String(a.basis)] ?? "会話" }); });
  const vals = readValues(i.materialText);
  for (const [k, v] of Object.entries(vals)) facts.push({ id: `v:${k}`, value: v!, from: "資料" });
  const cb = obj(m.conductor_brief);
  const fromConductor: string[] = [];
  if (cb) {
    const cf = Array.isArray(cb.facts) ? (cb.facts as unknown[]).map(obj).filter((x): x is Record<string, unknown> => !!x) : [];
    cf.forEach((f, k) => { const v = str(f.value, 50); if (v && !facts.some((x) => x.value === v)) facts.push({ id: `cb:${k + 1}`, value: v, from: "ブレインの統括" }); });
    for (const r of BRIEF_INTAKE) { const key = r.conductor.split("（")[0].split(".")[0]; if (cb[key] !== undefined && cb[key] !== BRIEF_NONE) fromConductor.push(key); }
  }
  // 要点
  const jb = obj(m.judge_basis);
  const keyPoint = i.s7.keyPoint ?? str(jb?.key_point, 80) ?? str(obj(cb?.aim)?.keyPoint, 80) ?? str(m.main_point, 80);
  if (!keyPoint) notYet.push("keyPoint");
  // 値（訴求）
  const appeal = i.s7.appeal ? appealValuePlan({ materialText: i.materialText, topText: [i.customerText, i.s7.appeal.what ?? ""].join("\n") }) : null;
  const values = appeal && appeal.sentences.length ? appeal.sentences.map((s) => s.map((x) => x.value)) : BRIEF_NONE;
  // 締め
  const cues = elementCuesOf(i.meta);
  const roleList = roles.map((r) => r.role);
  const apply = dest === "apply" || roleList.includes("apply") ? applyStrengthFromFacts(i.materialText, null) : null;
  const closing: ClosingDecision = decideClosing({
    scene: i.scene, dest, strength: apply?.strength ?? null, hook: hookOf(i.meta),
    propertyState: cues.notViewable || /退去予定/.test(i.materialText) ? "vacating" : i.s7.appeal?.property ? "viewable" : "none",
    sentThisTurn: false, considering: /検討/.test(i.customerText), urgent: cues.kinds.includes("K15"),
    sentenceCount: roles.length, firstContact: !!i.firstContact, customerAsked: /[?？]|ですか|ますか/.test(i.customerText),
    lastRole: [...roleList].reverse().find((r) => r !== "close") ?? null,
  });
  // 期日の言葉は材料（事実・資料）にある物だけ
  const dates = dateWordsOf([...facts.map((f) => f.value), i.materialText, i.customerText, ...i.recentStaffTexts.slice(-5)].join("\n"));
  const elem = pickElementTypes(i.meta);
  const leadAsk = asks[typeof tc?.lead_with === "number" ? (tc.lead_with as number) : 0] ?? null;
  const pn = i.s7.appeal?.property ?? null;
  const propertyName = pn ? propertyNameRule({ property: pn, customerText: i.customerText, recentStaffTexts: i.recentStaffTexts.slice(-3) }) ?? BRIEF_NONE : BRIEF_NONE;
  return {
    roles, aim: aimRow ? { id: aimRow.id, dest } : BRIEF_NONE, values, facts, keyPoint: keyPoint ?? BRIEF_NONE,
    closing: { name: toComposeClosing(closing), why: closing.why }, dates,
    skeleton: { elements: [...elem.push_line, ...elem.trust, ...elem.latent_line], answerSource: answerSourceOf(leadAsk) },
    shape: { sentences: roles.length, emoji: EMOJI_ALLOW }, propertyName, fromConductor, notYet,
  };
}

// ─── ② 書いた後の確かめ（疑いの印・記録だけ） ─────────────────────────────
export const DRAFT_DOUBT_KINDS = ["key_point_missing", "fact_added", "role_order", "closing_mismatch", "date_word", "value_missing", "emoji_out", "property_name"] as const;
export type DraftDoubtKind = typeof DRAFT_DOUBT_KINDS[number];
export const DRAFT_DOUBT_LABEL: Record<DraftDoubtKind, string> = {
  key_point_missing: "要点が入っていない", fact_added: "指示書に無い事実（金額・数）を足した", role_order: "役目の順が違う", closing_mismatch: "締めが違う",
  date_word: "材料に無い期日の言葉", value_missing: "推す値が入っていない", emoji_out: "使わない絵文字", property_name: "物件名の出し方が違う",
};
export type DraftDoubt = { kind: DraftDoubtKind; why: string };
const PART_OF_ROLE: Partial<Record<SentenceRole, string>> = { answer: "answer", worry: "answer", promise: "promise", keep: "promise", viewing: "invite", apply: "invite", estimate: "invite", ask_send: "invite", trust: "support", uke: "ack", close: "closing" };
const sentencesOf = (t: string) => String(t ?? "").split(/\n+|(?<=[。！!？?])(?=[^！!。？?])/).map((s) => s.trim()).filter(Boolean);
const keyTokens = (k: string) => (k.normalize("NFKC").match(/[一-龯ァ-ヶー]{2,}|\d[\d,.]*/g) ?? []).filter((x) => !/^(?:こと|ため|お客様|返信|伝える|答える|する)$/.test(x));
export function closingOfText(text: string): ReturnType<typeof toComposeClosing> {
  const L = sentencesOf(text); const tail = L.slice(-3).join("\n"), last = L[L.length - 1] ?? "";
  if (/お申込(?:み)?[^\n]{0,30}(?:抑|押)|お部屋(?:抑|押)え/.test(tail)) return "apply_cta";
  if (/ご内覧|ご案内させて|お日にち|ご都合/.test(tail)) return "viewing_cta";
  return /何卒/.test(last) ? "nanitozo" : /ご査収/.test(last) ? "receipt" : /お気軽に|いつでも/.test(last) ? "kigaru" : "none";
}
export function draftDoubts(b: ComposeBrief, draft: string): DraftDoubt[] {
  const d = String(draft ?? "").normalize("NFKC");
  const out: DraftDoubt[] = [];
  if (b.keyPoint !== BRIEF_NONE) {
    const tk = keyTokens(b.keyPoint);
    if (tk.length && !tk.some((x) => d.includes(x))) out.push({ kind: "key_point_missing", why: `要点「${b.keyPoint.slice(0, 30)}」の語が1つも無い` });
  }
  const known = [...b.facts.map((f) => f.value), ...(b.values === BRIEF_NONE ? [] : b.values.flat())].join("\n").normalize("NFKC").replace(/,/g, "");
  const nums = (d.match(/\d[\d,]*(?:\.\d+)?\s*(?:円|万円|帖|㎡|m2|ヶ月|か月|分)/g) ?? []).map((x) => x.replace(/[,\s]/g, ""));
  const added = nums.filter((x) => !known.includes(x.replace(/円$|万円$|帖$|㎡$|m2$|ヶ月$|か月$|分$/, "")));
  if (added.length) out.push({ kind: "fact_added", why: `指示書の事実・値に無い数: ${added.slice(0, 3).join("・")}` });
  const mainRole = b.roles.find((r) => r.rank === "main")?.role ?? null;
  const parts = sentencesOf(d).map(classifySentence);
  const mp = mainRole ? PART_OF_ROLE[mainRole] : null;
  if (mp && mp !== "invite") {
    const iMain = parts.indexOf(mp as never), iInv = parts.indexOf("invite" as never);
    if (iMain < 0) out.push({ kind: "role_order", why: `主の役目（${mainRole}）の段が無い` });
    else if (iInv >= 0 && iInv < iMain) out.push({ kind: "role_order", why: "誘いが主の文より先" });
  }
  const c = closingOfText(d);
  if (c !== b.closing.name) out.push({ kind: "closing_mismatch", why: `指示書 ${b.closing.name}・下書き ${c}` });
  const dw = dateWordsOf(d).filter((x) => !b.dates.includes(x));
  if (dw.length) out.push({ kind: "date_word", why: `材料に無い期日の言葉: ${dw.slice(0, 3).join("・")}` });
  if (b.values !== BRIEF_NONE) { const first = b.values[0] ?? []; if (first.length && !first.some((v) => d.includes(v.replace(/^家賃管理費込/, "").replace(/円$/, "")))) out.push({ kind: "value_missing", why: `1文目の値（${first.join("・")}）が1つも無い` }); }
  const emo = (d.match(/\p{Extended_Pictographic}/gu) ?? []).filter((e) => !(EMOJI_ALLOW as readonly string[]).includes(e));
  if (emo.length) out.push({ kind: "emoji_out", why: `使わない絵文字: ${[...new Set(emo)].join("")}` });
  return out;
}

// ─── ③ 文の自信の印 ──────────────────────────────────────────────────────
export type Sure = "high" | "mid" | "low";
export const COMPOSE_SURE_CUES = [
  { key: "weak_type", w: 2, why: "書き手の外れやすい型（53番の物差しで当たりが低い型 T4 押さえ方・T6/T7 信頼）" },
  { key: "value_not_in_material", w: 2, why: "訴求の番なのに材料から値が1つも読めない（値を作りやすい）" },
  { key: "no_skeleton", w: 1, why: "言い方の骨（要素の型・答えの出所）が無い" },
  { key: "no_key_point", w: 1, why: "押さえる要点が無い" },
  { key: "conductor_low", w: 2, why: "ブレインの統括の番の確かさが low" },
  { key: "draft_doubts", w: 1, why: "書いた後の疑いの印（1つにつき）" },
] as const;
export type ComposeSureKey = typeof COMPOSE_SURE_CUES[number]["key"];
export const COMPOSE_SURE_LINE = { mid: 2, low: 4 } as const;
export const WEAK_ORDER_TYPES: ReadonlySet<string> = new Set(["T4", "T6", "T7"]);
export function composeSure(b: ComposeBrief, o: { orderType: string | null; appealAsked: boolean; conductorSure?: string | null; doubts: DraftDoubt[] }): { level: Sure; score: number; cues: ComposeSureKey[] } {
  const cues: ComposeSureKey[] = [];
  if (o.orderType && WEAK_ORDER_TYPES.has((o.orderType.match(/^T\d+/) ?? [""])[0])) cues.push("weak_type");
  if (o.appealAsked && b.values === BRIEF_NONE) cues.push("value_not_in_material");
  if (!b.skeleton.elements.length && !b.skeleton.answerSource) cues.push("no_skeleton");
  if (b.keyPoint === BRIEF_NONE) cues.push("no_key_point");
  if (o.conductorSure === "low") cues.push("conductor_low");
  let score = cues.reduce((s, k) => s + COMPOSE_SURE_CUES.find((c) => c.key === k)!.w, 0);
  if (o.doubts.length) { cues.push("draft_doubts"); score += o.doubts.length; }
  return { level: score >= COMPOSE_SURE_LINE.low ? "low" : score >= COMPOSE_SURE_LINE.mid ? "mid" : "high", score, cues };
}

// ─── ④ 書き手との連携の表 ────────────────────────────────────────────────
/** 指示書の欄 → 書き手の指示文のどの行に届くか（その行の頭の言葉で届いたかを見る） */
export const COMPOSE_WRITER_LINK: ReadonlyArray<{ field: keyof ComposeBrief; target: string; mark: RegExp; via: string }> = [
  { field: "roles", target: "文の構成の設計図の行（主→従）", mark: /主の文|従の文|役目/, via: "COMPOSE_SENTENCE_PLAN" },
  { field: "values", target: "推す値の行", mark: /- 推す値/, via: "COMPOSE_VALUE_SLOTS" },
  { field: "closing", target: "締めの行", mark: /- 締め:/, via: "COMPOSE_CLOSING_TABLE" },
  { field: "skeleton", target: "言葉の型・答えの書き方の行", mark: /この番に合う言葉の型|答えの書き方/, via: "COMPOSE_ELEMENT_TYPES・COMPOSE_VALUE_SLOTS" },
  { field: "propertyName", target: "物件名の行", mark: /- 物件名:/, via: "COMPOSE_NAME_PROPERTY_RULE" },
  { field: "keyPoint", target: "設計図の要点（主の行のどの部分）", mark: /要点|押さえ/, via: "COMPOSE_SENTENCE_PLAN" },
  { field: "facts", target: "（届く行が無い・材料の段で渡っている）", mark: /$^/, via: "-" },
  { field: "dates", target: "（届く行が無い）", mark: /$^/, via: "-" },
  { field: "shape", target: "（届く行が無い・長さは writing-blueprint の長さの行）", mark: /$^/, via: "-" },
];
export function linkReport(b: ComposeBrief, writerNote: string): Array<{ field: string; target: string; has: boolean; reached: boolean }> {
  const has = (f: keyof ComposeBrief) => { const v = b[f] as unknown; return !(v === BRIEF_NONE || v == null || (Array.isArray(v) && !v.length)); };
  return COMPOSE_WRITER_LINK.map((l) => ({ field: String(l.field), target: l.target, has: has(l.field), reached: has(l.field) && l.mark.test(writerNote) }));
}

export function composeBriefDigest(b: ComposeBrief, extra: { doubts?: DraftDoubt[]; sure?: { level: Sure } | null; link?: Array<{ has: boolean; reached: boolean }> } = {}): string {
  const reached = extra.link ? `${extra.link.filter((x) => x.reached).length}/${extra.link.filter((x) => x.has).length}` : "-";
  return `cb2:役目=${b.roles.map((r) => r.role).join(">")}｜aim=${b.aim === BRIEF_NONE ? "未" : b.aim.id}｜事実=${b.facts.length}｜値=${b.values === BRIEF_NONE ? "未" : b.values.flat().length}｜締め=${b.closing.name}｜期日=${b.dates.length}｜骨=${b.skeleton.elements.length}${b.skeleton.answerSource ? "+" + b.skeleton.answerSource : ""}｜疑い=${(extra.doubts ?? []).map((d) => d.kind).join(",") || "-"}｜自信=${extra.sure?.level ?? "-"}｜届いた=${reached}`;
}
