// 2026-10-20 竹内さんの決定（設計知見 d6b6edc1・c16e9f4a 10/20）: 他社でこれから内覧する予定を伝えられた時は否定せず、
//   弊社でも内覧できる・弊社で内覧する利点で誘う。LLM なしのテスト（読み・会社の事実の文・訴求の判定）。
// 実行: npx tsx app/lib/__tests__/other-viewing-invite.test.ts
import { isOtherAgentViewingPlan, isOtherAgentViewingApplyQuestion } from "../other-agent-viewing";
import { matchCompanyFacts, buildCompanyFactsNote } from "../company-facts";
import { buildAppealInput, resolveAppealTiming } from "../appeal-timing";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`「${sub}」が無い: ${s.slice(0, 160)}`); }
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id);

// 本番 10/20 の発言（物件名は伏せた）
const AIMI = "圧倒的スモラさんの方が安いので契約スモラさんでしたいのですが、他社さんで〇〇の内見の予定あって、一度そっちでサクッと内見だけしてこようかなと思ってるんですが大丈夫でしょうか？？";
const Q166 = "明日もともとスーモに乗せていた\n不動産屋さんに依頼して\n内覧予定になってるんですが\n気に入ればそのまま\nこちらでお願いとかもできますか？";

console.log("読み（他社でこれから内覧する予定）");
it("10/20 本番: 他社で内見の予定・サクッと内見してこようかな → 予定", () => eq(isOtherAgentViewingPlan(AIMI), true));
it("q166: スーモの不動産屋に依頼して内覧予定＋こちらでお願いできるか → 予定（申込の問いも当たる）", () => {
  eq(isOtherAgentViewingPlan(Q166), true); eq(isOtherAgentViewingApplyQuestion(Q166), true);
});
it("別の不動産で内覧予定です → 予定", () => eq(isOtherAgentViewingPlan("別の不動産で内覧予定です。"), true));
it("✕ 他社で内覧しましたが、こちらで申込できますか（もう見た＝今まで通り）", () => {
  eq(isOtherAgentViewingPlan("他社で内覧しましたが、こちらで申込できますか？"), false);
  eq(isOtherAgentViewingApplyQuestion("他社で内覧しましたが、こちらで申込できますか？"), true);
});
it("✕ 仲介業者さんで内見したお部屋、そちらで申し込みできますか（過去）", () => eq(isOtherAgentViewingPlan("仲介業者さんで内見したお部屋、そちらで申し込みできますか？"), false));
it("✕ 他社で見た物件、こちらでも内覧お願いできますか（弊社での内覧の希望）", () => eq(isOtherAgentViewingPlan("他社で明日見る予定の物件ですが、こちらでも内覧お願いできますか？"), false));
it("✕ 他社の内見はキャンセルしました", () => eq(isOtherAgentViewingPlan("他社の内見予定はキャンセルしました"), false));
it("✕ もう見た＋別の予定語（明日申込・来週契約予定・予約できますか・予定がなくなった）", () => {
  for (const t of ["他社で内覧しました。明日申込したいです", "他社で内見してきました。こちらで予約できますか？", "他社で内覧済みです、来週契約予定です", "他社の内見予定がなくなりました"]) eq(isOtherAgentViewingPlan(t), false, t);
});
it("他社で明日内見してきます（これから）→ 予定", () => eq(isOtherAgentViewingPlan("他社で明日内見してきます"), true));
it("10/20 別の不動産屋でオンライン内見してここにきめようかな → 予定", () => eq(isOtherAgentViewingPlan("もし空いてたら別の不動産屋でオンライン内見してここにきめようかなと"), true));
it("✕ 別の不動産屋で内見してここに決めました（過去）", () => eq(isOtherAgentViewingPlan("別の不動産屋で内見してここに決めました"), false));
it("✕ 他社の話が無い「明日内覧予定です」", () => eq(isOtherAgentViewingPlan("明日内覧予定です"), false));
it("戻す OTHER_VIEWING_INVITE=off で当たらない", () => eq(isOtherAgentViewingPlan(AIMI, { OTHER_VIEWING_INVITE: "off" }), false));

console.log("会社の事実");
it("10/20 本番 → other_company_viewing と other_company_viewing_plan の両方", () => {
  const got = ids(AIMI); eq(got.includes("other_company_viewing"), true, "既存"); eq(got.includes("other_company_viewing_plan"), true, "予定");
});
it("過去の内覧の問い → 既存の事実だけ（誘いの事実は渡さない）", () => {
  const got = ids("他社で内覧しましたが、こちらで申込できますか？"); eq(got.includes("other_company_viewing"), true); eq(got.includes("other_company_viewing_plan"), false);
});
it("誘いの事実の文に ①受け止め ②弊社でも内覧できる ③利点 と「日時は書かない」が入っている", () => {
  const note = buildCompanyFactsNote(AIMI);
  has(note, "大丈夫です😊！！");
  has(note, "弊社にてご内見可能です");
  has(note, "ご挨拶も兼ねまして一度ご内見頂ければ");
  has(note, "ご安心してお任せ頂けると思います");
  has(note, "内覧の日時（候補）はこの返信に書かない");
  has(note, "弊社でお申込みしてお部屋を抑えられる");
});
it("既存の事実の文も「弊社でもご内覧できる旨は添える」", () => has(buildCompanyFactsNote("他社で内覧しましたが、こちらで申込できますか？"), "弊社でもご内覧できる旨は添える"));
it("COMPANY_FACT_1014=off で誘いの事実も止まる", () => {
  process.env.COMPANY_FACT_1014 = "off";
  try { eq(ids(AIMI).includes("other_company_viewing_plan"), false); } finally { delete process.env.COMPANY_FACT_1014; }
});

console.log("訴求の判定（OTHER_VIEWING_INVITE_APPEAL・既定は切）");
const msgs = [
  { sender: "staff", text: "【〇〇 406号室】\n\n初期費用さらに\n🌟82,000円", createdAt: "2026-10-20T03:51:08Z" },
  { sender: "customer", text: AIMI.replace("契約スモラさんでしたい", "スモラさんで契約したい"), createdAt: "2026-10-20T03:53:08Z" },
];
it("既定（切）: 入力に印が付かない＝今まで通り", () => {
  delete process.env.OTHER_VIEWING_INVITE_APPEAL;
  const i = buildAppealInput({ msgs, aixLogs: [{ aixType: "estimate_sheet", at: "2026-10-20T03:51:08Z" }], customerKind: "question" });
  eq(i.otherAgentViewingPlan, false);
});
it("入（on）: 申込の意思があっても弊社での内覧に誘う（日時は書かない）", () => {
  process.env.OTHER_VIEWING_INVITE_APPEAL = "on";
  try {
    const i = buildAppealInput({ msgs, aixLogs: [{ aixType: "estimate_sheet", at: "2026-10-20T03:51:08Z" }], customerKind: "question" });
    eq(i.otherAgentViewingPlan, true); eq(i.customer, "apply_intent");
    const v = resolveAppealTiming(i);
    eq(v.kind, "viewing"); has(v.note, "弊社にてご内見可能です"); has(v.note, "内覧の日時はこの返信に書かない");
  } finally { delete process.env.OTHER_VIEWING_INVITE_APPEAL; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
