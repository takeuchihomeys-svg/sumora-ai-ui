// ②約束の結果→ブレイン の見張り: 確認の約束を物件確認したで果たした番を「送れる物件が揃った」に数えない（LINK_WATCH_CHECK_FIRST）— LLM なし・DB なし
// 実物の型（10/26 あかり: お客様が SUUMO 2件「こちらの物件ありますか」→ こちら「2件、募集状況確認させて頂きます」→ 拡張で2件を探した行 → お礼 → 物件確認した）
// 実行: npx tsx app/lib/__tests__/link-watch-check-first.test.ts
import { watchConversation, reactionTokensOf, type LinkConvInput, type LinkWindow, type LinkVerdict } from "../link-brain-watch";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const H = 3600_000;
const T0 = Date.parse("2026-10-10T01:00:00.000Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString();
const NOW = T0 + 10 * 24 * H;
const W: LinkWindow = { fromMs: T0 - 2 * 24 * H, toMs: NOW, nowMs: NOW };
const base = (over: Partial<LinkConvInput> = {}): LinkConvInput => ({
  conv: { id: "abcdef12-0000-0000-0000-000000000000", customer_name: "テスト", status: "proposing", status_manual_back_at: null },
  messages: [], aixLogs: [], facts: [], turns: [], aixItems: [], pickups: [], judgments: [], memoItems: [], ...over,
});
const of = (vs: LinkVerdict[], link: string) => vs.filter((v) => v.link === link);
const input = () => base({
  messages: [
    { sender: "staff", text: "かしこまりました！！\nご条件に合うお部屋ピックアップ出来次第お送りさせて頂きます😌！！", created_at: iso(-20) },
    { sender: "customer", text: "https://suumo.jp/chintai/x/\nこちらの物件ありますか", created_at: iso(0) },
    { sender: "staff", text: "お部屋お送り頂きありがとうございます！！\nお送り頂きました2件、募集状況確認させて頂きます！！", created_at: iso(0.9) },
    { sender: "customer", text: "ありがとうございます！", created_at: iso(1) },
  ],
  pickups: [{ created_at: iso(0.95), sent_at: null, status: "pending", verdict: "pass" }],
  turns: [{ customer_turn_at: iso(1), brain_action: "", brain_check_pattern: null, brain_at: iso(1.01), staff_first_at: iso(1.3), staff_aix: [{ at: iso(1.3), aix_type: "property_check_result", check_pattern: "available", burst: true }] }] as LinkConvInput["turns"],
});

console.log("link-watch-check-first");
it("off は今まで通り（送れる物件が揃ったと数える）", () => {
  delete process.env.LINK_WATCH_CHECK_FIRST;
  eq(of(watchConversation(input(), W), "result_brain")[0]?.breakType, "pickup_ready_brain_other");
});
it("on: 確認の約束を物件確認したで果たした番は確認の側で見る", () => {
  process.env.LINK_WATCH_CHECK_FIRST = "on";
  try {
    const v = of(watchConversation(input(), W), "result_brain");
    eq(v[0]?.breakType === "pickup_ready_brain_other", false);
  } finally { delete process.env.LINK_WATCH_CHECK_FIRST; }
});
it("③ LINK_WATCH_REACTION_STRICT: 「一旦無しで通して貰ってもいいですか」は外す地域ではない（10/21 実物）", () => {
  delete process.env.LINK_WATCH_REACTION_STRICT;
  eq(reactionTokensOf("今出張で1ヶ月ぐらい帰って来れないので一旦無しで通して貰ってもいいですか？").length, 1);
  process.env.LINK_WATCH_REACTION_STRICT = "on";
  try {
    eq(reactionTokensOf("今出張で1ヶ月ぐらい帰って来れないので一旦無しで通して貰ってもいいですか？"), []);
    eq(reactionTokensOf("肥後橋は外してください"), [{ kind: "exclude", token: "肥後橋" }]);
  } finally { delete process.env.LINK_WATCH_REACTION_STRICT; }
});
it("④ LINK_WATCH_SECOND_WIDE: 開いただけの記録（本文なし）の10分後に答えを送った番は切れにしない（10/23 実物の型）", () => {
  const inp = () => base({
    messages: [
      { sender: "customer", text: "こちらのお部屋空いてますか？ https://suumo.jp/chintai/x/", created_at: iso(0) },
      { sender: "staff", text: "かしこまりました！！\n〇〇の募集状況確認させて頂きます！！", created_at: iso(0.5) },
      { sender: "staff", text: "お待たせ致しました！！\n〇〇 504号室、現在募集中のお部屋となります😊！！", created_at: iso(2 + 10 / 60) },
    ],
    aixLogs: [{ aix_type: "property_check_result", check_pattern: "available", sent_at: null, created_at: iso(2), generated_text: null }],
  });
  const brk = () => of(watchConversation(inp(), W), "brain_second").map((v) => v.breakType ?? "ok");
  delete process.env.LINK_WATCH_SECOND_WIDE;
  const off = brk();
  process.env.LINK_WATCH_SECOND_WIDE = "on";
  try {
    const on = brk();
    eq(on.includes("second_lacks_promise"), false);
    if (off.length) eq(off.includes("second_lacks_promise"), true);
  } finally { delete process.env.LINK_WATCH_SECOND_WIDE; }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
