/**
 * 自動モードの弱点を録画から見つけ、**通常モードの手本から直し方を作る**（2026-11-15 竹内さん）
 *
 *   竹内さん「自動モードの弱い部分も録画などから必要な時見つけ出して
 *     通常モードの学習から改善して実装するようにする そして強化していく」
 *
 * ★ この道具の流れ（1本にする）
 *   ① **自動モードの弱点を見つける**（録画の実測から・推測しない）
 *   ② **通常モードの手本と比べる**（人がどうやっているか）
 *   ③ **直し方を1つに決める**（費用・効く事・目標つき）
 *   ④ 記録に残す（次に同じ指摘を繰り返さない）
 *
 * ★ なぜ「通常モードの手本」から作るのか
 *   ⚠ 自動モードの録画だけ見ても「正解」が分からない。
 *     正解は**人がやった動き（通常モード）**にある。
 *     実測: 通常モードは操作の並び97%・カーソル94%・押した位置74%。
 *     自動モードは押した位置が12% → **通常モードの74%が正解の目安**になる。
 *
 * ⚠ 入れるのは数と名前だけ（中身・お客様の情報は入れない）。
 */

/** 1件の操作（`shot_ops` の形） */
export type DiagOp = {
  t?: number | null;
  k?: string | null;
  f?: string | null;
  w?: string | null;
  by?: string | null;
  was?: boolean | null;
  now?: boolean | null;
};

/** 1枚 */
export type DiagRow = {
  created_at?: string | null;
  shot_ops?: DiagOp[] | null;
  point_fields?: Record<string, unknown> | null;
  moves_n?: number | null;
};

/** 自動モードの弱点1つ */
export type AutoWeak = {
  /** 弱点の種類 */
  kind: "missing_field" | "no_cursor" | "no_point" | "changed_without_click" | "typed_on_choose" | "order_diff";
  /** 何が起きているか（1行） */
  what: string;
  /** 実測の数字 */
  why: string;
  /** 通常モードではどうやっているか（手本） */
  human: string;
  /** どう直すか */
  how: string;
  /** 費用 */
  cost: string;
  /** 効いたかの目安 */
  target: string;
};

/**
 * 自動モードの録画と通常モードの手本から、**直すべき弱点**を出す（純関数）。
 *   ⚠ 自動モードだけを見ない。**通常モードの手本と比べて**出す（正解は人にある）。
 */
