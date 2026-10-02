// scripts/backfill-quote-reactions.ts — 過去の引用返信を物件に結び付け直す（1回だけ・既定は書かない＝dry）
// 実行: npx tsx --env-file=.env.local scripts/backfill-quote-reactions.ts [--days=120] [--apply]
//
// 2026-10-02 ⑯ 手順4: line-webhook-text.resolvePropertyReference が sent_properties を .order("created_at")（無い列）で引いていて、
//   お客様の引用返信が1件も物件に結び付かなかった（親が 10/02 に sent_at へ直した）。直る前の分を同じ決め方で埋め直す:
//   引用先がスタッフの発言 → その会話の sent_properties のうち**返信より前**の直近20件（今の関数は今の直近20件）→ 画像の一致・URL・物件名。
//   反応の読みも同じ（見送|やめ|他で決|別の物件/部屋|なし|違う|微妙|イメージと＝rejected・それ以外 interested）。
//   書くのは --apply の時だけ。既に値がある行は上書きしない（messages.referenced_property_id・sent_properties.customer_reaction）。YUMA は外す。
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").split("=")[1]) || 120;
const apply = process.argv.includes("--apply");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const REJECT_RE = /見送|やめ|他で決|別の(物件|部屋)|なし|違う|微妙|イメージと/;

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const replies: any[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from("messages").select("id, conversation_id, text, quoted_message_id, referenced_property_id, created_at")
      .eq("sender", "customer").not("quoted_message_id", "is", null).gte("created_at", since).order("id").range(from, from + 999);
    if (error) { console.log("messages:", error.message); return; }
    if (!data?.length) break;
    replies.push(...data);
    if (data.length < 1000) break;
  }
  const c = { replies: replies.length, yuma: 0, already: 0, quotedMissing: 0, quotedCustomer: 0, noSends: 0, noMatch: 0, matched: 0, interested: 0, rejected: 0, wroteRef: 0, wroteReaction: 0, reactionKept: 0 };
  const byWay = { image: 0, url: 0, name: 0 };
  const examples: string[] = [];
  for (const r of replies) {
    if (r.conversation_id === YUMA) { c.yuma++; continue; }
    if (r.referenced_property_id) { c.already++; continue; }
    const { data: q } = await db.from("messages").select("id, sender, text, image_url").eq("line_message_id", r.quoted_message_id).maybeSingle();
    if (!q) { c.quotedMissing++; continue; }
    if (q.sender === "customer") { c.quotedCustomer++; continue; }
    const { data: props, error } = await db.from("sent_properties").select("id, property_name, room_no, image_url, property_url, customer_reaction, sent_at")
      .eq("conversation_id", r.conversation_id).lte("sent_at", r.created_at).order("sent_at", { ascending: false }).limit(20);
    if (error) { console.log("sent_properties:", error.message); return; }
    if (!props?.length) { c.noSends++; continue; }
    const qText = String(q.text ?? "");
    let way: keyof typeof byWay | null = null;
    const hit = props.find((p) => {
      if (p.image_url && p.image_url === q.image_url) { way = "image"; return true; }
      if (p.property_url && qText.includes(p.property_url)) { way = "url"; return true; }
      if (p.property_name && p.property_name.length >= 3 && qText.includes(p.property_name)) { way = "name"; return true; }
      return false;
    });
    if (!hit) { c.noMatch++; continue; }
    c.matched++;
    if (way) byWay[way as keyof typeof byWay]++;
    const reaction = REJECT_RE.test(String(r.text ?? "")) ? "rejected" : "interested";
    if (reaction === "interested") c.interested++; else c.rejected++;
    if (examples.length < 8) examples.push(`${reaction}｜${String(hit.property_name).slice(0, 20)}｜返信「${String(r.text ?? "").replace(/\s+/g, " ").slice(0, 30)}」`);
    if (!apply) continue;
    const { error: e1 } = await db.from("messages").update({ referenced_property_id: hit.id }).eq("id", r.id).is("referenced_property_id", null);
    if (!e1) c.wroteRef++;
    if (hit.customer_reaction) { c.reactionKept++; continue; }
    const { error: e2 } = await db.from("sent_properties").update({ customer_reaction: reaction }).eq("id", hit.id).is("customer_reaction", null);
    if (!e2) c.wroteReaction++;
  }
  console.log(`■ 引用返信の埋め直し（直近${days}日・${apply ? "書く" : "dry＝書かない"}）`);
  console.log(`  ${JSON.stringify(c)}`);
  console.log(`  結び付いた決め手: 画像 ${byWay.image}・URL ${byWay.url}・物件名 ${byWay.name}`);
  for (const e of examples) console.log(`  例: ${e}`);
})();
