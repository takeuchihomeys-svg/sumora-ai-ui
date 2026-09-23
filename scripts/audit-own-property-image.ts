// お客様が送ってきた画像が「こちらが送った物件か」を、今の照合（own-property-match）がどれだけ当てているかの全件監査。
//
// 2026-09-23 竹内「お客さんが送ってきた画像が、こちらから送った画像かどうかの判定も Jev でできるのかな？
//   それで判定したら送ったどの画像なのか確認して会話生成する動き」
//
// 型（CLAUDE.md「おかしな文を1通見つけた時」）: 実物を持つ → 出所を追う → 実送信で線を引く → 誤削除0 → 記録。
// ここは **読み取りのみ**。件数だけでなく1件ずつ目で読むために、当たらなかった実物を全部出す。
//
// 出す物:
//   ① 取り出せた／取り出せない（extractScreenshotProperty）
//   ② こちらの送付と照合できた／できない（matchOwnProperty）
//   ③ ポータルの画面か（無料 お問い合わせ・内見予約・キープ 等のボタン文字＝お客様が自分で探した画面）
//   ④ その後スタッフが実際に何を返したか（正解の手がかり）
// 実行: npx tsx --env-file=.env.local scripts/audit-own-property-image.ts [--days=180] [--show=all|miss|hit] [--jev]
//   --jev … 決定論で決まらなかった通を Jev に聞いて、スタッフの実際の返しと突き合わせる（TYPESAFE_API_KEY が要る）。
//           正解の手がかり: スタッフが「募集状況確認させて頂きます」と返した＝お客様が見つけた新しい物件として扱った。
//           「ご査収ありがとうございます／御見積書／引き続き新着」＝こちらが送った物件として扱った。
import { createClient } from "@supabase/supabase-js";
import { extractScreenshotProperty, matchOwnProperty, type SentProperty } from "../app/lib/own-property-match";
import { askOwnPropertyJev } from "../app/lib/own-property-jev";
import { isJevEnabled } from "../app/lib/jev-client";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "180"));
const SHOW = arg("show", "miss");
const USE_JEV = process.argv.includes("--jev");
/** スタッフの返しから「新しい物件として扱ったか」を読む（正解の手がかり） */
const STAFF_CHECKED_RE = /募集状況(?:を)?確認|お送り頂きました|お送りいただきました|お部屋お送りいただき/;
const STAFF_OURS_RE = /ご査収|引き続き(?:新着|お部屋)|御見積書|お見積書|内覧|ご案内させて/;

/** ポータル（SUUMO・HOME'S 等）の画面のボタン文字。こちらが送る物件資料には出ない */
const PORTAL_UI_RE = /無料\s*(?:お問い合わせ|内見予約|空室状況|入居可能時期)|内見予約|キープ|取扱う会社|回以上見た物件|この物件を見た人|お気に入りに追加|初期費用の目安を確認|成約キャッシュバック|問い合わせる/;
/** こちらが送る物件資料（リアプロ・ITANDI・レインズ）に出る言葉 */
const OURS_UI_RE = /募集中|物探下見|敷礼保|省なし|取引態様|【物件情報】|【間取り図】|入居可能時期：|現況|鍵：/;

