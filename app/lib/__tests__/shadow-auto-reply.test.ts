// app/lib/__tests__/shadow-auto-reply.test.ts — 影の自動返信（#812・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/shadow-auto-reply.test.ts
import { gateHoles, proposedGateStops, sceneReadiness, wilsonLower, shadowRecordOf, shadowLines, type ShadowTurn } from "../shadow-auto-reply";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = (o: Partial<ShadowTurn>): ShadowTurn => ({ scene: "返信:条件提示", wouldSend: true, verdict: "same", draft: "かしこまりました！！", staffText: "かしこまりました！！", staffPressedAix: false, danger: [], finalCheckOk: null, ...o });

const holes = gateHoles([T({}), T({ staffPressedAix: true }), T({ danger: ["物件", "約束"], verdict: "partial" }), T({ scene: "対象外:申込以降" }), T({ wouldSend: false, staffPressedAix: true })]);
t("穴: 通る番だけ・AIX の番・危ない直し（AIX の番は除く）・申込以降の場面・最終チェック不明", holes.passed === 4 && holes.staffAix === 1 && holes.danger === 1 && holes.dangerKinds["物件"] === 1 && holes.postApplyScene === 1 && holes.finalCheckUnknown === 4);
t("塞ぐ案: どれも既定 off（何も止めない）", proposedGateStops({ scene: "対象外:申込以降", allowScenes: new Set() }, {}).length === 0);
t("塞ぐ案: on なら 場面の許し・申込以降の場面・最終チェックの証拠なし で止める", proposedGateStops({ scene: "対象外:申込以降", allowScenes: new Set(["返信:短い了承・お礼"]) }, { AUTO_GATE_SCENE_ALLOW: "on", AUTO_GATE_POSTAPPLY_SCENE: "on", AUTO_GATE_REQUIRE_FC_STATE: "on" }).join() === "scene_not_allowed,post_apply_scene,final_check_unknown");
t("塞ぐ案: 許しの一覧の場面・証拠あり なら止めない", proposedGateStops({ scene: "返信:短い了承・お礼", finalCheckState: "ok", allowScenes: new Set(["返信:短い了承・お礼"]) }, { AUTO_GATE_SCENE_ALLOW: "on", AUTO_GATE_REQUIRE_FC_STATE: "on" }).length === 0);

t("Wilson の下限: 20/20 でも 95% に届かない・0 番は null", (wilsonLower(20, 20) ?? 1) < 0.95 && (wilsonLower(80, 80) ?? 0) >= 0.95 && wilsonLower(0, 0) === null);
const many = Array.from({ length: 80 }, () => T({ scene: "返信:短い了承・お礼" }));
const rs = sceneReadiness([...many, T({ scene: "返信:質問", verdict: "different" }), T({ scene: "返信:質問", staffPressedAix: true })]);
t("候補: 判定 80・全部同じ・AIX 0・危ない 0 の場面だけ", rs.find((r) => r.scene === "返信:短い了承・お礼")?.ready === true && rs.find((r) => r.scene === "返信:質問")?.ready === false && /判定 2/.test(rs.find((r) => r.scene === "返信:質問")!.why));
t("候補: AIX の番が1つでもあれば候補にしない", sceneReadiness([...many, T({ scene: "返信:短い了承・お礼", staffPressedAix: true })]).find((r) => r.scene === "返信:短い了承・お礼")?.ready === false);
const rec = shadowRecordOf(T({ verdict: "partial", danger: ["日時"] }));
t("影の記録: 送ったつもりの文・スタッフの文・同じか・危ない間違い", rec?.would_text === "かしこまりました！！" && rec.same === false && rec.danger.join() === "日時" && shadowRecordOf(T({ wouldSend: false })) === null);
t("行: 穴と候補", shadowLines(holes, rs)[1].startsWith("- 穴: スタッフが AIX を押した 1（25%）") && /候補の場面.*返信:短い了承・お礼/.test(shadowLines(holes, rs)[2]));
console.log(`shadow-auto-reply: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
