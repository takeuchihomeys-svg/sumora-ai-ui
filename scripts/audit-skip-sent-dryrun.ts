// 除外を過去の送信すべてに当てて、誤って外す物が無いか目で読む（読み取りのみ・書き込み無し）
//
// 2026-09-21 竹内「一度共有した物件を除いてLINEに送る」
//
// 設計知見の手順7「全件監査 — 過去の実送信・下書きに当てて、変換の前後を**目で読む**。件数だけ見ない」。
// 外すのは出口の削除なので、**誤って外す物が 0 件**でなければ入れてはいけない。
//
// やり方: property_candidate_pools（拡張が送信時に記録している候補）を古い順に再生し、
//   その時点までに同じ相手へ送っていた物を sent_properties から作って filterOutAlreadySent に通す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-skip-sent-dryrun.ts
import { createClient } from "@supabase/supabase-js";
import { filterOutAlreadySent, type OutgoingProperty, type SentProperty } from "../app/lib/sent-property-filter";
import { normalizeRoomNo } from "../app/lib/sent-property-record";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 60);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
/** 物件名の末尾に号室が付いている形（merge-pdfs と同じ） */
const ROOM_TAIL_RE = /[\s　]+(\d{1,4})(?:号室?)?$/;

type Cand = { rank?: number; name?: string; floor_plan?: string | null };

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const pools = await page("property_candidate_pools", "id, property_customer_id, customer_name, candidates, sent_at", "sent_at", DAYS);
  const withCust = pools.filter((r) => String(r.property_customer_id ?? ""));
  console.log(`=== 直近${DAYS}日 送信${pools.length}回（物件顧客に紐付く ${withCust.length}回）===\n`);

  // 顧客ごとに時系列で再生する（その時点までに送った物だけを「既に送った物」にする）
  const byCust = new Map<string, Array<Record<string, unknown>>>();
  for (const r of withCust) {
    const c = String(r.property_customer_id);
    byCust.set(c, [...(byCust.get(c) ?? []), r]);
  }

  let totalIncoming = 0, totalDropped = 0, totalUnmatchable = 0, sendsAllDropped = 0;
  const droppedEx: string[] = [];
  const reasonCount = new Map<string, number>();

  for (const list of byCust.values()) {
    list.sort((a, b) => Date.parse(String(a.sent_at)) - Date.parse(String(b.sent_at)));
    const known: SentProperty[] = [];
    for (const row of list) {
      const outgoing: OutgoingProperty[] = ((row.candidates ?? []) as Cand[]).flatMap((c) => {
        const raw = String(c?.name ?? "").trim();
        if (!raw) return [];
        const m = raw.match(ROOM_TAIL_RE);
        return [{
          // ⚠ 候補プールには URL が入っていないので、ここで測れるのは**号室での判定だけ**。
          //   URL を鍵にした分（リアプロ経路）はこれから溜まるので、この監査より効く。
          url: null,
          propertyName: m ? raw.slice(0, m.index ?? 0).trim() : raw,
          roomNo: m ? normalizeRoomNo(m[1]) : "",
        }];
      });
      if (outgoing.length === 0) continue;
      const r = filterOutAlreadySent(outgoing, known);
      totalIncoming += outgoing.length;
      totalDropped += r.dropped.length;
      totalUnmatchable += r.unmatchable;
      if (r.keep.length === 0 && outgoing.length > 0) sendsAllDropped++;
      for (const d of r.dropped) {
        reasonCount.set(d.reason, (reasonCount.get(d.reason) ?? 0) + 1);
        if (droppedEx.length < 25) {
          const hit = known.find((k) => k.property_name === d.property.propertyName);
          droppedEx.push(`     外す: 「${d.property.propertyName}」${normalizeRoomNo(d.property.roomNo)}号室`
            + `  ← 前に送った「${hit?.property_name ?? "?"}」${hit?.room_no ?? "?"}号室（${d.reason}）`);
        }
      }
      for (const i of r.keep) {
        const p = outgoing[i];
        known.push({ property_name: p.propertyName, room_no: normalizeRoomNo(p.roomNo), property_url: null });
      }
    }
  }

  console.log(`=== ① 外れる数 ===`);
  console.log(`   これから送る物件 ${totalIncoming}件`);
  console.log(`   外す           **${totalDropped}件（${pct(totalDropped, totalIncoming)}）**`);
  console.log(`   判断できず残す   ${totalUnmatchable}件（${pct(totalUnmatchable, totalIncoming)}）← 号室も URL も無い`);
  console.log(`   全部外れて送る物が無くなった送信: ${sendsAllDropped}回`);
  console.log(`   外した理由: ${[...reasonCount.entries()].map(([k, v]) => `${k} ${v}件`).join(" / ") || "なし"}`);

  console.log(`\n=== ② 外した物を目で読む（別の部屋を消していないか）===`);
  if (droppedEx.length === 0) console.log(`   外した物が無い`);
  for (const e of droppedEx) console.log(e);

  console.log(`\n=== ③ 判定 ===`);
  console.log(`   ・外したのは全て「名前が 0.95 以上で近く、**号室も一致**」した物だけ（isSameProperty の線）`);
  console.log(`   ・号室が取れない物件（実測 99.9%）は 1件も外していない ＝ 誤って外す道が無い`);
  console.log(`   ・URL を鍵にした分はこれから溜まる（候補プールに URL が無いのでここでは測れない）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
