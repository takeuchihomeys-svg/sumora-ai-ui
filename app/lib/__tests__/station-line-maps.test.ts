// app/lib/__tests__/station-line-maps.test.ts — サーバーの路線の対応表が正本（popup-maps.js）と同じか・手直しで ITANDI/REINS を作り直すか
// 実行: npx tsx app/lib/__tests__/station-line-maps.test.ts
// 2026-11-10 作業員B（DB_STRUCTURE.md の混ざっている所 4・6）
import { readFileSync } from "fs";
import { join } from "path";
import vm from "vm";
import { ITANDI_LINE_MAP, REINS_LINE_MAP, deriveSiteLines, mapRealproToItandi, mapRealproToReins } from "../station-line-maps";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── 正本から2つの表を取り出す（popup-maps.js の const をそのまま評価） ──
const src = readFileSync(join(__dirname, "../../../chrome-extension/popup-maps.js"), "utf8");
function extract(name: string): Record<string, string | string[]> {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`${name} が popup-maps.js に無い`);
  const end = src.indexOf("\n};", start);
  const body = src.slice(start + `const ${name} = `.length, end + 2);
  return vm.runInNewContext(`(${body})`) as Record<string, string | string[]>;
}
const CANON_ITANDI = extract("ITANDI_LINE_MAP_FILL");
const CANON_REINS = extract("REINS_LINE_MAP");

console.log("■ 正本と同じか");
t("ITANDI の表が正本と同じ（キーも値も）", eq(Object.keys(ITANDI_LINE_MAP).sort(), Object.keys(CANON_ITANDI).sort()) &&
  Object.keys(CANON_ITANDI).every((k) => eq(ITANDI_LINE_MAP[k], CANON_ITANDI[k])),
  JSON.stringify(Object.keys(CANON_ITANDI).filter((k) => !eq(ITANDI_LINE_MAP[k], CANON_ITANDI[k]))) +
  JSON.stringify(Object.keys(ITANDI_LINE_MAP).filter((k) => !(k in CANON_ITANDI))));
t("REINS の表が正本と同じ（キーも値も）", eq(Object.keys(REINS_LINE_MAP).sort(), Object.keys(CANON_REINS).sort()) &&
  Object.keys(CANON_REINS).every((k) => REINS_LINE_MAP[k] === CANON_REINS[k]),
  JSON.stringify(Object.keys(CANON_REINS).filter((k) => REINS_LINE_MAP[k] !== CANON_REINS[k])) +
  JSON.stringify(Object.keys(REINS_LINE_MAP).filter((k) => !(k in CANON_REINS))));

console.log("■ token-resolve の AI への例が表と同じ");
const tr = readFileSync(join(__dirname, "../../api/token-resolve/route.ts"), "utf8");
t("手書きの誤った例（阪急電鉄阪急神戸線・阪急電鉄神戸本線）が無い", !tr.includes("阪急電鉄阪急神戸線") && !tr.includes("阪急電鉄神戸本線"));
t("token-resolve は表を自前で持たず station-line-maps から読む", tr.includes('from "@/app/lib/station-line-maps"') && !/const ITANDI_LINE_MAP\b/.test(tr) && !/const REINS_LINE_MAP\b/.test(tr));
t("例の阪急神戸線: ITANDI=阪急神戸本線・REINS=阪急神戸線（表どおり）", ITANDI_LINE_MAP["阪急電鉄神戸線"] === "阪急神戸本線" && REINS_LINE_MAP["阪急電鉄神戸線"] === "阪急神戸線");

console.log("■ 変換");
t("2本に分かれる路線（近鉄難波・奈良線）", eq(mapRealproToItandi(["近鉄難波・奈良線"]).lines, ["近鉄難波線", "近鉄奈良線"]));
t("重なりは1つに（南海本線と南本線）", eq(mapRealproToItandi(["南海電鉄南海本線", "南海電鉄南本線"]).lines, ["南海本線"]));
t("表に無い路線は unmapped", eq(mapRealproToItandi(["謎の線"]).unmapped, ["謎の線"]));
t("REINS は最初の1本", mapRealproToReins(["大阪環状線", "阪神電鉄本線"]) === "大阪環状線");
t("REINS 表に無ければ null", mapRealproToReins(["謎の線"]) === null);

console.log("■ 手直しで作り直す（station-map の POST）");
const prev = { itandi_lines: ["高速電気軌道第1号線(大阪メトロ御堂筋線)"], reins_line: "大阪メトロ御堂筋線" };
{
  const r = deriveSiteLines(["阪急電鉄神戸線", "阪神電鉄本線"], prev, true);
  t("リアプロを直したら ITANDI も作り直す", eq(r.itandi_lines, ["阪急神戸本線", "阪神本線"]) && r.itandi === "rebuilt");
  t("リアプロを直したら REINS も作り直す", r.reins_line === "阪急神戸線" && r.reins === "rebuilt");
}
{
  const r = deriveSiteLines(["阪急電鉄神戸線", "謎の線"], prev, true);
  t("1本でも変換できない → ITANDI は前の値のまま・その路線を返す", eq(r.itandi_lines, prev.itandi_lines) && r.itandi === "kept" && eq(r.unmapped_itandi, ["謎の線"]));
  t("REINS は最初の1本が変換できれば作り直す", r.reins_line === "阪急神戸線" && r.reins === "rebuilt" && r.unmapped_reins.length === 0);
}
{
  const r = deriveSiteLines(["謎の線"], prev, true);
  t("最初の1本が変換できない → REINS は前の値のまま", r.reins_line === "大阪メトロ御堂筋線" && r.reins === "kept" && eq(r.unmapped_reins, ["謎の線"]));
}
{
  const r = deriveSiteLines(["大阪市高速軌道御堂筋線"], { itandi_lines: ["古い値"], reins_line: "古い値" }, false);
  t("路線の指定なし（駅として登録だけ）→ 入っている値は触らない", eq(r.itandi_lines, ["古い値"]) && r.reins_line === "古い値" && r.itandi === "kept" && r.reins === "kept");
}
{
  const r = deriveSiteLines(["大阪市高速軌道御堂筋線"], { itandi_lines: [], reins_line: null }, false);
  t("路線の指定なしでも空の列は今のリアプロの路線から埋める", eq(r.itandi_lines, ["高速電気軌道第1号線(大阪メトロ御堂筋線)"]) && r.reins_line === "大阪メトロ御堂筋線");
}
{
  const r = deriveSiteLines([], null, false);
  t("新しい語で路線も前の行も無い → 空のまま", eq(r.itandi_lines, []) && r.reins_line === null);
}

console.log("■ 配線（station-map の POST が作り直しを使う）");
const sm = readFileSync(join(__dirname, "../../api/station-map/route.ts"), "utf8");
t("POST が deriveSiteLines を呼び、その値を upsert に入れる", sm.includes("deriveSiteLines(") && sm.includes("itandi_lines: site.itandi_lines") && sm.includes("reins_line: site.reins_line"));
t("変換できない時は warning を返す", sm.includes("warning"));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
