// app/lib/shot-learn.ts
// 画面の写真から学ぶ（純関数・DB を触らない）。
//
// 2026-11-13 竹内さん「画面の写真から判断できる。そこの部分強化するようにする。
//   画像を見れば学習できるし弱い部分等は学習の統括が判断して学習を繰り返していく」
//
// これまでの穴:
//   学習は**数値だけ**（押した名前・位置・速さ）だった。写真は「あとで人が見る」だけ。
//   → 写真に写っている**欄の種類（プルダウン／入力欄／チェック）**や
//     **画面の状態（一覧・条件の画面・小窓）**は、写真からしか分からない事がある。
//
// ここでやる事（写真1枚 → 学んだ事1つ）:
//   ① 写真を見て「欄の種類」を読む（プルダウンか直接入力か・チェックか）
//   ② 写真を見て「どの画面か」を読む（form／modal／result／other）
//   ③ 数値の記録（押した名前・位置）と**突き合わせて**、名前だけでは分からなかった種類を埋める
//   ④ 弱い所（同じ欄で種類が割れている・写真と数値が食い違う）を**指摘**する
//
// ⚠ 画像から読むのは**欄の種類・画面の種類・ボタンの有無**だけ。
//   入力された中身（文字・数字）・お客様の名前は読まない・残さない。
// ⚠ LLM は「迷った時だけ」呼ぶ（決定論で分かる物は決定論で決める＝費用を抑える）。

/** 写真から読んだ1つの欄 */
export type ShotField = {
  /** 欄の名前（name 属性・見出しの文字）。30字まで */
  name: string;
  /** 種類: select=プルダウン / text=直接入力 / checkbox / radio / button / link */
  kind: string;
  /** 画面のどこか（0〜1の割合・左上基準） */
  x?: number | null;
  y?: number | null;
  /** 押せそうか（グレーでない） */
  enabled?: boolean;
};

/** 写真1枚から学んだ事 */
export type ShotLearn = {
  /** どの画面か */
  screen: "form" | "modal" | "result" | "other";
  /** 読めた欄 */
  fields: ShotField[];
  /** 読んだ方法（決定論／LLM） */
  by: "deterministic" | "llm";
  /** 確かさ（0〜1） */
  confidence: number;
  /** 人が読む1行 */
  note?: string;
};

const KINDS = ["select", "text", "checkbox", "radio", "button", "link"];
const norm = (s: unknown) => String(s == null ? "" : s).replace(/[\s\u3000]+/g, "").trim().slice(0, 30);

/**
 * 押す対象ではない「入れ物」の名前（学習に使わない）。
 *
 * 2026-11-14 竹内さん「ゴミデータが入らないようになっているか」:
 *   実測で学んだ欄に `div`/`img`/`td`/`svg`/`#axlx-bar` が **13件**、
 *   押す順番に `div`・`img` が **2件** 混ざっていた。
 *   これは「クリックが伝わっただけ」の入れ物で、人が押した操作ではない。
 *   入れると「div の次は img」のような**意味の無い順番**を学んでしまう。
 */
