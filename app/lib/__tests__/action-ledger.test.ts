// 2026-09-09 Fable5 行動台帳（Action Ledger）の回帰テスト。みく事例（「再度ピックアップ」誤生成）を中心に 20 件。
// 実行: npx tsx app/lib/__tests__/action-ledger.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import {
  buildActionLedger, checkDonePresupposition, applyLedgerAutoFix, buildLedgerNote, gatedVocabKeys, staffKindOf,
  type LedgerAixRow, type LedgerMessage, type LedgerTask,
} from "../action-ledger";
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveHedgeAllowance, resolveCloser, buildPairDirection, buildTurnPairNote,
  predictCloserSignals,
} from "../reply-context";
import { runDeterministicChecks, type FinalCheckContext } from "../final-check";

// ── ミニハーネス ──
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
    toContain(item: unknown) { if (Array.isArray(actual) ? !actual.includes(item) : typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    toBeTruthy() { if (!actual) throw new Error(`expected truthy but got ${JSON.stringify(actual)}`); },
    toBeFalsy() { if (actual) throw new Error(`expected falsy but got ${JSON.stringify(actual)}`); },
    not: {
      toBe(exp: T) { if (actual === exp) throw new Error(`expected not ${JSON.stringify(exp)}`); },
      toContain(item: unknown) { if (Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" ? actual.includes(String(item)) : false) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); },
      toMatch(re: RegExp) { if (typeof actual === "string" && re.test(actual)) throw new Error(`expected ${JSON.stringify(actual)} not to match ${re}`); },
    },
    toMatch(re: RegExp) { if (typeof actual !== "string" || !re.test(actual)) throw new Error(`expected ${JSON.stringify(actual)} to match ${re}`); },
  };
}

// ── みく会話（JST 9/8〜9/9）。時刻は UTC ISO ──
const T = (jst: string) => new Date(`2026-${jst}:00+09:00`).toISOString();
const MIKU_ASK = "みくさんお世話になっております！！\n①【ご入居の時期】⇒\n②【ご希望家賃】⇒\n③【間取り】⇒\n④【築年数】⇒\n⑤【ご希望エリア】⇒\n⑥【駅徒歩】⇒\n⑦【初期費用の限度額】⇒\n⑧【その他ご希望】⇒";
const MIKU_FORM = "ありがとうございます🙇\n以下希望でございます。\n①12月までに\n②9万以内\n③1LDK（できればカウンターキッチン希望）\n④10年以内（できれば）\n⑤梅田まで1本で行ける線\n⑥10分以内\n⑦20万位内\n⑧35㎡以上";
const MIKU_1040 = "梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n\nみくさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！\n何卒よろしくお願い致します！！";
const MIKU_1145 = "ありがとうございます🙇\nできれば大阪の市内付近でお願いいたします（京都・尼崎はNGで、、、）\nよろしくお願いします🙇";
const AI_1146 = "かしこまりました😊！！\n\n大阪市内に絞って再度ピックアップさせて頂きます！！梅田まで1本で行ける沿線・9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋をお届けします！！\n\n何卒よろしくお願い致します！！";
const STAFF_1148 = "かしこまりました😊！！\n\n大阪市内に絞らせて頂き、梅田まで1本で行ける沿線・9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋をピックアップさせて頂きます！！\n\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！";
const ESTIMATE_BODY = "みくさんお世話になっております！！\n【エストレーラ 305号室】\n初期費用の御見積書お送りさせて頂きます！！\n🌟13,250円割引させて頂いております！！\nお手隙の際にご査収ください😌！！";

const mikuMessages: LedgerMessage[] = [
  { sender: "customer", text: "エストレーラ305の初期費用知りたいです", createdAt: T("09-08T22:30") },
  { sender: "staff", text: ESTIMATE_BODY, createdAt: T("09-08T23:01") },
  { sender: "staff", text: "[画像]", createdAt: T("09-08T23:01") },
  { sender: "customer", text: "ありがとうございます。検討します。気になる物件また送ります", createdAt: T("09-09T00:10") },
  { sender: "staff", text: MIKU_ASK, createdAt: T("09-09T00:35") },
  { sender: "customer", text: MIKU_FORM, createdAt: T("09-09T10:20") },
  { sender: "staff", text: MIKU_1040, createdAt: T("09-09T10:40") },
  { sender: "customer", text: MIKU_1145, createdAt: T("09-09T11:45") },
];
const mikuAix: LedgerAixRow[] = [
  { aix_type: "estimate_sheet", created_at: T("09-08T23:01"), sent_at: T("09-08T23:01"), generated_text: ESTIMATE_BODY, estimate_sent: true },
  { aix_type: "condition_hearing", created_at: T("09-09T00:35"), sent_at: T("09-09T00:35") },
];
const mikuTasks: LedgerTask[] = [{ task_type: "property_send", status: "pending", created_at: T("09-09T10:40") }];
const mikuLedger = buildActionLedger({ recentAixRows: mikuAix, messages: mikuMessages, lineTasks: mikuTasks, lastCustomerAt: T("09-09T11:45"), now: Date.parse(T("09-09T11:46")) });

/** route.ts と同じ順序で往復文脈を組む */
const buildPair = (cust: string, staffText: string, ledger: ReturnType<typeof buildActionLedger>, opts: { lastStaffAt?: string; custAt?: string; aixMode?: boolean } = {}) => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: opts.lastStaffAt ?? null, ledger });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, {});
  const hedge = resolveHedgeAllowance({ customerMessage: cust, substance: sub, staff, customer, lastStaffText: staffText, lastCustomerAt: opts.custAt ?? null, ledger, isAixPropertySendMode: opts.aixMode });
  const pair = resolveTurnPair(staff, customer, sub, staffText, { searched: hedge.searched.yes, ledger });
  return { staff, sub, customer, hedge, pair };
};
const ctxOf = (cust: string, msgs: LedgerMessage[], ledger: ReturnType<typeof buildActionLedger>, extra: Partial<FinalCheckContext> = {}): FinalCheckContext => ({
  lastCustomerMessage: cust,
  recentMessages: msgs.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt })),
  customerName: "みく", ledger, ledgerStrict: true, ...extra,
});
const codesOf = (text: string, ctx: FinalCheckContext) => runDeterministicChecks(text, ctx).map((i) => `${i.code}:${i.severity}`);

