// 実行: npx tsx app/lib/__tests__/image-seq-flow.test.ts
// 連続画像の場面・流れを集計（summarizeImageSequenceFlows）と LLM screen 優先の試験
import {
  parseShotLearn,
  cleanScene,
  sanitizeStuck,
  summarizeImageSequenceFlows,
  learnFromShots,
  SHOT_LEARN_PROMPT,
} from "../shot-learn";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

console.log("■ ① parseShotLearn が場面・流れを読む");
{
  const j = parseShotLearn(
    '{"screen":"modal","confidence":0.9,"scene":"area","flow_step":"所在地小窓で区を選択中","transition":"入力→小窓が開いた","stuck":null,"fields":[]}',
  );
  t("scene を読む", j.scene === "area", j);
  t("flow_step を読む", j.flow_step === "所在地小窓で区を選択中", j);
  t("transition を読む", j.transition === "入力→小窓が開いた", j);
  t("stuck null", j.stuck == null, j);
  const badScene = parseShotLearn('{"screen":"form","fields":[],"scene":"???","flow_step":"' + "あ".repeat(50) + '"}');
  t("変な scene は other", badScene.scene === "other", badScene);
  t("flow_step は40字", (badScene.flow_step?.length ?? 0) <= 40, badScene.flow_step);
  t("壊れた JSON でも落ちない", parseShotLearn("{{").screen === "other");
}

console.log("\n■ ② cleanScene / sanitizeStuck");
{
  t("area を通す", cleanScene("area") === "area");
  t("空は未設定", cleanScene("") === undefined);
  t("住所っぽい stuck は落とす", sanitizeStuck("大阪市北区で止まった") === null);
  t("短い stuck は通す", sanitizeStuck("ボタンがグレー") === "ボタンがグレー");
}

console.log("\n■ ③ SHOT_LEARN_PROMPT に流れの指示がある（既存の決まりは残す）");
{
  t("入力中身禁止", /入力された中身.*絶対に書かない/.test(SHOT_LEARN_PROMPT));
  t("scene 指示", /"scene"/.test(SHOT_LEARN_PROMPT) && /flow_step/.test(SHOT_LEARN_PROMPT));
}

console.log("\n■ ④ summarizeImageSequenceFlows");
{
  const base = "2026-11-18/realpro/run_abc12_n1/";
  const rows = [
    {
      created_at: "2026-11-18T10:00:00Z",
      mode: "normal",
      shot_key: base + "01.jpg",
      shot_learn: { screen: "form", scene: "cond", flow_step: "賃料を選ぶ" },
    },
    {
      created_at: "2026-11-18T10:00:10Z",
      mode: "normal",
      shot_key: base + "02.jpg",
      shot_learn: { screen: "modal", scene: "area", transition: "小窓が開いた" },
    },
    {
      created_at: "2026-11-18T10:00:20Z",
      mode: "normal",
      shot_key: base + "03.jpg",
      shot_learn: { screen: "modal", scene: "area", stuck: "確定がグレー" },
    },
    {
      created_at: "2026-11-18T10:00:30Z",
      mode: "normal",
      shot_key: base + "04.jpg",
      shot_learn: { screen: "result", scene: "list" },
    },
    {
      created_at: "2026-11-18T11:00:00Z",
      mode: "normal",
      shot_key: "2026-11-18/realpro/run_xyz99_n1/01.jpg",
      shot_learn: null,
    },
  ];
  const s = summarizeImageSequenceFlows(rows);
  t("run は2件", s.total_runs === 2, s);
  t("場面付き学習が数える", s.learned_with_scene >= 3, s.learned_with_scene);
  t("連続学習 run がある", s.seq_learned_runs >= 1, s);
  t("画面枚数", s.screens.form === 1 && s.screens.modal === 2 && s.screens.result === 1, s.screens);
  t("遷移 area→list が含まれる", s.transitions.some((x) => x.from === "cond" && x.to === "area" && x.n >= 1), s.transitions);
  t("詰まりがある", s.stuck_points.some((x) => x.why === "確定がグレー"), s.stuck_points);
  t("流れの鎖", s.scene_chain.some((c) => /cond.*area.*list/.test(c)), s.scene_chain);
  t("1行要約", typeof s.line === "string" && s.line.includes("run"));
  t("未学習 run が出る", s.unlearned_runs.some((u) => u.run_id === "xyz99_n1" && u.pct === 0), s.unlearned_runs);
  const blob = JSON.stringify(s);
  t("お客様名・住所らしき並びを残さない", !/大阪市北区|120000/.test(blob));
}

console.log("\n■ ⑤ learnFromShots は LLM の screen を優先");
{
  const row = {
    shot_ops: [{ f: "rental_cost1" }],
    shot_learn: { screen: "result", fields: [{ name: "一覧の行", kind: "link" }] },
  };
  const r = learnFromShots([row, row] as never);
  t("result に入る（form に潰さない）", !!r.screens.result && r.screens.result.n === 2, r.screens);
  t("form に入らない", !r.screens.form?.n, r.screens);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);