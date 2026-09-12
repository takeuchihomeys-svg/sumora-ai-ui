// 2026-09-11 竹内方針3: 呼び名（resolveAddressName / normalizeDisplayName / checkNameConsistency / unifyAddressAliases）の回帰テスト。
//   実際に呼んでいる名前のまま・途中で変えない。名前・会話は匿名化した構成（実データの型だけを残す）
// 実行: npx tsx app/lib/__tests__/name.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { resolveAddressName, normalizeDisplayName, checkNameConsistency, unifyAddressAliases, applySurfaceFixes, canonOf, sameReading } from "../validate-reply";
import { buildFirstGreeting } from "../greeting";
import { mergeHistoryForAddress } from "../address-history";

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

describe("元の名前の固定（2026-09-12 竹内方針C）", () => {
  // 実データの型: 名乗り・申込フォーマット・本人確認書類の直後にスタッフが一時的に開示名へ切り替え、3会話とも元の名前に戻っている
  it("R6 名乗り → スタッフが一時的に開示名で呼ぶ → 次の返信は元の名前（yt 型）", () => {
    const v = resolveAddressName({ messages: [
      S("ytさんお世話になっております！！\n募集状況確認させて頂きます！！"),
      C("名前は、森田と申します！\n宜しくお願いします"),
      S("森田さん、お名前お伝え頂きありがとうございます😊！！"),
      S("森田さんお世話になっております！！\n初期費用お送りさせて頂きます！！"),
      C("ありがとうございます"),
    ], displayName: "yt" });
    expect(v.name).toBe("yt");
    expect(v.source).toBe("staff_original_locked");
    expect(v.aliases).toContain("森田");
  });
  it("R7 申込フォーマットの申込者欄の姓 → スタッフが一時切替しても元の名前（まりあ型）。連帯保証人欄の氏名は開示に数えない", () => {
    const form = "個人用\n【お申込者様記入欄】\n・入居希望日8/1\n・氏名、フリガナ 山川 花子 ヤマカワ ハナコ\n・生年月日 2000/1/1\n\n【連帯保証人様記入欄】\n・氏名、フリガナ 谷口 綾子 タニグチ アヤコ";
    const v = resolveAddressName({ messages: [
      S("はなさんお世話になっております！！\nお申込フォーマットお送りさせて頂きます！！"),
      C(form),
      S("山川さんお世話になっております！！\n管理会社に審査申込させて頂きます！！"),
    ], displayName: "はな" });
    expect(v.name).toBe("はな");
    expect(v.source).toBe("staff_original_locked");
    expect(v.aliases).toContain("山川");
    // 保証人欄の姓でスタッフが呼んだ場合は開示名に当たらない（固定しない＝従来どおり最新の呼び名）
    const w = resolveAddressName({ messages: [S("はなさんお世話になっております！！"), C(form), S("谷口さんお世話になっております！！")], displayName: "はな" });
    expect(w.name).toBe("谷口");
  });
  it("R7b 氏名が次の行にあるフォーマット・本人確認書類の OCR（氏名：江川　紀之 … 運転免許証）も開示に数える", () => {
    const v1 = resolveAddressName({ messages: [
      S("ノリさんお世話になっております！！"),
      C("【お申込者様記入欄】\n・氏名、フリガナ\n江川　紀之\nエガワ　ノリユキ\n・生年月日\n1980年1月1日"),
      S("江川さんお世話になっております！！"),
    ], displayName: "Nori E" });
    expect(v1.name).toBe("ノリ");
    const v2 = resolveAddressName({ messages: [
      S("Noriさんお世話になっております！！"),
      C("[画像] 氏名：江川　紀之\n生年月日：昭和55年1月1日生\n運転免許証"),
      S("江川さんお世話になっております！！"),
    ], displayName: "Nori E" });
    expect(v2.name).toBe("Nori");
  });
  it("R7c 開示と関係ない恒久切替（開示なしで かずし→福本）は最新のスタッフの呼び名に従う", () => {
    const v = resolveAddressName({ messages: [S("かずしさんお世話になっております！！"), C("よろしくお願いします"), S("福本さんお世話になっております！！")], displayName: "かずし" });
    expect(v.name).toBe("福本");
    expect(v.source).toBe("staff_greeting_head");
  });
  it("R7d 同じ名前の表記替え（Hitomi → 本人確認書類 → ひとみ）は固定しない（ローマ字⇔仮名は同じ名前）", () => {
    const v = resolveAddressName({ messages: [
      S("Hitomiさんお世話になっております！！"),
      C("[画像] 氏名 松下 ひとみ\n個人番号カード"),
      S("ひとみさんお世話になっております！！"),
    ], displayName: "H!tom!.M" });
    expect(v.name).toBe("ひとみ");
  });
  it("R7e 開示の前からスタッフが同じ名前で呼んでいた（初回から名乗った名前）は固定しない", () => {
    const v = resolveAddressName({ messages: [
      C("はじめまして。李維（リー・ウェイ）と申します"),
      S("李維さん、はじめまして😊！！"),
      S("李維さんお世話になっております！！"),
    ], displayName: "LiWei" });
    expect(v.name).toBe("李維");
    expect(v.source).toBe("staff_greeting_head");
  });
  it("R8 AIX だけが別の名前（MATSUO）→ 人間スタッフの呼び名（YUYA）を採る。AIX の名前は aliases", () => {
    const v = resolveAddressName({ messages: [
      S("YUYAさんお世話になっております！！"),
      { sender: "staff", text: "MATSUOさんにオススメのお部屋ピックアップさせて頂きました😊！！", isAix: true },
    ], displayName: "MATSUO YUYA" });
    expect(v.name).toBe("YUYA");
    expect(v.aliases).toContain("MATSUO");
    // 人間の呼び履歴が無い時は AIX の呼び名を採る
    const w = resolveAddressName({ messages: [{ sender: "staff", text: "MATSUOさんにオススメのお部屋ピックアップさせて頂きました😊！！", isAix: true }], displayName: "MATSUO YUYA" });
    expect(w.name).toBe("MATSUO");
  });
  it("R9 固定後は別名（一時的に使った名前）を元の名前へ統一する", () => {
    const r = applySurfaceFixes("森田さんお世話になっております！！\n初期費用お送りさせて頂きます！！", { customerName: "yt", aliases: ["森田"] });
    expect(r.text.startsWith("ytさん")).toBe(true);
  });
});

