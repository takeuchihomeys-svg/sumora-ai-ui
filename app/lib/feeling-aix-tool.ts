// app/lib/feeling-aix-tool.ts — 統括の「次に送る物」（feeling-conductor-table）を AIX ツール（物件出し）への具体的な指示にする（純関数・import なし）
//   2026-11-15 作業員I（竹内さん 11/15「AIX ツールや LINE 統括の部分との連携もしっかり精密に・統括の強化」・統括役の追加の頼み）
//
// ■ 名前は揃える（import はしない＝型の輪と重さを作らない。名前は scripts/test-feeling-conductor-table.ts が突き合わせる）
//   AIX の種類 … aix-taxonomy の AIX_BUTTON_LABELS（property_recommendation＝物件オススメ・estimate_sheet・cost_explain・viewing_invite・meeting_place・application_push）
//   刺さった点 … our-send-uptake の HOOK_POINTS（作業員16・L の連携の地図の hook.point）
//   🌟の場面 … recommend-star-rank の StarSituation の鍵（zero・spacious・newBuild・stationNear・floorHigh・equipKeys・作業員K）
//   判定の学び … hook-lean-core の HookFeatureKey（walk_near・area_wide・zero_zero・age_new・rent_upper）
//   条件の言い直し … brain-core の condition_change_type → 物件出しの条件の更新の案（condition-write-arbiter の今の道。ここは書かない）
// ■ 決まり: 竹内さんの決定のある指示だけ decided=true。決まっていない物（刺さった点で次のピックアップを寄せるか）は decided=false の案
//   （記録と問いの案だけ・AIX ツールの条件や🌟には入れない）。AIX の要否・種類を決めるのはブレイン（feedback_brain_owns_aix）＝ここは道を変えない
// ■ スイッチ: FEELING_CONDUCTOR_TABLE（shadow＝meta.feeling_aix_order に記録・on＝記録＋統括の指示書の「次に送る物」の1行に出す）

type M = Record<string, unknown>;
const obj = (v: unknown): M | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as M) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** our-send-uptake.HOOK_POINTS と同じ名前 */
export type HookPointName = "家賃" | "広さ・間取り" | "駅・場所" | "新しさ" | "設備" | "初期費用" | "空き・入居" | "条件の合い方" | "キャンペーン";
/** recommend-star-rank.StarSituation の真偽の鍵 */
export type StarSituationKey = "zero" | "spacious" | "newBuild" | "stationNear" | "floorHigh";
/** hook-lean-core.HookFeatureKey */
export type HookFeatureName = "rent_upper" | "rent_low" | "zero_zero" | "walk_near" | "age_new" | "age_old" | "area_wide";

/** 刺さった点 → 🌟の場面の鍵・判定の学びの鍵（写せる物だけ） */
export const HOOK_POINT_TO_TOOL: Readonly<Partial<Record<HookPointName, { star: StarSituationKey | "equip" | null; hook: HookFeatureName | null }>>> = {
  "家賃": { star: null, hook: "rent_upper" },   // 家賃の点は🌟の場面に無い（判定の学びだけ）
  "広さ・間取り": { star: "spacious", hook: "area_wide" },
  "駅・場所": { star: "stationNear", hook: "walk_near" },
  "新しさ": { star: "newBuild", hook: "age_new" },
  "設備": { star: "equip", hook: null },
  "初期費用": { star: "zero", hook: "zero_zero" },
};

export type AixToolOrder = {
  kind: "recommend_one" | "estimate" | "cost_explain" | "viewing_invite" | "meeting_place" | "apply" | "condition_update" | "pickup_weights";
  /** aix-taxonomy の種類（AIX ツールのボタン）。無い指示は null（返信の中の一手・条件の更新） */
  aix: string | null;
  what: string;
  /** 🌟の場面に足す鍵・判定の学びに足す鍵（pickup_weights の時だけ） */
  star?: Array<StarSituationKey | "equip">;
  hook?: HookFeatureName[];
  /** 条件の言い直しの種類（brain-core の condition_change_type） */
  condition?: string;
  /** 届く先（今のコードの口） */
  to: string;
  decided: boolean;
  source: string;
};

const CONDITION_TYPES = new Set(["area_change", "rent_change", "layout_change", "equip_add", "condition_relax", "multi"]);

