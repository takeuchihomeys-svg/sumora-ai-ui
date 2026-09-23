// 会社の事実を「聞かれた時だけ渡す」判定を実データに当てて、誤爆と当たり漏れを見る（読み取りのみ・全件監査）
//
// 2026-09-23 竹内「ちゃんとテストして改善されたか問題ないかも確認する」
//
// 見るのは3つ:
//   ① 実データの何%で出るか（出すぎていないか＝誤爆）
//   ② 当たった発言を目で読む（本当にその事実が要る場面か）
//   ③ 当たり漏れ: スタッフが実送信でその事実を答えているのに、判定が当たらなかった場面
//
// 実行: npx tsx --env-file=.env.local scripts/audit-company-facts-apply.ts [DAYS=180] [SHOW=4]
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts, COMPANY_FACTS } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(2)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** スタッフの実送信に「その事実を答えている」印があるか（当たり漏れを探すため） */
const ANSWERED_BY: Record<string, RegExp> = {
  store: /(オンライン専門|店舗(では|は)?(無|な)(く|い)|ご来社)/,
  viewing_method: /オンライン(内覧|内見)/,
  room_photo: /(室内|お部屋).{0,6}(写真|動画).{0,10}(撮影|お送り|送らせて)/,
  apply_docs: /(運転免許証|マイナンバーカード).{0,14}(裏表|表裏)/,
  emergency_contact: /(3親等|緊急連絡先.{0,10}(必須|必要))/,
  cancel: /キャンセル(料)?.{0,14}(かかりません|無料|発生しません)/,
  prorated_rent: /日割(家賃|り家賃)/,
  area: /大阪府.{0,4}(全域|全物件)/,
};

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const SHOW = Number(process.env.SHOW ?? 4);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
  const msgs: Msg[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const cust = msgs.filter((m) => m.sender === "customer" && (m.text ?? "").trim() && m.text !== "[画像]");
  console.log(`直近${days}日のお客様の発言 ${cust.length}通\n`);

  const hitAny = cust.filter((m) => matchCompanyFacts(m.text).length > 0);
  console.log(`① 事実が出る発言: ${hitAny.length}通（${pct(hitAny.length, cust.length)}）`);
  console.log(`   ⚠ 出すぎ（10%超）なら誤爆を疑う。会社の事実を聞かれる場面はそう多くない\n`);
  console.log(`   ${"事実".padEnd(20)} ${"当たった".padStart(6)} ／ 割合`);
  for (const f of COMPANY_FACTS) {
    const n = cust.filter((m) => matchCompanyFacts(m.text).some((x) => x.id === f.id)).length;
    console.log(`   ${f.id.padEnd(20)} ${String(n).padStart(6)} ／ ${pct(n, cust.length)}`);
  }

  console.log(`\n② 当たった発言を目で読む（本当にその事実が要る場面か）`);
  for (const f of COMPANY_FACTS) {
    const hit = cust.filter((m) => matchCompanyFacts(m.text).some((x) => x.id === f.id));
    if (hit.length === 0) continue;
    console.log(`\n── ${f.id}（${hit.length}通）`);
    for (const m of hit.slice(0, SHOW)) console.log(`   ・${one(m.text ?? "").slice(0, 76)}`);
  }

  // ③ 当たり漏れ: スタッフがその事実を答えた返信の、直前のお客様の発言で判定が当たったか
  console.log(`\n③ 当たり漏れ（スタッフは答えているのに、判定が当たらなかった場面）`);
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  for (const f of COMPANY_FACTS) {
    const re = ANSWERED_BY[f.id];
    if (!re) continue;
    let answered = 0, caught = 0;
    const missed: string[] = [];
    for (const list of byConv.values()) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].sender === "customer" || !re.test(list[i].text ?? "")) continue;
        // その返信の直前のお客様の発言
        let j = i - 1;
        while (j >= 0 && list[j].sender !== "customer") j--;
        if (j < 0) continue;
        answered++;
        if (matchCompanyFacts(list[j].text).some((x) => x.id === f.id)) caught++;
        else if (missed.length < SHOW) missed.push(one(list[j].text ?? "").slice(0, 70));
      }
    }
    if (answered === 0) continue;
    console.log(`   ${f.id.padEnd(20)} スタッフが答えた ${String(answered).padStart(4)}回 ／ 判定が当たった ${pct(caught, answered).padStart(7)}`);
    for (const t of missed) console.log(`       漏れ: ${t}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
