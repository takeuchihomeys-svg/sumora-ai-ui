// 1つの番を何通に分けるか（2026-11-05 竹内さん KB b834d9f0・cf241dbd・作業員7）
// 実行: npx tsx app/lib/__tests__/two-message-plan.test.ts
// 場面は本番の竹内さんの番（名前は伏せた）。ブレインの依頼の形は turn_contract.asks のまま
import { planMessages, planAnnounce, remainingAfterAix, templateReplyPartNote, afterAixReplyBrief, planDigest, twoMessagePlanOn, twoMessagePlanUiOn, twoMessageAnnounceVisible, afterAixDraftHint, checkPlan, planForConductor, planFromMeta, canAppealFromFocus } from "../two-message-plan";
import { BRAIN_TURN_CONTRACT_RULES } from "../turn-contract";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

// スイッチ（既定 off）
t("既定 off（サーバー）", twoMessagePlanOn({}) === false);
t("on で on", twoMessagePlanOn({ TWO_MESSAGE_PLAN: "on" }) === true);
t("既定 off（画面）", twoMessagePlanUiOn(undefined) === false && twoMessagePlanUiOn("on") === true);

// ① AIX が無い番＝返信1通・知らせなし
{
  const p = planMessages({ asks: [{ quote: "4月より今の方が家賃安いですか", route: "reply", about: "company" }] });
  t("① 返信だけ＝single 1通", p.order === "single" && p.count === 1 && p.messages[0].slot === "reply", p);
  t("① 知らせは出さない", planAnnounce(p) === null);
}

// ② 初回で画像だけ（10/26 アスヴェル難波EAST の番・No.41 の9番の会話）＝挨拶と約束 → 見積書 → テンプレート（空き・手数料）
{
  const p = planMessages({ asks: [{ quote: "初期費用の見積もりをお願いできますか", route: "aix", aix: "estimate_sheet", about: "property_cost" }], firstContact: true, imageOnly: true });
  t("② 初回の画像だけ＝返信が先", p.messages[0].slot === "reply" && /挨拶と約束/.test(p.messages[0].role), p);
  t("② 2通目は見積書の AIX", p.messages[1].slot === "aix" && p.messages[1].aix === "estimate_sheet");
  t("② 3通目は見積書の続きのテンプレート（9番の席）", p.messages[2]?.slot === "aix_template" && p.order === "three", p);
  const rest = remainingAfterAix(p, "estimate_sheet");
  t("② 見積書を送った後に残るのはテンプレート", rest?.length === 1 && rest[0].slot === "aix_template", rest);
}

// ③ 約束の番（No.42 (c) 物件が来た＝確認します → AIX）
{
  const p = planMessages({ asks: [{ quote: "この部屋空いてますか", route: "promise", answer: "募集状況を確認する" }], finalAix: "property_check_result" });
  t("③ 約束の返信 → 物件確認した", p.order !== "single" && p.messages[0].slot === "reply" && p.messages[1].aix === "property_check_result", p);
}

// ④ 返信で答えられる質問＋AIX（10/06 内覧したい＋夜職の審査）＝AIX【内覧調整】→ 返信（審査の答え）
{
  const p = planMessages({ asks: [
    { quote: "301号室の内覧お願いしたいです", route: "aix", aix: "viewing_invite", about: "viewing_day" },
    { quote: "大学生兼夜職でも借りれますか", route: "reply", answer: "審査通過できるようサポートする", about: "procedure" },
  ] });
  t("④ テンプレートの無い AIX＝AIX → 返信の2通", p.order === "aix_first" && p.count === 2 && p.messages[0].slot === "aix" && p.messages[1].slot === "reply", p);
  const b = afterAixReplyBrief(p, "viewing_invite", [{ quote: "大学生兼夜職でも借りれますか", route: "reply", answer: "審査通過できるようサポートする" }]);
  t("④ 内覧調整を送った後の返信の材料＝審査の質問と答えの要点", b?.answers[0]?.quote.startsWith("大学生") === true && b.answers[0].answer === "審査通過できるようサポートする", b);
  t("④ 知らせ", /この番は2通: ①AIX【内覧調整】.*→ ②返信：「大学生兼夜職/.test(planAnnounce(p) ?? ""), planAnnounce(p));
  t("④ digest", planDigest(p) === "aix_first:A>R");
}

