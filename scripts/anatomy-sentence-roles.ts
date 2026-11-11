// scripts/anatomy-sentence-roles.ts — 竹内さんの1通を1文ずつの役目に読み（3回の多数）、場面×重点ごとの役目の並びの型・誘導先・その後を数える（作業員5・11/11）
//   竹内さんの決定 KB P1 e94d6d27（1通は役目の違う部品の組み合わせ）。純関数は app/lib/takeuchi-anatomy-roles.ts。
//   テストの決まり（memory/test_protocol_brain.md）: setupLlmTest を最初に・LLM_TEST_MODE=deepseek-all・材料は伏せ済みの body・customer_gist と写しの状況の文 v2 だけ。
//   申込の書類以降の言葉を含む番は外す。既定は DB に書かない（--apply で anatomy.roles に足すだけ・他の項目は触らない）。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-sentence-roles.ts --per=22 --votes=3 --cap-usd=1 [--label=r1] [--apply]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");
const NG = /申込(フォーマット|書)|本人確認|免許証|マイナンバー|審査(結果|が通|に通|落ち)|契約書|重要事項|源泉|収入証明/;

(async () => {
  const h = await setupLlmTest("anatomy-sentence-roles");
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const R = await import("../app/lib/takeuchi-anatomy-roles");
    h.assertYuma(YUMA_CONVERSATION_ID, "文ごとの役目の解剖");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    // 写しの番（場面は resolveReplyScene・状況の文 v2）から場面ごとに偏りなく
    const turnsFile = join(CACHE, "conductor-focus", "turns-2026-11-04.json");
    const turns = JSON.parse(readFileSync(turnsFile, "utf8")) as Array<{ id: string; conv: string; at: string; scene: string; route: string; aix: string | null; v2: string }>;
    const per = Number(arg("per", "22"));
    type Row = { message_id: string; body: string; customer_gist: string | null; anatomy: Record<string, unknown> | null };
    const rows = new Map<string, Row>();
    for (let i = 0; i < turns.length; i += 100) {
      const { data, error } = await sb.from("takeuchi_compose_examples").select("message_id, body, customer_gist, anatomy").in("message_id", turns.slice(i, i + 100).map((t) => t.id));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) rows.set(r.message_id, r);
    }
    const byScene = new Map<string, typeof turns>();
    for (const t of turns) {
      const r = rows.get(t.id);
      if (!r || !r.body || NG.test(`${r.body}\n${r.customer_gist ?? ""}\n${t.v2}`)) continue;
      if (R.splitSentences(r.body).length < 2) continue; // 1文だけの番は組み合わせが無い
      (byScene.get(t.scene) ?? byScene.set(t.scene, []).get(t.scene)!).push(t);
    }
    // 重点（3票の解剖の focus）が偏らないように、場面の中で重点ごとに順に取る
    const pick: typeof turns = [];
    for (const [, l] of byScene) {
      const g = new Map<string, typeof turns>();
      for (const t of l.sort((a, b) => b.at.localeCompare(a.at))) { const f = String(rows.get(t.id)?.anatomy?.focus ?? "?"); (g.get(f) ?? g.set(f, []).get(f)!).push(t); }
      const lists = [...g.values()]; let k = 0; const got: typeof turns = [];
      while (got.length < per && lists.some((x) => x[k])) { for (const x of lists) if (x[k] && got.length < per) got.push(x[k]); k++; }
      pick.push(...got);
    }
    console.log(`選んだ ${pick.length}通（場面 ${byScene.size}・場面ごとに最大 ${per}）`);
    const votes = Math.max(1, Math.min(5, Number(arg("votes", "3")) || 3));
    const capUsd = Number(arg("cap-usd", "1")) || 1;
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    let calls = 0;
    const ask = async (user: string, n: number) => {
      calls++;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_anatomy", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 900, system: R.ROLES_SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) return null;
      const d = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return R.parseRoles(d.content?.find((b) => b.type === "text")?.text ?? "", n);
    };
    // その後（14日以内に内覧・申込に進んだか）: messages で会話の id → outcome_events
    const convOf = new Map<string, string>();
    for (let i = 0; i < pick.length; i += 100) {
      const { data } = await sb.from("messages").select("id, conversation_id").in("id", pick.slice(i, i + 100).map((t) => t.id));
      for (const m of (data ?? []) as Array<{ id: string; conversation_id: string }>) convOf.set(String(m.id), String(m.conversation_id));
    }
    const ev = new Map<string, Array<{ at: string; kind: string }>>();
    const convs = [...new Set(convOf.values())];
    for (let i = 0; i < convs.length; i += 100) {
      const { data } = await sb.from("outcome_events").select("conversation_id, at, kind").in("conversation_id", convs.slice(i, i + 100)).in("kind", ["viewing_scheduled", "viewing_held", "applied", "won"]).range(0, 999);
      for (const e of (data ?? []) as Array<{ conversation_id: string; at: string; kind: string }>) (ev.get(e.conversation_id) ?? ev.set(e.conversation_id, []).get(e.conversation_id)!).push(e);
    }
    const after = (t: { id: string; at: string }) => {
      const es = (ev.get(convOf.get(t.id) ?? "") ?? []).filter((e) => e.at > t.at && Date.parse(e.at) - Date.parse(t.at) <= 14 * 86_400_000);
      return es.some((e) => e.kind === "applied" || e.kind === "won") ? "apply" : es.length ? "viewing" : "none";
    };
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < pick.length; i += 5) {
      if ((calls + 5 * votes) * 0.0009 > capUsd) { console.log(`費用の上限 $${capUsd} の見込みで止めた（${i}/${pick.length}通）`); break; }
      await Promise.all(pick.slice(i, i + 5).map(async (t) => {
        const r = rows.get(t.id)!;
        const sentences = R.splitSentences(r.body).slice(0, 20);
        const user = R.rolesPrompt({ maskedCustomer: r.customer_gist, sentences, scene: t.scene, situation: t.v2 });
        const reads = await Promise.all(Array.from({ length: votes }, () => ask(user, sentences.length).catch(() => null)));
        const m = R.majorityRoles(reads, sentences.length);
        const pattern = R.rolePattern(m.roles.map((x) => x.role));
        out.push({ id: t.id, scene: t.scene, route: t.route, aix: t.aix, focus: r.anatomy?.focus ?? null, sentences, ...m, pattern, after: after(t), customer: (r.customer_gist ?? "").slice(0, 120) });
        if (process.argv.includes("--apply") && r.anatomy) {
          const up = await sb.from("takeuchi_compose_examples").update({ anatomy: { ...r.anatomy, roles: { v: 1, roles: m.roles, main_role: m.main_role, lead_to: m.lead_to, background: m.background, pattern } } }).eq("message_id", t.id);
          if (up.error) throw new Error(up.error.message);
        }
      }));
    }
    const dir = join(CACHE, "anatomy-roles"); mkdirSync(dir, { recursive: true });
    const label = arg("label", "r1");
    writeFileSync(join(dir, `roles-${label}.json`), JSON.stringify(out, null, 1));
    // 場面×重点ごとの型（多い順）・誘導先・その後
    const agg = new Map<string, { n: number; pat: Map<string, number>; lead: Map<string, number>; after: Map<string, number> }>();
    const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const o of out) {
      const k = `${o.scene}×${o.focus ?? "?"}`;
      const a = agg.get(k) ?? agg.set(k, { n: 0, pat: new Map(), lead: new Map(), after: new Map() }).get(k)!;
      a.n++; inc(a.pat, String(o.pattern).replace(/^greet>/, "")); inc(a.lead, String(o.lead_to)); inc(a.after, String(o.after));
    }
    const top = (m: Map<string, number>, n = 3) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join("・");
    console.log(`# 文ごとの役目 ${label}: ${out.length}通・割れた文 ${out.reduce((s, o) => s + Number(o.splitSentences), 0)}/${out.reduce((s, o) => s + (o.sentences as string[]).length, 0)}（うち2回以上読めなかった通の文 ${out.filter((o) => Number(o.failedReads) >= 2).reduce((s, o) => s + Number(o.splitSentences), 0)}）${process.argv.includes("--apply") ? "・DB に書いた" : "・書いていない"}`);
    for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${k} ${a.n}通: 型 ${top(a.pat)}｜誘導 ${top(a.lead)}｜その後 ${top(a.after)}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
