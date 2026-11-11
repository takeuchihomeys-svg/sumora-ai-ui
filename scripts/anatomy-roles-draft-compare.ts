// scripts/anatomy-roles-draft-compare.ts — AI の下書きを竹内さんと同じ形（文ごとの役目・3回の多数）で読み、竹内さんの送信と比べる（作業員5・11/11）
//   KB P1 e94d6d27 ⑤（下書きの文ごとの役目が竹内さんと同じか・欠けた役目・余分な役目）。作業員6 の外れの型（書き手が余分を足す 563・言うべき事が足りない）とつなぐ物差し。
//   竹内さんの側は anatomy-sentence-roles.ts の結果（--roles=<roles-*.json>）か DB の anatomy.roles。下書きは line_watch_turns.draft_first（その番の最初の下書き）。
//   下書きは伏せてから渡す（お客様の名前→YUMA・maskPII・URL・電話・個人の値や英字の名前が残る通は外す）。申込の書類以降の言葉を含む番は外す。DB に書かない。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-roles-draft-compare.ts --days=14 --limit=40 --votes=3 --cap-usd=0.15 [--label=d1]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const NG = /申込(フォーマット|書)|本人確認|免許証|マイナンバー|審査(結果|が通|に通|落ち)|契約書|重要事項|源泉|収入証明/;

