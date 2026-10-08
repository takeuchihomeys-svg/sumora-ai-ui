// 物件ごとの台帳（property-thread）に「オススメした物件」「お客様が送ってきた物件（持ち込み）」が物件名つきで残るかを、前（HEAD の台帳・30日の窓・控えなし）と後で数える。
// 2026-10-08 竹内「物件ごとに、お客さんが食いついてきた物件やオススメした物件について情報保管するようにしているのってちゃんと機能してるかな？」
// 読むだけ・LLM なし・本文は出さない（数だけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-property-memory.ts [--days=30] [--old=<HEAD の property-thread を写したファイル>]
//   --old を付けない時は「後」だけ数える。前を数える時は `git show HEAD~N:app/lib/property-thread.ts` を import の道を直して写して渡す。
import { createClient } from "@supabase/supabase-js";
import { extractScreenshotProperty } from "../app/lib/own-property-match";
import { customerSharedPropertyNames } from "../app/lib/customer-property-names";
import { splitPropertyName, matchRoomRefs } from "../app/lib/customer-state";
import { aixPropertyNamesForLog } from "../app/lib/aix-sent-names";
import { resolvePropertyThreads, type PtAix, type PtMsg, type PtEstimate, type PtRecommendation, type PropertyThreadState } from "../app/lib/property-thread";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "30"));
const OLD = arg("old", "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Item = { conv: string; at: string; name: string };
const hasRoom = (s: PropertyThreadState | null, name: string, kinds: string[] | null) => {
  if (!s) return false;
  const ref = splitPropertyName(name);
  if (!ref) return false;
  return s.rooms.some((r) => { const k = matchRoomRefs(ref, r.ref); return (k === "same_room" || k === "same_building") && (!kinds || r.events.some((e) => kinds.includes(e.kind))); });
};

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const brought: Item[] = [];
  for (let p = 0; p < 30; p++) {
    const { data } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").like("text", "[画像]%").gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    for (const m of (data ?? []) as Array<{ conversation_id: string; text: string; created_at: string }>) {
      if (m.conversation_id === YUMA) continue;
      const sp = extractScreenshotProperty(m.text);
      if (sp?.name) brought.push({ conv: m.conversation_id, at: m.created_at, name: sp.room ? `${sp.name} ${sp.room}号室` : sp.name });
    }
    if ((data ?? []).length < 1000) break;
  }
  // ポータルの共有文（SUUMO・athome）の物件名
  const nImg = brought.length;
  for (let p = 0; p < 30; p++) {
    const { data } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").like("text", "%http%").gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    for (const m of (data ?? []) as Array<{ conversation_id: string; text: string; created_at: string }>) {
      if (m.conversation_id === YUMA) continue;
      for (const c of customerSharedPropertyNames([{ sender: "customer", text: m.text, createdAt: m.created_at }], { limit: 5 })) brought.push({ conv: m.conversation_id, at: m.created_at, name: c.name });
    }
    if ((data ?? []).length < 1000) break;
  }
  console.error(`持ち込み: 画像 ${nImg}・共有文 ${brought.length - nImg}`);
  const { data: recLogs } = await sb.from("aix_usage_logs").select("conversation_id, created_at, generated_text").eq("aix_type", "property_recommendation").not("sent_at", "is", null).gte("created_at", since).limit(2000);
  const recs: Item[] = ((recLogs ?? []) as Array<{ conversation_id: string; created_at: string; generated_text: string | null }>)
    .filter((r) => r.conversation_id !== YUMA)
    .flatMap((r) => aixPropertyNamesForLog({ aixType: "property_recommendation", text: r.generated_text }).slice(0, 1).map((name) => ({ conv: r.conversation_id, at: r.created_at, name })));
  const convs = [...new Set([...brought, ...recs].map((x) => x.conv))];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oldMod: any = OLD ? await import(OLD.startsWith(".") || OLD.startsWith("/") || /^[A-Za-z]:/.test(OLD) ? OLD : `./${OLD}`) : null;
  const { propertyLabelsForImages } = await import("../app/lib/quoted-context");
  const res = { brought: { n: brought.length, before: 0, after: 0, afterShared: 0 }, rec: { n: recs.length, before: 0, after: 0, afterRecommended: 0 } };
  let i = 0;
  for (const c of convs) {
    i++;
    const until = new Date(Date.now() + 86400_000).toISOString();
    const [m, a, e, s] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, line_message_id, quoted_message_id, image_url, is_aix_generated").eq("conversation_id", c).lte("created_at", until).order("created_at", { ascending: false }).limit(500),
      sb.from("aix_usage_logs").select("created_at, aix_type, check_pattern, property_names, prop_statuses, estimate_sent, generated_text").eq("conversation_id", c).not("sent_at", "is", null).order("created_at", { ascending: false }).limit(300),
      sb.from("estimate_records").select("created_at, property_name, room_no, discount_yen, initial_cost_yen").eq("conversation_id", c).order("created_at", { ascending: false }).limit(200),
      sb.from("recommendation_snapshots").select("sent_at, star_name, star_room, star_text").eq("conversation_id", c).order("sent_at", { ascending: false }).limit(60),
    ]);
    const messages = ((m.data ?? []) as PtMsg[]).reverse();
    const urls = [...new Set(messages.filter((x) => x.sender === "staff" && x.image_url).map((x) => x.image_url as string))];
    const imageLabels = new Map<string, string>();
    for (let k = 0; k < urls.length; k += 40) for (const [u, v] of await propertyLabelsForImages(c, urls.slice(k, k + 40))) imageLabels.set(u, v);
    const aixRaw = (a.data ?? []) as PtAix[];
    // 後: 送信の記録に物件名を埋めた形（backfill-aix-property-names と同じ本文から）
    const aixAfter = aixRaw.map((x) => (x.property_names?.length ? x : { ...x, property_names: aixPropertyNamesForLog({ aixType: x.aix_type, text: x.generated_text }) }));
    const after = resolvePropertyThreads({ messages, imageLabels, aix: aixAfter, estimates: (e.data ?? []) as PtEstimate[], recommendations: (s.data ?? []) as PtRecommendation[] });
    let before: PropertyThreadState | null = null;
    if (oldMod) {
      const cut = Date.now() - 30 * 86400_000;
      const w = <T extends { created_at: string }>(xs: T[]) => xs.filter((x) => Date.parse(x.created_at) >= cut);
      before = oldMod.resolvePropertyThreads({ messages: w(messages), imageLabels, aix: w(aixRaw), estimates: w((e.data ?? []) as PtEstimate[]) });
    }
    for (const b of brought.filter((x) => x.conv === c)) {
      if (hasRoom(before, b.name, ["customer_shared"])) res.brought.before++;
      if (hasRoom(after, b.name, null)) res.brought.after++;
      if (hasRoom(after, b.name, ["customer_shared"])) res.brought.afterShared++;
    }
    for (const r of recs.filter((x) => x.conv === c)) {
      if (hasRoom(before, r.name, null)) res.rec.before++;
      if (hasRoom(after, r.name, null)) res.rec.after++;
      if (hasRoom(after, r.name, ["recommended"])) res.rec.afterRecommended++;
    }
    if (i % 20 === 0) console.error(`… ${i}/${convs.length}`);
  }
  const pct = (x: number, n: number) => (n ? `${Math.round((x / n) * 1000) / 10}%` : "-");
  console.log(`=== ${DAYS}日・会話 ${convs.length}（YUMA を除く） ===`);
  console.log(`お客様が送ってきた物件（物件名が読めた画像・ポータルの共有文）${res.brought.n}枚: 台帳に「お客様が送ってきた」で残った 前 ${oldMod ? pct(res.brought.before, res.brought.n) : "-"} → 後 ${pct(res.brought.afterShared, res.brought.n)}（物件として残った ${pct(res.brought.after, res.brought.n)}）`);
  console.log(`物件オススメ ${res.rec.n}通: 台帳に物件として残った 前 ${oldMod ? pct(res.rec.before, res.rec.n) : "-"} → 後 ${pct(res.rec.after, res.rec.n)}（「オススメした」の出来事つき ${pct(res.rec.afterRecommended, res.rec.n)}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
