// 引用された画像を実際に読んで、「お客様の質問に答えられるか」を目で確かめる
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるように」
// 実行: npx tsx --env-file=.env.local scripts/verify-quoted-image-detail.ts [--n=10] [--days=30]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImageDetail } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const N = Number(arg("n", "10"));
const DAYS = Number(arg("days", "30"));
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

type Msg = { id: number | string; conversation_id: string; sender: string; text: string | null; image_url: string | null; line_message_id: string | null; quoted_message_id: string | null; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data: q } = await sb.from("messages")
    .select("id, conversation_id, sender, text, image_url, line_message_id, quoted_message_id, created_at")
    .eq("sender", "customer").not("quoted_message_id", "is", null).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(200);
  const quoting = (q ?? []) as Msg[];
  const ids = [...new Set(quoting.map((m) => m.quoted_message_id!))];
  const targets = new Map<string, Msg>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("messages")
      .select("id, conversation_id, sender, text, image_url, line_message_id, quoted_message_id, created_at")
      .in("line_message_id", ids.slice(i, i + 100));
    for (const r of (data ?? []) as Msg[]) if (r.line_message_id) targets.set(r.line_message_id, r);
  }
  const isImageText = (t: string | null) => !t || /^\s*\[(?:画像|動画)\]\s*$/.test(t);
  const cases = quoting.filter((m) => {
    const t = targets.get(m.quoted_message_id!);
    return !!t && t.sender === "staff" && !!t.image_url && isImageText(t.text);
  }).slice(0, N);

  let okKind = 0, totalIn = 0, totalOut = 0, msSum = 0;
  for (const m of cases) {
    const t = targets.get(m.quoted_message_id!)!;
    const t0 = Date.now();
    const d = await readPropertyImageDetail(t.image_url!, { timeoutMs: Number(arg("timeout", "60000")) });
    const ms = Date.now() - t0; msSum += ms;
    totalIn += d.usage?.input ?? 0; totalOut += d.usage?.output ?? 0;
    if (d.kind === "property" && d.lines.length > 0) okKind++;
    // その後のスタッフの実送信（比較用）
    const { data: rep } = await sb.from("messages").select("text, created_at")
      .eq("conversation_id", m.conversation_id).eq("sender", "staff")
      .gt("created_at", m.created_at).order("created_at", { ascending: true }).limit(1);
    const reply = (rep ?? [])[0] as { text: string | null } | undefined;
    console.log("═".repeat(78));
    console.log(`${m.created_at.slice(0, 16)}  kind=${d.kind}  ${ms}ms  in=${d.usage?.input ?? 0}/out=${d.usage?.output ?? 0}`);
    console.log(`お客様: ${mask(String(m.text ?? "")).replace(/\n/g, " ／ ").slice(0, 90)}`);
    console.log(`読み取り:`);
    for (const l of d.lines) console.log(`   ・${l}`);
    if (d.lines.length === 0) console.log(`   （なし）raw=${d.raw.slice(0, 120)}`);
    console.log(`実送信 : ${reply ? mask(String(reply.text ?? "")).replace(/\n/g, " ／ ").slice(0, 120) : "（なし）"}`);
  }
  console.log("═".repeat(78));
  const n = cases.length || 1;
  console.log(`物件の資料として読めた: ${okKind} / ${cases.length}`);
  console.log(`平均 ${Math.round(msSum / n)}ms  入力${Math.round(totalIn / n)} / 出力${Math.round(totalOut / n)} トークン`);
  // DeepSeek 公式価格（$0.28/M in, $0.42/M out 相当で概算）
  const cost = (totalIn / 1e6) * 0.28 + (totalOut / 1e6) * 0.42;
  console.log(`この ${cases.length}枚で約 $${cost.toFixed(4)}（1.2枚/日なら月 $${((cost / n) * 36).toFixed(2)}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
