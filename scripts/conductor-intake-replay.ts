// scripts/conductor-intake-replay.ts — 入口の統括の最初の読みの「再生の試験」（竹内さん本人の番・最初の読みだけを流して竹内さんの一手と比べる）
//
// 2026-11-04 竹内さん（KB P1「統括を竹内さんの過去の番で鍛える」・41dadfe6）。テストの決まりは memory/test_protocol_brain.md:
//   試行錯誤は LLM_TEST_MODE=deepseek-all（Claude は止まる）・最後は LLM_TEST_FINAL_CLAUDE=1 で場面ごとに1〜2回・入口 setupLlmTest を最初に。
//   書き込みはしない（最初の読みは LLM を呼んで答えを読むだけ）。LLM の呼び出しの会話の id は YUMA（歯止めの出口が他の会話を断る）。
//   採点: 竹内さんの一手が AIX の番 ↔ 統括が AIX の担当（aix_desk）か AIX のやる事（todos.kind=aix）を出したか（返信か AIX かの見分け）。
//   結果は exam-cache/conductor-intake/results-<label>.json（番ごとの答え・当たり）。外れた番は取扱説明書の「よくある外れ」と指示の直しに回す。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/conductor-intake-replay.ts --qfile=<questions.json> --label=ci-ds1 [--limit=200]
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const h = await setupLlmTest("conductor-intake-replay");
  try {
    const qfile = arg("qfile"); const label = arg("label", "ci-run"); const limit = Number(arg("limit", "200"));
    if (!qfile) throw new Error("--qfile が要る");
    const q = JSON.parse(readFileSync(qfile, "utf8")) as { items: Array<{ id: string; customer: string; lastStaff: string | null; ledgerBlock?: string; gold: { route: "aix" | "reply"; aix: string | null } }> };
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { runConductorIntake } = await import("../app/lib/conductor-intake-server");
    h.assertYuma(YUMA_CONVERSATION_ID, "入口の統括の再生の試験");
    const rows: Array<Record<string, unknown>> = [];
    let n = 0, hit = 0, aixN = 0, aixHit = 0, replyN = 0, replyHit = 0, failed = 0;
    for (const it of q.items.slice(0, limit)) {
      const r = await runConductorIntake({ conversationId: YUMA_CONVERSATION_ID, turnAt: null, customerTurn: it.customer, lastStaff: it.lastStaff, ledgerBlock: it.ledgerBlock ?? "", carryLine: "", ruleMeta: "" }).catch(() => null);
      const a = r?.answer ?? null;
      if (!a) { failed++; rows.push({ id: it.id, gold: it.gold, answer: null }); continue; }
      const saidAix = a.roles.includes("aix_desk") || a.todos.some((t) => t.kind === "aix");
      const ok = (it.gold.route === "aix") === saidAix;
      n++; if (ok) hit++;
      if (it.gold.route === "aix") { aixN++; if (ok) aixHit++; } else { replyN++; if (ok) replyHit++; }
      rows.push({ id: it.id, gold: it.gold, scene: a.scene, roles: a.roles, todos: a.todos.map((t) => t.kind), confidence: a.confidence, ok });
    }
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
    const out = join(dirname(qfile), `results-${label}.json`);
    writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), prefixVersion: (await import("../app/lib/conductor-intake")).intakePrefixVersion(), n, hit, aixN, aixHit, replyN, replyHit, failed, rows }, null, 1));
    console.log(`# 入口の統括の再生の試験 ${label}: 返信か AIX かの見分け ${hit}/${n}（${pct(hit, n)}）・AIX の番 ${aixHit}/${aixN}（${pct(aixHit, aixN)}）・返信の番 ${replyHit}/${replyN}（${pct(replyHit, replyN)}）・読めなかった ${failed} → ${out}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
