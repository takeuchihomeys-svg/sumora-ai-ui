// app/lib/action-playbook.ts — 動き方の手順書（束から作る純関数・DB を使わない）
//
// 竹内さん「動き方をちゃんと学習して、無駄に計算や API をたたかなくて済むように」
// 「細部までこだわって、ちゃんとした抜けのない手順書をつくれるように」（2026-11-20）。
//
//   束（human_learn_profile.bundle）の `scene_flows` は、場面ごとに「人が実際に押した欄の並び」を持つ。
//   手順書は、その並びを次の形に組み直した、小さくて版の付いた物:
//     ① 値（区名・間取り・数字）は手順から外す（それは「そのお客様の検索の中身」であって手順ではない）
//     ② 欄の名前は人が読む名前にする（PLAYBOOK_FIELD_JA。確かめた名前だけ）
//     ③ 同じ名前が連続したら1つにする（押し直しの二重記録を畳む）
//     ④ 分からない名前は「未分類」として残す（地名か欄か人が確かめる候補・黙って消さない）
//   ⚠ 材料に `site_flow` は使わない（押した要素の名前の集計で、場面の順番にならない＝実測で 287件が場面不明）。
//   ⚠ 順番の数（variants）は束の作り（学習側）の数え方のまま＝区名などの値の違いも数えている。
//     手順書はそれを「値を含む数」と明示する（型の数はまだ決まっていない）。学習側の数え方は変えない
//     （テスト learn-flow-steps が「どの区を選んだか」を残す仕様として固定している）。
//   ⚠ 新しい表は作らない（DB の構造は変えない）。拡張への配り方は竹内さんの OK の後（ここでは作るだけ）。
//   ⚠ 統括（Pro）の判断は入れない。ここは決定論（数えて並べて検査するだけ）。

import { SCENE_JA } from "./learn-flow-steps";
import { AUTO_RULES, RULE_SCENE_JA, autoRulesVersion, type RuleScene } from "./auto-procedure-rules";

/** 場面の確かさ: 3回以上の検索で出た＝solid（手順として使える）／1〜2回＝thin（薄い・人が1回確かめる候補） */
export const PLAYBOOK_SOLID_RUNS = 3;
/** 手順に載せる欄の数の上限（長い手順は先頭だけ） */
export const PLAYBOOK_MAX_STEPS = 12;
/**
 * 手順書の作り方の版（欄の名前・値の判定を変えたら上げる。版の印に入る）
 *   3（2026-11-20）: 1手ずつの細部（押す欄・押す位置・開く物）と、自動の決まり（auto-procedure-rules.ts）を載せる。
 *   4（2026-11-20）: 押す位置に source を付けた（その欄で測った／写し）。
 *   5（2026-11-20）: source を field／alias（同じ欄の別名へ写した測った値）／mismatch（開くボタンにチェック欄の位置が写った）の3つに。
 *     4 では alias（賃料上限 等の正しい測り）まで「写し」にしていた。数は positions_alias／positions_mismatch。
 */
export const PLAYBOOK_BUILD_V = 5;
/** 束がこれより古いと検査で「古い」と出す（束は夜に作り直す想定） */
export const PLAYBOOK_STALE_MS = 36 * 60 * 60 * 1000;

/**
 * 欄の名前 → 人が読む名前（リアプロの実際の欄名・実測で出た物だけ）。
 *   ⚠ ここに無い名前は「未分類」になる（推測で増やさない）。増やす時は実データの欄名を見てから。
 */
