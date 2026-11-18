// RAG の見張り（2026-11-15 作業員H・RAG_WATCH・既定 on）
// 実行: npx tsx app/lib/__tests__/rag-watch.test.ts
import { ragWatchOn, ragRpcName, topSimilarity, ragArgsMeta, buildRagRow, wrapFetchWithRagWatch, ragWatchStats, ragWatchFindings, type RagCallRow } from "../rag-watch";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };

(async () => {
  t("既定 on・=off で止める（11/15）", ragWatchOn({}) && !ragWatchOn({ RAG_WATCH: "off" }));
  t("RPC の名前: match_* だけ", ragRpcName(new URL("https://x.supabase.co/rest/v1/rpc/match_takeuchi_compose")) === "match_takeuchi_compose" && ragRpcName(new URL("https://x.supabase.co/rest/v1/rpc/get_stats")) === null && ragRpcName(new URL("https://x.supabase.co/rest/v1/messages?select=*")) === null);
  t("近さ: similarity / score の最大", topSimilarity([{ similarity: 0.61 }, { similarity: 0.7234 }]) === 0.723 && topSimilarity([{ score: 0.5 }]) === 0.5 && topSimilarity([{ id: 1 }]) === null && topSimilarity([]) === null && topSimilarity([{ distance: 0.2 }, { distance: 0.3 }]) === 0.8);
  t("引数: 件数と名前だけ（値は残さない）", JSON.stringify(ragArgsMeta(JSON.stringify({ query_embedding: [0.1], match_count: 8, p_scene: "内覧" }))) === JSON.stringify({ match_count: 8, arg_keys: ["match_count", "p_scene", "query_embedding"] }));
  // 11/15 の match_takeuchi_compose の形: 200 で [] が返る
  const empty = buildRagRow({ rpc: "match_takeuchi_compose", route: "/api/generate-reply", status: 200, json: [], ms: 120, body: "{}" });
  t("0件は ok で rows 0", empty.ok && empty.rows === 0 && empty.top_sim === null);
  const bad = buildRagRow({ rpc: "match_takeuchi_compose", route: null, status: 404, json: { code: "42883", message: "function extensions.vector_cosine does not exist" }, ms: 30, body: "{}" });
  t("失敗は ok=false・短い文", !bad.ok && bad.rows === null && (bad.error ?? "").startsWith("42883"));
  // 包み: 応答の中身は変えない・match_* でない物は見ない
  const rows: RagCallRow[] = [];
  const pend: Promise<unknown>[] = [];
  const fake = async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("match_") ? [{ similarity: 0.8 }, { similarity: 0.6 }] : { a: 1 }), { status: 200 });
  const w = wrapFetchWithRagWatch(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pend.push(p); }, route: () => "/api/x", env: "test" });
  const r1 = await w("https://x.supabase.co/rest/v1/rpc/match_reply_examples", { method: "POST", body: JSON.stringify({ match_count: 5 }) });
  const j1 = await r1.json();
  await w("https://x.supabase.co/rest/v1/messages", {});
  await Promise.all(pend);
  t("包み: 応答はそのまま読める", Array.isArray(j1) && j1.length === 2);
  t("包み: match_* だけ1行・件数・近さ・route", rows.length === 1 && rows[0].rpc === "match_reply_examples" && rows[0].rows === 2 && rows[0].top_sim === 0.8 && rows[0].route === "/api/x" && rows[0].match_count === 5, rows);
  const thrower = async () => { throw new Error("timeout"); };
  const w2 = wrapFetchWithRagWatch(thrower, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pend.push(p); }, route: () => null, env: null });
  let threw = false;
  try { await w2("https://x.supabase.co/rest/v1/rpc/match_conductor_focus", {}); } catch { threw = true; }
  await Promise.all(pend);
  t("包み: 投げた時は投げ直し・status 0 で1行", threw && rows.length === 2 && rows[1].status === 0 && !rows[1].ok);
  // 拾い上げ
  const mk = (rpc: string, n: number, f: (i: number) => Partial<RagCallRow>) => Array.from({ length: n }, (_, i) => ({ rpc, ok: true, rows: 3, top_sim: 0.7, ms: 200, route: "/api/generate-reply", ...f(i) }));
  const st = ragWatchStats([...mk("match_takeuchi_compose", 6, () => ({ rows: 0, top_sim: null })), ...mk("match_reply_examples", 20, () => ({})), ...mk("match_conductor_focus", 5, (i) => ({ ms: i < 2 ? 200 : 9000 }))]);
  const fs = ragWatchFindings(st, { match_winning_patterns: 12, match_reply_examples: 30 });
  t("拾い上げ: 全部0件（11/15 の形）", fs.some((f) => f.rpc === "match_takeuchi_compose" && f.kind === "always_empty"));
  t("拾い上げ: 遅い（時間切れの手前）", fs.some((f) => f.rpc === "match_conductor_focus" && f.kind === "slow"));
  t("拾い上げ: 前の日は呼ばれ今日は0回", fs.some((f) => f.rpc === "match_winning_patterns" && f.kind === "silent"));
  t("拾い上げ: 普通の物は出さない", !fs.some((f) => f.rpc === "match_reply_examples"));
  console.log(`\n${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
})();
// 11/18: 同じ問いを60秒だけ置く（RAG_RPC_CACHE・既定 on）
import("../rag-watch").then(async ({ RagRpcCache, ragRpcCacheOn, wrapFetchWithRagWatch }) => {
  let calls = 0; const rows: Array<{ route: string | null; ms: number }> = []; const pend: Promise<unknown>[] = [];
  let clock = 1_000;
  const fake = async () => { calls++; return new Response(JSON.stringify([{ similarity: 0.9 }]), { status: 200 }); };
  const w = wrapFetchWithRagWatch(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pend.push(p); }, route: () => "/api/x", env: null, now: () => clock, cache: new RagRpcCache(60_000, 200) });
  const u = "https://x.supabase.co/rest/v1/rpc/match_reply_knowledge";
  const b = JSON.stringify({ query_embedding: [0.1], match_count: 8 });
  await (await w(u, { method: "POST", body: b })).json(); await Promise.all(pend);
  clock += 10_000; const r2 = await (await w(u, { method: "POST", body: b })).json(); await Promise.all(pend);
  clock += 61_000; await (await w(u, { method: "POST", body: b })).json(); await Promise.all(pend);
  await (await w(u, { method: "POST", body: JSON.stringify({ query_embedding: [0.2], match_count: 8 }) })).json(); await Promise.all(pend);
  const ok = ragRpcCacheOn({}) && !ragRpcCacheOn({ RAG_RPC_CACHE: "off" })
    && calls === 3 && Array.isArray(r2) && (r2 as unknown[]).length === 1 && rows.some((r) => r.route === "/api/x(cache)" && r.ms === 0);
  console.log(ok ? "  OK  同じ問いは60秒だけ置く・過ぎたら読み直す・違う問いは読む" : `  NG  キャッシュ calls=${calls}`);
  const c = new RagRpcCache(60_000, 2); c.set("a", "1", 0); c.set("b", "2", 0); c.set("c", "3", 0);
  const ok2 = c.size === 2 && c.get("a", 1) === null && c.get("c", 1) === "3";
  console.log(ok2 ? "  OK  置く数の上限（古い物から外す）" : "  NG  上限");
  if (!ok || !ok2) process.exit(1);
});
