// scripts/audit-sent-exclusion.ts（読むだけ・書かない）
// 2026-09-30 v2.5.42 竹内「画面監視して、一度送った物件はお客さんごとに再度送らないようにする形で」:
//   送る側（売上サポの既定のチェック・✨質の高い10件・★物件出し★の上位）で「送付済みの部屋」を外す線（app/lib/sent-room-match.ts＝拡張の sent-skip と同じ完全一致）を
//   本番の売上サポの行（property_pickups）× そのお客様に届けた送付（sent_properties・delivery=customer・その行より前）に当てる。
//   ①外す件数（未送信の行のうち送付済みの部屋と完全一致）②誤一致の確かめ（外した行と送付の行の 号室・家賃・間取りが同じか・目で読む例）
//   ③あいまい一致（売上サポのバッジ isSameProperty）とのちがい（バッジは出るが外さない行＝同じ建物の別の部屋など）
//   ④拡張の sent-skip.js と TS の写しが同じ答えか（全部の組で）
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-exclusion.ts [--since=2026-09-15] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
import { buildSentRoomIndex, isSentRoom, sentRoomKey, splitRoomFromName, normRoomName, roomKeyOf } from "../app/lib/sent-room-match";
import { isSameProperty } from "../app/lib/sent-property-record";
import { isCustomerRow } from "../app/lib/sent-delivery";
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SK = require_("../chrome-extension/sent-skip.js") as { buildIndex(rooms: Array<{ name: string; room: string }>): unknown; isSentRoom(idx: unknown, name: string, room: string | null): boolean };

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", "2026-09-15");
const show = Number(arg("show", "20"));

type Pick = { id: number; created_at: string; property_customer_id: string | null; property_name: string | null; room_no: string | null; status: string; verdict: string | null; reason_codes: string[] | null; pdf_text: string | null };
type Sent = { property_customer_id: string | null; property_name: string | null; room_no: string | null; sent_at: string; delivery: string | null; source: string | null; channel: string | null };

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
const rentOf = (t: string | null) => { const m = String(t ?? "").match(/賃料[^\d]{0,6}([\d,.]+)\s*(万)?円?/); if (!m) return null; const n = Number(m[1].replace(/,/g, "")); return m[2] ? Math.round(n * 10000) : n; };

