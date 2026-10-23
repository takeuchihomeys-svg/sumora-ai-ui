// app/lib/__tests__/final-check-flash.test.ts — 2026-10-23 最終チェックの指揮官 Claude＋FLASH の下確かめ（実行: npx tsx app/lib/__tests__/final-check-flash.test.ts）
// LLM・DB・LINE は呼ばない（FLASH・指揮官・fetch は全部差し替え）。
import {
  finalCheckFlashOn, finalCheckFlashTimeoutMs, flashEligibility, maskForFlash, parseFlashOut, runFlashSubChecks, lowRiskForSkip, passOfCode, flashUsd,
  type FlashMaterials, type FlashCaller,
} from "../final-check-flash";
import { piiValueSignal } from "../test-pii-guard";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const M = (o: Partial<FlashMaterials> = {}): FlashMaterials => ({
  draft: "かしこまりました！！\n引き続きお探しさせて頂きます！！",
  lastCustomer: "よろしくお願いします、北堀江あたりでお願いしたいです",
  history: "お客様: 北堀江で探しています\nスタッフ: かしこまりました",
  facts: "[登録の条件]\n北堀江・1K・家賃7万円以内",
  companyFacts: "",
  rules: "- 「少々お待ちください」は使わない",
  customerQuestions: [],
  now: "2026/10/23（金）15:00 JST",
  names: ["山田花子"],
  ...o,
});
const cleanCaller = (calls: string[]): FlashCaller => async (sys, user) => { calls.push(user); return { text: '{"hits":[]}', usage: { input: 900, output: 12, cacheHit: 600 }, model: "deepseek-flash" }; };

