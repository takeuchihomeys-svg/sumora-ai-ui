// 実行: npx tsx app/lib/__tests__/shot-learn.test.ts
// 2026-11-13 竹内さん「画面の写真から判断できる。そこの部分強化するようにする。
//   画像を見れば学習できるし弱い部分等は学習の統括が判断して学習を繰り返していく」
//
// 写真から学ぶ仕組み（app/lib/shot-learn.ts）を固定する。
import {
  cleanFields, cleanScreen, reconcilePoints, findWeakPoints, parseShotLearn, describeShotLearn, SHOT_LEARN_PROMPT,
} from "../shot-learn";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

console.log("■ ① 写真から読んだ欄を整える");
{
  t("名前と種類がそろった物だけ残す", cleanFields([
    { name: "賃料", kind: "select", x: 0.1, y: 0.5 },
    { name: "", kind: "text" },
    { name: "築年数", kind: "??? " },
  ]).length === 1);
  t("座標は 0〜1 に丸める", (() => {
    const f = cleanFields([{ name: "A", kind: "text", x: 9, y: -3 }])[0];
    return f.x === 1 && f.y === 0;
  })());
  t("同じ名前＋種類の重複は1つ", cleanFields([{ name: "A", kind: "text" }, { name: "A", kind: "text" }]).length === 1);
  t("  種類が違えば別物として残す", cleanFields([{ name: "A", kind: "text" }, { name: "A", kind: "select" }]).length === 2);
  t("押せない印を残す", cleanFields([{ name: "A", kind: "button", enabled: false }])[0].enabled === false);
  t("壊れた入力でも落ちない", cleanFields(null).length === 0 && cleanFields([null, 1, "x"]).length === 0);
}

console.log("\n■ ② 画面の種類");
{
  t("form/modal/result/other だけ通す", ["form", "modal", "result", "other"].every((s) => cleanScreen(s) === s));
  t("変な値は other", cleanScreen("unknown") === "other" && cleanScreen(null) === "other");
  t("大文字でも通す", cleanScreen("FORM") === "form");
}

console.log("\n■ ③ 写真と数値を突き合わせる（名前だけでは分からなかった種類を埋める）");
{
  const points = {
    rental_cost2: { x: 0.1, y: 0.2, n: 6 },                 // 種類が無い（旧版）
    structured_date: { x: 0.2, y: 0.3, n: 4, w: "text" },    // 数値は text（誤り）
    unknown_field: { x: 0.3, y: 0.4, n: 2, w: "select" },    // 写真に無い
  } as Record<string, { x: number; y: number; n: number; w?: string }>;
  const fields = [
    { name: "rental_cost2", kind: "select" },
    { name: "structured_date", kind: "select" },
  ];
  const r = reconcilePoints(points as never, fields as never);
  t("種類が無い欄を写真で埋める（select）", r.points.rental_cost2.w === "select", r.points.rental_cost2);
  t("食い違ったら**写真を採る**（text→select）", r.points.structured_date.w === "select", r.points.structured_date);
  t("写真に無い欄はそのまま（勝手に変えない）", r.points.unknown_field.w === "select");
  /**
   * 2026-11-14 竹内さん「確かめて治す」:
   *   ⚠ 旧は**埋めただけの欄も `fixed` に入れて**いたので「食い違い」が実在しなくても並んでいた
   *     （実測 `shot_learn` は0件＝比較する相手が無いのに6件出ていた）。
   *   → **本当に違う時だけ** `fixed` に入れるように直した。
   *     `rental_cost2`（種類が無い→埋めた）は `fixed` に入らない。`structured_date`（text→select）だけ入る。
   */
  t("直した所を残す（食い違いだけ・埋めただけは残さない）",
    r.fixed.length === 1 && r.fixed.some((f) => f.name === "structured_date" && f.from === "text" && f.to === "select"), r.fixed);
  t("  ⚠ 埋めただけの欄は「食い違い」にしない", !r.fixed.some((f) => f.name === "rental_cost2"), r.fixed);
  t("数を変えない（増減しない）", Object.keys(r.points).length === 3);
  t("元の points を書き換えない", points.rental_cost2.w === undefined);
}

