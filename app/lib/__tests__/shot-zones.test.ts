// app/lib/__tests__/shot-zones.test.ts
//
// 2026-11-15 竹内さん「画面全体見て把握できるようにする」
//
// なぜ要るか（実測）:
//   ⚠ 旧は**左34%だけ**を切り出して読んでいた（中央の拡張の小窓を避けるため）。
//     そのため**物件の一覧・ページ送り・右上の絞り込み・小窓**が1つも読めていなかった。
//     実測: 写真から読めた名前は130件すべて同じ19個＝左の条件だけ。
//   → 画面全体を読み、**どの領域にある欄か**（zone）を残す。
//
// このテストが守る物:
//   ① 位置から領域を決められる（写真が読めなくても使える・費用0）
//   ② 壊れた入力でも落ちない（既存の呼び出しを壊さない）
//   ③ AI が zone を書けばそれを優先・無ければ位置で埋める
//   ④ 領域ごとに数えて「どこに何があるか」を言える
//
// 実行: npx tsx app/lib/__tests__/shot-zones.test.ts
import { zoneOf, zoneJa, summarizeZones, cleanFields, parseShotLearn, SHOT_ZONES } from "../shot-learn";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 位置から領域を決める");
{
  ok("左の条件（x0.1）は left", zoneOf(0.1, 0.5) === "left");
  ok("中央の一覧（x0.5 y0.5）は center", zoneOf(0.5, 0.5) === "center");
  ok("下のページ送り（y0.96）は bottom", zoneOf(0.5, 0.96) === "bottom");
  ok("上の見出し（y0.05）は top", zoneOf(0.5, 0.05) === "top");
  ok("右の補足（x0.9）は right", zoneOf(0.9, 0.5) === "right");
  /**
   * ⚠ 順番の罠: 「下」を先に見ないと、左下のページ送りが left になる。
   *   ページ送りは画面の一番下の帯なので bottom が正しい。
   */
  ok("左下のページ送り（x0.1 y0.97）も bottom", zoneOf(0.1, 0.97) === "bottom");
  ok("位置が無ければ other", zoneOf(null, null) === "other");
  ok("片方だけでも落ちない", zoneOf(0.5, null) === "other" && zoneOf(undefined, 0.5) === "other");
  ok("範囲外の値でも落ちない", typeof zoneOf(-1, 2) === "string" && typeof zoneOf(99, -99) === "string");
  ok("領域の日本語が引ける", zoneJa("left") === SHOT_ZONES.left && zoneJa("なにこれ") === SHOT_ZONES.other);
}

console.log("\n■ ② cleanFields が領域を付ける（壊れた入力でも落ちない）");
{
  const f = cleanFields([{ name: "賃料", kind: "select", x: 0.1, y: 0.5 }]);
  ok("位置から left が付く", f[0]?.zone === "left", f[0]);
  const f2 = cleanFields([{ name: "次のページ", kind: "link", x: 0.5, y: 0.97 }]);
  ok("ページ送りは bottom", f2[0]?.zone === "bottom", f2[0]);
  const f3 = cleanFields([{ name: "物件一覧", kind: "button", x: 0.5, y: 0.5 }]);
  ok("一覧は center", f3[0]?.zone === "center", f3[0]);
  // AI が zone を書いていれば優先
  const f4 = cleanFields([{ name: "確定", kind: "button", x: 0.5, y: 0.5, zone: "modal" }]);
  ok("AI が書いた zone を優先する", f4[0]?.zone === "modal", f4[0]);
  // 知らない zone は位置で決める
  const f5 = cleanFields([{ name: "賃料", kind: "select", x: 0.1, y: 0.5, zone: "なにこれ" }]);
  ok("知らない zone は位置で決め直す", f5[0]?.zone === "left", f5[0]);
  // 位置が無くても落ちない
  const f6 = cleanFields([{ name: "賃料", kind: "select" }]);
  ok("位置が無ければ other が付く（落ちない）", f6[0]?.zone === "other", f6[0]);
  // 既存の動きを壊していない
  const f7 = cleanFields([{ name: "賃料", kind: "select", x: 0.1, y: 0.5 }]);
  ok("名前と種類は今まで通り", f7[0]?.name === "賃料" && f7[0]?.kind === "select");
  ok("x・y も今まで通り", f7[0]?.x === 0.1 && f7[0]?.y === 0.5);
  ok("ゴミ（名前なし）は今まで通り捨てる", cleanFields([{ name: "", kind: "select" }]).length === 0);
  ok("知らない種類は今まで通り捨てる", cleanFields([{ name: "x", kind: "なにこれ" }]).length === 0);
  ok("配列でなくても落ちない", cleanFields(null).length === 0 && cleanFields({}).length === 0);
}

console.log("\n■ ③ parseShotLearn が zones を返す");
{
  const s = parseShotLearn(JSON.stringify({
    screen: "form", confidence: 0.9,
    fields: [
      { name: "賃料", kind: "select", x: 0.1, y: 0.5 },
      { name: "築年数", kind: "select", x: 0.1, y: 0.6 },
      { name: "次のページ", kind: "link", x: 0.5, y: 0.96 },
    ],
  }));
  ok("zones が入る", Array.isArray(s.zones) && s.zones!.length === 2, s.zones);
  ok("多い順（左が2件で先頭）", s.zones![0].zone === "left" && s.zones![0].n === 2, s.zones);
  ok("代表の名前が入る", s.zones![0].names.indexOf("賃料") >= 0, s.zones![0]);
  ok("壊れた JSON でも落ちない", parseShotLearn("これはJSONではない").fields.length === 0);
  ok("fields が空でも落ちない", parseShotLearn('{"screen":"other","fields":[]}').zones?.length === 0);
}

console.log("\n■ ④ summarizeZones（名前は3つまで・重複しない）");
{
  const z = summarizeZones([
    { name: "a", kind: "select", zone: "left" },
    { name: "a", kind: "select", zone: "left" },
    { name: "b", kind: "text", zone: "left" },
    { name: "c", kind: "text", zone: "left" },
    { name: "d", kind: "text", zone: "left" },
  ]);
  ok("数は全部数える", z[0].n === 5, z[0]);
  ok("名前は3つまで", z[0].names.length === 3, z[0]);
  ok("名前は重複しない", new Set(z[0].names).size === z[0].names.length, z[0]);
  ok("zone が無ければ other に入る", summarizeZones([{ name: "x", kind: "text" }])[0].zone === "other");
  ok("空でも落ちない", summarizeZones([]).length === 0);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
