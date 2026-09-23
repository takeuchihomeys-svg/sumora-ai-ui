// 「ピックアップ出来次第お送りします」と「新着で出次第お送りします」の使い分けを実送信から学ぶ（読み取りのみ）
//
// 2026-09-23 竹内「ピックアップ出来次第と新着で物件のところの場面の違いを研究。物件次回送る約束についてのところ。
//   基本的にすべて物件ピックアップしてる形となるから、新しい条件などが送られたり条件広げるなどない限り、
//   新着の物件探す方向で LINE を入れている。ここの言い回しの意味を理解して状況によっての使い分けを理解し改善する」
//
// 【竹内さんの説明を仮説にする】
//   ピックアップ型 … これから条件に合う物件を**探して**送る（＝まだ探していない／条件が変わった）
//   新着型        … 条件に合う物件は**もう全部送った**ので、新しく募集に出た物を待って送る
//   分かれ目は「**新しい条件が来たか・条件を広げたか**」。無ければ新着型。
//
// 【測ること】
//   ① 実送信での件数と、会話の中での位置（何通目・送付済み物件の有無）
//   ② 直前のお客様の発言に条件の変更・追加があったか（＝仮説の分かれ目）
//   ③ AI の下書きは使い分けられているか（下書き vs 実送信）
//   ④ 実物を目で読む
//
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-vs-newarrival.ts [DAYS=180] [SHOW=6]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** これから探して送る（ピックアップ型） */
const PICKUP = /(ピックアップ|お探し|探させて|探して)[^。\n]{0,14}(お送り|送らせて|ご連絡|させて(頂き|いただき)ます|出来次第|でき次第)/;
/** 新しく募集に出た物を待って送る（新着型） */
const NEW_ARRIVAL = /新着[^。\n]{0,20}(出次第|出ましたら|入り次第|ご紹介|お送り|お知らせ)|新[^。\n]{0,4}(物件|お部屋)[^。\n]{0,12}(出次第|出ましたら|募集に出|入り次第)/;

