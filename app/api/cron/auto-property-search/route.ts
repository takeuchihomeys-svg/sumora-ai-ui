import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import {
  selectAutoSearchTargets, buildAutoSearchPayload, isBatchedRun,
  MAX_TARGETS_PER_RUN, RECENT_SENT_DAYS, NEW_CUSTOMER_DAYS,
  AUTO_SEARCH_SITES, autoStartAtMs, notBeforeSchedule, LEGACY_AM_IS_WIDE,
  type AutoSearchMode, type AutoSearchCustomer, type AutoSearchTarget,
} from "@/app/lib/auto-search-schedule";
import { planPayload, type UpdateDaysPlan } from "@/app/lib/search-update-days";
import { planUpdateDaysFor } from "@/app/lib/search-update-days-server";
import {
  planEnv, selectPlannedTargets, planByCustomerPayload, STATE_JA,
  type AutoSearchPlan, type AutoSearchState,
} from "@/app/lib/auto-search-plan";
import { loadStateInputs } from "@/app/lib/auto-search-plan-server";

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
//
// 2026-09-27 竹内「ITANDI もおねがい」「開始時間を 11:00 と 17:00 ではなく 10:15〜11:15・16:15〜17:15 の中で
//   ランダムに不規則性をもって毎日変える」:
//   ・sites はリアプロと ITANDI（AUTO_SEARCH_SITES）。ITANDI のタブが無い PC は拡張が ITANDI だけ飛ばす
//   ・cron は窓より前（10:00・16:00 JST）に積むだけ。payload.not_before（日ごとに窓の中でばらつく・11時は1人ずつずらす）
//     より前は /api/automation/pending が渡さない。3時間の期限も not_before から数える
//   ・?dry_run=1 で積まずに、誰を・何時から（not_before）を返す

type Row = AutoSearchCustomer & { customer_name?: string | null; desired_area?: string | null; area?: string | null; rp_update_days?: number | null };

