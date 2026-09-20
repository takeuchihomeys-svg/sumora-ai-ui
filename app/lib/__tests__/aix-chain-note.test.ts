// AIX の1通目を読んで2通目の材料にする（竹内「AIX の内容との関係性での生成が重要」）。
//
// テストの材料は**実物**（scripts/audit-aix-chain-coherence.ts が出した実送信のペア）を使う。
// 実測（直近90日・1通目→30分以内の2通目 1,419組）:
//   1通目「ピックアップしました」33.3% → 2通目で未来形にする 0.2%
//   1通目「ご査収」41.2% → 2通目にも書く 3.1%
//   1通目に挨拶 50.8% → 2通目にも書く 2.0%
//   2通目の長さ 中央値120字
//
// 実行: npx tsx app/lib/__tests__/aix-chain-note.test.ts（全 PASS で exit 0）
import { readFirstMessage, buildAixChainNote } from "../aix-chain-note";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (Array.isArray(actual) ? !actual.includes(item) : typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}

// ── 実物（2026-09-20 の実送信）──
const PICKUP_1ST = "じゅなさんお待たせ致しました！！\n\n大阪市内周辺全域からじゅなさんご希望の家賃管理費込み12万円以内・2LDK以上・駅徒歩15分以内・リビング広めのファミリー向けのお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
const RECOMMEND_1ST = "🌟フォルモント寺田町 304\n\n（オススメポイント）\n・家賃94,000円・管理費10,000円（合計104,000円）\n・間取り：1LDK（リビング10.3帖、洋室6.2帖）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！";
const ESTIMATE_1ST = "【ジュネーゼグラン難波ミラージュ 1203号室】\n\n初期費用さらに\n🌟22,000円割引させて頂き\n初期費用：139,000円\n\nギガ賃貸なら一般的な不動産業者より90,310円節約出来ます！！";
const CHECK_1ST = "お探しの地域周辺でご条件に合ったお部屋の募集が現在ない形となります！！\nご希望の駅から離れますがこちらのお部屋如何でしょうか！！";

describe("1通目を読む（実物）", () => {
  it("★ R1 物件ピックアップ: 挨拶・ご査収・ピックアップ完了を全部読む", () => {
    const f = readFirstMessage(PICKUP_1ST);
    expect(f.hasGreeting).toBe(true);
    expect(f.hasReceipt).toBe(true);
    expect(f.declaredDone).toContain("pickup");
  });

  it("★ R2 見積書: 金額があることを読む（2通目で金額を書き直させない）", () => {
    const f = readFirstMessage(ESTIMATE_1ST);
    expect(f.hasAmount).toBe(true);
    expect(f.propertyLabels).toContain("ジュネーゼグラン難波ミラージュ 1203号室");
  });

  it("R3 物件オススメ: 物件名と号室を拾う", () => {
    const f = readFirstMessage(RECOMMEND_1ST);
    expect(f.propertyLabels).toContain("フォルモント寺田町 304号室");
  });

  it("★ R4 家賃・管理費の行を物件名と間違えない", () => {
    const f = readFirstMessage(RECOMMEND_1ST);
    const bad = f.propertyLabels.filter((l) => /家賃|管理費|合計|初期費用/.test(l));
    expect(JSON.stringify(bad)).toBe("[]");
  });

  it("R5 募集なしの報告は check として読む", () => {
    expect(readFirstMessage(CHECK_1ST).declaredDone).toContain("check");
  });

  it("R6 1通目が空なら何も主張しない", () => {
    const f = readFirstMessage("");
    expect(f.hasGreeting).toBe(false);
    expect(f.hasReceipt).toBe(false);
    expect(JSON.stringify(f.declaredDone)).toBe("[]");
    expect(JSON.stringify(f.propertyLabels)).toBe("[]");
  });
});

