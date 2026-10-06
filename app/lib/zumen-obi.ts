// app/lib/zumen-obi.ts（純関数・何も import しない・画面とサーバー〔監査のスクリプト〕で共用）
// ITANDI の「まとめて図面取得」の ZIP（元付業者が作った募集図面）を、お客様に送れる形（弊社の帯に帯替え）にする判断の部分。
//
// 2026-10-06 竹内「まとめて図面ダウンロードをおして保存されるPDFをそのままAIXツールのところに入れて解析はできるのか
//   このようにまとめられているファイルの中にあるフォルダを　管理会社の帯もついているから加工して切り抜くのもできるのかな」
//   「このように下側に管理会社の情報が入っているので お客さん用に帯替えする必要がある」
//   「帯替えとはこのように弊社の情報に帯を変更するということ　帯の部分だけ判断して変えれば良い」
//
// 実物で分かった形（Downloads の ITANDI_BB_募集図面*.zip・2026-10-06 の13件ほか）:
//   - ZIP の中はフォルダ1つ・「連番_物件名 号室.pdf|.jpeg」。同じ号室が2ファイルある事がある（3_ラフォルテ日本橋 305.pdf は業者向けの案内のスキャン）
//   - PDF の1ページ目が図面。2ページ目以降は業者向けの案内（初期費用・申込書類の説明）・チラシ（LIVERO 等）＝お客様に送らない
//   - 帯（元付の会社の情報）は下端。会社ごとに形・色・高さが違う（ホームメイトはピンクの帯の画像・レオン都市開発は罫線の枠・
//     エスタス管財は 0.80 から下が「管理・お問い合わせ先＋案内方法＋部屋現況＋広告料」の段）
//   - 帯には手数料の配分（元付:0%・客付:100%）・広告料（AD）・紹介料・元付の連絡先＝お客様に見せてはいけない物が入る
//   - JPEG の図面（チラシの形）は文字の層が無く、帯の有無を確かめられない
//
// 決め方（決め打ちの座標を使わない・誤って本文を切らない側）:
//   1. 文字の層で「帯の目印」（免許番号・手数料の配分・広告料・AD n）を下の方（y ≥ 0.6）で探す
//   2. 目印の一番上より上で、文字も画像も横切らず・画素が空（または1本の罫線・色の帯の上端）の横の行を、下から探す＝切れ目
//   3. 切れ目のすぐ上の段が帯の言葉だけ（会社名・TEL・お問い合わせ・案内方法 等）なら、その段も帯に入れる
//   4. 帯の中に物件の内容（間取り・帖・専有面積・敷金 等）・大きな画像があれば止める／帯の外に手数料・AD・免許番号が残れば止める
//   どれかで迷えば「帯替えしない・スタッフに知らせる」（止めた理由の文を返す）。

/** 正規化した座標（0〜1・左上が原点・y は下向き） */
export type ObiBox = { x: number; y: number; w: number; h: number };
/** 文字の1片（pdfjs の textContent の item をページの比率にした物） */
export type ObiTextItem = { s: string; x0: number; y0: number; x1: number; y1: number };
/** 1行（同じ高さの文字の片をつないだ物） */
export type ObiLine = { text: string; x0: number; y0: number; x1: number; y1: number };

/** 行ごとの画素の様子（ページを描いた画素から作る） */
export type ObiRowProfile = {
  height: number;
  /** その行の「白でない」画素の割合（左右 2% の余白は除く） */
  ink: Float32Array;
  /** その行が1本の罫線・色の帯の端（同じ色が横に 50% 以上続く）か */
  rule: Uint8Array;
  /** 罫線の行の、一番長い同じ色の続きの左右の端（ページ比）。縦の線がこの範囲で交わるのは表の格子の区切り＝切ってよい */
  ruleX0?: Float32Array;
  ruleX1?: Float32Array;
  /**
   * その行を縦に横切る線（表の縦の罫線・枠の辺）の x（ページ比・まとめた中心）。無い行は省く（undefined）。
   * 2026-10-06 監査: 備考の枠の中の空の行（ワコーレグリーンコート芦屋）・右の表が下まで続く図面（アビタ小橋）で、
   *   文字の無い行を切れ目にして本文を帯に入れていた → 枠の外側の辺（ページの左右の端）以外を縦に横切る行は切らない
   */
  cross?: Array<number[] | undefined>;
  /** ページの絵の左右の端（ページ比）。枠の外側の辺かどうかの判定に使う */
  inkMinX?: number;
  inkMaxX?: number;
};

