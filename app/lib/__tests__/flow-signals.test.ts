// 実行: npx tsx app/lib/__tests__/flow-signals.test.ts
import { detectFlowSignals, flowSignalsLine, flowDigest, flowSignalsOn } from "../flow-signals";
import { normalizeThreeLayer, normalizeMainPoint, threeLayerDigest } from "../brain-need";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const t = (h: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + h * 3_600_000).toISOString();
const m = (sender: string, text: string, h: number) => ({ sender, text, created_at: t(h) });

it("既定 off", () => { ok(!flowSignalsOn({})); ok(flowSignalsOn({ BRAIN_FLOW_SIGNALS: "on" })); });
it("同じ質問の繰り返し", () => {
  const f = detectFlowSignals({ messages: [m("customer", "初期費用はいくらくらいですか？", 10), m("staff", "はい", 2), m("customer", "初期費用はいくらくらいですか", 1)].reverse() });
  ok(f.kinds.includes("repeat_q"), JSON.stringify(f));
});
it("送った物件に触れない", () => {
  const f = detectFlowSignals({ messages: [m("staff", "物件です", 1), m("customer", "ありがとうございます", 2), m("customer", "別件で質問です", 3)],
    rooms: [{ name: "A", sentByUs: true, events: [{ kind: "sent", at: t(1) }] }] });
  ok(f.kinds.includes("sent_ignored"), JSON.stringify(f)); ok(!f.kinds.includes("sent_reacted"));
  const g = detectFlowSignals({ messages: [m("staff", "物件です", 1), m("customer", "Aいいですね", 2)], rooms: [{ name: "A", sentByUs: true, events: [{ kind: "sent", at: t(1) }, { kind: "customer_mentioned", at: t(2) }] }] });
  ok(g.kinds.includes("sent_reacted"), JSON.stringify(g));
});
it("間隔が遅く・短く・絵文字が消えた・相談相手", () => {
  const msgs = [] as ReturnType<typeof m>[];
  let h = 0;
  for (let i = 0; i < 8; i++) { msgs.push(m("staff", "ご連絡ありがとうございます", h)); h += 0.1; msgs.push(m("customer", "ありがとうございます😊とても良さそうなので前向きに考えています", h)); h += 1; }
  msgs.push(m("staff", "いかがでしょうか", h)); h += 30; msgs.push(m("customer", "はい", h)); h += 0.1;
  msgs.push(m("staff", "かしこまりました", h)); h += 0.1; msgs.push(m("customer", "彼氏と相談します", h)); h += 0.1;
  msgs.push(m("staff", "はい", h)); h += 0.1; msgs.push(m("customer", "了解", h));
  const f = detectFlowSignals({ messages: [...msgs].reverse() });
  ok(f.kinds.includes("shorter") && f.kinds.includes("emoji_gone") && f.kinds.includes("consult"), JSON.stringify(f));
  ok(flowSignalsLine(f).includes("相談相手の気配")); ok(!!flowDigest(f));
  const g = detectFlowSignals({ messages: [...msgs.slice(0, 18)].reverse() });
  ok(g.kinds.includes("slower"), JSON.stringify(g));
});
it("合図が無ければ空", () => { const f = detectFlowSignals({ messages: [m("customer", "よろしくお願いします", 1)] }); ok(f.kinds.length === 0 && flowSignalsLine(f) === "" && flowDigest(f) === null); });
it("3段と一番の要点", () => {
  const tl = normalizeThreeLayer({ surface: "初期費用15万くらいの物件", worry: "予算が足りるか不安", relief: "割引で収まる物件" });
  ok(tl?.worry === "予算が足りるか不安" && threeLayerDigest(tl) === "予算が足りるか不安");
  ok(normalizeThreeLayer({ surface: "", worry: "" }) === null);
  ok(normalizeMainPoint("空室確認結果の報告", ["本人確認書類送付の催促", "空室確認結果の報告"]) === "空室確認結果の報告");
  ok(normalizeMainPoint("空室確認", ["空室確認結果の報告"]) === "空室確認結果の報告");
  ok(normalizeMainPoint("創作の要点", ["空室確認結果の報告"]) === null); ok(normalizeMainPoint(null, []) === null);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