console.log("\n■ ④ 弱い所を見つける（統括が「次に何を学ぶか」を決める）");
{
  const points = { a: { n: 3 }, b: { n: 2, w: "select" }, c: { n: 1, w: "text" } };
  const fields = [
    { name: "a", kind: "select" },
    { name: "c", kind: "text" },
    { name: "dup", kind: "select" },
    { name: "dup", kind: "text" },   // 同じ名前で割れている
    { name: "a", kind: "button", enabled: false },
  ];
  const weak = findWeakPoints(points as never, fields as never, [{ name: "c" }] as never);
  const kinds = weak.map((w) => w.kind);
  t("種類が分からない欄を指摘", kinds.includes("kind_unknown"));
  t("写真の中で種類が割れている欄を指摘", kinds.includes("kind_conflict_in_photo"));
  /**
   * 2026-11-14: `fixed` は「**本当に違った**物だけ」（`from` と `to` が違う）。
   *   `{ name: "c" }` だけ（from/to 無し）は「埋めただけ」なので、もう食い違いにしない。
   */
  const weak2 = findWeakPoints(points as never, fields as never, [{ name: "c", from: "text", to: "select" }] as never);
  const kinds2 = weak2.map((w) => w.kind);
  t("写真と記録が違った欄を指摘", kinds2.includes("photo_vs_record"), kinds2);
  const weak3 = findWeakPoints(points as never, fields as never, [{ name: "c" }] as never);
  t("  ⚠ from/to の無い物は「食い違い」にしない（埋めただけ）", !weak3.map((w) => w.kind).includes("photo_vs_record"), weak3.map((w) => w.kind));
  t("押せない欄を押しているのを指摘", kinds.includes("pressed_disabled"));
  t("それぞれに「次にどうするか」がある", weak.every((w) => !!w.next));
  t("同じ物を重ねない", new Set(weak.map((w) => w.kind + "|" + w.name)).size === weak.length);
  t("上限40件", findWeakPoints({} as never, [] as never, [] as never).length === 0);
}

console.log("\n■ ⑤ LLM の返事を読む（壊れていても落ちない）");
{
  const ok = parseShotLearn('はい。\n{"screen":"form","confidence":0.86,"fields":[{"name":"賃料","kind":"select","x":0.1,"y":0.5}]}');
  t("JSON を読む", ok.screen === "form" && ok.fields.length === 1);
  t("確かさを残す（0.86）", ok.confidence === 0.86);
  t("読んだ方法は llm", ok.by === "llm");
  const bad = parseShotLearn("JSON ではありません");
  t("壊れた返事でも落ちない", bad.fields.length === 0 && bad.confidence === 0);
  t("JSON の前後に文があっても読む", parseShotLearn('結果です {"screen":"result","fields":[]} 以上').screen === "result");
}

console.log("\n■ ⑥ 中身（入力した文字）は読ませない・残さない");
{
  t("指示文に「入力された中身は書かない」とある", /入力された中身.*絶対に書かない/.test(SHOT_LEARN_PROMPT));
  t("指示文に欄の種類の決め方がある", /プルダウン/.test(SHOT_LEARN_PROMPT) && /直接入力|文字を打つ欄/.test(SHOT_LEARN_PROMPT));
  t("読めない時は推測しない（空配列）", /読めない時は fields を空配列/.test(SHOT_LEARN_PROMPT));
  t("人が読む1行が出る", describeShotLearn({ screen: "form", fields: [{ name: "賃料", kind: "select" }], by: "llm", confidence: 0.9 }).includes("プルダウン1個"));
  t("  欄が読めない時も文章になる", describeShotLearn({ screen: "other", fields: [], by: "deterministic", confidence: 0.3 }).includes("欄は読めず"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
