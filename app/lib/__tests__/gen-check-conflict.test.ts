// 2026-09-11 統合設計: 返信生成と最終チェックの衝突解消（経路 A〜G）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/gen-check-conflict.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
// フィクスチャは調査で使った実文（YUYA / it_0 / ﾓﾓｶ / 慶次 / うえっち / 🐥 / 楓馬 / みく）。DB への書き込みは無い。
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveHedgeAllowance,
  fillPairPlaceholders, fillNameSlot, hasDirectAnswer, resolvePickupGate, viewingOfferLiteral, selectPairExample,
  isCellRequiredSentence, pickupRound, PAIR_MATRIX, type PairContext,
} from "../reply-context";
import { runDeterministicChecks, pairElementSuggestion, passTimeoutMs, skeletonBlockCodes, cellElementGaps, type FinalCheckContext } from "../final-check";
import { enforceAixGates, validateAndClean, normalizeCustomerName } from "../validate-reply";
import { buildActionLedger, applyLedgerAutoFix, type LedgerAixRow } from "../action-ledger";

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
const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

const T = (iso: string) => new Date(iso).toISOString();
const SKELETON = /^(WE_DO_MISSING_DET|REPLY_SKELETON_MISSING|PAIR_ELEMENT_MISSING|EMPTY_CLOSER|GENERIC_ONLY_REPLY)$/;
const OTHER_CUSTOMER_RE = /スプランディッド|エストレーラ|メロディーハイム|梅田|枚方|高槻|9月13日|換気|防虫|ブラウン|夜職|ブラック|トイレ|洗面/;
const PLACEHOLDER_RE = /[〇○]{2}\s*(?:さん|様)|\{[a-zA-Z_]+\}/;
const namesIn = (s: string) => [...s.matchAll(/([^\s「」『』、。！!\n（）()]{1,6})さん/g)].map((m) => m[1]);

/** 直前スタッフ1通＋顧客1通の往復から ctx を作る（ledger / staff は上書き可） */
function ctxOf(cust: string, staffText: string, name: string, extra: { ledger?: ReturnType<typeof buildActionLedger>; lastAixHistory?: string; tpoLabel?: string; priorCustomerText?: string } = {}) {
  const msgs = [
    ...(extra.priorCustomerText ? [{ sender: "customer", text: extra.priorCustomerText, createdAt: T("2026-09-10T12:00:00Z") }] : []),
    ...(staffText ? [{ sender: "staff", text: staffText, createdAt: T("2026-09-11T03:00:00Z") }] : []),
    { sender: "customer", text: cust, createdAt: T("2026-09-11T04:00:00Z") },
  ];
  const ledger = extra.ledger ?? buildActionLedger({ recentAixRows: [], messages: msgs, lineTasks: [], lastCustomerAt: T("2026-09-11T04:00:00Z"), now: Date.parse(T("2026-09-11T04:01:00Z")) });
  const staff = classifyLastStaffTurn(staffText, { lastStaffAt: staffText ? T("2026-09-11T03:00:00Z") : null, ledger, lastAixHistory: extra.lastAixHistory ?? null });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, { ledger });
  const pair = resolveTurnPair(staff, customer, sub, staffText, { ledger, customerName: name, priorCustomerText: extra.priorCustomerText ?? "" });
  const ctx: FinalCheckContext = { lastCustomerMessage: cust, recentMessages: msgs, customerName: name, ledger, ledgerStrict: true, substance: sub, pairContext: pair, tpoLabel: extra.tpoLabel };
  return { pair, sub, ledger, staff, customer, ctx };
}
const issuesOf = (text: string, c: { ctx: FinalCheckContext }) => runDeterministicChecks(text, c.ctx);
const blockCodes = (text: string, c: { ctx: FinalCheckContext }) => issuesOf(text, c).filter((i) => i.severity === "block").map((i) => i.code);

