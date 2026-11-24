// scripts/audit-exam-baseline-reuse.ts — off の基準（main の前の答えの取り置き）を、直近 N 晩でどれだけ作り直したか・いくら使ったか（読むだけ・DB も LLM も使わない）
// 実行: npx tsx scripts/audit-exam-baseline-reuse.ts [--days=7] [--json=<file>]
// 2026-11-24 作業員A（竹内さん 11/24 17時「試験の改善を優先する」・統括役の頼み c: off の基準の使い回し）
//   置き場 <倉庫の根>/.claude/exam-cache/brain-exam-baseline/<v-版の鍵|commit>-<構成の hash>/<問題>.json（brain-exam-baseline.ts）の savedAt・cost を読む。
//   作り直しの理由（その問題の前の取り置きと比べる・同じ問題の中身 hash・同じ段）:
//     ver_same_stage … 版の鍵は変わったが、その段の鍵（stage-keys-sk2.json の brain／draft）は同じ＝使い回せたはず（穴）
//     ver            … 版の鍵もその段の鍵も変わった（ブレイン／下書きに効く所が変わった＝作り直しは正しい・ただしスイッチで止まった変更かもしれない）
//     cfg            … 構成（env・回数・層）の hash が変わった（構成の鍵は env の全部を入れている＝off のままの新しいスイッチでも変わる）
//     cfg_repeat     … 構成の違いが回数（repeat）だけ
//     same           … 同じ置き場の上書き（期限切れ・回が足りない）
//     new            … その問題（中身）の取り置きが前に無い（初めて・問題の中身が変わった）
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_DIR, configEquivalent, oneSidedEnvKeys, defaultsAtCommit, type ExamConfig } from "./lib/brain-exam-baseline";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DAYS = Number(arg("days") || 7);
const readJ = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } };

type Cfg = { args?: Record<string, unknown>; env?: Record<string, string> };
type Row = { dir: string; id: string; hash: string; savedAt: string; t: number; commit: string; vk: string; cfg: string; stage: string; usd: number; realUsd: number; replayUsd: number; from: string; config: Cfg };

const stageKeys = readJ<Record<string, { brain: string; draft: string }>>(join(BASELINE_DIR, "stage-keys-sk2.json"), {});
const rows: Row[] = [];
for (const d of readdirSync(BASELINE_DIR)) {
  const m = d.match(/^(?:v-([0-9a-f]+)|([0-9a-f]{10}))-([0-9a-f]{10})$/);
  if (!m) continue;
  const dir = join(BASELINE_DIR, d);
  const conf = readJ<{ commit?: string; versionKey?: string | null; config?: Cfg }>(join(dir, "config.json"), {});
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "config.json") continue;
    const b = readJ<{ id?: string; problemHash?: string; savedAt?: string; commit?: string; versionKey?: string; config?: Cfg; fromLabel?: string; cost?: { realUsd?: number; replayUsd?: number } | null } | null>(join(dir, f), null);
    if (!b?.id || !b.savedAt) continue;
    const config = b.config ?? conf.config ?? {};
    const realUsd = Number(b.cost?.realUsd ?? 0), replayUsd = Number(b.cost?.replayUsd ?? 0);
    rows.push({ dir: d, id: b.id, hash: b.problemHash ?? "", savedAt: b.savedAt, t: Date.parse(b.savedAt), commit: b.commit ?? conf.commit ?? m[2] ?? "", vk: b.versionKey ?? conf.versionKey ?? m[1] ?? "", cfg: m[3], stage: String(config.args?.stage ?? "draft"), usd: realUsd + replayUsd, realUsd, replayUsd, from: b.fromLabel ?? "", config });
  }
}
rows.sort((a, b) => a.t - b.t);
const since = Date.now() - DAYS * 86_400_000;
const nightOf = (t: number) => new Date(t + 9 * 3_600_000 - 12 * 3_600_000).toISOString().slice(0, 10); // JST 12時で日を切る＝その晩の日付
const stageKeyOf = (commit: string, stage: string) => (stageKeys[commit] ? (stage === "brain" ? stageKeys[commit].brain : stageKeys[commit].draft) : null);
const envDiff = (a: Cfg, b: Cfg) => { const ks = new Set([...Object.keys(a.env ?? {}), ...Object.keys(b.env ?? {})]); return [...ks].filter((k) => (a.env ?? {})[k] !== (b.env ?? {})[k]); };
const argDiff = (a: Cfg, b: Cfg) => { const ks = new Set([...Object.keys(a.args ?? {}), ...Object.keys(b.args ?? {})]); return [...ks].filter((k) => JSON.stringify((a.args ?? {})[k]) !== JSON.stringify((b.args ?? {})[k])); };