export type ObiPlan =
  | { kind: "replace"; cutY: number; zoneMarkers: string[]; warnings: string[] }
  | { kind: "stop"; code: ObiStopCode; reason: string; warnings: string[] };

export type ObiStopCode =
  | "rotated" | "no_text" | "not_zumen" | "no_band_marker" | "no_cut" | "band_too_tall"
  | "body_in_band" | "big_image_in_band" | "no_company_in_band" | "fee_outside_band" | "image_only";

// ── 言葉の目印 ─────────────────────────────────────────────────────────
/** 免許番号（大阪府知事(4)第52532号・国土交通大臣免許(4)第007609号・宅建免許 大阪府知事（1）66065） */
export const LICENSE_RE = /(?:知事|大臣)\s*(?:免許)?\s*[（(]\s*[0-9０-９]+\s*[）)]\s*(?:第\s*)?[0-9０-９]{3,}|宅建免許|宅地建物取引業者?\s*免許/;
/** 手数料の配分・広告料・紹介料・AD n（お客様に見せない物）。「取引態様」は本文の表にもあるので入れない */
export const FEE_RE = /(?:元付|客付|貸主|借主)\s*[:：]?\s*[0-9０-９]+(?:\.[0-9]+)?\s*[%％]|広告料|紹介料|(?<![A-Za-z])(?:AD|ＡＤ)\s*[:：]?\s*[0-9０-９]/;
const CORP_RE = /株式会社|有限会社|合同会社|[（(]\s*株\s*[）)]|㈱|㈲/;
const TEL_RE = /(?:TEL|Tel|ＴＥＬ|℡|☎|電話)|0[0-9]{1,4}\s*[-－‐ー]\s*[0-9]{1,4}\s*[-－‐ー]\s*[0-9]{3,4}/;
/**
 * 帯の中にあってはいけない物件の内容（間取り図の字・表の項目）。
 * ⚠ 「賃料」は帯の「賃料の100%」（寄付会社様への報酬）にもあるので、数字が続く時だけ。「所在地」は会社の所在地にもあるので入れない
 */
export const BODY_RE = /専有面積|間取り?\s*[:：]|築年|敷\s*金|礼\s*金|徒歩\s*[0-9０-９]|[0-9０-９.]+\s*帖|[0-9０-９.]+\s*畳|洋室|和室|ＬＤＫ|(?<![A-Za-z])[1-4]?S?LDK|バルコニー|浴室|玄関|(?:賃料|家賃)\s*[:：]?\s*[0-9０-９]|共益費|管理費/;
/** 切れ目の上の段を帯に含めてよい言葉（会社・連絡先・業者向けの案内） */
const BAND_WORD_RE = /管理|お?問い?合わ?せ|問合せ|案内|取引態様|担当|特記|仲介|ITANDI|イタンジ|申込|内見|内覧|物確|空室確認|公式\s*LINE|株式会社|有限会社|TEL|FAX|ＴＥＬ|ＦＡＸ|℡|〒|[Mm]ail|E-?mail|広告|手数料|紹介料|報酬|(?<![A-Za-z])AD|ＡＤ|Web受付|営業時間|定休日|免許|宅建|協会|保証協会|https?:|www\.|[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}/;
/** 図面（物件の資料）らしい言葉。3種類以上で図面とみなす（業者向けの案内・チラシを外す） */
const ZUMEN_WORDS: RegExp[] = [/賃\s*料|家\s*賃/, /間\s*取/, /専有面積|専\s*有|面\s*積/, /敷\s*金/, /礼\s*金/, /築\s*年|完成年月|竣工/, /交\s*通|徒歩/, /所\s*在\s*地|住\s*所/, /設\s*備/, /共益費|管理費/, /構\s*造/];
/** 本文に残っても止めないが、スタッフに知らせる業者向けの記載（鍵の場所・暗証番号） */
const BODY_WARN: Array<{ re: RegExp; label: string }> = [
  { re: /キー\s*(?:BOX|ＢＯＸ|ボックス)|鍵\s*[:：]|暗証\s*(?:番号)?\s*[:：]?\s*[0-9０-９]|ダイヤル\s*[0-9０-９]{3,}/, label: "本文に鍵・暗証番号の記載がある（お客様に見せてよいか確かめる）" },
  { re: /業者様|仲介業者|物確|物件確認\s*(?:TEL|ＴＥＬ|ダイヤル|[:：])|内見予約|内覧予約/, label: "本文に業者向けの記載がある（物件確認の電話・内見予約の案内等）" },
];

