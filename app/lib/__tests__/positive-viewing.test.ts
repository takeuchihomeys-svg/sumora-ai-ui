// 2026-09-10 Fable5 Sさん事例（conversation 3890f691 / 2026-09-10 20:24 JST）の回帰テスト 16件。
//   「アーバネックス気になります」→「ご査収頂きありがとうございます＋かしこまりました＋内覧のご案内提案」に
//   到達できることを、A（前向き反応の語彙）・B（lastStaffEntry の選定）・C（往復セル）の3層で固定する。
// 実行: npx tsx app/lib/__tests__/positive-viewing.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import {
  buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask,
} from "../action-ledger";
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveHedgeAllowance,
  resolvePositive, viewingOfferLiteral, isBareViewingOffer,
  VIEWING_OFFER_SOFT_RE, VIEWING_DATE_ASK_RE,
} from "../reply-context";
import { runDeterministicChecks, type FinalCheckContext } from "../final-check";

// ── ミニハーネス（既存テストと同型）──
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
    },
    toMatch(re: RegExp) { if (typeof actual !== "string" || !re.test(actual)) throw new Error(`expected ${JSON.stringify(actual)} to match ${re}`); },
  };
}

// ── Sさん会話の再現（JST 2026-09-10）。引数は "MM-DDTHH:mm:ss" ──
const T = (jst: string) => new Date(`2026-${jst}+09:00`).toISOString();
const S_AIX_1905 = "お送りさせて頂きましたお部屋の中でも特にVinoプレジオ本町501号室が2023年8月築で築年数も新しく、敷金礼金なしで費用を抑える事ができ、かなりオススメ出来るお部屋となります！！\nリビング11帖・洋室6帖の角部屋1LDKでウォークインクローゼットも完備しております！！\nお手隙の際にご査収ください😊！！";
const S_CUST_2024 = "ありがとうございます！\nアーバネックス気になります！";
const S_NG = "アーバネックス気になって頂きありがとうございます😊！！\nかしこまりました！！";
const S_OK = "ご査収頂きありがとうございます😊！！\nかしこまりました！！\nよろしければSさんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！";
const SENT_NAMES = ["アーバネックス谷町四丁目 1102号室", "Vinoプレジオ本町 501号室"];

const sAix: LedgerAixRow[] = [
  { aix_type: "property_recommendation", created_at: T("09-10T19:05:15"), sent_at: T("09-10T19:04:13"), generated_text: S_AIX_1905, property_names: SENT_NAMES },
];
/** AIX 送信が全 pending タスクを直後に completed にする（result は NULL のまま＝顧客に報告していない） */
const sTask: LedgerTask[] = [
  { task_type: "property_check", status: "completed", created_at: T("09-10T19:00:35"), completed_at: T("09-10T19:04:14"), result: null },
];
const sMessages = (cust: string): LedgerMessage[] => [
  { sender: "customer", text: "よろしくお願いします", createdAt: T("09-10T18:30:00") },
  { sender: "staff", text: S_AIX_1905, createdAt: T("09-10T19:05:15") },
  { sender: "customer", text: cust, createdAt: T("09-10T20:24:00") },
];
const sLedger = (cust: string, tasks: LedgerTask[] = sTask) => buildActionLedger({
  recentAixRows: sAix, messages: sMessages(cust), lineTasks: tasks,
  lastCustomerAt: T("09-10T20:24:00"), now: Date.parse(T("09-10T20:25:00")),
});

/** route.ts と同じ順序で往復文脈を組む */
const buildPair = (cust: string, staffText: string, ledger: ReturnType<typeof buildActionLedger>, opts: { lastStaffAt?: string; custAt?: string; name?: string } = {}) => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: opts.lastStaffAt ?? null, ledger });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, { ledger });
  const hedge = resolveHedgeAllowance({ customerMessage: cust, substance: sub, staff, customer, lastStaffText: staffText, lastCustomerAt: opts.custAt ?? null, ledger });
  const pair = resolveTurnPair(staff, customer, sub, staffText, { searched: hedge.searched.yes, ledger, customerName: opts.name ?? "S" });
  return { staff, sub, customer, hedge, pair };
};
const ctxOf = (cust: string, ledger: ReturnType<typeof buildActionLedger>, pair: ReturnType<typeof buildPair>["pair"], sub: ReturnType<typeof analyzeSubstance>): FinalCheckContext => ({
  lastCustomerMessage: cust,
  recentMessages: sMessages(cust).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt })),
  customerName: "S", ledger, ledgerStrict: true, substance: sub, pairContext: pair,
});
const issuesOf = (text: string, ctx: FinalCheckContext) => runDeterministicChecks(text, ctx);
const codesOf = (text: string, ctx: FinalCheckContext) => issuesOf(text, ctx).map((i) => `${i.code}:${i.severity}`);

