// AIX の種類のうち、往復文脈の「直前スタッフ発言」に変換できないものはどれか（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？実際スタッフが送る返信を生成する為にも」
//
// find-brain-gaps の G1（分類の穴・325件 34.5%）で最多は「直前=other × 顧客=other」77件。
// reply-context.ts の AIX_TO_STAFF は **9種類**しかマップしていない:
//   viewing_invite / meeting_place / property_send / property_recommendation /
//   estimate_sheet / property_check_result / application_push / condition_hearing / acknowledge_check
// 実際に押されている AIX はもっと多い。マップに無い AIX を押した直後は
// 直前スタッフ発言が other に落ち、往復文脈のセルが選ばれず**材料ゼロで生成**する。
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** reply-context.ts の AIX_TO_STAFF（ここに無い種類は aix_history 経由では other） */
const MAPPED = new Set([
  "viewing_invite", "meeting_place", "property_send", "property_recommendation",
  "estimate_sheet", "property_check_result", "application_push", "condition_hearing", "acknowledge_check",
]);

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data } = await sb.from("aix_usage_logs")
    .select("aix_type, created_at, conversation_id, generated_text")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(3000);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  console.log(`=== 直近${days}日に押された AIX ${rows.length}件 ===\n`);

  const byType = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const t = String(r.aix_type ?? "(不明)");
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(r);
  }

  const unmapped: Array<{ t: string; n: number; otherRate: number; sample: string }> = [];
  const mapped: Array<{ t: string; n: number }> = [];
  for (const [t, list] of byType) {
    // その AIX の本文を「直前スタッフ発言」として分類したら何になるか（本文の regex で救えるか）
    let other = 0;
    let sample = "";
    for (const r of list) {
      const text = String(r.generated_text ?? "");
      const k = classifyLastStaffTurn(text, { recentAixRows: [], lastStaffAt: String(r.created_at) });
      if (k.kind === "other") { other++; if (!sample && text) sample = text.replace(/\n/g, " ").slice(0, 76); }
    }
    if (MAPPED.has(t)) mapped.push({ t, n: list.length });
    else unmapped.push({ t, n: list.length, otherRate: list.length ? other / list.length : 0, sample });
  }

  console.log(`--- AIX_TO_STAFF にマップ済み（${mapped.length}種類）---`);
  for (const m of mapped.sort((a, b) => b.n - a.n)) console.log(`  ${String(m.n).padStart(4)}件  ${m.t}`);

  console.log(`\n--- **マップに無い**（${unmapped.length}種類）---`);
  console.log(`  件数  本文でも救えない率   種類`);
  let totalUn = 0, totalOther = 0;
  for (const u of unmapped.sort((a, b) => b.n - a.n)) {
    totalUn += u.n;
    totalOther += Math.round(u.otherRate * u.n);
    const flag = u.otherRate >= 0.5 ? "🔴" : u.otherRate > 0 ? "🟡" : "🟢";
    console.log(`  ${String(u.n).padStart(4)}件  ${flag} ${(u.otherRate * 100).toFixed(0).padStart(3)}%          ${u.t}`);
    if (u.otherRate > 0 && u.sample) console.log(`             例: ${u.sample}`);
  }
  console.log(`\n=== マップに無い AIX: ${totalUn}件 ===`);
  console.log(`  うち**本文の regex でも救えず other に落ちる**: ${totalOther}件（${totalUn ? ((totalOther / totalUn) * 100).toFixed(0) : "-"}%）`);
  console.log(`  → この直後の返信生成は、往復文脈のセルが選ばれず材料ゼロになる`);
  console.log(`\n※ 🟢 は本文の regex（STAFF_*_RE）が救っているので実害が小さい。🔴 が実害。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
