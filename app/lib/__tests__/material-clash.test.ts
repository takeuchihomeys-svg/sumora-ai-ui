// npx tsx app/lib/__tests__/material-clash.test.ts
// 2026-11-15 作業員L: 材料どうしの食い違いの見張り（q091 の型を、実際の材料の文の形で）と、判断の根拠のメモの記録だけの形（BRAIN_JUDGE_BASIS=shadow）
import assert from "node:assert/strict";
import { detectMaterialClash, turnShapeOf, materialClashMode, materialClashDigest, splitBlocks, isShapeOnlyBlock } from "../material-clash";
import { judgeBasisMode, brainJudgeBasisOn, brainJudgeBasisShadow, brainJudgeBasisOutputItem, judgeBasisRecDigest, judgeBasisFromRecDigest, normalizeJudgeBasis, judgeNextOf } from "../brain-judge-basis";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
import { brainBasisOf, prodRowsOf, buildReport } from "../../../scripts/lib/judge-basis-score";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

// q091 の録音（11/14 main-ccbe4a7）の材料の文の形（会話・数は伏せて短くした）
const SYSTEM = [
  "【この番の本質】",
  "- ★こちらの約束の直後にお客様がお礼・了承（「ありがとうございます」）だけを言った番は、close_only にせず約束を果たす AIX にする。",
  "【reply_direction / key_topics】",
  "ルール⑥（感謝・了承への返し方）: 顧客の最新メッセージが感謝・了承のみ（60字未満かつ質問・要望・懸念を含まない）の場合 → reply_direction を「感謝を1行で受け取る」にする。**aix フィールドは null にする（直前と同じAIXアクションを繰り返さない）。",
  "ルール⑦（ネガ文脈）: 直前に「断り」が含まれる場合 → 受け止めのみにする。",
].join("\n");
const USER_BASE = [
  "【返信か AIX かの決め方（この順番で決める）】",
  "② 要らない → 返信。④ 要り、その情報を送る時 → AIX で送る。",
  "【まだ果たしていないこちらの約束（材料）】確認（果たすのは AIX【物件確認した】）。お客様の今の発言がお礼・了承だけ・約束の催促なら、約束を果たす AIX の番。お客様が新しい問い・ご事情を書いた番は、その問いに答える返信が先のこともある（30日: ブレインの答えが正 12・約束の AIX が正 4）。",
];
const ACK_SHAPE = [
  "【前の約束への了承（材料・turn_contract の ack_form を決める）】前のこちらの約束「確認出来次第ご連絡させて頂きます」／お客様の今の発言: 了承だけ。",
  "竹内さんの実送信（75日・了承だけの番）: 探すの約束が言い切り→待ちの形の1文 7・受けだけ 0／確認・連絡・見積・審査→受けだけ 5・待ちの形 3（割れる）。",
  "→ ack_form に \"receive_only\"（受けだけ）か \"wait_line\"（待ちの形の短い1文だけ）を入れる。",
];
const CONV_ACK = ["[スタッフ 11/14 10:00] 確認出来次第ご連絡させて頂きます😊！", "[顧客 11/14 10:02] ありがとうございます✨"];
const CONV_Q = ["[スタッフ 11/14 10:00] 確認出来次第ご連絡させて頂きます😊！", "[顧客 11/14 10:02] ペットは大丈夫ですか？"];

t("既定 off・shadow と on はどちらも記録だけ", () => {
  assert.equal(materialClashMode({}), "off");
  assert.equal(materialClashMode({ BRAIN_MATERIAL_CLASH: "shadow" }), "shadow");
  assert.equal(materialClashMode({ BRAIN_MATERIAL_CLASH: "on" }), "shadow");
});

t("番の形: お礼だけ／問い／材料の印", () => {
  assert.equal(turnShapeOf(CONV_ACK.join("\n")), "ack");
  assert.equal(turnShapeOf(CONV_Q.join("\n")), "question");
  assert.equal(turnShapeOf("【前の約束への了承】お客様の今の発言: 了承だけ。"), "ack");
});