describe("台帳（みく）", () => {
  it("#1 ledger_miku_facts: 送付0件・見積送付済(エストレーラ 305号室)・ピックアップ約束未履行・redo 不可・直前=pickup_declared", () => {
    const f = mikuLedger.facts;
    expect(f.propertiesSentCount).toBe(0);
    expect(f.estimateSent).toBe(true);
    expect(f.estimateSentFor).toEqual(["エストレーラ 305号室"]);
    expect(f.pickupPromisedUnfulfilled).toBe(true);
    expect(f.redoAllowed).toBe(false);
    expect(f.lastStaffEntry?.kind).toBe("pickup_declared");
    expect(f.lastStaffEntry?.status).toBe("promised");
  });
  it("#2 classify_miku_1040: 10:40 本文は pickup_declared（source=ledger）", () => {
    const st = classifyLastStaffTurn(MIKU_1040, { ledger: mikuLedger, lastStaffAt: T("09-09T10:40") });
    expect(st.kind).toBe("pickup_declared");
    expect(st.source).toBe("ledger");
    // 台帳なしでも本文 regex で宣言（未来形）を実行より先に判定する
    expect(classifyLastStaffTurn(MIKU_1040).kind).toBe("pickup_declared");
  });
  it("#3 pair_miku: pickup_declared × condition_change → PD_CONDITION_CHANGE・redo=''・closer=none＋何卒", () => {
    const { pair, customer, hedge } = buildPair(MIKU_1145, MIKU_1040, mikuLedger, { lastStaffAt: T("09-09T10:40"), custAt: T("09-09T11:45") });
    expect(customer.kind).toBe("condition_change");
    expect(pair.ruleId).toBe("PD_CONDITION_CHANGE");
    expect(pair.redo).toBe("");
    expect(hedge.allowance).toBe("forbid_preemptive");
    const closer = resolveCloser(pair, predictCloserSignals({}), { customerName: "みく", ledger: mikuLedger });
    expect(closer.closer).toBe("none");
    expect(closer.nanisotsu).toBe(true);
    const dir = buildPairDirection(pair, { brainFresh: false }) ?? "";
    expect(dir).not.toContain("再ピックアップ");
    expect(dir).toContain("物件送付0件");
  });
  it("#4 miku_1146_block_autofix: AI 11:46 文は DONE_PRESUPPOSED block → applyLedgerAutoFix で「再度」削除・再検査 block 0", () => {
    const hits = checkDonePresupposition(AI_1146, mikuLedger, { customerMessage: MIKU_1145, name: "みくさん" });
    const redo = hits.find((h) => h.key === "redo_pickup");
    expect(redo?.code).toBe("DONE_PRESUPPOSED_WITHOUT_EVIDENCE");
    expect(redo?.severity).toBe("block");
    expect(redo?.evidence).toBe("再度ピックアップ");
    expect(redo?.exempt).toBe(null);
    const ctx = ctxOf(MIKU_1145, mikuMessages, mikuLedger);
    expect(codesOf(AI_1146, ctx)).toContain("DONE_PRESUPPOSED_WITHOUT_EVIDENCE:block");
    const fx = applyLedgerAutoFix(AI_1146, mikuLedger, { customerMessage: MIKU_1145, name: "みくさん" });
    expect(fx.applied.length > 0).toBe(true);
    expect(fx.text).toContain("大阪市内に絞ってピックアップさせて頂きます");
    expect(fx.text).not.toContain("再度");
    expect(codesOf(fx.text, ctx).filter((c) => c.startsWith("DONE_PRESUPPOSED") || c.startsWith("UNSENT_CLAIM"))).toEqual([]);
  });
  it("#5 miku_1148_pass: 11:48 実送信文は台帳検査ゼロ・PAIR_ELEMENT_MISSING なし", () => {
    const ctx = ctxOf(MIKU_1145, mikuMessages, mikuLedger);
    const c = codesOf(STAFF_1148, ctx);
    expect(c.filter((x) => /DONE_PRESUPPOSED|UNSENT_CLAIM|PROMISE_ECHO|SENT_IGNORED|PAIR_ELEMENT_MISSING/.test(x))).toEqual([]);
    expect(checkDonePresupposition(STAFF_1148, mikuLedger, { customerMessage: MIKU_1145, name: "みくさん" }).filter((h) => !h.exempt)).toEqual([]);
  });
  it("#6 estimate_body_not_counted: 見積 AIX 本文の🌟割引・[画像]は物件送付に数えない（AIX ±3分帰属）", () => {
    expect(mikuLedger.facts.propertiesSentCount).toBe(0);
    expect(mikuLedger.entries.filter((e) => e.kind === "properties_sent")).toEqual([]);
    // AIX 行が無い純本文でも 見積語があるので estimate_sent（物件送付ではない）
    const noAix = buildActionLedger({ messages: [{ sender: "staff", text: ESTIMATE_BODY, createdAt: T("09-08T23:01") }] });
    expect(noAix.facts.propertiesSentCount).toBe(0);
    expect(noAix.facts.estimateSent).toBe(true);
  });
  it("#18 shadow: 台帳を渡さない旧経路（check-reply 相当）では DONE_PRESUPPOSED は warning に留まる", () => {
    const ctx = ctxOf(MIKU_1145, mikuMessages, mikuLedger, { ledgerStrict: false });
    expect(codesOf(AI_1146, ctx)).toContain("DONE_PRESUPPOSED_WITHOUT_EVIDENCE:warning");
  });
  it("buildLedgerNote: みく 11:46 時点の【📒 我々の行動台帳】に「1件も送っていない」「redo_pickup ゲート」が載る", () => {
    const note = buildLedgerNote(mikuLedger, { customerName: "みく" });
    expect(note).toContain("物件はこれまで1件も送っていない");
    expect(note).toContain("御見積書は送付済み");
    expect(note).toContain("宣言であって実行ではない");
    expect(gatedVocabKeys(mikuLedger)).toContain("redo_pickup");
    const { pair } = buildPair(MIKU_1145, MIKU_1040, mikuLedger, { lastStaffAt: T("09-09T10:40"), custAt: T("09-09T11:45") });
    const tp = buildTurnPairNote(pair, MIKU_1145, "みく");
    expect(tp).toContain("約束の維持");
    expect(tp).toContain("大阪市内に絞らせて頂き");
  });
});