const NON_TARGET_NAMES = /^(div|span|svg|td|tr|th|table|tbody|img|image|a|li|p|ul|i|b|strong|section|header|footer|main|nav|form|body|html|#axlx-[\w-]+|axlx-[\w-]+)$/i;

/** 学習に使ってよい名前か（入れ物・拡張自身の部品は除く） */
export function isLearnableName(name: unknown): boolean {
  const n = String(name ?? "").trim();
  if (!n) return false;
  /**
   * ★ 2026-11-14 竹内さん「徒歩が消えないようにする部分学習して改善する」→ **実測で判明（3つ目の罠）**:
   *
   *   ⚠ 1文字は捨てていたが、**リアプロの分数の欄は名前が `分`（1文字）**だった。
   *     そのため `分` が並びから消え、
   *     `transportation_id → 分 → transportation_id`（徒歩を選び直した証拠）が
   *     **`transportation_id → transportation_id`** に見えず、
   *     統括が「徒歩が消えている」と判断できなかった（実測: walk_reset が出なかった）。
   *
   *   → **意味のある1文字は通す**（`分` `円` `階` `歳` `畳` `帖` `件` `人` `駅` など）。
   *     数字・記号だけの1文字は今まで通り捨てる。
   */
  const ONE_CHAR_OK = /^[分円階歳畳帖件人駅室棟戸台個日月年]$/;
  if (n.length <= 1 && !ONE_CHAR_OK.test(n)) return false;
  if (NON_TARGET_NAMES.test(n)) return false;
  /**
   * 2026-11-14 竹内さん「データベースの写真から学習する」:
   *   ⚠ 学びに **`#aixlinx-mini-btn`（拡張自身のボタン）** が混ざっていた（実測）。
   *     自分の UI はサイトの操作ではないので、順番を濁らせる。
   *   → **どこかに拡張の印が入っていたら学ばない**（`div.search_menu` のような本物は残す）。
   */
  if (/(^|[^a-z])(aixlinx|axlx)/i.test(n)) return false;
  // 「div.building_tr」「td.st_td」のような入れ物の class 付きも除く（行・セル・画像）
  if (/^(div|span|svg|td|tr|th|table|img|a|li|p)\./i.test(n) && !/btn|button|search|go_search|next|confirm/i.test(n)) return false;
  return true;
}

/**
 * 欄の**名前から種類を推す**（純関数）。
 *
 * 2026-11-13 竹内さん「今弱い部分学習する。今のデータから学習する」:
 *   実測で弱い所 **40件がすべて `kind_unknown`**（押した記録に種類が無い・旧版の記録）だった。
 *   だが名前を見ると**明らかに分かる物ばかり**:
 *     `大阪市北区｜label.one_city` → チェック（区を選ぶ）
 *     `city_code[]` / `room_layout_id[]` → チェック（`[]` は複数選ぶ欄）
 *     `rental_cost1` / `square_meter_l` / `update_date` / `structured_date` → プルダウン
 *     `required_time` / `keyword` → 直接入力
 *     `確定してリストへ｜span` / `左の検索｜span` → 押すボタン
 *   → **名前の形（class・name・文字）から推す**。写真が無くても埋められる。
 *   ⚠ 推測なので**確かさ（conf）を返す**（低い物は弱い所として残す＝ごまかさない）。
 *
 * @returns kind と、その確かさ（0〜1）。分からなければ null
 */
export function guessKindFromName(name: unknown): { kind: string; conf: number } | null {
  const n = String(name ?? "");
  if (!n) return null;
  const raw = n.toLowerCase();
  /** サイトのクラス名（`｜` の後ろ）を優先して見る（一番確かな手がかり） */
  const cls = raw.includes("｜") ? raw.slice(raw.indexOf("｜") + 1) : raw;

  // ① クラス名がそのまま種類を言っている（一番確か）
  if (/label\.one_(city|town)/.test(cls)) return { kind: "checkbox", conf: 0.9 };  // 区・町字
  if (/label\.one_(line|station)/.test(cls)) return { kind: "checkbox", conf: 0.9 };
  if (/label\.one_/.test(cls)) return { kind: "checkbox", conf: 0.8 };
  /**
   * 2026-11-13 実測: `左の3K｜label`・`左の4K｜label` のように**クラス名が `label` だけ**の物がある
   *   （間取りのチェックは `input` ではなく `label` を押す作り）。
   *   → `label` だけでも**チェック**とみなす（0.75）。`div`/`span` だけの物は下で判断する。
   */
  if (/^label$/.test(cls)) return { kind: "checkbox", conf: 0.75 };
  if (/^input\.checkbox|type_checkbox/.test(cls)) return { kind: "checkbox", conf: 0.85 };
  if (/^input\.radio/.test(cls)) return { kind: "radio", conf: 0.85 };
  if (/^select/.test(cls)) return { kind: "select", conf: 0.85 };
  if (/^input\.text|^textarea/.test(cls)) return { kind: "text", conf: 0.85 };
  if (/go_search|btn|button/.test(cls)) return { kind: "button", conf: 0.75 };
  if (/town_search|city_search|search_menu/.test(cls)) return { kind: "button", conf: 0.7 };

  // ② name が `xxx[]` → 複数選ぶチェック
  if (/\[\]$/.test(raw)) return { kind: "checkbox", conf: 0.8 };

  // ③ 押す物（文字＋span/td/div）
  if (/(確定してリストへ|検索|絞り込み|とじる|クリア|リセット|次へ|設定へ進む)/.test(n)) return { kind: "button", conf: 0.75 };
  if (/｜(span|td|div|a|button|th|li)/.test(raw)) return { kind: "button", conf: 0.6 };

  // ④ 名前で分かる欄
  if (/(rental_cost|square_meter|update_date|structured_date|transportation_id|walk|age)/.test(raw)) return { kind: "select", conf: 0.7 };
  if (/(required_time|keyword|free_word|freeword|building_name|search_word|room_no)/.test(raw)) return { kind: "text", conf: 0.7 };
  if (/(include_common_fee|deposit_recommpence|shikirei|pet|fee_)/.test(raw)) return { kind: "checkbox", conf: 0.7 };

  // ⑤ 画像・見出し・件数など、押す対象ではなさそう
  if (/^(img|image)\b|^img\./.test(cls)) return { kind: "other", conf: 0.5 };
  /**
   * 2026-11-13 実測（残り11件）への対処:
   *   ・`堺市南区`・`大阪市中央区` … **区の名前そのもの**（クラス名が付いていない）。
   *     地域の小窓では「区を選ぶ」＝チェックなので **checkbox**。
   *   ・`div` / `span` / `svg` / `td` / `#axlx-bar` / `div.building_tr` / `td.st_td` …
   *     これらは**押す対象ではない**（見出し・行・拡張の帯）。押した記録に残っているのは
   *     クリックが要素へ伝わっただけ。→ `other` にして「学ぶ対象」から外す（0.4）。
   *   ⚠ `other` は学習の並べ替えには使わない（`_orderByLearned` は名前で照合するので実害なし）。
   */
  // 区・市の名前（「大阪市北区」「堺市南区」「東大阪市」など）
  if (/^[^\s]{1,10}(市|区|郡|町|村)[^\s]{0,8}$/.test(n)) return { kind: "checkbox", conf: 0.65 };
  // 押す対象ではない飾り・入れ物
  if (/^(div|span|svg|td|th|tr|table|tbody|p|ul|li|i|b|strong|section|header|footer|main|nav|form|label_text)$/.test(cls)) return { kind: "other", conf: 0.4 };
  if (/^(#axlx-|axlx)/.test(raw)) return { kind: "other", conf: 0.4 };
  if (/(building_tr|rl_area|st_td|hover_comment)/.test(cls)) return { kind: "other", conf: 0.5 };

  return null;
}

/**
 * 写真から読んだ欄の一覧を整える（純関数）。
 *   ⚠ 名前が無い・種類が変な物は捨てる。
 *   ⚠ 座標は 0〜1 に丸める。
 */
export function cleanFields(raw: unknown): ShotField[] {
  if (!Array.isArray(raw)) return [];
  const out: ShotField[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = norm(o.name);
    const kind = String(o.kind ?? "").toLowerCase();
    if (!name || !KINDS.includes(kind)) continue;
    const key = name + "|" + kind;
    if (seen.has(key)) continue;
    seen.add(key);
    const fx = typeof o.x === "number" ? Math.max(0, Math.min(1, Math.round(o.x * 100) / 100)) : null;
    const fy = typeof o.y === "number" ? Math.max(0, Math.min(1, Math.round(o.y * 100) / 100)) : null;
    out.push({
      name, kind,
      x: fx, y: fy,
      ...(o.enabled === false ? { enabled: false } : {}),
    });
    if (out.length >= 60) break;
  }
  return out;
}

/** 画面の種類を整える */
/**
 * 画面の種類を決める（純関数）。
 *
 * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい」:
 *   ⚠ 旧は呼ぶ側が `cleanScreen("other")` と**決め打ち**していたので、
 *     写真が「地域の小窓」なのか「検索の入力欄」なのか「結果の一覧」なのかが
 *     学習に残らず、**段（手順）と結びつかなかった**。
 *   → **写真のURL・操作の並び・欄の名前**から画面を判定する（写真を見なくても分かる材料だけ）。
 *     ・modal  … 小窓（所在地絞り込み／沿線・駅絞り込み）が開いている
 *     ・result … 物件の一覧（display=building など）
 *     ・form   … 検索条件の入力（method=estate）
 *     ・other  … 分からない（推測で埋めない）
 */
export function screenOf(input: {
  url?: unknown;
  ops?: ReadonlyArray<{ f?: unknown }>;
  fields?: ReadonlyArray<{ name?: unknown }>;
} = {}): ShotLearn["screen"] {
  const url = String(input.url ?? "");
  const names = [
    ...(Array.isArray(input.ops) ? input.ops.map((o) => String(o?.f ?? "")) : []),
    ...(Array.isArray(input.fields) ? input.fields.map((f) => String(f?.name ?? "")) : []),
  ];
  const has = (re: RegExp) => names.some((n) => re.test(n));
  /**
   * 小窓の印: 地域／駅の段の名前（`page-script` が `_auditStepP` で残す日本語）と、
   * 小窓の中だけにある部品（`one_city` / `one_town` / `one_line` / `確定してリストへ`）。
   *
   * ⚠ 2026-11-13 実測: `human_motion_learn.url` の列が**無い**ので、URL では判定できない。
   *   → **操作の名前だけで判定できる形**を主にする（地域・駅の手順は名前で分かる）。
   */
  if (
    has(/所在地絞り込み|沿線・駅絞り込み|区を選ぶ|町字を選ぶ|沿線を選ぶ|駅の設定へ進む|地域の設定へ進む|確定してリストへ/) ||
    has(/one_city|one_town|one_line|city_code|town_code|station_id|route_id/)
  ) return "modal";
  if (/display=(building|rent_rooms)|list/i.test(url)) return "result";
  if (/method=estate/i.test(url)) return "form";
  // URL が分からない時は、欄の名前で推す（賃料・面積・間取りがあれば入力画面）
  if (has(/rental_cost|square_meter|room_layout|structured_date|required_time|update_date/)) return "form";
  /**
   * どれでもない時、操作が**あれば**入力の途中とみなす（0件は「分からない」にする）。
   *   ⚠ `other` のままにすると、学んだ欄が宙に浮く（どの画面の物か分からない）。
   */
  if (names.length) return "form";
  return "other";
}

export function cleanScreen(v: unknown): ShotLearn["screen"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "form" || s === "modal" || s === "result" || s === "other") return s;
  return "other";
}

/**
 * 数値の記録（押した名前と種類）と、写真から読んだ欄を**突き合わせる**（純関数）。
 *   ・数値側に種類が無い（旧版の記録）→ 写真の種類で埋める
 *   ・食い違う（数値は text・写真は select）→ **写真を採る**（写真の方が確か・実際の見た目）
 *     ただし「写真の確かさ」が低い時は数値を残す
 * @returns 直した points（元は変えない）と、直した所の一覧
 */
export function reconcilePoints(
  points: Record<string, { x: number; y: number; n: number; w?: string }>,
  fields: ReadonlyArray<ShotField>,
  opt: { minConfidence?: number } = {},
): { points: Record<string, { x: number; y: number; n: number; w?: string }>; fixed: Array<{ name: string; from: string | null; to: string }> } {
  const minConf = opt.minConfidence ?? 0.6;
  const out: Record<string, { x: number; y: number; n: number; w?: string }> = {};
  for (const [k, v] of Object.entries(points || {})) out[k] = { ...v };
  const fixed: Array<{ name: string; from: string | null; to: string }> = [];
  const byName = new Map<string, ShotField>();
  for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);
  for (const [name, v] of Object.entries(out)) {
    const f = byName.get(name);
    if (!f) continue;
    const from = v.w ?? null;
    /**
     * 2026-11-14 竹内さん「確かめて治す」:
     *
     *   ⚠ **バグだった**。旧は**写真の種類で上書きした物を全部 `fixed`（食い違い）に入れて**いた。
     *     そのため統括に「記録と写真で種類が違う」が永久に並んでいた
     *     （実測: 直近1000行で `shot_learn` は **0件**。比較する相手すら無いのに6件出ていた）。
     *
     *   → **本当に違う時だけ** `fixed` に入れる（`from` があり、かつ写真と違う時）。
     *     ・`from` が null（記録に種類が無い）＝**埋めただけ**（食い違いではない）
     *     ・`from` === 写真の種類 ＝**一致**（何もしない・記録もしない）
     *     ・`from` !== 写真の種類 ＝**本当の食い違い**（ここだけ `fixed`）
     */
    const differs = from != null && String(from) !== String(f.kind);
    out[name] = { ...v, w: f.kind, w_src: "photo", w_conf: 1 } as typeof v;
    if (differs) fixed.push({ name, from, to: f.kind });
  }
  void minConf;
  return { points: out, fixed };
}

/**
 * 写真の**画面の種類**と、記録の**操作の並び**を結びつけて「どの画面で何を押したか」を作る。
 *
 * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい。抜けている部分徹底的に学習できるように」:
 *   これまでは写真（画像）と操作が**別々**に貯まるだけで、結びついていなかった。
 *   → 写真1枚ごとに「どの画面か」「最後に押したのは何か」「次に押したのは何か」を1行にする。
 *     これで「地域の小窓では、区を選んだ後に確定を押す」のような**仕組み**が学べる。
 *
 * ⚠ 入れるのは**画面の種類・欄の名前・順番だけ**（入力した中身・お客様の情報は入れない）。
 *
 * @param shots 写真の行（url・shot_ops・shot_learn を持つ）
 * @returns 画面ごとの「よく押す順番」と、写真で見えた欄
 */
export function learnFromShots(
  shots: ReadonlyArray<{
    url?: unknown;
    shot_ops?: unknown;
    shot_learn?: unknown;
    created_at?: unknown;
    /** 2026-11-14: 操作の並びが無い回でも、押した欄（順番つき）から学べるようにする */
    point_fields?: unknown;
    field_order?: unknown;
  }>,
): {
  screens: Record<string, { n: number; lastPressed: Array<{ name: string; n: number }>; steps: Array<{ from: string; to: string; n: number }>; fields: Array<{ name: string; kind: string; n: number }> }>;
  total: number;
  withOps: number;
} {
  type Acc = { n: number; last: Record<string, number>; steps: Record<string, Record<string, number>>; fields: Record<string, Record<string, number>> };
  const acc: Record<string, Acc> = {};
  let withOps = 0;

  for (const s0 of Array.isArray(shots) ? shots : []) {
    /**
     * 2026-11-13: 壊れた行（null・配列でない）が混ざっても落ちない。
     *   ⚠ 旧は `s.shot_ops` をそのまま読んでいたので、null が混ざると例外で**学習が丸ごと止まった**。
     */
    if (!s0 || typeof s0 !== "object") continue;
    const s = s0 as { url?: unknown; shot_ops?: unknown; shot_learn?: unknown; created_at?: unknown; point_fields?: unknown; field_order?: unknown };
    let ops = Array.isArray(s.shot_ops)
      ? (s.shot_ops as unknown[])
        .map((o) => (o && typeof o === "object" ? o as Record<string, unknown> : null))
        .filter((o): o is Record<string, unknown> => !!o)
        .map((o) => ({ f: typeof o.f === "string" ? String(o.f).slice(0, 30) : "" }))
        .filter((o) => o.f)
      : [];
    /**
     * 2026-11-14 竹内さん「データベースの写真から学習する」:
     *   ⚠ 実測で写真 **200枚すべて `shot_ops` が空**だった（写真は撮れている）。
     *     そのため `shot_learn` も `screen_flow` も永久に空のまま＝**写真から何も学べていない**。
     *   → `shot_ops` が空でも、**`field_order`（押した順番）** があればそれで学ぶ。
     *     `field_order` は人の操作から作られる（`point_fields` の順）ので、順番として使える。
     *     ⚠ `field_order` も無ければ `point_fields` のキー順で代用する（順番の精度は落ちるが、
     *       「どの画面でどの欄を触るか」は学べる）。
     */
    if (!ops.length) {
      const fo = Array.isArray(s.field_order) ? (s.field_order as unknown[]) : [];
      const names = fo.map((x) => norm(x)).filter((x) => x && isLearnableName(x));
      if (names.length) {
        ops = names.slice(0, 60).map((f) => ({ f }));
      } else {
        const pf = (s.point_fields && typeof s.point_fields === "object" && !Array.isArray(s.point_fields))
          ? (s.point_fields as Record<string, unknown>) : null;
        if (pf) {
          const keys = Object.keys(pf).filter((k) => isLearnableName(k)).slice(0, 60);
          if (keys.length) ops = keys.map((f) => ({ f }));
        }
      }
    }
    // 写真から読んだ欄（あれば）
    const learnedFields = (() => {
      const sl = (s.shot_learn && typeof s.shot_learn === "object" ? s.shot_learn : null) as Record<string, unknown> | null;
      const arr = sl && Array.isArray(sl.fields) ? sl.fields : [];
      return arr
        .map((f) => (f && typeof f === "object" ? f as Record<string, unknown> : null))
        .filter((f): f is Record<string, unknown> => !!f)
        .map((f) => ({ name: norm(f.name), kind: String(f.kind ?? "").toLowerCase() }))
        .filter((f) => f.name && f.kind);
    })();

    const screen = screenOf({ url: s.url, ops, fields: learnedFields });
    /**
     * 2026-11-14 竹内さん「データベースの写真から学習する」:
     *   ⚠ 実測で **`other` が3813枚**（学べているのは modal 226・form 75 だけ）。
     *     中身を見ると **材料（操作も押した欄も順番も）が1つも無い行**だった
     *     ＝写真だけあって「何を押したか」が付いていない。これは学べないので**数えない**
     *     （数えると「学べている」ように見えて、本当の穴が見えなくなる）。
     *   → 材料が無い行は `total` にも入れない（`withOps` だけが学びの材料）。
     */
    if (!ops.length && !learnedFields.length) continue;
    const a = (acc[screen] ||= { n: 0, last: {}, steps: {}, fields: {} });
    a.n++;
    if (ops.length) withOps++;
    if (ops.length) {
      const lastOne = ops[ops.length - 1].f;
      a.last[lastOne] = (a.last[lastOne] ?? 0) + 1;
      for (let i = 1; i < ops.length; i++) {
        const x = ops[i - 1].f, y = ops[i].f;
        if (x === y) continue;
        ((a.steps[x] ||= {})[y] = (a.steps[x][y] ?? 0) + 1);
      }
    }
    for (const f of learnedFields) {
      ((a.fields[f.name] ||= {})[f.kind] = (a.fields[f.name][f.kind] ?? 0) + 1);
    }
  }

  const out: ReturnType<typeof learnFromShots>["screens"] = {};
  for (const [screen, a] of Object.entries(acc)) {
    const lastPressed = Object.entries(a.last).map(([name, n]) => ({ name, n })).sort((x, y) => y.n - x.n).slice(0, 12);
    const steps: Array<{ from: string; to: string; n: number }> = [];
    for (const [from, dests] of Object.entries(a.steps)) {
      for (const [to, n] of Object.entries(dests)) if (n >= 2) steps.push({ from, to, n });
    }
    steps.sort((x, y) => y.n - x.n);
    const fields = Object.entries(a.fields)
      .map(([name, kinds]) => {
        const best = Object.entries(kinds).sort((x, y) => y[1] - x[1])[0];
        return { name, kind: best ? best[0] : "?", n: best ? best[1] : 0 };
      })
      .sort((x, y) => y.n - x.n)
      .slice(0, 40);
    out[screen] = { n: a.n, lastPressed, steps: steps.slice(0, 40), fields };
  }
  return { screens: out, total: Array.isArray(shots) ? shots.length : 0, withOps };
}

/**
 * 2026-11-14 竹内さん「画面録画したのみたら一連の動き学習できるからいまみてみて」:
 *   録画の**一連の動き**から「**この手順で押す**」という型を作る（統括が使う）。
 *
 *   なぜ要るか:
 *     これまでは「A の次は B」を**1組ずつ**学んでいた（`next`）。
 *     だが実際の検索は **10〜20手の一連の流れ**で、1組ずつでは
 *     「地域 → 区 → 町字 → 確定 → 徒歩 → 賃料 → …」の**全体**が見えなかった。
 *
 *   何を作るか:
 *     ・`sequence` … 実際に押された順番を**1本の鎖**にした物（回数の多い手順を優先）
 *     ・`groups`   … 意味のあるまとまり（地域／駅／条件）に分けた物
 *
 *   ⚠ 入れるのは**欄の名前と順番だけ**（入力した中身・お客様の情報は入れない）。
 *   ⚠ 1回しか出ていない手順は採らない（偶然を型にしない）。ただし鎖をつなぐ時は許す。
 */
export function learnSequenceFromShots(
  sequences: ReadonlyArray<ReadonlyArray<{ f?: unknown }>>,
  opt: { min?: number } = {},
): {
  sequence: string[];
  groups: Array<{ name: string; steps: string[]; n: number }>;
  edges: Array<{ from: string; to: string; n: number }>;
  samples: number;
} {
  const min = opt.min ?? 2;
  /**
   * 2026-11-14 竹内さん「ゴミデータが入らないようになっているか」:
   *   押す対象でない入れ物（`div`・`img`・`td` など）は**鎖に入れない**。
   *   ⚠ 判定は `isLearnableName`（1か所だけ・二重に持たない）。
   */
  const okName = (n: string) => isLearnableName(n);
  const seqs = (Array.isArray(sequences) ? sequences : [])
    .map((s) => (Array.isArray(s) ? s.map((x) => String(x?.f ?? "").trim()).filter((f) => !!f && okName(f)) : []))
    .filter((s) => s.length >= 2);
  if (!seqs.length) return { sequence: [], groups: [], edges: [], samples: 0 };

  // ① 組を数える
  const tally: Record<string, Record<string, number>> = {};
  for (const s of seqs) {
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      if (a === b) continue;
      (tally[a] ||= {})[b] = (tally[a][b] ?? 0) + 1;
    }
  }
  const edges: Array<{ from: string; to: string; n: number }> = [];
  for (const [from, dests] of Object.entries(tally)) {
    for (const [to, n] of Object.entries(dests)) edges.push({ from, to, n });
  }
  edges.sort((a, b) => b.n - a.n);

  // ② 鎖を作る（一番長い実際の並びを土台にし、min 回以上そろった組でつなぐ）
  const best = seqs.slice().sort((a, b) => b.length - a.length)[0] ?? [];
  const nextOf: Record<string, { to: string; n: number }> = {};
  for (const e of edges) {
    if (e.n < min) continue;
    if (!nextOf[e.from] || e.n > nextOf[e.from].n) nextOf[e.from] = { to: e.to, n: e.n };
  }
  const seq: string[] = [];
  const used = new Set<string>();
  let cur: string | undefined = best[0];
  let guard = 0;
  while (cur && guard++ < 60 && !used.has(cur)) {
    seq.push(cur);
    used.add(cur);
    cur = nextOf[cur]?.to;
  }

  // ③ 意味のあるまとまりに分ける（地域／駅／条件）
  const GROUP: Array<{ name: string; re: RegExp }> = [
    { name: "地域（所在地）", re: /所在地|区を選ぶ|町字|地域の設定/ },
    { name: "駅・沿線", re: /沿線|駅の設定|駅を選ぶ/ },
    { name: "条件の入力", re: /required_time|rental_cost|square_meter|structured_date|room_layout|update_date|transportation|include_common_fee|deposit_recommpence|敷金/ },
    { name: "検索", re: /検索|確定してリストへ/ },
  ];
  const groups: Array<{ name: string; steps: string[]; n: number }> = [];
  for (const g of GROUP) {
    const steps = seq.filter((s) => g.re.test(s));
    if (steps.length) groups.push({ name: g.name, steps, n: seqs.filter((s) => s.some((x) => g.re.test(x))).length });
  }

  return { sequence: seq, groups, edges: edges.slice(0, 40), samples: seqs.length };
}

