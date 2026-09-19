// scripts/audit-viewing-thanks.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-thanks.ts
//
// 2026-09-19 竹内（慶次事例）。実行前提語ゲートに足した viewing_thanks（内覧が完了した前提のお礼）を
// **スタッフの実送信全件**に当てて、誤削除が出ないかを数える（設計知見「落とす仕組みは過去の全件に当てる」）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const RE = /(?:本日|先日|昨日)[^\n。！!]{0,8}(?:ご内覧|内覧|ご見学|お時間)[^\n。！!]{0,10}(?:頂き|いただき|くださり|下さり)[^\n。！!]{0,8}(?:ありがとう|有難う)/;

async function main() {
  // ① 実送信で当たる文
  let from = 0; const size = 1000; const hits: Array<{ conv: string; text: string; at: string }> = [];
  let total = 0;
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("conversation_id, text, created_at").neq("sender", "customer").not("text", "is", null)
      .range(from, from + size - 1);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    for (const m of data) {
      const t = String(m.text ?? ""); if (!t.trim()) continue; total++;
      if (RE.test(t)) hits.push({ conv: m.conversation_id as string, text: t, at: m.created_at as string });
    }
    if (data.length < size) break;
    from += size;
  }
  console.log(`=== 実送信 ${total}通中、当たる文: ${hits.length}通 ===\n`);

  // ② その時点までに「待ち合わせ案内」があったか（AIX meeting_place ＋ 本文の待ち合わせ）
  let grounded = 0; const ungrounded: typeof hits = [];
  for (const h of hits) {
    const { count: aixMeet } = await sb.from("aix_usage_logs")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", h.conv).eq("aix_type", "meeting_place").lte("created_at", h.at);
    // 緩めた線: 待ち合わせ **または 内覧の打診**（その会話で内覧の話が一度でも出ているか）
    const { count: aixViewing } = await sb.from("aix_usage_logs")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", h.conv).in("aix_type", ["viewing_invite", "meeting_place", "greeting_viewing"]).lte("created_at", h.at);
    let ok = (aixMeet ?? 0) > 0 || (aixViewing ?? 0) > 0;
    if (!ok) {
      const { data: mm } = await sb.from("messages")
        .select("text").eq("conversation_id", h.conv).lt("created_at", h.at)
        .order("created_at", { ascending: false }).limit(60);
      ok = (mm ?? []).some((x) => /待ち合わせ|待合せ|現地エントランス|現地集合|ご内覧|内覧|内見|ご案内可能|ご来店|来店/.test(String(x.text ?? "")));
    }
    if (ok) grounded++; else ungrounded.push(h);
  }
  console.log(`  待ち合わせの証拠あり（落とさない）: ${grounded}通`);
  console.log(`  **証拠なし（落としてしまう＝誤削除の候補）: ${ungrounded.length}通**\n`);
  console.log("--- 証拠なしの実物（目で読む）---");
  for (const u of ungrounded.slice(0, 20)) {
    console.log(`  [${new Date(u.at).toLocaleDateString("ja-JP")}] ${u.text.replace(/\n/g, " / ").slice(0, 120)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