/** 帯の目印を探す範囲（これより下）・帯の高さの上限・目印の上から切れ目を探す下限 */
export const OBI_MARKER_MIN_Y = 0.6;
export const OBI_MAX_ZONE = 0.3;
/** 空の行とみなす白でない画素の割合 */
export const OBI_BLANK_INK = 0.015;
/** 帯の中で「大きな画像」とみなす面積（ページ比）。ロゴ・QR・ITANDI の案内の画像（〜0.017）は小さい */
export const OBI_BIG_IMAGE_AREA = 0.03;

// ── ファイル名 ─────────────────────────────────────────────────────────
/** 「0_ラフォルテ日本橋 408.pdf」→ 連番・物件名・号室。号室は最後の空白の後ろ（無ければ null） */
export function parseZumenName(fileName: string): { seq: number | null; name: string; room: string | null; key: string; ext: string } {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(base);
  const stem = (m?.[1] ?? base).trim();
  const ext = (m?.[2] ?? "").toLowerCase();
  const sm = /^(\d+)_(.*)$/.exec(stem);
  const seq = sm ? parseInt(sm[1], 10) : null;
  const rest = (sm ? sm[2] : stem).trim();
  const rm = /^(.*\S)[\s　]+([^\s　]+)$/.exec(rest);
  const name = (rm ? rm[1] : rest).trim();
  const room = rm ? rm[2].trim() : null;
  const key = `${name.normalize("NFKC").replace(/\s+/g, "")}|${(room ?? "").normalize("NFKC")}`;
  return { seq, name, room, key, ext };
}

/** ZIP の中の物を、物件（物件名＋号室）ごとにまとめる。並びは最初の連番の順。フォルダ・隠しファイル（__MACOSX 等）は外す */
export function groupZumenFiles<T extends { path: string }>(entries: T[]): Array<{ key: string; name: string; room: string | null; seq: number | null; files: T[] }> {
  const out = new Map<string, { key: string; name: string; room: string | null; seq: number | null; files: T[] }>();
  for (const e of entries) {
    const p = String(e.path ?? "");
    if (!p || p.endsWith("/") || /(^|\/)(__MACOSX|\.)/.test(p)) continue;
    if (!/\.(pdf|jpe?g|png|gif|webp)$/i.test(p)) continue;
    const n = parseZumenName(p);
    const g = out.get(n.key);
    if (g) { g.files.push(e); if (n.seq != null && (g.seq == null || n.seq < g.seq)) g.seq = n.seq; }
    else out.set(n.key, { key: n.key, name: n.name, room: n.room, seq: n.seq, files: [e] });
  }
  return [...out.values()].sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9));
}