/**
 * 弱い所を見つける（純関数・統括が「次に何を学ぶか」を決める材料）。
 *   ① 種類が割れている欄（同じ名前で select と text が両方ある＝読み違え）
 *   ② 種類がまだ分からない欄（数値に w が無い）
 *   ③ 写真と数値が食い違った欄
 *   ④ 押せない（グレー）のに押している欄
 */
/**
 * 弱い所から**次の学習の計画**を立てる（統括の判断・純関数）。
 *
 * 2026-11-13 竹内さん「学習の統括が強化されるように、その点も徹底する」:
 *   これまでは弱い所を**並べるだけ**で、「次に何をすれば埋まるか」を決める所が無かった
 *   （＝統括が働いていなかった）。→ 弱い所を**やる事**に変える。
 *
 * 決め方（優先度の高い順）:
 *   1. `photo_vs_record` … 写真と記録が食い違う（**誤学習の元**・最優先で確かめる）
 *   2. `kind_conflict_in_photo` … 写真の中で種類が割れている（読み違え）
 *   3. `pressed_disabled` … 押せない物を押している（＝**止まる原因**・自動検索に直結）
 *   4. `kind_unknown` … 種類が分からない（**名前から推せる**ならその場で埋める）
 * 同じ名前は1つにまとめ、**やる事の種類ごと**に数を出す。
 *
 * @param weak 弱い所の一覧
 * @param guessed 名前から推して埋めた物（あれば「もう埋めた」と分かる）
 * @returns 計画（優先度順・やる事・根拠）
 */
