// scripts/audit-second-receipt-other-room.ts — 質問11（2026-10-22）: 物件確認した の後の2通目で「ご査収」を外す恐れを実データで数える（読むだけ・LLM なし）
//   check_pattern ごとに: 2通目（15分以内・間にお客様なし）にご査収がある番・画像が会話に見えない時／見える時に fixReceiptWhenNotSent が外す数
// 実行: npx tsx --env-file=.env.local scripts/audit-second-receipt-other-room.ts
import { createClient } from "@supabase/supabase-js";
import { splitTurn, sentThisTurn, fixReceiptWhenNotSent } from "../app/lib/second-message-materials";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const DAYS = 90;
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const logs: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at").eq("aix_type", "property_check_result").not("sent_at", "is", null).gte("created_at", since).range(f, f + 999);
    if (error) throw error; logs.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  console.log("logs", logs.length);
  const stats: Record<string, any> = {};
  let shown = 0;
  for (const l of logs) {
    const at = Date.parse(l.sent_at);
    const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", l.conversation_id)
      .gte("created_at", new Date(at - 3 * 864e5).toISOString()).lte("created_at", new Date(at + 20 * 60e3).toISOString()).order("created_at", { ascending: true }).limit(200);
    const list = (ms ?? []) as any[];
    // first AIX msg: nearest staff msg to sent_at
    let idx = -1, best = 1e15;
    list.forEach((m, i) => { if (m.sender !== "customer") { const d = Math.abs(Date.parse(m.created_at) - at); if (d < best) { best = d; idx = i; } } });
    if (idx < 0 || best > 120e3) continue;
    // following staff messages until customer msg, within 15 min
    const after = [] as any[];
    for (let j = idx + 1; j < list.length; j++) { const m = list[j]; if (m.sender === "customer") break; if (Date.parse(m.created_at) - Date.parse(list[idx].created_at) > 15 * 60e3) break; after.push(m); }
    const second = after.find((m) => !/^\s*\[(?:画像|動画|ファイル)\]\s*$/.test(String(m.text ?? "")) && (m.text ?? "").trim());
    if (!second) continue;
    const imgsBefore = after.filter((m) => Date.parse(m.created_at) < Date.parse(second.created_at) && /^\s*\[(?:画像|動画|ファイル)\]/.test(String(m.text ?? ""))).length;
    const recent = list.slice(0, idx).map((m) => ({ sender: m.sender, text: m.text, rawCreatedAt: m.created_at, isAix: m.is_aix_generated }));
    // as generator sees: history up to first msg + images between
    const recentWithImgs = [...recent, ...after.filter((m) => Date.parse(m.created_at) < Date.parse(second.created_at)).map((m) => ({ sender: m.sender, text: m.text, rawCreatedAt: m.created_at }))];
    const k = l.check_pattern ?? "-";
    const s = (stats[k] ??= { n: 0, receipt: 0, img: 0, cut_noimg: 0, cut_withimg: 0 });
    s.n++;
    const hasReceipt = /ご査収(?:ください|下さい|願います|の程)/.test(second.text);
    if (imgsBefore) s.img++;
    if (!hasReceipt) continue;
    if (k === "available" && shown++ < 14) console.log("AV", imgsBefore, JSON.stringify(list[idx].text).slice(0, 140), "||", JSON.stringify(second.text).slice(0, 100));
    s.receipt++;
    for (const [rec, key] of [[recent, "cut_noimg"], [recentWithImgs, "cut_withimg"]] as const) {
      const { turnStaff } = splitTurn(rec as any, list[idx].text);
      const sent = sentThisTurn({ actionType: "property_check_result", turnStaff });
      const r = fixReceiptWhenNotSent(second.text, sent);
      if (r.applied.length) { s[key]++; if ((key === "cut_withimg" || k === "unavailable" || k === "available") && shown++ < 14) console.log("---", k, imgsBefore, JSON.stringify(list[idx].text).slice(0, 120), "||", JSON.stringify(second.text).slice(0, 160)); }
    }
  }
  console.log(JSON.stringify(stats, null, 1));
})();
