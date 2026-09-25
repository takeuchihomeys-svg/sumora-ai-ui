// 2026-09-25 竹内「沿線指定あれば沿線もちゃんと理解しているのか」
// 実行: npx tsx app/lib/__tests__/area-line-words.test.ts
import { parseAreaWant, buildPropertyLocation, matchArea } from "../area-want";
let passed = 0, failed = 0;
function eq<T>(name: string, a: T, b: T) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? passed++ : failed++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`}`); }
const P = {
  江坂: "【1】X\n70,000円\n1K 25㎡\n大阪メトロ御堂筋線 江坂駅 徒歩5分",
  淡路: "【2】Y\n70,000円\n1K 25㎡\n阪急京都線 淡路駅 徒歩5分",
  新大阪: "【3】Z\n70,000円\n1K 25㎡\nJR京都線 新大阪駅 徒歩5分",
  豊中: "【4】W\n70,000円\n1K 25㎡\n阪急宝塚線 豊中駅 徒歩5分",
};
const code = (want: string, p: keyof typeof P) => matchArea(parseAreaWant(want), buildPropertyLocation(P[p], null))?.code ?? null;
const read = (want: string) => { const w = parseAreaWant(want); return { lines: w.lines.map((l) => l.word), stations: w.stations.map((s) => s.station) }; };

console.log("\n■ 路線名の中の駅名を駅の希望にしない");
eq("阪急京都線沿線", read("阪急京都線沿線"), { lines: ["阪急京都線"], stations: [] });
eq("京阪中之島線", read("京阪中之島線"), { lines: ["京阪中之島線"], stations: [] });
eq("京都線（JR）", read("京都線"), { lines: ["京都線"], stations: [] });
eq("阪急宝塚線か千里線", read("阪急宝塚線か千里線"), { lines: ["阪急宝塚線", "千里線"], stations: [] });
eq("駅名の方が長い「野田阪神」は駅", read("野田阪神"), { lines: [], stations: ["野田阪神"] });
eq("「京都駅」は駅", read("京都駅").stations, ["京都"]);
eq("「谷町線の天満橋あたり」は路線と駅", read("谷町線の天満橋あたり"), { lines: ["谷町線"], stations: ["天満橋"] });

console.log("\n■ 沿線の照合");
eq("阪急京都線沿線 × 淡路（阪急京都線）", code("阪急京都線沿線", "淡路"), "AREA_LINE_MATCH");
eq("阪急京都線沿線 × 新大阪（JR京都線）は合わない", code("阪急京都線沿線", "新大阪"), "AREA_FAR");
eq("JR京都線沿い × 新大阪", code("JR京都線沿い", "新大阪"), "AREA_LINE_MATCH");
eq("JR京都線沿い × 淡路（阪急）は合わない", code("JR京都線沿い", "淡路"), "AREA_FAR");
eq("阪急宝塚線か千里線 × 豊中", code("阪急宝塚線か千里線", "豊中"), "AREA_LINE_MATCH");
eq("御堂筋線沿線 × 江坂", code("御堂筋線沿線", "江坂"), "AREA_LINE_MATCH");
eq("御堂筋線沿線 × 豊中（阪急）は合わない", code("御堂筋線沿線", "豊中"), "AREA_FAR");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
