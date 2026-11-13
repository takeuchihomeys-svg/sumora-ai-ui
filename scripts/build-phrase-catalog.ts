// scripts/build-phrase-catalog.ts — 竹内さんの言い方の骨と割合の表（app/lib/compose-phrase-catalog-data.ts）を作る（AI を呼ばない・DB を読まない・費用0）
//   材料: exam-cache/anatomy-roles/roles-r1.json（竹内さんの返信 198番・文と役目と場面）。名乗りが「鈴木」の番は入れない（11/12 統括役・竹内さんに確かめ中）
//   出力は札・終わりの言い方・数と割合だけ（本文・お客様の発言・名前は入れない）。終わりの言い方は2通以上の物だけ
// 実行: npx tsx scripts/build-phrase-catalog.ts [--src=<roles-r1.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { trustOfText, endingOf, trustSubsOfText } from "../app/lib/compose-phrase-catalog";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const src = arg("src", resolve(ROOT, "../../exam-cache/anatomy-roles/roles-r1.json"));
const roles = JSON.parse(readFileSync(src, "utf8")) as Array<{ id: string; scene: string; route?: string; main_role: string | null; sentences: string[]; roles: Array<{ i: number; role: string }> }>;
const trust = new Map<string, { n: number; m: Map<string, number> }>();
const ends = new Map<string, { n: number; m: Map<string, number> }>();
const bump = (tab: Map<string, { n: number; m: Map<string, number> }>, k: string, vals: string[]) => { const t = tab.get(k) ?? { n: 0, m: new Map<string, number>() }; t.n++; for (const v of vals) t.m.set(v, (t.m.get(v) ?? 0) + 1); tab.set(k, t); };
let used = 0, skipped = 0;
/** 文の役目13種 → 設計図の6役目（作業員22 の役目の名前）。promise は押さえ（確かめる約束で答える）・keep は締め（継続の約束）・barrier は信頼（少なさ・障壁を下げる） */
const V2_OF: Record<string, string> = { greet: "head", uke: "head", answer: "press", promise: "press", trust: "trust", barrier: "trust", worry: "latent", viewing: "bridge", apply: "bridge", estimate: "bridge", ask_send: "bridge", keep: "close", close: "close" };
const trustSub = new Map<string, { n: number; m: Map<string, number> }>();
const rowsTab = new Map<string, { n: number; has: Map<string, number>; pos: Map<string, number[]> }>();
// 形の欄（長さ・絵文字）: 場面×主の役目ごとの文の数・場面ごとの絵文字の数と種類
const lens = new Map<string, number[]>();
const emos = new Map<string, { counts: number[]; kinds: Map<string, number> }>();
const EMO_ALL = /[🌀-🫿☀-➿]/gu;
for (const r of roles) {
  if (r.route && r.route !== "reply") continue;
  if (r.sentences.some((s) => /鈴木/.test(s))) { skipped++; continue; }
  used++;
  for (const k of [`${r.scene}|${r.main_role}`, `*|${r.main_role}`]) { const a = lens.get(k) ?? []; a.push(r.sentences.length); lens.set(k, a); }
  { const all = r.sentences.join("").match(EMO_ALL) ?? []; for (const k of [r.scene, "*"]) { const e = emos.get(k) ?? { counts: [] as number[], kinds: new Map<string, number>() }; e.counts.push(all.length); for (const x of all) e.kinds.set(x, (e.kinds.get(x) ?? 0) + 1); emos.set(k, e); } }
  // 信頼の下の役目（場面×主の役目ごとの割合）
  if (r.main_role) { const subs = trustSubsOfText(r.sentences.join("\n")); bump(trustSub, `${r.scene}|${r.main_role}`, subs); bump(trustSub, `*|${r.main_role}`, subs); }
  if (r.main_role) { const ks = trustOfText(r.sentences.join("\n")); bump(trust, `${r.scene}|${r.main_role}`, ks); bump(trust, `*|${r.main_role}`, ks); }
  for (const x of r.roles) { const s = r.sentences[x.i - 1]; if (!s) continue; const e = endingOf(s); const v = e ? [e] : []; bump(ends, `${r.scene}|${x.role}`, v); bump(ends, `*|${x.role}`, v); }
  // 行の並び（COMPOSE_PLAN_ROWS_V2）: 設計図の6役目（head・press・trust・latent・bridge・close）がこの番にあるか・どの位置か（0＝先頭〜1＝最後）
  if (r.main_role) {
    const present = new Map<string, number>();
    r.roles.forEach((x, idx) => { const v2 = V2_OF[x.role]; if (!v2) return; const pos = r.roles.length > 1 ? idx / (r.roles.length - 1) : 0; if (!present.has(v2)) present.set(v2, pos); });
    for (const k of [`${r.scene}|${r.main_role}`, `*|${r.main_role}`]) {
      const t = rowsTab.get(k) ?? { n: 0, has: new Map<string, number>(), pos: new Map<string, number[]>() }; t.n++;
      for (const [v2, pos] of present) { t.has.set(v2, (t.has.get(v2) ?? 0) + 1); const ps = t.pos.get(v2) ?? []; ps.push(pos); t.pos.set(v2, ps); }
      rowsTab.set(k, t);
    }
  }
}
const rowsOut: Record<string, { n: number; roles: Array<[string, number, number]> }> = {};
for (const k of [...rowsTab.keys()].sort()) {
  const t = rowsTab.get(k)!; if (t.n < 2) continue;
  rowsOut[k] = { n: t.n, roles: [...t.has.entries()].map(([v2, c]) => { const ps = t.pos.get(v2) ?? []; return [v2, Math.round((c / t.n) * 100) / 100, Math.round((ps.reduce((a, b) => a + b, 0) / Math.max(1, ps.length)) * 100) / 100] as [string, number, number]; }).sort((a, b) => a[2] - b[2]) };
}
const r2 = (x: number) => Math.round(x * 100) / 100;
type Shares = Array<[string, number]>;
const sharesOf = (m: Map<string, number>, n: number, max: number, minC = 1): Shares => {
  const xs: Shares = [];
  for (const [x, c] of [...m.entries()].sort((a, b) => b[1] - a[1])) if (c >= minC && xs.length < max) xs.push([x, r2(c / n)]);
  return xs;
};
const trustOut: Record<string, { n: number; shares: Shares }> = {};
for (const k of [...trust.keys()].sort()) { const t = trust.get(k)!; if (t.n >= 2) trustOut[k] = { n: t.n, shares: sharesOf(t.m, t.n, 4) }; }
const trustSubOut: Record<string, { n: number; shares: Shares }> = {};
for (const k of [...trustSub.keys()].sort()) { const t = trustSub.get(k)!; if (t.n >= 2) trustSubOut[k] = { n: t.n, shares: sharesOf(t.m, t.n, 8) }; }
const endOut: Record<string, { n: number; top: Shares }> = {};
for (const k of [...ends.keys()].sort()) { const t = ends.get(k)!; if (t.n < 4) continue; const top = sharesOf(t.m, t.n, 3, 2); if (top.length) endOut[k] = { n: t.n, top }; }
const q = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))]; };
const lenOut: Record<string, { n: number; median: number; p25: number; p75: number }> = {};
for (const k of [...lens.keys()].sort()) { const a = lens.get(k)!; if (a.length >= 3) lenOut[k] = { n: a.length, median: q(a, 0.5), p25: q(a, 0.25), p75: q(a, 0.75) }; }
const emoOut: Record<string, { n: number; median: number; p75: number; kinds: Shares }> = {};
for (const k of [...emos.keys()].sort()) { const e = emos.get(k)!; emoOut[k] = { n: e.counts.length, median: q(e.counts, 0.5), p75: q(e.counts, 0.75), kinds: [...e.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) }; }
const built = new Date().toISOString().slice(0, 10);
const body = `// app/lib/compose-phrase-catalog-data.ts — scripts/build-phrase-catalog.ts が作る（手で直さない）。竹内さんの返信 ${used}番（名乗り「鈴木」の ${skipped}番は入れない）・札と割合だけ
export const PHRASE_CATALOG_BUILT = ${JSON.stringify(built)};
export const PHRASE_TRUST_TABLE: Record<string, { n: number; shares: Array<[string, number]> }> = ${JSON.stringify(trustOut)};
export const PHRASE_ENDING_TABLE: Record<string, { n: number; top: Array<[string, number]> }> = ${JSON.stringify(endOut)};
export const PHRASE_LENGTH_TABLE: Record<string, { n: number; median: number; p25: number; p75: number }> = ${JSON.stringify(lenOut)};
export const PHRASE_TRUST_SUB_TABLE: Record<string, { n: number; shares: Array<[string, number]> }> = ${JSON.stringify(trustSubOut)};
export const PHRASE_ROWS_TABLE: Record<string, { n: number; roles: Array<[string, number, number]> }> = ${JSON.stringify(rowsOut)};
export const PHRASE_EMOJI_TABLE: Record<string, { n: number; median: number; p75: number; kinds: Array<[string, number]> }> = ${JSON.stringify(emoOut)};
`;
writeFileSync(resolve(ROOT, "app/lib/compose-phrase-catalog-data.ts"), body);
console.log(`書いた: 信頼 ${Object.keys(trustOut).length} 組・終わりの言い方 ${Object.keys(endOut).length} 組（${used}番・外した ${skipped}）`);
