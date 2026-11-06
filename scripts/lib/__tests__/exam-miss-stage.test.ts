// 試験の外れの自動の切り分け（scripts/lib/exam-miss-stage.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-miss-stage.test.ts（全 PASS で exit 0）
// 行は 11/05〜06 の実際の答案（brain-exam-main・compose-1105 の結果）を縮めた物。手で見つけた段と同じ段を指すか
import { classifyMiss, markersOf, summarizeMisses, ownerOf, weaknessDraft, PROVISIONAL_LINKS, parseLogTags, type MissRowLite } from "../exam-miss-stage";

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

{
  const log = [
    '{"tag":"brain:rag","conversationId":"40f0db25-5fa9-4b96-bc19-3e1e5aba20c2","tpo":"x"}',
    '{"tag":"brain:answerable-direct","conversationId":"40f0db25-5fa9-4b96-bc19-3e1e5aba20c2","from":null,"to":"property_check_result","core":"rule:two_stage_promise(check)"}',
    '[YUMA3] ○ q149#1 [返信かAIXか] 本質=…',
    '[YUMA4] ○ q136#1【brain_full から違う】 [複数の依頼] 本質=…',
    '[YUMA4] ✕ q136#2 [複数の依頼] 本質=…',
  ].join("\n");
  const tags = parseLogTags(log, (id) => (id.startsWith("40f0db25") ? "YUMA4" : null));
  ok("記録の印: 同じ会話の次の結果の行に付く（rag は拾わない）", JSON.stringify(tags.get("q136#1")) === JSON.stringify(["log:answerable-direct(two_stage_promise(check)→property_check_result)"]) && !tags.has("q136#2") && !tags.has("q149#1"), JSON.stringify([...tags]));
  // q136（night-brain-on-p1 #1）: ブレインは AIX（生の答えも外れ）・2段が確認の約束にした所を answerableDirectAix が AIX に戻した
  const r: MissRowLite = { id: "q136", rep: 1, essence: { code: "AIX:property_check_result/mgmt_initial_cost", ok: false }, path: { code: "AIX:property_check_result/mgmt_parking", ok: false }, trace: { decision_source: "llm", scene_evidence: { scene: "S4_viewing" } }, logTags: [...(tags.get("q136#1") ?? [])], score: { pass: false } };
  const v = classifyMiss(r);
  ok("q136#1 → ブレイン＋決まった書き換え（answerable-direct）を全部並べる", v.stages.map((s) => s.stage).join(">") === "brain>rewrite" && v.line.includes("answerable-direct"), v.line);
}
{
  // q174（手: ブレインの読み＝customer_questions・proposals に「内覧」・2段の方向の文の決まった尾）
  const r: MissRowLite = { id: "q174", essence: { code: "AIX:viewing_invite", ok: false }, path: { code: "2段:pickup", ok: true }, draft: { code: "2段:pickup", ok: true, pass: false },
    raw: { reply_direction: "他候補を探す", customer_questions: ["一旦内覧してみたい"], proposals: ["内覧の日程"] },
    brain: { reply_direction: "他候補を探す。物件のご紹介が要る時だけ…ピックアップしお送りすると約束する返信にする", turn_contract: { route: "promise" } },
    trace: { decision_source_no_aix: "rule:two_stage_promise(pickup_unless_ack)", two_stage: "pickup" }, score: { pass: false } };
  const v = classifyMiss(r);
  ok("q174 → ブレインの読み（内覧）→ 2段 → 文の中身（方向の文の決まった尾・本質の帯）", v.stages.map((s) => s.stage).join(">") === "brain>two_stage>text>text" && v.line.includes("内覧") && v.line.includes("決まった尾"), v.line);
  ok("q174: 道は正しいが文の中身が変わった段を別に出す", v.stages.some((s) => s.marker === "text:direction_tail"));
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
