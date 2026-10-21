// グループの返信 → 【やることリスト】の行（app/lib/staff-todo-reply.ts）— 作り物のデータだけ・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-reply.test.ts（全 PASS で exit 0）
import {
  parseTodoReply, resolveTodoReply, pickTodoSnapshot, renderTodoReplyAck, ambiguousTodoNumbers, circledToNumber, isTodoNumbersOnly, TODO_SNAPSHOT_FRESH_MS,
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

// ─── 回す一覧の取り違え（2026-10-21）: 引用の無い「☑3」が前の一覧の③（別の新着確認の人）の時 ───
const J = (hm: string) => Date.parse(`2026-10-21T${hm}:00+09:00`);
const rot = (messageId: string, hm: string, n3: { key: string; cid: string; name: string } | null, extra: TodoSnapshot["items"] = []): TodoSnapshot => ({
  messageId, sentAt: new Date(J(hm)).toISOString(),
  items: [
    { n: 1, key: "aix:a1", conversationId: "c1", name: "テスト太郎", label: "AIX【見積書送る】：御見積書" },
    { n: 2, key: "newarrival:cK:2026-10-21", conversationId: "cK", name: "けいこ", label: "新着の物件確認：…" },
    ...(n3 ? [{ n: 3, key: n3.key, conversationId: n3.cid, name: n3.name, label: "新着の物件確認：…" }] : []),
    ...extra,
  ],
});
const A3 = { key: "newarrival:cA:2026-10-21", cid: "cA", name: "あいこ" };
const B3 = { key: "newarrival:cB:2026-10-21", cid: "cB", name: "べにこ" };
const m1 = rot("m1", "10:30", A3), m2 = rot("m2", "11:30", B3);
const snaps = [m2, m1];
/** サーバーと同じ順で読む（引用・返信の時刻・今） */
function readReply(text: string, quoted: string | null, replyAt: number, now = replyAt + 2000, ss: TodoSnapshot[] = snaps) {
  const p = parseTodoReply(text)!;
  const s = pickTodoSnapshot(ss, quoted, now, replyAt)!;
  const amb = ambiguousTodoNumbers(p.numbers, ss, quoted, now, replyAt);
  return { snap: s, res: resolveTodoReply(p, s, amb) };
}

it("回す: 新しい一覧のすぐ後の引用の無い「☑3」で前後の③が別の人 → ☑しない・引用か名前で返してと言う", () => {
  const { res } = readReply("☑3", null, J("11:40"));
  eq(res.hits.length, 0); eq(res.ambiguousNumbers, [3]); eq(res.unknownNumbers, []);
  const ack = renderTodoReplyAck(res, null)!;
  ok(ack.includes("引用") && ack.includes("「☑3」") && ack.includes("〇〇さん なし"), ack);
  ok(!ack.includes("あいこ") && !ack.includes("べにこ"), ack);
});
it("回す: ✅の時も同じ（返事は「✅3」「〇〇さん 完了」）", () => {
  const { res } = readReply("✅3", null, J("11:31"));
  eq(res.hits.length, 0); eq(res.ambiguousNumbers, [3]);
  const ack = renderTodoReplyAck(res, null)!;
  ok(ack.includes("「✅3」") && ack.includes("〇〇さん 完了") && !ack.includes("なし"), ack);
});
it("回す: 一覧を引用した「☑3」はその一覧の③（前の一覧でも今の一覧でも）", () => {
  eq(readReply("☑3", "m1", J("11:40")).res.hits.map((h) => h.key), [A3.key]);
  eq(readReply("☑3", "m2", J("11:40")).res.hits.map((h) => h.key), [B3.key]);
  eq(readReply("☑3", "m1", J("11:40")).res.ambiguousNumbers, undefined);
});
it("回す: 「べにこさん なし」（名前）はずれない＝すぐ☑", () => {
  const { res } = readReply("べにこさん なし", null, J("11:35"));
  eq(res.hits.map((h) => h.key), [B3.key]); eq(res.ambiguousNumbers, undefined);
});
it("回す: 新しい一覧から30分を過ぎた引用の無い「☑3」は今の一覧の③", () => {
  const { res } = readReply("☑3", null, J("12:01"));
  eq(res.hits.map((h) => h.key), [B3.key]); eq(res.ambiguousNumbers, undefined);
});
it("回す: 次の一覧が出る前に送った返信（届くのが遅れた）は、その時の一覧（前の一覧）の③", () => {
  const { snap, res } = readReply("☑3", null, J("11:20"), J("11:31"));
  eq(snap.messageId, "m1"); eq(res.hits.map((h) => h.key), [A3.key]); eq(res.ambiguousNumbers, undefined);
});
it("回す: 控えの書き込みの直前（1分内）に送った返信は決めない（新しい一覧を見ていたかもしれない）", () => {
  const { res } = readReply("☑3", null, J("11:29") + 30_000, J("11:31"));
  eq(res.hits.length, 0); eq(res.ambiguousNumbers, [3]);
});
it("回す: 前後で同じ行の番号はずれない＝すぐ☑（②は両方けいこさん）", () => {
  const { res } = readReply("☑2", null, J("11:35"));
  eq(res.hits.map((h) => h.key), ["newarrival:cK:2026-10-21"]); eq(res.ambiguousNumbers, undefined);
});
it("回す: ずれる番号とずれない番号を一緒に返した時は、ずれない方だけ☑して、ずれる方は聞く", () => {
  const { res } = readReply("☑2 3", null, J("11:35"));
  eq(res.hits.map((h) => h.n), [2]); eq(res.ambiguousNumbers, [3]);
  const ack = renderTodoReplyAck(res, null)!;
  ok(ack.includes("☑2 けいこさん") && ack.includes("⚠️ 3 は前の一覧と番号がずれています"), ack);
});
it("回す: 前の一覧にだけある番号は決めない／今の一覧にだけある番号は今の一覧の番号", () => {
  const onlyPrev = [rot("m2", "11:30", null), m1];
  const r1 = readReply("☑3", null, J("11:35"), J("11:35") + 2000, onlyPrev).res;
  eq(r1.hits.length, 0); eq(r1.ambiguousNumbers, [3]); eq(r1.unknownNumbers, []);
  const onlyCur = [m2, rot("m1", "10:30", null)];
  const r2 = readReply("☑3", null, J("11:35"), J("11:35") + 2000, onlyCur).res;
  eq(r2.hits.map((h) => h.key), [B3.key]); eq(r2.ambiguousNumbers, undefined);
});
it("回す: 一覧が1つだけ・控えの時刻が読めない物は数えない", () => {
  eq(readReply("☑3", null, J("10:35"), J("10:35"), [m1]).res.hits.map((h) => h.key), [A3.key]);
  const broken = { ...m1, sentAt: "not-a-date" };
  eq(readReply("☑3", null, J("11:35"), J("11:35"), [m2, broken]).res.hits.map((h) => h.key), [B3.key]);
});
it("回す: 返信の時刻が無い（古い呼び方）時は今の時刻で読む", () => {
  const p = parseTodoReply("☑3")!;
  eq(pickTodoSnapshot(snaps, null, J("11:40"))?.messageId, "m2");
  eq(ambiguousTodoNumbers(p.numbers, snaps, null, J("11:40")), [3]);
  eq(ambiguousTodoNumbers(p.numbers, snaps, null, J("12:40")), []);
});
it("回す: 返信より後に出た一覧の番号では読まない（返信の時刻より前の一覧を選ぶ）", () => {
  eq(pickTodoSnapshot(snaps, null, J("11:31"), J("11:10"))?.messageId, "m1");
  eq(pickTodoSnapshot(snaps, null, J("11:31"), J("10:00")), null);
});

// サーバーの読み（handleTodoGroupReply）: 作り物の DB（控えを読むだけ・書き込みは数える）で、ずれる番号は書かずに聞き返す
async function serverCase() {
  const { handleTodoGroupReply } = await import("../staff-todo-reply-server");
  const writes: string[] = [];
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b; b.eq = () => b; b.in = () => b;
    b.maybeSingle = async () => ({ data: table === "hanbancyo_settings" ? { value: JSON.stringify(snaps) } : null, error: null });
    b.upsert = async () => { writes.push(`upsert:${table}`); return { error: null }; };
    b.update = () => { writes.push(`update:${table}`); return b; };
    return b;
  };
  const sb = { from: builder } as unknown as Parameters<typeof handleTodoGroupReply>[0];
  const amb = await handleTodoGroupReply(sb, { text: "☑3", quotedMessageId: null, userId: "u", replyAtMs: J("11:40") }, J("11:40") + 1500);
  it("サーバー: ずれる「☑3」は何も書かず、聞き返す文を返す", () => {
    ok(amb?.includes("〇〇さん なし") && amb.includes("引用"), String(amb)); eq(writes, []);
  });
  const quoted = await handleTodoGroupReply(sb, { text: "☑3", quotedMessageId: "m1", userId: "u", replyAtMs: J("11:40") }, J("11:40") + 1500);
  it("サーバー: 引用した「☑3」は前の一覧の③（あいこさん）を☑", () => {
    ok(quoted?.includes("☑3 あいこさん"), String(quoted)); eq(writes, ["upsert:staff_todo_marks"]);
  });
}

serverCase().catch((e) => { failed++; console.log(`  ✗ serverCase ${e}`); }).finally(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
