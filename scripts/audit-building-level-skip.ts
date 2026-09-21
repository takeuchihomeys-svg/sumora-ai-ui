// 「マンションごと」外した場合と、今の「同じ部屋だけ」外す場合を並べる（読み取りのみ）
//
// 2026-09-21 竹内「これで一度グループに送った物件（マンションごと）は送られんようになってるかな？」
//
// ⚠ 今の実装は **同じ部屋だけ** 外す（建物が同じでも号室が違えば送る）。
//   そうした理由は scripts/audit-summary-room.ts の実測:
//     1回の送信の **74.2%** に「同じ建物名が2件以上」入っている＝別の部屋を同時に送っている。
//     名前だけで外すと、その2件目以降が消える。
//
//   竹内さんの望みが「建物ごと」なら線を変えられるが、変える前に**何が消えるか**を数える。
//   分けて数えるのが肝心:
//     A 同じ送信の中の同じ建物  … 1回の提案で複数の部屋を見せている（消すべきでない可能性が高い）
//     B 前の送信で送った建物    … 竹内さんが困っている「また同じマンション」
//
// 実行: npx tsx --env-file=.env.local scripts/audit-building-level-skip.ts
import { createClient } from "@supabase/supabase-js";
import { normalizePropertyName, similarity } from "../app/lib/property-name-match";
import { DUP_MIN_SCORE } from "../app/lib/sent-property-record";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 60);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const ROOM_TAIL_RE = /[\s　]+(\d{1,4})(?:号室?)?$/;

