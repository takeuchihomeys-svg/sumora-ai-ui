// AIX【物件確認した】の文がそのまま送れているか・何を直されているか（読み取りのみ）
//
// 2026-09-21 竹内「また他に必要な改善あれば教えて。実際の文使いやすいように」
//
// 「使いやすい」＝ スタッフが直さずそのまま送れること。直されている所が改善の候補。
// 設計知見「生成文と実送信の差分が正解データ」「実送信だけ見るとAIが書いた文を根拠にする＝循環」。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-check-result-quality.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 行の集合の差分（どの行が消され・足されたか） */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const A = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean));
  const B = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean));
  return {
    removed: [...A].filter((l) => !B.has(l)),
    added: [...B].filter((l) => !A.has(l)),
  };
}

async function page(days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, ai_draft, sent_reply, aix_action, created_at")
      .like("aix_action", "property_check_result%")
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const rows = (await page(DAYS)).filter((r) => String(r.sent_reply ?? "").trim() && String(r.ai_draft ?? "").trim());
  console.log(`=== AIX【物件確認した】下書きと実送信が揃う ${rows.length}件（直近${DAYS}日）===\n`);

  const same = rows.filter((r) => String(r.ai_draft).trim() === String(r.sent_reply).trim());
  console.log(`=== ① そのまま送れているか ===`);
  console.log(`   そのまま送った ${same.length}件（${pct(same.length, rows.length)}）`);
  console.log(`   直された       ${rows.length - same.length}件（${pct(rows.length - same.length, rows.length)}）`);

  // 種類別
  const byAction = new Map<string, { n: number; same: number }>();
  for (const r of rows) {
    const k = String(r.aix_action);
    const c = byAction.get(k) ?? { n: 0, same: 0 };
    c.n++;
    if (String(r.ai_draft).trim() === String(r.sent_reply).trim()) c.same++;
    byAction.set(k, c);
  }
  console.log(`\n   ─ 種類ごと ─`);
  for (const [k, c] of [...byAction.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   ${k.padEnd(38)} ${String(c.n).padStart(4)}件 ／ そのまま ${String(c.same).padStart(3)}件（${pct(c.same, c.n)}）`);
  }

  // ② 消された行・足された行（＝直すべき所）
  const changed = rows.filter((r) => String(r.ai_draft).trim() !== String(r.sent_reply).trim());
  const removedCount = new Map<string, number>();
  const addedCount = new Map<string, number>();
  for (const r of changed) {
    const d = lineDiff(String(r.ai_draft), String(r.sent_reply));
    for (const l of d.removed) {
      const k = mask(l).replace(/[^\s]{2,24}\s*\d{1,4}号室/g, "〈物件〉").slice(0, 46);
      if (k.length >= 6) removedCount.set(k, (removedCount.get(k) ?? 0) + 1);
    }
    for (const l of d.added) {
      const k = mask(l).replace(/[^\s]{2,24}\s*\d{1,4}号室/g, "〈物件〉").slice(0, 46);
      if (k.length >= 6) addedCount.set(k, (addedCount.get(k) ?? 0) + 1);
    }
  }
  console.log(`\n=== ② スタッフが**消した**行（上位15）＝ AI が書きすぎている所 ===`);
  for (const [l, n] of [...removedCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${String(n).padStart(3)}回  ${l}`);
  }
  console.log(`\n=== ③ スタッフが**足した**行（上位15）＝ AI が書けていない所 ===`);
  for (const [l, n] of [...addedCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${String(n).padStart(3)}回  ${l}`);
  }

  // ④ 長さの差（AI が長すぎないか）
  const lenDiff = changed.map((r) => String(r.sent_reply).trim().length - String(r.ai_draft).trim().length);
  if (lenDiff.length) {
    lenDiff.sort((a, b) => a - b);
    const med = lenDiff[Math.floor(lenDiff.length / 2)];
    const shorter = lenDiff.filter((d) => d < -20).length;
    const longer = lenDiff.filter((d) => d > 20).length;
    console.log(`\n=== ④ 直した後の長さ ===`);
    console.log(`   中央値 ${med > 0 ? "+" : ""}${med}字 ／ 20字以上短くした ${shorter}件（${pct(shorter, lenDiff.length)}） ／ 20字以上長くした ${longer}件（${pct(longer, lenDiff.length)}）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