// ── 文字の行 ───────────────────────────────────────────────────────────
/** 文字の片を行にまとめる（高さの中心が近い物を同じ行・左から並べる） */
export function linesFromItems(items: ObiTextItem[]): ObiLine[] {
  const its = items.filter((i) => i.s && i.s.trim() && i.y1 > i.y0).slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const lines: Array<{ items: ObiTextItem[]; cy: number; h: number }> = [];
  for (const it of its) {
    const cy = (it.y0 + it.y1) / 2, h = it.y1 - it.y0;
    const l = lines.find((L) => Math.abs(L.cy - cy) <= Math.max(L.h, h) * 0.45);
    if (l) { l.items.push(it); } else lines.push({ items: [it], cy, h });
  }
  return lines.map((L) => {
    const xs = L.items.slice().sort((a, b) => a.x0 - b.x0);
    // 1字ずつの片（ホームメイトの「第3 0 5 8 号」）を空白でつなぐと番号の目印に当たらない → 隣との隙間が字の高さの 0.3 未満なら詰める
    let text = "";
    xs.forEach((it, k) => {
      if (k > 0) {
        const prev = xs[k - 1];
        const gap = it.x0 - prev.x1;
        text += gap > Math.max(prev.y1 - prev.y0, it.y1 - it.y0) * 0.3 ? " " : "";
      }
      text += it.s;
    });
    return {
      text: text.replace(/\s+/g, " ").trim(),
      x0: Math.min(...xs.map((i) => i.x0)), x1: Math.max(...xs.map((i) => i.x1)),
      y0: Math.min(...xs.map((i) => i.y0)), y1: Math.max(...xs.map((i) => i.y1)),
    };
  }).sort((a, b) => a.y0 - b.y0);
}

/** 1行の言葉の目印（記録・画面の表示用） */
function markersOf(text: string): string[] {
  const m: string[] = [];
  if (LICENSE_RE.test(text)) m.push("免許番号");
  if (FEE_RE.test(text)) m.push("手数料・AD");
  if (CORP_RE.test(text)) m.push("会社名");
  if (TEL_RE.test(text)) m.push("TEL");
  return m;
}

/** 図面らしい言葉の種類の数 */
export function zumenWordKinds(text: string): number {
  return ZUMEN_WORDS.filter((re) => re.test(text)).length;
}

// ── 画素 ───────────────────────────────────────────────────────────────
/**
 * 描いたページの画素（RGBA）から行ごとの様子を作る。
 * rule: 同じ色（輝度の差 ≤ 18・色の差 ≤ 30）の画素が横に幅の 50% 以上続く行＝1本の罫線・色の帯の上端（写真の行は色が揃わない）
 */