// ══════════ フィクスチャ: YUYA（2026-09-11 04:59 生成・経路F1/E1/A）══════════
const YUYA_CUST = "家賃は共益費込みでの値段なのでお願いいたします🙇‍♂️\n\n条件等多くて申し訳ないですが宜しくお願いいたします🙇‍♂️";
const YUYA_STAFF_0314 = "かしこまりました！！\n条件お送り頂きありがとうございます😊！！\n\n保証会社ご希望の件・冷蔵庫スペースの件・独立洗面台の件全て理解いたしました！！\n\n10月末ご入居希望、家賃5〜6万円、阪急梅田〜十三・南方、御堂筋線東三国〜なんば、四つ橋線西梅田〜なんば、JR環状線大阪駅から1駅、徒歩10分前後、初期費用15〜19万円以下のご条件と、審査に通りやすい保証会社よお部屋を中心に、独立洗面台の条件以外を満たした家賃安めな物件と、全ての条件を出来るだけ満たしてる物件の2パターンで新たにピックアップしてお送りさせて頂きます😌！！\n\nYUYAさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！";
const YUYA_STAFF_ACTUAL = "全然です！！YUYAさんがご満足頂けるお部屋でお引越し出来るのが1番ですので、ご要望等出てきましたら、いつでもお気軽にご連絡ください！！\n物件ピックアップ出来ましたらお送りさせて頂きます！！";
const YUYA_GEN2 = "かしこまりました😊！！\n\n家賃は管理費込みで5〜6万円のご条件として、阪急梅田〜十三・南方、御堂筋線東三国〜なんば、四つ橋線西梅田〜なんば、JR環状線大阪駅から1駅でYUYAさんにオススメできるお部屋をピックアップさせて頂きます！！\n\nYUYAさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！";
const YUYA_EMPTY = "かしこまりました😊！！\n\n何卒よろしくお願い致します！！";
const yuyaAix: LedgerAixRow[] = [
  { aix_type: "estimate_sheet", created_at: T("2026-08-25T05:02:59Z"), sent_at: T("2026-08-25T05:02:57Z"), generated_text: "【メゾンベルキャステル 402号室】\n初期費用：146,380円", estimate_sent: true },
  { aix_type: "condition_hearing", created_at: T("2026-08-27T04:22:36Z"), sent_at: T("2026-08-27T04:22:34Z") },
  { aix_type: "property_send", created_at: T("2026-08-28T09:37:50Z"), sent_at: T("2026-08-28T09:37:49Z") },
  { aix_type: "property_recommendation", created_at: T("2026-08-28T09:39:09Z"), sent_at: T("2026-08-28T09:39:08Z"), generated_text: "🌟メゾンベルキャステル 402" },
  { aix_type: "property_recommendation", created_at: T("2026-08-29T06:02:40Z"), sent_at: T("2026-08-29T06:02:38Z"), generated_text: "🌟ビューテラス塚本 402" },
  { aix_type: "property_recommendation", created_at: T("2026-09-08T08:13:13Z"), sent_at: T("2026-09-08T08:13:12Z"), generated_text: "🌟フレア新大阪 406" },
];
const yuyaMsgs = [
  { sender: "customer", text: "条件フォーム", createdAt: T("2026-09-11T01:10:03Z") },
  { sender: "staff", text: YUYA_STAFF_0314, createdAt: T("2026-09-11T03:14:32Z") },
  { sender: "customer", text: YUYA_CUST, createdAt: T("2026-09-11T04:57:52Z") },
];
const yuyaLedger = buildActionLedger({ recentAixRows: yuyaAix, messages: yuyaMsgs, lineTasks: [{ task_type: "property_send", status: "pending", created_at: T("2026-09-11T01:13:48Z") }], lastCustomerAt: T("2026-09-11T04:57:52Z"), now: Date.parse("2026-09-11T04:59:14Z") });
const yuya = (() => {
  const staff = classifyLastStaffTurn(YUYA_STAFF_0314, { recentAixRows: yuyaAix, lastStaffAt: T("2026-09-11T03:14:32Z"), ledger: yuyaLedger });
  const sub = analyzeSubstance(YUYA_CUST, undefined, { staffAskedQuestion: false });
  const customer = classifyCustomerResponse(sub, staff, { ledger: yuyaLedger });
  const hedge = resolveHedgeAllowance({ customerMessage: YUYA_CUST, substance: sub, staff, customer, lastStaffText: YUYA_STAFF_0314, lastCustomerAt: T("2026-09-11T04:57:52Z"), ledger: yuyaLedger });
  const pair = resolveTurnPair(staff, customer, sub, YUYA_STAFF_0314, { searched: hedge.searched.yes, ledger: yuyaLedger, customerName: "YUYA" });
  const ctx: FinalCheckContext = { lastCustomerMessage: YUYA_CUST, recentMessages: yuyaMsgs, customerName: "YUYA", ledger: yuyaLedger, ledgerStrict: true, substance: sub, pairContext: pair, hedge };
  return { staff, sub, customer, pair, ctx };
})();

