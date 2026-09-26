// 「DeepSeek に渡してよい時刻の線」（deepseekSafeCutoff と周りの純関数）のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/post-apply-cutoff.test.ts
// 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げる」
import {
  deepseekSafeCutoff, resolvePostApply, NO_CUTOFF, cutoffMs, isAfterCutoff, filterAfterCutoff,
  cutoffMarkOf, formatCutoffMark, parseCutoffMark, preCutoffChunks, countCutoffLeaks, loadDeepseekCutoff,
} from "../post-apply";
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
  await describe("deepseekSafeCutoff: 申込中は null（渡さない）", async () => {
    await it("申込以降の status は全部 null（線があっても）", () => {
      for (const s of DRAFT_SKIP_STATUSES) eq(deepseekSafeCutoff({ status: s, deepseekCutoffAt: T("2026-09-01T00:00:00Z") }), null, s);
    });
    await it("スタッフの申込以降の印は null", () => eq(deepseekSafeCutoff({ status: "proposing", isPostApply: true }), null));
    await it("申込へ押下の後に戻していなければ null", () =>
      eq(deepseekSafeCutoff({ status: "proposing", applicationPushAt: T("2026-09-20T10:00:00+09:00") }), null));
    await it("収入証明書・本人確認書類が届いた後に戻していなければ null", () =>
      eq(deepseekSafeCutoff({ status: "viewing", idDocumentAt: T("2026-09-20T10:00:00+09:00") }), null));
    await it("戻した後にまた申込へを押したら null（線より記録が新しい）", () =>
      eq(deepseekSafeCutoff({ status: "proposing", applicationPushAt: T("2026-09-25T10:00:00+09:00"), deepseekCutoffAt: T("2026-09-22T10:00:00+09:00") }), null));
    await it("記録と切り替えが同時刻は申込中（記録が先）", () =>
      eq(deepseekSafeCutoff({ status: "proposing", applicationPushAt: T("2026-09-22T10:00:00+09:00"), deepseekCutoffAt: T("2026-09-22T10:00:00+09:00") }), null));
    await it("書いてある時刻が読めなければ null（fail-closed）", () => {
      eq(deepseekSafeCutoff({ status: "proposing", deepseekCutoffAt: "not-a-date" }), null);
      eq(deepseekSafeCutoff({ status: "proposing", applicationPushAt: "x", statusManualBackAt: T("2026-09-22T10:00:00Z") }), null);
    });
  });

  await describe("deepseekSafeCutoff: 戻したら切り替えた時刻より後だけ", async () => {
    // 実物の形: 9/11 に申込へ → 9/16 に物件提案中へ戻した（否決）→ その後に内覧へ進めて戻しの印が消えた会話
    await it("切り替えた時刻（消えない列）が線。戻しの印が前進で消えていても線は残る", () =>
      eq(deepseekSafeCutoff({ status: "viewing", applicationPushAt: T("2026-09-11T12:00:00+09:00"), statusManualBackAt: null, deepseekCutoffAt: T("2026-09-16T09:00:00+09:00") }), T("2026-09-16T09:00:00+09:00")));
    await it("旧の会話（切り替えた時刻なし）は戻しの印を線にする", () =>
      eq(deepseekSafeCutoff({ status: "proposing", applicationPushAt: T("2026-09-11T12:00:00+09:00"), statusManualBackAt: T("2026-09-16T09:00:00+09:00") }), T("2026-09-16T09:00:00+09:00")));
    await it("切り替えた時刻を戻しの印より優先する（後の戻しは申込と関係ない段階の戻しのことがある）", () =>
      eq(deepseekSafeCutoff({ status: "proposing", applicationPushAt: T("2026-09-11T12:00:00+09:00"), deepseekCutoffAt: T("2026-09-16T09:00:00+09:00"), statusManualBackAt: T("2026-09-20T09:00:00+09:00") }), T("2026-09-16T09:00:00+09:00")));
    await it("押下・書類の記録は無いが status が申込以降だった所から戻した（同期で審査中になっていた等）→ 線", () =>
      eq(deepseekSafeCutoff({ status: "proposing", deepseekCutoffAt: T("2026-09-18T09:00:00+09:00") }), T("2026-09-18T09:00:00+09:00")));
    await it("戻した後の判定は resolvePostApply と食い違わない（null ⇔ 申込以降）", () => {
      const cases = [
        { status: "viewing", applicationPushAt: T("2026-09-11T12:00:00Z"), deepseekCutoffAt: T("2026-09-16T00:00:00Z") },
        { status: "proposing", applicationPushAt: T("2026-09-18T12:00:00Z"), deepseekCutoffAt: T("2026-09-16T00:00:00Z") },
        { status: "screening", deepseekCutoffAt: T("2026-09-16T00:00:00Z") },
        { status: "proposing" },
      ];
      for (const c of cases) eq(deepseekSafeCutoff(c) === null, resolvePostApply(c).postApply, JSON.stringify(c));
    });
  });

  await describe("deepseekSafeCutoff: 申込の記録なし → 全部（-Infinity）", async () => {
    await it("記録も切り替えも無い会話", () => eq(deepseekSafeCutoff({ status: "proposing" }) === NO_CUTOFF, true));
    await it("申込と関係ない戻し（内覧→物件提案中）だけの会話も全部", () =>
      eq(deepseekSafeCutoff({ status: "proposing", statusManualBackAt: T("2026-09-16T09:00:00Z") }) === NO_CUTOFF, true));
  });

  await describe("線で切る（isAfterCutoff / filterAfterCutoff）", async () => {
    const line = T("2026-09-16T00:00:00Z");
    await it("線より後だけ残り、線ちょうど・前・時刻なし・読めない時刻は落ちる", () => {
      const msgs = [
        { t: "2026-09-10T00:00:00Z", x: "申込中" }, { t: line, x: "線ちょうど" }, { t: "2026-09-16T00:00:01Z", x: "後1" },
        { t: null, x: "時刻なし" }, { t: "bad", x: "読めない" }, { t: "2026-09-20T00:00:00Z", x: "後2" },
      ];
      eq(filterAfterCutoff(msgs, (m) => m.t, line).map((m) => m.x), ["後1", "後2"]);
    });
    await it("-Infinity は全部残す（時刻なしも）", () => eq(filterAfterCutoff([{ t: null }, { t: "x" }], (m) => m.t, NO_CUTOFF).length, 2));
    await it("null（申込中）は何も残さない", () => eq(filterAfterCutoff([{ t: "2030-01-01T00:00:00Z" }], (m) => m.t, null).length, 0));
    await it("cutoffMs の3つの形", () => { eq(cutoffMs(null), null); eq(cutoffMs(NO_CUTOFF) === NO_CUTOFF, true); eq(cutoffMs(line), Date.parse(line)); eq(cutoffMs(5), null); });
    await it("isAfterCutoff は線が null なら常に false", () => eq(isAfterCutoff("2030-01-01T00:00:00Z", null), false));
  });

  await describe("出口の印（二重の鍵）", async () => {
    await it("線 → 印 → ヘッダの値 → 印 が往復する", () => {
      for (const c of [null, NO_CUTOFF, T("2026-09-16T00:00:00Z")]) {
        const m = cutoffMarkOf(c);
        eq(parseCutoffMark(formatCutoffMark(m)), m, String(c));
      }
    });
    await it("印の種類", () => {
      eq(cutoffMarkOf(null).kind, "blocked"); eq(cutoffMarkOf(NO_CUTOFF).kind, "all"); eq(cutoffMarkOf(T("2026-09-16T00:00:00Z")).kind, "cut");
    });
    await it("値が無ければ null（印なし）・知らない値や読めない時刻は blocked", () => {
      eq(parseCutoffMark(null), null); eq(parseCutoffMark(""), null);
      eq(parseCutoffMark("yes"), { kind: "blocked" }); eq(parseCutoffMark("cut:bad"), { kind: "blocked" });
    });
  });

  await describe("出口の網（線より前のお客様の発言の断片）", async () => {
    // 実物の形（申込フォームの記入・否決の連絡の返事）。本文は作った例（個人情報なし）
    const before = [
      "お世話になります。勤務先は大阪市内の株式会社サンプルで、勤続三年です。年収は四百万円ほどです",
      "[画像] 収入証明書（給与明細）",
      "はい",
      "よろしくお願いします",
    ];
    const chunks = preCutoffChunks(before);
    await it("短い定型（はい・よろしくお願いします）と書類の種類だけの行は断片にしない", () => {
      eq(chunks.some((c) => c.includes("よろしくお願いします") && c.length < 20), false);
      eq(chunks.some((c) => c.includes("収入証明書")), false);
    });
    await it("線より前の文が本文に入っていれば数える（空白・改行が変わっても）", () => {
      const body = "【会話履歴】\nお客様: 勤務先は大阪市内の株式会社サンプルで、 勤続三年です\nスタッフ: 承知しました";
      eq(countCutoffLeaks(body, chunks) >= 1, true);
    });
    await it("線より後だけの本文なら0", () => eq(countCutoffLeaks("お客様: 別の物件も見てみたいです。駅から近いところがいいです", chunks), 0));
    await it("断片が無ければ0", () => eq(countCutoffLeaks("なんでも", []), 0));
  });

  await describe("記録から引く（loadDeepseekCutoff）", async () => {
    const fake = (conv: Record<string, unknown> | null, fail = false) => ({
      from: (table: string) => {
        const res = (payload: unknown) => (fail ? { data: null, error: { message: "boom" } } : { data: payload, error: null });
        const chain: Record<string, unknown> = {};
        chain.select = () => chain; chain.eq = () => chain; chain.in = () => chain; chain.order = () => chain; chain.lte = () => chain;
        chain.maybeSingle = async () => res(conv);
        chain.limit = async () => res(table === "aix_usage_logs" ? [{ created_at: "2026-09-11T03:00:00.000Z" }] : []);
        return chain;
      },
    });
    await it("会話が無い呼び出しは -Infinity（申込の記録が無い）", async () => eq((await loadDeepseekCutoff(fake(null), null)) === NO_CUTOFF, true));
    await it("読めなければ null（渡さない）", async () => eq(await loadDeepseekCutoff(fake(null, true), "c1"), null));
    await it("切り替えた時刻の列を読む", async () =>
      eq(await loadDeepseekCutoff(fake({ status: "viewing", is_post_apply: false, status_manual_back_at: null, deepseek_cutoff_at: "2026-09-16T00:00:00.000Z" }), "c1"), "2026-09-16T00:00:00.000Z"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
}
main();
