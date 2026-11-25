// app/lib/__tests__/human-like-audit.test.ts
//
// 2026-11-15 竹内さん「自動で直接入力されている部分ないかちゃんと人間のように
//   入力やクリックカーソルの移動おこなっているか その部分も強化するようにする
//   弱い部分は補強していく土台をつくって」
//
// なぜ要るか（**私が誤判定した**）:
//   写真1枚ごとの shot_ops を見て「押さずに値だけ変わった欄が67回」と報告したが、
//   実際は click と change が**別の写真に分かれていた**だけだった。
//   → 写真をまたいで1本にまとめてから判定しないと正しく見えない。
//
// 実行: npx tsx app/lib/__tests__/human-like-audit.test.ts
import {
  mergeOpsAcrossShots,
  isChooseField,
  auditHumanLike,
  findHumanLikeGaps,
  isDiagOnlyRow,
  judgeHumanLikePass,
  HUMAN_LIKE_PASS,
} from "../human-like-audit";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 選ぶ欄かどうか");
{
  ok("select は選ぶ欄", isChooseField("transportation_id", "select"));
  ok("checkbox は選ぶ欄", isChooseField("include_common_fee", "checkbox"));
  ok("rental_cost2 は選ぶ欄", isChooseField("rental_cost2"));
  ok("room_layout_id[] は選ぶ欄", isChooseField("room_layout_id[]"));
  ok("required_time は違う（文字を打つ欄）", !isChooseField("required_time", "text"));
  ok("空でも落ちない", !isChooseField(null));
}

console.log("\n■ ② 写真をまたいで1本にまとめる（★ここが核心）");
{
  // 実測の形: click と change が**別の写真**に分かれている
  const rows = [
    { shot_ops: [{ t: 1000, k: "click", f: "rental_cost2", w: "select" }] },
    { shot_ops: [{ t: 2000, k: "click", f: "rental_cost2", w: "select" }, { t: 2100, k: "change", f: "rental_cost2", w: "select" }] },
  ];
  const merged = mergeOpsAcrossShots(rows);
  /**
   * ⚠ 実測の形: 1枚目に click(1000)、2枚目に click(2000)+change(2100)。
   *   重複除去は「同じ f・k・t」だけなので、**click 1000 と click 2000 は別物**として残る。
   *   → 3件（click 1000・click 2000・change 2100）が正しい。
   */
  ok("重複を除いて1本にする（同じ f・k・t だけ除く）", merged.length === 3, merged.length);
  ok("時刻順に並ぶ", merged[0].t === 1000 && merged[2].t === 2100, merged.map((o) => o.t));
  ok("click が残る", merged.some((o) => o.k === "click"));
  ok("change が残る", merged.some((o) => o.k === "change"));
  ok("空でも落ちない", mergeOpsAcrossShots([]).length === 0);
  ok("null でも落ちない", mergeOpsAcrossShots(null as never).length === 0);
}

console.log("\n■ ③ 押してから変えた（正しい形）／押さずに変わった（疑い）");
{
  // 正しい: 同じ写真で click → change
  const good = auditHumanLike([{ shot_ops: [
    { t: 1000, k: "click", f: "rental_cost2", w: "select" },
    { t: 1200, k: "change", f: "rental_cost2", w: "select" },
  ] }]);
  ok("押してから変えたに入る", good.clickedThenChanged.includes("rental_cost2"), good);
  ok("押さずに変わったは0", good.changedWithoutClick.length === 0);

  // 別の写真に分かれていても正しく判定する（★誤判定の再発防止）
  const split = auditHumanLike([
    { shot_ops: [{ t: 1000, k: "click", f: "transportation_id", w: "select" }] },
    { shot_ops: [{ t: 1100, k: "change", f: "transportation_id", w: "select" }] },
  ]);
  ok("写真が別でも「押してから変えた」と判定", split.clickedThenChanged.includes("transportation_id"), split);
  ok("⚠ 誤って「押さずに変わった」と言わない", !split.changedWithoutClick.includes("transportation_id"));

  // 本当に押していない（疑い）
  const bad = auditHumanLike([{ shot_ops: [
    { t: 1000, k: "change", f: "room_layout_id[]", w: "checkbox" },
  ] }]);
  ok("押さずに変わったに入る", bad.changedWithoutClick.includes("room_layout_id[]"), bad);
}

console.log("\n■ ④ 直接打ち込み（選ぶ欄に打ち込んでいないか）");
{
  const typedText = auditHumanLike([{ shot_ops: [
    { t: 1000, k: "key", f: "required_time", w: "text" },
    { t: 2000, k: "key", f: "required_time", w: "text" },
  ] }]);
  ok("文字の欄への打ち込みは疑いに入れない", typedText.typedOnChoose.length === 0, typedText.typedOnChoose);
  ok("打ち込みの数は数える", typedText.typed === 2);

  const typedSelect = auditHumanLike([{ shot_ops: [
    { t: 1000, k: "key", f: "rental_cost2", w: "select" },
  ] }]);
  ok("⚠ 選ぶ欄への打ち込みは疑いに入れる", typedSelect.typedOnChoose.includes("rental_cost2"), typedSelect.typedOnChoose);
  ok("1行で分かる", typedSelect.line.includes("選ぶ欄に打ち込んだ疑い"), typedSelect.line);
}