// ─────────────────────────────────────────────────────────────
describe("Sさん 20:24（原因A+B+C の統合）", () => {
  const L = sLedger(S_CUST_2024);
  const P = buildPair(S_CUST_2024, S_AIX_1905, L, { lastStaffAt: T("09-10T19:05:15"), custAt: T("09-10T20:24:00") });

  it("T-01 セル解決: property_send × positive(appraisal) → PS_POSITIVE", () => {
    expect(P.staff.kind).toBe("property_send");
    expect(P.customer.kind).toBe("positive");
    expect(P.customer.positive?.kind).toBe("appraisal");
    expect(P.customer.positive?.source).toBe("regex");
    expect(P.pair.ruleId).toBe("PS_POSITIVE");
    // 旧実装: residue は正しく取れているのに statement 止まりで customer=other → ruleId=null だった
    expect(P.sub.kinds).toContain("positive");
    expect(P.sub.kinds).not.toContain("statement");
    expect(P.sub.has).toBe(true);
  });

  it("T-02 materials: ご査収ください（staffSent）× ありがとう（customerSaw）→ thanksAllowed", () => {
    expect(P.pair.materials.staffSent).toBe(true);
    expect(P.pair.materials.staffEvidence).toMatch(/ご査収ください|お送りさせて頂きました/);
    expect(P.pair.materials.customerSaw).toBe(true);
    expect(P.pair.materials.customerEvidence).toBe("ありがとう");
    expect(P.pair.materials.thanksAllowed).toBe(true);
    // 顧客が指名した物件は台帳の送付済み物件名との照合が一次証拠
    expect(P.pair.namedProperty.asWritten).toBe("アーバネックス");
    expect(P.pair.namedProperty.matchedSent).toBe(true);
    expect(P.pair.namedProperty.count).toBe(1);
    // 内覧提案リテラルはスタッフ実送信の3行目と一字一句同じ
    expect(viewingOfferLiteral("S", true, 1)).toBe("よろしければSさんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！");
  });

  it("T-03 スタッフ実送信（正解）は骨格系 block ゼロ", () => {
    const c = codesOf(S_OK, ctxOf(S_CUST_2024, L, P.pair, P.sub));
    expect(c.filter((x) => /^(WE_DO_MISSING_DET|EMPTY_CLOSER|PAIR_ELEMENT_MISSING|VIEWING_DATE_ASK_WITHOUT_AIX|VIEWING_OFFER_NAME_ECHO)/.test(x))).toEqual([]);
    expect(VIEWING_OFFER_SOFT_RE.test(S_OK)).toBe(true);
    expect(VIEWING_DATE_ASK_RE.test(S_OK)).toBe(false);
    expect(isBareViewingOffer(S_OK)).toBe(false);
  });

  it("T-04 AI生成 NG 文が捕まり、修正案に内覧提案のリテラルが入る", () => {
    const ctx = ctxOf(S_CUST_2024, L, P.pair, P.sub);
    const issues = issuesOf(S_NG, ctx);
    const codes = issues.map((i) => `${i.code}:${i.severity}`);
    expect(codes).toContain("EMPTY_CLOSER:block");
    expect(codes).toContain("PAIR_ELEMENT_MISSING:block");
    const sug = issues.filter((i) => i.code === "EMPTY_CLOSER" || i.code === "PAIR_ELEMENT_MISSING").map((i) => i.suggestion).join("／");
    expect(sug).toContain("ご都合よろしいお日にちにお部屋ご案内させて頂きます");
    expect(sug).not.toContain("{viewingOffer}");
  });

  it("T-05 T3（brain なし）でも同じセルに到達する（brain の値を1つも参照しない）", () => {
    const staff = classifyLastStaffTurn(S_AIX_1905, { recentAixRows: [], lastStaffAt: T("09-10T19:05:15"), ledger: L });
    const sub = analyzeSubstance(S_CUST_2024);
    const customer = classifyCustomerResponse(sub, staff, { ledger: L, brain: null });
    const pair = resolveTurnPair(staff, customer, sub, S_AIX_1905, { ledger: L, customerName: "S" });
    expect(pair.ruleId).toBe("PS_POSITIVE");
    expect(pair.customer.positive?.kind).toBe("appraisal");
  });
});

