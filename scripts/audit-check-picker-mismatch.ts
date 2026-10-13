// scripts/audit-check-picker-mismatch.ts — AIX【物件確認した】（物件あった）で、物件ごとのピッカー（申込あり／別の部屋／退去予定）と
//   下書きの文が食い違っていた件数を数え、今の直し（ensureAppliedTalk・1件の別の部屋の行）を当てた後に 0 になるかを見る（読むだけ）。
// 2026-10-13 竹内さん（未桜 10/09: 申込ありなのに「現在募集中のお部屋」だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-check-picker-mismatch.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { ensureAppliedTalk, findPickerTalkMismatch, alternativeSingleLine } from "../app/lib/check-result-status-lines";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]) || 30;

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: uses, error } = await sb.from("aix_usage_logs")
    .select("conversation_id, created_at, conversation_match, prop_statuses, property_names, generated_text")
    .eq("aix_type", "property_check_result").eq("check_pattern", "available").gte("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw error;
  let total = 0, before = 0, after = 0;
  for (const u of uses ?? []) {
    const st = (u.prop_statuses as string[] | null) ?? [];
    if (!st.length) continue;
    const { data: g } = await sb.from("aix_generate_log").select("generated_text")
      .eq("conversation_id", u.conversation_id).eq("action_type", "property_check_result").lte("created_at", u.created_at)
      .order("created_at", { ascending: false }).limit(1);
    const draft = (g?.[0]?.generated_text as string | undefined) ?? "";
    if (!draft) continue;
    total++;
    const names = (u.property_names as string[] | null) ?? [];
    const inp = { statuses: st, names, propertyCount: st.length };
    const miss = findPickerTalkMismatch(draft, inp);
    if (!miss) continue;
    before++;
    // 今の直し: ①1件の決まった文（会話を合わせるでない）で別の部屋 →「{建物} 別のお部屋ですが{号室}現在募集中となります！！」②申込ありの説明を足す
    let fixed = draft;
    if (!u.conversation_match && st.length === 1 && st[0] === "alternative" && names[0]) {
      fixed = fixed.replace(`${names[0]}現在募集中となります！！`, alternativeSingleLine(names[0]));
    }
    fixed = ensureAppliedTalk(fixed, inp).text;
    const still = findPickerTalkMismatch(fixed, inp);
    if (still) after++;
    console.log(`\n■ ${String(u.created_at).slice(0, 16)} ${u.conversation_match ? "会話を合わせる" : "決まった文"} ピッカー=${st.join(",")}\n  食い違い: ${miss}\n  直した後: ${still ?? "なし"}`);
    console.log("  下書き  : " + draft.split("\n").filter(Boolean).slice(0, 4).join(" ⏎ ").replace(/[^\s、。！!\n]{1,10}さん/g, "〈名〉さん"));
    console.log("  直した後: " + fixed.split("\n").filter(Boolean).slice(0, 5).join(" ⏎ ").replace(/[^\s、。！!\n]{1,10}さん/g, "〈名〉さん"));
    console.log("  送った文: " + String(u.generated_text ?? "").split("\n").filter(Boolean).slice(0, 4).join(" ⏎ ").replace(/[^\s、。！!\n]{1,10}さん/g, "〈名〉さん"));
  }
  console.log(`\n${days}日: 物件あった（ピッカー入り）${total}通 → 食い違い ${before}通 → 直した後 ${after}通`);
})();