export const PLAYBOOK_FIELD_JA: Record<string, string> = {
  "所在地絞り込み＋": "所在地絞り込みを開く",
  "沿線・駅絞り込み＋": "沿線・駅絞り込みを開く",
  "city_code[]": "区の欄（チェック）",
  "town_code[]": "町字の欄（チェック）",
  "route_id[]": "沿線の欄（チェック）",
  "station_id[]": "駅の欄（チェック）",
  "駅の設定へ進む": "駅の設定へ進む",
  "沿線の設定へ戻る": "沿線の設定へ戻る",
  "transportation_id": "交通手段（徒歩など）",
  "required_time": "徒歩の分数",
  "rental_cost1": "賃料（下限）",
  "rental_cost2": "賃料（上限）",
  "structured_date": "築年数",
  "room_layout_id[]": "間取りの欄（チェック）",
  "update_date": "更新日",
  "include_common_fee": "管理費込みの欄",
  "確定してリストへ": "確定してリストへ",
  "検索": "検索を押す",
  "go_search": "検索を押す",
  // 2026-11-20 実測（自動 run_mwofi2sn_jbec の shot_ops に出た欄名）
  "絞り込み条件＋": "絞り込み条件を開く",
  "eq_rm[]": "ペットの欄（チェック）",
  "ペット相談": "ペット相談の欄（チェック）",
  "square_meter_l": "面積（下限）",
  "印刷用PDF": "印刷用PDFを押す",
  "次": "次のページへ",
};

/** 手順の1手の細部（押す欄・学んだ押す位置・押すと開く物） */
export type PlaybookStep = {
  /** 人が読む名前 */
  step: string;
  /** 押す欄の名前（束の名前・飾りを落とした物） */
  field: string;
  /** 学んだ押す位置（要素の中の割合）。学んでいなければ null。source は PositionSource（mismatch は solid にしない） */
  aim: { x: number; y: number; n: number; confidence: "solid" | "thin"; source: PositionSource } | null;
  /** 押すと開く物（人が確かめて学んだ物だけ）。無ければ null */
  opens: string | null;
};

/** 手順書に載せる自動の決まり（auto-procedure-rules.ts の写し） */
export type PlaybookRule = {
  id: string;
  scene: RuleScene;
  scene_label: string;
  text: string;
  since: string | null;
  kb: string | null;
};

/** 場面の手順の1件（束の scene_flows を手順書の形にしたもの） */
export type PlaybookScene = {
  scene: string;
  /** 人が読む名前（SCENE_JA） */
  label: string;
  /** この場面が出た検索の数 */
  runs: number;
  /** 人の操作の数（畳んだ後） */
  ops: number;
  /** 一番よく出る順番（人が読む名前・値は外す・先頭 PLAYBOOK_MAX_STEPS 件） */
  steps: string[];
  /** 操作と操作の間（中央値 ms） */
  gap_ms: number | null;
  /** 順番の数（束の数え方のまま＝区名などの値の違いも含む） */
  variants: number;
  /** 手順から外した値の数（区名・間取り・数字など）＝検査用 */
  values_dropped: number;
  /** 分からない欄の名前（未分類・地名か欄か人が確かめる候補） */
  unknown: string[];
  confidence: "solid" | "thin";
  /** 1手ずつの細部（steps と同じ順・同じ数） */
  detail: PlaybookStep[];
  /** この場面に効く自動の決まり（id） */
  rules: string[];
};

/** 押す位置の1件（束の points の欄ごと・人が押した位置の票） */
export type PlaybookPosition = {
  field: string;
  n: number;
  w: string | null;
  x: number | null;
  y: number | null;
  confidence: "solid" | "thin";
  /** field: この名前で測った／alias: 同じ欄の別名へ写した測った値／mismatch: 開くボタンにチェック欄の位置が写った */
  source: PositionSource;
};

/** 開く欄の1件（束の opens・押すと何が開くか） */
export type PlaybookOpen = {
  field: string;
  opens: string | null;
  n: number;
  /** 推測のまま（人が開いて確かめていない） */
  guessed: boolean;
};

