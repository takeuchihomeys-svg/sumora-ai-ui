// 2026-09-10 Fable5 みく事例: brain の会話スコープ・フィールドがメッセージ判定を汚染する構造の是正の回帰テスト。
// 実行: npx tsx app/lib/__tests__/brain-scope.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair,
  mergeBrainEvidence, toBrainMessageLocal, toBrainConversationScope, detectCellConflicts,
  avoidConflictsWithCell, buildPairDirection, fillPairPlaceholders, detectWaitSignal,
  type CustomerResponse, type CustomerResponseKind,
} from "../reply-context";
import { resolveOpener } from "../greeting";
import { runDeterministicChecks } from "../final-check";

// ── ミニハーネス（pair-example.test.ts と同型）──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (!Array.isArray(actual) || !actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) && actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}

// ── みく 2026-09-10 ──────────────────────────────────────────
const MIKU_STAFF = "特にリアライズ長居公園通313号室が2025年3月築の新築で費用を抑える事ができ、みくさんにかなりオススメ出来るお部屋となります！！みくさんお気に召されましたら9月末退去後にお部屋ご案内させていただきます！！";
const MIKU_CUST  = "ありがとうございます！確認させていただきます🙇";
const MIKU_NG    = "ご要望お聞かせ頂きありがとうございます😊！！\n初期費用を抑えられる、築浅・広めのお部屋を中心にみくさんにオススメできるお部屋お調べさせて頂きます！！\n\nみくさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
const MIKU_OK    = "はい😊！！\nごゆっくりご確認頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！";
const MIKU_BRAIN: Record<string, unknown> = {
  repeated_concern: "初期費用", customer_concern: null, customer_questions: [], condition_change_type: "none",
  hesitancy_pattern: "thinking", customer_intent: "consultation", engagement_stance: "wait",
  avoid_topics: ["来阪", "他物件の募集状況確認", "新規物件ピックアップ", "別物件の提案", "申込誘導"],
  reply_direction: "感謝を受け取り検討を見守る",
};
const PROP_SENT = "🌟グランドメゾン 302号室\nお手隙の際にご査収ください😌！！";

