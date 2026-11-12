// scripts/w21-peek-msg.ts — 作業員21（夜の読み）: 会話id8/通id8 から始まるスタッフの番と、直前のお客様の通を手元で読む（読むだけ・LLM なし・外に出さない）
// 実行: npx tsx --env-file=.env.local scripts/w21-peek-msg.ts [--grep=<正規表現>] <conv8/msg8> ...
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const g = process.argv.find((a) => a.startsWith("--grep="))?.slice(7);
const re = g ? new RegExp(g) : null;
(async () => {
  for (const ref of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
    const [c8, m8] = ref.split("/");
    const { data: convs } = await sb.from("conversations").select("id").gte("id", c8).lt("id", c8 + "g").limit(2);
    const cid = convs?.[0]?.id; if (!cid) { console.log(ref, "会話なし"); continue; }
    const { data: ms } = await sb.from("messages").select("id, sender, created_at, text, staff_writer, is_aix_generated").eq("conversation_id", cid).order("created_at").limit(4000);
    const list = (ms ?? []) as any[]; const i = list.findIndex((m) => String(m.id).startsWith(m8));
    console.log(`=== ${ref}`);
    for (let k = i - 1, n = 0; k >= 0 && n < 2 && list[k].sender === "customer"; k--, n++) console.log(`  [客] ${String(list[k].text ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    for (let k = i; k < list.length && list[k].sender !== "customer"; k++) {
      const t = String(list[k].text ?? "").replace(/\s+/g, " ");
      const shown = re ? (t.split(/(?<=[。！!？?])/).filter((s) => re.test(s)).join(" ") || "(該当なし)") : t;
      console.log(`  [${list[k].staff_writer ?? "?"}${list[k].is_aix_generated ? ":AIX" : ""}] ${shown.slice(0, 260)}`);
    }
  }
})();
