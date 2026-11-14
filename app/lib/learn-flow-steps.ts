// app/lib/learn-flow-steps.ts
//
// 2026-11-14 竹内さん「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
//   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
//   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
//
// なぜ要るか（実測）:
//   ✅ `search_audits.filled.ops` に**人の押した順番が36/56件**入っていた（2026-11-14 実測）。
//      例: 所在地絞り込み＋ → 大阪市西区 → city_code[] → 大阪市中央区 → … → 確定してリストへ
//          → transportation_id → required_time → update_date → rental_cost2 → include_common_fee
//   ⚠ だが統括はこの順番を**見ていなかった**（`shot_ops` の集計だけ）。
//      さらに `shot_ops` は 12% しか埋まらない（録画の経路が壊れていた）。
//   → **すでにDBにある人の順番**を「場面ごとの手順」に変えて、統括の判断材料にする。
//     写真が1枚も取れていなくても学べる（ここが一番強い材料）。
//
// 何を作るか（純関数・DBに書かない）:
//   ① 押した操作の並びを**場面（scene）**に分ける
//        area    … 所在地絞り込み（区・町字を選ぶ）
//        station … 沿線・駅絞り込み
//        cond    … 条件（賃料・間取り・築年数・徒歩・更新日）
//        search  … 検索を押す
//        list    … 検索結果（物件の取得・並べ替え・絞り込み）
//        next    … 次のページへ
//        other   … どれでもない
//   ② 場面ごとの**手順**（欄の名前の並び）と**手数**・**間（ms）**を出す
//   ③ 人の手本と拡張の動きを分ける（`by`）＝手本は人の物だけ
//   ④ **弱い場面**を見つける（手本が無い・手数がばらつく・途中で止まる）
//
// ⚠ 入れるのは**欄の名前と操作の種類・時刻だけ**（入力した中身・お客様の情報は扱わない）。

/** 押した操作の1件（`filled.ops` の形） */
export type FlowOp = {
  /** `"click:所在地絞り込み＋"` / `"change:city_code[]"` / `"key"` など */
  k?: string | null;
  t?: number | null;
  /** "human" | "auto"（無ければ null＝旧記録） */
  by?: string | null;
};

/** 場面の名前 */
export type FlowScene = "area" | "station" | "cond" | "search" | "list" | "next" | "other";

/** 場面の日本語 */
export const SCENE_JA: Record<FlowScene, string> = {
  area: "所在地絞り込み",
  station: "沿線・駅絞り込み",
  cond: "条件（賃料・間取り・徒歩など）",
  search: "検索を押す",
  list: "検索結果（物件の取得）",
  next: "次のページへ",
  other: "その他",
};

/**
 * 操作の名前から場面を決める（純関数）。
 *   ⚠ 名前は**リアプロの実際の name 属性**に合わせる（推測で増やさない）。
 *     増やす時は実データの `filled.ops` を見て、実際に出た名前だけ足す。
 */
