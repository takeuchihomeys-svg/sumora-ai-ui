// お客様の設備の質問（app/lib/equipment-question.ts detectEquipmentQuestion）を実送信に当てて目で読む監査（読み取りのみ）
//
// 2026-09-29 竹内（林田尚貴さん「ガスコンロはついてないのですか？」）「この場合はガスコンロ付きかどうか画像分析をおこなう」
// 【見る物】
//   A. 広い候補（設備の語＋聞く形のお客様の文・200字以内）を全部並べ、当たり／外れを印にして全部読む
//   B. 当たった通の後24時間でスタッフが何をしたか（AIX mgmt_equipment／本文で有ると答えた／本文で無いと答えた／確認します／その他）
//   C. 2026-09-29 反証: 当たった通で、どの物件を対象に選んだか（pickEquipmentTargets・送った物件＋お客様の画像の時刻）と、
//      送った物件に無い建物名らしい語（mentionsUnknownBuilding）を並べて目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-equipment-question.ts [DAYS=365] [SHOW=all|hit|miss]
import { createClient } from "@supabase/supabase-js";
import { detectEquipmentQuestion, pickEquipmentTargets, mentionsUnknownBuilding, type SentPropertyLite } from "../app/lib/equipment-question";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) { console.error(error.message); break; } const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const BROAD = /コンロ|IH|ＩＨ|エアコン|クーラー|冷暖房|バス.?トイレ|風呂.?トイレ|トイレ.?(?:別|一緒)|ユニットバス|3点|洗面|洗濯機|オートロック|宅配|インターネット|ネット|Wi-?Fi|wifi|追い?焚|浴室乾燥|ウォシュレット|温水洗浄|エレベータ|ガス|ベランダ|バルコニー/i;
const one = (s: string | null | undefined, n = 140) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const jst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
function classify(texts: string[], aixEq: boolean): string {
  const t = texts.join("\n");
  if (aixEq) return "AIX設備";
  if (!texts.length) return "返信なし";
  if (/確認させて(?:頂|いただ)き(?:ます|ますね)|確認(?:出来|でき)次第|確認いたします|確認します/.test(t) && !/確認させて(?:頂|いただ)き(?:まし)?た/.test(t)) return "確認します";
  if (/備わ(?:って|った|っている)|ついて(?:いる|おり)|付いて(?:いる|おり)|ございます|設置されて|となります/.test(t) && !/(?:備わって|ついて|付いて)(?:い|お)?(?:ない|りません)|ございません|設置されていない|できない/.test(t)) return "本文で有る";
  if (/(?:備わって|ついて|付いて)(?:い|お)?(?:ない|りません)|ございません|設置されていない|設置いただく|外置き|ベランダ置き|できない/.test(t)) return "本文で無い";
  return "その他";
}
async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const show = (process.env.SHOW ?? "all").toLowerCase();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").gte("created_at", since).order("created_at").range(a, b));
  const aix = await all<{ conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string }>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).order("created_at").range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const arr = byConv.get(m.conversation_id) ?? []; arr.push(m); byConv.set(m.conversation_id, arr); }
  const cands = msgs.filter((m) => m.sender === "customer" && m.text && m.text.length <= 400 && !/^\s*\[/.test(m.text) && BROAD.test(m.text));
  const tally = new Map<string, number>();
  let hitN = 0;
  for (const c of cands) {
    const q = detectEquipmentQuestion(c.text);
    if (q) hitN++;
    if (show === "hit" && !q) continue;
    if (show === "miss" && q) continue;
    const conv = byConv.get(c.conversation_id)!;
    const i = conv.findIndex((m) => m.id === c.id);
    const t0 = Date.parse(c.created_at);
    const after = conv.slice(i + 1).filter((m) => Date.parse(m.created_at) - t0 < 24 * 3600_000).filter((m) => m.sender !== "customer").slice(0, 3);
    const aixEq = aix.some((a) => a.conversation_id === c.conversation_id && a.check_pattern === "mgmt_equipment" && Date.parse(a.created_at) >= t0 && Date.parse(a.created_at) - t0 < 48 * 3600_000);
    const cls = q ? classify(after.map((a) => a.text ?? ""), aixEq) : "";
    if (q) tally.set(cls, (tally.get(cls) ?? 0) + 1);
    console.log(`\n${q ? "◎当" : "・外"} [${jst(c.created_at)}] ${c.conversation_id.slice(0, 8)} ${q ? `{${q.topics.join(",")}} ${cls}` : ""}\n   客: ${one(c.text, 200)}`);
    if (q) {
      const { data: sent } = await sb.from("sent_image_properties").select("property_name, room_no, channel, created_at, image_url")
        .eq("conversation_id", c.conversation_id).lte("created_at", c.created_at).order("created_at", { ascending: false }).limit(40);
      const sentRows = (sent ?? []) as SentPropertyLite[];
      const custImgs = conv.filter((m) => m.sender === "customer" && m.image_url && Date.parse(m.created_at) <= t0).map((m) => m.created_at);
      const tg = pickEquipmentTargets(c.text!, sentRows, { askedAt: c.created_at, customerImageAts: custImgs });
      const unk = mentionsUnknownBuilding(c.text!, sentRows.slice(0, 10).map((r) => r.property_name));
      const lastSent = sentRows[0]?.created_at ? Math.round((t0 - Date.parse(sentRows[0].created_at)) / 60_000) : null;
      console.log(`   対象: ${tg.length ? tg.map((x) => `${x.property_name} ${x.room_no ?? ""}〔${x.by}〕`).join("／") : "なし"}${unk ? "（送っていない建物名らしい語あり）" : ""}・直前の送付から ${lastSent ?? "-"}分`);
    }
    if (q) for (const a of after) console.log(`   → ${a.is_aix_generated ? "AIX" : "手"}${a.image_url ? "📷" : ""} ${one(a.text, 160)}`);
  }
  console.log(`\n直近${days}日: 広い候補 ${cands.length}通・当たり ${hitN}通`);
  console.log("当たった通のスタッフの返し:", [...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("／"));
}
main();