export function planLearnFromWeak(
  weak: ReadonlyArray<{ kind: string; name: string; why?: string; next?: string }>,
  guessed: ReadonlyArray<{ name: string; kind: string; conf: number }> = [],
  /**
   * 2026-11-14 竹内さん「自動で強化必要な部分を強化する・できていない部分もDBに理解させて強化する」:
   *   **モード別**の材料。`modes` に各モードの記録数と学べた量を渡すと、
   *   「**自動（aix）は学びが少ない**」「**通常は学べている**」を統括が判断できる。
   */
  modes: Record<string, { rows: number; next: number; steps: number; gaps: { median_ms: number | null; samples: number } }> = {},
  /**
   * 2026-11-14 竹内さん「学習は統括の部分が管轄して整理もできているのか」:
   *   **ゴミの点検結果**を渡すと、統括が「捨てる・直す」を判断する。
   *   ・`garbage` … 検出したゴミの種類と件数（交互クリック・入れ物・水増し など）
   *   ⚠ 位置は**4番目**（既存の呼び出しを壊さない）。`modeCounts` は5番目。
   */
  garbage: Array<{ kind: string; n: number }> = [],
  /**
   * 2026-11-14 竹内さん「自動検索の部分学習反映されるようにちゃんと連携する。今自動検索がちゃんと学習連携されていない可能性たかい」:
   *   **実際の記録数**（`mode_counts`）。`modes`（by_mode）は3件未満を作らないので、
   *   1〜2件のモードを「**0件**」と誤って案内していた。ここで正しく区別する。
   */
  modeCounts: Record<string, number> = {},
): {
  items: Array<{ priority: number; kind: string; name: string; action: string; why: string }>;
  counts: Record<string, number>;
  filled: number;
  summary: string;
  /** モードごとの判断（足りない物・次にやる事） */
  mode_plan: Array<{ mode: string; rows: number; verdict: string; action: string }>;
  /** 整理（ゴミの扱い）＝統括の判断 */
  cleanup: Array<{ kind: string; n: number; verdict: string; action: string }>;
} {
  const PRI: Record<string, number> = {
    photo_vs_record: 1,
    kind_conflict_in_photo: 2,
    pressed_disabled: 3,
    kind_unknown: 4,
  };
  const ACT: Record<string, string> = {
    photo_vs_record: "次の録画の時に同じ欄を写真で読んで、記録と合うか確かめる（合わなければ写真を採る）",
    kind_conflict_in_photo: "同じ欄を2枚以上の写真で読んで、多い方の種類を採る",
    pressed_disabled: "押す前に「押せるか」を見る（グレーなら待つ・別の道を探す）",
    kind_unknown: "名前から推して埋める（推せない時だけ写真を読む）",
  };
  const guessedNames = new Set(guessed.map((g) => g.name));
  const seen = new Set<string>();
  const items: Array<{ priority: number; kind: string; name: string; action: string; why: string }> = [];
  const counts: Record<string, number> = {};

  for (const w of Array.isArray(weak) ? weak : []) {
    if (!w || !w.name) continue;
    const key = w.kind + "|" + w.name;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[w.kind] = (counts[w.kind] ?? 0) + 1;
    // 名前から埋めた物は「もう埋めた」ので、やる事から外す（件数だけ残す）
    if (w.kind === "kind_unknown" && guessedNames.has(w.name)) continue;
    items.push({
      priority: PRI[w.kind] ?? 9,
      kind: w.kind,
      name: w.name,
      action: ACT[w.kind] ?? "記録を増やして、もう一度学ぶ",
      why: String(w.why ?? ""),
    });
  }
  items.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const parts: string[] = [];
  if (guessed.length) parts.push(`名前から種類を埋めた: ${guessed.length}件`);
  /**
   * 2026-11-13: 「残り」は**やる事が残っているか**で決める（名前から埋めた分は残りに数えない）。
   *   ⚠ 旧は `counts`（のべ件数）をそのまま出していたので、全部埋めても「残り」と出ていた。
   */
  const left: Record<string, number> = {};
  for (const x of items) left[x.kind] = (left[x.kind] ?? 0) + 1;
  const top = Object.entries(left).sort((a, b) => (PRI[a[0]] ?? 9) - (PRI[b[0]] ?? 9));
  if (top.length) parts.push("残り: " + top.map(([k, n]) => `${k} ${n}件`).join("・"));
  else parts.push("残り: なし（やる事はありません）");

  /**
   * 2026-11-14 竹内さん「自動で強化必要な部分を強化する」:
   *   **モードごと**に「足りているか・何を足すか」を出す。
   *   ・記録が0 … **そのモードで一度も動いていない**（＝学べていない）
   *   ・記録はあるが押す順番が0 … 操作が記録されていない（写真と結びついていない）
   *   ・操作の間が無い … 「待つ長さ」を学べていない
   */
  const MODE_JA: Record<string, string> = { normal: "通常", staff: "スタッフ", aix: "AIX（自動）", brain: "ブレイン", auto: "自動" };
  const modePlan: Array<{ mode: string; rows: number; verdict: string; action: string }> = [];
  for (const [m, v] of Object.entries(modes || {})) {
    const ja = MODE_JA[m] || m;
    const rows = Number(v?.rows) || 0;
    const nx = Number(v?.next) || 0;
    const steps = Number(v?.steps) || 0;
    const gapN = Number(v?.gaps?.samples) || 0;
    if (rows < 3) {
      modePlan.push({ mode: m, rows, verdict: `${ja}: 記録が${rows}件だけ（学べていない）`, action: `「${ja}」で検索して録画する（操作が3件以上たまると学べます）` });
    } else if (nx === 0) {
      modePlan.push({ mode: m, rows, verdict: `${ja}: ${rows}件あるのに押す順番が0通り`, action: `「${ja}」の時に写真へ操作を付ける（ops が空。タブの取り違え／撮影の失敗を疑う）` });
    } else if (steps === 0) {
      modePlan.push({ mode: m, rows, verdict: `${ja}: 押す順番は${nx}通りだが画面の手順が0`, action: `「${ja}」でもう少し操作する（同じ日の同じ並びが2回以上そろうと学べます）` });
    } else if (gapN === 0) {
      modePlan.push({ mode: m, rows, verdict: `${ja}: 学べている（${nx}通り・手順${steps}）が待つ長さが0`, action: `操作の間（g）を記録する（押してから次まで待つ時間）` });
    } else {
      modePlan.push({ mode: m, rows, verdict: `${ja}: 学べています（押す順番${nx}通り・画面${steps}・間${Math.round(Number(v.gaps.median_ms) || 0)}ms）`, action: "追加で強化する所は無し" });
    }
  }
  /** 記録が0件のモードも知りたい（mode_counts に無い＝そのモードで動いていない） */
  for (const m of ["normal", "staff", "aix"]) {
    if (!(m in (modes || {}))) {
      /**
       * 2026-11-14: `modes`（by_mode）は**3件未満を作らない**。だが `modeCounts` には実数が入る。
       *   ⚠ 旧はこれを渡していなかったので、**2件動いていても「0件」**と案内していた（実測 aix）。
       *   → 実数があれば「もう少し動かせば学べる」と正しく言う。
       */
      const real = Number((modeCounts || {})[m]) || 0;
      if (real <= 0) {
        modePlan.push({ mode: m, rows: 0, verdict: `${MODE_JA[m] || m}: 記録が0件`, action: `「${MODE_JA[m] || m}」で検索して録画する` });
      } else if (real < 3) {
        modePlan.push({
          mode: m, rows: real,
          verdict: `${MODE_JA[m] || m}: ${real}件あるが、まだ学びを作れる数（3件）に届いていない`,
          action: `「${MODE_JA[m] || m}」であと${3 - real}回検索する（3件から学びます）`,
        });
      } else {
        /**
         * ⚠ 3件以上あるのに `modes`（by_mode）に無い＝**学びを作る所で落ちている**。
         *   「3件に届いていない」と言うのは嘘になる（実測の normal 10件で起きていた）。
         */
        modePlan.push({
          mode: m, rows: real,
          verdict: `${MODE_JA[m] || m}: ${real}件あるのに学びを作れていない`,
          action: `記録は届いている（連携oK）。学びの計算（順番・画面）を点検する`,
        });
      }
    }
  }
  /**
   * 2026-11-14 竹内さん「学習は統括の部分が管轄して整理もできているのか」:
   *   **ゴミをどう扱うか**を統括が決める。
   *   ・交互クリック（拡張のトグル跡）… 学習から**除く**（もう除いている・記録は残す）
   *   ・押す対象でない入れ物（div/img/td）… 学習から**除く**（v2.7.28 で除外を追加）
   *   ・同じ日の同じ並び（水増し）… **1回に畳む**（もう畳んでいる）
   *   ・種類が分からない … 名前から推す（推せなければ写真）
   */
  const CLEAN_ACT: Record<string, { verdict: string; action: string }> = {
    "交互クリック（トグル跡）": { verdict: "学習から除いています（記録は残す）", action: "拡張が同じチェックを2回押していないか確かめる（区のトグル）" },
    "押す対象でない入れ物": { verdict: "学習から除きました（v2.7.28）", action: "なし（除外の規則を入れた）" },
    "同じ日の同じ並び（水増し）": { verdict: "1回に畳んでいます", action: "なし（畳む規則は入っている）" },
    "同じ欄の4連打": { verdict: "学習から除いています", action: "同じ欄を4回押していないか確かめる" },
    "名前が1文字以下": { verdict: "学習から除いています", action: "名前が取れていない欄がある（記録側の改善）" },
  };
  const cleanup: Array<{ kind: string; n: number; verdict: string; action: string }> = [];
  for (const g of Array.isArray(garbage) ? garbage : []) {
    if (!g || !g.kind || !(Number(g.n) > 0)) continue;
    const c = CLEAN_ACT[g.kind] ?? { verdict: "要確認", action: "何のゴミか確かめる" };
    cleanup.push({ kind: g.kind, n: Number(g.n), verdict: c.verdict, action: c.action });
  }
  cleanup.sort((a, b) => b.n - a.n);

  return {
    items: items.slice(0, 40),
    counts,
    filled: guessed.length,
    summary: parts.join("／") + (cleanup.length ? "／整理: " + cleanup.map((c) => `${c.kind} ${c.n}件`).join("・") : ""),
    mode_plan: modePlan,
    cleanup,
  };
}