// ⑤ 見積書＋審査の質問（11/03 学生・夜職の代理契約の番）＝見積書 → テンプレート → 返信の3通
{
  const p = planMessages({ asks: [
    { quote: "こちらの物件も初期費用おしえて", route: "aix", aix: "estimate_sheet", about: "property_cost" },
    { quote: "学生で夜職でも個人で契約できますか", route: "reply", answer: "代理契約で審査を進める", about: "procedure" },
  ] });
  t("⑤ 3通（AIX → テンプレート → 返信）", p.order === "three" && planDigest(p) === "three:A>T>R", p);
  const note = templateReplyPartNote(p, "estimate_sheet");
  t("⑤ テンプレートには審査の質問を書かない（後ろの返信で）", /この通には書かない/.test(note) && /学生で夜職/.test(note), note);
}

// ⑥ その物件の質問が1つ＋テンプレートのある AIX（物件確認＋床の色）＝2通目のテンプレートで一緒に答える
{
  const p = planMessages({ asks: [
    { quote: "空いてますか", route: "aix", aix: "property_check_result", about: "vacancy" },
    { quote: "床の色白ですか", route: "reply", about: "property_equipment" },
  ] });
  t("⑥ 2通（AIX → テンプレートで質問にも答える）", p.order === "aix_first" && p.count === 2 && p.messages[1].slot === "aix_template" && p.messages[1].answers[0] === "床の色白ですか", p);
  t("⑥ テンプレートの材料に質問が入る", /この通（AIX の2通目）で/.test(templateReplyPartNote(p, "property_check_result")));
}

// ⑦ 送った AIX が計画と違う＝残りは出さない
{
  const p = planMessages({ asks: [{ quote: "見積", route: "aix", aix: "estimate_sheet" }, { quote: "審査は", route: "reply" }] });
  t("⑦ 別の AIX を押した＝null", remainingAfterAix(p, "viewing_invite") === null && templateReplyPartNote(p, "viewing_invite") === "");
}

// ⑧ AIX だけ（返信の質問なし）＝AIX（＋同じ AIX の訴求）
{
  const p = planMessages({ asks: [{ quote: "申し込みできますか", route: "aix", aix: "application_push" }] });
  t("⑧ AIX 1通・知らせなし", p.order === "single" && p.count === 1 && planAnnounce(p) === null, p);
  const p2 = planMessages({ asks: [], finalAix: "property_recommendation" });
  t("⑧ 依頼なし＋最終の AIX がオススメ＝AIX → テンプレート", p2.count === 2 && p2.messages[1].slot === "aix_template", p2);
}

// ⑨ 壊れた入力
t("⑨ null の依頼", planMessages({ asks: null }).order === "single");
t("⑨ ピッカー付きのキー", planMessages({ asks: [{ quote: "x", route: "aix", aix: "property_check_result/available" }, { quote: "y", route: "reply" }] }).messages[0].aix === "property_check_result");

// ⑫ 組み合わせの型と「なぜ」（KB 3701b532）
{
  const rat = planMessages({ asks: [{ quote: "見積もりお願い", route: "promise" }], finalAix: "estimate_sheet", firstContact: true });
  t("⑫ 初回の約束＋見積書＝RAT・なぜ（受け止めてから送る）", rat.shape === "RAT" && /受け止めてから送る/.test(rat.why), rat);
  const ar = planMessages({ asks: [{ quote: "内覧したい", route: "aix", aix: "viewing_invite" }, { quote: "審査は", route: "reply" }] });
  t("⑫ AR・なぜ（送る物と答えを混ぜない）", ar.shape === "AR" && /混ぜない/.test(ar.shapeWhy), ar);
  const atr = planMessages({ asks: [{ quote: "初期費用", route: "aix", aix: "estimate_sheet" }, { quote: "何を妥協したら", route: "reply" }] });
  t("⑫ ATR", atr.shape === "ATR" && /複雑な番/.test(atr.shapeWhy));
  const pr = planMessages({ asks: [{ quote: "探して", route: "promise" }, { quote: "繁忙期より安い？", route: "reply" }], finalAix: "property_send" });
  t("⑫ 約束＋質問＝受けて答える返信が先（RA）", pr.shape === "RA" && pr.messages[0].answers.length === 2, pr);
  t("⑫ 返信だけ＝R", planMessages({ asks: [{ quote: "x", route: "reply" }] }).shape === "R");
}

