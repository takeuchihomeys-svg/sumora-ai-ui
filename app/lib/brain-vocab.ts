// app/lib/brain-vocab.ts — ブレインの出力の欄の語彙を1つの表にまとめる（純関数・定数・変換だけ・DB/LLM なし・どこからも読まない）
//
// 2026-11-12 作業員17（統括役の決め: 主題は2段・条件の強さは must|want の2種・stage は出力欄の5種に統一・名前の合意は統括役）。
//   作業員19 の洗い出し（根B）: brain-core.ts の customer_concern の主題12種が「物件の性質」と「お金・手続き・事情」で混ざる／condition_change_type に入居時期・初期費用の上限・条件の強さが無い／
//   セーブデータの型（記録係の指示）に約束・見送り理由・条件の強さが無く、stage が4種（viewing 抜け）で出力欄の5種と食い違う。
//   置き方（道を引っぱらない）: 既存の欄の出力・指示文は変えない。ここは読み取り側の変換（旧→新）と、judge_basis の中に足す新しい軸（strength・scope・topic の2段）の名前だけ。
//   スイッチ: BRAIN_VOCAB（既定 off・shadow＝記録だけ）。配線は試験の後（今はこのファイルとテストと物差しだけ）。
type Env = Record<string, string | undefined>;
export const brainVocabMode = (env: Env = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" => ((env.BRAIN_VOCAB ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "off");

// ── 主題（2段）──────────────────────────────────────────────
export const TOPIC_GROUPS = ["property", "money_procedure"] as const;
export type TopicGroup = typeof TOPIC_GROUPS[number];
export type TopicDef = { key: string; group: TopicGroup; label: string; /** 物件ごとに管理会社・貸主で確かめる事＝スタッフだけが知る（AIX の番になり得る）。aix-confirm-items の staffFact と同じ向き */ staffFact: boolean };
export const TOPICS = [
  { key: "floor", group: "property", label: "階数", staffFact: false },
  { key: "age", group: "property", label: "築年数", staffFact: false },
  { key: "walk", group: "property", label: "駅距離", staffFact: false },
  { key: "size", group: "property", label: "広さ", staffFact: false },
  { key: "sun", group: "property", label: "日当たり", staffFact: false },
  { key: "equip", group: "property", label: "設備", staffFact: false },
  { key: "noise", group: "property", label: "騒音治安", staffFact: false },
  { key: "cost", group: "money_procedure", label: "費用", staffFact: false },
  { key: "screening", group: "money_procedure", label: "審査", staffFact: false },
  { key: "pet_parking", group: "money_procedure", label: "ペット駐車場", staffFact: true },
  { key: "timing", group: "money_procedure", label: "時期", staffFact: false },
  { key: "household", group: "money_procedure", label: "家族構成", staffFact: false },
] as const satisfies readonly TopicDef[];
export type TopicKey = typeof TOPICS[number]["key"];
export const TOPIC_KEYS = TOPICS.map((t) => t.key) as readonly TopicKey[];
/** 旧12種（customer_concern.topic の日本語）→ 新しい名前 */
export const OLD_TOPIC_TO_KEY: Readonly<Record<string, TopicKey>> = Object.fromEntries(TOPICS.map((t) => [t.label, t.key])) as Record<string, TopicKey>;
export function normalizeTopic(raw: unknown): (TopicDef & { from: "old" | "new" }) | null {
  const s = String(raw ?? "").trim();
  const byKey = TOPICS.find((t) => t.key === s);
  if (byKey) return { ...byKey, from: "new" };
  const k = OLD_TOPIC_TO_KEY[s];
  const d = k ? TOPICS.find((t) => t.key === k) : null;
  return d ? { ...d, from: "old" } : null;
}

// ── 条件の変更（種類・強さ・範囲）────────────────────────────
/** 種類: 既存の7種（brain-core の condition_change_type）＋入居時期・初期費用の上限。条件の緩和は種類（強さではない・統括役 11/12） */
export const CONDITION_KINDS = ["area_change", "rent_change", "layout_change", "equip_add", "condition_relax", "pickup_request", "multi", "move_in", "initial_cost_cap"] as const;
export type ConditionKind = typeof CONDITION_KINDS[number];
/** 既存の欄に入っている値（出力の指定は変えない）。新しい種類は judge_basis の中だけで書く */
export const EXISTING_CONDITION_KINDS: readonly ConditionKind[] = ["area_change", "rent_change", "layout_change", "equip_add", "condition_relax", "pickup_request", "multi"];
/** 強さ（竹内さんの決め 11/05「要望の強さ」＝絶対／できれば） */
export const STRENGTH_KINDS = ["must", "want"] as const;
export type Strength = typeof STRENGTH_KINDS[number];
export const STRENGTH_LABEL: Record<Strength, string> = { must: "絶対（ここは外せない）", want: "できれば" };
/** 範囲（竹内さんの決め 11/10「言い直したら登録の条件そのものを直す」: ずっと／今回だけ） */
export const SCOPE_KINDS = ["permanent", "this_time"] as const;
export type CondScope = typeof SCOPE_KINDS[number];
export type ConditionChange = { kind: ConditionKind; strength: Strength | null; scope: CondScope | null; text: string };
const pick = <T extends string>(v: unknown, l: readonly T[]): T | null => { const s = String(v ?? "").trim() as T; return l.includes(s) ? s : null; };
export function normalizeConditionChange(raw: unknown): ConditionChange | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = pick(o.kind, CONDITION_KINDS);
  if (!kind) return null;
  return { kind, strength: pick(o.strength, STRENGTH_KINDS), scope: pick(o.scope, SCOPE_KINDS), text: String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 40) };
}

