// scripts/audit-condition-move-in.ts — 本番の条件の入居時期（move_in_time）の全件に、今の読みと新しい読み（resolveConditionMoveIn）を当てて違う行を数える
//   2026-11-03 統括役の頼み。読むのは文と時刻だけ（property_customers の move_in_time・updated_at・created_at と、条件の履歴の move_in_time の最後の時刻）。
//   夜だけ（JST 9〜22時は動かない・--force で手元の確かめだけ）。LLM なし・書き込みなし・費用 0。
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-move-in.ts [--list]
import { createClient } from "@supabase/supabase-js";
import { resolveMoveInStart, resolveConditionMoveIn, ymdStr } from "../app/lib/contact-promise";

const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

(async () => {
  const rows: Array<{ id: string; move_in_time: string; updated_at: string | null; created_at: string | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("property_customers").select("id, move_in_time, updated_at, created_at").not("move_in_time", "is", null).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const setAt = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 300) {
    const { data } = await sb.from("property_condition_history").select("property_customer_id, created_at").eq("changed_field", "move_in_time").in("property_customer_id", rows.slice(i, i + 300).map((r) => r.id)).order("created_at", { ascending: false });
    for (const h of data ?? []) if (!setAt.has(h.property_customer_id as string)) setAt.set(h.property_customer_id as string, h.created_at as string);
  }
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let n = 0, diff = 0, oldFutureNewPast = 0, oldNoneNewSome = 0, otherDiff = 0, withHistory = 0;
  const list: string[] = [];
  for (const r of rows) {
    if (!r.move_in_time.trim()) continue;
    n++;
    const base = setAt.get(r.id) ?? r.updated_at ?? r.created_at ?? null;
    if (setAt.has(r.id)) withHistory++;
    const old = resolveMoveInStart(r.move_in_time, now);
    const oldKind = !old ? "none" : ymdStr(old.ymd) < today ? "past" : "future";
    const nw = resolveConditionMoveIn(r.move_in_time, { nowIso: now, setAtIso: base });
    const oldY = old ? ymdStr(old.ymd) : "-", newY = nw.kind !== "none" && nw.start ? ymdStr(nw.start.ymd) : "-";
    if (oldKind === nw.kind && oldY === newY) continue;
    diff++;
    if (oldKind === "future" && nw.kind === "past") oldFutureNewPast++;
    else if (oldKind === "none" && nw.kind !== "none") oldNoneNewSome++;
    else otherDiff++;
    if (process.argv.includes("--list") && list.length < 80) list.push(`- 「${r.move_in_time.replace(/\s+/g, " ").slice(0, 30)}」 基準 ${base?.slice(0, 10) ?? "-"}: 今 ${oldKind} ${oldY} → 新 ${nw.kind} ${newY}`);
  }
  console.log(`# 条件の入居時期の読み（本番 ${n}行・条件の履歴あり ${withHistory}）`);
  console.log(`- 違う行: ${diff}（今は先・新は過ぎた ${oldFutureNewPast}／今は読めない・新は読めた ${oldNoneNewSome}／その他 ${otherDiff}）`);
  if (list.length) console.log(list.join("\n"));
})().catch((e) => { console.error(e); process.exitCode = 1; });
