/**
 * DBにあるのに使われていない物を洗い出す（2026-11-14 竹内さん「DBにあって反映できていないものや
 * 連携にあたって強化できていない部分はあるか」）
 *
 * 4段それぞれの「隙間」を数える:
 *   ① DB に列がある → ② 読んでいる → ③ 束に入れている → ④ 拡張が使っている
 * 実行: npx tsx --env-file=.env.local scripts/audit-db-unused.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ROUTE = read("app/api/human-learn-profile/route.ts");
const BRAIN = read("app/lib/human-learn-brain.ts");
const SHOT = read("app/lib/shot-learn.ts");
const BG = read("chrome-extension/background.js");
const PS = read("chrome-extension/page-script.js");
const HL = read("chrome-extension/human-learn.js");
const REC = read("chrome-extension/human-learn-record.js");

/** 本番DBの human_motion_learn の列（実測） */
const DB_COLS = [
  "id", "created_at", "install_id", "device_label", "site", "mode", "ext_version",
  "ops", "sessions", "gap_ms", "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
  "drag_n", "points_n", "point_x", "point_y", "point_fields", "scrolls_n", "scroll_dy", "scroll_y",
  "scroll_down", "scroll_up", "scroll_ys", "kinds", "fields", "field_order",
  "shot_taken", "shot_key", "shot_w", "shot_h", "shot_b64", "shot_in_db", "shot_ops", "shot_learn",
  "opens", "open_kinds",
];

/** ① 読んでいる列（SELECT 配列） */
const sel = (() => {
  const m = /const SELECT = \[([\s\S]*?)\]\.join/.exec(ROUTE);
  if (!m) return new Set<string>();
  const out = new Set<string>();
  for (const mm of m[1].matchAll(/"([a-z_0-9]+)"/g)) out.add(mm[1]);
  return out;
})();

/** ② 束（bundle）のキー */
const bundleKeys = (() => {
  const out = new Set<string>();
  const m = /export type HumanLearnBundle = \{([\s\S]*?)\n\};/.exec(BRAIN);
  if (m) for (const mm of m[1].matchAll(/^\s{2}([a-z_0-9]+)\??:/gm)) out.add(mm[1]);
  return out;
})();

/** ③ 拡張が storage に置くキー → ④ 読むキー */
const bgPlaces = (() => {
  const out = new Set<string>();
  for (const mm of BG.matchAll(/axlx_learn_[a-z_0-9]+:/g)) out.add(mm[0].replace(":", ""));
  return out;
})();
const bgReads = (() => {
  const out = new Set<string>();
  for (const mm of BG.matchAll(/"?(axlx_learn_[a-z_0-9]+)"?/g)) out.add(mm[1]);
  return out;
})();
const psReads = (() => {
  const out = new Set<string>();
  for (const mm of PS.matchAll(/"(axlx_learn_[a-z_0-9]+)"/g)) out.add(mm[1]);
  return out;
})();

console.log("=== ① DB にあるが、学習の束を読む時に SELECT していない列 ===");
const notSelected = DB_COLS.filter((c) => !sel.has(c));
const knownNotNeeded = new Set(["id", "install_id", "device_label", "shot_b64", "shot_key", "shot_w", "shot_h", "shot_taken", "shot_in_db", "sessions", "ops", "move_dist", "drag_n", "scroll_y", "scroll_down", "scroll_up", "scroll_ys", "kinds"]);
for (const c of notSelected) {
  console.log(`  ${c === undefined ? "" : knownNotNeeded.has(c) ? "・" : "⚠"} ${c}${knownNotNeeded.has(c) ? "（束に要らない＝意図的）" : " ← 使われていない可能性"}`);
}

console.log("\n=== ② SELECT しているが、束（bundle）にしていない列 ===");
const selToBundle: Record<string, string[]> = {
  created_at: ["source"], site: ["source"], mode: ["by_mode", "mode_counts"], ext_version: [],
  moves_n: ["motion"], move_speed_px_s: ["motion"], move_curve: ["motion"], move_ms: ["motion"],
  gap_ms: ["gaps"], points_n: ["motion"], point_x: ["motion"], point_y: ["motion"],
  point_fields: ["points"], scrolls_n: ["motion"], scroll_dy: ["motion"],
  shot_ops: ["next", "screen_flow", "sequence_flow"], shot_learn: ["screen_flow"],
  field_order: ["next", "sequence_flow"], fields: ["next"], opens: ["opens"], open_kinds: [],
};
for (const c of sel) {
  const targets = selToBundle[c];
  if (targets === undefined) { console.log(`  ⚠ ${c} ← 束での使い道が不明`); continue; }
  if (targets.length === 0) { console.log(`  ！ ${c} … 読むだけで束に入れていない`); }
}

