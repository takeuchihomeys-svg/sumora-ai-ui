// scripts/kb-tree-propose.ts — 設計知見の木（parent）の最初の結び付けの案と、P0 の束ね案を作る（読むだけ・DB に書かない・LLM なし）
//
// 2026-11-03 作業員6（竹内さん KB P1「設計知見そのものにも統括を作る」）。
//   P1 → いちばん近い P0（近さ ≥ --p0=0.45・札が重なれば +0.05）／P2 → いちばん近い P1（≥ --p1=0.62）。近さは embedding の cos。
//   P0 の束ね案: P0 どうしで近さ ≥ --merge=0.70 の組を束ねる候補に（題と中身は並べて出す・新しい1行の文は人が書く）。
//   出力は Markdown（--out=<scratchpad のファイル>）。DB に書くのは統括が案を見てから（--apply は作らない）。
// 実行: npx tsx --env-file=.env.local scripts/kb-tree-propose.ts --out=<file.md> [--p0=0.45] [--p1=0.62] [--merge=0.70]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = { id: string; title: string; insight: string; priority: number | null; tags: string[] | null; created_at: string; embedding: string | number[] | null };
const vec = (e: Row["embedding"]): number[] | null => (Array.isArray(e) ? e : typeof e === "string" ? (JSON.parse(e) as number[]) : null);
const cos = (a: number[], b: number[]) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / (Math.sqrt(x * y) || 1); };

async function main() {
  const rows: Row[] = [];
  for (let f = 0; ; f += 500) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, priority, tags, created_at, embedding").eq("is_current", true).order("created_at").range(f, f + 499);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 500) break;
  }
  const withV = rows.map((r) => ({ ...r, v: vec(r.embedding) })).filter((r) => r.v);
  const P0 = withV.filter((r) => r.priority === 0), P1 = withV.filter((r) => r.priority === 1), P2 = withV.filter((r) => r.priority === 2);
  const tagBonus = (a: Row, b: Row) => ((a.tags ?? []).some((t) => (b.tags ?? []).includes(t)) ? 0.05 : 0);
  const best = (r: typeof withV[number], pool: typeof withV) => pool.filter((p) => p.id !== r.id).map((p) => ({ p, s: cos(r.v!, p.v!) + tagBonus(r, p) })).sort((a, b) => b.s - a.s)[0] ?? null;
  const th0 = Number(arg("p0", "0.45")), th1 = Number(arg("p1", "0.62")), thm = Number(arg("merge", "0.70"));
  const s8 = (id: string) => id.slice(0, 8);
  const L: string[] = [`# 設計知見の木の案（${new Date().toISOString().slice(0, 10)}・読むだけ・DB には書いていない）`, "",
    `現行 P0 ${P0.length}・P1 ${P1.length}・P2 ${P2.length}（embedding のある行）。線: P1→P0 ${th0}・P2→P1 ${th1}・P0 の束ね ${thm}`, ""];
  // P0 の束ね
  L.push("## 1. P0 の束ね案（目安 5）", "", "| 組 | 近さ | 元の id と題 |", "|---|---|---|");
  const pairs: Array<{ a: typeof withV[number]; b: typeof withV[number]; s: number }> = [];
  for (let i = 0; i < P0.length; i++) for (let j = i + 1; j < P0.length; j++) { const s = cos(P0[i].v!, P0[j].v!); if (s >= thm) pairs.push({ a: P0[i], b: P0[j], s }); }
  pairs.sort((x, y) => y.s - x.s).forEach((p, k) => L.push(`| ${k + 1} | ${p.s.toFixed(2)} | ${s8(p.a.id)}「${p.a.title.slice(0, 50)}」＋ ${s8(p.b.id)}「${p.b.title.slice(0, 50)}」 |`));
  L.push("", "P0 の一覧（束ねる時の材料）:", ...P0.map((r) => `- ${s8(r.id)}（${r.created_at.slice(0, 10)}）${r.title.slice(0, 90)}`), "");
  // P1 → P0
  const p1Links = P1.map((r) => ({ r, b: best(r, P0) }));
  const linked1 = p1Links.filter((x) => x.b && x.b.s >= th0);
  L.push(`## 2. P1 → P0 の結び付けの案（${linked1.length}/${P1.length}・残りは親の無い P1）`, "");
  const byP0 = new Map<string, typeof linked1>();
  for (const x of linked1) { const k = x.b!.p.id; const l = byP0.get(k) ?? []; l.push(x); byP0.set(k, l); }
  for (const p of P0) {
    const l = (byP0.get(p.id) ?? []).sort((a, b) => b.b!.s - a.b!.s);
    L.push(`### ${s8(p.id)} ${p.title.slice(0, 70)}（子 ${l.length}）`, ...l.slice(0, 25).map((x) => `- ${s8(x.r.id)} ${x.b!.s.toFixed(2)} ${x.r.title.slice(0, 80)}`), l.length > 25 ? `- …ほか ${l.length - 25}` : "", "");
  }
  L.push("### 親の無い P1（近さが線に届かない・上位30）", ...p1Links.filter((x) => !x.b || x.b.s < th0).slice(0, 30).map((x) => `- ${s8(x.r.id)} ${x.b ? x.b.s.toFixed(2) : "-"} ${x.r.title.slice(0, 80)}`), "");
  // P2 → P1
  const p2Links = P2.map((r) => ({ r, b: best(r, P1) })).filter((x) => x.b && x.b.s >= th1);
  L.push(`## 3. P2 → P1 の結び付けの案（${p2Links.length}/${P2.length}）・近い順の上位60`, "", ...p2Links.sort((a, b) => b.b!.s - a.b!.s).slice(0, 60).map((x) => `- ${s8(x.r.id)} → ${s8(x.b!.p.id)} ${x.b!.s.toFixed(2)} ${x.r.title.slice(0, 60)}`), "");
  // 書き込み用（統括が見てから）
  const plan = [...linked1.map((x) => ({ id: x.r.id, parent: x.b!.p.id, s: +x.b!.s.toFixed(3) })), ...p2Links.map((x) => ({ id: x.r.id, parent: x.b!.p.id, s: +x.b!.s.toFixed(3) }))];
  const out = arg("out");
  if (!out) throw new Error("--out=<scratchpad のファイル> を付ける");
  writeFileSync(out, L.filter((x) => x !== undefined).join("\n"));
  writeFileSync(out.replace(/\.md$/, "") + ".plan.json", JSON.stringify(plan));
  console.log(`P0 束ね候補 ${pairs.length}・P1→P0 ${linked1.length}/${P1.length}・P2→P1 ${p2Links.length}/${P2.length} → ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
