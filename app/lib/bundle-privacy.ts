// app/lib/bundle-privacy.ts — 学習の束から、お客様の名前らしい文字列を外す（純関数・DB を使わない・2026-11-20）
//
// 竹内さん「入力内容として外す」（2026-11-20）。
//   拡張（page-script.js）は、フェーズの段階名の後ろに**お客様の名前**を付けて記録する:
//     "今の客:fill_start 平田敏也"（束の next のキーに入っていた・実測）
//   学習の材料は「欄の名前と操作の種類・時刻だけ」の決まり。名前は手順にも束にも要らない。
//   ⚠ ここは**キーと値の両方**を見る（束の next はキーに入っていた）。
//   ⚠ 名前の後ろは必ず落とす（段階名だけ残す）。段階名（fill_start など）は学びに使うので残す。
//   ⚠ 同じ段階名に畳まれた数（件数）は**足す**（落とすと学びが減る）。

const CUSTOMER_PHASE = /(今の客:[A-Za-z_]+)\s+[^"\\]+/g;

/** 1つの文字列から名前を外す（段階名は残す） */
export function stripCustomerNameText(s: string): string {
  return s.replace(CUSTOMER_PHASE, "$1");
}

/**
 * 束（任意の形）から名前らしい文字列を外す。キーの衝突は数を足し、中の物は再帰で畳む。
 *   戻り値: { value, changed }（changed=何か外したか）
 */
export function stripCustomerNames<T>(input: T): { value: T; changed: boolean } {
  let changed = false;

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const t = stripCustomerNameText(v);
      if (t !== v) changed = true;
      return t;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k0, val] of Object.entries(v as Record<string, unknown>)) {
        const k = stripCustomerNameText(k0);
        if (k !== k0) changed = true;
        const nv = walk(val);
        if (!(k in out)) { out[k] = nv; continue; }
        // 同じキーに畳まれた: 数は足す／中身は両方を畳む（落とさない）
        const prev = out[k];
        if (typeof prev === "number" && typeof nv === "number") out[k] = prev + nv;
        else if (prev && nv && typeof prev === "object" && typeof nv === "object" && !Array.isArray(prev) && !Array.isArray(nv)) {
          out[k] = mergeCounts(prev as Record<string, unknown>, nv as Record<string, unknown>);
        }
        // それ以外（配列・文字の衝突）は先に入った物を残す（件数は失われない場合のみ）
      }
      return out;
    }
    return v;
  };

  const value = walk(input) as T;
  return { value, changed };
}

/** 2つの「数の箱」を足す（同じ名前の数は足し、無い物は入れる） */
function mergeCounts(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!(k in out)) { out[k] = v; continue; }
    const p = out[k];
    if (typeof p === "number" && typeof v === "number") out[k] = p + v;
    else if (p && v && typeof p === "object" && typeof v === "object" && !Array.isArray(p) && !Array.isArray(v)) out[k] = mergeCounts(p as Record<string, unknown>, v as Record<string, unknown>);
  }
  return out;
}
