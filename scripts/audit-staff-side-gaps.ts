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

/** 繰り返しを数える対象の宣言（お客様に「します」と言った物だけ。相槌は数えない） */
const DECLARATIONS: Array<[string, RegExp]> = [
  ["ピックアップ宣言", /(ピックアップ|お探し|探させて|お送りさせて|ご紹介させて)(させて)?(頂き|いただき)/],
  ["募集状況の確認", /(募集状況|空き状況|お部屋の状況)(を)?(含め)?.{0,6}(確認|お調べ)/],
  ["御見積書を作る", /(見積書|御見積)(を)?.{0,8}(作成|お作り|お送り)/],
  ["内覧のご案内", /(ご案内|内覧|内見).{0,10}(させて(頂き|いただき)|可能)/],
  ["ご連絡します", /(ご連絡|お知らせ)(させて)?(頂き|いただき)ます/],
  ["いつでもご連絡ください", /(いつでも|何時でも|お気軽に)(お気軽に)?(ご連絡|お知らせ)(ください|下さい)/],
];

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
  const repeats = new Map<string, Array<{ conv: string; a: string; b: string }>>();
  for (const [conv, list] of byConv) {
    const staffSeq = list.filter((m) => (m.text ?? "").trim() && m.text !== "[画像]");
    for (let i = 0; i < staffSeq.length; i++) {
      if (staffSeq[i].sender === "customer") continue;
      for (const [label, re] of DECLARATIONS) {
        if (!re.test(staffSeq[i].text ?? "")) continue;
        // 次に同じ宣言を出すまでに、お客様が「お願い・依頼」をしていないか見る
        for (let j = i + 1; j < staffSeq.length; j++) {
          const t = staffSeq[j].text ?? "";
          if (staffSeq[j].sender === "customer") {
            if (/(お願い|ください|下さい|探して|送って|見たい|希望|どう|ですか|\?|？)/.test(t)) { j = staffSeq.length; break; }
            continue;
          }
          if (re.test(t)) {
            if (!repeats.has(label)) repeats.set(label, []);
            repeats.get(label)!.push({ conv: conv.slice(0, 8), a: norm(staffSeq[i].text ?? "").slice(0, 46), b: norm(t).slice(0, 46) });
            break;
          }
        }
      }
    }
  }
  const totalRepeat = [...repeats.values()].reduce((a, b) => a + b.length, 0);
  console.log(`   合計 ${totalRepeat}件`);
  for (const [label, v] of [...repeats].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   - ${label}: ${v.length}件`);
    for (const s of v.slice(0, 2)) console.log(`       ${s.conv}  1回目「${s.a}」\n                 2回目「${s.b}」`);
  }
  console.log(`\n※ ③は「催促されていないのに言い直した」の数。全部が悪いわけではない（間が空けば言い直すのは自然）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