// ─────────────────────────────────────────────────────────────
describe("原因B: 台帳の直前スタッフ発言", () => {
  it("T-06 lastStaffEntry が1秒後の社内記帳行に奪われない（aix_log/conf3 が勝つ）", () => {
    const L = sLedger(S_CUST_2024);
    expect(L.facts.lastStaffEntry?.kind).toBe("properties_sent");
    expect(L.facts.lastStaffEntry?.source).toBe("aix_log");
    expect(L.facts.lastStaffEntry?.confidence).toBe(3);
  });

  it("T-07 result=NULL の property_check=completed は「報告済み」にしない", () => {
    const L = sLedger(S_CUST_2024);
    expect(L.entries.some((e) => e.kind === "confirmation_reported")).toBe(false);
    expect(L.facts.confirmationReported).toBe(false);
  });

  it("T-08 result 非 NULL なら従来どおり報告扱い。それでも直前発言は aix_log の物件送付", () => {
    const L = sLedger(S_CUST_2024, [{ ...sTask[0], result: "available" }]);
    const rep = L.entries.find((e) => e.kind === "confirmation_reported");
    expect(rep?.status).toBe("done");
    expect(rep?.source).toBe("line_task");
    expect(rep?.detail.checkPattern).toBe("available");
    // conf2/line_task は conf3/aix_log に勝てない（旧実装は 0.898 秒差で勝っていた）
    expect(L.facts.lastStaffEntry?.kind).toBe("properties_sent");
    expect(L.facts.lastStaffEntry?.source).toBe("aix_log");
  });
});

