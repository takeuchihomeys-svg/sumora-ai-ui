// app/lib/pickup-search-spec.ts — 探す条件の1枚（#820 案B・純関数・2026-11-27 作業員A）
//
// 竹内さん 11/27「物件検索のお客さんの条件を入れる所…ブレインと AIX ツールを連動させて」→ 承認「その順で進める（推奨）」（台帳 #820）。
//   今: 【物件ピックアップした】の文は ブレインの時の写し（property_search_params）と DB の行で条件を書き、探す方は 探す時の DB の行＋今回だけの上書き（search_override）で探す。
//   出所が2つ＝今回だけの条件は探されるのに文に出ない・ブレインの後に P4・橋が書くと文の「最新」が古くなる。
//   直し: 探す命令を積む時に「探す条件の1枚」を作り、命令（automation_commands.payload.pickup_spec）に残す。文はその1枚を読む（無ければ今のまま）。
//   あわせて、条件の欄ごとに最後に書いた書き手（property_condition_history の source_message_id の書き手の札）と、
//   同じ時に2つ以上の書き手が書いた欄（仲裁 applyConditionWriteArbiter が既定 off の穴）を1枚に残す＝仲裁を on にするかを記録で決める（統括役 11/27）。
// スイッチ PICKUP_SPEC_SHARED（既定 off＝命令にも文にも何も足さない）。印 pickup_spec（作った）・pickup_spec_mismatch（文と探した条件が違った欄の数）。
// 新しい列は無い（payload は jsonb・ピックアップの行は search_command_id で命令につながる）＝migrate-schema の変更は要らない。
import type { RegisteredConditions, SearchOverride } from "./search-override";
import { parseConditionSource, type ConditionWriter } from "./condition-history";
import { stagedOn, STAGE_OFF } from "./switch-stage";

type Env = Record<string, string | undefined>;
// 2026-11-27 作業員A（竹内さんの決め 11/27「これから on にする部品は段階で読む」・stage-coverage の点検）: 今の読み（=== "on"）と同じ答えを段階で読む＝夜の見張りが1段戻せる
export const pickupSpecSharedOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("PICKUP_SPEC_SHARED", env, STAGE_OFF);

/** 文に出す欄（登録の行の写し・探す欄より広い＝入居・こだわり・NG・その他も） */
export type SpecRow = RegisteredConditions & { move_in_time?: string | null; preferences?: string | null; ng_points?: string | null; other_requests?: string | null };
export type EffectiveConditions = {
  desired_area: string | null; floor_plan: string | null; rent_max: number | null; rent_min: number | null; walk_minutes: number | null; building_age: number | null;
  floor_area_min: number | null; pet: boolean | null; move_in_time: string | null; preferences: string | null; ng_points: string | null; other_requests: string | null;
  /** 今回だけの上書きで変わった欄 */
  temp: string[];
};
const yen = (n: unknown) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? v : null; };

/** 登録の条件＋今回だけの上書き＝この回に探す条件（上書きの書いた欄だけ今回の値） */
export function effectiveConditions(row: SpecRow | null | undefined, ov: SearchOverride | null | undefined): EffectiveConditions {
  const r = row ?? {};
  const temp: string[] = [];
  const pick = <T>(key: string, base: T, over: T | null | undefined): T => { if (over != null) { temp.push(key); return over as T; } return base; };
  let area = r.desired_area ?? null;
  const loc = ov?.location ?? null;
  if (loc) {
    const names = [...loc.stations.map((s) => `${s}駅`), ...loc.lines.map((l) => `${l}沿い`), ...loc.areas];
    if (names.length) { area = loc.mode === "add" && area ? `${area}・${names.join("・")}` : names.join("・"); temp.push("desired_area"); }
  }
  return {
    desired_area: area,
    floor_plan: pick("floor_plan", r.floor_plan ?? null, ov?.floor_plan),
    rent_max: pick("rent_max", yen(r.rent_max), yen(ov?.rent_max)),
    rent_min: pick("rent_min", yen(r.rent_min), yen(ov?.rent_min)),
    walk_minutes: pick("walk_minutes", r.walk_minutes ?? null, ov?.walk_minutes ?? null),
    building_age: pick("building_age", r.building_age ?? null, ov?.building_age ?? null),
    floor_area_min: pick("floor_area_min", r.floor_area_min ?? null, ov?.area_min ?? null),
    pet: ov?.pet ? (temp.push("pet"), true) : (r.pet ?? null),
    move_in_time: r.move_in_time ?? null, preferences: r.preferences ?? null, ng_points: r.ng_points ?? null, other_requests: r.other_requests ?? null,
    temp,
  };
}
const man = (y: number) => `${Math.round(y / 1000) / 10}`;
/** 文に渡す条件の1行（aix-template-generate の「希望条件（DB）」と同じ形・今回だけの欄に（今回だけ）） */
export function specConditionsText(e: EffectiveConditions): string {
  const t = (k: string) => (e.temp.includes(k) ? "（今回だけ）" : "");
  return [
    e.desired_area ? `エリア: ${e.desired_area}${t("desired_area")}` : "",
    e.floor_plan ? `間取り: ${e.floor_plan}${t("floor_plan")}` : "",
    e.rent_max ? `家賃上限: ${man(e.rent_max)}万円${t("rent_max")}` : "",
    e.walk_minutes ? `駅徒歩: ${e.walk_minutes}分以内${t("walk_minutes")}` : "",
    e.building_age ? `築年数: ${e.building_age}年以内${t("building_age")}` : "",
    e.floor_area_min ? `広さ: ${e.floor_area_min}㎡以上${t("floor_area_min")}` : "",
    e.pet ? `ペット可${t("pet")}` : "",
    e.move_in_time ? `入居希望: ${e.move_in_time}` : "",
    e.preferences ? `希望: ${e.preferences}` : "",
    e.ng_points ? `NG条件: ${e.ng_points}` : "",
    e.other_requests ? `その他: ${e.other_requests}` : "",
  ].filter(Boolean).join(" / ").slice(0, 1000);
}

