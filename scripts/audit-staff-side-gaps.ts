// 「こちらの送信側」が毎回の分析にどれだけ届いているかを実データで測る（読み取りのみ）
// 2026-09-23 竹内「今受信側に分析徹底しているが、こちらの送信側の部分は DeepSeek 管轄して渡すのはどうかな？
//   （同じことを何度も言うことも防げる）」
//
// 設計知見「材料を足す前に、その材料は当たるのかを測る」に従い、足す前に3つ測る:
//   ① 今の分類（classifyLastStaffTurn・本文だけ）で、こちらの発言の何%が other のままか
//   ② other の中身は何か（2026-09-20 に docs_request / apply_done / screening_wait を足した後で、まだ何が残っているか）
//   ③ 「同じことを何度も言う」は実際に何件あるか（お客様の新しい依頼が無いのに同じ宣言を繰り返した回）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-side-gaps.ts [DAYS=60]
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn, type StaffTurnKind } from "../app/lib/reply-context";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 繰り返しを数える対象の「これからする」の宣言。
 *
 * ⚠ 2026-09-23 に一度雑に測って 639件と出したが、**連投の2通目**（同じ話を続けて送っただけ）と
 *   **物件送付の本文**まで数えていた。実物を読んで作り直した線:
 *   ①こちらの発言どうしの間が30分以上（連投を外す）
 *   ②間にお客様の発言が1通以上あり、それが依頼・質問でない（催促されていない）
 *   ③どちらも未来形の宣言（「〜させて頂きます」「〜いたします」）
 *   ④2通目に新しい具体（日付・時刻・物件名・金額）が足されていない
 *     （設計知見「良い言い直しは固有の1つを足している」）
 */
const DECLARATIONS: Array<[string, RegExp]> = [
  ["ピックアップ宣言", /(ピックアップ|お探し|探させて)[^。\n]{0,12}(させて(頂き|いただき)ます|いたします|します)/],
  ["募集状況の確認", /(募集状況|空き状況|お部屋の状況)[^。\n]{0,8}(確認|お調べ)[^。\n]{0,8}(させて(頂き|いただき)ます|いたします|します)/],
  ["御見積書を作る", /(見積書|御見積)[^。\n]{0,8}(作成|お作り|お送り)[^。\n]{0,8}(させて(頂き|いただき)ます|いたします|します)/],
  ["内覧のご案内", /(ご案内|内覧|内見)[^。\n]{0,8}(させて(頂き|いただき)ます|いたします)/],
  ["ご連絡します", /(ご連絡|お知らせ)(させて)?(頂き|いただき)ます/],
];
/** お客様が催促・依頼・質問をした（＝言い直して当然の場面。数えない） */
const CUSTOMER_ASKED = /(お願い|ください|下さい|探して|送って|見たい|見れ|希望|どう|ですか|ますか|でしょうか|\?|？)/;
/** 2通目に足された「固有の1つ」（これがあれば正しい言い直し） */
const FRESH_BIT = /\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}時|[０-９\d,]{3,}\s*円|[万]円|[ァ-ヶA-Za-z][ァ-ヶーA-Za-z・]{3,}\s*\d{2,4}号室/;
/** 連投とみなす間隔 */
const BURST_MS = 30 * 60_000;

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs: Msg[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  console.log(`直近${days}日: ${msgs.length}通 ／ 会話 ${byConv.size}件\n`);

  // ① 返信を作る場面（お客様が返信した直前のこちらの発言）を分類する
  const kinds = new Map<StaffTurnKind, number>();
  const others: string[] = [];
  let scenes = 0;
  for (const list of byConv.values()) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].sender !== "customer") continue;
      // 直前のこちらの発言（連投はまとめる。本番と同じで直近の1通を見る）
      let j = i - 1;
      while (j >= 0 && list[j].sender === "customer") j--;
      if (j < 0) continue;
      const staffText = (list[j].text ?? "").trim();
      if (!staffText || staffText === "[画像]") continue;
      scenes++;
      const t = classifyLastStaffTurn(staffText, { lastStaffAt: list[j].created_at });
      kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
      if (t.kind === "other") others.push(norm(staffText).slice(0, 90));
    }
  }
  console.log(`① 返信を作る場面 ${scenes}件 の「直前のこちらの発言」の分類（本文だけで判定）`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(k).padEnd(20)} ${String(n).padStart(5)}  ${((n / scenes) * 100).toFixed(1)}%`);
  }

  // ② other の中身（よく出る書き出しでまとめる）
  console.log(`\n② other ${others.length}件 の中身（書き出し12字でまとめた上位）`);
  const heads = new Map<string, string[]>();
  for (const o of others) { const h = o.slice(0, 12); if (!heads.has(h)) heads.set(h, []); heads.get(h)!.push(o); }
  for (const [h, v] of [...heads].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    console.log(`   ${String(v.length).padStart(4)}回  「${h}…」`);
    console.log(`         例: ${v[0]}`);
  }

  // ③ 同じことを何度も言っているか（お客様の新しい依頼が無いのに、同じ宣言を繰り返した回）
  console.log(`\n③ 同じ宣言の繰り返し（こちらの発言の間にお客様の依頼が無い＝催促されていないのに言い直した）`);
  const repeats = new Map<string, Array<{ conv: string; a: string; b: string; fresh: boolean }>>();
  for (const [conv, list] of byConv) {
    const seq = list.filter((m) => (m.text ?? "").trim() && m.text !== "[画像]");
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].sender === "customer") continue;
      for (const [label, re] of DECLARATIONS) {
        if (!re.test(seq[i].text ?? "")) continue;
        let sawCustomer = false;
        for (let j = i + 1; j < seq.length; j++) {
          const t = seq[j].text ?? "";
          if (seq[j].sender === "customer") {
            if (CUSTOMER_ASKED.test(t)) { j = seq.length; break; }   // 催促された＝言い直して当然
            sawCustomer = true; continue;
          }
          if (!re.test(t)) continue;
          // ①連投を外す ②間にお客様の発言がある ③2通目に新しい具体が無い、の3つが揃った物だけ数える
          const gap = Date.parse(seq[j].created_at) - Date.parse(seq[i].created_at);
          if (!sawCustomer || gap < BURST_MS) { break; }
          const fresh = FRESH_BIT.test(t);
          if (!repeats.has(label)) repeats.set(label, []);
          repeats.get(label)!.push({ conv: conv.slice(0, 8), a: norm(seq[i].text ?? "").slice(0, 46), b: norm(t).slice(0, 46), fresh });
          break;
        }
      }
    }
  }
  const all = [...repeats.values()].flat();
  const bad = all.filter((x) => !x.fresh);
  console.log(`   合計 ${all.length}件（うち新しい具体が足されている ${all.length - bad.length}件＝正しい言い直し ／ **具体なしの言い直し ${bad.length}件**）`);
  for (const [label, v] of [...repeats].sort((a, b) => b[1].filter((x) => !x.fresh).length - a[1].filter((x) => !x.fresh).length)) {
    const b = v.filter((x) => !x.fresh);
    console.log(`   - ${label}: 具体なし ${b.length}件 ／ 具体あり ${v.length - b.length}件`);
    for (const s of b.slice(0, 2)) console.log(`       ${s.conv}  1回目「${s.a}」\n                 2回目「${s.b}」`);
  }
  console.log(`\n※ 数えたのは「30分以上あいて・間にお客様の発言があり・催促されておらず・新しい具体も足していない」言い直しだけ`);
}
main().catch((e) => { console.error(e); process.exit(1); });
