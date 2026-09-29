// app/lib/extension-snapshots.ts
// 拡張の「今の画面」と心拍の決まり（純関数・DB も Blob も触らない）。読み書きは extension-snapshots-server.ts。
//
// 2026-09-29 竹内「ブレインのAIX検索モードが隼斗さんで止まってしまっている。なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   調べると検索は 10:57 に正常に終わっていて帯が残っていただけ・16:32 の午後の便の見送りは古い版（再読み込みしていない PC）。
//   「その PC が今どの版で何をしているか」（心拍）と、止まった時／頼まれた時の画面（写真＋ページの文字＋拡張のログ）を残す。
//
// 表（migrate-schema に同時に追加・RLS 有効・ポリシーなし＝サービスロールだけ）:
//   extension_devices   … PC ごと1行（install_id）を心拍のたびに上書き
//   extension_snapshots … kind=request（画面から頼んだ）／result（拡張が撮った）。写真は Blob（推測できない名前・14日で消す）
// ⚠ 写真・ページの文字・帯の文は DeepSeek（検索の点検の見立て runDiagnosis）に渡さない（お客様の名前が帯に入るため）

export const SNAPSHOT_MAX_IMAGES = 3;
export const IMAGE_MAX_BYTES = 1200 * 1024;          // 拡張の snapshot-core IMAGE_MAX_BYTES と同じ
export const TOTAL_IMAGE_MAX_BYTES = 3_000_000;      // Vercel の本文の上限 4.5MB に収める（base64 で 4/3 倍＝4.0MB・拡張の snapshot-core TOTAL_IMAGE_MAX_BYTES と同じ）
export const BODY_MAX_CHARS = 4_400_000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;        // 頼まれの行に答える期限
export const RETENTION_DAYS = 14;
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;     // 心拍がこれより古い PC は「応答なし」（拡張は1分ごと）
export const TRIGGERS = ["stall", "pass_deadline", "waiter_timeout", "fill_timeout", "request", "run_end"] as const;
export type SnapshotTrigger = (typeof TRIGGERS)[number];
const SITES = new Set(["realpro", "itandi", "reins"]);
const MODES = new Set(["normal", "staff", "aix", "brain_normal", "brain_staff", "brain_aix"]);

const str = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
const isoOrNull = (v: unknown): string | null => {
  const n = num(v);
  if (n == null || n < 1_600_000_000_000 || n > 4_000_000_000_000) return null;
  return new Date(n).toISOString();
};

export function validInstallId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
}

export function validVersion(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(v);
}

/** /api/automation/pending の x-ext-version（拾った拡張の版）。形が違えば null（claim は版なしで続ける） */
export function claimExtVersion(h: string | null): string | null {
  const v = (h ?? "").trim();
  return validVersion(v) ? v : null;
}

/** /api/automation/pending の x-ext-install（拾った PC）。形が違えば null */
export function claimInstallId(h: string | null): string | null {
  const v = (h ?? "").trim();
  return validInstallId(v) ? v : null;
}

/** 列がまだ無い（migrate-schema を流す前）の error か（PostgreSQL 42703・PostgREST PGRST204） */
export function isMissingColumnError(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  return /column .* does not exist|Could not find the .* column/i.test(e.message ?? "");
}

/** a が b 以上か（2.5.40 ≥ 2.5.38）。読めない時は false */
export function versionAtLeast(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!validVersion(a) || !validVersion(b)) return false;
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let k = 0; k < 3; k++) if (pa[k] !== pb[k]) return pa[k] > pb[k];
  return true;
}

export type DeviceRow = {
  install_id: string;
  device_label: string | null;
  ext_version: string | null;
  mode: string | null;
  batch_running: boolean;
  batch_command_id: string | null;
  batch_started_at: string | null;
  last_progress_at: string | null;
  current_customer_id: string | null;
  current_site: string | null;
  waiting_for: string | null;
  can_capture: boolean;
  staff_mode: boolean;
  last_seen_at: string;
};

