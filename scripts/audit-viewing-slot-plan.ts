// scripts/audit-viewing-slot-plan.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-slot-plan.ts     （BACK=21 FWD=7 既定・読み取りのみ）
//
// 2026-09-30 竹内さん「内覧は1件なら1〜2時間の枠・予定の住所と移動時間も入れる・始まり11:00〜終了18:30」
// 実際のカレンダー（calendar_events。申込ツールの daily_tasks は鍵がある環境だけ）の各日に、旧の枠の決まりと新しい決まり
// （app/lib/viewing-slot-plan.ts）を当てて、出る枠を日ごとに並べる。件数だけでなく枠そのものを読む（案内できない日が増え過ぎていないか）
import { createClient } from "@supabase/supabase-js";
import { planDaySlots, isOutingViewingNotes, placeKeyOf, type SlotBusy } from "../app/lib/viewing-slot-plan";
import { jstParts, jstYmd } from "../app/lib/jst-date";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const BACK = Number(process.env.BACK ?? 21); const FWD = Number(process.env.FWD ?? 7);
const PLACE = process.env.PLACE ?? ""; // 内覧の場所（例: PLACE=東大阪市）

// 旧の決まり（2026-09-15〜9/30: 10:30〜18:30・前後1時間・2時間以上の空き・1枠は最大3時間）
function oldCalc(busy: Array<[number, number]>): string[] {
  const WS = 630, WE = 1110; const f = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  if (busy.length === 0) return ["13:00〜16:00", "16:00〜18:30"];
  const buf = busy.map(([s, e]) => [Math.max(Math.max(s, WS) - 60, WS), Math.min(Math.min(e, WE) + 60, WE)] as [number, number]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of buf) { const l = merged[merged.length - 1]; if (l && s < l[1]) l[1] = Math.max(l[1], e); else merged.push([s, e]); }
  const out: string[] = []; let cur = WS;
  for (const [bs, be] of [...merged, [WE, WE] as [number, number]]) { const fe = Math.min(bs, WE); if (fe - cur >= 120) out.push(`${f(cur)}〜${f(Math.min(cur + 180, fe))}`); cur = Math.max(cur, Math.min(be, WE)); }
  return out;
}

async function main() {
  const from = new Date(Date.now() - BACK * 86400_000).toISOString(); const to = new Date(Date.now() + FWD * 86400_000).toISOString();
  const { data, error } = await sb.from("calendar_events").select("start_at, end_at, event_type, title, all_day, notes").gte("start_at", from).lte("start_at", to).order("start_at").limit(2000);
  if (error) throw new Error(error.message);
  const byDay = new Map<string, NonNullable<typeof data>>();
  for (const e of data ?? []) { const k = jstYmd(e.start_at); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e); }
  const min = (iso: string) => { const p = jstParts(iso); return p.hour * 60 + p.minute; };
  let oldFull = 0, newFull = 0, days = 0, oldN = 0, newN = 0;
  console.log(`=== 旧と新の枠（${BACK}日前〜${FWD}日後・calendar_events だけ・内覧の場所=${PLACE || "不明"}）===`);
  for (const [day, evs] of [...byDay.entries()].sort()) {
    const busy: SlotBusy[] = []; const oldBusy: Array<[number, number]> = [];
    for (const e of evs) {
      if (e.all_day) { if (/定休|休業|休み|休日|お休み|closed|holiday/i.test(e.title || "") || e.event_type === "holiday") { busy.push({ start: 0, end: 1440 }); oldBusy.push([630, 1110]); } continue; }
      const s = min(e.start_at); const en = e.end_at ? min(e.end_at) : s + 60;
      busy.push({ start: s, end: Math.max(en, s), text: e.notes, outing: isOutingViewingNotes(e.event_type, e.notes) });
      oldBusy.push([s, en]);
    }
    const o = oldCalc(oldBusy); const plan = planDaySlots({ busy, place: PLACE });
    days++; if (o.length === 0) oldFull++; if (plan.slots.length === 0) newFull++; oldN += o.length; newN += plan.slots.length;
    const tiers = plan.blocks.map((b) => b.tier).reduce<Record<string, number>>((a, t) => { a[t] = (a[t] ?? 0) + 1; return a; }, {});
    const places = [...new Set(busy.filter((b) => b.outing).map((b) => placeKeyOf(b.text) || "（読めない）"))].join(",");
    console.log(`${day} 予定${String(busy.length).padStart(2)} 旧[${o.join(" ") || "案内不可"}] → 新[${plan.slots.join(" ") || "案内不可"}] ${JSON.stringify(tiers)}${places ? ` 内覧の場所=${places}` : ""}`);
  }
  console.log(`\n日数 ${days}・案内不可の日 旧 ${oldFull} → 新 ${newFull}・枠の数 旧 ${oldN} → 新 ${newN}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
