/**
 * お客様ごとに録画を分ける（2026-11-15 竹内さん）
 *
 *   竹内さん「まりあ　ゆーと　悠の順番で」「前に残っていたのを外している部分もちゃんと理解して学習する」
 *   「ここの記憶の部分は自動検索でお客さんを連続で検索するにあたってかなり重要になる」
 *
 * ★ なぜ要るか
 *   ⚠ `human_motion_learn` に**お客様IDの列が無い**（実測・41列に無い）。
 *     そのため「まりあ」「ゆーと」「悠」の操作が**1本に混ざる**。
 *     私はこれで2回誤読した（「泉大津市を選んでいる」→実際は前のお客さんのを外していた）。
 *
 * ★ どう分けるか（列を増やさずに、記録だけから）
 *   人は**お客さんを切り替える時、必ず「検索」を押す**。
 *   → **検索を押した所で区切る**と、1つの検索＝1人のお客さんになる。
 *   実測（今日の479枚）: 検索を押したのは3回 → **きれいに3組**に分かれた。
 *    1組目 09:32〜09:33 西区・中央区・北区（まりあ）
 *    2組目 09:34〜09:38 ＋西成区・浪速区・住之江区・泉大津市（ゆーと）
 *    3組目 09:44〜09:45 阪急宝塚線・モノレール・蛍池・豊中（悠）
 *
 * ⚠ お客様の**名前は記録からは分からない**（`property_customers` と結ぶ手がかりが無い）。
 *   → 名前を**推測で付けない**。`run` の番号（1組目・2組目…）で呼ぶ。
 *     竹内さんが「1組目はまりあ」と教えてくれたら、その対応だけを残す。
 * ⚠ 写真の中身・お客様の情報は入れない（欄の名前と真偽だけ）。
 */

/** 1件の操作（`shot_ops` の形） */
export type RunOp = {
  t?: number | null;
  k?: string | null;
  f?: string | null;
  w?: string | null;
  was?: boolean | null;
  now?: boolean | null;
};

/** 1枚（写真1枚の記録） */
export type RunRow = {
  id?: unknown;
  created_at?: string | null;
  shot_key?: string | null;
  shot_w?: number | null;
  shot_ops?: RunOp[] | null;
  shot_learn?: unknown;
};

/** 1組（＝1人のお客さんの検索） */
export type CustomerRun = {
  /** 何組目か（1から・古い順） */
  index: number;
  /** 最初と最後の時刻 */
  from: string | null;
  to: string | null;
  /** この組の操作（時刻順・重複を除いた物） */
  ops: RunOp[];
  /** この組に入る写真（行） */
  rows: RunRow[];
  /** 「検索」を押した時刻（この組の終わり） */
  searchedAt: number | null;
};

/** 検索を押したか（お客さんの切れ目） */
export function isSearchPress(op: RunOp | null | undefined): boolean {
  if (!op || typeof op !== "object") return false;
  if (String(op.k ?? "") !== "click") return false;
  const f = String(op.f ?? "").replace(/｜[^｜]*$/, "").replace(/^(左の|右の)/, "").trim();
  /**
   * ⚠ 2026-11-15 実測: 「住居検索」を**検索の切れ目にすると4組に分かれた**（本当は3組）。
   *   住居検索は**検索の画面へ移る**ボタンで、条件を入れて押す「検索」ではない。
   *   → **区切るのは「検索」だけ**（`go_search` も含む）。
   *     住居検索・物件を検索する・条件で検索は**画面移動**なので切れ目にしない。
   */
  return /^(検索|go_search|go_search_submit)$/.test(f);
}

/**
 * ★ 2026-11-15 竹内さん「ここの部分追加する」→ **細分化**:
 *
 *   統括が「どこが弱いか」を**種類ごと**に言えるようにする。
 *   ⚠ 「外した4件」だけでは足りない。**区は外せたが沿線が残っている**のように種類で違う。
 *
 *   種類（`areaKindsOf` が決める）:
 *     city    … 区・市（`label.one_city` / `city_code[]`）
 *     town    … 町字（`label.one_town` / `town_code[]`）
 *     line    … 沿線（`label.one_line` / `route_id[]`）
 *     station … 駅（`label.one_station` / `station_id[]`）
 *     layout  … 間取り（`room_layout_id[]`）
 *     cond    … 条件（賃料・面積・更新日・築年数・徒歩・敷金礼金など）
 *     other   … その他
 */