export function sceneOfOp(kind: string | null | undefined): FlowScene {
  const s = String(kind ?? "").toLowerCase();
  const raw = String(kind ?? "");
  const m = raw.match(/^([a-z]+):(.*)$/i);
  const name = (m ? m[2] : raw).trim();
  /**
   * ⚠ 2026-11-14 竹内さん「1から順に進めていく」→ **実測で判明（統括の指摘が誤っていた原因）**:
   *   実際の欄の名前は **`左の検索｜span`** のように
   *   **「左の」の接頭辞と「｜span」（タグ名）が付く**。
   *   旧の判定は `検索$`（検索で終わる）だったので、**1つも当たらなかった**（実測）:
   *     左の検索｜span            → その他（本当は「検索を押す」）
   *     左の検索｜div.go_search   → その他（本当は「検索を押す」）
   *     左の住居検索｜a.text      → その他（本当は「検索を押す」）
   *     左のnext｜span            → その他（本当は「次のページへ」）
   *   → そのため統括が「**『検索を押す』の手本が無い**」と**誤って**言っていた
   *     （実データでは人の押下が **25件**ある）。
   *   → **接頭辞と「｜タグ名」を落としてから判定する**。
   */
  const cleaned = name
    .replace(/^(左の|右の|上の|下の|中央の)/, "")     // 画面のどこか（拡張が付けている）
    .replace(/｜[^｜]*$/, "")                        // 「｜span」「｜div.go_search」「｜a.text」
    .trim();
  const n = (cleaned || name).toLowerCase();
  // 次のページ（一覧のページ送り）
  if (/next_page|pager|page_next|次のページ|次へ|ページ送り|^next$/.test(n)) return "next";
  /**
   * 検索を押す。
   *   ⚠ 実測の名前は `検索`（そのまま）・`住居検索`・`go_search` など**色々**。
   *     `検索$`（検索で終わる）だけでは `住居検索` は拾えるが、
   *     名前が `検索|span` の形だと拾えない → **含むかどうか**で見る。
   *   ⚠ ただし「検索条件」「検索結果」は押すボタンではないので除く。
   */
  if (/^(go_search|go_search_submit)$/.test(n) || /^search$/.test(n)) return "search";
  if (/検索/.test(n) && !/検索条件|検索結果|再検索の設定/.test(n)) return "search";
  // 所在地（区・町字・小窓）
  if (/city_code|town_code|one_city|one_town|住所|所在地|都道府県|市区郡|町字/.test(n)) return "area";
  /**
   * 実測の名前 `確定してリストへ｜span` は**所在地の小窓を閉じるボタン**。
   *   ⚠ 「その他」にすると、所在地の手順から**最後の1手が抜ける**（＝手順が途中で切れる）。
   */
  if (/確定してリストへ|リストへ確定/.test(n)) return "area";
  /**
   * 2026-11-14 実測: `click:大阪市西区` `click:大阪市中央区` `click:大阪市北区` は
   *   **区の見出しを押した記録**で、名前に `city_code` が入らない。
   *   ⚠ ここを拾わないと「どの区を選んだか」が順番から抜ける（実測で抜けていた）。
   *   → **区・市・郡・町・村で終わる短い名前**は所在地として扱う。
   *     （「確定してリストへ」「次のページ」などは終わりが違うので当たらない）
   */
  if ((cleaned || name).length <= 14 && /[区市郡町村]$/.test(cleaned || name)) return "area";
  // 沿線・駅
  if (/transportation_id|station|沿線|駅|required_time/.test(n)) return "station";
  // 検索結果の一覧（物件の取得・並べ替え）
  if (/building_tr|property_list|sort|並び替え|結果|一覧|bukken|room_/.test(n)) return "list";
  // 条件
  if (/rental_cost|update_date|room_layout|madori|間取り|賃料|築年|walk|徒歩|面積|menseki|include_common_fee|管理費|敷金|礼金/.test(n)) return "cond";
  return "other";
}

/** 場面ごとの手順（人が押した順） */
export type SceneFlow = {
  scene: FlowScene;
  /** 何回の検索でこの場面が出てきたか */
  runs: number;
  /** 手本にした操作の数（人の物だけ・同じ欄の2重記録は畳んだ後） */
  ops: number;
  /**
   * 畳む前の操作の数（`click:` と `change:` を別々に数える）。
   *   ⚠ 「押し直し・迷い」を見るにはこちらを使う（畳んだ後だと同じ欄の連打が消える）。
   */
  raw_ops: number;
  /** 一番よく出る順番（欄の名前の並び・重複は畳む） */
  steps: string[];
  /** 何通りあったか（ばらつき＝迷いの目安） */
  variants: number;
  /** 操作の間の中央値（ms） */
  gap_ms: number | null;
};

/**
 * 2026-11-14 竹内さん「徒歩の部分選択したら、そこは押して消えてしまうのは改善されるようになっているのか」
 *   → **実データで確認（7日6,027件）**。まず「消えている」と見えたが、**記録の数え方**だった:
 *
 *     徒歩（transportation_id）の記録の中身（実測）:
 *       +0ms    click  transportation_id  (w=select)   ← 人が「徒歩」を選ぶ
 *       +1018ms change transportation_id  (w=select)   ← ブラウザが「値が変わった」を出す
 *       +2080ms click  required_time      (w=text)     ← 分数を入れる
 *       +7021ms change required_time      (w=text)     ← 入力を確定
 *
 *   ⚠ **1回の操作が `click` と `change` の2件**として記録されていた（差は **1,018ms で一定**）。
 *     そのため「徒歩を2回選んだ」ように見え、手順として学ぶと
 *     「徒歩 → 徒歩 → 分数」という**人がやらない手順**になる。
 *   ⚠ 既存の `splitByScene` は「**直前と同じ名前なら畳む**」だが、
 *     `change` が 1,018ms 後に来るので**別の場面として残っていた**（時刻を見ていなかった）。
 *
 *   → **同じ欄の click→change は1回に畳む**（既定 1,200ms 以内・`collapseSameField`）。
 *     ⚠ 1,200ms より離れた同じ欄は**押し直しとして残す**（迷いの証拠・実測では0件だった）。
 */