/** 拡張の心拍（x-snap-state の JSON・snapshot-core heartbeatState と同じ名前）→ extension_devices の1行。読めなければ null */
export function sanitizeHeartbeat(installId: unknown, raw: unknown, nowMs: number): DeviceRow | null {
  if (!validInstallId(installId)) return null;
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = str(s.mode, 20);
  return {
    install_id: installId,
    device_label: str(s.device_label, 60),
    ext_version: validVersion(s.ext_version) ? s.ext_version : null,
    mode: mode && MODES.has(mode) ? mode : null,
    batch_running: bool(s.batch_running),
    batch_command_id: str(s.batch_command_id, 64),
    batch_started_at: isoOrNull(s.batch_started_at),
    last_progress_at: isoOrNull(s.last_progress_at),
    current_customer_id: str(s.current_customer_id, 64),
    current_site: str(s.current_site, 20),
    waiting_for: str(s.waiting_for, 120),
    can_capture: bool(s.can_capture),
    staff_mode: bool(s.staff_mode),
    last_seen_at: new Date(nowMs).toISOString(),
  };
}

/** x-snap-state ヘッダー（encodeURIComponent された JSON）を読む。読めなければ {} */
export function parseStateHeader(h: string | null): Record<string, unknown> {
  if (!h || h.length > 4000) return {};
  try {
    const v = JSON.parse(decodeURIComponent(h));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type SnapImage = { site: string; contentType: "image/jpeg" | "image/png"; bytes: Buffer };
export type SnapResultInput = {
  install_id: string;
  device_label: string | null;
  ext_version: string | null;
  mode: string | null;
  trigger: SnapshotTrigger;
  request_id: number | null;
  batch_command_id: string | null;
  audit_run_id: string | null;
  property_customer_id: string | null;
  band_text: string | null;
  can_capture: boolean;
  tabs: Array<Record<string, unknown>>;
  stall: Record<string, unknown> | null;
  log_tail: Array<{ t: number | null; l: string | null; m: string | null }>;
  images: SnapImage[];
};

function clampJson(v: unknown, maxChars: number): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  try {
    const s = JSON.stringify(v);
    if (s.length <= maxChars) return JSON.parse(s) as Record<string, unknown>;
    return { _truncated: true, head: s.slice(0, maxChars) };
  } catch {
    return null;
  }
}

function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** 拡張が送った「撮った物」の形を確かめる。写真は3枚・1枚1.2MB・合計3.5MB まで・JPEG/PNG だけ */
export function validateResultBody(body: unknown): { ok: true; value: SnapResultInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "本文がない" };
  const b = body as Record<string, unknown>;
  if (!validInstallId(b.install_id)) return { ok: false, error: "install_id が要ります" };
  const trigger = typeof b.trigger === "string" && (TRIGGERS as readonly string[]).includes(b.trigger) ? (b.trigger as SnapshotTrigger) : null;
  if (!trigger) return { ok: false, error: "trigger が違います" };
  const rawImages = Array.isArray(b.images) ? b.images : [];
  if (rawImages.length > SNAPSHOT_MAX_IMAGES) return { ok: false, error: `写真は${SNAPSHOT_MAX_IMAGES}枚まで` };
  const images: SnapImage[] = [];
  let total = 0;
  for (const im of rawImages) {
    const o = (im ?? {}) as Record<string, unknown>;
    const ct = o.content_type === "image/png" ? "image/png" : o.content_type === "image/jpeg" ? "image/jpeg" : null;
    if (!ct) return { ok: false, error: "写真は JPEG か PNG だけ" };
    if (typeof o.b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.b64)) return { ok: false, error: "写真の中身が読めない" };
    const size = base64Bytes(o.b64);
    if (size > IMAGE_MAX_BYTES) return { ok: false, error: `写真1枚が大きすぎる（${size}B）` };
    total += size;
    if (total > TOTAL_IMAGE_MAX_BYTES) return { ok: false, error: "写真の合計が大きすぎる" };
    const bytes = Buffer.from(o.b64, "base64");
    // 中身の先頭で種類を確かめる（JPEG: FF D8 FF／PNG: 89 50 4E 47）
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if ((ct === "image/jpeg" && !isJpeg) || (ct === "image/png" && !isPng)) return { ok: false, error: "写真の中身と種類が合わない" };
    const site = str(o.site, 20);
    images.push({ site: site && SITES.has(site) ? site : "other", contentType: ct, bytes });
  }
  const tabs = (Array.isArray(b.tabs) ? b.tabs : []).slice(0, 6).map((t) => clampJson(t, 6000)).filter((t): t is Record<string, unknown> => !!t);
  const logTail = (Array.isArray(b.log_tail) ? b.log_tail : []).slice(-80).map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    return { t: num(o.t), l: str(o.l, 8), m: str(o.m, 300) };
  });
  const mode = str(b.mode, 20);
  const reqId = num(b.request_id);
  return {
    ok: true,
    value: {
      install_id: b.install_id,
      device_label: str(b.device_label, 60),
      ext_version: validVersion(b.ext_version) ? b.ext_version : null,
      mode: mode && MODES.has(mode) ? mode : null,
      trigger,
      request_id: reqId != null && Number.isInteger(reqId) && reqId > 0 ? reqId : null,
      batch_command_id: str(b.batch_command_id, 64),
      audit_run_id: str(b.audit_run_id, 80),
      property_customer_id: str(b.property_customer_id, 64),
      band_text: str(b.band_text, 300),
      can_capture: bool(b.can_capture),
      tabs,
      stall: clampJson(b.stall, 8000),
      log_tail: logTail,
      images,
    },
  };
}

