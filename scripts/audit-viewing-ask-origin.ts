// 「ご都合よろしいお日にち御座いますでしょうか」は誰が送っているのか（読み取りのみ）
//
// 2026-09-20 竹内「AIX から返信する部分は AIX からスタッフが送るから大丈夫／②や⑤の部分等は AIX から」
//   VI_POSITIVE から外したのに YUMA ③で再発した。生成文は AIX_ACTION_REPLY_DIRECTION.viewing_invite.weDo と
//   一字一句同じ:「かしこまりました！！ご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます！！」
//
// 出所を決める前に **実送信で線を引く**（設計知見）:
//   ① この文は実送信に何通あるか
//   ② そのうち何通が AIX 由来（is_aix_generated）か ← 竹内さんの「AIX から送る」の裏取り
//   ③ 直前の生成で選ばれたセル（reply_context_snapshot.turnPair.ruleId）は何か
import { createClient } from "@supabase/supabase-js";
import { AIX_ACTION_REPLY_DIRECTION } from "../app/lib/aix-taxonomy";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const ASK_RE = /ご都合[^\n]{0,12}(?:お日にち|日程)[^\n]{0,12}(?:御座|ござ)いますでしょうか/;

async function main() {
  console.log(`=== ① 実送信での出現と、その出所（AIX か手打ちか）===`);
  const rows: Array<{ text: string | null; is_aix_generated: boolean | null; created_at: string; conversation_id: string }> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("messages").select("text, is_aix_generated, created_at, conversation_id")
      .eq("sender", "staff").gte("created_at", new Date(Date.now() - 180 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  const hit = rows.filter((r) => ASK_RE.test(r.text ?? ""));
  const aix = hit.filter((r) => r.is_aix_generated === true).length;
  console.log(`   スタッフ送信 ${rows.length}通中 この文を含む: ${hit.length}通`);
  console.log(`     うち AIX 由来（is_aix_generated=true）: ${aix}通`);
  console.log(`     うち 手打ち・通常返信                 : ${hit.length - aix}通`);
  console.log(`   → 竹内「この部分は AIX から送る」の裏取り: AIX 由来が ${hit.length ? ((aix / hit.length) * 100).toFixed(1) : "-"}%\n`);

  // 手打ち側の実物を読む（AIX でないのに送っているなら、それは通常返信でも許される形）
  console.log(`   --- AIX 由来でない実送信（最大8件・目で読む）---`);
  for (const r of hit.filter((x) => x.is_aix_generated !== true).slice(0, 8)) {
    console.log(`     ${r.created_at.slice(0, 10)} ${(r.text ?? "").replace(/\n/g, " ／ ").slice(0, 100)}`);
  }

  console.log(`\n=== ② weDo との一致（生成文がこれを引き写していないか）===`);
  const weDo = AIX_ACTION_REPLY_DIRECTION.viewing_invite.weDo;
  console.log(`   viewing_invite.weDo : 「${weDo}」`);
  console.log(`   この weDo は ASK_RE に当たるか: ${ASK_RE.test(weDo)}`);
  console.log(`   forbid              : ${AIX_ACTION_REPLY_DIRECTION.viewing_invite.forbid}`);
  console.log(`   → weDo に日程を聞く疑問形が入っている限り、推奨アクション行がこの文を手本として見せる`);

  console.log(`\n=== ③ YUMA の直前の生成で選ばれたセル ===`);
  const { data: snap, error } = await sb.from("conversations")
    .select("reply_context_snapshot, ai_draft, updated_at").eq("id", YUMA).maybeSingle();
  if (error) console.log(`   ⚠ ${error.message}`);
  const s = (snap ?? {}) as Record<string, unknown>;
  const rc = s.reply_context_snapshot as Record<string, unknown> | null;
  if (rc) {
    const tp = rc.turnPair as Record<string, unknown> | null;
    console.log(`   turnPair.ruleId : ${tp?.ruleId ?? "(なし)"}`);
    console.log(`   tier            : ${JSON.stringify(rc.tier ?? rc.brainTier ?? null)}`);
    console.log(`   positive.kind   : ${JSON.stringify((rc.positive as Record<string, unknown> | null)?.kind ?? null)}`);
    console.log(`   keys            : ${Object.keys(rc).join(", ")}`);
  } else console.log(`   reply_context_snapshot: なし`);
  console.log(`   ai_draft: ${String(s.ai_draft ?? "").replace(/\n/g, " ／ ").slice(0, 120)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
