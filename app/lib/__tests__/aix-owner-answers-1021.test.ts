// 2026-10-21 竹内さんの答え（AIX 側: C9 審査について・C2/C3 他社比べ・C5 訂正した御見積書・C6 他社の物件・D5 追客）のテスト。
//   LLM は呼ばない（純関数と切替だけ・文は作った例）
// 実行: npx tsx app/lib/__tests__/aix-owner-answers-1021.test.ts
import {
  screeningButtonEnabled, screeningBrainEnabled, screeningCardLabel, isScreeningButtonAction, SCREENING_TOPIC_OPTIONS, screeningTopicLine, isScreeningTopic,
  isOtherAgentCostCompare, isEstimateCorrectionContext, mentionsOtherAgentProperty, applyEstimateOwnerLines, OTHER_AGENT_HERE_LINE, ESTIMATE_CORRECTION_LINE, estimateOwnerNote,
} from "../aix-owner-answers-1021";
import { aixRequestMustUseClaude } from "../aix-new-pickers";
import { brainAixButtonLabel } from "../aix-button-view";
import { catalogBlockForBrain } from "../aix-catalog";
import { normalizeBrainCheckPattern } from "../brain-check-pattern";
import { sanitizePickerChoices } from "../aix-pickers";
import { composeFollowupText, sanitizeFollowupText, hasNewArrivalFact, followupRevive1021Enabled, followupShapeNote } from "../followup-revive-1021";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
function withEnv(k: string, v: string | undefined, fn: () => void) {
  const prev = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { fn(); } finally { if (prev === undefined) delete process.env[k]; else process.env[k] = prev; }
}

// ─── C9 ───
it("C9: 切替は既定 on・off で今まで通り・brain は既定で選ばない", () => {
  ok(screeningButtonEnabled({}), "既定 on でない");
  ok(!screeningButtonEnabled({ AIX_SCREENING_BUTTON: "off" }), "off が効かない");
  ok(!screeningBrainEnabled({}), "brain が既定 on");
  ok(screeningBrainEnabled({ AIX_SCREENING_BUTTON: "brain" }), "brain の値で動かない");
  ok(screeningButtonEnabled({ AIX_SCREENING_BUTTON: "brain" }), "brain の時にボタンが消えた");
});
it("C9: 選択肢は 保証会社について＋職業・名義・保証人・外国籍・時期・その他", () => {
  const labels = SCREENING_TOPIC_OPTIONS.map((o) => o.label).join("|");
  for (const w of ["保証会社", "職業", "名義", "保証人", "外国籍", "時期", "その他"]) ok(labels.includes(w), `${w} が無い`);
  ok(SCREENING_TOPIC_OPTIONS[0].value === "guarantor", "保証会社についてが先頭でない");
  ok(isScreeningTopic("job") && !isScreeningTopic("xxx"), "isScreeningTopic");
  ok(/職業/.test(screeningTopicLine("job")) && screeningTopicLine("guarantor") === "", "話題の行");
});
it("C9: 旧の値 → 新しいボタン（guarantor_info・mgmt_screening）／mgmt_guarantor は今まで通り", () => {
  ok(isScreeningButtonAction("guarantor_info"), "guarantor_info");
  ok(isScreeningButtonAction("property_check_result", "mgmt_screening"), "mgmt_screening");
  ok(!isScreeningButtonAction("property_check_result", "mgmt_guarantor"), "mgmt_guarantor まで寄せた");
  ok(screeningCardLabel("guarantor_info", null, {}) === "AIX 審査について（保証会社）", "カードの名前");
  ok(screeningCardLabel("guarantor_info", null, { AIX_SCREENING_BUTTON: "off" }) === null, "off で名前が変わる");
  withEnv("AIX_SCREENING_BUTTON", undefined, () => {
    ok(brainAixButtonLabel("property_check_result", "mgmt_screening") === "AIX 審査について", `カード: ${brainAixButtonLabel("property_check_result", "mgmt_screening")}`);
    ok(brainAixButtonLabel("property_check_result", "mgmt_guarantor") === "AIX 確認した（条件・交渉）", "mgmt_guarantor のカードが変わった");
  });
  withEnv("AIX_SCREENING_BUTTON", "off", () => ok(brainAixButtonLabel("guarantor_info") === "AIX 保証会社について", "off で今まで通りでない"));
});
it("C9: 審査について の中は必ず Claude（guarantor_info・話題つき・mgmt_screening）", () => {
  ok(aixRequestMustUseClaude({ action: "guarantor_info" }), "guarantor_info");
  ok(aixRequestMustUseClaude({ action: "property_check_result", check_pattern: "mgmt_screening", screening_topic: "job" }), "話題つき");
  ok(!aixRequestMustUseClaude({ action: "estimate_sheet" }), "見積書まで Claude 固定");
});
it("C9: ブレインの一覧は【審査について】の中に並べる・mgmt_screening は既定で出さない（brain の時だけ）", () => {
  const def = catalogBlockForBrain(null, { includeAll: true, env: {} });
  ok(def.includes("guarantor_info【審査について→保証会社について】"), "保証会社についてが審査についての中にない");
  ok(!def.includes("mgmt_screening"), "既定で mgmt_screening が出た");
  const br = catalogBlockForBrain(null, { includeAll: true, env: { AIX_SCREENING_BUTTON: "brain" } });
  ok(/property_check_result【審査について】/.test(br) && br.includes("mgmt_screening"), "brain の時に出ない");
  const off = catalogBlockForBrain(null, { includeAll: true, env: { AIX_SCREENING_BUTTON: "off" } });
  ok(!off.includes("審査について→"), "off で名前が変わった");
  withEnv("AIX_SCREENING_BUTTON", undefined, () => ok(normalizeBrainCheckPattern("mgmt_screening") === null, "既定でブレインの値として読んだ"));
  withEnv("AIX_SCREENING_BUTTON", "brain", () => ok(normalizeBrainCheckPattern("mgmt_screening") === "mgmt_screening", "brain で読まない"));
});
it("C9: 記録（picker_choices）に審査内容が残る", () => {
  const pc = sanitizePickerChoices("property_check_result", { screening_topic: "nationality" }, { checkPattern: "mgmt_screening" });
  ok(pc?.screening_topic === "nationality", "残らない");
  ok(!sanitizePickerChoices("property_check_result", { screening_topic: "nationality" }, { checkPattern: "mgmt_parking" }), "別のピッカーで残った");
});
it("C9: 画面とサーバの配線（メニュー・シート・モーダル・aix/action）", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  ok(/label: SCREENING_BUTTON, actionType: "guarantor_info"/.test(page), "メニューに審査について");
  ok(!/label: "保証会社について", actionType: "guarantor_info"/.test(page), "旧の保証会社についてのボタンが残った");
  ok(/key: "mgmt_screening",/.test(page) === false, "管理会社に確認した の中に審査について（ご相談）が残った（1か所にまとめる）");
  ok(/setAixInitScreeningTopic\(o\.value\)/.test(page) && /openAixDirect\("guarantor_info"\)/.test(page), "シートの配線");
  const modal = readFileSync("app/components/AixModal.tsx", "utf8");
  ok(/body\.screening_topic = screeningTopic/.test(modal), "モーダルが話題を送らない");
  const route = readFileSync("app/api/aix/action/route.ts", "utf8");
  ok(/screeningTopicLine\(body\.screening_topic\)/.test(route), "aix/action が話題を使わない");
});

