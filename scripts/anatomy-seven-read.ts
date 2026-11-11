// scripts/anatomy-seven-read.ts — 竹内さんの1通を7つの欄＋押す／待つで読む（DeepSeek・既定は1回読み）。roles-r1 の 198通（または Claude Code が読んだ 43通）に広げる
//   竹内さんの決定 KB P1 1f5bd301（親 2e164f41）・弱い所 579。純関数は app/lib/takeuchi-seven-read.ts。
//   テストの決まり（memory/test_protocol_brain.md）: setupLlmTest を最初に・LLM_TEST_MODE=deepseek-all・材料は伏せ済みの body・customer_gist と写しの状況の文 v2 だけ。
//   申込以降の番は turn-application-gate で外す・名乗った本名は sevenPrompt の中で伏せる。DB に書かない。
//   費用の見込み（11/11 の reply_anatomy の実測: 1回 入力約900・出力約210 トークン）: この指示は約2倍＝1回 約 $0.002。
//     43通×1回 ≈ $0.09（まず Claude Code の 43通の読みと合うかを見る）→ 198通×1回 ≈ $0.4 → 割れを見るなら ×3回 ≈ $1.2。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-seven-read.ts [--only=claude43] [--votes=1] [--cap-usd=0.5] [--label=s1]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");

(async () => {
  const h = await setupLlmTest("anatomy-seven-read");
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const S = await import("../app/lib/takeuchi-seven-read");
    const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
    const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
    const { applicationMaterialReason } = await import("../app/lib/test-pii-guard");
    h.assertYuma(YUMA_CONVERSATION_ID, "7つの欄の読み");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const roles = JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as Array<{ id: string; scene: string }>;
    const turns = new Map((JSON.parse(readFileSync(join(CACHE, "conductor-focus", "turns-2026-11-04.json"), "utf8")) as Array<{ id: string; conv: string; at: string; v2: string }>).map((t) => [t.id, t]));
    let ids = roles.map((r) => r.id);
    if (arg("only") === "claude43") {
      const tsv = readFileSync(join(CACHE, "anatomy-seven", "seven-claude-43.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t")[0]);
      ids = ids.filter((id) => tsv.includes(id.slice(0, 8)));
    }
    const rows = new Map<string, { body: string; customer_gist: string | null }>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("takeuchi_compose_examples").select("message_id, body, customer_gist").in("message_id", ids.slice(i, i + 100));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ message_id: string; body: string; customer_gist: string | null }>) rows.set(r.message_id, r);
    }
    // 申込以降の番を外す（1会話ずつ・間を空けて引く）
    const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
    const pick: string[] = [];
    let gated = 0;
    for (const id of ids) {
      const t = turns.get(id), r = rows.get(id);
      if (!t || !r?.body) continue;
      if (!recs.has(t.conv)) { recs.set(t.conv, await loadTurnApplicationRecords(sb, t.conv)); await new Promise((res) => setTimeout(res, 100)); }
      if (turnApplicationReason(recs.get(t.conv), t.at) || applicationMaterialReason(r.customer_gist) || applicationMaterialReason(r.body)) { gated++; continue; }
      pick.push(id);
    }
    console.log(`読む ${pick.length}通（申込以降の疑いで外した ${gated}通）`);
    const votes = Math.max(1, Math.min(3, Number(arg("votes", "1")) || 1));
    const capUsd = Number(arg("cap-usd", "0.5")) || 0.5;
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    let calls = 0;
    const ask = async (user: string) => {
      calls++;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_anatomy", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 900, system: S.SEVEN_SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) return null;
      const d = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return S.parseSevenRead(d.content?.find((b) => b.type === "text")?.text ?? "");
    };
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < pick.length; i += 5) {
      if ((calls + 5 * votes) * 0.002 > capUsd) { console.log(`費用の上限 $${capUsd} の見込みで止めた（${i}/${pick.length}通）`); break; }
      await Promise.all(pick.slice(i, i + 5).map(async (id) => {
        const t = turns.get(id)!, r = rows.get(id)!;
        const user = S.sevenPrompt({ maskedCustomer: r.customer_gist, maskedBody: r.body, scene: roles.find((x) => x.id === id)?.scene ?? "", situation: t.v2 });
        const reads = await Promise.all(Array.from({ length: votes }, () => ask(user).catch(() => null)));
        out.push({ id, scene: roles.find((x) => x.id === id)?.scene, reads });
      }));
    }
    const dir = join(CACHE, "anatomy-seven"); mkdirSync(dir, { recursive: true });
    const label = arg("label", "s1");
    writeFileSync(join(dir, `seven-${label}.json`), JSON.stringify(out, null, 1));
    // 場面ごとの傾向（1回目の読み）: 押す・強さ・訴求あり・潜在が具体・押さえ方と信頼の作り方の多い順
    const agg = new Map<string, { n: number; push: number; strong: number; appeal: number; concrete: number; how: Map<string, number>; trust: Map<string, number> }>();
    const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const o of out) {
      const r = (o.reads as Array<import("../app/lib/takeuchi-seven-read").SevenRead | null>)[0];
      if (!r) continue;
      const k = String(o.scene);
      const a = agg.get(k) ?? agg.set(k, { n: 0, push: 0, strong: 0, appeal: 0, concrete: 0, how: new Map(), trust: new Map() }).get(k)!;
      a.n++; if (r.push.push) a.push++; if (r.push.strength === "strong") a.strong++; if (r.appeal) a.appeal++; if (S.latentIsConcrete(r.latent?.what)) a.concrete++;
      r.point_how.forEach((x) => inc(a.how, x)); r.trust_how.forEach((x) => inc(a.trust, x));
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join("・");
    console.log(`# 7つの欄 ${label}: ${out.length}通・読めなかった ${out.filter((o) => !(o.reads as unknown[])[0]).length}・呼び出し ${calls}回`);
    for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${k} ${a.n}通: 押す ${a.push}（強 ${a.strong}）・訴求 ${a.appeal}・潜在が具体 ${a.concrete}｜押さえ方 ${top(a.how)}｜信頼 ${top(a.trust)}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
