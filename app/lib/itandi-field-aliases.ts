/**
 * ITANDI 専用の画面欄名・HTML name の対応（リアプロの field-name-aliases.ts とは完全分離・2026-11-27）
 *
 * ⚠ ここにリアプロ専用の欄名・変数名を入れない（site-split-guard.test.js が止める）。
 * ⚠ リアプロの FIELD_NAME_ALIASES を ITANDI に当てると、ITANDI の「賃料」「駅徒歩」「更新日」等から
 *   リアプロ欄へ座標複製が起きるため、ITANDI の束ではこのファイルだけを使う。
 */

export type ItandiFieldWithPos = {
  name?: string;
  kind?: string;
  n?: number;
  x?: number;
  y?: number;
  zone?: string;
};

export const ITANDI_FIELD_NAME_ALIASES: Record<string, readonly string[]> = {
  "所在地で絞り込み": ["所在地で絞り込みを開く"],
  "所在地で絞り込みを開く": ["所在地で絞り込み"],
  "路線・駅で絞り込み": ["路線・駅で絞り込みを開く", "路線・駅選択"],
  "路線・駅で絞り込みを開く": ["路線・駅で絞り込み", "路線・駅選択"],
  "リスト検索": ["検索", "左のリスト検索｜button.css-2d2om2-Butt"],
  "検索": ["リスト検索", "検索を押す（ITANDI）"],
  "rent:lteq": ["賃料", "賃料上限（ITANDI）"],
  "rent:gteq": ["賃料", "賃料下限（ITANDI）"],
  "賃料": ["rent:lteq", "rent:gteq"],
  "floor_area_amount:gteq": ["面積", "専有面積"],
  "面積": ["floor_area_amount:gteq"],
  "station_walk_minutes:lteq": ["駅徒歩", "徒歩分数", "分"],
  "駅徒歩": ["station_walk_minutes:lteq", "徒歩分数"],
  "building_age:lteq": ["築年数", "築年"],
  "築年数": ["building_age:lteq"],
  "building_name:match": ["物件名（カナ検索可）", "物件名"],
  "物件名（カナ検索可）": ["building_name:match", "物件名"],
  "room_layout:in": ["間取り"],
  "間取り": ["room_layout:in"],
  "offer_conditions_updated_at:gteq": ["更新日", "募集条件の更新日"],
  "更新日": ["offer_conditions_updated_at:gteq"],
  "structure_type:in": ["構造"],
  "構造": ["structure_type:in"],
  "option_id:all_in": ["設備・条件", "こだわり条件"],
  "すべて選択": ["全選択"],
  "全選択": ["すべて選択"],
};

export function itandiAliasesOf(name: string): string[] {
  const n = String(name || "").trim();
  if (!n) return [];
  const out = new Set<string>([n]);
  const direct = ITANDI_FIELD_NAME_ALIASES[n];
  if (direct) for (const a of direct) out.add(a);
  for (const [k, list] of Object.entries(ITANDI_FIELD_NAME_ALIASES)) {
    if (list.includes(n)) {
      out.add(k);
      for (const a of list) out.add(a);
    }
  }
  return [...out];
}

function isItandiOpener(name: string): boolean {
  const n = String(name || "").trim().replace(/^(左|右)の/, "").replace(/｜.*$/, "");
  return /絞り込み$|を開く$/.test(n);
}

function itandiKindBlocksCopy(target: string, srcKind: unknown, curKind?: unknown): boolean {
  const sk = String(srcKind ?? "");
  if (sk === "checkbox" && isItandiOpener(target)) return true;
  const ck = String(curKind ?? "");
  if (ck && sk && ck !== sk) return true;
  return false;
}

export function expandItandiAliasPoints<T extends { x?: number; y?: number; n?: number; w?: unknown }>(
  points: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = { ...points };
  for (const [name, v] of Object.entries(points)) {
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") continue;
    for (const a of itandiAliasesOf(name)) {
      if (a === name) continue;
      const cur = out[a];
      if (itandiKindBlocksCopy(a, v.w, cur && typeof cur.x === "number" ? cur.w : undefined)) continue;
      if (cur && typeof cur.x === "number" && typeof cur.y === "number") {
        if ((Number(cur.n) || 0) >= (Number(v.n) || 0)) continue;
      }
      out[a] = { ...v };
    }
  }
  return out;
}

export function expandItandiLearnedFields<T extends ItandiFieldWithPos>(fields: T[]): T[] {
  const out: T[] = [...fields];
  const have = new Set(fields.map((f) => String(f?.name ?? "").trim()).filter(Boolean));
  for (const f of fields) {
    const nm = String(f?.name ?? "").trim();
    if (!nm || typeof f.x !== "number" || typeof f.y !== "number") continue;
    for (const a of itandiAliasesOf(nm)) {
      if (a === nm || have.has(a)) continue;
      if (itandiKindBlocksCopy(a, f.kind)) continue;
      have.add(a);
      out.push({ ...f, name: a });
    }
  }
  return out;
}

/**
 * ITANDI 専用の別名展開（リアプロの FIELD_NAME_ALIASES を混ぜない）。
 */
export function applyItandiBundleAliasExpansion(bundle: Record<string, unknown>): void {
  const pts = bundle.points;
  if (pts && typeof pts === "object" && !Array.isArray(pts)) {
    bundle.points = expandItandiAliasPoints(pts as Record<string, { x?: number; y?: number; n?: number; w?: unknown }>);
  }
  const shots = bundle.shots;
  if (!shots || typeof shots !== "object" || Array.isArray(shots)) return;
  const sh = shots as { learned?: Record<string, unknown> };
  const learned = sh.learned;
  if (!learned || typeof learned !== "object") return;
  const out: Record<string, unknown> = {};
  for (const [screen, list] of Object.entries(learned)) {
    const arr = Array.isArray(list) ? list : [];
    out[screen] = expandItandiLearnedFields(arr as ItandiFieldWithPos[]).map((f) => ({
      name: String(f.name || ""),
      kind: String(f.kind || "unknown"),
      n: Number(f.n) || 0,
      ...(typeof f.x === "number" ? { x: f.x } : {}),
      ...(typeof f.y === "number" ? { y: f.y } : {}),
      ...(typeof f.zone === "string" && f.zone ? { zone: f.zone } : {}),
    }));
  }
  sh.learned = out;
}