export function findAutoWeaks(
  auto: ReadonlyArray<DiagRow>,
  human: ReadonlyArray<DiagRow>,
): AutoWeak[] {
  const a = (Array.isArray(auto) ? auto : []).filter((r) => r && typeof r === "object");
  const h = (Array.isArray(human) ? human : []).filter((r) => r && typeof r === "object");
  const out: AutoWeak[] = [];
  if (!a.length) return out;

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  // ① カーソル
  const aCursor = a.filter((r) => Number(r.moves_n) > 0).length;
  const hCursor = h.filter((r) => Number(r.moves_n) > 0).length;
  const ap = pct(aCursor, a.length), hp = pct(hCursor, h.length);
  if (h.length && hp - ap >= 30) {
    out.push({
      kind: "no_cursor",
      what: "自動モードでカーソルの動きが記録されていない",
      why: `通常 ${hp}% / 自動 ${ap}%（差 ${hp - ap}）`,
      human: "人は必ずカーソルを動かしてから押す（mousemove が出ている）",
      how: "押す前にカーソルを動かし、mousemove を出す（`pointer-ui` の移動）",
      cost: "0円",
      target: `自動を ${Math.min(hp, 80)}% 以上（人に近づける）`,
    });
  }

  // ② 押した位置
  const aPoint = a.filter((r) => r.point_fields && Object.keys(r.point_fields).length > 0).length;
  const hPoint = h.filter((r) => r.point_fields && Object.keys(r.point_fields).length > 0).length;
  const app = pct(aPoint, a.length), hpp = pct(hPoint, h.length);
  if (h.length && hpp - app >= 30) {
    out.push({
      kind: "no_point",
      what: "自動モードで押した位置が記録されていない",
      why: `通常 ${hpp}% / 自動 ${app}%（差 ${hpp - app}）`,
      human: "人は要素の中の**実際の位置**を押している（真ん中とは限らない）",
      how: "自動でも**カーソルの実際の位置**を記録する（v2.7.82 で実装）",
      cost: "0円",
      target: `自動を ${Math.min(hpp, 70)}% 以上`,
    });
  }

  // ③ 押さずに値が変わった
  const changedNoClick: string[] = [];
  for (const r of a) {
    const raw: DiagOp[] = Array.isArray(r.shot_ops) ? (r.shot_ops as DiagOp[]) : [];
    const ops: DiagOp[] = raw.filter((o: DiagOp) => !!o && !!o.f);
    const clicked = new Set<string>(ops.filter((o: DiagOp) => o.k === "click" || o.k === "tap").map((o: DiagOp) => String(o.f)));
    for (const o of ops) {
      if (o.k === "change" && o.f && !clicked.has(String(o.f)) && changedNoClick.indexOf(String(o.f)) < 0) {
        changedNoClick.push(String(o.f));
      }
    }
  }
  if (changedNoClick.length) {
    out.push({
      kind: "changed_without_click",
      what: "押さずに値が変わっている欄がある",
      why: `${changedNoClick.length}件（${changedNoClick.slice(0, 3).join("・")}）`,
      human: "人はプルダウンを**開いてから**選ぶ（click → change の順）",
      how: "値を入れる前に欄を開く（`chooseSelectLikeHuman` の見える一覧）",
      cost: "0円",
      target: "押さずに変わった欄を 0件",
    });
  }

  // ④ 選ぶ欄に打ち込んだ
  const typedChoose: string[] = [];
  for (const r of a) {
    for (const o of (Array.isArray(r.shot_ops) ? r.shot_ops : [])) {
      if (!o || o.k !== "key" || !o.f) continue;
      const w = String(o.w ?? "");
      if (w === "select" || w === "checkbox" || w === "radio") {
        const f = String(o.f);
        if (typedChoose.indexOf(f) < 0) typedChoose.push(f);
      }
    }
  }
  if (typedChoose.length) {
    out.push({
      kind: "typed_on_choose",
      what: "選ぶ欄に文字を打ち込んでいる",
      why: `${typedChoose.length}件（${typedChoose.slice(0, 3).join("・")}）`,
      human: "人はプルダウン・チェックを**選ぶ**（打ち込まない）",
      how: "プルダウン・チェックは開いて選ぶ（打ち込まない）",
      cost: "0円",
      target: "0件",
    });
  }

  // ⑤ 人が押す欄を自動が押していない（名前に着目・拡張自身は除く）
  const humanFields = new Set<string>();
  const autoFields = new Set<string>();
  for (const r of h) for (const o of (Array.isArray(r.shot_ops) ? r.shot_ops : [])) {
    if (o && o.f && !/aixlinx|axlx/i.test(String(o.f))) humanFields.add(String(o.f));
  }
  for (const r of a) for (const o of (Array.isArray(r.shot_ops) ? r.shot_ops : [])) {
    if (o && o.f) autoFields.add(String(o.f));
  }
  const missing = [...humanFields].filter((f) => !autoFields.has(f) && !/aixlinx|axlx/i.test(f));
  if (missing.length >= 3) {
    out.push({
      kind: "missing_field",
      what: "人が押す欄を自動モードが押していない",
      why: `${missing.length}欄（${missing.slice(0, 4).join("・")}）`,
      human: `人が ${humanFields.size}種類の欄を押している`,
      how: "人の手順を束に載せる（v2.7.80・`div.building_tr` を学ぶようにした）",
      cost: "0円",
      target: `自動の欄を ${humanFields.size}種類に近づける`,
    });
  }

  return out;
}

/**
 * 弱点を「やる順」に並べる（費用が安く・効きやすい物が先）。
 *   ⚠ 記録の取り方（0円）を先に直す。中身を学ぶのは後。
 */
export function orderWeaks(list: ReadonlyArray<AutoWeak>): AutoWeak[] {
  const RANK: Record<string, number> = {
    changed_without_click: 1,   // 別のお客さんの条件で検索する危険に直結
    typed_on_choose: 2,
    no_point: 3,
    no_cursor: 4,
    missing_field: 5,
    order_diff: 6,
  };
  return (Array.isArray(list) ? list : []).slice().sort((x, y) => (RANK[x.kind] ?? 9) - (RANK[y.kind] ?? 9));
}
