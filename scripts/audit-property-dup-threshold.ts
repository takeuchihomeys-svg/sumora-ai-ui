// 「同じ物件」の線をどこに引くか（読み取りのみ）
//
// 2026-09-20 竹内「一度送った物件が間違えって入ってしまうこと防げる（アナウンスがでる）」
//   アナウンスは**別の物件を重複と言わない**ことが最優先（誤った警告はスタッフの信頼を失う）。
//   設計知見「誤削除0になる線を探す — 段階を並べて0になる所を採る」をそのまま使う。
//
// 材料は実データ: 同じ会話に入っている物件名のペアを全部作り、似ている度の分布を見る。
//   ・号室が同じペア（重複の候補）
//   ・号室が違うペア（**別物件**＝重複と言ってはいけない）
// 「号室が違う＝別物件」を誤って重複と言わない線を探す。
import { createClient } from "@supabase/supabase-js";
import { normalizePropertyName, similarity } from "../app/lib/property-name-match";
import { normalizeRoomNo } from "../app/lib/sent-property-record";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from("sent_properties").select("conversation_id, property_name, room_no, sent_at")
      .not("conversation_id", "is", null).order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  const byConv = new Map<string, Array<{ name: string; room: string }>>();
  for (const r of rows) {
    const c = String(r.conversation_id ?? "");
    if (!c) continue;
    if (!byConv.has(c)) byConv.set(c, []);
    byConv.get(c)!.push({ name: String(r.property_name ?? ""), room: normalizeRoomNo(String(r.room_no ?? "")) });
  }

  // 同じ会話のペアを作る
  const sameRoom: Array<{ a: string; b: string; sim: number; room: string }> = [];
  const diffRoom: Array<{ a: string; b: string; sim: number }> = [];
  for (const [, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const an = normalizePropertyName(a.name), bn = normalizePropertyName(b.name);
        if (!an || !bn) continue;
        const sim = similarity(an, bn);
        if (a.room && b.room && a.room === b.room) sameRoom.push({ a: a.name, b: b.name, sim, room: a.room });
        else if (a.room && b.room) diffRoom.push({ a: a.name, b: b.name, sim });
      }
    }
  }
  console.log(`=== 同じ会話の物件名ペア（会話 ${byConv.size}件）===`);
  console.log(`   号室が同じペア: ${sameRoom.length}件 ／ 号室が違うペア: ${diffRoom.length}件\n`);

  // ── ① 号室が同じなのに名前が違うペア（= 別物件で号室が偶然同じ。重複と言ってはいけない）──
  console.log(`── 号室が同じで、名前が完全一致ではないペア（似ている度の低い順・20件）`);
  const notExact = sameRoom.filter((x) => x.sim < 1).sort((a, b) => a.sim - b.sim);
  console.log(`   ${notExact.length}件\n`);
  for (const x of notExact.slice(0, 20)) {
    console.log(`     ${x.sim.toFixed(3)}  ${x.room}号室  「${x.a}」 ↔ 「${x.b}」`);
  }

  // ── ② 線を段階で並べる ──
  console.log(`\n── 「号室一致＋似ている度 ≥ T」で重複と言う時、名前が違う物を何件巻き込むか`);
  for (const T of [0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00]) {
    const caught = notExact.filter((x) => x.sim >= T).length;
    const exact = sameRoom.filter((x) => x.sim >= 1).length;
    console.log(`     T=${T.toFixed(2)}  完全一致 ${exact}件 ＋ 名前が違うのに重複と言う ${caught}件`);
  }
  console.log(`   ※ 「名前が違うのに重複と言う」が0になる線を採る（誤った警告を出さない）`);

  // ── ③ 号室が違うペアの似ている度（同じ建物の別部屋＝重複ではない）──
  const hiDiff = diffRoom.filter((x) => x.sim >= 0.9);
  console.log(`\n── 号室が違うのに名前がほぼ同じペア（同じ建物の別部屋）: ${hiDiff.length}件 / ${diffRoom.length}件`);
  for (const x of hiDiff.slice(0, 6)) console.log(`     ${x.sim.toFixed(3)}  「${x.a}」 ↔ 「${x.b}」`);
  console.log(`   ※ ここが多い＝**号室を見ずに名前だけで重複と言うと同じ建物の別部屋を潰す**`);

  // ── ④ 参考: テストで使っている2組の実際の値 ──
  const pair = (a: string, b: string) => similarity(normalizePropertyName(a), normalizePropertyName(b)).toFixed(3);
  console.log(`\n── テストの2組の実際の似ている度`);
  console.log(`     グランパシフィック生野東 ↔ グランバシフィック生野東（パ/バ の誤読・同じ物件）: ${pair("グランパシフィック生野東", "グランバシフィック生野東")}`);
  console.log(`     グランパシフィック生野東 ↔ グランパシフィック梅南（別物件）                  : ${pair("グランパシフィック生野東", "グランパシフィック梅南")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