export function rowProfileFromPixels(px: ArrayLike<number>, width: number, height: number): ObiRowProfile {
  const ink = new Float32Array(height), rule = new Uint8Array(height);
  const ruleX0 = new Float32Array(height), ruleX1 = new Float32Array(height);
  const xa = Math.floor(width * 0.02), xb = Math.ceil(width * 0.98);
  const span = Math.max(1, xb - xa), minRun = Math.floor(width * 0.5);
  for (let y = 0; y < height; y++) {
    let n = 0, run = 0, best = 0, bestEnd = 0, pr = -1, pg = -1, pb = -1, pl = -1;
    for (let x = xa; x < xb; x++) {
      const i = (y * width + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const notWhite = l < 235 || chroma > 30;
      if (notWhite) n++;
      if (notWhite && pl >= 0 && Math.abs(l - pl) <= 18 && Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb) <= 30) { run++; }
      else run = notWhite ? 1 : 0;
      if (run > best) { best = run; bestEnd = x; }
      if (notWhite) { pr = r; pg = g; pb = b; pl = l; } else { pl = -1; }
    }
    ink[y] = n / span;
    rule[y] = best >= minRun ? 1 : 0;
    if (rule[y]) { ruleX0[y] = (bestEnd - best + 1) / width; ruleX1[y] = bestEnd / width; }
  }
  // 縦に横切る線と、ページの絵の左右の端
  const lineDark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    return 0.299 * r + 0.587 * g + 0.114 * b < 200 || Math.max(r, g, b) - Math.min(r, g, b) > 50;
  };
  const near = (x: number, y: number) => lineDark(x, y) || (x > 0 && lineDark(x - 1, y)) || (x + 1 < width && lineDark(x + 1, y));
  const D = Math.max(3, Math.round(height * 0.004));
  const colInk = new Uint32Array(width);
  const cross: Array<number[] | undefined> = new Array(height);
  for (let y = 0; y < height; y++) {
    const xs: number[] = [];
    for (let x = xa; x < xb; x++) {
      if (!lineDark(x, y)) continue;
      colInk[x]++;
      if (y >= D && y + D < height && near(x, y - D) && near(x, y + D)) xs.push(x);
    }
    if (!xs.length) continue;
    const centers: number[] = [];
    let s = xs[0], last = xs[0];
    for (let k = 1; k <= xs.length; k++) {
      if (k < xs.length && xs[k] - last <= 2) { last = xs[k]; continue; }
      // 太い塊（幅 1.5% 超）は線ではなく絵・字の続き＝ink の判定に任せる
      if (last - s <= width * 0.015) centers.push((s + last) / 2 / width);
      if (k < xs.length) { s = xs[k]; last = xs[k]; }
    }
    if (centers.length) cross[y] = centers;
  }
  const minCol = Math.max(1, Math.floor(height * 0.01));
  let inkMinX = 0, inkMaxX = 1;
  for (let x = xa; x < xb; x++) if (colInk[x] >= minCol) { inkMinX = x / width; break; }
  for (let x = xb - 1; x >= xa; x--) if (colInk[x] >= minCol) { inkMaxX = x / width; break; }
  return { height, ink, rule, ruleX0, ruleX1, cross, inkMinX, inkMaxX };
}

// ── 帯を決める ─────────────────────────────────────────────────────────
export type ObiPlanInput = {
  /** ページの回転（pdfjs の page.rotate）。0 以外は止める */
  rotate?: number;
  items: ObiTextItem[];
  /** 描画命令から取った画像の位置（ページ比） */
  images: ObiBox[];
  rows: ObiRowProfile;
};

const isPageBackground = (b: ObiBox) => b.w >= 0.9 && b.h >= 0.5;

/** その行（ページ比の y）を、文字・画像・画素が横切っていないか（切ってよい行か） */
function rowIsClean(y: number, lines: ObiLine[], images: ObiBox[], rows: ObiRowProfile): boolean {
  const r = Math.min(rows.height - 1, Math.max(0, Math.round(y * rows.height)));
  if (!(rows.ink[r] <= OBI_BLANK_INK || rows.rule[r])) return false;
  // 枠の外側の辺（ページの絵の左右の端から 2.5% 以内）以外の縦の線が横切る行は切らない（表・枠の中）
  const cx = rows.cross?.[r];
  if (cx && rows.inkMinX != null && rows.inkMaxX != null) {
    // 罫線の行で、縦の線が罫線の続きの中で交わる所（表の格子の区切り）は可（エグゼレジデンスタワー 1309 の帯は本文の表と同じ格子）
    const onRule = (x: number) => !!rows.rule[r] && rows.ruleX0 != null && rows.ruleX1 != null && x >= rows.ruleX0[r] - 0.003 && x <= rows.ruleX1[r] + 0.003;
    if (cx.some((x) => x > rows.inkMinX! + 0.025 && x < rows.inkMaxX! - 0.025 && !onRule(x))) return false;
  }
  const tol = 0.5 / rows.height;
  if (lines.some((l) => y > l.y0 - tol && y < l.y1 + tol)) return false;
  // 画像を横切る行は切らない。ただし小さな画像（ロゴ・QR）で、その行の画素が空か罫線（＝画像の透明な余白の所）なら可
  //   （東洋MIRAI のロゴの画像は上に透明な余白があり、帯の罫線の行に箱だけが掛かっていた）
  if (images.some((b) => !isPageBackground(b) && b.w > 0.003 && b.h > 0.003 && y > b.y + tol && y < b.y + b.h - tol && b.w * b.h >= OBI_BIG_IMAGE_AREA)) return false;
  return true;
}

