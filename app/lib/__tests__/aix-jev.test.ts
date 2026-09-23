// 2026-09-23 竹内「AIX でどのピッカーを選択するかの部分は Jev で強化」— ブレインの判定部品（純関数）のテスト
// 実行: npx tsx app/lib/__tests__/aix-jev.test.ts
import { AIX_BUTTON_LABELS } from "../aix-taxonomy";
import {
  JEV_AIX_OPTIONS, JEV_CHECK_TOPIC_OPTIONS, CHECK_PATTERN_TO_TOPIC, TOPIC_TO_CHECK_PATTERN, TOPIC_CHECK_PATTERNS,
  buildJevState, buildAixJevQuestions, parseAixJevAnswers, evaluateAixWithJev, toShadowRow,
  AIX_PICKER_CATALOG, hasPickerQuestion, buildPickerQuestion, parsePickerJevAnswer, evaluatePickerWithJev, toPickerShadowRow,
} from "../aix-jev";
import { readJevConfig, jevSystemOne } from "../jev-client";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

console.log("── ★ 選択肢は AIX の一覧（aix-taxonomy）と同じ物を指す（同じ事実を2か所に置かない）");
{
  const missing = Object.keys(AIX_BUTTON_LABELS).filter((k) => !(k in JEV_AIX_OPTIONS));
  t("★ AIX_BUTTON_LABELS の全キーが選択肢にある", missing.length === 0, missing);
  t("★ none がある（スタッフの操作が要らない場面）", "none" in JEV_AIX_OPTIONS);
  const extra = Object.keys(JEV_AIX_OPTIONS).filter((k) => k !== "none" && !(k in AIX_BUTTON_LABELS));
  t("★ 一覧に無い幽霊のボタンを増やしていない", extra.length === 0, extra);
  t("★ 選択肢は 255 個以内（Jev の上限）", Object.keys(JEV_AIX_OPTIONS).length <= 255 && Object.keys(JEV_CHECK_TOPIC_OPTIONS).length <= 255);
}

console.log("── ★ ピッカー: 「何を確認したか」は聞き、「確認の結果」は聞かない");
{
  t("★ 結果のピッカー（available/unavailable/alternative/exclusive）は availability に寄せる（会話からは分からない）",
    ["available", "unavailable", "alternative", "exclusive"].every((p) => CHECK_PATTERN_TO_TOPIC[p] === "availability"));
  t("★ 室内写真は interior_photo のまま", CHECK_PATTERN_TO_TOPIC.interior_photo === "interior_photo" && TOPIC_TO_CHECK_PATTERN.interior_photo === "interior_photo");
  t("★ availability の topic は check_pattern を決めない（スタッフが結果を選ぶ）", TOPIC_TO_CHECK_PATTERN.availability === null);
  t("★ Jev の topic は全部 check_pattern への写像を持つ", Object.keys(JEV_CHECK_TOPIC_OPTIONS).every((k) => k in TOPIC_TO_CHECK_PATTERN));
  t("★ 写像先は aix_usage_logs にある check_pattern の語（mgmt_move_in 等）", ["mgmt_move_in", "mgmt_initial_cost", "mgmt_guarantor", "mgmt_parking", "mgmt_pet", "mgmt_equipment", "mgmt_proxy", "other_room_check", "interior_photo"].every((p) => Object.values(TOPIC_TO_CHECK_PATTERN).includes(p)));
  t("★ 答え合わせの対象（会話から当てられるピッカー）に結果のピッカーは入らない", !TOPIC_CHECK_PATTERNS.has("available") && TOPIC_CHECK_PATTERNS.has("interior_photo") && TOPIC_CHECK_PATTERNS.has("mgmt_move_in"));
}

