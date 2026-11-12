// scripts/audit-takeuchi-split.ts — 竹内さん本人が、お客様の1通に返信を2通以上に分けた番を、場面（check-order の T1〜T11 に寄せた型）ごとに数える（読むだけ・LLM なし）
//   2026-11-12 作業員7（竹内さん「2通に分けるのは分かりやすく、返信しやすく伝えている部分もある」）。
//   営業時間（9〜22時）は流さない（DB の読み）。申込の書類以降の番は外す。名前・番号は出さない（集計と伏せた短い抜き出しだけ）。
//   実行: npx tsx --env-file=<鍵のある .env> scripts/audit-takeuchi-split.ts [--days=120] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")) || 120;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const jstHour = () => new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (jstHour() >= 9 && jstHour() < 22 && !process.argv.includes("--force-hours")) { console.error("営業時間（JST 9〜22時）は流さない"); process.exit(1); }

type M = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
const MASK = (t: string) => t.replace(/[\p{Script=Han}\p{Script=Katakana}A-Za-z]{1,12}(?:さん|様)/gu, "〇〇さん").replace(/\d{2,4}-?\d{2,4}-?\d{3,4}/g, "〈番号〉").replace(/https?:\/\/\S+/g, "〈URL〉");
const POST_APPLY_RE = /申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)|ご契約(?:書|手続)/;
const IMG_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/;