describe("経路F 後処理ゲートと必須要素（YUYA / it_0 / 楓馬）", () => {
  it("T01 YUYA: 送付後の未履行ピックアップ宣言 → resolvePickupGate は再宣言禁止にしない", () => {
    expect(yuya.pair.ruleId).toBe("PD_CONDITION_CHANGE");
    const g = resolvePickupGate(true, yuya.pair);
    expect(g.redeclareBlocked).toBe(false);
    ok(/送付後の未履行/.test(g.reason), `reason=${g.reason}`);
    // 解除条件が何も無ければ従来どおり禁止（ゲート自体を無効化していない）
    const plain = ctxOf("ありがとうございます", "🌟グランドメゾン 302号室\nお手隙の際にご査収ください😌！！", "あみ");
    expect(resolvePickupGate(true, plain.pair).redeclareBlocked).toBe(true);
  });

  it("T02 YUYA: GEN2 を protect 付きでゲートに通しても必須要素が残り、骨格系 block（PAIR_ELEMENT_MISSING / EMPTY_CLOSER）が出ない", () => {
    const v = validateAndClean(YUYA_GEN2, {
      aixGates: true, customerName: "YUYA", estimatePromised: true, customerMessage: YUYA_CUST, lastStaffMsg: YUYA_STAFF_0314,
      aixPickupDone: true, protect: (s) => isCellRequiredSentence(s, yuya.pair),
    });
    ok(/ピックアップ出来次第お送り/.test(v.cleaned), `cleaned=${v.cleaned}`);
    ok(/5〜6万円のご条件として/.test(v.cleaned), "条件復唱の宣言が見積金額内訳ゲートで置換された");
    const sk = skeletonBlockCodes(v.cleaned, yuya.ctx);
    expect(sk.includes("EMPTY_CLOSER")).toBe(false);
    // 2026-09-11 竹内方針1: PAIR_ELEMENT_MISSING は info になったので、安全弁は severity 非依存の cellElementGaps で比べる（ゲートで欠落が増えない）
    expect(cellElementGaps(v.cleaned, yuya.ctx)).toEqual(cellElementGaps(YUYA_GEN2, yuya.ctx));
  });

  it("T03 YUYA: スタッフの実際の正解「物件ピックアップ出来ましたらお送り」はゲートで削除されない（PICKUP_KEEP_RE）", () => {
    const r = enforceAixGates(YUYA_STAFF_ACTUAL, { aixPickupDone: true });
    ok(/物件ピックアップ出来ましたらお送りさせて頂きます/.test(r.cleaned), r.cleaned);
    expect(r.violations.length).toBe(0);
  });

  it("T04 it_0: ゲートで削った位置（末尾）に「かしこまりました」を入れない → EMPTY_CLOSER を作らない", () => {
    const it0 = "itさんお世話になっております！！\nルームシェアの件、決まり次第で構いませんので教えてください！！\n\nその間も条件に近いお部屋がございましたら引き続きピックアップしてお送りさせて頂きます！！";
    const r = enforceAixGates(it0, { aixPickupDone: true });
    ok(!r.cleaned.trim().endsWith("かしこまりました😊！！"), `末尾に挿入された: ${r.cleaned}`);
    ok(r.cleaned.split("\n")[1] === "かしこまりました😊！！", `挨拶行の直後に入る: ${JSON.stringify(r.cleaned)}`);
    const c = ctxOf("今ルームシェアの話が知人から出ていてまた決まり次第ご連絡してもいいでしょうか", "お手隙の際にご査収ください😌！！", "it");
    expect(issuesOf(r.cleaned, c).some((i) => i.code === "EMPTY_CLOSER")).toBe(false);
    expect(r.edits.some((e) => e.rule === "ピックアップ再宣言" && e.reversible)).toBe(true);
  });

  it("T05 楓馬: 顧客条件の復唱（家賃9万円〜13万円）は見積金額内訳ゲートで置換しない", () => {
    const s = "三国ヶ丘・百舌鳥周辺全域から家賃9万円〜13万円・2LDK・徒歩10分以内で楓馬さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！";
    const r = enforceAixGates(s, { customerMessage: "三国ヶ丘・百舌鳥周辺で家賃9万円〜13万円の2LDKを探しています", estimatePromised: false });
    expect(r.violations.some((v) => /見積金額内訳/.test(v))).toBe(false);
    expect(r.cleaned).toBe(s);
  });

  it("T06 楓馬（逆側の担保）: 物件固有の費用内訳「敷金50,000円・礼金1ヶ月分」は従来どおり置換される", () => {
    const r = enforceAixGates("敷金50,000円・礼金1ヶ月分となります！！", { customerMessage: "初期費用はいくらですか？" });
    expect(r.violations.some((v) => /見積金額内訳/.test(v))).toBe(true);
  });
});