console.log("── ★ state: 直近の会話だけ・長い文は切る・空は落とす");
{
  const s = buildJevState({
    messages: [
      { sender: "customer", text: "こんにちは" }, { sender: "staff", text: "お世話になっております！！" },
      { sender: "staff", text: "", isAix: true }, { sender: "customer", text: "  これ室内写真欲しいです\n\nお願いします  " },
    ],
    status: "proposing", sentPropertyCount: 3, estimateSent: false, lastAixType: "property_send",
  });
  const conv = s.conversation as Array<{ who: string; text: string }>;
  t("★ 空の発言は落ちる", conv.length === 3, conv);
  t("★ 改行・連続空白は1つに", conv[2].text === "これ室内写真欲しいです お願いします", conv[2]);
  t("★ latest_customer_message は最後のお客様の発言", s.latest_customer_message === "これ室内写真欲しいです お願いします");
  t("★ 状態（status・送った物件数・見積・直前の AIX）が入る", s.status === "proposing" && s.properties_sent_by_staff === 3 && s.estimate_sent === false && s.last_aix_pressed === "property_send");
  const long = buildJevState({ messages: Array.from({ length: 20 }, (_, i) => ({ sender: "customer", text: `m${i} ` + "あ".repeat(500) })) });
  const lc = long.conversation as Array<{ text: string }>;
  t("★ 既定は直近8通・1通400字まで", lc.length === 8 && lc.every((m) => m.text.length <= 400) && lc[0].text.startsWith("m12"));
}

console.log("── ★ questions: 3問（AIX・確認の対象・写真の依頼）");
{
  const q = buildAixJevQuestions();
  t("★ next_aix は choice で選択肢が AIX の一覧", q.next_aix.type === "choice" && q.next_aix.type === "choice" && Object.keys(q.next_aix.criteria).length === Object.keys(JEV_AIX_OPTIONS).length);
  t("★ check_topic は choice", q.check_topic.type === "choice");
  t("★ photo_request は noul（確率）", q.photo_request.type === "noul");
}

console.log("── ★ answers → ブレインが使う形");
{
  const d = parseAixJevAnswers({
    next_aix: { type: "choice", choice: "property_check_result", probabilities: { property_check_result: 0.82, property_send: 0.1, none: 0.08 }, confidence: 0.77 },
    check_topic: { type: "choice", choice: "interior_photo", probabilities: { interior_photo: 0.9, availability: 0.1 }, confidence: 0.85 },
    photo_request: { type: "noul", noul: 0.96 },
  });
  t("★ AIX と確率", d?.aix === "property_check_result" && d.aixProb === 0.82 && d.aixConfidence === 0.77);
  t("★ 室内写真 → check_pattern=interior_photo", d?.checkTopic === "interior_photo" && d.checkPattern === "interior_photo" && d.checkTopicProb === 0.9);
  t("★ 写真の依頼の確率", d?.photoRequestProb === 0.96);

  const d2 = parseAixJevAnswers({
    next_aix: { type: "choice", choice: "property_send", probabilities: { property_send: 0.7 } },
    check_topic: { type: "choice", choice: "interior_photo", probabilities: { interior_photo: 0.6 } },
  });
  t("★ AIX が物件確認したでなければ check_pattern は付けない", d2?.aix === "property_send" && d2.checkPattern === null && d2.photoRequestProb === null);

  const d3 = parseAixJevAnswers({
    next_aix: { type: "choice", choice: "property_check_result", probabilities: { property_check_result: 0.6 } },
    check_topic: { type: "choice", choice: "availability", probabilities: { availability: 0.9 } },
  });
  t("★ 募集状況の確認は check_pattern null（結果はスタッフが選ぶ）", d3?.checkPattern === null && d3.checkTopic === "availability");

  t("★ 知らない選択肢が返ったら null（決め打ちしない）", parseAixJevAnswers({ next_aix: { type: "choice", choice: "teleport", probabilities: {} } }) === null);
  t("★ answers 無しは null", parseAixJevAnswers(null) === null && parseAixJevAnswers({}) === null);
  const d4 = parseAixJevAnswers({ next_aix: { type: "choice", choice: "none" } });
  t("★ probabilities 無しでも choice は通る（確率は 1）", d4?.aix === "none" && d4.aixProb === 1 && d4.checkTopic === "none");
}

