// app/lib/sent-image-reread-server.ts — 読み直し待ちの送付の画像を DeepSeek で読み直して記録を埋める（純関数は sent-image-reread.ts）
//   ⚠ LINE には何も送らない（送信の関数を import しない）。書くのは recordSentImageProperty と ensureImageDetail の記録だけ。
import { supabase } from "@/app/lib/supabase-server";
import { pickRereadTargets, sentImageRereadOn, REREAD_WINDOW_HOURS, type RereadMsg, type RereadAix, type RereadTarget } from "@/app/lib/sent-image-reread";
import { isTestConversation } from "@/app/lib/test-conversations";

export type RereadReport = { ok: boolean; dry: boolean; off?: boolean; targets: number; conversations: number; results: Array<{ conversationId: string; source: string; sentAt: string; read?: string; sentProperties?: string }>; error?: string };

/** 読み直す送付を DB から選ぶ（読むだけ） */
export async function findRereadTargets(o: { conversationId?: string; windowHours?: number; limit?: number; nowMs?: number; excludeUrls?: ReadonlyArray<string> } = {}): Promise<RereadTarget[]> {
  const nowMs = o.nowMs ?? Date.now();
  const since = new Date(nowMs - (o.windowHours ?? REREAD_WINDOW_HOURS) * 3600_000).toISOString();
  let q = supabase.from("messages").select("id, conversation_id, created_at, image_url, is_aix_generated")
    .eq("sender", "staff").not("image_url", "is", null).gte("created_at", since).order("created_at", { ascending: true }).limit(1000);
  if (o.conversationId) q = q.eq("conversation_id", o.conversationId);
  const { data: msgs, error } = await q;
  if (error) throw new Error(`messages: ${error.message}`);
  const list = (msgs ?? []) as RereadMsg[];
  if (!list.length) return [];
  const urls = [...new Set(list.map((m) => m.image_url!).filter(Boolean))];
  const recorded = new Set<string>(o.excludeUrls ?? []);
  for (let i = 0; i < urls.length; i += 20) { // URL の長さ（画像の URL は長い＝100件だと GET の上限を超えて fetch failed）
    const { data, error: e2 } = await supabase.from("sent_image_properties").select("image_url").in("image_url", urls.slice(i, i + 20));
    if (e2) throw new Error(`sent_image_properties: ${e2.message}`);
    for (const r of (data ?? []) as Array<{ image_url: string }>) recorded.add(r.image_url);
    // 送った物件の行に同じ画像がある物（売上サポのピックアップの記録など別の書き手が書いた）も読み直さない
    const { data: sp, error: e4 } = await supabase.from("sent_properties").select("image_url").in("image_url", urls.slice(i, i + 20));
    if (e4) throw new Error(`sent_properties: ${e4.message}`);
    for (const r of (sp ?? []) as Array<{ image_url: string | null }>) if (r.image_url) recorded.add(r.image_url);
  }
  const convs = [...new Set(list.map((m) => m.conversation_id))];
  const aix: RereadAix[] = [];
  for (let i = 0; i < convs.length; i += 100) {
    const { data, error: e3 } = await supabase.from("aix_usage_logs").select("conversation_id, created_at, aix_type").in("conversation_id", convs.slice(i, i + 100)).gte("created_at", since).limit(1000);
    if (e3) throw new Error(`aix_usage_logs: ${e3.message}`);
    aix.push(...((data ?? []) as RereadAix[]));
  }
  const picked = pickRereadTargets(list, recorded, aix, { nowMs, windowHours: o.windowHours, limit: Math.max(o.limit ?? 40, 200), skipConv: (id) => isTestConversation(id) });
  // 申込の間（DeepSeek に渡さない線の後）の送付は読まない（2026-09-26 竹内さん「申込の間の部分は DeepSeek に渡さず」・sent-image-record と同じ線）。
  //   線が読めない・申込中（null）は全部読まない。線（ISO）がある会話は、その時刻より後に送った画像だけ読む（isAfterCutoff＝渡してよい側）
  const { loadDeepseekCutoff, isAfterCutoff } = await import("@/app/lib/post-apply");
  const cut = new Map<string, Awaited<ReturnType<typeof loadDeepseekCutoff>>>();
  for (const c of new Set(picked.map((t) => t.conversationId))) cut.set(c, await loadDeepseekCutoff(supabase, c));
  return picked.filter((t) => { const c = cut.get(t.conversationId); return c !== null && c !== undefined && isAfterCutoff(t.sentAt, c); }).slice(0, o.limit ?? 40);
}

/** 読み直して記録を埋める。dry は選ぶだけ */
export async function runSentImageReread(o: { dry?: boolean; conversationId?: string; windowHours?: number; limit?: number; excludeUrls?: ReadonlyArray<string> } = {}): Promise<RereadReport> {
  if (!sentImageRereadOn()) return { ok: true, dry: !!o.dry, off: true, targets: 0, conversations: 0, results: [] };
  try {
    const targets = await findRereadTargets(o);
    const report: RereadReport = { ok: true, dry: !!o.dry, targets: targets.length, conversations: new Set(targets.map((t) => t.conversationId)).size, results: [] };
    if (o.dry) { report.results = targets.map((t) => ({ conversationId: t.conversationId, source: t.source, sentAt: t.sentAt })); return report; }
    const [{ recordSentImageProperty }, { ensureImageDetail }] = await Promise.all([import("@/app/lib/sent-image-record"), import("@/app/lib/image-detail-store")]);
    for (const t of targets) {
      const r = await recordSentImageProperty({ imageUrl: t.imageUrl, conversationId: t.conversationId, source: t.source, sentAt: t.sentAt });
      await ensureImageDetail(t.imageUrl, t.conversationId).catch(() => null);
      report.results.push({ conversationId: t.conversationId, source: t.source, sentAt: t.sentAt, read: r.read, sentProperties: r.sentProperties });
    }
    console.log(JSON.stringify({ tag: "sent-image-reread", targets: report.targets, conversations: report.conversations, inserted: report.results.filter((x) => x.sentProperties === "inserted").length, failed: report.results.filter((x) => x.read === "failed").length }));
    return report;
  } catch (e) {
    return { ok: false, dry: !!o.dry, targets: 0, conversations: 0, results: [], error: e instanceof Error ? e.message : String(e) };
  }
}
