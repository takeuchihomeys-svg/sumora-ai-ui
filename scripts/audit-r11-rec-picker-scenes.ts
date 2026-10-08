// scripts/audit-r11-rec-picker-scenes.ts — 11巡目 B（10/08 竹内「物件オススメのピッカーはその形（画面の6種）にする。送った中から1件推すは物件ピックアップで複数送った時に続けて推す部分」）
//   竹内さんの AIX【物件オススメ】の送信（書き手 takeuchi）を、押下の前の AIX の記録（束の時刻・枚数・送り方・募集終了）と本文から6種に分け、2通目の言い回しを数える。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-rec-picker-scenes.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const ms = (s: string) => Date.parse(s);
(async () => {
  const ps = await readAll((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, aix_type, send_mode, check_pattern, picker_choices, created_at").in("aix_type", ["property_recommendation", "property_send", "property_check_result"]).gte("created_at", "2026-06-26").order("created_at").range(f, t));
  const by = new Map<string, any[]>(); for (const p of ps) { if (!by.has(p.conversation_id)) by.set(p.conversation_id, []); by.get(p.conversation_id)!.push(p); }
  const recs = ps.filter((p) => p.aix_type === "property_recommendation");
  const convs = [...new Set(recs.map((r) => r.conversation_id))];
  const msgs: any[] = [];
  for (let i = 0; i < convs.length; i += 100) msgs.push(...await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated, text, sender, image_url").in("conversation_id", convs.slice(i, i + 100)).gte("created_at", "2026-06-26").order("created_at").range(f, t)));
  const mBy = new Map<string, any[]>(); for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const cls: Record<string, { n: number; ex: string[]; feat: Record<string, number> }> = {};
  const FEAT: Record<string, RegExp> = { 中でも: /中でも/, 新着で: /新着で/, 如何でしょうか: /如何でしょうか/, 内覧誘導: /ご都合よろしいお日にち/, 申込誘導: /お申込み?し?で?お部屋(抑|押)/, ご査収: /ご査収/, 募集御座いません: /募集(御座い|ござい)ません|空室のお部屋で募集|ございませんでしたが|御座いませんでしたが/, 退去予定: /退去予定/, 条件広げ: /広げ|上げた|ご上限/ };
  for (const r of recs) {
    const t = ms(r.created_at);
    const all = mBy.get(r.conversation_id) ?? [];
    const block = all.filter((m) => m.sender !== "customer" && ms(m.created_at) >= t - 10 * 60_000 && ms(m.created_at) <= t + 30 * 60_000 && (m.text ?? "").length > 8 && !m.image_url);
    const w = block.find((m) => m.is_aix_generated)?.staff_writer ?? block[0]?.staff_writer;
    if (w !== "takeuchi") continue;
    const hist = (by.get(r.conversation_id) ?? []).filter((p) => ms(p.created_at) < t - 30_000);
    const lastSend = [...hist].reverse().find((p) => p.aix_type === "property_send");
    const gap = lastSend ? (t - ms(lastSend.created_at)) / 60_000 : null;
    // 束の画像の枚数（束の押下から次の押下まで・10分以内の画像の通）
    const bundleImgs = lastSend ? all.filter((m) => m.sender !== "customer" && m.image_url && ms(m.created_at) >= ms(lastSend.created_at) - 5 * 60_000 && ms(m.created_at) <= ms(lastSend.created_at) + 15 * 60_000).length : 0;
    const lastChk = [...hist].reverse().find((p) => p.aix_type === "property_check_result");
    const unav = lastChk && (t - ms(lastChk.created_at)) < 3 * 86400_000 && /unavailable|alternative/.test(lastChk.check_pattern ?? "");
    const priorSends = hist.filter((p) => p.aix_type === "property_send" || p.aix_type === "property_recommendation").length;
    const sendMode = lastSend?.send_mode ?? lastSend?.picker_choices?.send_mode;
    const text = block.map((m) => m.text).join("\n");
    const rec = r.picker_choices?.pickup_type ?? null;
    let k: string;
    if (FEAT.募集御座いません.test(text.split("🌟")[0] ?? "")) k = "現状伝えて1件";
    else if (unav && !(gap !== null && gap <= 60)) k = "代替ピックアップ";
    else if (gap !== null && gap <= 60 && sendMode === "widen") k = "条件広げピックアップ";
    else if (gap !== null && gap <= 60) k = bundleImgs >= 2 ? "継続ピックアップ（束の直後・複数）" : "束の直後・1枚";
    else if (priorSends === 0) k = "新規ピックアップ（前の送付なし）";
    else k = "新着1件（前の送付あり・束から1時間超）";
    const c = (cls[k] ??= { n: 0, ex: [], feat: {} });
    c.n++;
    for (const [f, re] of Object.entries(FEAT)) if (re.test(text)) c.feat[f] = (c.feat[f] ?? 0) + 1;
    c.feat[`記録:${rec ?? "なし"}`] = (c.feat[`記録:${rec ?? "なし"}`] ?? 0) + 1;
    c.ex.push(`${r.created_at.slice(0, 10)} 束${gap === null ? "-" : Math.round(gap)}分(${bundleImgs}枚・${sendMode ?? "-"}) 前${priorSends}｜${text.replace(/\n/g, "⏎").replace(/https?:\S+/g, "URL").slice(0, 170)}`);
  }
  for (const [k, c] of Object.entries(cls).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`\n## ${k} n=${c.n}  ${Object.entries(c.feat).sort((a, b) => b[1] - a[1]).map(([f, v]) => `${f} ${v}`).join("・")}`);
    for (const x of c.ex.slice(-5)) console.log("   " + x);
  }
})();