// ─── C2/C3 ───
it("C2/C3: 他社の見積と比べる・なぜ安い の網（関係ある時だけ）", () => {
  for (const t of ["他社の見積だと15万円でした", "他社さんのほうが安かったんですが", "なんでこんなに安いんですか？", "安すぎて大丈夫ですか？", "別の不動産屋の見積もりより高いです"]) ok(isOtherAgentCostCompare(t), `当たらない: ${t}`);
  for (const t of ["初期費用はいくらですか？", "家賃だけ払ったら住めるんですか？", "他社で内覧する予定です", "安いお部屋ありますか"]) ok(!isOtherAgentCostCompare(t), `当たりすぎ: ${t}`);
  const route = readFileSync("app/api/aix/action/route.ts", "utf8");
  ok(/cbCompare \? COST_COMPARE_FACT_BLOCK : ""/.test(route), "初期費用についてに足していない");
});

// ─── C5 ───
it("C5: 訂正した御見積書（お客様の抜けの指摘・スタッフの訂正の約束）", () => {
  const est = { sender: "staff", text: "【A 101号室】\n初期費用：100,000円" };
  ok(isEstimateCorrectionContext([est, { sender: "customer", text: "他社で確認してもらったら清掃代が抜けてると指摘されました" }], null, {}), "指摘で当たらない");
  ok(isEstimateCorrectionContext([est, { sender: "customer", text: "清掃代は？" }, { sender: "staff", text: "訂正しました御見積書作成しお送りさせて頂きます！！" }], null, {}), "約束で当たらない");
  ok(!isEstimateCorrectionContext([{ sender: "customer", text: "清掃代が抜けてると言われました" }], null, {}), "見積書を送る前に当たった");
  ok(!isEstimateCorrectionContext([est, { sender: "customer", text: "ありがとうございます" }], null, {}), "お礼で当たった");
  ok(!isEstimateCorrectionContext([est, { sender: "customer", text: "清掃代が抜けてると言われました" }], false, {}), "画面の選択が正でない");
  ok(!isEstimateCorrectionContext([est, { sender: "customer", text: "清掃代が抜けてると言われました" }], null, { ESTIMATE_CORRECTION_WORDING: "off" }), "off が効かない");
  // 2通目の生成: 今送ったばかりの御見積書が末尾にある
  ok(isEstimateCorrectionContext([est, { sender: "customer", text: "鍵交換代が入っていないと指摘されました" }, { sender: "staff", text: "【A 101号室】\n初期費用：116,500円" }], null, {}, { justSent: true }), "justSent で読めない");
  const r = applyEstimateOwnerLines("Aさんお世話になっております！！\nA 101号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", { correction: true });
  ok(r.text.includes("訂正しました御見積書となります") && !r.text.includes("最大限割引しました"), r.text);
  const r2 = applyEstimateOwnerLines("Aさんお世話になっております！！\nお手隙の際にご査収ください😌！！", { correction: true });
  ok(r2.text.split("\n")[1] === ESTIMATE_CORRECTION_LINE, r2.text);
  ok(applyEstimateOwnerLines("修正させて頂きました御見積書となります！！", { correction: true }).added.length === 0, "2回書いた");
});

