// scripts/build-osaka-transit-data.ts — 拡張ツール（物件検索）の辞書から、サーバーで使う静的データ app/lib/osaka-transit-data.ts を作る
// 実行: npx tsx scripts/build-osaka-transit-data.ts
//   → ① app/lib/osaka-transit-data.ts（拡張の辞書の写し）② chrome-extension/osaka-transit.js（サーバーと同じデータ・同じ関数の拡張用・UMD）
//   駅の位置・路線の直し・直通の運転・駅のまとまりの元は app/lib/osaka-geo.ts の1か所。直したら必ずこれを流し直す。
//
// 2026-09-25 竹内「通勤の部分も沿線の知識。拡張ツールの物件検索のデータベースにあるから、それ使えるなら使う」
//   → chrome-extension/popup-maps.js（駅→区・町名→区・広域名・区の隣接・路線の別名・乗換の塊・路線の駅の並び）と
//     chrome-extension/build-transit-graph.js（路線ごとの1駅の分数）を**読むだけ**（拡張は編集しない）で写す。
//   直し・足し（駅の並びの誤り・兵庫の路線・座標）は app/lib/osaka-geo.ts 側に持つ（ここは写しだけ・手で編集しない）。
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..");
const maps = readFileSync(join(root, "chrome-extension/popup-maps.js"), "utf8");
const graph = readFileSync(join(root, "chrome-extension/build-transit-graph.js"), "utf8");

