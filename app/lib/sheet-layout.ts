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
//   ⚠ 2026-09-24 夜 竹内「なんで itandi のやつできなかったのか」→ 原因: 画像だけの時に landscape（0.6 < 高さ÷幅 < 0.8）で判定し、
//     PC で切り抜いた itandi の資料（フッター無し・比 0.587〜0.605）が外れ、itandi の型も切り出しも一度も使われず1ページ全体で読まれた。
//     正解表（sent_properties の itandi 形 26枚・目視）で分かった形:
//       - 画像は2種類: ページ全体（フッター付き・スマホの画面を含む・比 0.678〜0.706）と、フッターを落とした切り抜き（比 0.587〜0.605）
//         切り抜きの座標はページ座標に x_page ≈ .003 + x_img×.993、y_page ≈ .003 + y_img×.834 で換算できる（081 のページ実測）
//       - 間取り図は全件「最初の枠」にある（または無い: 画像情報なし・外観写真だけの3件）。最初の枠は A/B/C の3形で、下端は最大 y .599（C 中枠）
//       - 文字層が無い（画像だけ）ので、物件名・号室（上の帯）と賃料・間取り・面積・設備（右の表）も画像から読む
//     → site=itandi なら縦横比で型を外さない。切り出しは「左の列（上の帯＋最初の枠）」と「右の表」の2枚を1回で読ませる
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
  /** 画像の範囲（間取り図＋写真・表を除く）。記録用 */
  imageArea: { x: 0.010, y: 0.085, w: 0.495, h: 0.735 },
  /**
   * 左の列（ページ座標）: 上の帯（物件名・号室）＋最初の枠（間取り図）。写真の格子の下の方は読まない。
   * 下端 .62 = 最初の枠の下端の最大（C 中枠 .599）＋余白。右端 .52 = 枠の右端の最大（B 大枠 .504）＋余白（表は .51 から・線が少し入るのは可）
   */
  left: { x: 0, y: 0, w: 0.52, h: 0.62 },
  /** 上の帯（ページ座標）: 物件名と「〇〇 号室」。枠が見つからない時に使う（枠の上端 .10〜.13 の手前まで） */
  band: { x: 0, y: 0, w: 0.52, h: 0.098 },
  /** 写真の範囲（ページ座標）: 枠が見つからない時の画像1（画像情報なしの D 形の枠 .81 まで入る） */
  photoArea: { x: 0, y: 0.085, w: 0.52, h: 0.735 },
  /** 右の表（ページ座標）: 所在地・賃料・間取り・専有面積・設備・備考。フッター（会社の帯 .86〜）は入れない */
  table: { x: 0.5, y: 0, w: 0.5, h: 0.86 },
} as const;

/** itandi の PDF の左上の枠（罫線の内側・ページ座標。実物 PDF 18件の描画で測った） */
export const ITANDI_PDF_FRAME: NormBox = { x: 0.028, y: 0.108, w: 0.234, h: 0.350 };