t("q091 の型: 約束を果たす AIX（★・まだ果たしていない約束）× ルール⑥ aix は null、了承の塊は形だけで道を言わない", () => {
  const m = detectMaterialClash({ system: SYSTEM, user: [...USER_BASE, ...ACK_SHAPE, ...CONV_ACK].join("\n") });
  assert.equal(m.turn, "ack");
  const pairs = m.opposed.filter((o) => o.level === "yes").map((o) => `${o.a}×${o.b}`);
  assert.ok(pairs.includes("まだ果たしていないこちらの約束×system:ルール⑥"), pairs.join(" / "));
  assert.ok(pairs.includes("system:この番の本質×system:ルール⑥"));
  assert.equal(m.opposed.find((o) => o.a === "まだ果たしていないこちらの約束")!.dyn, true);
  assert.equal(m.opposed.find((o) => o.a === "system:この番の本質" && o.b === "system:ルール⑥")!.dyn, false);
  assert.deepEqual(m.shapeNoRoute.map((s) => s.block), ["前の約束への了承"]);
  // 手順の塊（返信か AIX かの決め方）は数えない・ルール⑦（ネガ）は道を言わない
  assert.ok(!m.stances.some((s) => s.block.startsWith("返信か AIX") || s.block === "system:ルール⑦"));
  const d = materialClashDigest(m)!;
  assert.equal(d.o, 1); assert.equal(d.os, 1); assert.equal(d.s, 1); assert.equal(d.t, "a");
});

t("問いの番: お礼の条件の文（★・ルール⑥）は当てはまらない＝食い違いなし", () => {
  const m = detectMaterialClash({ system: SYSTEM, user: [...USER_BASE, ...CONV_Q].join("\n") });
  assert.equal(m.turn, "question");
  assert.equal(m.opposed.filter((o) => o.level === "yes").length, 0);
  // 「新しい問い・ご事情を書いた番は…返信が先」は問いの番にだけ当てはまる
  assert.ok(m.stances.some((s) => s.block === "まだ果たしていないこちらの約束" && s.stance === "reply" && s.level === "yes"));
});

t("ACK_CONFIRM_AIX_PATH の1行（道は約束を果たす AIX のまま）が入った了承の塊は形だけと数えない", () => {
  const withPath = [...ACK_SHAPE, "道は約束を果たす AIX のまま・結果がまだ無いのは返信にする理由にならない・ack_form は形として入れる。"];
  const b = splitBlocks(withPath.join("\n"), "user")[0];
  assert.equal(isShapeOnlyBlock(b), false);
  assert.equal(isShapeOnlyBlock(splitBlocks(ACK_SHAPE.join("\n"), "user")[0]), true);
});

t("約束が無い会話では「約束の直後」の★は当てはまらない", () => {
  const m = detectMaterialClash({ system: SYSTEM, user: CONV_ACK.join("\n") });
  assert.ok(!m.stances.some((s) => s.block === "system:この番の本質"));
  assert.ok(m.stances.some((s) => s.block === "system:ルール⑥" && s.stance === "reply"));
});

t("会話の行は材料の塊に入れない（お客様の言葉の「返信」で数えない）", () => {
  const m = detectMaterialClash({ system: "", user: "[顧客 11/14 10:02] 返信で答えてください。AIX なしでいいです\n" });
  assert.equal(m.stances.length, 0);
});

t("digest.mcl は記録の形（無い時は欄なし）", () => {
  assert.equal(brainDecisionDigestExtra({}, {} as Record<string, string>).hasOwnProperty("mcl"), false);
  const m = detectMaterialClash({ system: SYSTEM, user: [...USER_BASE, ...ACK_SHAPE, ...CONV_ACK].join("\n") });
  const out = brainDecisionDigestExtra({ material_clash: m }, { BRAIN_DIGEST_VER: "off" }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out.mcl as object).sort(), ["o", "os", "p", "s", "t", "w"]);
});

// ── 判断の根拠のメモ（BRAIN_JUDGE_BASIS）の3つの形
const RAW = { clues: ["了承だけ"], depth: "shallow", readings: [{ reading: "結果を待っている", focus: "promise_keep" }, { reading: "もう一度聞きたい", focus: "answer" }], chosen: 0, priority: ["keep_result"], focus: "promise_keep", order: ["read_ask", "route"], purpose: "keep_result", missing: [], key_point: "確認の結果", next_dest: "viewing" };

