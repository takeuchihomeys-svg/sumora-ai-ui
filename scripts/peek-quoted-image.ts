// 引用返信の引用先が「画像」だった通を全部出す（読み取りのみ）
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるようにする」
//   スクショ: Hina「ここの駐車所って１階ですか？」← [引用][画像]（こちらが送った物件資料）
//
// 見たいこと:
//   ① 引用先が画像の通は何件あるか（お客様の引用返信のうち何%か）
//   ② その画像は誰が送ったか（staff / customer）
//   ③ 引用先の画像の中身が分かっているか（messages.text の書き起こし / sent_properties の物件名）
//   ④ 分からない時、返信はどうなったか
//
// 実行: npx tsx --env-file=.env.local scripts/peek-quoted-image.ts [--days=90]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=90").split("=")[1]);
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

type Msg = {
  id: number | string; conversation_id: string; sender: string; text: string | null;
  image_url: string | null; image_type: string | null; line_message_id: string | null;
  quoted_message_id: string | null; created_at: string;
};

async function page<T>(table: string, cols: string, build: (q: ReturnType<typeof sb.from>) => unknown): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 30; p++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = sb.from(table).select(cols);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q = (build as any)(q);
    const { data, error } = await q.range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  // ① 引用返信（お客様）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quoting = await page<Msg>("messages", "id, conversation_id, sender, text, image_url, line_message_id, quoted_message_id, created_at", (q: any) =>
    q.eq("sender", "customer").not("quoted_message_id", "is", null).gte("created_at", since).order("created_at", { ascending: false }));
  console.log(`=== 直近${DAYS}日 お客様の引用返信: ${quoting.length}件 ===\n`);
  if (quoting.length === 0) return;

  // ② 引用先
  const ids = [...new Set(quoting.map((m) => m.quoted_message_id!).filter(Boolean))];
  const targets = new Map<string, Msg>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("messages")
      .select("id, conversation_id, sender, text, image_url, image_type, line_message_id, quoted_message_id, created_at")
      .in("line_message_id", ids.slice(i, i + 200));
    if (error) { console.log(`⚠ targets: ${error.message}`); break; }
    for (const r of (data ?? []) as Msg[]) if (r.line_message_id) targets.set(r.line_message_id, r);
  }

  const isImageText = (t: string | null) => !t || /^\s*\[(?:画像|動画)\]\s*$/.test(t);
  let notFound = 0, imgStaff = 0, imgCust = 0, textQ = 0;
  const imgRows: Array<{ m: Msg; t: Msg }> = [];
  for (const m of quoting) {
    const t = targets.get(m.quoted_message_id!);
    if (!t) { notFound++; continue; }
    const img = !!t.image_url || isImageText(t.text);
    if (!img) { textQ++; continue; }
    if (t.sender === "staff") imgStaff++; else imgCust++;
    imgRows.push({ m, t });
  }
  console.log(`引用先が見つからない : ${notFound}`);
  console.log(`引用先が文           : ${textQ}`);
  console.log(`引用先が画像         : ${imgRows.length}  （こちらが送った ${imgStaff} / お客様が送った ${imgCust}）\n`);

  // ③ 中身が分かっているか
  const urls = [...new Set(imgRows.map((r) => r.t.image_url).filter((u): u is string => !!u))];
  const labelByUrl = new Map<string, string>();
  for (const table of ["sent_image_properties", "sent_properties"] as const) {
    for (let i = 0; i < urls.length; i += 25) {   // URL は長いので小分け（200件だとリクエストが長すぎて fetch failed）
      const { data, error } = await sb.from(table).select("image_url, property_name, room_no").in("image_url", urls.slice(i, i + 25));
      if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
      for (const r of (data ?? []) as Array<{ image_url: string; property_name: string | null; room_no: string | null }>) {
        const n = (r.property_name ?? "").trim();
        if (n && !labelByUrl.has(r.image_url)) labelByUrl.set(r.image_url, r.room_no ? `${n} ${r.room_no}号室` : n);
      }
    }
  }
  let known = 0, ocr = 0, unknown = 0, noUrl = 0;
  for (const { t } of imgRows) {
    if (!t.image_url) { noUrl++; continue; }
    if (labelByUrl.has(t.image_url)) { known++; continue; }
    if (t.text && !isImageText(t.text)) { ocr++; continue; }   // 書き起こしがある（お客様の画像）
    unknown++;
  }
  console.log(`  ├ 物件が分かる（sent_properties に記録）: ${known}`);
  console.log(`  ├ 書き起こしがある（Vision 済み）        : ${ocr}`);
  console.log(`  ├ 中身が全く分からない                  : ${unknown}`);
  console.log(`  └ 画像URLすら無い                       : ${noUrl}\n`);

  // ④ 実物を出す（直近20件）
  console.log(`── 実物（直近20件）──`);
  for (const { m, t } of imgRows.slice(0, 20)) {
    const label = t.image_url ? labelByUrl.get(t.image_url) : undefined;
    const body = t.text && !isImageText(t.text) ? mask(t.text).replace(/\n/g, " ").slice(0, 70) : "";
    console.log(`${m.created_at.slice(0, 16)} conv=${String(m.conversation_id).slice(0, 8)} 引用先=${t.sender === "staff" ? "こちら" : "お客様"} ${label ? `【${label}】` : body ? `〔書起〕${body}` : "❌中身不明"}`);
    console.log(`   お客様「${mask(String(m.text ?? "")).replace(/\n/g, " ").slice(0, 60)}」  url=${t.image_url ? "あり" : "なし"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