function warningsOf(lines: ObiLine[], cutY: number | null): string[] {
  const w: string[] = [];
  const body = lines.filter((l) => cutY == null || l.y1 <= cutY).map((l) => l.text).join("\n");
  for (const { re, label } of BODY_WARN) if (re.test(body)) w.push(label);
  return w;
}

/**
 * 図面の1ページ目で、帯（元付の会社の情報）の上の切れ目を決める。迷えば stop（帯替えしない）。
 * 切れ目より下（cutY〜1）を弊社の帯に替える。本文（切れ目より上）は1画素も変えない。
 */
export function planObiReplace(input: ObiPlanInput): ObiPlan {
  const rot = ((input.rotate ?? 0) % 360 + 360) % 360;
  const lines = linesFromItems(input.items ?? []);
  const allText = lines.map((l) => l.text).join("\n");
  const stop = (code: ObiStopCode, reason: string): ObiPlan => ({ kind: "stop", code, reason, warnings: warningsOf(lines, null) });
  if (rot !== 0) return stop("rotated", "ページが回転している資料（帯の位置を確かめられない）");
  if (allText.replace(/\s/g, "").length < 30) return stop("no_text", "文字の層が無い資料（スキャン・画像だけ）＝図面か・帯がどこかを確かめられない");
  if (zumenWordKinds(allText) < 3) return stop("not_zumen", "図面ではない資料（賃料・間取り・面積などの項目が無い＝業者向けの案内・チラシ等）");

  const strong = lines.filter((l) => l.y0 >= OBI_MARKER_MIN_Y && (LICENSE_RE.test(l.text) || FEE_RE.test(l.text)));
  if (!strong.length) return stop("no_band_marker", "下の方に帯の目印（免許番号・手数料の配分・広告料・AD）が無い");
  const minStrong = Math.min(...strong.map((l) => l.y0));

  const H = input.rows.height;
  const step = 1 / H;
  const lo = 1 - OBI_MAX_ZONE;
  /** 下から上へ、y から最初の「切ってよい行」 */
  const findClean = (from: number): number | null => {
    for (let y = from; y >= lo; y -= step) if (rowIsClean(y, lines, input.images, input.rows)) return y;
    return null;
  };
  const cut0 = findClean(minStrong - step);
  if (cut0 == null) return stop("no_cut", "帯の上の境目（文字・画像を横切らない空の行・罫線）が見つからない");

  // 切れ目のすぐ上の段が帯の言葉だけ（会社名・お問い合わせ・案内方法の見出し等）なら帯に入れる
  let cut: number = cut0;
  for (let guard = 0; guard < 6; guard++) {
    // 上の段の上端＝cut から上へ、汚れた行が続いた後の最初のきれいな行
    let y: number = cut - step;
    while (y >= lo && rowIsClean(y, lines, input.images, input.rows)) y -= step;
    if (y < lo) break;
    const blockBottom: number = y;
    while (y >= lo && !rowIsClean(y, lines, input.images, input.rows)) y -= step;
    if (y < lo) break;
    const blockTop: number = y;
    if (blockBottom - blockTop > 0.06) break;
    // 空きが広い（2% 超）上の段は帯ではない（2026-10-06 監査: ワコーレグリーンコート芦屋の備考の※の行を「内覧」の語で帯に入れていた）
    if (cut - blockBottom > 0.02) break;
    const inBlock = lines.filter((l) => l.y1 > blockTop && l.y0 < blockBottom + step);
    const imgs = input.images.filter((b) => !isPageBackground(b) && b.y + b.h > blockTop && b.y < blockBottom + step);
    if (!inBlock.length) break;
    // ※で始まる行は本文の注意書き（帯に入れない）
    if (!inBlock.every((l) => BAND_WORD_RE.test(l.text) && !BODY_RE.test(l.text) && !/^[※＊*]/.test(l.text))) break;
    if (imgs.some((b) => b.w * b.h >= OBI_BIG_IMAGE_AREA)) break;
    cut = blockTop;
  }

  if (1 - cut > OBI_MAX_ZONE) return stop("band_too_tall", `帯が高すぎる（ページの ${Math.round((1 - cut) * 100)}%）`);
  const zone = lines.filter((l) => l.y0 >= cut);
  const zoneText = zone.map((l) => l.text).join("\n");
  const body = zone.find((l) => BODY_RE.test(l.text));
  if (body) return stop("body_in_band", `帯の範囲に物件の内容がある（「${body.text.slice(0, 24)}」）`);
  const big = input.images.find((b) => !isPageBackground(b) && b.y >= cut - 0.002 && b.w * b.h >= OBI_BIG_IMAGE_AREA && !(b.w >= 0.9));
  if (big) return stop("big_image_in_band", "帯の範囲に大きな画像（写真・間取り図の可能性）がある");
  if (!(LICENSE_RE.test(zoneText) || (CORP_RE.test(zoneText) && TEL_RE.test(zoneText)))) {
    return stop("no_company_in_band", "帯の範囲に会社の情報（免許番号・会社名と TEL）が無い");
  }
  const leftover = lines.find((l) => l.y1 <= cut && (FEE_RE.test(l.text) || LICENSE_RE.test(l.text)));
  if (leftover) return stop("fee_outside_band", `帯の外にも手数料・AD・免許番号の記載がある（「${leftover.text.slice(0, 24)}」）`);

  const zoneMarkers = [...new Set(zone.flatMap((l) => markersOf(l.text)))];
  return { kind: "replace", cutY: cut, zoneMarkers, warnings: warningsOf(lines, cut) };
}