export function findWeakPoints(
  points: Record<string, { n: number; w?: string }>,
  fields: ReadonlyArray<ShotField>,
  fixed: ReadonlyArray<{ name: string; from?: string | null; to?: string }>,
): Array<{ kind: string; name: string; why: string; next: string }> {
  const out: Array<{ kind: string; name: string; why: string; next: string }> = [];
  // ① 写真の中で同じ名前が違う種類
  const seen = new Map<string, Set<string>>();
  for (const f of fields) {
    if (!seen.has(f.name)) seen.set(f.name, new Set());
    seen.get(f.name)!.add(f.kind);
  }
  for (const [name, kinds] of seen) {
    if (kinds.size > 1) {
      out.push({ kind: "kind_conflict_in_photo", name, why: "同じ欄が写真の中で違う種類に見えた（" + [...kinds].join("/") + "）", next: "次の写真でも同じ欄を読んで、多い方を採る" });
    }
  }
  // ② 種類が分からない欄
  for (const [name, v] of Object.entries(points || {})) {
    /**
     * 2026-11-13 竹内さん「今弱い部分学習する」:
     *   `other`（押す対象ではない飾り・入れ物・拡張の帯）は**学ぶ対象ではない**ので弱い所から外す。
     *   残すと「学んでも直らない物」が永久に居座る（実測で div/svg/span が10件残っていた）。
     */
    if (!v.w) out.push({ kind: "kind_unknown", name, why: "押した記録に種類が無い（旧版の記録）", next: "写真から種類を読んで埋める" });
    else if (v.w === "other") continue;
  }
  /**
   * ③ 記録と「写真から読んだ種類」が**本当に食い違った**欄。
   *
   * ⚠ 2026-11-14 竹内さん「確かめて治す」: 以前は `fixed` に**埋めただけの物も全部**入っていたので、
   *   食い違いが無いのに「記録と写真で種類が違う」が並んでいた（実測 `shot_learn` は0件）。
   *   → `reconcilePoints` が**本当に違う時だけ** `fixed` に入れるように直した。
   *     ここでは「記録に種類があり、写真と違った」物だけを受け取る。
   */
  for (const f of fixed) {
    if (!f || !f.name) continue;
    if (f.from == null) continue;              // 埋めただけ（食い違いではない）
    if (String(f.from) === String(f.to)) continue;
    out.push({ kind: "photo_vs_record", name: f.name, why: `記録は「${f.from}」だが写真は「${f.to}」`, next: "写真を採る（実際の見た目）・次の回でも同じか確かめる" });
  }
  // ④ 押せない欄を押している
  for (const f of fields) {
    if (f.enabled === false && points[f.name]) {
      out.push({ kind: "pressed_disabled", name: f.name, why: "グレー（押せない）に見える欄を押している", next: "待ってから押す・押せない時は別の道を探す" });
    }
  }
  // 同じ物を重ねない
  const uniq = new Map<string, (typeof out)[number]>();
  for (const w of out) uniq.set(w.kind + "|" + w.name, w);
  return [...uniq.values()].slice(0, 40);
}