// ── 送付済み段階 ──
const SENT_BODY = "🌟グランドール福島 402号室\n家賃8.5万円\n🌟ラ・フォーレ野田 305号室\n家賃8.8万円\nお手隙の際にご査収ください😌！！";
const sentMessages: LedgerMessage[] = [
  { sender: "customer", text: MIKU_FORM, createdAt: T("09-09T10:20") },
  { sender: "staff", text: MIKU_1040, createdAt: T("09-09T10:40") },
  { sender: "staff", text: SENT_BODY, createdAt: T("09-09T11:00") },
  { sender: "customer", text: MIKU_1145, createdAt: T("09-09T11:45") },
];
const sentAix: LedgerAixRow[] = [{ aix_type: "property_send", created_at: T("09-09T11:00"), sent_at: T("09-09T11:00"), generated_text: SENT_BODY }];
const sentLedger = buildActionLedger({ recentAixRows: sentAix, messages: sentMessages, lastCustomerAt: T("09-09T11:45"), now: Date.parse(T("09-09T11:46")) });

describe("送付済み段階", () => {
  it("#7 redo_after_send_pass: 送付済み（2件）で「再度ピックアップ」は exempt=evidence", () => {
    expect(sentLedger.facts.propertiesSentCount).toBe(2);
    expect(sentLedger.facts.propertiesSentNames).toEqual(["グランドール福島 402号室", "ラ・フォーレ野田 305号室"]);
    expect(sentLedger.facts.pickupPromisedUnfulfilled).toBe(false); // 10:40 の宣言は 11:00 送付で履行
    const text = "かしこまりました😊！！\n大阪市内に絞らせて頂き、9万以内・1LDKでみくさんにオススメできるお部屋を再度ピックアップしてお送りさせて頂きます！！\nみくさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！";
    const hits = checkDonePresupposition(text, sentLedger, { customerMessage: MIKU_1145, name: "みくさん" });
    expect(hits.find((h) => h.key === "redo_pickup")?.exempt).toBe("evidence");
    const c = codesOf(text, ctxOf(MIKU_1145, sentMessages, sentLedger));
    expect(c.filter((x) => /DONE_PRESUPPOSED|UNSENT_CLAIM/.test(x))).toEqual([]);
    const { pair } = buildPair(MIKU_1145, SENT_BODY, sentLedger, { lastStaffAt: T("09-09T11:00"), custAt: T("09-09T11:45") });
    expect(pair.ruleId).toBe("PS_CONDITION_CHANGE");
    expect(pair.redo).toBe("再度");
    const closer = resolveCloser(pair, predictCloserSignals({}), { customerName: "みく", ledger: sentLedger });
    expect(closer.closer).toBe("commit_until_found");
    expect(closer.nanisotsu).toBe(false);
  });
  it("#8 sent_no_forced_mention: 送付済み × 条件変更 × 初回型宣言のみ → 既送付への言及を強制しない（台帳に無い文を足させない）", () => {
    const text = "かしこまりました😊！！\n大阪市内・9万以内・1LDKでみくさんにオススメできるお部屋をピックアップさせて頂きます！！\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！";
    const issues = runDeterministicChecks(text, ctxOf(MIKU_1145, sentMessages, sentLedger));
    expect(issues.find((i) => i.code === "SENT_IGNORED")).toBe(undefined);
    expect(issues.some((i) => /選択肢として|残して頂/.test(i.suggestion ?? ""))).toBe(false);
  });
  it("#9 redo_after_send_ack_pass: 「2LDKも含めて改めてピックアップ」（成約実例型）は issue なし", () => {
    const text = "かしこまりました！！\n2LDKも含めてみくさんにオススメできるお部屋改めてピックアップしてお送りさせて頂きます！！\nみくさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！";
    const c = codesOf(text, ctxOf(MIKU_1145, sentMessages, sentLedger));
    expect(c.filter((x) => /DONE_PRESUPPOSED|UNSENT_CLAIM|PROMISE_ECHO/.test(x))).toEqual([]);
  });
  it("#19 hedge_searched_ledger: 顧客最新+1分の property_send は hedge.searched=ledger:aix_log・PS_CONDITION_CHANGE_SEARCHED", () => {
    const msgs: LedgerMessage[] = [...sentMessages, { sender: "staff", text: SENT_BODY, createdAt: T("09-09T11:46") }];
    const aix: LedgerAixRow[] = [...sentAix, { aix_type: "property_send", created_at: T("09-09T11:46"), sent_at: T("09-09T11:46"), generated_text: SENT_BODY }];
    const l = buildActionLedger({ recentAixRows: aix, messages: msgs, lastCustomerAt: T("09-09T11:45"), now: Date.parse(T("09-09T11:47")) });
    expect(l.facts.propertiesSentSinceCustomerLatest).toBe(true);
    const { hedge, pair } = buildPair(MIKU_1145, SENT_BODY, l, { lastStaffAt: T("09-09T11:46"), custAt: T("09-09T11:45") });
    expect(hedge.searched.yes).toBe(true);
    expect(hedge.searched.source).toBe("aix_log");
    expect(hedge.searched.evidence).toMatch(/^ledger:aix_log/);
    expect(pair.ruleId).toBe("PS_CONDITION_CHANGE_SEARCHED");
  });
});