export type Playbook = {
  v: 1;
  /** 作り方の版 */
  build_v: number;
  /** 版（内容のハッシュ・同じ束＝同じ版） */
  version: string;
  /** 元にした束の作成時刻 */
  based_on: string;
  /** 場面の手順（束の順のまま） */
  scenes: PlaybookScene[];
  /** まだ1件も学んでいない場面（人が1回通して録る候補） */
  missing: string[];
  /** 押す位置の確かさ（全体の数） */
  points: { solid: number; thin: number };
  /** 押す位置の一覧（欄ごと・票の多い順。学んだ物を全部載せる） */
  positions: PlaybookPosition[];
  /** positions のうち同じ欄の別名へ写した数（測った値そのもの） */
  positions_alias: number;
  /** positions のうち開くボタンにチェック欄の位置が写った数（そのまま使えない） */
  positions_mismatch: number;
  /** 押すと開く欄の数（人が確かめて学んだ物だけ＝推測は数えない） */
  opens_known: number;
  /** 押すと開く欄の一覧（推測の印つき・全部載せる） */
  opens: PlaybookOpen[];
  /** 推測のまま・票0の開く欄の数 */
  opens_guessed: number;
  /** 束の `next`（次のページ等）の学びの数（場面の手順にはまだ入っていないかもしれない） */
  next_n: number;
  /** 足りない所・迷い・分からない欄（人が確かめる文） */
  gaps: string[];
  /** 自動の決まり（全部・場面つき） */
  rules: PlaybookRule[];
  /** 自動の決まりの版（拡張の点検記録 playbook_seen の rv と突き合わせる） */
  rules_v: string;
};

type SceneFlowLike = {
  scene?: string;
  runs?: number;
  ops?: number;
  steps?: unknown[];
  gap_ms?: number | null;
  variants?: number;
};

type BundleLike = {
  generated_at?: string | null;
  scene_flows?: SceneFlowLike[] | null;
  points?: Record<string, { n?: number; w?: unknown; x?: unknown; y?: unknown }> | null;
  opens?: Record<string, { opens?: unknown; n?: unknown; guessed?: unknown }> | null;
  next?: Record<string, unknown> | null;
};

/** FNV-1a（32bit）の16進。版の印に使う（暗号ではない） */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 欄の名前の前後の飾り（画面の位置・タグ名）を落とす。sceneOfOp と同じ考え方 */
export function cleanPlaybookName(raw: string): string {
  return String(raw ?? "")
    .replace(/^(左の|右の|上の|下の|中央の)/, "")
    .replace(/｜[^｜]*$/, "")
    .trim();
}

/**
 * 値（お客様の検索の中身）かどうか。手順からは外す。
 *   区・市・郡・町・村の名前（大阪市西区・千林町 など）／間取り（2K・3LDK・ワンルーム）／数字・単位。
 *   ⚠ 「確定してリストへ」「沿線・駅絞り込み＋」のような欄の名前は当てない（末尾が区・市などでも、欄の語を含むなら欄）。
 */
export function isPlaybookValue(raw: string): boolean {
  const n = cleanPlaybookName(raw);
  if (!n) return false;
  if (PLAYBOOK_FIELD_JA[n]) return false;
  if (/^(ワンルーム|メゾネット|\d+[KDRSL]+)$/i.test(n)) return true;
  if (/^\d+(\.\d+)?(万円|万|分|㎡|年)?$/.test(n)) return true;
  // 金額・割合の選択肢（例: 「…初回総賃料50％月額1.5％」）は値
  if (/[％%]|円|万/.test(n) && /[0-9０-９]/.test(n)) return true;
  if (n.length <= 14 && /[区市郡町村]$/.test(n) && !/[＋]|検索|設定|リスト|絞り込み|一覧/.test(n)) return true;
  return false;
}

/**
 * 操作の並び（束の steps）→ 手順（人が読む名前）。純関数。
 *   値を外す → 欄の名前を読める形に → 同じ名前の連続を1つに。分からない名前は「未分類」として残す。
 */
export function normalizePlaybookSteps(steps: ReadonlyArray<string>): {
  steps: string[];
  /** steps と同じ順の欄の名前（飾りを落とした物） */
  fields: string[];
  unknown: string[];
  values_dropped: number;
} {
  const out: string[] = [];
  const fields: string[] = [];
  const unknown: string[] = [];
  let values_dropped = 0;
  for (const raw of steps) {
    const n = cleanPlaybookName(String(raw ?? ""));
    if (!n) continue;
    if (isPlaybookValue(n)) { values_dropped++; continue; }
    const label = PLAYBOOK_FIELD_JA[n];
    let item: string;
    if (label) item = label;
    else {
      item = `未分類（${n.slice(0, 40)}）`;
      if (!unknown.includes(n)) unknown.push(n.slice(0, 40));
    }
    if (out[out.length - 1] !== item) { out.push(item); fields.push(n); }
  }
  return { steps: out, fields, unknown, values_dropped };
}

