// 2026-09-16 竹内（YUYA 事例）: 内覧当日の送り出しの後のお礼は返信せず、内覧後の挨拶（AIX）を待つ
// 実行: npx tsx app/lib/__tests__/viewing-day.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveViewingDayAck, STAFF_SENDOFF_RE } from "../viewing-day";
import { stripDateQualifierFromOpenDoor } from "../relative-date";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

// YUYA の実会話（9/16 内覧 10:30・お客様が 10:40 着と連絡）
const YUYA = [
  { sender: "staff", text: "YUYAさんお世話になっております！！\n本日10時半お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！" },
  { sender: "customer", text: "すみません。。\n仕事の都合で到着が10時40分頃になりそうなのですがよろしいでしょうか？" },
  { sender: "staff", text: "はい！！大丈夫です！！\nお気をつけてお越し下さい😊！！" },
  { sender: "customer", text: "ありがとうございます🙇‍♂️" },
];

it("YUYA: 内覧当日・送り出し済み・お礼だけ → 返信しない（内覧後の挨拶を待つ）", () => {
  const v = resolveViewingDayAck(YUYA, true, true);
  expect(v.hold).toBe(true);
  expect(v.reason).toBe("viewing_today_sendoff_ack");
  expect(v.staffLine).toBe("お気をつけてお越し下さい😊！！");
});
it("内覧が今日でなければ止めない（前日のやり取りは普通に返す）", () => {
  expect(resolveViewingDayAck(YUYA, true, false).hold).toBe(false);
  expect(resolveViewingDayAck(YUYA, true, false).reason).toBe("viewing_not_today");
});
it("お礼だけでなければ止めない（遅刻の連絡・到着・階数の質問には返す）", () => {
  const arrived = [...YUYA, { sender: "customer", text: "着いたと思うのですが何階まで上がればいいでしょうか？" }];
  expect(resolveViewingDayAck(arrived, false, true).hold).toBe(false);
  expect(resolveViewingDayAck(arrived, false, true).reason).toBe("customer_not_ack");
});
it("直前のこちらの発言が送り出しでなければ止めない", () => {
  const msgs = [
    { sender: "staff", text: "こちら初期費用の御見積書となります！！" },
    { sender: "customer", text: "ありがとうございます🙇‍♂️" },
  ];
  expect(resolveViewingDayAck(msgs, true, true).hold).toBe(false);
  expect(resolveViewingDayAck(msgs, true, true).reason).toBe("staff_not_sendoff");
});
it("当日の朝の案内文（本日10時半お部屋ご案内させて頂きます）も送り出しとして読む", () => {
  const msgs = [YUYA[0], { sender: "customer", text: "よろしくお願い致します！" }];
  expect(resolveViewingDayAck(msgs, true, true).hold).toBe(true);
  expect(STAFF_SENDOFF_RE.test("かしこまりました！！\nお気をつけてお越しください😌！！")).toBe(true);
  expect(STAFF_SENDOFF_RE.test("ご返答お待ちしております😊！！")).toBe(true);
});
it("最後がこちらの発言なら止めない（お客様の番ではない）", () => {
  expect(resolveViewingDayAck([...YUYA, { sender: "staff", text: "はい😊！！" }], true, true).reason).toBe("last_not_customer");
});
it("画像だけの通は飛ばして直前のこちらの文を見る", () => {
  const msgs = [
    { sender: "staff", text: "はい！！大丈夫です！！\nお気をつけてお越し下さい😊！！" },
    { sender: "staff", text: "[画像]" },
    { sender: "customer", text: "ありがとうございます🙇‍♂️" },
  ];
  expect(resolveViewingDayAck(msgs, true, true).hold).toBe(true);
});

// 扉の一文の日付の修飾（実送信 365日で 185件中 0件）
it("YUYA: 扉の一文の「明日以降も」を落とす", () => {
  const r = stripDateQualifierFromOpenDoor("はい😊！！\n明日以降も気になる点等出てきましたらいつでもお気軽にご連絡ください！！");
  expect(r.text).toBe("はい😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！");
  expect(r.applied.join(",")).toBe("OPEN_DOOR_DATE_QUALIFIER_DROPPED:明日以降も");
});
it("扉の一文の「本日以降も」「9/17以降も」も落とす", () => {
  expect(stripDateQualifierFromOpenDoor("本日以降もご不明な点ございましたらお気軽にご連絡ください！！").text)
    .toBe("ご不明な点ございましたらお気軽にご連絡ください！！");
  expect(stripDateQualifierFromOpenDoor("9/17以降も気になる点出てきましたらお気軽にご連絡ください！！").text)
    .toBe("気になる点出てきましたらお気軽にご連絡ください！！");
});
it("扉ではない文の日付は触らない（明日の約束・明日のご案内）", () => {
  const t = "明日一番で管理会社に確認しご連絡させて頂きます！！";
  expect(stripDateQualifierFromOpenDoor(t).text).toBe(t);
  const t2 = "本日10時半お部屋ご案内させて頂きます！！";
  expect(stripDateQualifierFromOpenDoor(t2).text).toBe(t2);
});
it("「今後も」「引き続き」は落とさない（日付ではない）", () => {
  const t = "今後も気になる点出てきましたらお気軽にご連絡ください！！";
  expect(stripDateQualifierFromOpenDoor(t).text).toBe(t);
  const t2 = "引き続き気になる点等ございましたらお気軽にご連絡ください！！";
  expect(stripDateQualifierFromOpenDoor(t2).text).toBe(t2);
});
it("日付の修飾が無い扉はそのまま（applied も空）", () => {
  const t = "気になる点出てきましたらいつでもお気軽にご連絡ください😌！！";
  const r = stripDateQualifierFromOpenDoor(t);
  expect(r.text).toBe(t);
  expect(r.applied.length).toBe(0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