export type ToggleKind = "city" | "town" | "line" | "station" | "layout" | "cond" | "other";

/** 欄の名前から種類を決める（純関数） */
export function areaKindOf(name: unknown): ToggleKind {
  const n = String(name ?? "");
  if (/label\.one_city|city_code/.test(n)) return "city";
  if (/label\.one_town|town_code/.test(n)) return "town";
  if (/label\.one_line|route_id/.test(n)) return "line";
  if (/label\.one_station|station_id/.test(n)) return "station";
  if (/room_layout/.test(n)) return "layout";
  if (/rental_cost|square_meter|update_date|structured_date|building_age|transportation|required_time|deposit|include_common|pet|eq_rm|structured_type/.test(n)) return "cond";
  return "other";
}

/** 種類の日本語（統括が読む） */
export const KIND_JA: Record<ToggleKind, string> = {
  city: "区・市", town: "町字", line: "沿線", station: "駅", layout: "間取り", cond: "条件", other: "その他",
};

/**
 * 種類ごとに「外した数・選んだ数」を分ける（純関数）。
 *   ⚠ 竹内さんの言う「細分化」はこれ。統括は「区は外せたが沿線が残っている」と言える。
 */
export function splitByKind(ops: ReadonlyArray<RunOp>): {
  off: Record<ToggleKind, string[]>;
  on: Record<ToggleKind, string[]>;
  /** 種類ごとの外した数 */
  offN: Record<ToggleKind, number>;
  onN: Record<ToggleKind, number>;
} {
  const empty = (): Record<ToggleKind, string[]> => ({ city: [], town: [], line: [], station: [], layout: [], cond: [], other: [] });
  const off = empty(), on = empty();
  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o || typeof o !== "object") continue;
    const f = String(o.f ?? "").trim();
    if (!f) continue;
    const k = areaKindOf(f);
    const short = f.replace(/｜[^｜]*$/, "").replace(/^(左の|右の)/, "").trim().slice(0, 20);
    if (o.was === true && o.now === false) { if (off[k].indexOf(short) < 0) off[k].push(short); }
    else if (o.was === false && o.now === true) { if (on[k].indexOf(short) < 0) on[k].push(short); }
  }
  const count = (r: Record<ToggleKind, string[]>) => {
    const out = {} as Record<ToggleKind, number>;
    for (const k of Object.keys(r) as ToggleKind[]) out[k] = r[k].length;
    return out;
  };
  return { off, on, offN: count(off), onN: count(on) };
}

