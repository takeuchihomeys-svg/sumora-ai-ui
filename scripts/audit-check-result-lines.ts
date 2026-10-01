// scripts/audit-check-result-lines.ts — AIX【物件確認した】の1通目（定型）の行を、スタッフが残したか消したか（場面別）で数える（読むだけ）
// 2026-10-01 竹内「見積書や他のよく使うAIXテンプレートの部分も改善する」: 定型の行（引き続き…探させて／申込誘導／ご査収）の線を引く
// 実行: npx tsx --env-file=.env.local scripts/audit-check-result-lines.ts
import { createClient } from "@supabase/supabase-js";
import { loadAixPairs } from "./aix-pairs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const { pairs } = await loadAixPairs(sb, "property_check_result", new Date(Date.now() - 365 * 86400_000).toISOString());
  const P = pairs.filter((p) => p.firstOrigin === "edited" || p.firstOrigin === "as_is");
  const allEnded = (d: string) => /現在募集に出ていないお部屋となっております/.test(d) && !/募集中/.test(d);
  const groups: Array<[string, (d: string) => boolean]> = [["全部募集終了の定型", allEnded], ["一部募集終了（他N件）", (d) => /他\d+件は/.test(d)], ["それ以外", (d) => !allEnded(d) && !/他\d+件は/.test(d)]];
  const lines: Array<[string, RegExp]> = [["引き続き…探させて", /引き続き条件に合うお部屋を探/], ["引き続き…ピックアップしてお送り", /ご条件に合ったお部屋をピックアップしてお送りさせて頂きます/], ["申込誘導", /お気に召されましたらお申込みしお部屋を?抑え/], ["ご査収", /ご査収/], ["最大限割引しました…同封", /最大限割引しました(?:初期費用)?御見積書同封/]];
  for (const [g, f] of groups) {
    const xs = P.filter((p) => f(p.firstDraft));
    console.log(`\n== ${g}: ${xs.length}組`);
    for (const [k, re] of lines) {
      const inD = xs.filter((p) => re.test(p.firstDraft)); const kept = inD.filter((p) => re.test(p.first));
      const added = xs.filter((p) => !re.test(p.firstDraft) && re.test(p.first));
      console.log(`  ${k}: 下書き ${inD.length} → 残 ${kept.length}・消 ${inD.length - kept.length} ／ 足した ${added.length}`);
    }
  }
  // 1件・空室・見積書同封（締め無しで終わる下書き）: スタッフはご査収を足したか
  const single = P.filter((p) => /御見積書同封させて頂きました！！\s*$/.test(p.firstDraft.trim()));
  console.log(`\n== 下書きが「…御見積書同封させて頂きました！！」で終わる ${single.length}組: 送った文がご査収/ご確認で終わる ${single.filter((p) => /(?:ご査収|ご確認)[^\n]{0,10}$/.test(p.first.trim())).length}・同封の行のまま ${single.filter((p) => /同封させて頂きました！！\s*$/.test(p.first.trim())).length}`);
  for (const p of single.slice(-8)) console.log("   … " + p.first.trim().split("\n").slice(-2).join(" ⏎ ").replace(/[^\s、。！!\n]{1,10}さん/g, "〈名〉さん"));
  // 退去予定の1件の定型（申込誘導で終わる）
  const vac = P.filter((p) => /退去予定/.test(p.firstDraft) && /お気に召されましたらお申込みしお部屋を抑えさせていただきます！！\s*$/.test(p.firstDraft.trim()));
  console.log(`\n== 退去予定の1件の定型（申込誘導で終わる） ${vac.length}組: 申込を残した ${vac.filter((p) => /お申込みしお部屋を?抑え/.test(p.first)).length}・ご査収で終わる ${vac.filter((p) => /ご査収[^\n]{0,8}$/.test(p.first.trim())).length}`);
  for (const p of vac.slice(-8)) console.log("   … " + p.first.trim().split("\n").slice(-3).join(" ⏎ ").replace(/[^\s、。！!\n]{1,10}さん/g, "〈名〉さん"));
})();
