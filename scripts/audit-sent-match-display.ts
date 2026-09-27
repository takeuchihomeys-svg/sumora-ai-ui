// 送った画像の照合の辞書（sent-image-record.knownPropertyNames）と、状況の表示名（customer-state.splitPropertyName）の前後を比べる（読み取りのみ・LLM なし）。
// 2026-09-27 竹内さん「重い順から治す」:
//   ⑤ 照合できずに source=vision になった行（直近 N 日）に、旧の辞書（順序なし50行＋本文の「…号室」）と新しい辞書（新しい順300行・物件顧客 ID・直近14日のピックアップ・「🌟建物 0205」）を当てる
//      ＝読み取った名前（sent_image_properties.property_name）が辞書と照合できるようになるか。誤照合は目で読む
//   ⑥ 送った物件（sent_properties）の名前・号室を、旧の表示（照合用の形）と新しい表示（資料の文字）で並べ、変わる物だけ出す
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-match-display.ts [--days=14]
import { createClient } from "@supabase/supabase-js";
import { extractPropertyLabels } from "../app/lib/action-ledger";
import { matchKnownProperty } from "../app/lib/property-name-match";
import { starHeadBuilding } from "../app/lib/aix-material-facts";
import { splitPropertyName, normalizeRoomNo } from "../app/lib/customer-state";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "14"));
const since = new Date(Date.now() - DAYS * 86400000).toISOString();
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function dicts(conv: string, pcId: string | null, before: string) {
  const oldSet = new Set<string>(), newSet = new Set<string>();
  const { data: spOld } = await sb.from("sent_properties").select("property_name").eq("conversation_id", conv).lt("sent_at", before).limit(50);
  for (const r of spOld ?? []) if (r.property_name) oldSet.add(String(r.property_name).trim());
  let q = sb.from("sent_properties").select("property_name").lt("sent_at", before);
  q = pcId ? q.or(`conversation_id.eq.${conv},property_customer_id.eq.${pcId}`) : q.eq("conversation_id", conv);
  const { data: spNew } = await q.order("sent_at", { ascending: false }).limit(300);
  for (const r of spNew ?? []) if (r.property_name) newSet.add(String(r.property_name).trim());
  const { data: pk } = await sb.from("property_pickups").select("property_name").eq("conversation_id", conv).lt("created_at", before)
    .gte("created_at", new Date(Date.parse(before) - 14 * 86400000).toISOString()).limit(300);
  for (const r of pk ?? []) if (r.property_name) newSet.add(String(r.property_name).trim());
  const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", conv).lt("created_at", before).order("created_at", { ascending: false }).limit(80);
  const texts = (ms ?? []).map((m) => String(m.text ?? ""));
  for (const l of extractPropertyLabels(texts.join("\n"))) { const n = l.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim(); oldSet.add(n); newSet.add(n); }
  for (const t of texts) { const b = starHeadBuilding(t); if (b) newSet.add(b); }
  return { old: [...oldSet].filter((s) => s.length >= 2), neu: [...newSet].filter((s) => s.length >= 2) };
}

async function main() {
  // ⑤
  const { data: rows } = await sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, created_at, channel")
    .eq("source", "vision").gte("created_at", since).order("created_at", { ascending: false }).limit(500);
  let total = 0, oldHit = 0, newHit = 0; const show: string[] = [];
  const pcCache = new Map<string, string | null>();
  for (const r of rows ?? []) {
    if (!r.conversation_id || !r.property_name) continue;
    total++;
    if (!pcCache.has(r.conversation_id)) {
      const { data: c } = await sb.from("conversations").select("property_customer_id").eq("id", r.conversation_id).maybeSingle();
      pcCache.set(r.conversation_id, (c?.property_customer_id as string | null) ?? null);
    }
    const d = await dicts(r.conversation_id, pcCache.get(r.conversation_id) ?? null, r.created_at);
    const o = matchKnownProperty(r.property_name, d.old), n = matchKnownProperty(r.property_name, d.neu);
    if (o) oldHit++;
    if (n) newHit++;
    if (!o && n) show.push(`${r.conversation_id === YUMA ? "YUMA" : r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)} [${r.channel ?? "-"}] 読んだ名前「${r.property_name}」→ 辞書「${n.name}」(${n.score.toFixed(2)})`);
  }
  console.log(`■ ⑤ 照合できなかった行（source=vision・${DAYS}日）${total}行: 旧の辞書で照合 ${oldHit}行 → 新しい辞書で照合 ${newHit}行（新しく照合できる ${show.length}行・目で読む）`);
  show.forEach((s) => console.log("  " + s));

  // ⑥
  const { data: sp } = await sb.from("sent_properties").select("property_name, room_no, conversation_id").gte("sent_at", since).limit(3000);
  const oldDisplay = (raw: string, roomNo: string | null) => {
    const r = splitPropertyName(raw, roomNo);
    if (!r) return null;
    const b = raw.normalize("NFKC"); void b;
    return r.room ? `${r.buildingKey}#${r.room}` : r.buildingKey;
  };
  let n6 = 0, changed = 0; const seen = new Set<string>(); const show6: string[] = [];
  for (const r of sp ?? []) {
    const raw = String(r.property_name ?? ""); const room = r.room_no ? String(r.room_no) : null;
    const k = `${raw}|${room}`; if (seen.has(k)) continue; seen.add(k);
    const ref = splitPropertyName(raw, room);
    if (!ref) continue;
    n6++;
    // 旧の表示＝照合用の形（NFKC の建物名＋先頭0を外した号室）
    const nk = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
    const oldB = ref.building.normalize("NFKC");
    const old = ref.room ? `${oldB} ${normalizeRoomNo(room ?? ref.room)}号室` : oldB;
    void nk; void oldDisplay;
    if (old !== ref.display) { changed++; if (show6.length < 40) show6.push(`「${raw}」号室「${room ?? ""}」: 旧「${old}」→ 新「${ref.display}」`); }
  }
  console.log(`\n■ ⑥ 送った物件の表示（${DAYS}日・名前×号室 ${n6}種類）: 変わる ${changed}種類`);
  show6.forEach((s) => console.log("  " + s));
}
main().catch((e) => { console.error(e); process.exit(1); });
