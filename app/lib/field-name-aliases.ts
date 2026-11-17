/**
 * 画像学習の日本語名 ↔ 自動が使う HTML name の対応
 * （2026-11-15「画像から学習した部分はちゃんと改善して更新」）
 *
 * ★ 実測: 束に `transportation_id` n=108・xy無し と `駅からの移動手段` n=235・xy有り が並存。
 *   画像の位置は日本語名に付き、課題欄（HTML id）に乗らない → 自動は改善されない。
 */
export const FIELD_NAME_ALIASES: Record<string, readonly string[]> = {
  transportation_id: ["駅からの移動手段", "移動手段"],
  required_time: ["分数", "徒歩分数", "駅徒歩"],
  rental_cost2: ["賃料上限", "上限賃料"],
  rental_cost1: ["賃料下限", "下限賃料"],
  structured_date: ["築年数", "築年"],
  update_date: ["更新日"],
  "city_code[]": ["所在地絞り込み", "所在地を絞り込み", "区を選ぶ"],
  "区を選ぶ": ["所在地絞り込み", "所在地を絞り込み", "city_code[]"],
  // 課題表記「沿線を選ぶ」↔ ボタン台帳・束の正名（仕組み㉑）
  "沿線を選ぶ": ["沿線・駅絞り込み＋", "沿線・駅絞り込み", "route_id[]"],
  "route_id[]": ["沿線を選ぶ", "沿線・駅絞り込み＋", "沿線・駅絞り込み", "路線"],
  "沿線・駅絞り込み＋": ["沿線を選ぶ", "route_id[]", "沿線・駅絞り込み"],
};

export type FieldWithPos = {
  name?: string;
  kind?: string;
  n?: number;
  x?: number;
  y?: number;
  zone?: string;
};

/** 別名一覧（HTML id → 日本語・逆も） */
export function aliasesOf(name: string): string[] {
  const n = String(name || "").trim();
  if (!n) return [];
  const out = new Set<string>([n]);
  const direct = FIELD_NAME_ALIASES[n];
  if (direct) for (const a of direct) out.add(a);
  for (const [k, list] of Object.entries(FIELD_NAME_ALIASES)) {
    if (list.includes(n)) {
      out.add(k);
      for (const a of list) out.add(a);
    }
  }
  return [...out];
}

/**
 * 同じ画面の欄一覧で、HTML id に x/y が無く別名に有るとき、位置を移す。
 * ⚠ 元の日本語欄は残す。HTML id 側に x/y を足すだけ。
 */
export function mergeAliasPositions<T extends FieldWithPos>(fields: T[]): T[] {
  const byName = new Map<string, T>();
  for (const f of fields) {
    const nm = String(f?.name ?? "").trim();
    if (nm) byName.set(nm, f);
  }
  return fields.map((f) => {
    const nm = String(f?.name ?? "").trim();
    if (!nm) return f;
    if (typeof f.x === "number" && typeof f.y === "number") return f;
    for (const a of aliasesOf(nm)) {
      if (a === nm) continue;
      const src = byName.get(a);
      if (src && typeof src.x === "number" && typeof src.y === "number") {
        return {
          ...f,
          x: src.x,
          y: src.y,
          ...(typeof src.zone === "string" && src.zone ? { zone: src.zone } : {}),
        };
      }
    }
    return f;
  });
}

/** 課題欄が束（欄名+x/y）に載っているか。別名も見る。 */
export function fieldHasPosition(
  field: string,
  have: Iterable<string> | Set<string>,
  haveWithXy?: Set<string>,
): boolean {
  const set = haveWithXy || (have instanceof Set ? have : new Set(have));
  for (const a of aliasesOf(field)) {
    if (set.has(a)) return true;
  }
  // 部分一致（最後の手段）
  for (const h of set) {
    if (h.includes(field) || field.includes(h)) return true;
  }
  return false;
}

/**
 * ★ 2026-11-16「自動モード強化を徹底／細かい部分強化」:
 *   拡張は `points[名前]`・画面位置[名前] を**完全一致**で引く（別名を見ない）。
 *   → 束を書く前に、xy がある欄の位置を**別名キーにも複製**する。
 *   例: `route_id[]` に位置があれば `沿線を選ぶ` にも同じ x/y/n を載せる。
 */
export function expandAliasPoints<T extends { x?: number; y?: number; n?: number }>(
  points: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = { ...points };
  for (const [name, v] of Object.entries(points)) {
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") continue;
    for (const a of aliasesOf(name)) {
      if (a === name) continue;
      const cur = out[a];
      if (cur && typeof cur.x === "number" && typeof cur.y === "number") {
        // 既にある方の n が大きいなら残す
        if ((Number(cur.n) || 0) >= (Number(v.n) || 0)) continue;
      }
      out[a] = { ...v };
    }
  }
  return out;
}

/** shots.learned の欄配列にも別名行を足す（拡張の画面位置引き用） */
export function expandAliasLearnedFields<T extends FieldWithPos>(fields: T[]): T[] {
  const out: T[] = [...fields];
  const have = new Set(fields.map((f) => String(f?.name ?? "").trim()).filter(Boolean));
  for (const f of fields) {
    const nm = String(f?.name ?? "").trim();
    if (!nm || typeof f.x !== "number" || typeof f.y !== "number") continue;
    for (const a of aliasesOf(nm)) {
      if (a === nm || have.has(a)) continue;
      have.add(a);
      out.push({ ...f, name: a });
    }
  }
  return out;
}