const build = (cust: string, staffText: string, bm: Record<string, unknown> | null = null) => {
  const staff = classifyLastStaffTurn(staffText, {});
  const local = toBrainMessageLocal(bm), strategy = toBrainConversationScope(bm);
  const sub = mergeBrainEvidence(analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" }), local, true);
  const customer = classifyCustomerResponse(sub, staff, { brain: local });
  const pair = resolveTurnPair(staff, customer, sub, staffText, {});
  pair.conflicts = detectCellConflicts(pair, strategy, true);
  return { staff, sub, customer, pair, strategy };
};

describe("S residue と brain スコープ", () => {
  it("S1 みく: residue は空・isAckOnly=false・isPureBoilerplate=true・waitSignal.verb=確認", () => {
    const s = analyzeSubstance(MIKU_CUST);
    expect(s.residue).toBe(""); expect(s.isAckOnly).toBe(false);
    expect(s.isPureBoilerplate).toBe(true); expect(s.waitSignal.verb).toBe("確認");
  });
  it("S2 residue 空なら fresh brain の repeated_concern で concern も has も立たない", () => {
    const s = build(MIKU_CUST, MIKU_STAFF, MIKU_BRAIN).sub;
    expect(s.has).toBe(false); expect(s.kinds).not.toContain("concern");
    expect(s.evidence.some((e) => e.startsWith("brain.skipped"))).toBe(true);
  });
  it("S3 純了承（ありがとうございます！のみ）も repeated_concern で concern にならない", () => {
    expect(build("ありがとうございます！", MIKU_STAFF, MIKU_BRAIN).customer.kind).toBe("ack_only");
  });
  it("S4 residue があり customer_concern が本文にアンカーされていれば concern は立つ", () => {
    const s = build("2階なんですね…虫が心配で迷います", MIKU_STAFF, { ...MIKU_BRAIN, customer_concern: { topic: "2階の虫侵入" } }).sub;
    expect(s.kinds).toContain("concern");
  });
  it("S5 customer_concern が本文にアンカーされていなければ採用しない（差分分析の持ち越し対策）", () => {
    const s = build("駅から徒歩10分以内でお願いします", MIKU_STAFF, { ...MIKU_BRAIN, customer_concern: { topic: "審査" } }).sub;
    expect(s.evidence.some((e) => e.startsWith("brain.customer_concern"))).toBe(false);
  });
  it("S6 customer_questions は message-local なので residue があれば維持される", () => {
    const s = build("初期費用はいくらになりますか？", MIKU_STAFF, { ...MIKU_BRAIN, customer_questions: ["初期費用はいくらか"] }).sub;
    expect(s.kinds).toContain("question");
  });
  it("S7 toBrainMessageLocal / toBrainConversationScope が scope を分けて詰める", () => {
    const local = toBrainMessageLocal(MIKU_BRAIN)!, strat = toBrainConversationScope(MIKU_BRAIN)!;
    expect(local.scope).toBe("message-local"); expect(strat.scope).toBe("conversation");
    expect(strat.repeated_concern).toBe("初期費用"); expect(strat.engagement_stance).toBe("wait");
    expect(Object.prototype.hasOwnProperty.call(local, "repeated_concern")).toBe(false);
  });
  it("S8 detectWaitSignal は「検討」「確認」「また連絡します」を動詞クラスで拾う", () => {
    expect(detectWaitSignal("一度検討させて頂きます").verb).toBe("検討");
    expect(detectWaitSignal("後ほど確認します").verb).toBe("確認");
    expect(detectWaitSignal("こんにちは").yes).toBe(false);
  });
});

describe("T セル選択", () => {
  it("T1 みく 18:50 は PS_THINKING（PS_CONCERN ではない）", () => {
    const { customer, pair } = build(MIKU_CUST, MIKU_STAFF, MIKU_BRAIN);
    expect(customer.kind).toBe("thinking"); expect(pair.ruleId).toBe("PS_THINKING");
  });
  it("T2 direction に「ご要望お聞かせ」「お調べさせて頂きます」が出ない", () => {
    const { pair, strategy } = build(MIKU_CUST, MIKU_STAFF, MIKU_BRAIN);
    const d = buildPairDirection(pair, { brainReplyDirection: strategy!.reply_direction, brainFresh: true, strategy })!;
    expect(/ご要望お聞かせ/.test(d)).toBe(false); expect(/お調べさせて頂きます/.test(d)).toBe(false);
  });
  it("T2' preferWhenAvoid で「扉を開ける側」がリテラル指名される", () => {
    const { pair, strategy } = build(MIKU_CUST, MIKU_STAFF, MIKU_BRAIN);
    const d = buildPairDirection(pair, { brainReplyDirection: null, brainFresh: true, strategy })!;
    expect(/この場面では必ず →/.test(d)).toBe(true);
    expect(/実際にお部屋ご案内させて頂きます/.test(d)).toBe(true);
  });
  it("T3 本物の懸念（お風呂が狭い）は PS_CONCERN が選ばれ object が非 null", () => {
    const { customer, pair } = build("お風呂が狭くて迷います…", PROP_SENT);
    expect(customer.kind).toBe("concern"); expect(customer.object).toBe("お風呂");
    expect(pair.ruleId).toBe("PS_CONCERN");
  });
  it("T4 対象語のない brain 単独 concern はセルが降格する（check-reply 経路の二重防護）", () => {
    const sub = analyzeSubstance(MIKU_CUST);
    const staff = classifyLastStaffTurn(MIKU_STAFF, {});
    const forged = { kind: "concern", object: null as unknown as string, secondary: [], evidence: "brain:repeated_concern", source: "brain" } as CustomerResponse;
    const pair = resolveTurnPair(staff, forged, sub, MIKU_STAFF, {});
    expect(pair.cellGuard.concernDemoted).toBe(true); expect(pair.ruleId).toBe("PS_THINKING");
    expect(pair.customer.kind).toBe("thinking");
  });
  it("T5 {object} が空のまま懸念 direction をレンダリングしようとしたら開発時に落ちる", () => {
    const { pair } = build(MIKU_CUST, MIKU_STAFF, MIKU_BRAIN);
    let threw = false;
    try { fillPairPlaceholders("懸念（{object}）を条件に変換", { ...pair, ruleId: "PS_CONCERN" }); } catch { threw = true; }
    expect(threw).toBe(true);
  });
  it("T5' {fix} は顧客が書いた対象語から導かれ、汎用フォールバックを持たない", () => {
    const { pair } = build("お風呂が狭くて迷います…", PROP_SENT);
    const filled = fillPairPlaceholders("{fix}", pair);
    expect(/ご希望条件のお部屋を中心に/.test(filled)).toBe(false);
    expect(filled.length > 0).toBe(true);
  });
  it("T6 開口語は hai（thinking → はい😊！！）", () => {
    const { customer, sub } = build(MIKU_CUST, MIKU_STAFF, MIKU_BRAIN);
    expect(resolveOpener({ greetingKind: "standard", customerKind: customer.kind as CustomerResponseKind, substanceKinds: sub.kinds }).opener).toBe("hai");
  });
});

describe("U brain 方針の活用", () => {
  it("U1 engagement_stance=wait × 新規ピックアップ必須のセルは stance 衝突として記録される", () => {
    const { pair } = build("お風呂が狭くて迷います…", PROP_SENT);
    const cf = detectCellConflicts(pair, toBrainConversationScope(MIKU_BRAIN), true);
    expect(cf.some((c) => c.kind === "stance_wait_vs_proposal")).toBe(true);
    expect(cf.some((c) => c.kind === "avoid_vs_must" && /新規物件ピックアップ/.test(c.brainValue))).toBe(true);
  });
  it("U2 「新規物件ピックアップ」と「再ピックアップ宣言」を衝突と認識する（旧 includes では不可能だった）", () => {
    const { pair } = build("お風呂が狭くて迷います…", PROP_SENT);
    const cf = detectCellConflicts(pair, toBrainConversationScope({ avoid_topics: ["新規物件ピックアップ"] }), true);
    expect(cf.length > 0).toBe(true);
    expect(avoidConflictsWithCell(pair, "新規物件ピックアップ")).toBe(true);
    expect(avoidConflictsWithCell(pair, "来阪")).toBe(false);
  });
  it("U3 brainFresh=false / strategy=null では衝突を出さない", () => {
    const { pair } = build("お風呂が狭くて迷います…", PROP_SENT);
    expect(detectCellConflicts(pair, toBrainConversationScope(MIKU_BRAIN), false).length).toBe(0);
    expect(detectCellConflicts(pair, null, true).length).toBe(0);
  });
});

describe("V final-check", () => {
  const ctx = (bm: Record<string, unknown> | null) => ({
    lastCustomerMessage: MIKU_CUST, customerName: "みく",
    recentMessages: [{ sender: "staff", text: MIKU_STAFF, createdAt: "2026-09-10T09:40:00Z" },
                     { sender: "customer", text: MIKU_CUST, createdAt: "2026-09-10T09:50:00Z" }],
    brainStrategy: toBrainConversationScope(bm),
  });
  it("V1 NG 文は UNPROMPTED_PROPOSAL:block で捕まる", () => {
    const codes = runDeterministicChecks(MIKU_NG, ctx(MIKU_BRAIN)).map((i) => `${i.code}:${i.severity}`);
    expect(codes).toContain("UNPROMPTED_PROPOSAL:block");
  });
  it("V2 正解文は UNPROMPTED_PROPOSAL を出さない", () => {
    const codes = runDeterministicChecks(MIKU_OK, ctx(MIKU_BRAIN)).map((i) => i.code);
    expect(codes).not.toContain("UNPROMPTED_PROPOSAL");
  });
  it("V3 顧客が条件を書いていればピックアップ宣言は咎めない（免除の確認）", () => {
    const c = { ...ctx(null), lastCustomerMessage: "9万以内・1LDKでお願いします" };
    expect(runDeterministicChecks("かしこまりました！！\n9万以内・1LDKでみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！", c).map((i) => i.code))
      .not.toContain("UNPROMPTED_PROPOSAL");
  });
  it("V4 未履行のピックアップ約束の復唱（PD_ACK）は咎めない", () => {
    const c = { ...ctx(null), lastCustomerMessage: "よろしくお願いします🙇",
      recentMessages: [{ sender: "staff", text: "みくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！", createdAt: "2026-09-10T09:40:00Z" },
                       { sender: "customer", text: "よろしくお願いします🙇", createdAt: "2026-09-10T09:50:00Z" }] };
    expect(runDeterministicChecks("はい😊！！\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！", c).map((i) => i.code))
      .not.toContain("UNPROMPTED_PROPOSAL");
  });
  it("V5 CELL_AVOID_CONFLICT は warning で cellConflicts から出る", () => {
    const { pair } = build("お風呂が狭くて迷います…", PROP_SENT);
    const conflicts = detectCellConflicts(pair, toBrainConversationScope(MIKU_BRAIN), true);
    const codes = runDeterministicChecks("お風呂広めのお部屋を中心にオススメできるお部屋お調べさせて頂きます！！", {
      lastCustomerMessage: "お風呂が狭くて迷います…", customerName: "みく",
      recentMessages: [{ sender: "staff", text: PROP_SENT, createdAt: "2026-09-10T09:40:00Z" },
                       { sender: "customer", text: "お風呂が狭くて迷います…", createdAt: "2026-09-10T09:50:00Z" }],
      cellConflicts: conflicts,
    }).map((i) => `${i.code}:${i.severity}`);
    expect(codes).toContain("CELL_AVOID_CONFLICT:warning");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("\n失敗一覧:"); failures.forEach((f) => console.log(" - " + f)); process.exit(1); }