/**
 * 写真から読む時の**指示文**（LLM に渡す）。
 *   ⚠ 読むのは**欄の種類・画面の種類・押せるか**だけ。入力された中身は読ませない。
 */
export const SHOT_LEARN_PROMPT = [
  "あなたはブラウザの画面写真を見て、フォームの作りだけを読み取る係です。",
  "次の JSON だけを返してください（説明文は書かない）。",
  '{ "screen": "form" | "modal" | "result" | "other", "confidence": 0.0〜1.0, "fields": [ { "name": "...", "kind": "select|text|checkbox|radio|button|link", "x": 0.0〜1.0, "y": 0.0〜1.0, "enabled": true|false } ] }',
  "",
  "決まり:",
  "・kind は「見た目」で決める。プルダウン（∨ が付いた選択欄）は select、文字を打つ欄は text、四角いチェックは checkbox、丸い選択は radio、押すボタンは button、リンクは link。",
  "・name は欄の見出しの文字（例: 賃料・築年数・間取り・徒歩）。見出しが読めなければ近くの短い文字。**40字以内**。",
  "・x と y は画面全体を 0〜1 とした位置（左上が 0,0）。",
  "・グレーで押せないように見える欄は enabled: false。",
  "・**入力された中身（数字・文字・お客様の名前・住所）は絶対に書かない**。欄の名前だけ。",
  "・読めない時は fields を空配列にする（推測で埋めない）。",
].join("\n");

