// app/lib/__tests__/example-premise.test.ts
// 実行: npx tsx app/lib/__tests__/example-premise.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildPremiseExcludeRe, missingPremiseKeys, derivePremiseLabel, daysSinceViewingMove, PREMISE_RULES, VIEWING_THANKS_MAX_DAYS, type PremiseFacts } from "../example-premise";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入っている`); },
  };
}

const NO_FACTS: PremiseFacts = { viewingInvited: false, meetingPlaceSent: false, propertiesSentCount: 0, estimateSent: false };
/** 慶次さんの実物（条件変更の場面・内覧の事実なし） */
const KEIJI = {
  staffHist: "慶次さんお世話になっております！！\n大阪市北区、福島区、西区から敷金礼金無しのガスコンロタイプのお部屋探させて頂きましたが、現在募集に出ておらず、エリア広げさせていただきました！！",
  customerMessage: "ありがとうございます。なかなか無い中、探して頂いてるのに申し訳ないのですが 出来れば中央大通りより北側でお願いしたいです。ミナミ方面は、避けたいです。本当にわがままばかり言いまして申し訳ありません。",
};
/** 手本の実物（他のお客様の内覧後のお礼） */
const VIEWING_THANKS_EXAMPLE = "関さん\n本日お時間頂きありがとうございました😊！！\n本日ご内覧頂きましたお部屋でお気に召されたお部屋御座いましたお部屋のお申込みさせていただきます！！";

it("慶次事例: 内覧の事実が無い会話では「内覧後のお礼」の手本を落とす", () => {
  const re = buildPremiseExcludeRe({ ...KEIJI, facts: { ...NO_FACTS, propertiesSentCount: 2 } });
  expect(re === null).toBe(false);
  expect(re!.test(VIEWING_THANKS_EXAMPLE)).toBe(true);           // ← この手本は落ちる
  expect(missingPremiseKeys({ ...KEIJI, facts: { ...NO_FACTS, propertiesSentCount: 2 } }).includes("viewing_done")).toBe(true);
});

it("内覧を打診している会話では落とさない（実送信68通が全部こちら）", () => {
  const facts: PremiseFacts = { ...NO_FACTS, viewingInvited: true, propertiesSentCount: 2 };
  const keys = missingPremiseKeys({ staffHist: "直近ですと明日 9/18(金) 16:30〜18:30にてご案内可能です！！", customerMessage: "つきました！", facts });
  expect(keys.includes("viewing_done")).toBe(false);
});

// ── 2026-09-19 竹内「内覧挨拶は当日にAIXからおこなうなら分かるが、持ち越したことで変な文になっていた」──
//   鮮度の線は実送信68通で測った: 直前N日以内に内覧の動きがある通数
//   0.5日 44 / 1日 51 / 2日 59 / 3日 62 / 5日 65 / 7日 67 / 14日 68（誤削除0）
it("内覧が14日より前なら落とす（打診があっても持ち越さない）", () => {
  const old: PremiseFacts = { ...NO_FACTS, viewingInvited: true, meetingPlaceSent: true, daysSinceViewingMove: 30 };
  expect(missingPremiseKeys({ staffHist: "現地エントランスでお待ち合わせ", customerMessage: "はい", facts: old }).includes("viewing_done")).toBe(true);
  const fresh: PremiseFacts = { ...NO_FACTS, viewingInvited: true, daysSinceViewingMove: 0.2 };
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "つきました！", facts: fresh }).includes("viewing_done")).toBe(false);
  // 境界: 14日ちょうどは通す・14.1日は落とす（誤削除0の線）
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "", facts: { ...NO_FACTS, daysSinceViewingMove: VIEWING_THANKS_MAX_DAYS } }).includes("viewing_done")).toBe(false);
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "", facts: { ...NO_FACTS, daysSinceViewingMove: VIEWING_THANKS_MAX_DAYS + 0.1 } }).includes("viewing_done")).toBe(true);
});

