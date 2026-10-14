// scripts/audit-portal-listing.ts — お客様が送ってきたポータル（SUUMO 等）の URL・スクショを、どこまで物件として読めているかを数える（読むだけ・LLM なし・$0）
//
// 2026-10-14 竹内さん「SUUMO を送ってきた時に中身を読む仕組みが既にあるか確かめ、どこまで読めているかを数え、読めていない所をつなぐ。
//   物件名が無い時は駅・家賃・間取り・広さで売上サポ・帳簿の物件に当て、1つに決まる時だけ」。照らし方は app/lib/portal-listing-match.ts。
//   ① 形: SUUMO（物件名つき）・athome（物件名：）・物件名の無い共有文（ニフティ等）・スクショ（Vision の書き起こし）・URL だけ
//   ② 物件名の無い物を、売上サポの行（説明文）と送った画像の読み取り（facts）に照らして 1つに決まる数。確かめ: その会話のその後のこちらの名前（AIX・送付）に同じ物件が出るか
//   ③ 竹内さんが受けた時に実際に送った文と下書き（ai_reply_examples）の差（数えるだけ・直しは返信の担当へ）
// 実行: npx tsx --env-file=.env.local scripts/audit-portal-listing.ts [--days=120] [--show=15]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { let q = sb.from(t).select(cols).range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(`${t}: ${error.message}`); out.push(...((data ?? []) as T[])); if (!data || data.length < 1000) break; }
  return out;
}

