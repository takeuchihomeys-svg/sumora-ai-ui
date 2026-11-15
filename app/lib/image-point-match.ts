/**
 * 画像から読んだ欄と「実際に押した位置」を突き合わせる（2026-11-15 竹内さん）
 *
 *   竹内さん「弱い部分みて自動の録画のところからおかしい部分を統括具体的に把握
 *     通常モードの録画から細かい部分の動き見て改善するようにする この考え方統括大切にする
 *     押した位置も画像みたら理解できるし
 *     どこがプルダウンかどこ押しているかも通常モードの録画みて統括理解して
 *     学習したのを自動モードに反映したらきょうかされる」
 *
 * ★ 考え方（統括が大切にする事）
 *   ① **自動モードの録画から「おかしい所」を具体的に**見つける
 *   ② **通常モードの録画（人）から細かい動き**を学ぶ
 *   ③ **画像から「どこに何があるか」**が分かる（押した位置も・プルダウンも）
 *   ④ 学んだ事を**自動モードに反映**すれば強化される
 *
 * ★ この道具がやる事
 *   画像から読んだ欄（`shot_learn` の fields：名前・種類・**位置**・領域）と、
 *   実際に押した位置（`point_fields`：欄ごとの**押した場所**）を**突き合わせる**。
 *
 *   ⚠ 実測で分かった事:
 *     `shot_learn` は「マップ検索 x=0.05 y=0.23」のように**画面のどこに何があるか**を持つ。
 *     `point_fields` は「その欄の**中**のどこを押したか」（0〜1）を持つ。
 *     → **役割が違う**。混ぜると意味が壊れる（画面の位置と要素の中の位置）。
 *       突き合わせる時は**別々に扱う**。
 *   ⚠ `point_fields` が `{}`（空）の記録を「ある」と数えない（実測で踏んだ）。
 */

/** 画像から読んだ欄 */
export type ImageField = {
  name?: unknown;
  kind?: unknown;
  x?: unknown;
  y?: unknown;
  zone?: unknown;
};

/** 押した位置（要素の中の割合） */
export type PressedPoint = { n?: unknown; x?: unknown; y?: unknown; w?: unknown };

/** 突き合わせた1欄 */
export type FieldMatch = {
  /** 欄の名前 */
  name: string;
  /** 画像から読んだ種類（select / button …） */
  imgKind: string | null;
  /** 実際に押した時の種類（w） */
  pressedKind: string | null;
  /** 種類が一致するか（undefined＝比べられない） */
  kindMatch: boolean | null;
  /** 画像での画面の位置（0〜1） */
  screenX: number | null;
  screenY: number | null;
  /** 実際に押した（要素の中の割合） */
  pressX: number | null;
  pressY: number | null;
  /** 押した回数 */
  n: number;
};

/** 突き合わせの結果 */
export type ImagePointMatch = {
  /** 画像から読んだ欄の数 */
  imageFields: number;
  /** 実際に押した欄の数（空でない物だけ） */
  pressedFields: number;
  /** 両方にある欄 */
  matched: FieldMatch[];
  /** 画像にあるが押していない欄（＝まだ使えていない） */
  notPressed: string[];
  /** 押したが画像に無い欄（＝画像が読めていない） */
  notInImage: string[];
  /** ⚠ 種類が違う欄（プルダウンなのに押す扱い等） */
  kindConflicts: FieldMatch[];
  /** 人が読む1行 */
  line: string;
};

const nm = (v: unknown) => String(v == null ? "" : v).replace(/^(左の|右の|上の|下の)/, "").replace(/｜[^｜]*$/, "").trim();

/**
 * 同じ欄かどうか（純関数）。
 *   ⚠ 名前は表記が揺れる（`左の検索｜span` / `検索`）ので**接頭辞とタグ名を落として比べる**。
 *   ⚠ 完全一致だけでなく、**片方が他方を含む**時も同じとみなす（`大阪市西区` ⊂ `左の大阪市西区`）。
 */
export function sameField(a: unknown, b: unknown): boolean {
  const x = nm(a), y = nm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  /**
   * ★ 2026-11-15 実測で判明（**誤った対応**が出た）:
   *   ⚠ `"2"` と `"2"` が一致して、画像の「2」（ページ送り）に
   *     押した記録の「2」（賃料の選択肢）を対応させていた。
   *     → **短い名前（3文字未満）は部分一致させない**。
   *   ⚠ `"絞り込み条件"` が別の欄に当たっていたのも同じ理由。
   *   → **部分一致は4文字以上**に限る。
   */
  const minLen = 4;
  if (x.length < minLen || y.length < minLen) return false;
  if (x.includes(y) || y.includes(x)) {
    /**
     * ⚠ さらに、**片方が極端に短い**時は部分一致にしない（`検索` ⊂ `住居検索` は良いが
     *   `2` ⊂ `2024` のような誤爆を防ぐ）。
     */
    const short = Math.min(x.length, y.length);
    const long = Math.max(x.length, y.length);
    if (short / long < 0.5) return false;
    return true;
  }
  return false;
}

/**
 * 画像から読んだ欄と押した位置を突き合わせる（純関数）。
 *   ⚠ `point_fields` が空（`{}`）なら**押していない**として扱う（実測で踏んだ罠）。
 */
