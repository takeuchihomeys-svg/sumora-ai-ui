// 2026-09-23 竹内「お客さんが送ってきた画像が、こちらから送った画像かどうかの判定も Jev でできるのかな」
// 実行: npx tsx app/lib/__tests__/own-property-jev.test.ts
import {
  buildOwnPropertyJevQuestion, parseOwnPropertyJevAnswer, dedupeChoices, choiceKeyFor,
  askOwnPropertyJev, NONE_KEY, MAX_CHOICES, type SentChoice,
} from "../own-property-jev";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

const SENT: SentChoice[] = [
  { name: "ラクラス阿倍野元町", room: "0507", sentAt: "2026-09-19T10:50:00Z" },
  { name: "ラクラス阿倍野元町", room: "507", sentAt: "2026-09-20T10:50:00Z" },   // 同じ部屋の表記ゆれ
  { name: "SUMMIT（サミット）", room: "406", sentAt: "2026-09-20T12:51:00Z" },
  { name: "", room: null, sentAt: null },                                        // 名前なしは捨てる
];

console.log("── ★ 選択肢: 同じ物件はまとめ、新しい順・上限あり");
{
  const c = dedupeChoices(SENT);
  t("★ 号室の表記ゆれ（0507 と 507）は1つにまとまる", c.length === 2, c.map((x) => choiceKeyFor(x)));
  t("★ 名前が無い記録は選択肢に出さない", c.every((x) => x.name.length >= 2));
  t("★ 新しい順", (c[0].sentAt ?? "") >= (c[1].sentAt ?? ""));
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `物件${i}`, room: String(100 + i), sentAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }));
  t(`★ 上限 ${MAX_CHOICES} 件に絞る（Jev の上限 255 の内側）`, dedupeChoices(many).length === MAX_CHOICES);
}

console.log("── ★ 質問の形");
{
  t("★ 送った物件が無ければ質問を作らない", buildOwnPropertyJevQuestion([]) === null);
  const q = buildOwnPropertyJevQuestion(SENT)!;
  t("★ choice で「どれでもない」を必ず入れる", q.type === "choice" && NONE_KEY in (q as { criteria: Record<string, string> }).criteria);
  const crit = (q as { criteria: Record<string, string> }).criteria;
  t("★ 選択肢の説明に物件名・号室・送った日が入る", Object.values(crit).some((v) => v.includes("ラクラス阿倍野元町") && v.includes("507号室") && v.includes("9/20")));
  t("★ 指示で「建物が同じでも号室が違えば どれでもない」を明示（同じ部屋と言い切らせない）",
    (q as { instructions: string }).instructions.includes("号室が違えば"));
}

console.log("── ★ 答えの読み方");
{
  const key = choiceKeyFor({ name: "ラクラス阿倍野元町", room: "507", sentAt: null });
  const d = parseOwnPropertyJevAnswer({ type: "choice", choice: key, probabilities: { [key]: 0.93, none: 0.07 }, confidence: 0.9 }, SENT);
  t("★ 選ばれた物件と確率が取れる", d?.choice?.name === "ラクラス阿倍野元町" && d.prob === 0.93 && d.confidence === 0.9);
  const n = parseOwnPropertyJevAnswer({ type: "choice", choice: NONE_KEY, probabilities: { none: 0.88 } }, SENT);
  t("★ どれでもない（お客様が見つけた物件）", n?.choice === null && n.key === NONE_KEY && n.prob === 0.88);
  t("★ 知らない選択肢は使わない（null）", parseOwnPropertyJevAnswer({ type: "choice", choice: "p_知らない物件" }, SENT) === null);
  t("★ 答えが無い・形が違う時は null", parseOwnPropertyJevAnswer(undefined, SENT) === null && parseOwnPropertyJevAnswer({ type: "noul", noul: 0.9 }, SENT) === null);
}

console.log("── ★ 呼び出し（鍵が無ければ何もしない・失敗しても止めない）");
(async () => {
  t("★ 鍵なしは null", await askOwnPropertyJev({ transcript: "[画像] x", sent: SENT, env: {} }) === null);
  t("★ 送った物件が無ければ呼ばない", await askOwnPropertyJev({ transcript: "[画像] x", sent: [], env: { TYPESAFE_API_KEY: "k" } }) === null);

  const box: { body: Record<string, unknown> | null } = { body: null };
  const key = choiceKeyFor({ name: "ラクラス阿倍野元町", room: "507", sentAt: null });
  const fake = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    box.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { which_property: { type: "choice", choice: key, probabilities: { [key]: 0.95 }, confidence: 0.9 } }, usage: { input_tokens: 400, output_tokens: 12 } }), { status: 200 });
  }) as typeof fetch;
  const ev = await askOwnPropertyJev({
    transcript: "[画像] ラクラス阿倍野元町 0507 6.4万円（省なし）(+共 8,000円)\n募集中 物探下見",
    sent: SENT, conversationId: "c1", env: { TYPESAFE_API_KEY: "k" }, fetchImpl: fake,
  });
  const state = (box.body?.state ?? {}) as Record<string, unknown>;
  t("★ 渡すのは書き起こしの文字だけ（画像は渡さない）", typeof state.customer_image_text === "string" && !JSON.stringify(box.body).includes("image_url") && !JSON.stringify(box.body).includes("base64"));
  t("★ 先頭の [画像] は外して渡す", String(state.customer_image_text).startsWith("ラクラス"));
  t("★ 答え: こちらが送った物件と確率", ev?.decision.choice?.name === "ラクラス阿倍野元町" && ev.decision.prob === 0.95);
  t("★ model と ms を持つ（記録用）", ev?.raw.model === "jev-1.13.0" && typeof ev.raw.ms === "number");

  const bad = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  t("★ 失敗は null（今までどおり決定論だけで動く）", await askOwnPropertyJev({ transcript: "[画像] x", sent: SENT, env: { TYPESAFE_API_KEY: "k" }, fetchImpl: bad }) === null);

  console.log(`\n合計: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