describe("経路C 回答検出（ﾓﾓｶ / 慶次 / 人の実送信）", () => {
  const VI_STAFF = "16時30分よりお部屋ご案内させて頂きます！！";
  const MOMOKA_CUST = "お時間どのくらいを予定してますか？";
  it("T07 ﾓﾓｶ:「1時間程度を予定しております😊！！」は回答＝骨格系 block 0件", () => {
    const c = ctxOf(MOMOKA_CUST, VI_STAFF, "ﾓﾓｶ");
    expect(c.pair.ruleId).toBe("ANY_QUESTION");
    const draft = "内覧のお時間については1時間程度を予定しております😊！！\n\nご都合よろしいお日にちが決まりましたら教えてください！！";
    expect(blockCodes(draft, c).filter((x) => SKELETON.test(x))).toEqual([]);
  });

  it("T08 人の実送信「15分から30分程となります😊！！」（絵文字の後置）で WE_DO_MISSING_DET が block にならない", () => {
    const c = ctxOf(MOMOKA_CUST, VI_STAFF, "C");
    expect(blockCodes("15分から30分程となります😊！！", c).includes("WE_DO_MISSING_DET")).toBe(false);
  });

  it("T09 慶次: 依頼形の質問（物件はないですか）への探索宣言は回答（questionForm=request・PAIR_ELEMENT_MISSING の block なし）", () => {
    const cust = "労働条件通知書の他への提出はコンプライアンス違反になる為出せないので\n在籍証明を用意しますので少しお時間ください。\n北区、福島区ではやはりいい条件の物件はないですか？";
    const c = ctxOf(cust, "在籍証明をご用意頂けますでしょうか？", "慶次");
    expect(c.pair.customer.kind).toBe("question");
    expect(c.pair.customer.questionForm ?? null).toBe("request");
    const draft = "かしこまりました！！\n在籍証明のご用意、何卒よろしくお願い致します！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！";
    expect(blockCodes(draft, c).includes("PAIR_ELEMENT_MISSING")).toBe(false);
  });

  it("T10 対象語の無い先送り「確認出来次第改めてご連絡」だけの返信は回答ではない（PAIR_ELEMENT_MISSING が残る）", () => {
    const c = ctxOf("現地集合は可能ですか？", "", "B");
    const draft = "かしこまりました！！\n確認出来次第改めてご連絡させて頂きます！！";
    expect(issuesOf(draft, c).some((i) => i.code === "PAIR_ELEMENT_MISSING")).toBe(true);
  });

  it("T11 定型句（ありがとうございます／何卒よろしく）だけでは回答にならない（甘さの是正）", () => {
    expect(hasDirectAnswer("ありがとうございます😊！！何卒よろしくお願い致します！！", "info").yes).toBe(false);
    expect(hasDirectAnswer("駐車場はございません😊！！", "info").yes).toBe(true);
    expect(hasDirectAnswer("審査通過後のご案内という流れになります😊！！", "info").yes).toBe(true);
  });
});

