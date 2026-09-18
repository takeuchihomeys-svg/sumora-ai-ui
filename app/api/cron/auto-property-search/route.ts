import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import {
  selectAutoSearchTargets, buildAutoSearchPayload,
  MAX_TARGETS_PER_RUN, RECENT_SENT_DAYS, NEW_CUSTOMER_DAYS,
  type AutoSearchMode, type AutoSearchCustomer,
} from "@/app/lib/auto-search-schedule";

export const maxDuration = 60;

// GET /api/cron/auto-property-search?mode=am|pm
//
// 2026-09-19 竹内:
//   「拡張ツールAIXモードにしている場合、毎日11:00になったら3日以内物件確認している人や
//     新規のお客さんの物件検索自動ですることできるか（AD高い順）。ルールは…本来の通り。
//     そして17:00に今日出た新規物件をおくる為本日の更新日付で検索したの送る形出来るか
//     （最新物件・AD順ではなくて更新順・項目は１ページだけ）」
//
// ここは**コマンドを積むだけ**。検索と送信は既存の仕組みがそのまま動く:
//   automation_commands（pending）→ 拡張の AIX モードの PC が /api/automation/pending?aix=1 で claim
//   → リアプロを自動入力して検索 → PDF と説明文を売上番長グループへ送信。
// 送信の仕組みも対象の抽出も二重に作らない（設計知見「入口は1つの関数にまとめる」）。
//
// 誰を選ぶか・どの条件かは app/lib/auto-search-schedule.ts の純関数1か所（四者同名）。
// AIX モードの PC が1台も無いまま3時間経ったコマンドは、既存の /api/automation/pending が error で閉じる。

type Row = AutoSearchCustomer & { customer_name?: string | null; desired_area?: string | null; area?: string | null };

export async function GET(req: NextRequest) {
  const mode = (req.nextUrl.searchParams.get("mode") === "pm" ? "pm" : "am") as AutoSearchMode;
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? MAX_TARGETS_PER_RUN);
  const now = Date.now();
  const jstDate = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("property_customers")
    // 2026-09-19 竹内「物件出ししたお客さんっていうのは送信じゃなくて確認したお客さんも含む」→ property_viewed_at も取る
    .select("id, customer_name, status, last_property_sent_at, property_viewed_at, created_at, desired_area, area")
    .limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Row[];
  // 検索条件（エリア）が無い人は拡張が空振りするので積まない
  const withCondition = rows.filter((r) => !!(r.desired_area || r.area));
  const targets = selectAutoSearchTargets(withCondition, { nowMs: now, limit: Number.isFinite(limit) ? limit : MAX_TARGETS_PER_RUN });

  // 同じ日・同じ便で既に積んでいたら積み直さない（cron の再実行・手動実行での二重積みを防ぐ）
  const { data: sameRun } = await supabase
    .from("automation_commands")
    .select("id, customer_ids, status, payload")
    .eq("command_type", "batch_property_search")
    .eq("payload->>source", "auto_schedule")
    .eq("payload->>mode", mode)
    .eq("payload->>jst_date", jstDate)
    .limit(500);
  const alreadyQueued = new Set<string>();
  for (const r of sameRun ?? []) {
    for (const id of ((r.customer_ids as string[] | null) ?? [])) alreadyQueued.add(String(id));
  }

  // 実行中・未実行のコマンドがある顧客には積まない（同じ人を二重に検索しない）
  const { data: openCmds } = await supabase
    .from("automation_commands")
    .select("customer_ids")
    .in("status", ["pending", "running"])
    .limit(500);
  const openIds = new Set<string>();
  for (const r of openCmds ?? []) {
    for (const id of ((r.customer_ids as string[] | null) ?? [])) openIds.add(String(id));
  }

  const queued: Array<{ id: string; name: string | null; reason: string; rp_update_days: number | null }> = [];
  const skipped: Array<{ id: string; name: string | null; why: string }> = [];
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  for (const t of targets) {
    const c = byId.get(t.id);
    if (alreadyQueued.has(t.id)) { skipped.push({ id: t.id, name: c?.customer_name ?? null, why: "今日この便で積み済み" }); continue; }
    if (openIds.has(t.id)) { skipped.push({ id: t.id, name: c?.customer_name ?? null, why: "未実行・実行中のコマンドあり" }); continue; }
    const payload = buildAutoSearchPayload(mode, t, now);
    if (dryRun) { queued.push({ id: t.id, name: c?.customer_name ?? null, reason: t.reason, rp_update_days: payload.rp_update_days }); continue; }
    const { error: insErr } = await supabase.from("automation_commands").insert({
      command_type: "batch_property_search",
      customer_ids: [t.id],
      sites: ["realnetpro"],
      payload,
      status: "pending",
    });
    if (insErr) { skipped.push({ id: t.id, name: c?.customer_name ?? null, why: `積めなかった: ${insErr.message}` }); continue; }
    queued.push({ id: t.id, name: c?.customer_name ?? null, reason: t.reason, rp_update_days: payload.rp_update_days });
  }

  const summary = {
    ok: true,
    mode,
    jst_date: jstDate,
    dry_run: dryRun,
    rule: mode === "pm"
      ? "本日の更新日付（更新日1日以内）・更新順・1ページだけ"
      : `直近${RECENT_SENT_DAYS}日に物件出しした人（送信 or 確認）＋登録${NEW_CUSTOMER_DAYS}日以内でまだ出していない人・更新日は前回出した日から・AD高い順`,
    customers: rows.length,
    targets: targets.length,
    queued: queued.length,
    skipped: skipped.length,
    queued_detail: queued,
    skipped_detail: skipped,
  };
  console.log("[auto-property-search]", JSON.stringify({ mode, jstDate, targets: targets.length, queued: queued.length, skipped: skipped.length }));
  return NextResponse.json(summary);
}