describe("2通目への指示を作る", () => {
  it("★ N1 ピックアップ済みなら「これからピックアップします」を禁じる", () => {
    const note = buildAixChainNote(PICKUP_1ST);
    expect(note).toContain("送り終えた");
    expect(note).toContain("ピックアップさせて頂きます");
    expect(note).toContain("これからやる形で書かない");
  });

  it("★ N2 挨拶とご査収の重ねを禁じる（実測 2.0% / 3.1%）", () => {
    const note = buildAixChainNote(PICKUP_1ST);
    expect(note).toContain("挨拶行を重ねない");
    expect(note).toContain("繰り返さない");
  });

  it("★ N3 見積書の1通目なら金額を書き直させない", () => {
    const note = buildAixChainNote(ESTIMATE_1ST);
    expect(note).toContain("金額・割引額・節約額を書き直さない");
  });

  it("★ N4 1通目の物件だけに限る（会話履歴の別物件を持ち出させない）", () => {
    const note = buildAixChainNote(RECOMMEND_1ST);
    expect(note).toContain("フォルモント寺田町 304号室");
    expect(note).toContain("これ以外の物件名・号室を出さない");
  });

  it("N5 1通目の本文そのものを渡す（AI が中身を読めるように）", () => {
    expect(buildAixChainNote(PICKUP_1ST)).toContain("大阪市内周辺全域から");
  });

  it("N6 長さの目安（実送信の中央値120字）を伝える", () => {
    expect(buildAixChainNote(PICKUP_1ST)).toContain("120字前後");
  });

  // 2026-09-20 竹内「残る差もテストして改善する」: YUMA で 名前100%（実送信35.1%）・条件0%（30.7%）・物件名13%（36.0%）だった
  it("★ N10 1通目用の指示5つを名指しで上書きする（呼びかけを含む）", () => {
    const n = buildAixChainNote(PICKUP_1ST);
    expect(n).toContain("文章構造の原則");
    expect(n).toContain("この種別の書き方");
    expect(n).toContain("CTA強度の上書き");
    expect(n).toContain("呼びかけは実名のみ");
    expect(n).toContain("毎回付ける意味ではない");
  });
  it("★ N11 呼びかけ・物件名・条件の実送信の割合を見せる（消えすぎを戻す）", () => {
    const n = buildAixChainNote(PICKUP_1ST);
    expect(n).toContain("呼びかけ「〇〇さん」… 35%");
    expect(n).toContain("物件名・号室 … 36%");
    expect(n).toContain("条件の復唱");
    expect(n).toContain("31%");
  });
  it("★ N12 禁じているのは「並べ直し」だと明示する（1つ触れるのは可）", () => {
    const n = buildAixChainNote(PICKUP_1ST);
    expect(n).toContain("禁じているのは「・」で並べ直すこと");
    expect(n).toContain("文の中で1つ触れるのは実送信どおり");
  });
  it("★ N13 CTA は「毎回は付けない」であって「付けるな」ではない（0%に振れないように）", () => {
    const n = buildAixChainNote(PICKUP_1ST);
    expect(n).toContain("付けてはいけない訳でもない");
    expect(n).toContain("約7通に1通");
    expect(n).toContain("前向きな反応");
  });

  it("★ N7 1通目が無ければ空文字（無条件に指示を足さない）", () => {
    expect(buildAixChainNote("")).toBe("");
    expect(buildAixChainNote(null)).toBe("");
    expect(buildAixChainNote(undefined)).toBe("");
  });

  it("★ N8 読み取れる物が何も無い1通目でも空文字（空の指示ブロックを作らない）", () => {
    expect(buildAixChainNote("承知しました")).toBe("");
  });

  it("N9 長い1通目は600字で切り詰める（プロンプトを膨らませない）", () => {
    const long = `${PICKUP_1ST}\n${"あ".repeat(900)}`;
    const note = buildAixChainNote(long);
    expect(note).toContain("…");
    // 1通目そのものは600字までしか入らない（指示の分は別に数える）
    expect(note.includes("あ".repeat(601))).toBe(false);
    // 2026-09-20: 指示（1通目用の上書き・実送信の割合）を足した分ブロックは伸びた。
    //   見るのは「1通目が青天井に入らないこと」なので、全体の上限は実測に合わせて緩める
    expect(note.length < 2400).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