describe("経路D 締め・探索終了のお礼（うえっち）", () => {
  const DECLINE_ACK = "かしこまりました！！\nまたお部屋探しをされる際はいつでもお気軽にご連絡ください😊！！\nその際はうえっちさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！\nこの度はありがとうございました！！";
  const UECCHI_CUST = "こちらこそ色々探してもらってありがとうございました。";
  const u = () => ctxOf(UECCHI_CUST, DECLINE_ACK, "うえっち", { lastAixHistory: "最新:property_check_result", priorCustomerText: "転勤の件無くなりましたので今回は見送りでお願いします" });

  it("T12 締め文は farewell_ack（7日前の AIX 履歴で check_result にしない）・締め verdict=farewell・セル=ANY_FAREWELL", () => {
    const c = u();
    expect(c.staff.kind).toBe("farewell_ack");
    expect(c.sub.isAckOnly).toBe(true);
    expect(c.pair.closing.kind).toBe("farewell");
    expect(c.pair.ruleId).toBe("ANY_FAREWELL");
  });

  it("T13 短いお礼返し／★実送信（全力サポート付き）はどちらも骨格系 block 0件", () => {
    const c = u();
    expect(blockCodes("こちらこそありがとうございました😊！！", c).filter((x) => SKELETON.test(x))).toEqual([]);
    expect(blockCodes(DECLINE_ACK, c).filter((x) => SKELETON.test(x))).toEqual([]);
  });

  it("T14 締めの場面で「足す」系（骨格系）と「削る」系が同時に出ない", () => {
    const c = u();
    const draft = "はい！！\nうえっちさんこちらこそ、色々ご検討いただきありがとうございました😊！！\nまたお部屋探しをされる際はいつでもお気軽にご連絡ください！！うえっちさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
    expect(issuesOf(draft, c).filter((i) => SKELETON.test(i.code) && i.severity !== "info").map((i) => i.code)).toEqual([]);
    // 締めで前進提案を入れたら削る指示（warning）だけが出る
    const push = "こちらこそありがとうございました😊！！\n引き続きオススメできるお部屋ピックアップしてお送りさせて頂きます！！";
    const iss = issuesOf(push, c);
    expect(iss.some((i) => i.code === "CLOSING_FORWARD_PUSH" && i.severity === "warning")).toBe(true);
    expect(iss.filter((i) => SKELETON.test(i.code) && i.severity !== "info").map((i) => i.code)).toEqual([]);
  });

  it("T15 断り（今回は見送り）× ANY_DECLINE の example は WE_DO_MISSING_DET / GENERIC_ONLY_REPLY の block なし", () => {
    const c = ctxOf("転勤の件無くなりましたので今回は見送りでお願いします", "🌟グランドメゾン 302号室\nお手隙の際にご査収ください😌！！", "うえっち");
    expect(c.pair.closing.kind).toBe("decline");
    expect(c.pair.ruleId).toBe("ANY_DECLINE");
    const ex = PAIR_MATRIX.find((r) => r.id === "ANY_DECLINE")!.example;
    const b = blockCodes(ex, c);
    expect(b.includes("WE_DO_MISSING_DET") || b.includes("GENERIC_ONLY_REPLY")).toBe(false);
  });

  it("T15b「本日は内覧ありがとうございました」は ack_only だが締めにしない（内覧後の前進場面）", () => {
    const c = ctxOf("こちらこそ本日は内覧ありがとうございました！", "本日はご内覧頂きありがとうございました！！", "A");
    expect(c.sub.isAckOnly).toBe(true);
    expect(c.pair.closing.kind).toBe(null);
  });
});

