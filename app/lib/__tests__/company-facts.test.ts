// 会社として答えが決まっている事実を、聞かれた時だけ渡す関数のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/company-facts.test.ts
import { buildCompanyFactsNote, matchCompanyFacts, COMPANY_FACTS } from "../company-facts";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id);

// AI が実際に作文していた実物（通常返信の大幅書き直しから）
describe("AI が作文していた場面で、事実が渡る", () => {
  it("店舗へ伺いたい → 店舗の事実", () =>
    truthy(ids("当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います").includes("store")));
  it("緊急連絡先は必ず必要ですか → 緊急連絡先の事実", () =>
    truthy(ids("緊急連絡先は必ず必要ですか？").includes("emergency_contact")));
  it("室内写真が欲しい → 写真の事実", () =>
    truthy(ids("これ室内写真欲しいです").includes("room_photo")));
  it("キャンセルできるか → キャンセルの事実", () =>
    truthy(ids("キャンセル料はかかりますか？").includes("cancel")));
  it("遠方で行けない → 内覧方法の事実", () =>
    truthy(ids("東京在住なのですが内見はどうすればいいですか").includes("viewing_method")));
  it("申込に何が必要か → 申込の事実", () =>
    truthy(ids("申込には何が必要ですか？").includes("apply_docs")));
  it("月末入居の家賃 → 日割の事実", () =>
    truthy(ids("月末に入居したら家賃はどうなりますか？").includes("prorated_rent")));
});

// ⚠ 誤爆0の確認: 関係ない会話には一切出さない（設計知見「当たらない会話には影響しない」）
describe("関係ない発言では出さない", () => {
  const none = [
    "ありがとうございます！",
    "この物件の初期費用が知りたいです",
    "もう少し駅に近いお部屋はありますか？",
    "9月中に引っ越したいです",
    "ペット可のお部屋でお願いします",
    "はい、よろしくお願いします",
  ];
  for (const t of none) it(`「${t}」→ 空`, () => eq(buildCompanyFactsNote(t), ""));
  it("空文字・null", () => { eq(buildCompanyFactsNote(""), ""); eq(buildCompanyFactsNote(null), ""); });
});

// ⚠ 竹内「物件によって保証会社に違いあるから適当に答えない」
describe("物件によって変わる事を事実にしない", () => {
  it("保証会社の名前を持たない", () => {
    for (const f of COMPANY_FACTS) falsy(/(エポス|全保連|GTN|ジャックス|オリコ|日本セーフティ|LICC|独立系|信販系)/.test(f.fact), f.id);
  });
  it("金額を持たない（仲介手数料はブランドで違うので入れない）", () => {
    for (const f of COMPANY_FACTS) falsy(/[0-9０-９][0-9０-９,，]{2,}\s*円|仲介手数料.{0,6}(無料|0円)/.test(f.fact), `${f.id}: ${f.fact}`);
  });
  it("物件名・号室を持たない", () => {
    for (const f of COMPANY_FACTS) falsy(/\d{3,4}号室|[ァ-ヶー]{5,}\s*\d/.test(f.fact), f.id);
  });
  it("「物件によって変わる事は言い切らない」を必ず添える", () =>
    truthy(buildCompanyFactsNote("緊急連絡先は必要ですか").includes("物件によって変わる")));
  it("連帯保証人と緊急連絡先を分けて書く（竹内さんのルール）", () =>
    truthy(buildCompanyFactsNote("緊急連絡先について").includes("連帯保証人")));
});

describe("形", () => {
  it("当たった数だけ行が出る", () => {
    const s = buildCompanyFactsNote("店舗に行けますか？あと緊急連絡先は必要ですか？");
    truthy(s.includes("オンライン専門"));
    truthy(s.includes("3親等以内"));
  });
  it("見出しが付く", () => truthy(buildCompanyFactsNote("店舗ありますか").includes("【🏢 会社として答えが決まっている事実")));
  it("1回あたり 900字以内（当たるのは普通1〜2件）", () =>
    truthy(buildCompanyFactsNote("緊急連絡先は必ず必要ですか？").length < 900));
  it("すべての事実に根拠の通数がある", () => { for (const f of COMPANY_FACTS) truthy(f.n > 0, f.id); });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
