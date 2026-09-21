// 送っている物件の「名前」に号室が入っているか（読み取りのみ）
//
// 2026-09-21 竹内「一度共有した物件を除いてLINEに送る」
//
// ⚠ 号室が取れないと除外は危険:
//   isSameProperty は号室が片方でも無いと**名前だけ**で重複と判定する。
//   同じ建物の別部屋（「〇〇マンション 501」と「〇〇マンション 803」）を誤って除外すると、
//   送るべき物件が送られなくなる（設計知見「出口は誤削除0でなければ入れない」）。
//   実測では同じ会話に「名前が同じで号室が違う」ペアが 65組あった。
//
// ここで見るのは property_candidate_pools（拡張が送信時に一緒に記録している候補プール）。
// merge-pdfs に渡る property_summaries の1行目と同じ元データなので、号室の有無が分かる。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-summary-room.ts
import { createClient } from "@supabase/supabase-js";
import { normalizeRoomNo } from "../app/lib/sent-property-record";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 60);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
/** merge-pdfs が号室を切り出す時と同じ正規表現（四者同名） */
const ROOM_TAIL_RE = /[\s　]+(\d{1,4})(?:号室?)?$/;

async function main() {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("property_candidate_pools")
      .select("property_customer_id, customer_name, site, candidates, sent_at")
      .gte("sent_at", new Date(Date.now() - DAYS * 86400_000).toISOString())
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  console.log(`=== property_candidate_pools 直近${DAYS}日 ${out.length}回の送信 ===\n`);

  type Cand = { rank?: number; name?: string };
  const names: string[] = [];
  let withCustomer = 0;
  for (const row of out) {
    if (row.property_customer_id) withCustomer++;
    for (const c of ((row.candidates ?? []) as Cand[])) {
      const n = String(c?.name ?? "").trim();
      if (n) names.push(n);
    }
  }
  console.log(`   物件顧客IDが入っている送信: ${withCustomer}/${out.length}（${pct(withCustomer, out.length)}）`);
  console.log(`   物件名 ${names.length}件\n`);

  // ① 号室が末尾に付いているか
  const withRoom = names.filter((n) => ROOM_TAIL_RE.test(n));
  console.log(`=== ① 名前の末尾に号室があるか（merge-pdfs と同じ正規表現）===`);
  console.log(`   号室あり ${withRoom.length}件（${pct(withRoom.length, names.length)}）`);
  console.log(`   号室なし ${names.length - withRoom.length}件（${pct(names.length - withRoom.length, names.length)}）`);
  console.log(`\n   ─ 号室ありの例 ─`);
  for (const n of withRoom.slice(0, 6)) {
    const m = n.match(ROOM_TAIL_RE);
    console.log(`     ${n}   → 名前「${n.slice(0, m?.index).trim()}」／ 号室「${normalizeRoomNo(m?.[1])}」`);
  }
  console.log(`\n   ─ 号室なしの例 ─`);
  for (const n of names.filter((x) => !ROOM_TAIL_RE.test(x)).slice(0, 10)) console.log(`     ${n}`);

  // ② 号室が無い物件で、同じ名前が複数の部屋を指していないか（＝誤除外の危険）
  console.log(`\n=== ② 号室が無いまま名前だけで除外した時の危険 ===`);
  const noRoom = names.filter((n) => !ROOM_TAIL_RE.test(n));
  const cnt = new Map<string, number>();
  for (const n of noRoom) cnt.set(n, (cnt.get(n) ?? 0) + 1);
  const repeated = [...cnt.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  console.log(`   号室なしの物件名 ${cnt.size}種類 ／ 2回以上出る名前 ${repeated.length}種類`);
  console.log(`   ＝ この名前は「同じ建物の別の部屋」かもしれないのに、号室が無いので区別できない`);
  for (const [n, c] of repeated.slice(0, 8)) console.log(`     ${c}回  ${n}`);

  // ③ 同じ送信の中に同じ名前が複数あるか（同じ建物の複数部屋を1回で送っている証拠）
  console.log(`\n=== ③ 1回の送信の中に同じ名前が複数あるか ===`);
  let sendsWithSameName = 0, sameNamePairs = 0;
  for (const row of out) {
    const ns = ((row.candidates ?? []) as Cand[]).map((c) => String(c?.name ?? "").trim()).filter(Boolean);
    const c2 = new Map<string, number>();
    for (const n of ns) {
      const base = n.replace(ROOM_TAIL_RE, "").trim();
      c2.set(base, (c2.get(base) ?? 0) + 1);
    }
    const hit = [...c2.values()].filter((v) => v >= 2).length;
    if (hit) { sendsWithSameName++; sameNamePairs += hit; }
  }
  console.log(`   同じ建物名が2件以上入っている送信: ${sendsWithSameName}/${out.length}（${pct(sendsWithSameName, out.length)}）`);
  console.log(`   ＝ 号室が無いまま名前で除外すると、**この送信では2件目以降が消える**`);
}
main().catch((e) => { console.error(e); process.exit(1); });
