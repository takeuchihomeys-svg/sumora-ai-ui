// scripts/audit-r9-phrases.ts — 9巡目の学習ルールの総点検: ルールが必須／禁止にしている言い回しを、スタッフの手打ちが何通使うか（読み取りのみ・LLM 0）
// 2026-10-08 竹内さん「LINE は今直近で狭くしか見れていないから広げていく。1ヶ月とかで見れればもっと強化される」:
//   全期間（記録は 5/17〜）・直近30日・週ごとの推移を並べる。場面で絞る物は「直前のお客様の文」の正規表現で絞る（その場面の返事の最初の手打ち）。
// 実行: npx tsx --env-file=.env.local scripts/audit-r9-phrases.ts
import { createClient } from "@supabase/supabase-js";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const skip = new Set<string>(TEST_CONVERSATION_IDS);
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

/** name・本文の正規表現・（任意）直前のお客様の文の正規表現（その場面の返事だけで数える） */
export const R9_PHRASES: Array<{ name: string; re: RegExp; prev?: RegExp }> = [
  { name: "何卒よろしくお願い致します（締め）", re: /何卒よろしくお願い(?:致|いた)します/ },
  { name: "お気軽に／何かございましたら（質問歓迎の一文）", re: /お気軽に|何かございましたら|何かあれば|何時でも|いつでもご連絡/ },
  { name: "ご連絡ありがとうございます（冒頭の感謝）", re: /^[^\n]{0,20}(?:ご連絡|ご返信|ご返答)(?:頂き|いただき)?ありがとうございます/ },
  { name: "申し訳（謝罪）", re: /申し訳(?:ございません|ありません|ない)/ },
  { name: "ご査収いただきありがとうございます", re: /ご査収(?:頂き|いただき)ありがとうございます/ },
  { name: "本日中に", re: /本日中に/ },
  { name: "明日〜次第／明日中に（期限の約束）", re: /明日(?:中に|[^\n]{0,10}次第)/ },
  { name: "確認させて頂きます", re: /確認させて(?:頂|いただ)きます/ },
  { name: "交渉させて頂きます", re: /交渉させて(?:頂|いただ)きます/ },
  { name: "以降ご内覧／以降内覧", re: /以降(?:ご)?内覧|以降(?:ご)?内見/ },
  { name: "新着が出次第お送り", re: /新着[^\n]{0,12}(?:出|で)次第/ },
  { name: "末尾が？", re: /[？?]\s*$/ },
  { name: "TikTok", re: /tiktok|ティックトック/i },
  { name: "優先的に", re: /優先的に/ },
  { name: "お申込み(を)?させて頂きます", re: /お?申込み?(?:を)?させて(?:頂|いただ)きます/ },
  { name: "以前ご希望の", re: /以前ご希望/ },
  { name: "2番手", re: /2番手|二番手/ },
  // 場面で絞る（直前のお客様の文）
  { name: "[内覧後のお礼] 何かの返事", re: /./, prev: /(?:内覧|内見|案内)[^\n]{0,30}(?:ありがとう)|ありがとう[^\n]{0,30}(?:内覧|内見|案内)/ },
  { name: "[内覧後のお礼] 申込の誘導", re: /お申込|申込/, prev: /(?:内覧|内見|案内)[^\n]{0,30}(?:ありがとう)|ありがとう[^\n]{0,30}(?:内覧|内見|案内)/ },
  { name: "[内覧後のお礼] 新着・ピックアップの約束", re: /新着|ピックアップ/, prev: /(?:内覧|内見|案内)[^\n]{0,30}(?:ありがとう)|ありがとう[^\n]{0,30}(?:内覧|内見|案内)/ },
  { name: "[内覧後のお礼] 何卒の締め", re: /何卒/, prev: /(?:内覧|内見|案内)[^\n]{0,30}(?:ありがとう)|ありがとう[^\n]{0,30}(?:内覧|内見|案内)/ },
  { name: "[お礼] 何かの返事", re: /./, prev: /^(?:[^\n]{0,15})(?:ありがとう|よろしくお願い)[^\n]{0,15}$/ },
  { name: "[お礼] お気軽に／何かございましたら", re: /お気軽に|何かございましたら|何かあれば|何時でも|いつでも/, prev: /^(?:[^\n]{0,15})(?:ありがとう|よろしくお願い)[^\n]{0,15}$/ },
  { name: "[お礼] 何卒の締め", re: /何卒/, prev: /^(?:[^\n]{0,15})(?:ありがとう|よろしくお願い)[^\n]{0,15}$/ },
  { name: "[お礼] ご査収いただきありがとう", re: /ご査収(?:頂き|いただき)ありがとう/, prev: /^(?:[^\n]{0,15})(?:ありがとう|よろしくお願い)[^\n]{0,15}$/ },
  { name: "[内覧の日にち決定] 新着の並行紹介", re: /新着|ピックアップ/, prev: /(?:\d{1,2}[\/月]\d{1,2}|明日|明後日|土曜|日曜)[^\n]{0,20}(?:お願いします|大丈夫|でお願い|で行けます|空いて)/ },
  { name: "[検討します] 新着が出次第の約束", re: /新着|出次第/, prev: /検討|考えます|考えてみ|候補に/ },
  { name: "[設備・駐車場の質問] 確認の約束", re: /確認させて|確認出来次第|確認でき次第/, prev: /(?:駐車場|ペット|エアコン|ネット|wifi|Wi-Fi|設備|バイク|駐輪|オートロック|宅配)[^\n]{0,30}[？?]|(?:ありますか|できますか|可能ですか)/i },
];

