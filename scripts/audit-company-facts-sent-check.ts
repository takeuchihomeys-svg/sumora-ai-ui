// S6 実送信側の点検（読み取りのみ）
//  ① 今月のこちらの送信に「会社の事実に反する文」が何通あるか（0が合格）
//  ② prorated_rent の当たり漏れ: 見積書テンプレの定型（※ご入居日によって日割家賃が発生致します）を除いた
//     手打ちの「日割」の説明で、直前3通のお客様発言が当たっていない物を目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-company-facts-sent-check.ts
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SINCE = process.env.SINCE ?? "2026-08-31T15:00:00Z";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string; is_aix_generated: boolean | null };
const mask = (s: string) => s.replace(/https?:\/\/\S+/g, "[URL]").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/\s+/g, " ").trim();
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

/** 会社の事実に反する断定（誤って書いたら事故になる形） */
const CONTRA: Array<{ id: string; re: RegExp }> = [
  { id: "store: 店舗訪問を受け入れ", re: /(店舗|事務所)[^。\n]{0,16}(お待ちしております|お越しください|ご来店ください|ご来店をお待ち)/ },
  { id: "emergency: 緊急連絡先は不要／なくても可", re: /緊急連絡先[^。\n]{0,10}(不要|無くても|なくても|必ずしも|柔軟)/ },
  { id: "room_photo: 写真が無いと断定", re: /(室内|お部屋)[^。\n]{0,6}(写真|画像)[^。\n]{0,8}(ございません|ありません|ご用意(出来|でき)て(い)?ない)/ },
  { id: "cancel: 審査前でもキャンセル料がかかる", re: /(お申込|申込)[^。\n]{0,10}後[^。\n]{0,12}キャンセル料[^。\n]{0,8}(発生|必要|かかり)/ },
  { id: "prorated: 1日入居でも日割が発生", re: /1日[^。\n]{0,4}入居[^。\n]{0,10}日割[^。\n]{0,6}(発生|かかり)/ },
  { id: "viewing: オンライン内覧は出来ない（全体）", re: /オンライン(内覧|内見)[^。\n]{0,6}(出来|でき|行って)(ません|おりません)/ },
  { id: "area: 大阪府外も紹介", re: /(兵庫|京都|奈良|東京)[^。\n]{0,8}(お部屋|物件)[^。\n]{0,8}(ご紹介|ピックアップ)(可能|できます|出来ます)/ },
];

async function main() {
  const msgs: Msg[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated")
      .gte("created_at", SINCE).neq("conversation_id", YUMA).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const l = byConv.get(m.conversation_id) ?? []; l.push(m); byConv.set(m.conversation_id, l); }
  const staff = msgs.filter((m) => m.sender !== "customer" && (m.text ?? "").trim() && m.text !== "[画像]");
  console.log(`今月のこちらの送信 ${staff.length}通\n\n【① 会社の事実に反する文】`);
  let contra = 0;
  for (const c of CONTRA) {
    const hit = staff.filter((s) => c.re.test(String(s.text)));
    console.log(`  ${c.id.padEnd(32)} ${hit.length}通`);
    for (const h of hit.slice(0, 5)) console.log(`     [${jst(h.created_at)}] ${mask(String(h.text)).slice(0, 200)}`);
    contra += hit.length;
  }
  console.log(`  合計 ${contra}通（目で読んで本当に反しているかを確認する）`);

  console.log(`\n【② 手打ちの「日割」説明（見積書の定型を除く）で、直前3通のお客様発言が当たっていない物】`);
  let n = 0;
  for (const s of staff) {
    const t = String(s.text);
    if (!/日割|前家賃/.test(t)) continue;
    if (/※ご入居日によって日割家賃が発生致します/.test(t) && /初期費用(：|さらに)/.test(t)) continue; // 見積書テンプレ
    const conv = byConv.get(s.conversation_id) ?? [];
    const tt = Date.parse(s.created_at);
    const prev = [...conv].reverse().filter((x) => x.sender === "customer" && Date.parse(x.created_at) < tt && (x.text ?? "").trim()).slice(0, 3);
    const matched = prev.some((x) => matchCompanyFacts(x.text).some((f) => f.id === "prorated_rent"));
    if (matched) continue;
    n++;
    console.log(`  ── [${jst(s.created_at)}${s.is_aix_generated ? "/AIX" : ""}] conv=${s.conversation_id.slice(0, 8)}`);
    for (const x of [...prev].reverse()) console.log(`     客: ${mask(String(x.text)).slice(0, 120)}`);
    console.log(`     こちら: ${mask(t).slice(0, 220)}`);
  }
  console.log(`  ${n}通`);
}
main().catch((e) => { console.error(e); process.exit(1); });
