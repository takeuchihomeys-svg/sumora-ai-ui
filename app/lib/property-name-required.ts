// app/lib/property-name-required.ts
// AIX【物件確認した】の物件名が「物件①」のような仮の名前・空のまま送られないようにする（純関数・依存なし）。
//
// 2026-10-07 5巡目（竹内さん「物件名にする」）: 物件確認した（物件あった）は画像の読み取りに失敗すると名前が `物件①` になり、
//   そのまま aix_usage_logs.property_names に残って送られていた（4巡目の物件ごとの台帳は「物件①」を推定で寄せるしかなかった）。
//   → 送る前に名前を必須にする（仮の名前・空では送れない）。名前の先入れは画面の namePrefill（送った物件・お客様の持ち込み）と
//     送った物件の候補（SentPropertyPicker）・確認の対象（confirm-target-property）から。

/** 画面・サーバが入れる仮の名前（「物件①」「物件1」「物件」「お部屋②」「物件情報」） */
const PLACEHOLDER_RE = /^(?:物件|お?部屋|物件情報)\s*[①-⑳0-9０-９]*\s*$/;

export function isPlaceholderPropertyName(name: string | null | undefined): boolean {
  const t = String(name ?? "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  if (!t) return true;
  return PLACEHOLDER_RE.test(t.normalize("NFC")) || PLACEHOLDER_RE.test(String(name ?? "").trim());
}

/** 送れない物件の番号（0 始まり）。無ければ空 */
export function missingPropertyNameIndexes(names: ReadonlyArray<string | null | undefined>, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (isPlaceholderPropertyName(names[i])) out.push(i);
  return out;
}

/** 画面に出す1文 */
export function missingPropertyNameMessage(indexes: ReadonlyArray<number>, count: number): string {
  const marks = "①②③④⑤";
  const which = count > 1 ? indexes.map((i) => `物件${marks[i] ?? String(i + 1)}`).join("・") : "物件";
  return `${which}の物件名（マンション名・号室）を入れてください（「物件①」のような仮の名前・空では送れません。送った物件の候補から選ぶか資料の画像から読み取れます）`;
}