type PosIndex = Map<string, { x: number; y: number; n: number; source: PositionSource }>;
type OpenIndex = Map<string, string>;

/**
 * 押す位置の出どころ:
 *   field    … この名前で測った位置（同じ値の名前が他に無い）
 *   alias    … 同じ欄の別名へ写した位置（rental_cost2 ↔ 賃料上限 等・field-name-aliases.ts の展開）。測った値そのもの
 *   mismatch … 開くボタン（〜絞り込み＋）に、箱の中のチェック欄の位置が写った物（押す物の形が違う＝そのまま使えない）
 *   実測（2026-11-20 束 2532）: city_code[]・所在地絞り込み・左の所在地絞り込み＋｜span が全部 n=1238 (0.5,0.5) checkbox。
 *     FIELD_NAME_ALIASES で city_code[] と 所在地絞り込み（開くボタン）が同じ組になっているため。沿線・駅も同じ。
 */
export type PositionSource = "field" | "alias" | "mismatch";
const SOURCE_RANK: Record<PositionSource, number> = { field: 3, alias: 2, mismatch: 1 };

function pointSignature(p: { n?: number; x?: unknown; y?: unknown; w?: unknown }): string {
  return `${p.n}|${p.x}|${p.y}|${String(p.w ?? "")}`;
}

/** 箱を開くボタンの名前か（〜絞り込み＋・〜絞り込み・〜を絞り込み） */
function isOpenerName(name: string): boolean {
  const n = cleanPlaybookName(name);
  return /＋$|\+$|絞り込み$/.test(n);
}

/** 同じ値（票・x・y・種類）を持つ名前の数 */
function signatureCounts(points: BundleLike["points"]): Map<string, number> {
  const count = new Map<string, number>();
  for (const p of Object.values(points ?? {})) {
    if (!p || (Number(p.n) || 0) < 1) continue;
    const s = pointSignature(p);
    count.set(s, (count.get(s) ?? 0) + 1);
  }
  return count;
}

function sourceOf(name: string, p: { n?: number; x?: unknown; y?: unknown; w?: unknown }, counts: Map<string, number>): PositionSource {
  if ((counts.get(pointSignature(p)) ?? 0) < 2) return "field";
  if (isOpenerName(name) && String(p.w ?? "") === "checkbox") return "mismatch";
  return "alias";
}

function indexPositions(points: BundleLike["points"]): PosIndex {
  const entries = Object.entries(points ?? {}).filter(([, p]) => (Number(p?.n) || 0) >= 1 && typeof p?.x === "number" && typeof p?.y === "number");
  const counts = signatureCounts(points);
  const m: PosIndex = new Map();
  for (const [k, p] of entries) {
    const n = Number(p.n) || 0;
    const source = sourceOf(k, p, counts);
    const key = cleanPlaybookName(k);
    const cur = m.get(key);
    const better = !cur || SOURCE_RANK[source] > SOURCE_RANK[cur.source] || (cur.source === source && cur.n < n);
    if (better) m.set(key, { x: p.x as number, y: p.y as number, n, source });
  }
  return m;
}

/** 束の opens を同じく引けるようにする（人が確かめた物だけ・推測は入れない） */
function indexOpens(opens: BundleLike["opens"]): OpenIndex {
  const m: OpenIndex = new Map();
  for (const [k, o] of Object.entries(opens ?? {})) {
    if (o?.guessed === true || !(Number(o?.n) > 0) || typeof o?.opens !== "string") continue;
    m.set(cleanPlaybookName(k), o.opens);
  }
  return m;
}

/** 手順書の場面 → 効く自動の決まり（同じ場面の物。press は全部の場面に効くので playbook.rules で見る） */
function rulesForScene(scene: string): string[] {
  return AUTO_RULES.filter((r) => r.scene === scene).map((r) => r.id);
}