/** itandi の資料画像の形。page＝A4 横1ページ（フッター込み）／cut＝フッターを落とした切り抜き（PC で切った物） */
export type ItandiFrame = "page" | "cut";
/** 切り抜き（フッター無し）とページの境目（高さ÷幅）。実測 cut 0.587〜0.605 ／ page 0.678〜0.707 の間 */
export const ITANDI_CUT_MAX_ASPECT = 0.64;
/** これより縦長（高さ÷幅）は横向きの itandi の資料ではない（実測は cut 0.587〜0.605 ／ page 0.678〜0.707） */
export const ITANDI_PORTRAIT_MIN_ASPECT = 0.85;
export function itandiFrameOf(aspect: number | null | undefined): ItandiFrame {
  return aspect != null && Number.isFinite(aspect) && aspect < ITANDI_CUT_MAX_ASPECT ? "cut" : "page";
}
/** ページ座標の範囲を、その画像の座標に（cut は 081 のページ実測の換算の逆: x=(xp-.003)/.993, y=(yp-.003)/.834） */
export function itandiRectFor(b: NormBox, frame: ItandiFrame): NormBox {
  if (frame === "page") return { ...b };
  const fx = (v: number) => Math.min(1, Math.max(0, (v - 0.003) / 0.993));
  const fy = (v: number) => Math.min(1, Math.max(0, (v - 0.003) / 0.834));
  const x = fx(b.x), y = fy(b.y);
  const x2 = b.x + b.w >= 0.999 ? 1 : fx(b.x + b.w), y2 = b.y + b.h >= 0.999 ? 1 : fy(b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

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

/**
 * floor＝リアプロの間取り図の枠／image_area＝itandi の画像だけの資料（左の列＋右の表の2枚）／
 * itandi_pdf＝itandi の PDF（文字層あり。左上の枠＋ほかのマスの2枚）／page＝1ページ全体
 */
export type CropMode = "floor" | "image_area" | "itandi_pdf" | "page";
export type CropPlan = {
  mode: CropMode;
  /** 切り出す範囲（比率）。page はページ全体 */
  rect: NormBox;
  /** drawn＝描画命令の位置で確かめた／pixels＝画素で枠の罫線を見つけた（itandi の画像）／fixed＝測った比率（確かめられない）／page＝切り出さない */
  basis: "drawn" | "pixels" | "fixed" | "page";
  /** 室内写真のマス（読ませない・記録用）。無ければ null */
  photos: NormBox | null;
  /** 2枚目に読ませる範囲（itandi の右の表）。無ければ null */
  extra?: NormBox | null;
  /** 2枚目を複数の範囲から上から順に縦に並べて作る時（itandi の画像: 上の帯→右の表）。ある時は extra より優先 */
  extraStack?: NormBox[] | null;
  /** itandi の画像の形（page／cut） */
  frame?: ItandiFrame | null;
  /** 1ページ全体に戻した理由 */
  reason: string | null;
};

const PAGE: NormBox = { x: 0, y: 0, w: 1, h: 1 };

const near = (b: NormBox, s: NormBox, tol = SLOT_TOLERANCE) =>
  Math.abs(b.x - s.x) <= tol && Math.abs(b.y - s.y) <= tol && Math.abs(b.w - s.w) <= tol && Math.abs(b.h - s.h) <= tol;
/**
 * 背景（ページ全体に敷いた画像）・会社の帯（横幅いっぱい）は数えない。
 * 2026-09-24 夜: itandi の PDF（実物 18件）は横幅いっぱいの画像が2つ（x.013 y.019 w.980 h.819 の枠・y.854 の会社の帯）あり、
 *   旧の「幅も高さも 0.9 以上」では背景と見なされなかった → 幅 0.9 以上なら背景
 */
const isBackground = (b: NormBox) => b.w >= 0.9;
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
 * @param aspect ページの高さ÷幅（A4 横＝0.707）。itandi は型を外す判定に使わず、画像の形（page／cut）の換算にだけ使う
 * @param found 画素で見つけた物（itandi の画像の左上の枠＝findItandiFrameBox）。無ければ測った比率で切る
 */
export function planSheetCrop(type: SheetType, boxes: NormBox[] | null, aspect?: number | null, found?: { itandiFrame?: NormBox | null }): CropPlan {
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
    // 2026-09-24 夜: 縦横比で itandi を外さない（切り抜きの 0.59 が外れて1ページ全体で読まれていた）。縦横比は座標の換算（page／cut）にだけ使う。
    //   左の列（上の帯＋最初の枠）と右の表の2枚を読ませる（文字層が無くても物件名・号室・賃料・面積を突き合わせに使える）。
    //   描画命令がある（PDF）＝ページ座標そのもの。左の列に画像があれば drawn（位置を確かめた）、無ければ fixed（線で描いた図・画像情報なし）。
    //   旧: 描画命令の画像をまとめて切っていた → 上の帯（号室）と表が入らず、ロゴだけの時は1ページ全体に戻っていた
    if (boxes) {
      // 2026-09-24 夜 実物の PDF（property_pickups 50〜67・18件）: 文字層がある（物件名・号室・賃料・面積・設備は文字で取れる）ので、
      //   読ませるのは画像だけ。左上の枠（x.028〜.262・y.108〜.458）は 16件中 13件が間取り図・2件が外観（間取り図は2つ目のマス）・
      //   1件は枠の下の方に小さな絵（間取り図は2つ目のマス）。画像が1つも無い「画像情報なし」が2件。
      //   → 画像1＝左上の枠（大きく読む）、画像2＝ほかのマスをまとめた物（間取り図が枠に無い時に探す）。
      //   ページ全体の範囲を1枚で渡すと枠の間取り図が 330px まで縮み、帖数の字が読めない
      const imgs = drawn.filter((b) => inside(b, ITANDI_SLOTS.imageArea, 0.02));
      // 枠の中から始まる画像（枠が大きい形＝写真の少ない資料で図が枠をはみ出す物も入れる）。隣のマス（x .266〜）は入れない
      const F = ITANDI_PDF_FRAME;
      const startsInFrame = (b: NormBox) => b.x >= F.x - 0.02 && b.x < F.x + F.w - 0.005 && b.y >= F.y - 0.02 && b.y < F.y + F.h - 0.005;
      const inFrame = imgs.filter(startsInFrame);
      const others = imgs.filter((b) => !startsInFrame(b));
      const rect = padBox(union([ITANDI_PDF_FRAME, ...inFrame]));
      return {
        mode: "itandi_pdf", rect, extra: others.length ? padBox(union(others)) : null, frame: "page",
        basis: imgs.length ? "drawn" : "fixed", photos: null,
        reason: imgs.length ? null : "画像の範囲に画像が無い（画像情報なし）",
      };
    }
    // 反証 2026-09-25: 縦向き（スマホの画面・縦の資料）に横向きの座標を当てると間取り図が切れる → 1ページ全体（旧の安全側を残す）
    if (aspect != null && Number.isFinite(aspect) && aspect > ITANDI_PORTRAIT_MIN_ASPECT) {
      return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "横向きの資料ではない（itandi の範囲を当てられない）" };
    }
    const frame: ItandiFrame = itandiFrameOf(aspect);
    const table = itandiRectFor(ITANDI_SLOTS.table, frame);
    // 2026-09-25 正解表（画像 25枚・PDF 18件で採点）: 左の列（帯＋枠＋写真の格子）を1枚で渡すと、間取り図は画像の 1/4 ほどで字がつぶれた
    //   （DeepSeek は画像を決まった大きさに縮める）。→ 画像1＝左上の枠だけ（画素で罫線を見つけた範囲・25枚中24枚で ±0.005）、
    //   画像2＝上の帯（物件名・号室）と右の表を縦に並べた物。枠が見つからない（画像情報なし・別の形）時は写真の範囲全体を画像1にする
    const f = found?.itandiFrame ?? null;
    const bandH = f ? Math.max(0.04, f.y - 0.002) : itandiRectFor(ITANDI_SLOTS.band, frame).h;
    const band: NormBox = { x: 0, y: 0, w: itandiRectFor(ITANDI_SLOTS.left, frame).w, h: bandH };
    const rect = f ? padBox(f, 0.004) : itandiRectFor(ITANDI_SLOTS.photoArea, frame);
    return { mode: "image_area", rect, extra: table, extraStack: [band, table], frame, basis: f ? "pixels" : "fixed", photos: null, reason: null };
  }
  return { mode: "page", rect: PAGE, basis: "page", photos: null, reason: "型が分からない資料" };
}