export function matchImageToPressed(
  imageFields: ReadonlyArray<ImageField>,
  pressed: Record<string, PressedPoint> | null | undefined,
): ImagePointMatch {
  const img = (Array.isArray(imageFields) ? imageFields : [])
    .filter((f): f is ImageField => !!f && typeof f === "object")
    .map((f) => ({ name: nm(f.name), kind: String(f.kind ?? "").toLowerCase() || null, x: typeof f.x === "number" ? f.x : null, y: typeof f.y === "number" ? f.y : null }))
    .filter((f) => !!f.name);

  // ⚠ 空のオブジェクトは「押していない」
  const pressedList = (pressed && typeof pressed === "object" && Object.keys(pressed).length)
    ? Object.entries(pressed).map(([k, v]) => {
        const p = (v && typeof v === "object" ? v : {}) as PressedPoint;
        return {
          name: nm(k),
          kind: String(p.w ?? "").toLowerCase() || null,
          x: typeof p.x === "number" ? p.x : null,
          y: typeof p.y === "number" ? p.y : null,
          n: Number(p.n) || 0,
        };
      }).filter((p) => !!p.name)
    : [];

  const used = new Set<number>();
  const matched: FieldMatch[] = [];
  const notPressed: string[] = [];
  const kindConflicts: FieldMatch[] = [];

  /**
   * ★ 2026-11-15 実測で判明（**誤った対応**）:
   *   ⚠ 画像の `"2"（link）` に、押した記録の `"2"（select）` を対応させていた。
   *     名前が同じでも**種類が違えば別の欄**（ページ送り vs 賃料の選択肢）。
   *   → 名前が同じでも**種類が食い違う時は対応させない**（`notPressed` 側に回す）。
   *     ⚠ 種類が片方でも空なら、名前だけで対応させる（比べられないので）。
   */
  const kindCompatible = (a: string | null, b: string | null): boolean => {
    if (!a || !b) return true;            // 比べられない時は名前で判断
    if (a === b) return true;
    // ⚠ 似た種類は許す（link と button はサイトによって同じ物を指す）
    const near = (x: string, y: string) =>
      (x === "link" && y === "button") || (x === "button" && y === "link") ||
      (x === "text" && y === "select") || (x === "select" && y === "text");
    return near(a, b);
  };

  for (const f of img) {
    let hit = -1;
    for (let i = 0; i < pressedList.length; i++) {
      if (used.has(i)) continue;
      if (!sameField(f.name, pressedList[i].name)) continue;
      // ⚠ 種類が食い違う物は対応させない（別の欄の可能性）
      if (!kindCompatible(f.kind, pressedList[i].kind)) continue;
      hit = i; break;
    }
    if (hit < 0) { notPressed.push(f.name); continue; }
    used.add(hit);
    const p = pressedList[hit];
    /**
     * 種類の一致: 画像は `select`、押した記録は `select`。
     * ⚠ 片方が空なら比べない（null）。
     */
    const kindMatch = (f.kind && p.kind) ? f.kind === p.kind : null;
    const m: FieldMatch = {
      name: f.name, imgKind: f.kind, pressedKind: p.kind, kindMatch,
      screenX: f.x, screenY: f.y, pressX: p.x, pressY: p.y, n: p.n,
    };
    matched.push(m);
    if (kindMatch === false) kindConflicts.push(m);
  }

  const notInImage = pressedList.filter((_p, i) => !used.has(i)).map((p) => p.name);

  const parts: string[] = [];
  parts.push(`画像 ${img.length}欄／押した ${pressedList.length}欄`);
  if (matched.length) parts.push(`両方にある ${matched.length}欄`);
  if (notPressed.length) parts.push(`画像にあるが押していない ${notPressed.length}欄`);
  if (notInImage.length) parts.push(`⚠ 押したが画像に無い ${notInImage.length}欄`);
  if (kindConflicts.length) parts.push(`⚠ 種類が違う ${kindConflicts.length}欄`);

  return {
    imageFields: img.length,
    pressedFields: pressedList.length,
    matched, notPressed, notInImage, kindConflicts,
    line: parts.join("／"),
  };
}

/**
 * ★ 2026-11-15 竹内さん「押した位置も画像みたら理解できるし どこがプルダウンかどこ押しているかも
 *   通常モードの録画みて統括理解して」:
 *
 *   突き合わせから**統括が言える事**を出す。
 *   ⚠ 悪い所だけを名指しする（良ければ言わない）。
 */
export function whatSupervisorCanSay(r: ImagePointMatch): Array<{ what: string; why: string; next: string }> {
  const out: Array<{ what: string; why: string; next: string }> = [];
  if (r.kindConflicts.length) {
    const s = r.kindConflicts.slice(0, 3).map((m) => `${m.name}（画像=${m.imgKind ?? "?"}・記録=${m.pressedKind ?? "?"}）`);
    out.push({
      what: "画像で見た種類と、押した記録の種類が違う欄がある",
      why: `${r.kindConflicts.length}欄: ${s.join("・")}`,
      next: "画像（実際の見た目）を採る。プルダウンは開いて選ぶ・ボタンは押すだけ",
    });
  }
  if (r.pressedFields === 0) {
    out.push({
      what: "押した位置が1つも記録されていない",
      why: `画像からは ${r.imageFields}欄 読めているのに、押した場所が空`,
      next: "押した時に「要素の中のどこか」を残す（真ん中固定にしない）",
    });
  } else if (r.notPressed.length >= 5) {
    out.push({
      what: "画像にあるのに押していない欄が多い",
      why: `${r.notPressed.length}欄（${r.notPressed.slice(0, 3).join("・")}）`,
      next: "その欄を押す手順が手本にあるか確かめる（無ければ人が1回やる）",
    });
  }
  if (r.notInImage.length >= 5) {
    out.push({
      what: "押しているのに画像に写っていない欄がある",
      why: `${r.notInImage.length}欄（${r.notInImage.slice(0, 3).join("・")}）`,
      next: "写真の大きさ・撮るタイミングを見直す（画面全体を読めているか）",
    });
  }
  return out;
}