type Msg = { id: string; conversation_id: string; created_at: string; text: string | null; image_type: string | null };

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

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const msgs = await page<Msg>("messages", "id, conversation_id, created_at, text, image_type",
    (q) => q.eq("sender", "customer").like("text", "[画像]%").gte("created_at", since).order("created_at", { ascending: false }));
  console.log(`=== お客様の画像 ${msgs.length}通（${DAYS}日）===\n`);

  const convIds = [...new Set(msgs.map((m) => m.conversation_id))];
  // 会話ごとの「こちらが送った物件」
  const sentByConv = new Map<string, SentProperty[]>();
  for (let i = 0; i < convIds.length; i += 100) {
    const chunk = convIds.slice(i, i + 100);
    const [sp, sip] = await Promise.all([
      page<{ conversation_id: string; property_name: string | null; room_no: string | null; sent_at: string | null }>(
        "sent_properties", "conversation_id, property_name, room_no, sent_at", (q) => q.in("conversation_id", chunk)),
      page<{ conversation_id: string; property_name: string | null; room_no: string | null; created_at: string }>(
        "sent_image_properties", "conversation_id, property_name, room_no, created_at", (q) => q.in("conversation_id", chunk)),
    ]);
    for (const r of sp) {
      const a = sentByConv.get(r.conversation_id) ?? []; a.push({ name: r.property_name ?? "", room: r.room_no, sentAt: r.sent_at }); sentByConv.set(r.conversation_id, a);
    }
    for (const r of sip) {
      const a = sentByConv.get(r.conversation_id) ?? []; a.push({ name: r.property_name ?? "", room: r.room_no, sentAt: r.created_at }); sentByConv.set(r.conversation_id, a);
    }
  }
  // その画像の後のスタッフの最初の返し（正解の手がかり）
  const staffAfter = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 100) {
    const chunk = convIds.slice(i, i + 100);
    const rows = await page<{ conversation_id: string; created_at: string; text: string | null }>(
      "messages", "conversation_id, created_at, text", (q) => q.in("conversation_id", chunk).eq("sender", "staff").gte("created_at", since).order("created_at", { ascending: true }));
    for (const m of msgs) {
      if (staffAfter.has(m.id)) continue;
      const next = rows.find((r) => r.conversation_id === m.conversation_id && r.created_at > m.created_at && (r.text ?? "").length > 3);
      if (next) staffAfter.set(m.id, (next.text ?? "").replace(/\s+/g, " ").slice(0, 70));
    }
  }

  let nProperty = 0, nExtract = 0, nMatch = 0, nPortal = 0, nOursUi = 0;
  let jevAsked = 0, jevJudged = 0, jevOk = 0;
  const miss: string[] = [], hit: string[] = [], jevLines: string[] = [];
  if (USE_JEV && !isJevEnabled()) { console.log("⚠ TYPESAFE_API_KEY が無いので Jev は聞かない（決定論の監査だけ行う）\n"); }
  for (const m of msgs) {
    const txt = m.text ?? "";
    const isProperty = m.image_type === "floor_plan" || m.image_type === "property_photo"
      || (!m.image_type && (PORTAL_UI_RE.test(txt) || OURS_UI_RE.test(txt)));
    if (m.image_type === "id_document" || m.image_type === "estimate") continue;   // 本人確認書類・見積書は対象外
    if (!isProperty) continue;
    nProperty++;
    const portal = PORTAL_UI_RE.test(txt);
    const oursUi = OURS_UI_RE.test(txt) && !portal;
    if (portal) nPortal++;
    if (oursUi) nOursUi++;
    const item = extractScreenshotProperty(txt);
    if (item) nExtract++;
    const sent = (sentByConv.get(m.conversation_id) ?? []).filter((s) => s.name && (!s.sentAt || s.sentAt < m.created_at));
    const match = item ? matchOwnProperty(item, sent) : null;
    if (match?.kind === "same_room") nMatch++;
    const head = `${m.created_at.slice(5, 16).replace("T", " ")} ${m.conversation_id.slice(0, 8)} [${m.image_type ?? "-"}]${portal ? "📱ポータル" : oursUi ? "📄うちの資料" : ""}`;
    const body = txt.replace(/^\[画像\]\s*/, "").replace(/\s+/g, " ");
    const line = `${head}\n    文: ${body.slice(0, 150)}\n    取出: ${item ? `${item.name}${item.room ? ` / ${item.room}` : ""}` : "×"}  照合: ${match?.kind ?? "-"}${match?.sent ? ` → ${match.sent.name}` : ""}  送付済${sent.length}件\n    店の返し: ${staffAfter.get(m.id) ?? "(なし)"}`;
    if (match?.kind === "same_room") hit.push(line); else miss.push(line);

    // ── Jev の答え合わせ（決定論で決まらなかった通だけ）──
    if (USE_JEV && match?.kind !== "same_room" && sent.length > 0) {
      const ev = await askOwnPropertyJev({ transcript: txt, sent, conversationId: m.conversation_id, timeoutMs: 15_000 });
      if (ev) {
        jevAsked++;
        const staff = staffAfter.get(m.id) ?? "";
        const truth = STAFF_CHECKED_RE.test(staff) ? "新しい物件" : STAFF_OURS_RE.test(staff) ? "こちらの物件" : "?";
        const said = ev.decision.choice ? "こちらの物件" : "新しい物件";
        if (truth !== "?") { jevJudged++; if (truth === said) jevOk++; }
        jevLines.push(`  ${m.conversation_id.slice(0, 8)} Jev=${said}${ev.decision.choice ? `（${ev.decision.choice.name}）` : ""} p=${ev.decision.prob.toFixed(2)}  店の返しから=${truth}${truth !== "?" && truth !== said ? "  ← 食い違い" : ""}\n      文: ${body.slice(0, 80)}\n      店: ${staff.slice(0, 60)}`);
      }
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`物件系の画像            ${nProperty}通`);
  console.log(`  📱 ポータルの画面      ${nPortal}通 (${pct(nPortal, nProperty)})  ＝お客様が自分で探した画面`);
  console.log(`  📄 うちの資料らしい    ${nOursUi}通 (${pct(nOursUi, nProperty)})`);
  console.log(`  物件名を取り出せた      ${nExtract}通 (${pct(nExtract, nProperty)})`);
  console.log(`  こちらの送付と照合できた ${nMatch}通 (${pct(nMatch, nProperty)})\n`);
  if (USE_JEV && jevAsked > 0) {
    console.log(`── Jev の答え合わせ（決定論で決まらなかった ${jevAsked}通）──`);
    console.log(`  スタッフの返しで正解が分かる ${jevJudged}通 のうち一致 ${jevOk}通 = ${pct(jevOk, jevJudged)}\n`);
    for (const l of jevLines) console.log(l);
    console.log("");
  }
  if (SHOW === "hit" || SHOW === "all") { console.log(`── 照合できた ${hit.length}件 ──`); for (const l of hit) console.log(l); }
  if (SHOW === "miss" || SHOW === "all") { console.log(`\n── 照合できなかった ${miss.length}件（目で読む）──`); for (const l of miss) console.log(l); }
}
main().catch((e) => { console.error(e); process.exit(1); });
