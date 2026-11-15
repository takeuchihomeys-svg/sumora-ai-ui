/**
 * 統括が「録画の学習データ」から自動モードを改善する（2026-11-15 竹内さん）
 *
 *   竹内さん「この自動モードの改善は録画している学習データから統括が改善する」
 *
 * ★ 考え方
 *   私は何度も「コードを読んで推測で直す」をやって失敗した（2回誤読・2回渡し忘れ）。
 *   → **統括に録画データを見せて、改善の順番を決めさせる**。
 *     私は「材料を揃える」「決まった事を実行する」に徹する。
 *
 * ★ 統括に渡す材料（すべて実測・推測を混ぜない）
 *   ① 人の手本と自動モードの**差**（同じ欄を、人はどこを押し、機械はどこを押したか）
 *   ② 自動モードが**できていない事**（押さずに値が変わる・カーソルが動いていない）
 *   ③ 学んだのに**使われていない**物（`aim_used` で「狙えなかった理由」が分かる）
 *   ④ 学習の**抜け**（まだ読める写真が何枚あるか）
 *
 * ★ 統括が出す答え（形を決めておく）
 *   `{ priority, what, why, how, cost }` の並び。⚠ 費用がかかる物は上限を付ける。
 */

/** 1つの欄について、人と機械を比べた結果 */
export type FieldCompare = {
  /** 欄の名前 */
  field: string;
  /** 人の手本で押された回数 */
  humanN: number;
  /** その位置（人が押した所・要素の中の割合） */
  humanX: number | null;
  humanY: number | null;
  /** 自動モードで押された回数 */
  autoN: number;
  /** 自動モードが狙った位置（学んだ位置を使った時） */
  autoX: number | null;
  autoY: number | null;
  /** 学んだ位置を狙えたか（`aim_used` の why が null なら狙えた） */
  aimed: boolean | null;
  /** 狙えなかった理由（no_learn / few_times:1 / no_pos） */
  aimWhy: string | null;
};

/** 比べた結果のまとめ */
export type AutoModeGaps = {
  /** 人の手本にある欄の数 */
  humanFields: number;
  /** 自動モードが押した欄の数 */
  autoFields: number;
  /** 人が押すのに自動モードが押していない欄（⚠ 一番大事） */
  onlyHuman: string[];
  /** 学んだ位置を狙えた回数 */
  aimedOk: number;
  /** 狙えなかった回数 */
  aimedNg: number;
  /** 狙えなかった理由の内訳 */
  aimWhyCount: Record<string, number>;
  /** 人が押した位置と自動モードが狙った位置のずれ（平均・0〜1） */
  avgDrift: number | null;
  /** 人が読む1行 */
  line: string;
};

/**
 * 人と機械を欄ごとに比べる（純関数）。
 *   ⚠ 位置のずれは**要素の中の割合**なので 0〜1。0.15 以上なら「違う所を押している」。
 */
