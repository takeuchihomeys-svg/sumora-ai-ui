// app/lib/room-no.ts（純関数・依存なし・画面とサーバで共用）
// 号室を1つの形にそろえる: 日本の建物の号室は先頭の0を読まない（0704→704・00101→101）・読み取りの化け（1O1→101・I01→101）を直す。
//
// 2026-10-14 竹内さん「号室を正しく読めれば間違えない。日本の建物の号室は先頭の0を読まない（0704→704・00101→101）。
//   照合・表示・記録のすべてで同じ形にそろえる（property-name-loose・aix-sent-names の照合も）。号室の化け（1O1 等）も」
// 実データ（2026-10-14・保存済みの全件・scripts/fix-room-no-stored.ts）:
//   先頭の0: 売上サポの行 487/2,450（リアプロ 447「00201」）・送った画像の記録 413/4,027・送った物件 255/8,571・AIX の物件名 98/1,062（「Comforza 0302号室」）
//   号室の化け（0 と O・1 と I/l）: 1件（「1I階部分」）だけ＝読み取りはほぼ数字で読めている。照合（normalizeRoomNo・property-name-loose）は前から0を外している
// 戻す: ROOM_NO_CANONICAL=off（読んだ・入れた形のまま）

export function roomNoCanonicalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ROOM_NO_CANONICAL ?? env.NEXT_PUBLIC_ROOM_NO_CANONICAL ?? "").trim().toLowerCase() !== "off";
}

/** 数字の中の英字の化け（O/o→0・I/l/|→1）。数字が1つ以上あり、数字と化けの字だけの並びの時だけ */
function fixOcrDigits(tok: string): string {
  if (!/[0-9]/.test(tok) || !/^[0-9OoIl|]+$/.test(tok)) return tok;
  // 全部が英字に近い並び（「II」）は号室ではない＝数字が半分以上の時だけ
  const digits = (tok.match(/[0-9]/g) ?? []).length;
  if (digits * 2 < tok.length) return tok;
  return tok.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
}

/**
 * 号室の形（「0704」→「704」・「00101号室」→「101」・「1O1」→「101」・「B-0102」→「B-102」・「3-C」はそのまま）。空は ""
 * 全部 0 の号室（「000」）は潰さない
 */
export function canonicalRoomNo(raw: string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  let s = String(raw ?? "").normalize("NFKC").trim().replace(/\s*(?:号室|号)\s*$/, "").trim();
  if (!s || !roomNoCanonicalEnabled(env)) return s;
  s = fixOcrDigits(s);
  // 頭の英字・区切り（B-0102・A0203）は残し、数字の先頭の0だけ外す
  const m = s.match(/^([A-Za-z]{1,2}\s*[-‐－]?\s*)?([0-9]+)([A-Za-z]?)$/);
  if (!m) return s;
  const num = m[2].replace(/^0+(?=\d)/, "");
  return `${(m[1] ?? "").toUpperCase().replace(/\s+/g, "")}${num}${m[3].toUpperCase()}`;
}

/**
 * 「建物 0302号室」「建物0302号室」のような名前の号室だけをそろえる（建物名は触らない）。
 *   本文の中ではなく、記録・表示の名前（1行の物件名）に使う
 */
export function canonicalRoomLabel(label: string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  const t = String(label ?? "");
  if (!t || !roomNoCanonicalEnabled(env)) return t;
  return t.replace(/(^|[^0-9A-Za-z０-９])([A-Za-z]{0,2}[-‐－]?[0-9０-９OoIl|]{2,6})(\s*号室)/g, (all, pre: string, room: string, suf: string) => {
    const c = canonicalRoomNo(room, env);
    return /^[A-Z]{0,2}-?[0-9]+[A-Z]?$/.test(c) ? `${pre}${c}${suf}` : all;
  });
}