function objectLiteral(src: string, name: string): unknown {
  const i = src.search(new RegExp(String.raw`(?:const|var|let)\s+${name}\s*=`));
  if (i < 0) throw new Error(`${name} が見つからない`);
  const start = src.indexOf("{", i);
  let depth = 0, j = start, inStr: string | null = null;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (inStr) { if (ch === "\\") { j++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  return new Function(`return ${src.slice(start, j + 1)}`)();
}

const out = {
  STATION_WARD_MAP: objectLiteral(maps, "STATION_WARD_MAP"),
  NEIGHBORHOOD_WARD_MAP: objectLiteral(maps, "NEIGHBORHOOD_WARD_MAP"),
  MULTI_WARD_MAP: objectLiteral(maps, "MULTI_WARD_MAP"),
  ADJACENT_AREA_MAP: objectLiteral(maps, "ADJACENT_AREA_MAP"),
  LINE_ALIAS_MAP: objectLiteral(maps, "LINE_ALIAS_MAP"),
  STATION_HUB_MAP: objectLiteral(maps, "STATION_HUB_MAP"),
  LINE_STATION_ORDER: objectLiteral(maps, "LINE_STATION_ORDER"),
  LINE_TRAVEL_TIMES: objectLiteral(graph, "LINE_TRAVEL_TIMES"),
};

const head = `// app/lib/osaka-transit-data.ts — 自動生成（scripts/build-osaka-transit-data.ts）。手で編集しない。
// 出所: chrome-extension/popup-maps.js（STATION_WARD_MAP・NEIGHBORHOOD_WARD_MAP・MULTI_WARD_MAP・ADJACENT_AREA_MAP・LINE_ALIAS_MAP・
//   STATION_HUB_MAP・LINE_STATION_ORDER）と chrome-extension/build-transit-graph.js（LINE_TRAVEL_TIMES＝路線ごとの1駅の分数）。
// 拡張の辞書を直したら生成し直す。誤りの直し・足りない路線・座標は app/lib/osaka-geo.ts に持つ。
// 生成: ${new Date().toISOString().slice(0, 10)}
/* eslint-disable */
`;
const body = Object.entries(out).map(([k, v]) => {
  const type = k === "LINE_TRAVEL_TIMES" ? "Record<string, number>"
    : k === "MULTI_WARD_MAP" || k === "ADJACENT_AREA_MAP" || k === "STATION_HUB_MAP" || k === "LINE_STATION_ORDER" ? "Record<string, string[]>"
    : "Record<string, string>";
  return `export const EXT_${k}: ${type} = ${JSON.stringify(v)};\n`;
}).join("\n");
writeFileSync(join(root, "app/lib/osaka-transit-data.ts"), head + "\n" + body, "utf8");
console.log(Object.entries(out).map(([k, v]) => `${k}: ${Object.keys(v as object).length}`).join(" / "));

// ───────────────────────── 拡張用: chrome-extension/osaka-transit.js（UMD・self.AxlxOsakaTransit） ─────────────────────────
// 2026-09-25 竹内「地図の部分や沿線の部分の位置関係の強化は拡張ツールでも理解できるようにする」
//   データ（transitData()＝osaka-geo の路線・直し・直通の運転・駅のまとまり・座標・名前の揺れ）と関数（app/lib/transit-core.ts を JS に変換）を
//   そのまま書き出す。サーバーと拡張で同じデータ・同じ関数（手で二重に持たない）。拡張側でこのファイルを編集しない。
//   駅名は拡張の辞書（popup-maps.js の STATION_LINE_MAP・LINE_STATION_ORDER）の言い方に戻す表（EXT_NAMES）を付ける。
//   サイトごとの駅名・路線名（リアプロ／itandi／レインズ）には触れない（拡張の既存の対応表を通す）。
async function buildExtension() {
  const ts = await import("typescript");
  const { transitData } = await import("../app/lib/transit-route");
  const { normStation } = await import("../app/lib/osaka-geo");
  const data = transitData();

  // 拡張の駅名 → そろえた名前（逆に引く表）
  const stationLineMap = objectLiteral(maps, "STATION_LINE_MAP") as Record<string, string[]>;
  const extWords = new Set<string>(Object.keys(stationLineMap));
  for (const st of Object.values(out.LINE_STATION_ORDER as Record<string, string[]>)) for (const s of st) extWords.add(s);
  // 会社名の頭を落とすと別の駅と同じ名前になる言い方（能勢電の平野 ≠ 谷町線・大和路線の平野）
  const EXT_WORD_FIX: Record<string, string> = { 能勢電平野: "平野(能勢)" };
  const extNames: Record<string, string[]> = {};
  for (const w of extWords) {
    const n = EXT_WORD_FIX[w] ?? normStation(w);
    (extNames[n] ??= []).push(w);
  }
  for (const [n, arr] of Object.entries(extNames)) {
    // そろえた名前と同じ言い方 → 拡張の STATION_LINE_MAP にある言い方 → 短い順
    arr.sort((a, b) => Number(b === n) - Number(a === n) || Number(!!stationLineMap[b]) - Number(!!stationLineMap[a]) || a.length - b.length);
    extNames[n] = [...new Set(arr)];
  }

  const coreSrc = readFileSync(join(root, "app/lib/transit-core.ts"), "utf8");
  const js = ts.transpileModule(coreSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, removeComments: false } }).outputText;

  const stamp = new Date().toISOString().slice(0, 10);
  const umd = `// chrome-extension/osaka-transit.js — 自動生成（scripts/build-osaka-transit-data.ts）。手で編集しない。
// 生成: ${stamp}
// 中身: app/lib/transit-core.ts（関数・JS に変換）＋ app/lib/transit-route.ts の transitData()（osaka-geo の路線・直通の運転・駅のまとまり・座標）。
// 使い方（拡張）: self.AxlxOsakaTransit.oneRideStations("梅田") ／ .stationsWithin("梅田", 30, { maxTransfers: 1 }) ／ .commuteAsks(文)
//   ／ .extName("なんば")（拡張の辞書の駅名に戻す）。サーバーは app/lib/transit-route.ts の同じ名前の関数。
/* eslint-disable */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxOsakaTransit = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";
  var exports = {};
  // ───── app/lib/transit-core.ts（変換） ─────
${js.split("\n").map((l) => (l ? "  " + l : l)).join("\n")}
  // ───── データ ─────
  var DATA = ${JSON.stringify(data)};
  var EXT_NAMES = ${JSON.stringify(extNames)};
  var t = exports.createTransit(DATA);
  var INDEX = {};
  Object.keys(DATA.lines).forEach(function (l) { DATA.lines[l].forEach(function (s) { INDEX[s] = true; }); });
  // 結果の駅名（「住吉(神戸)」「平野(能勢)」）はそのまま、言い方の揺れはそろえてから引く
  function key(station) { return INDEX[station] ? station : t.normStation(station); }
  /** そろえた駅名 → 拡張の辞書の駅名（無ければ null＝拡張の辞書に無い駅） */
  function extName(station) {
    var arr = EXT_NAMES[key(station)];
    return arr && arr.length ? arr[0] : null;
  }
  /** そろえた駅名 → 拡張の辞書の言い方の全部（「なんば」→ なんば・難波・JR難波・大阪難波 等。路線で選び分ける時に使う） */
  function extNames(station) {
    return (EXT_NAMES[key(station)] || []).slice();
  }
  /** 文から「◯◯まで一本／◯分／通勤」を読む（サーバーの commuteAsksInText と同じ） */
  function commuteAsks(text) { return exports.parseCommuteAsks(text, t.groupOf); }
  return {
    version: "${stamp}",
    normStation: t.normStation,
    groupOf: t.groupOf,
    isKnownStation: t.isKnownStation,
    linesOf: t.linesOf,
    oneRideStations: t.oneRideStations,
    stationsWithin: t.stationsWithin,
    shortestRoute: t.shortestRoute,
    distanceKmBetween: t.distanceKmBetween,
    commuteAsks: commuteAsks,
    shortLineName: exports.shortLineName,
    extName: extName,
    extNames: extNames,
    groups: DATA.groups,
    lines: DATA.lines,
  };
});
`;
  writeFileSync(join(root, "chrome-extension/osaka-transit.js"), umd, "utf8");
  console.log(`chrome-extension/osaka-transit.js: 路線 ${Object.keys(data.lines).length}・直通 ${data.services.length}・まとまり ${Object.keys(data.groups).length}・座標 ${Object.keys(data.coords).length}・拡張の駅名 ${Object.keys(extNames).length}・${Math.round(umd.length / 1024)}KB`);
}
buildExtension().catch((e) => { console.error(e); process.exit(1); });
