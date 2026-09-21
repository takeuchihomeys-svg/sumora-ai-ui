// AIX【物件オススメ】の冒頭フレーム（竹内 2026-09-21）。
//
// 竹内「複数物件送った中では『お送りさせて頂きましたお部屋の中でも〜』の言い回しを使ったり、
//   新着物件なら新着物件の言い回しを使う。別のスタッフが送ってる質の悪い言い回しもあるから、
//   そこも含めて改善する。」
//
// ⚠ この判定は aix-template-generate の中にしか無く、**AIX ボタン本体では効いていなかった**
//   （実測: 生成ログ693件中シナリオが決まっていたのは 74件＝10.7%）。
//   ここに出して両方の経路が同じ物を見る。★ は事実と文が食い違わないための線。
//
// 実行: npx tsx app/lib/__tests__/recommendation-frame.test.ts（全 PASS で exit 0）
import {
  canUseCompareFrame, resolveRecommendationScenario, detectFrameViolation,
  isExampleFrameCompatible, buildScenarioNote, COMPARE_FRAME_STALE_HOURS,
  RECOMMENDATION_SCENARIO_GUIDES, RECOMMENDATION_FORBIDDEN_OPENINGS,
  type PropertySendFacts, type RecommendationScenario,
} from "../recommendation-frame";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected NOT to contain ${JSON.stringify(item)}`); },
  };
}
const facts = (p: Partial<PropertySendFacts> = {}): PropertySendFacts => ({
  priorSentPropertyCount: 0, priorBulkSendCount: 0, priorSingleSendCount: 0, hoursSinceLastSend: null, ...p,
});
const scen = (p: Partial<PropertySendFacts>, pickupType: string | null = null, checkPattern: string | null = null) =>
  resolveRecommendationScenario({ actionType: "property_recommendation", pickupType, checkPattern, facts: facts(p) });

describe("★ 複数送っていれば比較の言い回しを使う（竹内さんの指示そのもの）", () => {
  it("★ C1 まとめ送付が1回でもあれば複数送っている＝比較してよい", () => {
    expect(canUseCompareFrame(facts({ priorSentPropertyCount: 1, priorBulkSendCount: 1, hoursSinceLastSend: 2 }))).toBe(true);
  });
  it("★ C2 ブレインが件数を知っていればそれが正（2件以上で比較してよい）", () => {
    expect(canUseCompareFrame(facts({ brainSentPropertyCount: 5, hoursSinceLastSend: 2 }))).toBe(true);
    expect(canUseCompareFrame(facts({ brainSentPropertyCount: 1, priorBulkSendCount: 3, hoursSinceLastSend: 2 }))).toBe(false);
  });
  it("★ C3 1件送付だけなら2回以上でようやく複数", () => {
    expect(canUseCompareFrame(facts({ priorSentPropertyCount: 1, priorSingleSendCount: 1, hoursSinceLastSend: 2 }))).toBe(false);
    expect(canUseCompareFrame(facts({ priorSentPropertyCount: 2, priorSingleSendCount: 2, hoursSinceLastSend: 2 }))).toBe(true);
  });
  it("★ C4 1週間以上前の送付は「中でも」で引き合いに出さない", () => {
    expect(canUseCompareFrame(facts({ brainSentPropertyCount: 5, hoursSinceLastSend: COMPARE_FRAME_STALE_HOURS + 1 }))).toBe(false);
    expect(COMPARE_FRAME_STALE_HOURS).toBe(168);
  });
  it("★ C5 複数送っていれば比較選択型になる", () => {
    expect(scen({ brainSentPropertyCount: 4, hoursSinceLastSend: 3 })).toBe("compare");
  });
});

describe("★ 新着なら新着の言い回しを使う", () => {
  it("★ N1 ピッカーが新着なら、過去に何件送っていても新着型", () => {
    expect(scen({ brainSentPropertyCount: 9, hoursSinceLastSend: 1 }, "新着1件")).toBe("new_listing");
    expect(scen({ brainSentPropertyCount: 9, hoursSinceLastSend: 1 }, "新着まとめ")).toBe("new_listing");
  });
  it("★ N2 新着型では比較の言い回しを禁止する", () => {
    expect(RECOMMENDATION_FORBIDDEN_OPENINGS.new_listing.join("/")).toContain("お送りさせて頂きましたお部屋の中でも");
  });
  it("★ N3 比較型では新着の言い回しを禁止する", () => {
    expect(RECOMMENDATION_FORBIDDEN_OPENINGS.compare.join("/")).toContain("募集に出ました");
  });
});

describe("★ 事実が無い時は比較の言い回しを使わせない", () => {
  it("★ F1 1件も送っていなければ初回提案型", () => {
    expect(scen({})).toBe("first");
  });
  it("★ F2 送ってはいるが比較できる複数が無ければ追加提案型（「初回」も嘘になる）", () => {
    expect(scen({ brainSentPropertyCount: 1, hoursSinceLastSend: 2 })).toBe("followup_single");
  });
  it("★ F3 募集終了・別の部屋なら代替提案型", () => {
    expect(scen({ brainSentPropertyCount: 5, hoursSinceLastSend: 2 }, null, "unavailable")).toBe("alternative");
    expect(scen({ brainSentPropertyCount: 5, hoursSinceLastSend: 2 }, null, "alternative")).toBe("alternative");
  });
  it("★ F4 継続ピックアップでも比較できる実体が無ければ降格する", () => {
    expect(scen({ brainSentPropertyCount: 1, hoursSinceLastSend: 2 }, "継続ピックアップ")).toBe("followup_single");
    expect(scen({ brainSentPropertyCount: 4, hoursSinceLastSend: 2 }, "継続ピックアップ")).toBe("compare");
  });
  it("F5 物件オススメ以外では判定しない", () => {
    expect(resolveRecommendationScenario({ actionType: "property_send", pickupType: null, checkPattern: null, facts: facts() })).toBe(null);
    expect(resolveRecommendationScenario({ actionType: null, pickupType: null, checkPattern: null, facts: facts() })).toBe(null);
  });
});

describe("★ 生成文の検査（出口）", () => {
  it("★ V1 比較できないのに「お送りした中でも」なら違反", () => {
    const v = detectFrameViolation("お送りさせて頂きましたお部屋の中でも特に〇〇が…", "first");
    if (!v) throw new Error("違反を見つけられていない");
    expect(v).toContain("比較表現");
  });
  it("★ V2 比較型なのに「募集に出ました」なら違反", () => {
    const v = detectFrameViolation("新着で1件オススメ出来るお部屋が募集に出ました！！", "compare");
    if (!v) throw new Error("違反を見つけられていない");
  });
  it("★ V3 合っていれば違反ではない", () => {
    expect(detectFrameViolation("お送りさせて頂きましたお部屋の中でも特に〇〇が…", "compare")).toBe(null);
    expect(detectFrameViolation("新着で1件募集に出ました！！", "new_listing")).toBe(null);
  });
  it("★ V4 竹内さんのスクショの文は比較型として正しい", () => {
    const text = "お送りさせて頂きましたお部屋の中でも\nシャルマンフジ北花田が特に〇〇さんにオススメのお部屋となります！！";
    expect(detectFrameViolation(text, "compare")).toBe(null);
    if (!detectFrameViolation(text, "new_listing")) throw new Error("新着型なら違反のはず");
  });
  it("V5 シナリオが無ければ検査しない", () => {
    expect(detectFrameViolation("お送りした中でも", null)).toBe(null);
  });
});

describe("★ 実例のフレーム汚染を止める", () => {
  it("★ E1 新着型に比較の実例を入れない", () => {
    expect(isExampleFrameCompatible("お送りさせて頂きましたお部屋の中でも…", "new_listing")).toBe(false);
    expect(isExampleFrameCompatible("新着で募集に出ました！！", "new_listing")).toBe(true);
  });
  it("★ E2 比較型に新着の実例を入れない", () => {
    expect(isExampleFrameCompatible("新着で1件募集に出ました", "compare")).toBe(false);
    expect(isExampleFrameCompatible("お送りした中でも特に…", "compare")).toBe(true);
  });
  it("★ E3 初回・追加・代替はどちらの実例も入れない", () => {
    for (const s of ["first", "followup_single", "alternative"] as RecommendationScenario[]) {
      expect(isExampleFrameCompatible("お送りした中でも", s)).toBe(false);
      expect(isExampleFrameCompatible("新着で募集に出ました", s)).toBe(false);
      expect(isExampleFrameCompatible("〇〇さんにオススメのお部屋です", s)).toBe(true);
    }
  });
  it("E4 シナリオが無ければ全部通す", () => {
    expect(isExampleFrameCompatible("お送りした中でも", null)).toBe(true);
  });
});

describe("生成に渡すブロック", () => {
  it("★ G1 シナリオのガイドと禁止表現の両方を載せる", () => {
    const n = buildScenarioNote("compare");
    expect(n).toContain("比較選択型");
    expect(n).toContain("絶対に使わない冒頭");
    expect(n).toContain("募集に出ました");
  });
  it("G2 シナリオが無ければ空", () => {
    expect(buildScenarioNote(null)).toBe("");
  });
  it("G3 5つのシナリオ全部にガイドがある", () => {
    for (const s of ["compare", "new_listing", "alternative", "followup_single", "first"] as RecommendationScenario[]) {
      if (!RECOMMENDATION_SCENARIO_GUIDES[s]) throw new Error(`${s} のガイドが無い`);
      if (!buildScenarioNote(s)) throw new Error(`${s} のブロックが空`);
    }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
