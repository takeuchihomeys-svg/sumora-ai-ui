// applying（申込・審査中）への自動昇格の判定と、申込フォーム検知の線のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/applying-promotion.test.ts
// 2026-09-23 課題②: 画像の旗が全会話で0件だった昇格条件を、実物の会話の並び（AIX【申込へ】→ フォーム文 → 本人確認書類）で直した
import { resolveApplyingPromotion, shouldSetApplyingImageFlag, applicationPushIsFresh, APPLICATION_PUSH_FRESH_DAYS, STAFF_FORM_REQUEST_RE } from "../applying-promotion";
import { isApplicationFormMessage, hasApplyHintKeyword, PRE_APPLY_STATUSES } from "../application-form-detect";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const H = 3600_000, D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-09-20T10:00:00Z");

// ── ① 申込フォーム検知の線（実物の形・値はダミー）──────────────────────
describe("即時語1語だけ・項目0 の普通の文はフォームでない（誤検知の実物 9e45b9a1／6e0d57a5 の形）", () => {
  // 実物: 「法人契約」1語・243字・項目0・後で否決→再検索になった会話。status が動いてはいけない
  it("「法人契約は可能でしょうか」型の質問 → 非検知", () =>
    falsy(isApplicationFormMessage("お世話になっております。こちらの物件ですが、法人契約は可能でしょうか？会社の福利厚生で家賃補助が出るので、可能であれば法人で借りたいと考えています。難しい場合は個人で申込を検討します。よろしくお願いいたします。").detected));
  it("「法人名義でも大丈夫ですか」→ 非検知", () =>
    falsy(isApplicationFormMessage("法人名義でも大丈夫ですか？").detected));
  it("「入居申込書はどこで貰えますか」→ 非検知（入居申込書 ⊃ 申込書 を項目に数えない）", () =>
    falsy(isApplicationFormMessage("入居申込書はどこで貰えますか？").detected));
  it("「申込フォームを送ってください」→ 非検知", () =>
    falsy(isApplicationFormMessage("申込フォームを送ってください").detected));
});

// 実物のフォーマット（AIX【申込へ】の後にスタッフが送る個人用の項目18・値はダミー）
const INDIVIDUAL_FORM = [
  "【入居申込書】",
  "①氏名：山田 太郎", "②フリガナ：ヤマダ タロウ", "③生年月日：1990年1月1日", "④現住所：東京都〇〇区1-1-1",
  "⑤電話番号：090-0000-0000", "⑥メール：test@example.com", "⑦勤務先：株式会社サンプル", "⑧勤務先住所：東京都〇〇区2-2-2",
  "⑨勤務先電話：03-0000-0000", "⑩職業：会社員", "⑪年収：400万円", "⑫勤続年数：3年", "⑬入居者：本人のみ",
  "⑭緊急連絡先：山田 花子", "⑮続柄：母", "⑯緊急連絡先電話：090-1111-1111", "⑰住居年数：2年", "⑱保証人：なし",
].join("\n");
const CORPORATE_FORM = [
  "【法人御契約】", "法人名：株式会社サンプル", "代表者名：山田 太郎", "登記住所：東京都〇〇区1-1-1",
  "設立：2010年", "資本金：1000万円", "事業内容：IT", "従業員数：20名", "入居者名：山田 次郎",
].join("\n");

describe("本物のフォームは検知する（項目8+ の個人フォームは86.4%が申込に至った実物の形）", () => {
  it("個人フォーム（項目18・即時語あり）→ individual", () => { const r = isApplicationFormMessage(INDIVIDUAL_FORM); truthy(r.detected); eq(r.formType, "individual"); });
  it("個人フォーム（即時語なし・項目だけ）→ individual", () => { const r = isApplicationFormMessage(INDIVIDUAL_FORM.replace("【入居申込書】\n", "")); truthy(r.detected); eq(r.formType, "individual"); });
  it("法人フォーム（【法人御契約】＋項目）→ corporate", () => { const r = isApplicationFormMessage(CORPORATE_FORM); truthy(r.detected); eq(r.formType, "corporate"); });
  it("法人フォーム（即時語なし・項目2以上）→ corporate", () => { const r = isApplicationFormMessage("法人名：株式会社サンプル\n代表者名：山田 太郎"); truthy(r.detected); eq(r.formType, "corporate"); });
  it("即時語＋項目1つ（「法人契約」＋会社名）→ 検知（線は項目1以上）", () =>
    truthy(isApplicationFormMessage("法人契約でお願いします\n会社名：株式会社サンプル").detected));
});