// ⑬ 各通の担う事と全体の確かめ（答える・信頼・訴求）
{
  const asks = [{ quote: "初期費用", route: "aix", aix: "estimate_sheet" }, { quote: "何を妥協したら", route: "reply" }];
  const p = planMessages({ asks, canAppeal: true });
  t("⑬ ATR: A=答える・T=訴求・R=答える＋信頼", p.messages[0].duties.join() === "answer" && p.messages[1].duties.join() === "appeal" && p.messages[2].duties.join() === "answer,trust", p.messages);
  const c = checkPlan(p, { asks, canAppeal: true });
  t("⑬ 全部そろう", c.answered && c.trust && c.appeal === true && c.gaps.length === 0, c);
  const a = planMessages({ asks: [{ quote: "申込したい", route: "aix", aix: "application_push" }] });
  const ca = checkPlan(a, { asks: [{ quote: "申込したい", route: "aix" }] });
  t("⑬ AIX だけ＝信頼の抜けを理由つきで", !ca.trust && /AIX の文の中で/.test(ca.gaps.join()), ca);
  const r = planMessages({ asks: [{ quote: "分割できますか", route: "reply" }], canAppeal: true });
  t("⑬ 訴求できる場面の返信1通＝通を増やさず最後の通に訴求", r.count === 1 && r.messages[0].duties.includes("appeal"), r);
  const cm = checkPlan(planMessages({ asks: [{ quote: "x", route: "reply" }] }), { asks: [{ quote: "x", route: "reply" }, { quote: "y", route: "reply" }] });
  t("⑬ 答えていない質問を出す", !cm.answered && /「y」/.test(cm.gaps[0]), cm);
}

// ⑭ 統括の置いた組み立てを読む（meta.two_message_plan が先・形が違えば null）
{
  const r = planForConductor({ asks: [{ quote: "内覧したい", route: "aix", aix: "viewing_invite" }, { quote: "審査は", route: "reply" }], focus: "close" });
  t("⑭ 統括の形（{plan,check,digest}）をそのまま読める", planFromMeta({ two_message_plan: r })?.shape === "AR" && planFromMeta({ two_message_plan: r.plan })?.shape === "AR");
  t("⑭ 形が違う＝null", planFromMeta({ two_message_plan: { messages: [{ slot: "x" }] } }) === null && planFromMeta(null) === null);
  t("⑭ 重点 close＝訴求あり・ease＝なし", canAppealFromFocus("close") && !canAppealFromFocus("ease"));
}

// ⑩ 画面の知らせ（未設定＝YUMA・テストだけ）と AIX の後の下書きの指定
t("⑩ 未設定＝テストの会話だけ", twoMessageAnnounceVisible(undefined, true) && !twoMessageAnnounceVisible(undefined, false));
t("⑩ all＝全員・off＝出さない", twoMessageAnnounceVisible("all", false) && !twoMessageAnnounceVisible("off", true));
{
  const asks = [
    { quote: "301号室の内覧お願いしたいです", route: "aix", aix: "viewing_invite" },
    { quote: "大学生兼夜職でも借りれますか", route: "reply", answer: "審査通過できるようサポートする" },
  ];
  const p = planMessages({ asks });
  const h = afterAixDraftHint(afterAixReplyBrief(p, "viewing_invite", asks), "viewing_invite");
  t("⑩ 下書きの指定に質問と要点・AIX の名前", /内覧調整/.test(h) && /大学生兼夜職/.test(h) && /要点: 審査通過/.test(h), h);
  t("⑩ 残りが無い＝指定なし", afterAixDraftHint(null, "viewing_invite") === "");
}

// ⑪ ブレインの規則の1行（off は1字も変えない・on だけ足す）
//   （on の確かめ: TWO_MESSAGE_PLAN=on npx tsx -e で BRAIN_TURN_CONTRACT_RULES に行が入る＝作業員7 11/05 確認済み）
if ((process.env.TWO_MESSAGE_PLAN ?? "").trim().toLowerCase() !== "on") {
  t("⑪ off の規則に2通の行は無い", !/返信で答えられる質問を別の ask/.test(BRAIN_TURN_CONTRACT_RULES));
}

console.log(`\ntwo-message-plan: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