async function main() {
  console.log("■ スイッチ");
  t("既定 off", !finalCheckFlashOn({}));
  t("on", finalCheckFlashOn({ FINAL_CHECK_FLASH: "on" }));
  t("時間切れの既定 4500", finalCheckFlashTimeoutMs({}) === 4500);
  t("時間切れは 1500〜8000 に収める", finalCheckFlashTimeoutMs({ FINAL_CHECK_FLASH_TIMEOUT_MS: "99999" }) === 8000 && finalCheckFlashTimeoutMs({ FINAL_CHECK_FLASH_TIMEOUT_MS: "10" }) === 1500);

  console.log("■ 入口（Claude だけにする所）");
  const okGate = { autoSendConversation: false, sensitive: false, postApply: false, stateUnknown: false };
  t("入口の判定なし（check-reply 等）は使わない", !flashEligibility({ gate: null, rawTexts: ["a"] }).ok);
  t("自動送信は使わない", !flashEligibility({ gate: { ...okGate, autoSendConversation: true }, rawTexts: ["a"] }).ok);
  t("センシティブは使わない", !flashEligibility({ gate: { ...okGate, sensitive: true }, rawTexts: ["a"] }).ok);
  t("申込以降は使わない", !flashEligibility({ gate: { ...okGate, postApply: true }, rawTexts: ["a"] }).ok);
  t("記録が読めないは使わない", !flashEligibility({ gate: { ...okGate, stateUnknown: true }, rawTexts: ["a"] }).ok);
  t("段階 applying は使わない", !flashEligibility({ gate: okGate, phaseKey: "applying", rawTexts: ["a"] }).ok);
  t("段階の名前に審査・申込は使わない", !flashEligibility({ gate: okGate, conversationStage: "審査中", rawTexts: ["a"] }).ok);
  t("審査の事情（保証人がいない）は使わない", !flashEligibility({ gate: okGate, rawTexts: ["保証人がいないのですが大丈夫ですか"] }).ok);
  t("携帯の番号が入っていたら使わない", !flashEligibility({ gate: okGate, rawTexts: ["090-1234-5678 に連絡ください"] }).ok);
  t("物件の条件の言い方（保証人不要）は審査の事情ではない", flashEligibility({ gate: okGate, rawTexts: ["保証人不要の物件がいいです"] }).ok);
  t("ふつうの番は使う", flashEligibility({ gate: okGate, phaseKey: "proposing", rawTexts: ["北堀江で探しています"] }).ok);

  console.log("■ 伏せる");
  const mk = maskForFlash("山田花子さん、ご連絡は yamada@example.com へ", ["山田花子"]);
  t("名前を伏せる", !mk.includes("山田花子"), mk);
  t("メールを伏せる", !mk.includes("yamada@example.com"), mk);
  t("号室・金額は残す（照らすのに要る）", maskForFlash("サンハイツ302号室 家賃7万円", []).includes("302号室") && maskForFlash("サンハイツ302号室 家賃7万円", []).includes("7万円"));

  console.log("■ FLASH の答えを読む");
  const d = "家賃は7万5千円です！！";
  t("正しい形", (parseFlashOut("facts", '{"hits":[{"code":"FABRICATED_AMOUNT","evidence":"7万5千円","why":"材料に無い"}]}', d, "") ?? []).length === 1);
  t("係の外の code は捨てる", (parseFlashOut("facts", '{"hits":[{"code":"MISSED_QUESTION","evidence":"7万5千円","why":""}]}', d, "") ?? [1]).length === 0);
  t("引用が本文に無い物は捨てる", (parseFlashOut("facts", '{"hits":[{"code":"FABRICATED_AMOUNT","evidence":"8万円","why":""}]}', d, "") ?? [1]).length === 0);
  t("asks はお客様の発言からの引用", (parseFlashOut("asks", '{"hits":[{"code":"MISSED_QUESTION","evidence":"駐車場はありますか","why":""}]}', d, "駐車場はありますか？") ?? []).length === 1);
  t("```json の囲みも読む", (parseFlashOut("rules", '```json\n{"hits":[]}\n```', d, "") ?? null) !== null);
  t("読めない形は null（今の3パスへ）", parseFlashOut("rules", "問題ありません", d, "") === null);

  console.log("■ 下確かめを同時に");
  {
    const calls: string[] = [];
    const out = await runFlashSubChecks(M(), { call: cleanCaller(calls), timeoutMs: 3000 });
    t("全部きれい → ok・候補0", out.ok && out.hits.length === 0);
    t("会社の事実が無い番は company を呼ばない（4項目）", calls.length === 4, String(calls.length));
    t("FLASH に名前は渡らない", calls.every((u) => !u.includes("山田花子")));
    t("FLASH に個人の値は渡らない", calls.every((u) => !piiValueSignal(u)));
    t("費用を数える", out.usd > 0 && out.usd < 0.001, String(out.usd));
  }
  {
    const calls: string[] = [];
    const out = await runFlashSubChecks(M({ companyFacts: "- 店舗でのご相談は承っておりません" }), { call: cleanCaller(calls), timeoutMs: 3000 });
    t("会社の事実がある番は5項目", out.ok && calls.length === 5);
  }
  {
    const call: FlashCaller = async (sys) => (sys.includes("事実の係") ? null : { text: '{"hits":[]}', usage: { input: 1, output: 1, cacheHit: 0 }, model: "deepseek-flash" });
    const out = await runFlashSubChecks(M(), { call, timeoutMs: 3000 });
    t("1項目でも応答なし → ok=false（今の3パスへ）", !out.ok && /facts/.test(out.fallbackReason ?? ""), out.fallbackReason ?? "");
  }
  {
    const call: FlashCaller = (sys) => new Promise((res) => setTimeout(() => res({ text: '{"hits":[]}', usage: { input: 1, output: 1, cacheHit: 0 }, model: "deepseek-flash" }), sys.includes("答えの抜け") ? 5000 : 10));
    const s = Date.now();
    const out = await runFlashSubChecks(M(), { call, timeoutMs: 1500 });
    const ms = Date.now() - s;
    t("遅い係がいても硬い時間切れで戻る（待ちの尾を作らない）", !out.ok && /時間切れ/.test(out.fallbackReason ?? "") && ms < 2200, `${ms}ms ${out.fallbackReason}`);
  }
  {
    const calls: string[] = [];
    const call: FlashCaller = async (sys, user) => { calls.push(user); return { text: sys.includes("事実の係") ? '{"hits":[{"code":"FABRICATED_AMOUNT","evidence":"7万5千円","why":"材料に無い"}]}' : '{"hits":[]}', usage: { input: 1, output: 1, cacheHit: 0 }, model: "deepseek-flash" }; };
    const out = await runFlashSubChecks(M({ draft: "家賃は7万5千円です！！" }), { call, timeoutMs: 3000 });
    t("候補を集める", out.ok && out.hits.length === 1 && out.hits[0].key === "facts");
  }

  console.log("■ 指揮官を呼ばずに済むか（保守的）");
  const base = { hits: [], allOk: true, detSeverities: [] as string[] };
  t("決まり文句だけ・候補0 → 呼ばない", lowRiskForSkip({ ...base, draft: "かしこまりました！！\n引き続きお探しさせて頂きます！！" }).skip);
  t("金額を含む → 呼ぶ", !lowRiskForSkip({ ...base, draft: "家賃は7万円です！！" }).skip);
  t("日付を含む → 呼ぶ", !lowRiskForSkip({ ...base, draft: "10月25日に内覧可能です！！" }).skip);
  t("曜日を含む → 呼ぶ", !lowRiskForSkip({ ...base, draft: "土曜でしたら大丈夫です！！" }).skip);
  t("号室を含む → 呼ぶ", !lowRiskForSkip({ ...base, draft: "302号室も空いております！！" }).skip);
  t("候補あり → 呼ぶ", !lowRiskForSkip({ ...base, hits: [{ key: "asks", code: "MISSED_QUESTION", evidence: "x", why: "" }], draft: "はい" }).skip);
  t("決定論の warning → 呼ぶ", !lowRiskForSkip({ ...base, detSeverities: ["warning"], draft: "はい" }).skip);
  t("初回 → 呼ぶ", !lowRiskForSkip({ ...base, isEarlyConversation: true, draft: "はい" }).skip);
  t("長い → 呼ぶ", !lowRiskForSkip({ ...base, draft: "あ".repeat(230) }).skip);
  t("完走していない → 呼ぶ", !lowRiskForSkip({ ...base, allOk: false, draft: "はい" }).skip);

  console.log("■ code → 3パスの名前（severity を今と同じにする）");
  t("AIX_BOUNDARY → rule_check", passOfCode("AIX_BOUNDARY_ESTIMATE") === "rule_check");
  t("FABRICATED → anomaly_scan", passOfCode("FABRICATED_AMOUNT") === "anomaly_scan");
  t("COMPANY → anomaly_scan", passOfCode("COMPANY_FACT_CONTRADICTION") === "anomaly_scan");
  t("MISSED_QUESTION → context_check", passOfCode("MISSED_QUESTION") === "context_check");
  t("混雑の時間は2倍", Math.abs(flashUsd({ input: 1e6, output: 0, cacheHit: 0 }, true) - 0.3) < 1e-9);

  console.log("■ runFinalCheck に組み込んだ形（fetch・FLASH・指揮官は差し替え）");
  const fc = await import("../final-check");
  const realFetch = globalThis.fetch;
  let anthropicCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("api.anthropic.com")) { anthropicCalls++; return new Response(JSON.stringify({ content: [{ type: "text", text: '{"issues":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }); }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  const ctx = (o: Record<string, unknown> = {}) => ({
    lastCustomerMessage: "北堀江あたりでお願いしたいです",
    recentMessages: [{ sender: "staff", text: "ご希望のエリアはございますか？" }, { sender: "customer", text: "北堀江あたりでお願いしたいです" }],
    flashGate: okGate, phaseKey: "hearing",
    ...o,
  });
  const draftClean = "かしこまりました！！\n北堀江エリアからお探しさせて頂きます！！";
  try {
    process.env.FINAL_CHECK_FLASH = "on";
    let conductorCalls = 0;
    fc.__setFinalCheckFlashDeps({ flash: cleanCaller([]), conductor: async () => { conductorCalls++; return { issues: [], usd: 0.004 }; } });
    anthropicCalls = 0;
    const r1 = await fc.runFinalCheck(draftClean, ctx() as never, 30000);
    const detOnly = fc.runDeterministicChecks(draftClean, ctx() as never);
    const lowRisk = !detOnly.some((i) => i.severity === "block" || i.severity === "warning");
    t("FLASH を使った（mode used）", r1.flash?.mode === "used", JSON.stringify(r1.flash));
    t("今の3パス（Anthropic の fetch）は呼ばない", anthropicCalls === 0, String(anthropicCalls));
    if (lowRisk) {
      t("候補0・低リスク → 指揮官も呼ばない", conductorCalls === 0 && r1.flash?.conductor?.ran === false);
    } else {
      t("決定論の指摘あり → 指揮官を呼ぶ", conductorCalls === 1, JSON.stringify(detOnly.map((i) => i.code)));
    }
    t("3重チェックの完走として数える（自動送信でない番だけ）", r1.passes_completed.length === 3);
    t("PARTIALLY_UNCHECKED を出さない", !r1.issues.some((i) => i.code === "PARTIALLY_UNCHECKED"));

    // 候補あり → 指揮官が決めた指摘が今と同じ severity で出る
    conductorCalls = 0;
    const draftAmt = "かしこまりました！！\n初期費用は約35万円になります！！";
    const hitCaller: FlashCaller = async (sys) => ({ text: sys.includes("返信か AIX か") ? '{"hits":[{"code":"AIX_BOUNDARY_ESTIMATE","evidence":"初期費用は約35万円になります","why":"見積の金額"}]}' : '{"hits":[]}', usage: { input: 1, output: 1, cacheHit: 0 }, model: "deepseek-flash" });
    let seenPrompt = "";
    fc.__setFinalCheckFlashDeps({ flash: hitCaller, conductor: async (prompt) => { conductorCalls++; seenPrompt = prompt.map((b) => b.text).join("\n"); return { issues: [{ code: "AIX_BOUNDARY_ESTIMATE", message: "見積の金額を返信で出している", evidence: "初期費用は約35万円になります", suggestion: "金額を消して見積書でご案内する" }], usd: 0.004 }; } });
    const r2 = await fc.runFinalCheck(draftAmt, ctx() as never, 30000);
    const aix = r2.issues.find((i) => i.code === "AIX_BOUNDARY_ESTIMATE");
    t("指揮官を1回だけ呼ぶ", conductorCalls === 1);
    t("指揮官には候補が渡る", seenPrompt.includes("AIX_BOUNDARY_ESTIMATE") && seenPrompt.includes("【候補】"));
    t("指摘は rule_check・block（今と同じ決まり）", aix?.pass === "rule_check" && aix?.severity === "block", JSON.stringify(aix));
    t("費用の見込みを残す", (r2.flash?.est_usd ?? 0) > 0.003);

    // FLASH の失敗 → 今の3パス（Claude だけ）
    fc.__setFinalCheckFlashDeps({ flash: async () => null, conductor: async () => { throw new Error("呼ばれてはいけない"); } });
    anthropicCalls = 0;
    const r3 = await fc.runFinalCheck(draftClean, ctx() as never, 30000);
    t("FLASH の失敗 → fallback", r3.flash?.mode === "fallback");
    t("今の3パスを呼んだ", anthropicCalls === 3, String(anthropicCalls));

    // 指揮官の失敗 → 今の3パス
    fc.__setFinalCheckFlashDeps({ flash: hitCaller, conductor: async () => { throw new Error("HTTP 529"); } });
    anthropicCalls = 0;
    const r3b = await fc.runFinalCheck(draftAmt, ctx() as never, 30000);
    t("指揮官の失敗 → fallback・今の3パス", r3b.flash?.mode === "fallback" && anthropicCalls === 3, `${r3b.flash?.mode} ${anthropicCalls}`);

    // 入口なし（check-reply 等）→ 今の3パス
    fc.__setFinalCheckFlashDeps({ flash: async () => { throw new Error("呼ばれてはいけない"); } });
    anthropicCalls = 0;
    const r4 = await fc.runFinalCheck(draftClean, ctx({ flashGate: undefined }) as never, 30000);
    t("入口なし → ineligible・今の3パス", r4.flash?.mode === "ineligible" && anthropicCalls === 3);
    // 申込以降 → 今の3パス
    anthropicCalls = 0;
    const r5 = await fc.runFinalCheck(draftClean, ctx({ flashGate: { ...okGate, postApply: true } }) as never, 30000);
    t("申込以降 → ineligible・今の3パス", r5.flash?.mode === "ineligible" && anthropicCalls === 3);

    // スイッチ off → 何も変わらない（flash の記録も無い）
    delete process.env.FINAL_CHECK_FLASH;
    anthropicCalls = 0;
    const r6 = await fc.runFinalCheck(draftClean, ctx() as never, 30000);
    t("off → 記録なし・今の3パス", r6.flash === undefined && anthropicCalls === 3);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.FINAL_CHECK_FLASH;
    fc.__setFinalCheckFlashDeps({ flash: null, conductor: null });
  }

  console.log(`\n${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
