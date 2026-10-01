// tmp: 手元で詳細 API（view=detail）を直接呼び、送付済みの照合（sent_room_history）と 👑 を確かめる（YUMA・読むだけ）
import { NextRequest } from "next/server";
import { GET } from "../app/api/property-pickups/route";
import { sentConfirmMessage, defaultAixChecks } from "../app/lib/pickup-review-order";
async function main() {
  const res = await GET(new NextRequest("http://localhost/api/property-pickups?view=detail&pcid=509cd061-60cc-49a9-8c5a-4f356c4a5f88&batches=30"));
  const j = await res.json() as { customer: Record<string, any> };
  const c = j.customer;
  console.log("sent_history", c.sent_history.length, "sent_room_history", c.sent_room_history?.length, "best", c.best?.id, c.best?.property_name, c.best?.room_no);
  const all = (c.batches as any[]).flatMap((b) => b.items);
  for (const id of [2261, 2251, 2252, 2253, 2254]) { const it = all.find((x: any) => x.id === id); console.log(id, it?.property_name, it?.room_no, "=>", sentConfirmMessage([it], c.sent_room_history) ?? "（確かめなし）"); }
  const checks = defaultAixChecks((c.batches as any[]).map((b) => ({ items: b.items, created_at: b.created_at })), c.best?.id ?? null, 10, { firstProposalSentAt: c.first_proposal_sent_at, sentHistory: c.sent_room_history });
  console.log("既定のチェックに入った送付済み:", [2261, 2251, 2252, 2253, 2254].filter((id) => checks[id]));
}
main().then(() => process.exit(0));
