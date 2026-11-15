// app/lib/__tests__/image-point-match.test.ts
//
// 2026-11-15 竹内さん「押した位置も画像みたら理解できるし
//   どこがプルダウンかどこ押しているかも通常モードの録画みて統括理解して
//   学習したのを自動モードに反映したらきょうかされる」
//
// ★ 実測で分かった役割の違い（混ぜると壊れる）
//   `shot_learn`（画像から読んだ欄）: **画面のどこに何があるか**（x=0.05 y=0.23）
//   `point_fields`（押した位置）     : **その欄の中のどこを押したか**（0〜1）
//   → 別々に扱い、名前で突き合わせる。
//
// ⚠ 実測で踏んだ罠: `point_fields` が `{}`（空）でも「ある」と数えてしまった。
//
// 実行: npx tsx app/lib/__tests__/image-point-match.test.ts
import { matchImageToPressed, sameField, whatSupervisorCanSay } from "../image-point-match";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 同じ欄かどうか（表記の揺れを吸収）");
{
  ok("完全一致", sameField("検索", "検索"));
  ok("接頭辞を落とす", sameField("左の検索｜span", "検索"));
  ok("片方が他方を含む（4文字以上）", sameField("左の大阪市西区", "大阪市西区"));
  ok("違う欄は違う", !sameField("検索", "リセット"));
  ok("空は同じにしない", !sameField("", ""));
  /**
   * ⚠ 2026-11-15 実測で誤った対応が出た:
   *   `"2"` と `"2"` が一致して、画像の「2」（ページ送り）に
   *   押した記録の「2」（賃料の選択肢）を対応させていた。
   */
  ok("⚠ 短い名前（2文字以下）は部分一致させない", !sameField("分", "分譲"));
  ok("⚠ 極端に短い物は部分一致させない（2 ⊂ 2024）", !sameField("2", "2024"));
  /**
   * ⚠ 長さ比が 0.5 未満は部分一致させない（`2` ⊂ `2024` の誤爆防止）。
   *   "住居検索"(4) / "検索"(2) = 0.5 なので**ちょうど境界**。
   *   → 同じ長さの半分以上なら許す（"大阪市西区"(5) / "大阪市西区"(5) = 1.0）。
   */
  ok("4文字以上で長さが近ければ部分一致を許す", sameField("左の大阪市西区", "大阪市西区"));
  ok("短すぎる物は許さない（住居検索 vs 検索）", !sameField("住居検索", "検索"));
}

console.log("\n■ ①-b 種類が違えば対応させない（別の欄）");
{
  const r = matchImageToPressed(
    [{ name: "2", kind: "link", x: 0.28, y: 0.94 }],
    { "2": { n: 2, x: 0.17, y: 0.2, w: "select" } },
  );
  ok("⚠ 名前が同じでも link と select は対応させない", r.matched.length === 0, r.matched);
  ok("画像側は「押していない」に入る", r.notPressed.includes("2"));
  // 似た種類（link と button）は許す
  const r2 = matchImageToPressed(
    [{ name: "絞り込み条件", kind: "link" }],
    { "絞り込み条件": { n: 2, x: 0.5, y: 0.5, w: "button" } },
  );
  ok("link と button は同じとみなす（サイト差）", r2.matched.length === 1, r2.matched);
}

console.log("\n■ ② ⚠ 空の point_fields を「押した」と数えない（実測の罠）");
{
  const img = [{ name: "マップ検索", kind: "button", x: 0.05, y: 0.06 }];
  const r1 = matchImageToPressed(img, {});
  ok("空オブジェクトは押した数0", r1.pressedFields === 0, r1.pressedFields);
  ok("画像にあるが押していないに入る", r1.notPressed.includes("マップ検索"));
  const r2 = matchImageToPressed(img, null);
  ok("null でも押した数0", r2.pressedFields === 0);
}

console.log("\n■ ③ 突き合わせ（画像と押した位置）");
{
  const img = [
    { name: "マップ検索", kind: "button", x: 0.05, y: 0.06, zone: "left" },
    { name: "所在地絞り込み", kind: "button", x: 0.05, y: 0.23 },
    { name: "賃料", kind: "select", x: 0.07, y: 0.5 },
  ];
  const pressed = {
    "左のマップ検索｜span": { n: 2, x: 0.5, y: 0.5, w: "button" },
    "rental_cost2": { n: 3, x: 0.1, y: 0.3, w: "select" },
  };
  const r = matchImageToPressed(img, pressed);
  ok("画像の欄の数", r.imageFields === 3);
  ok("押した欄の数", r.pressedFields === 2);
  ok("両方にあるのは1欄（マップ検索）", r.matched.length === 1, r.matched.map((m) => m.name));
  ok("画像にあるが押していない（所在地・賃料）", r.notPressed.length === 2, r.notPressed);
  ok("⚠ 押したが画像に無い（rental_cost2）", r.notInImage.includes("rental_cost2"), r.notInImage);
  ok("1行で分かる", r.line.includes("画像") && r.line.includes("押した"), r.line);
}

