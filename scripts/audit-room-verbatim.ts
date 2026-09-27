// 号室の先頭0をスタッフはどう送っているか（資料の表記のまま送ってよいかの線引き）と、旧出口（号室の先頭ゼロ除去）が何を変えていたかを数える（読み取りのみ）。
// 2026-09-27 竹内さん「物件の資料の中の文字変えなくても…そのまま使う・文字抜かなくて」（YUMA 9/27 物件オススメで資料の「0206」が「206」に）。
//   ①AIX の実送信（ai_reply_examples の aix_action あり）で、下書きと送った文の🌟行の号室を並べ、スタッフが号室を直した件数
//   ②送った文に先頭0の号室が残っている件数（アクション別）と実物
//   ③旧出口（finalize の /0+(\d+)号室/ と stripRoomLeadingZeros の「ミカーサ 0203」を消す形）を実送信に当てた時に変わる件数と前後
// 実行: npx tsx --env-file=.env.local scripts/audit-room-verbatim.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const oldFinalize = (t: string) => t.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");
const oldTemplateStrip = (t: string) => oldFinalize(t).replace(/\s+0\d+(?=[\s　、。！!？?」\n]|$)/g, "");
const starRoom = (t: string) => t.split("\n").find((l) => l.startsWith("🌟"))?.match(/\s(0?\d{3,4}[A-Za-z]?)(?:号室)?\s*$/)?.[1] ?? null;
async function main() {
  const rows: any[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("aix_action, ai_draft, sent_reply, created_at").not("aix_action", "is", null)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); return; }
    rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  let both = 0, same = 0, changed = 0; const changedShow: string[] = [];
  for (const r of rows.filter((x) => x.aix_action === "property_recommendation")) {
    const d = starRoom(String(r.ai_draft ?? "")), s = starRoom(String(r.sent_reply ?? ""));
    if (!d || !s) continue; both++;
    if (d === s) same++; else { changed++; if (changedShow.length < 10) changedShow.push(`${d} → ${s}`); }
  }
  console.log("① 物件オススメ: 下書きと送った文の号室が両方ある", both, "同じ", same, "スタッフが直した", changed, changedShow);
  const zeroByAct: Record<string, number> = {}; const zeroShow: string[] = [];
  let oldFin = 0, oldTpl = 0; const oldShow: string[] = [];
  for (const r of rows) {
    const s = String(r.sent_reply ?? "");
    const lines = s.split("\n").filter((l) => /(?<![\d０-９])0[1-9]\d{1,2}(?:号室)?(?!\d)/.test(l) && /🌟|号室|【|にて|\s0\d{3}\s*$/.test(l));
    if (lines.length) { zeroByAct[r.aix_action] = (zeroByAct[r.aix_action] ?? 0) + 1; if (zeroShow.length < 20) zeroShow.push(`[${r.aix_action}] ${r.created_at.slice(0, 10)} ${lines[0].slice(0, 80)}`); }
    if (oldFinalize(s) !== s) oldFin++;
    if (oldTemplateStrip(s) !== s) { oldTpl++; if (oldShow.length < 12) { const l = s.split("\n").find((x) => oldTemplateStrip(x) !== x) ?? ""; oldShow.push(`[${r.aix_action}] 前: ${l.slice(0, 90)}\n   後: ${oldTemplateStrip(l).slice(0, 90)}`); } }
  }
  console.log("\n② 送った文に先頭0の号室（アクション別）", zeroByAct); zeroShow.forEach((x) => console.log("  " + x));
  console.log(`\n③ 旧出口を実送信 ${rows.length} 通に当てると変わる: finalize ${oldFin} 通・テンプレの strip ${oldTpl} 通`); oldShow.forEach((x) => console.log("  " + x));
}
main();
