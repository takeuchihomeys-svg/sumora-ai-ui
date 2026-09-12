// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」統合設計 段2:
//   ブレインの判断とスタッフが押した AIX の対（pairBrainDecisions）・集計（aggregateBrainAixFeedback）・
//   LLM が null の時の場面の信号（sceneSignalFallback）・check_pattern の出どころ（resolveBrainCheckPattern）・
//   降格ゲートの読み先（feedbackGateRate）・未返信の顧客発言（unrepliedCustomerTurn）・プロンプトの証拠欄の回帰テスト。
// 実行: npx tsx app/lib/__tests__/brain-aix-feedback.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  pairBrainDecisions, collapsePresses, aggregateBrainAixFeedback, sceneSignalFallback, resolveBrainCheckPattern,
  feedbackGateRate, unrepliedCustomerTurn, customerTurnBeforePress, buildSceneEvidencePromptText, sceneEvidenceForTurn,
  type BrainDecisionRow, type AixPressRow,
} from "../brain-aix-feedback";
import { detectAixSceneEvidence } from "../aix-scene-evidence";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const T0 = Date.parse("2026-09-01T00:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const dec = (id: string, min: number, action: string, conv = "c1", extra: Partial<BrainDecisionRow> = {}): BrainDecisionRow =>
  ({ id, conversation_id: conv, created_at: at(min), suggested_action: action, ...extra });
const press = (min: number, aix: string, conv = "c1", cp: string | null = null): AixPressRow =>
  ({ conversation_id: conv, aix_type: aix, check_pattern: cp, created_at: at(min) });
const NOW = T0 + 10 * 24 * 60 * 60_000; // 10日後（窓はすべて閉じている）

describe("pairBrainDecisions", () => {
  it("窓の中で最初に押された AIX と対にする（一致）", () => {
    const p = pairBrainDecisions([dec("d1", 0, "estimate_sheet")], [press(10, "estimate_sheet")], NOW);
    expect(p[0].matched).toBe(true); expect(p[0].press?.aix_type).toBe("estimate_sheet");
  });
  it("別の AIX が押されたら不一致", () => {
    const p = pairBrainDecisions([dec("d1", 0, "viewing_invite")], [press(10, "meeting_place")], NOW);
    expect(p[0].matched).toBe(false); expect(p[0].press?.aix_type).toBe("meeting_place");
  });
  it("30分以内の連続押しは1件にまとめる（2回目は数えない）", () => {
    const c = collapsePresses([press(0, "property_send"), press(20, "property_send"), press(45, "estimate_sheet"), press(200, "property_send")]);
    // 0 と 20 はまとまる。45 は直前の押し（20）から25分なのでまとまる。200 は別
    expect(c.length).toBe(2);
    expect(c[1].created_at).toBe(at(200));
  });
  it("acknowledge_check は property_check_result と同じ扱い", () => {
    const p = pairBrainDecisions([dec("d1", 0, "acknowledge_check")], [press(5, "property_check_result", "c1", "mgmt_move_in")], NOW);
    expect(p[0].matched).toBe(true);
  });
  it("次の判断で打ち切る（押しは次の判断の窓に入る）", () => {
    const p = pairBrainDecisions([dec("d1", 0, "estimate_sheet"), dec("d2", 60, "viewing_invite")], [press(90, "viewing_invite")], NOW);
    const d1 = p.find((x) => x.decision.id === "d1")!; const d2 = p.find((x) => x.decision.id === "d2")!;
    expect(d1.press).toBe(null); expect(d1.matched).toBe(false);
    expect(d2.matched).toBe(true);
  });
  it("24時間を超えた押しは対にしない", () => {
    const p = pairBrainDecisions([dec("d1", 0, "estimate_sheet")], [press(25 * 60, "estimate_sheet")], NOW);
    expect(p[0].press).toBe(null); expect(p[0].matched).toBe(false);
  });
  it("action なしの判断は「何も押されなかった」を一致とする", () => {
    const p = pairBrainDecisions([dec("d1", 0, ""), dec("d2", 0, "", "c2")], [press(10, "property_send", "c2")], NOW);
    expect(p.find((x) => x.decision.id === "d1")!.matched).toBe(true);
    expect(p.find((x) => x.decision.id === "d2")!.matched).toBe(false);
  });
  it("窓がまだ閉じておらず押されていない判断は保留（matched=null）", () => {
    const p = pairBrainDecisions([dec("d1", 0, "estimate_sheet")], [], T0 + 60 * 60_000);
    expect(p[0].pending).toBe(true); expect(p[0].matched).toBe(null);
  });
  it("別の会話の押しは混ざらない", () => {
    const p = pairBrainDecisions([dec("d1", 0, "estimate_sheet", "c1")], [press(5, "estimate_sheet", "c2")], NOW);
    expect(p[0].press).toBe(null);
  });
});

describe("aggregateBrainAixFeedback", () => {
  it("n>=minN だけ行にし、alt_top に代わりに押された AIX を数える", () => {
    const decisions = [dec("a", 0, "acknowledge_check", "c1"), dec("b", 0, "acknowledge_check", "c2"), dec("c", 0, "acknowledge_check", "c3")];
    const presses = [press(5, "estimate_sheet", "c1"), press(5, "estimate_sheet", "c2"), press(5, "property_check_result", "c3")];
    const rows = aggregateBrainAixFeedback(pairBrainDecisions(decisions, presses, NOW), [], 30, 3);
    const r = rows.find((x) => x.key === "action:property_check_result")!;
    expect(r.n).toBe(3); expect(r.pressed).toBe(3); expect(r.matched).toBe(1); expect(r.alt_top[0].aix).toBe("estimate_sheet"); expect(r.alt_top[0].n).toBe(2);
  });
  it("押されなかった判断は n に入るが pressed には入らない", () => {
    const decisions = [dec("a", 0, "estimate_sheet", "c1"), dec("b", 0, "estimate_sheet", "c2")];
    const r = aggregateBrainAixFeedback(pairBrainDecisions(decisions, [press(5, "estimate_sheet", "c1")], NOW), [], 30, 2)[0];
    expect(r.n).toBe(2); expect(r.pressed).toBe(1); expect(r.matched).toBe(1);
  });
  it("minN 未満は出さない", () => {
    const rows = aggregateBrainAixFeedback(pairBrainDecisions([dec("a", 0, "estimate_sheet")], [], NOW), [], 30, 10);
    expect(rows.length).toBe(0);
  });
  it("scene_staff は場面ごとにスタッフが押した AIX の分布", () => {
    const sp = [
      { scene: "S5_time_spec", candidateAction: "meeting_place", aix: "meeting_place" },
      { scene: "S5_time_spec", candidateAction: "meeting_place", aix: "meeting_place" },
      { scene: "S5_time_spec", candidateAction: "meeting_place", aix: "viewing_invite" },
    ];
    const r = aggregateBrainAixFeedback([], sp, 30, 3).find((x) => x.kind === "scene_staff")!;
    expect(r.key).toBe("scene_staff:S5_time_spec"); expect(r.matched).toBe(2); expect(r.alt_top[0].aix).toBe("meeting_place");
  });
  it("decision_source 別・action|check_pattern 別も集計する", () => {
    const decisions = [1, 2, 3].map((i) => dec(`d${i}`, 0, "property_check_result", `c${i}`, { suggested_check_pattern: "mgmt_move_in", decision_source: "signal:scene_S2" }));
    const presses = [1, 2, 3].map((i) => press(5, "property_check_result", `c${i}`, "mgmt_move_in"));
    const rows = aggregateBrainAixFeedback(pairBrainDecisions(decisions, presses, NOW), [], 30, 3);
    expect(rows.some((x) => x.key === "action_cp:property_check_result|mgmt_move_in" && x.matched === 3)).toBe(true);
    expect(rows.some((x) => x.key === "decision_source:signal:scene_S2" && x.n === 3)).toBe(true);
  });
});

describe("sceneSignalFallback（LLM が null の時だけの場面の信号）", () => {
  it("S2 入居日 → property_check_result / mgmt_move_in", () => {
    const e = detectAixSceneEvidence({ latestCustomerTurn: "この物件いつから住めますか？", hasCustomerImage: false });
    const s = sceneSignalFallback(e);
    expect(s?.action).toBe("property_check_result"); expect(s?.checkPattern).toBe("mgmt_move_in"); expect(s?.decisionSource).toBe("signal:scene_S2");
  });
  it("S3 審査 → property_check_result / mgmt_guarantor", () => {
    const s = sceneSignalFallback(detectAixSceneEvidence({ latestCustomerTurn: "この物件って審査厳しいですか？", hasCustomerImage: false }));
    expect(s?.action).toBe("property_check_result"); expect(s?.checkPattern).toBe("mgmt_guarantor");
  });
  it("S5 日時指定＋viewing_invite 履歴 → meeting_place", () => {
    const s = sceneSignalFallback(detectAixSceneEvidence({ latestCustomerTurn: "9/9の15時からお願いします！", hasCustomerImage: false, aixHistory: [{ aix_type: "viewing_invite" }] }));
    expect(s?.action).toBe("meeting_place"); expect(s?.decisionSource).toBe("signal:scene_S5");
  });
  it("S1 空室・S4 内覧は信号にしない（テキスト返信での誤発火が多い）", () => {
    expect(sceneSignalFallback(detectAixSceneEvidence({ latestCustomerTurn: "この物件まだ空いてますか？", hasCustomerImage: false }))).toBe(null);
    expect(sceneSignalFallback(detectAixSceneEvidence({ latestCustomerTurn: "内覧したいです", hasCustomerImage: false }))).toBe(null);
  });
  it("証拠なし → null（既存の信号の結果に何も足さない）", () => {
    expect(sceneSignalFallback(null)).toBe(null);
  });
});

describe("resolveBrainCheckPattern（check_pattern の出どころ）", () => {
  it("property_check_result 以外は null", () => {
    expect(resolveBrainCheckPattern("estimate_sheet", null, null, "保証会社はどこですか")).toBe(null);
  });
  it("場面の信号の check_pattern を最優先", () => {
    expect(resolveBrainCheckPattern("property_check_result", null, "vacate_date", "")?.check_pattern).toBe("vacate_date");
  });
  it("証拠が S2/S3 ならその check_pattern（未返信の文に別の語があっても）", () => {
    const e = detectAixSceneEvidence({ latestCustomerTurn: "この物件いつから住めますか？駐車場もありますか", hasCustomerImage: false });
    expect(resolveBrainCheckPattern("property_check_result", e, null, "この物件いつから住めますか？駐車場もありますか")?.check_pattern).toBe("mgmt_move_in");
  });
  it("証拠が無ければ未返信の顧客発言だけに detectPropertyCheckPattern", () => {
    expect(resolveBrainCheckPattern("property_check_result", null, null, "近くに月極ありますか")?.check_pattern).toBe("nearby_parking");
    expect(resolveBrainCheckPattern("property_check_result", null, null, "")).toBe(null);
  });
});

describe("feedbackGateRate（降格ゲートの読み先）", () => {
  const rows = [{ kind: "action" as const, action: "property_check_result", pressed: 20, matched: 6 }];
  it("acknowledge_check は property_check_result の行を読む・分母は押された判断（pressed）", () => {
    const r = feedbackGateRate(rows, "acknowledge_check");
    expect(r?.n).toBe(20); expect(r?.rate).toBe(0.3);
  });
  it("押された判断が0件なら null（押されずテキストで返した判断だけで降格しない）", () => {
    expect(feedbackGateRate([{ kind: "action", action: "estimate_sheet", pressed: 0, matched: 0 }], "estimate_sheet")).toBe(null);
  });
  it("行が無ければ null（フェイルオープン）", () => {
    expect(feedbackGateRate(rows, "estimate_sheet")).toBe(null);
  });
});

describe("未返信の顧客発言・押す直前の顧客発言", () => {
  it("最後のスタッフ発言より後の顧客の連投を古い順につなぐ（画像は hasImage）", () => {
    const t = unrepliedCustomerTurn([
      { sender: "customer", text: "この物件いつから住めますか？" },
      { sender: "customer", text: "[画像]" },
      { sender: "customer", text: "こんにちは" },
      { sender: "staff", text: "お送りしました" },
      { sender: "customer", text: "古い発言" },
    ]);
    expect(t.text).toBe("こんにちは\nこの物件いつから住めますか？"); expect(t.hasImage).toBe(true);
  });
  it("最新がスタッフ発言なら空", () => {
    expect(unrepliedCustomerTurn([{ sender: "staff", text: "x" }, { sender: "customer", text: "y" }]).text).toBe("");
  });
  it("押す直前にスタッフのテキストが挟まっても、その前の顧客の連投を拾う（48時間以内）", () => {
    const pressAt = T0 + 60 * 60_000;
    const t = customerTurnBeforePress([
      { sender: "staff", text: "かしこまりました", created_at: at(55) },
      { sender: "customer", text: "9/9の15時からお願いします！", created_at: at(50) },
    ], pressAt);
    expect(t.text).toBe("9/9の15時からお願いします！");
    const old = customerTurnBeforePress([{ sender: "customer", text: "古い", created_at: at(0) }], T0 + 49 * 60 * 60_000);
    expect(old.text).toBe("");
  });
  it("sceneEvidenceForTurn は退去予定なら S2 を vacate_date にする", () => {
    const e = sceneEvidenceForTurn({ text: "この物件いつから住めますか？", hasImage: false }, { sentPropertyCount: 0, moveOutScheduled: true });
    expect(e?.checkPattern).toBe("vacate_date");
  });
});

describe("buildSceneEvidencePromptText（証拠と実績の欄・規則にしない）", () => {
  it("場面と実績を事実として書き、「AIX を決めるのはあなた」を明記", () => {
    const e = detectAixSceneEvidence({ latestCustomerTurn: "9/9の15時からお願いします！", hasCustomerImage: false, aixHistory: [{ aix_type: "viewing_invite" }] });
    const txt = buildSceneEvidencePromptText(e, [{ kind: "scene_staff", action: "meeting_place", scene: "S5_time_spec", n: 30, pressed: 30, matched: 28, alt_top: [{ aix: "meeting_place", n: 28 }] }]);
    expect(txt.includes("AIX を決めるのはあなた")).toBe(true);
    expect(txt.includes("meeting_place 28件")).toBe(true);
    expect(/必ず|しなければ/.test(txt)).toBe(false);
  });
  it("証拠も実績も無ければ空文字（プロンプトを変えない）", () => {
    expect(buildSceneEvidencePromptText(null, [])).toBe("");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
