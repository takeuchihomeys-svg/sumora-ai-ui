// app/lib/takeuchi-anatomy.ts — 竹内さんの文の解剖（純関数: 選び方・下読みの指示と読み取り・決定論の札との照らし）
//
// 2026-11-03 作業員6（竹内さん KB P1「竹内さんの文の解剖」「実際の竹内送っている文の構成や要点もちゃんと理解できれば、より早く、より正確に質上がる」）。
//   1通ずつ: 場面・趣旨・一番の要点・奥の心配への答え・部品の順・なぜこの順か・答えずに省いた事とその理由。
//   下読みは DeepSeek（名札 reply_anatomy・伏せ済みの body と customer_gist だけ・出口の alt-pii-gate を通る）。
//   決定論の札（purposeOfText の趣旨・部品の並び）と食い違った所だけ見直す（anatomy_conflicts）。
//   使い道: ①構成のブレインの手本（近い場面で引く）②採点の物差し（趣旨・一番の要点・構成が竹内さんと同じか）。
// テスト: app/lib/__tests__/takeuchi-anatomy.test.ts
import { COMPOSE_PURPOSES, purposeOfText, type ComposePurpose, type SentenceTag } from "./compose-blueprint";
import { FOCUS_KINDS, FOCUS_LABEL, type Focus } from "./conductor-focus";

export type AnatomyPart = "greet" | "uke" | "main" | "add" | "cta" | "close";
export type Anatomy = {
  scene: string; purpose: ComposePurpose; main_point: string; worry_answer: string | null;
  parts: AnatomyPart[]; why_order: string; omitted: Array<{ what: string; why: string }>;
  /** 2026-11-05 作業員5（KB P0 575a7cd5・統括役了承）: この番の重点と言葉の背景（TAKEUCHI_ANATOMY_FOCUS=on の時だけ読ませる・無い行は省く） */
  focus?: Focus | null; background?: string | null;
  /** 2026-11-05 作業員9の案（統括役・作業員5）: 書けたのに書かなかった事の札（決まった一覧から）と、継続の約束を添えたか（重点を読む時だけ） */
  skipped_types?: SkippedType[]; keep?: boolean | null;
};
/** 書けたのに書かなかった事の札（作業員9 14日の24通の型）。採点でそのまま数える */
export const SKIPPED_TYPES = ["hours", "restate_conditions", "restate_viewing", "cost_assert", "double_apology", "apply_promise", "deadline_promise", "keep_promise_absent"] as const;
export type SkippedType = typeof SKIPPED_TYPES[number];
/** 解剖に重点と背景も読ませる（既定 off）。on の間は anatomy が無い行と focus が無い行を新しい順に約1,000通まで読む */
export const anatomyFocusOn = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) => (env.TAKEUCHI_ANATOMY_FOCUS ?? "").trim().toLowerCase() === "on";

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
/** 重点と背景も書き出させる時の指示（ANATOMY_SYSTEM の後ろに足すだけ・元の項目は変えない）。種類の境目は 11/05 統括役の決定（竹内さんに確認中） */
export const ANATOMY_SYSTEM_FOCUS = [
  ANATOMY_SYSTEM,
  "追加で書き出す物（JSON に一緒に入れる）: background（言葉の背景＝お客様がなぜ今それを言ったか・言っていない心配や本音・段階と気持ち・前の約束や送った物との関係。40字以内・読める物だけ・無ければ null）・",
  `focus（竹内さんがこの番で一番大切にした事を次から1つ: ${FOCUS_KINDS.map((k) => `${k}=${FOCUS_LABEL[k]}`).join("／")}）。`,
  "境目: 内覧の希望に内覧の調整で応える＝close／日程の確定待ちで「確認します」と返す＝promise_make／受けだけの文でも前の約束を果たしている番（結果・物件・見積を送った直後の受け等）＝promise_keep／残念な報告も正直に答える番＝answer。迷ったら優先の段（正直→確認の約束→一つ一つに答える→即答→気持ち→次の一手→形）の上。",
  "skipped_types（書けたのに竹内さんが書かなかった型を次から当てはまる物だけ: hours=営業時間の一言／restate_conditions=条件の全部の復唱／restate_viewing=内覧の詳細の復唱／cost_assert=日割・割引の断言／double_apology=二重の謝罪／apply_promise=根拠の無い申込の約束／deadline_promise=時期の約束（明日中 等）／keep_promise_absent=継続の約束を添えなかった。無ければ []）・",
  "keep（継続の約束＝「新着で出次第お送り」「見つかるまで全力でサポート」等を添えたか true/false）。",
  "出力は JSON だけ（上の項目に \"background\"・\"focus\"・\"skipped_types\"・\"keep\" を足す）。",
].join("\n");
/** 下読みに渡すのは伏せ済みの物だけ（body・customer_gist は takeuchi_compose_examples に伏せて置いた物）。situation はその番の時点の状況の文 v2（あれば） */
export function anatomyPrompt(o: { maskedCustomer: string | null; maskedBody: string; scene: string; situation?: string | null }): string {
  return `## 場面（決定論の札）\n${o.scene}\n\n${o.situation ? `## その番の時点の状況（伏せ済み・決まった計算）\n${o.situation.slice(0, 500)}\n\n` : ""}## お客様の発言（伏せ済み）\n${(o.maskedCustomer ?? "（こちらから送った番）").slice(0, 300)}\n\n## 竹内さんの返信（伏せ済み）\n${o.maskedBody.slice(0, 500)}`;
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
      ...(o.focus !== undefined ? { focus: (FOCUS_KINDS as readonly string[]).includes(String(o.focus)) ? (String(o.focus) as Focus) : null } : {}),
      ...(o.skipped_types !== undefined ? { skipped_types: (Array.isArray(o.skipped_types) ? o.skipped_types : []).map(String).filter((x): x is SkippedType => (SKIPPED_TYPES as readonly string[]).includes(x)).filter((x, i, a) => a.indexOf(x) === i) } : {}),
      ...(o.keep !== undefined ? { keep: o.keep === true || o.keep === "true" ? true : o.keep === false || o.keep === "false" ? false : null } : {}),
      ...(o.background !== undefined ? { background: o.background == null || String(o.background) === "null" ? null : clip(o.background, 60) } : {}),
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
