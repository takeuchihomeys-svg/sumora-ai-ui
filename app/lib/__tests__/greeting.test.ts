// G32（2026-09-09 Fable5 じゅにあ事例）: 冒頭二層（挨拶行＋開口語）の回帰テスト。「お待たせ致しました」は如何なる場合も出ない。
// 実行: npx tsx app/lib/__tests__/greeting.test.ts（全 PASS で exit 0）
import {
  resolveGreeting, enforceOpening, buildGreetingNote, stripWaited, isProgressPushMessage, normalizeGreetingLite, toGreetingLite, buildFirstGreeting,
} from "../greeting";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../reply-context";
import { runDeterministicChecks } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (Array.isArray(actual) ? !actual.includes(item) : typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
    toStartWith(prefix: string) { if (typeof actual !== "string" || !actual.startsWith(prefix)) throw new Error(`expected ${JSON.stringify(actual)} to start with ${JSON.stringify(prefix)}`); },
  };
}

type M = { sender: string; text: string; createdAt: string };
const NOW_1616 = Date.parse("2026-09-09T07:16:00Z"); // JST 16:16
const isSub = (t: string) => analyzeSubstance(t).has;
/** generate-reply と同じ順で decision を作る（classifyCustomerResponse → resolveGreeting） */
function decide(msgs: M[], now: number, jstHour: number, extra: { isFirst?: boolean; deliverable?: boolean; greetedToday?: boolean } = {}) {
  const lastStaff = [...msgs].reverse().find((m) => m.sender === "staff");
  const custs = msgs.slice(msgs.findIndex((m) => m === lastStaff) + 1).filter((m) => m.sender === "customer").map((m) => m.text).join("\n");
  const staff = classifyLastStaffTurn(lastStaff?.text ?? "", { lastStaffAt: lastStaff?.createdAt ?? null });
  const sub = analyzeSubstance(custs, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const cr = classifyCustomerResponse(sub, staff);
  const greetedToday = extra.greetedToday ?? (lastStaff ? Date.parse(lastStaff.createdAt) >= Date.parse("2026-09-08T15:00:00Z") : false);
  return resolveGreeting({
    customerName: "じゅにあ", isFirstEverReply: !!extra.isFirst, alreadyGreetedToday: greetedToday, recentMessages: msgs, jstHour, now,
    isProgressPush: isProgressPushMessage(custs, { isAckOnly: sub.isAckOnly }), isSubstantive: isSub,
    customerKind: cr.kind, customerSecondary: cr.secondary, substanceKinds: sub.kinds, isDeliverableReply: !!extra.deliverable,
  });
}
const JUNIA: M[] = [
  { sender: "staff", text: "じゅにあさんお世話になっております！！\nはい😊！！ごゆっくりご検討頂けますと幸いです！！\n\nまたじゅにあさんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、気になる点等出てきましたら何時でもお気軽にご連絡ください😌！！", createdAt: "2026-09-09T02:13:16Z" },
  { sender: "customer", text: "よろしくお願いします🙇‍♀️", createdAt: "2026-09-09T02:45:31Z" },
  { sender: "customer", text: "我孫子駅から天王寺駅までの間で探して頂いてもいいですか？", createdAt: "2026-09-09T06:36:54Z" },
  { sender: "customer", text: "出来たらネット環境がある物件が良いです。", createdAt: "2026-09-09T06:37:16Z" },
];
const BODY = "我孫子駅から天王寺駅までの間で探させて頂きます！！ネット環境ありのお部屋も含めてじゅにあさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！";

describe("じゅにあ事例", () => {
  it("T1 16:16 当日挨拶済み＋依頼形 → 挨拶行なし・開口語かしこまりました", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(d.kind).toBe("none"); expect(d.openingLine).toBe(""); expect(d.opener).toBe("kashikomari");
    expect(buildGreetingNote(d, 16)).not.toContain("必ず「");
    expect(buildGreetingNote(d, 16)).toContain("かしこまりました");
  });
  it("T1b AI旧生成「じゅにあさんお待たせ致しました！！」は剥がれ、正解文はそのまま通る", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const bad = enforceOpening(`じゅにあさんお待たせ致しました！！\n${BODY}`, d);
    expect(bad.cleaned).not.toContain("お待たせ"); expect(bad.cleaned).toStartWith("我孫子駅");
    const ok = enforceOpening(`かしこまりました😊！！\n${BODY}`, d);
    expect(ok.cleaned).toBe(`かしこまりました😊！！\n${BODY}`); expect(ok.fixes.length).toBe(0);
  });
  it("T2 同じ会話で 15:36 依頼を 4h 放置（JST 19:36）→ それでも お待たせ は出ず かしこまりました", () => {
    const d = decide(JUNIA, Date.parse("2026-09-09T10:36:54Z"), 19);
    expect(d.kind).toBe("none"); expect(d.opener).toBe("kashikomari");
    expect(d.audit.waitedMs).toBe(4 * 3600 * 1000);
    expect(d.audit.originTextHead ?? "").toStartWith("我孫子駅"); // 起点は了承のみ(11:45)ではなく実質のある依頼
    expect(buildGreetingNote(d, 19)).not.toContain("必ず「");
  });
  it("T3 final-check ⑦: 正解文は OPENING_GREETING_*／OPENER_MISMATCH／BANNED_WORD を出さない", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const codes = runDeterministicChecks(`かしこまりました😊！！\n${BODY}`, { recentMessages: JUNIA, lastCustomerMessage: JUNIA[3].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d) }).map((i) => i.code);
    expect(codes.some((c) => c.startsWith("OPENING_GREETING") || c === "OPENER_MISMATCH" || c === "BANNED_WORD")).toBe(false);
  });
  it("T4 final-check: 「お待たせ致しました」を含む文は BANNED_WORD block", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const issues = runDeterministicChecks(`じゅにあさんお待たせ致しました！！\n${BODY}`, { recentMessages: JUNIA, lastCustomerMessage: JUNIA[3].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d) });
    expect(issues.some((i) => i.code === "BANNED_WORD" && i.severity === "block" && /お待たせ/.test(i.evidence ?? ""))).toBe(true);
  });
});

