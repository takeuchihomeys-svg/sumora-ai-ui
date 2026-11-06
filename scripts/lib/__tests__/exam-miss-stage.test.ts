// 試験の外れの自動の切り分け（scripts/lib/exam-miss-stage.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-miss-stage.test.ts（全 PASS で exit 0）
// 行は 11/05〜06 の実際の答案（brain-exam-main・compose-1105 の結果）を縮めた物。手で見つけた段と同じ段を指すか
import { classifyMiss, markersOf, summarizeMisses, ownerOf, weaknessDraft, PROVISIONAL_LINKS, type MissRowLite } from "../exam-miss-stage";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// q055・q332（手で見つけた: two-stage の check_question が AIX を確認の約束に書き換えた）
const q055: MissRowLite = { id: "q055", essence: { code: "AIX:property_check_result/availability", ok: false }, path: { code: "2段:check", ok: false }, trace: { decision_source_no_aix: "rule:two_stage_promise(check_question)", two_stage: "check" }, score: { pass: false } };
const q332: MissRowLite = { id: "q332", essence: { code: "AIX:property_check_result/mgmt_screening", ok: false }, path: { code: "2段:check", ok: false }, trace: { decision_source_no_aix: "rule:two_stage_promise(check_question)", two_stage: "check" }, score: { pass: false } };
// q174（手で見つけた: 内覧の guard が「探す約束」の番を返信に書き換え・下書きは 2段:pickup）
const q174: MissRowLite = { id: "q174", essence: { code: "AIX:viewing_invite", ok: false }, path: { code: "返信", ok: false }, draft: { code: "2段:pickup", ok: true }, trace: { decision_source_no_aix: "guard:viewing(search_promise)+not_pickup_turn" }, score: { pass: false } };
// q136（手で見つけた: 夜の管理会社の確認＝ブレインの2層目の判断が確認の約束を AIX に戻した・決まった書き換えではない）
const q136: MissRowLite = { id: "q136", essence: { code: "2段:check", ok: true }, path: { code: "AIX:property_check_result/mgmt_initial_cost", ok: false }, draft: { code: "AIX:property_check_result/mgmt_initial_cost", ok: false, pass: false }, trace: { decision_source: "llm", scene_evidence: { scene: "S4_viewing" } }, score: { pass: false } };

ok("印: 2段と決まった書き換え", markersOf(q055).join("|") === "decision:two_stage_promise(check_question)|two_stage:check");
ok("印: 場面", markersOf(q136).includes("scene_net:S4_viewing"));
{
  const v = classifyMiss(q055);
  ok("q055 → 2段（check_question）", v.stage === "two_stage" && v.line.includes("check_question"), v.line);
  ok("q332 → 2段（check_question）", classifyMiss(q332).stage === "two_stage");
}
{
  const v = classifyMiss(q174);
  ok("q174 → 決まった書き換え（guard）", v.stage === "rewrite" && v.line.includes("guard:viewing"), v.line);
}
{
  const v = classifyMiss(q136);
  ok("q136 → ブレインの2層目（決まった書き換えではない）・原因は場面・決まりの読み違い", v.stage === "brain" && v.cause === "場面・決まりの読み違い" && v.line.includes("2層目"), v.line);
}
{
  const w: MissRowLite = { id: "qx", essence: { code: "返信", ok: true }, path: { code: "返信", ok: true }, draft: { code: "AIX:estimate_sheet", ok: false, pass: false }, score: { pass: false } };
  ok("書き手で道が変わった", classifyMiss(w).stage === "writer");
  const f: MissRowLite = { id: "qy", essence: { code: "返信", ok: true }, path: { code: "返信", ok: true }, draft: { code: "返信", ok: true, pass: false }, score: { pass: false } };
  ok("道は同じで下書きの要点が抜けた → 最終チェックか書き手", classifyMiss(f).stage === "final_check");
  const a: MissRowLite = { id: "qz", essence: { code: "AIX:estimate_sheet", ok: true }, path: { code: "返信", ok: false }, trace: { decision_source_no_aix: "rule:answerable_direct_aix" }, score: { pass: false } };
  const va = classifyMiss(a);
  ok("生の答えが正解で AIX → 返信に書き換え → 原因は AIX の番を返信にした", va.stage === "rewrite" && va.cause === "AIX の番を返信にした", va.line);
}
{
  const s = summarizeMisses([q055, { ...q055 }, { ...q055, score: { pass: true } }]);
  ok("まとめ: 外れの回だけ・一番多い段", s?.n === 2 && s.stage === "two_stage" && /外れ 2\/2回/.test(s.line), s?.line);
  const o = ownerOf(s!.markers);
  ok("持ち主: 連携の表（作業員5）で引ける", o?.id === "two_stage", JSON.stringify(o));
  ok("持ち主: 仮の表でも引ける", ownerOf(s!.markers, PROVISIONAL_LINKS)?.id === "two_stage");
  const w = weaknessDraft(s!, o);
  ok("弱い所の案: 段＋印の頭で key", w.key === "exam-stage:two_stage:decision:two_stage_promise" && w.area === "exam" && w.root_cause.includes("two_stage"), JSON.stringify(w));
  ok("持ち主が仮の表に無い", ownerOf(["zzz:1"], PROVISIONAL_LINKS) === null);
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
