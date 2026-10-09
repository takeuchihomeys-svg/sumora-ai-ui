// scripts/audit-r12-pickup-line-form.ts — 竹内さんの AIX【物件ピックアップした】の「ピックアップ行」の形（読むだけ・LLM なし）
// 2026-10-08 竹内「竹内が送っているような形で」: 条件の数・並べ方・「ご希望のご条件に近いお部屋」の言い方を数える
// 実行: npx tsx --env-file=.env.local scripts/audit-r12-pickup-line-form.ts [--show]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const ms = (s: string) => Date.parse(s);
const SHOW = process.argv.includes("--show");
(async () => {
  const logs = await readAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").eq("aix_type", "property_send").order("created_at").range(f, t));
  const convs = [...new Set(logs.map((l) => l.conversation_id))];
  const msgs: any[] = [];
  for (let i = 0; i < convs.length; i += 80) msgs.push(...await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated, text, sender").in("conversation_id", convs.slice(i, i + 80)).eq("staff_writer", "takeuchi").order("created_at").range(f, t)));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of logs) {
    const t = ms(l.created_at);
    const m = msgs.find((m) => m.conversation_id === l.conversation_id && m.is_aix_generated && Math.abs(ms(m.created_at) - t) < 15 * 60_000 && /ピックアップ|募集に出|募集にで/.test(m.text ?? ""));
    if (!m || seen.has(m.created_at + m.conversation_id)) continue;
    seen.add(m.created_at + m.conversation_id);
    const line = (m.text as string).split("\n").find((x) => /ピックアップ|募集に出|募集にで/.test(x)) ?? "";
    lines.push(line);
  }
  const st: Record<string, number> = {}; const bump = (k: string) => (st[k] = (st[k] ?? 0) + 1);
  for (const x of lines) {
    bump(/ご希望のご条件に近い/.test(x) ? "「ご希望のご条件に近い」" : /ご条件に近い/.test(x) ? "「ご条件に近い」(ご希望なし)" : /ご条件に合った|ご希望の条件に合う/.test(x) ? "「ご条件に合った」" : "近い/合ったの語なし");
    bump(/から/.test(x) ? "「〜から」あり" : "「から」なし");
    bump(/^新着/.test(x) ? "新着で始まる" : "新着以外");
    // 「から」と「お部屋/ご希望」の間の条件の語（・ と の と で区切る目安）
    const mid = (x.split("から")[1] ?? "").split(/さんご希望|ご希望|お部屋/)[0] ?? "";
    const n = mid ? mid.split(/・|、|の(?=[^\s])|で/).filter((s) => s.trim().length >= 2).length : 0;
    bump(`から〜ご希望の間の条件の数（目安） ${Math.min(n, 4)}${n >= 4 ? "+" : ""}`);
  }
  console.log(`竹内さんの AIX 物件ピックアップした ${lines.length}通`);
  for (const [k, v] of Object.entries(st).sort()) console.log(`  ${k}: ${v}`);
  const f = lines.map(pickupLineForm); const c = (k: keyof ReturnType<typeof pickupLineForm>) => f.filter((v) => v[k]).length;
  console.log(`  形: 全域から ${c("zeniki")}・さんにオススメできる ${c("osusume")}・ご条件に近い ${c("kondo")}・ご条件に合った ${c("gatta")}・😊 ${c("emoji")}・全てピックアップ ${c("zenbu")}（${lines.length}通中）`);
  if (SHOW) for (const x of lines) console.log("  | " + x);
})();
// 形の数（--form）: 周辺全域から／〇〇さんにオススメ(でき|出来)る／ご条件に近い／絵文字
export function pickupLineForm(x: string) {
  return {
    zeniki: /周辺全域から|全域から/.test(x),
    osusume: /さんにオススメ(?:でき|出来)る|にオススメ(?:でき|出来)る/.test(x),
    kondo: /ご条件に近い/.test(x),
    gatta: /ご条件に合った/.test(x),
    emoji: /😊/.test(x),
    zenbu: /全てピックアップ/.test(x),
  };
}
