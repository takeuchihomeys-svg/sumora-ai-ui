// app/lib/pickup-retention-server.ts（サーバー専用・画面から import しない）
// 売上サポ（property_pickups）の画像・資料を、届いてから 72時間で消す（/api/cron/pickup-retention が毎日1回呼ぶ）。
// 選び方は純関数 app/lib/pickup-retention.ts（テストあり）。ここは DB を読む・Blob を消す・印を付けるだけ。
//
// 2026-09-25 竹内「3日前の画像は消されるように。保存期間が終了しましたと出る感じで（実際の LINE のように）」
//   消さない物（protectedUrls）: お客様に送った画像＝messages.image_url・sent_properties.image_url・sent_image_properties.image_url が
//     指す URL（完全一致＋Blob の pickups/ を指す行の総なめ）と、まだ期限内の行が使っている URL。
//   失敗時: Blob の削除が失敗した行は印を付けない → 次の日にやり直す。1回の上限 LIMIT 行（残りは次の日）。
import { supabase } from "@/app/lib/supabase";
import { planPickupPurge, rowsToMarkExpired, PICKUP_RETENTION_HOURS, PICKUP_URL_COLUMNS, type PurgeRow } from "@/app/lib/pickup-retention";

const DEFAULT_LIMIT = 300;
const DEL_CHUNK = 100;
const IN_CHUNK = 10;   // URL が長いので .in() は 10件ずつ（100件だと要求が長すぎて fetch failed になった）

export type PickupRetentionReport = {
  ok: boolean; dry: boolean; error?: string;
  retentionHours: number; cutoff: string;
  candidates: number; byStatus: Record<string, number>;
  deleteUrls: number; kept: { used_elsewhere: number; not_pickup_blob: number };
  deleted: number; deleteFailed: number; marked: number;
  estimatedMB?: number; oldest?: string | null;
  sample?: Array<{ id: number; status: string | null; delete: string[]; kept: string[] }>;
};

async function urlsReferencedBy(urls: string[]): Promise<Set<string>> {
  const hit = new Set<string>();
  const targets: Array<[string, string]> = [["messages", "image_url"], ["sent_properties", "image_url"], ["sent_image_properties", "image_url"]];
  for (const [table, col] of targets) {
    for (let i = 0; i < urls.length; i += IN_CHUNK) {
      const { data, error } = await supabase.from(table).select(col).in(col, urls.slice(i, i + IN_CHUNK));
      // 読めない時は「全部送った物」とみなす（消さない側に倒す）
      if (error) { console.warn(JSON.stringify({ tag: "pickup-retention:lookup-failed", table, error: error.message })); for (const u of urls.slice(i, i + IN_CHUNK)) hit.add(u); continue; }
      for (const d of (data ?? []) as unknown as Array<Record<string, string | null>>) if (d[col]) hit.add(d[col] as string);
    }
    // 念のため: Blob の pickups/ を指す送信の行を総なめ（URL の後ろに ?… が付いた等で完全一致しない物も拾う）
    const { data: likeRows, error: likeErr } = await supabase.from(table).select(col).like(col, "%.blob.vercel-storage.com/pickups/%").limit(2000);
    if (likeErr) return new Set(urls);
    for (const d of (likeRows ?? []) as unknown as Array<Record<string, string | null>>) {
      const v = d[col];
      if (!v) continue;
      hit.add(v);
      const base = v.split("?")[0];
      for (const u of urls) if (u.split("?")[0] === base) hit.add(u);
    }
  }
  return hit;
}

