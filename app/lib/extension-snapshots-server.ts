// app/lib/extension-snapshots-server.ts
// 拡張の「今の画面」と心拍の読み書き（DB と Blob）。決まりは extension-snapshots.ts（純関数）。
//
// 2026-09-29 竹内「なぜ固まっているのか」「画面開いているのも目で見ることができるのが理想」
// ・表は RLS 有効・ポリシーなし＝サービスロールだけ（写真・帯にお客様の名前が入るため公開キーでは読めなくする）。
//   サービスロールの鍵が無い時は anon に逃げずに止める（静かに壊れない: 返り値の error で分かる）
// ・DB の error は全部見て返す（data ?? [] で握り潰さない）
// ⚠ ここで扱う写真・ページの文字・帯の文は DeepSeek（検索の点検の見立て runDiagnosis）に渡さない
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  sanitizeHeartbeat, pendingRequestsFor, blobPathFor, blobPutOptions, planSnapshotPurge, deviceView, validInstallId,
  REQUEST_TTL_MS, RETENTION_DAYS, type DeviceRow, type DeviceView, type SnapResultInput,
} from "@/app/lib/extension-snapshots";

let _admin: SupabaseClient | null = null;
function admin(): { sb: SupabaseClient | null; error: string | null } {
  if (_admin) return { sb: _admin, error: null };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { sb: null, error: "SUPABASE_SERVICE_ROLE_KEY が無い（拡張の画面の表はサービスロールだけ）" };
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return { sb: _admin, error: null };
}

/** 心拍を上書きし、この PC がまだ答えていない頼まれの id を返す */
export async function heartbeatAndPoll(installId: string, state: Record<string, unknown>, nowMs = Date.now()): Promise<{ ok: boolean; requests: number[]; error?: string }> {
  const { sb, error } = admin();
  if (!sb) return { ok: false, requests: [], error: error ?? "no client" };
  const row = sanitizeHeartbeat(installId, state, nowMs);
  if (!row) return { ok: false, requests: [], error: "install_id が違います" };
  const { error: upErr } = await sb.from("extension_devices").upsert(row, { onConflict: "install_id" });
  if (upErr) return { ok: false, requests: [], error: `心拍: ${upErr.message}` };
  const since = new Date(nowMs - REQUEST_TTL_MS).toISOString();
  const { data: reqs, error: rErr } = await sb.from("extension_snapshots")
    .select("id, created_at, install_id").eq("kind", "request").gte("created_at", since).order("created_at", { ascending: true }).limit(20);
  if (rErr) return { ok: false, requests: [], error: `頼まれ: ${rErr.message}` };
  if (!reqs || reqs.length === 0) return { ok: true, requests: [] };
  const { data: ans, error: aErr } = await sb.from("extension_snapshots")
    .select("request_id, install_id").eq("kind", "result").eq("install_id", installId).in("request_id", reqs.map((r) => r.id)).limit(50);
  if (aErr) return { ok: false, requests: [], error: `答え: ${aErr.message}` };
  return { ok: true, requests: pendingRequestsFor(reqs as never, (ans ?? []) as never, installId, nowMs) };
}

