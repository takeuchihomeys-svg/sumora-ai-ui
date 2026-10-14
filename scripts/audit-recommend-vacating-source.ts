// scripts/audit-recommend-vacating-source.ts — AIX【物件オススメ】の2通目で「退去予定」を書いた番に、その材料がどこにあったか（読むだけ・LLM なし・$0）
//
// 2026-10-15 竹内さん（小さな直し）: 竹内さんは物件オススメの2通目で「〇月末退去予定で…募集に出ました」と書く事が多いが、
//   ✨2通目の材料（property_pickups の行＝resolveRecommendViewable の material）にその材料が無い番が多い（aix-after-reply の報告）。
//   番 = aix_usage_logs の property_recommendation を送った（sent_at）直後 15分以内・次のお客様の発言より前にスタッフが打った文（2通目）。
//   出どころの候補（その番より前に DB にあった物だけ）:
//     pickup_route  … 今の ✨ の引き方（property_pickups を会話＋号室の字の完全一致で引いて pickupForFirstMessage）→ readMaterialViewable
//     pickup_loose  … 同じ会話の property_pickups 全部から号室の形をそろえて引く（00201・201号室 も当てる）
//     sip           … 送った資料の画像の読み（sent_image_properties.facts.status=move_out_planned/occupied・vacancy_date）。会話＋号室＋名前の頭
//     image_lines   … pickups の image_lines の「退去予定:」行／pdf_text の「退去予定・居住中」
//     first_text    … 1通目の本文（スタッフが入れた退去予定日）
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-vacating-source.ts [--days=180] [--show=8]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { headOfFirstMessage, pickupForFirstMessage, type PickupLookupRow } from "../app/lib/recommend-cta";
import { readMaterialViewable } from "../app/lib/recommend-viewable";
import { canonicalRoomNo } from "../app/lib/room-no";
import { sipVacating, pickupForHeadLoose, sentImageViewable } from "../app/lib/recommend-vacating-source";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const SHOW = Number(arg("show", "8"));
const SINCE = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const MIN = 60_000;
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 300_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
type Press = { id: string; conversation_id: string; created_at: string; sent_at: string | null };
type Pk = PickupLookupRow & { conversation_id: string; image_lines?: unknown; pdf_text?: string | null; terms?: unknown };
type Sip = { conversation_id: string; property_name: string | null; room_no: string | null; created_at: string; facts: Record<string, unknown> | null; facts_read_at?: string | null };
const VAC_RE = /退去(?:予定|後|の為|のため|日)|ご退去|居住中|入居中/;

