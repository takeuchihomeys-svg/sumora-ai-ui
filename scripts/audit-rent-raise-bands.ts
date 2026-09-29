// scripts/audit-rent-raise-bands.ts — 監査（読むだけ・DB に書かない）2026-09-27
// 「家賃を上げて」（金額なし）の上げ幅の決まり（app/lib/rent-raise.ts RENT_RAISE_RULE）と、スタッフ・自動が実際に上げた幅を並べる。
//   竹内「この決まりはまた詳細を学習していったらいける」→ 表の点（rates・minDeltaYen）を直す時の材料。
//   ①決まりの表（帯ごとの上げた後の値） ②property_condition_history の rent_max の上げ（old < new）を1行ずつ:
//     その時の上限・実際の上げた後・決まりの値・差・出どころ（source_message_id: 無し＝手・画面／P4 等、scope:temporary は除く）
//     と、直前2時間のお客様の発言（上げての依頼か＝detectRentRaiseRequest の読み）
//   ③帯ごとの中央値（実際の上げ幅の率 vs 決まりの率）
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-raise-bands.ts [SINCE=2026-06-01]
import { createClient } from "@supabase/supabase-js";
import { RENT_RAISE_RULE, defaultRaisedRentMax, rentRaiseRate, detectRentRaiseRequest } from "../app/lib/rent-raise";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const SINCE = process.env.SINCE ?? "2026-06-01";
const YUMA_PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const man = (y: number) => `${Math.round(y / 1000) / 10}万`;
const one = (s: string, n: number) => String(s ?? "").replace(/\n/g, " / ").slice(0, n);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function main() {
  console.log("===== ① 決まりの表（RENT_RAISE_RULE）", JSON.stringify(RENT_RAISE_RULE));
  for (const y of [50000, 60000, 70000, 80000, 90000, 100000, 120000, 150000, 200000]) {
    const v = defaultRaisedRentMax(y);
    console.log(`  ${man(y)} → ${man(v)}（+${man(v - y)}・率 ${(rentRaiseRate(y) * 100).toFixed(1)}%）`);
  }

  console.log(`\n===== ② 実際の上げ（property_condition_history rent_max・${SINCE}〜）`);
  const rows: Array<{ property_customer_id: string; old_value: string | null; new_value: string | null; source_message_id: string | null; created_at: string }> = [];
  for (let off = 0; off < 20000; off += 1000) {
    const { data, error } = await sb.from("property_condition_history").select("property_customer_id,old_value,new_value,source_message_id,created_at")
      .eq("changed_field", "rent_max").gte("created_at", SINCE).order("created_at").range(off, off + 999);
    if (error) { console.log(error.message); break; }
    if (!data?.length) break;
    rows.push(...(data as never[]));
  }
  const bands = new Map<string, { actual: number[]; rule: number[]; asked: number }>();
  const bandOf = (y: number) => (y < 70000 ? "〜7万未満" : y < 100000 ? "7〜10万未満" : y < 150000 ? "10〜15万未満" : "15万〜");
  let n = 0;
  for (const r of rows) {
    const o = Number(r.old_value), v = Number(r.new_value);
    if (!(o > 0 && v > o) || r.property_customer_id === YUMA_PC) continue;
    if (String(r.source_message_id ?? "").startsWith("scope:temporary")) continue;
    n++;
    const rule = defaultRaisedRentMax(o);
    const { data: conv } = await sb.from("conversations").select("id,customer_name").eq("property_customer_id", r.property_customer_id).limit(1).maybeSingle();
    let asked = "";
    if (conv?.id) {
      const from = new Date(Date.parse(r.created_at) - 2 * 3600e3).toISOString();
      const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", conv.id).eq("sender", "customer").gte("created_at", from).lte("created_at", r.created_at).order("created_at", { ascending: false }).limit(5);
      const hit = (ms ?? []).map((m) => String(m.text ?? "")).find((t) => detectRentRaiseRequest(t));
      if (hit) { const q = detectRentRaiseRequest(hit)!; asked = `依頼(${q.kind})「${one(hit, 50)}」`; }
    }
    const b = bands.get(bandOf(o)) ?? { actual: [], rule: [], asked: 0 };
    b.actual.push((v - o) / o); b.rule.push((rule - o) / o); if (asked) b.asked++;
    bands.set(bandOf(o), b);
    console.log(`  ${r.created_at.slice(0, 16)} ${conv?.customer_name ?? r.property_customer_id.slice(0, 8)} ${man(o)} → 実際 ${man(v)}（+${man(v - o)}）・決まり ${man(rule)}・差 ${v - rule >= 0 ? "+" : ""}${man(v - rule)}・出どころ ${r.source_message_id ?? "（印なし）"} ${asked}`);
  }
  console.log(`  計 ${n} 件`);

  console.log("\n===== ③ 帯ごと（実際の上げ幅の率の中央値 vs 決まりの率の中央値・お客様の依頼があった件数）");
  for (const [k, b] of [...bands.entries()].sort()) {
    console.log(`  ${k}: ${b.actual.length}件・実際 ${(median(b.actual) * 100).toFixed(1)}%・決まり ${(median(b.rule) * 100).toFixed(1)}%・依頼あり ${b.asked}`);
  }
  console.log("  ※ 依頼ありの件だけが決まりの正解の材料（依頼なしの上げはスタッフの判断・フォームの入れ直し等が混ざる）");
}
main();