/** Blob の置き場所（addRandomSuffix: true と一緒に使う＝推測できない URL） */
export function blobPathFor(installId: string, site: string, contentType: string, nowMs: number): string {
  const d = new Date(nowMs + 9 * 60 * 60 * 1000).toISOString();
  const day = d.slice(0, 10).replace(/-/g, "");
  const hms = d.slice(11, 19).replace(/:/g, "");
  const ext = contentType === "image/png" ? "png" : "jpg";
  return `ext-snapshots/${day}/${hms}_${installId.slice(0, 8)}_${site}.${ext}`;
}

/** Blob の put の設定（テストで addRandomSuffix を固定する） */
export function blobPutOptions(contentType: string): { access: "public"; contentType: string; addRandomSuffix: true } {
  return { access: "public", contentType, addRandomSuffix: true };
}

type ReqRow = { id: number; created_at: string; install_id: string | null };
type ResRow = { request_id: number | null; install_id: string | null };

/** この PC がまだ答えていない、10分以内の頼まれ（宛先なし＝全部の PC／宛先がこの PC）。古い順に最大 max 件 */
export function pendingRequestsFor(requests: ReqRow[], answered: ResRow[], installId: string, nowMs: number, max = 1): number[] {
  const done = new Set(answered.filter((a) => a.install_id === installId && a.request_id != null).map((a) => a.request_id as number));
  return requests
    .filter((r) => (r.install_id == null || r.install_id === installId) && !done.has(r.id))
    .filter((r) => { const t = Date.parse(r.created_at); return Number.isFinite(t) && nowMs - t <= REQUEST_TTL_MS && nowMs - t >= -60_000; })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, max)
    .map((r) => r.id);
}

/** 14日を過ぎた行と、その行の写真の URL（消す物） */
export function planSnapshotPurge(rows: Array<{ id: number; created_at: string; tabs: unknown }>, nowMs: number, days = RETENTION_DAYS): { ids: number[]; urls: string[] } {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const ids: number[] = [];
  const urls: string[] = [];
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t >= cutoff) continue;
    ids.push(r.id);
    for (const tab of Array.isArray(r.tabs) ? r.tabs : []) {
      const u = (tab as Record<string, unknown> | null)?.image_url;
      if (typeof u === "string" && /^https:\/\//.test(u)) urls.push(u);
    }
  }
  return { ids, urls: [...new Set(urls)] };
}

export type DeviceView = DeviceRow & { stale: boolean; outdated: boolean; seen_ago_sec: number };

/** 画面に出す PC ごとの状態: 心拍が3分より古い＝応答なし／版が今の版より古い＝赤 */
export function deviceView(d: DeviceRow, latestVersion: string | null, nowMs: number): DeviceView {
  const seen = Date.parse(d.last_seen_at);
  const ago = Number.isFinite(seen) ? Math.max(0, Math.round((nowMs - seen) / 1000)) : 1e9;
  return {
    ...d,
    stale: ago * 1000 > HEARTBEAT_STALE_MS,
    outdated: !!latestVersion && !!d.ext_version && !versionAtLeast(d.ext_version, latestVersion),
    seen_ago_sec: ago,
  };
}
