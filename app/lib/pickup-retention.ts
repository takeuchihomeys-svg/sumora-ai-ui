// app/lib/pickup-retention.ts（純関数・依存なし・画面とサーバーで共用）
// 売上サポ（property_pickups）の画像・資料の保存期間。
//
// 2026-09-25 竹内「画像それぞれのお客さん何件まで保存しているのか？ 3日前の画像は消されるようになっているか？
//   保存期間が終了しましたと出る感じで（実際の LINE のように）。そうすれば重くなり続ける心配がない。
//   物件は検索で出してから基本的に1日以内にはお客さんに送るから」
//   → 届いてから 72時間で、行の画像・資料（Vercel Blob の pickups/ …pdf・_p1.png・_p2.png・trim/…jpg）を消す。
//     行そのもの（説明文・判定・札・分析結果の文字・PDF の文字層）は残す（軽い・履歴と学習に使う）。
//   ⚠ 消すのは「Vercel Blob の pickups/ 配下」だけ。お客様に送った画像は AIX が別の置き場（Supabase property-images）へ
//     写してから LINE に送っている（AixModal の uploadImage）ので、LINE の会話に出ている画像は消えない（あちらは 90日・cleanup-images）。
//     それでも同じ URL を messages / sent_properties / sent_image_properties が指していれば消さない（旧い直接送信の名残・テスト行）。
//   ⚠ 資料から読んだ事実（property_sheet_facts）・画像の読み取り（image_details の文字）は消さない（使い回しの効果・引用返信）。

export const PICKUP_RETENTION_HOURS = 72;
/** 残りがこの時間を切ったら「あと◯時間で保存期間が終了します」を出す */
export const PICKUP_EXPIRY_WARN_HOURS = 12;
export const PICKUP_URL_COLUMNS = ["pdf_blob_url", "page_image_url", "agent_image_url", "trim_image_url"] as const;
export type PickupUrlColumn = typeof PICKUP_URL_COLUMNS[number];

export const PICKUP_EXPIRED_LABEL = "保存期間が終了しました";
export const PICKUP_EXPIRED_ACTION_NOTE = "届いてから3日で画像・資料の保存期間が終了したため、画像保存・画像で分析・AIXで送るは使えません（説明文と判定は残っています）";

const HOUR = 3600_000;

export type RetentionRow = { created_at: string; expired_at?: string | null };
export type RetentionState = {
  /** 期限が切れた（消した印がある、または届いてから 72時間を過ぎた） */
  expired: boolean;
  /** 期限の時刻（ISO）。created_at が読めなければ null（切れていない扱い＝誤って隠さない） */
  expires_at: string | null;
  /** 残り時間（切り上げ・時間）。切れていれば 0 */
  hours_left: number | null;
  /** 残りが PICKUP_EXPIRY_WARN_HOURS 以下（切れる前だけ） */
  warn: boolean;
};

export function pickupRetention(row: RetentionRow, nowMs: number): RetentionState {
  const created = Date.parse(row.created_at);
  if (!Number.isFinite(created)) return { expired: !!row.expired_at, expires_at: null, hours_left: row.expired_at ? 0 : null, warn: false };
  const exp = created + PICKUP_RETENTION_HOURS * HOUR;
  const expired = !!row.expired_at || nowMs >= exp;
  const hoursLeft = expired ? 0 : Math.ceil((exp - nowMs) / HOUR);
  return { expired, expires_at: new Date(exp).toISOString(), hours_left: hoursLeft, warn: !expired && hoursLeft <= PICKUP_EXPIRY_WARN_HOURS };
}

/**
 * 画面に返す行: 期限が切れた行は画像・資料の URL を空にし、expired を付ける。
 *   消す処理（cron・1日1回）が走る前の数時間も、画面は 72時間ちょうどで「保存期間が終了しました」にそろえる（LINE と同じ見え方）。
 */
export function withPickupRetention<T extends RetentionRow & Partial<Record<PickupUrlColumn, string | null>>>(row: T, nowMs: number): T & { expired: boolean; expires_at: string | null; expiry_hours_left: number | null; expiry_warn: boolean } {
  const s = pickupRetention(row, nowMs);
  const out = { ...row, expired: s.expired, expires_at: s.expires_at, expiry_hours_left: s.hours_left, expiry_warn: s.warn };
  if (s.expired) for (const c of PICKUP_URL_COLUMNS) if (c in out) (out as Record<string, unknown>)[c] = null;
  return out;
}

/** 消してよい置き場か: Vercel Blob の pickups/ 配下だけ（Supabase の property-images・結合 PDF（直下）・他の Blob は触らない） */
export function isPickupBlobUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".public.blob.vercel-storage.com") && u.pathname.startsWith("/pickups/");
  } catch {
    return false;
  }
}

export type PurgeRow = { id: number; created_at: string; expired_at?: string | null; status?: string | null } & Partial<Record<PickupUrlColumn, string | null>>;
export type KeptReason = "used_elsewhere" | "not_pickup_blob";
export type PurgePlan = {
  /** 期限切れの印を付ける行（URL の列は空にする）と、その行で消す Blob */
  rows: Array<{ id: number; status: string | null; deleteUrls: string[]; keptUrls: Array<{ col: PickupUrlColumn; reason: KeptReason }> }>;
  /** 消す Blob（重複なし） */
  deleteUrls: string[];
  keptCount: Record<KeptReason, number>;
};

/**
 * 消す対象を選ぶ。
 *   対象の行: 印がまだ無く、届いてから 72時間を過ぎた行（created_at が読めない行は選ばない）
 *   消す物  : その行の URL のうち Vercel Blob の pickups/ 配下で、protectedUrls（お客様に送った画像・まだ期限内の行の画像）に無い物
 *   残す物  : protectedUrls にある物（used_elsewhere）・pickups/ 以外（not_pickup_blob）。行の列は空にするが、ファイルは消さない
 */
export function planPickupPurge(input: { rows: PurgeRow[]; protectedUrls: Set<string>; nowMs: number }): PurgePlan {
  const cutoff = input.nowMs - PICKUP_RETENTION_HOURS * HOUR;
  const out: PurgePlan = { rows: [], deleteUrls: [], keptCount: { used_elsewhere: 0, not_pickup_blob: 0 } };
  const seen = new Set<string>();
  for (const r of input.rows) {
    if (r.expired_at) continue;
    const created = Date.parse(r.created_at);
    if (!Number.isFinite(created) || created > cutoff) continue;
    const plan = { id: r.id, status: r.status ?? null, deleteUrls: [] as string[], keptUrls: [] as Array<{ col: PickupUrlColumn; reason: KeptReason }> };
    for (const col of PICKUP_URL_COLUMNS) {
      const u = r[col];
      if (!u) continue;
      if (input.protectedUrls.has(u)) { plan.keptUrls.push({ col, reason: "used_elsewhere" }); out.keptCount.used_elsewhere++; continue; }
      if (!isPickupBlobUrl(u)) { plan.keptUrls.push({ col, reason: "not_pickup_blob" }); out.keptCount.not_pickup_blob++; continue; }
      plan.deleteUrls.push(u);
      if (!seen.has(u)) { seen.add(u); out.deleteUrls.push(u); }
    }
    out.rows.push(plan);
  }
  return out;
}

/** 消した Blob（成功した物）から、印を付けてよい行（その行の消す物が全部消えた行）を選ぶ。失敗が混ざった行は次の回にやり直す */
export function rowsToMarkExpired(plan: PurgePlan, deleted: Set<string>): number[] {
  return plan.rows.filter((r) => r.deleteUrls.every((u) => deleted.has(u))).map((r) => r.id);
}