describe("分割送信は結合フォールバックが拾う（hasApplyHintKeyword → 直近8件を結合）", () => {
  const parts = ["①氏名：山田 太郎", "②フリガナ：ヤマダ タロウ", "③生年月日：1990年1月1日", "④現住所：東京都〇〇区1-1-1"];
  it("1通ずつは閾値未満", () => { for (const p of parts) falsy(isApplicationFormMessage(p).detected, p); });
  it("最後の1通がヒント語を持つ", () => truthy(hasApplyHintKeyword(parts[0])));
  it("結合すると検知", () => truthy(isApplicationFormMessage(parts.join("\n")).detected));
});

// ── ② 昇格の判定（実物の並び）──────────────────────────────
const base = { status: "proposing", textReceived: true, imageReceived: false, statusManualBackAt: null, lastApplicationPushAt: null, now: iso(NOW) };

describe("実物の並び: AIX【申込へ】→（10分〜3h・最大2.4日）フォーム文 → 本人確認書類", () => {
  it("フォーム文 ＋ 本人確認書類（画像の旗）→ 昇格（従来の両旗）", () => {
    const r = resolveApplyingPromotion({ ...base, imageReceived: true }); truthy(r.promote); eq(r.reason, "text_and_image");
  });
  it("フォーム文だけ → 不可（A1 は手戻し後の会話 3/7 で true になる）", () => {
    const r = resolveApplyingPromotion(base); falsy(r.promote); eq(r.blocked, "no_second_evidence");
  });
  it("本人確認書類だけ（フォーム文なし）→ 不可", () => {
    const r = resolveApplyingPromotion({ ...base, textReceived: false, imageReceived: true }); falsy(r.promote); eq(r.blocked, "no_text");
  });
  it("AIX【申込へ】3h前 ＋ フォーム文 → 昇格（実物の中央値の形）", () => {
    const r = resolveApplyingPromotion({ ...base, lastApplicationPushAt: iso(NOW - 3 * H) }); truthy(r.promote); eq(r.reason, "text_and_application_push");
  });
  it("AIX【申込へ】2.4日前 ＋ フォーム文 → 昇格（実測の最大）", () =>
    truthy(resolveApplyingPromotion({ ...base, lastApplicationPushAt: iso(NOW - 2.4 * D) }).promote));
  it("AIX【申込へ】14日前 ＋ フォーム文 → 昇格（線の内側）", () =>
    truthy(resolveApplyingPromotion({ ...base, lastApplicationPushAt: iso(NOW - APPLICATION_PUSH_FRESH_DAYS * D) }).promote));
  it("AIX【申込へ】15日前 ＋ フォーム文 → 不可（鮮度切れ）", () => {
    const r = resolveApplyingPromotion({ ...base, lastApplicationPushAt: iso(NOW - 15 * D) }); falsy(r.promote); eq(r.blocked, "no_second_evidence");
  });
  it("AIX【申込へ】が判定時刻より後（時計のずれ）→ 先行と数えない", () =>
    falsy(applicationPushIsFresh(iso(NOW + H), iso(NOW))));
  it("AIX【申込へ】だけ（フォーム文なし）→ 不可", () =>
    falsy(resolveApplyingPromotion({ ...base, textReceived: false, lastApplicationPushAt: iso(NOW - H) }).promote));
});

describe("進めてはいけない会話", () => {
  it("status_manual_back_at あり（手で戻した会話）→ 両旗が揃っていても不可", () => {
    const r = resolveApplyingPromotion({ ...base, imageReceived: true, statusManualBackAt: iso(NOW - D) }); falsy(r.promote); eq(r.blocked, "manual_back");
  });
  it("status=applying → no-op（冪等）", () => {
    const r = resolveApplyingPromotion({ ...base, status: "applying", imageReceived: true }); falsy(r.promote); eq(r.blocked, "not_pre_apply");
  });
  it("status=closed_won／closed_lost → no-op（ダウングレード禁止）", () => {
    for (const s of ["closed_won", "closed_lost", "contract", "screening"]) falsy(resolveApplyingPromotion({ ...base, status: s, imageReceived: true }).promote, s);
  });
  it("申込前の全 status で判定が通る（status が空でも例外にならない）", () => {
    for (const s of PRE_APPLY_STATUSES) truthy(resolveApplyingPromotion({ ...base, status: s, imageReceived: true }).promote, s);
    eq(resolveApplyingPromotion({ ...base, status: null, imageReceived: true }).blocked, "not_pre_apply");
  });
  it("押下時刻が壊れた文字列 → 根拠に使わない", () =>
    falsy(resolveApplyingPromotion({ ...base, lastApplicationPushAt: "not-a-date" }).promote));
});

