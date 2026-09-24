// scripts/build-osaka-transit-data.ts — 拡張ツール（物件検索）の辞書から、サーバーで使う静的データ app/lib/osaka-transit-data.ts を作る
// 実行: npx tsx scripts/build-osaka-transit-data.ts
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