// ── 段（会話の進み）: 出力欄の5種に統一 ───────────────────────
export const STAGE_KINDS = ["hearing", "proposing", "viewing", "applying", "contract"] as const;
export type Stage = typeof STAGE_KINDS[number];
/** セーブデータの記録係の指示は4種（hearing/proposing/applying/contract・viewing 抜け）＝読み取りで5種に寄せる。内覧の調整〜内覧後は viewing */
export function normalizeStage(raw: unknown, o: { viewingActive?: boolean } = {}): Stage | null {
  const s = pick(raw, STAGE_KINDS);
  if (!s) return null;
  return s === "proposing" && o.viewingActive ? "viewing" : s;
}

// ── セーブデータの項目（足す案・記録係の指示は変えない）──────────
export const CHECKPOINT_EXTRA_FIELDS = ["promise", "pass_reason", "condition_strength"] as const;
export type CheckpointExtra = { promise: { who: "staff" | "customer"; what: string; by: string | null; open: boolean } | null; pass_reason: string | null; condition_strength: Record<string, Strength> | null };

// ── 重点・七つの欄との対応表（案・合意は統括役）───────────────────
import type { Focus } from "./conductor-focus";
import type { Need } from "./check-order";
/** 作業員10 の seven_read.lead → 重点（Focus）。lead は「次へつなげた先」・重点は「この番で一番大切にした事」で、lead だけでは重点は決まらない（候補の目安） */
export const LEAD_TO_FOCUS_HINT: Readonly<Record<string, Focus[]>> = {
  viewing: ["close"], apply: ["close"], estimate: ["promise_keep", "propose"], ask_send: ["propose"], keep: ["relation", "promise_make"], answer_only: ["answer", "ease"], none: ["relation"],
};
/** 主題 → 優先（16 の Need）の目安。費用・審査は answer か worry、staffFact の主題は confirm_promise が先 */
export const TOPIC_TO_NEED_HINT: Readonly<Record<TopicKey, Need[]>> = {
  floor: ["answer"], age: ["answer"], walk: ["answer"], size: ["answer"], sun: ["answer"], equip: ["answer", "confirm_promise"], noise: ["worry", "answer"],
  cost: ["answer", "worry"], screening: ["worry", "answer"], pet_parking: ["confirm_promise", "answer"], timing: ["answer", "next_move"], household: ["answer", "relation"],
};
