/**
 * 自動か手動か（人か拡張か）の見分け方の正本（純関数・DBなし）
 *
 * ★ 2026-11-20 竹内さん「自動か手動かもちゃんと判断するようにする」:
 *   ・**モード**（mode）… その記録がどのモードで撮られたか。自動は aix / ai / auto / brain_*。
 *     ⚠ 旧は場所ごとに `aix` だけ・`aix|auto` だけと数え方が違い、`brain_aix` が自動から漏れていた。
 *   ・**押した人**（by）… 押し1回ごとに人（isTrusted）か拡張か。
 *     ⚠ 自動モードの中でも人が押す（例: 一覧の物件の行）・通常モードの中でも拡張が押す（自動入力）ので、
 *       押した位置・手の形を「人の手本」として学ぶ時はモードではなく by で分ける。
 *   ・位置（point_fields の1欄）の by が無い旧記録は、人の押し（isTrusted だけを拾う rec）から来た物。
 *     `syn:true` は拡張の合成クリック（座標0,0）なので自動。
 */

export type PressBy = "human" | "auto";

/** 自動モードか（aix / ai / auto / brain_*） */
export function isAutoMode(mode: unknown): boolean {
  const m = String(mode ?? "").trim().toLowerCase();
  if (!m) return false;
  return m === "aix" || m === "ai" || m === "auto" || m.startsWith("brain_");
}

/** 位置1欄（point_fields の値）を押したのは人か自動か */
export function pointBy(v: unknown): PressBy {
  if (!v || typeof v !== "object") return "human";
  const o = v as { by?: unknown; syn?: unknown };
  if (o.by === "auto" || o.syn === true) return "auto";
  return "human";
}

/** 操作1件（shot_ops）を押したのは人か自動か。by が無い旧記録は分からない（null） */
export function opBy(o: unknown): PressBy | null {
  if (!o || typeof o !== "object") return null;
  const by = String((o as { by?: unknown }).by ?? "");
  if (by === "auto") return "auto";
  if (by === "human") return "human";
  return null;
}

/** point_fields から人だけ／自動だけの欄を取り出す */
export function pointFieldsBy(pf: unknown, want: PressBy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!pf || typeof pf !== "object" || Array.isArray(pf)) return out;
  for (const [k, v] of Object.entries(pf as Record<string, unknown>)) {
    if (pointBy(v) === want) out[k] = v;
  }
  return out;
}

/** その行に、人／自動の押した位置が1欄でもあるか */
export function rowHasPointBy(pf: unknown, want: PressBy): boolean {
  return Object.keys(pointFieldsBy(pf, want)).length > 0;
}
