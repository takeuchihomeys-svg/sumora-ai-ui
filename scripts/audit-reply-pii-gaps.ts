// 返信生成（DeepSeek に回る唯一の文の経路）で、伏せ切れずに外へ出る個人情報が無いかを実データで測る（読み取りのみ）
// 2026-09-23 竹内「生成の文だけ DeepSeek だと個人情報が渡る心配もないのかな？」
//
// 見る所は2つ:
//   ① お客様の発言・こちらの送信に、**伏せる仕組みを通しても残る**連絡先が何通あるか
//      （RE_MOBILE は 070/080/090 だけ。固定電話 06-・050-・0120- は対象外）
//   ② キャッシュの印が付いたブロック（＝マスクを掛けない所）に個人情報が無いか
//      手本 ai_reply_examples・ナレッジ ai_reply_knowledge・テンプレは過去の実物なので、本名や連絡先が焼き込まれている恐れがある
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-pii-gaps.ts [DAYS=90]
import { createClient } from "@supabase/supabase-js";
import { createMasker } from "../app/lib/pii-pseudonym";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

/** 連絡先に見える形（携帯・固定・IP・フリーダイヤル）。伏せる仕組みが拾うのは 070/080/090 だけ */
const ANY_PHONE = /(?<![\d-])0\d{1,4}[-ー－()\s]?\d{1,4}[-ー－()\s]?\d{3,4}(?![\d-])/g;
const MOBILE = /^0[789]0/;
/** 明らかに電話ではない数字を外す（家賃・面積・築年数・郵便番号・日付） */
const NOT_PHONE_CTX = /(円|万|㎡|平米|年築|築|階|号室|丁目|番地|〒|年|月|日|時|分)/;

/** 伏せた後に入る偽番号（pii-pseudonym の `090-0000-NNNN`）。これを漏れと数えない */
const FAKE_MOBILE = /^0900000\d{4}$/;
/** 個人の情報のそばにある番号か（申込フォーム・本人の連絡先）。会社の代表番号・コールセンターと分ける */
const PERSONAL_CTX = /(氏名|フリガナ|生年月日|現住所|勤務先|緊急連絡先|保証人|続柄|年収|申込|本人|携帯|自宅|連絡先)/;
/** 会社の公開番号（管理会社・保険会社・コールセンター）。個人情報ではない */
const BUSINESS_CTX = /(管理会社|株式会社|有限会社|コールセンター|カスタマー|お客さま専用|ダイヤル|取扱代理店|営業時間|不動産|保険)/;

const ex = (s: string, i: number, w = 24) => s.slice(Math.max(0, i - w), i + w).replace(/\s+/g, " ");