it("daysSinceViewingMove: 直近の内覧の動きからの経過日数を出す（無ければ null）", () => {
  const now = Date.parse("2026-09-19T12:00:00+09:00");
  const d = daysSinceViewingMove([
    { text: "お部屋ピックアップさせて頂きました", createdAt: "2026-09-18T12:00:00+09:00" },
    { text: "直近ですと 9/7(日) 15:00〜にてご案内可能です", createdAt: "2026-09-07T12:00:00+09:00" },
  ], now);
  expect(d !== null && Math.round(d)).toBe(12);
  expect(daysSinceViewingMove([{ text: "敷金礼金なしで探しています", createdAt: "2026-09-18T12:00:00+09:00" }], now)).toBe(null);
  expect(daysSinceViewingMove([], now)).toBe(null);
  // 時刻が無い発言は使わない（順不同でよい）
  expect(daysSinceViewingMove([{ text: "現地エントランス" }], now)).toBe(null);
});

it("台帳が無い経路（check-reply 等）では語で判定する＝どちらでも動く", () => {
  // 語に内覧があれば前提あり
  expect(missingPremiseKeys({ staffHist: "本日ですと17:30からご内覧可能です！！", customerMessage: "お願いします" }).includes("viewing_done")).toBe(false);
  // 語が無ければ前提なし
  expect(missingPremiseKeys({ staffHist: "お部屋ピックアップさせて頂きます", customerMessage: "ありがとうございます" }).includes("viewing_done")).toBe(true);
});

it("台帳の事実が語より優先される（語が窓から外れても前提を保つ／語があっても事実が無ければ落とす）", () => {
  // 直前の発言に内覧の語が無くても、台帳に内覧打診があれば前提あり
  expect(missingPremiseKeys({ staffHist: "お部屋ピックアップさせて頂きます", customerMessage: "はい", facts: { ...NO_FACTS, viewingInvited: true } }).includes("viewing_done")).toBe(false);
  // 物件送付も同じ（台帳の件数が正）
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "はい", facts: { ...NO_FACTS, propertiesSentCount: 3 } }).includes("delivered")).toBe(false);
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "はい", facts: NO_FACTS }).includes("delivered")).toBe(true);
});

it("既存の6つの前提はそのまま効く（撮影・ご査収・現地到着・見積・審査・申込書類）", () => {
  const keys = missingPremiseKeys({ staffHist: "", customerMessage: "", facts: NO_FACTS });
  for (const k of ["shooting", "delivered", "arrived", "estimate", "screening", "apply_docs"]) {
    expect(keys.includes(k)).toBe(true);
  }
  // 見積: お客様が費用を聞いていれば前提あり
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "初期費用はいくらですか？", facts: NO_FACTS }).includes("estimate")).toBe(false);
  // 審査: お客様が不安を言っていれば前提あり
  expect(missingPremiseKeys({ staffHist: "", customerMessage: "審査通るか心配です", facts: NO_FACTS }).includes("screening")).toBe(false);
});

it("全部の前提が揃っていれば null（何も落とさない）", () => {
  const re = buildPremiseExcludeRe({
    staffHist: "撮影出来次第お送りします。9/18 17時に現地でお待ち合わせ。ご査収ください。最大限割引しました御見積書作成しお送りします",
    customerMessage: "初期費用いくらですか？審査通りますか？申込したいです",
    facts: { viewingInvited: true, meetingPlaceSent: true, propertiesSentCount: 2, estimateSent: true },
  });
  expect(re === null).toBe(true);
});

it("注記は決定論で作る（手本の本文にある前提だけ並べる）", () => {
  const label = derivePremiseLabel(VIEWING_THANKS_EXAMPLE);
  expect(label).toContain("日以内に内覧・来店がある");   // 鮮度つきの注記になっている
  expect(derivePremiseLabel("お部屋ピックアップさせて頂きます！！")).toBe("");
  expect(derivePremiseLabel("確認出来次第ご連絡させて頂きます")).toContain("管理会社への確認事項");
});

it("ルールの vocab と label は1対1で揃っている（四者同名の崩れを止める）", () => {
  expect(PREMISE_RULES.length).toBe(7);
  for (const r of PREMISE_RULES) {
    expect(r.key.length > 0).toBe(true);
    expect(r.label.length > 0).toBe(true);
  }
  expect(new Set(PREMISE_RULES.map((r) => r.key)).size).toBe(PREMISE_RULES.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
