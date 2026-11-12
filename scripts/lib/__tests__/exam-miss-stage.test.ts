// 試験の外れの自動の切り分け（scripts/lib/exam-miss-stage.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-miss-stage.test.ts（全 PASS で exit 0）
// 行は 11/05〜06 の実際の答案（brain-exam-main・compose-1105 の結果）を縮めた物。手で見つけた段と同じ段を指すか
import { classifyMiss, markersOf, summarizeMisses, ownerOf, weaknessDraft, PROVISIONAL_LINKS, parseLogTags, weaknessHitsFromMisses, weaknessKeyOf, pathSlug, missStageV2On, twoStageKindOfAix, type MissRowLite } from "../exam-miss-stage";
import { aggregateWeaknessHits, mergeWeaknessRow, isWeaknessKey } from "../../../app/lib/brain-weaknesses";

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
  ok("q174（道は正解）→ 書き手（依頼／下書きの側）→ 文の中身（方向の文の決まった尾・本質の帯）・2段にしない（11/07 統括役）", v.stages.map((s) => s.stage).join(">") === "writer>text>text" && v.stage === "writer" && !v.stages.some((s) => s.stage === "two_stage") && v.line.includes("決まった尾"), v.line);
  ok("q174: 道は正しいが文の中身が変わった段を別に出す", v.stages.some((s) => s.marker === "text:direction_tail"));
}

{
  // 弱い所の台帳への自動の登録（統括役 11/06: 同じ key は evidence に足す・持ち主・試験の名前・問題・回・5行まで）
  ok("key: 大文字・括弧を台帳の形に", weaknessKeyOf("scene_net", ["scene_net:S4_viewing"]) === "exam-stage:scene_net:scene_net:s4_viewing" && weaknessKeyOf("two_stage", ["decision:two_stage_promise(check_question)"]) === "exam-stage:two_stage:decision:two_stage_promise");
  const own = (mk: string[]) => ownerOf(mk, PROVISIONAL_LINKS);
  const s55 = summarizeMisses([{ ...q055, rep: 1 }, { ...q055, rep: 3 }])!, s332 = summarizeMisses([{ ...q332, rep: 2 }])!, s136 = summarizeMisses([{ ...q136, rep: 1 }])!;
  const hits = weaknessHitsFromMisses("tm9", [s332, s55, s136], { owner: own });
  const h2 = hits.find((h) => h.key === weaknessKeyOf(s55.stage, s55.markers));
  ok("同じ key（q055・q332）は1行にまとめ、問題と回を evidence に", hits.length === 2 && !!h2 && h2.n === 3 && (h2.evidence.exam_qids ?? []).join(",") === "q055,q332" && (h2.evidence.exam_reps ?? []).includes("tm9 q055#3") && (h2.evidence.exam_reps ?? []).includes("tm9 q332#2"), JSON.stringify(hits));
  ok("持ち主と試験の名前を evidence に", !!h2 && (h2.evidence.owners ?? [])[0] === "two_stage（（仮））" && (h2.evidence.exam_labels ?? [])[0] === "tm9");
  ok("key は全部台帳で使える形", hits.every((h) => isWeaknessKey(h.key)));
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, n: 8 - i, stage: "scene_net" as const, markers: [`scene_net:S${i}`], line: "x", reps: [1] }));
  const capped = weaknessHitsFromMisses("tmx", many);
  ok("1回の試験で5行まで（外れの多い順）", capped.length === 5 && capped[0].evidence.exam_qids?.[0] === "q0" && !capped.some((h) => h.evidence.exam_qids?.includes("q7")));
  ok("段が決められない・依頼だけは入れない", weaknessHitsFromMisses("t", [{ id: "a", n: 1, stage: "none", markers: [], line: "" }, { id: "b", n: 1, stage: "asks", markers: [], line: "" }]).length === 0);
  // 既存の open の行に足す（新しい行は作らない・持ち主と回は evidence に残る）
  const agg = aggregateWeaknessHits(hits)[0];
  const old = { key: agg.key, title: "人が付けた題", area: "exam" as const, symptom: null, root_cause: "人の原因", status: "open" as const, fix_ref: null, evidence: { exam_qids: ["q999"], exam_labels: ["tm1"], owners: ["two_stage（（仮））"] }, occurrences: 4, first_seen: "2026-11-05T00:00:00Z", last_seen: "2026-11-05T00:00:00Z" };
  const m = mergeWeaknessRow(old, agg, "2026-11-06T00:00:00Z");
  ok("既存の行に足す: 題・原因・状態は残し、数と evidence を足す", m.title === "人が付けた題" && m.status === "open" && m.occurrences === 4 + (agg.n ?? 0) && (m.evidence.exam_qids ?? []).includes("q999") && (m.evidence.exam_qids ?? []).includes("q055") && (m.evidence.exam_reps ?? []).length === (agg.evidence.exam_reps ?? []).length && (m.evidence.owners ?? []).length === 1, JSON.stringify(m));
}