async function main() {
  const msgs: Msg[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").in("sender", ["staff", "customer"]).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as Msg[])); if ((data ?? []).length < 1000) break;
  }
  const conv = new Map<string, Msg[]>();
  for (const m of msgs) { if (skip.has(m.conversation_id)) continue; const a = conv.get(m.conversation_id) ?? []; a.push(m); conv.set(m.conversation_id, a); }
  // 手打ちの1通ずつ＋直前のお客様の文（返事の最初の1通だけ prev を持つ）
  type H = { text: string; at: number; prev: string | null };
  const hs: H[] = [];
  for (const ms of conv.values()) {
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; if (m.sender !== "staff" || m.is_aix_generated) continue;
      const t = (m.text ?? "").trim(); if (!t || /^\[画像\]|^\[スタンプ\]|^https?:\/\//.test(t)) continue;
      // 直前のお客様の連投をまとめる
      let prev: string | null = null;
      if (ms[i - 1]?.sender === "customer") { const cs: string[] = []; for (let j = i - 1; j >= 0 && ms[j].sender === "customer"; j--) cs.unshift(ms[j].text ?? ""); prev = cs.join("\n"); }
      hs.push({ text: t, at: Date.parse(m.created_at), prev });
    }
  }
  const t30 = Date.now() - 30 * 86400_000;
  const weekOf = (t: number) => { const d = new Date(t + 9 * 3600_000); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(5, 10); };
  const weeks = [...new Set(hs.map((h) => weekOf(h.at)))].sort();
  console.log(`スタッフの手打ち ${hs.length}通（全期間 5/17〜・YUMA 等を除く）／直近30日 ${hs.filter((h) => h.at >= t30).length}通`);
  console.log(`週（月曜始まり JST）: ${weeks.join(" ")}`);
  for (const ph of R9_PHRASES) {
    const base = ph.prev ? hs.filter((h) => h.prev && ph.prev!.test(h.prev)) : hs;
    const hit = base.filter((h) => ph.re.test(h.text));
    const b30 = base.filter((h) => h.at >= t30); const h30 = hit.filter((h) => h.at >= t30);
    const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
    const series = weeks.map((w) => { const b = base.filter((h) => weekOf(h.at) === w).length; const a = hit.filter((h) => weekOf(h.at) === w).length; return b ? `${a}/${b}` : "-"; }).join(" ");
    console.log(`\n${ph.name}\n  全期間 ${hit.length}/${base.length}（${pct(hit.length, base.length)}）・30日 ${h30.length}/${b30.length}（${pct(h30.length, b30.length)}）\n  週ごと ${series}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
