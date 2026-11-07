// scripts/conductor-focus-replay.ts — 「表 → 背景 → 重点」の読みを竹内さんの過去の番で解き直す（作業員5・11/05・書き込みなし）
//
// KB P0 575a7cd5（重点・3段・近い番の重点を添える）・P0 2acd77de（竹内さんの過去の番で鍛える）。テストの決まりは memory/test_protocol_brain.md:
//   LLM_TEST_MODE=deepseek-all（Claude は止まる）・入口 setupLlmTest を最初に・LLM の会話の id は YUMA（材料は伏せた状況の文 v2 だけ）。
//   材料: conductor-focus-build.ts の exam-cache（伏せた状況の文 v2・竹内さんの重点・埋め込み）。近い番の重点は時間順で前の番だけ・同じ会話とお客様を外して作る。
//   比べる: 近い番の1行なし（A）と、あり（B）で、統括の重点が竹内さんの重点と合うか。重点ごとに偏りなく --n 番。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/conductor-focus-replay.ts --n=140 --label=fr1
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DIR = join(process.cwd(), "..", "..", "exam-cache", "conductor-focus");

(async () => {
  const h = await setupLlmTest("conductor-focus-replay");
  try {
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const F = await import("../app/lib/conductor-focus");
    h.assertYuma(YUMA_CONVERSATION_ID, "重点の解き直し");
    const file = join(DIR, readdirSync(DIR).filter((f) => f.startsWith("turns-")).sort().pop() as string);
    type T = { id: string; conv: string; pc: string | null; at: string; scene: string; route: string; focus: string | null; v2: string; e2: number[] };
    const turns = (JSON.parse(readFileSync(file, "utf8")) as T[]).filter((t) => t.focus);
    // 2026-11-06: --gold=<id:focus,...のファイル> を渡すと、正解（と近い番の札）を文の解剖の重点に置き換える（決まった札は解剖の無い番の仮の値・弱い所 297）
    const goldFile = arg("gold");
    const gold = new Map<string, string>(goldFile ? readFileSync(goldFile, "utf8").trim().split(",").map((x) => x.split(":") as [string, string]) : []);
    let detAgree = 0, detN = 0;
    for (const t of turns) { const g = gold.get(t.id); if (g) { detN++; if (g === t.focus) detAgree++; t.focus = g; } }
    if (goldFile) console.log(`解剖の重点がある番 ${detN}・決まった札と合う ${detAgree}/${detN}`);
    const norm = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
    for (const t of turns) t.e2 = norm(t.e2);
    const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
    // 重点ごとに偏りなく（前の番が 100 以上ある番から・決まった選び方＝id の順）
    const N = Number(arg("n", "140")), per = Math.ceil(N / F.FOCUS_KINDS.length);
    const pool = turns.slice(100).filter((t) => !goldFile || gold.has(t.id));
    const pick: T[] = [];
    // 2026-11-07: --ids=<id,... のファイル> を渡すと、その番だけ（狙いの型の番を選んで解き直す・偏りなくの選び方は使わない）
    // 開いている約束からの経過（11/07 の試し: 40＋20番で 近い番あり 35→34＝効かず・本体には入れていない）
    const elapsedLine = (m: number) => `【開いている約束からの経過】こちらが確認・ピックアップ・御見積書を約束したのは ${m < 60 ? `${m}分前` : m < 1440 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前`}`;
    const elapsed = (arg("elapsed") ? JSON.parse(readFileSync(arg("elapsed"), "utf8")) : {}) as Record<string, number>;
    const idsFile = arg("ids");
    if (idsFile) { const want = new Set(readFileSync(idsFile, "utf8").trim().split(",")); pick.push(...turns.filter((t) => want.has(t.id))); }
    else for (const k of F.FOCUS_KINDS) pick.push(...pool.filter((t) => t.focus === k).sort((a, b) => a.id.localeCompare(b.id)).slice(0, per));
    const system = [
      "あなたは賃貸の仲介会社の LINE 返信の「入口の統括」です。お客様の今の番を最初に読み、この番の重点を決めます。返信の文は書きません。",
      "【絶対の決まり】スタッフだけが知る事（確認の結果・募集状況・見積の金額・内覧の日程の確定）は AIX で送る番。返信は AI が知り得る事だけ。",
      F.FOCUS_INTAKE_RULES,
      // --extra=<ファイル>: 足す1段を試す時だけ（効いたか分かるまで本体の指示には入れない）
      ...(arg("extra") ? [readFileSync(arg("extra"), "utf8").trim()] : []),
      `JSON だけを返す: {${F.FOCUS_INTAKE_FIELD}}`,
    ].join("\n\n");
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    const ask = async (user: string) => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("conductor_intake", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 300, system, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) return null;
      const d = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      const txt = d.content?.find((b) => b.type === "text")?.text ?? "";
      const m = txt.match(/\{[\s\S]*\}/); if (!m) return null;
      try { return F.parseFocusRead(JSON.parse(m[0])); } catch { return null; }
    };
    const rows: Array<Record<string, unknown>> = [];
    let n = 0, a = 0, b = 0, nearHit = 0, fail = 0;
    for (const t of pick) {
      const i = turns.indexOf(t);
      const prev = turns.slice(0, i).filter((p) => p.at < t.at && p.conv !== t.conv && (!t.pc || p.pc !== t.pc));
      const sf = F.sceneMajorityFocus(prev.filter((p) => p.scene === t.scene).map((p) => p.focus as never));
      const neigh = prev.map((p) => ({ id: p.id, focus: p.focus as never, dist: 1 - dot(t.e2, p.e2) })).sort((x, y) => x.dist - y.dist).slice(0, 30);
      const near = F.nearestFocus(neigh, { band: 0.2, minN: 5, sceneFocus: sf });
      // 2026-11-07: --elapsed=<id→分 の json> を渡すと、開いている約束からの経過の1行を足す（入口の材料の試し）
      const elapsedMin = elapsed[t.id];
      const base = `【今の番の状況（伏せた材料）】\n${t.v2}${elapsedMin != null ? `\n${elapsedLine(elapsedMin)}` : ""}`;
      const [ra, rb] = await Promise.all([ask(base), ask(`${base}\n\n${F.nearFocusLine(near)}`)]);
      if (!ra || !rb) { fail++; continue; }
      n++; if (ra.focus === t.focus) a++; if (rb.focus === t.focus) b++; if (near?.focus === t.focus) nearHit++;
      rows.push({ id: t.id, gold: t.focus, scene: t.scene, route: t.route, near: near?.focus ?? null, inBand: near?.inBand ?? false, A: ra.focus, B: rb.focus, bg: rb.background, why: rb.why });
    }
    const pct = (x: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : "-");
    const byGold: Record<string, { n: number; a: number; b: number }> = {};
    for (const r of rows) { const g = (byGold[r.gold as string] ??= { n: 0, a: 0, b: 0 }); g.n++; if (r.A === r.gold) g.a++; if (r.B === r.gold) g.b++; }
    const label = arg("label", "fr");
    writeFileSync(join(DIR, `replay-${label}.json`), JSON.stringify({ label, n, a, b, nearHit, fail, byGold, rows }, null, 1));
    // 人だけが知る事で分かれる外れ（relation と promise_keep の取り違え・F.focusHumanOnlyMiss）を外した当たりも出す（11/07 統括役）
    const hA = rows.filter((r) => F.focusHumanOnlyMiss(r.A as string, r.gold as string)).length, hB = rows.filter((r) => F.focusHumanOnlyMiss(r.B as string, r.gold as string)).length;
    console.log(`  人だけが知る事で分かれる外れを外すと: 近い番なし ${a}/${n - hA}・近い番あり ${b}/${n - hB}（外した番 なし ${hA}・あり ${hB}）`);
    console.log(`# 重点の解き直し ${label}: ${n}番（読めず ${fail}）・近い番なし ${a}/${n}（${pct(a)}）・近い番あり ${b}/${n}（${pct(b)}）・近い番の重点だけ ${nearHit}/${n}（${pct(nearHit)}）`);
    for (const [k, v] of Object.entries(byGold)) console.log(`  ${k}: なし ${v.a}/${v.n}・あり ${v.b}/${v.n}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