(async () => {
  const picks = await all<Pick>((o) => sb.from("property_pickups").select("id, created_at, property_customer_id, property_name, room_no, status, verdict, reason_codes, pdf_text").gte("created_at", since).order("created_at").order("id").range(o, o + 999));
  const ids = [...new Set(picks.map((p) => p.property_customer_id).filter(Boolean))] as string[];
  const sent: Sent[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    sent.push(...await all<Sent>((o) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, sent_at, delivery, source, channel").in("property_customer_id", ids.slice(i, i + 50)).order("sent_at").order("id").range(o, o + 999)));
  }
  const sentBy = new Map<string, Sent[]>();
  for (const s of sent) { if (!s.property_customer_id) continue; const a = sentBy.get(s.property_customer_id) ?? []; a.push(s); sentBy.set(s.property_customer_id, a); }

  let open = 0, withRoom = 0, excluded = 0, alreadyByJudge = 0, newlyExcluded = 0, fuzzyOnly = 0, extDiff = 0, sameBuildingOther = 0;
  // 参考: ★物件出し★への共有（delivery=shared）も含めた時（拡張の sent-skip・見張りの SENT_SELECTED と同じ出所）
  let sharedHit = 0, sharedJudge = 0; const sharedEx: string[] = [];
  let pairs = 0, otherRoomRows = 0, otherRoomWrong = 0; const otherEx: string[] = [];
  const examples: string[] = [], fuzzyEx: string[] = [], diffEx: string[] = [];
  for (const p of picks) {
    if (!p.property_customer_id || p.status !== "pending") continue;
    open++;
    const before = (sentBy.get(p.property_customer_id) ?? []).filter((s) => s.sent_at < p.created_at && isCustomerRow({ delivery: s.delivery, source: s.source } as never));
    const idx = buildSentRoomIndex(before);
    const room = (p.room_no ?? "").trim() || splitRoomFromName(p.property_name ?? "").room;
    const name = (p.room_no ?? "").trim() ? p.property_name : (splitRoomFromName(p.property_name ?? "").building || p.property_name);
    if (room) withRoom++;
    const hit = isSentRoom(idx, name, room);
    const allBefore = (sentBy.get(p.property_customer_id) ?? []).filter((s) => s.sent_at < p.created_at);
    if (isSentRoom(buildSentRoomIndex(allBefore), name, room)) {
      sharedHit++;
      const jh = (p.reason_codes ?? []).some((c) => /^ALREADY_SENT/.test(c)) || p.verdict === "drop" || p.verdict === "hold";
      if (jh) sharedJudge++;
      const m = allBefore.find((s) => sentRoomKey(s.property_name, s.room_no) === sentRoomKey(name, room));
      if (sharedEx.length < show) sharedEx.push(`#${p.id} ${String(p.property_name).slice(0, 28)} ${room}（${p.created_at.slice(5, 16)}）← ${m?.delivery} ${m?.sent_at.slice(5, 16)} ${String(m?.property_name).slice(0, 28)} ${m?.room_no}・判定=${p.verdict}${jh ? "" : "・札なし"}`);
    }
    // 拡張の写しと同じ答えか（④）: お客様に届けた物だけ・共有も含めた物の両方で比べる
    for (const pool of [before, allBefore]) {
      const extIdx = SK.buildIndex(pool.filter((s) => s.property_name && s.room_no).map((s) => ({ name: String(s.property_name), room: String(s.room_no) })));
      const extHit = SK.isSentRoom(extIdx, String(name ?? ""), room);
      const tsHit = isSentRoom(buildSentRoomIndex(pool), name, room);
      pairs++;
      if (extHit !== tsHit) { extDiff++; if (diffEx.length < 5) diffEx.push(`#${p.id} ${name} ${room} ts=${tsHit} ext=${extHit}`); }
    }
    // 同じ建物の別の部屋（名前は完全一致・号室が違う）は外さない（誤一致 0 の確かめ・共有も含めた送付で）
    const nk = normRoomName(name);
    const other = room ? allBefore.find((s) => normRoomName(s.property_name) === nk && s.room_no && roomKeyOf(s.room_no) !== roomKeyOf(room)) : undefined;
    if (other && !allBefore.some((s) => sentRoomKey(s.property_name, s.room_no) === sentRoomKey(name, room))) {
      otherRoomRows++;
      if (isSentRoom(buildSentRoomIndex(allBefore), name, room)) otherRoomWrong++;
      if (otherEx.length < 8) otherEx.push(`#${p.id} ${String(name).slice(0, 28)} ${room}（送付は ${other.room_no}）→ 外さない`);
    }
    const judgeHit = (p.reason_codes ?? []).some((c) => c === "ALREADY_SENT" || c === "ALREADY_SENT_SAME_ROOM");
    if (hit) {
      excluded++;
      if (judgeHit || p.verdict === "drop" || p.verdict === "hold") alreadyByJudge++; else newlyExcluded++;
      const m = before.find((s) => sentRoomKey(s.property_name, s.room_no) === sentRoomKey(name, room));
      if (examples.length < show) examples.push(`#${p.id} ${String(p.property_name).slice(0, 30)} ${room} ← 送付 ${m?.sent_at.slice(5, 16)} ${String(m?.property_name).slice(0, 30)} ${m?.room_no}（${m?.channel ?? m?.source ?? "?"}）判定=${p.verdict}${judgeHit ? "・札あり" : ""}・家賃=${rentOf(p.pdf_text) ?? "?"}`);
    } else {
      // バッジ（あいまい一致）は出るが外さない行（③）
      const fuzzy = before.find((s) => isSameProperty({ property_name: p.property_name ?? "", room_no: room }, { property_name: s.property_name ?? "", room_no: s.room_no }));
      if (fuzzy) {
        fuzzyOnly++;
        const sameBuilding = room && fuzzy.room_no && String(fuzzy.room_no).replace(/^0+/, "") !== String(room).replace(/^0+/, "");
        if (sameBuilding) sameBuildingOther++;
        if (fuzzyEx.length < show) fuzzyEx.push(`#${p.id} ${String(p.property_name).slice(0, 30)} ${room ?? "(号室なし)"} ≈ 送付 ${String(fuzzy.property_name).slice(0, 30)} ${fuzzy.room_no ?? "(号室なし)"}${sameBuilding ? "（同じ建物の別の部屋）" : ""}`);
      }
    }
  }
  console.log(`=== 送る側の「送付済みの部屋」を外す線（${since}〜・売上サポの未送信の行 ${open}件・お客様 ${ids.length}人・送付 ${sent.length}行）===`);
  console.log(`号室の読める行 ${withRoom}件 → 外す（完全一致） ${excluded}件（判定が既に保留/外す候補 ${alreadyByJudge}・新たに外れる ${newlyExcluded}）`);
  console.log(`参考: ★物件出し★への共有も含めると ${sharedHit}件（判定が既に保留/外す候補 ${sharedJudge}）`); sharedEx.forEach((x) => console.log("    " + x));
  console.log(`拡張 sent-skip.js と TS の写しの答えの違い: ${extDiff}件（${pairs}組で比べた）`);
  console.log(`同じ建物の別の部屋（名前は完全一致・号室が違う）: ${otherRoomRows}行 → 外した（誤一致） ${otherRoomWrong}件`); otherEx.forEach((x) => console.log("    " + x)); diffEx.forEach((x) => console.log("  " + x));
  console.log(`\n■ 外す行（目で読む・${examples.length}件）`); examples.forEach((x) => console.log("  " + x));
  console.log(`\n■ バッジ（あいまい一致）は出るが外さない行 ${fuzzyOnly}件（うち同じ建物の別の部屋 ${sameBuildingOther}件）`); fuzzyEx.forEach((x) => console.log("  " + x));
})().catch((e) => { console.error(e); process.exit(1); });
