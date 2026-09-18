// scripts/audit-opener-body.ts
// 2026-09-18 竹内（ゆうこ事例）「かしこまりましたとはいの使い分けの部分と、情報ではなくて、ここでは点と答える」
//
// 出口の2つの直しを、本番の実データ（スタッフ実送信＝正解）にそのまま当てて数える。
//   ① 開口語: お客様の質問への返信で、返信の中身が「その場で答える」なのに「かしこまりました」で始まる物
//      （＝本番でこの直しが書き換える文。スタッフの正解が書き換わるなら線が広すぎる）
//   ② 言い回し: 「〜情報はございません」→「〜点はございません」で変わってしまう実送信（期待 0 通）
//   ③ 今ある下書き（入力欄に出ている物）に当てて、実際に何件直るか
//
// 判定は app/lib/greeting.ts の classifyReplyBody / app/lib/reply-phrasing.ts の fixAbsenceWording を
// **そのまま呼ぶ**（正規表現を SQL 側に書き写さない＝四者同名）。どちらかを変えたら必ず流す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-opener-body.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { classifyReplyBody, detectOpener } from "../app/lib/greeting";
import { fixAbsenceWording } from "../app/lib/reply-phrasing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);

type Msg = { conversation_id: string; sender: string; text: string; created_at: string };

async function fetchMessages(since: string): Promise<Msg[]> {
  const out: Msg[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await sb
      .from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).not("text", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...(data as Msg[]));
    if (data.length < 1000) break;
  }
  return out;
}

const short = (s: string, n = 78) => s.replace(/\s+/g, " ").slice(0, n);

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const all = await fetchMessages(since);
  console.log(`直近 ${DAYS} 日のメッセージ ${all.length} 通を読み込み\n`);

  // 会話ごとに時系列へ並べ直して「お客様の質問 → こちらの返信」の組を作る
  const byConv = new Map<string, Msg[]>();
  for (const m of all) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push(m);
    byConv.set(m.conversation_id, list);
  }

  const buckets = { answer: { hai: 0, kashikomari: 0 }, undertake: { hai: 0, kashikomari: 0 }, unknown: { hai: 0, kashikomari: 0 } };
  const rewritten: Array<{ at: string; ask: string; sent: string }> = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (let i = 1; i < list.length; i++) {
      const reply = list[i], ask = list[i - 1];
      if (reply.sender === "customer" || ask.sender !== "customer") continue;
      if (!/[？?]/.test(ask.text)) continue;              // 質問の場面だけ（openerBodyRule が立つ場面）
      const op = detectOpener(reply.text);
      if (!op) continue;                                   // 開口語が無い返信はこの直しの対象外
      const body = reply.text.trimStart().slice(op.match.length).trimStart();
      const kind = classifyReplyBody(body);
      buckets[kind][op.opener === "hai" ? "hai" : "kashikomari"]++;
      if (kind === "answer" && op.opener !== "hai") rewritten.push({ at: reply.created_at, ask: ask.text, sent: reply.text });
    }
  }

  console.log("① 開口語（お客様の質問への返信・開口語つき）");
  console.log("   返信の中身          はい   かしこまりました");
  console.log(`   その場で答える      ${String(buckets.answer.hai).padStart(4)}   ${String(buckets.answer.kashikomari).padStart(4)}   ← ここだけ「はい」に直す`);
  console.log(`   引き受け・承諾      ${String(buckets.undertake.hai).padStart(4)}   ${String(buckets.undertake.kashikomari).padStart(4)}   ← 触らない（スタッフも両方書く）`);
  console.log(`   どちらとも言えない  ${String(buckets.unknown.hai).padStart(4)}   ${String(buckets.unknown.kashikomari).padStart(4)}   ← 触らない（fail-closed）`);
  console.log(`\n   → この直しが書き換える実送信: ${rewritten.length} 通（1桁なら線は妥当。増えたら中身を見て線を引き直す）`);
  for (const r of rewritten.slice(0, 10)) {
    console.log(`     ${new Date(r.at).toLocaleDateString("ja-JP")}  お客様「${short(r.ask, 30)}」`);
    console.log(`                 実送信「${short(r.sent)}」`);
  }

  // ② 「情報」→「点」を実送信に当てる（期待 0 通）
  const sent = all.filter((m) => m.sender !== "customer");
  const wordingHits = sent.filter((m) => fixAbsenceWording(m.text) !== m.text);
  console.log(`\n② 「〜情報はございません」→「〜点はございません」で変わる実送信: ${wordingHits.length} 通（期待 0）`);
  for (const h of wordingHits.slice(0, 10)) console.log(`     ${new Date(h.created_at).toLocaleDateString("ja-JP")}  ${short(h.text)}`);
  console.log(`   ※ 参考: 「情報」という語を含む実送信は ${sent.filter((m) => m.text.includes("情報")).length} 通（正しい使い方は触っていないことの確認）`);

  // ③ 今ある下書きに当てる
  const { data: drafts, error } = await sb
    .from("conversations").select("customer_name, ai_draft").not("ai_draft", "is", null).limit(1000);
  if (error) throw error;
  const draftHits = (drafts ?? []).filter((d) => d.ai_draft && fixAbsenceWording(d.ai_draft) !== d.ai_draft);
  console.log(`\n③ 今ある下書き ${drafts?.length ?? 0} 件のうち「情報→点」で直る物: ${draftHits.length} 件`);
  for (const d of draftHits.slice(0, 10)) console.log(`     ${d.customer_name}  ${short(d.ai_draft!)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
