// app/lib/extension-live-server.ts
// 2026-11-10 竹内「画面操作を別のPCで行う場合、その操作ちゃんと動いているかスマホで確認できるツールできるかな？」
//   別の PC（事務所の PC 等）で拡張が自動モードで動いている時、その場にいなくてもスマホで「今どうなっているか」を見るための読み取り専用の口。
//   新しい表・列は作らない（今ある extension_devices・automation_commands・search_audits・screen_watch_events を読むだけ）。
//     ・extension_devices … 拡張の1分ごとの心拍（版・モード・実行中の命令・お客様・サイト・待っている事・最後に進んだ時刻）
//     ・automation_commands … たまっている指示・拾った PC・失敗の理由
//     ・search_audits … 直近の検索の1回ごと（何を入れた・結果・操作ごとの時刻）
//   書き込みは一切しない（読み取り専用＝スマホから何かを動かせない。止めたい時は今まで通りサーバーの止めの印を使う）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 心拍がこれより古い PC は「止まっている（画面が閉じた・PC が落ちた）」と見なす */
const STALE_MS = 3 * 60 * 1000;

type DeviceRow = {
  install_id: string;
  device_label: string | null;
  ext_version: string | null;
  mode: string | null;
  batch_running: boolean | null;
  batch_command_id: string | null;
  batch_started_at: string | null;
  last_progress_at: string | null;
  current_customer_id: string | null;
  current_site: string | null;
  waiting_for: string | null;
  can_capture: boolean | null;
  staff_mode: boolean | null;
  last_seen_at: string | null;
};

type CommandRow = {
  id: string | number;
  created_at: string | null;
  status: string | null;
  sites: string[] | null;
  customer_ids: string[] | null;
  payload: Record<string, unknown> | null;
  picked_install_id: string | null;
  picked_ext_version: string | null;
  error_message: string | null;
  completed_at: string | null;
  picked_up_at?: string | null;
};

type AuditRow = {
  run_id: string;
  created_at: string | null;
  finished_at?: string | null;
  site: string | null;
  trigger: string | null;
  property_customer_id: string | null;
  status: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  error_kind: string | null;
  filled?: Record<string, unknown> | null;
  steps: Array<{ at?: number; k?: string; d?: string | null }> | null;
  ext_version: string | null;
};

const siteJa = (s: string | null): string | null => {
  const v = String(s || "").toLowerCase();
  if (v === "realpro" || v === "realnetpro") return "リアプロ";
  if (v === "itandi") return "ITANDI";
  if (v === "reins") return "レインズ";
  return s;
};

const modeJa = (m: string | null): string | null => {
  if (!m) return null;
  const x = String(m);
  if (x === "brain_aix") return "ブレイン×自動";
  if (x === "aix") return "自動";
  if (x === "brain_staff") return "ブレイン×スタッフ";
  if (x === "staff") return "スタッフ";
  if (x === "brain_normal") return "ブレイン×通常";
  if (x === "normal") return "通常";
  return x;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** 「あと何秒」の文（待っている事の補足） */
function sinceJa(fromIso: string | null, nowMs: number): string | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 90) return sec + "秒前";
  const min = Math.round(sec / 60);
  if (min < 90) return min + "分前";
  return Math.round(min / 60) + "時間前";
}

/**
 * スマホで見る「今どうなっているか」。読み取りだけ。
 *   ?install=… で1台に絞れる（省略時は動いている PC を全部）
 */