/**
 * itandi の資料画像（文字層・描画命令が無い）から、左上の枠（間取り図の枠）の黒い罫線を画素で探す。見つからなければ null。
 * 2026-09-25 正解表（itandi の資料画像 25枚）: DeepSeek は画像を決まった大きさに縮めて読む（トークンは画像の大きさでほぼ変わらない）ため、
 *   左の列（帯＋枠＋写真の格子）を渡すと間取り図は画像の 1/4 ほどしか無く、帖数・「浴室WC」・収納の字がつぶれて誤った
 *   （収納 75%・キッチン 91%・独立洗面 91%）。枠は 1〜3px の黒い罫線の四角で、左端は x .014〜.041・上端は y .10〜.13・
 *   右端は .25〜.51・下端は .45〜.81（A/B/C/画像なしの4形）。
 * 手順: 左端（x .08 以内）で「上下に .25 以上続く暗い縦線」の最初の列＝左辺（その線の上端・下端が枠の上辺・下辺）→
 *   上辺・下辺の行で左辺から右へ続く暗い横線の長い方の端＝右辺 → 右辺の縦線も 85% 以上暗い事を確かめる。
 *   上辺から下辺を探す形は、上辺の罫線が途中で切れた資料（002）と、枠の中の外観写真の下端を下辺と取り違えた資料（104）で外れた
 * @param px RGBA の画素（getImageData の data）
 */
