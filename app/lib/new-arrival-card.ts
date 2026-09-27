// app/lib/new-arrival-card.ts
// LINE のトーク画面（スタッフだけ）に出す「新着物件カード」の中身を作る純関数（DB・画面の依存なし＝画面からも使える）。
//
// 2026-09-27 竹内「ブレインの検索 → AIXツール（売上サポ・PickupReview）で採点された新着物件を、LINE のトーク画面に折りたたみで出す。
//   中身は拡張で検索した条件＋物件の件数（通す・保留）・新規／新着／広げて等の種類。押したら AIXツールのそのグループへ。
//   確認した（AIXツールで開いた・送った）かが分かるように（漏れ防止）。AIXツールでの分析結果の部分と結びつけるだけ」
//
// 材料は AIXツールと同じ物だけ（新しい判定を作らない）:
//   property_pickups の行（verdict・status・seen_at・search_mode・search_override）→ 回は AIXツールと同じ groupPickupRounds でまとめる
//   search_audits（拡張が入れようとした条件 intended・検索を始めた時のお客様の写し customer_snapshot・is_wide）→ 条件の1行と種類
// 確認済みの決まり（既存の列だけ）:
//   通す（verdict=pass）の全部が「送った／見送った（status≠pending）」か「AIXツールで開いた（seen_at）」→ 確認済み。1件でも残れば未確認。
//   seen_at は AIXツールでお客様を開いた時に /api/property-pickups/seen が入れる（スタッフ全員で共有）。
// お客様に出ない: この中身は messages に入れない・LINE へ送らない・下書き・ブレインの材料に渡さない（トーク画面の表示だけ）。
import { groupPickupRounds, siteLabel } from "./pickup-card-view";
import { WARD_CODE_NAMES } from "./search-condition-drift";

export type NacPickupRow = {
  id: number;
  created_at: string;
  batch_id: string;
  site: string | null;
  verdict: string | null;
  status: string | null;
  seen_at?: string | null;
  sent_at?: string | null;
  search_mode?: string | null;
  search_override?: unknown;
  complete_group_id?: string | null;
};

export type NacAudit = {
  created_at: string;
  site: string | null;
  is_wide?: boolean | null;
  intended?: Record<string, unknown> | null;
  customer_snapshot?: Record<string, unknown> | null;
};

export type NacConfirm =
  | { state: "unconfirmed"; left: number }
  | { state: "opened"; at: string | null }
  | { state: "sent"; at: string | null; sent: number }
  | { state: "none" };

export type NewArrivalCard = {
  /** AIXツールの回の鍵（元の batch_id を「,」でつないだ物） */
  key: string;
  /** トークの時系列に置く時刻（その回ができた時刻＝最初の行） */
  at: string;
  last_at: string;
  /** 「リアプロ 9・itandi 3」 */
  sites: string;
  total: number;
  pass: number;
  hold: number;
  drop: number;
  /** 種類の札（新規／新着／追加／🎯 ピンポイント／🔎 広げて／📝 メモの条件） */
  kinds: string[];
  /** 拡張で検索した条件の1行（点検の intended から。無ければ null） */
  condition: string | null;
  confirm: NacConfirm;
};

const ms = (s: string | null | undefined) => { const v = Date.parse(String(s ?? "")); return Number.isFinite(v) ? v : NaN; };
/** 点検のサイト名とピックアップのサイト名をそろえる（realpro / realnetpro → realpro） */
function siteKey(s: string | null | undefined): string {
  const v = String(s ?? "").toLowerCase();
  if (v.includes("real")) return "realpro";
  if (v.includes("itandi")) return "itandi";
  if (v.includes("reins")) return "reins";
  return v;
}
/** 回の直前の点検として認める幅（検索を始めてから結果が届くまで） */
export const NAC_AUDIT_LOOKBACK_MS = 3 * 60 * 60 * 1000;