describe("経路B 〇〇 プレースホルダ（🐥）", () => {
  // 懸念セル（{object}/{fix} を持つ）でもプレースホルダが空にならない基底 pair
  const concernBase = (name: string) => ctxOf("2階だと階段の上り下りが不安です", "よろしければご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！", name).pair;

  it("T16 名前不明（🐥）でも全セルの fix / direction / label / example に「〇〇さん」「{token}」が残らない", () => {
    expect(normalizeCustomerName("🐥")).toBe("");
    const base = concernBase("");
    const bad: string[] = [];
    for (const r of PAIR_MATRIX) {
      const p: PairContext = { ...base, rule: r, ruleId: r.id };
      const texts = [
        fillPairPlaceholders(r.direction, p),
        ...r.mustInclude.map((m) => fillPairPlaceholders(m.label, p)),
        ...r.mustInclude.map((m) => pairElementSuggestion(m, p)),
        selectPairExample(p, "2階だと階段の上り下りが不安です").text ?? "",
      ];
      for (const t of texts) if (PLACEHOLDER_RE.test(t)) bad.push(`${r.id}: ${t.slice(0, 50)}`);
    }
    expect(bad).toEqual([]);
    ok(!/[〇○]{2}/.test(viewingOfferLiteral("", false)), viewingOfferLiteral("", false));
  });

  it("T17 後処理 validateAndClean が「〇〇さん」を確定名で埋める／名前不明なら呼びかけ＋助詞ごと削除", () => {
    const draft = "はい😊！！\n本日はありがとうございました！！\n引き続き〇〇さんにオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！";
    const noName = validateAndClean(draft, { aixGates: true, customerName: "" });
    ok(!/[〇○]{2}/.test(noName.cleaned), noName.cleaned);
    ok(/引き続きオススメできる/.test(noName.cleaned), noName.cleaned);
    const miku = validateAndClean(draft, { aixGates: true, customerName: "みく" });
    ok(/みくさんにオススメできる/.test(miku.cleaned), miku.cleaned);
    expect(fillNameSlot("{name}がご満足頂くお部屋", "")).toBe("ご満足頂くお部屋");
  });

  it("T18 applyLedgerAutoFix（名前なし）は〇〇を書かない・台帳に約束が無い感謝返しで PROMISE_ECHO_MISSING を出さない", () => {
    const c = ctxOf("お願いします！", "9/18日の14:00からArtizA南船場のお部屋のご案内させていただきます", "");
    const fx = applyLedgerAutoFix("先ほどお送りした物件はいかがでしょうか！！", c.ledger, { customerMessage: "お願いします！", name: "" });
    ok(fx.applied.length > 0, "自動修正が走っていない");
    ok(!/[〇○]{2}/.test(fx.text), fx.text);
    const draft = "はい😊！！\n当日は現地にてお待ちしております！！";
    const c1 = ctxOf("お願いします！", "9/18日の14:00からArtizA南船場のお部屋のご案内させていただきます", "", { tpoLabel: "感謝返し（短い了承・感謝メッセージ。開口語「はい😊！！」一択）" });
    expect(issuesOf(draft, c1).some((i) => i.code === "PROMISE_ECHO_MISSING")).toBe(false);
    const c2 = ctxOf("お願いします！", "9/18日の14:00からArtizA南船場のお部屋のご案内させていただきます", "", { tpoLabel: "短い了承（直前スタッフ約束への了承）" });
    expect(issuesOf(draft, c2).some((i) => i.code === "PROMISE_ECHO_MISSING")).toBe(false);
  });
});

