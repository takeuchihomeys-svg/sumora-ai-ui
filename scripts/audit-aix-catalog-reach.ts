// scripts/audit-aix-catalog-reach.ts — スタッフが押した AIX が、その番でブレインに渡った AIX の辞書の一覧（catalogBlockForBrain）に入っていたか（台帳 #688・読むだけ・LLM なし）
// 実行: npx tsx scripts/audit-aix-catalog-reach.ts --from=<audit-aix-miss-causes の --json（--hits=N つき）>
// 2026-11-25 作業員A（竹内さん「AIX の種類をちゃんと読み取って理解できるのか」・統括役の頼み: 読み取りの入口の点検）
//   一覧は brain-core.ts:2876 の catalogBlockForBrain(brainScene, { sceneUncertain })。BRAIN_CATALOG_ALL_BUTTONS が既定 on（10/14 から）＝場面で絞らず、
//   選べるボタン（brainSelectable）は全部入る。入らないのは 選べない物（phone_followup・property_search）と、スイッチで止めたピッカー（新しいピッカー・審査のご相談・入居者の条件・お部屋止め・床の色）。
//   ここでは、本番の既定の env（このプロセスの env）で一覧を作り、押した AIX（種類／ピッカー）の名前が一覧の文に出るかで見る（番ごとの場面は使わない＝全部のボタンが入る既定の時と同じ）
import { readFileSync } from "node:fs";
import { AIX_CATALOG, catalogBlockForBrain } from "../app/lib/aix-catalog";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
type M = { staff_aix: string | null; staff_check_pattern: string | null; cause: string; brain_action: string | null; staff_writer: string };
const j = JSON.parse(readFileSync(arg("from"), "utf8")) as { misses: M[]; hits: M[] };
const block = catalogBlockForBrain(null, {});
const entryOf = (t: string, p: string | null) => AIX_CATALOG.find((e) => e.aixType === t && (p ? e.picker?.value === p : true)) ?? AIX_CATALOG.find((e) => e.aixType === t);
const inList = (t: string | null, p: string | null): { ok: boolean; why: string } => {
  if (!t) return { ok: false, why: "押した AIX が無い" };
  const e = entryOf(t, p);
  if (!e) return { ok: false, why: `辞書に無い（${t}${p ? `/${p}` : ""}）` };
  if (!e.brainSelectable) return { ok: false, why: `ブレインが選べない物（${e.button}）` };
  const label = e.picker ? e.picker.label : e.button;
  return block.includes(label) ? { ok: true, why: "入っていた" } : { ok: false, why: `スイッチで止めたピッカー（${e.button}→${label}）` };
};
const tally = (xs: M[]) => {
  const m = new Map<string, number>(); let ok = 0;
  for (const x of xs) { const r = inList(x.staff_aix, x.staff_check_pattern); if (r.ok) ok++; else m.set(r.why, (m.get(r.why) ?? 0) + 1); }
  return { n: xs.length, ok, why: [...m].sort((a, b) => b[1] - a[1]) };
};
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 1000) / 10}%` : "—");
const misses = j.misses.filter((x) => !x.cause.startsWith("④")), staffOnly = j.misses.filter((x) => x.cause.startsWith("④"));
for (const [name, xs] of [["外れ（④ を除く）", misses], ["④ スタッフだけが知る番", staffOnly], ["当たり", j.hits]] as const) {
  const t = tally(xs);
  console.log(`■ ${name}: ${t.n}番・押した AIX が一覧に入っていた ${t.ok}（${pct(t.ok, t.n)}）`);
  for (const [w, n] of t.why.slice(0, 8)) console.log(`    入っていない: ${w} ${n}`);
}
console.log(`\n（一覧の字数 ${block.length}・本番の既定の env で作った一覧・番ごとの場面では絞らない＝BRAIN_CATALOG_ALL_BUTTONS 既定 on）`);
