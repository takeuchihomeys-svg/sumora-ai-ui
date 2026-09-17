// 2026-09-17 竹内: AIX【物件オススメ】「現状伝えて・1件訴求」
// 実行: npx tsx app/lib/__tests__/recommendation-situation.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  SITUATION_PRESETS,
  isSituationKind,
  buildSituationLine,
  hasSituationOpening,
  ensureSituationOpening,
  buildSituationPromptNote,
  situationOpeningLine,
} from "../recommendation-situation";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

console.log("\n[現状の1文＝実送信そのまま]");
it("竹内さんのスクショ（M さん）と同じ文になる", () => {
  const line = buildSituationLine("vacancy_none", {
    area: "大国町・本町・堺筋本町周辺全域", customerName: "Mさん",
  });
  expect(line).toBe("大国町・本町・堺筋本町周辺全域からご条件に合った物件すべて探させて頂きましたところ空室のお部屋で募集御座いませんでしたが、1件退去予定のお部屋でMさんご希望のご条件にピッタリなお部屋が募集に出ております😊！！");
});
it("コトミさんの実送信（エリア外で1件）と同じ骨組み — エリア未入力は「周辺の地域で」", () => {
  const line = buildSituationLine("area_none", { area: "", customerName: "コトミさん", foundArea: "東淀川区" });
  expect(line).toBe("周辺の地域でコトミさんのご条件に合った物件探させて頂きましたところ東淀川区の物件となりますが1件オススメ出来るお部屋御座いました！！");
  // エリアを入れた時は「〇〇から」
  const withArea = buildSituationLine("area_none", { area: "布施・八戸の里周辺全域", customerName: "コトミさん", foundArea: "東花園" });
  expect(withArea).toBe("布施・八戸の里周辺全域からコトミさんのご条件に合った物件探させて頂きましたところ東花園の物件となりますが1件オススメ出来るお部屋御座いました！！");
});
it("エリアが空でも文として成立する（前置きだけ落ちる）", () => {
  expect(buildSituationLine("vacancy_none", { area: "", customerName: "YUMAさん" }))
    .toBe("ご条件に合った物件すべて探させて頂きましたところ空室のお部屋で募集御座いませんでしたが、1件退去予定のお部屋でYUMAさんご希望のご条件にピッタリなお部屋が募集に出ております😊！！");
  expect(buildSituationLine("area_none", { area: null, customerName: "YUMAさん" }))
    .toBe("周辺の地域でYUMAさんのご条件に合った物件探させて頂きましたところ1件オススメ出来るお部屋御座いました！！");
});
it("自分で書く（custom）はこちらで文を作らない＝創作しない", () => {
  expect(buildSituationLine("custom", { customerName: "YUMAさん", note: "新着で3件だけ出ました" })).toBe(null);
});
it("出口で置く1文: custom はスタッフの言葉をそのまま（言い回しを作らない）", () => {
  expect(situationOpeningLine("custom", { customerName: "YUMAさん", note: "新着で3件だけ出ました" }))
    .toBe("新着で3件だけ出ました");
  expect(situationOpeningLine("custom", { customerName: "YUMAさん", note: "  " })).toBe(null);
  expect(situationOpeningLine("vacancy_none", { area: "梅田周辺全域", customerName: "YUMAさん" }))
    .toBe(buildSituationLine("vacancy_none", { area: "梅田周辺全域", customerName: "YUMAさん" }));
});
it("チップは3つ・種類の判定", () => {
  expect(SITUATION_PRESETS.length).toBe(3);
  expect(SITUATION_PRESETS.map((p) => p.kind)).toBe(["vacancy_none", "area_none", "custom"]);
  expect(isSituationKind("vacancy_none")).toBe(true);
  expect(isSituationKind("new_none")).toBe(false);
  expect(isSituationKind(null)).toBe(false);
});