export function compareFields(
  human: ReadonlyArray<{ f: string; n: number; x: number | null; y: number | null }>,
  auto: ReadonlyArray<{ f: string; n: number; x: number | null; y: number | null }>,
  aimUsed: ReadonlyArray<{ f: string; x: number | null; y: number | null; why: string | null }>,
): { rows: FieldCompare[]; gaps: AutoModeGaps } {
  const hMap = new Map<string, { n: number; x: number | null; y: number | null }>();
  for (const h of Array.isArray(human) ? human : []) {
    if (!h || !h.f) continue;
    const cur = hMap.get(h.f) || { n: 0, x: null, y: null };
    cur.n += Number(h.n) || 1;
    if (cur.x == null && typeof h.x === "number") { cur.x = h.x; cur.y = h.y; }
    hMap.set(h.f, cur);
  }
  const aMap = new Map<string, { n: number; x: number | null; y: number | null }>();
  for (const a of Array.isArray(auto) ? auto : []) {
    if (!a || !a.f) continue;
    const cur = aMap.get(a.f) || { n: 0, x: null, y: null };
    cur.n += Number(a.n) || 1;
    if (cur.x == null && typeof a.x === "number") { cur.x = a.x; cur.y = a.y; }
    aMap.set(a.f, cur);
  }
  const aimMap = new Map<string, { x: number | null; y: number | null; why: string | null }>();
  for (const u of Array.isArray(aimUsed) ? aimUsed : []) {
    if (!u || !u.f) continue;
    if (!aimMap.has(u.f)) aimMap.set(u.f, { x: u.x, y: u.y, why: u.why });
  }

  const rows: FieldCompare[] = [];
  const onlyHuman: string[] = [];
  for (const [f, h] of hMap) {
    const a = aMap.get(f);
    const u = aimMap.get(f);
    rows.push({
      field: f,
      humanN: h.n, humanX: h.x, humanY: h.y,
      autoN: a?.n ?? 0, autoX: u?.x ?? a?.x ?? null, autoY: u?.y ?? a?.y ?? null,
      aimed: u ? u.why === null : null,
      aimWhy: u?.why ?? null,
    });
    if (!a) onlyHuman.push(f);
  }
  // 自動モードにしか無い欄も入れる（人の手本に無い＝推測で押した疑い）
  for (const [f, a] of aMap) {
    if (hMap.has(f)) continue;
    const u = aimMap.get(f);
    rows.push({
      field: f, humanN: 0, humanX: null, humanY: null,
      autoN: a.n, autoX: u?.x ?? a.x, autoY: u?.y ?? a.y,
      aimed: u ? u.why === null : null, aimWhy: u?.why ?? null,
    });
  }

  let aimedOk = 0, aimedNg = 0;
  const aimWhyCount: Record<string, number> = {};
  for (const u of Array.isArray(aimUsed) ? aimUsed : []) {
    if (!u) continue;
    if (u.why === null) aimedOk++;
    else {
      aimedNg++;
      const k = String(u.why).split(":")[0].slice(0, 16);
      aimWhyCount[k] = (aimWhyCount[k] || 0) + 1;
    }
  }

  // 位置のずれ（両方に位置がある欄だけ）
  const drifts: number[] = [];
  for (const r of rows) {
    if (r.humanX == null || r.autoX == null) continue;
    drifts.push(Math.abs(r.humanX - r.autoX) + Math.abs((r.humanY ?? 0) - (r.autoY ?? 0)));
  }
  const avgDrift = drifts.length ? Math.round((drifts.reduce((s, v) => s + v, 0) / drifts.length) * 100) / 100 : null;

  const parts: string[] = [];
  parts.push(`人の手本 ${hMap.size}欄／自動 ${aMap.size}欄`);
  if (onlyHuman.length) parts.push(`⚠ 人が押すのに自動が押していない ${onlyHuman.length}欄`);
  if (aimedOk || aimedNg) parts.push(`学んだ位置を狙えた ${aimedOk}回・狙えず ${aimedNg}回`);
  if (avgDrift != null) parts.push(`位置のずれ ${avgDrift}（0.15以上は違う所）`);

  return {
    rows,
    gaps: {
      humanFields: hMap.size, autoFields: aMap.size, onlyHuman,
      aimedOk, aimedNg, aimWhyCount, avgDrift,
      line: parts.join("／"),
    },
  };
}

/**
 * ★ 2026-11-15 竹内さん「このように統括は弱い部分ちゃんと把握するようにする」:
 *
 *   **「手本に無い」と「束に入っていない」を混同しない**（純関数）。
 *
 *   ⚠ 実測の失敗: 統括が「人が押す欄を自動モードが押していない」と**10欄**挙げたが、
 *     **7欄は既に束に入っていた**（`points`/`next` にあった）。
 *     統括は「人が押した欄」と「束に入っている欄」を**別々に見ていなかった**。
 *
 *   → **束に入っている物を除いて**、本当に足りない欄だけを返す。
 *     - `points`（押す位置）のキー
 *     - `next`（押す順番）のキー（「A→B」の形なので部分一致でも見る）
 *     ⚠ 部分一致は**誤って除外しない**ように、区切りの両側で見る（`f` が独立した欄名の時だけ）。
 */
export function filterReallyMissing(
  onlyHuman: ReadonlyArray<string>,
  bundleKeys: { points?: ReadonlyArray<string>; next?: ReadonlyArray<string> },
): { missing: string[]; covered: string[] } {
  const pts = new Set((Array.isArray(bundleKeys?.points) ? bundleKeys.points : []).filter(Boolean));
  const nxt = (Array.isArray(bundleKeys?.next) ? bundleKeys.next : []).filter(Boolean);
  const missing: string[] = [];
  const covered: string[] = [];
  /**
   * ★ 2026-11-15 竹内さん「反映させる」→ **統括が拡張自身の部品を「人が押す欄」と誤認していた**。
   *   ⚠ 実測: 統括が「人が押す欄を自動モードが押していない 3欄」と言ったが、中身は
   *     `AIXLINX｜div`・`#aixlinx-mini-btn`・`左のAIXLINX｜div` ＝ **全部、拡張自身の小窓**だった。
   *     これはサイトの欄ではないので、**学ぶ対象ではない**（直しても意味が無い）。
   *   → 拡張自身の部品は候補から除く（`isOwnPart`）。
   */
  for (const f of Array.isArray(onlyHuman) ? onlyHuman : []) {
    const name = String(f ?? "").trim();
    if (!name) continue;
    if (isOwnPart(name)) continue;           // ⚠ 拡張自身の部品は除く
    if (pts.has(name)) { covered.push(name); continue; }
    /**
     * ⚠ `next` は「A→B」の形。**完全一致**か、**区切り（→ ・ |）で囲まれた一致**だけ認める。
     *   単なる `includes` だと `img` が `img.room_layout_image` に当たって誤って除外する。
     */
    const hit = nxt.some((k) => {
      if (k === name) return true;
      return k.split(/→|・|\|/).map((s: string) => s.trim()).indexOf(name) >= 0;
    });
    if (hit) covered.push(name);
    else missing.push(name);
  }
  return { missing, covered };
}

