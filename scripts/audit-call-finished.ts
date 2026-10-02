// scripts/audit-call-finished.ts
// 2026-10-02 ⑫ 20巡: phone-button-sent.callJustFinished（電話が終わった後の返事にもう一度 電話をかける を出さない）の線。読むだけ・LLM なし。
//   電話のお礼がある会話で、callJustFinished が真になるお客様の番の後に、スタッフが AIX【電話をかける】を押した数（0 なら止めてよい）
// 実行: npx tsx --env-file=.env.local scripts/audit-call-finished.ts
import { createClient } from "@supabase/supabase-js";
import { callJustFinished, CALL_FINISHED_RE } from "../app/lib/phone-button-sent";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const { data: seeds } = await sb.from("messages").select("conversation_id").ilike("text", "%お電話%ありがとう%").limit(1000);
  const convs = [...new Set((seeds ?? []).map((s) => s.conversation_id as string))];
  let turns = 0, pressed = 0, texted = 0; const shown: string[] = [];
  for (const cid of convs) {
    const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", cid).order("created_at").limit(2000);
    const { data: ps } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", cid).eq("aix_type", "phone_call");
    const list = (ms ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (list[i + 1] && list[i + 1].sender === "customer")) continue;
      const hist = list.slice(0, i + 1).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
      if (!hist.some((m) => CALL_FINISHED_RE.test(m.text ?? "")) || !callJustFinished(hist)) continue;
      turns++;
      const at = Date.parse(list[i].created_at);
      const next = list.slice(i + 1).find((m) => m.sender !== "customer");
      const p = (ps ?? []).some((x) => Date.parse(x.created_at) > at && Date.parse(x.created_at) < at + 6 * 3600_000);
      if (p) { pressed++; shown.push(`押した: ${String(list[i].text).replace(/\n/g, " ").slice(0, 60)}`); } else if (next) texted++;
      if (shown.length < 8 && !p) shown.push(`手打ち: ${String(list[i].text).replace(/\n/g, " ").slice(0, 50)} → ${String(next?.text ?? "").replace(/\n/g, " ").slice(0, 50)}`);
    }
  }
  console.log(`電話のお礼のある会話 ${convs.length}・電話が終わった後の番 ${turns}: スタッフが 電話をかける を押した ${pressed}・手打ち ${texted}`);
  for (const s of shown) console.log("  ", s);
})();
