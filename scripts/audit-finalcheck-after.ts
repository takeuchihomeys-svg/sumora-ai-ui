// 最終チェックを絞った後、本当に「誤字・禁止用語・ハルシネーション」だけになったか（読み取りのみ）
//
// 2026-09-21 竹内「これでブレインの考え方が優先されてファイナルチェックは文字の誤字や禁止用語入れない
//   ハルシネーション防ぐ部分に限定されて質よくなったかな？」
//
// 設計知見:
//   ・「直した効果は日別の時系列で確かめる — 全体の率は過去の分で薄まる」
//   ・「効果は平均ではなく狙った事象で測る」
//   ・「分類に無い code は fact 扱い（＝出す）」→ **分類漏れが無いか実データの全 code で確かめる**
//
// 実行: npx tsx --env-file=.env.local scripts/audit-finalcheck-after.ts
import { createClient } from "@supabase/supabase-js";
import { classifyIssueScope } from "../app/lib/final-check-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";

/** 竹内さんの言う「最終チェックが見るべき物」に当たるか（人が読んで判断するための当たり） */
const EXPECTED_FACT = /FABRICAT|UNSENT|UNGROUNDED|NO_BASIS|ASSERT|MISSED_QUESTION|DOUBLE_DECLARATION|TIME_INVALID|NG_PROPERTY|BANNED|PLACEHOLDER|NAME|RULE_VIOLATION|STAGE|SENSITIVE|DUPLICATE|UNCHECKED|PARTIALLY|REVISION_EXHAUSTED|MISROUTED|SUBJECT_CONFUSION|OMITTED|ECHO_FROM_BRAIN|COST_|GUIDE_POSSIBLE_NO_DATE|SCHEDULE_/;

async function main() {
  const days = Number(process.env.DAYS ?? 45);
  const convs = await page("conversations", "id, ai_draft_check, updated_at", "updated_at", days);
  const withCheck = convs.filter((c) => c.ai_draft_check && typeof c.ai_draft_check === "object");
  console.log(`=== 材料: 最終チェックの結果が残っている会話 ${withCheck.length}件（直近${days}日）===\n`);

  type Issue = { code?: string; severity?: string; message?: string };
  const all: Issue[] = [];
  for (const c of withCheck) {
    const chk = c.ai_draft_check as { issues?: Issue[] };
    for (const i of chk.issues ?? []) all.push(i);
  }
  console.log(`=== ① 出ていた指摘 ${all.length}件を新しい分類に当てる ===`);
  const byScope = new Map<string, number>();
  const byCode = new Map<string, { n: number; scope: string; sev: Set<string> }>();
  for (const i of all) {
    const scope = classifyIssueScope(i.code);
    byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
    const k = String(i.code ?? "?");
    const b = byCode.get(k) ?? { n: 0, scope, sev: new Set<string>() };
    b.n++; b.sev.add(String(i.severity ?? "?")); byCode.set(k, b);
  }
  for (const s of ["fact", "safety", "style"]) {
    const n = byScope.get(s) ?? 0;
    console.log(`   ${s.padEnd(7)} ${String(n).padStart(4)}件 (${pct(n, all.length)})  ${s === "style" ? "← 画面から消える・作り直させない" : "← 出す"}`);
  }
  const shown = (byScope.get("fact") ?? 0) + (byScope.get("safety") ?? 0);
  console.log(`\n   → スタッフに見せる指摘は ${all.length}件 → **${shown}件**（${pct(all.length - shown, all.length)} 減）`);

  console.log(`\n=== ② code ごと（分類が正しいか目で読む）===`);
  console.log(`   件数  分類    severity        code`);
  for (const [k, v] of [...byCode.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const flag = v.scope !== "style" && !EXPECTED_FACT.test(k) ? "  ⚠ 文体では？（分類を見直す）" : "";
    console.log(`   ${String(v.n).padStart(4)}  ${v.scope.padEnd(6)}  ${[...v.sev].join(",").padEnd(14)}  ${k}${flag}`);
  }

  console.log(`\n=== ③ 残る指摘は「誤字・禁止用語・ハルシネーション」か（1件ずつ読む）===`);
  const kept = all.filter((i) => classifyIssueScope(i.code) !== "style");
  const seen = new Set<string>();
  for (const i of kept) {
    const k = String(i.code);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`${"─".repeat(74)}`);
    console.log(`   [${classifyIssueScope(i.code)}] ${k}`);
    console.log(`   ${String(i.message ?? "").slice(0, 150)}`);
    if (seen.size >= 12) break;
  }

  console.log(`\n=== ④ ブロック（作り直しを起こす）指摘のうち文体はどれだけあったか ===`);
  const blocks = all.filter((i) => i.severity === "block");
  const blockStyle = blocks.filter((i) => classifyIssueScope(i.code) === "style");
  console.log(`   block ${blocks.length}件 / うち文体 ${blockStyle.length}件 (${pct(blockStyle.length, blocks.length)})`);
  console.log(`   → 文体が block だと作り直し（＝生成をもう1回）が走っていた。これが止まる`);
  for (const i of blockStyle.slice(0, 5)) console.log(`     ${i.code}: ${String(i.message ?? "").slice(0, 90)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