describe("実行前提語ゲート（語彙辞書）", () => {
  const propOnly = buildActionLedger({ recentAixRows: [{ aix_type: "property_send", created_at: T("09-09T11:00"), sent_at: T("09-09T11:00") }], messages: [{ sender: "customer", text: "お願いします", createdAt: T("09-09T11:30") }], lastCustomerAt: T("09-09T11:30") });
  it("#10 unsent_estimate_claim: 見積未送付で「先ほどお送りした御見積書」は UNSENT_CLAIM(block, missing=[estimateSent])・autofix→未来形", () => {
    const text = "はい😊！！\n先ほどお送りした御見積書をご確認ください！！";
    const hit = checkDonePresupposition(text, propOnly, { customerMessage: "お願いします", name: "〇〇さん" }).find((h) => h.key === "prior_sent_claim");
    expect(hit?.code).toBe("UNSENT_CLAIM");
    expect(hit?.severity).toBe("block");
    expect(hit?.missing).toEqual(["estimateSent"]);
    expect(hit?.exempt).toBe(null);
    const fx = applyLedgerAutoFix(text, propOnly, { customerMessage: "お願いします", name: "〇〇さん" });
    expect(fx.text).toContain("御見積書作成しお送りさせて頂きます");
    expect(fx.text).not.toContain("先ほどお送りした");
  });
  it("#11 deliverable_exempt: 成果物添付（この返信が物件送付文）なら「こちらの物件」免除・PROMISE_ECHO/JUSHU なし", () => {
    const text = "みくさんお待たせ致しました！！\n🌟エスリード西九条 801号室\nこちらのお部屋はカウンターキッチン付きです！！\nお手隙の際にご査収ください😌！！";
    const hits = checkDonePresupposition(text, mikuLedger, { customerMessage: MIKU_1145, name: "みくさん", isDeliverableReply: true });
    expect(hits.find((h) => h.key === "these_properties")?.exempt).toBe("deliverable_reply");
    const c = codesOf(text, ctxOf(MIKU_1145, mikuMessages, mikuLedger, { isDeliverableReply: true }));
    expect(c.filter((x) => /PROMISE_ECHO_MISMATCH|JUSHU_BEFORE_SEND|DONE_PRESUPPOSED/.test(x))).toEqual([]);
  });
  it("#12 promise_echo_mismatch: 宣言のみ・未履行で完了形「ピックアップさせて頂きました！！ご査収ください」は PROMISE_ECHO_MISMATCH(warning)＋JUSHU_BEFORE_SEND・autofix→出来次第", () => {
    // 見積も物件も送っていない会話（ヒアリング→フォーム→宣言→了承）
    const msgs: LedgerMessage[] = [...mikuMessages.slice(4, 7), { sender: "customer", text: "よろしくお願いします🙇", createdAt: T("09-09T11:45") }];
    const l = buildActionLedger({ recentAixRows: [], messages: msgs, lineTasks: mikuTasks, lastCustomerAt: T("09-09T11:45"), now: Date.parse(T("09-09T11:46")) });
    expect(l.facts.estimateSent).toBe(false);
    expect(l.facts.pickupPromisedUnfulfilled).toBe(true);
    const text = "はい😊！！\nみくさんにオススメできるお部屋ピックアップさせて頂きました！！ご査収ください！！";
    const c = codesOf(text, ctxOf("よろしくお願いします🙇", msgs, l));
    expect(c).toContain("PROMISE_ECHO_MISMATCH:warning");
    expect(c).toContain("JUSHU_BEFORE_SEND:warning");
    const fx = applyLedgerAutoFix(text, l, { customerMessage: "よろしくお願いします🙇", name: "みくさん" });
    expect(fx.text).toContain("ピックアップ出来次第お送りさせて頂きます");
    expect(fx.applied.some((a) => a.startsWith("promise_echo"))).toBe(true);
  });
  it("#13 customer_prior_ref: 顧客が先に「先ほどの物件」に言及 → exempt=customer_ref", () => {
    const cust = "先ほどの物件、駅からどれくらいですか？";
    const text = "先ほどお送りした物件は駅徒歩8分となります！！";
    const hit = checkDonePresupposition(text, mikuLedger, { customerMessage: cust, name: "みくさん" }).find((h) => h.key === "prior_sent_claim");
    expect(hit?.exempt ?? "").toMatch(/^customer_ref/);
  });
  it("#14 other_props_customer_asked: 顧客「他の物件もありますか？」→「他のお部屋もピックアップ」は exempt=customer_asks_more", () => {
    const text = "はい😊！！他のお部屋もピックアップしてお送りさせて頂きます！！";
    const hit = checkDonePresupposition(text, mikuLedger, { customerMessage: "他の物件もありますか？", name: "みくさん" }).find((h) => h.key === "other_properties");
    expect(hit?.exempt).toBe("customer_asks_more");
  });
  it("#15 future_notice_pass: 「集合場所は改めてご連絡させて頂きます」はどの語にも不一致", () => {
    const hits = checkDonePresupposition("かしこまりました！！\n集合場所は改めてご連絡させて頂きます！！", mikuLedger, { customerMessage: "了解です", name: "みくさん" });
    expect(hits).toEqual([]);
    // 顧客が主語の「改めてご条件お送りいただいても」も対象外
    expect(checkDonePresupposition("改めてこちらに現在のご条件お送りいただいてもよろしいでしょうか！！", mikuLedger, { customerMessage: "はい", name: "みくさん" }).filter((h) => h.key === "redo_pickup")).toEqual([]);
  });
  it("#16 redo_viewing_block: 内覧打診なしで「来週再度ご案内」は DONE_PRESUPPOSED(block, missing=[viewingInvited])", () => {
    const hit = checkDonePresupposition("来週再度ご案内させて頂きます！！", propOnly, { customerMessage: "お願いします", name: "〇〇さん" }).find((h) => h.key === "redo_viewing");
    expect(hit?.severity).toBe("block");
    expect(hit?.missing).toEqual(["viewingInvited"]);
    expect(hit?.exempt).toBe(null);
  });
});