/** 撮った物を置く: 写真を Blob（推測できない名前）→ 行を入れる → 頼まれの行を done に */
export async function saveResult(v: SnapResultInput, nowMs = Date.now()): Promise<{ ok: boolean; id?: number; images?: number; error?: string }> {
  const { sb, error } = admin();
  if (!sb) return { ok: false, error: error ?? "no client" };
  // image_url はサーバーが Blob に置いた時だけ付ける（送られてきた image_url は捨てる。
  //   残すと画面のリンク・14日の消し込み（purgeOldSnapshots の del）が送り手の決めた URL に向く）
  const tabs = v.tabs.map((t) => { const rest: Record<string, unknown> = { ...t }; delete rest.image_url; return rest; });
  const imageErrors: string[] = [];
  if (v.images.length > 0) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      imageErrors.push("BLOB_READ_WRITE_TOKEN が無いので写真を置いていない");
    } else {
      const { put } = await import("@vercel/blob");
      for (let i = 0; i < v.images.length; i++) {
        const im = v.images[i];
        try {
          const blob = await put(blobPathFor(v.install_id, im.site, im.contentType, nowMs), im.bytes, blobPutOptions(im.contentType));
          const tab = tabs.find((t) => t.image_index === i);
          if (tab) tab.image_url = blob.url;
          else tabs.push({ site: im.site, image_index: i, image_url: blob.url });
        } catch (e) {
          imageErrors.push(`写真${i + 1}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
        }
      }
    }
  }
  const row = {
    kind: "result",
    status: "done",
    trigger: v.trigger,
    request_id: v.request_id,
    install_id: v.install_id,
    device_label: v.device_label,
    ext_version: v.ext_version,
    mode: v.mode,
    batch_command_id: v.batch_command_id,
    audit_run_id: v.audit_run_id,
    property_customer_id: v.property_customer_id,
    band_text: v.band_text,
    can_capture: v.can_capture,
    tabs,
    stall: v.stall,
    log_tail: v.log_tail,
    error: imageErrors.length ? imageErrors.join(" / ").slice(0, 1000) : null,
  };
  const { data, error: insErr } = await sb.from("extension_snapshots").insert(row).select("id").single();
  if (insErr) return { ok: false, error: `保存: ${insErr.message}` };
  if (v.request_id != null) {
    const { error: uErr } = await sb.from("extension_snapshots").update({ status: "done" }).eq("id", v.request_id).eq("kind", "request");
    if (uErr) console.warn("[extension-snapshots] 頼まれの行を done にできない:", uErr.message);
  }
  return { ok: true, id: (data as { id: number }).id, images: v.images.length - imageErrors.length };
}

/** 画面から「今の画面を撮る」を頼む（installId なし＝動いている全部の PC が答える） */
export async function createRequest(requestedBy: string | null, installId: string | null): Promise<{ ok: boolean; id?: number; error?: string }> {
  const { sb, error } = admin();
  if (!sb) return { ok: false, error: error ?? "no client" };
  const { data, error: insErr } = await sb.from("extension_snapshots").insert({
    kind: "request", status: "requested", trigger: "request",
    requested_by: requestedBy ? requestedBy.slice(0, 60) : null,
    install_id: installId && validInstallId(installId) ? installId : null,
  }).select("id").single();
  if (insErr) return { ok: false, error: insErr.message };
  return { ok: true, id: (data as { id: number }).id };
}

export type SnapshotRow = {
  id: number; created_at: string; kind: string; status: string | null; trigger: string | null; request_id: number | null;
  install_id: string | null; device_label: string | null; ext_version: string | null; mode: string | null;
  batch_command_id: string | null; audit_run_id: string | null; property_customer_id: string | null; band_text: string | null;
  can_capture: boolean | null; tabs: Array<Record<string, unknown>> | null; stall: Record<string, unknown> | null;
  log_tail: Array<Record<string, unknown>> | null; error: string | null; requested_by: string | null;
};

/** PC ごとの心拍と、最新の撮った物（requestId を渡すとその頼まれへの答えだけ） */
export async function latestView(opts: { limit: number; installId?: string | null; requestId?: number | null; latestVersion: string | null }, nowMs = Date.now()): Promise<{ devices: DeviceView[]; snapshots: SnapshotRow[]; latest_ext_version: string | null; error?: string }> {
  const { sb, error } = admin();
  if (!sb) return { devices: [], snapshots: [], latest_ext_version: opts.latestVersion, error: error ?? "no client" };
  const { data: devs, error: dErr } = await sb.from("extension_devices").select("*").order("last_seen_at", { ascending: false }).limit(20);
  if (dErr) return { devices: [], snapshots: [], latest_ext_version: opts.latestVersion, error: `心拍: ${dErr.message}` };
  let q = sb.from("extension_snapshots").select("*").eq("kind", "result").order("created_at", { ascending: false }).limit(Math.min(Math.max(opts.limit, 1), 20));
  if (opts.installId && validInstallId(opts.installId)) q = q.eq("install_id", opts.installId);
  if (opts.requestId != null) q = q.eq("request_id", opts.requestId);
  const { data: snaps, error: sErr } = await q;
  if (sErr) return { devices: [], snapshots: [], latest_ext_version: opts.latestVersion, error: `撮った物: ${sErr.message}` };
  return {
    devices: ((devs ?? []) as DeviceRow[]).map((d) => deviceView(d, opts.latestVersion, nowMs)),
    snapshots: (snaps ?? []) as SnapshotRow[],
    latest_ext_version: opts.latestVersion,
  };
}

/** 14日を過ぎた撮った物・頼まれを消す（写真の Blob も）。検索の点検の見回り（/api/cron/search-audit-sweep）から呼ぶ */
export async function purgeOldSnapshots(nowMs = Date.now()): Promise<{ ok: boolean; rows: number; blobs: number; error?: string }> {
  const { sb, error } = admin();
  if (!sb) return { ok: false, rows: 0, blobs: 0, error: error ?? "no client" };
  const cutoff = new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error: selErr } = await sb.from("extension_snapshots").select("id, created_at, tabs").lt("created_at", cutoff).limit(500);
  if (selErr) return { ok: false, rows: 0, blobs: 0, error: selErr.message };
  const plan = planSnapshotPurge((data ?? []) as never, nowMs);
  if (plan.ids.length === 0) return { ok: true, rows: 0, blobs: 0 };
  let blobs = 0;
  if (plan.urls.length > 0) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return { ok: false, rows: 0, blobs: 0, error: "BLOB_READ_WRITE_TOKEN が無いので消していない" };
    const { del } = await import("@vercel/blob");
    try { await del(plan.urls); blobs = plan.urls.length; } // 既に無い物を消しても失敗しない
    catch (e) { return { ok: false, rows: 0, blobs: 0, error: `写真を消せない: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const { error: dErr } = await sb.from("extension_snapshots").delete().in("id", plan.ids);
  if (dErr) return { ok: false, rows: 0, blobs, error: dErr.message };
  return { ok: true, rows: plan.ids.length, blobs };
}
