// 「押した AIX と流れ」の文のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/aix-flow-note.test.ts
import { buildAixFlowNote, buildAixTransitionMap, STRATEGY_FLOW_LINE } from "../aix-flow-note";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const has = (s: string, sub: string) => { if (!s.includes(sub)) throw new Error(`expected to include「${sub}」\n${s}`); };
const hasNot = (s: string, sub: string) => { if (s.includes(sub)) throw new Error(`expected NOT to include「${sub}」\n${s}`); };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

// 2026-09-23 10:00 JST を「今」にする
const NOW = Date.parse("2026-09-23T01:00:00Z");
const map = buildAixTransitionMap([
  { from_aix_type: "property_check_result", to_aix_type: "viewing_invite", count: 12 },
  { from_aix_type: "property_check_result", to_aix_type: "estimate_sheet", count: 8 },
  { from_aix_type: "property_check_result", to_aix_type: "property_send", count: 11 },
  { from_aix_type: "property_check_result", to_aix_type: "application_push", count: 6 },
  { from_aix_type: "estimate_sheet", to_aix_type: "application_push", count: 13 },
]);
// 新→旧（brain-core の読み出し順）。実物の並び: 物件送付 → オススメ → 物件確認した（募集終了）
const logs = [
  { aix_type: "property_check_result", created_at: "2026-09-22T23:30:00Z", template_name: null, check_pattern: "unavailable" },
  { aix_type: "property_recommendation", created_at: "2026-09-22T05:00:00Z", template_name: "1件特にオススメ" },
  { aix_type: "property_send", created_at: "2026-09-22T04:50:00Z" },
  { aix_type: "property_send", created_at: "2026-09-20T04:50:00Z" },
];

describe("流れの文", () => {
  const n = buildAixFlowNote(logs, map, { nowMs: NOW });
  it("直近3件を新→旧で、結果と時刻・何時間前つきで並べる", () => {
    has(n.recentAixSeqText, "【直近AIXアクション（新→旧順）】最新:property_check_result(結果:unavailable)[9/23 08:30・2時間前]");
    has(n.recentAixSeqText, "2回前:property_recommendation(1件特にオススメ)");
    has(n.recentAixSeqText, "3回前:property_send");
  });
  it("使った種類は回数と最後の時刻つき（重複なし）", () => {
    eq(n.usedAixTypes, ["property_check_result", "property_recommendation", "property_send"]);
    has(n.text, "property_send×2回（最後 9/22 13:50・");
    has(n.text, "【会話全体で使用済みのAIXアクション（回数と最後に押した時刻）】");
  });
  it("成約実績の次打ちマップは直近 AIX から上位3件（count 順は渡した順のまま）", () => {
    has(n.text, "【成約実績・次打ちマップ】直近AIXが property_check_result の場合、成約会話ではviewing_inviteが12回・estimate_sheetが8回・property_sendが11回");
    has(n.text, "推奨候補");
  });
  it("自己ループ警告は property_check_result が2回以上連続の時だけ", () => {
    eq(n.pcrLoopWarning, "");
    const loop = buildAixFlowNote([logs[0], { ...logs[0], created_at: "2026-09-22T20:00:00Z" }, logs[1]], map, { nowMs: NOW });
    has(loop.pcrLoopWarning, "直近2回連続");
    has(loop.text, "自己ループ警告");
  });
  it("AIX が1つも無ければ空", () => {
    const e = buildAixFlowNote([], map, { nowMs: NOW });
    eq(e.text, ""); eq(e.recentAixSeqText, ""); eq(e.usedAixTypes, []);
  });
  it("待ちのルール（物件送付直後の反応待ちは aix:null）を消していない", () => has(n.text, "物件送付直後で顧客の反応がまだ無い場合は aix:null"));
});

describe("戦略の層に足す1行", () => {
  it("成約の典型順（黄金フロー）と同じ並びで、物件確認が『お客様が物件を持ってきたら』の位置にある", () => {
    has(STRATEGY_FLOW_LINE, "条件 → 物件送付 → オススメ →（お客様が物件を持ってきたら）募集状況の確認 → 見積書 → 内覧 → 待ち合わせ → 申込");
  });
  it("押した AIX・行動台帳を踏まえ、押した物を Step に書かない", () => {
    has(STRATEGY_FLOW_LINE, "【この会話で押した AIX】"); has(STRATEGY_FLOW_LINE, "【行動台帳】"); has(STRATEGY_FLOW_LINE, "もう一度書かず");
  });
  it("次打ちマップは推奨候補・先走らない（必須の形にしない）", () => {
    has(STRATEGY_FLOW_LINE, "推奨候補"); has(STRATEGY_FLOW_LINE, "先走らない"); hasNot(STRATEGY_FLOW_LINE, "必ず");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
