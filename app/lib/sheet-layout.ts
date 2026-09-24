// app/lib/sheet-layout.ts（純関数・依存なし・画面とサーバーで共用できる）
// 物件資料（1ページ目）の「型」を決め、DeepSeek に読ませる所（間取り図・画像の範囲）の切り出し位置を決める。
//
// 2026-09-24 竹内「2つの型を使ってプロンプトキャッシュを効かせる。必要な所（間取り図・室内写真）だけを切り出して読ませる。
//   表の文字は PDF の文字層から取る。拡張ツールからリアプロで送ったらリアプロ、itandi で送ったら itandi なので分かりやすい」
//
// 調査（2026-09-24・property_pickups の site=realpro 全18行＋fixture・sent_properties の資料画像137枚を目で分けた）:
//   リアプロ（弊社の帯替え・PDF 1ページ目）: PDF 16件で画像の位置が小数3桁まで同じ。pdfjs の描画命令（paintImageXObject）で正確に取れる
//     間取り図 x.343 y.296 w.255 h.362 ／ 地図 x.604 y.296 w.341 h.362 ／ 外観 x.343 y.023 w.184 h.261 ／ 室内写真 x.533 y.023 w.373 h.261（4×2 のマス）
//     隣との隙間は 0.006〜0.012 しか無い → 余白は各辺 0.003 まで
//     ⚠ 資料画像81枚のうち12枚（15%）は別の形（キャッチコピー付きで間取り図が大きい／写真の段に間取り図／写真なし）
//       → 位置を決め打ちせず、描画命令で「間取り図の位置と地図の位置の両方に画像がある」事を確かめる。合わなければ1ページ全体に戻す
//   itandi: 実物の PDF は1件も手に入らず、資料の画像26枚から測った推定（A4 横と仮定）。
//     最初の枠（x.015 y.093 w.241 h.355）は 26件中7件（27%）で外れる（写真が少ないと枠が広がる・最初が外観・画像情報なし）
//     → 固定の枠ではなく「画像の範囲」全体（x .010〜.505・y .085〜.82。26件全部が入る）を1枚で渡す。表は x .51 から右
//     ⚠ itandi の PDF で描画命令の座標と文字層を確かめてから固定する事（YUMA で itandi の物件を1回通して確かめる・未確認）
//   間取り図か写真かを画素で見分けるのは無理だった（白の割合・色の濃さが重なる）→ 読ませる時に「間取り図か」をモデルに答えさせ、文字層と突き合わせる
//
// 室内写真の切り出し位置（photos）も求めるが、今は DeepSeek に渡さない:
//   2026-09-24 実測で写真の帯を足すとキッチンの配置欄に選択肢に無い値（「キッチン」）が返り、質が下がった。設備は文字層で取れる

export type SheetType = "realpro" | "itandi" | "unknown";
/** ページ全体に対する比率（左上 x・y と幅・高さ） */
export type NormBox = { x: number; y: number; w: number; h: number };

export const REALPRO_SLOTS = {
  floor: { x: 0.343, y: 0.296, w: 0.255, h: 0.362 },
  map: { x: 0.604, y: 0.296, w: 0.341, h: 0.362 },
  exterior: { x: 0.343, y: 0.023, w: 0.184, h: 0.261 },
  photos: { x: 0.533, y: 0.023, w: 0.373, h: 0.261 },
} as const;

export const ITANDI_SLOTS = {
  /** 最初の枠（標準の形の間取り図）。73% でしか合わないので切り出しには使わない（記録用） */
  firstSlot: { x: 0.015, y: 0.093, w: 0.241, h: 0.355 },
  /** 画像の範囲（間取り図＋写真・表を除く） */
  imageArea: { x: 0.010, y: 0.085, w: 0.495, h: 0.735 },
} as const;

/** 余白（各辺）。隣の画像（表・地図・写真）まで 0.006〜0.012 しか無いので 0.003 */
export const CROP_PAD = 0.003;
/** 描画命令の位置が「その枠の画像」と見なす誤差 */
const SLOT_TOLERANCE = 0.01;

/** リアプロの文字層の目印（36/36 ページにある） */
const REALPRO_MARKERS = [/Powered\s*by\s*RealNetPro/i, /物件種目/, /号室名/, /間取タイプ/, /開口部方位/];
/** itandi の目印（資料の画像で確かめた語。PDF の文字層では未確認） */
const ITANDI_MARKERS = [/敷引\s*[/／]\s*償却/, /主要採光面/, /入居可能時期/, /itandi/i];

export type SheetTypeDecision = { type: SheetType; by: "site" | "url" | "text" | "none" };

/**
 * 資料の型を決める。
 *   1. 拡張ツールの送り元（property_pickups.site）: "realpro" / "itandi"。"reins" 等は型を持たない（unknown）
 *   2. site が無い時: PDF の URL が realnetpro ならリアプロ
 *   3. 文字層の目印（リアプロ 3つ以上・itandi 2つ以上）
 *   4. どれでもなければ unknown（切り出さず1ページ全体を読む）
 */
