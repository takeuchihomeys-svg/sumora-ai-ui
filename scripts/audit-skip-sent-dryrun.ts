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
import { filterOutAlreadySent, type OutgoingProperty, type SentProperty, type SkipLevel } from "../app/lib/sent-property-filter";
import { normalizeRoomNo } from "../app/lib/sent-property-record";
import { isSameBuilding } from "../app/lib/sent-property-filter";

/** 既定は建物ごと（2026-09-21 竹内さんの選択）。部屋ごとに見る時は LEVEL=room */
const LEVEL: SkipLevel = process.env.LEVEL === "room" ? "room" : "building";

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
  const fuzzyEx: string[] = [];
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
      const r = filterOutAlreadySent(outgoing, known, LEVEL);
      totalIncoming += outgoing.length;
      totalDropped += r.dropped.length;
      totalUnmatchable += r.unmatchable;
      if (r.keep.length === 0 && outgoing.length > 0) sendsAllDropped++;
      for (const d of r.dropped) {
        reasonCount.set(d.reason, (reasonCount.get(d.reason) ?? 0) + 1);
        // 「名前が完全には同じでないのに外した」＝ 巻き込みの可能性がある分だけを別に集める
        if (d.reason === "building") {
          const exact = known.some((k) => k.property_name === d.property.propertyName);
          if (!exact) {
            const near = known.find((k) => isSameBuilding(d.property.propertyName, k.property_name));
            fuzzyEx.push(`     「${d.property.propertyName}」 ← 前に送った「${near?.property_name ?? "?"}」`);
          }
        }
        if (droppedEx.length < 25) {
          const hit = known.find((k) => k.property_name === d.property.propertyName);
          droppedEx.push(`     外す: 「${d.property.propertyName}」${normalizeRoomNo(d.property.roomNo) || "(号室なし)"}`
            + `  ← 前に送った「${hit?.property_name ?? "(名前の違う同じ建物)"}」（${d.reason}）`);
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

  console.log(`\n=== ③ 「名前が違うのに同じ建物と判定した」分を全部出す（巻き込みの実体）===`);
  if (fuzzyEx.length === 0) {
    console.log(`   **0件** — 外したのは全て**名前が完全に同じ**物だった（表記ゆれで寄せた物すら無い）`);
  } else {
    console.log(`   ${fuzzyEx.length}件（目で読む）`);
    for (const e of fuzzyEx.slice(0, 40)) console.log(e);
  }

  console.log(`\n=== ④ 判定（単位: ${LEVEL}）===`);
  if (LEVEL === "building") {
    console.log(`   ・一度送ったマンションは、別の部屋でも外す（竹内さん 2026-09-21 の選択）`);
    console.log(`   ・「〇〇Ⅱ」「〇〇Ⅲ」は棟が違うので別の建物（buildingWing で分けている）`);
    console.log(`   ・名前の線は 0.97（実測で巻き込み0になる 0.96 より内側）`);
    console.log(`   ・1回の送信の中の同じマンションは全部残す`);
  } else {
    console.log(`   ・同じ部屋だけ外す。号室が取れない物件（実測 99.9%）は1件も外さない`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
