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
  it("金額を持たない（仲介手数料はブランドで違うので入れない。手数料率3.24%は全物件共通なので可）", () => {
    for (const f of COMPANY_FACTS) falsy(/[0-9０-９][0-9０-９,，]{2,}\s*円|仲介手数料.{0,6}(無料|0円)/.test(f.fact), `${f.id}: ${f.fact}`);
  });
  it("物件名・号室を持たない", () => {
    for (const f of COMPANY_FACTS) falsy(/\d{3,4}号室|[ァ-ヶー]{5,}\s*\d/.test(f.fact), f.id);
  });
  it("「物件によって変わる事は言い切らない」を必ず添える", () =>
    truthy(buildCompanyFactsNote("緊急連絡先は必要ですか").includes("物件によって変わる")));
  it("連帯保証人と緊急連絡先を分けて書く（竹内さんのルール）", () =>
    truthy(buildCompanyFactsNote("緊急連絡先について").includes("連帯保証人")));
  // 2026-09-26 竹内さん決定（保証会社の知識を直す）
  it("緊急連絡先は確認の電話だけ・支払い義務は無い", () => {
    const f = COMPANY_FACTS.find((x) => x.id === "emergency_contact")!.fact;
    truthy(/確認のお電話が入るだけ/.test(f), f);
    truthy(/支払い義務は無い/.test(f), f);
  });
  it("審査期間は「3日〜10日」（旧「3〜5日」「3日〜1週間」を持たない）", () => {
    const all = COMPANY_FACTS.map((x) => x.fact).join("\n");
    truthy(all.includes("3日〜10日"), "3日〜10日");
    falsy(/3〜5日|3日〜5日|3日〜1週間/.test(all), all);
  });
  // 2026-09-26 竹内さん訂正: 種類は4つ（独立系・LICC系・信販系・信用系）で、会社ごとの種類は guarantor-companies.ts のマスタ1本。
  //   会社の事実（company-facts）には種類を入れない（入れると取り違えがマスタと食い違う＝fd989546 で信用系を信販系と書いた事故の再発を防ぐ）
  it("保証会社の種類名（独立系・LICC系・信販系・信用系）を持たない（種類はマスタ1本）", () => {
    for (const f of COMPANY_FACTS) falsy(/独立系|LICC系|信販系|信用系/.test(f.fact), f.id);
  });
});

// ── 2026-09-23 S6 の実測（今月の当たり76通を全部読んだ）: 当たりの50%が [画像] の書き起こし ──
describe("[画像] の書き起こしには当てない（誤当たりの50%）", () => {
  const tiktok = "[画像] 初期費用ゼロ（前家賃だけ）\n1LDK 6万円 ペット可\n無料 お問い合わせ";
  const suumo = "[画像] 取り扱い店舗\n受付店舗\n間取り/画像一覧・室内写真\n7.9万円/管理費 -";
  it("TikTok の「初期費用ゼロ（前家賃だけ）」→ 日割に当てない", () => eq(ids(tiktok).length, 0));
  it("SUUMO の「取り扱い店舗」「室内写真」→ 店舗・写真に当てない", () => eq(ids(suumo).length, 0));
  it("配列: 画像の通は外し、文の通だけ当てる（brain-core の3通）", () =>
    eq(ids([tiktok, "キャンセル料はかかりますか？", suumo].join("\n")).length, 0),
  );
  it("配列で渡すと文の通は当たる", () => {
    const hit = matchCompanyFacts([tiktok, "キャンセル料はかかりますか？", suumo]).map((f) => f.id);
    truthy(hit.includes("cancel"));
    falsy(hit.includes("prorated_rent"));
    falsy(hit.includes("store"));
  });
  it("通の区切り（MSG_SEP）でも画像の通だけ外れる", () => {
    const hit = matchCompanyFacts(`${tiktok}\n⁣\n店舗に伺えますか？`).map((f) => f.id);
    truthy(hit.includes("store"));
    falsy(hit.includes("prorated_rent"));
  });
});

