// 最終チェックの「直らない RULE_VIOLATION」2つの型（app/lib/final-check-staff-standard.ts）のテスト（自己完結ハーネス）
// 2026-10-07 竹内「最終チェックはちゃんと機能しているか」。ルールの文・指摘の引用は実物（ai_prompt_rules・line_watch_turns 28日）。
// 実行: npx tsx app/lib/__tests__/final-check-staff-standard.test.ts
import { bansStaffStandardPhrase, isMissingElementRuleFlag, isPassiveMisfire, discountPhraseAllowed, isAllowedDiscountMisfire } from "../final-check-staff-standard";
import { selectRulesForCheck } from "../final-check-rules";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

describe("① スタッフの定型を禁じる学習ルール（最終チェックに渡さない）", () => {
  it("f6e3cd53 全域を勝手に追加しない", () => eq(bansStaffStandardPhrase("お客様が記載したエリア表現（駅名・地域名・範囲指定）はそのまま使う。お客様が使っていない「全域」「周辺全域」等の修飾語を勝手に追加しない。"), "zeniki"));
  it("ac177394 ご満足…は不安の場面以外で使用禁止", () => eq(bansStaffStandardPhrase("「〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！」というフレーズは、お客様が不安を口にしている・申し訳なさそうにしている場面以外では使用禁止。"), "manzoku_support"));
  it("744f95e0 hearing の初期返信で初期費用を最大限割引は禁止", () => eq(bansStaffStandardPhrase("hearing段階の初期返信で「初期費用を最大限割引」などのコスト優遇アピールを自発的に入れるのは禁止。"), "discount_closing"));
  it("f4410208 定型文を自動追加しない", () => eq(bansStaffStandardPhrase("条件ヒアリング後のピックアップ宣言文末に「初期費用も最大限割引させて頂き〜費用を出来る限り抑えさせて頂きます！！」の定型文を自動追加しない。"), "discount_closing"));
  it("b2d7bf7f エリアの推測・絞り込みを禁じる中身があるルールは外さない", () => eq(bansStaffStandardPhrase("顧客が希望エリアを明示している場合は、そのエリアのみで物件を探し提案する。AIが会話履歴から勤務地や生活動線を推測して独自にエリアを絞り込んだり、広げたりしてはならない。「〇〇周辺全域から」といった自作のエリア表現も使わない。"), null));
  it("e206603e ご満足で締める（勧めるだけ）は外さない", () => eq(bansStaffStandardPhrase("挨拶・自己紹介の後は『ご満足いただけるお部屋が見つかるまで全力でサポートします』という寄り添い・伴走姿勢の一文で締め、金額訴求や見積り提示は次のフェーズに送ること。"), null));
  it("関係ない禁止のルールは外さない", () => eq(bansStaffStandardPhrase("「少々お待ちください」は使わない。"), null));
  it("永久ルールの節は selectRulesForCheck で外さない", () => {
    const src = "【永久ルール（最上位・絶対厳守）】\n・お客様が使っていない「全域」を勝手に追加しない。\n\n【AI学習ルール（参考）】\n・お客様が使っていない「全域」を勝手に追加しない。\n・「少々お待ちください」は使わない。";
    const sel = selectRulesForCheck(src);
    eq(sel.excludedStaffStandard, 1);
    eq((sel.text.match(/全域/g) ?? []).length, 1);
    eq(sel.text.includes("少々お待ちください"), true);
  });
});

describe("② 本文に無い要素を「言及がない」と言う RULE_VIOLATION（外す）", () => {
  it("#792 入居時期の言及がない", () => eq(isMissingElementRuleFlag("rule_check", "RULE_VIOLATION", "Brain指示には「11月末入居のご条件に合うお部屋を」と明記されているが、実返信に入居時期の言及がない", false), true));
  it("#792 「本日中に」が欠落", () => eq(isMissingElementRuleFlag("rule_check", "RULE_VIOLATION", "実返信：「ピックアップしてお送りさせて頂きます」（「本日中に」が欠落）", false), true));
  it("#488 Brain判定で必須とされた条件", () => eq(isMissingElementRuleFlag("rule_check", "RULE_VIOLATION", "本文に記載されている条件：「管理費込み10万以内・1LDK」。Brain判定で必須とされた条件：「管理費込み10万以内・1LDK・駐車場ありの条件」", false), true));
  it("#254 修正後ドラフト全文に〜の記述がない", () => eq(isMissingElementRuleFlag("rule_check", "RULE_VIOLATION", "修正後ドラフト全文に初期費用割引に関する記述がない。", false), true));
  it("引用が本文にある RULE_VIOLATION は残す", () => eq(isMissingElementRuleFlag("rule_check", "RULE_VIOLATION", "明日確認してご連絡させて頂きます", true), false));
  it("本文に無い引用でも「足りない」の形でなければ残す（写し違い等）", () => eq(isMissingElementRuleFlag("rule_check", "RULE_VIOLATION", "フェリオ永田101号室", false), false));
  it("MISSED_QUESTION（文脈の段）は対象外", () => eq(isMissingElementRuleFlag("context_check", "MISSED_QUESTION", "修正後ドラフト全文に質問への直接回答がない", false), false));
  it("FABRICATED_PROPERTY は対象外", () => eq(isMissingElementRuleFlag("anomaly_scan", "FABRICATED_PROPERTY", "言及がない", false), false));
});

describe("③ 最後の Claude の確かめで残った誤発火", () => {
  it("行動宣言への「受け身」は外す", () => eq(isPassiveMisfire("rule_check", "RULE_VIOLATION", "顧客を主語にした受け身表現が使用されている", "「YUMAさんにオススメできるお部屋ピックアップして」「YUMAさんがご満足頂くお部屋が見つかるまで」"), true));
  it("行動宣言の無い「受け身」は残す", () => eq(isPassiveMisfire("rule_check", "RULE_VIOLATION", "受け身表現", "YUMAさんのご条件に合うものがあればご連絡します"), false));
  it("⑦ 10万位（20万以内）→ 割引の一文は使ってよい", () => eq(discountPhraseAllowed("②【ご希望の家賃（8万円〜13万円）】⇒\n⑦【初期費用の限度額】⇒10万位"), true));
  it("⑦ やすくしてください → 使ってよい", () => eq(discountPhraseAllowed("②【ご希望の家賃】⇒管理費込み4.5万円以下\n⑦【初期費用の限度額】⇒やすくしてください"), true));
  it("⑦ 出来ればなし → 使ってよい（スタッフも送った）", () => eq(discountPhraseAllowed("②【ご希望の家賃】⇒8〜14万円\n⑦【初期費用の限度額】⇒出来ればなし"), true));
  it("⑦ 50万・家賃8万（3倍超かつ20万超）→ 使ってはいけない", () => eq(discountPhraseAllowed("②【ご希望の家賃】⇒6〜8万\n⑦【初期費用の限度額】⇒50万"), false));
  it("⑦ 空欄・費用の言及なし → 使ってはいけない", () => eq(discountPhraseAllowed("②【ご希望の家賃】⇒9-12\n⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒"), false));
  it("⑦ 空欄でも「初期費用はほぼ掛からない物件がいい」→ 使ってよい", () => eq(discountPhraseAllowed("家賃45,000から65,000くらい\n初期費用はほぼ掛からない物件がいいです。"), true));
  it("割引の一文以外の RULE_VIOLATION は対象外", () => eq(isAllowedDiscountMisfire("rule_check", "RULE_VIOLATION", "大阪市内全域から", "⑦⇒10万"), false));
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