describe("確定名を再正規化しない（canonOf）", () => {
  it("N1 「りおなちゃん」はそのまま（初回挨拶・名前スロット）。空白区切りの生の値は姓", () => {
    expect(canonOf("りおなちゃん")).toBe("りおなちゃん");
    expect(buildFirstGreeting("りおなちゃん").startsWith("りおなちゃんさん、")).toBe(true);
    expect(canonOf("山田 太郎")).toBe("山田");
    expect(canonOf("名称未設定")).toBe("");
  });
  it("N2 validateAndClean の名前スロット（〇〇さん）も「ちゃん」を剥がさない", () => {
    const r = applySurfaceFixes("〇〇さんお世話になっております！！", { customerName: "りおなちゃん", fillName: true });
    expect(r.text.startsWith("りおなちゃんさん")).toBe(true);
  });
  it("N3 sameReading: Hitomi＝ひとみ・Yoko＝ようこ・Shota＝しょうた／Hitomi≠ひろみ", () => {
    expect(sameReading("Hitomi", "ひとみ")).toBe(true);
    expect(sameReading("Yoko", "ようこ")).toBe(true);
    expect(sameReading("SHOTA", "しょうた")).toBe(true);
    expect(sameReading("Hitomi", "ひろみ")).toBe(false);
  });
});

describe("サーバー側の履歴のつなぎ方（mergeHistoryForAddress）", () => {
  it("H1 窓より前の DB 行だけを前につなぎ、窓の isAix が無ければ DB の is_aix_generated で補う", () => {
    const db = [
      { sender: "staff", text: "MATSUOさんにオススメです", created_at: "2026-08-25T03:00:00Z", is_aix_generated: true },
      { sender: "staff", text: "YUYAさんお世話になっております！！", created_at: "2026-08-20T03:00:00Z", is_aix_generated: false },
    ];
    const merged = mergeHistoryForAddress([{ sender: "staff", text: "MATSUOさんにオススメです", createdAt: "2026-08-25T03:00:00.000Z" }], db);
    expect(merged.length).toBe(2);
    expect(merged[0].text).toBe("YUYAさんお世話になっております！！");
    expect(merged[1].isAix).toBe(true);
    expect(resolveAddressName({ messages: merged, displayName: "MATSUO YUYA" }).name).toBe("YUYA");
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