console.log("\n■ ⑤ カーソルと押した位置");
{
  const r = auditHumanLike([
    { moves_n: 20, point_fields: { rental_cost2: { n: 3 } } },
    { moves_n: 0, point_fields: null },
    { moves_n: 15, point_fields: {} },
    // ★ 2026-11-17: diag だけの健康診断写真は分母に入れない
    { moves_n: 1, point_fields: null, shot_ops: [{ t: 1, k: "diag", f: "" }] },
  ]);
  ok("diag だけは分母外", isDiagOnlyRow({ shot_ops: [{ k: "diag" }] }));
  ok("カーソルの枚数を数える", r.withCursor === 2, r.withCursor);
  ok("押した位置の枚数を数える", r.withPoint === 1, r.withPoint);
  ok("記録の枚数（diag除外）", r.rows === 3, r.rows);
  const gaps = findHumanLikeGaps(r);
  /**
   * ⚠ カーソルは 2/3（67%）= 半分以上なので**指摘しない**（悪くない時に言わない）。
   *   指摘が出るのは押した位置 1/3（33%）だけ。
   */
  ok("カーソルが半分以上なら指摘しない", !gaps.some((g) => g.what.includes("カーソル")), gaps);
  ok("押した位置が半分未満なら補強する所に出す", gaps.some((g) => g.what.includes("押した位置")), gaps);
}

console.log("\n■ ⑥ 良い状態なら補強する所を出さない");
{
  const r = auditHumanLike([{ moves_n: 20, point_fields: { a: { n: 2 } }, shot_ops: [
    { t: 1000, k: "click", f: "rental_cost2", w: "select" },
    { t: 1200, k: "change", f: "rental_cost2", w: "select" },
    { t: 2000, k: "key", f: "required_time", w: "text" },
  ] }]);
  ok("補強する所は0", findHumanLikeGaps(r).length === 0, findHumanLikeGaps(r));
}

console.log("\n■ ⑦ 手の形（cs=pointer）を通常から学べる");
{
  const r = auditHumanLike([{ shot_ops: [
    { t: 1000, k: "click", f: "印刷用PDF", w: "button", cs: "pointer", by: "human" },
    { t: 2000, k: "click", f: "rental_cost2", w: "select", cs: "default", by: "human" },
  ] }]);
  ok("手の形クリックを数える", r.handCursorClicks === 1, r.handCursorClicks);
  ok("手が付いた欄名を残す", r.handCursorFields.includes("印刷用PDF"), r.handCursorFields);
}

console.log("\n■ ⑧ 壊れた入力でも落ちない");
{
  ok("空配列", auditHumanLike([]).ops === 0);
  ok("null でも落ちない", auditHumanLike(null as never).ops === 0);
  ok("null が混ざっても落ちない", auditHumanLike([null as never, { shot_ops: null }]).ops === 0);
  ok("名前が無い操作は飛ばす", mergeOpsAcrossShots([{ shot_ops: [{ k: "click" }] }]).length === 0);
}

console.log("\n■ ⑨ 人間らしさ合格線（judgeHumanLikePass・機械 vs 人）");
{
  ok("合格線定数", HUMAN_LIKE_PASS.cursorMinPct === 50 && HUMAN_LIKE_PASS.pointMinPct === 50 && HUMAN_LIKE_PASS.typedOnChooseMax === 0);

  // 人っぽい: click→change・カーソル・位置あり・選ぶ欄に打ち込まない
  const humanish = auditHumanLike([
    {
      moves_n: 12,
      point_fields: { rental_cost2: { x: 0.4, y: 0.5, n: 3 } },
      shot_ops: [
        { t: 1000, k: "click", f: "rental_cost2", w: "select", cs: "pointer", by: "auto" },
        { t: 1500, k: "change", f: "rental_cost2", w: "select", by: "auto" },
        { t: 2500, k: "key", f: "required_time", w: "text", by: "auto" },
      ],
    },
    {
      moves_n: 8,
      point_fields: { a: { n: 1 } },
      shot_ops: [{ t: 3000, k: "click", f: "検索", w: "button", cs: "pointer", by: "auto" }],
    },
  ]);
  const hp = judgeHumanLikePass(humanish);
  ok("人っぽい操作は合格", hp.ok, hp.line);

  // 機械っぽい: 選ぶ欄に key・押さず change・カーソル無し・位置無し
  const machine = auditHumanLike([
    {
      moves_n: 0,
      point_fields: null,
      shot_ops: [
        { t: 1000, k: "key", f: "rental_cost2", w: "select" },
        { t: 1100, k: "change", f: "room_layout_id[]", w: "checkbox" },
      ],
    },
  ]);
  const mp = judgeHumanLikePass(machine);
  ok("機械っぽい操作は不合格", !mp.ok, mp.line);
  ok("機械は直書き・打ち込み・カーソルを名指し", mp.gaps.length >= 2, mp.gaps);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
