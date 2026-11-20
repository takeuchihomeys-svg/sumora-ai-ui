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

/** 場面の確かさ: 3回以上の検索で出た＝solid（手順として使える）／1〜2回＝thin（薄い・人が1回確かめる候補） */
export const PLAYBOOK_SOLID_RUNS = 3;
/** 手順に載せる欄の数の上限（長い手順は先頭だけ） */
export const PLAYBOOK_MAX_STEPS = 12;
/** 手順書の作り方の版（欄の名前・値の判定を変えたら上げる。版の印に入る） */
export const PLAYBOOK_BUILD_V = 2;
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
};

/** 押す位置の1件（束の points の欄ごと・人が押した位置の票） */
export type PlaybookPosition = {
  field: string;
  n: number;
  w: string | null;
  x: number | null;
  y: number | null;
  confidence: "solid" | "thin";
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
  unknown: string[];
  values_dropped: number;
} {
  const out: string[] = [];
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
    if (out[out.length - 1] !== item) out.push(item);
  }
  return { steps: out, unknown, values_dropped };
}

/** 場面の手順 → 手順書の場面（値を外す・名前を読める形に・件数で上限） */
export function playbookSceneOf(f: SceneFlowLike): PlaybookScene {
  const scene = String(f.scene ?? "other");
  const runs = Number(f.runs) || 0;
  const norm = normalizePlaybookSteps((Array.isArray(f.steps) ? f.steps : []).map((x) => String(x)));
  return {
    scene,
    label: (SCENE_JA as Record<string, string>)[scene] ?? scene,
    runs,
    ops: Number(f.ops) || 0,
    steps: norm.steps.slice(0, PLAYBOOK_MAX_STEPS),
    gap_ms: typeof f.gap_ms === "number" && Number.isFinite(f.gap_ms) ? f.gap_ms : null,
    variants: Number(f.variants) || 0,
    values_dropped: norm.values_dropped,
    unknown: norm.unknown,
    confidence: runs >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin",
  };
}

/** 束 → 手順書（純関数。同じ束からは同じ版） */
export function buildPlaybook(bundle: BundleLike): Playbook {
  const scenes = (Array.isArray(bundle.scene_flows) ? bundle.scene_flows : [])
    .filter((f) => f && typeof f.scene === "string" && f.scene !== "other")
    .map(playbookSceneOf);
  const learned = new Set(scenes.map((s) => s.scene));
  // other（場面が決まらない操作）は「学んでいない場面」ではないので外す
  const missing = Object.keys(SCENE_JA).filter((k) => k !== "other" && !learned.has(k));

  // 押す位置: 束の points を欄ごとに全部載せる（票1以上・票の多い順）。数は solid/thin で数える
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
      };
    })
    .filter((p) => p.n >= 1)
    .sort((a, b) => b.n - a.n);
  const solid = positions.filter((p) => p.confidence === "solid").length;
  const thin = positions.filter((p) => p.confidence === "thin").length;

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

  const body = JSON.stringify({ build_v: PLAYBOOK_BUILD_V, scenes, missing, points: { solid, thin }, positions, opens, next_n });
  return {
    v: 1,
    build_v: PLAYBOOK_BUILD_V,
    version: fnv1a(body),
    based_on: String(bundle.generated_at ?? ""),
    scenes,
    missing,
    points: { solid, thin },
    positions,
    opens_known,
    opens,
    opens_guessed,
    next_n,
    gaps,
  };
}

/**
 * 手順書の検査（純関数）。抜けがあれば文で返す（空＝問題なし）。
 *   ⚠ 「問題なし」は「この検査では見つからない」という意味。手順が正しいとは言わない。
 */
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
  const based = Date.parse(pb.based_on);
  if (!Number.isFinite(based)) issues.push("束の作成時刻が読めない");
  else if (nowMs - based > PLAYBOOK_STALE_MS) issues.push(`束が古い（作成から ${Math.round((nowMs - based) / 3600000)} 時間）`);
  return issues;
}