console.log("── ★ ボタンが決まった後: そのボタンのピッカーを選ぶ（2026-09-23 竹内）");
{
  t("★ ピッカーのあるボタン: 物件確認した・物件ピックアップした・物件オススメ・申込へ！", ["property_check_result", "property_send", "property_recommendation", "application_push"].every(hasPickerQuestion));
  t("★ ピッカーの無いボタンは null（見積書送る・内覧日調整 等）", !hasPickerQuestion("estimate_sheet") && !hasPickerQuestion("viewing_invite") && buildPickerQuestion("estimate_sheet") === null);
  t("★ 選択肢は aix_usage_logs の実物の語（send_mode: normal/new_arrival/widen/alternative）", ["normal", "new_arrival", "widen", "alternative"].every((k) => k in AIX_PICKER_CATALOG.property_send.options));
  t("★ 選択肢は aix_usage_logs の実物の語（app_sub_mode: push/confirm/format/docs_request）", ["push", "confirm", "format", "docs_request"].every((k) => k in AIX_PICKER_CATALOG.application_push.options));
  const q = buildPickerQuestion("application_push")!;
  t("★ ピッカーの質問は choice でそのボタンの選択肢だけ", q.type === "choice" && Object.keys(q.criteria).length === 4);

  const p1 = parsePickerJevAnswer("property_send", { type: "choice", choice: "new_arrival", probabilities: { new_arrival: 0.7, normal: 0.3 }, confidence: 0.6 });
  t("★ 物件ピックアップした → send_mode=new_arrival", p1?.field === "send_mode" && p1.pickerValue === "new_arrival" && p1.prob === 0.7);
  const p2 = parsePickerJevAnswer("property_check_result", { type: "choice", choice: "interior_photo", probabilities: { interior_photo: 0.9 } });
  t("★ 物件確認した → check_pattern=interior_photo", p2?.field === "check_pattern" && p2.pickerValue === "interior_photo");
  const p3 = parsePickerJevAnswer("property_check_result", { type: "choice", choice: "availability", probabilities: { availability: 0.9 } });
  t("★ 募集状況 → 値は null（あった／なかったはスタッフが選ぶ）", p3?.picker === "availability" && p3.pickerValue === null);
  t("★ そのボタンに無い選択肢が返ったら null", parsePickerJevAnswer("application_push", { type: "choice", choice: "new_arrival" }) === null);
  t("★ ピッカーの無いボタンは null", parsePickerJevAnswer("estimate_sheet", { type: "choice", choice: "x" }) === null);
}

