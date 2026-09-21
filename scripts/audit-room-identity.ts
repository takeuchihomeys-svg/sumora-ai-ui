// 号室が無いまま「同じ部屋」を見分けられるか（読み取りのみ）
//
// 2026-09-21 竹内「一度共有した物件を除いてLINEに送る」
//
// ■ ここまでで分かったこと（scripts/audit-summary-room.ts）
//   ・送っている物件名に号室が入っているのは **0.1%（12/20,716）**
//   ・1回の送信の **74.2%** に「同じ建物名が2件以上」入っている（＝別の部屋を同時に送っている）
//   → 名前だけで除外すると、74.2% の送信で別の部屋まで消える。**このままでは除外は作れない**。
//
// ■ ここで測ること
//   property_candidate_pools の candidates には rank / name / rent / floor_plan / walk_minutes / ad_months がある。
//   号室の代わりに **名前＋家賃＋間取り** で部屋を見分けられるなら、除外の鍵にできる。
//   見分けられる条件は「同じ建物の別部屋が、家賃か間取りで必ず違う」こと。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-room-identity.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 60);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

type Cand = { rank?: number; name?: string; rent?: number | null; floor_plan?: string | null; walk_minutes?: number | null; ad_months?: number | null };

async function main() {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("property_candidate_pools")
      .select("id, property_customer_id, customer_name, site, candidates, sent_at")
      .gte("sent_at", new Date(Date.now() - DAYS * 86400_000).toISOString())
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  const all: Cand[] = [];
  for (const row of out) for (const c of ((row.candidates ?? []) as Cand[])) if (String(c?.name ?? "").trim()) all.push(c);
  console.log(`=== 直近${DAYS}日 ${out.length}回の送信 / 物件 ${all.length}件 ===\n`);

  // ① 鍵になる列がどれだけ埋まっているか（「入れ物があることと埋まっていることは別」）
  console.log(`=== ① 号室の代わりになりうる列の埋まり具合 ===`);
  const filled = (f: (c: Cand) => unknown) => all.filter((c) => {
    const v = f(c); return v !== null && v !== undefined && String(v).trim() !== "";
  }).length;
  for (const [label, f] of [
    ["name", (c: Cand) => c.name], ["rent", (c: Cand) => c.rent],
    ["floor_plan", (c: Cand) => c.floor_plan], ["walk_minutes", (c: Cand) => c.walk_minutes],
    ["ad_months", (c: Cand) => c.ad_months],
  ] as Array<[string, (c: Cand) => unknown]>) {
    console.log(`   ${label.padEnd(14)} ${String(filled(f)).padStart(6)}件（${pct(filled(f), all.length)}）`);
  }

  // ② 同じ送信の中で「同じ建物名」の物件が、家賃/間取りで見分けられるか
  //    ここが肝心: 見分けられなければ、鍵にしても別部屋を巻き込む
  console.log(`\n=== ② 同じ送信の中の「同じ建物名」— 家賃・間取りで別部屋と分かるか ===`);
  let sameNameGroups = 0, distinguishable = 0, identical = 0;
  const identicalEx: string[] = [];
  for (const row of out) {
    const cs = ((row.candidates ?? []) as Cand[]).filter((c) => String(c?.name ?? "").trim());
    const byName = new Map<string, Cand[]>();
    for (const c of cs) {
      const n = String(c.name).trim();
      byName.set(n, [...(byName.get(n) ?? []), c]);
    }
    for (const [n, list] of byName) {
      if (list.length < 2) continue;
      sameNameGroups++;
      const keys = new Set(list.map((c) => `${c.rent ?? ""}|${(c.floor_plan ?? "").trim()}`));
      if (keys.size === list.length) distinguishable++;
      else {
        identical++;
        if (identicalEx.length < 6) {
          identicalEx.push(`     ${n} … ${list.length}件中 ${list.length - keys.size + 1}件が同じ（`
            + list.map((c) => `${c.rent ?? "-"}円/${c.floor_plan ?? "-"}`).join(" ／ ") + `）`);
        }
      }
    }
  }
  console.log(`   同じ建物名が2件以上あるまとまり: ${sameNameGroups}組`);
  console.log(`   家賃＋間取りで**全部見分けられる**: ${distinguishable}組（${pct(distinguishable, sameNameGroups)}）`);
  console.log(`   見分けられない（同じ家賃・同じ間取りが混ざる）: **${identical}組（${pct(identical, sameNameGroups)}）**`);
  if (identicalEx.length) { console.log(`   ─ 見分けられない例 ─`); for (const e of identicalEx) console.log(e); }

  // ③ 「名前＋家賃＋間取り」を鍵にした時、過去の送信と何件ぶつかるか（＝除外の効き目）
  console.log(`\n=== ③ 「名前＋家賃＋間取り」を鍵にした時、同じ相手に再送している数 ===`);
  const keyOf = (c: Cand) => `${String(c.name).trim()}|${c.rent ?? ""}|${(c.floor_plan ?? "").trim()}`;
  const byCustomer = new Map<string, Array<{ key: string; at: number }>>();
  for (const row of out) {
    const cust = String(row.property_customer_id ?? "");
    if (!cust) continue;
    const at = Date.parse(String(row.sent_at));
    for (const c of ((row.candidates ?? []) as Cand[])) {
      if (!String(c?.name ?? "").trim()) continue;
      byCustomer.set(cust, [...(byCustomer.get(cust) ?? []), { key: keyOf(c), at }]);
    }
  }
  let total = 0, repeats = 0;
  const gapHours: number[] = [];
  for (const list of byCustomer.values()) {
    list.sort((a, b) => a.at - b.at);
    const firstAt = new Map<string, number>();
    for (const x of list) {
      total++;
      const f = firstAt.get(x.key);
      if (f === undefined) { firstAt.set(x.key, x.at); continue; }
      if (x.at - f < 60_000) continue;          // 同じ送信の中の重複は数えない
      repeats++;
      gapHours.push((x.at - f) / 3600_000);
    }
  }
  console.log(`   物件顧客に紐付く送信 ${byCustomer.size}人 / 物件 ${total}件`);
  console.log(`   **一度送った物件をまた送っている: ${repeats}件（${pct(repeats, total)}）**`);
  if (gapHours.length) {
    const B: Array<[string, number, number]> = [
      ["1時間〜1日", 0, 24], ["1〜3日", 24, 72], ["3〜7日", 72, 168],
      ["1〜2週", 168, 336], ["2〜4週", 336, 672], ["1ヶ月〜", 672, Infinity],
    ];
    console.log(`   ─ 前に送ってから何日後に送り直しているか ─`);
    for (const [label, lo, hi] of B) {
      const n = gapHours.filter((g) => g >= lo && g < hi).length;
      if (n) console.log(`     ${label.padEnd(12)} ${String(n).padStart(5)}件（${pct(n, gapHours.length)}）`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