export async function runPickupRetention(opts: { dry: boolean; nowMs?: number; limit?: number; onlyIds?: number[]; measure?: boolean }): Promise<PickupRetentionReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - PICKUP_RETENTION_HOURS * 3600_000).toISOString();
  const cols = `id, created_at, expired_at, status, ${PICKUP_URL_COLUMNS.join(", ")}`;
  const base: PickupRetentionReport = { ok: false, dry: opts.dry, retentionHours: PICKUP_RETENTION_HOURS, cutoff, candidates: 0, byStatus: {}, deleteUrls: 0, kept: { used_elsewhere: 0, not_pickup_blob: 0 }, deleted: 0, deleteFailed: 0, marked: 0 };

  let q = supabase.from("property_pickups").select(cols).is("expired_at", null).lte("created_at", cutoff).order("created_at", { ascending: true }).limit(opts.limit ?? DEFAULT_LIMIT);
  if (opts.onlyIds?.length) q = q.in("id", opts.onlyIds);
  const { data, error } = await q;
  if (error) return { ...base, error: error.message };
  const rows = (data ?? []) as unknown as PurgeRow[];

  // まだ期限内の行が使っている URL（同じ Blob を指す行があれば消さない）
  const { data: young, error: yErr } = await supabase.from("property_pickups").select(PICKUP_URL_COLUMNS.join(", ")).gt("created_at", cutoff).limit(5000);
  if (yErr) return { ...base, error: yErr.message };
  const protectedUrls = new Set<string>();
  for (const y of (young ?? []) as unknown as Array<Record<string, string | null>>) for (const c of PICKUP_URL_COLUMNS) if (y[c]) protectedUrls.add(y[c] as string);
  const allUrls = [...new Set(rows.flatMap((r) => PICKUP_URL_COLUMNS.map((c) => r[c]).filter((u): u is string => !!u)))];
  for (const u of await urlsReferencedBy(allUrls)) protectedUrls.add(u);

  const plan = planPickupPurge({ rows, protectedUrls, nowMs });
  const byStatus: Record<string, number> = {};
  for (const r of plan.rows) byStatus[r.status ?? "-"] = (byStatus[r.status ?? "-"] ?? 0) + 1;
  const report: PickupRetentionReport = {
    ...base, ok: true, candidates: plan.rows.length, byStatus, deleteUrls: plan.deleteUrls.length, kept: plan.keptCount,
    oldest: rows[0]?.created_at ?? null,
    sample: plan.rows.slice(0, 5).map((r) => ({ id: r.id, status: r.status, delete: r.deleteUrls.map((u) => u.split("/").slice(3).join("/").slice(0, 80)), kept: r.keptUrls.map((k) => `${k.col}:${k.reason}`) })),
  };
  if (opts.measure && plan.deleteUrls.length > 0) {
    // 大きさの見込み（最大 40件の HEAD の平均 × 件数）
    const sample = plan.deleteUrls.slice(0, 40);
    const sizes = await Promise.all(sample.map(async (u) => {
      try { const r = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(8000) }); return Number(r.headers.get("content-length") ?? 0); } catch { return 0; }
    }));
    const got = sizes.filter((s) => s > 0);
    report.estimatedMB = got.length ? Math.round((got.reduce((a, b) => a + b, 0) / got.length) * plan.deleteUrls.length / 1024 / 1024 * 10) / 10 : 0;
  }
  if (opts.dry || plan.rows.length === 0) return report;

  if (plan.deleteUrls.length > 0 && !process.env.BLOB_READ_WRITE_TOKEN) {
    return { ...report, ok: false, error: "BLOB_READ_WRITE_TOKEN が無いので消していません" };
  }
  const { del } = await import("@vercel/blob");
  const deleted = new Set<string>();
  for (let i = 0; i < plan.deleteUrls.length; i += DEL_CHUNK) {
    const chunk = plan.deleteUrls.slice(i, i + DEL_CHUNK);
    try {
      await del(chunk);   // 既に無い物を消しても失敗しない
      for (const u of chunk) deleted.add(u);
    } catch (e) {
      report.deleteFailed += chunk.length;
      console.error(JSON.stringify({ tag: "pickup-retention:del-failed", n: chunk.length, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  report.deleted = deleted.size;
  const markIds = rowsToMarkExpired(plan, deleted);
  const nowIso = new Date(nowMs).toISOString();
  for (let i = 0; i < markIds.length; i += 100) {
    const ids = markIds.slice(i, i + 100);
    const { data: upd, error: uErr } = await supabase.from("property_pickups")
      .update({ expired_at: nowIso, pdf_blob_url: null, page_image_url: null, agent_image_url: null, trim_image_url: null })
      .in("id", ids).is("expired_at", null).select("id");
    if (uErr) { console.error(JSON.stringify({ tag: "pickup-retention:mark-failed", error: uErr.message })); continue; }
    report.marked += (upd ?? []).length;
  }
  console.log(JSON.stringify({ tag: "pickup-retention", ...report, sample: undefined }));
  return report;
}
