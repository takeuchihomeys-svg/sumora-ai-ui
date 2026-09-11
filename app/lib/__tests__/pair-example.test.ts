// 2026-09-10 Fable5 あみ事例: 持込予告（will_send_later）の業務フロー統一 ＋ example 前提ラベル機構の回帰テスト。
// 実行: npx tsx app/lib/__tests__/pair-example.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair,
  resolveHedgeAllowance, resolveCloser, deriveCloserSignals, buildTurnPairNote,
  classifyWillSendObject, CUST_WILL_SEND_SELF_PRED, checkGoyukkuriMirror, PAIR_MATRIX,
} from "../reply-context";
import { resolveOpener } from "../greeting";
import { classifyStaffTextForLedger } from "../action-ledger";
import { isMisumoriContextAppropriate } from "../estimate-context";
import { runDeterministicChecks } from "../final-check";

// ── ミニハーネス（stance.test.ts と同型）──
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

const build = (cust: string, staffText: string) => {
  const staff = classifyLastStaffTurn(staffText, { lastStaffAt: "2026-09-09T04:24:00Z" });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, {});
  const hedge = resolveHedgeAllowance({ customerMessage: cust, substance: sub, staff, customer, lastStaffText: staffText, lastCustomerAt: "2026-09-09T06:32:00Z" });
  const pair = resolveTurnPair(staff, customer, sub, staffText, { searched: hedge.searched.yes });
  return { staff, sub, customer, hedge, pair };
};
const codes = (text: string, cust: string, staffText: string, extra: Record<string, unknown> = {}) =>
  runDeterministicChecks(text, {
    lastCustomerMessage: cust,
    recentMessages: [
      ...(staffText ? [{ sender: "staff", text: staffText, createdAt: "2026-09-09T04:24:00Z" }] : []),
      { sender: "customer", text: cust, createdAt: "2026-09-09T06:32:00Z" },
    ],
    customerName: "あみ",
    ...extra,
  }).map((i) => `${i.code}:${i.severity}`);
const blocks = (text: string, cust: string, staffText: string, extra: Record<string, unknown> = {}) =>
  codes(text, cust, staffText, extra).filter((x) => x.endsWith(":block"));

// ── あみ（スモラ・物件提案中・2026-09-09）──
const AMI_STAFF = "とんでもございません😊！！新着でオススメできるお部屋で次第お送りさせていただきます！！";
const AMI_CUST = "こちらも気になる物件見つけたら送らせて頂きます！";
const AMI_NG = "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまたお気になるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、気になる点出てきましたらいつでもお気軽にご連絡ください！！";
const AMI_OK = "はい😊！！\n気になるお部屋ございましたらいつでもお送りください！！\nお送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！";
const PROP_SENT = "🌟グランドメゾン 302号室\nお手隙の際にご査収ください😌！！";

