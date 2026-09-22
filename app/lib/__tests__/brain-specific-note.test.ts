// ブレインの「今回の中身」を生成へ届ける1行のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/brain-specific-note.test.ts
import { buildBrainSpecificNote, saysSameThing, MAX_SPECIFIC_CHARS } from "../brain-specific-note";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const truthy = (a: unknown) => { if (!a) throw new Error(`expected truthy but got ${JSON.stringify(a)}`); };
const falsy = (a: unknown) => { if (a) throw new Error(`expected falsy but got ${JSON.stringify(a)}`); };

// 実測で出た実物（scripts/audit-brain-generation-gap.ts の「差し替わった」例）
const BRAIN = "平野区の物件情報を提案する";
const TYPE = "お客様が条件の追加/変更を伝えた（台帳: 物件送付8件／見積送付済）。①「かしこまりました！！」②条件を行動宣言に埋め込む";

describe("足す／足さないの線", () => {
  it("型と中身が別物なら足す（実物・平野区）", () => {
    const s = buildBrainSpecificNote({ brainDirection: BRAIN, effectiveDirection: TYPE, fresh: true, noNewProposalScene: false });
    truthy(s.includes("平野区"));
    truthy(s.includes("型とぶつかる場合は型を優先"));
  });
  it("ブレインが方向を出していなければ足さない", () =>
    eq(buildBrainSpecificNote({ brainDirection: null, effectiveDirection: TYPE, fresh: true, noNewProposalScene: false }), ""));
  it("古い判断は足さない（鮮度ゲートは effectiveReplyDirection と同じ線）", () =>
    eq(buildBrainSpecificNote({ brainDirection: BRAIN, effectiveDirection: TYPE, fresh: false, noNewProposalScene: false }), ""));
  // 設計知見「同じ事実に『書け』と『書くな』を別の場所から渡さない」（まりあ事例）
  it("新しい提案を禁止している場面では足さない（内覧キャンセル・断り・強推し直後 等）", () =>
    eq(buildBrainSpecificNote({ brainDirection: BRAIN, effectiveDirection: TYPE, fresh: true, noNewProposalScene: true }), ""));
  it("既に型がブレインの方向そのものなら二重に渡さない", () =>
    eq(buildBrainSpecificNote({ brainDirection: BRAIN, effectiveDirection: BRAIN, fresh: true, noNewProposalScene: false }), ""));
  it("型がブレインの方向を含んでいる時も足さない", () =>
    eq(buildBrainSpecificNote({ brainDirection: BRAIN, effectiveDirection: `${BRAIN}。100〜150字`, fresh: true, noNewProposalScene: false }), ""));
  it("型が無い（フォールバック）時も足せる", () =>
    truthy(buildBrainSpecificNote({ brainDirection: BRAIN, effectiveDirection: null, fresh: true, noNewProposalScene: false }).includes("平野区")));
  it("長い方向は切り詰める（プロンプトを膨らませない）", () => {
    const long = "あ".repeat(MAX_SPECIFIC_CHARS + 50);
    const s = buildBrainSpecificNote({ brainDirection: long, effectiveDirection: TYPE, fresh: true, noNewProposalScene: false });
    truthy(s.includes("…"));
    truthy(s.length < long.length + 200);
  });
});

// 全件監査で「実送信と内容語が1語も重ならなかった」実物（＝足しても情報が増えない）
describe("中身がゼロの方向は足さない（実物）", () => {
  const empty = ["物件提案を再開する", "新条件で物件提案を再開する", "物件提案を開始する", "条件に合う物件を提案する"];
  for (const d of empty) {
    it(`「${d}」は足さない`, () =>
      eq(buildBrainSpecificNote({ brainDirection: d, effectiveDirection: TYPE, fresh: true, noNewProposalScene: false }), ""));
  }
  // ⚠ 誤削除0の確認: 固有名詞が無くても中身がある物は落とさない
  const keep = ["別保証会社の可否を確認し代替申込に備える", "社員証代替の可否を確認する旨を伝える", "審査手続き開始を報告する", "難波ワンルームの条件をヒアリングする", "日本橋1・2丁目エリアの物件を新規ピックアップする"];
  for (const d of keep) {
    it(`「${d}」は落とさない`, () =>
      truthy(buildBrainSpecificNote({ brainDirection: d, effectiveDirection: TYPE, fresh: true, noNewProposalScene: false }).includes(d)));
  }
});

describe("同じことを言っているかの判定", () => {
  it("同一文", () => truthy(saysSameThing("新条件で物件を再ピックアップして送付する", "新条件で物件を再ピックアップして送付する")));
  it("片方が他方を含む", () => truthy(saysSameThing("平野区の物件情報を提案する", "平野区の物件情報を提案する。100〜150字")));
  it("言い回し違いの同義（足さない側に倒す）", () => truthy(saysSameThing("新条件で物件を再ピックアップして送付する", "新条件で物件を再ピックアップし送付する")));
  it("別のこと", () => falsy(saysSameThing("平野区の物件情報を提案する", "感謝を1行で受け取り、次のアクション文を1つだけ添える")));
  it("空は別物扱い", () => falsy(saysSameThing("", "平野区の物件情報を提案する")));
});

describe("実物3件（audit-brain-generation-gap で差し替わっていた物）", () => {
  const cases: Array<[string, string]> = [
    ["別保証会社の可否を確認し代替申込に備える", "我々は直前に「〇〇の条件でピックアップしてお送りします」と宣言しただけで、その宣言はまだ履行していない"],
    ["社員証代替の可否を確認する旨を伝える", "条件受領中。揃った条件（エリア・家賃）を行動宣言に埋め込んで即ピックアップ宣言。100〜180字"],
    ["審査手続き開始を報告する", "商談継続中。顧客の質問・要望を1文で受け止め、具体名詞を含むWE DO宣言を1つだけ添える。100〜150字"],
  ];
  for (const [brain, type] of cases) {
    it(`「${brain}」が届く`, () => {
      const s = buildBrainSpecificNote({ brainDirection: brain, effectiveDirection: type, fresh: true, noNewProposalScene: false });
      truthy(s.includes(brain));
    });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
