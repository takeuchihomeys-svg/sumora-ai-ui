// app/lib/pickup-image-bonus.ts（純関数・import は純関数の image-wants.ts だけ・画面とサーバーで共用）
// 売上サポの「🔍 画像で分析」を判定の点に**足す**分（画像の加点）を決める。
//
// 2026-09-27 竹内「ここは合わせる」（e86ed5cc で画像の点を判定の点に足さず「同じ点の時の順番」にだけ使った事への答え）:
//   画像の点を判定の点に合わせて（足して）順位・👑 を決める。ただし判定にもう入っている画像・設備の札と二重に数えない。
//
// 合わせ方（重さ・上限の根拠）:
//   - 画像で分析の 0〜100点（match）は「判定できた希望の ○ の割合」で、判定の点（50＋札の合計・最大200）とは物差しが違う。
//     割合をそのまま足すと、判定に入っている希望（例: バストイレ別＝EQUIP_BATH_TOILET_MUST_OK +5）がもう一度数えられる
//     （YUMA の回 cg_509cd061_716: 画像の希望 6つのうち バストイレ別 は判定の札と同じ）。
//   - → 画像の希望を1つずつ見て、**判定に同じ設備の札（○×が決まった物）がある希望は外し**、残った希望だけを
//     判定の設備の札と同じ物差しで足す:
//       ○ 必須・NG 条件の希望 +5（EQUIP_*_MUST_OK・IMAGE_*_OK と同じ）／ふつうの希望 +3（EQUIP_*_OK と同じ）
//       × 必須・NG 条件の希望 −10（EQUIP_*_NG・IMAGE_*_NG と同じ）／ふつうの希望 −5（会話のついでの希望は条件欄より弱い）
//       ？（分からない）0
//     合計は +15 まで（設備の ○ の合計の上限 EQUIP_OK_MAX_TOTAL と同じ）・−20 まで（1つの物件を画像だけで大きく沈めない）。
//   - 同じ設備の希望（「NG条件: 1階不可」と「1階不可」）は1つに数える（ng があれば ×）。設備に当たらない希望（広さ・部屋の配置）は1つずつ
//   - 要確認（物件と資料が合わない）は足さない（null）。分析していない物件も null（分析待ち＝合計に入れない・判定の点のまま）
import { wantFeatures } from "./image-wants";

export const IMAGE_BONUS_OK = 3;
export const IMAGE_BONUS_OK_STRONG = 5;
export const IMAGE_BONUS_NG = -5;
export const IMAGE_BONUS_NG_STRONG = -10;
export const IMAGE_BONUS_MAX = 15;
export const IMAGE_BONUS_MIN = -20;

/**
 * 画像の希望の細かい設備（image-wants.WANT_FEATURES の key）→ 判定の札の頭。
 *   この頭の札で ○×（_OK・_NG・_MUST_OK・_SOFT_OK・_OK_MAX・_NEAR）が決まっていれば、その希望は判定に入っている＝画像では足さない。
 *   _UNLISTED・_ASK（資料に書いていない・要確認＝0点）は決まっていない扱い＝画像で確かめた分を足してよい
 *   対応の無い設備（部屋の配置・独立キッチン・シューズWIC）は判定に札が無いので、いつも画像で足す
 */
const FEATURE_JUDGE_PREFIX: Record<string, string[]> = {
  bath_toilet: ["EQUIP_BATH_TOILET_", "IMAGE_BATH_TOILET_SEPARATE_"],
  washbasin: ["EQUIP_WASHBASIN_", "IMAGE_SEPARATE_WASHSTAND_"],
  storage: ["IMAGE_STORAGE_"],
  wic: ["EQUIP_WALK_IN_CLOSET_"],
  counter_kitchen: ["EQUIP_COUNTER_KITCHEN_"],
  burners: ["EQUIP_BURNER2_"],
  laundry_in: ["EQUIP_LAUNDRY_IN_"],
  pet: ["EQUIP_PET_", "PET_NG"],
  autolock: ["EQUIP_AUTOLOCK_"],
  net_free: ["EQUIP_NET_FREE_"],
  delivery_box: ["EQUIP_DELIVERY_BOX_"],
  sunlight: ["EQUIP_SOUTH_", "IMAGE_SOUTH_FACING_"],
  corner: ["EQUIP_CORNER_"],
  floor2: ["EQUIP_FLOOR2_", "IMAGE_FLOOR_2_PLUS_"],
  loft: ["EQUIP_LOFT_"],
  balcony: ["EQUIP_BALCONY_"],
  // 2026-09-27 洋室の帖数（判定の ROOM_JO_OK／ROOM_JO_NG／ROOM_JO_SOFT_NG が決まっていれば画像では足さない・_UNKNOWN は決まっていない）
  room_jo: ["ROOM_JO_"],
};

/** 判定の札が ○× の決まった物か（_UNLISTED・_ASK・上限の印は決まっていない）。_HELD（AD の保留の印）は外して見る */
function decidedCode(code: string): boolean {
  const c = code.endsWith("_HELD") ? code.slice(0, -5) : code;
  if (c === "PET_NG") return true;
  if (c === "EQUIP_MUST_NG_CAP") return false;
  return /_(?:OK|OK_MAX|NG|NEAR)$/.test(c);
}

