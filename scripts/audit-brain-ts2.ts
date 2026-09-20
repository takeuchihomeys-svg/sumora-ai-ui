// source=brain なのに analyzed_msg_ts が無いのは「今も起きている」のか（読み取りのみ）
// 2026-09-20 竹内「ブレインの判断通りにうごくか」
//   brain-core は analyzed_msg_ts = lastCustomerMsg?.created_at ?? null で書く。
//   ＝ **お客様の発言が1件も無い会話**では正当に null になる。
//   それ以外（お客様の発言があるのに null）なら今も起きている穴。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data } = await sb.from("conversations")
    .select("id, customer_name, status, suggested_aix_meta, brain_analyzed_at, updated_at")
    .order("updated_at", { ascending: false }).limit(400);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

  const target = rows.filter((r) => {
    const s = r.suggested_aix_meta as Record<string, unknown> | null;
    return s && typeof s === "object" && !s.analyzed_msg_ts;
  });
  console.log(`=== suggested_aix_meta があるのに analyzed_msg_ts が無い: ${target.length}件 ===\n`);

  // 形で分ける（古い残骸か・今の形か）
  const oldShape = target.filter((r) => {
    const s = r.suggested_aix_meta as Record<string, unknown>;
    return "phase_hint" in s || "is_hot" in s;
  });
  const nowShape = target.filter((r) => !oldShape.includes(r));
  console.log(`  古い形（phase_hint / is_hot を持つ＝今のコードに無い項目）: ${oldShape.length}件`);
  console.log(`  今の形                                                 : ${nowShape.length}件\n`);

  // 今の形のものに、お客様の発言があるか
  const ids = nowShape.map((r) => String(r.id));
  const custCount = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 40) {
    const { data: ms } = await sb.from("messages").select("conversation_id")
      .in("conversation_id", ids.slice(i, i + 40)).eq("sender", "customer");
    for (const m of ((ms ?? []) as Array<{ conversation_id: string }>)) {
      custCount.set(m.conversation_id, (custCount.get(m.conversation_id) ?? 0) + 1);
    }
  }
  const noCust = nowShape.filter((r) => (custCount.get(String(r.id)) ?? 0) === 0);
  const withCust = nowShape.filter((r) => (custCount.get(String(r.id)) ?? 0) > 0);
  console.log(`  今の形 ${nowShape.length}件の内訳`);
  console.log(`    お客様の発言が0件（null は**正当**・まだ誰も何も言っていない）: ${noCust.length}件`);
  console.log(`    お客様の発言がある（**今も起きている穴**）                   : ${withCust.length}件`);
  for (const r of withCust.slice(0, 10)) {
    const s = r.suggested_aix_meta as Record<string, unknown>;
    console.log(`      ${r.customer_name} [${r.status}] source=${s.source ?? "-"} action=${String(s.action ?? "-").slice(0, 30)} 発言${custCount.get(String(r.id))}件 分析=${String(r.brain_analyzed_at ?? "-").slice(0, 16)}`);
  }

  // 古い形はいつのものか
  if (oldShape.length) {
    const dates = oldShape.map((r) => String(r.updated_at ?? "")).filter(Boolean).sort();
    console.log(`\n  古い形の更新時刻: ${dates[0]?.slice(0, 10)} 〜 ${dates[dates.length - 1]?.slice(0, 10)}`);
    console.log(`    → 今のコードに phase_hint / is_hot を書く場所は無い（grep 0件）＝過去の残骸`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