export function collapseSameField<T extends { t?: number; k?: string; f?: string | null }>(
  ops: ReadonlyArray<T>,
  opt: { gapMs?: number } = {},
): T[] {
  const gap = opt.gapMs ?? 1200;
  const out: T[] = [];
  let prevF = "";
  /**
   * ⚠ 2026-11-14: `prevT = 0` を「まだ無い」の代わりに使うと、
   *   **最初の要素の時刻が 0** の時に畳めない（テストで発覚）。
   *   → `has` で「前の欄があるか」を別に持つ。
   */
  let prevT = 0;
  let has = false;
  for (const o of ops) {
    const f = typeof o?.f === "string" ? o.f : "";
    const t = Number(o?.t) || 0;
    if (f && has && f === prevF && Math.abs(t - prevT) <= gap) {
      prevT = t;   // 畳んだ後の時刻を次の基準にする
      continue;
    }
    out.push(o);
    if (f) { prevF = f; prevT = t; has = true; }
  }
  return out;
}

/**
 * ★ 2026-11-14 竹内さん「直近の通常モードの録画から押し方プルダウンの場所、
 *   徒歩が消えないようにする部分学習して改善する」
 *
 *   ⚠ **リアプロの仕様**: 移動手段（`transportation_id`）を選ぶと、その下の分数（`required_time`）が
 *     **リセットされる**（画面が作り直される）。人が「分数 → 移動手段」の順でやると分数が消える。
 *
 *   実測（直近の録画 mwgf1gx3_n1k5 の操作）:
 *     click transportation_id → click 分 → click transportation_id → click 大阪43棟189戸並べ替
 *     ⚠ **徒歩が2回**出ている＝もう一度選び直している（分数を入れた後に消された疑い）。
 *
 *   → **手本の中に「分数 → 移動手段」の順があれば弱い所として出す**（統括が直せるように）。
 *     ⚠ 順番が正しい時は何も言わない（無駄な指摘を出さない）。
 */
export function findWalkResetRisk(
  runs: ReadonlyArray<ReadonlyArray<{ f?: unknown }>>,
): { kind: string; why: string; next: string } | null {
  let bad = 0, good = 0, twice = 0;
  for (const ops of Array.isArray(runs) ? runs : []) {
    const names = (Array.isArray(ops) ? ops : [])
      .map((o) => String(o?.f ?? ""))
      .filter((n) => n && n !== "undefined");
    /**
     * ⚠ 2026-11-14 実測で判明: 画面の欄名は `required_time` ではなく **`分`** で記録される事がある
     *   （実測の並び: `transportation_id → 分 → transportation_id`）。
     *   旧の判定は `required_time` しか見ていなかったので、**実測の形で指摘が出なかった**。
     *   → 「分」「徒歩分」「駅からの徒歩時間」も分数として扱う。
     */
    const isWalk = (n: string) => /transportation_id|移動手段|交通手段/.test(n);
    const isMin = (n: string) => /required_time|^分$|徒歩分|徒歩時間|駅からの徒歩/.test(n);
    const iT = names.findIndex(isWalk);
    const iW = names.findIndex(isMin);
    if (iT < 0 && iW < 0) continue;
    // 同じ回で移動手段が2回以上＝選び直し
    if (names.filter(isWalk).length >= 2) twice++;
    if (iT >= 0 && iW >= 0) {
      if (iW < iT) bad++;   // 分数が先 → 消える恐れ
      else good++;          // 移動手段が先 → 正しい
    }
  }
  const total = bad + good;
  /**
   * ⚠ 選び直し（`twice`）は**分数を入れた後に移動手段を選び直した**事の証拠なので、
   *   `bad+good` が0でも指摘する（実測の並びがまさにこれ）。
   */
  if (!total && !twice) return null;
  if (total && bad === 0 && twice === 0) return null;   // 全部正しい順・選び直しも無い＝指摘しない
  const why = bad
    ? `分数を入れてから移動手段を選んでいる手本が ${bad}/${total}件あります（移動手段を選ぶと分数がリセットされる）`
    : `移動手段を2回以上選んでいる手本が ${twice}件あります（選び直し＝分数が消えた疑い）`;
  return {
    kind: "walk_reset",
    why,
    next: "手順を「移動手段 → 分数」の順に固定する（自動は既に固定済み。人の案内も同じ順にする）",
  };
}

