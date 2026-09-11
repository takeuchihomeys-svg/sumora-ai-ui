// 2026-09-11 竹内方針3: 呼び名（resolveAddressName / normalizeDisplayName / checkNameConsistency / unifyAddressAliases）の回帰テスト。
//   実際に呼んでいる名前のまま・途中で変えない。名前・会話は匿名化した構成（実データの型だけを残す）
// 実行: npx tsx app/lib/__tests__/name.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { resolveAddressName, normalizeDisplayName, checkNameConsistency, unifyAddressAliases, applySurfaceFixes } from "../validate-reply";

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
    toContain(item: unknown) { if (!Array.isArray(actual) || !actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
  };
}
const S = (text: string) => ({ sender: "staff", text });
const C = (text: string) => ({ sender: "customer", text });
const blocks = (text: string, canon: string, aliases: string[] = []) =>
  checkNameConsistency(text, canon, { aliases }).filter((i) => i.severity === "block").map((i) => i.code);

describe("表示名の正規化（分割し、結合しない）", () => {
  it("D1 Hayato.I→Hayato／H!tom!.M→なし／H0N0KA.→なし／愛 乃→愛乃／ゆき♡→ゆき", () => {
    expect(normalizeDisplayName("Hayato.I")).toBe("Hayato");
    expect(normalizeDisplayName("H!tom!.M")).toBe("");
    expect(normalizeDisplayName("H0N0KA.")).toBe("");
    expect(normalizeDisplayName("愛 乃")).toBe("愛乃");
    expect(normalizeDisplayName("ゆき♡")).toBe("ゆき");
  });
  it("D2 DB名の漢字フルネーム（空白区切り）は姓／「ちゃん」は剥がさない", () => {
    expect(normalizeDisplayName("高木 翔太")).toBe("高木");
    expect(normalizeDisplayName("みおなちゃん")).toBe("みおなちゃん");
  });
});

describe("呼び名の決定（直近スタッフの呼びかけが正）", () => {
  it("R1 スタッフが2行目の行頭で呼ぶ名前を拾う（表示名より優先）", () => {
    const v = resolveAddressName({ messages: [C("内見したいです"), S("はい！！\nご案内可能です😊！！\n高木さんのご都合よろしいお日にちお聞かせください！！")], displayName: "翔太", pcName: "高木 翔太" });
    expect(v.name).toBe("高木");
    expect(v.source).toBe("staff_greeting_head");
  });
  it("R2 AIX カードの物件名（🌟ネッサンス 201号室）から名前を拾わない", () => {
    const v = resolveAddressName({ messages: [S("🌟ネッサンス 201号室\n家賃6.5万円\nお手隙の際にご査収ください😌！！")], displayName: "中村 花子" });
    expect(v.name).toBe("中村");
    expect(v.source).toBe("display");
  });
  it("R3 スタッフの呼び履歴が無い時だけ名乗り（李維（リー・ウェイ）と申します）を採る", () => {
    const v = resolveAddressName({ messages: [C("はじめまして。李維（リー・ウェイ）と申します。大阪で部屋を探しています")], displayName: "LiWei" });
    expect(v.name).toBe("李維");
    expect(v.source).toBe("customer_self_intro");
  });
  it("R4 スタッフ履歴がある会話では名乗りで切り替えない（yt のまま・名乗った名前は aliases）", () => {
    const v = resolveAddressName({ messages: [S("ytさんお世話になっております！！\n募集状況確認させて頂きます！！"), C("名前は、森田と申します！")], displayName: "yt" });
    expect(v.name).toBe("yt");
    expect(v.aliases).toContain("森田");
  });
  it("R5 前方一致: 大倉優太（表示名）で姓「大倉」の呼びかけを block しない", () => {
    expect(blocks("大倉さんお世話になっております！！", "大倉優太").length).toBe(0);
  });
});

describe("検査（呼びかけ位置の別名だけを block）", () => {
  it("K1 りおなちゃんさん を block しない", () => {
    expect(blocks("りおなちゃんさんお世話になっております！！", "りおなちゃん").length).toBe(0);
    expect(blocks("りおなちゃんさんお世話になっております！！", "りおな").length).toBe(0);
  });
  it("K2 物件名のカタカナ「サン」（モンサント旭町・都度サンメゾン）を名前として拾わない", () => {
    expect(blocks("モンサント旭町の募集状況確認させて頂きます！！", "高木").length).toBe(0);
    expect(blocks("都度サンメゾンの初期費用お送りさせて頂きます！！", "高木").length).toBe(0);
  });
  it("K3 紹介者・会話相手の文脈（くぼさんとお話し・あさみさんよりご紹介）を block しない", () => {
    expect(blocks("先日くぼさんとお話しさせて頂きました件です！！", "高木").length).toBe(0);
    expect(blocks("あさみさんよりご紹介頂きありがとうございます！！", "高木").length).toBe(0);
  });
  it("K4 呼びかけ位置の別人（清水さんの会話で「吉永さんお世話になっております」）は block する", () => {
    expect(blocks("吉永さんお世話になっております！！\n募集状況確認させて頂きます！！", "清水")).toContain("NAME_MISMATCH");
  });
  it("K5 aliases（スタッフが過去に呼んだ名前）は呼びかけ位置でも block しない", () => {
    expect(blocks("森田さんお世話になっております！！", "yt", ["森田"]).length).toBe(0);
  });
});

describe("後処理（別名を確定名へ統一）", () => {
  it("U1 呼びかけ位置の別名 → 確定名（NAME_ALIAS_UNIFIED）", () => {
    const r = unifyAddressAliases("翔太さんお世話になっております！！\n翔太さんにオススメのお部屋ピックアップさせて頂きます！！", "高木", ["翔太"]);
    expect(r.text).toBe("高木さんお世話になっております！！\n高木さんにオススメのお部屋ピックアップさせて頂きます！！");
    expect(r.fixes.length).toBe(1);
  });
  it("U2 applySurfaceFixes は別名の統一と誤字（さんさん）を同じ入口で直す", () => {
    const r = applySurfaceFixes("翔太さんさんお世話になっております！！", { customerName: "高木", aliases: ["翔太"] });
    expect(r.text.startsWith("高木さん")).toBe(true);
    expect(r.text.includes("さんさん")).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
