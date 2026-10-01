// scripts/audit-estimate-second.ts — AIX【見積書送る】の直後の2通目の検査（findEstimateSecondProblems）を、実送信の2通目全部に当てる（読むだけ）
//
// 2026-10-01 竹内「見積書や他のよく使うAIXテンプレートの部分も改善する」:
//   出口（作り直し1回）の線は「スタッフが書いた／直した2通目で当たる数」で引く。当たった文は全部目で読む。
//   ⚠ apply（申込の誘い）は竹内さんの決まり（見積書の後は申込へではない）で入れた検査で、スタッフが書いた2通目の 28% に当たる（実送信と決まりの食い違い・報告に残す）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-second.ts [--days=365] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { loadAixPairs, type Origin } from "./aix-pairs";
import { findEstimateSecondProblems, isEstimateCard, estimatePropertiesOf } from "../app/lib/estimate-second-message";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")) || 365;
const SHOW = Number(arg("show", "20"));
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const one = (s: string) => s.replace(/[^\s、。！!\n「」]{1,10}さん/g, "〈名〉さん").replace(/\n+/g, " ⏎ ");

async function main() {
  const { pairs } = await loadAixPairs(sb, "estimate_sheet", since);
  const seconds = pairs.filter((p) => p.second && p.secondOrigin);
  console.log(`== 見積書送る ${DAYS}日: 2通目 ${seconds.length}通（1通目が見積書の本体 ${pairs.filter((p) => isEstimateCard(p.first)).length}/${pairs.length}）`);
  const props = pairs.map((p) => estimatePropertiesOf(p.first).length);
  console.log(`   1通目の【物件】の数: 0件 ${props.filter((n) => n === 0).length}・1件 ${props.filter((n) => n === 1).length}・2件以上 ${props.filter((n) => n >= 2).length}`);
  for (const o of ["human", "edited", "as_is"] as Origin[]) {
    const xs = seconds.filter((p) => p.secondOrigin === o);
    const hits = xs.map((p) => ({ p, h: findEstimateSecondProblems(p.second, { closing: "receipt", first: p.first }) }));
    const by = (k: string) => hits.filter((x) => x.h.some((y) => y.key === k));
    console.log(`\n━━ ${o} ${xs.length}通: apply ${by("apply").length}・eval ${by("eval").length}・amount ${by("amount").length}・room ${by("room").length}`);
    for (const k of ["eval", "amount", "room", "apply"]) {
      for (const x of by(k).slice(0, k === "apply" ? 4 : SHOW)) console.log(`   [${k}] 「${x.h.find((y) => y.key === k)!.match}」 … ${one(x.p.second!).slice(0, 160)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
