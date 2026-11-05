// 試験の台帳の伏せ（scripts/lib/brain-exam-mask.ts maskLedgerDeep・弱い所 301）
// 実行: npx tsx scripts/lib/__tests__/brain-exam-mask-ledger.test.ts（自己完結。全 PASS で exit 0）
import { maskLedgerDeep, maskExamText, isMaskExemptValue } from "../brain-exam-mask";

let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); }
}
const mask = (s: string) => maskExamText(s, "山田 花子", []);

// 壊れていた実物の形: 秒の小数・uuid・LINE の通の id
const row = {
  id: "3f2a9c10-1234-4abc-9def-0123456789ab",
  conversation_id: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7",
  line_message_id: "585012345678901234",
  aix_usage_log_id: 1234567890,
  sent_at: "2026-09-19T10:50:19.123456+00:00",
  estimated_at: "2026-09-19 10:50:19.98765+00",
  viewing_date: "2026-09-21",
  note: "山田 花子さん 090-1234-5678 に折り返し",
  meta: { customer_phone: "08012345678", memo: "連絡先 06-6123-4567", ref_id: "06612345678", at: "2026-09-19T10:50:19.5Z" },
  lines: ["070-1111-2222 まで", "2026-09-19T10:50:19.123+09:00"],
};
const out = maskLedgerDeep(row, mask) as typeof row;
eq("id（uuid）は残す", out.id, row.id);
eq("conversation_id は残す", out.conversation_id, row.conversation_id);
eq("line_message_id は残す", out.line_message_id, row.line_message_id);
eq("数の id は残す", out.aix_usage_log_id, row.aix_usage_log_id);
eq("ISO 時刻（秒の小数）は残す", out.sent_at, row.sent_at);
eq("空白区切りの時刻も残す", out.estimated_at, row.estimated_at);
eq("日付は残す", out.viewing_date, row.viewing_date);
eq("入れ子の時刻も残す", out.meta.at, row.meta.at);
eq("配列の中の時刻も残す", out.lines[1], row.lines[1]);
// 伏せは弱くしない
eq("本文の電話と名前は伏せる", out.note.includes("090-1234-5678") || out.note.includes("山田"), false);
eq("入れ子の電話（ハイフン無し）も伏せる", out.meta.customer_phone.includes("08012345678"), false);
eq("入れ子の固定電話も伏せる", out.meta.memo.includes("6123-4567"), false);
eq("配列の電話も伏せる", out.lines[0].includes("1111-2222"), false);
eq("*_id の欄は伏せない（id の形の欄）", out.meta.ref_id, "06612345678");
// 時刻の形の中に電話を混ぜても時刻の形にならない（すり抜けない）
eq("時刻の後ろに電話を付けた文は時刻扱いしない", isMaskExemptValue("2026-09-19 090-1234-5678"), false);
eq("電話だけは時刻扱いしない", isMaskExemptValue("090-1234-5678"), false);

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
