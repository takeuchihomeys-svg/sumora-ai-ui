// 2026-10-02 竹内「AIXの電話をかけるが…不在の通知がはいるようにする」: 電話ボタンを押した記録の署名・転送の URL・通知文・トーク画面の印
// 実行: npx tsx app/lib/__tests__/call-tap.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { signCallTap, verifyCallTap, buildCallTapUrl, buildCallTapNotice, callTapSecret } from "../call-tap";
import { shouldShowCallTapBadge } from "../call-tap-view";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const SECRET = "test-secret-123456";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const CALL = "https://lin.ee/x8chWxm";

it("署名は合う物だけ通す", () => {
  const s = signCallTap(CONV, "sumora", SECRET);
  expect(verifyCallTap(CONV, "sumora", s, SECRET)).toBe(true);
  expect(verifyCallTap(CONV, "ieyasu", s, SECRET)).toBe(false);
  expect(verifyCallTap("00000000-0000-0000-0000-000000000000", "sumora", s, SECRET)).toBe(false);
  expect(verifyCallTap(CONV, "sumora", s.slice(0, -1) + (s.endsWith("A") ? "B" : "A"), SECRET)).toBe(false);
  expect(verifyCallTap(CONV, "sumora", "", SECRET)).toBe(false);
  expect(verifyCallTap(CONV, "sumora", s, "other-secret-999")).toBe(false);
});

it("https の自分のサイトの時だけ転送の形にする", () => {
  const u = buildCallTapUrl({ origin: "https://sumora-ai-ui.vercel.app", conversationId: CONV, accountKey: "sumora", callUrl: CALL, secret: SECRET });
  const p = new URL(u);
  expect(p.pathname).toBe("/api/call-tap");
  expect(p.searchParams.get("c")).toBe(CONV);
  expect(p.searchParams.get("a")).toBe("sumora");
  expect(verifyCallTap(CONV, "sumora", p.searchParams.get("s") ?? "", SECRET)).toBe(true);
});

it("手元（http）・鍵なし・会話なしは通話URL をそのまま", () => {
  expect(buildCallTapUrl({ origin: "http://localhost:3000", conversationId: CONV, accountKey: "sumora", callUrl: CALL, secret: SECRET })).toBe(CALL);
  expect(buildCallTapUrl({ origin: "https://sumora-ai-ui.vercel.app", conversationId: CONV, accountKey: "sumora", callUrl: CALL, secret: null })).toBe(CALL);
  expect(buildCallTapUrl({ origin: "https://sumora-ai-ui.vercel.app", conversationId: null, accountKey: "sumora", callUrl: CALL, secret: SECRET })).toBe(CALL);
});

it("鍵は8文字以上の物だけ", () => {
  expect(callTapSecret({})).toBe(null);
  expect(callTapSecret({ SYNC_SECRET: "short" })).toBe(null);
  expect(callTapSecret({ INTERNAL_API_SECRET: "abcdefgh12" })).toBe("abcdefgh12");
  expect(callTapSecret({ CALL_TAP_SECRET: "callsecret1", INTERNAL_API_SECRET: "abcdefgh12" })).toBe("callsecret1");
});

it("通知文は名前と JST の時刻", () => {
  expect(buildCallTapNotice("YUMA", new Date("2026-10-02T06:05:00Z"))).toBe("📞【電話】\nYUMAさんが電話ボタンを押しました（15:05）\n出られなかった時は折り返しをお願いします");
  expect(buildCallTapNotice("", new Date("2026-10-02T06:05:00Z")).includes("名前なし")).toBe(true);
});

it("トーク画面の印: 押した後にスタッフの送信が無ければ出す・あれば消す・24時間で消す", () => {
  const tap = "2026-10-02T06:00:00Z";
  const now = Date.parse("2026-10-02T06:10:00Z");
  expect(shouldShowCallTapBadge(tap, [{ sender: "staff", rawCreatedAt: "2026-10-02T05:50:00Z" }, { sender: "customer", rawCreatedAt: "2026-10-02T06:05:00Z" }], now)).toBe(true);
  expect(shouldShowCallTapBadge(tap, [{ sender: "staff", rawCreatedAt: "2026-10-02T06:08:00Z" }], now)).toBe(false);
  expect(shouldShowCallTapBadge(tap, [], Date.parse("2026-10-03T06:00:01Z"))).toBe(false);
  expect(shouldShowCallTapBadge(null, [], now)).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