/** 場面（check-order の型に寄せた・お客様の連投の言葉から） */
function sceneOf(cust: string, firstContact: boolean): string {
  const t = cust;
  if (firstContact) return "T11 初回";
  if (/申し?込(?:み)?(?:たい|します|させ)|抑えて|審査/.test(t)) return "T9 決める合図・審査";
  if (/https?:\/\/|\[画像\]|SUUMO|ホームズ/.test(t)) return "T4 物件が届いた";
  if (/内[覧見]|見学|案内/.test(t)) return "T7 内覧";
  if (/初期費用|費用|見積|いくら|割引|安く/.test(t)) return "T8 費用";
  if (/検討|考え(?:させ|ます)|相談して|また連絡/.test(t)) return "T6 検討";
  if (/(?:エリア|家賃|間取り|築|駅|条件|希望)/.test(t) && !/[?？]/.test(t)) return "T1 条件";
  if (/[?？]|ですか|ますか|でしょうか/.test(t)) return "T2/T3 質問";
  if (/ありがと|了解|承知|お願いします|わかりました|かしこまり/.test(t)) return "T5 お礼・了承";
  return "その他";
}
/** 通の中身（1通の役目・上から当てる・複数あり） */
function partsOf(t: string): string[] {
  const out: string[] = [];
  if (/かしこまりました|ありがとうございます|承知(?:致|いた)しました|お伝え頂き/.test(t)) out.push("受け");
  if (/確認させて頂|確認させていただ|お調べ|ピックアップ(?:し|して)?(?:お送り|させ)|お送りさせて頂きます|作成しお送り|ご用意/.test(t)) out.push("約束");
  if (/[?？]|でしょうか|如何でしょうか|ございますでしょうか/.test(t)) out.push("質問・誘い");
  if (/ご内覧|内覧|ご案内|お申込|抑え/.test(t)) out.push("内覧・申込の線");
  if (/となります|可能です|御座います|ございます|円|帖|徒歩|築|ご入居頂け/.test(t)) out.push("答え・事実");
  if (/何卒よろしく|お気軽に|いつでも|ご査収/.test(t)) out.push("締め");
  return out.length ? out : ["その他"];
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  // 竹内さんの手打ちがある会話だけ（頁で読む）
  const convs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) convs.add(r.conversation_id as string);
    if (!data || data.length < 1000) break;
  }
  type Turn = { scene: string; shape: string; nReply: number; len1: number; lenAll: number; asks: number; parts: string[][]; ex: string[] };
  const turns: Turn[] = [];
  for (const cid of convs) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", cid).gte("created_at", since).order("created_at", { ascending: true }).limit(2000);
    if (error) throw error;
    const ms = (data ?? []) as M[];
    let seenStaff = false;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer") { seenStaff = true; continue; }
      if (i + 1 < ms.length && ms[i + 1].sender === "customer") continue; // 連投の最後の1通から見る
      let j = i; const cust: string[] = [];
      while (j >= 0 && ms[j].sender === "customer") { cust.unshift(String(ms[j].text ?? "")); j--; }
      const t0 = Date.parse(ms[i].created_at);
      const after: M[] = [];
      for (let k = i + 1; k < ms.length && ms[k].sender !== "customer" && Date.parse(ms[k].created_at) - t0 <= 60 * 60_000; k++) if (!IMG_RE.test(String(ms[k].text ?? "")) || ms[k].is_aix_generated) after.push(ms[k]);
      if (!after.length) continue;
      if (!after.some((m) => m.staff_writer === "takeuchi" && !m.is_aix_generated)) continue;
      if (after.some((m) => m.staff_writer === "employee")) continue;
      if (after.some((m) => POST_APPLY_RE.test(String(m.text ?? ""))) || cust.some((c) => POST_APPLY_RE.test(c))) continue; // 申込の門
      // 2通目は前の通から数分以内（10分）の続きだけを「分けた」と数える
      const replies = after.filter((m) => !m.is_aix_generated);
      const firstAt = Date.parse(replies[0].created_at);
      const close = replies.filter((m) => Date.parse(m.created_at) - firstAt <= 10 * 60_000);
      let shape = ""; for (const m of after) { const k = m.is_aix_generated ? "A" : "R"; if (!(k === "A" && shape.endsWith("A"))) shape += k; }
      const texts = close.map((m) => String(m.text ?? ""));
      turns.push({ scene: sceneOf(cust.join("\n"), !seenStaff), shape, nReply: close.length, len1: texts[0]?.length ?? 0, lenAll: texts.join("").length,
        asks: (cust.join("\n").match(/[?？]/g) ?? []).length, parts: texts.map(partsOf), ex: close.length >= 2 ? texts.slice(0, 2).map((x) => MASK(x).replace(/\s+/g, " ").slice(0, 70)) : [] });
      seenStaff = true;
    }
  }
  const by: Record<string, { n: number; split: number; aix: number; len1: number[]; lenSplit: number[]; lenOne: number[]; asksSplit: number[]; asksOne: number[]; pairs: Record<string, number>; ex: string[][] }> = {};
  for (const t of turns) {
    const b = (by[t.scene] ??= { n: 0, split: 0, aix: 0, len1: [], lenSplit: [], lenOne: [], asksSplit: [], asksOne: [], pairs: {}, ex: [] });
    b.n++;
    if (t.shape.includes("A")) b.aix++;
    if (t.nReply >= 2) {
      b.split++; b.lenSplit.push(t.lenAll); b.asksSplit.push(t.asks);
      const k = `${t.parts[0].join("+")} ｜ ${t.parts[1].join("+")}`; b.pairs[k] = (b.pairs[k] ?? 0) + 1;
      if (b.ex.length < 3) b.ex.push(t.ex);
    } else { b.lenOne.push(t.lenAll); b.asksOne.push(t.asks); }
  }
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
  console.log(`竹内さんの番 ${turns.length}（${DAYS}日・従業員の混ざる番と申込以降は外した）・返信を10分以内に2通以上 ${turns.filter((t) => t.nReply >= 2).length}`);
  for (const [k, b] of Object.entries(by).sort((a, b2) => b2[1].n - a[1].n)) {
    console.log(`\n## ${k}: 番 ${b.n}・分けた ${b.split}（${Math.round((100 * b.split) / b.n)}%）・AIX のある番 ${b.aix}｜長さの中央 分けた ${med(b.lenSplit)}字／1通 ${med(b.lenOne)}字｜お客様の？の平均 分けた ${avg(b.asksSplit)}／1通 ${avg(b.asksOne)}`);
    for (const [p, n] of Object.entries(b.pairs).sort((a, c) => c[1] - a[1]).slice(0, 4)) console.log(`   ${n}× 1通目［${p.split(" ｜ ")[0]}］→ 2通目［${p.split(" ｜ ")[1]}］`);
    for (const e of b.ex) console.log(`   例: 「${e[0]}」→「${e[1]}」`);
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ days: DAYS, turns: turns.length, by }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