/** 場面の手順 → 手順書の場面（値を外す・名前を読める形に・件数で上限・1手ずつの細部） */
export function playbookSceneOf(f: SceneFlowLike, pos: PosIndex = new Map(), opn: OpenIndex = new Map()): PlaybookScene {
  const scene = String(f.scene ?? "other");
  const runs = Number(f.runs) || 0;
  const norm = normalizePlaybookSteps((Array.isArray(f.steps) ? f.steps : []).map((x) => String(x)));
  const steps = norm.steps.slice(0, PLAYBOOK_MAX_STEPS);
  const detail: PlaybookStep[] = steps.map((step, i) => {
    const field = norm.fields[i] ?? "";
    const p = pos.get(field);
    return {
      step,
      field,
      aim: p ? { x: p.x, y: p.y, n: p.n, confidence: p.source !== "mismatch" && p.n >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin", source: p.source } : null,
      opens: opn.get(field) ?? null,
    };
  });
  return {
    scene,
    label: (SCENE_JA as Record<string, string>)[scene] ?? scene,
    runs,
    ops: Number(f.ops) || 0,
    steps,
    gap_ms: typeof f.gap_ms === "number" && Number.isFinite(f.gap_ms) ? f.gap_ms : null,
    variants: Number(f.variants) || 0,
    values_dropped: norm.values_dropped,
    unknown: norm.unknown,
    confidence: runs >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin",
    detail,
    rules: rulesForScene(scene),
  };
}

/** 束 → 手順書（純関数。同じ束からは同じ版） */
export function buildPlaybook(bundle: BundleLike): Playbook {
  const posIdx = indexPositions(bundle.points);
  const openIdx = indexOpens(bundle.opens);
  const scenes = (Array.isArray(bundle.scene_flows) ? bundle.scene_flows : [])
    .filter((f) => f && typeof f.scene === "string" && f.scene !== "other")
    .map((f) => playbookSceneOf(f, posIdx, openIdx));
  const learned = new Set(scenes.map((s) => s.scene));
  // other（場面が決まらない操作）は「学んでいない場面」ではないので外す
  const missing = Object.keys(SCENE_JA).filter((k) => k !== "other" && !learned.has(k));

  // 押す位置: 束の points を欄ごとに全部載せる（票1以上・票の多い順）。数は solid/thin で数える
  const sigCounts = signatureCounts(bundle.points);
  const positions: PlaybookPosition[] = Object.entries(bundle.points ?? {})
    .map(([field, p]) => {
      const n = Number(p?.n) || 0;
      return {
        field,
        n,
        w: typeof p?.w === "string" ? p.w : null,
        x: typeof p?.x === "number" && Number.isFinite(p.x) ? p.x : null,
        y: typeof p?.y === "number" && Number.isFinite(p.y) ? p.y : null,
        confidence: (n >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin") as "solid" | "thin",
        source: sourceOf(field, p ?? {}, sigCounts),
      };
    })
    .filter((p) => p.n >= 1)
    .sort((a, b) => b.n - a.n);
  const solid = positions.filter((p) => p.confidence === "solid").length;
  const thin = positions.filter((p) => p.confidence === "thin").length;
  const aliasCopies = positions.filter((p) => p.source === "alias").length;
  const mismatches = positions.filter((p) => p.source === "mismatch").length;

  // 開く欄: 人が確かめて学んだ物（n≥1 かつ推測でない）だけを「知っている」と数える。推測は別に数える
  const opens: PlaybookOpen[] = Object.entries(bundle.opens ?? {})
    .map(([field, o]) => ({
      field,
      opens: typeof o?.opens === "string" ? o.opens : null,
      n: Number(o?.n) || 0,
      guessed: o?.guessed === true,
    }))
    .sort((a, b) => b.n - a.n);
  const opens_known = opens.filter((o) => !o.guessed && o.n > 0).length;
  const opens_guessed = opens.length - opens_known;
  const next_n = Object.keys(bundle.next ?? {}).length;

  const gaps: string[] = [];
  if (!positions.length) gaps.push("押す位置が1つも無い（束の points が空）");
  if (mismatches) {
    const names = positions.filter((p) => p.source === "mismatch").map((p) => cleanPlaybookName(p.field)).slice(0, 4);
    gaps.push(`押す位置 ${positions.length}件のうち ${mismatches}件は、開くボタンに箱の中のチェック欄の位置が写った物（${names.join("・")}）＝別名の組（field-name-aliases.ts）でボタンとチェック欄が同じ組になっている`);
  }
  if (opens_guessed) gaps.push(`開く欄 ${opens_guessed}件は推測のまま（人が開いて確かめていない・数に入れない）`);
  if (next_n && !learned.has("next")) gaps.push(`次のページへ：束の next に ${next_n}件あるが、場面の手順（人が押した順）にはまだなっていない（整理の抜けの疑い）`);
  if (!scenes.length) gaps.push("場面の手順が1つも無い（まだ学んでいない）");
  for (const s of scenes) {
    if (s.confidence === "thin") gaps.push(`${s.label}：検索${s.runs}回だけ（3回未満・人が1回通して確かめる候補）`);
    // 順番の数が0は「数えていない」（束の欠け）。0通りとは読まない
    if (s.runs > 0 && s.variants === 0) gaps.push(`${s.label}：順番の数が束に入っていない（0と書かれている・学習側の欠けの疑い）`);
    // 順番の数は値（区名など）の違いも数えている＝「迷い」と言い切れない
    if (s.variants >= 2) gaps.push(`${s.label}：順番${s.variants}通り（区名・間取りなど値の違いを含む数・型の数はまだ確かめていない）`);
    if (s.unknown.length) gaps.push(`${s.label}：欄の名前が分からないもの（${s.unknown.join("・")}）・地名か欄かを人が確かめる`);
  }
  if (missing.length) gaps.push(`まだ学んでいない場面：${missing.map((k) => (SCENE_JA as Record<string, string>)[k]).join("・")}`);
  for (const s of scenes) {
    const noAim = s.detail.filter((d) => !d.aim).map((d) => d.step);
    if (noAim.length) gaps.push(`${s.label}：押す位置を学んでいない手 ${noAim.length}件（${noAim.slice(0, 4).join("・")}）`);
    const badAim = s.detail.filter((d) => d.aim?.source === "mismatch").map((d) => d.step);
    if (badAim.length) gaps.push(`${s.label}：押す位置がボタンとチェック欄の取り違えの手 ${badAim.length}件（${badAim.slice(0, 4).join("・")}）`);
    const thinAim = s.detail.filter((d) => d.aim && d.aim.source !== "mismatch" && d.aim.confidence === "thin").map((d) => d.step);
    if (thinAim.length) gaps.push(`${s.label}：押す位置の票が3回未満の手 ${thinAim.length}件（${thinAim.slice(0, 4).join("・")}）`);
  }

  // 自動の決まり（拡張で直した物）。人の手本の場面が無い所（前客の外し・ペット等）も決まりは載せる
  const rules: PlaybookRule[] = AUTO_RULES.map((r) => ({
    id: r.id, scene: r.scene, scene_label: RULE_SCENE_JA[r.scene], text: r.text, since: r.since, kb: r.kb,
  }));
  const rules_v = autoRulesVersion();
  const ruleOnly = [...new Set(rules.map((r) => r.scene))].filter((sc) => sc !== "press" && !learned.has(sc));
  if (ruleOnly.length) {
    gaps.push(`人の手本（録画の場面）がまだ無く、自動の決まりだけの場面：${ruleOnly.map((sc) => RULE_SCENE_JA[sc]).join("・")}`);
  }

  const body = JSON.stringify({ build_v: PLAYBOOK_BUILD_V, scenes, missing, points: { solid, thin }, positions, opens, next_n, rules_v });
  return {
    v: 1,
    build_v: PLAYBOOK_BUILD_V,
    version: fnv1a(body),
    based_on: String(bundle.generated_at ?? ""),
    scenes,
    missing,
    points: { solid, thin },
    positions,
    positions_alias: aliasCopies,
    positions_mismatch: mismatches,
    opens_known,
    opens,
    opens_guessed,
    next_n,
    gaps,
    rules,
    rules_v,
  };
}

/**
 * 手順書の検査（純関数）。抜けがあれば文で返す（空＝問題なし）。
 *   ⚠ 「問題なし」は「この検査では見つからない」という意味。手順が正しいとは言わない。
 */
/**
 * 束の手順書が古ければ（作り方の版が下・決まりの版がコードと違う・無い）作り直した写しを返す（元の束は変えない）。
 *   API が拡張へ渡す時に使う＝決まりを直してデプロイしたら、次に束を書く前でも拡張は新しい手順書を読む。
 */
export function refreshPlaybookIfStale(bundle: Record<string, unknown> | null | undefined): {
  bundle: Record<string, unknown> | null | undefined; refreshed: boolean; why: string | null;
} {
  if (!bundle || typeof bundle !== "object") return { bundle, refreshed: false, why: null };
  const pb = bundle.playbook as Partial<Playbook> | null | undefined;
  let why: string | null = null;
  if (!pb || typeof pb !== "object") why = "手順書が無い";
  else if ((Number(pb.build_v) || 0) < PLAYBOOK_BUILD_V) why = `作り方が古い（${pb.build_v ?? "-"}→${PLAYBOOK_BUILD_V}）`;
  else if (pb.rules_v !== autoRulesVersion()) why = `決まりの版が古い（${pb.rules_v ?? "-"}→${autoRulesVersion()}）`;
  if (!why) return { bundle, refreshed: false, why: null };
  const copy: Record<string, unknown> = { ...bundle };
  copy.playbook = buildPlaybook(copy as never);
  return { bundle: copy, refreshed: true, why };
}

export function checkPlaybook(pb: Playbook, nowMs: number = Date.now()): string[] {
  const issues: string[] = [];
  if (!pb.scenes.length) issues.push("場面が0（手順書が空）");
  // 学んだ押す位置が手順書に全部入っているか（入れ忘れ・数の食い違いの網）
  if (pb.positions.length !== pb.points.solid + pb.points.thin) issues.push("押す位置の数が合わない（一覧と数）");
  if (pb.opens_known + pb.opens_guessed !== pb.opens.length) issues.push("開く欄の数が合わない（一覧と数）");
  if (pb.positions.some((p) => p.x == null || p.y == null)) issues.push("押す位置に座標の無い物がある（押せない）");
  for (const s of pb.scenes) {
    if (!(s.scene in SCENE_JA)) issues.push(`場面の名前が知らない物：${s.scene}`);
    if (!s.steps.length) issues.push(`${s.label}：手順が空`);
    for (const st of s.steps) {
      // 値（間取り・区名の形）が手順に残っていないか
      if (/\d+[KDLS]+/.test(st) || /[区市郡]$/.test(st)) issues.push(`${s.label}：値が手順に残っている（${st}）`);
    }
    if (s.unknown.length) issues.push(`${s.label}：未分類の欄 ${s.unknown.length}件`);
    if (s.runs > 0 && s.variants === 0) issues.push(`${s.label}：順番の数が0（束の欠けの疑い・0と読まない）`);
  }
  // 自動の決まり（拡張で直した物）が手順書に入っているか・コードの決まりと同じ版か
  if ((Number(pb.build_v) || 0) < PLAYBOOK_BUILD_V) issues.push(`作り方が古い（build_v=${pb.build_v}・今は ${PLAYBOOK_BUILD_V}）`);
  if (!Array.isArray(pb.rules) || !pb.rules.length) issues.push("自動の決まりが手順書に入っていない");
  else if (pb.rules_v !== autoRulesVersion()) issues.push(`自動の決まりの版が古い（手順書 ${pb.rules_v}・コード ${autoRulesVersion()}）`);
  for (const s of pb.scenes) {
    if (!Array.isArray(s.detail) || s.detail.length !== s.steps.length) issues.push(`${s.label}：1手ずつの細部が手順と合わない`);
  }
  const based = Date.parse(pb.based_on);
  if (!Number.isFinite(based)) issues.push("束の作成時刻が読めない");
  else if (nowMs - based > PLAYBOOK_STALE_MS) issues.push(`束が古い（作成から ${Math.round((nowMs - based) / 3600000)} 時間）`);
  return issues;
}
