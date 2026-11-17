// AIX が2種類ある番の AIX→AIX の席（TWO_MESSAGE_AIX_AIX・既定 off・作業員M 2026-11-15・統括役の決定 ①-(a)(b)）
// 実行: npx tsx app/lib/__tests__/two-message-aix-aix.test.ts
// 形は試験の答案（q014・q048・q134・q151・q184 の要件の形・物件名は伏せた）
import { planMessages, twoMessageAixAixOn, aixKindsOfAsks, remainingAfterAix } from "../two-message-plan";
import { buildAskLedger } from "../ask-ledger";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };
const withEnv = <T>(v: string | undefined, f: () => T): T => { const o = process.env.TWO_MESSAGE_AIX_AIX; if (v === undefined) delete process.env.TWO_MESSAGE_AIX_AIX; else process.env.TWO_MESSAGE_AIX_AIX = v; try { return f(); } finally { if (o === undefined) delete process.env.TWO_MESSAGE_AIX_AIX; else process.env.TWO_MESSAGE_AIX_AIX = o; } };

t("既定 off", twoMessageAixAixOn({}) === false && twoMessageAixAixOn({ TWO_MESSAGE_AIX_AIX: "on" }) === true);

// q014 の形: 案内できますか（物件確認した）＋初期費用の見積もり（見積書）・最終の AIX は見積書
const q014 = [
  { quote: "案内できますか？", route: "aix", aix: "property_check_result", about: "vacancy", kind: "question" },
  { quote: "初期費用の見積もり出してもらえますか", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "request" },
];
t("種類: 物件確認した を先", JSON.stringify(aixKindsOfAsks(q014)) === JSON.stringify(["property_check_result", "estimate_sheet"]));
t("種類: 物件の束は1つ", aixKindsOfAsks([{ quote: "a", route: "aix", aix: "property_send" }, { quote: "b", route: "aix", aix: "property_recommendation/x" }]).length === 1);
{
  const off = withEnv(undefined, () => planMessages({ asks: q014, finalAix: "estimate_sheet" }));
  t("off は今と同じ（AIX の席は1つ）", off.messages.filter((m) => m.slot === "aix").length === 1, off.messages);
  const offL = withEnv(undefined, () => buildAskLedger({ asks: q014, finalAix: "estimate_sheet" }));
  t("off の帳面は取りこぼし1", offL.check.dropped.length === 1, offL.check);

  const on = withEnv("on", () => planMessages({ asks: q014, finalAix: "estimate_sheet" }));
  const aixSeats = on.messages.filter((m) => m.slot === "aix");
  t("on: AIX の席が2つ（物件確認した → 見積書）", aixSeats.length === 2 && aixSeats[0].aix === "property_check_result" && aixSeats[1].aix === "estimate_sheet", on.messages);
  t("on: 各席が自分の要件に答える", aixSeats[0].answers[0] === q014[0].quote && aixSeats[1].answers[0] === q014[1].quote.slice(0, 40));
  t("on: 通の番号が1から順", on.messages.every((m, k) => m.no === k + 1));
  const onL = withEnv("on", () => buildAskLedger({ asks: q014, finalAix: "estimate_sheet" }));
  t("on の帳面は外れ0", onL.check.ok, onL.check);
  t("on: 1つ目の AIX を送った後に2つ目の AIX が残る", remainingAfterAix(on, "property_check_result")?.some((m) => m.slot === "aix" && m.aix === "estimate_sheet") === true);
  t("on: 型は AIX が2つ入る", (on.shape.match(/A/g) ?? []).length === 2, on.shape);
}

// q048 の形: 見積書＋待ち合わせ（内見行きたい）
{
  const asks = [
    { quote: "この物件の初期費用はどのくらい", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "question" },
    { quote: "上記4件の内見行きたいです", route: "aix", aix: "meeting_place", about: "viewing_day", kind: "request" },
  ];
  const on = withEnv("on", () => planMessages({ asks, finalAix: "estimate_sheet" }));
  const s = on.messages.filter((m) => m.slot === "aix").map((m) => m.aix);
  t("q048: 見積書 → 待ち合わせ（要件の順）", JSON.stringify(s) === JSON.stringify(["estimate_sheet", "meeting_place"]), on.messages);
  t("q048: 帳面の外れ0", withEnv("on", () => buildAskLedger({ asks, finalAix: "estimate_sheet" })).check.ok);
}

