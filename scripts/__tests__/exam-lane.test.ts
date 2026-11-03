// scripts/__tests__/exam-lane.test.ts — 試験のレーン（scripts/lib/exam-lane.ts）の確かめ（LLM も DB も使わない）
//   実行: npx tsx scripts/__tests__/exam-lane.test.ts
//   2026-11-04 作業員1・指揮役の了承: ①env の Proxy がレーンごとに分かれる ②録音の札・時計のずらしがレーンごと ③EXAM_CONCURRENCY が 1 の時は入れない ④レーンの割り当て
import { currentLane, makeLane, runInLane, readConcurrency, installLaneEnvProxy, uninstallLaneEnvProxy, laneEnvProxyInstalled, LaneLimiter, runLanes, RATE_LIMIT_RE } from "../lib/exam-lane";
import { installExamClock, setExamClockOffset, examClockOffset, realNow } from "../lib/exam-clock";
import { setCassetteTag, makeCassetteFetch, flushCassette, type CassetteStats } from "../lib/llm-cassette";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, detail = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${detail ? ` — ${detail}` : ""}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("── ③ EXAM_CONCURRENCY の読み方（1 の時は入れない）");
  t("無い＝1", readConcurrency({}) === 1);
  t("1＝1", readConcurrency({ EXAM_CONCURRENCY: "1" }) === 1);
  t("読めない＝1", readConcurrency({ EXAM_CONCURRENCY: "abc" }) === 1 && readConcurrency({ EXAM_CONCURRENCY: "0" }) === 1 && readConcurrency({ EXAM_CONCURRENCY: "-3" }) === 1);
  t("4＝4", readConcurrency({ EXAM_CONCURRENCY: "4" }) === 4);
  t("上限 6", readConcurrency({ EXAM_CONCURRENCY: "99" }) === 6);
  t("入れる前は Proxy でない", !laneEnvProxyInstalled());
  // brain-exam は readConcurrency>1 の時だけ installLaneEnvProxy を呼ぶ＝1 の時の process.env は本物のまま
  const realRef = process.env;

  console.log("── ① env の Proxy（レーンごとに分かれる）");
  process.env.EXAM_LANE_T_A = "real-a";
  process.env.EXAM_LANE_T_DEL = "real-del";
  delete process.env.EXAM_LANE_T_NEW;
  t("入れた", installLaneEnvProxy() && laneEnvProxyInstalled() && process.env !== realRef);
  t("2回目は入れない", !installLaneEnvProxy());
  t("外: 本物を読む", process.env.EXAM_LANE_T_A === "real-a");
  const l1 = makeLane(0, "YUMA2", {}), l2 = makeLane(1, "YUMA3", {});
  const seen: Record<string, unknown> = {};
  await Promise.all([
    runInLane(l1, async () => {
      process.env.EXAM_LANE_T_A = "lane1";
      process.env.EXAM_LANE_T_NEW = "n1";
      delete process.env.EXAM_LANE_T_DEL;
      await sleep(30);
      seen.a1 = process.env.EXAM_LANE_T_A; seen.n1 = process.env.EXAM_LANE_T_NEW;
      seen.del1 = process.env.EXAM_LANE_T_DEL; seen.delIn1 = "EXAM_LANE_T_DEL" in process.env;
      seen.keys1 = Object.keys(process.env).filter((k) => k.startsWith("EXAM_LANE_T_")).sort().join(",");
      seen.spread1 = ({ ...process.env } as Record<string, string | undefined>).EXAM_LANE_T_A;
      // setTimeout の先もレーンが付いて回る
      seen.timer1 = await new Promise((r) => setTimeout(() => r(process.env.EXAM_LANE_T_A), 5));
    }),
    runInLane(l2, async () => {
      await sleep(10);
      process.env.EXAM_LANE_T_A = "lane2";
      await sleep(40);
      seen.a2 = process.env.EXAM_LANE_T_A; seen.n2 = process.env.EXAM_LANE_T_NEW;
      seen.del2 = process.env.EXAM_LANE_T_DEL; seen.delIn2 = "EXAM_LANE_T_DEL" in process.env;
      process.env.EXAM_LANE_T_NUM = 5 as unknown as string;
      seen.num2 = process.env.EXAM_LANE_T_NUM;
    }),
  ]);
  t("レーン1 は自分の値", seen.a1 === "lane1", String(seen.a1));
  t("レーン2 は自分の値", seen.a2 === "lane2", String(seen.a2));
  t("レーン1 で足した鍵はレーン2 に見えない", seen.n1 === "n1" && seen.n2 === undefined);
  t("レーン1 で消した鍵はレーン1 だけ消える", seen.del1 === undefined && seen.delIn1 === false && seen.del2 === "real-del" && seen.delIn2 === true);
  t("Object.keys もレーンの形", seen.keys1 === "EXAM_LANE_T_A,EXAM_LANE_T_NEW", String(seen.keys1));
  t("{...process.env} もレーンの値", seen.spread1 === "lane1");
  t("setTimeout の先もレーンの値", seen.timer1 === "lane1");
  t("書いた値は文字列（本物の env と同じ）", seen.num2 === "5");
  t("外: 本物はそのまま", process.env.EXAM_LANE_T_A === "real-a" && process.env.EXAM_LANE_T_DEL === "real-del" && process.env.EXAM_LANE_T_NEW === undefined && realRef.EXAM_LANE_T_A === "real-a");
  t("外: レーンの書き込みは本物に入らない", realRef.EXAM_LANE_T_NUM === undefined && !("EXAM_LANE_T_NUM" in process.env));
  process.env.EXAM_LANE_T_OUT = "o";
  t("外で書くと本物に入る", realRef.EXAM_LANE_T_OUT === "o");
  t("外で書いた物はレーンからも見える（上書きが無い鍵）", runInLane(l1, () => process.env.EXAM_LANE_T_OUT) === "o");
  delete process.env.EXAM_LANE_T_OUT;
  t("外で消すと本物から消える", !("EXAM_LANE_T_OUT" in realRef));

  console.log("── ② 録音の札・時計のずらしはレーンごと");
  installExamClock();
  setExamClockOffset(0);
  const clock: Record<string, number> = {};
  await Promise.all([
    runInLane(l1, async () => { setExamClockOffset(3_600_000); await sleep(20); clock.o1 = examClockOffset(); clock.d1 = realNow() - Date.now(); }),
    runInLane(l2, async () => { await sleep(5); setExamClockOffset(60_000); await sleep(20); clock.o2 = examClockOffset(); clock.d2 = realNow() - new Date().getTime(); }),
  ]);
  t("レーン1 の時計は1時間戻る", clock.o1 === 3_600_000 && Math.abs(clock.d1 - 3_600_000) < 50, JSON.stringify(clock));
  t("レーン2 の時計は1分戻る", clock.o2 === 60_000 && Math.abs(clock.d2 - 60_000) < 50, JSON.stringify(clock));
  t("外の時計は戻らない", examClockOffset() === 0 && Math.abs(realNow() - Date.now()) < 50);
  setExamClockOffset(5000);
  t("外のずらしはレーンに効かない（レーンは自分の値）", runInLane(l1, () => examClockOffset()) === 3_600_000 && examClockOffset() === 5000);
  setExamClockOffset(0);
  for (const l of [l1, l2]) l.clockOffsetMs = 0;

  // 録音の札: 呼び出しの数え（byTag）が並べた問題ごとに分かれる
  const stats: CassetteStats = { mode: "off" as never, dir: "", total: { real: 0, realUsd: 0, replayed: 0, replayUsd: 0, missed: 0, unrecordable: 0 }, byAction: new Map(), byTag: new Map(), misses: [] };
  const inner = async () => { await sleep(10); return new Response(JSON.stringify({ model: "claude-sonnet-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); };
  const { mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "exam-lane-cas-"));
  stats.dir = dir; (stats as { mode: string }).mode = "record";
  const cf = makeCassetteFetch(inner, { mode: "record", dir, stats, env: {}, log: () => {}, transportFp: "", envFp: "" });
  const call = (c: string) => cf("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-sumora-llm-action": "brain_full" }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: c }] }) });
  setCassetteTag({ problem: "outside", rep: "1" });
  await Promise.all([
    runInLane(l1, async () => { setCassetteTag({ problem: "qA", rep: "1" }); await sleep(15); await call("a1"); await call("a2"); }),
    runInLane(l2, async () => { await sleep(5); setCassetteTag({ problem: "qB", rep: "1" }); await call("b1"); }),
  ]);
  await call("o1");
  await flushCassette(); // 数えは答えを録り終えた後（録る途中の約束）
  const realOf = (k: string) => stats.byTag.get(k)?.real ?? 0;
  t("レーン1 の呼び出しはレーン1 の問題に数える", realOf("qA") === 2, JSON.stringify([...stats.byTag].map(([k, v]) => [k, v.real])));
  t("レーン2 の呼び出しはレーン2 の問題に数える", realOf("qB") === 1);
  t("外の呼び出しは外の札に数える（レーンの札に変わらない）", realOf("outside") === 1, JSON.stringify([...stats.byTag].map(([k, v]) => [k, v]), null, 0) + " total=" + JSON.stringify(stats.total));
  t("レーンの札は持ち物に入る", l1.cassetteTag.problem === "qA" && l2.cassetteTag.problem === "qB");
  await flushCassette();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

  console.log("── ④ レーンの割り当て（同じ問題の回は1つのレーンで順に・レーンの中は列の順）");
  {
    const items = Array.from({ length: 9 }, (_, i) => `q${i + 1}`);
    const lanes = [0, 1, 2].map((i) => makeLane(i, `L${i}`, { log: [] as string[] }));
    const ran: Array<{ lane: number; item: string; rep: number }> = [];
    const took = await runLanes(items, lanes, async (item, lane) => {
      for (let rep = 1; rep <= 3; rep++) {
        t(`${item}#${rep} はレーンの中で回る`, currentLane() === lane);
        ran.push({ lane: lane.index, item, rep });
        await sleep(1 + ((item.charCodeAt(1) * 7 + rep) % 5));
      }
    });
    const all = took.flat();
    t("全部の問題が1回ずつ", all.length === 9 && new Set(all).size === 9);
    t("どのレーンも何かを回した", took.every((x) => x.length > 0), JSON.stringify(took));
    t("同じ問題の回は同じレーン", items.every((it) => new Set(ran.filter((r) => r.item === it).map((r) => r.lane)).size === 1));
    t("同じ問題の回は順に（1→2→3）", items.every((it) => ran.filter((r) => r.item === it).map((r) => r.rep).join() === "1,2,3"));
    t("レーンの中は列の順", took.every((xs) => xs.every((x, k) => k === 0 || items.indexOf(x) > items.indexOf(xs[k - 1]))));
    t("1本のレーンの中は同時に2問を回さない", lanes.every((l) => { const seq = ran.filter((r) => r.lane === l.index).map((r) => r.item); return seq.every((x, k) => k === 0 || x === seq[k - 1] || !seq.slice(k).includes(seq[k - 1])); }));
  }
  {
    // 1本だけ＝列の順のまま
    const items = ["a", "b", "c", "d"];
    const order: string[] = [];
    const took = await runLanes(items, [makeLane(0, "L0", {})], async (x) => { order.push(x); await sleep(1); });
    t("1本なら列の順そのまま", order.join() === "a,b,c,d" && took[0].join() === "a,b,c,d");
  }
  {
    // 止める印: "stop" を返したら次を取らない
    const items = ["a", "b", "c", "d", "e", "f"];
    const done: string[] = [];
    await runLanes(items, [makeLane(0, "L0", {}), makeLane(1, "L1", {})], async (x) => { await sleep(5); done.push(x); return x === "b" ? "stop" : undefined; });
    t("stop の後は新しい問題を取らない", !done.includes("e") && !done.includes("f"), done.join());
  }
  {
    // 1本が投げても他のレーンは回している問題を終える・最後に投げる
    const items = ["a", "b", "c", "d"];
    const done: string[] = [];
    let threw = "";
    try { await runLanes(items, [makeLane(0, "L0", {}), makeLane(1, "L1", {})], async (x) => { if (x === "a") throw new Error("boom"); await sleep(20); done.push(x); }); } catch (e) { threw = (e as Error).message; }
    t("失敗を投げる", threw === "boom");
    t("回していた問題は終える・新しい問題は取らない", done.join() === "b", done.join());
  }

  console.log("── ⑤ 429 で並べる数を減らす");
  {
    const lim = new LaneLimiter(4);
    t("初めは 4", lim.limit === 4 && lim.mayTake(3));
    t("429 が無ければ減らさない", !lim.atBoundary() && lim.limit === 4);
    lim.note429("a"); lim.note429("b"); lim.note429("c");
    t("何度見ても区切りで1つだけ減らす", lim.atBoundary() && lim.limit === 3 && !lim.mayTake(3) && lim.mayTake(2));
    t("次の区切りでは減らさない（新しい 429 が無い）", !lim.atBoundary() && lim.limit === 3);
    lim.noteError("DeepSeek 429: Too Many Requests"); lim.atBoundary();
    lim.noteError("ブレインが null"); lim.atBoundary();
    t("失敗の文の 429 で減らす・関係ない失敗では減らさない", lim.limit === 2, String(lim.limit));
    lim.note429(); lim.atBoundary(); lim.note429(); lim.atBoundary();
    t("1 より下には減らさない", lim.limit === 1 && lim.mayTake(0));
    t("減らした記録", lim.events.map((e) => `${e.from}→${e.to}`).join() === "4→3,3→2,2→1");
    t("429 らしい文の見分け", RATE_LIMIT_RE.test("rate limit exceeded") && RATE_LIMIT_RE.test("HTTP 429") && RATE_LIMIT_RE.test("Too Many Requests") && !RATE_LIMIT_RE.test("q429 の問題") && !RATE_LIMIT_RE.test("ブレインが null"));
    // レーンで: 429 の後は番号の大きいレーンが次を取らない
    const lim2 = new LaneLimiter(3);
    const items = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const took = await runLanes(items, [0, 1, 2].map((i) => makeLane(i, `L${i}`, {})), async (x) => { if (x === "p0") lim2.note429("x"); await sleep(5); }, { limiter: lim2 });
    t("429 の後はレーン3 が新しい問題を取らない", took[2].length <= 2 && took.flat().length === 12, JSON.stringify(took));
  }

  uninstallLaneEnvProxy();
  t("戻した", !laneEnvProxyInstalled() && process.env === realRef);
  for (const k of ["EXAM_LANE_T_A", "EXAM_LANE_T_DEL"]) delete process.env[k];

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