// ─── C6 ───
it("C6: 他社の物件（紹介・仮押さえ・内覧予定）→ 弊社でもお申込み・ご内覧頂けます を締めの前に", () => {
  ok(mentionsOtherAgentProperty([{ sender: "customer", text: "他社さんで紹介してもらった物件なんですが見積もりお願いできますか" }], {}), "紹介");
  ok(mentionsOtherAgentProperty([{ sender: "customer", text: "不動産屋さんで仮押さえしてもらってます" }], {}), "仮押さえ");
  ok(mentionsOtherAgentProperty([{ sender: "customer", text: "他社で明日内覧予定です" }], {}), "内覧予定");
  ok(!mentionsOtherAgentProperty([{ sender: "staff", text: "他社さんで紹介された物件も弊社で" }], {}), "こちらの文で当たった");
  ok(!mentionsOtherAgentProperty([{ sender: "customer", text: "他の物件も見積お願いします" }], {}), "他の物件で当たった");
  ok(!mentionsOtherAgentProperty([{ sender: "customer", text: "他社さんで紹介してもらった" }], { ESTIMATE_OTHER_AGENT_LINE: "off" }), "off が効かない");
  const r = applyEstimateOwnerLines("A 101号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", { otherAgent: true });
  const ls = r.text.split("\n");
  ok(ls[1] === OTHER_AGENT_HERE_LINE && /ご査収/.test(ls[2]), r.text);
  ok(applyEstimateOwnerLines("弊社でもお申込み可能です！！", { otherAgent: true }).added.length === 0, "2回書いた");
  ok(/弊社でもお申込み・ご内覧頂けます/.test(estimateOwnerNote({ otherAgent: true })), "指示に入らない");
  const tg = readFileSync("app/api/aix-template-generate/route.ts", "utf8");
  const act = readFileSync("app/api/aix/action/route.ts", "utf8");
  ok(/applyEstimateOwnerLines\(text, estimateOwner\)/.test(tg) && /applyEstimateOwnerLines\(cover_letter, coverOwner\)/.test(act), "2通目の出口2か所に配線していない");
});

// ─── D5 ───
it("D5: 追客の竹内さんの形・その後いかがでしょうかを落とす・新着を作らない", () => {
  ok(followupRevive1021Enabled({}) && !followupRevive1021Enabled({ FOLLOWUP_REVIVE_1021: "off" }), "切替");
  const t = composeFollowupText({ name: "R", greet: true });
  ok(t === "Rさんお世話になっております！！\nRさんお部屋探し継続されていますでしょうか！！\nまだお決まりになっていない場合Rさんのご条件に合ったお部屋ピックアップしお送りさせて頂きます😌！！", t);
  ok(!composeFollowupText({ name: "R", greet: false }).includes("お世話になっております"), "今日2回目に挨拶");
  ok(composeFollowupText({ name: "R", greet: false, newArrival: true, propertyName: "Aハイツ" }).includes("新着でRさんにオススメ出来るAハイツが募集に出ました"), "新着の一文");
  const s1 = sanitizeFollowupText("Rさんお世話になっております！！\nその後いかがでしょうか！！\n前回のお部屋探しの件、引き続きお探しさせて頂きます😊！！", { newArrivalFact: false });
  ok(s1.text !== null && !/その後/.test(s1.text) && s1.removed.includes("sonogo"), String(s1.text));
  ok(sanitizeFollowupText("Rさん\n新しくオススメ出来る物件が募集にでましたのでご連絡させていただきました！！", { newArrivalFact: false }).text === null, "材料なしの新着を通した");
  ok(sanitizeFollowupText("新着でオススメ出来るお部屋が募集に出ました！！", { newArrivalFact: true }).text !== null, "材料ありの新着を落とした");
  ok(sanitizeFollowupText("Rさんお世話になっております！！\nその後いかがでしょうか！！", { newArrivalFact: false }).text === null, "挨拶だけの文を通した");
  ok(hasNewArrivalFact({ extraInput: "新着物件あり" }) && hasNewArrivalFact({ propertyName: "A" }) && !hasNewArrivalFact({ extraInput: "条件変更の提案" }), "新着の材料");
  ok(/その後いかがでしょうか」は書かない/.test(followupShapeNote({ newArrivalFact: false })), "指示");
  const act = readFileSync("app/api/aix/action/route.ts", "utf8");
  ok((act.match(/applyFollowup1021\(message_text\)/g) ?? []).length === 2, "追客の出口2か所");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
