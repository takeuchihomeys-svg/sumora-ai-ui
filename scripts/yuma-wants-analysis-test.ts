// YUMA で「希望（条件欄＋会話＋訴求点）を1つずつ画像で判定する」強化版の分析を DeepSeek で通す
// 2026-09-24 竹内「希望条件や NG 条件の細かい部分も画像から判断できているか。会話や物件オススメの訴求点から抜けている部分を入れる。テストは YUMA で DeepSeek」
//   ① 本番と同じ loadImageWants で YUMA の会話から何が拾えるかを見る
//   ② 画面の例（WIC 付き・ペット可NG[必須]・西天満より北 NG）＋会話で出てくる言い回し＋訴求点で、YUMA のピックアップ3件を判定
// 実行: npx tsx --env-file=.env.local scripts/yuma-wants-analysis-test.ts
import { createClient } from "@supabase/supabase-js";
import { loadImageWants } from "../app/lib/image-wants-server";
import { extractImageWants, wantsToText } from "../app/lib/image-wants";
import { analyzePickupImage, pickBest } from "../app/lib/pickup-image-analysis";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const MARK: Record<string, string> = { ok: "◎", ng: "×", unknown: "？" };

async function main() {
  const fromYuma = await loadImageWants({ conversationId: YUMA, propertyCustomerId: null });
  console.log(`① YUMA の会話（120日）から拾えた希望 ${fromYuma.length}件:`);
  fromYuma.forEach((w) => console.log(`   ${w.id} ${w.source} ${w.text}`));

  const wants = extractImageWants({
    conditions: { preferences: "WIC（ウォークインクローゼット）付き", ng_points: "西天満より北のエリア・ペット可NG[必須]", other_requests: null, additional_conditions: null },
    customerMessages: [
      { text: "食事するリビングと寝室は生活空間を分けたいです", created_at: "2026-09-22" },
      { text: "洋室が小さいのは嫌なので、もう少し余裕あるところがいいです", created_at: "2026-09-21" },
      { text: "お風呂とトイレは別でお願いします", created_at: "2026-09-20" },
      { text: "料理するので対面キッチンだと嬉しいです", created_at: "2026-09-19" },
    ],
    sellingPoints: ["敷礼0円", "角部屋", "バストイレ別", "広告料2ヶ月以上"],
    mask: (s) => s,
  });
  console.log(`\n② 判定に使う希望 ${wants.length}件:\n${wantsToText(wants).split("\n").map((l) => "   " + l).join("\n")}`);

  const { data } = await sb.from("property_pickups").select("id, rank, property_name, trim_image_url").eq("conversation_id", YUMA).like("batch_id", "YUMA_%").order("rank");
  const rows = await Promise.all(((data ?? []) as Array<{ id: number; rank: number; property_name: string; trim_image_url: string }>).map(async (r) => {
    const t = Date.now();
    const out = await analyzePickupImage(r.trim_image_url, wants);
    if (out.analysis) await sb.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id);
    return { ...r, ms: Date.now() - t, model: out.model, analysis: out.analysis };
  }));
  for (const r of rows.sort((a, z) => a.rank - z.rank)) {
    const a = r.analysis;
    console.log(`\n【${r.rank}】${r.property_name}  ${r.ms}ms model=${r.model ?? "-"}  ${a ? `${a.match ?? "-"}点` : "読めなかった"}`);
    if (!a) continue;
    for (const w of wants) {
      const c = a.checks.find((x) => x.id === w.id);
      console.log(`   ${MARK[c?.result ?? "unknown"]} ${w.id} ${w.text}（${w.source}${w.ng ? "・NG" : ""}${w.must ? "・必須" : ""}）${c?.why ? ` — ${c.why}` : ""}`);
    }
  }
  const best = pickBest(rows);
  console.log(`\n👑 一番条件に合う: ${best ? `【${best.rank}】${best.property_name}（${best.analysis?.match}点）` : "（決められない）"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