describe("経路A suggestion の出所", () => {
  it("T19 全セル・全要素の修正案に別顧客の固有名詞・〇〇・未置換トークンが無く、呼びかけは確定名だけ", () => {
    const base = ctxOf("2階だと階段の上り下りが不安です", "よろしければご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！", "ゆい").pair;
    const bad: string[] = [];
    for (const r of PAIR_MATRIX) {
      const p: PairContext = { ...base, rule: r, ruleId: r.id };
      for (const m of r.mustInclude) {
        const s = pairElementSuggestion(m, p);
        if (OTHER_CUSTOMER_RE.test(s)) bad.push(`${r.id}/${m.label}: 他顧客語 ${s.match(OTHER_CUSTOMER_RE)![0]}`);
        if (PLACEHOLDER_RE.test(s)) bad.push(`${r.id}/${m.label}: プレースホルダ`);
        for (const n of namesIn(s)) if (!n.endsWith("ゆい")) bad.push(`${r.id}/${m.label}: 呼びかけ「${n}さん」`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("T20 静的不変条件: 全 mustInclude に fix があり、旧 rule.suggestion フィールドは存在しない", () => {
    expect(PAIR_MATRIX.every((r) => r.mustInclude.every((m) => typeof m.fix === "string" && m.fix.length > 0))).toBe(true);
    expect(PAIR_MATRIX.some((r) => "suggestion" in r)).toBe(false);
  });

  it("T21 YUYA の空本文: 修正案にみくさんの実文（大阪市内・みく）が無く、骨格系の修正案が重複しない", () => {
    const iss = issuesOf(YUYA_EMPTY, yuya);
    const sugs = iss.map((i) => i.suggestion ?? "");
    ok(!sugs.some((s) => /みく|大阪市内に絞/.test(s)), sugs.join(" | "));
    const pem = iss.filter((i) => i.code === "PAIR_ELEMENT_MISSING").map((i) => i.suggestion);
    ok(pem.length > 0, "PAIR_ELEMENT_MISSING が出ていない");
    expect(new Set(pem).size).toBe(pem.length);
  });

  it("T22 M8: 資料送付×顧客が見た証拠がある時は「ご査収頂きありがとうございます」を BANNED_WORD にしない", () => {
    const c = ctxOf("ありがとうございます！すごく気になります", "🌟グランドメゾン 302号室\nお手隙の際にご査収ください😌！！", "あみ");
    expect(c.pair.materials.thanksAllowed).toBe(true);
    const draft = "ご査収頂きありがとうございます😊！！\nかしこまりました！！\nよろしければあみさんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！";
    expect(issuesOf(draft, c).some((i) => i.code === "BANNED_WORD" && /ご査収頂きありがとう/.test(i.evidence))).toBe(false);
    // 資料送付が無い場面では従来どおり禁止語
    const c2 = ctxOf("ありがとうございます！", "かしこまりました！！", "あみ");
    expect(issuesOf("ご査収頂きありがとうございます😊！！", c2).some((i) => i.code === "BANNED_WORD")).toBe(true);
  });
});

describe("経路E 台帳と staff 判定", () => {
  it("T23 みく: condition_hearing AIX で機械的に閉じられた property_send タスクは物件送付に数えない", () => {
    const l = buildActionLedger({
      recentAixRows: [{ aix_type: "condition_hearing", created_at: T("2026-09-08T15:35:22Z"), sent_at: T("2026-09-08T15:35:22Z") }],
      messages: [{ sender: "customer", text: "条件フォーム", createdAt: T("2026-09-08T14:00:00Z") }],
      lineTasks: [{ task_type: "property_send", status: "completed", created_at: T("2026-09-08T14:05:00Z"), completed_at: T("2026-09-08T15:35:23Z") }],
      now: Date.parse(T("2026-09-10T04:24:00Z")),
    });
    expect(l.facts.propertiesSentCount).toBe(0);
    // 物件系 AIX の直後に閉じたタスクは従来どおり送付
    const l2 = buildActionLedger({
      recentAixRows: [{ aix_type: "property_send", created_at: T("2026-09-08T15:35:22Z"), sent_at: T("2026-09-08T15:35:22Z") }],
      messages: [],
      lineTasks: [{ task_type: "property_send", status: "completed", created_at: T("2026-09-08T14:05:00Z"), completed_at: T("2026-09-08T15:35:23Z") }],
    });
    ok(l2.facts.propertiesSentCount >= 1, `sent=${l2.facts.propertiesSentCount}`);
  });

  it("T24 楓馬: 手打ち宣言（staff_text）の1秒後の line_task pending に送信の証拠を吸収させない", () => {
    const decl = "三国ヶ丘・百舌鳥周辺全域から家賃9万円〜13万円・2LDKで楓馬さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！";
    const l = buildActionLedger({
      messages: [{ sender: "customer", text: "条件フォーム", createdAt: T("2026-09-11T03:05:00Z") }, { sender: "staff", text: decl, createdAt: "2026-09-11T03:10:21.641Z" }],
      lineTasks: [{ task_type: "property_send", status: "pending", created_at: "2026-09-11T03:10:22.770Z" }],
    });
    expect(l.facts.lastStaffEntry?.source).toBe("staff_text");
  });

  it("T24b E2: 本文があって regex が外れた時は brain の古い AIX 履歴（最新:）で staff 種別を確定しない", () => {
    const st = classifyLastStaffTurn("承知しました、少々確認します", { lastStaffAt: T("2026-09-11T03:00:00Z"), lastAixHistory: "最新:property_check_result" });
    expect(st.kind).toBe("other");
    const noText = classifyLastStaffTurn("", { lastAixHistory: "最新:property_check_result" });
    expect(noText.kind).toBe("check_result");
  });

  it("T24c E1: ラウンドの文言は pickupRound の1関数（送付済み>0 で「まだ1件も送っていない」を出さない）", () => {
    expect(pickupRound(yuyaLedger).round).toBe("next");
    ok(!/1件も送っていない/.test(fillPairPlaceholders(yuya.pair.rule!.direction, yuya.pair)), "YUYA（送付済み）に「まだ1件も送っていない」が出た");
  });
});

describe("経路G タイムアウト配分・順序依存", () => {
  it("T25 loop2（60s）: 1回目＋再送の合計がチェック枠（28.5s）以内＝修正枠 30s が残る", () => {
    const first = passTimeoutMs("context_check", 28500, 0);
    const second = passTimeoutMs("context_check", 28500 - first, 1);
    ok(first + second <= 28500, `first=${first} second=${second}`);
    ok(60000 - 1000 - 28500 >= 30000, "修正枠が残らない");
    // 締切が無い経路（check-reply 2300ms）は上限そのまま
    expect(passTimeoutMs("context_check", 2300, 0, 2300)).toBe(2300);
  });

  it("T26 M13: 足す系 block がある本文では NANISOTSU_MISPLACED を block/warning にしない", () => {
    const iss = issuesOf(YUYA_EMPTY, yuya);
    ok(iss.some((i) => i.severity === "block" && SKELETON.test(i.code)), "足す系 block が無い（前提が崩れた）");
    expect(iss.some((i) => i.code === "NANISOTSU_MISPLACED" && (i.severity === "block" || i.severity === "warning"))).toBe(false);
  });
});

// ══════════ かぁな（2026-09-11 18:50 生成）: 内部指示の地の文漏れ・気持ちの代弁（同調）══════════
const KAANA_CUST = "コンロのところ少し大きめで広くがいいなって思うんですけど中々ないですよね、、、\n皆同じくらい小さいコンロ2口とかで…";
const KAANA_STAFF = "かぁなさんお送りさせて頂きましたお部屋、お気に召されましたらお部屋ご案内させて頂きます😌！！";
const KAANA_DRAFT = "コンロサイズの懸念を条件に変換して再ピックアップ宣言する場面です。\n\nかぁなさんお送りさせて頂きましたお部屋、コンロサイズ気になりますよね😊！！\n\nコンロ大きめ・広めのキッチンのお部屋を中心に、かぁなさんにオススメできるお部屋再度ピックアップしお送りさせて頂きます！！";
const KAANA_CLEAN = "かしこまりました！！\n\nコンロ大きめ・広めのキッチンのお部屋を中心に、かぁなさんにオススメできるお部屋再度ピックアップしお送りさせて頂きます！！";
describe("かぁな: 地の文漏れ・同調文", () => {
  const kaana = ctxOf(KAANA_CUST, KAANA_STAFF, "かぁな");
  it("T27 内部指示の地の文（〜する場面です）と同調文（〜気になりますよね）を block", () => {
    const codes = blockCodes(KAANA_DRAFT, kaana);
    expect(codes).toContain("SYSTEM_MARKER_LEAK");
    expect(codes).toContain("SYMPATHY_ECHO");
  });
  it("T28 2文を除いた本文ではどちらも出ない", () => {
    const codes = issuesOf(KAANA_CLEAN, kaana).map((i) => i.code);
    expect(codes).not.toContain("SYSTEM_MARKER_LEAK");
    expect(codes).not.toContain("SYMPATHY_ECHO");
  });
  it("T29 確認の質問（〜ないですよね？）は同調文扱いしない", () => {
    const codes = issuesOf("かしこまりました！！\nペットは飼われていないですよね？", kaana).map((i) => i.code);
    expect(codes).not.toContain("SYMPATHY_ECHO");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("\n失敗:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