describe("往復セル・台帳の細部", () => {
  it("#17 pd_ack: pickup_declared × ack_only → PD_ACK・example「はい😊！！…出来次第お送り」", () => {
    const { pair } = buildPair("よろしくお願いします🙇", MIKU_1040, mikuLedger, { lastStaffAt: T("09-09T10:40") });
    expect(pair.ruleId).toBe("PD_ACK");
    expect(pair.rule?.example ?? "").toMatch(/^はい😊！！\n.*出来次第お送り/);
    const text = "はい😊！！\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！";
    const c = codesOf(text, ctxOf("よろしくお願いします🙇", mikuMessages, mikuLedger, { tpoLabel: pair.rule?.tpoLabel }));
    expect(c).not.toContain("GENERIC_ONLY_REPLY:block");
    expect(c.filter((x) => /PAIR_ELEMENT_MISSING|DONE_PRESUPPOSED/.test(x))).toEqual([]);
  });
  it("#20 line_task_dedup: 手打ち宣言 15:36:00 ＋ line_tasks pending 15:36:05 → pickup_declared 1件（source=line_task, conf2）", () => {
    const l = buildActionLedger({
      messages: [{ sender: "customer", text: MIKU_FORM, createdAt: T("09-09T15:30") }, { sender: "staff", text: MIKU_1040, createdAt: T("09-09T15:36") }],
      lineTasks: [{ task_type: "property_send", status: "pending", created_at: new Date(Date.parse(T("09-09T15:36")) + 5000).toISOString() }],
    });
    const decl = l.entries.filter((e) => e.kind === "pickup_declared");
    expect(decl.length).toBe(1);
    expect(decl[0].source).toBe("line_task");
    expect(decl[0].confidence).toBe(2);
    expect(staffKindOf(decl[0])).toBe("pickup_declared");
  });
  it("ANY_CONDITION_CHANGE: {redo} は送付実績で出し分け（0件→空・example none／≥1→「再度」）", () => {
    const staffOther = "かしこまりました！！フォロー致します！！";
    const cust = "2LDKでお願いします";
    const l0 = buildActionLedger({ messages: [{ sender: "customer", text: MIKU_FORM, createdAt: T("09-09T10:20") }, { sender: "staff", text: staffOther, createdAt: T("09-09T10:40") }, { sender: "customer", text: cust, createdAt: T("09-09T11:45") }], lastCustomerAt: T("09-09T11:45") });
    const a = buildPair(cust, staffOther, l0, { lastStaffAt: T("09-09T10:40") });
    expect(a.pair.ruleId).toBe("ANY_CONDITION_CHANGE");
    expect(a.pair.redo).toBe("");
    expect(buildPairDirection(a.pair, { brainFresh: false }) ?? "").not.toMatch(/再度ピックアップ|再ピックアップ/);
    expect(buildTurnPairNote(a.pair, cust, "みく")).toContain("出来次第お送り");
    const l1 = buildActionLedger({ recentAixRows: sentAix, messages: [{ sender: "customer", text: MIKU_FORM, createdAt: T("09-09T10:20") }, { sender: "staff", text: SENT_BODY, createdAt: T("09-09T11:00") }, { sender: "customer", text: "ありがとうございます", createdAt: T("09-09T11:10") }, { sender: "staff", text: staffOther, createdAt: T("09-09T11:20") }, { sender: "customer", text: cust, createdAt: T("09-09T11:45") }], lastCustomerAt: T("09-09T11:45") });
    const b = buildPair(cust, staffOther, l1, { lastStaffAt: T("09-09T11:20") });
    expect(b.pair.ruleId).toBe("ANY_CONDITION_CHANGE");
    expect(b.pair.redo).toBe("再度");
    expect(buildPairDirection(b.pair, { brainFresh: false }) ?? "").toContain("再度ピックアップ宣言");
    expect(buildTurnPairNote(b.pair, cust, "みく")).toContain("新たにピックアップ");
  });
  it("旧規約互換: 台帳なしの「🌟…ご査収」は property_send、「9万以内」だけの宣言文を送付にしない", () => {
    expect(classifyLastStaffTurn(SENT_BODY).kind).toBe("property_send");
    expect(classifyLastStaffTurn(MIKU_1040).kind).toBe("pickup_declared");
    // 裸の号室は台帳なし＝従来互換で送付扱い、台帳が送付0件なら送付にしない
    expect(classifyLastStaffTurn("エストレーラ 305号室は現在募集中です").kind).toBe("property_send");
    expect(classifyLastStaffTurn("エストレーラ 305号室は現在募集中です", { ledger: mikuLedger }).kind).not.toBe("property_send");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
