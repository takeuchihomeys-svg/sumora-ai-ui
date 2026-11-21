// scripts/audit-scene-feeling-appeal.ts — 土台「気持ち」「訴求」を場面ごとに数える（竹内さん本人の実送信の形・読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #496〜#499・作業員N の foundation-scene-grid で「場面ごとの決まり・物差しが無い」と出た所・統括役の頼み）。
//   1番＝お客様の束の後の、竹内さん本人のこちらの通の塊（次のお客様の通まで・AIX の文も含む）。
//   場面: こちらの塊に物件ピックアップ／物件オススメの AIX がある番は「物件を送る」、それ以外はお客様の束の reply-scene（短いお礼・検討中・質問・条件・物件を送ってきた・初期費用・内覧・申込・その他）。
//   形（決まった網・1番に複数付く）:
//     気持ち … 受けた（共感・気持ちの語で受けた: ですよね・ご不安・ご心配・お気持ち・嬉しい・良かった・残念・安心 等）／受けていない
//     訴求   … 推した（オススメ・お得・初期費用を抑え・審査通過・人気・早め 等）／内覧へ誘った（ご案内させて・ご内覧）／どちらも無い
//   本文は出さない（場面ごとの数と割合だけ）。--json= で場面ごとの数を書く（毎日の数の元）。
// 重い読み: 営業時間（JST 9〜22時）は --days=3 に絞る（30日は22時以降）。
// 実行: npx tsx --env-file=.env.local scripts/audit-scene-feeling-appeal.ts [--days=30] [--json=<出力>] [--force]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
export const FEEL_RE = /ですよね|お気持ち|ご不安|ご心配|不安な|心配な|分かります|わかります|嬉しい|うれしい|良かった|よかった|安心|残念|お辛い|大変でしたね|お忙しい中/;
export const APPEAL_RE = /オススメ|おすすめ|お勧め|お得|初期費用(?:を|も)?抑え|審査(?:通過|が通り)|人気|すぐに?埋まり|早め|お早め|🌟|一押し|特に/;
export const INVITE_RE = /ご案内させて|ご内覧|内覧(?:頂|いただ|のご案内)|お気に召され/;
export type TurnShape = { scene: string; feeling: boolean; appeal: boolean; invite: boolean };

/** 1番の形（純関数） */
export function turnShape(customerTexts: ReadonlyArray<string>, ourTexts: ReadonlyArray<string>, propertySend: boolean): TurnShape {
  const ours = ourTexts.join("\n").normalize("NFKC");
  const scene = propertySend ? "property_send" : resolveReplyScene({ customerText: customerTexts.join("\n") }).scene;
  return { scene, feeling: FEEL_RE.test(ours), appeal: APPEAL_RE.test(ours), invite: INVITE_RE.test(ours) };
}

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "30")) || 30;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 3); console.log(`営業時間なので --days=${days} に絞った（全部は22時以降）`); }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: tk, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(20000);
  if (error) throw new Error(error.message);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !isTestConversation(c) && !isNoLineTestConversation(c));
  const tally: Record<string, { n: number; feeling: number; appeal: number; invite: number }> = {};
  for (const c of convs) {
    const [mq, aq] = await Promise.all([
      sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(2000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).in("aix_type", ["property_send", "property_recommendation"]).limit(500),
    ]);
    const ms = (mq.data ?? []) as M[];
    const sendAts = ((aq.data ?? []) as Array<{ sent_at: string | null; created_at: string }>).map((a) => Date.parse(a.sent_at ?? a.created_at));
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "staff" || m.staff_writer !== "takeuchi" || (i > 0 && ms[i - 1].sender === "staff")) continue;
      const cust: string[] = []; for (let j = i - 1; j >= 0 && ms[j].sender === "customer"; j--) cust.unshift(String(ms[j].text ?? ""));
      if (!cust.length) continue;
      let k = i; const ours: string[] = []; while (k < ms.length && ms[k].sender !== "customer") { ours.push(String(ms[k].text ?? "")); k++; }
      const from = Date.parse(m.created_at), to = k < ms.length ? Date.parse(ms[k].created_at) : Infinity;
      const s = turnShape(cust, ours, sendAts.some((t) => t >= from - 5000 && t < to));
      const c2 = (tally[s.scene] ??= { n: 0, feeling: 0, appeal: 0, invite: 0 });
      c2.n++; if (s.feeling) c2.feeling++; if (s.appeal) c2.appeal++; if (s.invite) c2.invite++;
    }
  }
  const pct = (a: number, n: number) => (n ? Math.round((100 * a) / n) : 0);
  console.log(`竹内さん本人の番の場面ごとの形（${days}日・${convs.length}会話）: 番 ／ 気持ちを受けた ／ 推した ／ 内覧へ誘った`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(15)} ${String(v.n).padStart(4)} ／ ${pct(v.feeling, v.n)}% ／ ${pct(v.appeal, v.n)}% ／ ${pct(v.invite, v.n)}%`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify({ days, scenes: tally }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
