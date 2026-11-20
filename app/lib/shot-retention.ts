/**
 * 録画の写真（Storage human-motion-shots）の保存期間。
 *
 * ★ 2026-11-20 竹内さん（写真の保存期間）「自動モードの未読だけ14日で消す・読んだ写真と通常は残す」:
 *   実測: 10日で 25,355枚・3.3GB（1日 300〜700MB）。消す仕組みが無かった。自動（aix・ai）の写真 13,210枚/7日のうち読んだのは 536枚。
 *   → 自動のフォルダ（`日付/aix/`・`日付/ai/`）のうち、撮って14日を過ぎて `shot_learn` が空（読んでいない）写真だけ消す。
 *   ⚠ 読んだ写真・通常・スタッフ・旧形式（`日付/端末-時刻.jpg`・モード不明）は消さない。
 *   ⚠ 表の行（動き・押した順）は消さない。消すのは Storage の画像だけ。
 *   ⚠ 公開キーには削除権限を付けない（アプリに入っている鍵で誰でも消せてしまう）→ サーバー専用の鍵がある時だけ消す。
 */
import { supabase } from "./supabase-server";

export const SHOT_BUCKET = "human-motion-shots";
export const SHOT_RETENTION_DAYS = 14;
export const SHOT_RETENTION_MODES = ["aix", "ai"] as const;
/** 何日分さかのぼって見るか（cron が止まった日の取りこぼしを拾う） */
export const SHOT_RETENTION_LOOKBACK_DAYS = 10;

/** 消してよいフォルダの日付（UTC の `YYYY-MM-DD`）。撮った日から keepDays 日を丸ごと過ぎた日だけ */
export function retentionDays(nowMs: number, keepDays = SHOT_RETENTION_DAYS, lookback = SHOT_RETENTION_LOOKBACK_DAYS): string[] {
  const out: string[] = [];
  const day0 = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  for (let d = keepDays + 1; d <= keepDays + lookback; d++) out.push(new Date(day0 - d * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** 消す写真 = 自動のフォルダの写真 − 読んだ写真 */
export function pickExpiredShots(keys: readonly string[], learned: ReadonlySet<string>): string[] {
  return keys.filter((k) => /\.(jpg|jpeg|png)$/i.test(k) && SHOT_RETENTION_MODES.some((m) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}/${m}/`).test(k)) && !learned.has(k));
}

type Entry = { name?: string | null; metadata?: { size?: number } | null };

async function listAll(prefix: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const r = await supabase.storage.from(SHOT_BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (r.error) throw new Error(`list ${prefix}: ${r.error.message}`);
    const got = (r.data ?? []) as Entry[];
    out.push(...got);
    if (got.length < 1000) break;
  }
  return out;
}

/** フォルダの写真（`run_xxx/` の下も）を { key, size } で集める */
async function listShots(prefix: string): Promise<Array<{ key: string; size: number }>> {
  const files: Array<{ key: string; size: number }> = [];
  for (const e of await listAll(prefix)) {
    const name = String(e.name || "");
    if (!name) continue;
    if (/\.(jpg|jpeg|png)$/i.test(name)) { files.push({ key: `${prefix}/${name}`, size: Number(e.metadata?.size) || 0 }); continue; }
    for (const f of await listAll(`${prefix}/${name}`)) {
      const n = String(f.name || "");
      if (/\.(jpg|jpeg|png)$/i.test(n)) files.push({ key: `${prefix}/${name}/${n}`, size: Number(f.metadata?.size) || 0 });
    }
  }
  return files;
}

async function learnedKeysOf(keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 150) {
    const chunk = keys.slice(i, i + 150);
    const r = await supabase.from("human_motion_learn").select("shot_key").in("shot_key", chunk).not("shot_learn", "is", null);
    if (r.error) throw new Error(`learned: ${r.error.message}`);
    for (const x of (r.data ?? []) as Array<{ shot_key: string | null }>) if (x.shot_key) out.add(x.shot_key);
  }
  return out;
}

export type ShotRetentionResult = {
  dry: boolean;
  keepDays: number;
  days: Array<{ day: string; mode: string; files: number; learned: number; expired: number; expiredMB: number; removed: number }>;
  candidates: number;
  candidateMB: number;
  removed: number;
  skipped?: string;
  error?: string;
  more?: boolean;
};

export async function cleanupUnreadAutoShots(o: { dry: boolean; nowMs?: number; budgetMs?: number }): Promise<ShotRetentionResult> {
  const t0 = Date.now();
  const budget = o.budgetMs ?? 40_000;
  const res: ShotRetentionResult = { dry: o.dry, keepDays: SHOT_RETENTION_DAYS, days: [], candidates: 0, candidateMB: 0, removed: 0 };
  if ((process.env.SHOT_RETENTION_OFF ?? "") === "1") return { ...res, skipped: "SHOT_RETENTION_OFF=1" };
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  let admin: ReturnType<typeof import("@supabase/supabase-js").createClient> | null = null;
  if (!o.dry) {
    if (!serviceKey) return { ...res, skipped: "SUPABASE_SERVICE_ROLE_KEY が無いため削除していません（公開キーには削除権限が無い）" };
    const { createClient } = await import("@supabase/supabase-js");
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", serviceKey);
  }
  try {
    for (const day of retentionDays(o.nowMs ?? Date.now())) {
      for (const mode of SHOT_RETENTION_MODES) {
        if (Date.now() - t0 > budget) { res.more = true; return res; }
        const files = await listShots(`${day}/${mode}`);
        if (!files.length) continue;
        const keys = files.map((f) => f.key);
        const learned = await learnedKeysOf(keys);
        const expired = pickExpiredShots(keys, learned);
        const sizeOf = new Map(files.map((f) => [f.key, f.size]));
        const mb = Math.round(expired.reduce((n, k) => n + (sizeOf.get(k) ?? 0), 0) / 1048576 * 10) / 10;
        let removed = 0;
        if (admin && expired.length) {
          for (let i = 0; i < expired.length; i += 500) {
            if (Date.now() - t0 > budget) { res.more = true; break; }
            const r = await admin.storage.from(SHOT_BUCKET).remove(expired.slice(i, i + 500));
            if (r.error) { res.error = String(r.error.message).slice(0, 160); break; }
            // 権限が無いとエラーにならず空で返る → 実際に消えた物だけ数える
            removed += (r.data ?? []).length;
          }
        }
        res.days.push({ day, mode, files: files.length, learned: learned.size, expired: expired.length, expiredMB: mb, removed });
        res.candidates += expired.length;
        res.candidateMB = Math.round((res.candidateMB + mb) * 10) / 10;
        res.removed += removed;
        if (res.error || res.more) return res;
      }
    }
  } catch (e) {
    res.error = String((e as Error)?.message ?? e).slice(0, 160);
  }
  return res;
}