export function detectSheetType(input: { site?: string | null; pdfUrl?: string | null; pageText?: string | null }): SheetTypeDecision {
  const site = String(input.site ?? "").trim().toLowerCase();
  if (site === "realpro" || site === "realnetpro") return { type: "realpro", by: "site" };
  if (site === "itandi") return { type: "itandi", by: "site" };
  if (site) return { type: "unknown", by: "site" };   // reins など（今は売上サポに来ないが同じ扱い）
  if (/realnetpro/i.test(String(input.pdfUrl ?? ""))) return { type: "realpro", by: "url" };
  const text = String(input.pageText ?? "");
  if (REALPRO_MARKERS.filter((re) => re.test(text)).length >= 3) return { type: "realpro", by: "text" };
  if (ITANDI_MARKERS.filter((re) => re.test(text)).length >= 2) return { type: "itandi", by: "text" };
  return { type: "unknown", by: "none" };
}

export type CropMode = "floor" | "image_area" | "page";
export type CropPlan = {
  mode: CropMode;
  /** 切り出す範囲（比率）。page はページ全体 */
  rect: NormBox;
  /** drawn＝描画命令の位置で確かめた／fixed＝測った比率（確かめられない）／page＝切り出さない */
  basis: "drawn" | "fixed" | "page";
  /** 室内写真のマス（読ませない・記録用）。無ければ null */
  photos: NormBox | null;
  /** 1ページ全体に戻した理由 */
  reason: string | null;
};

const PAGE: NormBox = { x: 0, y: 0, w: 1, h: 1 };

const near = (b: NormBox, s: NormBox, tol = SLOT_TOLERANCE) =>
  Math.abs(b.x - s.x) <= tol && Math.abs(b.y - s.y) <= tol && Math.abs(b.w - s.w) <= tol && Math.abs(b.h - s.h) <= tol;
/** 背景（ページ全体に敷いた画像）は数えない */
const isBackground = (b: NormBox) => b.w >= 0.9 && b.h >= 0.9;
const inside = (b: NormBox, area: NormBox, tol = 0.005) =>
  b.x >= area.x - tol && b.y >= area.y - tol && b.x + b.w <= area.x + area.w + tol && b.y + b.h <= area.y + area.h + tol;

/** 余白を足してページの中に収める */
export function padBox(b: NormBox, pad: number = CROP_PAD): NormBox {
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const x2 = Math.min(1, b.x + b.w + pad), y2 = Math.min(1, b.y + b.h + pad);
  return { x, y, w: x2 - x, h: y2 - y };
}

function union(bs: NormBox[]): NormBox {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.w)), y2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * 切り出す所を決める。
 * @param boxes 描画命令から取った画像の位置（比率）。null＝描画命令が無い（画像から切る時）
 * @param aspect ページの高さ÷幅（A4 横＝0.707）。itandi の固定の比率は A4 横でしか使わない
 */
export function planSheetCrop(type: SheetType, boxes: NormBox[] | null, aspect?: number | null): CropPlan {
  const drawn = (boxes ?? []).filter((b) => !isBackground(b) && b.w > 0.01 && b.h > 0.01);
  if (type === "realpro") {
    if (!boxes) return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "描画命令が無い（位置を確かめられない）" };
    const floor = drawn.find((b) => near(b, REALPRO_SLOTS.floor));
    const map = drawn.find((b) => near(b, REALPRO_SLOTS.map));
    if (!floor || !map) {
      return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "リアプロの標準の形ではない（間取り図・地図の位置に画像が無い）" };
    }
    const photoCells = drawn.filter((b) => inside(b, REALPRO_SLOTS.photos));
    return { mode: "floor", rect: padBox(floor), basis: "drawn", photos: photoCells.length ? padBox(union(photoCells)) : null, reason: null };
  }
  if (type === "itandi") {
    const area = ITANDI_SLOTS.imageArea;
    const landscape = aspect == null || (aspect > 0.6 && aspect < 0.8);
    if (drawn.length > 0) {
      const left = drawn.filter((b) => inside(b, area, 0.02));
      if (!left.length) return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "itandi の画像の範囲に画像が無い" };
      // 2026-09-24 反証: 範囲の中の画像がロゴ・アイコンだけ（間取り図が線で描かれている等）だと、切り出しが小さな絵だけになり
      //   間取り図が収まらない → 画像の合計がページの 4% 未満なら1ページ全体に戻す（itandi の PDF は未確認のため安全側）
      const u = union(left);
      if (u.w * u.h < 0.04) return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "itandi の画像の範囲の画像が小さすぎる（間取り図が収まらない）" };
      return { mode: "image_area", rect: padBox(u), basis: "drawn", photos: null, reason: null };
    }
    // 描画命令が無い／ページ全体が1枚の画像（スキャン・スクリーンショット）: 測った範囲で切る（26件全部が入った範囲）
    if (!landscape) return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "横向きの資料ではない（itandi の範囲を当てられない）" };
    return { mode: "image_area", rect: padBox(area), basis: "fixed", photos: null, reason: null };
  }
  return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "型が分からない資料" };
}

/** 比率の範囲を画素に（整数・画像の中に収める） */
export function toPixelRect(r: NormBox, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.floor(r.x * width)), y = Math.max(0, Math.floor(r.y * height));
  const x2 = Math.min(width, Math.ceil((r.x + r.w) * width)), y2 = Math.min(height, Math.ceil((r.y + r.h) * height));
  return { x, y, width: Math.max(1, x2 - x), height: Math.max(1, y2 - y) };
}