describe("W 持込予告（will_send_later）", () => {
  it("W1 あみ 13:24「オススメできるお部屋…お送りさせていただきます」は pickup_declared（旧 regex は other に落ちていた）", () => {
    expect(classifyLastStaffTurn(AMI_STAFF, {}).kind).toBe("pickup_declared");
    expect(classifyStaffTextForLedger(AMI_STAFF, null)?.kind).toBe("pickup_declared");
  });

  it("W2 あみ 15:32 は will_send_later ＋ sendObject=property", () => {
    const { customer, pair } = build(AMI_CUST, AMI_STAFF);
    expect(customer.kind).toBe("will_send_later");
    expect(pair.sendObject).toBe("property");
  });

  it("W3 セル選択は PD_WILL_SEND（ANY_WILL_SEND ではない）", () => {
    expect(build(AMI_CUST, AMI_STAFF).pair.ruleId).toBe("PD_WILL_SEND");
  });

  // 2026-09-11 竹内方針1: 必須要素の欠落は観測専用（info）。block は UNANCHORED_VOCAB（顧客が言っていない語）が担う
  it("W4 あみ 15:42 の NG は UNANCHORED_VOCAB の block・必須要素の欠落は info（観測）", () => {
    const c = codes(AMI_NG, AMI_CUST, AMI_STAFF);
    expect(c).toContain("UNANCHORED_VOCAB:block");     // ごゆっくりご相談 ＋ 随時ピックアップ
    expect(c).toContain("PAIR_ELEMENT_MISSING:info");  // 募集状況確認 ／ 御見積書
    expect(c).not.toContain("PAIR_ELEMENT_MISSING:block");
  });

  it("W5 修正後の返信は block 0", () => {
    expect(blocks(AMI_OK, AMI_CUST, AMI_STAFF)).toEqual([]);
  });

  it("W6 みく型 ES_WILL_SEND のセル選択と必須要素が壊れない（回帰）", () => {
    const staff = "みくさんお世話になっております！！\nエストレーラ305号室の最大限割引しました初期費用の御見積書となります😊！！";
    const cust = "ありがとうございます！ゆっくり検討してみます。気になる物件あればまた送らせていただきます";
    const { pair } = build(cust, staff);
    expect(pair.ruleId).toBe("ES_WILL_SEND");
    const ok = "みくさんお世話になっております！！\nはい😊！！ごゆっくりご検討頂けますと幸いです！！\n気になるお部屋ございましたらお送りください！！お送り頂き次第募集状況確認させて頂き、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！";
    expect(codes(ok, cust, staff)).not.toContain("PAIR_ELEMENT_MISSING:block");
    expect(codes(ok, cust, staff)).not.toContain("UNANCHORED_VOCAB:block");
    expect(codes(ok, cust, staff)).not.toContain("VOCAB_MIRROR_MISMATCH:block");
  });

  it("W7 顧客が『家族と相談します』なら「ごゆっくりご相談」は検出されない", () => {
    const cust = "一度家族と相談してみます！";
    const ok = "はい😊！！\nごゆっくりご相談頂けますと幸いです！！\nご不明な点出てきましたらいつでもお気軽にご連絡ください😌！！";
    expect(codes(ok, cust, PROP_SENT)).not.toContain("UNANCHORED_VOCAB:block");
    expect(codes(ok, cust, PROP_SENT)).not.toContain("VOCAB_MIRROR_MISMATCH:block");
  });

  it("W8 顧客が『検討します』なのに「ごゆっくりご相談」は鏡写し不一致", () => {
    const g = checkGoyukkuriMirror("ごゆっくりご相談頂けますと幸いです", "一度検討してみます");
    expect(g!.expected).toBe("ご検討");
    expect(g!.ok).toBe(false);
    const g2 = checkGoyukkuriMirror("ごゆっくりご検討頂けますと幸いです", "一度検討してみます");
    expect(g2!.ok).toBe(true);
  });

  it("W9 予告形の見積は estimate ゲートで許可される（sent=0 でも block しない）", () => {
    const ws = CUST_WILL_SEND_SELF_PRED(AMI_CUST);
    const v = isMisumoriContextAppropriate({
      customerMessage: AMI_CUST, sentPropertiesCount: 0, recentCustomerMessages: [], lastStaffMessage: AMI_STAFF,
      customerWillSendProperty: ws.yes && classifyWillSendObject(AMI_CUST) === "property",
    });
    expect(v.mode).toBe("declare");
    expect(v.trigger).toBe("customer_will_send_property");
    expect(codes(AMI_OK, AMI_CUST, AMI_STAFF)).not.toContain("ESTIMATE_NO_TRIGGER:block");
    expect(codes(AMI_OK, AMI_CUST, AMI_STAFF)).not.toContain("TIMING_VOCAB_MISMATCH:block");
  });

  it("W10 (B)『気になる物件あればお送りください』は will_send_later にしない", () => {
    const { customer } = build("気になる物件あればまたお送りください！", AMI_STAFF);
    expect(customer.kind === "will_send_later").toBe(false);
    expect(CUST_WILL_SEND_SELF_PRED("気になる物件あればまたお送りください！").yes).toBe(false);
  });

  it("W11 条件を送る予告は sendObject=condition＝見積要素が外れ、条件探索が必須になる", () => {
    const cust = "条件がいくつかあって送らせてもらっていいですか？";
    const { pair } = build(cust, "");
    expect(pair.sendObject).toBe("condition");
    const active = pair.rule!.mustInclude.filter((m) => !m.when || m.when(pair)).map((m) => m.label);
    expect(active.some((l) => /御見積書/.test(l))).toBe(false);
    expect(active.some((l) => /条件に合う/.test(l))).toBe(true);
    const ok = "はい！！\nご条件お送りいただきましたら条件に合ったお部屋探させていただきます😊！！";
    expect(blocks(ok, cust, "")).toEqual([]);
  });

  it("W12 staff=other は ANY_WILL_SEND・staff=pickup_declared は PD_WILL_SEND", () => {
    expect(build(AMI_CUST, "ありがとうございます！").pair.ruleId).toBe("ANY_WILL_SEND");
    expect(build(AMI_CUST, AMI_STAFF).pair.ruleId).toBe("PD_WILL_SEND");
  });

  it("W15 開口語は will_send_later → はい（回帰）", () => {
    expect(resolveOpener({ greetingKind: "standard", customerKind: "will_send_later", substanceKinds: [] }).opener).toBe("hai");
  });

  it("W16 締めは PD/ANY=none・ES=open_door（セル指定を尊重）", () => {
    const sig = deriveCloserSignals(AMI_OK);
    expect(resolveCloser(build(AMI_CUST, AMI_STAFF).pair, sig, { customerName: "あみ" }).closer).toBe("none");
    expect(PAIR_MATRIX.find((r) => r.id === "ES_WILL_SEND")!.closer).toBe("open_door");
    expect(PAIR_MATRIX.find((r) => r.id === "ANY_WILL_SEND")!.closer).toBe("none");
  });

  it("W17 台帳: 送付済み文は properties_sent のまま（宣言 regex 拡張の副作用なし）", () => {
    expect(classifyStaffTextForLedger("🌟エストレーラ 305号室\nお手隙の際にご査収ください😌！！", null)?.kind).toBe("properties_sent");
    expect(classifyStaffTextForLedger("オススメできるお部屋ピックアップさせて頂きました！！", null)?.kind).toBe("properties_sent");
  });

  it("W18 顧客が継続紹介を依頼した場面では「随時ピックアップ」は許可される", () => {
    const cust = "1度相談してみます！また条件のあう物件等あればご紹介いただきたいです";
    const ok = "かしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまたあみさんのご条件に合うお部屋出てきましたら随時ピックアップしてお送りさせて頂きます！！";
    expect(codes(ok, cust, PROP_SENT)).not.toContain("UNANCHORED_VOCAB:block");
  });
});

