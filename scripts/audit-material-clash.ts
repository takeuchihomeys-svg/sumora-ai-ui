// scripts/audit-material-clash.ts — 材料どうしの食い違いの見張り（app/lib/material-clash.ts）を試験の答案の録音に当てる（読むだけ・LLM なし・DB なし・費用0）
//
// 2026-11-15 作業員L（統括の土台②・KB 878a2f0b q091）。
//   答案の行（scripts/brain-exam/results/<label>.jsonl）の llmCalls から、ブレインの今回の発言の層（brain_fresh・無ければ brain_full）の録音
//   （.claude/exam-cache/llm-cassette/<鍵の頭2字>/<鍵>.json の normBody＝system と user の文）を開いて食い違いを数え、
//   その番の当たり・外れ（本質の道＝LLM の最初の答え essence.ok・最終の道 score.path）と並べる。
// 実行: npx tsx scripts/audit-material-clash.ts --results=<jsonl,…> [--cassette=<dir>] [--top=15] [--show=q091,q178] [--json=<出力>]
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectMaterialClash, type MaterialClash } from "../app/lib/material-clash";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = resolve(__dirname, "..");
const CASSETTE = arg("cassette", resolve(ROOT, "../../exam-cache/llm-cassette"));
const cassetteDir = existsSync(CASSETTE) ? CASSETTE : resolve(ROOT, ".claude/exam-cache/llm-cassette");
const TOP = Number(arg("top", "15")) || 15;
const SHOW = new Set(arg("show", "").split(",").filter(Boolean));

type Row = { id: string; rep?: number; type?: string; llmCalls?: Array<{ key: string; action: string | null }>; score?: { path?: boolean | null }; essence?: { ok?: boolean | null; code?: string } | null; path?: { code?: string } | null };
const textOf = (x: unknown): string => (typeof x === "string" ? x : Array.isArray(x) ? x.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("\n") : "");

function loadPrompt(r: Row): { system: string; user: string } | null {
  const calls = r.llmCalls ?? [];
  const c = calls.find((x) => x.action === "brain_fresh") ?? calls.find((x) => x.action === "brain_full");
  if (!c) return null;
  const fp = join(cassetteDir, c.key.slice(0, 2), `${c.key}.json`);
  if (!existsSync(fp)) return null;
  try {
    const e = JSON.parse(readFileSync(fp, "utf8")) as { normBody?: string };
    const b = JSON.parse(e.normBody ?? "{}") as { system?: unknown; messages?: Array<{ content?: unknown }> };
    return { system: textOf(b.system), user: (b.messages ?? []).map((m) => textOf(m.content)).join("\n") };
  } catch { return null; }
}

type T = { n: number; essOk: number; essN: number; finOk: number; finN: number };
const tz = (): T => ({ n: 0, essOk: 0, essN: 0, finOk: 0, finN: 0 });
const add = (t: T, r: Row) => { t.n++; if (typeof r.essence?.ok === "boolean") { t.essN++; if (r.essence.ok) t.essOk++; } if (typeof r.score?.path === "boolean") { t.finN++; if (r.score.path) t.finOk++; } };
const pc = (a: number, n: number) => (n ? `${a}/${n}（${Math.round((100 * a) / n)}%）` : "-");
const line = (name: string, t: T) => `${name.padEnd(34)} 番 ${String(t.n).padStart(3)}｜本質の道 当たり ${pc(t.essOk, t.essN).padEnd(12)} 外れ ${t.essN - t.essOk}｜最終の道 当たり ${pc(t.finOk, t.finN).padEnd(12)} 外れ ${t.finN - t.finOk}`;

const files = arg("results", "").split(",").filter(Boolean).map((p) => (existsSync(resolve(process.cwd(), p)) ? resolve(process.cwd(), p) : resolve(ROOT, p)));
if (!files.length) { console.error("--results=<jsonl,…> を指定してください"); process.exit(1); }
const rows: Row[] = files.flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Row]; } catch { return []; } }) : []));