(async () => {
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, created_at, sent_at").eq("aix_type", "property_recommendation").not("sent_at", "is", null).gte("created_at", SINCE).order("created_at").range(f, t));
  const convs = [...new Set(presses.map((p) => p.conversation_id).filter((c) => c && !isTestConversation(c)))];
  const msgs: Msg[] = [], pks: Pk[] = [], sips: Sip[] = [];
  for (let i = 0; i < convs.length; i += 60) {
    const cs = convs.slice(i, i + 60);
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer").in("conversation_id", cs).gte("created_at", SINCE).order("created_at").order("id").range(f, t)));
    pks.push(...await readAll<Pk>((f, t) => sb.from("property_pickups").select("conversation_id, property_name, room_no, verdict, reason_codes, created_at, terms, location, equipment, image_lines, pdf_text").in("conversation_id", cs).order("id").range(f, t)));
    sips.push(...await readAll<Sip>((f, t) => sb.from("sent_image_properties").select("conversation_id, property_name, room_no, created_at, facts, facts_read_at").in("conversation_id", cs).order("created_at").range(f, t)));
  }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pkBy = by(pks), sBy = by(sips), prBy = by(presses);
  const C: Record<string, number> = {};
  const inc = (k: string) => { C[k] = (C[k] ?? 0) + 1; };
  const examples: string[] = [];
  for (const p of presses) {
    if (!p.conversation_id || isTestConversation(p.conversation_id)) continue;
    const at = ms(p.sent_at);
    const mm = mBy.get(p.conversation_id) ?? [];
    const first = mm.filter((m) => m.sender !== "customer" && Math.abs(ms(m.created_at) - at) < 3 * MIN && /🌟/.test(m.text ?? "")).pop();
    if (!first) { inc("1通目なし"); continue; }
    const nextCust = mm.find((m) => m.sender === "customer" && ms(m.created_at) > at)?.created_at;
    const nextPress = (prBy.get(p.conversation_id) ?? []).find((q) => q.id !== p.id && ms(q.sent_at) > at)?.sent_at;
    const hi = Math.min(at + 15 * MIN, nextCust ? ms(nextCust) : Infinity, nextPress ? ms(nextPress) : Infinity);
    const secondMsgs = mm.filter((m) => m.sender !== "customer" && m.id !== first.id && ms(m.created_at) > at && ms(m.created_at) < hi && (m.text ?? "").trim() && !/🌟/.test(m.text ?? ""));
    const second = secondMsgs.map((m) => m.text ?? "").join("\n");
    const secondAt = secondMsgs.length ? ms(secondMsgs[0].created_at) : at;
    inc("番");
    if (!second) { inc("2通目なし"); continue; }
    inc("2通目あり");
    const head = headOfFirstMessage(first.text);
    const wrote = VAC_RE.test(second);
    const firstVac = VAC_RE.test(first.text ?? "");
    if (!wrote) {
      // 逆向き: 竹内さんが退去予定を書かなかった番に、送った資料の読みが退去予定と言っていた数（材料が誤って退去予定にする恐れ）
      const svN = sentImageViewable(sipVacating((sBy.get(p.conversation_id) ?? []).filter((s) => ms(s.created_at) <= secondAt && (!s.facts_read_at || ms(s.facts_read_at) <= secondAt)), head), secondAt);
      inc(svN?.notViewable ? "◇退去予定を書かなかった番で読みが退去予定" : "◇退去予定を書かなかった番（読みは退去予定でない）");
      if (svN?.notViewable && firstVac) inc("◇  うち1通目に退去の字");
      if (svN?.notViewable && !firstVac && examples.length < SHOW * 6) examples.push(`逆 ${p.sent_at?.slice(0, 10)} ${head?.name} ${head?.room} 材料「${svN.line}」 | 2通目: ${second.replace(/\n/g, " ").slice(0, 110)}`);
      continue;
    }
    inc("2通目に退去予定");
    if (firstVac) inc("  1通目にも退去の字");
    if (!head) { inc("  見出しが読めない"); continue; }
    const rows = (pkBy.get(p.conversation_id) ?? []).filter((r) => ms(r.created_at) <= at + MIN);
    // 今の ✨ の引き方（号室の字の完全一致・作った時刻を問わない）
    const routeRow = pickupForFirstMessage((pkBy.get(p.conversation_id) ?? []).filter((r) => r.room_no === head.room), head);
    const looseRow = pickupForHeadLoose(rows, head);
    const mvRoute = readMaterialViewable(routeRow as never, at);
    const mvLoose = readMaterialViewable(looseRow as never, at);
    const sip = sipVacating((sBy.get(p.conversation_id) ?? []).filter((s) => ms(s.created_at) <= secondAt && (!s.facts_read_at || ms(s.facts_read_at) <= secondAt)), head);
    const il = looseRow && Array.isArray(looseRow.image_lines) ? (looseRow.image_lines as unknown[]).map(String).filter((l) => /^(?:退去予定|現況)\s*[:：]/.test(l)) : [];
    const pdfVac = looseRow?.pdf_text ? /退去予定|居住中|入居中/.test(looseRow.pdf_text) : false;
    inc(routeRow ? "  ✨の引き: 行あり" : "  ✨の引き: 行なし");
    if (mvRoute.notViewable === true) inc("    ✨の引き: 退去予定と読める");
    inc(looseRow ? "  号室をそろえた引き: 行あり" : "  号室をそろえた引き: 行なし");
    if (mvLoose.notViewable === true) inc("    号室をそろえた引き: 退去予定と読める");
    if (sip) inc(`  送った資料の読み: ${sip.notViewable ? "退去予定" : "空室"}${sip.vacancyDate ? "（日付あり）" : ""}`);
    else inc("  送った資料の読み: なし");
    if (il.length) inc("  image_lines に現況/退去予定の行");
    if (pdfVac) inc("  pdf_text に退去予定/居住中");
    const any = mvRoute.notViewable === true || mvLoose.notViewable === true || sip?.notViewable === true || firstVac;
    const routeOnly = mvRoute.notViewable === true || firstVac;
    inc(routeOnly ? "★今の✨に届く" : any ? "★届くはずが届かない（つなげば届く）" : "★どこにも無い");
    // 直した後（2026-10-15 aix-template-generate: 本文→売上サポの行→送った資料の読み→ブレイン）
    const sv = sentImageViewable(sip, secondAt);
    inc(routeOnly || sv?.notViewable ? "◆直した後の✨に届く" : "◆直した後も届かない");
    if (!routeOnly && sv?.notViewable && examples.length < SHOW * 3) examples.push(`後 ${p.sent_at?.slice(0, 10)} ${head.name} ${head.room} → 材料「${sv.line}」 | 竹内: ${second.replace(/\n/g, " ").match(/[^。！]*退去[^。！]*/)?.[0]?.slice(0, 60) ?? ""}`);
    if (!any) {
      // どこにも無い番の内訳: 送った資料の読みがその部屋にあるか（時刻を問わず）・現況が空か・前の会話に退去の話があるか
      const hn = head.name.normalize("NFKC").replace(/\s+/g, "").slice(0, 4);
      const all = (sBy.get(p.conversation_id) ?? []).filter((s) => String(s.property_name ?? "").normalize("NFKC").replace(/\s+/g, "").includes(hn) && canonicalRoomNo(String(s.room_no ?? "")) === canonicalRoomNo(head.room));
      if (!all.length) inc("    無い内訳: 送った資料の読みの行なし");
      else if (all.every((s) => !s.facts?.status)) inc("    無い内訳: 行はあるが現況が読めていない");
      else if (all.some((s) => ["move_out_planned", "occupied"].includes(String(s.facts?.status)))) inc("    無い内訳: 行は後から書かれた（退去予定）");
      else inc(`    無い内訳: 現況=${[...new Set(all.map((s) => s.facts?.status))].join("/")}`);
      const before = mm.filter((m) => ms(m.created_at) < at - MIN && /退去/.test(m.text ?? "") && (m.text ?? "").normalize("NFKC").replace(/\s+/g, "").includes(hn));
      if (before.length) inc(`    無い内訳: 前の会話に建物名＋退去（${before[before.length - 1].sender}）`);
      const recentStaff = mm.filter((m) => m.sender !== "customer" && ms(m.created_at) < at - MIN && at - ms(m.created_at) < 3 * 86400_000 && /退去/.test(m.text ?? ""));
      if (recentStaff.length) inc("    無い内訳: 3日以内のスタッフの文に退去の字");
      const allPk = (pkBy.get(p.conversation_id) ?? []).filter((r) => canonicalRoomNo(String(r.room_no ?? "")) === canonicalRoomNo(head.room));
      if (allPk.length) inc("    無い内訳: pickups の行は後から（または時刻外）");
    }
    if (!routeOnly && examples.length < SHOW * 3) examples.push(`${any ? "つなげば" : "無い"} ${p.sent_at?.slice(0, 10)} ${head.name} ${head.room} | route=${routeRow ? `${routeRow.room_no}` : "-"} loose=${looseRow ? `${looseRow.room_no}/${mvLoose.notViewable}` : "-"} sip=${sip ? `${sip.status}/${sip.vacancyDate ?? "-"}` : "-"} il=${il.slice(0, 1).join("")} | 2通目: ${second.replace(/\n/g, " ").match(/[^。！]*退去[^。！]*/)?.[0]?.slice(0, 50) ?? ""}`);
  }
  console.log(`直近${DAYS}日 物件オススメ（送った）${presses.length}`);
  for (const [k, v] of Object.entries(C)) console.log(`${k.padEnd(40)} ${v}`);
  console.log("\n例:"); for (const e of examples.slice(0, SHOW * 3)) console.log(e);
  void canonicalRoomNo;
})().catch((e) => { console.error(e); process.exit(1); });