/** 表の判断（meta.feeling_conductor）と番の読み（刺さった点・条件の言い直し）→ AIX ツールへの指示（決まっている物を先に） */
export function aixToolOrders(meta: M | null | undefined): AixToolOrder[] {
  const m = meta ?? {};
  const d = obj(m.feeling_conductor);
  const rows = arr(d?.rows).map(String);
  const next = obj(d?.next);
  const out: AixToolOrder[] = [];
  // 迷い（物件どうし）→ 1件を推す＝AIX【物件オススメ】（10/09 決定2）
  if (rows.includes("hesitate_between")) out.push({ kind: "recommend_one", aix: "property_recommendation", what: "迷っている物件のうち1件を推す（🌟の並べ方の1件）", to: "AIX【物件オススメ】・🌟の並べ方（recommend-star-rank）", decided: true, source: "10/09 決定2" });
  // 次に送る物（表の行がそのまま決めた AIX）
  const aix = typeof next?.aix === "string" ? next.aix : null;
  const kindOf: Record<string, AixToolOrder["kind"]> = { estimate_sheet: "estimate", cost_explain: "cost_explain", viewing_invite: "viewing_invite", meeting_place: "meeting_place" };
  if (aix && kindOf[aix]) out.push({ kind: kindOf[aix], aix, what: String(next?.what ?? ""), to: `AIX【${aix}】`, decided: true, source: String(d?.nextFrom ?? "表") });
  if (!aix && next?.dest === "apply" && !rows.includes("hesitate_between")) out.push({ kind: "apply", aix: null, what: String(next?.what ?? "申込で抑える"), to: "返信の一手（申込の流れ）", decided: true, source: String(d?.nextFrom ?? "表") });
  // 条件の言い直し → 登録の条件そのものを直す（feedback_condition_change_permanent）＝物件出しの条件の更新の案（今の道 condition-write-arbiter）
  const cc = typeof m.condition_change_type === "string" ? m.condition_change_type : null;
  if (cc && CONDITION_TYPES.has(cc)) out.push({ kind: "condition_update", aix: null, condition: cc, what: "登録の条件そのものを直して探す（一時の上書きにしない）", to: "物件出しの条件の更新の案（condition-write-arbiter・条件の更新の履歴）", decided: true, source: "feedback_condition_change_permanent（9/27 竹内さん）" });
  // 刺さった点 → 次のピックアップの重み: 決まっていない（案）
  const hooked = arr(m.our_send_uptake).map(obj).filter((u): u is M => !!u && u.hook === "hooked" && typeof u.point === "string");
  const pts = [...new Set(hooked.map((u) => String(u.point)))] as HookPointName[];
  const star = pts.map((p) => HOOK_POINT_TO_TOOL[p]?.star).filter((x): x is StarSituationKey | "equip" => !!x);
  const hook = pts.map((p) => HOOK_POINT_TO_TOOL[p]?.hook).filter((x): x is HookFeatureName => !!x);
  if (star.length || hook.length) out.push({ kind: "pickup_weights", aix: null, what: `刺さった点（${pts.join("・")}）で次のピックアップと🌟を寄せる`, star: [...new Set(star)], hook: [...new Set(hook)], to: "🌟の場面（starSituationFromConditions）・判定の学び（hook-lean）", decided: false, source: "決まっていない（問いの案: 竹内さんに確かめる）" });
  return out;
}

/** 記録の短い印 例 "recommend_one:property_recommendation|condition_update:area_change|?pickup_weights:stationNear" */
export function aixToolDigest(o: ReadonlyArray<AixToolOrder>): string | null {
  if (!o.length) return null;
  return o.map((x) => `${x.decided ? "" : "?"}${x.kind}:${x.aix ?? x.condition ?? (x.star ?? []).join("+")}`).join("|").slice(0, 100);
}
/** 統括の指示書の「次に送る物」の1行（決まっている物だけ・on の時） */
export function aixToolLine(o: ReadonlyArray<AixToolOrder>): string | null {
  const dec = o.filter((x) => x.decided);
  return dec.length ? dec.map((x) => `${x.what}→${x.to}`).join("／").slice(0, 160) : null;
}
