// 2026-09-29 Jev の影の運用（お客様の発言の分類・Haiku の 4 択と並べる）— 純関数のテスト
// 実行: npx tsx app/lib/__tests__/condition-classify-jev.test.ts
import {
  CONDITION_CLASSES, JEV_CONDITION_CLASS_OPTIONS, buildConditionClassifyState, buildConditionClassifyQuestion,
  parseConditionClassifyAnswer, evaluateConditionClassifyWithJev, toConditionClassifyShadowRow, passesConditionGate, compareConditionClassify,
} from "../condition-classify-jev";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

console.log("── ★ 選択肢は Haiku の 4 択と同じ（増やさない・減らさない）");
{
  t("★ 4 択が全部ある", CONDITION_CLASSES.length === 4 && CONDITION_CLASSES.every((c) => c in JEV_CONDITION_CLASS_OPTIONS));
  t("★ 幽霊の選択肢が無い", Object.keys(JEV_CONDITION_CLASS_OPTIONS).length === 4);
  const q = buildConditionClassifyQuestion();
  t("★ 質問は choice・criteria は 4 択", q.type === "choice" && Object.keys(q.criteria).length === 4);
}

console.log("── ★ state: Haiku と同じ材料（直近の会話 150 字・今回の発言 500 字）・うちのフォーマットの説明を持つ");
{
  const s = buildConditionClassifyState({
    recentContext: [{ sender: "staff", text: "ご希望の\n\nエリアは？" + "x".repeat(300) }, { sender: "customer", text: "   " }],
    customerText: "難波で1Kがいいです " + "y".repeat(600),
  }) as { recent_conversation: Array<{ who: string; text: string }>; customer_message: string; our_condition_format: string };
  t("★ 空の発言は落とす・150 字で切る", s.recent_conversation.length === 1 && s.recent_conversation[0].who === "スタッフ" && s.recent_conversation[0].text.length === 150);
  t("★ 改行・連続空白は 1 つに", !s.recent_conversation[0].text.includes("\n"));
  t("★ 今回の発言は 500 字で切る", s.customer_message.length === 500);
  t("★ うちのフォーマットの説明（①〜⑧）を持つ", s.our_condition_format.includes("①【ご入居の時期】") && s.our_condition_format.includes("⑧"));
}

console.log("── ★ 答えの読み取り: 4 択以外は捨てる・確率と確信度を持つ");
{
  const d = parseConditionClassifyAnswer({ type: "choice", choice: "condition_add", probabilities: { condition_add: 0.7, not_condition: 0.3 }, confidence: 0.6 });
  t("★ 4 択の答えを読む", d?.type === "condition_add" && d.prob === 0.7 && d.confidence === 0.6);
  t("★ 知らない選択肢は null", parseConditionClassifyAnswer({ type: "choice", choice: "greeting" }) === null);
  t("★ choice 以外は null", parseConditionClassifyAnswer({ type: "noul", noul: 0.9 }) === null && parseConditionClassifyAnswer(undefined) === null);
  t("★ 確率が無ければ 1", parseConditionClassifyAnswer({ type: "choice", choice: "not_condition" })?.prob === 1);
}

console.log("── ★ 入口の判断（通す／落とす）は line-webhook-text と同じ線（not_condition でなく 0.6 以上）");
{
  t("★ 0.6 以上の条件は通す", passesConditionGate("condition_change", 0.6) && passesConditionGate("formal_format", 0.9));
  t("★ 0.6 未満は落とす", !passesConditionGate("condition_change", 0.59));
  t("★ not_condition は確率に関係なく落とす", !passesConditionGate("not_condition", 0.99));
  t("★ confidence 無しは 0.5 扱い（Haiku の既定と同じ）で落とす", !passesConditionGate("condition_add", null));
  const a = compareConditionClassify({ brain_action: "condition_add", brain_prob: 0.8, brain_source: "haiku", jev_picker: "condition_change", jev_picker_prob: 0.7 });
  t("★ 4 択は違うが入口は同じ（両方通す）", !a.sameClass && a.sameGate && !a.hardTruth && a.jevRightOnHard === null);
  const b = compareConditionClassify({ brain_action: "formal_format", brain_prob: 1, brain_source: "deterministic", jev_picker: "not_condition", jev_picker_prob: 0.9 });
  t("★ 決定論の回は硬い正解: Jev の外しが数えられる", b.hardTruth && b.jevRightOnHard === false && !b.sameGate);
  const c = compareConditionClassify({ brain_action: "formal_format", brain_prob: 1, brain_source: "deterministic", jev_picker: "formal_format", jev_picker_prob: 0.95 });
  t("★ 決定論の回で Jev が当てた", c.jevRightOnHard === true && c.sameClass);
}