describe("E example 前提ラベル機構", () => {
  it("E1 前提不成立なら PS_THINKING の example は出さず『型のみ』注記になる", () => {
    const cust = "ありがとうございます！一旦持ち帰ります";
    const { pair } = build(cust, PROP_SENT);
    expect(pair.ruleId).toBe("PS_THINKING");
    const note = buildTurnPairNote(pair, cust, "あみ");
    expect(/文はそのまま使わない/.test(note)).toBe(true);
    expect(/ごゆっくりご相談/.test(note)).toBe(false);
  });

  it("E2 前提成立なら PS_THINKING の example はそのまま出る", () => {
    const cust = "一度同居人と相談してみます！";
    const { pair } = build(cust, PROP_SENT);
    const note = buildTurnPairNote(pair, cust, "あみ");
    expect(/ごゆっくりご相談/.test(note)).toBe(true);
    expect(/文はそのまま使わない/.test(note)).toBe(false);
  });

  it("E3 PAIR_ELEMENT_MISSING の修正案は example ではなく要素ごとの fix リテラル", () => {
    const issues = runDeterministicChecks(AMI_NG, {
      lastCustomerMessage: AMI_CUST,
      recentMessages: [{ sender: "staff", text: AMI_STAFF, createdAt: "2026-09-09T04:24:00Z" }, { sender: "customer", text: AMI_CUST, createdAt: "2026-09-09T06:32:00Z" }],
      customerName: "あみ",
    }).filter((i) => i.code === "PAIR_ELEMENT_MISSING");
    expect(issues.length > 0).toBe(true);
    expect(issues.every((i) => !/ごゆっくりご相談|随時[^\n]{0,8}ピックアップ/.test(i.suggestion))).toBe(true);
    expect(issues.some((i) => /募集状況確認/.test(i.suggestion))).toBe(true);
  });

  it("E4 前提ラベルを付けた全セルで exampleRequires が自分の example に一致する（自己整合）", () => {
    const bad = PAIR_MATRIX.filter((r) => r.exampleRequires && r.exampleFallback && r.exampleRequires.test(r.exampleFallback));
    // fallback は前提依存語を含まないことが条件（前提語を含んだままなら意味がない）
    expect(bad.map((r) => r.id)).toEqual([]);
  });

  it("E5 will_send 系4セルは全て同じ業務フロー要素（募集状況確認＋御見積書）を持つ", () => {
    for (const id of ["ES_WILL_SEND", "PS_WILL_SEND", "PD_WILL_SEND", "ANY_WILL_SEND"]) {
      const r = PAIR_MATRIX.find((x) => x.id === id)!;
      expect(r.mustInclude.some((m) => /募集状況/.test(m.label))).toBe(true);
      expect(r.mustInclude.some((m) => /御見積書/.test(m.label))).toBe(true);
      expect(/随時[^\n]{0,8}ピックアップ/.test(r.example)).toBe(false);
      expect(/ご相談/.test(r.example)).toBe(false);
    }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("\n失敗:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
