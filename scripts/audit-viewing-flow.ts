// scripts/audit-viewing-flow.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-flow.ts            （DAYS=180 既定・読み取りのみ）
//       DUMP=1 …… 会話ごとの時系列（内覧調整の2通前〜内覧後のお礼まで）を全部出す
//       CONV=8a77820b …… その会話だけ時系列を出す
//
// 2026-09-30 竹内さん「AIX の内覧調整で内覧の日にち調整して、日にち決まったら、AIX 待ち合わせで内覧が確定されるまでの流れは
//   しっかり理解できているか。まず内覧調整から候補日入れて内覧日設定して、内覧日決めてから、待ち合わせ場所決める流れ。
//   実際の LINE や成約データから流れをちゃんとできるように、先走らないようにする形で改善する」
//
// 実際の LINE（messages）と AIX の記録（aix_usage_logs）から、内覧の流れを段階ごとに起こす:
//   ① 内覧したい／内覧の提案  ② AIX【内覧調整】(viewing_invite)  ③ お客様の返事（日にちを返す・聞き返す・別日・保留）
//   ④ 日にちが決まる（こちらの確定の言い方）  ⑤ AIX【待ち合わせ場所】(meeting_place)＝確定
//   ⑥ 前日・当日の挨拶  ⑦ 内覧後のお礼 → 申込
// 出す物: 段階ごとの件数・段階の間の時間と通数・順番の飛び／戻り・成約とそれ以外の差・
//         ③のお客様の返事の分類（決まった形／決まっていない形）の実物・②〜⑤の間の別の質問へのこちらの返事が内覧に触れたか
import { createClient } from "@supabase/supabase-js";
import { extractViewingAppointment } from "../app/lib/action-ledger";
import { findStaffViewingDeclaration, findPrematureViewing } from "../app/lib/viewing-premature";
import { CUSTOMER_VIEWING_WISH_RE, STAFF_VIEWING_DONE_RE, CUSTOMER_VIEWING_CANCEL_RE } from "../app/lib/viewing-thread";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);
const DUMP = process.env.DUMP === "1";
const CONV = process.env.CONV ?? "";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
type Aix = { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null; generated_text: string | null; template_name: string | null; suggested_action: string | null };
type Conv = { id: string; customer_name: string | null; status: string | null; is_post_apply: boolean | null; line_source_type: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const r = data ?? [];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const half = (s: string) => s.normalize("NFKC");
const one = (s: string | null | undefined, n = 170) => (s ?? "").replace(/\n+/g, " / ").slice(0, n);
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3600_000;
function median(xs: number[]): number | null { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function q(xs: number[], p: number): number | null { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
const f1 = (x: number | null) => (x == null ? "-" : x.toFixed(1));

// ── 形（読むための分類。ここで決めた線は報告用で、本番の判定には使っていない） ──
const DATE_RE = /[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}|(?<![0-9])[0-9]{1,2}日(?!間)|明日|明後日|本日|今日|[月火水木金土日]曜|来週|今週|週末|土日|平日/;
const TIME_RE = /[0-9]{1,2}\s*(?:時|:[0-9]{2})|午前|午後|夕方|朝|お昼|昼|夜/;
/** こちらの打診（候補の日時を出した）と、日時を出していない誘い */
const STAFF_SLOT_OFFER_RE = /[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}[^\n]{0,30}(?:[0-9]{1,2}:[0-9]{2}|[0-9]{1,2}時)|直近ですと|ご案内可能(?:です|でございます)/;
const STAFF_ASK_DAY_RE = /ご都合(?:の)?(?:よろしい|良い)お?日(?:にち|時|程)|ご希望(?:の)?(?:お)?日(?:にち|時|程)|いつ頃|お日にち[^\n]{0,12}(?:いかが|如何|ございますか|教えて)/;
/** お客様の返事の分類 */
const C_ACCEPT_RE = /お願い(?:します|致します|いたします|したい)|大丈夫です|行けます|いけます|伺います|向かいます|可能です|希望です|がいいです|が良いです|でお願い|にします|空いてます|空いています/;
const C_ASK_RE = /[?？]|ですか|ますか|でしょうか|ですよね|ますよね|かな[ぁ〜]?$/m;
const C_HOLD_RE = /また(?:ご)?連絡|改めて(?:ご)?連絡|わかり次第|分かり次第|確認して|確認します|シフト|まだ(?:わから|分から|決ま|未定)|未定|難しい|厳しい|無理|予定が|都合が|調整(?:して|します)|考え(?:ます|させて)|検討/;
const ONLINE_RE = /オンライン(?:内覧|内見)|ビデオ通話|テレビ電話|LINE通話で(?:の)?(?:内覧|内見)/;
const APPLY_RE = /記入欄】|申込(?:み)?時フォーマット|お申込(?:み)?(?:に|の)?必要なご情報/;
const PRE_GREETING_RE = /(?:明日|本日|当日)[^\n]{0,20}(?:ご内覧|内覧|ご案内|お待ち合わせ)[^\n]{0,20}(?:よろしく|宜しく)|(?:ご内覧|内覧)[^\n]{0,8}(?:よろしく|宜しく)お願い|お気をつけてお越し|到着(?:され|し)ましたら/;
const OTHER_Q_RE = /初期費用|審査|保証(?:人|会社)|アリバイ|分割|カード|ペット|駐輪|駐車|ネット|Wi-?Fi|入居日|契約|家賃|敷金|礼金|必要(?:書類|な物|なもの)|無職|水商売|夜職|在籍/;
const VIEW_WORD_RE = /内覧|内見|ご案内|お待ち合わせ|待ち合わせ/;

type CustKind = "decided" | "counter" | "ask_back" | "hold" | "cancel" | "other_q" | "ack" | "other";
function classifyCustomer(text: string): CustKind {
  const t = half(text);
  const hasDay = DATE_RE.test(t) || TIME_RE.test(t);
  if (CUSTOMER_VIEWING_CANCEL_RE.test(t) && /キャンセル|中止|やめ|辞め|見送|行けなく|延期|また今度/.test(t)) return "cancel";
  if (hasDay && C_ASK_RE.test(t) && !/でお願い(?:します|致します)[^?？]*$/.test(t)) return /可能|空いて|行け|いけ|できます|出来ます|どう|大丈夫/.test(t) ? "counter" : "ask_back";
  if (hasDay && C_ACCEPT_RE.test(t)) return "decided";
  if (C_HOLD_RE.test(t)) return "hold";
  if (hasDay) return "counter";
  if (OTHER_Q_RE.test(t) && C_ASK_RE.test(t)) return "other_q";
  // 日時の語が無い短い了承（「大丈夫です！」「お願いします」）: 直前のこちらの打診が日時1つなら決まる・候補が複数なら決まらない → 別に数える
  if (/^(?:はい[、。！!]*)?(?:大丈夫です|お願いします|お願い致します|お願いいたします|了解です|わかりました|承知しました|ありがとうございます)[^\n]{0,12}$/m.test(t) && t.length <= 40) return "ack";
  return "other";
}

type Ev = { at: string; kind: string; who: "staff" | "customer" | "aix"; text: string; extra?: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await pageAll<Conv>((a, b) => sb.from("conversations").select("id, customer_name, status, is_post_apply, line_source_type").range(a, b));
  const convById = new Map(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => [c.id, c]));
  const aixAll = await pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text, template_name, suggested_action").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const aix = aixAll.filter((r) => convById.has(r.conversation_id));
  const msgs = await pageAll<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!convById.has(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const aixByConv = new Map<string, Aix[]>();
  for (const r of aix) (aixByConv.get(r.conversation_id) ?? aixByConv.set(r.conversation_id, []).get(r.conversation_id)!).push(r);

  const isWon = (c: Conv) => c.status === "closed_won";
  const isApplied = (c: Conv) => c.status === "closed_won" || c.status === "applying" || c.status === "screening" || !!c.is_post_apply;

  console.log(`=== 対象 ${DAYS}日: 会話 ${byConv.size}（グループ・YUMA 除く）／成約 ${[...byConv.keys()].filter((id) => isWon(convById.get(id)!)).length}／申込以降 ${[...byConv.keys()].filter((id) => isApplied(convById.get(id)!)).length} ===`);

  // ── 会話ごとの出来事 ──
  type Flow = {
    conv: Conv; evs: Ev[];
    wish: string | null; invites: Aix[]; meetings: string[]; meetingAix: Aix[]; staffMeetingText: string[]; decl: string[];
    done: string[]; apply: string | null; online: boolean;
  };
  const flows: Flow[] = [];
  for (const [cid, ms] of byConv) {
    const conv = convById.get(cid)!;
    const ax = aixByConv.get(cid) ?? [];
    const invites = ax.filter((r) => r.aix_type === "viewing_invite");
    const meetingAix = ax.filter((r) => r.aix_type === "meeting_place");
    const evs: Ev[] = [];
    let wish: string | null = null; const staffMeetingText: string[] = []; const decl: string[] = []; const done: string[] = []; let apply: string | null = null; let online = false;
    for (const r of invites) evs.push({ at: r.sent_at ?? r.created_at, kind: "②AIX内覧調整", who: "aix", text: r.generated_text ?? "", extra: r.template_name ?? "" });
    for (const r of meetingAix) evs.push({ at: r.sent_at ?? r.created_at, kind: "⑤AIX待ち合わせ", who: "aix", text: r.generated_text ?? "", extra: r.template_name ?? "" });
    for (const r of ax.filter((x) => x.aix_type === "application_push")) { evs.push({ at: r.sent_at ?? r.created_at, kind: "AIX申込へ", who: "aix", text: r.generated_text ?? "" }); apply ??= r.sent_at ?? r.created_at; }
    const nearAix = (at: string, list: Aix[]) => list.some((r) => Math.abs(Date.parse(r.sent_at ?? r.created_at) - Date.parse(at)) < 3 * 60_000);
    for (const m of ms) {
      const t = half(m.text ?? "");
      if (!t) continue;
      if (m.sender === "customer") {
        if (CUSTOMER_VIEWING_WISH_RE.test(t)) { wish ??= m.created_at; evs.push({ at: m.created_at, kind: "①内覧したい", who: "customer", text: t }); }
        else evs.push({ at: m.created_at, kind: "客", who: "customer", text: t });
      } else if (m.sender === "staff") {
        if (ONLINE_RE.test(t)) online = true;
        const ap = extractViewingAppointment(t, m.created_at);
        const dc = findStaffViewingDeclaration(t, Date.parse(m.created_at));
        if (ap && !nearAix(m.created_at, meetingAix)) { staffMeetingText.push(m.created_at); evs.push({ at: m.created_at, kind: nearAix(m.created_at, invites) ? "⑤内覧調整の本文で待ち合わせ" : "⑤本文で待ち合わせ", who: "staff", text: t }); }
        else if (dc && !nearAix(m.created_at, meetingAix)) {
          // 待ち合わせを案内した後（10日以内）の「本日16:00よりお部屋ご案内させていただきます」は確定の宣言ではなく当日・前日の挨拶（⑥）
          const afterMeeting = [...meetingAix.map((r) => r.sent_at ?? r.created_at), ...staffMeetingText].some((x) => Date.parse(x) < Date.parse(m.created_at) && Date.parse(m.created_at) - Date.parse(x) < 10 * 86400_000);
          if (afterMeeting) evs.push({ at: m.created_at, kind: "⑥前日当日", who: "staff", text: t });
          else { decl.push(m.created_at); evs.push({ at: m.created_at, kind: "④確定の宣言", who: "staff", text: t, extra: dc }); }
        }
        else if (STAFF_VIEWING_DONE_RE.test(t)) { done.push(m.created_at); evs.push({ at: m.created_at, kind: "⑦内覧後のお礼", who: "staff", text: t }); }
        else if (APPLY_RE.test(t)) { apply ??= m.created_at; evs.push({ at: m.created_at, kind: "申込フォーマット", who: "staff", text: t }); }
        else if (PRE_GREETING_RE.test(t)) evs.push({ at: m.created_at, kind: "⑥前日当日", who: "staff", text: t });
        else if (nearAix(m.created_at, invites) || nearAix(m.created_at, meetingAix)) continue; // AIX 本文（aix の行で持つ）
        else evs.push({ at: m.created_at, kind: "ス", who: "staff", text: t });
      }
    }
    evs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const meetings = [...meetingAix.map((r) => r.sent_at ?? r.created_at), ...staffMeetingText].sort();
    flows.push({ conv, evs, wish, invites, meetings, meetingAix, staffMeetingText, decl, done, apply, online });
  }

  const withInvite = flows.filter((f) => f.invites.length);
  const withMeeting = flows.filter((f) => f.meetings.length);
  const withDone = flows.filter((f) => f.done.length);
  const applied = flows.filter((f) => isApplied(f.conv));
  const won = flows.filter((f) => isWon(f.conv));
  console.log(`\n=== 1. 段階ごとの会話数 ===`);
  console.log(`  ① お客様が内覧の希望を言った: ${flows.filter((f) => f.wish).length}`);
  console.log(`  ② AIX【内覧調整】を押した: ${withInvite.length}会話・${withInvite.reduce((n, f) => n + f.invites.length, 0)}回`);
  console.log(`  ④ 本文での確定の宣言（待ち合わせの語なし）: ${flows.filter((f) => f.decl.length).length}会話`);
  console.log(`  ⑤ 待ち合わせ（AIX ${flows.filter((f) => f.meetingAix.length).length}会話・本文だけ ${flows.filter((f) => !f.meetingAix.length && f.staffMeetingText.length).length}会話）: 計 ${withMeeting.length}会話`);
  console.log(`  ⑦ 内覧後のお礼: ${withDone.length}会話`);
  console.log(`  申込以降: ${applied.length}（うち成約 ${won.length}）`);

  // ── 2. 成約・申込と内覧 ──
  console.log(`\n=== 2. 成約・申込まで進んだ会話と内覧 ===`);
  for (const [label, set] of [["成約", won], ["申込以降（成約含む）", applied]] as const) {
    const m = set.filter((f) => f.meetings.length || f.done.length || f.decl.length);
    const inv = set.filter((f) => f.invites.length);
    console.log(`  ${label} ${set.length}: 内覧あり（待ち合わせ・確定の宣言・お礼） ${m.length}／AIX内覧調整あり ${inv.length}／内覧の記録なし ${set.length - m.length}（オンライン内覧の語 ${set.filter((f) => f.online).length}）`);
  }
  console.log(`  内覧の記録なしで申込以降（会話が ${DAYS}日より前に始まった物・電話で決めた物を含む）:`);
  for (const f of applied.filter((x) => !x.meetings.length && !x.done.length && !x.decl.length).slice(0, 40)) {
    console.log(`    ${f.conv.id.slice(0, 8)} ${f.conv.status} 内覧調整${f.invites.length} 内覧の希望${f.wish ? "あり" : "なし"} 発言${f.evs.length}`);
  }

  // ── 3. エピソード（②→⑤）: 最初の内覧調整から、その後の最初の待ち合わせまで ──
  type Ep = { f: Flow; inviteAt: string; meetAt: string | null; hours: number | null; custMsgs: number; staffMsgs: number; invitesBefore: number; between: Ev[]; firstReply: Ev | null; inviteHasSlot: boolean };
  const eps: Ep[] = [];
  for (const f of withInvite) {
    let cursor = 0;
    const inviteTimes = f.invites.map((r) => r.sent_at ?? r.created_at);
    while (cursor < inviteTimes.length) {
      const inviteAt = inviteTimes[cursor];
      const meetAt = f.meetings.find((t) => Date.parse(t) > Date.parse(inviteAt) - 3 * 60_000) ?? null;
      const end = meetAt ? Date.parse(meetAt) : Infinity;
      const invitesBefore = inviteTimes.filter((t) => Date.parse(t) >= Date.parse(inviteAt) && Date.parse(t) < end).length;
      const between = f.evs.filter((e) => Date.parse(e.at) > Date.parse(inviteAt) + 3 * 60_000 && Date.parse(e.at) < Math.min(end, Date.parse(inviteAt) + 14 * 86400_000));
      const inv = f.invites[cursor];
      eps.push({
        f, inviteAt, meetAt, hours: meetAt ? hours(inviteAt, meetAt) : null,
        custMsgs: between.filter((e) => e.who === "customer").length, staffMsgs: between.filter((e) => e.who !== "customer").length,
        invitesBefore, between, firstReply: between.find((e) => e.who === "customer") ?? null,
        inviteHasSlot: STAFF_SLOT_OFFER_RE.test(half(inv.generated_text ?? "")),
      });
      // 次のエピソード: この待ち合わせより後の内覧調整
      const next = inviteTimes.findIndex((t) => Date.parse(t) > (meetAt ? Date.parse(meetAt) : Infinity));
      if (next < 0) break;
      cursor = next;
    }
  }
  const reached = eps.filter((e) => e.meetAt);
  console.log(`\n=== 3. ②内覧調整 → ⑤待ち合わせ（エピソード ${eps.length}・うち待ち合わせまで届いた ${reached.length}） ===`);
  const hs = reached.map((e) => e.hours!).filter((h) => h >= 0);
  console.log(`  かかった時間: 中央 ${f1(median(hs))}h／25% ${f1(q(hs, 0.25))}h／75% ${f1(q(hs, 0.75))}h／最長 ${f1(Math.max(...hs))}h／同じ通（内覧調整の本文で待ち合わせまで）${reached.filter((e) => e.hours! < 0.05).length}`);
  console.log(`  間のお客様の発言: 中央 ${median(reached.map((e) => e.custMsgs))}通／こちら 中央 ${median(reached.map((e) => e.staffMsgs))}通`);
  console.log(`  待ち合わせまでに内覧調整を押した回数: 1回 ${reached.filter((e) => e.invitesBefore === 1).length}／2回 ${reached.filter((e) => e.invitesBefore === 2).length}／3回以上 ${reached.filter((e) => e.invitesBefore >= 3).length}`);
  console.log(`  内覧調整の本文に候補の日時あり: ${eps.filter((e) => e.inviteHasSlot).length}/${eps.length}（届いた ${reached.filter((e) => e.inviteHasSlot).length}/${eps.filter((e) => e.inviteHasSlot).length}・候補なし 届いた ${reached.filter((e) => !e.inviteHasSlot).length}/${eps.filter((e) => !e.inviteHasSlot).length}）`);
  for (const [label, pred] of [["成約", (e: Ep) => isWon(e.f.conv)], ["申込以降", (e: Ep) => isApplied(e.f.conv)], ["それ以外", (e: Ep) => !isApplied(e.f.conv)]] as const) {
    const s = eps.filter(pred); const r = s.filter((e) => e.meetAt); const h = r.map((e) => e.hours!).filter((x) => x >= 0);
    console.log(`  [${label}] エピソード ${s.length}・待ち合わせまで ${r.length}（${s.length ? Math.round((r.length / s.length) * 100) : 0}%）・中央 ${f1(median(h))}h・75% ${f1(q(h, 0.75))}h・内覧調整2回以上 ${r.filter((e) => e.invitesBefore >= 2).length}・お客様の最初の返事まで 中央 ${f1(median(s.filter((e) => e.firstReply).map((e) => hours(e.inviteAt, e.firstReply!.at))))}h`);
  }

  // ── 4. ③ AIX【内覧調整】の後のお客様の最初の返事（連投は1つにまとめる）と、その次のこちらの一手 ──
  console.log(`\n=== 4. ③ AIX【内覧調整】（全${withInvite.reduce((n, f) => n + f.invites.length, 0)}回）の後のお客様の最初の返事と、次のこちらの一手 ===`);
  type Turn = { f: Flow; inviteAt: string; inviteText: string; slots: number; at: string; text: string; next: Ev | null; waitH: number };
  const buckets = new Map<CustKind | "none", Turn[]>();
  const countSlots = (t: string) => (half(t).match(/[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}日?\s*[（(]?[月火水木金土日]?|本日|明日|明後日/g) ?? []).length;
  for (const f of withInvite) for (const inv of f.invites) {
    const inviteAt = inv.sent_at ?? inv.created_at;
    const after = f.evs.filter((e) => Date.parse(e.at) > Date.parse(inviteAt) + 60_000 && Date.parse(e.at) < Date.parse(inviteAt) + 7 * 86400_000);
    const ci = after.findIndex((e) => e.who === "customer");
    const base = { f, inviteAt, inviteText: inv.generated_text ?? "", slots: countSlots(inv.generated_text ?? "") };
    if (ci < 0) { (buckets.get("none") ?? buckets.set("none", []).get("none")!).push({ ...base, at: inviteAt, text: "（7日以内に返事なし）", next: null, waitH: 0 }); continue; }
    let cj = ci; while (cj + 1 < after.length && after[cj + 1].who === "customer" && Date.parse(after[cj + 1].at) - Date.parse(after[cj].at) < 30 * 60_000) cj++;
    const text = after.slice(ci, cj + 1).map((e) => e.text).join("\n");
    const k = classifyCustomer(text);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push({ ...base, at: after[ci].at, text, next: after.slice(cj + 1).find((e) => e.who !== "customer") ?? null, waitH: hours(inviteAt, after[ci].at) });
  }
  const LABEL: Record<CustKind | "none", string> = { decided: "日時の語＋お願い（日にちを決めて返した）", counter: "別の日時・空きを聞く（逆提案）", ask_back: "日時の語＋聞き返し", hold: "保留（また連絡・確認する・難しい）", cancel: "取りやめ", other_q: "別の質問（費用・審査など）", ack: "日時の語の無い短い了承", other: "その他", none: "返事なし" };
  for (const k of ["decided", "ack", "counter", "ask_back", "hold", "cancel", "other_q", "other", "none"] as Array<CustKind | "none">) {
    const b = buckets.get(k) ?? [];
    const nextKinds = new Map<string, number>();
    for (const x of b) { const nk = x.next ? x.next.kind.replace(/^⑤.*/, "⑤待ち合わせ") : "（こちらの次の一手なし）"; nextKinds.set(nk, (nextKinds.get(nk) ?? 0) + 1); }
    console.log(`\n  ■ ${LABEL[k]}: ${b.length}回（返事まで 中央 ${f1(median(b.map((x) => x.waitH)))}h） → 次のこちらの一手: ${[...nextKinds].sort((a, c) => c[1] - a[1]).map(([n, c]) => `${n} ${c}`).join("／")}`);
    for (const x of b.slice(0, DUMP ? 200 : 14)) {
      console.log(`    [${x.f.conv.id.slice(0, 8)} ${jst(x.at)}${isApplied(x.f.conv) ? " ★" : ""} 候補${x.slots}] 客: ${one(x.text, 130)}`);
      if (x.next) console.log(`        → ${x.next.kind}: ${one(x.next.text, 150)}`);
    }
  }

  // ── 5. ②〜⑤の間（内覧調整の後・待ち合わせの前・96時間以内）に別の質問が来た時、こちらの手書きの返事は内覧に触れたか ──
  console.log(`\n=== 5. 内覧調整〜待ち合わせの間（まだ決まっていない・96時間以内）の別の質問への、こちらの手書きの返事 ===`);
  const oq: Array<{ e: Ep; ev: Ev; next: Ev }> = [];
  for (const e of eps) for (let i = 0; i < e.between.length; i++) {
    const ev = e.between[i];
    if (ev.who !== "customer" || Date.parse(ev.at) > Date.parse(e.inviteAt) + 96 * 3600_000) continue;
    const t = half(ev.text);
    if (!(OTHER_Q_RE.test(t) && C_ASK_RE.test(t)) || t.startsWith("[画像]")) continue;
    const next = e.between.slice(i + 1).find((x) => x.who !== "customer");
    if (next && next.who === "staff" && !next.text.startsWith("[画像]")) oq.push({ e, ev, next });
  }
  const touched = oq.filter((x) => VIEW_WORD_RE.test(x.next.text));
  const premature = oq.filter((x) => findPrematureViewing(x.next.text).length > 0);
  console.log(`  別の質問 ${oq.length}通: 返事が内覧の語に触れた ${touched.length}／決まった予定として書いた（viewing-premature の形） ${premature.length}／内覧に触れず質問にだけ答えた ${oq.length - touched.length}`);
  console.log(`  -- 内覧の語に触れた返事（全部）--`);
  for (const x of touched) console.log(`    [${x.e.f.conv.id.slice(0, 8)} ${jst(x.ev.at)}] 客: ${one(x.ev.text, 110)}\n        → ${one(x.next.text, 240)}`);
  console.log(`  -- 内覧に触れなかった返事（${DUMP ? "全部" : "先頭12"}）--`);
  for (const x of oq.filter((y) => !touched.includes(y)).slice(0, DUMP ? 200 : 12)) console.log(`    [${x.e.f.conv.id.slice(0, 8)} ${jst(x.ev.at)}] 客: ${one(x.ev.text, 110)}\n        → ${one(x.next.text, 200)}`);

  // ── 5b. 待ち合わせの本文の形: 言い切り（何卒よろしく）か、まだ聞いている（いかがでしょうか）か ──
  const meetEvs = flows.flatMap((f) => f.evs.filter((e) => e.kind.startsWith("⑤") && e.text).map((e) => ({ f, e })));
  const asking = meetEvs.filter((x) => /いかが|如何|でしょうか/.test(x.e.text.split("\n").filter((l) => /待ち合わせ/.test(l)).join(" ")));
  console.log(`\n=== 5b. 待ち合わせの案内 ${meetEvs.length}通の形: 言い切り ${meetEvs.length - asking.length}／まだ聞いている（待ち合わせいかがでしょうか） ${asking.length}（AIX ${asking.filter((x) => x.e.who === "aix").length}・手書き ${asking.filter((x) => x.e.who !== "aix").length}） ===`);
  const lead: number[] = [];
  for (const x of meetEvs) {
    const ap = extractViewingAppointment(x.e.text, x.e.at);
    if (!ap?.dateMD || !ap.time) continue;
    const [mo, d] = ap.dateMD.split("/").map(Number); const [h, mi] = ap.time.split(":").map(Number);
    const y = new Date(Date.parse(x.e.at) + 9 * 3600_000).getUTCFullYear();
    const lh = (Date.UTC(y, mo - 1, d, h - 9, mi) - Date.parse(x.e.at)) / 3600_000;
    if (lh > -2 && lh < 24 * 40) lead.push(lh);
  }
  console.log(`  待ち合わせの案内から内覧の時刻まで: 中央 ${f1(median(lead))}h／25% ${f1(q(lead, 0.25))}h／75% ${f1(q(lead, 0.75))}h／12h以内 ${lead.filter((x) => x <= 12).length}／${lead.length}`);

  // ── 6. ④→⑤ 決まった後の一手 / ⑤の後 ──
  console.log(`\n=== 6. 待ち合わせ（⑤）の直前のお客様の発言（＝「決まった」と読んだ実物）と、⑤の本文 ===`);
  let n6 = 0;
  for (const f of withMeeting) {
    for (const mt of f.meetings) {
      const idx = f.evs.findIndex((e) => e.kind.startsWith("⑤") && Math.abs(Date.parse(e.at) - Date.parse(mt)) < 3 * 60_000);
      if (idx < 0) continue;
      const prevC = [...f.evs.slice(0, idx)].reverse().find((e) => e.who === "customer");
      if (n6++ >= (DUMP ? 300 : 45)) break;
      console.log(`  [${f.conv.id.slice(0, 8)} ${jst(mt)}${isApplied(f.conv) ? " ★" : ""}] 客(${prevC ? f1(hours(prevC.at, mt)) + "h前" : "-"}): ${one(prevC?.text, 100)}\n        ${f.evs[idx].kind}: ${one(f.evs[idx].text, 170)}`);
    }
  }

  // ── 7. 順番の飛び・戻り ──
  console.log(`\n=== 7. 順番の飛び・戻り ===`);
  const aixLogStart = Math.min(...aix.map((r) => Date.parse(r.created_at)));
  // AIX の記録（aix_usage_logs）が始まる前の待ち合わせは、内覧調整を押したかどうか分からないので数えない
  const noInviteMeeting = withMeeting.filter((f) => Date.parse(f.meetings[0]) > aixLogStart + 86400_000 && !f.invites.some((r) => Date.parse(r.sent_at ?? r.created_at) < Date.parse(f.meetings[0])));
  console.log(`  （AIX の記録の始まり: ${jst(new Date(aixLogStart).toISOString())}。それより前の待ち合わせは「飛んだ」に数えない）`);
  const multiMeeting = withMeeting.filter((f) => f.meetings.length >= 2);
  const inviteAfterMeeting = withMeeting.filter((f) => f.invites.some((r) => Date.parse(r.sent_at ?? r.created_at) > Date.parse(f.meetings[0]) + 3 * 60_000));
  const cancelAfterMeeting = withMeeting.filter((f) => f.evs.some((e) => e.who === "customer" && Date.parse(e.at) > Date.parse(f.meetings[0]) && Date.parse(e.at) < Date.parse(f.meetings[0]) + 10 * 86400_000 && classifyCustomer(e.text) === "cancel"));
  const inviteNoMeeting = withInvite.filter((f) => !f.meetings.length);
  console.log(`  内覧調整なしで待ち合わせ（⑤に飛んだ・うち本文だけで決めた ${noInviteMeeting.filter((f) => !f.meetingAix.length).length}）: ${noInviteMeeting.length}会話 ${noInviteMeeting.map((f) => f.conv.id.slice(0, 8)).join(" ")}`);
  console.log(`  待ち合わせを2回以上（日程変更・別のお部屋・2回目の内覧）: ${multiMeeting.length}会話 ${multiMeeting.map((f) => `${f.conv.id.slice(0, 8)}×${f.meetings.length}`).join(" ")}`);
  console.log(`  待ち合わせの後にまた内覧調整（戻った）: ${inviteAfterMeeting.length}会話 ${inviteAfterMeeting.map((f) => f.conv.id.slice(0, 8)).join(" ")}`);
  console.log(`  待ち合わせの後にお客様の取りやめ・延期: ${cancelAfterMeeting.length}会話 ${cancelAfterMeeting.map((f) => f.conv.id.slice(0, 8)).join(" ")}`);
  console.log(`  内覧調整だけで待ち合わせに届かなかった: ${inviteNoMeeting.length}会話（申込以降 ${inviteNoMeeting.filter((f) => isApplied(f.conv)).length}） ${inviteNoMeeting.map((f) => f.conv.id.slice(0, 8)).join(" ")}`);
  console.log(`  オンライン内覧の語がある: ${flows.filter((f) => f.online).length}会話 ${flows.filter((f) => f.online).map((f) => f.conv.id.slice(0, 8)).join(" ")}`);
  console.log(`  確定の宣言だけ（待ち合わせなし）: ${flows.filter((f) => f.decl.length && !f.meetings.length).map((f) => f.conv.id.slice(0, 8)).join(" ")}`);

  const placeLater = flows.flatMap((f) => f.evs.filter((e) => e.who === "staff" && /待ち合わせ(?:場所)?[^\n]{0,10}(?:追って|改めて|後ほど)|待ち合わせしやすい場所/.test(e.text)).map((e) => ({ f, e })));
  console.log(`  日にちは決まったが待ち合わせ場所は後で（「待ち合わせ場所追ってご連絡」「改めてお送り」）: ${placeLater.length}通`);
  for (const x of placeLater.slice(0, 10)) console.log(`    [${x.f.conv.id.slice(0, 8)} ${jst(x.e.at)}] ${one(x.e.text, 170)}`);

  // ── 8. ⑤→⑥→⑦→申込 ──
  console.log(`\n=== 8. 待ち合わせの後 ===`);
  const m2d = withMeeting.filter((f) => f.done.some((d) => Date.parse(d) > Date.parse(f.meetings[0])));
  console.log(`  待ち合わせ → 内覧後のお礼あり: ${m2d.length}/${withMeeting.length}／待ち合わせ → 申込（AIX申込へ・申込フォーマット）: ${withMeeting.filter((f) => f.apply && Date.parse(f.apply) > Date.parse(f.meetings[0])).length}／待ち合わせ → 申込以降の状態: ${withMeeting.filter((f) => isApplied(f.conv)).length}`);
  const greet = withMeeting.map((f) => f.evs.filter((e) => e.kind === "⑥前日当日" && Date.parse(e.at) > Date.parse(f.meetings[0]))).flat();
  console.log(`  ⑥ 前日・当日の挨拶（待ち合わせの後）: ${greet.length}通`);
  for (const g of greet.slice(0, 12)) console.log(`    [${jst(g.at)}] ${one(g.text, 150)}`);
  console.log(`  ⑦ 内覧後のお礼の実物:`);
  for (const f of withDone.slice(0, 8)) { const e = f.evs.find((x) => x.kind === "⑦内覧後のお礼")!; console.log(`    [${f.conv.id.slice(0, 8)} ${jst(e.at)}] ${one(e.text, 170)}`); }

  // ── 9. ②の本文の実物（候補の日時あり／なし） ──
  console.log(`\n=== 9. AIX【内覧調整】の本文の実物 ===`);
  for (const e of eps.slice(-14)) console.log(`  [${e.f.conv.id.slice(0, 8)} ${jst(e.inviteAt)} 候補${e.inviteHasSlot ? "あり" : "なし"} ${e.meetAt ? `→待ち合わせ ${f1(e.hours)}h` : "→届かず"}] ${one(e.f.invites.find((r) => (r.sent_at ?? r.created_at) === e.inviteAt)?.generated_text, 230)}`);

  // ── 時系列 ──
  if (DUMP || CONV) {
    console.log(`\n=== 時系列（内覧調整・待ち合わせのある会話） ===`);
    for (const f of flows.filter((x) => (CONV ? x.conv.id.startsWith(CONV) : x.invites.length || x.meetings.length))) {
      const first = [f.invites[0] ? f.invites[0].sent_at ?? f.invites[0].created_at : null, f.meetings[0] ?? null].filter(Boolean).sort()[0] as string;
      const lastT = [...f.meetings, ...f.done, ...f.invites.map((r) => r.sent_at ?? r.created_at)].sort().at(-1)!;
      const from = Date.parse(first) - 12 * 3600_000; const to = Date.parse(lastT) + 36 * 3600_000;
      console.log(`\n--- ${f.conv.id.slice(0, 8)} ${f.conv.status}${f.conv.is_post_apply ? "・申込以降" : ""} 内覧調整${f.invites.length} 待ち合わせ${f.meetings.length} ---`);
      for (const e of f.evs.filter((x) => Date.parse(x.at) >= from && Date.parse(x.at) <= to)) console.log(`  ${jst(e.at)} ${e.kind.padEnd(4)} ${one(e.text, CONV ? 400 : 150)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