// 返信の質問と約束が混ざる番: 約束の返信 → AIX → AIX、返信の質問は残る
{
  const asks = [
    { quote: "家賃15万で戸建て探してほしい", route: "promise", answer: "ピックアップしお送り", about: "search_condition", kind: "request" },
    { quote: "まだ空いてますか", route: "aix", aix: "property_check_result", about: "vacancy", kind: "question" },
    { quote: "見積もりください", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "request" },
  ];
  const on = withEnv("on", () => planMessages({ asks, finalAix: "estimate_sheet" }));
  t("約束あり: 1通目は返信", on.messages[0].slot === "reply" && on.messages[0].answers.includes(asks[0].quote), on.messages);
  const L = withEnv("on", () => buildAskLedger({ asks, finalAix: "estimate_sheet" }));
  t("約束あり: 帳面の外れ0・全部に通", L.check.ok && L.items.every((e) => e.msg != null), L);
}

// AIX が1種類の番は on でも今と同じ
{
  const asks = [{ quote: "見積もりください", route: "aix", aix: "estimate_sheet", kind: "request" }];
  const a = withEnv(undefined, () => planMessages({ asks, finalAix: "estimate_sheet" }));
  const b = withEnv("on", () => planMessages({ asks, finalAix: "estimate_sheet" }));
  t("1種類は on でも同じ", JSON.stringify(a) === JSON.stringify(b));
}

// 席を最終の AIX に合わせる（TWO_MESSAGE_SEAT_FOLLOWS_FINAL・既定 off）
{
  const withBoth = <T>(f: () => T): T => { const o1 = process.env.TWO_MESSAGE_AIX_AIX, o2 = process.env.TWO_MESSAGE_SEAT_FOLLOWS_FINAL; process.env.TWO_MESSAGE_AIX_AIX = "on"; process.env.TWO_MESSAGE_SEAT_FOLLOWS_FINAL = "on"; try { return f(); } finally { if (o1 === undefined) delete process.env.TWO_MESSAGE_AIX_AIX; else process.env.TWO_MESSAGE_AIX_AIX = o1; if (o2 === undefined) delete process.env.TWO_MESSAGE_SEAT_FOLLOWS_FINAL; else process.env.TWO_MESSAGE_SEAT_FOLLOWS_FINAL = o2; } };
  // q330 の形: 内覧したい（約束）＋送った物件3件の空き（物件確認した）・最終は内覧調整
  const q330 = [
    { quote: "15日見に行けたりしますか？", route: "promise", about: "viewing_day", kind: "request" },
    { quote: "物件A 1LDK 11階", route: "aix", aix: "property_check_result", about: "vacancy", kind: "question" },
    { quote: "物件B 1LDK 26階", route: "aix", aix: "property_check_result", about: "vacancy", kind: "question" },
  ];
  const offL = buildAskLedger({ asks: q330, finalAix: "viewing_invite" });
  t("q330 off: 取り違え（要件の AIX ≠ 最終の AIX）", offL.check.misrouted.length >= 1, offL.check);
  const p = withBoth(() => planMessages({ asks: q330, finalAix: "viewing_invite" }));
  t("q330 on: 内覧調整の席1つ（確認は文の中）", p.messages.filter((m) => m.slot === "aix").length === 1 && p.messages.find((m) => m.slot === "aix")?.aix === "viewing_invite", p.messages);
  const L = withBoth(() => buildAskLedger({ asks: q330, finalAix: "viewing_invite" }));
  t("q330 on: 帳面の外れ0", L.check.ok, L.check);
  t("q330 on: 内覧調整を送った後に組みが読める", withBoth(() => remainingAfterAix(p, "viewing_invite")) !== null || p.messages[p.messages.length - 1].slot === "aix");
  // q187 の形: よろしくお願いします（物件確認した）・最終は見積書
  const q187 = [{ quote: "よろしくお願いします！", route: "aix", aix: "property_check_result", about: "reaction_to_sent", kind: "report" }];
  const p2 = withBoth(() => planMessages({ asks: q187, finalAix: "estimate_sheet" }));
  const seats = p2.messages.filter((m) => m.slot === "aix").map((m) => m.aix);
  t("q187 on: 物件確認した → 見積書の2席", JSON.stringify(seats) === JSON.stringify(["property_check_result", "estimate_sheet"]), p2.messages);
  t("q187 on: 帳面の外れ0", withBoth(() => buildAskLedger({ asks: q187, finalAix: "estimate_sheet" })).check.ok);
  // 要件に最終の AIX がある番は今と同じ
  const same = [{ quote: "見積もりください", route: "aix", aix: "estimate_sheet" }];
  t("要件に最終の AIX があれば同じ", JSON.stringify(withBoth(() => planMessages({ asks: same, finalAix: "estimate_sheet" }))) === JSON.stringify(planMessages({ asks: same, finalAix: "estimate_sheet" })));
}

console.log(`\ntwo-message-aix-aix: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
