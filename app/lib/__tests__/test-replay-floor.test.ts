// YUMA の再生テストの「場面より前の記録を読まない線」（app/lib/test-replay-floor.ts）と AIX の自動反映の度合い（app/lib/aix-autofill-readiness.ts）
// 実行: npx tsx app/lib/__tests__/test-replay-floor.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { rewriteRestUrl, isConversationRowRead, blankConversationRow, currentReplayFloor, TABLE_TIME_COLUMN } from "../test-replay-floor";
import { classifyAixAutofill } from "../aix-autofill-readiness";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }

const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const OTHER = "8a77820b-0000-0000-0000-000000000000";
const F = { conversationId: YUMA, floor: "2026-10-01T12:00:00.000Z" };
const base = "https://x.supabase.co/rest/v1";

console.log("rewriteRestUrl（線より前の行を外す）");
it("YUMA の messages の GET に created_at=gte を足す（他の条件はそのまま）", () => {
  const u = rewriteRestUrl(`${base}/messages?select=sender%2Ctext&conversation_id=eq.${YUMA}&order=created_at.desc&limit=30`, "GET", F);
  const p = new URL(u).searchParams;
  eq(p.getAll("created_at"), [`gte.${F.floor}`]);
  eq(p.get("limit"), "30");
});
it("messages は場面の通（line_message_id の頭）だけ読める（他の担当が同時に入れた通を混ぜない）", () => {
  const url = rewriteRestUrl(`${base}/messages?conversation_id=eq.${YUMA}`, "GET", { ...F, messageIdPrefix: "replay-" });
  eq(new URL(url).searchParams.get("line_message_id"), "like.replay-*");
  eq(new URL(rewriteRestUrl(`${base}/aix_usage_logs?conversation_id=eq.${YUMA}`, "GET", { ...F, messageIdPrefix: "replay-" })).searchParams.get("line_message_id"), null);
});
it("sent_properties は sent_at で切る", () => {
  eq(new URL(rewriteRestUrl(`${base}/sent_properties?conversation_id=eq.${YUMA}`, "GET", F)).searchParams.get("sent_at"), `gte.${F.floor}`);
});
it("送った物件の or（会話＋お客様）でも切る・他の会話を含む or は触らない", () => {
  const u = rewriteRestUrl(`${base}/sent_properties?select=*&or=(conversation_id.eq.${YUMA})&or=(source.is.null,source.neq.line_group)`, "GET", F);
  eq(new URL(u).searchParams.get("sent_at"), `gte.${F.floor}`);
  const u2 = `${base}/sent_properties?or=(conversation_id.eq.${YUMA},conversation_id.eq.${OTHER})`;
  eq(rewriteRestUrl(u2, "GET", F), u2);
});
it("本物の会話は触らない", () => {
  const url = `${base}/messages?conversation_id=eq.${OTHER}`;
  eq(rewriteRestUrl(url, "GET", F), url);
});
it("複数の会話を引く問い合わせ（in.(…)に他の会話）は触らない", () => {
  const url = `${base}/messages?conversation_id=in.(${YUMA},${OTHER})`;
  eq(rewriteRestUrl(url, "GET", F), url);
});
it("書き込み（POST/PATCH/DELETE）は触らない", () => {
  const url = `${base}/messages?conversation_id=eq.${YUMA}`;
  eq(rewriteRestUrl(url, "POST", F), url);
  eq(rewriteRestUrl(url, "DELETE", F), url);
  eq(rewriteRestUrl(url, "PATCH", F), url);
});
it("線が無ければ触らない・表の一覧に無い表も触らない", () => {
  const url = `${base}/messages?conversation_id=eq.${YUMA}`;
  eq(rewriteRestUrl(url, "GET", null), url);
  const u2 = `${base}/llm_usage_logs?conversation_id=eq.${YUMA}`;
  eq(rewriteRestUrl(u2, "GET", F), u2);
  eq("llm_usage_logs" in TABLE_TIME_COLUMN, false);
});