{
  // ブレインの段は「本質の道→正解の道」を頭に（11/06 統括役: exam-stage:brain:none は粗い）
  ok("道の英字", pathSlug("返信") === "reply" && pathSlug("2段:pickup") === "two_stage_pickup" && pathSlug("AIX:property_send（左だけ）") === "aix_property_send" && pathSlug("AIX:property_check_result/mgmt_screening") === "aix_property_check_result_mgmt_screening" && pathSlug(null) === "unknown" && pathSlug("なし") === "none");
  const a = { id: "qa", n: 1, stage: "brain" as const, markers: [], line: "x", reps: [1], essence: "AIX:property_send（左だけ）" };
  const b = { ...a, id: "qb", markers: ["decision:llm"], reps: [2] };
  const hs = weaknessHitsFromMisses("tk", [a, b], { acceptOf: () => "AIX:condition_hearing" });
  ok("条件の番で本質が物件送付の型が同じ key に", hs.length === 1 && hs[0].key === "exam-stage:brain:ess:aix_property_send-to-aix_condition_hearing" && hs[0].n === 2 && hs[0].title.includes("本質の道が AIX:property_send"), JSON.stringify(hs.map((h) => h.key)));
  ok("本質が無いブレインの段は今まで通り", weaknessKeyOf("brain", ["decision:llm"]) === "exam-stage:brain:decision:llm");
  ok("ブレイン以外の段は印の頭のまま", weaknessKeyOf("writer", ["writer"], { essence: "返信", accept: "返信" }) === "exam-stage:writer:writer");
}

// 2026-11-12 作業員10（持ち主の付け違い）: 下書きの無い回（--stage=brain）の依頼の外れはブレイン（brain:asks）・下書きのある回は今まで通り書き手（writer:asks）
{
  // q065（w7-q065-on4・ブレインの段）: 道は正解・答案（ブレインの答え）が「最短2週間」で正解の「10日程」と食い違う・下書きなし
  const q065b: MissRowLite = { id: "q065", essence: { code: "返信", ok: true }, path: { code: "返信", ok: true }, asks: [{ covered: false, route: true }], brain: { reply_direction: "最速入居時期の質問に対し、申込から最短2週間程度で入居可能と答える", turn_contract: {} }, trace: { decision_source_no_aix: "llm" }, score: { pass: false } };
  const v = classifyMiss(q065b);
  ok("下書きなし → ブレイン（brain:asks）", v.stage === "brain" && v.markers.includes("brain:asks") && !v.markers.includes("writer:asks"), v.line);
  ok("下書きなし → 持ち主はブレイン", ownerOf(v.markers)?.id === "brain", String(ownerOf(v.markers)?.id));
  // q145（ブレインの段）: 方向の文の決まった尾の印があっても頭はブレイン
  const q145b: MissRowLite = { id: "q145", essence: { code: "返信", ok: true }, path: { code: "返信", ok: true }, asks: [{ covered: false, route: true }], brain: { reply_direction: "お客様の今の発言に先に一言で応え、物件のご紹介が要る時だけピックアップしてお送りすると約束する返信にする", turn_contract: {} }, raw: { reply_direction: "入居日を答える" }, score: { pass: false } };
  ok("下書きなし＋文の尾の印 → 頭はブレイン", classifyMiss(q145b).stage === "brain", classifyMiss(q145b).line);
  // q072（w10-csp-maj6-p2・下書きの段）: 下書きがあって要点が抜けた → 今まで通り書き手の側（brain:asks にしない）
  const q072d: MissRowLite = { id: "q072", essence: { code: "返信", ok: true }, path: { code: "返信", ok: true }, draft: { code: "返信", ok: true, pass: false, asks: [false, true] }, asks: [{ covered: true, route: true }, { covered: true, route: true }], brain: { reply_direction: "埋まる可能性を答える", turn_contract: {} }, score: { pass: false } };
  const vd = classifyMiss(q072d);
  ok("下書きあり → brain:asks にしない", !vd.markers.includes("brain:asks") && vd.stage !== "brain", vd.line);
}

