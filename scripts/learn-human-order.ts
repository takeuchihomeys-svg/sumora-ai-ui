// scripts/learn-human-order.ts
// 2026-11-10 竹内さん「1ヶ月スタッフが動かしている。そこ参考にできるかな」→ C（A: 配線を直す＋B: 既存データから学ぶ）
//
// B: 既存の記録から「スタッフが実際にどう入力したか」を学ぶ（読むだけ・書き込みなし）。
//   search_audits.filled.form（案内モードで実際に入っていた値）と steps の順番を使う。
//   分かる事:
//     ① どの項目を・どの順で入れたか（steps の並び）
//     ② 実際に入った値のパターン（家賃・更新日・間取り・エリア）
//     ③ 入力の総時間（最初の段から検索を押すまで）
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/learn-human-order.ts --days=30
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const argOf = (name: string, def: string): string => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const i = args.indexOf(hit);
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const DAYS = Math.max(1, Math.min(180, Number(argOf("days", "30")) || 30));

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

type Step = { at?: number; k?: string; d?: string | null };
type Row = { run_id: string; trigger: string | null; site: string | null; steps: Step[] | null; filled: Record<string, unknown> | null; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let from = 0; from < 4000; from += 500) {
    const r = await sb.from("search_audits")
      .select("run_id,trigger,site,steps,filled,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + 499);
    if (r.error) { console.error("読めません:", r.error.message); process.exit(1); }
    rows.push(...((r.data ?? []) as Row[]));
    if (!r.data || r.data.length < 500) break;
  }

  // 案内モード（スタッフが押した回）
  const humanRuns = rows.filter((r) => r.trigger === "single" || r.trigger === "bulk_manual");
  console.log(`\n記録 ${rows.length} 回（直近 ${DAYS} 日）・案内モード ${humanRuns.length} 回`);

  // ① 手順の順番（steps の k を並べる・2件以上の回だけ）
  const stepOrders = new Map<string, number>();
  for (const r of humanRuns) {
    const ks = (r.steps ?? []).map((s) => String(s.k ?? "")).filter((k) => k && k !== "begin" && k !== "finish");
    if (ks.length < 3) continue;
    const sig = ks.join(" > ");
    stepOrders.set(sig, (stepOrders.get(sig) ?? 0) + 1);
  }
  console.log(`\n■ 実際の手順（${stepOrders.size} 通り）`);
  [...stepOrders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([sig, n]) => {
    console.log(`  ${n}回: ${sig.slice(0, 180)}`);
  });

  // ② 実際に入った値
  const forms = humanRuns.map((r) => r.filled?.form).filter((f): f is Record<string, unknown> => !!f && typeof f === "object");
  console.log(`\n■ 実際に入った値（${forms.length} 回分が読めた）`);
  const tally = (key: string) => {
    const m = new Map<string, number>();
    for (const f of forms) {
      const v = f[key];
      if (v == null || v === "" || v === "-1") continue;
      const s = String(v).slice(0, 24);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  };
  for (const [key, ja] of [["rent_max", "家賃の上限"], ["rent_min", "家賃の下限"], ["update_days", "更新日"], ["walk", "徒歩"], ["age", "築年数"]] as Array<[string, string]>) {
    const t = tally(key);
    if (t.length) console.log(`  ${ja}: ${t.map(([v, n]) => `${v}(${n})`).join(" / ")}`);
  }
  const layoutTally = new Map<string, number>();
  for (const f of forms) {
    const arr = Array.isArray(f.layouts) ? (f.layouts as unknown[]) : [];
    for (const v of arr) layoutTally.set(String(v), (layoutTally.get(String(v)) ?? 0) + 1);
  }
  if (layoutTally.size) {
    console.log(`  間取り: ${[...layoutTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}(${n})`).join(" / ")}`);
  }

  // ③ 入力の総時間（最初の段から検索の段まで）
  const durs: number[] = [];
  for (const r of humanRuns) {
    const ats = (r.steps ?? []).map((s) => Number(s.at)).filter((n) => Number.isFinite(n) && n > 0);
    if (ats.length < 2) continue;
    const search = (r.steps ?? []).find((s) => String(s.k) === "search" || String(s.k) === "page:search");
    const end = search && Number(search.at) ? Number(search.at) : ats[ats.length - 1];
    const d = end - Math.min(...ats);
    if (d > 0 && d < 30 * 60_000) durs.push(d);
  }
  durs.sort((a, b) => a - b);
  if (durs.length) {
    const q = (p: number) => durs[Math.min(durs.length - 1, Math.floor(durs.length * p))];
    console.log(`\n■ 入力の総時間（${durs.length} 回）`);
    console.log(`  中央値 ${Math.round(q(0.5) / 1000)}秒・p25 ${Math.round(q(0.25) / 1000)}秒・p75 ${Math.round(q(0.75) / 1000)}秒・最長 ${Math.round(durs[durs.length - 1] / 1000)}秒`);
  } else {
    console.log("\n■ 入力の総時間: 材料が無い");
  }

  console.log(`\n■ 使い方`);
  console.log(`  ・手順の順番 → 自動モードでも同じ順で入れる（いまは 家賃→面積→徒歩→築年→間取り の固定）`);
  console.log(`  ・実際の値 → 「この条件ならこの値」の目安（外しの検知に使える）`);
  console.log(`  ・総時間 → 自動の待ちが長すぎ／短すぎの判断材料`);
}

main().catch((e) => { console.error(e); process.exit(1); });