/** 判定に ○× が入っている設備（FEATURE_JUDGE_PREFIX の key） */
export function judgedFeatures(codes: ReadonlyArray<string> | null | undefined): Set<string> {
  const out = new Set<string>();
  const decided = (codes ?? []).filter(decidedCode).map((c) => (c.endsWith("_HELD") ? c.slice(0, -5) : c));
  for (const [key, heads] of Object.entries(FEATURE_JUDGE_PREFIX)) {
    if (decided.some((c) => heads.some((h) => (h.endsWith("_") ? c.startsWith(h) : c === h)))) out.add(key);
  }
  return out;
}

type WantLike = { id: string; text: string; ng?: boolean; must?: boolean };
type CheckLike = { id: string; result: string; why?: string };
export type ImageAnalysisForBonus = { match?: unknown; wants?: unknown; checks?: unknown; review?: unknown; [k: string]: unknown } | null | undefined;

export type ImageBonusLine = {
  /** まとめた希望の先頭の id と文 */
  id: string; text: string;
  result: "ok" | "ng" | "unknown";
  /** 判定にもう入っている（足さない） */
  covered: boolean;
  /** 足した点（covered・unknown は 0） */
  points: number;
};
export type ImageBonus = {
  /** 判定の点に足す点（上限・下限の後） */
  points: number;
  /** 上限・下限の前の合計 */
  raw: number;
  ok: number; ng: number;
  /** 判定の札と同じで足さなかった希望の数 */
  covered: number;
  lines: ImageBonusLine[];
};

const isReviewNeedsCheck = (a: ImageAnalysisForBonus) => (a?.review as { status?: unknown } | undefined)?.status === "要確認";

/**
 * 画像の加点（純関数）。分析していない・要確認・希望と答えが読めない（古い形）なら null（＝合計に入れない）。
 *   row.reason_codes: その物件の判定の札（割引の比べを外した後の物）
 */
export function imageBonusOf(row: { reason_codes?: ReadonlyArray<string> | null; image_analysis?: ImageAnalysisForBonus }): ImageBonus | null {
  const a = row.image_analysis;
  if (!a || isReviewNeedsCheck(a)) return null;
  const wants = Array.isArray(a.wants) ? (a.wants as WantLike[]).filter((w) => w && typeof w.id === "string") : null;
  const checks = Array.isArray(a.checks) ? (a.checks as CheckLike[]).filter((c) => c && typeof c.id === "string") : null;
  if (!wants || !checks) return null;
  const judged = judgedFeatures(row.reason_codes);
  const byId = new Map(checks.map((c) => [c.id, c]));
  // 同じ設備の希望は1つに（設備に当たらない希望は1つずつ）
  type G = { id: string; text: string; features: string[]; strong: boolean; results: string[] };
  const groups = new Map<string, G>();
  for (const w of wants) {
    const f = wantFeatures(String(w.text ?? "")).sort();
    const key = f.length ? f.join("+") : `id:${w.id}`;
    const g = groups.get(key) ?? { id: w.id, text: String(w.text ?? ""), features: f, strong: false, results: [] };
    g.strong = g.strong || !!w.must || !!w.ng;
    g.results.push(byId.get(w.id)?.result ?? "unknown");
    groups.set(key, g);
  }
  const lines: ImageBonusLine[] = [];
  let raw = 0, ok = 0, ng = 0, covered = 0;
  for (const g of groups.values()) {
    const result: ImageBonusLine["result"] = g.results.includes("ng") ? "ng" : g.results.includes("ok") ? "ok" : "unknown";
    const isCovered = g.features.length > 0 && g.features.every((f) => judged.has(f));
    let points = 0;
    if (isCovered) { if (result !== "unknown") covered++; }
    else if (result === "ok") { points = g.strong ? IMAGE_BONUS_OK_STRONG : IMAGE_BONUS_OK; ok++; }
    else if (result === "ng") { points = g.strong ? IMAGE_BONUS_NG_STRONG : IMAGE_BONUS_NG; ng++; }
    raw += points;
    lines.push({ id: g.id, text: g.text, result, covered: isCovered, points });
  }
  const points = Math.max(IMAGE_BONUS_MIN, Math.min(IMAGE_BONUS_MAX, raw));
  return { points, raw, ok, ng, covered, lines };
}

/** 合計の点（判定の点＋画像の加点）。判定の点が無ければ null・画像が分析待ち／要確認なら判定の点のまま */
export function totalPointOf(row: { score?: number | null; reason_codes?: ReadonlyArray<string> | null; image_analysis?: ImageAnalysisForBonus }): number | null {
  if (typeof row.score !== "number" || !Number.isFinite(row.score)) return null;
  return row.score + (imageBonusOf(row)?.points ?? 0);
}

/** 加点の文字（+6・−5・±0） */
export function signedPoints(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "±0";
}

/**
 * 点の見せ方（👑 の行・カードの丸い札の説明）。
 *   画像を足した時「合計 169点（判定 163・画像 +6）」／分析待ち・要確認・画像なし「判定 163点」
 */
export function totalPointsLabel(row: { score?: number | null; reason_codes?: ReadonlyArray<string> | null; image_analysis?: ImageAnalysisForBonus }): string {
  if (typeof row.score !== "number") return "判定 －";
  const b = imageBonusOf(row);
  if (!b) return `判定 ${row.score}点`;
  return `合計 ${row.score + b.points}点（判定 ${row.score}・画像 ${signedPoints(b.points)}）`;
}
