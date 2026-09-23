// 「申込以降の会話か」の判定のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/post-apply.test.ts
import { resolvePostApply, isPostApplyConversation, loadPostApplyFacts } from "../post-apply";
import { DRAFT_SKIP_STATUSES } from "../conversation-status";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void | Promise<void>) { current = name; return fn(); }
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

async function main() {
  await describe("従来の線（status）はそのまま", async () => {
    await it("DRAFT_SKIP_STATUSES の全部が申込以降", () => {
      for (const s of DRAFT_SKIP_STATUSES) eq(resolvePostApply({ status: s }), { postApply: true, reason: "status" }, s);
    });
    await it("申込前の status だけなら申込以降ではない", () => {
      for (const s of ["proposing", "property_recommendation", "viewing", "hearing", "first_reply", "", null, undefined]) eq(isPostApplyConversation({ status: s }), false, String(s));
    });
  });

  await describe("新しい根拠（記録から引ける・status の昇格を待たない）", async () => {
    // 実物: status=proposing のまま本人確認書類を受け取り、DeepSeek で返信を作っていた会話（2026-09-23 監査・7会話38回）
    await it("AIX【申込へ】を押した会話は status が proposing でも申込以降", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushPressed: true }), { postApply: true, reason: "application_push" }));
    await it("本人確認書類が届いた会話は申込へを押していなくても申込以降", () =>
      eq(resolvePostApply({ status: "property_recommendation", applicationPushPressed: false, idDocumentReceived: true }), { postApply: true, reason: "id_document" }));
    await it("スタッフの印（is_post_apply）も申込以降", () =>
      eq(resolvePostApply({ status: "viewing", isPostApply: true }), { postApply: true, reason: "badge" }));
    await it("理由の優先は status → 印 → 申込へ → 本人確認書類", () => {
      eq(resolvePostApply({ status: "applying", isPostApply: true, applicationPushPressed: true, idDocumentReceived: true }).reason, "status");
      eq(resolvePostApply({ status: "viewing", isPostApply: true, applicationPushPressed: true }).reason, "badge");
      eq(resolvePostApply({ status: "viewing", applicationPushPressed: true, idDocumentReceived: true }).reason, "application_push");
    });
    await it("根拠が無い（undefined/null/false）なら申込前のまま", () =>
      eq(isPostApplyConversation({ status: "proposing", isPostApply: null, applicationPushPressed: null, idDocumentReceived: false }), false));
  });

  await describe("記録の読み方（loadPostApplyFacts）", async () => {
    const fake = (opts: { status?: string; badge?: boolean; push?: number; idDoc?: number; failTable?: string }) => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => table === opts.failTable ? { data: null, error: { message: "boom" } } : { data: { status: opts.status ?? "proposing", is_post_apply: !!opts.badge }, error: null },
            eq: () => ({
              limit: async () => table === opts.failTable
                ? { data: null, error: { message: "boom" } }
                : { data: new Array(table === "aix_usage_logs" ? (opts.push ?? 0) : (opts.idDoc ?? 0)).fill({ id: "x" }), error: null },
            }),
          }),
        }),
      }),
    });
    await it("3つの記録を1つの facts にまとめる", async () => {
      const f = await loadPostApplyFacts(fake({ status: "proposing", push: 1, idDoc: 0 }), "c1");
      eq(f, { status: "proposing", isPostApply: false, applicationPushPressed: true, idDocumentReceived: false });
      eq(resolvePostApply(f).reason, "application_push");
    });
    await it("どれか1つでも読めなければ例外（呼び出し側が fail-closed にできる）", async () => {
      for (const t of ["conversations", "aix_usage_logs", "messages"]) {
        let threw = false;
        try { await loadPostApplyFacts(fake({ failTable: t }), "c1"); } catch { threw = true; }
        eq(threw, true, t);
      }
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
}
main();
