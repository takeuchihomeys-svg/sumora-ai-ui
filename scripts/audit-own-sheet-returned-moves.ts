// お客様がこちらの物件資料を送り返してきた番で、竹内さん（とスタッフ）が何をしたか・照合の取り違えが無いかの監査（読むだけ）
//
// 2026-11-05 統括役（8931・弱い所 302）: 「送り返してきた番で竹内さんが確認せず見積書に直行した番が何割か」「照合に当たった物件のうち、実は別の物件だった数が0か」
//   取り出しの号室の見出しを広げる（OWN_PROPERTY_ROOM_LABEL_WIDE）前と後で、same_room（こちらが送った物件と言い切る）を数える。
//   取り違えの確かめ: 画像の賃料と、照合した送付の賃料（sent_properties.rent）が合うか。合わない・分からない物は目で読む行に出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-own-sheet-returned-moves.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { extractScreenshotProperty, matchOwnProperty, normalizeRoom, type SentProperty } from "../app/lib/own-property-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "90"));
const ESTIMATE_RE = /御見積書|お見積書|見積書|お見積り|御見積/;
const CHECK_RE = /募集状況(?:を)?(?:確認|ご確認)|空き状況(?:を)?確認|確認させて頂きます|確認させていただきます/;

async function page<T>(table: string, cols: string, build: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
type Msg = { id: string; conversation_id: string; created_at: string; text: string | null; sender: string; is_aix_generated: boolean | null; staff_writer: string | null };
type Sent = SentProperty & { rent: number | null };
const rentOf = (t: string): number | null => {
  const m = t.normalize("NFKC").match(/賃料[:：]?\s*([0-9,]{4,7})\s*円|賃料[:：]?\s*([0-9.]+)\s*万/);
  if (!m) return null;
  return m[1] ? Number(m[1].replace(/,/g, "")) : Math.round(Number(m[2]) * 10000);
};
type Row = { m: Msg; name: string; room: string | null; sent: Sent; rentOk: boolean | null; move: string; writer: string; staff: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const imgs = await page<Msg>("messages", "id, conversation_id, created_at, text, sender, is_aix_generated, staff_writer",
    (q) => q.eq("sender", "customer").like("text", "[画像]%").gte("created_at", since).order("created_at", { ascending: true }));
  const cand = imgs.filter((m) => /物件名|名称/.test(m.text ?? ""));
  const convs = [...new Set(cand.map((m) => m.conversation_id))];
  const sentBy = new Map<string, Sent[]>();
  const after = new Map<string, Msg[]>();
  const aixBy = new Map<string, Array<{ created_at: string; aix_type: string | null; template_name: string | null }>>();
  for (let i = 0; i < convs.length; i += 50) {
    const ch = convs.slice(i, i + 50);
    const [sp, sm, ax] = await Promise.all([
      page<{ conversation_id: string; property_name: string | null; room_no: string | null; sent_at: string | null; rent: number | null }>("sent_properties", "conversation_id, property_name, room_no, sent_at, rent", (q) => q.in("conversation_id", ch)),
      page<Msg>("messages", "id, conversation_id, created_at, text, sender, is_aix_generated, staff_writer", (q) => q.in("conversation_id", ch).eq("sender", "staff").gte("created_at", since).order("created_at", { ascending: true })),
      page<{ conversation_id: string; created_at: string; aix_type: string | null; template_name: string | null }>("aix_usage_logs", "conversation_id, created_at, aix_type, template_name", (q) => q.in("conversation_id", ch).gte("created_at", since)),
    ]);
    for (const r of sp) { const a = sentBy.get(r.conversation_id) ?? []; a.push({ name: r.property_name ?? "", room: r.room_no, sentAt: r.sent_at, rent: r.rent }); sentBy.set(r.conversation_id, a); }
    for (const r of sm) { const a = after.get(r.conversation_id) ?? []; a.push(r); after.set(r.conversation_id, a); }
    for (const r of ax) { const a = aixBy.get(r.conversation_id) ?? []; a.push(r); aixBy.set(r.conversation_id, a); }
  }
  const run = (wide: boolean): Row[] => {
    process.env.OWN_PROPERTY_ROOM_LABEL_WIDE = wide ? "on" : "off";
    const rows: Row[] = [];
    for (const m of cand) {
      const it = extractScreenshotProperty(m.text);
      if (!it) continue;
      const sent = (sentBy.get(m.conversation_id) ?? []).filter((s) => s.name && s.sentAt && s.sentAt < m.created_at && Date.parse(m.created_at) - Date.parse(s.sentAt) <= 30 * 86400_000);
      const r = matchOwnProperty(it, sent);
      if (r.kind !== "same_room" || !r.sent) continue;
      const s = r.sent as Sent;
      const ir = rentOf(m.text ?? "");
      const rentOk = ir == null || s.rent == null ? null : Math.abs(ir - s.rent) <= 1000;
      const t0 = Date.parse(m.created_at);
      const within = (iso: string) => Date.parse(iso) > t0 && Date.parse(iso) - t0 <= 12 * 3600_000;
      const st = (after.get(m.conversation_id) ?? []).filter((x) => within(x.created_at) && (x.text ?? "").length > 3);
      const ax = (aixBy.get(m.conversation_id) ?? []).filter((x) => within(x.created_at)).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const first = st[0];
      const txt = st.slice(0, 3).map((x) => x.text ?? "").join("\n");
      const axs = ax.map((x) => `${x.aix_type ?? ""}/${x.template_name ?? ""}`).join(",");
      const move = /estimate|見積/.test(axs) || ESTIMATE_RE.test(txt) ? "見積書" : /property_check|物件確認|確認/.test(axs) || CHECK_RE.test(txt) ? "確認" : first ? "その他" : "返し無し";
      rows.push({ m, name: it.name, room: it.room, sent: s, rentOk, move, writer: first?.staff_writer ?? "-", staff: (first?.text ?? "").replace(/\s+/g, " ").slice(0, 60) + (axs ? ` ［AIX ${axs.slice(0, 60)}］` : "") });
    }
    return rows;
  };
  const off = run(false);
  const on = run(true);
  const offIds = new Set(off.map((r) => r.m.id));
  console.log(`お客様の画像 ${imgs.length}通・物件名の見出しあり ${cand.length}通（${DAYS}日）`);
  const count = (rs: Row[]) => { const m = new Map<string, number>(); for (const r of rs) m.set(r.move, (m.get(r.move) ?? 0) + 1); return [...m].map(([k, v]) => `${k} ${v}`).join("・"); };
  for (const [lab, rows] of [["今（off）", off], ["号室の見出しを広げた（on）", on]] as const) {
    const tk = rows.filter((r) => r.writer === "takeuchi");
    console.log(`\n■ ${lab}: こちらの物件と言い切った ${rows.length}通（竹内さんの番 ${tk.length}）`);
    console.log(`  全員の次の一手: ${count(rows)}`);
    console.log(`  竹内さんの次の一手: ${count(tk)}`);
    console.log(`  賃料の照らし合わせ: 合う ${rows.filter((r) => r.rentOk === true).length}・合わない ${rows.filter((r) => r.rentOk === false).length}・分からない ${rows.filter((r) => r.rentOk == null).length}`);
  }
  console.log(`\n── on で新しく言い切った通・賃料が合わない／名前の違う物（目で読む）──`);
  for (const r of on) {
    const fresh = !offIds.has(r.m.id);
    if (!process.argv.includes("--all") && !fresh && r.rentOk !== false && r.name === r.sent.name) continue;
    console.log(`${fresh ? "新" : "  "} ${r.m.created_at.slice(0, 16)} ${r.m.conversation_id.slice(0, 8)} 画像「${r.name} ${r.room ?? "-"}」↔ 送付「${r.sent.name} ${normalizeRoom(r.sent.room) ?? "-"}」 賃料${r.rentOk == null ? "?" : r.rentOk ? "○" : "×"} → ${r.writer} ${r.move}: ${r.staff}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
