// scripts/audit-cost-burst-score.ts — yuma-cost-burst-test.ts の出力を読む（読むだけ・LLM なし）
//   今（連投の途中も呼ぶ）と案（途中を呼ばない）の最後の判断を、スタッフの道との一致（2段の約束の決まりどおりを含む）・番ごとの差（95% の幅）・
//   今と案の判断が同じ割合（今同士・案同士の揺れと並べる）で比べる。A1（途中の判断）の後の状態が P と同じだった割合も出す。
// 実行: npx tsx scripts/audit-cost-burst-score.ts [scripts/.replay-out/cost-burst.jsonl]
import { readFileSync } from "node:fs";

type B = { action?: string | null; reply_mode?: string | null; src?: string | null; dir?: string; phase?: string | null; aix?: string | null };
type R = { conv: string; scene: string; staffPath: string[]; now?: B[]; prop?: B[]; A1?: B[]; P?: B; error?: string; skip?: string } & Record<string, unknown>;
const rows = readFileSync(process.argv[2] ?? "scripts/.replay-out/cost-burst.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as R);
const PROP = /^property_(send|recommendation|pickup|search)$/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));
const pathOf = (x: B) => (x.reply_mode === "aix" && x.action ? x.action : "reply");
const samePath = (a: B, b: B) => { const x = pathOf(a), y = pathOf(b); return x === y || (PROP.test(x) && PROP.test(y)); };
function pathOk(x: B, staff: string[]): boolean {
  const brain = pathOf(x);
  if (brain === "reply" ? staff[0] === "reply" : staff.some((s) => sameAix(s, brain))) return true;
  const m = /two_stage_promise\((pickup|check|check_question|estimate)\)/.exec(x.src ?? "");
  if (!m || x.reply_mode === "aix") return false;
  const k = m[1];
  return staff.some((a) => (k === "pickup" && /^property_(send|recommendation|search)$/.test(a)) || (k.startsWith("check") && (a === "property_check_result" || a === "acknowledge_check")) || (k === "estimate" && a === "estimate_sheet"));
}
const meanCi = (xs: number[]) => { const n = xs.length; if (!n) return { m: NaN, ci: NaN, n }; const m = xs.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { m, ci: (1.96 * sd) / Math.sqrt(n), n }; };
const f = (o: { m: number; ci: number; n: number }, sign = false) => (o.n ? `${sign && o.m >= 0 ? "+" : ""}${Math.round(o.m * 100)}${sign ? "pt" : "%"}±${Math.round(o.ci * 100)}（n=${o.n}）` : "-");
const pairs = (xs: B[], ys: B[] | null) => { let a = 0, n = 0; if (ys) { for (const x of xs) for (const y of ys) { n++; if (samePath(x, y)) a++; } } else { for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) { n++; if (samePath(xs[i], xs[j])) a++; } } return n ? a / n : NaN; };
const ok = rows.filter((r) => !r.error && !r.skip && r.now?.length && r.prop?.length);
console.log(`番 ${ok.length}（エラー ${rows.filter((r) => r.error).length}・飛ばし ${rows.filter((r) => r.skip).length}）`);
const stateSame = ok.map((r) => { const ks = Object.keys(r).filter((k) => k.startsWith("same_state_")); return ks.filter((k) => r[k] === true).length / Math.max(1, ks.length); });
console.log(`途中の判断（A1）の後の状態（フェーズ・AIX）が連投の前（P）と同じ回: ${f(meanCi(stateSame))}`);
for (const s of ["全体", ...new Set(ok.map((r) => r.scene))]) {
  const rs = ok.filter((r) => s === "全体" || r.scene === s);
  const now = rs.map((r) => r.now!.filter((x) => pathOk(x, r.staffPath)).length / r.now!.length);
  const prop = rs.map((r) => r.prop!.filter((x) => pathOk(x, r.staffPath)).length / r.prop!.length);
  const diff = rs.map((_, i) => prop[i] - now[i]);
  const cross = rs.map((r) => pairs(r.now!, r.prop!)), selfNow = rs.map((r) => pairs(r.now!, null)), selfProp = rs.map((r) => pairs(r.prop!, null));
  const d = meanCi(diff);
  console.log(`${s.padEnd(15)} 道の一致 今 ${f(meanCi(now))}・案 ${f(meanCi(prop))}｜差（案−今）${f(d, true)}${d.n && d.m + d.ci < 0 ? " ← 下がる側" : ""}｜道が同じ: 今×案 ${f(meanCi(cross.filter((x) => !Number.isNaN(x))))}・今×今 ${f(meanCi(selfNow.filter((x) => !Number.isNaN(x))))}・案×案 ${f(meanCi(selfProp.filter((x) => !Number.isNaN(x))))}`);
}
for (const r of ok) {
  const p = (xs: B[]) => xs.map((x) => (x.reply_mode === "aix" ? x.action : "返信")).join(",");
  const n1 = r.now!.filter((x) => pathOk(x, r.staffPath)).length, p1 = r.prop!.filter((x) => pathOk(x, r.staffPath)).length;
  if (n1 !== p1) console.log(`  ${n1 > p1 ? "↓" : "↑"} ${r.conv} [${r.scene}] 人=${r.staffPath.join(",")} P=${p([r.P!])} A1=${p(r.A1 ?? [])} 今=${p(r.now!)} 案=${p(r.prop!)}`);
}