console.log("\n[出口: 🌟の前に現状の1文を置く]");
const CARD = "🌟エステムコート難波サウスプレイスVIラグジー\n大国町徒歩7分の立地、トイレ独立している間取りのお部屋となります！！\nお手隙の際にご査収ください😊！！";
const LINE = buildSituationLine("vacancy_none", { area: "大国町・本町・堺筋本町周辺全域", customerName: "Mさん" })!;
it("🌟だけの生成文に現状の1文を足す（1行空ける）", () => {
  const { text, added } = ensureSituationOpening(CARD, LINE);
  expect(added).toBe(true);
  expect(text.startsWith(LINE)).toBe(true);
  expect(text).toContain(`${LINE}\n\n🌟エステムコート`);
});
it("既に現状の1文があれば触らない（実送信の形）", () => {
  const real = `${LINE}\n\n${CARD}`;
  expect(ensureSituationOpening(real, LINE)).toBe({ text: real, added: false });
  // 言い回しが少し違っても現状の文と分かれば足さない
  const other = `梅田周辺全域から探させて頂きましたところ空室は御座いませんでした！！\n\n${CARD}`;
  expect(ensureSituationOpening(other, LINE).added).toBe(false);
});
it("🌟の前に挨拶があればその後ろに足す・🌟が無ければ先頭に足す", () => {
  const withGreeting = `Mさんお世話になっております！！\n\n${CARD}`;
  const out = ensureSituationOpening(withGreeting, LINE).text;
  expect(out.startsWith("Mさんお世話になっております！！")).toBe(true);
  expect(out).toContain(`！！\n${LINE}\n\n🌟`);
  const noStar = "エステムコート難波のお部屋となります！！";
  expect(ensureSituationOpening(noStar, LINE).text).toBe(`${LINE}\n\n${noStar}`);
});
it("文が無い・空文は触らない（安全側）", () => {
  expect(ensureSituationOpening(CARD, null)).toBe({ text: CARD, added: false });
  expect(ensureSituationOpening("", LINE)).toBe({ text: "", added: false });
});
it("custom: スタッフの言葉が🌟の前にあれば足さない・無ければ足す", () => {
  const note = "新着で3件だけ出ましたが、その中で1件だけご条件に合いました";
  const already = `${note}\n\n${CARD}`;
  expect(ensureSituationOpening(already, note).added).toBe(false);
  const out = ensureSituationOpening(CARD, note);
  expect(out.added).toBe(true);
  expect(out.text.startsWith(note)).toBe(true);
});
it("カードの中の「募集に出ております」は現状の文と数えない（🌟より後ろ）", () => {
  const cardOnly = "🌟テスト\n1件退去予定のお部屋が募集に出ております！！";
  expect(hasSituationOpening(cardOnly)).toBe(false);
  expect(ensureSituationOpening(cardOnly, LINE).added).toBe(true);
});

console.log("\n[生成の指示]");
it("実送信の文をそのまま使わせる・🌟より前を許す", () => {
  const note = buildSituationPromptNote("vacancy_none", { area: "大国町・本町・堺筋本町周辺全域", customerName: "Mさん" });
  expect(note).toContain("この経路だけ🌟より前に文を書いてよい");
  expect(note).toContain("大国町・本町・堺筋本町周辺全域からご条件に合った物件すべて探させて頂きましたところ");
  expect(note).toContain("現状の1文に物件名・家賃・設備は書かない");
});
it("エリア未入力なら会話から足してよいと書く", () => {
  const note = buildSituationPromptNote("vacancy_none", { area: "", customerName: "YUMAさん" });
  expect(note).toContain("会話・希望条件にあるエリアだけ");
});
it("自分で書く（custom）はスタッフの言葉を使わせ、足さないと書く", () => {
  const note = buildSituationPromptNote("custom", { customerName: "YUMAさん", note: "新着で3件だけ出ました" });
  expect(note).toContain("新着で3件だけ出ました");
  expect(note).toContain("スタッフが書いていない事実（募集件数・エリア・理由）は足さない");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
