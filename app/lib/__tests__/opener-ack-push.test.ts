// 2026-09-17 竹内（Hina 事例）: 了承＋こちらが既に言ったことの後押しは「はい」（かしこまりましたではない）
// 実行: npx tsx app/lib/__tests__/opener-ack-push.test.ts
import { resolveAckPush } from "../opener-ack-push";
import { resolveOpener } from "../greeting";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// Hina 9/17 のこちらの発言（写真・動画を既に申し出ている）
const HINA_STAFF = [
  "明日、室内の写真と動画撮影しお送りさせていただきます！！",
  "内覧会ですがお時間13:00〜13:30の枠のみ確保出来ております！！\nお時間厳しい場合、撮影した室内写真と動画お送りさせて頂きます😌！！",
];

console.log("\n[実データ: はい だった12件（新しい中身が無い後押し）]");
const HAI_CASES: [string, string[]][] = [
  ["承知しました！\n時間的に厳しそうなので、\n写真またお願いします🙇🏻‍♀️", HINA_STAFF], // 竹内さんのスクショ
  ["了解しました！\n当日よろしくお願いいたします", ["9/15 12:00にご案内させて頂きます！！"]],
  ["かしこまりました！よろしくお願いします", []],
  ["分かりました！お願いいたします🙇🏼‍♀️", []],
  ["わかりました！\nありがとうございます、\nよろしくお願いします！", []],
  ["わかりました!\nよろしくお願いします(よろしく)", []],
  ["分かりました！\n引き続きよろしくお願い致します", []],
  ["わかりました！\n何卒宜しくお願いいたします🙇‍♂️", []],
  ["承知しました！\nよろしくお願いいたします！", []],
  ["かしこまりました！\nよろしくお願いいたします🙇‍♀️", []],
  ["承知しました。\n引き続きよろしくお願いいたします。", []],
];
it("11件すべて後押し（push=true）と判定する", () => {
  const ng = HAI_CASES.filter(([t, staff]) => !resolveAckPush(t, staff).push).map(([t]) => t.slice(0, 20));
  expect(ng).toBe([]);
});
it("Hina の通は「写真」がこちらの発言にあるので後押し", () => {
  const v = resolveAckPush("承知しました！\n時間的に厳しそうなので、\n写真またお願いします🙇🏻‍♀️", HINA_STAFF);
  expect(v.push).toBe(true);
  expect(v.reason).toBe("ack_push_already_offered");
  expect(v.objects).toBe(["写真"]);
});
it("こちらがまだ言っていない物を頼まれたら後押しではない（新しい依頼）", () => {
  const v = resolveAckPush("承知しました！\n見積書またお願いします", HINA_STAFF);
  expect(v.push).toBe(false);
  expect(v.reason).toBe("new_object:見積書");
});

console.log("\n[実データ: かしこまりました だった7件（新しい中身がある）]");
const KASHI_CASES = [
  "わかりました、19:30に現地集合にてよろしくお願いします。",
  "承知しました\n\n19日夕方の鍵受け渡し宜しくお願いします\n契約書届いたら返送します",
  "わかりました！\n\n追加でこちらも空いているか確認お願いしたいです",
  "わかりました！\nあればお願いします！",
  "承知しました。ありがとうございます。引き続きよろしくお願いいたします。日付未定大阪市内で引越し業者は決めちゃってます。よろしくお願いいたします。",
];
it("新しい中身（日時・追加の依頼・条件つき）があれば後押しにしない", () => {
  const ng = KASHI_CASES.filter((t) => resolveAckPush(t, []).push).map((t) => t.slice(0, 24));
  expect(ng).toBe([]);
});
it("実データの監査で出た誤爆2件も後押しにしない（目的語つきの依頼・条件の指定）", () => {
  // 「グランデールの内覧をお願い致します。」＝物件を指した新しい依頼
  expect(resolveAckPush("承知致しました。\n\nグランデールの内覧をお願い致します。", ["ご案内の内覧可能日は…"]).push).toBe(false);
  // 「同じくらいの感じでよろしくお願いします！」＝条件の指定（押しの言葉を剥がすと中身が残る）
  expect(resolveAckPush("かしこまりました！\nよろしくお願いします！\n\n同じくらいの感じでよろしくお願いします！", []).push).toBe(false);
});

console.log("\n[この場面ではない通]");
it("了承で始まらない・お願いが無い通は触らない", () => {
  expect(resolveAckPush("こちらの6件お調べして頂きたいです", []).reason).toBe("not_ack_head");
  expect(resolveAckPush("承知しました！", []).reason).toBe("no_push_word");
  expect(resolveAckPush("", []).reason).toBe("no_text");
  expect(resolveAckPush("保証人不要のお部屋も追加でお願いします", []).reason).toBe("not_ack_head");
});

console.log("\n[開口語の決定]");
it("後押しなら「はい」で、かしこまりましたは許さない", () => {
  const op = resolveOpener({ greetingKind: "none", customerKind: "other", substanceKinds: ["statement"], ackPush: true });
  expect(op.opener).toBe("hai");
  expect(op.openerAllowed).toBe(["hai", "none"]);
});
it("後押しでなければ従来どおり（分類不能は LLM を尊重）", () => {
  const op = resolveOpener({ greetingKind: "none", customerKind: "other", substanceKinds: ["statement"], ackPush: false });
  expect(op.opener).toBe("none");
  expect(op.openerAllowed).toBe(["none", "hai", "kashikomari"]);
});
it("申込の案内の後の検討（みく事例）は後押しより優先されない＝従来どおり かしこまりました", () => {
  const op = resolveOpener({ greetingKind: "none", customerKind: "thinking", applyGuideThinking: true, ackPush: true });
  expect(op.opener).toBe("kashikomari");
});
it("初回・結果報告・条件フォームの判定は変わらない", () => {
  expect(resolveOpener({ greetingKind: "first", customerKind: "ack_only", ackPush: true }).opener).toBe("none");
  expect(resolveOpener({ greetingKind: "none", customerKind: "ack_only", isDeliverableReply: true, ackPush: true }).opener).toBe("none");
  expect(resolveOpener({ greetingKind: "none", customerKind: "ack_only", customerSentConditionForm: true, ackPush: true }).opener).toBe("none");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
