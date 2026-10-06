// scripts/audit-okyaku-name-slot.ts
// 行頭の名前の欄の「お客様」の出口（okyaku-address.ts）と、スタッフが冒頭で2回以上呼んだ名前（aix-staff-called-name.ts）の監査（読むだけ・LLM なし・費用0）。
//   ① 誤削除: スタッフの送信（messages・365日）に当てて、行頭の名前の欄で変わる通を数えて見せる（名前は伏せる）
//   ② 当て直し: AIX の下書きの名前の欄が「お客様」だった組（ai_reply_examples）で、直した後の1行目がスタッフの送った1行目と同じ形か
//      （スタッフが名前を書かなかった → 名前の行が無い／スタッフが名前で呼んだ → 同じ名前）
// 2026-10-06 ⑰
// 実行: npx tsx --env-file=.env.local scripts/audit-okyaku-name-slot.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { fixSecondPersonOkyaku } from "../app/lib/okyaku-address";
import { staffCalledName } from "../app/lib/aix-staff-called-name";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "365"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const mask = (s: string) => s.replace(/[^\s、。！!？?・「」]{1,12}(さん|様)/g, "〇〇$1").replace(/\n/g, "⏎").slice(0, 90);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  // ① スタッフの送信
  let staff: Row[] = [];
  for (let p = 0; p < 300; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").like("text", "%お客様%").gte("created_at", since).order("id").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    staff = staff.concat(data as Row[]);
    if (data.length < 1000) break;
  }
  staff = staff.filter((m) => m.conversation_id !== YUMA_CONVERSATION_ID);
  let slotHits = 0;
  const shown: string[] = [];
  for (const m of staff) {
    const r = fixSecondPersonOkyaku(String(m.text), null);
    if (r.changes.some((c) => c.startsWith("行頭のお客様"))) { slotHits++; if (shown.length < 10) shown.push(mask(String(m.text))); }
  }
  console.log(`① スタッフの送信（${DAYS}日・「お客様」を含む ${staff.length}通）: 行頭の名前の欄で変わる ${slotHits}通`);
  for (const s of shown) console.log(`   ${s}`);

  // ② AIX の下書きの名前の欄
  const { data: ex, error: e2 } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, created_at")
    .eq("entry_source", "aix_action").gte("created_at", new Date(Date.now() - 60 * 864e5).toISOString()).like("ai_draft", "%お客様%").limit(1000);
  if (e2) throw new Error(e2.message);
  const pairs = ((ex ?? []) as Row[]).filter((r) => r.conversation_id !== YUMA_CONVERSATION_ID && /(^|\n)[ \t　]*お客様/.test(String(r.ai_draft)));
  let before = 0, after = 0, n = 0;
  // スタッフは同じお客様でも通ごとに名前を書く／書かないを選ぶ＝「名前の有無まで一致」は厳しすぎる。
  //   分けて数える: 行頭の「お客様」が残る／スタッフが名前で呼んだ通で同じ名前／スタッフが書かなかった通で名前の行が無い・知っている名前で呼ぶ
  let okyakuLeft = 0, staffNamed = 0, sameName = 0, staffNoName = 0, noNameOmitted = 0, noNameKnown = 0;
  for (const r of pairs) {
    const { data: hist } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(60);
    const called = staffCalledName(((hist ?? []) as Row[]).reverse());
    const fixed = fixSecondPersonOkyaku(String(r.ai_draft), called || null).text;
    const first = (s: string) => String(s).split("\n").map((x) => x.trim()).find(Boolean) ?? "";
    const sentFirst = first(r.sent_reply);
    const sentName = (sentFirst.match(/^([^\s、。！？]{1,8}?)さん/) ?? [])[1] ?? "";
    const fixedName = (first(fixed).match(/^([^\s、。！？]{1,8}?)さん/) ?? [])[1] ?? "";
    const okBefore = !/^お客様/.test(first(r.ai_draft)) && false; // 前は名前の欄が必ず「お客様」＝一致しない
    const okAfter = sentName ? fixedName === sentName : !fixedName && !/^お客様/.test(first(fixed));
    n++; if (okBefore) before++; if (okAfter) after++;
    if (/(^|\n)[ \t　]*お客様/.test(fixed)) okyakuLeft++;
    if (sentName) { staffNamed++; if (fixedName === sentName) sameName++; }
    else { staffNoName++; if (!fixedName) noNameOmitted++; else noNameKnown++; }
  }
  console.log(`② AIX の下書きの名前の欄が「お客様」の組（60日）${n}: スタッフの1行目の呼び方（名前の有無まで）と一致 前 ${before} → 後 ${after}`);
  console.log(`   行頭の「お客様」が残る: 前 ${n} → 後 ${okyakuLeft}`);
  console.log(`   スタッフが名前で呼んだ ${staffNamed}通: 同じ名前 前 0 → 後 ${sameName}（残りはスタッフが2回以上呼んだ名前が無い＝呼ばない形）`);
  console.log(`   スタッフが名前を書かなかった ${staffNoName}通: 後は 名前の行なし ${noNameOmitted}・スタッフが前に呼んだ名前で呼ぶ ${noNameKnown}`);
})().catch((e) => { console.error(e); process.exit(1); });