/** お客様が新しい条件・条件の変更を出したか（仮説の分かれ目） */
const NEW_CONDITION = /(エリア|地域|駅|沿線|線|区|市|町)[^。\n]{0,10}(も|でも|に変更|追加|широ|広げ|変え)|(家賃|予算|賃料)[^。\n]{0,10}(まで|以内|に変更|上げ|下げ)|(\d+(?:\.\d+)?万)|([0-9]LDK|[0-9]DK|[0-9]K|ワンルーム)|(ペット|駐車場|バストイレ別|独立洗面|オートロック|南向き|角部屋|築[0-9]+年)[^。\n]{0,8}(可|付|希望|欲し|条件|も)/;
/** お客様が「他も見たい・まだあるか」と聞いた（新着型に寄る場面） */
const ASK_MORE = /(他|ほか|もう少し|もっと|別の)[^。\n]{0,8}(物件|お部屋|ところ)|新着|新しい(物件|お部屋)|まだ(ある|出て)/;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const SHOW = Number(process.env.SHOW ?? 6);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
  const msgs: Msg[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }

  type Case = { conv: string; type: "ピックアップ" | "新着" | "両方"; text: string; cust: string; idx: number; sentBefore: boolean; newCond: boolean; askMore: boolean };
  const cases: Case[] = [];
  for (const [conv, list] of byConv) {
    const seq = list.filter((m) => (m.text ?? "").trim());
    let sentBefore = false;   // それまでに物件を送っているか（🌟や物件カードの印）
    for (let i = 0; i < seq.length; i++) {
      const t = seq[i].text ?? "";
      if (seq[i].sender === "customer") continue;
      const isPickup = PICKUP.test(t), isNew = NEW_ARRIVAL.test(t);
      if (isPickup || isNew) {
        // 直前のお客様の発言
        let j = i - 1; while (j >= 0 && seq[j].sender !== "customer") j--;
        const cust = j >= 0 ? (seq[j].text ?? "") : "";
        cases.push({
          conv: conv.slice(0, 8),
          type: isPickup && isNew ? "両方" : isPickup ? "ピックアップ" : "新着",
          text: one(t), cust: one(cust), idx: i, sentBefore,
          newCond: NEW_CONDITION.test(cust), askMore: ASK_MORE.test(cust),
        });
      }
      if (/🌟|号室|物件名/.test(t)) sentBefore = true;
    }
  }
  console.log(`直近${days}日で「次に物件を送る約束」を含むこちらの送信 ${cases.length}件\n`);

  const P = cases.filter((c) => c.type === "ピックアップ"), N = cases.filter((c) => c.type === "新着"), B = cases.filter((c) => c.type === "両方");
  console.log(`① 型の内訳`);
  console.log(`   ピックアップ型 ${String(P.length).padStart(5)}件（${pct(P.length, cases.length)}）`);
  console.log(`   新着型         ${String(N.length).padStart(5)}件（${pct(N.length, cases.length)}）`);
  console.log(`   両方入っている ${String(B.length).padStart(5)}件（${pct(B.length, cases.length)}）`);

  console.log(`\n② 竹内さんの説明どおりか（新しい条件が来たら ピックアップ／無ければ 新着）`);
  const row = (name: string, xs: Case[]) => {
    if (xs.length < 5) return;
    console.log(`   ${name.padEnd(16)} ${String(xs.length).padStart(5)}件 ／ 直前に新しい条件 ${pct(xs.filter((x) => x.newCond).length, xs.length).padStart(6)} ／ 他も見たい ${pct(xs.filter((x) => x.askMore).length, xs.length).padStart(6)} ／ 既に物件を送っている ${pct(xs.filter((x) => x.sentBefore).length, xs.length)}`);
  };
  row("ピックアップ型", P); row("新着型", N); row("両方", B);

  console.log(`\n③ 逆から見る（条件の有無で、どちらの型を選んでいるか）`);
  const withCond = cases.filter((c) => c.newCond), noCond = cases.filter((c) => !c.newCond);
  console.log(`   直前に新しい条件あり ${String(withCond.length).padStart(5)}件 → ピックアップ ${pct(withCond.filter((c) => c.type !== "新着").length, withCond.length)} ／ 新着のみ ${pct(withCond.filter((c) => c.type === "新着").length, withCond.length)}`);
  console.log(`   新しい条件なし       ${String(noCond.length).padStart(5)}件 → ピックアップ ${pct(noCond.filter((c) => c.type !== "新着").length, noCond.length)} ／ 新着のみ ${pct(noCond.filter((c) => c.type === "新着").length, noCond.length)}`);

  console.log(`\n④ 既に物件を送った後だけで見る（＝竹内さんが言う「基本的にすべてピックアップしてる形」の後）`);
  const after = cases.filter((c) => c.sentBefore);
  console.log(`   ${after.length}件 → ピックアップ ${pct(after.filter((c) => c.type !== "新着").length, after.length)} ／ 新着のみ ${pct(after.filter((c) => c.type === "新着").length, after.length)}`);
  const afterNoCond = after.filter((c) => !c.newCond);
  console.log(`   そのうち新しい条件なし ${afterNoCond.length}件 → ピックアップ ${pct(afterNoCond.filter((c) => c.type !== "新着").length, afterNoCond.length)} ／ 新着のみ ${pct(afterNoCond.filter((c) => c.type === "新着").length, afterNoCond.length)}`);

  console.log(`\n⑤ 実物（目で読む）`);
  for (const [name, xs] of [["新着型", N], ["ピックアップ型（物件送付後・条件なし）", afterNoCond.filter((c) => c.type !== "新着")]] as const) {
    console.log(`\n── ${name}`);
    for (const c of xs.slice(0, SHOW)) {
      console.log(`   客 : ${c.cust.slice(0, 60) || "（なし）"}`);
      console.log(`   我 : ${c.text.slice(0, 96)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