console.log("\n=== ③ 束にあるが、拡張が storage に置いていないキー ===");
const bundleToStorage: Record<string, string> = {
  next: "axlx_learn_next", points: "axlx_learn_points", motion: "axlx_learn_motion",
  buttons: "", site_flow: "axlx_learn_site_flow", gaps: "axlx_learn_gaps", weak: "axlx_learn_weak",
  screen_flow: "axlx_learn_screen_flow", sequence_flow: "axlx_learn_seq", by_mode: "axlx_learn_by_mode",
  learn_plan: "axlx_learn_plan", opens: "axlx_learn_opens", shots: "axlx_learn_shots",
  mode_counts: "", source: "axlx_learn_src", lines: "",
};
for (const k of bundleKeys) {
  const st = bundleToStorage[k];
  if (st === undefined) { console.log(`  ⚠ ${k} ← 置き場所が決まっていない`); continue; }
  if (!st) { console.log(`  ！ ${k} … 拡張に渡していない（サーバー側だけで使う）`); continue; }
  if (!bgPlaces.has(st)) console.log(`  ⚠ ${st} ← background が置いていない`);
}

console.log("\n=== ④ storage に置いたが、page-script が読んでいないキー ===");
for (const k of bgPlaces) {
  if (!psReads.has(k)) {
    // background / human-learn.js が読む物は除く
    const byOther = HL.includes(`"${k}"`) || REC.includes(`"${k}"`) || bgReads.has(k);
    console.log(`  ${byOther ? "・" : "⚠"} ${k}${byOther ? "（page-script 以外が読む）" : " ← 誰も読んでいない"}`);
  }
}

console.log("\n=== ⑤ 学習の中身で「学んでいるのに自動検索が使っていない」物 ===");
const usedInPs: Array<[string, boolean]> = [
  ["押す順番（next）", PS.includes("_orderByLearned")],
  ["押す位置（points）", PS.includes("_aimByEl")],
  ["展開先（opens）", PS.includes("_opensOfEl")],
  ["画面ごとの手順（screen_flow）", PS.includes("axlx_learn_screen_flow")],
  ["一連の動き（sequence_flow）", PS.includes("axlx_learn_seq")],
  ["モード別（by_mode）", PS.includes("axlx_learn_by_mode") || BG.includes("by_mode")],
  ["操作の間（gaps）", HL.includes("medianGapFor") || HL.includes("axlx_learn_gaps")],
  ["動きの癖（motion）", HL.includes("axlx_learn_motion")],
  ["弱い所（weak）", PS.includes("axlx_learn_weak") || BG.includes("axlx_learn_weak")],
  ["統括の判断（learn_plan）", PS.includes("axlx_learn_plan")],
];
for (const [name, used] of usedInPs) console.log(`  ${used ? "✓" : "⚠"} ${name}${used ? "" : " ← 自動検索が使っていない"}`);

console.log("\n=== ⑥ 記録しているが送っていない物（拡張 → DB）===");
const sends: Array<[string, boolean]> = [
  ["操作（ops）", /add\.n|summarize\(/.test(REC)],
  ["押した位置（points）", REC.includes("adds.points")],
  ["動き（moves）", REC.includes("adds.moves")],
  ["スクロール（scrolls）", REC.includes("adds.scrolls")],
  ["欄の名前（fields）", REC.includes("add.fields")],
  ["押す順番（order）", REC.includes("add.order")],
  ["展開先（opens）", REC.includes("add.opens")],
  ["展開先の内訳（open_kinds）", REC.includes("add.open_kinds")],
  ["モード別の自動（mode=aix）", REC.includes('mode: "aix"')],
];
for (const [name, ok] of sends) console.log(`  ${ok ? "✓" : "⚠"} ${name}`);