(async () => {
  const h = await setupLlmTest("anatomy-roles-draft-compare");
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const R = await import("../app/lib/takeuchi-anatomy-roles");
    const { maskPII } = await import("../app/lib/pii-mask");
    const { maskCustomerNames, customerNameTokens, staffHeadNames, leftLatinName } = await import("../app/lib/compose-name-mask");
    const { piiValueSignal, applicationMaterialReason } = await import("../app/lib/test-pii-guard");
    const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
    const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
    h.assertYuma(YUMA_CONVERSATION_ID, "下書きの文ごとの役目");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const days = Math.max(1, Math.min(30, Number(arg("days", "14")) || 14));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    // 竹内さんの送信（伏せ済み）と、同じ会話で前後3分のスタッフの最初の送信がある番の下書き
    const { data: ex, error } = await sb.from("takeuchi_compose_examples").select("message_id, sent_at, scene, body, customer_gist, anatomy").gte("sent_at", since).order("sent_at", { ascending: false }).range(0, 299);
    if (error) throw new Error(error.message);
    const exs = (ex ?? []) as Array<{ message_id: string; sent_at: string; scene: string; body: string; customer_gist: string | null; anatomy: Record<string, unknown> | null }>;
    const convOf = new Map<string, string>();
    for (let i = 0; i < exs.length; i += 100) {
      const { data } = await sb.from("messages").select("id, conversation_id").in("id", exs.slice(i, i + 100).map((r) => r.message_id));
      for (const m of (data ?? []) as Array<{ id: string; conversation_id: string }>) convOf.set(String(m.id), String(m.conversation_id));
    }
    const convs = [...new Set(convOf.values())];
    type Turn = { conversation_id: string; staff_first_at: string | null; draft_first: string | null };
    const turns: Turn[] = [];
    for (let i = 0; i < convs.length; i += 100) {
      const { data } = await sb.from("line_watch_turns").select("conversation_id, staff_first_at, draft_first").in("conversation_id", convs.slice(i, i + 100)).gte("customer_turn_at", since).not("draft_first", "is", null).range(0, 999);
      turns.push(...((data ?? []) as Turn[]));
    }
    const names = new Map<string, string[]>();
    for (let i = 0; i < convs.length; i += 100) {
      const { data } = await sb.from("conversations").select("id, customer_name, call_name").in("id", convs.slice(i, i + 100));
      for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null; call_name: string | null }>) names.set(c.id, customerNameTokens([c.customer_name, c.call_name]));
    }
    const pairs: Array<{ ex: (typeof exs)[number]; draft: string }> = [];
    let skipped = 0, gated = 0;
    const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
    for (const e of exs) {
      const conv = convOf.get(e.message_id); if (!conv) continue;
      const t = turns.filter((x) => x.conversation_id === conv && x.staff_first_at && Math.abs(Date.parse(x.staff_first_at) - Date.parse(e.sent_at)) <= 3 * 60_000)[0];
      if (!t?.draft_first) continue;
      // 2026-11-11 申込の手前の番だけ（turn-application-gate・その番の時刻で申込の記録を引き直す・読めなければ外す）。1会話ずつ間を空けて引く
      if (!recs.has(conv)) { recs.set(conv, await loadTurnApplicationRecords(sb, conv)); await new Promise((res) => setTimeout(res, 100)); }
      if (turnApplicationReason(recs.get(conv), e.sent_at) || applicationMaterialReason(e.customer_gist) || applicationMaterialReason(e.body)) { gated++; continue; }
      const raw = String(t.draft_first);
      const masked = maskPII(maskCustomerNames(raw, customerNameTokens([...(names.get(conv) ?? []), ...staffHeadNames([raw])]))).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
      if (NG.test(`${masked}\n${e.body}\n${e.customer_gist ?? ""}`) || piiValueSignal(masked) || leftLatinName(masked) || R.splitSentences(e.body).length < 2) { skipped++; continue; }
      pairs.push({ ex: e, draft: masked.slice(0, 600) });
      if (pairs.length >= Number(arg("limit", "40"))) break;
    }
    console.log(`比べる番 ${pairs.length}（外した ${skipped}・申込以降の疑いで外した ${gated}）`);
    const votes = Math.max(1, Math.min(5, Number(arg("votes", "3")) || 3));
    const capUsd = Number(arg("cap-usd", "0.15")) || 0.15;
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    let calls = 0;
    const ask = async (user: string, n: number) => {
      calls++;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_anatomy", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 900, system: R.ROLES_SYSTEM.replace("社長（竹内さん）の LINE の返信", "LINE の返信（下書き）"), messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) return null;
      const d = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return R.parseRoles(d.content?.find((b) => b.type === "text")?.text ?? "", n);
    };
    const readRoles = async (body: string, cust: string | null, scene: string) => {
      const s = R.splitSentences(body).slice(0, 20);
      const reads = await Promise.all(Array.from({ length: votes }, () => ask(R.rolesPrompt({ maskedCustomer: cust, sentences: s, scene }), s.length).catch(() => null)));
      return { s, m: R.majorityRoles(reads, s.length) };
    };
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < pairs.length; i += 3) {
      if ((calls + 6 * votes) * 0.001 > capUsd) { console.log(`費用の上限 $${capUsd} の見込みで止めた（${i}/${pairs.length}番）`); break; }
      await Promise.all(pairs.slice(i, i + 3).map(async ({ ex: e, draft }) => {
        const saved = (e.anatomy?.roles as { roles?: Array<{ role: string | null }> } | undefined)?.roles;
        const tk = saved ? { s: R.splitSentences(e.body), m: { roles: saved as Array<{ i: number; role: never; why: string | null }> } } : await readRoles(e.body, e.customer_gist, e.scene);
        const dr = await readRoles(draft, e.customer_gist, e.scene);
        const tr = tk.m.roles.map((x) => x.role), drr = dr.m.roles.map((x) => x.role);
        out.push({ id: e.message_id, scene: e.scene, takeuchi: R.rolePattern(tr), draft: R.rolePattern(drr), ...R.compareRoles(tr, drr), tkSentences: tk.s, drSentences: dr.s });
      }));
    }
    const dir = join(process.cwd(), "..", "..", "exam-cache", "anatomy-roles"); mkdirSync(dir, { recursive: true });
    const label = arg("label", "d1");
    writeFileSync(join(dir, `draft-compare-${label}.json`), JSON.stringify(out, null, 1));
    const cnt = (k: "missing" | "extra") => out.flatMap((o) => o[k] as string[]).reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    console.log(`# 下書きと竹内さんの文ごとの役目 ${label}: ${out.length}番・同じ ${out.filter((o) => o.same).length}・欠け ${JSON.stringify(cnt("missing"))}・余分 ${JSON.stringify(cnt("extra"))}・順番の違い ${out.filter((o) => o.orderDiff).length}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
