// scripts/audit-viewing-reask.ts
// 2026-10-02 ⑫ 21巡: viewing-reask.findViewingDateReask（決まった内覧の日にちを聞き直す下書きを自動で送らない）の線。読むだけ・LLM なし。
//   スタッフの送信（365日）で、直前の 6通のこちらの送信に日時の確定がある時に日にちを聞いた文（＝人もする聞き直し・別の物件の内覧 等）を数えて読む
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-reask.ts
import { createClient } from "@supabase/supabase-js";
import { findViewingDateReask, VIEWING_FIXED_STAFF_RE } from "../app/lib/viewing-reask";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const { data: seeds } = await sb.from("messages").select("conversation_id").neq("sender", "customer").ilike("text", "%からはよろしく%").limit(1000);
  const convs = [...new Set((seeds ?? []).map((s) => s.conversation_id as string))];
  let staffN = 0, hit = 0; const shown: string[] = [];
  for (const cid of convs) {
    const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", cid).order("created_at").limit(2000);
    const staff = (ms ?? []).filter((m) => m.sender !== "customer");
    for (let i = 0; i < staff.length; i++) {
      const prev = staff.slice(Math.max(0, i - 6), i).map((m) => m.text);
      if (!prev.some((t) => VIEWING_FIXED_STAFF_RE.test(String(t ?? "")))) continue;
      staffN++;
      const h = findViewingDateReask(staff[i].text, prev);
      if (!h) continue;
      hit++;
      if (shown.length < 15) shown.push(`[${h}] ${String(staff[i].text).replace(/\n/g, " ").slice(0, 120)}`);
    }
  }
  console.log(`日時が決まった後のスタッフの送信 ${staffN}（会話 ${convs.length}）: 日にちを聞いた文 ${hit}`);
  for (const s of shown) console.log("  ", s);
})();