export function findItandiFrameBox(px: ArrayLike<number>, width: number, height: number): NormBox | null {
  if (width < 200 || height < 150) return null;
  const DARK = 120, GAP = 2;
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < DARK;
  };
  const y0 = Math.floor(height * 0.06), y1 = Math.floor(height * 0.95);
  /** その列の一番長い暗い縦線（小さな切れ目は GAP px まで許す） */
  const longestV = (x: number): { ys: number; ye: number } | null => {
    let best: { ys: number; ye: number } | null = null, ys = -1, last = -1, gap = 0;
    for (let y = y0; y <= y1; y++) {
      if (dark(x, y)) { if (ys < 0) ys = y; last = y; gap = 0; }
      else if (ys >= 0 && ++gap > GAP) { if (!best || last - ys > best.ye - best.ys) best = { ys, ye: last }; ys = -1; gap = 0; }
    }
    if (ys >= 0 && (!best || last - ys > best.ye - best.ys)) best = { ys, ye: last };
    return best;
  };
  /** 行 y で x0 から右へ続く暗い横線の右端（±1 行の太さ・ぼけを許す） */
  const runRight = (x0: number, y: number) => {
    let last = x0, gap = 0;
    for (let x = x0; x < Math.floor(width * 0.56); x++) {
      const d = [y - 1, y, y + 1].some((yy) => yy >= 0 && yy < height && dark(x, yy));
      if (d) { last = x; gap = 0; } else if (++gap > GAP) break;
    }
    return last;
  };
  const colDark = (x: number, ya: number, yb: number) => {
    let n = 0, d = 0;
    for (let y = ya; y <= yb; y++) { n++; if (dark(x, y) || (x > 0 && dark(x - 1, y)) || (x + 1 < width && dark(x + 1, y))) d++; }
    return n ? d / n : 0;
  };
  const minH = Math.floor(height * 0.25), minW = Math.floor(width * 0.18);
  for (let x = 0; x < Math.floor(width * 0.08); x++) {
    const v = longestV(x);
    if (!v || v.ye - v.ys < minH) continue;
    // 上辺・下辺の線そのものの行で右へたどる（片方が途中で切れていても、もう片方で右端が取れる）
    const xe = Math.max(runRight(x, v.ys + 1), runRight(x, v.ye - 1));
    if (xe - x < minW) continue;
    if (colDark(xe, v.ys + 2, v.ye - 2) < 0.85) continue;
    const b = { x: x / width, y: v.ys / height, w: (xe - x + 1) / width, h: (v.ye - v.ys + 1) / height };
    // itandi の枠の位置の範囲（ページ・切り抜きの両方の実測＋余裕）。外れたら itandi の枠ではない（表の罫線・別の資料）
    if (b.x > 0.06 || b.y < 0.08 || b.y > 0.16 || b.x + b.w < 0.24 || b.x + b.w > 0.52 || b.y + b.h < 0.42 || b.y + b.h > 0.85) continue;
    return b;
  }
  return null;
}

/** 比率の範囲を画素に（整数・画像の中に収める） */
export function toPixelRect(r: NormBox, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.floor(r.x * width)), y = Math.max(0, Math.floor(r.y * height));
  const x2 = Math.min(width, Math.ceil((r.x + r.w) * width)), y2 = Math.min(height, Math.ceil((r.y + r.h) * height));
  return { x, y, width: Math.max(1, x2 - x), height: Math.max(1, y2 - y) };
}
