// scripts/backfill-sent-image-aix-attribute.ts — AIX で送った画像で物件の記録が無い物を、AIX の記録の物件名（1件だけの時）に結ぶ（LLM なし・#448・作業員G）
//   既定は数えるだけ（--write で sent_image_properties に書く・既に記録がある画像は触らない）。⚠ 9〜22時は回さない。
//   使い方: npx tsx --env-file=<.env.local> scripts/backfill-sent-image-aix-attribute.ts [--days=60] [--write] [--show]
import { createClient } from "@supabase/supabase-js";
import { pickAixProperty, AIX_ATTRIBUTE_WINDOW_MS, type AixLogForAttr } from "../app/lib/sent-image-aix-attribute";
import { channelFromSource } from "../app/lib/sent-delivery";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")), WRITE = process.argv.includes("--write"), SHOW = process.argv.includes("--show");
const h = new Date().getHours();
if (h >= 9 && h < 22 && !process.argv.includes("--force")) { console.error("9〜22時は回さない"); process.exit(1); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

async function main() {
  type M = { conversation_id: string; image_url: string; created_at: string };
  const imgs: M[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, image_url, created_at").neq("sender", "customer").gte("created_at", since).not("image_url", "is", null).eq("is_aix_generated", true).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    imgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const targets = imgs.filter((m) => !isTestConversation(m.conversation_id));
  const has = new Set<string>();
  for (let i = 0; i < targets.length; i += 15) {
    const { data } = await sb.from("sent_image_properties").select("image_url").in("image_url", targets.slice(i, i + 15).map((m) => m.image_url));
    for (const r of (data ?? []) as Array<{ image_url: string }>) has.add(r.image_url);
  }
  const todo = targets.filter((m) => !has.has(m.image_url));
  const byConv = new Map<string, M[]>();
  for (const m of todo) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const n = { aix_images: targets.length, no_record: todo.length, attributed: 0, no_match: 0 };
  const byType: Record<string, number> = {};
  for (const [cid, list] of byConv) {
    const { data: logs } = await sb.from("aix_usage_logs").select("aix_type, property_names, sent_at, created_at, generated_text").eq("conversation_id", cid).gte("created_at", new Date(Date.parse(since) - 2 * 3600_000).toISOString()).limit(2000);
    const L = (logs ?? []) as AixLogForAttr[];
    for (const m of list) {
      const t = Date.parse(m.created_at);
      const near = L.filter((l) => Math.abs(Date.parse(l.sent_at ?? l.created_at) - t) <= AIX_ATTRIBUTE_WINDOW_MS);
      const type = near.length === 1 ? near[0].aix_type : null;
      const hit = type ? pickAixProperty(`aix:${type}`, t, L) : null;
      if (!hit) { n.no_match++; continue; }
      n.attributed++; byType[hit.aixType] = (byType[hit.aixType] ?? 0) + 1;
      if (SHOW) {
        // 確かめ（目で読む）: AIX の本文に物件名が出ているか・画像の中身の読み（image_details）に何が書いてあるか
        const log = near[0] as AixLogForAttr & { generated_text?: string | null };
        const key = hit.name.normalize("NFKC").replace(/\s+/g, "").slice(0, 6);
        const inText = (log.generated_text ?? "").normalize("NFKC").replace(/\s+/g, "").includes(key);
        const { data: det } = await sb.from("image_details").select("kind, lines").eq("image_url", m.image_url).maybeSingle();
        const d = det as { kind: string | null; lines: unknown } | null;
        const dl = d ? JSON.stringify(d.lines ?? "").replace(/\s+/g, " ").slice(0, 90) : "（読みなし）";
        console.log(`${cid.slice(0, 8)} ${m.created_at.slice(0, 16)} ${hit.aixType} → ${hit.name}${hit.room ? ` ${hit.room}` : ""}｜本文に名前 ${inText ? "あり" : "なし"}｜画像の読み ${d?.kind ?? "-"} ${dl}`);
      }
      if (WRITE) {
        const channel = channelFromSource(`aix:${hit.aixType}`);
        const { error } = await sb.from("sent_image_properties").upsert({ image_url: m.image_url, conversation_id: cid, property_name: hit.name, room_no: hit.room, source: `aix_log:${hit.aixType}`, created_at: m.created_at, ...(channel ? { channel } : {}) }, { onConflict: "image_url", ignoreDuplicates: true });
        if (error) console.warn("書けない:", error.message);
      }
    }
  }
  console.log(JSON.stringify({ ...n, byType, write: WRITE }));
}
main().catch((e) => { console.error(e); process.exit(1); });