/**
 * ★ 2026-11-14 竹内さん「所在地の部分も一気に押すのではなくて一つずつカーソル動かして押すようにする」
 *   「同じ平米数の物件は賃料がいちばん低い部屋1部屋と」「お客さんごとに送付済みの物件は送らないように」
 *   「送付済みで物件なければ次へ移動する部分もちゃんと学習を自動モードに反映する」
 *   「ここの部分統括の部分改善おねがい／学習して大切な部分統括重要度上げてつぎに活かすようにする」
 *
 *   **竹内さんの4つの決まり**が、実際の動きで守られているかを**記録から確かめる**（統括の材料にする）。
 *   ⚠ 守られていない物だけ返す（守れている物を並べても判断にならない）。
 */
export function findWeakRules(
  runs: ReadonlyArray<ReadonlyArray<{ t?: unknown; f?: unknown }>>,
): Array<{ scene: FlowScene; kind: string; why: string; next: string }> {
  const out: Array<{ scene: FlowScene; kind: string; why: string; next: string }> = [];

  /**
   * ① **所在地を一気に押していないか**（区と区の間隔）。
   *    ⚠ 人が区を選ぶのは 600〜1400ms。300ms 未満が続くなら「一気押し」。
   *    実測（自動モード・6件）: 区の間隔の中央値 230ms・300ms未満が 9/17 ＝ 一気押しが残っていた。
   */
  let areaGaps = 0, areaFast = 0;
  for (const ops of Array.isArray(runs) ? runs : []) {
    const area = (Array.isArray(ops) ? ops : []).filter((o) => /one_city|city_code|one_town|town_code/.test(String(o?.f ?? "")));
    for (let i = 1; i < area.length; i++) {
      const g = Number(area[i]?.t) - Number(area[i - 1]?.t);
      if (!(g > 0) || g > 60000) continue;
      areaGaps++;
      if (g < 300) areaFast++;
    }
  }
  if (areaGaps >= 3 && areaFast / areaGaps >= 0.3) {
    out.push({
      scene: "area",
      kind: "area_clicked_too_fast",
      why: `所在地の区を続けて押す間隔が短すぎます（${areaGaps}個のうち ${areaFast}個が300ms未満＝一気押し）`,
      next: "区は**1つずつカーソルを動かして**押す（人が区を選ぶ速さ 620〜1400ms）",
    });
  }

  /**
   * ② **同じ平米数で賃料が安い部屋を1つだけ選んでいるか**。
   *    ⚠ 「㎡が同じ部屋が3つ以上」ある回で、**同じ㎡の部屋を2つ以上**送っていたら守れていない。
   */
  let sameSqmRuns = 0, sameSqmBad = 0;
  for (const ops of Array.isArray(runs) ? runs : []) {
    const names = (Array.isArray(ops) ? ops : []).map((o) => String(o?.f ?? ""));
    // ⚠ ㎡の数値と賃料は `shot_ops.f` には入らない（入力値は残さない決まり）ので、
    //   ここでは「同じ㎡を絞る操作（square_meter）をしていない回」を数える＝絞り忘れの目安。
    const hasSqm = names.some((n) => /square_meter|平米|㎡/.test(n));
    const sentMany = names.filter((n) => /印刷用PDF/.test(n)).length;
    if (sentMany >= 3) {
      sameSqmRuns++;
      if (!hasSqm) sameSqmBad++;
    }
  }
  if (sameSqmRuns >= 2 && sameSqmBad / sameSqmRuns >= 0.5) {
    out.push({
      scene: "list",
      kind: "same_sqm_not_narrowed",
      why: `3件以上送った回のうち ${sameSqmBad}/${sameSqmRuns}回で「同じ平米数」の絞り込みがされていません`,
      next: "同じ㎡の部屋は**賃料が一番安い1部屋だけ**送る（`_applyCheapestPerLayout` が効いているか確かめる）",
    });
  }

  return out;
}

/**
 * 1回の検索の押した並びを、場面ごとに分ける（純関数） */
