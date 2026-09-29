// scripts/build-commute-reach-table.ts — 到達時間の表 app/lib/commute-reach-table.ts を作る（決定論・ハードコードの写し）
// 実行: npx tsx scripts/build-commute-reach-table.ts
//   出所: app/lib/osaka-geo.ts（路線の駅の並び・駅の間の分・直通の運転・駅のまとまり）→ transit-route.stationsWithin（乗り換え1回まで・5分）。
//   目的の駅は、お客様の通勤先で多い物（2026-09-29 の property_customers の通勤の列・希望エリアの「◯◯まで◯分」）と主要なターミナル。
//   osaka-geo を直したら流し直す（app/lib/__tests__/commute-reach.test.ts が「表＝その場の計算」を確かめる）。
import { writeFileSync } from "fs";
import { join } from "path";
import { stationsWithin, transit } from "../app/lib/transit-route";

/** 目的の駅（そろえた名前）。お客様の通勤先で多い順＋主要ターミナル */
export const TARGETS = [
  "梅田", "なんば", "天王寺", "本町", "心斎橋", "京橋", "新大阪", "淀屋橋", "上本町", "日本橋", "堺筋本町", "北浜", "南森町", "天満橋",
  "三ノ宮", "江坂", "大日", "野江", "玉造", "西九条", "北加賀屋", "茨木市", "七道", "堺東", "阿波座", "新今宮", "鶴橋", "十三",
];
export const MAX_MINUTES = 45;
export const MAX_TRANSFERS = 1;

const t = transit();
const table: Record<string, Array<[string, number, number]>> = {};
for (const target of TARGETS) {
  const g = t.groupOf(target);
  if (!g) throw new Error(`目的の駅が路線図に無い: ${target}`);
  const w = stationsWithin(g.key, MAX_MINUTES, { maxTransfers: MAX_TRANSFERS });
  if (!w) throw new Error(`到達駅が出ない: ${target}`);
  table[g.key] = w.stations.map((s) => [s.station, s.minutes, s.transfers] as [string, number, number]);
}
const stamp = new Date().toISOString().slice(0, 10);
const head = `// app/lib/commute-reach-table.ts — 自動生成（scripts/build-commute-reach-table.ts）。手で編集しない。
// 到達時間の表: 目的の駅（そろえた名前・梅田＝大阪・西梅田・北新地 等のまとまり）→ [駅, 所要の目安（分）, 乗り換えの回数] を分の短い順に。
//   乗り換えは ${MAX_TRANSFERS} 回まで（5分）・${MAX_MINUTES} 分まで・目的の駅そのものは含めない。出所は osaka-geo（駅の並び・駅の間の分・直通の運転）。
//   時刻表ではない目安（各停の分数。急行・特急は入れていない）。誤りは osaka-geo.ts を直して流し直す。
// 生成: ${stamp}
/* eslint-disable */
export const COMMUTE_REACH_TABLE_MAX_MINUTES = ${MAX_MINUTES};
export const COMMUTE_REACH_TABLE_MAX_TRANSFERS = ${MAX_TRANSFERS};
export const COMMUTE_REACH_TARGETS: string[] = ${JSON.stringify(Object.keys(table))};
export const COMMUTE_REACH_TABLE: Record<string, Array<[string, number, number]>> = {
`;
const body = Object.entries(table).map(([k, rows]) => `  ${JSON.stringify(k)}: [\n${rows.map((r) => `    ${JSON.stringify(r)},`).join("\n")}\n  ],`).join("\n");
writeFileSync(join(__dirname, "..", "app/lib/commute-reach-table.ts"), `${head}${body}\n};\n`, "utf8");
console.log(Object.entries(table).map(([k, v]) => `${k} ${v.length}`).join(" / "));
