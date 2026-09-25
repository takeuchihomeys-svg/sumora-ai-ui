// scripts/audit-osaka-transit.ts — 代表の目的地で「乗り換えなしで行ける駅」「◯分以内の駅」を並べ、目で読むための一覧（DB なし・0円）
// 実行: npx tsx scripts/audit-osaka-transit.ts [--min=30] [--to=梅田,なんば] [--full]
//   サーバー（app/lib/transit-route.ts）と拡張（chrome-extension/osaka-transit.js）の結果が一字一句同じかも確かめる。
// 2026-09-25 竹内「梅田駅まで電車で一本の場合…沿線を全て理解…電車で何分以内で通える駅かも分かる」
import { createRequire } from "module";
import { join } from "path";
import { oneRideStations, stationsWithin, shortLineName } from "../app/lib/transit-route";

const req = createRequire(__filename);
const ext = req(join(__dirname, "../chrome-extension/osaka-transit.js"));

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const MIN = Number(arg("min") ?? 30);
const full = process.argv.includes("--full");
const dests = (arg("to") ?? "梅田,なんば,天王寺,京橋,本町,新大阪").split(",");

let mismatch = 0;
for (const d of dests) {
  const one = oneRideStations(d);
  const within = stationsWithin(d, MIN, { maxTransfers: 2 });
  const w1 = stationsWithin(d, MIN, { maxTransfers: 1 });
  const extOne = ext.oneRideStations(d);
  const extWithin = ext.stationsWithin(d, MIN, { maxTransfers: 2 });
  if (JSON.stringify(one) !== JSON.stringify(extOne) || JSON.stringify(within) !== JSON.stringify(extWithin)) { mismatch++; console.log(`!! ${d}: サーバーと拡張の結果が違う`); }
  if (!one || !within || !w1) { console.log(`!! ${d}: 知らない目的地`); continue; }
  console.log(`\n■ ${d}（まとまり: ${one.target.members.join("・")}）`);
  console.log(`  乗り換えなし: ${one.stations.length}駅・${one.routes.length}経路`);
  for (const r of one.routes) {
    const names = full || r.stations.length <= 14 ? r.stations.join(" ") : `${r.stations.slice(0, 7).join(" ")} … ${r.stations.slice(-5).join(" ")}`;
    console.log(`   - ${r.kind === "service" ? "直通 " : ""}${r.kind === "line" ? shortLineName(r.route) : r.route}（${r.via.join("・")}）${r.stations.length}駅: ${names}`);
  }
  const noExt = one.stations.filter((s) => !ext.extName(s.station)).map((s) => s.station);
  if (noExt.length) console.log(`   拡張の辞書に無い駅 ${noExt.length}: ${noExt.slice(0, 30).join(" ")}${noExt.length > 30 ? " …" : ""}`);
  const byT = [0, 1, 2].map((n) => within.stations.filter((s) => s.transfers === n).length);
  console.log(`  ${MIN}分以内: ${within.stations.length}駅（乗換0: ${byT[0]}・1回: ${byT[1]}・2回: ${byT[2]}）／乗換1回まで ${w1.stations.length}駅`);
  const show = full ? within.stations : within.stations.filter((_, i) => i % Math.max(1, Math.floor(within.stations.length / 40)) === 0);
  console.log("   " + show.map((s) => `${s.station}${s.minutes}${s.transfers ? `(${s.transfers})` : ""}`).join(" "));
}
console.log(`\nサーバーと拡張の食い違い: ${mismatch}`);
