// 開口語・締め・名前が実送信と合っているか（読み取りのみ）
//
// 2026-09-20 竹内「はいやかしこまりましたの使い分け／何卒よろしくお願い致しますで締める部分や
//   お客さんの名前入れる部分注意して／実際の成約データや直近の会話のようにできているのかテスト」
//
// 設計知見「開口語がぶれる根本は『決定論が決めていない』こと — 正解データは ai_reply_examples の
//   ai_draft と sent_reply の差分で直接取れる（180日2,791組: かしこまり→はい 25・はい→かしこまり 28・
//   かしこまり→なし 81）」。同じ測り方で**今の状態**を出す。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 1行目の開口語 */
function opener(t: string): "はい" | "かしこまりました" | "承知" | "お世話" | "はじめまして" | "名前" | "なし" {
  const first = t.split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  if (/^はい[！!😊😌\s]/.test(first) || first === "はい") return "はい";
  if (/^かしこまりました/.test(first)) return "かしこまりました";
  if (/^承知(?:いた)?しました/.test(first)) return "承知";
  if (/^[^\s]{1,12}さん[、,]?\s*$/.test(first)) return "名前";
  if (/はじめまして/.test(first)) return "はじめまして";
  if (/お世話になっております/.test(first)) return "お世話";
  return "なし";
}
const closesNanisotsu = (t: string) => /何卒(?:よろしく|宜しく)お願い(?:致します|いたします|します)[！!😊😌\s]*$/.test(t.trim());
const hasName = (t: string, name: string) => !!name && t.includes(`${name}さん`);
const nameCount = (t: string, name: string) => name ? (t.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}さん`, "g")) ?? []).length : 0;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("conversation_id, ai_draft, sent_reply, created_at")
      .gte("created_at", since).not("ai_draft", "is", null).not("sent_reply", "is", null)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  const { data: convs } = await sb.from("conversations").select("id, customer_name").limit(6000);
  const nameOf = new Map<string, string>();
  for (const c of ((convs ?? []) as Array<{ id: string; customer_name: string | null }>)) {
    nameOf.set(c.id, (c.customer_name ?? "").replace(/[\s　]/g, ""));
  }

  const usable = rows.filter((r) => {
    const d = String(r.ai_draft ?? ""), s = String(r.sent_reply ?? "");
    return d && s && d !== "__SHOWN__" && !/^\[/.test(d) && !/^\[/.test(s) && d.length > 6 && s.length > 6;
  });
  console.log(`=== 下書きと実送信が揃う ${usable.length}件（直近${days}日）===\n`);

  // ① 開口語
  const pair = new Map<string, number>();
  let sameOpener = 0;
  for (const r of usable) {
    const a = opener(String(r.ai_draft)), b = opener(String(r.sent_reply));
    if (a === b) sameOpener++;
    else pair.set(`${a} → ${b}`, (pair.get(`${a} → ${b}`) ?? 0) + 1);
  }
  console.log(`① 開口語（1行目）`);
  console.log(`   一致: ${sameOpener}/${usable.length}件 (${((sameOpener / usable.length) * 100).toFixed(1)}%)`);
  console.log(`   --- 直された組（AI → スタッフ）上位12 ---`);
  for (const [k, n] of [...pair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`     ${String(n).padStart(4)}件  ${k}`);
  }

  // ② 「何卒よろしくお願い致します」で締める
  let dN = 0, sN = 0, bothN = 0, onlyDraft = 0, onlySent = 0;
  for (const r of usable) {
    const a = closesNanisotsu(String(r.ai_draft)), b = closesNanisotsu(String(r.sent_reply));
    if (a) dN++; if (b) sN++;
    if (a && b) bothN++; else if (a && !b) onlyDraft++; else if (!a && b) onlySent++;
  }
  const pc = (n: number) => `${((n / usable.length) * 100).toFixed(1)}%`;
  console.log(`\n② 「何卒よろしくお願い致します」で締める`);
  console.log(`   AI の下書き: ${dN}件 (${pc(dN)})`);
  console.log(`   スタッフ   : ${sN}件 (${pc(sN)})`);
  console.log(`   AI だけ付けた（スタッフが消した）: ${onlyDraft}件`);
  console.log(`   スタッフだけ付けた（AI が書けず）: ${onlySent}件`);

  // ③ 名前
  let dName = 0, sName = 0, dMulti = 0, sMulti = 0, onlyDraftName = 0, onlySentName = 0, withName = 0;
  for (const r of usable) {
    const nm = nameOf.get(String(r.conversation_id)) ?? "";
    if (!nm) continue;
    withName++;
    const a = hasName(String(r.ai_draft), nm), b = hasName(String(r.sent_reply), nm);
    if (a) dName++; if (b) sName++;
    if (nameCount(String(r.ai_draft), nm) >= 2) dMulti++;
    if (nameCount(String(r.sent_reply), nm) >= 2) sMulti++;
    if (a && !b) onlyDraftName++;
    if (!a && b) onlySentName++;
  }
  const pn = (n: number) => withName ? `${((n / withName) * 100).toFixed(1)}%` : "-";
  console.log(`\n③ お客様の名前（「〇〇さん」）— 名前が分かる ${withName}件`);
  console.log(`   AI の下書きに入っている: ${dName}件 (${pn(dName)})`);
  console.log(`   スタッフが入れている   : ${sName}件 (${pn(sName)})`);
  console.log(`   AI だけ入れた（スタッフが消した）: ${onlyDraftName}件`);
  console.log(`   スタッフだけ入れた（AI が書けず）: ${onlySentName}件`);
  console.log(`   2回以上: AI ${dMulti}件 (${pn(dMulti)}) / スタッフ ${sMulti}件 (${pn(sMulti)})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
