// scripts/audit-voicing-same-room.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-voicing-same-room.ts [--days=365]
//
// 2026-10-06 竹内（R 事例「別の物件がはいりこんでしまっている…物件特定できる能力高める」）:
//   御見積書の読み取りが「カーサピエント」を「カーサビエント」と読み（sent_properties source=vision）、customer-state で
//   同じ 203号室が「見積済」と「送った候補」の2部屋に割れていた。matchRoomRefs に「濁点・半濁点だけが違い号室が同じ＝同じ部屋」を足した。
// 線を引く: 同じ会話の物件名（sent_properties・AIX の文の【〇〇 号室】🌟〇〇 号室）の組で、建物の鍵が濁点・半濁点だけ違う物を全部出す。
//   号室が同じ組（寄せる）と違う組（寄せない）を並べて目で読む。読み取りのみ・LLM なし。
import { createClient } from "@supabase/supabase-js";
import { splitPropertyName, voicingFold } from "../app/lib/customer-state";
import { extractPropertyLabels } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
const since = new Date(Date.now() - days * 86400_000).toISOString();

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  const sent = await pageAll<{ conversation_id: string | null; property_name: string | null; room_no: string | null; source: string | null }>((a, b) =>
    sb.from("sent_properties").select("conversation_id, property_name, room_no, source").gte("sent_at", since).not("conversation_id", "is", null).range(a, b));
  const aix = await pageAll<{ conversation_id: string | null; generated_text: string | null }>((a, b) =>
    sb.from("aix_generate_log").select("conversation_id, generated_text").gte("created_at", since).range(a, b));
  const byConv = new Map<string, Map<string, { name: string; room: string | null; key: string; from: string }>>();
  const add = (conv: string | null, raw: string | null, room: string | null, from: string) => {
    if (!conv || !raw) return;
    const ref = splitPropertyName(raw, room);
    if (!ref) return;
    const id = `${ref.buildingKey}#${ref.room ?? ""}`;
    const m = byConv.get(conv) ?? new Map();
    if (!m.has(id)) m.set(id, { name: ref.display, room: ref.room, key: ref.buildingKey, from });
    byConv.set(conv, m);
  };
  for (const s of sent) add(s.conversation_id, s.property_name, s.room_no, `sent:${s.source}`);
  for (const g of aix) for (const l of extractPropertyLabels(g.generated_text)) add(g.conversation_id, l, null, "aix");
  let same = 0, diff = 0;
  for (const [conv, m] of byConv) {
    const xs = [...m.values()];
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
      const a = xs[i], b = xs[j];
      if (a.key === b.key || voicingFold(a.key) !== voicingFold(b.key)) continue;
      const merge = !!a.room && !!b.room && a.room === b.room;
      if (merge) same++; else diff++;
      console.log(`${merge ? "寄せる" : "寄せない"}｜${conv.slice(0, 8)}｜${a.name}（${a.from}） ⇔ ${b.name}（${b.from}）`);
    }
  }
  console.log(`=== ${days}日: 会話 ${byConv.size}・濁点だけ違う組 ${same + diff}（号室が同じ＝寄せる ${same}・寄せない ${diff}）===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
