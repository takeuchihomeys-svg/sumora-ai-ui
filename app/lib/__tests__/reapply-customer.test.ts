// 申込歴あり（再探し）・戻った理由・戻った会話の DeepSeek の線と強めの網のテスト（自己完結ハーネス・LLM なし・本物のお客様の文は使わない）
// 実行: npx tsx app/lib/__tests__/reapply-customer.test.ts
import { resolveReapply, detectReturnPattern, staffPatternOf, reapplyMemoText, buildReapplyBrainNote, reapplyBadgeText, REAPPLY_MEMO_ID, RETURN_PATTERNS } from "../reapply-customer";
import { deepseekPostApply, deepseekSafeCutoff, postApplyDraftSkip, resolvePostApply, filterAfterCutoff } from "../post-apply";
import { altPiiSignalReapply, altPiiSignalReapplyValues, altPiiSignal } from "../alt-pii-gate";
import { buildStaffTodoList, REAPPLY_HEADER_MARK, type TodoInput } from "../staff-todo-list";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void | Promise<void>) { current = name; return fn(); }
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const T = (d: string) => new Date(d).toISOString();
const ON = { REAPPLY_DEEPSEEK: "on" }, OFF = { REAPPLY_DEEPSEEK: "off" };

async function main() {
  await describe("申込歴あり（resolveReapply）", async () => {
    await it("申込へ押下 → 後で戻した＝申込歴あり（戻した時刻・最後の申込の記録）", () => {
      eq(resolveReapply({ status: "proposing", applicationPushAt: T("2026-10-01T10:00:00Z"), statusManualBackAt: T("2026-10-05T10:00:00Z") }),
        { reapply: true, returnedAt: T("2026-10-05T10:00:00Z"), lastApplyAt: T("2026-10-01T10:00:00Z") });
    });
    await it("本人確認書類・記入済みフォームも申込の記録", () => {
      eq(resolveReapply({ status: "viewing", idDocumentAt: T("2026-10-01T10:00:00Z"), deepseekCutoffAt: T("2026-10-03T00:00:00Z") }).reapply, true);
      eq(resolveReapply({ status: "viewing", applicationFormAt: T("2026-10-01T10:00:00Z"), statusManualBackAt: T("2026-10-03T00:00:00Z") }).reapply, true);
    });
    await it("戻した後にまた申込へ（記録が新しい）＝申込中（申込歴ありの札は出さない）", () => {
      eq(resolveReapply({ status: "proposing", applicationPushAt: T("2026-10-06T10:00:00Z"), statusManualBackAt: T("2026-10-05T10:00:00Z") }).reapply, false);
    });
    await it("戻した後にフォームが届いた＝申込中", () => {
      eq(resolveReapply({ status: "proposing", applicationPushAt: T("2026-10-01T10:00:00Z"), statusManualBackAt: T("2026-10-05T10:00:00Z"), applicationFormAt: T("2026-10-06T00:00:00Z") }).reapply, false);
    });
    await it("今の status が申込以降なら申込歴ありにしない", () => {
      eq(resolveReapply({ status: "applying", deepseekCutoffAt: T("2026-10-03T00:00:00Z") }).reapply, false);
    });
    await it("申込の記録が無い普通の戻し（内覧→提案中）は申込歴ではない", () => {
      eq(resolveReapply({ status: "proposing", statusManualBackAt: T("2026-10-03T00:00:00Z") }).reapply, false);
    });
    await it("記録が無くても消えない切り替えの時刻（申込以降→申込前）があれば申込歴あり（審査管理の同期の status だけだった会話）", () => {
      eq(resolveReapply({ status: "proposing", deepseekCutoffAt: T("2026-10-03T00:00:00Z") }).reapply, true);
    });
    await it("印だけ残って戻した会話（b50fd451 の形）も申込歴あり", () => {
      eq(resolveReapply({ status: "proposing", isPostApply: true, idDocumentAt: T("2026-09-25T00:00:00Z"), statusManualBackAt: T("2026-10-09T00:00:00Z") }).reapply, true);
    });
    await it("印があって戻していない会話は申込中", () => {
      eq(resolveReapply({ status: "proposing", isPostApply: true, idDocumentAt: T("2026-09-25T00:00:00Z") }).reapply, false);
    });
  });

  await describe("戻った理由（detectReturnPattern）", async () => {
    const back = T("2026-10-10T00:00:00Z");
    const m = (sender: string, text: string, at: string) => ({ sender, text, createdAt: T(at) });
    await it("①審査否決（管理会社の結果を伝えた文）", () => {
      eq(detectReturnPattern([m("staff", "保証会社の審査が通らなかったとのご連絡がございました", "2026-10-09T03:00:00Z")], back).pattern, "screening_denied");
      eq(detectReturnPattern([m("staff", "今回は否決となってしまいました", "2026-10-09T03:00:00Z")], back).pattern, "screening_denied");
    });
    await it("仮定・心配の文（否決になった場合は）は根拠にしない", () => {
      eq(detectReturnPattern([m("staff", "万が一否決になった場合でも別の保証会社でご案内できます", "2026-10-02T03:00:00Z")], back).pattern, "unknown");
      eq(detectReturnPattern([m("customer", "審査落ちたらどうしようか不安です", "2026-10-02T03:00:00Z")], back).pattern, "unknown");
    });
    await it("②番手で1番手が審査通過", () => {
      eq(detectReturnPattern([m("staff", "1番手の方の審査が通過してしまいお部屋が決まってしまいました", "2026-10-09T03:00:00Z")], back).pattern, "lost_to_first");
      eq(detectReturnPattern([m("staff", "先にお申込の方で決まってしまいました", "2026-10-09T03:00:00Z")], back).pattern, "lost_to_first");
    });
    await it("①否決の後の問いの形（なんで落ちたか分かりますか）も否決", () => {
      eq(detectReturnPattern([m("customer", "テスト保証なんで落ちたかわかりますか", "2026-10-08T03:00:00Z")], back).pattern, "screening_denied");
    });
    await it("②番手で申込んで戻した（2番手で申込・抑えた）＝戻す前の文だけ", () => {
      eq(detectReturnPattern([m("staff", "2番手でお申し込み完了しております", "2026-10-08T03:00:00Z")], back).pattern, "lost_to_first");
      eq(detectReturnPattern([m("staff", "お部屋お申込し2番手で抑えさせて頂きます", "2026-10-08T03:00:00Z")], back).pattern, "lost_to_first");
      eq(detectReturnPattern([m("staff", "2番手以降でのお申込となります", "2026-10-11T03:00:00Z")], back).pattern, "unknown");
    });
    await it("保証会社の並び（1番手:〇〇保証）は番手の申込にしない", () => {
      eq(detectReturnPattern([m("staff", "1番手:テスト保証（信用系）", "2026-10-08T03:00:00Z")], back).pattern, "unknown");
    });
    await it("②はピッカー（申込状況について・ほかの方の申込あり）だけでも", () => {
      const d = detectReturnPattern([], back, [{ checkPattern: "mgmt_application_status", choices: { app_status_has: "あり", ahead: 1 }, createdAt: T("2026-10-03T00:00:00Z") }]);
      eq([d.pattern, d.evidence], ["lost_to_first", "picker"]);
    });
    await it("ピッカーで「なし」だけを選んだ記録は②にしない", () => {
      eq(detectReturnPattern([], back, [{ checkPattern: "mgmt_application_status", choices: { app_status_has: "なし" }, createdAt: T("2026-10-03T00:00:00Z") }]).pattern, "unknown");
    });
    await it("③お客様の切り替え（戻す前のお客様の発言だけ）", () => {
      eq(detectReturnPattern([m("customer", "やっぱり別の物件にしたいです", "2026-10-09T03:00:00Z")], back).pattern, "switched");
      eq(detectReturnPattern([m("customer", "申込をキャンセルさせてください", "2026-10-09T03:00:00Z")], back).pattern, "switched");
    });
    await it("戻した後のお客様の物件探しの言葉（別のお部屋で）では③にしない", () => {
      eq(detectReturnPattern([m("customer", "別のお部屋で探したいです", "2026-10-11T03:00:00Z")], back).pattern, "unknown");
    });
    await it("スタッフの「別のお部屋」は③にしない（お客様の発言だけ）", () => {
      eq(detectReturnPattern([m("staff", "別のお部屋でお申込を進めましょう", "2026-10-09T03:00:00Z")], back).pattern, "unknown");
    });
    await it("否決と切り替えが両方ある時は①（切り替えは否決の結果の言葉）", () => {
      eq(detectReturnPattern([
        m("staff", "審査が通りませんでした", "2026-10-09T03:00:00Z"),
        m("customer", "やっぱり別の物件にします", "2026-10-09T04:00:00Z"),
      ], back).pattern, "screening_denied");
    });
    await it("窓の外（戻す30日より前）の文は見ない", () => {
      eq(detectReturnPattern([m("staff", "審査が通りませんでした", "2026-08-01T03:00:00Z")], back).pattern, "unknown");
    });
    await it("戻した時刻が無ければ理由不明", () => {
      eq(detectReturnPattern([m("staff", "否決となりました", "2026-10-09T03:00:00Z")], null).pattern, "unknown");
    });
  });

  await describe("スタッフの選択（メモの1行）・札・材料", async () => {
    await it("メモの行から読める・外した行は読まない", () => {
      for (const p of RETURN_PATTERNS) eq(staffPatternOf([{ id: REAPPLY_MEMO_ID, text: reapplyMemoText(p) }]), p);
      eq(staffPatternOf([{ id: REAPPLY_MEMO_ID, text: reapplyMemoText("switched"), retiredAt: T("2026-10-01T00:00:00Z") }]), null);
      eq(staffPatternOf([{ id: "s-1", text: reapplyMemoText("switched") }]), null);
    });
    await it("札は短い形", () => {
      eq(reapplyBadgeText({ pattern: "screening_denied" }), "申込歴あり（再探し）・①審査否決");
      eq(reapplyBadgeText({ pattern: "unknown" }), "申込歴あり（再探し）・理由不明");
    });
    await it("ブレインの材料にパターンと次の一手が入り、個人の値は入らない", () => {
      const n = buildReapplyBrainNote({ reapply: true, returnedAt: T("2026-10-10T00:00:00Z"), pattern: "lost_to_first", source: "auto" }, Date.parse("2026-10-12T00:00:00Z"));
      if (!/申込歴あり（再探し）/.test(n) || !/1番手が審査通過/.test(n) || !/似た物件をすぐ出す/.test(n) || !/戻って2日/.test(n)) throw new Error(n);
      eq(altPiiSignal(n), null);
    });
  });

  await describe("戻った会話の DeepSeek の線（印だけ残って戻した会話）", async () => {
    const f = { status: "proposing", isPostApply: true, idDocumentAt: T("2026-09-25T00:00:00Z"), statusManualBackAt: T("2026-10-09T00:00:00Z") };
    /** 出口の強めの網を通る入口（返信生成・AIX）だけが開く */
    const R = { reapply: true };
    await it("網を通らない入口（loadDeepseekCutoff の既定）は今まで通り渡さない", () => {
      const prev = process.env.REAPPLY_DEEPSEEK; process.env.REAPPLY_DEEPSEEK = "on";
      try { eq(deepseekSafeCutoff(f), null); } finally { if (prev === undefined) delete process.env.REAPPLY_DEEPSEEK; else process.env.REAPPLY_DEEPSEEK = prev; }
    });
    await it("REAPPLY_DEEPSEEK=on: DeepSeek の申込以降に数えず、線は戻した時刻", () => {
      eq(deepseekPostApply(f, ON), false);
      const prev = process.env.REAPPLY_DEEPSEEK; process.env.REAPPLY_DEEPSEEK = "on";
      try { eq(deepseekSafeCutoff(f, R), T("2026-10-09T00:00:00Z")); } finally { if (prev === undefined) delete process.env.REAPPLY_DEEPSEEK; else process.env.REAPPLY_DEEPSEEK = prev; }
    });
    await it("申込中の期間（書類〜戻した時刻）の通は線で落ちる", () => {
      const prev = process.env.REAPPLY_DEEPSEEK; process.env.REAPPLY_DEEPSEEK = "on";
      try {
        const msgs = [{ at: T("2026-09-24T00:00:00Z") }, { at: T("2026-09-26T00:00:00Z") }, { at: T("2026-10-08T23:59:00Z") }, { at: T("2026-10-09T00:00:00Z") }, { at: T("2026-10-10T00:00:00Z") }];
        eq(filterAfterCutoff(msgs, (x) => x.at, deepseekSafeCutoff(f, R)).map((x) => x.at), [T("2026-10-10T00:00:00Z")]);
      } finally { if (prev === undefined) delete process.env.REAPPLY_DEEPSEEK; else process.env.REAPPLY_DEEPSEEK = prev; }
    });
    await it("REAPPLY_DEEPSEEK=off: 旧のまま（Claude 固定・線なし）", () => {
      eq(deepseekPostApply(f, OFF), true);
      const prev = process.env.REAPPLY_DEEPSEEK; process.env.REAPPLY_DEEPSEEK = "off";
      try { eq(deepseekSafeCutoff(f, R), null); } finally { if (prev === undefined) delete process.env.REAPPLY_DEEPSEEK; else process.env.REAPPLY_DEEPSEEK = prev; }
    });
    await it("消えない列（deepseek_cutoff_at）だけ＝印を付ける前の古い戻しかもしれない → Claude のまま", () => {
      eq(deepseekPostApply({ status: "proposing", isPostApply: true, deepseekCutoffAt: T("2026-10-09T00:00:00Z") }, ON), true);
    });
    await it("記録の無い印＋戻し: 全部（NO_CUTOFF）にせず戻しの印より後だけ", () => {
      const prev = process.env.REAPPLY_DEEPSEEK; process.env.REAPPLY_DEEPSEEK = "on";
      try { eq(deepseekSafeCutoff({ status: "proposing", isPostApply: true, statusManualBackAt: T("2026-10-09T00:00:00Z") }, R), T("2026-10-09T00:00:00Z")); }
      finally { if (prev === undefined) delete process.env.REAPPLY_DEEPSEEK; else process.env.REAPPLY_DEEPSEEK = prev; }
    });
    await it("戻した後にフォームが届いた（また申込中）→ 渡さない", () => {
      const prev = process.env.REAPPLY_DEEPSEEK; process.env.REAPPLY_DEEPSEEK = "on";
      try { eq(deepseekSafeCutoff({ ...f, applicationFormAt: T("2026-10-11T00:00:00Z") }, R), null); }
      finally { if (prev === undefined) delete process.env.REAPPLY_DEEPSEEK; else process.env.REAPPLY_DEEPSEEK = prev; }
    });
    await it("戻した後に書類・押下 → 申込以降（Claude）", () => {
      eq(deepseekPostApply({ ...f, idDocumentAt: T("2026-10-11T00:00:00Z") }, ON), true);
      eq(deepseekPostApply({ ...f, applicationPushAt: T("2026-10-11T00:00:00Z") }, ON), true);
    });
    await it("status が申込以降なら印があっても Claude", () => {
      eq(deepseekPostApply({ ...f, status: "screening" }, ON), true);
    });
    await it("下書きの判定・申込以降の判定（resolvePostApply）は変えない", () => {
      eq(resolvePostApply(f).postApply, true);
      eq(postApplyDraftSkip(f, {}), false);
    });
    await it("印の無い普通の戻し（従来）は変わらない", () => {
      const g = { status: "proposing", applicationPushAt: T("2026-10-01T00:00:00Z"), deepseekCutoffAt: T("2026-10-05T00:00:00Z") };
      eq(deepseekPostApply(g, OFF), false);
      eq(deepseekSafeCutoff(g), T("2026-10-05T00:00:00Z"));
    });
  });

  await describe("出口の強めの網（altPiiSignalReapply・線のある呼び出しの messages）", async () => {
    await it("申込情報の名残を当てる（作り物の値）", () => {
      eq(altPiiSignalReapply("年収 350万円です"), "年収の値");
      eq(altPiiSignalReapply("1995年3月12日"), "生年月日らしい日付");
      eq(altPiiSignalReapply("平成7年3月12日生"), "生年月日らしい日付");
      eq(altPiiSignalReapply("勤務先：テスト商事"), "勤務先の値");
      eq(altPiiSignalReapply("[お客様が申込フォームに記入して送信（個人情報のため非表示）]"), "申込情報を伏せた跡");
      eq(altPiiSignalReapply("勤務先 ○○（勤務先）"), "申込情報を伏せた跡");
      eq(altPiiSignalReapply("【申込者様記入欄】"), "申込フォームの欄");
    });
    await it("今までの網（携帯番号）も当たる", () => {
      eq(altPiiSignalReapply("090-1234-5678"), "携帯電話の番号");
    });
    await it("物件探しの普通の文・築年月・物件の金額は当てない", () => {
      eq(altPiiSignalReapply("梅田まで20分以内で家賃7万円ほどの1Kを探しています"), null);
      eq(altPiiSignalReapply("築年月 平成20年3月築・家賃 68,000円・管理費 5,000円"), null);
      eq(altPiiSignalReapply("勤務先が梅田なので通勤しやすい所がいいです"), null);
      eq(altPiiSignalReapply("2026年10月25日に内覧希望です"), null);
    });
    await it("system の値だけの網: 値は当て、指示文の語（申込フォーム・本人確認書類）では止めない", () => {
      eq(altPiiSignalReapplyValues("【ブレインの判断】勤務先：テスト商事・年収 350万円"), "年収の値");
      eq(altPiiSignalReapplyValues("前回のまとめ: 勤務先：テスト商事"), "勤務先の値");
      eq(altPiiSignalReapplyValues("申込に要る物は申込者様記入欄のフォーマットと本人確認書類（運転免許証）の2つ"), null);
    });
    await it("出口（cut）: system の値・messages の審査の事情も当てる／AIX の画像の道も同じ網", () => {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const prov = readFileSync(join(__dirname, "..", "llm-alt-provider.ts"), "utf8");
      const aix = readFileSync(join(__dirname, "..", "..", "api", "aix", "action", "route.ts"), "utf8");
      if (!/altPiiSignalReapplyValues\(flattenContent\(body\.system\)\)/.test(prov)) throw new Error("system values");
      if (!/screeningSensitiveSignal\(\(body\.messages \?\? \[\]\)[^\n]*\? "審査の事情"/.test(prov)) throw new Error("screening");
      if (!/if \(!visionPii && !opts\.forceClaude && shouldRouteVisionAlt/.test(aix)) throw new Error("vision");
    });
  });

  await describe("やることリスト（申込歴ありを上げる・印が残っていても約束と未返信を出す）", async () => {
    const at = Date.parse("2026-10-21T03:00:00Z");
    const base: TodoInput = {
      atMs: at,
      conversations: [
        { id: "00000000-0000-0000-0000-00000000000a", customer_name: "テストA", account: null, status: "proposing" },
        { id: "00000000-0000-0000-0000-00000000000b", customer_name: "テストB", account: null, status: "proposing", is_post_apply: true, reapply: true },
      ],
      aixItems: [], promises: [], facts: [], viewings: [],
      messages: [
        { conversation_id: "00000000-0000-0000-0000-00000000000a", sender: "customer", text: "物件まだありますか", created_at: "2026-10-21T01:00:00Z" },
        { conversation_id: "00000000-0000-0000-0000-00000000000b", sender: "customer", text: "物件まだありますか", created_at: "2026-10-21T01:30:00Z" },
      ],
    };
    await it("申込歴ありのお客様が先・見出しに印", () => {
      const l = buildStaffTodoList(base);
      eq(l.customers.map((c) => c.name), ["テストB", "テストA"]);
      if (!l.customers[0].accountLabel.endsWith(REAPPLY_HEADER_MARK)) throw new Error(l.customers[0].accountLabel);
    });
    await it("申込歴ありでない印だけの会話は今まで通り出さない", () => {
      const l = buildStaffTodoList({ ...base, conversations: base.conversations.map((c) => (c.id.endsWith("b") ? { ...c, reapply: false } : c)) });
      eq(l.customers.map((c) => c.name), ["テストA"]);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main();
