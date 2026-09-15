// 2026-09-15 竹内（ゆうこ事例）: AIX の本文に書き足した約束も送信時の記録に残す（一覧に AIX が出ない問題）
// 実行: npx tsx app/lib/__tests__/aix-text-promises.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { aixTextPromises, buildActionLedger, type RecordedFact } from "../action-ledger";
import { resolveStaffPromiseAix } from "../aix-task-link";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const YUKO_AIX = "ゆうこさんお世話になっております！！\nレシオス阿倍野ヴィータ303号室は初期費用39,300円は翌月分の家賃を支払った費用となります！！\n\n別途必要な費用はご入居日によって日割家賃が発生いたします！\n\n南向き・5階以上・御堂筋線沿線のご条件でも改めてゆうこさんにオススメできるお部屋ピックアップさせて頂きます！！";
const AT = "2026-09-15T07:32:30.945Z";

it("ゆうこ: 初期費用について の本文のピックアップの約束を読む", () => {
  const ps = aixTextPromises("cost_breakdown", YUKO_AIX, AT);
  expect(ps.map((p) => `${p.kind}/${p.status}`).join(",")).toBe("pickup_declared/promised");
});
it("物件ピックアップした 自身の「ピックアップさせて頂きました」は約束ではない", () => {
  expect(aixTextPromises("property_send", "ゆうこさんにオススメできるお部屋ピックアップさせて頂きました😊！！\nお手隙の際にご査収ください😌！！", AT).length).toBe(0);
});
it("見積書送る・御見積書を同封した AIX の見積書の約束は数えない", () => {
  expect(aixTextPromises("estimate_sheet", "最大限割引しました御見積書お送りさせて頂きます！！", AT).length).toBe(0);
  expect(aixTextPromises("property_check_result", "募集中となります！！御見積書お送りさせて頂きます！！", AT, { estimateEnclosed: true }).length).toBe(0);
});
it("約束の無い AIX は何も足さない", () => expect(aixTextPromises("cost_breakdown", "初期費用は39,300円となります！！", AT).length).toBe(0));

it("記録を台帳に入れると、ブレインの約束の判定が 物件ピックアップした（promise:pickup）になる", () => {
  const facts: RecordedFact[] = [
    { sent_at: "2026-09-14T08:20:00.815Z", origin: "aix", aix_type: "property_send", kind: "properties_sent", status: "done" },
    { sent_at: AT, origin: "aix", aix_type: "cost_breakdown", kind: "cost_breakdown_explained", status: "done" },
    ...aixTextPromises("cost_breakdown", YUKO_AIX, AT).map((p, i) => ({ sent_at: new Date(Date.parse(AT) + 1 + i).toISOString(), origin: "aix" as const, aix_type: "cost_breakdown", kind: p.kind, status: p.status, evidence: p.evidence })),
  ];
  const messages = [
    { sender: "customer", text: "南向きで5階以上希望です", createdAt: "2026-09-15T04:06:46.096Z", isAix: false, lineMessageId: null },
    { sender: "staff", text: YUKO_AIX, createdAt: AT, isAix: true, lineMessageId: null },
  ];
  const ledger = buildActionLedger({ recentAixRows: [], messages, lineTasks: [], lastAixHistory: null, lastCustomerAt: "2026-09-15T04:06:46.096Z", recordedFacts: facts });
  const r = resolveStaffPromiseAix(ledger.facts, messages);
  expect(r ? `${r.action}/${r.kind}` : "null").toBe("property_send/pickup");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