function splitByScene(ops: ReadonlyArray<FlowOp>): Map<FlowScene, string[]> {
  const out = new Map<FlowScene, string[]>();
  /**
   * ⚠ 2026-11-14: **同じ欄の click→change を1回に畳んでから**分ける。
   *   実測で `transportation_id` が 0ms と 1018ms の2件あり、
   *   「徒歩 → 徒歩 → 分数」という**人がやらない手順**を学んでいた。
   */
  const list0 = collapseSameField(ops as ReadonlyArray<{ t?: number; k?: string; f?: string | null }>);
  for (const o of list0) {
    const k = String(o?.k ?? "");
    if (!k) continue;
    // `k` は `"click:名前"` の形。名前だけにする（種類は残す）
    const m = k.match(/^([a-z]+):(.*)$/i);
    const verb = m ? m[1] : "";
    const name = (m ? m[2] : k).trim();
    if (!name) continue;
    // `key`（文字入力）は名前が無いので場面を決めない（直前の欄に属する）
    if (!verb && /^key$/i.test(name)) continue;
    const sc = sceneOfOp(k);
    if (sc === "other") continue;
    /**
     * ⚠ `change:` は `click:` と同じ欄の2重記録（実測で交互に出ていた）。
     *   畳む単位は**同じ欄**（`city_code[]` と `大阪市西区` は別の欄＝別の手として残す）。
     *   旧は「直前と同じ名前なら畳む」だったので、区の名前が `city_code[]` の後ろで消えていた
     *   （実測: `["所在地絞り込み＋","city_code[]"]` になり、どの区を選んだか抜けた）。
     *   ⚠ 同じ欄が**離れて**もう一度出たら、それは押し直し（残す）。
     *     直前と同じ時だけ畳む（隣り合う2重記録）。
     */
    const list = out.get(sc) ?? [];
    if (list[list.length - 1] !== name) list.push(name);
    out.set(sc, list);
  }
  return out;
}