export async function liveDevices(opts: { install?: string | null } = {}): Promise<Record<string, unknown>> {
  const sb = admin();
  const now = Date.now();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い（この画面はサービスロールだけ）" };

  // ① PC（心拍）: 直近24時間に来た物を新しい順に
  const since24 = iso(now - 24 * 3600 * 1000);
  let devQuery = sb.from("extension_devices")
    .select("install_id, device_label, ext_version, mode, batch_running, batch_command_id, batch_started_at, last_progress_at, current_customer_id, current_site, waiting_for, can_capture, staff_mode, last_seen_at")
    .gte("last_seen_at", since24)
    .order("last_seen_at", { ascending: false })
    .limit(20);
  if (opts.install) devQuery = devQuery.eq("install_id", String(opts.install).slice(0, 64));
  const dev = await devQuery;
  const devices = (dev.data ?? []) as DeviceRow[];

  // ② たまっている・走っている指示（直近6時間・pending/running）
  const since6 = iso(now - 6 * 3600 * 1000);
  const cmdRes = await sb.from("automation_commands")
    .select("id, created_at, status, sites, customer_ids, payload, picked_install_id, picked_ext_version, error_message, completed_at, picked_up_at")
    .gte("created_at", since6)
    .in("status", ["pending", "running", "error"])
    .order("created_at", { ascending: false })
    .limit(40);
  const commands = (cmdRes.data ?? []) as CommandRow[];

  // ③ 直近の検索の1回（点検）: 15分ぶん
  const since15 = iso(now - 15 * 60 * 1000);
  const audRes = await sb.from("search_audits")
    .select("run_id, created_at, finished_at, site, trigger, property_customer_id, status, result, error, error_kind, steps, ext_version, filled")
    .gte("created_at", since15)
    .order("created_at", { ascending: false })
    .limit(30);
  const audits = (audRes.data ?? []) as AuditRow[];

  // ④ お客様の名前（ID だけでは分からないため）
  const ids = new Set<string>();
  devices.forEach((d) => { if (d.current_customer_id) ids.add(d.current_customer_id); });
  audits.forEach((a) => { if (a.property_customer_id) ids.add(a.property_customer_id); });
  const names: Record<string, string> = {};
  if (ids.size) {
    const idList = Array.from(ids).slice(0, 100);
    const c = await sb.from("property_customers").select("id, customer_name").in("id", idList);
    for (const r of (c.data ?? []) as Array<{ id: string; customer_name: string | null }>) names[r.id] = r.customer_name ?? "";
  }

  // ⑤ 見張り（異常の印）: 直近15分で normal 以外
  const wRes = await sb.from("screen_watch_events")
    .select("id, created_at, site, checkpoint, final_label, action, action_reason, property_customer_id, outcome")
    .gte("created_at", since15)
    .neq("final_label", "normal")
    .order("created_at", { ascending: false })
    .limit(20);
  const watchAlerts = (wRes.error ? [] : (wRes.data ?? [])) as Array<Record<string, unknown>>;

  const devicesOut = devices.map((d) => {
    const seenMs = d.last_seen_at ? Date.parse(d.last_seen_at) : 0;
    const stale = !seenMs || now - seenMs > STALE_MS;
    const progress = d.last_progress_at ? Date.parse(d.last_progress_at) : 0;
    // 動いているのに10分以上進んでいない＝止まっている疑い（拡張の見張りと同じ線）
    const stuck = !!(d.batch_running && progress && now - progress > 10 * 60 * 1000);
    return {
      install_id: d.install_id,
      label: d.device_label || String(d.install_id).slice(0, 8),
      version: d.ext_version,
      mode: modeJa(d.mode),
      running: !!d.batch_running,
      stale,
      stuck,
      since: sinceJa(d.last_seen_at, now),
      command_id: d.batch_command_id,
      batch_started: sinceJa(d.batch_started_at, now),
      last_progress: sinceJa(d.last_progress_at, now),
      customer_id: d.current_customer_id,
      customer_name: d.current_customer_id ? (names[d.current_customer_id] || null) : null,
      site: siteJa(d.current_site),
      waiting_for: d.waiting_for,
      can_capture: !!d.can_capture,
      staff_mode: !!d.staff_mode,
    };
  });

  const commandsOut = commands.map((c) => ({
    id: c.id,
    created_at: c.created_at,
    status: c.status,
    sites: (c.sites ?? []).map((s) => siteJa(s)),
    customers: (c.customer_ids ?? []).length,
    source: c.payload && typeof c.payload.source === "string" ? c.payload.source : null,
    aix_action: c.payload && typeof c.payload.aix_action === "string" ? c.payload.aix_action : null,
    is_wide: c.payload && c.payload.is_wide === true,
    picked_install_id: c.picked_install_id,
    picked_ext_version: c.picked_ext_version,
    error: c.error_message ? String(c.error_message).slice(0, 200) : null,
    completed_at: c.completed_at,
  }));

  const auditsOut = audits.map((a) => {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const last = steps.length ? steps[steps.length - 1] : null;
    const filled = (a as { filled?: Record<string, unknown> | null }).filled ?? null;
    const human = filled && typeof filled.human === "object" && filled.human ? filled.human as Record<string, unknown> : null;
    const humanN = human && typeof human.n === "number" ? human.n : null;
    // 案内モード（スタッフが押す）なのに人の操作が 0 ＝止まっている疑い。自動系（trigger が batch/aix/auto）なら人が居ないのが正常
    const guideish = a.trigger === "single" || a.trigger === "bulk_manual";
    return {
      run_id: a.run_id,
      at: a.created_at,
      since: sinceJa(a.created_at, now),
      site: siteJa(a.site),
      trigger: a.trigger,
      customer_id: a.property_customer_id,
      customer_name: a.property_customer_id ? (names[a.property_customer_id] || null) : null,
      status: a.status,
      done: !!a.finished_at,
      rows: a.result && typeof a.result.read_rows === "number" ? a.result.read_rows : null,
      sent: a.result && typeof a.result.sent_count === "number" ? a.result.sent_count : null,
      pages: a.result && typeof a.result.pages === "number" ? a.result.pages : null,
      error: a.error ? String(a.error).slice(0, 200) : null,
      error_kind: a.error_kind,
      last_step: last ? String(last.k || "") : null,
      steps: steps.slice(-8).map((s) => ({ at: s.at ?? null, k: String(s.k || ""), d: s.d == null ? null : String(s.d).slice(0, 80) })),
      version: a.ext_version,
      // 2026-11-10 人の操作（案内モードで人が押しているか）
      human_n: humanN,
      human_judge: humanN == null ? null : (humanN > 0 ? "人が操作している（" + humanN + "回）" : (guideish ? "人の操作が0回（案内なのに誰も触っていない＝止まっている疑い）" : "拡張だけで動いている（人0回）")),
      human_last: human && human.last_k ? String(human.last_k) : null,
      human_gap: human && typeof human.avg_gap_ms === "number" ? human.avg_gap_ms : null,
    };
  });

  const running = devicesOut.filter((d) => d.running && !d.stale);
  return {
    ok: true,
    now: iso(now),
    summary: {
      devices: devicesOut.length,
      running: running.length,
      stale: devicesOut.filter((d) => d.stale).length,
      stuck: devicesOut.filter((d) => d.stuck).length,
      pending_commands: commandsOut.filter((c) => c.status === "pending").length,
      running_commands: commandsOut.filter((c) => c.status === "running").length,
      error_commands: commandsOut.filter((c) => c.status === "error").length,
      recent_searches: auditsOut.length,
      watch_alerts: watchAlerts.length,
    },
    devices: devicesOut,
    commands: commandsOut,
    audits: auditsOut,
    // 2026-11-10 竹内「人間が動いているか確認もできるように」: 各回で人の操作が数えられていれば出す（案内モードなら人が動いている証拠）
    human: auditsOut.map((a) => ({
      run_id: a.run_id,
      at: a.at,
      site: a.site,
      customer_name: a.customer_name,
      n: (a as Record<string, unknown>).human_n ?? null,
      judge: (a as Record<string, unknown>).human_judge ?? null,
      last_k: (a as Record<string, unknown>).human_last ?? null,
      avg_gap_ms: (a as Record<string, unknown>).human_gap ?? null,
    })).filter((x) => x.n != null),
    watch_alerts: watchAlerts.map((w) => ({
      at: w.created_at, site: siteJa(String(w.site || "")), checkpoint: w.checkpoint, label: w.final_label,
      action: w.action, reason: w.action_reason, customer_name: w.property_customer_id ? (names[String(w.property_customer_id)] || null) : null,
    })),
    table_missing: {
      devices: !!(dev.error && /relation|does not exist/i.test(dev.error.message)),
      commands: !!(cmdRes.error && /relation|does not exist/i.test(cmdRes.error.message)),
      audits: !!(audRes.error && /relation|does not exist/i.test(audRes.error.message)),
      watch: !!(wRes.error && /relation|does not exist/i.test(wRes.error.message)),
    },
  };
}