type Why = "ver_same_stage" | "ver" | "cfg" | "cfg_repeat" | "same" | "new";
const out: Array<Row & { why: Why; prev?: string; envKeys?: string[]; argKeys?: string[]; equiv?: boolean }> = [];
const defMemo = new Map<string, Map<string, string>>();
const defsFor = (commit: string, names: string[]) => { const k = `${commit}|${[...names].sort().join(",")}`; if (!defMemo.has(k)) defMemo.set(k, defaultsAtCommit(commit, names)); return defMemo.get(k)!; };
const toCfg = (c: Cfg): ExamConfig => ({ args: (c.args ?? {}) as ExamConfig["args"], env: c.env ?? {} });
for (const [i, r] of rows.entries()) {
  if (r.t < since) continue;
  const prior = rows.slice(0, i).filter((p) => p.id === r.id && p.hash === r.hash && p.stage === r.stage);
  if (!prior.length) { out.push({ ...r, why: "new" }); continue; }
  const p = prior[prior.length - 1];
  if (p.dir === r.dir) { out.push({ ...r, why: "same", prev: p.savedAt }); continue; }
  if (p.cfg === r.cfg) {
    const ks = stageKeyOf(r.commit, r.stage), kp = stageKeyOf(p.commit, p.stage);
    out.push({ ...r, why: ks && kp && ks === kp ? "ver_same_stage" : "ver", prev: p.dir });
    continue;
  }
  // 構成が違う: 同じ版の鍵の物があればそれと比べる
  const sameVer = prior.filter((x) => x.vk === r.vk).pop() ?? p;
  const ek = envDiff(sameVer.config, r.config), ak = argDiff(sameVer.config, r.config);
  // 11/24 の直し（EXAM_BASELINE_CFG_EQUIV）で使い回せたか: 同じ版の鍵・構成の違いが「既定と同じ値の env が片方に無い」と回数だけ
  const equiv = sameVer.vk === r.vk && configEquivalent(toCfg(r.config), toCfg(sameVer.config), defsFor(r.commit, oneSidedEnvKeys(toCfg(r.config), toCfg(sameVer.config))));
  out.push({ ...r, why: !ek.length && ak.length && ak.every((k) => k === "repeat") ? "cfg_repeat" : "cfg", prev: sameVer.dir, envKeys: ek.slice(0, 8), argKeys: ak, equiv });
}

const sum = (xs: typeof out) => xs.reduce((a, x) => a + x.usd, 0);
console.log(`■ off の基準の取り置き（直近 ${DAYS}日・作った問題の答え ${out.length}件・$${sum(out).toFixed(2)}）`);
const WHY_JA: Record<Why, string> = { ver_same_stage: "版の鍵だけ変わった（段の鍵は同じ＝使い回せたはず）", ver: "その段に効く所が変わった", cfg: "構成（env・層）が変わった", cfg_repeat: "回数だけ違う", same: "同じ置き場の上書き（期限・回の不足）", new: "初めて（前の取り置きが無い）" };
for (const w of Object.keys(WHY_JA) as Why[]) { const xs = out.filter((x) => x.why === w); if (xs.length) console.log(`  ${WHY_JA[w]}: ${xs.length}件・$${sum(xs).toFixed(2)}`); }
const redo = out.filter((x) => x.why !== "new");
console.log(`  作り直しの割合: ${out.length ? Math.round((redo.length / out.length) * 100) : 0}%（${redo.length}/${out.length}件）・作り直しの金額 $${sum(redo).toFixed(2)}`);
{ const eq = out.filter((x) => x.equiv); console.log(`  うち 11/24 の直し（構成の同じ扱い・同じ版の鍵）で使い回せた見込み: ${eq.length}件・${sum(eq).toFixed(2)}`); }
console.log(`\n■ 晩ごと（JST の晩・作った件数／作り直し／金額）`);
for (const n of [...new Set(out.map((x) => nightOf(x.t)))].sort()) { const xs = out.filter((x) => nightOf(x.t) === n); const rd = xs.filter((x) => x.why !== "new"); console.log(`  ${n}: ${xs.length}件・作り直し ${rd.length}（$${sum(rd).toFixed(2)}）・全部 $${sum(xs).toFixed(2)}`); }
const envCount = new Map<string, number>();
for (const x of out.filter((x) => x.why === "cfg")) for (const k of x.envKeys ?? []) envCount.set(k, (envCount.get(k) ?? 0) + 1);
console.log(`\n■ 構成が変わった作り直しの env の名前（上位）: ${[...envCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
const argCount = new Map<string, number>();
for (const x of out.filter((x) => x.why === "cfg" || x.why === "cfg_repeat")) for (const k of x.argKeys ?? []) argCount.set(k, (argCount.get(k) ?? 0) + 1);
console.log(`  args の名前（上位）: ${[...argCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
console.log(`  置き場の数（直近）: ${new Set(out.map((x) => x.dir)).size}・版の鍵 ${new Set(out.map((x) => x.vk)).size}・構成 ${new Set(out.map((x) => x.cfg)).size}`);
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(out.map(({ config, ...x }) => x), null, 1));
if (!existsSync(BASELINE_DIR)) console.log("置き場が無い");
