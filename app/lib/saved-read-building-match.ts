// app/lib/saved-read-building-match.ts（純関数・DB/LLM なし）
// 保存した資料の読み（sent_image_properties の property_name）を1通目の物件の見出し（建物名）に当てる当て方。
// 2026-10-15 second-material-saved-read.ts（2通目の資料の事実）と recommend-vacating-source.ts（退去予定の材料）に
//   同じ当て方が2つあったので1つにまとめた（動きは変えない）。号室の形のそろえ方は呼ぶ側で違う（前者は「号室」と先頭の0を外す・
//   後者は数字だけ）ので、そろえた号室の鍵を受け取る。
// 2026-10-15 確かめる人: 旧の「建物名の頭6字」はシリーズ名で別の建物に当たった
//   （「スプランディッド堀江 1309」→「スプランディッド本町グラン 1309」）→ 建物の鍵の一致にした。
import { normalizePropertyName } from "./property-name-match";

/** 建物の鍵（customer-state.buildingKeyOf と同じ形: NFKC → 〜を外す → normalizePropertyName） */
export const buildingKey = (s: string | null | undefined): string =>
  normalizePropertyName(String(s ?? "").normalize("NFKC").replace(/[〜~～]/g, ""));

const fold = (s: string) => s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");

/** 同じ長さで1字だけ違う（読み取りの取り違え「セレーネ/セレーノ」「今宮/令宮」） */
const oneCharOff = (a: string, b: string) => {
  if (a.length !== b.length || a.length < 4) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
};

/**
 * 2＝同じ建物（鍵の一致・濁点違い・読みの名前に号室が付いた形・先頭の飾り「★築浅★」を含む）
 * 1＝同じ長さで1字だけの読み違い／0＝別の建物（どちらかの鍵が2字未満も0）
 * roomKeyStr は呼ぶ側でそろえた号室の鍵（空なら「名前に号室が付いた形」は見ない）
 */
export function buildingMatchTier(readName: string | null | undefined, headName: string, roomKeyStr: string): number {
  const k = buildingKey(readName), hk = buildingKey(headName);
  if (k.length < 2 || hk.length < 2) return 0;
  if (k === hk || fold(k) === fold(hk) || (roomKeyStr !== "" && (k === hk + roomKeyStr || hk === k + roomKeyStr))
    || (Math.min(k.length, hk.length) >= 5 && (k.endsWith(hk) || hk.endsWith(k)))) return 2;
  return oneCharOff(k, hk) ? 1 : 0;
}