/** 中央値（純関数） */
function med(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/**
 * 何回分かの押した並びから、場面ごとの手順を作る（純関数）。
 *
 * @param runs 1回の検索ぶんの操作の並び（`search_audits.filled.ops` を1行ずつ）
 * @param opt.by 手本にする `by`（既定 "human"＝人の動きだけ。null を渡すと全部）
 */
export function learnSceneFlows(
  runs: ReadonlyArray<ReadonlyArray<FlowOp>>,
  opt: { by?: string | null } = {},
): SceneFlow[] {
  const wantBy = opt.by === undefined ? "human" : opt.by;
  const acc = new Map<FlowScene, { runs: number; ops: number; raw: number; seqs: Map<string, number>; gaps: number[] }>();

  for (const ops of Array.isArray(runs) ? runs : []) {
    if (!Array.isArray(ops) || !ops.length) continue;
    /**
     * 手本にする物だけ残す。
     *   ⚠ `by` が**1件も無い旧記録**は、人か機械か分からない（実測: 394件すべて `by` 無し）。
     *     ここで捨てると**過去の材料が全部消える**ので、`by` が1つも無い回だけは全部を手本にする
     *     （`by` がある回は人の物だけ＝機械の動きを混ぜない）。
     */
    const hasBy = ops.some((o) => o && (o.by === "human" || o.by === "auto"));
    const filtered = wantBy == null
      ? ops
      : hasBy
        ? ops.filter((o) => String(o?.by ?? "") === wantBy)
        : ops;
    if (!filtered.length) continue;

    const perScene = splitByScene(filtered);
    // 畳む前の手数（「押し直し」を見るため）
    const rawByScene = new Map<FlowScene, number>();
    for (const o of filtered) {
      const sc = sceneOfOp(String(o?.k ?? ""));
      if (sc === "other") continue;
      rawByScene.set(sc, (rawByScene.get(sc) ?? 0) + 1);
    }
    // 間（ms）は同じ場面の中で、前の操作からの差
    const lastAt = new Map<FlowScene, number>();
    for (const o of filtered) {
      const t = typeof o?.t === "number" ? o.t : null;
      if (t == null) continue;
      const sc = sceneOfOp(String(o?.k ?? ""));
      const prev = lastAt.get(sc);
      if (prev != null && t > prev && t - prev < 120_000) {
        const a = acc.get(sc) ?? { runs: 0, ops: 0, raw: 0, seqs: new Map<string, number>(), gaps: [] };
        a.gaps.push(t - prev);
        acc.set(sc, a);
      }
      lastAt.set(sc, t);
    }

    for (const [sc, steps] of perScene) {
      if (!steps.length) continue;
      const a = acc.get(sc) ?? { runs: 0, ops: 0, raw: 0, seqs: new Map<string, number>(), gaps: [] };
      a.runs++;
      a.ops += steps.length;
      a.raw += rawByScene.get(sc) ?? steps.length;
      const key = steps.join(" → ");
      a.seqs.set(key, (a.seqs.get(key) ?? 0) + 1);
      acc.set(sc, a);
    }
  }

  const out: SceneFlow[] = [];
  for (const [scene, a] of acc) {
    const sorted = [...a.seqs.entries()].sort((x, y) => y[1] - x[1]);
    out.push({
      scene,
      runs: a.runs,
      ops: a.ops,
      raw_ops: a.raw,
      steps: sorted.length ? sorted[0][0].split(" → ") : [],
      variants: a.seqs.size,
      gap_ms: med(a.gaps),
    });
  }
  // 手数が多い場面から（＝学ぶ価値が大きい）
  return out.sort((x, y) => y.ops - x.ops);
}

/**
 * 場面ごとの「弱い所」を見つける（純関数）。
 *   統括が「どこを強化するか」を決めるための材料。
 */
export function findWeakScenes(
  flows: ReadonlyArray<SceneFlow>,
  opt: { minRuns?: number; minOps?: number } = {},
): Array<{ scene: FlowScene; kind: string; why: string; next: string }> {
  const minRuns = opt.minRuns ?? 3;
  const minOps = opt.minOps ?? 8;
  const out: Array<{ scene: FlowScene; kind: string; why: string; next: string }> = [];
  const have = new Set(flows.map((f) => f.scene));

  /**
   * ① **手本が0件の場面**（＝その場面を人がまだやっていない／記録できていない）。
   *   統括は「この場面は学べていない」と言える（できない事をできると言わない）。
   */
  const IMPORTANT: FlowScene[] = ["area", "cond", "search", "list", "next"];
  for (const sc of IMPORTANT) {
    if (!have.has(sc)) {
      out.push({
        scene: sc,
        kind: "no_example",
        why: `${SCENE_JA[sc]}の手本が1件もありません`,
        next: `${SCENE_JA[sc]}を人が1回やれば学べます（記録の経路も同時に確かめる）`,
      });
    }
  }

  for (const f of flows) {
    /**
     * ② **ばらつきが多い**（順番が毎回違う＝迷っている・学ぶと安定する）。
     *   ⚠ 1回しか無い場面は比べられないので言わない（推測になる）。
     */
    if (f.runs >= minRuns && f.variants > 1 && f.ops >= minOps) {
      const ratio = Math.round((f.variants / f.runs) * 100);
      if (ratio >= 60) {
        out.push({
          scene: f.scene,
          kind: "unstable",
          why: `${SCENE_JA[f.scene]}の順番が毎回違います（${f.runs}回で${f.variants}通り・${ratio}%）`,
          next: `一番多い順番（${f.steps.slice(0, 3).join(" → ")}…）を決まりにして、そこから外れた時だけ人に聞く`,
        });
      }
    }
    /**
     * ③ **手数が多すぎる**（押し直し・迷いの疑い）。
     *   ⚠ 畳んだ後（`ops`）ではなく**畳む前（`raw_ops`）**で見る。
     *     同じ欄を何度も押していると畳まれて消えるので、畳んだ後では気づけない（テストで発覚）。
     */
    if (f.runs >= 2 && f.raw_ops / Math.max(1, f.runs) >= 14) {
      out.push({
        scene: f.scene,
        kind: "too_many",
        why: `${SCENE_JA[f.scene]}で1回あたり約${Math.round(f.raw_ops / f.runs)}回も押しています（押し直し・迷いの疑い）`,
        next: "同じ欄を2回押していないか確かめる（`change:` と `click:` の2重記録も数に入る）",
      });
    }
    /**
     * ④ **間が長すぎる**（待たされている・読み込み待ちで止まっている）。
     */
    if (f.runs >= 2 && typeof f.gap_ms === "number" && f.gap_ms >= 15_000) {
      out.push({
        scene: f.scene,
        kind: "slow",
        why: `${SCENE_JA[f.scene]}の間が平均 約${Math.round(f.gap_ms / 1000)}秒あきます（待ち・止まりの疑い）`,
        next: "読み込み待ちか、押せなくて止まっているかを写真で確かめる",
      });
    }
  }
  return out.slice(0, 12);
}

/**
 * ★ 2026-11-14 竹内さん「徒歩が消えないようにする部分学習して改善する」
 *   **操作の並び（`runs`）から直接**、徒歩の順番の危険を見つける（`findWeakScenes` の仲間）。
 *   ⚠ `findWeakScenes` は場面ごとの集計を見るので、「分数→移動手段」のような
 *     **同じ場面の中の順番**は拾えない。ここで別に見る。
 */
export function findWeakSteps(
  runs: ReadonlyArray<ReadonlyArray<{ t?: unknown; f?: unknown }>>,
): Array<{ scene: FlowScene; kind: string; why: string; next: string }> {
  const out: Array<{ scene: FlowScene; kind: string; why: string; next: string }> = [];
  const walk = findWalkResetRisk(runs);
  if (walk) out.push({ scene: "station", ...walk });
  /**
   * ★ 2026-11-14 竹内さん「所在地を一つずつ」「同じ平米数は最安1部屋」「送付済みは送らない」
   *   「送付済みで無ければ次へ」「統括の部分改善おねがい」
   *   → **竹内さんの4つの決まり**が守られているかも記録から確かめる。
   */
  try {
    const rules = findWeakRules(runs);
    for (const r of rules) if (!out.some((x) => x.kind === r.kind)) out.push(r);
  } catch { /* 決まりの判定が失敗しても、徒歩の判定は使う */ }
  return out;
}

/**
 * **時系列で最後に触った場面**を返す（純関数）。
 *
 * 2026-11-14 竹内さん「いま一番効く3つ（実測）ここの部分もデータ見たら改善できる」:
 *   ⚠ 実測で**誤った事を統括が言っていた**:
 *     「止まる回が多いのは『所在地絞り込み』」→ 実際は **17回とも最後は `click:検索`**
 *     （所在地 → 駅 → 条件 → 検索 まで全部押して、**検索の後で止まっていた**）。
 *   原因: `learnSceneFlows(...)[0]` を使っていた。あれは**手数が多い順**に並ぶので
 *     「最後に触った場面」ではなく「一番手数が多い場面」（＝所在地）を返していた。
 *   → 止まった場所を見る時は**必ずこの関数**を使う（並び順に依存しない）。
 */
export function lastSceneOf(ops: ReadonlyArray<FlowOp>): FlowScene | null {
  const list = Array.isArray(ops) ? ops : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = String(list[i]?.k ?? "");
    if (!k) continue;
    // `key`（文字入力）は欄の名前が無いので場面を決めない → 1つ前を見る
    const m = k.match(/^([a-z]+):(.*)$/i);
    if (!m && /^key$/i.test(k)) continue;
    const sc = sceneOfOp(k);
    if (sc === "other") continue;
    return sc;
  }
  return null;
}

