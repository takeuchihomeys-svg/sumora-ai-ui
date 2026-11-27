// app/lib/__tests__/shadow-reach.test.ts — 影の届き（#823 ①・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/shadow-reach.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runShadowReach, shadowReachDigest, shadowReachOn, SHADOW_PARTS, type ShadowReachCtx, type ShadowPart } from "../shadow-reach";
import { toFreshDigest } from "../brain-layers";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = (h: number) => new Date(Date.parse("2026-11-20T00:00:00Z") + h * 36e5).toISOString();
const ctx: ShadowReachCtx = {
  loc: { node: "hearing", branch: "screening_concern", next: { aix: ["property_send"] } }, since: null,
  ledgerMessages: [], recentAixRows: [], viewingHistory: [], lineTasks: [],
  ledgerFacts: { estimateSent: false, propertiesSentCount: 0, pickupPromisedUnfulfilled: true },
  unrepliedText: "審査が不安です。ブラックでも通りますか？", unrepliedHasImage: false, scene: "question", pickupReady: false,
  typedMessages: [
    { sender: "customer", text: "審査が不安です。ブラックでも通りますか？", created_at: T(5) },
    { sender: "staff", text: "こちらのお部屋もオススメです！！", created_at: T(2) },
    { sender: "customer", text: "初期費用はいくらですか？", created_at: T(1) },
  ],
  aixLogs: [], prevMindset: null, turnAtMs: Date.parse(T(5)) + 1,
};
(async () => {
  const r = await runShadowReach(ctx, { env: {}, budgetMs: 10000 }); // 冷えた import は遅い（本番は brain-core が読み込み済み）＝中身の確かめは上限を広げる
  t("部品は8つ・どれも 字数か err か skip（off の部品は全部組む）", Object.keys(r.parts).length === SHADOW_PARTS.length && Object.values(r.parts).every((v) => typeof v === "number" || v === "err" || v === "skip"));
  t("答え漏れ: 前の番の費用の問いに届く（字数 > 0）", typeof r.parts.unanswered === "number" && (r.parts.unanswered as number) > 0);
  t("駅の状態: 分かれ道の番は組まない（0）", r.parts.station_state === 0);
  t("その部品のスイッチが on の番は組まない（on）", (await runShadowReach(ctx, { env: { UNANSWERED_ASKS_LINE: "on" } })).parts.unanswered === "on");
  const boom: ShadowPart = { sw: "X_BOOM", mark: "boom", build: async () => { throw new Error("x"); } };
  const ok1: ShadowPart = { sw: "X_OK", mark: "ok1", build: async () => "あいう" };
  const r2 = await runShadowReach(ctx, { env: {}, parts: [boom, ok1] });
  t("例外は err だけ・次の部品は組む", r2.parts.boom === "err" && r2.parts.ok1 === 3);
  let clock = 0; const slow: ShadowPart = { sw: "X_SLOW", mark: "slow", build: async () => { clock += 80; return "a"; } };
  const r3 = await runShadowReach(ctx, { env: {}, parts: [slow, ok1], now: () => clock, budgetMs: 50 });
  t("上限の時間を超えたら残りは skip", r3.parts.slow === 1 && r3.parts.ok1 === "skip" && r3.ms === 80);
  t("digest: 届いた・失敗・飛ばしただけ・ms", /^boom:err,ok1:3|d+ms$/.test(shadowReachDigest(r2) ?? "") && shadowReachDigest({ v: "x", parts: { a: 0, b: "on" }, ms: 2 }) === "-|2ms");
  t("brain-layers の digest.shr も同じ形", (toFreshDigest({ shadow_reach: r2 }, null) as Record<string, unknown>).shr === shadowReachDigest(r2));
  t("既定 off", !shadowReachOn({}) && shadowReachOn({ SHADOW_REACH: "on" }));
  // プロンプトを1バイトも変えない線: 影の組みは LLM の後（判断の記録を組む所）で動き、材料の文・塊・印に書かない
  const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
  const at = bc.indexOf("shadowReachRec = await sr.runShadowReach(");
  const llmAt = bc.indexOf("parsed.aix");
  t("配線: 影の組みは LLM の答え（parsed）を読む所より後", at > 0 && llmAt > 0 && at > llmAt);
  const block = bc.slice(bc.indexOf("let shadowReachRec"), bc.indexOf("let afterRecords"));
  t("配線: 影の組みは材料の文・材料の塊・印に書かない", !/customerStateBlockText|applyRouteText|materialBlocks|materialMarks/.test(block));
  const src = readFileSync(join(__dirname, "..", "shadow-reach.ts"), "utf8");
  t("部品は DB も LLM も呼ばない（supabase・fetch・anthropic が無い）", !/supabase|fetch\(|anthropic|deepseek/i.test(src));
  console.log(`shadow-reach: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