// ─────────────────────────────────────────────────────────────
describe("原因A: 前向き反応の下位種別", () => {
  it("T-09 「良さそうですね」（物件名なし・資料送付直後）は appraisal。内覧提案は『お気に召されましたら』型", () => {
    const cust = "良さそうですね";
    const L = sLedger(cust);
    const { pair, sub } = buildPair(cust, S_AIX_1905, L, { lastStaffAt: T("09-10T19:05:15"), custAt: T("09-10T20:24:00") });
    expect(sub.has).toBe(true);                       // 7字でも positive なら実質あり
    expect(pair.customer.positive?.kind).toBe("appraisal");
    expect(pair.ruleId).toBe("PS_POSITIVE");
    expect(pair.namedProperty.asWritten).toBe(null);
    expect(viewingOfferLiteral("S", pair.namedProperty.matchedSent, pair.namedProperty.count))
      .toBe("Sさんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！");
  });

  it("T-10 「内見したいです」（T2 明示）は viewing_explicit。内覧提案が block で要求される", () => {
    const cust = "内見したいです";
    const L = sLedger(cust);
    const { pair, sub } = buildPair(cust, S_AIX_1905, L, { lastStaffAt: T("09-10T19:05:15"), custAt: T("09-10T20:24:00") });
    expect(pair.customer.kind).toBe("positive");
    expect(pair.customer.positive?.kind).toBe("viewing_explicit");
    const c = codesOf("かしこまりました！！\n募集状況確認させて頂きます！！", ctxOf(cust, L, pair, sub));
    expect(c).toContain("PAIR_ELEMENT_MISSING:block");
  });

  it("T-11 「内見などはできますか？？」は質問ではなく内覧受付（ANY_QUESTION に落ちない）", () => {
    const cust = "内見などはできますか？？";
    const L = sLedger(cust);
    const { pair } = buildPair(cust, S_AIX_1905, L, { lastStaffAt: T("09-10T19:05:15"), custAt: T("09-10T20:24:00") });
    expect(pair.customer.kind).toBe("positive");
    expect(pair.customer.positive?.kind).toBe("viewing_explicit");
    expect(pair.customer.secondary).toContain("question");
    expect(pair.ruleId).not.toBe("ANY_QUESTION");
    expect(pair.ruleId).toBe("PS_POSITIVE");
  });

  it("T-12 資料未送付（条件ヒアリング直後）の「気になります」は positive にしない（T1 単独発火の禁止）", () => {
    const askStaff = "Sさんお世話になっております！！\n①【ご入居の時期】⇒\n②【ご希望家賃】⇒\n③【間取り】⇒";
    const cust = "アーバネックス気になります";
    const L = buildActionLedger({
      messages: [
        { sender: "staff", text: askStaff, createdAt: T("09-10T19:00:00") },
        { sender: "customer", text: cust, createdAt: T("09-10T20:24:00") },
      ],
      lastCustomerAt: T("09-10T20:24:00"),
    });
    const staff = classifyLastStaffTurn(askStaff, { lastStaffAt: T("09-10T19:00:00"), ledger: L });
    const sub = analyzeSubstance(cust);
    expect(staff.kind).toBe("condition_ask");
    expect(resolvePositive(sub, staff, L)).toBe(null);
    const pair = resolveTurnPair(staff, classifyCustomerResponse(sub, staff, { ledger: L }), sub, askStaff, { ledger: L, customerName: "S" });
    expect(pair.customer.kind).not.toBe("positive");
    expect(pair.ruleId).not.toBe("PS_POSITIVE");
  });

  it("T-13 物件名のみの短文は台帳の送付済み物件名と一致した時だけ昇格する（source=ledger_named）", () => {
    const cust = "アーバネックス";
    const L = sLedger(cust);
    const { pair } = buildPair(cust, S_AIX_1905, L, { lastStaffAt: T("09-10T19:05:15"), custAt: T("09-10T20:24:00") });
    expect(pair.customer.positive?.kind).toBe("appraisal");
    expect(pair.customer.positive?.source).toBe("ledger_named");
    expect(pair.ruleId).toBe("PS_POSITIVE");
    // 台帳に送付済み物件が無ければ昇格しない（誤検出源なので単独では採らない）
    const bare = buildActionLedger({ messages: sMessages(cust), lastCustomerAt: T("09-10T20:24:00") });
    const staff = classifyLastStaffTurn(S_AIX_1905, { lastStaffAt: T("09-10T19:05:15"), ledger: bare });
    expect(resolvePositive(analyzeSubstance(cust), staff, bare)).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────
describe("原因C: [X]型と[Y]型の分離", () => {
  const L = sLedger(S_CUST_2024);
  const P = buildPair(S_CUST_2024, S_AIX_1905, L, { lastStaffAt: T("09-10T19:05:15"), custAt: T("09-10T20:24:00") });

  it("T-14 [X]型（AIX 専用の候補日時確認）を通常返信で書いたら block", () => {
    const draft = "ご査収頂きありがとうございます😊！！\nかしこまりました！！\nお部屋ご案内させて頂きます！！\nSさんご都合よろしいお日にち御座いますでしょうか😊！！";
    const c = codesOf(draft, ctxOf(S_CUST_2024, L, P.pair, P.sub));
    expect(c).toContain("VIEWING_DATE_ASK_WITHOUT_AIX:block");
  });

  it("T-15 条件節なしの裸型は [Y] に一致せず PAIR_ELEMENT_MISSING が出る", () => {
    const draft = "ご査収頂きありがとうございます😊！！\nかしこまりました！！\nSさんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！";
    expect(VIEWING_OFFER_SOFT_RE.test(draft)).toBe(false);
    expect(isBareViewingOffer(draft)).toBe(true);
    const c = codesOf(draft, ctxOf(S_CUST_2024, L, P.pair, P.sub));
    expect(c).toContain("PAIR_ELEMENT_MISSING:block");
  });

  it("T-16 内覧提案の文で物件名を復唱したら warning（内覧は物件非依存）", () => {
    const draft = "ご査収頂きありがとうございます😊！！\nかしこまりました！！\nよろしければアーバネックスをご都合よろしいお日にちにご案内させて頂きます😌！！";
    const c = codesOf(draft, ctxOf(S_CUST_2024, L, P.pair, P.sub));
    expect(c).toContain("VIEWING_OFFER_NAME_ECHO:warning");
    // 正解文（物件名なし）では出ない
    expect(codesOf(S_OK, ctxOf(S_CUST_2024, L, P.pair, P.sub))).not.toContain("VIEWING_OFFER_NAME_ECHO:warning");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