// 2026-11-13 作業員7b: EXAM_MISS_STAGE_V2（既定 off）。実際の答案 w16-nl-on3b・w19-replymode-p0-on（11/13 朝）を縮めた物
{
  const V2 = { EXAM_MISS_STAGE_V2: "on" };
  ok("V2 既定 off", !missStageV2On({}) && missStageV2On(V2));
  ok("AIX の系 → 2段の種類", twoStageKindOfAix("AIX:property_check_result/mgmt_move_in") === "check" && twoStageKindOfAix("AIX:viewing_invite") === "check" && twoStageKindOfAix("AIX:property_send（左だけ）") === "pickup" && twoStageKindOfAix("AIX:estimate_sheet") === "estimate" && twoStageKindOfAix("返信") === null);
  // (d) q057 w19#1: ブレインが自分で AIX【物件確認した】→ 2段 check_question が確認の約束に言い換えただけ（正解は返信）
  const q057: MissRowLite = { id: "q057", rep: 1, essence: { code: "AIX:property_check_result/mgmt_move_in", ok: false }, path: { code: "2段:check", ok: false }, trace: { decision_source_no_aix: "rule:two_stage_promise(check_question)", two_stage: "check" }, logTags: ["log:two-stage"], score: { pass: false } };
  ok("(d) 旧は 2段", classifyMiss(q057).stage === "two_stage");
  const v = classifyMiss(q057, V2);
  ok("(d) V2 はブレイン（同じ系の言い換え）", v.stage === "brain", v.line);
  // (d) q088 w16#1: 本質も最終も返信（2段は動いていない）・前の回の log:two-stage が付いていた
  const q088: MissRowLite = { id: "q088", rep: 1, essence: { code: "返信", ok: false }, path: { code: "返信", ok: false }, trace: {}, logTags: ["log:two-stage"], score: { pass: false } };
  ok("(d) 旧は決まった書き換え", classifyMiss(q088).stage === "rewrite");
  ok("(d) V2 は道が変わっていない＝ブレイン", classifyMiss(q088, V2).stage === "brain");
  // (d) 別の系への書き換え（AIX:property_send → 2段:check）は今まで通り 2段
  const cross: MissRowLite = { ...q057, essence: { code: "AIX:property_send", ok: false } };
  ok("(d) 別の系は V2 でも 2段", classifyMiss(cross, V2).stage === "two_stage");
  // (b) q057 w16: 1回は 2段の外れ、3回は道が正解（下書きあり＝書き手）。V2 の印は多数の並びの回だけ
  const wr = (rep: number): MissRowLite => ({ id: "q057", rep, essence: { code: "返信", ok: true }, path: { code: "返信", ok: true }, draft: { code: "返信", ok: true, pass: false, asks: [false] }, trace: {}, score: { pass: false } });
  const rows = [{ ...q057, essence: { code: "AIX:viewing_invite", ok: false }, trace: { decision_source_no_aix: "rule:two_stage_promise(viewing_check)", two_stage: "check" } }, wr(2), wr(3), wr(4)];
  const so = summarizeMisses(rows)!, sn = summarizeMisses(rows, V2)!;
  ok("(b) 旧は下書きの段の key の頭が別の回の 2段の印", so.stage === "final_check" && weaknessKeyOf(so.stage, so.markers) === "exam-stage:final_check:decision:two_stage_promise", String(weaknessKeyOf(so.stage, so.markers)));
  ok("(b) V2 は多数の回の印だけ", sn.stage === "final_check" && !sn.markers.some((m) => m.startsWith("decision:two_stage")), sn.markers.join(","));
  // (c) 同じ out.log の「前（main）」の回の印を今の回に付けない
  const log = ["=== テスト「brain-exam-w16」 試行錯誤", "[YUMA5] ✕ q088#1 x", "=== テスト「brain-exam-main-4419555-x」 試行錯誤", '{"tag":"brain:two-stage","conversationId":"c5"}', "[YUMA5] ✕ q088#1 y"].join("\n");
  const nm = (id: string) => (id === "c5" ? "YUMA5" : null);
  ok("(c) 旧は前の回の印が混ざる", (parseLogTags(log, nm).get("q088#1") ?? []).includes("log:two-stage"));
  ok("(c) V2 は label の回だけ", !parseLogTags(log, nm, { label: "w16", env: V2 }).has("q088#1"));
  ok("(c) V2 でも label が無ければ旧のまま", (parseLogTags(log, nm, { env: V2 }).get("q088#1") ?? []).includes("log:two-stage"));
}
console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
