// app/lib/takeuchi-anatomy.ts — 竹内さんの文の解剖（純関数: 選び方・下読みの指示と読み取り・決定論の札との照らし）
//
// 2026-11-03 作業員6（竹内さん KB P1「竹内さんの文の解剖」「実際の竹内送っている文の構成や要点もちゃんと理解できれば、より早く、より正確に質上がる」）。
//   1通ずつ: 場面・趣旨・一番の要点・奥の心配への答え・部品の順・なぜこの順か・答えずに省いた事とその理由。
//   下読みは DeepSeek（名札 reply_anatomy・伏せ済みの body と customer_gist だけ・出口の alt-pii-gate を通る）。
//   決定論の札（purposeOfText の趣旨・部品の並び）と食い違った所だけ見直す（anatomy_conflicts）。
//   使い道: ①構成のブレインの手本（近い場面で引く）②採点の物差し（趣旨・一番の要点・構成が竹内さんと同じか）。
// テスト: app/lib/__tests__/takeuchi-anatomy.test.ts
import { COMPOSE_PURPOSES, purposeOfText, type ComposePurpose, type SentenceTag } from "./compose-blueprint";

export type AnatomyPart = "greet" | "uke" | "main" | "add" | "cta" | "close";
export type Anatomy = {
  scene: string; purpose: ComposePurpose; main_point: string; worry_answer: string | null;
  parts: AnatomyPart[]; why_order: string; omitted: Array<{ what: string; why: string }>;
};

/** 場面×趣旨で偏りなく選ぶ（組ごとに上限 cap・新しい順・合計 total まで） */
export function pickBalanced<T extends { scene: string; purpose: string; sent_at: string }>(rows: ReadonlyArray<T>, total = 200, cap?: number): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) { const k = `${r.scene}|${r.purpose}`; const l = groups.get(k) ?? []; l.push(r); groups.set(k, l); }
  for (const l of groups.values()) l.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const per = cap ?? Math.max(3, Math.ceil(total / Math.max(1, groups.size)));
  const out: T[] = [];
  // 組を順に1通ずつ取る（少ない組も入る）
  for (let i = 0; i < per && out.length < total; i++) for (const l of groups.values()) { if (out.length >= total) break; if (l[i]) out.push(l[i]); }
  return out;
}

export const ANATOMY_SYSTEM = [
  "あなたは賃貸仲介会社の社長（竹内さん）の LINE の返信を読み解く担当です。1通ずつ、竹内さんがどう組み立てたかを書き出します（文は直さない）。",
  "書き出す物: scene（場面を短く）・purpose（appeal 訴求／support 不安を受け止める／promise 約束／inform 答え・説明／ask 聞く／ack 受けだけ のどれか）・",
  "main_point（一番の要点＝竹内さんがこの1通で一番伝えたい事を1文で）・worry_answer（お客様の奥の心配に答えた所。無ければ null）・",
  "parts（部品の順: greet 名前と挨拶／uke 受け／main メイン／add 添え／cta 誘い／close 締め）・why_order（なぜこの順か・1文）・",
  "omitted（お客様の発言の中で答えずに省いた事とその理由。無ければ []）。",
  "名前は YUMA、伏せた所は〈〉のまま。推測で事実を足さない。出力は JSON だけ: {\"scene\":\"…\",\"purpose\":\"…\",\"main_point\":\"…\",\"worry_answer\":\"…\"|null,\"parts\":[…],\"why_order\":\"…\",\"omitted\":[{\"what\":\"…\",\"why\":\"…\"}]}",
].join("\n");
/** 下読みに渡すのは伏せ済みの物だけ（body・customer_gist は takeuchi_compose_examples に伏せて置いた物） */
export function anatomyPrompt(o: { maskedCustomer: string | null; maskedBody: string; scene: string }): string {
  return `## 場面（決定論の札）\n${o.scene}\n\n## お客様の発言（伏せ済み）\n${(o.maskedCustomer ?? "（こちらから送った番）").slice(0, 300)}\n\n## 竹内さんの返信（伏せ済み）\n${o.maskedBody.slice(0, 500)}`;
}
const PARTS: readonly AnatomyPart[] = ["greet", "uke", "main", "add", "cta", "close"];
export function parseAnatomy(text: string): Anatomy | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (!(COMPOSE_PURPOSES as readonly string[]).includes(String(o.purpose))) return null;
    const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    return {
      scene: clip(o.scene, 40), purpose: o.purpose as ComposePurpose, main_point: clip(o.main_point, 120),
      worry_answer: o.worry_answer == null || String(o.worry_answer) === "null" ? null : clip(o.worry_answer, 120),
      parts: (Array.isArray(o.parts) ? o.parts : []).map(String).filter((p): p is AnatomyPart => (PARTS as readonly string[]).includes(p)).slice(0, 8),
      why_order: clip(o.why_order, 120),
      omitted: (Array.isArray(o.omitted) ? o.omitted : []).slice(0, 3).map((x) => ({ what: clip((x as { what?: unknown })?.what, 60), why: clip((x as { why?: unknown })?.why, 80) })).filter((x) => x.what),
    };
  } catch { return null; }
}
const TAG_TO_PART: Partial<Record<SentenceTag, AnatomyPart>> = { greet: "greet", opener: "greet", ack: "uke", thanks: "uke", close: "close", cta_viewing: "cta", cta_apply: "cta" };
/** 決定論の札と食い違った所（見直すのはここだけ） */
export function anatomyConflicts(a: Anatomy, body: string): string[] {
  const d = purposeOfText(body);
  const out: string[] = [];
  if (d.purpose !== "material" && d.purpose !== "decline" && d.purpose !== a.purpose) out.push(`趣旨: 札=${d.purpose}・下読み=${a.purpose}`);
  const detPartsHead = d.seq.map((t) => TAG_TO_PART[t] ?? "main").filter((p, i, arr) => arr[i - 1] !== p);
  const llmHead = a.parts.filter((p, i, arr) => arr[i - 1] !== p);
  if (detPartsHead[0] && llmHead[0] && detPartsHead[0] !== llmHead[0]) out.push(`書き出し: 札=${detPartsHead[0]}・下読み=${llmHead[0]}`);
  const detCta = detPartsHead.includes("cta"), llmCta = llmHead.includes("cta");
  if (detCta !== llmCta) out.push(`誘い: 札=${detCta ? "あり" : "なし"}・下読み=${llmCta ? "あり" : "なし"}`);
  return out;
}
