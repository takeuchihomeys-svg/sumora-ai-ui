// AIX の物件ピックアップで実際に送っている文の型（読み取りのみ）
//
// 2026-09-20 竹内「実際送ってる AIX の物件ピックアップの文のように送られるのか テストして確認」
//   生成文を「良い／悪い」で判断する前に、**実送信の型を数字で出して比較の基準**を作る
//   （設計知見「実送信で線を引く」「生成文と実送信の差分が正解データ」）。
//
// 対象: aix_usage_logs の property_send / property_recommendation / property_search と
//   同じ会話・同じ時刻帯（±10分）のスタッフ送信テキスト。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PICK = new Set(["property_send", "property_recommendation", "property_search"]);

/** 型の要素（実送信で何%あるか） */
const ELEMENTS: Array<{ key: string; re: RegExp }> = [
  { key: "① 開口語 かしこまりました", re: /^かしこまりました/ },
  { key: "① 開口語 はい", re: /^はい[！!😊😌]/ },
  { key: "② お待たせ（禁止語）", re: /お待たせ(?:致|いた)?しました/ },
  { key: "③ 名前呼びかけ 〇〇さん", re: /^[^\n]{1,14}さん/ },
  { key: "④ お世話になっております", re: /お世話になっております/ },
  { key: "⑤ ピックアップ（過去形）", re: /ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|お送り(?:させて(?:頂|いただ)き|いたし|致し)ました/ },
  { key: "⑥ ピックアップ（未来形）", re: /ピックアップ[^\n。！!]{0,12}(?:させて(?:頂|いただ)き|いたし|致し|し)ます/ },
  { key: "⑦ ご査収ください", re: /ご査収/ },
  { key: "⑧ エリア名を書く", re: /(?:市|区|町|駅|沿線|周辺|エリア)[^\n。！!]{0,10}(?:から|周辺|全域)/ },
  { key: "⑨ 家賃・条件の復唱", re: /[0-9０-９]{1,3}[\.．]?[0-9０-９]{0,2}万|[0-9０-９]{1,2}[LDKSldks]{1,4}|築[0-9０-９]{1,2}/ },
  { key: "⑩ 物件名を本文に書く", re: /[0-9０-９]{2,4}号室/ },
  { key: "⑪ 全力サポートの締め", re: /全力でサポート/ },
  { key: "⑫ 何卒よろしくお願い致します", re: /何卒(?:よろしく|宜しく)お願い/ },
  { key: "⑬ いつでもお気軽に", re: /いつでもお気軽|何時でもお気軽/ },
  { key: "⑭ 条件に合うお部屋が無かった旨", re: /募集(?:が)?(?:御座|ござ)いません|少ない状況|見つかりません/ },
  { key: "⑮ 条件を広げた旨", re: /(?:まで|も)(?:広げ|拡[げ大])|も含めて[^\n。！!]{0,12}(?:ピックアップ|お探し)/ },
];

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const logs: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 8; p++) {
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    logs.push(...r);
    if (r.length < 1000) break;
  }
  const picks = logs.filter((l) => PICK.has(String(l.aix_type ?? "")));
  console.log(`=== AIX の物件ピックアップ ${picks.length}件（直近${days}日）===`);

  // ① generated_text が残っている物（AIX が作った文そのもの）
  const withText = picks.filter((l) => String(l.generated_text ?? "").trim().length > 10);
  console.log(`   generated_text が残っている: ${withText.length}件 (${picks.length ? ((withText.length / picks.length) * 100).toFixed(1) : "-"}%)`);

  // ② 実際に LINE に出た文（messages から ±10分で拾う）
  const convIds = [...new Set(picks.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];
  const msgs: Array<{ conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 10; p++) {
      const { data } = await sb.from("messages").select("conversation_id, text, created_at, is_aix_generated")
        .in("conversation_id", chunk).eq("sender", "staff").gte("created_at", since)
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  const sent: string[] = [];
  for (const l of picks) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    const near = (byConv.get(c) ?? []).filter((m) => {
      const mt = Date.parse(m.created_at);
      return Math.abs(mt - t) <= 10 * 60_000 && (m.text ?? "").trim().length > 15 && !/^\[/.test(m.text ?? "");
    });
    if (near.length) sent.push((near[0].text ?? "").trim());
  }
  console.log(`   実際に LINE に出た文を拾えた: ${sent.length}件\n`);

  // ③ 型（要素の出現率）
  console.log(`── 実送信 ${sent.length}通の型（この率が比較の基準）`);
  for (const e of ELEMENTS) {
    const n = sent.filter((t) => e.re.test(t)).length;
    console.log(`     ${e.key.padEnd(30)} ${String(n).padStart(4)}通 (${sent.length ? ((n / sent.length) * 100).toFixed(1) : "-"}%)`);
  }

  // ④ 長さ
  const lens = sent.map((t) => t.length).sort((a, b) => a - b);
  const q = (p: number) => lens.length ? lens[Math.floor(lens.length * p)] : NaN;
  console.log(`\n── 長さ: 中央値 ${q(0.5)}字（25% ${q(0.25)} / 75% ${q(0.75)} / 最短 ${lens[0]} / 最長 ${lens[lens.length - 1]}）`);
  const lines = sent.map((t) => t.split("\n").filter((x) => x.trim()).length).sort((a, b) => a - b);
  console.log(`   行数: 中央値 ${lines.length ? lines[Math.floor(lines.length / 2)] : "-"}行`);

  // ⑤ 実物（目で読む）
  console.log(`\n── 実送信の実物（10件・目で読む）`);
  for (const t of sent.slice(0, 10)) console.log(`     「${t.replace(/\n/g, " ／ ").slice(0, 160)}」`);
}
main().catch((e) => { console.error(e); process.exit(1); });