/** LLM の返事を読む（純関数・壊れた JSON でも落ちない） */
export function parseShotLearn(text: string): ShotLearn {
  const t = String(text ?? "");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return { screen: "other", fields: [], by: "llm", confidence: 0 };
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const conf = typeof j.confidence === "number" ? Math.max(0, Math.min(1, Math.round(j.confidence * 100) / 100)) : 0.5;
    return { screen: cleanScreen(j.screen), fields: cleanFields(j.fields), by: "llm", confidence: conf };
  } catch {
    return { screen: "other", fields: [], by: "llm", confidence: 0 };
  }
}

/** 人が読む1行（点検・報告用） */
export function describeShotLearn(s: ShotLearn): string {
  const KJ: Record<string, string> = { select: "プルダウン", text: "直接入力", checkbox: "チェック", radio: "チェック1つ", button: "押す", link: "リンク" };
  const byKind: Record<string, number> = {};
  for (const f of s.fields) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const parts = Object.entries(byKind).map(([k, n]) => (KJ[k] || k) + n + "個");
  return `写真から: ${s.screen}（${s.by === "llm" ? "AI" : "決定論"}・確かさ${Math.round(s.confidence * 100)}%）`
    + (parts.length ? "／" + parts.join("・") : "／欄は読めず");
}