const all = tz(), withO = tz(), withSys = tz(), withW = tz(), withS = tz(), none = tz(), both = tz();
const byTurn: Record<string, T> = {};
const pairs = new Map<string, T & { ids: Set<string>; missIds: Set<string> }>();
const shapes = new Map<string, T & { ids: Set<string>; missIds: Set<string> }>();
let noPrompt = 0;
const out: Array<{ id: string; rep: number; ess: boolean | null; fin: boolean | null; clash: MaterialClash }> = [];
for (const r of rows) {
  const p = loadPrompt(r);
  if (!p) { noPrompt++; continue; }
  const m = detectMaterialClash(p);
  out.push({ id: r.id, rep: r.rep ?? 0, ess: r.essence?.ok ?? null, fin: r.score?.path ?? null, clash: m });
  add(all, r); add((byTurn[m.turn] ??= tz()), r);
  const yes = m.opposed.filter((o) => o.level === "yes" && o.dyn);
  const sysYes = m.opposed.filter((o) => o.level === "yes" && !o.dyn);
  if (yes.length) add(withO, r);
  if (sysYes.length) add(withSys, r);
  if (yes.length && m.shapeNoRoute.length) add(both, r);
  if (m.opposed.some((o) => o.level === "weak")) add(withW, r);
  if (m.shapeNoRoute.length) add(withS, r);
  if (!yes.length && !sysYes.length && !m.shapeNoRoute.length) add(none, r);
  const miss = r.essence?.ok === false || r.score?.path === false;
  for (const o of [...yes, ...sysYes]) { const k = `${o.dyn ? "" : "[system どうし] "}${o.kind === "aix_reply" ? "AIX×返信" : "AIX×約束"}: ${o.a} × ${o.b}`; const t = pairs.get(k) ?? { ...tz(), ids: new Set<string>(), missIds: new Set<string>() }; add(t, r); t.ids.add(r.id); if (miss) t.missIds.add(r.id); pairs.set(k, t); }
  for (const s of m.shapeNoRoute) { const k = `形だけ: ${s.block} ／ 決まり: ${s.with.slice(0, 2).join("・")}`; const t = shapes.get(k) ?? { ...tz(), ids: new Set<string>(), missIds: new Set<string>() }; add(t, r); t.ids.add(r.id); if (miss) t.missIds.add(r.id); shapes.set(k, t); }
  if (SHOW.has(r.id)) {
    console.log(`\n--- ${r.id}#${r.rep ?? 0} 番の形=${m.turn} 本質=${r.essence?.code ?? "?"}(${r.essence?.ok}) 最終=${r.path?.code ?? "?"}(${r.score?.path})`);
    for (const s of m.stances) console.log(`   [${s.stance}/${s.level}${s.decision ? "/決まり" : ""}] ${s.block}: ${s.quote}`);
    for (const o of m.opposed) console.log(`   逆の組 ${o.kind}/${o.level}: ${o.a} × ${o.b}`);
    for (const s of m.shapeNoRoute) console.log(`   形だけ: ${s.block} ← 決まり ${s.with.join("・")}`);
  }
}
console.log(`\n# 材料どうしの食い違い（答案 ${files.length} ファイル・${rows.length} 行・録音の無い行 ${noPrompt}）`);
console.log(line("全部", all));
console.log(line("① 道の逆の組あり（材料の塊を含む yes）", withO));
console.log(line("  system どうしの逆の組あり（yes）", withSys));
console.log(line("  ①と②が両方", both));
console.log(line("  （参考）弱い組だけ含む（weak）", withW));
console.log(line("② 形だけの塊＋決まりの塊", withS));
console.log(line("どちらも無し", none));
console.log("\n## 番の形ごと");
for (const [k, t] of Object.entries(byTurn)) console.log(line(k, t));
const rank = (m: Map<string, T & { ids: Set<string>; missIds: Set<string> }>) => [...m.entries()].sort((a, b) => b[1].missIds.size - a[1].missIds.size || b[1].n - a[1].n).slice(0, TOP);
console.log(`\n## ① 逆の組（外れと重なった問題の数の多い順・上位 ${TOP}）`);
for (const [k, t] of rank(pairs)) console.log(`${line(k.slice(0, 90), t)}\n     外れと重なった問題 ${t.missIds.size}/${t.ids.size}: ${[...t.missIds].slice(0, 12).join(",")}`);
console.log(`\n## ② 形だけの塊（外れと重なった問題の数の多い順・上位 ${TOP}）`);
for (const [k, t] of rank(shapes)) console.log(`${line(k.slice(0, 90), t)}\n     外れと重なった問題 ${t.missIds.size}/${t.ids.size}: ${[...t.missIds].slice(0, 12).join(",")}`);
if (arg("json")) writeFileSync(resolve(process.cwd(), arg("json")), JSON.stringify(out, null, 1));
