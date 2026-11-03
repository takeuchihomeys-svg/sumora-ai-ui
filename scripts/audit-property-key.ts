// scripts/audit-property-key.ts — 号室の正規化6つと1つの鍵（app/lib/property-key.ts）を過去の全件の号室に当てて比べる（読むだけ・LLM なし・費用 0）
//   作業員2の設計 §3: 違いが出た所を目で読み、誤った寄せが0になる線で決める → 古い6つを薄い包みに（PROPERTY_KEY_UNIFIED）
//   重い読み（4つの表の号室の全件）なので夜に流す: exam-conductor.ts --add --runner=cmd --label=audit-property-key --cmd="scripts/audit-property-key.ts"
//   出力: .claude/exam-cache/property-key/audit-<日付>.md（号室の文字だけ・お客様の情報は無い）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { unifiedRoomKey } from "../app/lib/property-key";
import { normalizeRoomNo as csRoom } from "../app/lib/customer-state";
import { roomKey as listingRoom } from "../app/lib/listing-text";
import { normalizeRoom as ownRoom } from "../app/lib/own-property-match";
import { normalizeRoomKey as pbRoom } from "../app/lib/property-brain";
import { normalizeRoomNo as spRoom } from "../app/lib/sent-property-record";
import { roomKeyOf as srRoom } from "../app/lib/sent-room-match";
import { examCacheRoot } from "./lib/llm-cassette";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const TABLES: Array<[string, string]> = [["sent_properties", "room_no"], ["sent_image_properties", "room_no"], ["property_pickups", "room_no"], ["estimate_records", "room_no"], ["deal_outcomes", "room_no"]];
const FNS: Record<string, (s: string) => string | null> = {
  "customer-state.normalizeRoomNo": (s) => csRoom(s), "listing-text.roomKey": (s) => listingRoom(s) || null, "own-property-match.normalizeRoom": (s) => ownRoom(s),
  "property-brain.normalizeRoomKey": (s) => pbRoom(s) || null, "sent-property-record.normalizeRoomNo": (s) => spRoom(s) || null, "sent-room-match.roomKeyOf": (s) => srRoom(s) || null,
};

async function distinctRooms(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const [tb, col] of TABLES) {
    for (let i = 0; ; i += 1000) {
      const { data, error } = await sb.from(tb).select(col).not(col, "is", null).order(col).range(i, i + 999);
      if (error) { console.warn(`  ${tb}: ${error.message}`); break; }
      for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) { const v = String(r[col] ?? "").trim(); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
      if ((data ?? []).length < 1000) break;
    }
  }
  return m;
}

(async () => {
  const rooms = await distinctRooms();
  const raws = [...rooms.keys()];
  const L: string[] = [`# 号室の鍵の読み比べ（${new Date().toISOString().slice(0, 10)}）`, "", `違う号室の文字 ${raws.length}種（${[...rooms.values()].reduce((a, b) => a + b, 0)}行）`, ""];
  const uni = new Map(raws.map((r) => [r, unifiedRoomKey(r)]));
  for (const [name, fn] of Object.entries(FNS)) {
    const old = new Map(raws.map((r) => [r, fn(r)]));
    // 古い関数が1つにまとめるが、1つの鍵では別＝古い関数の誤った寄せの候補（例 A0205 と B0205 → 205）
    const byOld = new Map<string, string[]>();
    for (const r of raws) { const k = old.get(r); if (k) byOld.set(k, [...(byOld.get(k) ?? []), r]); }
    const oldMerges = [...byOld].filter(([, rs]) => new Set(rs.map((r) => uni.get(r))).size > 1);
    // 1つの鍵がまとめるが、古い関数では別＝新しい寄せ（目で読んで正しいか決める）
    const byUni = new Map<string, string[]>();
    for (const r of raws) { const k = uni.get(r); if (k) byUni.set(k, [...(byUni.get(k) ?? []), r]); }
    const newMerges = [...byUni].filter(([, rs]) => new Set(rs.map((r) => old.get(r) ?? `∅${r}`)).size > 1);
    const oldNullUni = raws.filter((r) => !old.get(r) && uni.get(r));
    const uniNullOld = raws.filter((r) => old.get(r) && !uni.get(r));
    L.push(`## ${name}`, `- 古い関数が寄せて1つの鍵は分ける: ${oldMerges.length}組`, ...oldMerges.slice(0, 15).map(([k, rs]) => `  - ${k} ← ${rs.slice(0, 6).join("／")}`),
      `- 1つの鍵が寄せて古い関数は分ける: ${newMerges.length}組`, ...newMerges.slice(0, 15).map(([k, rs]) => `  - ${k} ← ${rs.slice(0, 6).map((r) => `${r}(${old.get(r) ?? "∅"})`).join("／")}`),
      `- 古い関数は読めない・1つの鍵は読む: ${oldNullUni.length}（例 ${oldNullUni.slice(0, 8).join("／")}）`,
      `- 古い関数は読む・1つの鍵は読めない: ${uniNullOld.length}（例 ${uniNullOld.slice(0, 8).map((r) => `${r}→${old.get(r)}`).join("／")}）`, "");
  }
  const out = join(examCacheRoot(), "property-key");
  mkdirSync(out, { recursive: true });
  const f = join(out, `audit-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(f, L.join("\n") + "\n");
  console.log(L.slice(0, 40).join("\n"));
  console.log(`\n保存: ${f}`);
})().catch((e) => { console.error(e); process.exit(1); });
