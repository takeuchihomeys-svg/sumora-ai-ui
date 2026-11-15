/**
 * 自動モードが「人間のように」動いているかを点検する（2026-11-15 竹内さん）
 *
 *   竹内さん「自動で直接入力されている部分ないかちゃんと人間のように
 *     入力やクリックカーソルの移動おこなっているか その部分も強化するようにする
 *     弱い部分は補強していく土台をつくって」
 *
 * ★ なぜ要るか（**私が誤判定した**）
 *   写真1枚ごとの `shot_ops` を見て「押さずに値だけ変わった欄が67回」と報告したが、
 *   実際は `click` と `change` が**別の写真に分かれていた**だけだった
 *   （実測: rental_cost2 は change×15 だけ、transportation_id は click×16+change×25）。
 *   → **写真をまたいで1本にまとめてから**判定しないと、正しく見えない。
 *
 * ★ 何を見るか
 *   ① **直接打ち込み**（`key`）が「選ぶ欄」（select / checkbox）に使われていないか
 *   ② **押してから変えたか**（click → change の順になっているか）
 *   ③ **カーソルの動き**が記録されているか（人の速さに寄せられているか）
 *   ④ **押した位置**が記録されているか（要素の中のどこを押したか）
 *
 * ⚠ 入れるのは**欄の名前・操作の種類・真偽**だけ（入力した中身は見ない）。
 */

/** 1件の操作 */
export type AuditOp = {
  t?: number | null;
  k?: string | null;
  f?: string | null;
  w?: string | null;
  by?: string | null;
  was?: boolean | null;
  now?: boolean | null;
};

/** 1枚（写真1枚の記録） */
export type AuditRow = {
  created_at?: string | null;
  shot_ops?: AuditOp[] | null;
  point_fields?: Record<string, unknown> | null;
  moves_n?: number | null;
  move_speed_px_s?: number | null;
};

/** 「選ぶ欄」の名前（打ち込むのではなく選ぶべき物） */
export function isChooseField(name: unknown, kind?: unknown): boolean {
  const n = String(name ?? "");
  const w = String(kind ?? "");
  if (w === "select" || w === "checkbox" || w === "radio") return true;
  return /^(select|checkbox|radio)$/.test(w) ||
    /rental_cost\d?$|room_layout|update_date|structured_date|square_meter|transportation_id|^city_code|^town_code|^station|^route_id|^structured_type|include_common|deposit_recommpence|building_age/.test(n);
}

/**
 * 写真1枚ごとに切れている記録を**1本にまとめる**（純関数）。
 *   ⚠ これが**一番大事**。写真をまたいで `click` → `change` を繋がないと
 *     「押さずに値が変わった」と**誤判定する**（実測で67回と誤って報告した）。
 *   ⚠ 同じ操作が何枚にも載るので**重複を除く**（`f|k|t` で同一とみなす）。
 */
export function mergeOpsAcrossShots(rows: ReadonlyArray<AuditRow>): AuditOp[] {
  const seen = new Set<string>();
  const out: AuditOp[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const o of (Array.isArray(r?.shot_ops) ? r.shot_ops : [])) {
      if (!o || typeof o !== "object" || !o.f) continue;
      const key = String(o.f) + "|" + String(o.k) + "|" + String(o.t);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
    }
  }
  return out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
}

/**
 * 自動モードの「人間らしさ」を点検する（純関数）。
 *   ⚠ **写真をまたいでまとめた操作**で判定する（1枚ずつ見ない）。
 */
