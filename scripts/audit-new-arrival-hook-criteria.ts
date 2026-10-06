// scripts/audit-new-arrival-hook-criteria.ts
// 「新着1件に刺さった」の基準（app/lib/new-arrival-hook.ts newArrivalHookOf）を実物で確かめる（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内さん「刺さった基準ちゃんと調査」。段:
//   1. 新着1件の🌟（isNewArrivalSnapshot）ごとに、送った後の流れ（お客様・スタッフの LINE 72時間・AIX 14日・見積書の記録 14日・内覧の記録 30日）を並べて書き出す
//      → --out=<ファイル> に全件（目で読む用・個人情報を含むので手元だけ・リポジトリに置かない）
//   2. 基準ごと（返事が前向き／引用／見積書の AIX／内覧の AIX／申込の AIX）の件数と、別の物差し（見積書の記録の物件名・内覧の記録の物件名）との突き合わせ
//   3. 漏れの候補: 刺さっていない回で「お客様の最初の返事」を種類別に（画像・質問・お礼だけ・確認します・断り・別件）数える
//
// 実行: npx tsx --env-file=.env.local scripts/audit-new-arrival-hook-criteria.ts [--days=400] [--out=<scratchpad>/hook-timeline.txt] [--v=1|2]
//   --v=2 で新しい基準（newArrivalHookV2Of）も並べて、旧だけ／新だけ刺さったの回を書き出す
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { newArrivalHookOf, newArrivalHookV2Of, classifyHookReply } from "../app/lib/new-arrival-hook";
import { isNewArrivalSnapshot } from "../app/lib/hooked-arrival-learning";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const one = (s: unknown, n = 90) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const hrs = (a: number, b: number) => `${((a - b) / H).toFixed(1)}h`;

