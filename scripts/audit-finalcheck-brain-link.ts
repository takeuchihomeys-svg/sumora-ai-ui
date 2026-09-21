// final-check にブレイン・AIX-META がどれだけ届いているかを実データで見る（読み取りのみ）
//
// 2026-09-21 竹内「ファイナルチェックのところはちゃんとブレインやAIX-METAと連携されてるんかな？」
//
// コードで見ると、渡していたのは action と enforcement_level（＋engagement_stance）の3つだけで、
// ブレインが出している reply_direction / key_topics / avoid_topics / recommended_tone /
// closing_strategy / reply_mode は**1つも渡っていなかった**。
// ここでは「実際にブレインがそれらを出せていたのか（出しているのに捨てていたのか）」を数える。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-finalcheck-brain-link.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";

async function main() {
  const days = Number(process.env.DAYS ?? 30);

  // ① ブレインの判断（brain_decision_logs）に何が入っているか
  const logs = await page("brain_decision_logs", "*", "created_at", days);
  console.log(`=== ① ブレインの判断 ${logs.length}件（直近${days}日）===`);
  if (logs.length > 0) {
    console.log(`   列: ${Object.keys(logs[0]).join(", ")}\n`);
    const metaKey = Object.keys(logs[0]).find((k) => /meta|decision|payload|result/.test(k) && typeof logs[0][k] === "object");
    if (metaKey) {
      const fields = ["action", "enforcement_level", "reply_direction", "key_topics", "avoid_topics", "recommended_tone", "closing_strategy", "reply_mode", "reply_opener"];
      const have = new Map<string, number>();
      for (const r of logs) {
        const m = (r[metaKey] ?? {}) as Record<string, unknown>;
        for (const f of fields) {
          const v = m[f];
          const filled = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
          if (filled) have.set(f, (have.get(f) ?? 0) + 1);
        }
      }
      console.log(`   ブレインが実際に値を入れている割合（${metaKey}）:`);
      for (const f of fields) {
        const c = have.get(f) ?? 0;
        const passed = ["action", "enforcement_level"].includes(f);
        console.log(`     ${pct(c, logs.length).padStart(6)}  ${String(c).padStart(5)}/${logs.length}  ${f.padEnd(20)} ${passed ? "→ 検査に届いていた" : "→ **検査に届いていなかった**"}`);
      }
    } else {
      console.log(`   ⚠ meta らしき列が見つからない`);
    }
  }

  // ② 生成時のスナップショット（conversations.ai_draft_check）に検査の結果が残っている
  const convs = await page("conversations", "id, ai_draft_check, suggested_aix_meta, updated_at", "updated_at", days);
  const withCheck = convs.filter((c) => c.ai_draft_check && typeof c.ai_draft_check === "object");
  console.log(`\n=== ② 最終チェックの結果が残っている会話 ${withCheck.length}件 ===`);
  const codes = new Map<string, number>();
  let okCount = 0;
  for (const c of withCheck) {
    const chk = c.ai_draft_check as { ok?: boolean; issues?: Array<{ code?: string; severity?: string }> };
    if (chk.ok) okCount++;
    for (const i of chk.issues ?? []) codes.set(String(i.code ?? "?"), (codes.get(String(i.code ?? "?")) ?? 0) + 1);
  }
  console.log(`   指摘なし ${okCount}件 / 指摘あり ${withCheck.length - okCount}件`);
  console.log(`   指摘の内訳:`);
  for (const [k, c] of [...codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    const wasHardcoded = k === "GRATITUDE_OPENING" || k === "CONDITION_OPENING";
    console.log(`     ${String(c).padStart(4)}回  ${k}${wasHardcoded ? "  ← 「一択」の決めつけ（2026-09-21 に廃止）" : ""}`);
  }

  // ③ ブレインの判断と検査が同時に残っている会話で、ブレインが出していた材料を数える
  console.log(`\n=== ③ 検査が走った時にブレインが持っていた材料 ===`);
  const both = withCheck.filter((c) => c.suggested_aix_meta && typeof c.suggested_aix_meta === "object");
  const fields = ["action", "reply_direction", "key_topics", "avoid_topics", "recommended_tone", "closing_strategy", "reply_mode", "reply_opener"];
  const have = new Map<string, number>();
  for (const c of both) {
    const m = c.suggested_aix_meta as Record<string, unknown>;
    for (const f of fields) {
      const v = m[f];
      const filled = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
      if (filled) have.set(f, (have.get(f) ?? 0) + 1);
    }
  }
  console.log(`   対象 ${both.length}件`);
  for (const f of fields) {
    const c = have.get(f) ?? 0;
    const passed = f === "action";
    console.log(`     ${pct(c, both.length).padStart(6)}  ${String(c).padStart(5)}/${both.length}  ${f.padEnd(20)} ${passed ? "→ 検査に届いていた" : "→ **検査に届いていなかった**"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