describe("挨拶行の決定", () => {
  const YESTERDAY_STAFF: M = { sender: "staff", text: "じゅにあさんお世話になっております！！\n🌟サンピアザ 503号室\nお手隙の際にご査収ください😌！！", createdAt: "2026-09-08T05:30:00Z" };
  it("T5 了承のみを 5h 放置・当日未挨拶 → standard（お世話に）＋はい", () => {
    const d = decide([YESTERDAY_STAFF, { sender: "customer", text: "よろしくお願いします🙇", createdAt: "2026-09-09T02:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("standard"); expect(d.openingLine).toBe("じゅにあさんお世話になっております！！"); expect(d.opener).toBe("hai");
    expect(d.audit.waitedMs).toBe(null); // 了承のみは起点にならない
  });
  it("T5b 了承のみ 5h 放置・当日挨拶済み → none＋はい", () => {
    const d = decide([{ ...YESTERDAY_STAFF, createdAt: "2026-09-09T01:00:00Z" }, { sender: "customer", text: "ありがとうございます！", createdAt: "2026-09-09T02:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("none"); expect(d.opener).toBe("hai");
  });
  it("T6 約束の結果報告（deliverable）当日未挨拶 → お世話に＋開口語なし。当日挨拶済み → 挨拶行なし。どちらも お待たせ は出ない", () => {
    const req: M = { sender: "customer", text: "こちらの物件の空室確認お願いします", createdAt: "2026-09-09T00:00:00Z" };
    const a = decide([YESTERDAY_STAFF, req], NOW_1616, 16, { deliverable: true });
    expect(a.kind).toBe("standard"); expect(a.opener).toBe("none"); expect(buildGreetingNote(a, 16)).not.toContain("お待たせ致しました」で");
    const b = decide([YESTERDAY_STAFF, req], NOW_1616, 16, { deliverable: true, greetedToday: true });
    expect(b.kind).toBe("none"); expect(b.openingLine).toBe(""); expect(b.opener).toBe("none");
    const out = enforceOpening("じゅにあさんお待たせ致しました！！\n🌟サンピアザ 503号室 現在募集中となります！！\nお手隙の際にご査収ください😌！！", b);
    expect(out.cleaned).toStartWith("🌟サンピアザ"); expect(out.cleaned).not.toContain("お待たせ");
  });
  it("T7 情報質問 → 開口語なし（はい／かしこまりました も許容）。「はい！！」で始めた生成はそのまま", () => {
    const d = decide([YESTERDAY_STAFF, { sender: "customer", text: "この物件の初期費用はいくらになりますか？", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16, { greetedToday: true });
    expect(d.opener).toBe("none"); expect(d.openerAllowed).toContain("hai");
    expect(enforceOpening("はい😊！！\n初期費用は約25万円となります！！", d).cleaned).toBe("はい😊！！\n初期費用は約25万円となります！！");
  });
  it("T8 初回 → first・はじめまして固定・開口語なし", () => {
    const d = decide([{ sender: "customer", text: "難波で1LDK探してます", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16, { isFirst: true });
    expect(d.kind).toBe("first"); expect(d.openingLine).toBe(buildFirstGreeting("じゅにあ")); expect(d.opener).toBe("none");
    expect(enforceOpening("かしこまりました！！\n難波周辺でピックアップさせて頂きます！！", d).cleaned).toStartWith(buildFirstGreeting("じゅにあ"));
  });
  // 2026-09-12 竹内（Aoi 事例）: 返信に「夜遅くに失礼します」は入れない → 深夜でも夜間接頭辞は付けない（旧 T9 は付与を期待していた）
  it("T9 深夜（JST 23 時・直前スタッフ発言 5h 前・当日挨拶済み）→ 夜間接頭辞は付けない", () => {
    const d = decide([{ ...YESTERDAY_STAFF, createdAt: "2026-09-09T09:00:00Z" }, { sender: "customer", text: "2LDKでも探してもらえますか？", createdAt: "2026-09-09T13:50:00Z" }], Date.parse("2026-09-09T14:00:00Z"), 23);
    expect(d.kind).toBe("none"); expect(d.openingLine).toBe(""); expect(d.opener).toBe("kashikomari");
    expect(enforceOpening("かしこまりました！！\n2LDKでもピックアップさせて頂きます！！", d).cleaned).toStartWith("かしこまりました！！");
  });
  it("T10 当日挨拶済み＋依頼: LLM が「お世話になっております」を書いても剥がれて かしこまりました のみ", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(enforceOpening(`じゅにあさんお世話になっております！！\nかしこまりました！！\n${BODY}`, d).cleaned).toStartWith("かしこまりました！！\n我孫子駅");
  });
});

describe("催促（late_apology）", () => {
  const staff: M = { sender: "staff", text: "かしこまりました！！\n空室確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", createdAt: "2026-09-09T01:00:00Z" };
  it("T11 「まだですか？連絡ないんですけど」→ late_apology・開口語なし", () => {
    const d = decide([staff, { sender: "customer", text: "空室確認まだですか？連絡ないんですけど", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("late_apology"); expect(d.openingLine).toBe("じゅにあさん、ご連絡遅くなり申し訳御座いません！！"); expect(d.opener).toBe("none");
  });
  it("T12 催促の実質が無い（了承のみ・依頼 4h 放置）では late_apology にならない", () => {
    expect(isProgressPushMessage("よろしくお願いします🙇", { isAckOnly: true })).toBe(false);
    expect(isProgressPushMessage("ありがとうございます、お願いします", { isAckOnly: true })).toBe(false);
    const d = decide([staff, { sender: "customer", text: "我孫子駅から天王寺駅までの間で探して頂いてもいいですか？", createdAt: "2026-09-09T03:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("none"); expect(d.opener).toBe("kashikomari");
  });
});

describe("開口語の後処理・禁止語", () => {
  it("T13 承知いたしました → かしこまりました に正規化", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(enforceOpening(`承知いたしました！！\n${BODY}`, d).cleaned).toStartWith("かしこまりました！！\n");
  });
  it("T14 了承のみに LLM が かしこまりました → はい に置換", () => {
    const d = decide([{ sender: "staff", text: "🌟サンピアザ 503号室\nお手隙の際にご査収ください😌！！", createdAt: "2026-09-09T05:00:00Z" }, { sender: "customer", text: "ありがとうございます！仕事終わりに見させて頂きます", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16);
    expect(d.opener).toBe("hai");
    expect(enforceOpening("かしこまりました😊！！\nごゆっくりご確認ください！！", d).cleaned).toBe("はい😊！！\nごゆっくりご確認ください！！");
  });
  it("T15 文中2行目の「お待たせいたしました」も除去される", () => {
    const r = stripWaited("かしこまりました！！\nじゅにあさんお待たせいたしました！！ 募集状況確認させて頂きました！！\nお手隙の際にご査収ください😌！！");
    expect(r.removed).toBe(1); expect(r.text).not.toContain("お待たせ"); expect(r.text).toContain("募集状況確認させて頂きました！！");
  });
  it("T16 旧 DB 形式 kind=waited の復元は standard に写像し、お待たせ→お世話に", () => {
    const l = normalizeGreetingLite({ kind: "waited", opening: "じゅにあさんお待たせ致しました！！", reason: "返信まで約5時間" });
    expect(l?.kind).toBe("standard"); expect(l?.openingLine).toBe("じゅにあさんお世話になっております！！");
  });
  it("T17 final-check ⑦: none なのに お世話に 開始 → OPENING_GREETING_UNEXPECTED、了承場面で かしこまりました → OPENER_MISMATCH", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const c1 = runDeterministicChecks(`じゅにあさんお世話になっております！！\nかしこまりました！！\n${BODY}`, { recentMessages: JUNIA, lastCustomerMessage: JUNIA[3].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d) }).map((i) => i.code);
    expect(c1).toContain("OPENING_GREETING_UNEXPECTED");
    const ack: M[] = [JUNIA[0], { sender: "customer", text: "ありがとうございます！検討します", createdAt: "2026-09-09T06:00:00Z" }];
    const d2 = decide(ack, NOW_1616, 16);
    const c2 = runDeterministicChecks("かしこまりました！！\nごゆっくりご検討頂けますと幸いです！！", { recentMessages: ack, lastCustomerMessage: ack[1].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d2) }).map((i) => i.code);
    expect(c2).toContain("OPENER_MISMATCH");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
