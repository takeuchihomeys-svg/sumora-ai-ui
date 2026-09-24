// app/lib/generic-building-name.ts（純関数・依存は property-name-match だけ・画面とサーバーで共用）
// 名前だけでは建物を決められない「一般名」（物件・マンション・物件3 …）を見分ける。
//
// 使う所:
//   - pickup-dedupe.ts: 同じ建物の重複を落とす時、一般名どうしを同じ建物と見なさない（別の建物の部屋が落ちる穴）
//   - property-brain.ts: 送付済みの建物（ALREADY_SENT・-30・drop）の照合。一般名は送付済みの記録にも入れず、照合もしない
//
// 2026-09-24 竹内「外す候補 20 と出てるが、なんで全部外す候補 20 でばらつきないのか」:
//   itandi の説明文は拡張が名前を取れず全件「【n】物件」。過去の itandi の送付も sent_properties に「物件」で残るので、
//   送付済みの建物に「物件」が入り、今回の18件のうち15件が ALREADY_SENT（50−30＝20・外す候補）で横並びになった。
//   → 一般名は「どの建物か分からない」＝送付済みとも同じ建物とも判断しない（迷う物は残す側・誤削除0）
import { normalizePropertyName } from "./property-name-match";

export const GENERIC_BUILDING_NAMES: ReadonlySet<string> = new Set(["物件", "物件名", "建物", "建物名", "マンション", "アパート", "ハイツ", "コーポ", "メゾン", "レジデンス",
  "貸家", "戸建", "戸建て", "一戸建", "一戸建て", "テラスハウス", "不明", "未定", "名称未設定", "名称なし", "なし", "無し", "-", "－"]);

/** 一般名（または1文字以下）なら true＝建物の照合に使わない。「物件3」「物件 No.2」「【4】物件」も一般名 */
export function isGenericBuildingName(name: string | null | undefined): boolean {
  const raw = String(name ?? "").normalize("NFKC").replace(/^\s*【[^】]*】\s*/, "").replace(/[\s　]/g, "");
  if (!raw) return true;
  if (GENERIC_BUILDING_NAMES.has(raw)) return true;
  // 一般名＋番号（拡張が名前を取れなかった時の「物件3」。NFKC で ①→1）
  const base = raw.replace(/(?:No\.?|#|番)?\d+$/i, "");
  if (base !== raw && GENERIC_BUILDING_NAMES.has(base)) return true;
  return normalizePropertyName(raw).length <= 1;
}