async function main() {
  const days = Number(arg("days", "120")), show = Number(arg("show", "15"));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const pm = await import("../app/lib/portal-listing-match");
  const { customerSharedPropertyNames } = await import("../app/lib/customer-property-names");
  const { matchLoose, isSameLoose } = await import("../app/lib/property-name-loose");
  const msgs = await all<{ conversation_id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null }>("messages", "conversation_id, sender, text, created_at, line_message_id", (q) => q.eq("sender", "customer").gte("created_at", since).or("text.ilike.%http%,text.ilike.[画像]%"));
  const forms = new Map<string, number>();
  const noName: Array<{ conv: string; at: string; text: string; clues: ReturnType<typeof pm.readListingClues> }> = [];
  for (const m of msgs) {
    if (m.conversation_id === YUMA || String(m.line_message_id ?? "").startsWith("bexam")) continue;
    const named = customerSharedPropertyNames([{ sender: "customer", text: m.text, createdAt: m.created_at }], { limit: 3 }).length;
    const f = pm.portalFormOf(m.text, named);
    if (f === "none") continue;
    forms.set(f, (forms.get(f) ?? 0) + 1);
    if (f === "no_name_share" || f === "screenshot") noName.push({ conv: m.conversation_id, at: m.created_at, text: m.text ?? "", clues: pm.readListingClues(m.text) });
  }
  console.log(`■ ${days}日のお客様のポータルの発言: ${[...forms].map(([k, v]) => `${k} ${v}`).join("・")}`);

  // 候補: 売上サポの行（説明文）＋送った画像の読み取り（facts）。全部の会話から（物件は会話をまたいで同じ）
  const pk = await all<{ property_name: string; room_no: string | null; summary_text: string | null; created_at: string }>("property_pickups", "property_name, room_no, summary_text, created_at", (q) => q.gte("created_at", new Date(Date.now() - (days + 60) * 86400_000).toISOString()));
  const cands: import("../app/lib/portal-listing-match").ListingCandidate[] = pk.map((r) => ({ name: r.property_name, room: r.room_no, ...pm.cluesFromPickupSummary(r.summary_text), source: "pickup" }));
  const sip = await all<{ property_name: string | null; room_no: string | null; facts: Record<string, unknown> | null }>("sent_image_properties", "property_name, room_no, facts", (q) => q.not("facts", "is", null).neq("source", "vision"));
  for (const r of sip) {
    const f = r.facts ?? {};
    if (!r.property_name) continue;
    cands.push({ name: r.property_name, room: r.room_no, station: typeof f.station === "string" ? f.station : null, walk: typeof f.walk_minutes === "number" ? f.walk_minutes : null, rentYen: typeof f.rent === "number" ? f.rent : null, madori: typeof f.floor_plan === "string" ? f.floor_plan : null, areaSqm: typeof f.area_sqm === "number" ? f.area_sqm : null, source: "image" });
  }
  let enough = 0, unique = 0, multi = 0, zero = 0;
  const matched: Array<{ conv: string; at: string; name: string; text: string }> = [];
  for (const x of noName) {
    if (!x.clues.station || x.clues.rentYen == null || !x.clues.madori) continue;
    enough++;
    const r = pm.matchListing(x.clues, cands, {});
    if (r.match) { unique++; matched.push({ conv: x.conv, at: x.at, name: r.match.name, text: x.text }); } else if (r.hits > 1) multi++; else zero++;
  }
  console.log(`■ 物件名の無い共有文・スクショ ${noName.length}: 手がかり（駅・家賃・間取り）がそろう ${enough}・1つに決まる ${unique}・2つ以上 ${multi}・当たる物件なし ${zero}`);
  // 確かめ: その会話でその後 3日以内のこちらの物件名（AIX の記録・照合済みの送付・売上サポ）
  const convs = [...new Set(matched.map((m) => m.conv))];
  const later = new Map<string, Array<{ name: string; at: string }>>();
  for (let i = 0; i < convs.length; i += 50) {
    const ids = convs.slice(i, i + 50);
    const ax = await all<{ conversation_id: string; property_names: string[] | null; created_at: string }>("aix_usage_logs", "conversation_id, property_names, created_at", (q) => q.in("conversation_id", ids).not("property_names", "is", null));
    for (const r of ax) for (const n of r.property_names ?? []) { const a = later.get(r.conversation_id) ?? []; a.push({ name: n, at: r.created_at }); later.set(r.conversation_id, a); }
    const sp = await all<{ conversation_id: string; property_name: string | null; sent_at: string | null; source: string | null }>("sent_properties", "conversation_id, property_name, sent_at, source", (q) => q.in("conversation_id", ids).neq("source", "vision"));
    for (const r of sp) if (r.property_name) { const a = later.get(r.conversation_id) ?? []; a.push({ name: r.property_name, at: r.sent_at ?? "" }); later.set(r.conversation_id, a); }
  }
  let ok = 0, other = 0, none = 0;
  for (const m of matched) {
    const xs = (later.get(m.conv) ?? []).filter((x) => x.at >= m.at && Date.parse(x.at) - Date.parse(m.at) <= 3 * 86400_000);
    if (!xs.length) { none++; continue; }
    if (xs.some((x) => isSameLoose(matchLoose(x.name, m.name)))) ok++; else other++;
  }
  console.log(`   1つに決まった ${unique} の確かめ（その会話の3日以内のこちらの物件名）: 同じ物件 ${ok}・別の物件の名前だけ ${other}・こちらの物件名なし ${none}`);
  for (const m of matched.slice(0, show)) console.log(`   ${m.text.replace(/\s+/g, " ").slice(0, 60)} → ${m.name}`);

  // ③ 実送信と下書きの差（ポータルの URL の番）
  const ex = await all<{ customer_message: string | null; ai_draft: string | null; sent_reply: string | null; ai_similarity: number | null; aix_action: string | null; conversation_id: string }>("ai_reply_examples", "customer_message, ai_draft, sent_reply, ai_similarity, aix_action, conversation_id", (q) => q.gte("created_at", since).ilike("customer_message", "%http%"));
  const portal = ex.filter((r) => r.conversation_id !== YUMA && /suumo\.jp|homes\.co\.jp|athome|chintai|nifty|lifull/i.test(r.customer_message ?? "") && r.ai_draft && r.sent_reply && !r.aix_action);
  const same = portal.filter((r) => (r.ai_draft ?? "").trim() === (r.sent_reply ?? "").trim()).length;
  const sim = portal.map((r) => r.ai_similarity).filter((x): x is number => typeof x === "number");
  const has = (re: RegExp, k: "ai_draft" | "sent_reply") => portal.filter((r) => re.test(r[k] ?? "")).length;
  const marks: Array<[string, RegExp]> = [
    ["「お送り頂きました物件」", /お送り(頂|いただ)きました(物件|お部屋)/], ["募集状況を確認する約束", /募集状況[^\n]{0,12}確認させて/], ["駅名・徒歩分で物件を呼ぶ", /徒歩\s*\d+\s*分の(物件|お部屋)/],
    ["御見積書・初期費用", /御?見積|初期費用/], ["かしこまりました", /かしこまりました/], ["ありがとうございます", /ありがとうございます/],
  ];
  console.log(`■ ポータルの URL を受けた番（${days}日・AIX でない返信）${portal.length}件: 下書きと実送信が同じ ${same}・似ている度 平均 ${sim.length ? (sim.reduce((a, b) => a + b, 0) / sim.length).toFixed(2) : "—"}`);
  for (const [k, re] of marks) console.log(`   ${k}: 実送信 ${has(re, "sent_reply")}・下書き ${has(re, "ai_draft")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