// ── 2026-09-23 S6 の当たり漏れ（お客様が聞き、スタッフが事実で答えたのに当たらなかった3通）──
describe("当たり漏れを拾う", () => {
  it("オンラインで内覧などは可能でしょうか？ → 内覧方法", () =>
    truthy(ids("オンラインで内覧などは可能でしょうか？").includes("viewing_method")));
  it("写真お願いできますか？ → 写真", () => truthy(ids("写真お願いできますか？").includes("room_photo")));
  // 2026-09-23 竹内: 写真の判定はブレインの場面と同じ isRoomPhotoRequest（反証で見つかった書類の写真の誤当たりを外す）
  it("申込書類の記入箇所の写真・明細書の画像・内定通知の画像 → 写真の事実を渡さない", () => {
    falsy(ids("記入が必要な箇所の写真もう一度送っていただけないでしょうか").includes("room_photo"));
    falsy(ids("初期費用の明細書を\nこのよう形で画像でもお送りいただくことは可能でしょうか…？").includes("room_photo"));
    falsy(ids("内定通知の画像をテンプしないといけないみたいなんですが、もらえますか？").includes("room_photo"));
    falsy(ids("この写真のような、物件があれば幸いです").includes("room_photo"));
  });
  it("写真の事実は AIX【物件確認した→室内写真を確認した】から送る流れ・撮影の約束もしない", () => {
    const s = buildCompanyFactsNote("お部屋の画像ありますでしょうか？");
    truthy(s.includes("AIX【物件確認した→室内写真を確認した】")); truthy(s.includes("撮影して送るとも約束しない"));
  });
  it("親と縁切れてる場合でも親の連絡先いりますか？ → 緊急連絡先", () =>
    truthy(ids("親と縁切れてる場合でも親の連絡先いりますか？").includes("emergency_contact")));
  it("緊急連絡先欄の記入そのもの（改行あり）は渡さない", () =>
    falsy(ids("緊急連絡先\n氏名: 山田太郎\nフリガナ: ヤマダタロウ\n続柄: 父\n生年月日: 1960/1/1").includes("emergency_contact")));
});

// ── 2026-09-23 S7 の実測: 埋もれた質問「クレカ払いはできますか」に答えない／事実違い ──
describe("クレジットカード払い（実送信25通で一貫: 対応・手数料3.24%・分割はカードのみ）", () => {
  it("あとクレカ払いはできますか？ → 事実が渡る", () => truthy(ids("あとクレカ払いはできますか？").includes("credit_card")));
  it("初期費用カード決済可能ですか → 渡る", () => truthy(ids("初期費用カード決済可能ですか？").includes("credit_card")));
  it("分割払いはできますか → 渡る（答えはカードの分割のみ）", () => truthy(ids("初期費用の分割払いはできますか？").includes("credit_card")));
  it("保証会社の話（クレカ系は控えたい・クレカブラック）には渡さない", () => {
    falsy(ids("保証会社はクレカ系は控えたいです").includes("credit_card"));
    falsy(ids("クレカブラックなのと、夜職なので給料明細だせませんが").includes("credit_card"));
  });
  it("事実に手数料と「対応していないと断定しない」がある", () => {
    const s = buildCompanyFactsNote("クレカ払いはできますか？");
    truthy(s.includes("3.24%"));
    truthy(s.includes("対応していない」と断定しない"));
  });
});

describe("形", () => {
  it("当たった数だけ行が出る", () => {
    const s = buildCompanyFactsNote("店舗に行けますか？あと緊急連絡先は必要ですか？");
    truthy(s.includes("オンライン専門"));
    truthy(s.includes("3親等以内"));
  });
  it("質問に必ず答えるよう優先を宣言する（埋もれた質問の穴・2026-09-23）", () =>
    truthy(buildCompanyFactsNote("店舗に行けますか").includes("先に、この質問へ本文で必ず答える")));
  it("見出しが付く", () => truthy(buildCompanyFactsNote("店舗ありますか").includes("【🏢 会社として答えが決まっている事実")));
  it("1回あたり 900字以内（当たるのは普通1〜2件）", () =>
    truthy(buildCompanyFactsNote("緊急連絡先は必ず必要ですか？").length < 1000));
  it("すべての事実に根拠の通数がある", () => { for (const f of COMPANY_FACTS) truthy(f.n > 0, f.id); });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