/** その回を見つけた検索（同じサイト・回より前で一番新しい・3時間以内） */
export function auditForRound(audits: ReadonlyArray<NacAudit>, site: string | null, roundAt: string): NacAudit | null {
  const at = ms(roundAt);
  const sk = siteKey(site);
  let best: NacAudit | null = null;
  for (const a of audits) {
    const t = ms(a.created_at);
    if (!Number.isFinite(t) || !Number.isFinite(at)) continue;
    if (siteKey(a.site) !== sk) continue;
    if (t > at + 60_000 || at - t > NAC_AUDIT_LOOKBACK_MS) continue;
    if (!best || t > ms(best.created_at)) best = a;
  }
  return best;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function manYen(yen: number): string { return `${String(Math.round(yen / 100) / 100)}万`; }

/** 拡張が入れようとした条件（search_audits.intended）→「北区・福島区／〜9万／1K・1LDK／30㎡〜／築25年／徒歩10分」 */
export function conditionLine(intended: Record<string, unknown> | null | undefined): string | null {
  if (!intended || typeof intended !== "object") return null;
  const parts: string[] = [];
  const codes = Array.isArray(intended.city_codes) ? (intended.city_codes as unknown[]).map(String) : [];
  const wards = codes.map((c) => (WARD_CODE_NAMES[c] ?? "").replace(/^大阪市/, "")).filter(Boolean);
  const stations = Array.isArray(intended.station_names) ? (intended.station_names as unknown[]).map(String).filter(Boolean) : [];
  if (stations.length) parts.push(stations.length > 4 ? `${stations.slice(0, 4).join("・")} ほか${stations.length - 4}駅` : stations.join("・"));
  else if (wards.length) parts.push(wards.join("・"));
  const rmin = num(intended.rent_min), rmax = num(intended.rent_max);
  if (rmin || rmax) parts.push(`${rmin ? manYen(rmin) : ""}〜${rmax ? manYen(rmax) : ""}`);
  const plan = typeof intended.floor_plan === "string" ? intended.floor_plan.replace(/[、,]\s*/g, "・").trim() : "";
  if (plan) parts.push(plan);
  const amin = num(intended.area_min);
  if (amin) parts.push(`${amin}㎡〜`);
  const age = num(intended.building_age);
  if (age) parts.push(`築${age}年`);
  const walk = num(intended.walk_minutes);
  if (walk) parts.push(`徒歩${walk}分`);
  const upd = num(intended.rp_update_days);
  if (upd) parts.push(`更新${upd}日以内`);
  return parts.length ? parts.join("／") : null;
}

/**
 * 種類: 新着＝更新日で絞った回（rp_update_days）／新規＝物件を出したことが無い時の回（検索を始めた時の写しに送った・内覧の日が無い）／追加＝それ以外。
 *   分からない（点検が無い）時は出さない。ピンポイント／広げては行の search_mode と点検の is_wide
 */
export function roundKinds(rows: ReadonlyArray<NacPickupRow>, audit: NacAudit | null): string[] {
  const out: string[] = [];
  if (audit) {
    const upd = num(audit.intended?.rp_update_days);
    const snap = audit.customer_snapshot;
    const had = !!snap && typeof snap === "object" && ["last_property_sent_at", "property_viewed_at"].some((k) => Number.isFinite(ms(snap[k] as string)));
    out.push(upd ? "新着" : snap ? (had ? "追加" : "新規") : "追加");
  }
  const modes = new Set(rows.map((r) => String(r.search_mode ?? "")));
  if (modes.has("pinpoint")) out.push("🎯 ピンポイント");
  if (modes.has("widen") || audit?.is_wide === true) out.push("🔎 広げて");
  if (rows.some((r) => r.search_override != null)) out.push("📝 メモの条件");
  return out;
}

/** 確認済みか（通すの全部が 送った・見送った か AIXツールで開いた） */
export function roundConfirm(rows: ReadonlyArray<NacPickupRow>): NacConfirm {
  const pass = rows.filter((r) => r.verdict === "pass");
  if (pass.length === 0) return { state: "none" };
  const left = pass.filter((r) => r.status === "pending" && !r.seen_at).length;
  if (left > 0) return { state: "unconfirmed", left };
  const sent = rows.filter((r) => r.status === "sent");
  if (sent.length > 0) {
    const at = sent.map((r) => r.sent_at ?? "").filter(Boolean).sort().slice(-1)[0] ?? null;
    return { state: "sent", at, sent: sent.length };
  }
  const at = pass.map((r) => r.seen_at ?? "").filter(Boolean).sort().slice(-1)[0] ?? null;
  return { state: "opened", at };
}

/** お客様1人分の行と点検 → トークに出すカード（古い順） */
export function buildNewArrivalCards(rows: ReadonlyArray<NacPickupRow>, audits: ReadonlyArray<NacAudit>): NewArrivalCard[] {
  const byBatch = new Map<string, { batch_id: string; created_at: string; site: string | null; round_id: string | null; rows: NacPickupRow[] }>();
  for (const r of rows) {
    const b = byBatch.get(r.batch_id) ?? { batch_id: r.batch_id, created_at: r.created_at, site: r.site, round_id: r.complete_group_id ?? null, rows: [] };
    if (r.created_at < b.created_at) b.created_at = r.created_at;
    if (!b.round_id && r.complete_group_id) b.round_id = r.complete_group_id;
    b.rows.push(r);
    byBatch.set(r.batch_id, b);
  }
  return groupPickupRounds([...byBatch.values()]).map((round) => {
    const items = round.batches.flatMap((b) => b.rows);
    const siteCount = new Map<string, number>();
    for (const b of round.batches) siteCount.set(siteLabel(b.site), (siteCount.get(siteLabel(b.site)) ?? 0) + b.rows.length);
    // 条件: サイトごとに回の直前の点検（同じ条件なら1つにまとめる）
    const siteList = [...new Set(round.batches.map((b) => b.site))];
    const audits1 = siteList.map((s) => auditForRound(audits, s, round.created_at)).filter((a): a is NacAudit => !!a);
    const conds = [...new Set(audits1.map((a) => conditionLine(a.intended)).filter((v): v is string => !!v))];
    const kinds = [...new Set(audits1.length ? audits1.flatMap((a) => roundKinds(items, a)) : roundKinds(items, null))];
    const n = { pass: 0, hold: 0, drop: 0 };
    for (const it of items) if (it.verdict === "pass" || it.verdict === "hold" || it.verdict === "drop") n[it.verdict]++;
    return {
      key: round.key,
      at: round.created_at,
      last_at: round.last_at,
      sites: [...siteCount.entries()].map(([k, c]) => `${k} ${c}`).join("・"),
      total: items.length,
      ...n,
      kinds,
      condition: conds.length ? conds.join(" ／ ") : null,
      confirm: roundConfirm(items),
    };
  });
}

/** トークの時系列のどこに置くか: 前の吹き出し（prevAt）より後で、この吹き出し（curAt）以前のカード。最後の吹き出しの後ろは curAt=null */
export function cardsBetween<T extends { at: string }>(cards: ReadonlyArray<T>, prevAt: string | null | undefined, curAt: string | null | undefined): T[] {
  const lo = prevAt ? ms(prevAt) : -Infinity;
  const hi = curAt ? ms(curAt) : Infinity;
  return cards.filter((c) => { const t = ms(c.at); return Number.isFinite(t) && t > (Number.isFinite(lo) ? lo : -Infinity) && t <= (Number.isFinite(hi) ? hi : Infinity); });
}

/** AIXツールのそのお客様・その回を開く URL（/conditions?pickup=<お客様の鍵>&batch=<回の最初の batch_id>） */
export function pickupReviewHref(focus: string, roundKey: string): string {
  const first = roundKey.split(",")[0] ?? "";
  return `/conditions?pickup=${encodeURIComponent(focus)}&batch=${encodeURIComponent(first)}`;
}

/** カードの見出し（折りたたんだ時の1行）「🏠 新着物件 通す3・保留6（リアプロ 10）」 */
export function cardHeadline(c: Pick<NewArrivalCard, "pass" | "hold" | "drop" | "sites">): string {
  const v = [`通す ${c.pass}`, c.hold ? `保留 ${c.hold}` : "", c.drop ? `外す候補 ${c.drop}` : ""].filter(Boolean).join("・");
  return `🏠 新着物件 ${v}${c.sites ? `（${c.sites}）` : ""}`;
}

/** 確認の札 */
export function confirmLabel(c: NacConfirm, fmt: (iso: string) => string = (s) => s): { text: string; tone: "warn" | "ok" | "muted" } {
  if (c.state === "unconfirmed") return { text: `未確認（通す ${c.left}件）`, tone: "warn" };
  if (c.state === "sent") return { text: `✅ 送った ${c.sent}件${c.at ? `・${fmt(c.at)}` : ""}`, tone: "ok" };
  if (c.state === "opened") return { text: `✅ AIXツールで確認済み${c.at ? `・${fmt(c.at)}` : ""}`, tone: "ok" };
  return { text: "通す 0件", tone: "muted" };
}