async function main() {
  const days = Number(process.env.DAYS ?? 90);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // 申込以降の会話は DeepSeek に回らない（歯止め）ので、対象から外して数える
  const { data: convs } = await sb.from("conversations").select("id, status, customer_name").limit(5000);
  const convRows = (convs ?? []) as Array<{ id: string; status: string | null; customer_name: string | null }>;
  const routed = new Map(convRows.filter((c) => !DRAFT_SKIP_STATUSES.has((c.status ?? "").trim())).map((c) => [c.id, c]));
  console.log(`会話 ${convRows.length}件 ／ うち DeepSeek に回りうる（申込前） ${routed.size}件\n`);

  const msgs: Array<{ conversation_id: string; sender: string | null; text: string | null }> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`messages 読み取り: ${error.message}`); break; }
    const r = (data ?? []) as typeof msgs; msgs.push(...r); if (r.length < 1000) break;
  }
  const target = msgs.filter((m) => routed.has(m.conversation_id) && (m.text ?? "").trim());
  console.log(`① 直近${days}日のメッセージ ${msgs.length}通 ／ うち回りうる会話の分 ${target.length}通`);

  const maskers = new Map<string, ReturnType<typeof createMasker>>();
  const leaks: Array<{ conv: string; sender: string; kind: string; sample: string }> = [];
  for (const m of target) {
    const text = m.text ?? "";
    if (!ANY_PHONE.test(text)) { ANY_PHONE.lastIndex = 0; continue; }
    ANY_PHONE.lastIndex = 0;
    const c = routed.get(m.conversation_id)!;
    if (!maskers.has(c.id)) maskers.set(c.id, createMasker({ conversationId: c.id, customerName: c.customer_name ?? null, knownNames: [] }));
    const masked = maskers.get(c.id)!.mask(text);
    for (const hit of masked.matchAll(ANY_PHONE)) {
      const raw = hit[0];
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 11) continue;                 // 電話の桁でない
      if (NOT_PHONE_CTX.test(ex(masked, hit.index ?? 0, 6))) continue;        // 家賃・面積・日付の並び
      if (FAKE_MOBILE.test(digits)) continue;                                  // 伏せた後の偽番号（＝正しく伏せられている）
      const around = ex(masked, hit.index ?? 0, 40);
      const personal = PERSONAL_CTX.test(around) && !BUSINESS_CTX.test(around);
      leaks.push({
        conv: c.id.slice(0, 8), sender: m.sender ?? "?",
        kind: (MOBILE.test(digits) ? "携帯" : digits.startsWith("050") ? "IP電話" : digits.startsWith("0120") || digits.startsWith("0800") ? "フリーダイヤル" : "固定電話")
          + (personal ? "・個人の情報のそば ⚠" : "・会社の番号"),
        sample: ex(masked, hit.index ?? 0),
      });
    }
  }
  const byKind = new Map<string, typeof leaks>();
  for (const l of leaks) { if (!byKind.has(l.kind)) byKind.set(l.kind, []); byKind.get(l.kind)!.push(l); }
  console.log(`   伏せた後も残る番号: ${leaks.length}件`);
  for (const [k, v] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   - ${k}: ${v.length}件（差出人 お客様 ${v.filter((x) => x.sender === "customer").length} / こちら ${v.filter((x) => x.sender !== "customer").length}）`);
    for (const s of v.slice(0, 3)) console.log(`       ${s.conv} ${s.sender}: …${s.sample}…`);
  }

  // ①-2 ラベルの無い住所（「現住所:」が付いていない番地）。伏せる仕組みはラベル付きしか拾わない
  const ADDR = /[^\n\s]{0,10}?[市区町村][^\n\s]{0,14}?\d{1,4}[-−ー丁目]\d{1,4}(?:[-−ー番地]\d{1,4})?/g;
  const addrHits: Array<{ conv: string; sender: string; sample: string; personal: boolean }> = [];
  for (const m of target) {
    const c = routed.get(m.conversation_id)!;
    if (!maskers.has(c.id)) maskers.set(c.id, createMasker({ conversationId: c.id, customerName: c.customer_name ?? null, knownNames: [] }));
    const masked = maskers.get(c.id)!.mask(m.text ?? "");
    for (const hit of masked.matchAll(ADDR)) {
      const around = ex(masked, hit.index ?? 0, 40);
      // 物件の所在地は伏せる対象ではない（返信に要る）。お客様本人の住まいらしい時だけ数える
      const personal = /(現住所|お住まい|住んで|実家|自宅|引越し前|今の家|本籍)/.test(around) && !/(物件|所在地|最寄|マンション|アパート|ハイツ|レジデンス)/.test(around);
      addrHits.push({ conv: c.id.slice(0, 8), sender: m.sender ?? "?", sample: around, personal });
    }
  }
  const addrPersonal = addrHits.filter((a) => a.personal);
  console.log(`\n①-2 ラベルの無い番地: ${addrHits.length}件（うち お客様本人の住まいらしい ${addrPersonal.length}件）`);
  for (const a of addrPersonal.slice(0, 5)) console.log(`   ${a.conv} ${a.sender}: …${a.sample}…`);

  // ② キャッシュ側（マスクを掛けない所）に個人情報が無いか
  console.log(`\n② キャッシュの印が付いたブロック（マスクを掛けない所）の中身`);
  const NAME_HON = /([一-龥ぁ-んァ-ヶー]{2,5})(さん|様|さま)/g;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  for (const [table, col] of [["ai_reply_examples", "sent_reply"], ["ai_reply_examples", "customer_message"], ["ai_reply_examples", "ai_draft"], ["ai_reply_knowledge", "content"]] as const) {
    const { data, error } = await sb.from(table).select(col).limit(3000);
    if (error) { console.log(`   ${table}.${col}: 読めず（${error.message.slice(0, 40)}）`); continue; }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r[col] ?? ""));
    const phone = rows.filter((t) => { ANY_PHONE.lastIndex = 0; return [...t.matchAll(ANY_PHONE)].some((h) => { const d = h[0].replace(/\D/g, ""); return d.length >= 10 && d.length <= 11 && !NOT_PHONE_CTX.test(ex(t, h.index ?? 0, 6)); }); });
    const mail = rows.filter((t) => { EMAIL.lastIndex = 0; return EMAIL.test(t); });
    const names = new Set<string>();
    for (const t of rows) for (const h of t.matchAll(NAME_HON)) names.add(h[1]);
    console.log(`   ${table}.${col}（${rows.length}件）: 連絡先 ${phone.length}件 ／ メール ${mail.length}件 ／ 「〇〇さん」形の呼び名 ${names.size}種`);
    if (phone.length) console.log(`       例: …${ex(phone[0], phone[0].search(ANY_PHONE))}…`);
    if (names.size) console.log(`       呼び名の例: ${[...names].slice(0, 8).join("・")}`);
  }
  console.log(`\n※ 中身は前後24字だけ出している。件数だけでなく、出た例を目で読むこと`);
}
main().catch((e) => { console.error(e); process.exit(1); });