export function auditHumanLike(rows: ReadonlyArray<AuditRow>): {
  /** 操作の総数 */
  ops: number;
  /** 直接打ち込み（key）の数 */
  typed: number;
  /** そのうち「選ぶ欄」に打ち込んだ疑い（⚠ 0 が理想） */
  typedOnChoose: string[];
  /** 押してから変えた欄（正しい形） */
  clickedThenChanged: string[];
  /** 押さずに値が変わった欄（⚠ 0 が理想・本当に直接入れた疑い） */
  changedWithoutClick: string[];
  /** カーソルの動きが記録されている枚数 */
  withCursor: number;
  /** 押した位置が記録されている枚数 */
  withPoint: number;
  /** 記録の枚数 */
  rows: number;
  /** 人の速さに寄っているか（px/s の中央値） */
  speedMedian: number | null;
  /** 人が読む1行 */
  line: string;
} {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];
  const ops = mergeOpsAcrossShots(list);

  let typed = 0;
  const typedOnChooseSet = new Set<string>();
  for (const o of ops) {
    if (String(o.k) !== "key") continue;
    typed++;
    const f = String(o.f ?? "");
    if (f && isChooseField(f, o.w)) typedOnChooseSet.add(f);
  }

  /**
   * 欄ごとに「押した（click/tap）」と「変わった（change）」の**最初の時刻**を比べる。
   *   ⚠ 押す → 変わった の順なら正しい（人が開いて選んだ）。
   *     変わった だけなら**押さずに入れた疑い**。
   */
  const firstClick = new Map<string, number>();
  const firstChange = new Map<string, number>();
  for (const o of ops) {
    const f = String(o.f ?? "");
    if (!f) continue;
    const t = Number(o.t) || 0;
    const k = String(o.k ?? "");
    if (k === "click" || k === "tap") {
      if (!firstClick.has(f) || t < (firstClick.get(f) ?? Infinity)) firstClick.set(f, t);
    } else if (k === "change") {
      if (!firstChange.has(f) || t < (firstChange.get(f) ?? Infinity)) firstChange.set(f, t);
    }
  }
  const clickedThenChanged: string[] = [];
  const changedWithoutClick: string[] = [];
  for (const [f, tc] of firstChange) {
    const tk = firstClick.get(f);
    if (tk == null) changedWithoutClick.push(f);
    else if (tk <= tc || tc - tk <= 5000) clickedThenChanged.push(f);   // ⚠ 5秒以内なら同じ操作
    else changedWithoutClick.push(f);
  }

  const withCursor = list.filter((r) => Number(r.moves_n) > 0).length;
  const withPoint = list.filter((r) => r.point_fields && Object.keys(r.point_fields).length > 0).length;
  const sp = list.map((r) => Number(r.move_speed_px_s)).filter((x) => x > 0).sort((a, b) => a - b);
  const speedMedian = sp.length ? sp[Math.floor(sp.length / 2)] : null;

  const parts: string[] = [];
  parts.push(`操作 ${ops.length}件`);
  if (typedOnChooseSet.size) parts.push(`⚠ 選ぶ欄に打ち込んだ疑い ${typedOnChooseSet.size}件（${[...typedOnChooseSet].slice(0, 3).join("・")}）`);
  else if (typed) parts.push(`打ち込み ${typed}件（すべて文字の欄）`);
  else parts.push("直接打ち込みなし");
  if (changedWithoutClick.length) parts.push(`⚠ 押さずに値が変わった ${changedWithoutClick.length}件（${changedWithoutClick.slice(0, 3).join("・")}）`);
  else parts.push(`押してから変えた ${clickedThenChanged.length}件`);
  parts.push(`カーソル ${withCursor}/${list.length}件`);
  if (speedMedian) parts.push(`速さ ${speedMedian}px/s`);

  return {
    ops: ops.length, typed,
    typedOnChoose: [...typedOnChooseSet],
    clickedThenChanged, changedWithoutClick,
    withCursor, withPoint, rows: list.length, speedMedian,
    line: parts.join("／"),
  };
}

/**
 * 点検の結果から「補強する所」を出す（統括が次の一手を決めるため）。
 *   ⚠ 数字が悪い所だけを**名指し**する（良くても言わない）。
 */
export function findHumanLikeGaps(r: ReturnType<typeof auditHumanLike>): Array<{ what: string; why: string; next: string }> {
  const out: Array<{ what: string; why: string; next: string }> = [];
  if (r.typedOnChoose.length) {
    out.push({
      what: "選ぶ欄に文字を打ち込んでいる",
      why: `${r.typedOnChoose.length}件（${r.typedOnChoose.slice(0, 4).join("・")}）`,
      next: "プルダウン・チェックは**開いて選ぶ**（打ち込まない）",
    });
  }
  if (r.changedWithoutClick.length) {
    out.push({
      what: "押さずに値が変わっている欄がある",
      why: `${r.changedWithoutClick.length}件（${r.changedWithoutClick.slice(0, 4).join("・")}）`,
      next: "値を入れる前に**欄を開く**（人がやる順番）",
    });
  }
  if (r.rows > 0 && r.withCursor / r.rows < 0.5) {
    out.push({
      what: "カーソルの動きが記録されていない回が多い",
      why: `${r.withCursor}/${r.rows}件（${Math.round((r.withCursor / r.rows) * 100)}%）`,
      next: "押す前にカーソルを動かす（`pointer-ui` の mousemove）",
    });
  }
  if (r.rows > 0 && r.withPoint / r.rows < 0.5) {
    out.push({
      what: "押した位置が記録されていない回が多い",
      why: `${r.withPoint}/${r.rows}件`,
      next: "押した所（要素の中の割合）を残す",
    });
  }
  return out;
}
