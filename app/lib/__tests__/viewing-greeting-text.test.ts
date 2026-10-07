// 2026-10-07 竹内「文の質をあげてボタンとしてつかっていく」: AIX【内覧挨拶】の内覧前（決まった3行・LLM なし）と内覧後の1行目
// 実行: npx tsx app/lib/__tests__/viewing-greeting-text.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { viewingTimeJa, buildViewingBeforeGreeting, viewingAfterThankLine } from "../viewing-greeting-text";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { const a = JSON.stringify(actual), b = JSON.stringify(exp); if (a !== b) throw new Error(`expected ${b} but got ${a}`); },
    notToContain(s: string) { if (String(actual).includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

it("時刻: 14:00→14時・12:30→12時半・10:45→10時45分・14時はそのまま・読めなければ空", () => {
  expect(viewingTimeJa("14:00")).toBe("14時");
  expect(viewingTimeJa("12:30")).toBe("12時半");
  expect(viewingTimeJa("10:45")).toBe("10時45分");
  expect(viewingTimeJa("１５：００")).toBe("15時");
  expect(viewingTimeJa("14時")).toBe("14時");
  expect(viewingTimeJa("10時半")).toBe("10時半");
  expect(viewingTimeJa("")).toBe("");
  expect(viewingTimeJa("午後")).toBe("");
  expect(viewingTimeJa("25:00")).toBe("");
});
// 実送信（10/06 田邉さん・09/12 Sさん・08/24 H!tom!.Mさん）と同じ3行
it("内覧前: 今日はじめての LINE＝名前＋お世話になっております＋本日〇時お部屋ご案内させて頂きます！＋本日は何卒…（手打ちの型と一字一句同じ）", () => {
  expect(buildViewingBeforeGreeting({ name: "Sさん", greeting: "お世話になっております！！", time: "14:00" }))
    .toBe("Sさんお世話になっております！！\n本日14時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！");
  expect(buildViewingBeforeGreeting({ name: "YUYAさん", greeting: "お世話になっております！！", time: "10:30" }))
    .toBe("YUYAさんお世話になっております！！\n本日10時半お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！");
});
it("内覧前: 今日すでに送った＝挨拶なし（名前の行だけ）・名前も無ければ本文から・時刻が無ければ「本日お部屋ご案内」", () => {
  expect(buildViewingBeforeGreeting({ name: "モモカさん", greeting: "", time: "16:30" })).toBe("モモカさん\n本日16時半お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！");
  expect(buildViewingBeforeGreeting({ name: "", greeting: "お世話になっております！！", time: "12:00" })).toBe("お世話になっております！！\n本日12時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！");
  expect(buildViewingBeforeGreeting({ name: "", greeting: "", time: "" })).toBe("本日お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！");
});
it("内覧前: Haiku が出していた崩れ（形の記号・初回の挨拶・物件名）は決定論の文に出ない", () => {
  const t = buildViewingBeforeGreeting({ name: "aさん", greeting: "お世話になっております！！", time: "13:00" });
  for (const w of ["②", "「", "」", "ご連絡頂きありがとうございます", "今日も1日"]) expect(t).notToContain(w);
});
it("内覧後の1行目: 名前が無ければ呼ばない（「お客様本日…」12回の直し）", () => {
  expect(viewingAfterThankLine("rさん")).toBe("rさん本日お時間頂きありがとうございました！！");
  expect(viewingAfterThankLine("")).toBe("本日お時間頂きありがとうございました！！");
  expect(viewingAfterThankLine("")).notToContain("お客様");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
