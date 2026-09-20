// YUMA の本番生成で気になった言い回しを実送信で確かめる（読み取りのみ）
// 2026-09-20 竹内「YUMAで一通りおくって…実際のスタッフが送ってるような言い回しになるのか」
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const CHECKS: Array<{ id: string; re: RegExp; note: string }> = [
  { id: "③「ご都合よろしいお日にち御座いますでしょうか」", re: /ご都合(?:の)?よろしい(?:お日にち|日)[^\n]{0,16}(?:御座います|ございます|ありますでしょうか)/,
    note: "設計知見: n=51 の96%が具体日時とセット・47/51 が aix=viewing_invite ＝ AIX【内覧日調整】専用" },
  { id: "⑤「お申込みのご意思承りました」", re: /お?申込(?:み)?(?:の)?ご意思[^\n]{0,8}(?:承り|受け|頂き)/,
    note: "AI が作った言い方か、スタッフも使うか" },
  { id: "⑤（参考）「お申込みさせていただきます」", re: /お?申込(?:み)?(?:さ|し)せて(?:頂|いただ)きます/,
    note: "スタッフの正解形（前回の調査）" },
  { id: "⑤（参考）「承りました」単体", re: /承りました/, note: "" },
  { id: "②「初期費用確認させて頂きます」", re: /初期費用[^\n]{0,8}確認(?:させて(?:頂|いただ)き|いたし|致し)ます/,
    note: "物件が無い費用の質問への答え方" },
  { id: "②（参考）費用の質問に物件ピックアップを添える", re: /初期費用[^\n]{0,30}確認[\s\S]{0,80}ピックアップ/,
    note: "2つの宣言を並べていないか" },
];

async function main() {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const sent: string[] = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) { const t = String(x.text ?? ""); if (t) sent.push(t); }
    if (r.length < 1000) break;
  }
  // AIX で送った物（aix_usage_logs）とも突き合わせる
  const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, generated_text").gte("created_at", since).limit(3000);
  const aix = (ax ?? []) as unknown as Array<Record<string, unknown>>;

  console.log(`=== 実送信 ${sent.length}通 / AIX ${aix.length}件（365日）===\n`);
  for (const c of CHECKS) {
    const hit = sent.filter((t) => c.re.test(t));
    const aixHit = aix.filter((a) => c.re.test(String(a.generated_text ?? "")));
    const byType = new Map<string, number>();
    for (const a of aixHit) byType.set(String(a.aix_type ?? "?"), (byType.get(String(a.aix_type ?? "?")) ?? 0) + 1);
    console.log(`${c.id}`);
    console.log(`   実送信 ${hit.length}通 / AIX 本文 ${aixHit.length}件`);
    if (byType.size) console.log(`   AIX の種類: ${[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" / ")}`);
    if (c.note) console.log(`   ${c.note}`);
    for (const h of hit.slice(0, 3)) console.log(`     例: ${h.replace(/\n/g, " ").slice(0, 90)}`);
    console.log("");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
