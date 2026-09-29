// scripts/audit-sent-skip.ts（読むだけ・書かない）
// 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないように」: 拡張が一覧で飛ばす部屋（sent-skip.js）を本番の記録に当てる。
//   材料: property_candidate_pools（拡張が選んで資料を取りに行った候補・merge-pdfs の前に記録）× sent_properties（その時点より前の送付済み）
//   判定: 拡張と同じ関数（chrome-extension/sent-skip.js）で「建物名＋号室が送付済みと同じ」を飛ばす
//   誤一致の確かめ: リアプロは資料の URL の id（factsheet.php?id=…＝部屋ごとの番号）。前に送った同じ部屋の候補の id と違えば「疑い」として目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-skip.ts [--since=2026-09-15] [--show=30]
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SK = require_("../chrome-extension/sent-skip.js") as {
  buildIndex(rooms: Array<{ name: string; room: string }>): { map: Record<string, string>; size: number };
  isSentRoom(idx: unknown, name: string, room: string | null): boolean; roomFromRealproCell(c: string): string | null; normName(s: string): string; normRoom(s: string): string; roomKey(s: string): string;
};
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", "2026-09-15");
const show = Number(arg("show", "30"));

type Cand = { name?: string; cells?: string[]; room_no?: string | null; pdf_url?: string | null; head?: string[] };
const idOf = (u: string | null | undefined) => (String(u ?? "").match(/[?&]id=(\d+)/) ?? [])[1] ?? null;

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; off < 60000; off += 1000) {
    const { data, error } = await q(off);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

(async () => {
  const pools = await all<{ property_customer_id: string | null; site: string; candidates: Cand[]; sent_at: string }>((o) =>
    sb.from("property_candidate_pools").select("property_customer_id, site, candidates, sent_at").gte("sent_at", since).order("sent_at").range(o, o + 999));
  const ids = [...new Set(pools.map((p) => p.property_customer_id).filter(Boolean))] as string[];
  const sent: Array<{ property_customer_id: string; property_name: string | null; room_no: string | null; sent_at: string; delivery: string | null }> = [];
  for (let i = 0; i < ids.length; i += 50) {
    sent.push(...await all((o) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, sent_at, delivery").in("property_customer_id", ids.slice(i, i + 50)).order("sent_at").range(o, o + 999)));
  }
  const sentBy = new Map<string, typeof sent>();
  for (const s of sent) { const a = sentBy.get(s.property_customer_id) ?? []; a.push(s); sentBy.set(s.property_customer_id, a); }
  // 前に選んだ候補（id を持つ）: 同じお客様×同じ部屋の鍵 → id の集合
  const seenIds = new Map<string, Set<string>>();
  const seenFacts = new Map<string, string>();
  const facts = (c: Cand & { rent?: number; floor_plan?: string; area_sqm?: number; ad_months?: number }) => `${c.rent ?? "?"}円・${c.floor_plan ?? "?"}・${c.area_sqm ?? "?"}㎡・AD${c.ad_months ?? "?"}`;
  let total = 0, withRoom = 0, skipped = 0, suspect = 0, idSame = 0, idUnknown = 0;
  const bySite: Record<string, { total: number; withRoom: number; skipped: number }> = {};
  const examples: string[] = [];
  const suspects: string[] = [];
  for (const p of pools) {
    const cid = p.property_customer_id;
    if (!cid) continue;
    const before = (sentBy.get(cid) ?? []).filter((s) => s.sent_at < new Date(Date.parse(p.sent_at) - 1000).toISOString());
    const idx = SK.buildIndex(before.map((s) => ({ name: String(s.property_name ?? ""), room: String(s.room_no ?? "") })));
    const site = p.site === "itandi" ? "itandi" : "realpro";
    const b = (bySite[site] ??= { total: 0, withRoom: 0, skipped: 0 });
    for (const c of p.candidates ?? []) {
      total++; b.total++;
      const labels = Array.isArray(c.head) ? c.head : null;
      const room = site === "realpro"
        ? (labels && labels.length && !/部屋|号室/.test(String(labels[0] ?? "")) ? null : SK.roomFromRealproCell(String(c.cells?.[0] ?? "")))
        : (c.room_no ? String(c.room_no) : null);
      if (room) { withRoom++; b.withRoom++; }
      const name = String(c.name ?? "");
      const key = `${cid}|${SK.normName(name)}|${SK.roomKey(room ?? "")}`;
      const id = idOf(c.pdf_url);
      if (room && SK.isSentRoom(idx, name, room)) {
        skipped++; b.skipped++;
        const prev = seenIds.get(key);
        if (site === "realpro" && id && prev && prev.size) {
          if (prev.has(id)) idSame++;
          else { suspect++; if (suspects.length < show) suspects.push(`${p.sent_at.slice(0, 16)} ${cid.slice(0, 8)} ${name} ${room} id=${id} 前の id=${[...prev].join(",")}（今 ${facts(c)} ／ 前 ${seenFacts.get(key) ?? "?"}）`); }
        } else idUnknown++;
        if (examples.length < show) examples.push(`${p.sent_at.slice(0, 16)} ${site} ${cid.slice(0, 8)} ${name} ${room}（前の送付: ${before.filter((s) => SK.normName(String(s.property_name)) === SK.normName(name) && SK.normRoom(String(s.room_no)) === SK.normRoom(room)).map((s) => `${s.sent_at.slice(5, 16)} ${s.delivery ?? "-"}`).slice(0, 2).join("・")}）`);
      }
      if (room && id) { const s = seenIds.get(key) ?? new Set<string>(); s.add(id); seenIds.set(key, s); seenFacts.set(key, facts(c)); }
    }
  }
  console.log(`=== 送付済みの部屋を飛ばす当て込み（${since}〜・候補の記録 ${pools.length}回・お客様 ${ids.length}人） ===`);
  console.log(`候補 ${total}件（号室が読める ${withRoom}件）→ 飛ばす ${skipped}件（${(skipped / Math.max(1, total) * 100).toFixed(1)}%）`);
  for (const [s, v] of Object.entries(bySite)) console.log(`  ${s}: 候補 ${v.total}・号室あり ${v.withRoom}・飛ばす ${v.skipped}`);
  console.log(`誤一致の確かめ（リアプロの資料の id）: 前に選んだ同じ部屋と id が同じ ${idSame}件 ／ id が違う（疑い）${suspect}件 ／ 前の候補が無く確かめられない ${idUnknown}件`);
  console.log("\n--- 飛ばす例 ---"); for (const e of examples) console.log(e);
  console.log("\n--- 疑い（id が違う）---"); for (const e of suspects) console.log(e);
})().catch((e) => { console.error(e); process.exit(1); });
