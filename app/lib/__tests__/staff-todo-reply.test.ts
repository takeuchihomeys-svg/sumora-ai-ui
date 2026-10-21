// グループの返信 → 【やることリスト】の行（app/lib/staff-todo-reply.ts）— 作り物のデータだけ・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-reply.test.ts（全 PASS で exit 0）
import {
  parseTodoReply, resolveTodoReply, pickTodoSnapshot, renderTodoReplyAck, circledToNumber, isTodoNumbersOnly, TODO_SNAPSHOT_FRESH_MS,
  type TodoSnapshot,
} from "../staff-todo-reply";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, m = "expected truthy") { if (!v) throw new Error(m); }

const NOW = Date.parse("2026-10-21T13:00:00+09:00");
const snap = (messageId: string, sentAt: string): TodoSnapshot => ({
  messageId, sentAt,
  items: [
    { n: 1, key: "aix:a1", conversationId: "c1", name: "テスト太郎", label: "AIX【見積書送る】：御見積書を作ってお送りする" },
    { n: 2, key: "promise:5", conversationId: "c1", name: "テスト太郎", label: "AIX【物件ピックアップした】：物件ピックアップ送付（お約束）" },
    { n: 3, key: "viewing:9", conversationId: "c2", name: "はなこ", label: "内覧：15:00 テスト荘のご案内" },
    { n: 4, key: "reply:c3:x", conversationId: "c3", name: "テスト次郎", label: "返信：10/21 09:00 のご連絡に返信する" },
  ],
});

console.log("staff-todo-reply");

it("✅／完了／済 の言葉が無い発言は読まない", () => {
  eq(parseTodoReply("3番のお客様どうなりました？"), null);
  eq(parseTodoReply("テスト太郎さんから電話ありました"), null);
  eq(parseTodoReply(""), null);
});

it("番号: 半角・全角・丸数字・並べ方いろいろ", () => {
  eq(parseTodoReply("✅3")!.numbers, [3]);
  eq(parseTodoReply("✅ 3 5")!.numbers, [3, 5]);
  eq(parseTodoReply("③⑤ 完了")!.numbers, [3, 5]);
  eq(parseTodoReply("１、２済みです")!.numbers, [1, 2]);
  eq(parseTodoReply("完了 3,4")!.numbers, [3, 4]);
});

it("時刻・日付・件数・部屋番号は番号にしない", () => {
  eq(parseTodoReply("10:30 の分 ✅2")!.numbers, [2]);
  eq(parseTodoReply("10/21 送りました ✅")?.numbers ?? [], []);
  eq(parseTodoReply("1305号室の確認 完了 ①")!.numbers, [1]);
});

it("名前: 「〇〇さん 完了」「完了 〇〇さん」「✅〇〇さん」", () => {
  eq(parseTodoReply("テスト太郎さん 完了")!.names, ["テスト太郎"]);
  eq(parseTodoReply("完了 はなこさん")!.names, ["はなこ"]);
  eq(parseTodoReply("✅はなこさん")!.names, ["はなこ"]);
});

it("普段の会話を✅にしない（すみません・長い文の数字・名前の1文字）", () => {
  eq(parseTodoReply("すみません、3つ目の物件どうでした？"), null);
  eq(parseTodoReply("テスト太郎さん、すみません折り返します"), null);
  eq(parseTodoReply("やったー！2件決まりました"), null);
  eq(parseTodoReply("申込完了しました！2回目でやっと通りました"), null);
  eq(parseTodoReply("テスト太郎さんの申込の件はさっき完了しました、あと5も見ておきます")?.numbers ?? [], []);
  const s = snap("m1", "2026-10-21T12:30:00+09:00");
  eq(resolveTodoReply({ numbers: [], names: ["は"] }, s).hits.length, 0);
});

it("一覧を貼り返した文は読まない", () => {
  eq(parseTodoReply("【やることリスト】10/21 10:30\n✅AIX【…】"), null);
});

it("丸数字の読み", () => {
  eq(circledToNumber("①"), 1); eq(circledToNumber("⑳"), 20); eq(circledToNumber("㉑"), 21); eq(circledToNumber("㊿"), 50); eq(circledToNumber("a"), null);
});

it("番号だけ（物件出しの「完了 [顧客名]」と見分ける）", () => {
  eq(isTodoNumbersOnly("3"), true); eq(isTodoNumbersOnly("③ ⑤"), true); eq(isTodoNumbersOnly("3,5"), true);
  eq(isTodoNumbersOnly("テスト太郎"), false); eq(isTodoNumbersOnly(""), false);
});

it("どの一覧で読むか: 引用した一覧 → 無ければ最後の一覧（古すぎれば読まない）", () => {
  const a = snap("m1", "2026-10-21T10:30:00+09:00"), b = snap("m2", "2026-10-21T12:30:00+09:00");
  eq(pickTodoSnapshot([b, a], "m1", NOW)?.messageId, "m1");
  eq(pickTodoSnapshot([a, b], null, NOW)?.messageId, "m2");
  eq(pickTodoSnapshot([a, b], "unknown", NOW)?.messageId, "m2");
  eq(pickTodoSnapshot([a], null, Date.parse(a.sentAt) + TODO_SNAPSHOT_FRESH_MS + 1), null);
});

it("番号と名前を行に結ぶ（名前はそのお客様の残りの行を全部）", () => {
  const s = snap("m1", "2026-10-21T12:30:00+09:00");
  eq(resolveTodoReply(parseTodoReply("✅3")!, s).hits.map((h) => h.key), ["viewing:9"]);
  eq(resolveTodoReply(parseTodoReply("テスト太郎さん 完了")!, s).hits.map((h) => h.key), ["aix:a1", "promise:5"]);
  const r = resolveTodoReply(parseTodoReply("✅9")!, s);
  eq(r.hits.length, 0); eq(r.unknownNumbers, [9]);
});

it("名前が2人以上に当たる時は決めない（番号で返してもらう）", () => {
  const s = snap("m1", "2026-10-21T12:30:00+09:00");
  const r = resolveTodoReply(parseTodoReply("テストさん 完了")!, s);
  eq(r.hits.length, 0); eq(r.unknownNames, ["テスト"]);
  ok(renderTodoReplyAck(r, null)!.includes("番号で"));
});

it("返事: ✅番号・名前・行の中身", () => {
  const s = snap("m1", "2026-10-21T12:30:00+09:00");
  const ack = renderTodoReplyAck(resolveTodoReply(parseTodoReply("✅1 3")!, s), null)!;
  ok(ack.includes("✅1 テスト太郎さん AIX【見積書送る】"), ack);
  ok(ack.includes("✅3 はなこさん 内覧"), ack);
  eq(renderTodoReplyAck({ hits: [], unknownNumbers: [], unknownNames: [] }, null), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
