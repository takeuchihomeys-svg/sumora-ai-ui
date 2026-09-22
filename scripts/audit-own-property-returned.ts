// お客様が「こちらが前に送った物件」を送り返してきた場面は何件あり、スタッフはどう返したか（読み取りのみ）
//
// 2026-09-22 竹内（𝓡さん事例）「こっちが送った物件をお客さんが送ってくることもある。物件名や画像をみたら判断できるようにする」
// 実行: npx tsx --env-file=.env.local scripts/audit-own-property-returned.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { extractScreenshotProperty, matchOwnProperty, type SentProperty } from "../app/lib/own-property-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=90").split("=")[1]);
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");
const CONFIRM_RE = /募集状況(?:を)?確認|空室確認|空き状況(?:を)?確認|確認させて(?:頂|いただ)きます/;
const THANKS_RE = /ご査収(?:頂|いただ)きありがとう|ご確認(?:頂|いただ)きありがとう|お気に召して/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; text: string; created_at: string }> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at")
      .eq("sender", "customer").like("text", "[画像]%").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const withProp = rows.map((r) => ({ ...r, item: extractScreenshotProperty(r.text) })).filter((r) => r.item);
  console.log(`=== 直近${DAYS}日 お客様の画像 ${rows.length}件のうち物件名が取れた ${withProp.length}件 ===`);

  const sentCache = new Map<string, SentProperty[]>();
  const sentOf = async (cid: string) => {
    if (sentCache.has(cid)) return sentCache.get(cid)!;
    const [{ data: sp }, { data: sip }] = await Promise.all([
      sb.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", cid).limit(300),
      sb.from("sent_image_properties").select("property_name, room_no, created_at").eq("conversation_id", cid).limit(300),
    ]);
    const list: SentProperty[] = [
      ...((sp ?? []) as Array<{ property_name: string; room_no: string | null; sent_at: string | null }>).map((r) => ({ name: r.property_name, room: r.room_no, sentAt: r.sent_at })),
      ...((sip ?? []) as Array<{ property_name: string; room_no: string | null; created_at: string }>).map((r) => ({ name: r.property_name, room: r.room_no, sentAt: r.created_at })),
    ].filter((s) => s.name);
    sentCache.set(cid, list);
    return list;
  };

  let ours = 0, building = 0, none = 0, confirm = 0, thanks = 0, replied = 0;
  const shown: string[] = [];
  const seenTurn = new Set<string>();
  for (const r of withProp) {
    const sent = (await sentOf(r.conversation_id)).filter((s) => !s.sentAt || s.sentAt < r.created_at);
    const m = matchOwnProperty(r.item!, sent);
    if (m.kind === "same_building") { building++; continue; }
    if (m.kind === "none") { none++; continue; }
    ours++;
    // 同じ会話の同じ連投（10分以内）は1回として数える
    const turnKey = `${r.conversation_id}:${r.created_at.slice(0, 15)}`;
    if (seenTurn.has(turnKey)) continue;
    seenTurn.add(turnKey);
    const { data: rep } = await sb.from("messages").select("text").eq("conversation_id", r.conversation_id).eq("sender", "staff")
      .gt("created_at", r.created_at).lt("created_at", new Date(Date.parse(r.created_at) + 24 * 3600_000).toISOString())
      .order("created_at", { ascending: true }).limit(3);
    const texts = ((rep ?? []) as Array<{ text: string | null }>).map((x) => x.text ?? "").filter((t) => t && !t.startsWith("[画像]"));
    const reply = texts[0] ?? "";
    if (reply) replied++;
    if (CONFIRM_RE.test(reply)) confirm++;
    if (THANKS_RE.test(reply)) thanks++;
    if (shown.length < 15) shown.push(`${r.created_at.slice(0, 16)} 【${r.item!.name} ${r.item!.room ?? ""}】= こちらの ${m.sent!.name}（${(m.sent!.sentAt ?? "").slice(5, 10)}送付）\n  実送信: ${mask(reply).replace(/\n/g, " ／ ").slice(0, 110) || "（返信なし）"}`);
  }
  console.log(`こちらが送った物件と同じ: ${ours}件 ／ 同じマンションの別の部屋: ${building}件 ／ 記録に無い: ${none}件`);
  console.log(`同じ物件を送ってきた場面（連投は1回）: ${seenTurn.size}回・スタッフが返信 ${replied}回`);
  console.log(`  うち「募集状況確認します」型 ${confirm}回 ／「ご査収頂きありがとう」等のお礼 ${thanks}回\n`);
  console.log(shown.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
