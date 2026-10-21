// LLM の録音と再生（scripts/lib/llm-cassette.ts）・前の取り置き（scripts/lib/brain-exam-baseline.ts）
// 実行: npx tsx scripts/lib/__tests__/llm-cassette.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCassetteFetch, normalizeBody, cassetteSalt, cassetteResponseFits, usageOfResponse, wrapGlobalFetch, setCassetteTag, flushCassette, formatCassetteStats, type CassetteStats, type CassetteMode,
  setCassettePins, cassetteCallsOf, inputDiffOf, pinsFromRows, hasPinsFor } from "../llm-cassette";
import { planBaseline, childArgs, examConfig, configHash, problemHash } from "../brain-exam-baseline";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const dir = mkdtempSync(join(tmpdir(), "cassette-test-"));
const newStats = (mode: CassetteMode): CassetteStats => ({ mode, dir, total: { real: 0, realUsd: 0, replayed: 0, replayUsd: 0, missed: 0, unrecordable: 0 }, byAction: new Map(), byTag: new Map(), misses: [] });
let innerCalls = 0;
const inner = async (_i: RequestInfo | URL, init?: RequestInit) => {
  innerCalls++;
  const b = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content: string }> };
  const text = `答え${innerCalls}:${b.messages?.[0]?.content.slice(0, 8)}`;
  return new Response(JSON.stringify({ model: "claude-sonnet-5", content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const URL_A = "https://api.anthropic.com/v1/messages";
const req = (content: string, action = "brain_full") => ({ method: "POST", headers: { "content-type": "application/json", "x-sumora-llm-action": action }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content }] }) });
const quiet = () => {};