console.log("── ★ 鍵が無ければ何もしない（今までどおり）・失敗は null（fail-open）");
{
  t("★ 鍵なし → 設定 null", readJevConfig({}) === null);
  t("★ TYPESAFE_API_KEY で有効・既定の model と endpoint", (() => { const c = readJevConfig({ TYPESAFE_API_KEY: "k" }); return !!c && c.model === "jev-latest" && c.endpoint.startsWith("https://api.typesafe.ai/"); })());
  t("★ JEV_API_KEY でも有効", readJevConfig({ JEV_API_KEY: "k" }) !== null);
  t("★ 鍵は環境変数からだけ（ハードコード無し）", !/Bearer\s+[A-Za-z0-9_-]{20,}/.test(require("node:fs").readFileSync("app/lib/jev-client.ts", "utf8")));
}
(async () => {
  const none = await jevSystemOne({ state: "x", questions: {}, env: {} });
  t("★ 鍵なしの呼び出しは null（通信しない）", none === null);

  type Sent = { url: string; body: Record<string, unknown>; auth: string | null };
  const sentBox: { v: Sent | null } = { v: null };
  const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    sentBox.v = { url: String(url), body: JSON.parse(String(init?.body)), auth: h.get("authorization") };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {
      next_aix: { type: "choice", choice: "property_check_result", probabilities: { property_check_result: 0.9 }, confidence: 0.8 },
      check_topic: { type: "choice", choice: "interior_photo", probabilities: { interior_photo: 0.95 }, confidence: 0.9 },
      photo_request: { type: "noul", noul: 0.97 },
    }, usage: { input_tokens: 300, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ev = await evaluateAixWithJev({
    messages: [{ sender: "staff", text: "🌟物件A 送りました" }, { sender: "customer", text: "これ室内写真欲しいです" }],
    status: "proposing", conversationId: "c1", env: { TYPESAFE_API_KEY: "test-key" }, fetchImpl: fakeFetch,
  });
  const sent = sentBox.v;
  t("★ 生きた呼び出し: state と questions を POST・Bearer で認証", !!sent && sent.url.includes("systemone") && sent.auth === "Bearer test-key" && "state" in sent.body && "questions" in sent.body && sent.body.model === "jev-latest");
  t("★ 答えがブレインの形になる（物件確認した→室内写真）", ev?.decision.aix === "property_check_result" && ev.decision.checkPattern === "interior_photo" && ev.decision.photoRequestProb === 0.97);
  t("★ usage と model を持つ（llm_usage_logs 用）", ev?.raw.usage.input_tokens === 300 && ev.raw.model === "jev-1.13.0");
  const row = toShadowRow("c1", "2026-09-23T00:00:00Z", { action: "", check_pattern: null }, ev!);
  t("★ 影の運用の行: ブレインの判断と Jev の答えを並べる", row.jev_action === "property_check_result" && row.jev_check_pattern === "interior_photo" && row.brain_action === "" && row.jev_model === "jev-1.13.0");
  t("★ ピッカーを聞いていない時は picker の列は null", row.jev_picker === null && row.jev_picker_field === null && row.jev_picker_prob === null);
  const rowP = toShadowRow("c1", null, { action: "property_send", check_pattern: null }, ev!, { decision: { aixType: "property_send", field: "send_mode", picker: "widen", pickerValue: "widen", prob: 0.8, confidence: 0.7, probabilities: { widen: 0.8 } } });
  t("★ ボタン決定後のピッカーも同じ行に並ぶ（field・picker・値・確率）", rowP.jev_picker_field === "send_mode" && rowP.jev_picker === "widen" && rowP.jev_picker_value === "widen" && rowP.jev_picker_prob === 0.8 && rowP.brain_action === "property_send");

  const pickerFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    sentBox.v = { url: "", body, auth: null };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { picker: { type: "choice", choice: "widen", probabilities: { widen: 0.8, normal: 0.2 }, confidence: 0.7 } }, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200 });
  }) as typeof fetch;
  const pk = await evaluatePickerWithJev({ aixType: "property_send", messages: [{ sender: "customer", text: "家賃もう少し上げても大丈夫です" }], env: { TYPESAFE_API_KEY: "k" }, fetchImpl: pickerFetch });
  const pkState = (sentBox.v?.body.state ?? {}) as Record<string, unknown>;
  t("★ ボタン決定後のピッカー: state に押すボタンが入り、質問は picker 1つ", pkState.chosen_aix_button === "物件ピックアップした" && Object.keys((sentBox.v?.body.questions ?? {}) as object).join() === "picker");
  t("★ 答え: 物件ピックアップした → 条件を広げた", pk?.decision.pickerValue === "widen" && pk.decision.prob === 0.8 && pk.decision.field === "send_mode");
  // 竹内「決まったボタンからピッカーを選ぶ部分を Jev が担当。AIX ボタンを選ぶのは今まで通り」= 本番の影の運用はこの行だけ
  const rowOnly = toPickerShadowRow("c1", null, { action: "property_send", check_pattern: null }, pk!);
  t("★ ピッカーだけの行: 全ボタンの問いは null・ボタンはブレインの物・ピッカーは Jev の物", rowOnly.jev_action === null && rowOnly.brain_action === "property_send" && rowOnly.jev_picker === "widen" && rowOnly.jev_picker_prob === 0.8 && rowOnly.jev_model === "jev-1.13.0");
  const pkNone = await evaluatePickerWithJev({ aixType: "estimate_sheet", messages: [{ sender: "customer", text: "x" }], env: { TYPESAFE_API_KEY: "k" }, fetchImpl: pickerFetch });
  t("★ ピッカーの無いボタンは呼ばずに null", pkNone === null);

  const failFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const bad = await evaluateAixWithJev({ messages: [{ sender: "customer", text: "x" }], env: { TYPESAFE_API_KEY: "k" }, fetchImpl: failFetch });
  t("★ HTTP エラーは null（ブレインを止めない）", bad === null);
  const throwFetch = (async () => { throw new Error("network"); }) as typeof fetch;
  const bad2 = await evaluateAixWithJev({ messages: [{ sender: "customer", text: "x" }], env: { TYPESAFE_API_KEY: "k" }, fetchImpl: throwFetch });
  t("★ 通信の失敗も null", bad2 === null);

  console.log(`\n合計: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
