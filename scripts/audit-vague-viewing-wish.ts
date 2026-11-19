// scripts/audit-vague-viewing-wish.ts — お部屋も日にちも決まっていない「ふわっとした内覧の希望」の番で、スタッフが何を送ったかを実送信で数える（読むだけ・LLM なし）
//
// 2026-11-14 作業員B（q427 の細分化・統括役）。q427: 複数のお部屋を送った後の「後内とかもしたいです」に竹内さんは返信で
//   「お部屋のご案内も可能です！！お気に召されましたお部屋ご教授いただけましたらお部屋のご案内可否も確認させて頂きます😊！！」。
//   ブレインは見積を送ったお部屋の内覧依頼と読み AIX【内覧へ】（viewing_invite）にした。
// 数える物: お客様の番（10分以内の連投をまとめる）に内覧の希望があり、日時の語が無い番。
//   お部屋の特定: 番の中に直近14日にこちらが送ったお部屋の名前がある／引用／URL・画像 → 特定あり。
//   スタッフの応え（次のお客様の通まで・12時間以内）: 部屋を聞く返信／候補の日時（本文 or AIX 内覧系）／確認の約束／その他。
// 実行（営業時間 9〜22時は避ける）: npx tsx --env-file=.env.local scripts/audit-vague-viewing-wish.ts [--days=365] [--show=ask,slots,other]
import { createClient } from "@supabase/supabase-js";
import { YUMA_CONVERSATION_ID, NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { hasConcreteSlot } from "../app/lib/final-check-facts-source";
import { isVagueViewingWish, viewingRoomNamed, sentRoomNames, ASK_ROOM_RE } from "../app/lib/vague-viewing-wish";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "365"));
const SHOW = new Set(arg("show", "ask,slots,other,check").split(","));
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const SKIP = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; quoted_message_id: string | null; image_url: string | null };
const one = (s: unknown, n = 200) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const ms = (s: string) => new Date(s).getTime();

const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date())) % 24;
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は流さない（--force で外す）`); process.exit(0); }

async function main() {
  const cands: Msg[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, quoted_message_id, image_url")
      .eq("sender", "customer").gte("created_at", SINCE).or("text.ilike.%内覧%,text.ilike.%内見%,text.ilike.%見学%,text.ilike.%後内%")
      .order("created_at").range(p * 500, p * 500 + 499);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    for (const r of (data ?? []) as Msg[]) if (!SKIP.has(r.conversation_id)) cands.push(r);
    if ((data ?? []).length < 500) break;
  }
  type Row = { key: string; conv: string; at: string; turn: string; named: boolean; rooms: number; kind: string; staff: string; aix: string[] };
  const rows: Row[] = []; const seen = new Set<string>();
  const queue = [...cands];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const t = ms(c.created_at);
      const { data } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, quoted_message_id, image_url")
        .eq("conversation_id", c.conversation_id).gte("created_at", new Date(t - 14 * 864e5).toISOString()).lte("created_at", new Date(t + 12 * 36e5).toISOString()).order("created_at").limit(1000);
      const msgs = (data ?? []) as Msg[];
      const i = msgs.findIndex((m) => m.id === c.id); if (i < 0) continue;
      // 番＝この通の前後10分以内のお客様の連投
      let s = i; while (s > 0 && msgs[s - 1].sender === "customer" && t - ms(msgs[s - 1].created_at) < 10 * 6e4) s--;
      let e = i; while (e + 1 < msgs.length && msgs[e + 1].sender === "customer" && ms(msgs[e + 1].created_at) - t < 10 * 6e4) e++;
      const key = `${c.conversation_id}:${msgs[e].id}`; if (seen.has(key)) continue; seen.add(key);
      const turnMsgs = msgs.slice(s, e + 1);
      const turn = turnMsgs.map((m) => m.text ?? "").join("\n");
      if (!isVagueViewingWish(turn)) continue;
      const before = msgs.slice(0, s).filter((m) => m.sender !== "customer").map((m) => m.text ?? "");
      const names = sentRoomNames(before);
      const named = viewingRoomNamed(turn, names) || turnMsgs.some((m) => !!m.quoted_message_id || !!m.image_url || /https?:\/\//.test(m.text ?? ""));
      const after: Msg[] = []; for (let k = e + 1; k < msgs.length && msgs[k].sender !== "customer"; k++) after.push(msgs[k]);
      const tEnd = after.length ? ms(after[after.length - 1].created_at) + 6e4 : ms(msgs[e].created_at) + 12 * 36e5;
      const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", c.conversation_id)
        .gte("created_at", msgs[e].created_at).lte("created_at", new Date(tEnd).toISOString());
      const aix = ((ax ?? []) as { aix_type: string }[]).map((a) => a.aix_type);
      const staff = after.map((m) => m.text ?? "").join("\n");
      if (!after.length) continue;
      const kind = ASK_ROOM_RE.test(staff) ? "ask"
        : (aix.some((a) => /viewing|greeting_viewing|meeting/.test(a)) || hasConcreteSlot(staff)) ? "slots"
        : /確認(?:させて|致し|いたし)/.test(staff) ? "check" : "other";
      rows.push({ key, conv: c.conversation_id, at: msgs[e].created_at, turn, named, rooms: names.length, kind, staff, aix });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const tally = (f: (r: Row) => boolean) => { const g = rows.filter(f); const c: Record<string, number> = {}; for (const r of g) c[r.kind] = (c[r.kind] ?? 0) + 1; return `${g.length}番 ${JSON.stringify(c)}`; };
  console.log(`期間 ${DAYS}日・内覧の語のお客様の通 ${cands.length}・日時の無い内覧の希望の番 ${rows.length}`);
  console.log(`  全体: ${tally(() => true)}`);
  console.log(`  お部屋の特定あり: ${tally((r) => r.named)}`);
  console.log(`  特定なし・直近に送ったお部屋 0〜1: ${tally((r) => !r.named && r.rooms <= 1)}`);
  console.log(`  特定なし・直近に送ったお部屋 2以上（q427 の形）: ${tally((r) => !r.named && r.rooms >= 2)}`);
  for (const grp of [["特定なし・2以上", (r: Row) => !r.named && r.rooms >= 2], ["特定なし・0〜1", (r: Row) => !r.named && r.rooms <= 1], ["特定あり", (r: Row) => r.named]] as const) {
    console.log(`\n■ ${grp[0]}`);
    for (const r of rows.filter(grp[1])) if (SHOW.has(r.kind))
      console.log(`  [${r.kind}] ${r.conv.slice(0, 8)} ${r.at.slice(0, 16)} 部屋${r.rooms} AIX=${r.aix.join("/") || "-"}\n    客: ${one(r.turn, 160)}\n    送: ${one(r.staff, 220)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
