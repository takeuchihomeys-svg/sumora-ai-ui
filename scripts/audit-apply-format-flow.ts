// 申込フォーマットの流れを実データから学ぶ（読み取りのみ）
//
// 2026-09-20 竹内（S さん事例）
//   「申込情報は申込のフォーマットの部分となる」
//   「申込情報は AIX の申込へ からフォーマット送ってきた後にくるもの」
//   「申込以降はステータスが申込の状態なら返信生成しなくても良い」
//   「申込はフォーマットきまってるから それが申込情報やし
//     申込情報がどういう場面でおくられてるか流れ分かれば理解できる」
//
// 実物: status=viewing・is_post_apply=false・フォーマット未送付の会話で、
//   お客様「ありがとうございます！考えます(よろしく)」に対し
//   AI「はい！！ お申込み情報を確かに受け取りました😊！！ …」＝完全な捏造。
//   ブレインの方向は「感謝を受け取り検討を見守る姿勢で締める」で**正しかった**。
//
// ここで測る3つ:
//   ① 「申込情報を受け取った」型は実送信に何通あるか（出口を入れてよいかの線）
//   ② 申込フォーマットはどう送られ、お客様はどう返し、スタッフはどう応じるか（正しい流れ）
//   ③ 申込以降のステータスで返信生成がどれだけ起きているか（竹内「生成しなくても良い」）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 「申込の情報を受け取った」と述べる形（S さん・まりあさんに出た捏造） */
const APPLY_RECEIVED_RE =
  /お?申込(?:み)?(?:の)?(?:情報|内容)[^\n。！!]{0,12}(?:受け取り|受領|拝受|確かに|頂きました|いただきました)|お?申込(?:み)?情報[^\n。！!]{0,6}(?:を)?(?:確かに)?(?:受け取|受領|拝受)/;
/** 申込フォーマットの送付（AIX【申込へ】の定型文・【お申込者様記入欄】） */
const APPLY_FORMAT_SENT_RE =
  /お申込(?:み)?に必要な(?:ご)?情報となります|【お申込者様記入欄】|上記フォーマット(?:に)?ご?入力/;
/** お客様がフォーマットを記入して返した形 */
const APPLY_FORM_FILLED_RE =
  /【お申込者様記入欄】|(?:・|①)[^\n]{0,8}(?:入居希望日|氏名|フリガナ|生年月日)/;

async function grabStaff(days: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out: Array<{ t: string; at: string; conv: string }> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("messages").select("text, created_at, conversation_id")
      .eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) { const t = String(x.text ?? ""); if (t) out.push({ t, at: String(x.created_at), conv: String(x.conversation_id ?? "") }); }
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = 365;
  const sent = await grabStaff(days);
  console.log(`=== 実送信（スタッフ）${sent.length}通・${days}日 ===\n`);

  // ① 線を引く
  const recv = sent.filter((x) => APPLY_RECEIVED_RE.test(x.t));
  console.log(`① 「申込の情報を受け取った」型: **${recv.length}通**`);
  for (const r of recv.slice(0, 10)) console.log(`     [${r.at.slice(5, 16)}] ${r.t.replace(/\n/g, " ").slice(0, 100)}`);
  if (recv.length === 0) console.log(`     🟢 実送信0通 → 出口で落として誤削除0\n`);

  const fmt = sent.filter((x) => APPLY_FORMAT_SENT_RE.test(x.t));
  console.log(`\n② 申込フォーマットの送付: ${fmt.length}通`);
  for (const r of fmt.slice(0, 3)) console.log(`     [${r.at.slice(5, 16)}] ${r.t.replace(/\n/g, " ").slice(0, 110)}`);

  // ② 流れ: フォーマット送付 → お客様の返答 → スタッフの正解
  const convIds = [...new Set(fmt.map((x) => x.conv))].slice(0, 60);
  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated")
      .in("conversation_id", convIds.slice(i, i + 20)).order("created_at", { ascending: true });
    msgs.push(...((data ?? []) as typeof msgs));
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  console.log(`\n=== 申込フォーマットの流れ（会話 ${byConv.size}件）===`);
  let aixSent = 0, manualSent = 0, filled = 0, notFilled = 0;
  const answers: string[] = [];
  for (const [, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "staff" || !m.text || !APPLY_FORMAT_SENT_RE.test(m.text)) continue;
      if (m.is_aix_generated) aixSent++; else manualSent++;
      // 次のお客様発言
      const next = list.slice(i + 1).find((x) => x.sender === "customer" && x.text);
      if (!next?.text) continue;
      if (APPLY_FORM_FILLED_RE.test(next.text)) {
        filled++;
        // その後のスタッフの返答（＝正解）
        const idx = list.indexOf(next);
        const reply = list.slice(idx + 1).find((x) => x.sender === "staff" && x.text);
        if (reply?.text && answers.length < 12) answers.push(`   客（記入して返信）「${next.text.replace(/\n/g, " ").slice(0, 38)}」\n      店「${reply.text.replace(/\n/g, " ").slice(0, 88)}」`);
      } else notFilled++;
    }
  }
  console.log(`  フォーマットの送り方: AIX ${aixSent}通 / 手打ち ${manualSent}通`);
  console.log(`  その後お客様が記入して返した: ${filled}件 / それ以外の返答: ${notFilled}件`);
  console.log(`\n  --- ★ 記入が返ってきた時のスタッフの正解（これが「申込情報を受け取った」場面）---`);
  for (const a of answers) console.log(a);

  // ③ 申込以降のステータスで返信生成が起きているか
  const { data: convs } = await sb.from("conversations").select("id, status, is_post_apply").limit(6000);
  const cRows = (convs ?? []) as Array<{ id: string; status: string | null; is_post_apply: boolean | null }>;
  const postApply = new Set(cRows.filter((c) => c.is_post_apply === true
    || ["applying", "screening", "contract"].includes(String(c.status))).map((c) => c.id));
  const { data: ex } = await sb.from("ai_reply_examples")
    .select("conversation_id, was_ai_used, ai_similarity, created_at")
    .gte("created_at", new Date(Date.now() - 90 * 86400_000).toISOString()).limit(4000);
  const exRows = (ex ?? []) as unknown as Array<Record<string, unknown>>;
  const inPost = exRows.filter((r) => postApply.has(String(r.conversation_id)));
  const usedPost = inPost.filter((r) => r.was_ai_used === true).length;
  console.log(`\n③ 申込以降のステータスの会話: ${postApply.size}件`);
  console.log(`   そこでの返信生成（直近90日）: ${inPost.length}件 / 全 ${exRows.length}件`);
  console.log(`   そのまま送信: ${usedPost}件（${inPost.length ? ((usedPost / inPost.length) * 100).toFixed(1) : "-"}%）`);
  console.log(`   → 竹内「申込以降はステータスが申込の状態なら返信生成しなくても良い」の対象件数`);
}
main().catch((e) => { console.error(e); process.exit(1); });