// ── 弊社の帯を描く ─────────────────────────────────────────────────────
/** 2D の描く道具の最小の形（ブラウザの canvas と @napi-rs/canvas の両方が満たす） */
export type ObiCtx = {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void;
};

/** 帯を置く位置（画素）。帯の範囲（cutY〜下端）の中に、弊社の帯の画像を縦横比のまま入れる（左寄せ・上下中央） */
export function obiPlacement(pageW: number, pageH: number, cutY: number, band: { width: number; height: number }): { fill: { x: number; y: number; w: number; h: number }; draw: { x: number; y: number; w: number; h: number } } {
  const top = Math.max(0, Math.floor(cutY * pageH));
  const zoneH = pageH - top;
  const padX = Math.round(pageW * 0.02), padY = Math.max(2, Math.round(zoneH * 0.08));
  const maxW = pageW - padX * 2, maxH = Math.max(1, zoneH - padY * 2);
  const k = Math.min(maxW / band.width, maxH / band.height);
  const w = Math.max(1, Math.round(band.width * k)), h = Math.max(1, Math.round(band.height * k));
  return { fill: { x: 0, y: top, w: pageW, h: zoneH }, draw: { x: padX, y: top + Math.round((zoneH - h) / 2), w, h } };
}

/** 帯の範囲を白で消し、弊社の帯の画像を置き、上に細い線を引く（本文は触らない） */
export function paintObi(ctx: ObiCtx, pageW: number, pageH: number, cutY: number, band: { width: number; height: number; image: unknown }): void {
  const p = obiPlacement(pageW, pageH, cutY, band);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(p.fill.x, p.fill.y, p.fill.w, p.fill.h);
  ctx.fillStyle = "#9e9e9e";
  ctx.fillRect(Math.round(pageW * 0.015), p.fill.y + 1, Math.round(pageW * 0.97), Math.max(1, Math.round(pageH / 900)));
  ctx.drawImage(band.image, p.draw.x, p.draw.y, p.draw.w, p.draw.h);
}

/** 止めた・帯替えした結果の札（画面の一覧の1行） */
export function obiResultLabel(plan: ObiPlan): string {
  if (plan.kind === "replace") return `帯替えした（帯の目印: ${plan.zoneMarkers.join("・") || "—"}）`;
  return `帯替えしていない: ${plan.reason}`;
}