export async function GET(req: NextRequest) {
  const mode = (req.nextUrl.searchParams.get("mode") === "pm" ? "pm" : "am") as AutoSearchMode;
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? MAX_TARGETS_PER_RUN);
  const now = Date.now();
  const jstDate = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 2026-10-01 竹内「いっかい今はとめておく」: 一時停止中（automation_settings.paused）は積まない（拡張の受け取り口 /api/automation/pending でも止まる）
  if (!dryRun) {
    const { data: st } = await supabase.from("automation_settings").select("paused").eq("id", 1).maybeSingle();
    if ((st as { paused?: boolean } | null)?.paused) return NextResponse.json({ skipped: "paused", mode, jstDate });
  }

  const { data, error } = await supabase
    .from("property_customers")
    // 2026-09-19 竹内「物件出ししたお客さんっていうのは送信じゃなくて確認したお客さんも含む」→ property_viewed_at も取る
    .select("id, customer_name, status, last_property_sent_at, property_viewed_at, created_at, desired_area, area, rp_update_days")
    .limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Row[];
  // 検索条件（エリア）が無い人は拡張が空振りするので積まない
  const withCondition = rows.filter((r) => !!(r.desired_area || r.area));
  const lim = Number.isFinite(limit) ? limit : MAX_TARGETS_PER_RUN;

  // 2026-09-30 v2.5.44 竹内さんの決定: お客様の状態（実際にお客様へ届けた送付・お客様の発言・条件の変更・前回の検索）で選び、
  //   お客様ごとの並び・更新日・止める線を payload.plan_by_customer に載せる（auto-search-plan.ts の PLAN_TABLE 1か所）。
  //   AUTO_SEARCH_PLAN=legacy で今までの選び方（午前 AD 順・広げて）に戻る。材料が読めない時も今までの選び方（検索は止めない）
  const env = planEnv();
  let planMode: "plan" | "legacy" = env.legacy ? "legacy" : "plan";
  let planNoteAll: string | null = env.legacy ? "AUTO_SEARCH_PLAN=legacy" : null;
  const planById = new Map<string, AutoSearchPlan>();
  const stateById = new Map<string, { state: AutoSearchState; reason: string; runReason?: string }>();
  let stateBreakdown: Record<string, number> | null = null;
  let notThisRun: Array<{ id: string; name: string | null; state: string; why: string }> = [];
  let overLimit: Array<{ id: string; name: string | null; state: string }> = [];
  let targets: AutoSearchTarget[] = [];
  if (planMode === "plan") {
    try {
      const inputs = await loadStateInputs(supabase, withCondition, now);
      const sel = selectPlannedTargets(inputs, mode, jstDate, now, { limit: lim, stopAtLast: env.stopAtLast });
      stateBreakdown = Object.fromEntries(Object.entries(sel.byState).map(([k, v]) => [STATE_JA[k as AutoSearchState], v]));
      const nameOf = (id: string) => rows.find((r) => String(r.id) === id)?.customer_name ?? null;
      notThisRun = sel.notThisRun.map((x) => ({ id: x.id, name: nameOf(x.id), state: STATE_JA[x.state], why: x.why }));
      overLimit = sel.overLimit.map((x) => ({ id: x.id, name: nameOf(x.id), state: STATE_JA[x.state] }));
      for (const t of sel.targets) { planById.set(t.id, t.plan); stateById.set(t.id, { state: t.state, reason: t.stateReason, runReason: t.runReason }); }
      // reason は今までの2つの値の型に合わせる（新規と言い直しは new_customer・その他は recent_sent）。状態は plan_by_customer に
      targets = sel.targets.map((t) => ({ id: t.id, reason: t.state === "new" || t.state === "cond_changed" ? "new_customer" : "recent_sent", rpUpdateDays: t.plan.days }));
    } catch (e) {
      planMode = "legacy";
      planNoteAll = `状態の材料を読めない（今までの選び方）: ${e instanceof Error ? e.message : String(e)}`;
      console.warn("[auto-property-search]", planNoteAll);
    }
  }
  if (planMode === "legacy") targets = selectAutoSearchTargets(withCondition, { nowMs: now, limit: lim });

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

  const queued: Array<{ id: string; name: string | null; reason: string; rp_update_days: number | null; not_before?: string; update_days?: string; state?: AutoSearchState; sort?: "ad" | "updated"; stop_at_last?: boolean; max_pages?: number; run_reason?: string }> = [];
  // v2.5.44 dry_run・報告の明細（並び・止める線・ページ・この便に入れた理由）
  const stateOf = (id: string) => stateById.get(id)?.state;
  const planCols = (id: string) => ({ state: stateOf(id), sort: planById.get(id)?.sort, stop_at_last: planById.get(id)?.stop_at_last, max_pages: planById.get(id)?.max_pages, run_reason: stateById.get(id)?.runReason });
  const skipped: Array<{ id: string; name: string | null; why: string }> = [];
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  // 積む相手（既に積んである人・実行中の人を除く）
  const toQueue = targets.filter((t) => {
    const c = byId.get(t.id);
    if (alreadyQueued.has(t.id)) { skipped.push({ id: t.id, name: c?.customer_name ?? null, why: "今日この便で積み済み" }); return false; }
    if (openIds.has(t.id)) { skipped.push({ id: t.id, name: c?.customer_name ?? null, why: "未実行・実行中のコマンドあり" }); return false; }
    return true;
  });

  // 2026-09-29 v2.5.41 竹内「更新日を生かすことによって最新の物件の検索や新規物件のもれがないように」:
  //   今までの決まり（午後＝1・午前＝手で決めた値→前回物件を出した日から）を、前回の検索（そのお客様×サイトの最後に終わった回）から
  //   空いた時間を覆う所まで広げる（狭めない・14 でも足りなければ指定なし）。拡張は payload.update_days_plan.by_customer[id].days を使う
  const plans = new Map<string, UpdateDaysPlan>();
  try {
    const entries = toQueue.map((t) => {
      // v2.5.44: 計画のある人は計画の元の値（新規・言い直し 14／前回以降は 1＝前回の検索からの空きで広げる／前回の検索が無ければ最後に届けた日から）
      const p = planById.get(t.id);
      if (p) return { id: t.id, baseDays: p.days };
      const manual = byId.get(t.id)?.rp_update_days;
      const base = mode === "pm" ? buildAutoSearchPayload(mode, null, now).rp_update_days : (typeof manual === "number" && manual > 0 ? manual : t.rpUpdateDays);
      return { id: t.id, baseDays: base };
    });
    for (const e of await planUpdateDaysFor(supabase, entries, AUTO_SEARCH_SITES, now)) plans.set(e.id, e.plan);
  } catch (e) { console.warn("[auto-property-search] 更新日の計画を作れない（今までの決まり）:", e instanceof Error ? e.message : String(e)); }
  const planNote = (id: string) => plans.get(id)?.reason;
  // お客様ごとの計画（拡張が読む形）。days は更新日の計画で広げた後の値（計画が作れなければ元の値）
  const planByCustomer = (ts: ReadonlyArray<AutoSearchTarget>) =>
    planByCustomerPayload(ts.filter((t) => planById.has(t.id)).map((t) => ({ id: t.id, plan: planById.get(t.id)!, days: plans.has(t.id) ? plans.get(t.id)!.days : planById.get(t.id)!.days })));
  const legacyAm = planMode === "legacy" && mode === "am";

  // 2026-09-30 午後の便も計画の時は1人1命令（午前と同じ形・not_before を1人ずつずらす）。
  //   理由: 1命令に何十人も入れると1命令が数時間になり、/api/automation/pending の「running のまま30分で pending に戻す」見張りに掛かる
  //   （picked_up_at は拾った時刻のまま＝別の AIX の PC が同じ命令を拾い直して二重に検索し得る）。1人1命令なら1命令は1人分（中央値 約5〜7分）で、
  //   途中で止まっても残りの人は別の PC が続けられる。AUTO_SEARCH_PLAN=legacy の時だけ今まで通り1命令で一括
  if (isBatchedRun(mode) && planMode === "legacy") {
    // 17時（pm）: 全員が同じ条件なので**1コマンドにまとめて**拡張の一括検索で回す
    //   （竹内 2026-09-19「17:00の検索はピンポイント検索で一括で行うようにする」）
    //   更新日だけはお客様ごとの計画（update_days_plan）で広げる（前回の検索から2日以上空いた人を 1日以内で探さない）
    //   v2.5.44: 並び（新規・言い直しは AD 順）・止める線はお客様ごとに plan_by_customer（上の sort=updated は古い拡張の既定）
    const pbc = planByCustomer(toQueue);
    const payload = { ...buildAutoSearchPayload(mode, null, now), not_before: new Date(autoStartAtMs(mode, jstDate)).toISOString(),
      ...(plans.size ? { update_days_plan: planPayload(toQueue.filter((t) => plans.has(t.id)).map((t) => ({ id: t.id, plan: plans.get(t.id)! }))) } : {}),
      ...(Object.keys(pbc).length ? { plan_by_customer: pbc } : {}) };
    if (toQueue.length > 0 && !dryRun) {
      const { error: insErr } = await supabase.from("automation_commands").insert({
        command_type: "batch_property_search",
        customer_ids: toQueue.map((t) => t.id),
        sites: [...AUTO_SEARCH_SITES],
        payload,
        status: "pending",
      });
      if (insErr) {
        for (const t of toQueue) skipped.push({ id: t.id, name: byId.get(t.id)?.customer_name ?? null, why: `積めなかった: ${insErr.message}` });
      } else {
        for (const t of toQueue) queued.push({ id: t.id, name: byId.get(t.id)?.customer_name ?? null, reason: t.reason, rp_update_days: plans.get(t.id)?.days ?? payload.rp_update_days, not_before: payload.not_before, update_days: planNote(t.id), ...planCols(t.id) });
      }
    } else {
      for (const t of toQueue) queued.push({ id: t.id, name: byId.get(t.id)?.customer_name ?? null, reason: t.reason, rp_update_days: plans.get(t.id)?.days ?? payload.rp_update_days, not_before: payload.not_before, update_days: planNote(t.id), ...planCols(t.id) });
    }
  } else {
    // 11時（am）・計画の時の午後: 更新日が人ごとに違うので1人1コマンド。開始は1人ずつ不規則な間でずらす（notBeforeSchedule）。
    //   後ろの人は前の人が終わってから拾われる（pending は古い順に1件ずつ・拡張は1人を終えて人の間を置いてから次を拾う）。
    //   not_before は「これより前は拾わない」だけ。拾い手が動いている間は3時間の期限を延ばす（automation-sources.isPickerWaitExpired）
    const nbById = new Map(notBeforeSchedule(mode, jstDate, toQueue.map((t) => t.id)).map((x) => [x.id, x.notBeforeMs]));
    for (const t of toQueue) {
      const c = byId.get(t.id);
      const plan = plans.get(t.id);
      const cp = planById.get(t.id);
      const pbc = planByCustomer([t]);
      const payload = { ...buildAutoSearchPayload(mode, t, now), not_before: new Date(nbById.get(t.id) ?? autoStartAtMs(mode, jstDate)).toISOString(),
        ...(plan ? { rp_update_days: plan.days, update_days_plan: planPayload([{ id: t.id, plan }]) } : {}),
        // v2.5.44: 1人1命令なので上の並びもその人の計画に（古い拡張も並びは合う）。legacy は今までの「午前は広げて」
        ...(cp ? { sort: cp.sort, is_wide: false, max_pages: cp.max_pages, plan_by_customer: pbc } : {}),
        ...(legacyAm ? { is_wide: LEGACY_AM_IS_WIDE } : {}) };
      if (dryRun) { queued.push({ id: t.id, name: c?.customer_name ?? null, reason: t.reason, rp_update_days: plans.get(t.id)?.days ?? payload.rp_update_days, not_before: payload.not_before, update_days: planNote(t.id), ...planCols(t.id) }); continue; }
      const { error: insErr } = await supabase.from("automation_commands").insert({
        command_type: "batch_property_search",
        customer_ids: [t.id],
        sites: [...AUTO_SEARCH_SITES],
        payload,
        status: "pending",
      });
      if (insErr) { skipped.push({ id: t.id, name: c?.customer_name ?? null, why: `積めなかった: ${insErr.message}` }); continue; }
      queued.push({ id: t.id, name: c?.customer_name ?? null, reason: t.reason, rp_update_days: plans.get(t.id)?.days ?? payload.rp_update_days, not_before: payload.not_before, update_days: planNote(t.id), ...planCols(t.id) });
    }
  }

  const summary = {
    ok: true,
    mode,
    jst_date: jstDate,
    dry_run: dryRun,
    plan_mode: planMode,
    ...(planNoteAll ? { plan_note: planNoteAll } : {}),
    rule: planMode === "plan"
      ? (mode === "pm"
        ? `午後: 今日の検索で通す候補が0件の人だけ（午前に回らなかった・失敗・時間切れの人も）・全員 更新順・更新日1日（前回の検索が無い人は空きで広げる）・午前以降だけ${env.stopAtLast ? "（止める線あり）" : "（止める線は切ってある）"}・2ページ・広げてなし・上限${lim}人・1人1コマンド（午前の命令が残っている人は午前の続きを待つ）`
        : `お客様の状態で選ぶ（実際の送付・発言・条件の変更）: ③言い直し・①新規＝AD 順・更新日14日・止める線なし／②送った後・要対応＝更新順・前回の検索以降だけ${env.stopAtLast ? "（止める線あり）" : "（止める線は切ってある）"}／④止まっている＝週2回・更新順。全員ピンポイント・5ページ・上限${lim}人（③→①→要対応→②→④）・1人1コマンド`)
      : mode === "pm"
      ? "本日の更新日付（更新日1日以内）・更新順・5ページまで・ピンポイント検索・1コマンドで一括（1人ずつリアプロ→ITANDI）"
      : `直近${RECENT_SENT_DAYS}日に物件出しした人（送信 or 確認）＋登録${NEW_CUSTOMER_DAYS}日以内でまだ出していない人・更新日は前回出した日から・AD高い順・広げて検索・1人1コマンド`,
    ...(stateBreakdown ? { states: stateBreakdown } : {}),
    ...(planMode === "plan" ? {
      queued_by_state: queued.reduce<Record<string, number>>((m, q) => { const k = q.state ? STATE_JA[q.state] : "?"; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
      not_this_run: notThisRun.length, over_limit: overLimit.length,
      ...(dryRun ? { not_this_run_detail: notThisRun, over_limit_detail: overLimit } : {}),
    } : {}),
    batched: isBatchedRun(mode) && planMode === "legacy",
    sites: [...AUTO_SEARCH_SITES],
    // 今日のこの便の開始（JST の窓の中・日ごとに変わる）
    start_at_jst: new Date(autoStartAtMs(mode, jstDate) + 9 * 3600 * 1000).toISOString().slice(11, 19),
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