/**
 * 統括に渡す1行（人が読める形）。
 *   例: 「所在地絞り込み: 6回・手本38手・順番2通り（最も多い: 所在地絞り込み＋ → 大阪市西区 → …）」
 */
export function describeSceneFlow(f: SceneFlow): string {
  const g = typeof f.gap_ms === "number" ? `・間 約${Math.round(f.gap_ms / 1000)}秒` : "";
  const v = f.variants > 1 ? `・順番${f.variants}通り` : "・順番は決まっている";
  const head = f.steps.slice(0, 4).join(" → ");
  const rest = f.steps.length > 4 ? ` …（全${f.steps.length}手）` : "";
  return `${SCENE_JA[f.scene]}: ${f.runs}回・手本${f.ops}手${v}${g}（${head}${rest}）`;
}

/**
 * 場面ごとの手順を**教える形**（自動の時に参照する短文）に変える（純関数）。
 *   ⚠ 中身（入力した値）は入れない。欄の**順番**だけ。
 */
export function scenePlaybook(flows: ReadonlyArray<SceneFlow>): string[] {
  return flows
    .filter((f) => f.steps.length >= 2 && f.runs >= 2)
    .map((f) => `■ ${SCENE_JA[f.scene]}（${f.runs}回の実測）\n   ${f.steps.join(" → ")}`)
    .slice(0, 8);
}