console.log("conversations の行");
it("id=eq.YUMA の GET だけ空にする対象", () => {
  eq(isConversationRowRead(`${base}/conversations?select=*&id=eq.${YUMA}`, "GET", F), true);
  eq(isConversationRowRead(`${base}/conversations?select=*&id=eq.${OTHER}`, "GET", F), false);
  eq(isConversationRowRead(`${base}/conversations?id=eq.${YUMA}`, "PATCH", F), false);
});
it("過去の判断・戦略・紐付けを空にし、状態は場面の物", () => {
  const out = blankConversationRow([{ id: YUMA, status: "viewing", brain_strategy: { a: 1 }, property_customer_id: "509c", has_viewed: true, customer_name: "YUMA" }], "hearing") as Array<Record<string, unknown>>;
  eq(out[0].status, "hearing");
  eq(out[0].brain_strategy, null);
  eq(out[0].property_customer_id, null);
  eq(out[0].has_viewed, false);
  eq(out[0].customer_name, "YUMA");
});

console.log("currentReplayFloor（動く条件）");
it("ファイルが無い・本番・テスト用でない会話は null", () => {
  const dir = mkdtempSync(join(tmpdir(), "floor-"));
  const file = join(dir, "f.json");
  writeFileSync(file, JSON.stringify({ conversationId: OTHER, floor: F.floor }));
  eq(currentReplayFloor({ REPLAY_FLOOR_FILE: file }), null);
});
it("本番（VERCEL）では読まない", () => {
  eq(currentReplayFloor({ REPLAY_FLOOR_FILE: "x.json", VERCEL: "1" }), null);
});

console.log("classifyAixAutofill（AIX を入力なしで作れるか）");
it("申込へ・ヒアリング・電話は会話だけで作れる", () => {
  for (const a of ["application_push", "condition_hearing", "phone_call"]) eq(classifyAixAutofill({ action: a, customerText: "" }).level, "auto");
});
it("内覧調整はお客様の希望日を読んで候補にする（実物「明日の土曜日内覧可能でしょうか！13時以降だと助かります」）", () => {
  const r = classifyAixAutofill({ action: "viewing_invite", customerText: "明日の土曜日内覧可能でしょうか！\n13時以降だと助かります", nowMs: Date.parse("2026-10-02T01:00:00Z") });
  eq(r.level, "auto_calendar");
  eq(typeof (r.request as Record<string, unknown>).viewing_requested_dates, "string");
});
it("物件確認した は確認の結果が要る・物件名が決まらなければそれも", () => {
  const r = classifyAixAutofill({ action: "property_check_result", customerText: "こちら３階は空きありますか？" });
  eq(r.level, "staff_confirm");
  eq(r.blockers.length, 2);
});
it("待ち合わせ場所は住所の材料が要る（日時はお客様の発言から読める）", () => {
  const r = classifyAixAutofill({ action: "meeting_place", customerText: "10/4の13時半でお願いします!", propertyName: "ジーメゾン石津町東アビテ 0201号室", nowMs: Date.parse("2026-10-01T01:00:00Z") });
  eq(r.level, "needs_material");
  eq(r.blockers, ["待ち合わせの住所（番地まで・資料から）"]);
  eq(Object.keys(r.prefilled).sort(), ["日時", "物件名"]);
});
it("待ち合わせ場所: 「5日の15時〜」（月なし）と直前の内覧調整の文の物件名を読む（本番 84434172 9/29）", () => {
  const r = classifyAixAutofill({ action: "meeting_place", customerText: "5日の15時〜でお願いします！", staffTexts: ["かしこまりました！！\nアンリュウソウ 203号室ご案内させていただきます😊！！\n直近ですと\n10/5(月) 12:00〜16:00"], nowMs: Date.parse("2026-10-01T01:00:00Z") });
  eq(r.blockers, ["待ち合わせの住所（番地まで・資料から）"]);
  eq(r.prefilled["物件名"].startsWith("アンリュウソウ 203号室"), true);
  eq(/15:00/.test(r.prefilled["日時"]), true);
});
it("見積書・物件の送付は材料が要る", () => {
  eq(classifyAixAutofill({ action: "estimate_sheet", customerText: "" }).level, "needs_material");
  eq(classifyAixAutofill({ action: "property_recommendation", customerText: "" }).request, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
