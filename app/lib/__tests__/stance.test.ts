// 2026-09-09 Fable5 みく事例: 姿勢（ヘッジゲート・締めポリシー・姿勢ギャップ）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/stance.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveHedgeAllowance, resolveCloser,
  deriveCloserSignals, computeStanceFlags, stripPreemptiveRelax, extractEchoTokens, evalConditionEcho, computeStanceLite,
} from "../reply-context";
import { runDeterministicChecks } from "../final-check";

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
    toContain(item: unknown) { if (!Array.isArray(actual) || !actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    toContainAll(items: string[]) { if (!Array.isArray(actual) || !items.every((i) => actual.includes(i))) throw new Error(`expected ${JSON.stringify(actual)} to contain all ${JSON.stringify(items)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) && actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}

const MIKU_FORM = "ありがとうございます🙇\n以下希望でございます。\n①12月までに\n②9万以内\n③1LDK（できればカウンターキッチン希望）\n④10年以内（できれば）\n⑤梅田まで1本で行ける線\n⑥10分以内\n⑦20万位内\n⑧35㎡以上。この条件では難しいと思うので、条件を変えた場合にいい物件があれば教えてください";
const ASK = "みくさんお世話になっております！！\n①【ご入居の時期】⇒\n②【ご希望家賃】⇒\n③【間取り】⇒\n④【築年数】⇒\n⑤【ご希望エリア】⇒\n⑥【駅徒歩】⇒\n⑦【初期費用の限度額】⇒\n⑧【その他ご希望】⇒";
const build = (cust: string, staffText: string, opts: { aix?: Array<{ aix_type: string; created_at: string }>; custAt?: string; flags?: Parameters<typeof classifyCustomerResponse>[2] } = {}) => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: opts.aix ?? [], lastStaffAt: "2026-09-09T01:00:00Z" });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, opts.flags ?? {});
  const hedge = resolveHedgeAllowance({ customerMessage: cust, substance: sub, staff, customer, lastStaffText: staffText, lastCustomerAt: opts.custAt ?? "2026-09-09T01:39:00Z", recentAixRows: opts.aix ?? [] });
  const pair = resolveTurnPair(staff, customer, sub, staffText, { searched: hedge.searched.yes });
  return { staff, sub, customer, hedge, pair };
};
const codes = (text: string, cust: string, staffText: string, extra: Record<string, unknown> = {}) =>
  runDeterministicChecks(text, { lastCustomerMessage: cust, recentMessages: [{ sender: "staff", text: staffText, createdAt: "2026-09-09T01:00:00Z" }, { sender: "customer", text: cust, createdAt: "2026-09-09T01:39:00Z" }], customerName: "みく", ...extra }).map((i) => `${i.code}:${i.severity}`);

describe("ヘッジ禁止", () => {
  it("H1 みくフォーム: forbid_preemptive・自己ヘッジ検出・NG締めは PREEMPTIVE_HEDGE block", () => {
    const { hedge, pair } = build(MIKU_FORM, ASK, { flags: { isConditionPresented: true } });
    expect(hedge.allowance).toBe("forbid_preemptive");
    expect(hedge.customerSelfHedge.yes).toBe(true);
    expect(pair.ruleId).toBe("CA_CONDITION");
    const ng = "かしこまりました😊！！\n梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n35㎡以上は少し難しい可能性もございますので、条件を1つ変えた場合のご提案もあわせてお送りさせて頂きます😌！！";
    const c = codes(ng, MIKU_FORM, ASK);
    expect(c).toContain("PREEMPTIVE_HEDGE:block");
    expect(c).toContain("CONDITION_RELAX_UNASKED:block");
  });
  it("H2 条件変更（瑞希）: 未探索で「少ない状況でしたので」は FABRICATED_SEARCH_REPORT block", () => {
    const cust = "今回2LDKで探してまして。家賃の希望は以前お伝えしたもので変わらないです";
    const staff = "🌟ライオンズ枚方 302号室\n家賃7.5万円\nお手隙の際にご査収ください😌！！";
    const ng = "かしこまりました！！\n2LDKですと少ない状況でしたので、枚方・高槻まで広げてピックアップさせて頂きます！！";
    expect(codes(ng, cust, staff)).toContain("FABRICATED_SEARCH_REPORT:block");
  });
  it("H3 brain 戦略から代替案節を剥がす", () => {
    expect(stripPreemptiveRelax("希望条件でピックアップ、35㎡未満まで広げた代替案もセットで送付")).toBe("希望条件でピックアップ");
    expect(stripPreemptiveRelax("代替案（条件を変えた再ピックアップ宣言）で応える")).toBe("");
  });
});

describe("ヘッジ許可", () => {
  it("H4 探索後（aix_log）: 過去形の結果報告＋ご査収は通る／未来形は block", () => {
    const cust = "1LDKで8万以内でお願いします";
    const staff = "うのさんお世話になっております！！ご希望条件お聞かせください";
    const aix = [{ aix_type: "property_send_widen", created_at: "2026-09-09T02:00:00Z" }];
    const { hedge } = build(cust, staff, { aix });
    expect(hedge.allowance).toBe("allow_after_search");
    const ok = "うのさんお世話になっております！！\n伏見駅・竹田駅周辺全域からうのさんご希望の1LDK・家賃8万円以内のお部屋ピックアップさせて頂きました！！\n1LDKのご条件ですと合うお部屋が少ない状況でしたので、間取りの範囲を少し広げてピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！";
    const c = codes(ok, cust, staff, { hedge });
    expect(c.some((x) => x.startsWith("PREEMPTIVE_HEDGE") || x.startsWith("FABRICATED_SEARCH_REPORT") || x.startsWith("CONDITION_RELAX_UNASKED"))).toBe(false);
    const future = ok.replace("少ない状況でしたので", "少ない状況になる可能性がございますので");
    expect(codes(future, cust, staff, { hedge })).toContain("PREEMPTIVE_HEDGE:block");
  });
  it("H5 顧客の直接質問: 傾向回答＋探索宣言は通る／探索宣言なしは HEDGE_WITHOUT_SEARCH_DECL", () => {
    const cust = "家賃5万円台で駅近って難しいですか？";
    const staff = "ご希望条件お聞かせください";
    const { hedge } = build(cust, staff);
    expect(hedge.allowance).toBe("allow_on_customer_ask");
    const ok = "傾向として5万円台ですと駅徒歩10分前後が多いですが、〇〇さんのご条件でしっかりピックアップしてお送りさせて頂きます！！";
    expect(codes(ok, cust, staff).some((x) => x.startsWith("HEDGE_WITHOUT"))).toBe(false);
    const ng = "5万円台で駅近は少し難しい状況かと思います！！";
    expect(codes(ng, cust, staff)).toContain("HEDGE_WITHOUT_SEARCH_DECL:block");
  });
});

describe("締めあり", () => {
  it("C1 みく正解文: closer=commit/nanisotsu=true・指摘ゼロ", () => {
    const { pair } = build(MIKU_FORM, ASK, { flags: { isConditionPresented: true } });
    const ok = "かしこまりました😊！！\n\n梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n\nみくさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！\n何卒よろしくお願い致します！！";
    const v = resolveCloser(pair, deriveCloserSignals(ok), { customerName: "みく" });
    expect(v.closer).toBe("commit_until_found"); expect(v.nanisotsu).toBe(true);
    expect(codes(ok, MIKU_FORM, ASK).filter((x) => /HEDGE|RELAX|CLOSER|NANISOTSU|GENERIC|ECHO/.test(x))).toEqual([]);
  });
  it("C2 条件変更（瑞希）: commit・何卒なし。何卒を付けると NANISOTSU_MISPLACED warning", () => {
    const cust = "今回2LDKで探してまして。家賃の希望は以前お伝えしたもので変わらないです";
    const staff = "🌟ライオンズ枚方 302号室\nお手隙の際にご査収ください😌！！";
    const ok = "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
    const { pair } = build(cust, staff);
    expect(pair.ruleId).toBe("PS_CONDITION_CHANGE");
    const v = resolveCloser(pair, deriveCloserSignals(ok), { customerName: "瑞希" });
    expect(v.closer).toBe("commit_until_found"); expect(v.nanisotsu).toBe(false);
    expect(codes(ok + "\n何卒よろしくお願い致します！！", cust, staff, { customerName: "瑞希" })).toContain("NANISOTSU_MISPLACED:warning");
  });
  it("C3 懸念（PS_CONCERN）: 具体宣言のみで伴走締めが無いと CLOSER_MISSING warning", () => {
    const cust = "2階が新生児と階段で不安です";
    const staff = "🌟グランメゾン 205号室\nお手隙の際にご査収ください😌！！";
    const noCloser = "ご要望お聞かせ頂きありがとうございます😊！！\n1階またはエレベーター付きのお部屋を中心にあみさんにオススメできるお部屋再度ピックアップしお送りさせて頂きます！！";
    expect(codes(noCloser, cust, staff, { customerName: "あみ" })).toContain("CLOSER_MISSING:warning");
  });
});

describe("締めなし", () => {
  it("N1 成果物添付: receive_check・全力サポートを重ねると COMMIT_AFTER_DELIVERABLE", () => {
    const cust = "阿波座・本町で2LDK 17万以内でお願いします";
    const staff = "ご希望条件お聞かせください";
    const ok = "rさんお世話になっております！！\n阿波座・本町周辺全域からrさんにオススメできる2LDK・家賃17万円以内のお部屋ピックアップさせて頂きました！！\n🌟レジデンス本町 801号室\nお手隙の際にご査収ください😌！！";
    const { pair } = build(cust, staff);
    expect(resolveCloser(pair, deriveCloserSignals(ok), { customerName: "r" }).closer).toBe("receive_check");
    expect(codes(ok + "\nrさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！", cust, staff, { customerName: "r" })).toContain("COMMIT_AFTER_DELIVERABLE:warning");
  });
  it("N2 日程打診: 疑問形で終える・確定形＋何卒は SCHEDULE_ASSERT_UNCONFIRMED", () => {
    const cust = "月曜日は内覧可能でしょうか？";
    const staff = "🌟ISM大阪城公園 508号室\nお気に召されましたらご都合よろしいお日にち御座いますでしょうか😊！！";
    const ng = "はい！！\n月曜日ご案内させて頂きます！！\n9/7（月）にISM大阪城公園 508号室 現地エントランスお待ち合わせで何卒よろしくお願い致します😊！！";
    const c = codes(ng, cust, staff, { customerName: "前田" });
    expect(c).toContain("SCHEDULE_ASSERT_UNCONFIRMED:warning");
    const ok = "はい！！\nお部屋ご案内可能です😊！！\n9/7（月）【15:00】にISM大阪城公園 508号室 現地エントランスお待ち合わせ如何でしょうか！！";
    expect(codes(ok, cust, staff, { customerName: "前田" }).some((x) => x.startsWith("SCHEDULE_ASSERT"))).toBe(false);
  });
  it("N3 事務往復: 確認宣言で終える・何卒は NANISOTSU_MISPLACED", () => {
    const cust = "シティハイツ千種、メゾン加美北の初期費用も教えてほしいです";
    const staff = "🌟サンコーハイツ 302号室\nお手隙の際にご査収ください😌！！";
    const ng = "かしこまりました！！\nシティハイツ千種・メゾン加美北の初期費用確認させて頂きます😊！！\n何卒よろしくお願い致します😌！！";
    expect(codes(ng, cust, staff)).toContain("NANISOTSU_MISPLACED:warning");
  });
  it("N4 検討中（ES_THINKING）: wait_softly。ごゆっくり＋扉に PASSIVE_CLOSER / HUMBLE_WAIT は出ない", () => {
    const cust = "ありがとうございます。確認して検討します";
    const staff = "御見積書お送りさせて頂きました！！\nお手隙の際にご査収ください😌！！";
    const ok = "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nお気に召されましたらお申込しお部屋抑えさせて頂きますので、気になる点出てきましたらいつでもお気軽にご連絡ください！！";
    const { pair } = build(cust, staff);
    expect(resolveCloser(pair, deriveCloserSignals(ok), { customerName: "愛乃" }).closer).toBe("wait_softly");
    expect(codes(ok, cust, staff, { customerName: "愛乃" }).some((x) => /PASSIVE_CLOSER|HUMBLE_WAIT|CLOSER_MISSING/.test(x))).toBe(false);
  });
});

describe("姿勢ギャップ", () => {
  it("S1 具体復唱: 抽象宣言は CONDITION_ECHO_MISSING、トークン抽出はフォームラベルを剥がす", () => {
    const tokens = extractEchoTokens(MIKU_FORM);
    expect(tokens).toContainAll(["9万以内", "1LDK", "カウンターキッチン", "10年以内", "35㎡"]);
    expect(tokens).not.toContain("⑦20万");
    const abstract = "かしこまりました！！\nご希望のご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！\nみくさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます😌！！";
    expect(evalConditionEcho(abstract, tokens).echoed.length).toBe(0);
    expect(codes(abstract, MIKU_FORM, ASK)).toContain("CONDITION_ECHO_MISSING:block");
  });
  it("S2 あやさん型（具体宣言なしの全力サポート）: GENERIC_ONLY_REPLY block。具体宣言があれば発火しない", () => {
    const cust = "桜川・西九条エリアで7万以内でお願いします";
    const staff = "ご希望条件お聞かせください";
    const generic = "ご条件お送り頂きありがとうございます！！\nあやさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！\n何卒よろしくお願い致します😌！！";
    expect(codes(generic, cust, staff, { customerName: "あや" })).toContain("GENERIC_ONLY_REPLY:block");
    const ok = "かしこまりました！！\n桜川・西九条周辺全域から7万以内であやさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\nあやさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます😌！！";
    expect(codes(ok, cust, staff, { customerName: "あや" }).some((x) => x.startsWith("GENERIC_ONLY"))).toBe(false);
  });
  it("S3 可否即答・煽り・受け身: FACT_DEFERRED_ANSWER / URGENCY_NO_INTENT / HUMBLE_WAIT", () => {
    const c1 = codes("はい！！\n写真のみでご契約頂けるか社内で確認させて頂きます😊！！", "広島在住で写真だけで契約できますか？", "ご希望条件お聞かせください");
    expect(c1).toContain("FACT_DEFERRED_ANSWER:warning");
    const c2 = codes("🌟スプランディッド難波 501号室\n新着でかなり条件のいいお部屋です！！埋まってしまう前にご案内させて頂きます！！", "また物件探してみます", "🌟ABC 101号室\nお手隙の際にご査収ください😌！！");
    expect(c2).toContain("URGENCY_NO_INTENT:warning");
    const c3 = codes("こちらこそご丁寧にありがとうございます😊\n物件が揃い次第お送りいたしますので、少々お時間いただけますと幸いです😌", "ありがとうございます。よろしくお願いします", "ピックアップしてお送りさせて頂きます！！");
    expect(c3).toContain("HUMBLE_WAIT:warning");
  });
  it("S4 computeStanceFlags: みくNG文は closer_kind=preemptive_hedge・期待は commit", () => {
    const { pair, hedge } = build(MIKU_FORM, ASK, { flags: { isConditionPresented: true } });
    const f = computeStanceFlags("かしこまりました😊！！\n梅田まで1本で行ける沿線周辺全域から9万以内・1LDKでみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n35㎡以上は少し難しい可能性もございます😌！！", pair, hedge, { customerName: "みく", customerText: MIKU_FORM });
    expect(f.closer_kind).toBe("preemptive_hedge"); expect(f.closer_expected).toBe("commit_until_found"); expect(f.hedge_kind).toBe("preemptive");
  });
  it("S5 computeStanceLite（送信文側）: みく正解文は commit/何卒あり・復唱率0.5以上", () => {
    const lite = computeStanceLite("かしこまりました😊！！\n梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチン希望・築10年以内・35㎡以上でみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\nみくさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！\n何卒よろしくお願い致します！！", MIKU_FORM);
    expect(lite.closer_kind).toBe("commit_until_found"); expect(lite.has_nanisotsu).toBe(true); expect(lite.echo_ratio >= 0.5).toBe(true); expect(lite.emoji_count).toBe(2);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
