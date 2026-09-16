// 2026-09-16 竹内（𝒮 さん事例）: 1日に時間を2つ出すのはお客様が日にちを指定した時だけ。こちらから日にちを出す時は1日1つ
// 実行: npx tsx app/lib/__tests__/viewing-slots.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { pickDaySlots, limitSlotsPerDay, normalizeMd, limitViewingSlotsInReply } from "../viewing-slots";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("こちらから出す日は先頭の1つだけ／指定された日は全部", () => {
  const slots = ["12:00〜14:00", "16:00〜18:00"];
  expect(pickDaySlots(slots, false)).toBe(["12:00〜14:00"]);
  expect(pickDaySlots(slots, true)).toBe(["12:00〜14:00", "16:00〜18:00"]);
  expect(pickDaySlots([], false)).toBe([]);
});

it("カレンダーの材料（1行1日・/ 区切り）は1日1つに落とす", () => {
  const info = "本日(9/16水) 13:00〜16:00 / 16:00〜18:30\n明日(9/17木) 12:00〜14:00 / 16:00〜18:00";
  expect(limitSlotsPerDay(info)).toBe("本日(9/16水) 13:00〜16:00\n明日(9/17木) 12:00〜14:00");
});

it("𝒮: お客様が指定した日（9/17）はそのまま・他の日は1つに", () => {
  const info = "本日(9/16水) 13:00〜16:00 / 16:00〜18:30\n明日(9/17木) 12:00〜14:00 / 16:00〜18:00";
  expect(limitSlotsPerDay(info, ["9/17"])).toBe("本日(9/16水) 13:00〜16:00\n明日(9/17木) 12:00〜14:00 / 16:00〜18:00");
});

it("生成文の出口: 日付の行の2つ目の時間だけを落とし、後ろの文は残す", () => {
  const text = [
    "かしこまりました！！",
    "お部屋ご案内させて頂きます！！",
    "",
    "直近ですと",
    "9/16(水) 12:00〜15:00",
    "9/18(金) 10:30〜11:30 17:00〜18:30にてご案内可能です😊！！",
    "",
    "隼斗さんご都合よろしいお日にち御座いますでしょうか！！",
  ].join("\n");
  expect(limitSlotsPerDay(text)).toBe([
    "かしこまりました！！",
    "お部屋ご案内させて頂きます！！",
    "",
    "直近ですと",
    "9/16(水) 12:00〜15:00",
    "9/18(金) 10:30〜11:30にてご案内可能です😊！！",
    "",
    "隼斗さんご都合よろしいお日にち御座いますでしょうか！！",
  ].join("\n"));
});

it("愛乃の型（「明日 9/7(月) 11:00〜11:30 ・17:30〜18:00」）の中黒の区切りも一緒に落とす", () => {
  expect(limitSlotsPerDay("明日 9/7(月) 11:00〜11:30  ・17:30〜18:00")).toBe("明日 9/7(月) 11:00〜11:30");
});

it("時間が1つの行・時間の無い行は変えない", () => {
  expect(limitSlotsPerDay("明日 9/17(水) 10:30〜13:30")).toBe("明日 9/17(水) 10:30〜13:30");
  expect(limitSlotsPerDay("かしこまりました！！")).toBe("かしこまりました！！");
  expect(limitSlotsPerDay("")).toBe("");
});

it("日付が読めない行は、指定日がある時は触らない（減らして指定日の候補を消さない）", () => {
  expect(limitSlotsPerDay("明日ですと 12:00〜14:00 16:00〜18:00", ["9/17"])).toBe("明日ですと 12:00〜14:00 16:00〜18:00");
  // 指定日が無ければ（こちらから出す日）落とす
  expect(limitSlotsPerDay("明日ですと 12:00〜14:00 16:00〜18:00")).toBe("明日ですと 12:00〜14:00");
});

it("時刻だけの候補（「本日 17:00 明日 12:00」）も先頭だけにする", () => {
  expect(limitSlotsPerDay("6/24 13:00 17:00")).toBe("6/24 13:00");
});

it("M/D の揃え方（09/17・9／17 も 9/17）", () => {
  expect(normalizeMd("09/17")).toBe("9/17");
  expect(normalizeMd("9／17")).toBe("9/17");
  expect(normalizeMd("9/17(木)")).toBe("9/17");
  expect(normalizeMd("明日")).toBe("");
});

// ── 出口（AIX【内覧へ】の生成後）────────────────────────────
// 2026-09-16(水) 15:27 JST = 06:27 UTC（𝒮 さんの実際の場面）
const NOW = Date.UTC(2026, 8, 16, 6, 27);
const S_REPLY = "かしこまりました！！\n明日お部屋ご案内させて頂きます！！\n\n明日ですと\n9/17(木) 12:00〜14:00  16:00〜18:00\nご案内可能です😊！！\n\nSさんご都合よろしいお時間御座いますでしょうか！！";

it("𝒮: お客様が「明日だと何時」と1日だけ指定 → その日の2つの時間はそのまま", () => {
  const msgs = [
    { sender: "staff", text: "お部屋ご案内させて頂きます！！" },
    { sender: "customer", text: "お世話なっております！\nすみません容量の問題でトーク来てないかもです💦\n明日だと何時だとご都合よろしいでしょうか？" },
  ];
  expect(limitViewingSlotsInReply(S_REPLY, { messages: msgs, nowMs: NOW })).toBe(S_REPLY);
  // 画面の入力（内覧日指定あり）から来た時も同じ
  expect(limitViewingSlotsInReply(S_REPLY, { requestedDatesText: "9/17(木)", nowMs: NOW })).toBe(S_REPLY);
});

it("こちらから日にちを出す時（お客様の指定なし）は1日1つに落とす", () => {
  const msgs = [{ sender: "customer", text: "お部屋見てみたいです！" }];
  expect(limitViewingSlotsInReply(S_REPLY, { messages: msgs, nowMs: NOW })).toBe(
    "かしこまりました！！\n明日お部屋ご案内させて頂きます！！\n\n明日ですと\n9/17(木) 12:00〜14:00\nご案内可能です😊！！\n\nSさんご都合よろしいお時間御座いますでしょうか！！",
  );
});

it("お客様が複数日を挙げた時は各日1つ（実送信の型は日付の数＝枠の数）", () => {
  const text = "直近ですと\n9/17(木) 12:00〜14:00 16:00〜18:00\n9/18(金) 10:30〜11:30 17:00〜18:30にてご案内可能です😊！！";
  const msgs = [{ sender: "customer", text: "17日か18日はいかがでしょうか？" }];
  expect(limitViewingSlotsInReply(text, { messages: msgs, nowMs: NOW })).toBe(
    "直近ですと\n9/17(木) 12:00〜14:00\n9/18(金) 10:30〜11:30にてご案内可能です😊！！",
  );
});

it("断りの文の日付は指定日にしない（「本日は厳しいので…」）", () => {
  const text = "9/16(水) 12:00〜14:00 16:00〜18:00\nご案内可能です😊！！";
  const msgs = [{ sender: "customer", text: "本日は厳しいです" }];
  expect(limitViewingSlotsInReply(text, { messages: msgs, nowMs: NOW })).toBe("9/16(水) 12:00〜14:00\nご案内可能です😊！！");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