(async () => {
  console.log("── ★ 生きた呼び出し（偽の fetch）: 鍵なしは通信しない・答えは影の行になる・失敗は null");
  const none = await evaluateConditionClassifyWithJev({ recentContext: [], customerText: "x", env: {} });
  t("★ 鍵なしは null（通信しない）", none === null);

  const sentBox: { body: Record<string, unknown> | null; auth: string | null } = { body: null, auth: null };
  const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sentBox.body = JSON.parse(String(init?.body)); sentBox.auth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { condition_class: { type: "choice", choice: "formal_format", probabilities: { formal_format: 0.92, not_condition: 0.05 }, confidence: 0.88 } }, usage: { input_tokens: 500, output_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ev = await evaluateConditionClassifyWithJev({
    recentContext: [{ sender: "staff", text: "ご希望のご条件お送りください" }],
    customerText: "①【ご入居の時期】⇒10月\n②【ご希望の家賃】⇒7万まで\n⑤【ご希望のエリア・駅名】⇒難波",
    conversationId: "c1", env: { TYPESAFE_API_KEY: "test-key" }, fetchImpl: fakeFetch,
  });
  const body = sentBox.body as { state?: Record<string, unknown>; questions?: Record<string, unknown> } | null;
  t("★ state と questions（condition_class 1 問）を POST・Bearer で認証", !!body && sentBox.auth === "Bearer test-key" && Object.keys(body.questions ?? {}).join() === "condition_class" && typeof body.state === "object");
  t("★ 答えが読める", ev?.decision.type === "formal_format" && ev.decision.prob === 0.92 && ev.decision.confidence === 0.88 && ev.raw.model === "jev-1.13.0");
  const row = toConditionClassifyShadowRow("c1", "2026-09-29T00:00:00Z", { type: "not_condition", confidence: 0.7, source: "haiku" }, ev!);
  t("★ 影の行: kind・今の判定（Haiku）・Jev の答えが並ぶ", row.kind === "classify_condition" && row.brain_action === "not_condition" && row.brain_prob === 0.7 && row.brain_source === "haiku" && row.jev_picker === "formal_format" && row.jev_picker_prob === 0.92 && row.jev_picker_field === "condition_class");
  const rowD = toConditionClassifyShadowRow("c1", null, { type: "formal_format", confidence: 1, source: "deterministic" }, ev!);
  t("★ 決定論の回は brain_prob=1・source=deterministic", rowD.brain_prob === 1 && rowD.brain_source === "deterministic");

  const badAnswer = (async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { condition_class: { type: "choice", choice: "hello" } }, usage: {} }), { status: 200 })) as typeof fetch;
  t("★ 知らない答えは null（記録しない）", (await evaluateConditionClassifyWithJev({ recentContext: [], customerText: "x", env: { TYPESAFE_API_KEY: "k" }, fetchImpl: badAnswer })) === null);
  const failFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  t("★ HTTP エラーは null（止めない）", (await evaluateConditionClassifyWithJev({ recentContext: [], customerText: "x", env: { TYPESAFE_API_KEY: "k" }, fetchImpl: failFetch })) === null);
  const throwFetch = (async () => { throw new Error("network"); }) as typeof fetch;
  t("★ 通信の失敗も null", (await evaluateConditionClassifyWithJev({ recentContext: [], customerText: "x", env: { TYPESAFE_API_KEY: "k" }, fetchImpl: throwFetch })) === null);

  console.log(`\n合計: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