type Cand = { rank?: number; name?: string };

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("property_candidate_pools")
      .select("property_customer_id, candidates, sent_at")
      .gte("sent_at", new Date(Date.now() - DAYS * 86400_000).toISOString())
      .order("sent_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; rows.push(...r); if (r.length < 1000) break;
  }
  const withCust = rows.filter((r) => String(r.property_customer_id ?? ""));
  console.log(`=== 直近${DAYS}日 送信${rows.length}回（物件顧客に紐付く ${withCust.length}回）===\n`);

  const byCust = new Map<string, Array<Record<string, unknown>>>();
  for (const r of withCust) {
    const c = String(r.property_customer_id);
    byCust.set(c, [...(byCust.get(c) ?? []), r]);
  }

  let total = 0;
  let sameRunSameBuilding = 0;     // A 同じ送信の中の同じ建物
  let pastSameBuilding = 0;        // B 前の送信で送った建物
  let sendsEmptied = 0;            // 建物ごとに外したら送る物が0になる送信
  let sendsShrunk = 0;
  const shrinkRatios: number[] = [];
  const exampleB: string[] = [];
  const byBuildingRepeat = new Map<string, number>();

  for (const list of byCust.values()) {
    list.sort((a, b) => Date.parse(String(a.sent_at)) - Date.parse(String(b.sent_at)));
    /** その顧客に過去の送信で送った建物（正規化した名前） */
    const pastBuildings: string[] = [];
    for (const row of list) {
      const names = ((row.candidates ?? []) as Cand[])
        .map((c) => String(c?.name ?? "").trim()).filter(Boolean)
        .map((raw) => {
          const m = raw.match(ROOM_TAIL_RE);
          return m ? raw.slice(0, m.index ?? 0).trim() : raw;
        });
      if (names.length === 0) continue;
      const seenInRun: string[] = [];
      let kept = 0;
      for (const n of names) {
        total++;
        const norm = normalizePropertyName(n);
        const inPast = pastBuildings.some((p) => similarity(p, norm) >= DUP_MIN_SCORE);
        const inRun = seenInRun.some((p) => similarity(p, norm) >= DUP_MIN_SCORE);
        if (inPast) {
          pastSameBuilding++;
          byBuildingRepeat.set(n, (byBuildingRepeat.get(n) ?? 0) + 1);
          if (exampleB.length < 10) exampleB.push(`     ${n}`);
        } else if (inRun) {
          sameRunSameBuilding++;
        } else {
          kept++;
        }
        seenInRun.push(norm);
      }
      // 「前の送信で送った建物だけ外す」（同じ送信内は残す）場合に残る数
      const keptIfPastOnly = names.length - (names.length - kept - sameRunSameBuilding >= 0 ? 0 : 0);
      void keptIfPastOnly;
      const keepCount = names.filter((n) => {
        const norm = normalizePropertyName(n);
        return !pastBuildings.some((p) => similarity(p, norm) >= DUP_MIN_SCORE);
      }).length;
      if (keepCount === 0) sendsEmptied++;
      else if (keepCount < names.length) { sendsShrunk++; shrinkRatios.push(keepCount / names.length); }
      for (const n of names) pastBuildings.push(normalizePropertyName(n));
    }
  }

  console.log(`=== ① 今の実装（同じ部屋だけ外す）===`);
  console.log(`   外れるのは「URL が一致」か「名前が近く号室も一致」した物だけ。`);
  console.log(`   号室は実測 0.1% しか取れないので、**建物が同じでも部屋が違えば送られる**。`);
  console.log(`   ＝ 竹内さんの言う「マンションごと」には**なっていない**。\n`);

  console.log(`=== ② 建物ごとに外した場合（名前が ${DUP_MIN_SCORE} 以上で一致したら外す）===`);
  console.log(`   これから送る物件 ${total}件`);
  console.log(`   B 前の送信で送った建物   **${pastSameBuilding}件（${pct(pastSameBuilding, total)}）** ← 竹内さんが困っている分`);
  console.log(`   A 同じ送信の中の同じ建物  ${sameRunSameBuilding}件（${pct(sameRunSameBuilding, total)}）← 1回の提案で複数の部屋を見せている分`);
  console.log(`\n   B だけ外した場合（A は残す）:`);
  console.log(`     送る物が0件になる送信   **${sendsEmptied}回**`);
  console.log(`     件数が減る送信           ${sendsShrunk}回`);
  if (shrinkRatios.length) {
    const avg = shrinkRatios.reduce((a, b) => a + b, 0) / shrinkRatios.length;
    console.log(`     減った後に残る割合の平均 ${(avg * 100).toFixed(1)}%`);
  }

  console.log(`\n=== ③ 何度も送られている建物（上位）===`);
  for (const [n, c] of [...byBuildingRepeat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(c).padStart(4)}回  ${n}`);
  }

  // ④ 期間で区切った場合（「〇日以内に送った建物だけ外す」）
  //    期間を設けると「前に送ったが時間が経った建物」は送れる（募集が変わっている可能性があるので）
  console.log(`\n=== ④ 期間で区切ると何が変わるか ===`);
  console.log(`   期間        外れる物件            送る物が0件になる送信`);
  for (const days of [3, 7, 14, 30, 60, Infinity]) {
    let drop = 0, emptied = 0, tot = 0, sends = 0;
    for (const list of byCust.values()) {
      list.sort((a, b) => Date.parse(String(a.sent_at)) - Date.parse(String(b.sent_at)));
      const past: Array<{ name: string; at: number }> = [];
      for (const row of list) {
        const at = Date.parse(String(row.sent_at));
        const names = ((row.candidates ?? []) as Cand[])
          .map((c) => String(c?.name ?? "").trim()).filter(Boolean)
          .map((raw) => { const m = raw.match(ROOM_TAIL_RE); return m ? raw.slice(0, m.index ?? 0).trim() : raw; });
        if (names.length === 0) continue;
        sends++;
        let keep = 0;
        for (const n of names) {
          tot++;
          const norm = normalizePropertyName(n);
          const hit = past.some((p) => (at - p.at) / 86400_000 <= days && similarity(p.name, norm) >= DUP_MIN_SCORE);
          if (hit) drop++; else keep++;
        }
        if (keep === 0) emptied++;
        for (const n of names) past.push({ name: normalizePropertyName(n), at });
      }
    }
    const label = days === Infinity ? "期間なし" : `${days}日以内`;
    console.log(`   ${label.padEnd(10)} ${String(drop).padStart(6)}件（${pct(drop, tot).padStart(6)}）   ${String(emptied).padStart(5)}回 / ${sends}回（${pct(emptied, sends)}）`);
  }

  console.log(`\n=== ⑤ 決めること ===`);
  console.log(`   ・「マンションごと」にすると、前に送った建物に**新しい部屋**が出ても送られなくなる`);
  console.log(`   ・1回の送信で同じ建物の複数部屋を見せるのは残す（A）か消す（A も外す）か`);
  console.log(`   ・送る物が0件になる送信が ${sendsEmptied}回ある（その時は「すべて送付済み」の1通だけになる）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
