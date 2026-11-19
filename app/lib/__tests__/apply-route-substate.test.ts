// app/lib/__tests__/apply-route-substate.test.ts — 地図の2段目（細かい状態）・この番の目的と仕込み（turn_aims）・受け渡し
//   実行: npx tsx app/lib/__tests__/apply-route-substate.test.ts
import { readFileSync } from "node:fs";
import { SUBSTATES, substatesFor, buildSubstateBrainText, substateBrainTextIfEnabled, applyRouteSubstateOn, SUBSTATE_SKIP_MOVE_IN_RE } from "../apply-route-substate";
import { PLANT_NOT_PROMISE_RE, turnAimsOn, normalizeTurnAims, BRAIN_TURN_AIMS_RULES, BRAIN_TURN_AIMS_FIELD, turnAimsDigest } from "../brain-turn-aims";
import { buildHandoff, handoffNote } from "../conductor-handoff";
import { ROUTE_NODES, ROUTE_BRANCHES } from "../apply-route-map";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.error(`NG ${name}`); } };

// 表
t("状態の置き場は今の地図の駅か分かれ道", SUBSTATES.every((s) => s.at in ROUTE_NODES || s.at in ROUTE_BRANCHES));
t("深さの数は通数と合う", SUBSTATES.every((s) => s.depthCount[0] + s.depthCount[1] + s.depthCount[2] === s.n));
t("例が少ない印（n<4）", SUBSTATES.every((s) => (s.n < 4) === !!s.few));
t("id は重ならない", new Set(SUBSTATES.map((s) => s.id)).size === SUBSTATES.length);
// 候補
t("内覧調整の駅は日時・内見できない・内覧なしの3つ", substatesFor({ node: "viewing_arrange", branch: null }).map((s) => s.id).join(",") === "viewing_dates,viewing_cannot,viewing_no_view_doubt");
t("分かれ道（検討）も拾う", substatesFor({ node: "proposing", branch: "considering" }).some((s) => s.id === "proposing_considering"));
t("位置が無ければ空", substatesFor(null).length === 0 && buildSubstateBrainText({ node: null, branch: null }) === "");
const txt = buildSubstateBrainText({ node: "viewing_arrange", branch: null });
t("材料の文: 目的・中期・先読み・仕込み・道は決めない", ["目的=", "中期=", "先読み=", "仕込み=", "道（返信か AIX か）はこの表で決めない"].every((w) => txt.includes(w)) && txt.length <= 900);
// 既定 off
t("既定 off は1字も足さない", !applyRouteSubstateOn({}) && substateBrainTextIfEnabled({ node: "viewing_arrange", branch: null }, {}) === "");
t("on で足す", substateBrainTextIfEnabled({ node: "viewing_arrange", branch: null }, { APPLY_ROUTE_SUBSTATE: "on" }) === txt);
// turn_aims
t("turn_aims 既定 off", !turnAimsOn({}) && turnAimsOn({ BRAIN_TURN_AIMS: "on" }));
t("決まりは判断の後・道を変えない", BRAIN_TURN_AIMS_RULES.includes("判断を変えない") && BRAIN_TURN_AIMS_RULES.includes("書き終えた後"));
t("欄の形", BRAIN_TURN_AIMS_FIELD.startsWith('"turn_aims": {'));
const ta = normalizeTurnAims({ state: "内覧の日時の希望・都合", depth: "2", depth_why: "日時が決まれば次は申込", turn_aim: "日時を決める", mid_aim: "待ち合わせ→申込", plant: "1部屋のみ" });
t("normalize", !!ta && ta.depth === 2 && ta.plant === "1部屋のみ" && turnAimsDigest(ta) === "d2|仕内覧の日時の希望・都");
t("空なら null", normalizeTurnAims({ state: "", turn_aim: "null", mid_aim: "", plant: "none" }) === null && normalizeTurnAims("x") === null);
t("深さが範囲外は null", normalizeTurnAims({ turn_aim: "a", depth: 5 })?.depth === null);
// 受け渡し
const h = handoffNote(buildHandoff({ to: "compose", meta: { action: "reply", turn_aims: ta } }));
t("受け渡しに目的・狙い・仕込み", h.includes("この番の目的: 日時を決める") && h.includes("次の2〜3番の狙い: 待ち合わせ→申込") && h.includes("入れる仕込み: 1部屋のみ"));
t("turn_aims が無ければ今まで通り", !handoffNote(buildHandoff({ to: "compose", meta: { action: "reply" } })).includes("この番の目的"));
// 配線
const core = readFileSync("app/lib/brain-core.ts", "utf8");
t("今回の発言の層（fresh）でも turn_aims を書く（11/12: q425・q426 で欄が出なかった原因）", core.includes("このモードでも出力の最後に turn_aims"));
t("brain-core に配線（材料・出力の欄・決まり・meta）", core.includes("ar.text + substateBrainTextIfEnabled(ar.loc, undefined, { procedureTurn: isProcedureReplyQuestion(detectProcedureQuestion(unrepliedTurn.text ?? \"\")) || SUBSTATE_SKIP_MOVE_IN_RE.test(") && core.includes('BRAIN_TURN_AIMS_ON ? ", " + BRAIN_TURN_AIMS_FIELD') && core.includes("BRAIN_TURN_AIMS_ON ? BRAIN_TURN_AIMS_RULES") && core.includes("turn_aims: BRAIN_TURN_AIMS_ON ? (normalizeTurnAims("));

// 11/12 統括役の決め ①②（q065: on 0/4・off 4/4）
t("① 手続きの問いの番は状態の候補を出さない", substateBrainTextIfEnabled({ node: "pickup", branch: null }, { APPLY_ROUTE_SUBSTATE: "on" }, { procedureTurn: true }) === "");
t("① q065 の文（最速で入居）は網に当たる・q057 の文は当たらない", SUBSTATE_SKIP_MOVE_IN_RE.test("ありがとうございます\n最速で入居できるとしていつくらいになりそうですか？") && SUBSTATE_SKIP_MOVE_IN_RE.test("最短でも入居可能日は11月中旬でしょうか？") && !SUBSTATE_SKIP_MOVE_IN_RE.test("内見はできない感じってことですかね？"));
t("② 仕込みに確認・約束を入れない（q065 の実物）", normalizeTurnAims({ turn_aim: "a", plant: "最速入居日は管理会社に確認してすぐ連絡する" })?.plant === "" && PLANT_NOT_PROMISE_RE.test("入居時期は確認させて頂きご連絡"));
t("② 事実・線の仕込みは残す", normalizeTurnAims({ turn_aim: "a", plant: "1部屋のみの募集" })?.plant === "1部屋のみの募集" && normalizeTurnAims({ turn_aim: "a", plant: "即入居可のお部屋を優先" })?.plant === "即入居可のお部屋を優先");
t("② 決まりの文に確認・約束は書かない", BRAIN_TURN_AIMS_RULES.includes("確認・約束（管理会社に確認・確認してご連絡 等）は書かない"));
console.log(`apply-route-substate: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