console.log("\n■ ④ 画面の位置と要素の中の位置を混ぜない（役割が違う）");
{
  const img = [{ name: "所在地絞り込み", kind: "button", x: 0.05, y: 0.23 }];
  const pressed = { "左の所在地絞り込み＋｜span": { n: 2, x: 0.55, y: 0.6, w: "button" } };
  const r = matchImageToPressed(img, pressed);
  const m = r.matched[0];
  ok("画面の位置は 0.05 / 0.23", m.screenX === 0.05 && m.screenY === 0.23, m);
  ok("押した位置は 0.55 / 0.6（別物として持つ）", m.pressX === 0.55 && m.pressY === 0.6, m);
}

console.log("\n■ ⑤ 種類が違う欄を見つける（プルダウンかボタンか）");
{
  const img = [{ name: "賃料", kind: "select", x: 0.07, y: 0.5 }];
  const pressed = { "rental_cost2": { n: 3, x: 0.1, y: 0.3, w: "button" } };
  const r = matchImageToPressed(img, pressed);
  // 名前が違うので突き合わせられない → kindConflicts には入らない（正直に）
  ok("名前が違えば突き合わせない（推測しない）", r.matched.length === 0);
  // 同じ名前で種類が違う場合は**対応させない**（別の欄の可能性）
  const r2 = matchImageToPressed([{ name: "賃料", kind: "select" }], { "賃料": { n: 2, x: 0.1, y: 0.3, w: "button" } });
  ok("⚠ 種類が違えば対応させない（conflicts ではなく notPressed）", r2.kindConflicts.length === 0 && r2.notPressed.includes("賃料"), r2);
  ok("押した側は notInImage に入る", r2.notInImage.includes("賃料"), r2.notInImage);
}

console.log("\n■ ⑥ 統括が言える事（悪い所だけ名指し）");
{
  // 押した位置が0
  const r1 = matchImageToPressed([{ name: "検索", kind: "button" }], {});
  const say1 = whatSupervisorCanSay(r1);
  ok("押した位置が0なら指摘する", say1.some((s) => s.what.includes("押した位置が1つも記録されていない")), say1);
  ok("画像からは何欄読めたかを添える", say1.some((s) => s.why.includes("1欄")), say1);

  // 種類の食い違いは「対応させない」ので conflicts は出ない（設計変更）
  const r2 = matchImageToPressed([{ name: "賃料", kind: "select" }], { "賃料": { n: 2, w: "button" } });
  ok("種類が違う欄は対応させない（誤った対応を防ぐ）", r2.kindConflicts.length === 0 && r2.notPressed.includes("賃料"), r2);

  // 良い状態なら何も言わない
  const r3 = matchImageToPressed([{ name: "検索", kind: "button" }], { "検索": { n: 2, x: 0.5, y: 0.5, w: "button" } });
  ok("✅ 良ければ指摘しない", whatSupervisorCanSay(r3).length === 0, whatSupervisorCanSay(r3));
}

console.log("\n■ ⑦ 壊れた入力でも落ちない");
{
  ok("空でも落ちない", matchImageToPressed([], {}).imageFields === 0);
  ok("null でも落ちない", matchImageToPressed(null as never, null as never).pressedFields === 0);
  ok("null が混ざっても落ちない", matchImageToPressed([null as never, { name: "検索", kind: "button" }], {}).imageFields === 1);
  ok("名前が無い欄は飛ばす", matchImageToPressed([{ kind: "button" }], {}).imageFields === 0);
  /**
   * ⚠ 画像0欄・押した0欄でも「押した位置が1つも記録されていない」は**正しい指摘**
   *   （学ぶ材料が無いので、次にやるべき事がある）。
   */
  ok("空でも落ちない（押した位置0を指摘する）", whatSupervisorCanSay(matchImageToPressed([], {})).length === 1);
}

console.log("\n■ ⑧ 竹内さんの考え方をコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../image-point-match.ts"), "utf8");
  ok("押した位置も画像で分かると書いてある", /押した位置も画像/.test(src));
  ok("プルダウンかどうかも分かると書いてある", /プルダウン/.test(src));
  ok("画像と押した位置の役割が違うと書いてある", /役割が違う/.test(src));
  ok("空の point_fields の罠を書いてある", /空.*数えない|`\{\}`/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
