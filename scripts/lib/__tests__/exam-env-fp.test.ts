// スイッチの指紋（scripts/lib/exam-env-fp.ts）と、使い回し・持ち越し・録音の鍵への入り方（2026-10-21）
// 実行: npx tsx scripts/lib/__tests__/exam-env-fp.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReaders, envFingerprintOf, defaultEnvOf, parseDotenv, envFpMismatchNote, canonValue, appReaders, isFpName, FP_EXCLUDE_RE } from "../exam-env-fp";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { reuseKey } from "../exam-brain";
import { planBaseline, findCarryOver, type BaselineFile } from "../brain-exam-baseline";
import { makeCassetteFetch, cassetteRunSalt, setCassetteTag, flushCassette, type CassetteStats, type CassetteMode } from "../llm-cassette";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const SRC = [
  `export function on(env = process.env) { return (env.DAY_SUBJECT_READER ?? "").trim().toLowerCase() === "on"; }`,
  `if (process.env.ACK_TOPIC_SCOPE !== "off") x(); if (process.env.ACK_TOPIC_SCOPE === "off") y();`,
  `const pii = (env.SCREENING_PII_CLAUDE ?? "on").trim().toLowerCase() !== "off";`,
  `const v = (env.STAFF_ONLY_AIX_1020 ?? "").trim().toLowerCase(); const k = process.env.ANTHROPIC_API_KEY; const m = process.env.DEEPSEEK_MODEL;`,
];
const readers = collectReaders(SRC);
const dot = parseDotenv(`﻿# Created by Vercel CLI\nLLM_ALT_PROVIDER="deepseek"\nACK_TOPIC_SCOPE=off # 本番は切っている\n`);
const fp = (env: Record<string, string | undefined>) => envFingerprintOf(env, dot, readers);

// ① 読み方
ok("読み方: === \"on\" は bool", readers.get("DAY_SUBJECT_READER")?.kind === "bool");
ok("読み方: 同じ文字の ===/!== は bool", readers.get("ACK_TOPIC_SCOPE")?.kind === "bool");
ok("読み方: 比べの無い読み方は raw", readers.get("STAFF_ONLY_AIX_1020")?.kind === "raw");
ok(".env.local: BOM・コメント・引用符", dot.LLM_ALT_PROVIDER === "deepseek" && dot.ACK_TOPIC_SCOPE === "off");
ok("bool の効く値: 既定 on の !== off", canonValue(undefined, readers.get("SCREENING_PII_CLAUDE")) === canonValue("ON", readers.get("SCREENING_PII_CLAUDE")));

// ② on と off で違う・付けない＝既定の明示と同じ
const base = { LLM_ALT_PROVIDER: "deepseek", ACK_TOPIC_SCOPE: "off", PATH: "/x", ANTHROPIC_API_KEY: "sk", DEEPSEEK_MODEL: "deepseek-flash" };
const off = fp(base), on = fp({ ...base, DAY_SUBJECT_READER: "on" }), offExplicit = fp({ ...base, DAY_SUBJECT_READER: "off" }), offUpper = fp({ ...base, DAY_SUBJECT_READER: " Off " });
ok("付けない回の指紋は空（既定）", off.hash === "" && off.text === "", JSON.stringify(off));
ok("on の指紋は空でない・名前と値が見える", on.hash !== "" && on.text === "DAY_SUBJECT_READER=on", JSON.stringify(on));
ok("付けない == 既定の値を明示（off）", offExplicit.hash === off.hash && offUpper.hash === "");
ok("鍵・秘密・モデルの選びは入らない", !on.text.includes("API_KEY") && !on.text.includes("DEEPSEEK_MODEL") && !on.text.includes("PATH"));
ok(".env.local の値と同じなら入らない（ACK_TOPIC_SCOPE=off）", fp({ ...base }).pairs.length === 0);
ok(".env.local と違えば入る（ACK_TOPIC_SCOPE を消した）", fp({ LLM_ALT_PROVIDER: "deepseek" }).text === "ACK_TOPIC_SCOPE=(unset)");
ok("raw の読み方は値で比べる", fp({ ...base, STAFF_ONLY_AIX_1020: "on" }).hash !== fp({ ...base, STAFF_ONLY_AIX_1020: "mgmt_pending" }).hash);
ok("コードに無くてもスイッチの形は入る", fp({ ...base, LINE_WATCH_NEW_THING: "on" }).text === "LINE_WATCH_NEW_THING=on");
const dEnv = defaultEnvOf({ ...base, DAY_SUBJECT_READER: "on", ACK_TOPIC_SCOPE: "on" }, fp({ ...base, DAY_SUBJECT_READER: "on", ACK_TOPIC_SCOPE: "on" }), dot);
ok("既定の環境: .env.local に無い名前は消す・ある名前は .env.local の値", !("DAY_SUBJECT_READER" in dEnv) && dEnv.ACK_TOPIC_SCOPE === "off" && fp(dEnv).hash === "");
ok("比べの注意: 同じなら null・違えば出す", envFpMismatchNote(on, on) === null && !!envFpMismatchNote(on, null)?.includes("DAY_SUBJECT_READER=on") && envFpMismatchNote(null, { hash: "" }) === null);

