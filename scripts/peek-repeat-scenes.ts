// 「催促されていないのに同じ宣言を言い直した」実物の場面を取り出す（読み取りのみ）
// 2026-09-23 竹内「実際にテストしてみて質上がったか確認おねがい」
//   テストの場面を想像で作らないため、言い直しの直前に**お客様が何と言っていたか**を実データから拾う。
// 実行: npx tsx --env-file=.env.local scripts/peek-repeat-scenes.ts [DAYS=60] [N=12]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const DECLARATIONS: Array<[string, RegExp]> = [
  ["ピックアップ宣言", /(ピックアップ|お探し|探させて|お送りさせて|ご紹介させて)(させて)?(頂き|いただき)/],
  ["内覧のご案内", /(ご案内|内覧|内見).{0,10}(させて(頂き|いただき)|可能)/],
  ["御見積書を作る", /(見積書|御見積)(を)?.{0,8}(作成|お作り|お送り)/],
  ["募集状況の確認", /(募集状況|空き状況|お部屋の状況)(を)?(含め)?.{0,6}(確認|お調べ)/],
];

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const N = Number(process.env.N ?? 12);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs: Msg[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }

  const out: Array<{ label: string; conv: string; first: string; between: string[]; custBefore: string; second: string; hours: number }> = [];
  for (const [conv, list] of byConv) {
    const seq = list.filter((m) => (m.text ?? "").trim() && m.text !== "[画像]");
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].sender === "customer") continue;
      for (const [label, re] of DECLARATIONS) {
        if (!re.test(seq[i].text ?? "")) continue;
        const between: string[] = [];
        for (let j = i + 1; j < seq.length; j++) {
          const t = seq[j].text ?? "";
          if (seq[j].sender === "customer") {
            if (/(お願い|ください|下さい|探して|送って|見たい|希望|どう|ですか|\?|？)/.test(t)) { j = seq.length; break; }
            between.push(norm(t)); continue;
          }
          if (re.test(t)) {
            // 言い直しの直前のお客様の発言（＝テストで使う場面の入口）
            let cust = "";
            for (let k = j - 1; k >= 0; k--) if (seq[k].sender === "customer") { cust = norm(seq[k].text ?? ""); break; }
            out.push({
              label, conv: conv.slice(0, 8),
              first: norm(seq[i].text ?? "").slice(0, 70),
              between, custBefore: cust,
              second: norm(t).slice(0, 90),
              hours: (Date.parse(seq[j].created_at) - Date.parse(seq[i].created_at)) / 3600_000,
            });
            break;
          }
        }
      }
    }
  }
  // 言い直しの直前のお客様の発言を種類ごとにまとめる（どんな発言の後に言い直すのか）
  const heads = new Map<string, number>();
  for (const o of out) heads.set(o.custBefore.slice(0, 12) || "（発言なし）", (heads.get(o.custBefore.slice(0, 12) || "（発言なし）") ?? 0) + 1);
  console.log(`言い直し ${out.length}件。その直前のお客様の発言（書き出し12字・上位）`);
  for (const [h, n] of [...heads].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(n).padStart(4)}回 「${h}…」`);

  console.log(`\n実物 ${N}件（間の時間が短い順＝一番おかしく見える物から）`);
  for (const o of out.sort((a, b) => a.hours - b.hours).slice(0, N)) {
    console.log(`\n── ${o.conv} ${o.label}（${o.hours.toFixed(1)}時間後に言い直し）`);
    console.log(`   1回目 : ${o.first}`);
    if (o.between.length) console.log(`   間の客: ${o.between.slice(0, 3).map((x) => x.slice(0, 40)).join(" ／ ")}`);
    console.log(`   直前客: ${o.custBefore.slice(0, 60)}`);
    console.log(`   2回目 : ${o.second}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