/**
 * 拡張自身の部品か（純関数）。
 *   ⚠ 実測で「人が押す欄」に混ざっていた物: `AIXLINX｜div`・`#aixlinx-mini-btn`・`左のAIXLINX｜div`。
 *     これらは**サイトの欄ではない**ので、直しても検索は良くならない。
 */
export function isOwnPart(name: unknown): boolean {
  const n = String(name ?? "");
  return /aixlinx|axlx|AIXLINX/i.test(n) || /^[#.]?(axlx|aixlinx)/i.test(n.trim());
}

/**
 * 統括に渡す「改善の候補」（統括が順番を決める）。
 *   ⚠ 費用がかかる物は**必ず上限と概算**を付ける（勝手にお金を使わない）。
 *   ⚠ 効果が大きい順に並べる（別のお客さんの条件で検索する危険 → 押せない → 見た目）。
 */
export function autoModeCandidates(g: AutoModeGaps, extra: { shotTodo?: number; changedWithoutClick?: number; cursorPct?: number } = {}): Array<{
  key: string; what: string; why: string; how: string; cost: string; effect: string;
}> {
  const out: Array<{ key: string; what: string; why: string; how: string; cost: string; effect: string }> = [];
  if (g.onlyHuman.length) {
    out.push({
      key: "miss_fields",
      what: "人が押す欄を自動モードが押していない",
      why: `${g.onlyHuman.length}欄（${g.onlyHuman.slice(0, 5).join("・")}）`,
      how: "その欄の手順を束に載せる（人が押した順番ごと）",
      cost: "0円（記録を作り直すだけ）",
      effect: "検索の条件が入りきる（止まりにくくなる）",
    });
  }
  if (g.aimedNg > 0) {
    const top = Object.entries(g.aimWhyCount).sort((a, b) => b[1] - a[1])[0];
    out.push({
      key: "aim_not_used",
      what: "学んだ押す位置を狙えていない",
      why: `${g.aimedNg}回（一番多い理由: ${top ? top[0] + " " + top[1] + "回" : "－"}）`,
      how: "回数が少ない欄は記録を増やす・学びが無い欄は写真から読む",
      cost: "0〜20円",
      effect: "人が押す所と同じ所を押せる（見た目が人に近づく）",
    });
  }
  if (g.avgDrift != null && g.avgDrift >= 0.15) {
    out.push({
      key: "drift",
      what: "人が押した位置と自動モードの位置がずれている",
      why: `平均 ${g.avgDrift}（0.15以上は違う所）`,
      how: "学んだ位置を使う（`_aimOf`）・写真から読んだ位置と突き合わせる",
      cost: "0円",
      effect: "同じボタンでも人の押し方に近づく",
    });
  }
  if ((extra.changedWithoutClick ?? 0) > 0) {
    out.push({
      key: "changed_no_click",
      what: "押さずに値が変わっている欄がある",
      why: `${extra.changedWithoutClick}件`,
      how: "値を入れる前に欄を開く（人がやる順番）",
      cost: "0円",
      effect: "サイトの反応が人と同じになる（絞り込みが効く）",
    });
  }
  if ((extra.cursorPct ?? 100) < 50) {
    out.push({
      key: "cursor",
      what: "カーソルの動きが記録されていない回が多い",
      why: `${extra.cursorPct}%（半分未満）`,
      how: "押す前にカーソルを動かす（`pointer-ui` の mousemove）",
      cost: "0円",
      effect: "人の速さ・軌跡を学べるようになる",
    });
  }
  if ((extra.shotTodo ?? 0) > 0) {
    const todo = extra.shotTodo ?? 0;
    out.push({
      key: "photo",
      what: "まだ読んでいない写真が残っている",
      why: `${todo}枚（読める大きさ）`,
      how: "写真から学ぶを回す（同じ画面は1枚）",
      cost: `約${Math.max(1, Math.round(todo * 0.17))}円`,
      effect: "欄の種類・場所・領域が増える",
    });
  }
  return out;
}
