// S6 改善前（今日のデプロイ前）の下書きが、会社の事実の質問にどう答えていたか（読み取りのみ）
//   今月の ai_reply_examples のうち customer_message が matchCompanyFacts に当たる物（画像の書き起こしは除く）を
//   事実ごとに「下書きが事実に沿って答えたか／反したか」「実送信はどうか」「そのまま送られたか」で数える。
//   → (a) の YUMA 再現（改善後）と並べる「前」の数字。
// 実行: npx tsx --env-file=.env.local scripts/audit-company-facts-drafts-before.ts
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SINCE = process.env.SINCE ?? "2026-08-31T15:00:00Z";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
type Ex = { conversation_id: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; aix_action: string | null; created_at: string; conversation_state: string | null };
const mask = (s: string) => s.replace(/https?:\/\/\S+/g, "[URL]").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/\s+/g, " ").trim();
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

const WANT: Record<string, RegExp> = {
  store: /(オンライン専門|店舗で(は|ではあり)|店舗では(無|な)|ご来社|来店.{0,8}(出来|でき)ない|事務所)/,
  viewing_method: /(オンライン(内見|内覧)|現地|ご案内|動画|写真)/,
  room_photo: /(撮影|お送り|送らせて|添付|室内(写真|イメージ|動画)|画像)/,
  apply_docs: /(本人確認書類|運転免許証|マイナンバー)/,
  emergency_contact: /(必須|必要|3親等|三親等|固定|自宅|勤務先|専業主婦)/,
  cancel: /(審査[^。\n]{0,20}(通過|通る|承認)[^。\n]{0,16}(まで|前)|キャンセル料[^。\n]{0,14}(かかりません|無料|発生しません|一切|不要|掛からない)|週間|日程度)/,
  prorated_rent: /(日割|前家賃|円)/,
  area: /大阪府/,
};
const FORBID: Record<string, RegExp> = {
  store: /(店舗|そちら|事務所)[^。\n]{0,16}(お待ちしております|お越しください|ご案内させて|ご相談させて|伺って)/,
  viewing_method: /内(見|覧)(は|が)?(出来|でき)ません|内(見|覧)不可/,
  room_photo: /((写真|画像)(が|は)?(ござい|あり)ません|ご用意(出来|でき)て(い)?ない|写真が(無|な)い)/,
  apply_docs: /(必ず|必須)[^。\n]{0,10}(収入証明|内定(通知)?書)/,
  emergency_contact: /(柔軟に対応|ケースもござ|緊急連絡先(は|が)?(不要|無くても|なくても))/,
  cancel: /キャンセル料[^。\n]{0,10}(発生いたします|かかります|必要となります)/,
  prorated_rent: /日割[^。\n]{0,8}(発生(しません|いたしません|しない)|かかりません|不要)/,
  area: /(兵庫|京都|奈良)[^。\n]{0,8}(ご紹介|ピックアップ)(可能|できます)/,
};

async function main() {
  const rows: Ex[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, aix_action, created_at, conversation_state")
      .gte("created_at", SINCE).neq("conversation_id", YUMA).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Ex[]; rows.push(...r); if (r.length < 1000) break;
  }
  const hits = rows.filter((r) => r.customer_message && !/^\s*\[画像\]/.test(r.customer_message) && matchCompanyFacts(r.customer_message).length && r.ai_draft);
  console.log(`今月の ai_reply_examples ${rows.length}件のうち、会社の事実に当たる発言への下書き ${hits.length}件（画像の書き起こしは除く）\n`);
  const agg: Record<string, { n: number; draftWant: number; draftBad: number; sentWant: number; sentBad: number; used: number; aix: number }> = {};
  for (const h of hits) {
    const facts = matchCompanyFacts(h.customer_message);
    for (const f of facts) {
      const a = (agg[f.id] ??= { n: 0, draftWant: 0, draftBad: 0, sentWant: 0, sentBad: 0, used: 0, aix: 0 });
      a.n++;
      const d = String(h.ai_draft ?? ""), s = String(h.sent_reply ?? "");
      if (WANT[f.id]?.test(d)) a.draftWant++; if (FORBID[f.id]?.test(d)) a.draftBad++;
      if (WANT[f.id]?.test(s)) a.sentWant++; if (FORBID[f.id]?.test(s)) a.sentBad++;
      if (h.was_ai_used) a.used++; if (h.aix_action) a.aix++;
    }
  }
  console.log(`${"事実".padEnd(18)} 件 ／ 下書きが答えた ／ 下書きが反した ／ 実送信が答えた ／ 実送信が反した ／ そのまま送信 ／ AIX`);
  for (const [k, a] of Object.entries(agg).sort((x, y) => y[1].n - x[1].n)) {
    const p = (x: number) => `${x}/${a.n} (${a.n ? Math.round((x / a.n) * 100) : 0}%)`;
    console.log(`${k.padEnd(18)} ${String(a.n).padStart(2)} ／ ${p(a.draftWant).padEnd(12)} ／ ${p(a.draftBad).padEnd(12)} ／ ${p(a.sentWant).padEnd(12)} ／ ${p(a.sentBad).padEnd(12)} ／ ${p(a.used).padEnd(12)} ／ ${a.aix}`);
  }
  console.log(`\n【全件・目で読む】`);
  for (const h of hits) {
    const facts = matchCompanyFacts(h.customer_message).map((f) => f.id).join(",");
    console.log(`── [${jst(h.created_at)}] conv=${h.conversation_id.slice(0, 8)} state=${h.conversation_state} aix=${h.aix_action ?? "通常"} そのまま=${h.was_ai_used ? "はい" : "いいえ"} 当たり=${facts}`);
    console.log(`   客: ${mask(String(h.customer_message)).slice(0, 160)}`);
    console.log(`   下書き: ${mask(String(h.ai_draft)).slice(0, 260)}`);
    console.log(`   実送信: ${mask(String(h.sent_reply ?? "")).slice(0, 260)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
