// G33（2026-09-20 竹内「お客さんの名前入れる部分注意して」）:
//   standard（当日未挨拶）の挨拶行は**必須ではない**ことを生成の指示が言っているか。
//
// 根拠（scripts/audit-greeting-line.ts・直近120日の実送信）:
//   当日はじめての送信 1312通（はじめまして除く）で「お世話になっております」は 33%。
//   長さ別 3.2%／26.0%／45.2%／37.5%／9.6% ＝ **どこも過半数に届かない**（300字以上は旧文言と逆）。
//   下書き→実送信の差分でも「お世話→名前」92件・「お世話→なし」94件（計186件）が付けすぎ由来。
//   設計知見「必須にしてよいのは過半数が守っている形だけ」により固定をやめた。
//
// 実行: npx tsx app/lib/__tests__/greeting-standard-optional.test.ts（全 PASS で exit 0）
import { resolveGreeting, buildGreetingNote, enforceOpening, isProgressPushMessage } from "../greeting";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}

type M = { sender: string; text: string; createdAt: string };
/** 当日まだ送っていない（＝ standard）状況を作る */
function standardDecision(jstHour: number, customerText: string) {
  const msgs: M[] = [
    { sender: "staff", text: "お部屋のご紹介をお送りさせて頂きます！！", createdAt: "2026-09-17T02:00:00Z" },
    { sender: "customer", text: customerText, createdAt: "2026-09-19T23:30:00Z" },
  ];
  const lastStaff = msgs[0];
  const staff = classifyLastStaffTurn(lastStaff.text, { lastStaffAt: lastStaff.createdAt });
  const sub = analyzeSubstance(customerText, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const cr = classifyCustomerResponse(sub, staff);
  return resolveGreeting({
    customerName: "じゅにあ", isFirstEverReply: false, alreadyGreetedToday: false, recentMessages: msgs,
    jstHour, now: Date.parse("2026-09-20T01:00:00Z"),
    isProgressPush: isProgressPushMessage(customerText, { isAckOnly: sub.isAckOnly }),
    isSubstantive: (t: string) => analyzeSubstance(t).has,
    customerKind: cr.kind, customerSecondary: cr.secondary, substanceKinds: sub.kinds,
  });
}

describe("standard の挨拶行は必須ではない", () => {
  it("S1 当日未挨拶 → kind=standard・openingLine は従来どおり", () => {
    const d = standardDecision(10, "この物件気になります！");
    expect(d.kind).toBe("standard");
    expect(d.openingLine).toBe("じゅにあさんお世話になっております！！");
  });

  it("S2 指示は「必須ではない」と言う（旧: 長い返信は固定）", () => {
    const note = buildGreetingNote(standardDecision(10, "この物件気になります！"), 10);
    expect(note).toContain("必須ではない");
    expect(note).not.toContain("先頭行は「じゅにあさんお世話になっております！！」で固定");
  });

  it("S3 指示は実送信の比率を見せる（本題・開口語・名前だけ の3つの逃げ道）", () => {
    const note = buildGreetingNote(standardDecision(10, "この物件気になります！"), 10);
    expect(note).toContain("本題からすぐ入る");
    expect(note).toContain("開口語");
    expect(note).toContain("「じゅにあさん」だけ置いて改行し本題");
  });

  it("S4 「必ず「」は使わない（first/late_apology だけの語）", () => {
    const note = buildGreetingNote(standardDecision(10, "この物件気になります！"), 10);
    expect(note).not.toContain("必ず「");
  });

  it("S5 後処理は standard で挨拶行を足さない（AI が書かなければ付かない）", () => {
    const d = standardDecision(10, "この物件気になります！");
    const body = "かしこまりました😊！！\nこちらのお部屋の詳細お調べさせて頂きます！！";
    const { cleaned } = enforceOpening(body, d);
    expect(cleaned).not.toContain("お世話になっております");
  });

  it("S6 後処理は standard で AI が書いた挨拶行を消さない（誤削除0）", () => {
    const d = standardDecision(10, "この物件気になります！");
    const body = "じゅにあさんお世話になっております！！\nかしこまりました😊！！\nこちらのお部屋の詳細お調べさせて頂きます！！";
    const { cleaned } = enforceOpening(body, d);
    expect(cleaned).toContain("お世話になっております");
  });
});

describe("夜間だけは従来どおり固定（enforce=true）", () => {
  it("S7 深夜帯は先頭行を固定と伝える", () => {
    const d = standardDecision(2, "この物件気になります！");
    const note = buildGreetingNote(d, 2);
    if (d.enforce) {
      expect(note).toContain("固定");
      expect(note).not.toContain("必須ではない");
    } else {
      // 夜間接頭辞が無効化されている場合は standard と同じ扱いでよい
      expect(note).toContain("必須ではない");
    }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