/** 時刻（ms）。読めなければ 0 */
function opTime(op: RunOp | null | undefined): number {
  const t = Number(op?.t);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * 写真の記録を「検索を押した所」で区切って、お客さんごとの組に分ける（純関数）。
 *   ⚠ 検索が1回も無い時は**1組**として返す（分けられない＝正直にそう言う）。
 *   ⚠ 組の順番は**古い順**（1組目が一番古い）。竹内さんが「まりあ・ゆーと・悠の順」と言った順と合わせる。
 */
export function splitByCustomer(rows: ReadonlyArray<RunRow>): CustomerRun[] {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object");
  if (!list.length) return [];

  // 全部の操作を時刻順に1本にする（重複を除く・同じ操作が何枚にも載っているため）
  const seen = new Set<string>();
  const all: RunOp[] = [];
  for (const r of list) {
    for (const o of (Array.isArray(r.shot_ops) ? r.shot_ops : [])) {
      if (!o || typeof o !== "object" || !o.f) continue;
      const key = String(o.f) + "|" + String(o.k) + "|" + String(o.t);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(o);
    }
  }
  all.sort((a, b) => opTime(a) - opTime(b));

  // 検索を押した位置で区切る
  const cuts: number[] = [];
  for (let i = 0; i < all.length; i++) if (isSearchPress(all[i])) cuts.push(i);

  const groups: Array<{ ops: RunOp[]; searchedAt: number | null }> = [];
  if (!cuts.length) {
    groups.push({ ops: all, searchedAt: null });
  } else {
    let start = 0;
    for (const c of cuts) {
      groups.push({ ops: all.slice(start, c + 1), searchedAt: opTime(all[c]) });
      start = c + 1;
    }
    if (start < all.length) groups.push({ ops: all.slice(start), searchedAt: null });
  }

  // 各組に写真を割り当てる（組の時間帯に入る物）
  return groups.map((g, i) => {
    const t0 = g.ops.length ? opTime(g.ops[0]) : 0;
    const t1 = g.ops.length ? opTime(g.ops[g.ops.length - 1]) : 0;
    const inRange = list.filter((r) => {
      const t = r.created_at ? Date.parse(String(r.created_at)) : NaN;
      if (!Number.isFinite(t)) return false;
      if (!t0 || !t1) return true;
      // ⚠ 写真は操作の**後**に撮られるので、少し余裕を持たせる（±5秒）
      return t >= t0 - 5000 && t <= t1 + 5000;
    });
    return {
      index: i + 1,
      from: g.ops.length ? new Date(opTime(g.ops[0])).toISOString() : null,
      to: g.ops.length ? new Date(opTime(g.ops[g.ops.length - 1])).toISOString() : null,
      ops: g.ops,
      rows: inRange.length ? inRange : list.filter((r) => {
        // 時間が読めない時は**最後の組**に入れる（取りこぼさない）
        return i === groups.length - 1;
      }),
      searchedAt: g.searchedAt,
    };
  });
}

/**
 * 1組の要約（統括が読む1行）。
 *   ⚠ 「前に残っていたのを外した」を**必ず別に数える**（竹内さんの指摘）。
 */
export function summarizeRun(run: CustomerRun): {
  index: number;
  rows: number;
  learned: number;
  /** 外した数（前のお客さんの条件を消した） */
  offN: number;
  /** 選んだ数 */
  onN: number;
  /** 外した物の名前（種類別に数えるための材料） */
  offNames: string[];
  onNames: string[];
  /** 場所の種類（区・町字・沿線・駅） */
  areaKinds: string[];
  /** ★ 細分化: 種類ごとの外した数・選んだ数 */
  offByKind: Record<ToggleKind, number>;
  onByKind: Record<ToggleKind, number>;
  /** ★ 細分化した人が読む行（「区・市 4件を外した／沿線 2件を選んだ」） */
  kindLine: string;
  line: string;
} {
  const offNames: string[] = [];
  const onNames: string[] = [];
  for (const o of run.ops) {
    const f = String(o.f ?? "").trim();
    if (!f) continue;
    if (o.was === true && o.now === false) { if (offNames.indexOf(f) < 0) offNames.push(f); }
    else if (o.was === false && o.now === true) { if (onNames.indexOf(f) < 0) onNames.push(f); }
  }
  // 場所の種類（細分化のため）
  const kinds = new Set<string>();
  for (const n of [...offNames, ...onNames]) {
    const k = areaKindOf(n);
    if (k !== "other") kinds.add(KIND_JA[k]);
  }
  /**
   * ★ 2026-11-15「ここの部分追加する」: **種類ごとに分ける**（統括が弱点を名指しできる）。
   */
  const byKind = splitByKind(run.ops);
  const kindParts: string[] = [];
  for (const k of Object.keys(byKind.offN) as ToggleKind[]) {
    if (byKind.offN[k] > 0) kindParts.push(`${KIND_JA[k]} を外した ${byKind.offN[k]}件`);
  }
  for (const k of Object.keys(byKind.onN) as ToggleKind[]) {
    if (byKind.onN[k] > 0) kindParts.push(`${KIND_JA[k]} を選んだ ${byKind.onN[k]}件`);
  }
  const learned = run.rows.filter((r) => !!r.shot_learn).length;
  const parts: string[] = [];
  parts.push(`${run.index}組目（写真 ${run.rows.length}枚・学習済み ${learned}枚）`);
  if (offNames.length) parts.push(`前に残っていたのを外した ${offNames.length}件`);
  if (onNames.length) parts.push(`選んだ ${onNames.length}件`);
  if (!offNames.length && !onNames.length) parts.push("外した／選んだは区別できない（旧版の記録）");
  return {
    index: run.index, rows: run.rows.length, learned,
    offN: offNames.length, onN: onNames.length, offNames, onNames,
    areaKinds: [...kinds],
    offByKind: byKind.offN, onByKind: byKind.onN,
    kindLine: kindParts.length ? kindParts.join("／") : "（種類なし）",
    line: parts.join("／"),
  };
}
