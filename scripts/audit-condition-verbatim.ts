// 物件ピックアップ（AIX property_send）の文が、希望条件の欄の文字をそのまま使っているかを数え、出口 restoreConditionDots の前後を目で読む（読み取りのみ）。
// 2026-09-27 竹内さん「物件の資料の中の文字変えなくても…そのまま使う・文字抜かなくて」（YUMA 9/27: 「バストイレ別・オートロック」→「バストイレ別オートロック」・
//   「間取り: 1K、1DK、1LDK」→「1K」だけ）。材料: aix_generate_log の property_send 全件（生成した文＋その時の希望条件 conditions_snapshot.customer_conditions）。
//   ①中黒の復元: 当たった件数・前後・誤削除0（「・」を全部消すと前後で同じ文）の確認
//   ②間取りの並び: 希望の間取りが2つ以上の時に、文に書いた間取りが並びの一部だけだった件数（入口の直しの前の頻度）
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-verbatim.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { restoreConditionDots, desiredLayoutField, extractLayouts } from "../app/lib/pickup-send-facts";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").split("=")[1]);
async function main() {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows: any[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("aix_generate_log").select("created_at, conversation_id, generated_text, conditions_snapshot")
      .eq("action_type", "property_send").gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); return; }
    rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  let withCond = 0, dotItems = 0, restored = 0, bad = 0, multi = 0, subset = 0, full = 0, none = 0;
  const shows: string[] = [], subsetShows: string[] = [];
  for (const r of rows) {
    const cond = r.conditions_snapshot?.customer_conditions as string | undefined;
    const text = String(r.generated_text ?? "");
    if (!cond || !text) continue;
    withCond++;
    if (/[^、,\n]・[^、,\n]/.test(cond.split("\n").filter((l) => /^(?:希望|設備|こだわり|その他)/.test(l)).join("\n"))) dotItems++;
    const out = restoreConditionDots(text, cond);
    if (out.restored.length) {
      restored++;
      if (out.text.replace(/・/g, "") !== text.replace(/・/g, "")) bad++;
      if (shows.length < 15) shows.push(`--- ${r.created_at.slice(0, 16)} ${String(r.conversation_id).slice(0, 8)} 戻した: ${out.restored.join(" / ")}\n前: ${text.split("\n").find((l) => /ピックアップ|募集に/.test(l))}\n後: ${out.text.split("\n").find((l) => /ピックアップ|募集に/.test(l))}`);
    }
    const d = desiredLayoutField(cond);
    if (d && d.layouts.length >= 2) {
      multi++;
      const line = text.split("\n").find((l) => /ピックアップ|募集に/.test(l)) ?? "";
      const got = extractLayouts(line).filter((l) => d.layouts.includes(l));
      if (got.length === 0) none++;
      else if (got.length < d.layouts.length) { subset++; if (subsetShows.length < 10) subsetShows.push(`--- ${r.created_at.slice(0, 16)} 希望「${d.raw}」→ 文: ${line.slice(0, 120)}`); }
      else full++;
    }
  }
  console.log({ days, rows: rows.length, withCond, condHasDotItem: dotItems, restored, wrongDeletion: bad, multiLayoutWish: multi, wroteAll: full, wroteSubset: subset, wroteNoLayout: none });
  console.log("\n== 中黒の復元（前後） =="); shows.forEach((s) => console.log(s));
  console.log("\n== 希望の間取りの並びの一部だけを書いた文（入口の直しの前） =="); subsetShows.forEach((s) => console.log(s));
}
main();