t("BRAIN_JUDGE_BASIS: off／on／shadow（既定 off・shadow は書かせるが読む側に渡さない）", () => {
  assert.equal(judgeBasisMode({}), "off");
  assert.equal(judgeBasisMode({ BRAIN_JUDGE_BASIS: "shadow" }), "shadow");
  assert.equal(brainJudgeBasisOn({ BRAIN_JUDGE_BASIS: "shadow" }), false);
  assert.equal(brainJudgeBasisShadow({ BRAIN_JUDGE_BASIS: "shadow" }), true);
  assert.equal(brainJudgeBasisOutputItem({}), "");
  // shadow の出力の指定は on と1文字も違わない（記録のために書かせる物は同じ）
  assert.equal(brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS: "shadow" }), brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS: "on" }));
  // shadow は次の行き先（文の統括へ渡す judge_next）を作らない
  assert.equal(judgeNextOf(RAW, { BRAIN_JUDGE_BASIS: "shadow", BRAIN_JUDGE_BASIS_NEXT: "on" }), undefined);
  assert.ok(judgeNextOf(RAW, { BRAIN_JUDGE_BASIS: "on", BRAIN_JUDGE_BASIS_NEXT: "on" }));
});

t("digest.jbr は戻すと同じ段で数えられる（判断の根拠の物差しが本番の記録で読める）", () => {
  const jb = normalizeJudgeBasis(RAW)!;
  const d = judgeBasisRecDigest(jb)!;
  assert.deepEqual(d, { d: "shallow", f: "promise_keep", p: ["keep_result"], o: ["read_ask", "route"], r: ["promise_keep", "answer"], c: 0, u: "keep_result", m: [] });
  const back = normalizeJudgeBasis(judgeBasisFromRecDigest(d))!;
  assert.equal(back.focus, "promise_keep"); assert.equal(back.depth, "shallow"); assert.equal(back.chosen, 0); assert.deepEqual(back.order, ["read_ask", "route"]);
  const out = brainDecisionDigestExtra({ judge_basis_rec: jb }, { BRAIN_DIGEST_VER: "off" }) as Record<string, unknown>;
  assert.deepEqual(out.jbr, d);
  assert.equal(brainBasisOf({ id: "x", brain: { judge_basis_rec: RAW } }).focus, "promise_keep");
  assert.equal(brainBasisOf({ id: "x", brain: { jbr: d } }).focus, "promise_keep");
});

t("本番の記録の行 → 段ごとの外れ（押した AIX の重点が正解・押さなかった番は道だけ・保留は外す）", () => {
  const jbKeep = judgeBasisRecDigest(normalizeJudgeBasis(RAW));
  const jbAns = judgeBasisRecDigest(normalizeJudgeBasis({ ...RAW, focus: "answer", readings: [{ reading: "答えが欲しい", focus: "answer" }], chosen: 0 }));
  const r = prodRowsOf([
    { id: "d1", scene: "S1", jbr: jbKeep, pressAix: "property_check_result", matched: true, pending: false },
    { id: "d2", scene: "S1", jbr: jbAns, pressAix: "property_check_result", matched: false, pending: false },
    { id: "d3", scene: "S2", jbr: jbAns, pressAix: null, matched: true, pending: false },
    { id: "d4", scene: "S2", jbr: jbAns, pressAix: null, matched: null, pending: true },
  ]);
  assert.equal(r.pending, 1);
  const rep = buildReport(r.specs, r.rows);
  assert.equal(rep.total.n, 3);
  assert.equal(rep.total.pathN, 3); assert.equal(rep.total.pathOk, 2);
  // d2: 押した AIX（物件確認した＝約束を果たす）なのに読みの候補に約束を果たすが無い＝読みで外れ
  assert.equal(rep.verdicts.find((v) => v.id === "d2")!.missStage, "read");
  assert.equal(rep.verdicts.find((v) => v.id === "d1")!.missStage, null);
});

console.log(`${n} tests ok`);
