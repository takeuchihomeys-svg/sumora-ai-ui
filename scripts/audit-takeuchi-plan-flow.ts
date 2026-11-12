// scripts/audit-takeuchi-plan-flow.ts — 竹内さんの番をまたぐ流れ（同じお客様で次の2〜3番に何を順に果たしたか）を数える（読むだけ・LLM なし）
//   2026-11-12 作業員7（竹内さん「統括の機能も細分化して強化していく」・番をまたぐ計画）。
//   1手＝こちらの1つの番の主の送り物（AIX の種類か返信の役目）。お客様の通をはさんだ次の2〜3手の並びを、最初の手（＝駅）ごとに数える。
//   書き換え: 並びが途中で別の道に移った時の、その間のお客様の言葉の型（検討・条件の言い直し・断り・質問）も数える。
//   営業時間（JST 9〜22）は流さない。申込の書類以降で止める。名前は出さない（集計だけ）。
//   実行: npx tsx --env-file=<鍵のある .env> scripts/audit-takeuchi-plan-flow.ts [--days=120] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")) || 120;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (h >= 9 && h < 22 && !process.argv.includes("--force-hours")) { console.error("営業時間（JST 9〜22時）は流さない"); process.exit(1); }

type M = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
const POST_APPLY_RE = /申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として/;
const IMG_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/;
function aixStep(t: string): string {
  if (/ご希望のお部屋探しご条件|①ご入居時期/.test(t)) return "A:条件ヒアリング";
  if (/御見積書|初期費用：/.test(t)) return "A:見積書";
  if (/募集中|募集終了|お申込が入|空室/.test(t)) return "A:物件確認した";
  if (/待ち合わせ|現地エントランス/.test(t)) return "A:待ち合わせ";
  if (/ご内覧|内覧日|候補日/.test(t)) return "A:内覧調整";
  if (/オススメ|おすすめ/.test(t)) return "A:物件オススメ";
  if (/ピックアップ|お部屋一覧|物件一覧/.test(t)) return "A:物件ピックアップ";
  return "A:その他";
}
function replyStep(t: string): string {
  if (/抑え|お申込(?:み)?(?:頂|で|しお部屋)/.test(t)) return "R:抑える・申込の線";
  if (/ご内覧|ご案内|お日にち/.test(t)) return "R:内覧へ";
  if (/確認させて頂|確認出来次第/.test(t)) return "R:確認の約束";
  if (/ピックアップ(?:し|して)?(?:お送り|させ)|新着/.test(t)) return "R:探す約束";
  if (/御見積書を?作成|最大限割引/.test(t)) return "R:見積の約束・費用";
  return "R:答え・受け";
}
function custKind(t: string): string {
  if (/検討|考え|相談/.test(t)) return "検討";
  if (/エリア|家賃|間取り|条件|希望|他の(?:物件|お部屋)/.test(t)) return "条件・他の物件";
  if (/大丈夫です|やめ|見送|他で決|結構です/.test(t)) return "断り・見送り";
  if (/[?？]|ですか|ますか/.test(t)) return "質問";
  if (/ありがと|お願いします|了解|わかりました/.test(t)) return "お礼・了承";
  return "その他";
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) convs.add(r.conversation_id as string);
    if (!data || data.length < 1000) break;
  }
  const tri: Record<string, number> = {}; const rewrite: Record<string, number> = {};
  let seqs = 0;
  for (const cid of convs) {
    const { data, error } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", cid).gte("created_at", since).order("created_at", { ascending: true }).limit(3000);
    if (error) throw error;
    const ms = (data ?? []) as M[];
    // 番ごとの主の手（こちらの連続した送信の中で AIX があれば最初の AIX・無ければ返信の役目）と、その前のお客様の言葉
    const steps: Array<{ step: string; cust: string }> = [];
    let cust = "";
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (POST_APPLY_RE.test(String(m.text ?? ""))) break;
      if (m.sender === "customer") { cust = String(m.text ?? ""); continue; }
      const block: M[] = [];
      while (i < ms.length && ms[i].sender !== "customer") { if (!IMG_RE.test(String(ms[i].text ?? "")) || ms[i].is_aix_generated) block.push(ms[i]); i++; }
      i--;
      if (!block.length || block.some((b) => b.staff_writer === "employee")) { cust = ""; continue; }
      const a = block.find((b) => b.is_aix_generated && !IMG_RE.test(String(b.text ?? "")));
      steps.push({ step: a ? aixStep(String(a.text ?? "")) : replyStep(block.map((b) => String(b.text ?? "")).join("\n")), cust: custKind(cust) });
      cust = "";
    }
    for (let s = 0; s + 2 < steps.length; s++) {
      if (steps[s].step === "R:答え・受け") continue;
      seqs++;
      const k = `${steps[s].step} → ${steps[s + 1].step} → ${steps[s + 2].step}`; tri[k] = (tri[k] ?? 0) + 1;
      const r = `${steps[s].step} →（お客様: ${steps[s + 1].cust}）→ ${steps[s + 1].step}`; rewrite[r] = (rewrite[r] ?? 0) + 1;
    }
  }
  const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`3手の並び ${seqs}（${DAYS}日・竹内さんの手打ちがある会話・申込の書類で止める・従業員の番は外す）`);
  console.log("\n# 3手の並び（多い順）"); for (const [k, n] of top(tri, 30)) console.log(`  ${n}  ${k}`);
  console.log("\n# 次の手がお客様の言葉でどう変わったか（多い順）"); for (const [k, n] of top(rewrite, 30)) console.log(`  ${n}  ${k}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ tri, rewrite, seqs }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
