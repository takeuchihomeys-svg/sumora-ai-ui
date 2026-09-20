// 申込の後、スタッフは「会話の外で分かった事実」をどれだけ書いているか（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？実際スタッフが送る返信を生成する為にも」
//
// 設計知見「【汎用】会話の外で分かった事実（対面・電話）は会話ログから推測させない —
//   その場にいた人が既にある操作の流れで1欄だけ書き、全ての判断者に同じ関数で渡す」
// 内覧には viewing_report（内覧に行ったスタッフが分かったこと）がある。申込・審査にはあるか？
//
// 申込後のスタッフ返信の実例:
//   「無事1番手にてお申込み完了しております！！ 保証会社より本人確認のお電話がございます」
//   「管理会社に確認させていただき、息子様での代理契約可能とのご返答」
//   「オリコフォレントインシュアで否決となった場合は別の保証会社での審査」
// どれも**会話には書かれていない事実**（管理会社・保証会社との電話）。
// AI はこれを書けない＝この場面の返信は生成できない。どれだけの割合かを数える。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 会話の外で分かった事実（管理会社・保証会社・審査の結果） */
const OUTSIDE_FACT: Array<{ id: string; re: RegExp }> = [
  { id: "番手（1番手・2番手・繰り上がり）", re: /[０-９0-9一二]番手|繰り上が/ },
  { id: "審査の結果・進捗", re: /審査[^\n]{0,8}(?:通過|否決|結果|進捗|開始|中|状況)|承認(?:完了|下り)|否決/ },
  { id: "管理会社・オーナーの回答", re: /管理会社(?:より|から|に確認)[^\n]{0,20}(?:とのこと|ご返答|回答|連絡)|オーナー(?:より|から)/ },
  { id: "保証会社の動き", re: /保証会社(?:より|から)[^\n]{0,16}(?:お電話|連絡|審査|確認)/ },
  { id: "入居可能日・退去日の確定", re: /(?:入居可能日|退去(?:予定)?日)[^\n]{0,12}(?:確定|決定|とのこと)/ },
  { id: "契約・書類の手続き", re: /レターパック|重要事項説明|契約書[^\n]{0,8}(?:お送り|ご返送)|初期費用[^\n]{0,8}お振込/ },
];

async function main() {
  const days = Number(process.env.DAYS ?? 90);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data: convs } = await sb.from("conversations").select("id, status, is_post_apply").limit(6000);
  const convRows = (convs ?? []) as Array<{ id: string; status: string | null; is_post_apply: boolean | null }>;
  const postApply = new Set(convRows.filter((c) => c.is_post_apply === true
    || ["applying", "screening", "contract", "closed_won"].includes(String(c.status))).map((c) => c.id));
  console.log(`=== 申込以降の会話: ${postApply.size}件 / 全 ${convRows.length}件 ===\n`);

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 24; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }

  const staffPost = msgs.filter((m) => m.sender === "staff" && m.text && postApply.has(m.conversation_id));
  const staffAll = msgs.filter((m) => m.sender === "staff" && m.text);
  console.log(`直近${days}日のスタッフ送信: 全 ${staffAll.length}通 ／ 申込以降の会話 ${staffPost.length}通\n`);

  console.log(`${"会話の外で分かった事実".padEnd(34)} 申込以降 / 全体`);
  console.log("─".repeat(62));
  let anyPost = 0;
  const seen = new Set<string>();
  for (const f of OUTSIDE_FACT) {
    const a = staffPost.filter((m) => f.re.test(m.text ?? ""));
    const b = staffAll.filter((m) => f.re.test(m.text ?? ""));
    for (const m of a) { const k = `${m.conversation_id}|${m.created_at}`; if (!seen.has(k)) { seen.add(k); anyPost++; } }
    const pa = staffPost.length ? ((a.length / staffPost.length) * 100).toFixed(1) : "-";
    console.log(`${f.id.padEnd(34)} ${String(a.length).padStart(4)} (${pa}%) / ${String(b.length).padStart(4)}`);
    for (const m of a.slice(0, 2)) console.log(`      ${(m.text ?? "").replace(/\n/g, " ").slice(0, 88)}`);
  }
  const pAny = staffPost.length ? ((anyPost / staffPost.length) * 100).toFixed(1) : "-";
  console.log(`\n=== 申込以降のスタッフ送信 ${staffPost.length}通 のうち、会話の外の事実を含む: **${anyPost}通（${pAny}%）** ===`);
  console.log(`  → この割合の返信は、会話ログだけからは書けない（材料がどこにも無い）`);

  // 参考: 申込以降の会話で AI 下書きがどれだけ使われているか
  const { data: ex } = await sb.from("ai_reply_examples")
    .select("conversation_id, was_ai_used, ai_similarity, conversation_state, created_at")
    .gte("created_at", since).limit(4000);
  const exRows = ((ex ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((r) => postApply.has(String(r.conversation_id)));
  const used = exRows.filter((r) => r.was_ai_used === true).length;
  console.log(`\n=== 申込以降の会話での AI 下書き ${exRows.length}件 ===`);
  console.log(`  そのまま送信: ${used}件（${exRows.length ? ((used / exRows.length) * 100).toFixed(1) : "-"}%）`);
  const allUsed = ((ex ?? []) as unknown as Array<Record<string, unknown>>).filter((r) => r.was_ai_used === true).length;
  const allN = ((ex ?? []) as unknown as Array<Record<string, unknown>>).length;
  console.log(`  （全体では ${allUsed}/${allN} = ${allN ? ((allUsed / allN) * 100).toFixed(1) : "-"}%）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