// ── 書き手（統括役 11/27 ③: どの書き手が最後に勝ったか） ──────────────
export type HistoryRow = { changed_field: string; source_message_id: string | null; created_at: string; new_value?: string | null };
export type FieldWriter = { writer: ConditionWriter | "unknown"; at: string };
/** 同じ時（既定 10分の内）に書いたと見る幅 */
export const SAME_TIME_MS = 10 * 60_000;
/** 欄ごとの最後の書き手と、最後の書き込みと同じ時に別の書き手も書いた欄（争った欄） */
export function lastWritersOf(history: readonly HistoryRow[], sameTimeMs = SAME_TIME_MS): { writers: Record<string, FieldWriter>; contested: Array<{ field: string; writers: string[]; winner: string }> } {
  const byField = new Map<string, HistoryRow[]>();
  for (const h of history) byField.set(h.changed_field, [...(byField.get(h.changed_field) ?? []), h]);
  const writers: Record<string, FieldWriter> = {};
  const contested: Array<{ field: string; writers: string[]; winner: string }> = [];
  for (const [field, rows] of byField) {
    const asc = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const last = asc[asc.length - 1];
    const w = (h: HistoryRow) => parseConditionSource(h.source_message_id).writer ?? "unknown";
    writers[field] = { writer: w(last), at: last.created_at };
    const near = asc.filter((h) => Date.parse(last.created_at) - Date.parse(h.created_at) <= sameTimeMs);
    const names = [...new Set(near.map(w))];
    if (names.length >= 2) contested.push({ field, writers: names, winner: w(last) });
  }
  return { writers, contested };
}

export type PickupSearchSpec = { v: 1; at: string; customer_id: string; effective: EffectiveConditions; text: string; override: SearchOverride | null; writers: Record<string, FieldWriter>; contested: Array<{ field: string; writers: string[]; winner: string }> };
/** 探す命令を積む時の1枚（命令の payload.pickup_spec に入れる） */
export function buildPickupSearchSpec(o: { customerId: string; row: SpecRow | null; override: SearchOverride | null; history?: readonly HistoryRow[]; nowIso: string }): PickupSearchSpec {
  const effective = effectiveConditions(o.row, o.override);
  const { writers, contested } = lastWritersOf(o.history ?? []);
  return { v: 1, at: o.nowIso, customer_id: o.customerId, effective, text: specConditionsText(effective), override: o.override ?? null, writers, contested };
}
/** 命令の payload から読む（形が違えば null） */
export function readPickupSpec(x: unknown): PickupSearchSpec | null {
  const s = x as PickupSearchSpec | null;
  return s && s.v === 1 && typeof s.text === "string" && s.effective ? s : null;
}

// ── 文と探した条件の照らし（印 pickup_spec_mismatch・書き換えはしない） ──
/** AIX の文に書いた家賃の上限・間取りが、探した条件と違う欄（文に書いていない欄は見ない） */
export function specTextMismatch(spec: PickupSearchSpec, aixText: string): string[] {
  const t = String(aixText ?? "").normalize("NFKC");
  const out: string[] = [];
  const e = spec.effective;
  if (e.rent_max) {
    const m = t.match(/家賃[^。\n]{0,10}?(\d{1,2}(?:\.\d)?)\s*万(?:円)?(?:以内|以下|まで|上限)/);
    if (m && Math.abs(Number(m[1]) - e.rent_max / 10000) > 0.05) out.push("rent_max");
  }
  if (e.floor_plan) {
    const want = new Set((e.floor_plan.toUpperCase().match(/[1-4](?:SLDK|LDK|SDK|DK|K)|1R|ワンルーム/g) ?? []));
    const said = (t.toUpperCase().match(/[1-4](?:SLDK|LDK|SDK|DK|K)(?=[^0-9]|$)/g) ?? []).filter((x) => !/号/.test(x));
    if (said.length && want.size && !said.some((x) => want.has(x)) && !/以上/.test(e.floor_plan)) out.push("floor_plan");
  }
  return out;
}
