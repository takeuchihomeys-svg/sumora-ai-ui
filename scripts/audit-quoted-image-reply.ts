// 引用先が「こちらが送った画像」だった時、**スタッフは実際に何を返したか**（読み取りのみ）
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるようにする」
// 決めたいこと:
//   ① 物件名を返信に書いているか（今の生成は「引用画像の物件名は絶対に書くな」と指示している）
//   ② 画像の中身（駐車場・階・設備・間取り・初期費用）を答えているか＝画像を読む必要がある質問は何割か
//   ③ その場で答えているか／「確認させて頂きます」で受けているか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-quoted-image-reply.ts [--days=120] [--show=40]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "120"));
const SHOW = Number(arg("show", "40"));
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");
const one = (s: string, n = 90) => mask(s).replace(/\n/g, " ／ ").slice(0, n);

type Msg = { id: number | string; conversation_id: string; sender: string; text: string | null; image_url: string | null; line_message_id: string | null; quoted_message_id: string | null; created_at: string };

/** 画像の中身を読まないと答えられない質問か（資料に書いてある事を聞いている） */
const NEEDS_IMAGE_RE = /駐車|駐輪|バイク|ペット|楽器|ガス|オートロック|宅配ボックス|エレベーター|階|向き|方角|広さ|平米|㎡|間取り|築|設備|家賃|賃料|敷金|礼金|初期費用|更新料|保証会社|保証人|フリーレント|即入居|いつから|入居|退去|管理費|共益費|角部屋|バルコニー|収納|洗濯|独立洗面|風呂|トイレ/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const quoting: Msg[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("messages")
      .select("id, conversation_id, sender, text, image_url, line_message_id, quoted_message_id, created_at")
      .eq("sender", "customer").not("quoted_message_id", "is", null).gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as Msg[]; quoting.push(...r); if (r.length < 1000) break;
  }
  const ids = [...new Set(quoting.map((m) => m.quoted_message_id!).filter(Boolean))];
  const targets = new Map<string, Msg>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from("messages")
      .select("id, conversation_id, sender, text, image_url, line_message_id, quoted_message_id, created_at")
      .in("line_message_id", ids.slice(i, i + 150));
    for (const r of (data ?? []) as Msg[]) if (r.line_message_id) targets.set(r.line_message_id, r);
  }
  const isImageText = (t: string | null) => !t || /^\s*\[(?:画像|動画)\]\s*$/.test(t);
  const cases = quoting.filter((m) => {
    const t = targets.get(m.quoted_message_id!);
    return !!t && t.sender === "staff" && (!!t.image_url || isImageText(t.text));
  });
  console.log(`=== 直近${DAYS}日 「こちらが送った画像」への引用返信 ${cases.length}件 ===\n`);

  // 物件名（引用先の画像 → sent_image_properties / sent_properties）
  const urls = [...new Set(cases.map((m) => targets.get(m.quoted_message_id!)!.image_url).filter((u): u is string => !!u))];
  const nameByUrl = new Map<string, { name: string; room: string }>();
  for (const table of ["sent_image_properties", "sent_properties"] as const) {
    for (let i = 0; i < urls.length; i += 25) {
      const { data, error } = await sb.from(table).select("image_url, property_name, room_no").in("image_url", urls.slice(i, i + 25));
      if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
      for (const r of (data ?? []) as Array<{ image_url: string; property_name: string | null; room_no: string | null }>) {
        if (r.property_name && !nameByUrl.has(r.image_url)) nameByUrl.set(r.image_url, { name: r.property_name.trim(), room: (r.room_no ?? "").trim() });
      }
    }
  }

  // スタッフの返信（その発言の後・24時間以内の最初のスタッフ発言）
  // ⚠ 会話をまとめて取ると PostgREST の上限1000件に当たって古い方しか返らない（実際に全件「返信なし」に見えた）。
  //   1件ずつ「その時刻より後の最初の1通」を取る。
  const replyOf = new Map<string, Msg | null>();
  for (const m of cases) {
    const { data } = await sb.from("messages")
      .select("id, conversation_id, sender, text, image_url, line_message_id, quoted_message_id, created_at")
      .eq("conversation_id", m.conversation_id).eq("sender", "staff")
      .gt("created_at", m.created_at)
      .lt("created_at", new Date(Date.parse(m.created_at) + 24 * 3600_000).toISOString())
      .order("created_at", { ascending: true }).limit(1);
    replyOf.set(String(m.id), ((data ?? [])[0] as Msg | undefined) ?? null);
  }

  let withName = 0, needImg = 0, needImgAnswered = 0, confirmOnly = 0, replied = 0;
  const shown: string[] = [];
  const CONFIRM_RE = /確認(させて|いたし|し)て?(頂|いただ)|確認致します|お調べ|問い合わせ/;
  for (const m of cases) {
    const t = targets.get(m.quoted_message_id!)!;
    const prop = t.image_url ? nameByUrl.get(t.image_url) : undefined;
    const reply = replyOf.get(String(m.id)) ?? null;
    const replyText = String(reply?.text ?? "");
    const custText = String(m.text ?? "");
    const needs = NEEDS_IMAGE_RE.test(custText);
    if (reply) replied++;
    if (needs) needImg++;
    const named = !!prop && prop.name.length >= 3 && replyText.includes(prop.name);
    if (named) withName++;
    const confirmed = CONFIRM_RE.test(replyText);
    if (needs && reply && !confirmed) needImgAnswered++;
    if (confirmed) confirmOnly++;
    if (shown.length < SHOW) {
      shown.push([
        `${m.created_at.slice(0, 16)} ${prop ? `【${prop.name}${prop.room ? ` ${prop.room}号室` : ""}】` : "【物件不明】"}${needs ? " 〈資料を読む質問〉" : ""}`,
        `  客 : ${one(custText, 80)}`,
        `  実送信: ${reply ? one(replyText, 120) : "（返信なし）"}${named ? "  ← 物件名あり" : ""}`,
      ].join("\n"));
    }
  }
  const pct = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : "-";
  console.log(`スタッフが返信した            : ${replied} / ${cases.length}（${pct(replied, cases.length)}）`);
  console.log(`返信に引用先の物件名を書いた  : ${withName} / ${cases.length}（${pct(withName, cases.length)}）`);
  console.log(`資料を読まないと答えられない質問: ${needImg} / ${cases.length}（${pct(needImg, cases.length)}）`);
  console.log(`  └ うち「確認します」で受けずにその場で答えた: ${needImgAnswered}（${pct(needImgAnswered, needImg)}）`);
  console.log(`返信が「確認させて頂きます」型 : ${confirmOnly} / ${cases.length}（${pct(confirmOnly, cases.length)}）\n`);
  console.log(shown.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