(async () => {
  const until = Date.now();
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, candidate_count")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).order("id").range(a, b) as never, 300))
    .filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && isNewArrivalSnapshot(s));
  const convs = [...new Set(snaps.map((s) => String(s.conversation_id)))];
  const msgs: Row[] = [], aix: Row[] = [], ests: Row[] = [], views: Row[] = [], imgs: Row[] = [], sends: Row[] = [];
  for (const c of chunks(convs, 50)) {
    msgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, sender, text, image_url, created_at, referenced_property_id, line_message_id, quoted_message_id, is_aix_generated").in("conversation_id", c).gte("created_at", new Date(until - (DAYS + 2) * D).toISOString()).order("id").range(a, b) as never));
    aix.push(...await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, generated_text, created_at, sent_at").in("conversation_id", c).gte("created_at", new Date(until - (DAYS + 2) * D).toISOString()).order("id").range(a, b) as never));
    ests.push(...await all((a, b) => sb.from("estimate_records").select("conversation_id, property_name, room_no, created_at, estimated_at").in("conversation_id", c).order("id").range(a, b) as never));
    imgs.push(...await all((a, b) => sb.from("sent_image_properties").select("image_url, conversation_id, property_name").in("conversation_id", c).not("property_name", "is", null).order("image_url").range(a, b) as never));
    sends.push(...await all((a, b) => sb.from("sent_properties").select("conversation_id, property_name, sent_at").in("conversation_id", c).order("id").range(a, b) as never));
    views.push(...await all((a, b) => sb.from("viewing_history").select("conversation_id, property_name, scheduled_date, status, created_at").in("conversation_id", c).order("id").range(a, b) as never));
  }
  const g = (xs: Row[]) => { const m = new Map<string, Row[]>(); for (const x of xs) { const v = String(x.conversation_id); if (!m.has(v)) m.set(v, []); m.get(v)!.push(x); } return m; };
  const mOf = g(msgs), aOf = g(aix), eOf = g(ests), vOf = g(views), iOf = g(imgs), sOf = g(sends);
  const imgName = new Map(imgs.map((r) => [String(r.image_url), String(r.property_name)]));
  const useV2 = String(args.v ?? "1") === "2";

  const lines: string[] = [];
  const cnt: Record<string, number> = {};
  const inc = (k: string) => { cnt[k] = (cnt[k] ?? 0) + 1; };
  for (const s of snaps.sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))) {
    const cv = String(s.conversation_id), t = Date.parse(s.sent_at), name = String(s.star_name);
    const ms = mOf.get(cv) ?? [], ax = aOf.get(cv) ?? [];
    const h1 = newArrivalHookOf({ starName: name, sentAt: s.sent_at, messages: ms as never, aix: ax as never });
    const h2 = useV2 ? newArrivalHookV2Of({ starName: name, starRoom: s.star_room ?? null, sentAt: s.sent_at, messages: ms as never, aix: ax as never, estimates: (eOf.get(cv) ?? []) as never, viewings: (vOf.get(cv) ?? []) as never, imageNameOf: (u) => imgName.get(u) ?? null, otherNames: (iOf.get(cv) ?? []).filter((r) => Math.abs(Date.parse(String(r.created_at ?? s.sent_at)) - t) < 7 * D).map((r) => String(r.property_name)).concat((sOf.get(cv) ?? []).filter((r) => Math.abs(Date.parse(String(r.sent_at)) - t) < 14 * D).map((r) => String(r.property_name ?? "")).filter(Boolean)) }) : null;
    inc(`v1:${h1.hooked ? "hooked" : "no"}`); for (const x of h1.signals) inc(`v1sig:${x}`);
    if (h2) { inc(`v2:${h2.level}${h2.bundle ? "(束)" : ""}`); if (h2.badName) inc("v2:名前が物件でない"); for (const x of h2.signals) inc(`v2sig:${x}`); if (h1.hooked && h2.level === "none") inc("diff:旧だけ"); if (!h1.hooked && h2.level !== "none") inc("diff:新だけ"); }
    const custAfter = ms.filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t && Date.parse(m.created_at) <= t + 48 * H).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const first = custAfter[0];
    const kind = first ? classifyHookReply({ text: first.text, image_url: first.image_url }) : "返事なし";
    inc(`first:${kind}${h1.hooked ? "（旧:刺さった）" : ""}`);
    // 書き出し
    const tag = h2 ? `旧=${h1.hooked ? "刺" : "-"}[${h1.signals.join(",")}] 新=${h2.level}[${h2.signals.join(",")}]` : `旧=${h1.hooked ? "刺" : "-"}[${h1.signals.join(",")}]${h1.declined ? " 断" : ""}`;
    if (useV2 && args.diffonly && !((h1.hooked && h2!.level === "none") || (!h1.hooked && h2!.level !== "none") || (h1.hooked && h2!.level === "weak"))) continue;
    lines.push(`\n■ #${s.id} ${new Date(t).toISOString().slice(0, 16)} 🌟${name} ${s.star_room ?? ""}  ${tag}  最初の返事=${kind}`);
    if (h2?.evidence.length) lines.push(`  根拠: ${h2.evidence.join(" ｜ ")}`);
    lines.push(`  送った: ${one(String(s.star_text ?? "").split("\n").slice(0, 3).join(" / "), 120)}`);
    const tl: Array<[number, string]> = [];
    for (const m of ms) { const at = Date.parse(m.created_at); if (at > t - 5 * 60_000 && at <= t + 72 * H) tl.push([at, `${m.sender === "customer" ? "客" : m.sender === "staff" || m.sender === "agent" ? "店" : m.sender}${m.quoted_message_id ? "(引用)" : ""}${m.image_url ? "[画像]" : ""}: ${one(m.text)}`]); }
    for (const a of ax) { const at = Date.parse(a.created_at); if (at > t && at <= t + 14 * D && a.aix_type !== "property_recommendation") tl.push([at, `AIX ${a.aix_type}: ${one(a.generated_text, 70)}`]); }
    for (const e of eOf.get(cv) ?? []) { const at = Date.parse(e.created_at); if (at > t && at <= t + 14 * D) tl.push([at, `見積記録: ${e.property_name} ${e.room_no ?? ""}`]); }
    for (const v of vOf.get(cv) ?? []) { const at = Date.parse(v.created_at); if (at > t - D && at <= t + 30 * D) tl.push([at, `内覧記録: ${v.property_name ?? "(物件名なし)"} ${v.scheduled_date ?? ""} ${v.status ?? ""}`]); }
    tl.sort((a, b) => a[0] - b[0]);
    for (const [at, x] of tl.slice(0, 18)) lines.push(`   +${hrs(at, t)} ${x}`);
  }
  console.log(`新着1件の🌟 ${snaps.length}`);
  for (const k of Object.keys(cnt).sort()) console.log(`  ${k}: ${cnt[k]}`);
  if (args.out) { writeFileSync(String(args.out), lines.join("\n")); console.log(`→ ${args.out}（${lines.length}行・個人情報を含む・手元だけ）`); }
})();
