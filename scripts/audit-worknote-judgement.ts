// 判定メモの行（「9/22（火）14:20時点、直前に物件送付済み・見積は未送付、お客様は…の質問。これは事実確認質問だが、…断言は禁止」）を
// 落とす言い回しが、スタッフの実送信に当たらないかの監査（誤削除0の確認・読み取りのみ）
// 2026-09-22 YUMA の下書き1行目に入った（何卒・絵文字・約束の場面の確認中）
// 実行: npx tsx --env-file=.env.local scripts/audit-worknote-judgement.ts
import { createClient } from "@supabase/supabase-js";
import { hasCustomerFacingMarker } from "../app/lib/meta-narration";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const RES: Array<[string, RegExp]> = [
  ["〜は禁止", /(?:断言|記載|言及|生成|提示|約束)(?:は|を)?禁止/],
  ["これは〜質問だが", /これは[^\n。]{0,20}(?:質問|依頼|場面|返信|問い合わせ)(?:だが|です|である|であり)/],
  ["時点、〜送付済み／未送付", /時点[、,][^\n]{0,40}(?:送付済み|未送付)/],
];

async function main() {
  for (const [label, re] of RES) {
    let n = 0; const hit: string[] = [];
    for (const kw of ["%禁止%", "%これは%", "%時点%"]) {
      for (let p = 0; p < 30; p++) {
        const { data } = await sb.from("messages").select("text").eq("sender", "staff").ilike("text", kw).range(p * 1000, p * 1000 + 999);
        const r = (data ?? []) as Array<{ text: string | null }>;
        n += r.length;
        for (const x of r) for (const l of (x.text ?? "").split("\n")) if (re.test(l) && !hasCustomerFacingMarker(l)) hit.push(l.slice(0, 80));
        if (r.length < 1000) break;
      }
    }
    console.log(`${label}: スタッフ送信（語を含む）${n}通 ／ お客様への言葉の特徴が無い行で当たる ${hit.length}行`);
    for (const h of hit.slice(0, 5)) console.log("   ", h);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
