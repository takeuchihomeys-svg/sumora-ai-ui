// 影の関所（app/lib/shadow-auto-gate.ts）と解禁の表（app/lib/shadow-unlock.ts）
// 実行: npx tsx app/lib/__tests__/shadow-auto-gate.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { shadowAutoGate, watchGroundText, finalCheckHasBlock, SHADOW_GATE_VERSION } from "../shadow-auto-gate";
import { shadowUnlockTable, confidenceCalibration, SHADOW_UNLOCK, type UnlockTurn } from "../shadow-unlock";
import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq(a: unknown, b: unknown, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`); }

// 本番の条件提示の番の形（名前は伏せた）
const DRAFT = "条件の方ありがとうございます😊！！\nご条件でお部屋の方ピックアップさせて頂きます！！\n少々お待ちくださいませ🌟";
const FC_HIGH = { ok: true, issues: [], confidence: { v: "dc", score: 100, band: "high", reasons: [] } };
const base = { draft: DRAFT, draftSrc: "last", convStatus: "hearing", brainReplyMode: "text", brainAction: null, finalCheck: FC_HIGH, groundText: "大国町 7万円まで", env: {} };

console.log("影の関所");
it("材料がそろった返信の番は送っていた（would_send）・文が残る", () => {
  const g = shadowAutoGate(base);
  eq(g.would_send, true); eq(g.reason, "ok"); eq(g.v, SHADOW_GATE_VERSION);
  eq(g.text?.includes("ピックアップ"), true);
  eq(g.confidence, { score: 100, band: "high" });
  eq(g.missing.includes("ground_extra"), true, "本文の外の材料は足していない印");
});
it("ブレインが AIX を指した番は送らない（aix_suggested）・AIX の関所も残す", () => {
  const g = shadowAutoGate({ ...base, brainAction: "property_check_result" });
  eq(g.would_send, false); eq(g.reason, "aix_suggested");
  eq(g.aix, { action: "property_check_result", ok: false, reason: "staff_confirm:property_check_result" });
});
it("返信モードが aix の番は送らない", () => { eq(shadowAutoGate({ ...base, brainReplyMode: "aix" }).reason, "aix_mode"); });
it("最終チェックの block は送らない", () => {
  const g = shadowAutoGate({ ...base, finalCheck: { ok: true, issues: [{ code: "X", severity: "block" }] } });
  eq(g.reason, "final_check_block");
});
it("自信が低い番は送らない（DRAFT_CONFIDENCE 既定 on）・off なら当てない", () => {
  const fc = { ok: true, issues: [], confidence: { score: 40, band: "low", reasons: [] } };
  eq(shadowAutoGate({ ...base, finalCheck: fc }).reason, "low_confidence");
  eq(shadowAutoGate({ ...base, finalCheck: fc, env: { DRAFT_CONFIDENCE: "off" } }).would_send, true);
});
it("申込以降の番（番の時点）は送らない（影で足す線）", () => { eq(shadowAutoGate({ ...base, postApply: true }).lines[0], "post_apply"); });
it("この番の下書きでない（stale）は送らない", () => { eq(shadowAutoGate({ ...base, draftSrc: "stale" }).reason, "draft_not_for_turn"); });
it("根拠を読めなかった番は送らない（fail-closed）", () => { eq(shadowAutoGate({ ...base, groundText: null }).lines.includes("ground_unread"), true); });
it("会話に無い金額の言い切りは止まる・会話にあれば通る", () => {
  const d = "ご予算ですと家賃6.5万円程のお部屋が多くなります😊！！";
  eq(shadowAutoGate({ ...base, draft: d, groundText: "梅田 家賃7万" }).would_send, false);
  eq(shadowAutoGate({ ...base, draft: d, groundText: "梅田 家賃6.5万円まで" }).would_send, true);
});
it("合図 [AIX誘導中] が下書きより後なら止める・前なら下書きを見る・時刻不明は止める", () => {
  eq(shadowAutoGate({ ...base, sentinel: "[AIX誘導中]", sentinelAt: "2026-11-10T10:05:00Z", draftAt: "2026-11-10T10:00:00Z" }).reason, "sentinel_draft");
  eq(shadowAutoGate({ ...base, sentinel: "[AIX誘導中]", sentinelAt: "2026-11-10T09:55:00Z", draftAt: "2026-11-10T10:00:00Z" }).would_send, true);
  eq(shadowAutoGate({ ...base, sentinel: "[AIX誘導中]" }).reason, "sentinel_draft");
});
it("最終チェックの控えが無い下書きは止める（影で足す線）", () => { eq(shadowAutoGate({ ...base, finalCheck: null }).lines.includes("no_final_check"), true); });
it("下書きが無い番は no_draft", () => { eq(shadowAutoGate({ ...base, draft: null }).reason, "no_draft"); });
it("読むべき範囲の外の行為・申込フォーマットは予約の前の網で止まる", () => {
  eq(shadowAutoGate({ ...base, outOfTopicActs: ["pickup"] }).lines.includes("ack_topic_out_of_scope"), true);
  eq(shadowAutoGate({ ...base, draft: `${DRAFT}\n【お申込者様記入欄】` }).lines.includes("application_format_in_draft"), true);
});
it("影は本物の auto_send_enabled を見ない（入力に無い）・送信の関数を import しない", () => {
  const src = readFileSync(path.join(__dirname, "..", "shadow-auto-gate.ts"), "utf8");
  eq(/scheduled_messages|send-scheduled|pushMessage|supabase/.test(src.replace(/\/\/.*$/gm, "")), false, "送信・DB に触れる語");
});
it("finalCheckHasBlock は ok=false も block", () => { eq(finalCheckHasBlock({ ok: false, issues: [] }), true); eq(finalCheckHasBlock({ ok: true, issues: [{ severity: "warning" }] }), false); });
it("根拠の文は番の最後のお客様の発言までの通だけ（後のスタッフの返事を入れない）", () => {
  const g = watchGroundText([{ created_at: "2026-11-10T10:00:00Z", text: "7万まで" }, { created_at: "2026-11-10T10:30:00Z", text: "6.5万円の物件です" }], "2026-11-10T10:00:00Z", { rent_max: 70000 });
  eq(g.includes("7万まで"), true); eq(g.includes("6.5万円"), false); eq(g.includes("70000円"), true);
});

console.log("解禁の表");
const mk = (n: number, o: Partial<UnlockTurn> & { sim?: number; send?: boolean; band?: string }): UnlockTurn[] => Array.from({ length: n }, () => ({
  scene_key: o.scene_key ?? "返信:条件提示", verdict: o.verdict ?? "same",
  verdict_detail: { sim: o.sim ?? 1, path: "返信" }, auto_eligible: { would_send: o.send ?? true, confidence: { band: o.band ?? "high" } },
}));
it("50番・95% 以上で reached・25番 85% で near", () => {
  const rows = shadowUnlockTable([...mk(49, {}), ...mk(1, { sim: 1 }), ...mk(2, { verdict: "partial", sim: 0.5 })]);
  const r = rows[0];
  eq(r.shadowN, 52); eq(r.shadowAsIs, 50); eq(r.reached, true);
  const near = shadowUnlockTable([...mk(26, { scene_key: "s" }), ...mk(3, { scene_key: "s", verdict: "partial", sim: 0.4 })])[0];
  eq(near.reached, false); eq(near.near, true);
});
it("影が送らなかった番は shadowN に入れない・na は数えない", () => {
  const r = shadowUnlockTable([...mk(3, { send: false }), { scene_key: "返信:条件提示", verdict: "na", verdict_detail: null }])[0];
  eq(r.n, 3); eq(r.shadowN, 0); eq(r.remaining.includes(`あと ${SHADOW_UNLOCK.minN}番`), true);
});
it("自信の段ごとの当たり（高・中・低の順）", () => {
  const c = confidenceCalibration([...mk(4, { band: "low", verdict: "different", sim: 0.2 }), ...mk(4, { band: "high" })]);
  eq(c.map((x) => x.band), ["high", "low"]); eq(c[0].matchRate, 1); eq(c[1].matchRate, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