// ── ③ 画像の旗 ───────────────────────────────────────
describe("画像の旗（applying_image_received）を立てる条件", () => {
  it("image_type=id_document → 立てる（AIX【申込へ】の後に届く実物の形・10/31）", () => {
    const r = shouldSetApplyingImageFlag({ imageType: "id_document", lastStaffTextWithin72h: "承知いたしました！" }); truthy(r.set); eq(r.reason, "id_document");
  });
  it("従来: 直近スタッフ発言に「ご記入」→ 立てる", () => {
    const r = shouldSetApplyingImageFlag({ imageType: null, lastStaffTextWithin72h: "こちらの申込書にご記入の上お送りください" }); truthy(r.set); eq(r.reason, "staff_form_request");
  });
  it("AIX【申込へ】の直後の実物の発言（申込・フォーマット・本人確認・免許・マイナンバー）は従来の語に当たらない", () => {
    // 実物: AIX【申込へ】直後2h以内のスタッフ発言に含まれる語は 申込=22/22・フォーマット=21・本人確認=21・免許=21・マイナンバー=21・書類=21、旗の4語は0件
    const t = "お申込ありがとうございます！下記フォーマットにお答えください。あわせて本人確認書類（免許証・マイナンバーカード等）の画像をお送りください。";
    falsy(STAFF_FORM_REQUEST_RE.test(t));
    falsy(shouldSetApplyingImageFlag({ imageType: "other", lastStaffTextWithin72h: t }).set);
  });
  it("間取り図・物件写真（image_type=floor_plan）＋スタッフの語なし → 立てない", () =>
    falsy(shouldSetApplyingImageFlag({ imageType: "floor_plan", lastStaffTextWithin72h: "空室でした！" }).set));
  it("PDF（image_type なし）＋スタッフの語なし → 立てない", () =>
    falsy(shouldSetApplyingImageFlag({ lastStaffTextWithin72h: "ご確認ください" }).set));
});

// ── ④ 実物の会話を時系列で流す（旗の積み上げ → 各出来事で判定）──────────
describe("実物の会話 [5752c0d1 型]: 申込へ 09:00 → フォーム文 09:40 → 本人確認書類 10:30", () => {
  const push = NOW - 90 * 60_000;
  let text = false, image = false;
  it("フォーム文の時点: 申込へが先行 → 昇格", () => {
    text = true;
    truthy(resolveApplyingPromotion({ status: "proposing", textReceived: text, imageReceived: image, statusManualBackAt: null, lastApplicationPushAt: iso(push), now: iso(NOW - 50 * 60_000) }).promote);
  });
  it("本人確認書類の時点: 既に applying → no-op", () => {
    image = true;
    eq(resolveApplyingPromotion({ status: "applying", textReceived: text, imageReceived: image, statusManualBackAt: null, lastApplicationPushAt: iso(push), now: iso(NOW) }).blocked, "not_pre_apply");
  });
});

describe("実物の会話 [手戻し 9280fa49 型]: フォーム文 → 昇格 → 否決で手で proposing に戻す（旗リセット・印）→ 新しい画像", () => {
  it("戻した後は本人確認書類が届いても進めない（印がある間はスタッフの判断が正）", () =>
    eq(resolveApplyingPromotion({ status: "proposing", textReceived: false, imageReceived: true, statusManualBackAt: iso(NOW - 3 * D), lastApplicationPushAt: iso(NOW - 5 * D), now: iso(NOW) }).blocked, "manual_back"));
  it("戻した後にスタッフが手で applying へ進めた（印が消える）→ no-op", () =>
    eq(resolveApplyingPromotion({ status: "applying", textReceived: false, imageReceived: true, statusManualBackAt: null, lastApplicationPushAt: null, now: iso(NOW) }).blocked, "not_pre_apply"));
  // 2026-09-23 竹内「否決となって再度物件提案中にもどる場合もある…そうしたらまた申込までうごく」（post-apply.ts と同じ時間順）
  it("戻した後にもう一度 AIX【申込へ】を押し、フォーム文が届いた（再申込）→ 印より押下が新しいので昇格", () =>
    truthy(resolveApplyingPromotion({ status: "proposing", textReceived: true, imageReceived: false, statusManualBackAt: iso(NOW - 3 * D), lastApplicationPushAt: iso(NOW - D), now: iso(NOW) }).promote));
  it("戻しより前の押下しか無ければ、フォーム文が届いても印で止まる", () =>
    eq(resolveApplyingPromotion({ status: "proposing", textReceived: true, imageReceived: false, statusManualBackAt: iso(NOW - 3 * D), lastApplicationPushAt: iso(NOW - 5 * D), now: iso(NOW) }).blocked, "manual_back"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("失敗:\n  " + failures.join("\n  ")); process.exit(1); }
