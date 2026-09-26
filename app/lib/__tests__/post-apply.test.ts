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

const T = (d: string) => new Date(d).toISOString();

async function main() {
  await describe("従来の線（status）はそのまま", async () => {
    await it("DRAFT_SKIP_STATUSES の全部が申込以降（申込・審査中は必ず Claude）", () => {
      for (const s of DRAFT_SKIP_STATUSES) eq(resolvePostApply({ status: s }).reason, "status", s);
    });
    await it("申込前の status で記録も無ければ申込以降ではない", () => {
      for (const s of ["proposing", "property_recommendation", "viewing", "hearing", "first_reply", "", null, undefined]) eq(isPostApplyConversation({ status: s }), false, String(s));
    });
  });

  await describe("新しい根拠（記録から引ける・status の昇格を待たない）", async () => {
    // 実物: status=proposing のまま申込へを押し、DeepSeek で返信を作っていた会話（2026-09-23 監査・6会話37回）
    await it("AIX【申込へ】を押した会話は status が proposing でも申込以降", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushAt: T("2026-09-20T10:00:00+09:00") }), { postApply: true, reason: "application_push", movedBack: false }));
    await it("本人確認書類が届いた会話は申込へを押していなくても申込以降", () =>
      eq(resolvePostApply({ status: "property_recommendation", idDocumentAt: T("2026-09-20T10:00:00+09:00") }).reason, "id_document"));
    await it("スタッフの印（is_post_apply）も申込以降", () =>
      eq(resolvePostApply({ status: "viewing", isPostApply: true }).reason, "badge"));
    await it("理由は 新しい方の記録（押下と書類の遅い方）", () => {
      eq(resolvePostApply({ status: "viewing", applicationPushAt: T("2026-09-20T10:00:00+09:00"), idDocumentAt: T("2026-09-21T10:00:00+09:00") }).reason, "id_document");
      eq(resolvePostApply({ status: "viewing", applicationPushAt: T("2026-09-22T10:00:00+09:00"), idDocumentAt: T("2026-09-21T10:00:00+09:00") }).reason, "application_push");
    });
  });

  // 2026-09-23 竹内「一度申込にした人でも審査が否決となって再度物件提案中にもどる場合もあるから、その場合は渡してよい」
  await describe("否決→物件提案中に戻したら、また渡してよい（時間順）", async () => {
    // 実物: 9/11 に申込へ → 9/16 にスタッフが物件提案中へ戻した（status_manual_back_at）会話（62d01e33…）
    await it("最後の申込へ押下より後に戻していれば申込前（movedBack）", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushAt: T("2026-09-11T12:00:00+09:00"), statusManualBackAt: T("2026-09-16T09:00:00+09:00") }), { postApply: false, reason: null, movedBack: true }));
    await it("本人確認書類の後に戻した場合も同じ", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushAt: T("2026-08-27T12:00:00+09:00"), idDocumentAt: T("2026-08-27T13:00:00+09:00"), statusManualBackAt: T("2026-09-15T09:00:00+09:00") }).postApply, false));
    await it("戻した後にまた申込へを押せば、また申込以降", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushAt: T("2026-09-18T12:00:00+09:00"), statusManualBackAt: T("2026-09-16T09:00:00+09:00") }).reason, "application_push"));
    await it("戻しより前の申込の記録しか無くても、status が申込・審査中なら Claude（status が勝つ）", () =>
      eq(resolvePostApply({ status: "screening", applicationPushAt: T("2026-09-11T12:00:00+09:00"), statusManualBackAt: T("2026-09-16T09:00:00+09:00") }).reason, "status"));
    await it("戻しがあっても印（is_post_apply）が付いていれば申込以降（スタッフの意思が正）", () =>
      eq(resolvePostApply({ status: "proposing", isPostApply: true, applicationPushAt: T("2026-08-21T12:00:00+09:00"), statusManualBackAt: T("2026-09-18T09:00:00+09:00") }).reason, "badge"));
    await it("同じ時刻なら記録の側（申込以降）に倒す", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushAt: T("2026-09-22T12:00:00+09:00"), statusManualBackAt: T("2026-09-22T12:00:00+09:00") }).postApply, true));
    await it("壊れた時刻文字列は無いものとして扱う", () =>
      eq(resolvePostApply({ status: "proposing", applicationPushAt: "not-a-date", statusManualBackAt: "x" }).postApply, false));
  });

  await describe("記録の読み方（loadPostApplyFacts）", async () => {
    const fake = (opts: { status?: string; badge?: boolean; back?: string | null; push?: string | null; idDoc?: string | null; failTable?: string }) => ({
      from: (table: string) => {
        const res = (payload: unknown) => (table === opts.failTable ? { data: null, error: { message: "boom" } } : { data: payload, error: null });
        const chain: Record<string, unknown> = {};
        chain.select = () => chain; chain.eq = () => chain; chain.in = () => chain; chain.order = () => chain;
        chain.maybeSingle = async () => res({ status: opts.status ?? "proposing", is_post_apply: !!opts.badge, status_manual_back_at: opts.back ?? null, deepseek_cutoff_at: null });
        chain.limit = async () => res(table === "aix_usage_logs" ? (opts.push ? [{ created_at: opts.push }] : []) : (opts.idDoc ? [{ created_at: opts.idDoc }] : []));
        return chain;
      },
    });
    await it("3つの記録を1つの facts にまとめる（最後の時刻だけ）", async () => {
      const f = await loadPostApplyFacts(fake({ status: "proposing", push: "2026-09-20T01:00:00.000Z", back: "2026-09-16T00:00:00.000Z" }), "c1");
      eq(f, { status: "proposing", isPostApply: false, applicationPushAt: "2026-09-20T01:00:00.000Z", idDocumentAt: null, statusManualBackAt: "2026-09-16T00:00:00.000Z", deepseekCutoffAt: null });
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