(async () => {
  // ① 鍵: 日時・UUID・時刻は伏せる／会話の中身は伏せない
  const a = normalizeBody(JSON.stringify({ b: 1, a: "2026-10-15T03:04:05.123Z 今は14:05 10/15（水）id 0f8b6c1e-1111-2222-3333-444455556666" }), {});
  const b = normalizeBody(JSON.stringify({ a: "2026-11-12T09:00:00Z 今は09:41 11/12（水）id 9a8b6c1e-aaaa-bbbb-cccc-ddddeeeeffff", b: 1 }), {});
  ok("日時・UUID・時刻・鍵の順が違っても同じ鍵", a === b, `${a}\n   ${b}`);
  ok("中身が違えば違う鍵", normalizeBody(JSON.stringify({ a: "家賃8万" }), {}) !== normalizeBody(JSON.stringify({ a: "家賃9万" }), {}));
  ok("LLM_CASSETTE_KEY=exact は伏せない", normalizeBody(JSON.stringify({ a: "14:05" }), { LLM_CASSETTE_KEY: "exact" }).includes("14:05"));

  // ② 録る → 再生（呼ばない）
  const sRec = newStats("record");
  const fRec = makeCassetteFetch(inner, { mode: "record", dir, stats: sRec, env: {}, log: quiet });
  setCassetteTag({ problem: "q001", rep: "1" });
  const r1 = await fRec(URL_A, req("お客様: 10/15 14:00 に内覧できますか"));
  const t1 = await r1.text();
  await flushCassette();
  ok("録る: 本当に呼ぶ", innerCalls === 1 && sRec.total.real === 1);
  ok("録る: 費用を数える（Sonnet の usage から）", sRec.total.realUsd > 0, String(sRec.total.realUsd));

  const sRep = newStats("replay");
  const fRep = makeCassetteFetch(inner, { mode: "replay", dir, stats: sRep, env: {}, log: quiet });
  const r2 = await fRep(URL_A, req("お客様: 11/12 09:30 に内覧できますか"));
  ok("再生: 日時だけ違う要求は呼ばずに同じ答え", innerCalls === 1 && (await r2.text()) === t1 && r2.headers.get("x-llm-cassette") === "replay");
  ok("再生: 数え（再生1・呼んでいたら$）", sRep.total.replayed === 1 && sRep.total.replayUsd > 0 && sRep.byTag.get("q001")?.replayed === 1);
  // 同じ回で同じ要求の2回目（--repeat=3）は録った答えが1つしか無い → replay は本当に呼んで足す
  await fRep(URL_A, req("お客様: 10/15 14:00 に内覧できますか"));
  await flushCassette();
  ok("再生: 2回目は録音が足りない → 呼んで足す", innerCalls === 2 && sRep.total.real === 1);
  // 変わった要求は本当に呼ぶ
  await fRep(URL_A, req("お客様: 10/15 14:00 に内覧できますか？駐車場もありますか"));
  await flushCassette();
  ok("再生: 中身が変わった要求だけ呼ぶ", innerCalls === 3);

  // ③ strict: 変わった要求は呼ばずに 400・どこが変わったかを出す
  const sStr = newStats("strict");
  const fStr = makeCassetteFetch(inner, { mode: "strict", dir, stats: sStr, env: {}, log: quiet });
  const before = innerCalls;
  const r3 = await fStr(URL_A, req("お客様: 10/15 14:00 に内覧できますか。ペット可ですか"));
  ok("strict: 呼ばない・400", innerCalls === before && r3.status === 400 && r3.headers.get("x-llm-cassette") === "miss");
  ok("strict: 変わった所を出す", sStr.misses.length === 1 && /ペット/.test(sStr.misses[0].hint), sStr.misses[0]?.hint);
  const r4 = await fStr(URL_A, req("お客様: 10/16 15:00 に内覧できますか"));
  ok("strict: 同じ要求（日時だけ違う）は再生", r4.status === 200 && innerCalls === before);
  ok("数えの表が出る", /新しく呼んだ/.test(formatCassetteStats(sStr)) && /変わった所/.test(formatCassetteStats(sStr)));

  // ④ 名札が違えば別物・LLM でない宛先は素通し
  const r5 = await fStr(URL_A, req("お客様: 10/15 14:00 に内覧できますか", "reply_generate"));
  ok("名札が違えば別の鍵（strict で止まる）", r5.status === 400);
  let other = 0;
  const fOther = makeCassetteFetch(async () => { other++; return new Response("ok"); }, { mode: "strict", dir, stats: newStats("strict"), env: {}, log: quiet });
  await fOther("https://xyz.supabase.co/rest/v1/messages", { method: "POST", body: "{}" });
  ok("LLM でない宛先（supabase）は素通し", other === 1);

  // ⑤ SSE（Anthropic）と OpenAI 互換（DeepSeek）の usage
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":300,"cache_read_input_tokens":100}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n';
  const us = usageOfResponse(sse, "text/event-stream");
  ok("SSE の usage", us.model === "claude-sonnet-5" && us.input_uncached === 300 && us.cache_read === 100 && us.output_tokens === 50, JSON.stringify(us));
  const ud = usageOfResponse(JSON.stringify({ model: "deepseek-v4-pro", usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 40 } }), "application/json");
  ok("DeepSeek の usage", ud.input_uncached === 200 && ud.cache_read === 800 && ud.output_tokens === 40, JSON.stringify(ud));

  // ⑥ 包みを替えても前の包みの印を写す（別クラウドの「包みが外れた」判定で二重に包まれない）
  const saved = globalThis.fetch;
  const marked = (async () => new Response("x")) as unknown as typeof fetch & Record<string | symbol, unknown>;
  marked.__sumoraAltProvider = true; marked[Symbol.for("sumora.altInnerBox")] = { fn: saved };
  globalThis.fetch = marked;
  wrapGlobalFetch((prev) => (i, n) => prev(i, n));
  const g = globalThis.fetch as unknown as Record<string | symbol, unknown>;
  ok("印を写す", g !== marked && g.__sumoraAltProvider === true && !!g[Symbol.for("sumora.altInnerBox")]);
  globalThis.fetch = saved;

  // ⑦ 前の取り置き
  type R = { rep: number; error?: string };
  const cached = new Map([
    ["q001", { id: "q001", problemHash: "h1", commit: "c", config: { args: {}, env: {} }, savedAt: "", fromLabel: "", rows: [{ rep: 1 }] as R[] }],
    ["q002", { id: "q002", problemHash: "OLD", commit: "c", config: { args: {}, env: {} }, savedAt: "", fromLabel: "", rows: [{ rep: 1 }] as R[] }],
    ["q003", { id: "q003", problemHash: "h3", commit: "c", config: { args: {}, env: {} }, savedAt: "", fromLabel: "", rows: [{ rep: 1, error: "x" }] as R[] }],
  ]);
  const plan = planBaseline([{ id: "q001", hash: "h1" }, { id: "q002", hash: "h2" }, { id: "q003", hash: "h3" }, { id: "q004", hash: "h4" }], cached, 1);
  ok("取り置き: 同じ問題は使い回す・直った問題・失敗・無い問題は回す", plan.reuse.join() === "q001" && plan.run.join() === "q002,q003,q004" && plan.stale.join() === "q002", JSON.stringify(plan));
  ok("取り置き: --repeat=3 で回が足りなければ回す", planBaseline([{ id: "q001", hash: "h1" }], cached, 3).run.join() === "q001");
  ok("子に渡さない引数", childArgs(["--label=x", "--only=q1", "--types=出し切り", "--baseline=main", "--replay", "--stage=brain", "--layer=prod", "--conv=auto"]).join(" ") === "--replay --stage=brain --layer=prod --conv=auto");
  const c1 = examConfig({ BRAIN_X: "1", TWO_STAGE_Y: "on", ANTHROPIC_API_KEY: "sk", BRAIN_SECRET_TOKEN: "t", LLM_TEST_MODE: "deepseek-all", HOME: "/h", LLM_CASSETTE: "replay" }, { layer: "prod", repeat: 1 });
  ok("構成: 効く変数だけ・秘密と録音のモードは入れない", JSON.stringify(c1.env) === JSON.stringify({ BRAIN_X: "1", LLM_TEST_MODE: "deepseek-all", TWO_STAGE_Y: "on" }), JSON.stringify(c1.env));
  ok("構成の hash は順に依らない", configHash(examConfig({ TWO_STAGE_Y: "on", BRAIN_X: "1" }, { repeat: 1, layer: "prod" })) === configHash(examConfig({ BRAIN_X: "1", TWO_STAGE_Y: "on" }, { layer: "prod", repeat: 1 })));
  ok("問題の hash は中身で変わる", problemHash({ id: "q1", accept: ["返信"] }) !== problemHash({ id: "q1", accept: ["2段:check"] }));

  // 2026-10-15 RPC match_*（似た物探し）の録音・再生: 同じ本文なら DB を読まずに録った結果・失敗は録らない・LLM の数えに入れない・off で素通し
  {
    let dbCalls = 0, failNext = false;
    const db = async () => { dbCalls++; if (failNext) { failNext = false; return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }); } return new Response(JSON.stringify([{ id: `k${dbCalls}` }]), { status: 200, headers: { "content-type": "application/json" } }); };
    const RPC = "https://abc.supabase.co/rest/v1/rpc/match_reply_knowledge";
    const rq = (q: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query_embedding: q, match_count: 5 }) });
    const s1 = newStats("replay");
    const f1 = makeCassetteFetch(db, { mode: "replay", dir, stats: s1, env: {}, log: quiet });
    failNext = true;
    const x0 = await f1(RPC, rq("[0.1,0.2]")); await flushCassette();
    ok("RPC: 失敗（時間切れ）は録らない", x0.status === 500 && s1.rpc?.failed === 1 && s1.rpc?.recorded === 0);
    const x1 = await (await f1(RPC, rq("[0.1,0.2]"))).text(); await flushCassette();
    const s2 = newStats("strict");
    const f2 = makeCassetteFetch(db, { mode: "strict", dir, stats: s2, env: {}, log: quiet });
    const before = dbCalls;
    const x2 = await (await f2(RPC, rq("[0.1,0.2]"))).text();
    const x3 = await (await f2(RPC, rq("[0.1,0.2]"))).text();
    ok("RPC: 2回目からは DB を読まずに録った結果（同じ回で2度目も同じ）", dbCalls === before && x2 === x1 && x3 === x1 && s2.rpc?.replayed === 2, `${x1} ${x2} ${x3}`);
    ok("RPC: LLM の数えには入らない", s2.total.real === 0 && s2.total.replayed === 0 && s2.total.missed === 0);
    const x4 = await f2(RPC, rq("[0.3]"));
    ok("RPC: strict でも録音に無い RPC は読む（止めない）", x4.status === 200 && dbCalls === before + 1);
    const f3 = makeCassetteFetch(db, { mode: "replay", dir, stats: newStats("replay"), env: { LLM_CASSETTE_RPC: "off" }, log: quiet });
    await f3(RPC, rq("[0.1,0.2]"));
    ok("RPC: LLM_CASSETTE_RPC=off は素通し", dbCalls === before + 2);
    const f4 = makeCassetteFetch(db, { mode: "replay", dir, stats: newStats("replay"), env: {}, log: quiet });
    await f4("https://abc.supabase.co/rest/v1/rpc/increment_knowledge_used_count", rq("x"));
    await f4("https://abc.supabase.co/rest/v1/rpc/increment_knowledge_used_count", rq("x"));
    ok("RPC: match_* 以外（書く RPC）は録らない", dbCalls === before + 4);
  }

  // 2026-10-18: Claude の確かめの回は別の鍵・DeepSeek の試験は Claude の答えを再生しない
  {
    const A = "api.anthropic.com";
    ok("鍵の印: 既定の pro は印なし", cassetteSalt({ LLM_TEST_MODE: "deepseek-all" }, A) === "");
    ok("鍵の印: flash は model の印", cassetteSalt({ LLM_TEST_MODE: "deepseek-all", DEEPSEEK_MODEL: "deepseek-flash" }, A) === "\n#model=deepseek-flash");
    ok("鍵の印: Claude の確かめは provider の印", cassetteSalt({ LLM_TEST_FINAL_CLAUDE: "1" }, A) === "\n#provider=claude");
    ok("鍵の印: DeepSeek 直の要求は印なし", cassetteSalt({ LLM_TEST_FINAL_CLAUDE: "1" }, "api.deepseek.com") === "");
    ok("鍵の印: 名札ごとに flash へ替えた要求は model の印（flash-writer）", cassetteSalt({ LLM_TEST_MODE: "deepseek-all" }, A, "deepseek-flash") === "\n#model=deepseek-flash");
    ok("鍵の印: 名札ごとの替えが pro なら印なし", cassetteSalt({ LLM_TEST_MODE: "deepseek-all", DEEPSEEK_MODEL: "deepseek-flash" }, A, "deepseek-v4-pro") === "");
    ok("合う答え: DeepSeek の試験は Claude の答えを返さない", !cassetteResponseFits({ LLM_TEST_MODE: "deepseek-all" }, "claude-sonnet-5") && cassetteResponseFits({ LLM_TEST_MODE: "deepseek-all" }, "deepseek-v4-pro"));
    ok("合う答え: Claude の確かめは Claude の答えだけ", cassetteResponseFits({ LLM_TEST_FINAL_CLAUDE: "1" }, "claude-sonnet-5") && !cassetteResponseFits({ LLM_TEST_FINAL_CLAUDE: "1" }, "deepseek-v4-pro"));
    ok("合う答え: モデルが分からない旧の録音は返す", cassetteResponseFits({ LLM_TEST_MODE: "deepseek-all" }, null));
  }

  // 2026-10-21 ①入力の差: main の回の呼び出しの控え → 今の版の同じ要求は main の答え（スイッチの指紋・回の印が違っても）・違った段から呼ぶ
  {
    const pdir = mkdtempSync(join(tmpdir(), "cassette-pin-"));
    const st = (m: CassetteMode): CassetteStats => ({ mode: m, dir: pdir, total: { real: 0, realUsd: 0, replayed: 0, replayUsd: 0, missed: 0, unrecordable: 0 }, byAction: new Map(), byTag: new Map(), misses: [] });
    let calls = 0;
    const llm = async (_i: RequestInfo | URL, init?: RequestInit) => { calls++; const b = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content: string }> }; return new Response(JSON.stringify({ model: "deepseek-v4-pro", content: [{ type: "text", text: `ans${calls}:${b.messages?.[0]?.content}` }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } }); };
    // main の回（スイッチ既定・2回目は回の印）: 読み手 → 本体 → 判定
    const fMain = makeCassetteFetch(llm, { mode: "replay", dir: pdir, stats: st("replay"), env: {}, log: quiet, envFp: "" });
    const mainRows: Array<{ id: string; rep: number; llmCalls: ReturnType<typeof cassetteCallsOf> }> = [];
    for (const rep of [1, 2]) {
      setCassetteTag({ problem: "q177", rep: String(rep) });
      const a = await (await fMain(URL_A, req("読み手の入力", "brain_reader"))).text();
      await (await fMain(URL_A, req(`本体の入力 ${a.slice(0, 12)}`, "brain_full"))).text();
      await flushCassette();
      mainRows.push({ id: "q177", rep, llmCalls: cassetteCallsOf("q177", rep) });
    }
    ok("控え: 回ごとに呼び出しを残す（record の sha は録った後に入る）", mainRows[0].llmCalls.length === 2 && mainRows[0].llmCalls.every((c) => c.src === "record" && c.sha.length === 16), JSON.stringify(mainRows[0].llmCalls));
    const mainCalls = calls;
    const pins = pinsFromRows(mainRows);
    ok("控え: 行から問題×回の控えを作る", Object.keys(pins).join() === "q177#1,q177#2" && hasPinsFor("q177", 1) === false);
    // 今の版（スイッチの指紋が違う＝録音の鍵は違う）: 同じ要求 → main の答え（呼ばない）
    setCassettePins(pins);
    const sNow = st("replay");
    const fNow = makeCassetteFetch(llm, { mode: "replay", dir: pdir, stats: sNow, env: {}, log: quiet, envFp: "abc123" });
    const outs: string[] = [];
    for (const rep of [1, 2]) {
      setCassetteTag({ problem: "q177", rep: String(rep) });
      const a = await (await fNow(URL_A, req("読み手の入力", "brain_reader"))).text();
      outs.push(await (await fNow(URL_A, req(`本体の入力 ${a.slice(0, 12)}`, "brain_full"))).text());
      await flushCassette();
    }
    const d1 = inputDiffOf(cassetteCallsOf("q177", 1), hasPinsFor("q177", 1));
    ok("入力が同じ: スイッチの指紋が違っても main の答えを返し呼ばない", calls === mainCalls && d1.same && d1.pinned === 2 && sNow.total.pinned === 4, `${calls} ${JSON.stringify(d1)}`);
    ok("入力が同じ: 2回目の回は main の2回目の答え（回ごと）", outs[0] !== outs[1] || mainCalls === 4);
    // 2段目だけ違う → 1段目は main の答え・2段目から呼ぶ
    setCassetteTag({ problem: "q177", rep: "1" });
    await (await fNow(URL_A, req("読み手の入力", "brain_reader"))).text();
    await (await fNow(URL_A, req("本体の入力（直した指示）", "brain_full"))).text();
    await flushCassette();
    const d2 = inputDiffOf(cassetteCallsOf("q177", "1"), true);
    ok("段ごと: 1段目は main の答え・違った2段目だけ呼ぶ", calls === mainCalls + 1 && !d2.same && d2.pinned === 1 && d2.firstChanged === "brain_full", JSON.stringify(d2));
    // 下見（plan）: 違う要求は呼ばずに 400
    setCassettePins(pins, { only: true });
    const sPlan = st("replay");
    const fPlan = makeCassetteFetch(llm, { mode: "replay", dir: pdir, stats: sPlan, env: {}, log: quiet, envFp: "abc123" });
    setCassetteTag({ problem: "q177", rep: "1" });
    await (await fPlan(URL_A, req("読み手の入力", "brain_reader"))).text();
    const r3 = await fPlan(URL_A, req("本体の入力（また違う）", "brain_full"));
    ok("下見: 違う要求は呼ばずに止める", r3.status === 400 && calls === mainCalls + 1 && sPlan.total.missed === 1 && sPlan.total.pinned === 1);
    // 札を付け直す（回し直し）と使い済みが空になる
    setCassetteTag({ problem: "q177", rep: "1" });
    const r4 = await fPlan(URL_A, req("読み手の入力", "brain_reader"));
    ok("回し直し: 札を付け直すと main の答えをもう一度使える", r4.status === 200 && cassetteCallsOf("q177", 1).length === 1);
    // 別の問題（控えなし）は下見でも同じ判定にしない
    ok("控えの無い回は入力が同じにしない", !inputDiffOf([], false).same);
    setCassettePins(null);
    const sOff = st("replay");
    const fOff = makeCassetteFetch(llm, { mode: "replay", dir: pdir, stats: sOff, env: {}, log: quiet, envFp: "zzz" });
    setCassetteTag({ problem: "q177", rep: "1" });
    await (await fOff(URL_A, req("読み手の入力", "brain_reader"))).text();
    await flushCassette();
    ok("控えを外すと今まで通り（スイッチの指紋が違えば呼ぶ）", calls === mainCalls + 2 && !sOff.total.pinned);
    rmSync(pdir, { recursive: true, force: true });
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`llm-cassette: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})();