// ②b 2026-10-21 確かめる人: ?. の読み方・名前を文字で渡す手伝い・書き置きだけの名前も拾う
{
  const r2 = collectReaders([
    `if ((process.env?.PII_MASK_KEEP_OWNER ?? "").toLowerCase() !== "off") a();`,
    `const flag = (name: string, env: E) => (env[name] ?? "").toLowerCase() !== "off"; if (flag("ITSUDEMO_R13", env)) b(); meetingDayWordOn(process.env, "MEETING_DAY_WORD");`,
    `// 戻す OLD_AGE_MODE=off\nconst m = modeOf(process.env?.OLD_AGE_MODE);`,
    `if ((env.UP_SWITCH ?? "").toUpperCase() === "ON") c();`,
  ]);
  ok("読み方: process.env?.X も拾う（bool）", r2.get("PII_MASK_KEEP_OWNER")?.kind === "bool");
  ok("読み方: 手伝いの関数に文字で渡す名前を拾う（raw）", r2.get("ITSUDEMO_R13")?.kind === "raw" && r2.get("MEETING_DAY_WORD")?.kind === "raw");
  ok("読み方: ?. の生の読み方（raw）", r2.get("OLD_AGE_MODE")?.kind === "raw");
  ok("読み方: toUpperCase の比べは raw（安全側）", r2.get("UP_SWITCH")?.kind === "raw");
}
// ②c 本番のコード（app/）で env から読む名前は全部、指紋の対象か外す名前（漏れ＝on/off の比べが混ざる・main の取り置きにも混ざる）
{
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(n) && !/\.test\./.test(n)) files.push(p); } };
  walk("app");
  const ar = appReaders(".");
  const pats = [
    /\b\w*[eE]nv\w*\??\.([A-Z][A-Z0-9_]{2,})\b/g,
    /\b\w*[eE]nv\w*(?:\?\.)?\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\]/g,
    /\b\w*\(\s*["'`]([A-Z][A-Z0-9_]{3,})["'`]\s*,\s*[\w.?]*\benv\b/g,
    /\b\w*\(\s*[\w.?]*\benv\s*,\s*["'`]([A-Z][A-Z0-9_]{3,})["'`]/g,
  ];
  const miss = new Set<string>();
  for (const f of files) { const s = readFileSync(f, "utf8"); for (const p of pats) { p.lastIndex = 0; let m: RegExpExecArray | null; while ((m = p.exec(s))) if (!isFpName(m[1], ar) && !FP_EXCLUDE_RE.test(m[1])) miss.add(`${m[1]}（${f}）`); } }
  ok("本番のコードの env の名前は全部指紋の対象", files.length > 50 && miss.size === 0, [...miss].slice(0, 20).join(" / "));
}

// ③ 使い回しの鍵
const rk = { problemHash: "p", stage: "brain" as const, scopeKey: "s", toolKey: "t", cfgHash: "c", model: "m", kbKey: "-", dbKey: "d", convKey: "-" };
ok("使い回しの鍵: 既定（空）は旧の鍵と同じ", reuseKey({ ...rk, envFp: "" }) === reuseKey(rk));
ok("使い回しの鍵: on と off で違う", reuseKey({ ...rk, envFp: on.hash }) !== reuseKey({ ...rk, envFp: off.hash }));

// ④ main の取り置き・持ち越し: 指紋の無い古い物は既定とみる＝既定の回にだけ使う
type R = { rep: number; error?: string };
const now = Date.now();
const bf = (o: Partial<BaselineFile<R>>): BaselineFile<R> => ({ id: "q1", problemHash: "h", commit: "c", config: { args: {}, env: {} }, savedAt: new Date(now).toISOString(), fromLabel: "x", rows: [{ rep: 1 }], ...o });
const plan = (b: BaselineFile<R>, envFp?: string) => planBaseline([{ id: "q1", hash: "h" }], new Map([["q1", b]]), 1, { envFp, now });
ok("取り置き: 古い（指紋なし）は既定の回で使う", plan(bf({}), "").reuse.includes("q1"));
ok("取り置き: 古い（指紋なし）は on の回では使わない", plan(bf({}), on.hash).run.includes("q1"));
ok("取り置き: on の答えは既定の回で使わない", plan(bf({ envFp: on.hash }), "").run.includes("q1"));
ok("取り置き: 同じ指紋なら使う", plan(bf({ envFp: on.hash }), on.hash).reuse.includes("q1"));
const keyOf = () => "k";
ok("持ち越し: 古い（指紋なし）は既定に持ち越す", !!findCarryOver([bf({})], { hash: "h" }, { key: "k", keyOf, envFp: "" }, 1, { now }));
ok("持ち越し: on の答えは既定に持ち越さない", !findCarryOver([bf({ envFp: on.hash })], { hash: "h" }, { key: "k", keyOf, envFp: "" }, 1, { now }));

// ⑤ 録音の鍵: 指紋・回
const A = "api.anthropic.com";
ok("録音の印: 既定・1回目は印なし", cassetteRunSalt({ envFp: "", host: A, action: "brain_full", rep: "1", mode: "replay" }) === "");
ok("録音の印: on は env の印", cassetteRunSalt({ envFp: on.hash, host: A, action: "brain_full", rep: "1", mode: "replay" }) === `\n#env=${on.hash}`);
ok("録音の印: 判定（DeepSeek 直・名札なし）には env の印を足さない", cassetteRunSalt({ envFp: on.hash, host: "api.deepseek.com", action: null, rep: "1", mode: "replay" }) === "");
ok("録音の印: 2回目は rep の印（判定も）", cassetteRunSalt({ envFp: "", host: "api.deepseek.com", action: null, rep: "2", mode: "replay" }) === "\n#rep=2");
ok("録音の印: strict は rep の印を足さない", cassetteRunSalt({ envFp: "", host: A, action: "brain_full", rep: "2", mode: "strict" }) === "");
ok("録音の印: LLM_CASSETTE_REP=off で rep の印を止める", cassetteRunSalt({ envFp: "", host: A, action: "brain_full", rep: "3", mode: "record", env: { LLM_CASSETTE_REP: "off" } }) === "");

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfp-cassette-"));
  const stats = (mode: CassetteMode): CassetteStats => ({ mode, dir, total: { real: 0, realUsd: 0, replayed: 0, replayUsd: 0, missed: 0, unrecordable: 0 }, byAction: new Map(), byTag: new Map(), misses: [] });
  let calls = 0;
  const inner = async () => { calls++; return new Response(JSON.stringify({ model: "deepseek-v4-pro", content: [{ type: "text", text: `答え${calls}` }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }); };
  const req = { method: "POST", headers: { "content-type": "application/json", "x-sumora-llm-action": "brain_full" }, body: JSON.stringify({ messages: [{ role: "user", content: "同じ要求" }] }) };
  const run = async (envFp: string, rep: string, mode: CassetteMode = "replay") => {
    setCassetteTag({ problem: "q192", rep });
    const f = makeCassetteFetch(inner as never, { mode, dir, stats: stats(mode), env: { LLM_TEST_MODE: "deepseek-all" }, envFp, log: () => {} });
    const r = await f("https://api.anthropic.com/v1/messages", req); const t = await r.text(); await flushCassette();
    return { t, replay: r.headers.get("x-llm-cassette") === "replay" };
  };
  const onR = await run(on.hash, "1");
  const offR = await run("", "1");
  ok("録音: on の後の off（既定）は on の答えを再生しない", !offR.replay && offR.t !== onR.t, JSON.stringify({ onR, offR }));
  const offAgain = await run("", "1");
  ok("録音: 同じ off・1回目の別の実行は再生する", offAgain.replay && offAgain.t === offR.t);
  const rep2 = await run("", "2");
  ok("録音: 別の実行の2回目は1回目を再生しない（独立な確かめ）", !rep2.replay && rep2.t !== offR.t);
  const rep2Strict = await run("", "2", "strict");
  ok("録音: strict の2回目は回を足して録った答えを返す（無ければ旧の鍵）", rep2Strict.replay && rep2Strict.t === rep2.t, JSON.stringify({ rep2Strict, rep2 }));
  const rep3Strict = await run("", "3", "strict");
  ok("録音: strict で回の録音が無い時は旧の鍵（1回目の録音）を返す", rep3Strict.replay && rep3Strict.t === offR.t, JSON.stringify(rep3Strict));
  rmSync(dir, { recursive: true, force: true });
  console.log(`exam-env-fp: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})();
