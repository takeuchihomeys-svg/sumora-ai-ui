// 穴(3)「お客様の返事を、こちらの問い・提案への答えとして読めない」を測る（読むだけ・LLM は呼ばない・本文はマスクして出す）
// 2026-09-26 竹内「ここの部分改善する根本的に・設計知見と協力して」（診断担当・コードは変えていない）
//
// 測ること（generate-reply の下書き × スタッフの実送信・ai_reply_examples entry_source=line_reply・YUMA 除く・直近60日）:
//   ① 返信生成の時点の「内覧の流れ」を viewing-thread.ts の resolveViewingThread（既存・AIX 物件確認した でだけ使っている）で立てる
//      scheduled（待ち合わせ送付済み／提案した日時をお客様が受諾）× 台帳の見方（extractViewingAppointment＝待ち合わせの語＋時刻）
//   ② 下書き・実送信の「日程の問い（ご都合よろしいお日にち…）」「内覧の詳細はご連絡（先送り）」
//   ③ generate-reply の「内覧日程確定後シンプル締め」（isViewingAppointmentAck・route.ts 1546〜）と「2回目締め」（isSecondClosing・1527〜）が
//      履歴の各発言の **1行目だけ** を見ているため発火していないか（lastStaffLines = 『スモラ:』で始まる行＝複数行の発言の1行目）
//
// 2026-09-26 の結果（60日・845組）:
//   - scheduled 106組（うち待ち合わせ送付済み 75・受諾のみで台帳が拾えない 17）。下書きの日程の問い／詳細は後で連絡 10件・スタッフ 2件
//     （スタッフの2件は日程の変更・延期の場面）。お客様の短い了承（リスケ・質問なし）36組ではスタッフ 0件＝この範囲なら線が引ける
//   - シンプル締めの判定: 決まった内覧への了承 41組で 1行目だけ 3組（7.3%）／全文なら 26組（63.4%）。ただし全文にすると提案中（まだ決まっていない）
//     にも 28組立つ → 判定は viewing-thread の scheduled に寄せる（1か所）。2回目締め: 短いお礼 170組で 1行目だけ 0／全文 51
//   - 出所: 常時の GENERATION_SYSTEM が「内覧に触れる場合は『お気に召されましたらご都合よろしいお日にちにご案内』のみ許可」「通常返信は
//     『内覧の詳細については改めてご連絡』のみ書く」を状態に関係なく渡し、ブレインの meeting_place の WE DO 例も「内覧の詳細はご連絡」。
//     打ち消す材料（シンプル締め）は1行目バグで届いていない。台帳は待ち合わせの語が無い受諾（「9/7 16:00〜如何」→「大丈夫です」）を知らない
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-answer-reading.ts   （DAYS=60・OUT=<file> で実物を書き出す）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { textSimilarity } from "../app/lib/knowledge-utils";
import { resolveViewingThread, CUSTOMER_SLOT_ACCEPT_RE } from "../app/lib/viewing-thread";
import { extractViewingAppointment } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; t: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page<T>(table: string, cols: string, since: string, extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    let q = sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const SCHED_ASK = /ご都合(?:の)?よろしい(?:お日にち|日時|日程|お時間|日)|ご都合(?:いかが|如何)|候補(?:日|の日|日時)|お日にち[^。\n]{0,12}(?:御座|ござ)いますでしょうか|日程(?:の)?(?:ご?調整|ご相談)|ご都合(?:の)?(?:良い|よい)/;
const DETAILS_LATER = /(?:内覧|ご案内|集合|待ち合わせ)[^。\n]{0,15}(?:詳細|場所|時間|日時)[^。\n]{0,20}(?:ご連絡|お送り|お伝え)/;
// route.ts の写し（isViewingAppointmentAck / isSecondClosing）
const VIEWING_SCHEDULED_STAFF_RE = new RegExp(
  "(?:明日|本日|今日|明後日|[0-9０-９]{1,2}[\\/月][0-9０-９]{1,2}(?:日)?)(?:[^。\\n]{0,60})(?:ご?案内|内覧|内見|お待ち合わせ|待ち合わせ|エントランス)" +
  "|(?:内覧|内見).*(?:ご案内させて頂き|一緒にご案内)|住所[:：]\\s*.{5,}");
const CUSTOMER_VIEWING_ACK_RE = /^(?:はい|了解|承知|かしこまり|わかりました|分かりました|大丈夫です|お願いします|よろしくお願い|ありがとう)[^\n]{0,12}$/m;
const RESCHEDULE_RE = /別日|別の日|変更|ずらし|都合(?:が)?悪|難しく|延期|キャンセル/;
async function main() {
  const DAYS = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const since2 = new Date(Date.now() - (DAYS + 30) * 86400e3).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ex = await page<any>("ai_reply_examples", "id, conversation_id, sent_reply, ai_draft, was_ai_used, ai_similarity, entry_source, sent_at, created_at", since, (q) => q.not("ai_draft", "is", null));
  const msgs = (await page<Msg>("messages", "conversation_id, sender, text, image_url, created_at", since2)).map((m) => ({ ...m, t: Date.parse(m.created_at) }));
  const byConv = new Map<string, Msg[]>(); for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const rows = ex.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && r.conversation_id && r.entry_source === "line_reply" && !String(r.conversation_id).startsWith("dd34f5b0"));
  type G = { used: boolean; draftBad: boolean; sentBad: boolean };
  const groups = new Map<string, G[]>(); const add = (k: string, g: G) => { if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(g); };
  const out: string[] = [];
  let ackN = 0, ackSched = 0, fire1 = 0, fireAll = 0, fire1S = 0, fireAllS = 0;
  for (const r of rows) {
    const list = byConv.get(r.conversation_id) ?? [];
    const sentT = Date.parse(r.sent_at ?? r.created_at);
    const head = String(r.sent_reply).replace(/\s+/g, "").slice(0, 12);
    const hit = list.find((m) => m.sender !== "customer" && Math.abs(m.t - sentT) < 15 * 60e3 && (m.text ?? "").replace(/\s+/g, "").startsWith(head));
    const anchor = hit ? hit.t : sentT;
    const before = list.filter((m) => m.t < anchor - 1000);
    if (!before.length || before[before.length - 1].sender !== "customer") continue;
    const d = String(r.ai_draft), s = String(r.sent_reply), used = !!r.was_ai_used;
    const thread = resolveViewingThread(before.map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: m.text ?? (m.image_url ? "[画像]" : ""), rawCreatedAt: m.created_at })), { nowMs: anchor, windowHours: 7 * 24 });
    const ledgerAppt = [...before].reverse().filter((m) => m.sender !== "customer" && anchor - m.t < 10 * 86400e3).map((m) => extractViewingAppointment(m.text ?? "", m.created_at)).find(Boolean) ?? null;
    const cust = (() => { const b: Msg[] = []; for (let i = before.length - 1; i >= 0 && before[i].sender === "customer"; i--) b.unshift(before[i]); return b.map((m) => m.text ?? "").join("\n"); })();
    const custN = cust.normalize("NFKC").trim();
    const ack = CUSTOMER_VIEWING_ACK_RE.test(custN) && !RESCHEDULE_RE.test(cust) && !/[？?]/.test(cust);
    const draftBad = SCHED_ASK.test(d) || DETAILS_LATER.test(d), sentBad = SCHED_ASK.test(s) || DETAILS_LATER.test(s);
    add(`${thread.kind}:${thread.reason.replace(/\+.*/, "")}${ledgerAppt ? "／台帳=拾える" : "／台帳=拾えない"}${CUSTOMER_SLOT_ACCEPT_RE.test(custN) ? "／今=受諾" : ""}`, { used, draftBad, sentBad });
    if (thread.kind === "scheduled") add(`[scheduled × お客様の発言=${ack ? "短い了承" : "その他"}]`, { used, draftBad, sentBad });
    // ③ 1行目だけ vs 全文
    if (CUSTOMER_VIEWING_ACK_RE.test(custN) && !RESCHEDULE_RE.test(cust)) {
      const staff = before.filter((m) => m.sender !== "customer" && (m.text ?? "").trim() && !/^\[(画像|動画|スタンプ)/.test(m.text ?? "")).slice(-3);
      const f1 = VIEWING_SCHEDULED_STAFF_RE.test(staff.map((m) => (m.text ?? "").split("\n")[0]).join("\n"));
      const fa = VIEWING_SCHEDULED_STAFF_RE.test(staff.map((m) => m.text ?? "").join("\n"));
      ackN++; if (f1) fire1++; if (fa) fireAll++;
      if (thread.kind === "scheduled") { ackSched++; if (f1) fire1S++; if (fa) fireAllS++; }
    }
    if (thread.kind === "scheduled" && draftBad && !sentBad) {
      out.push(`\n#### ${thread.reason} id=${String(r.id).slice(0, 8)} conv=${r.conversation_id.slice(0, 8)} at=${String(r.sent_at ?? r.created_at).slice(0, 16)} used=${used} sim=${(typeof r.ai_similarity === "number" ? r.ai_similarity : textSimilarity(d, s)).toFixed(2)}`);
      for (const m of before.slice(-6)) out.push(`  [-${Math.round((anchor - m.t) / 60e3)}分] ${m.sender === "customer" ? "客" : "我"}: ${mask((m.text ?? "[画像]").replace(/\n+/g, " / ")).slice(0, 220)}`);
      out.push(`  ▼下書き: ${mask(d.replace(/\n+/g, " / ")).slice(0, 300)}`);
      out.push(`  ▲実送信: ${mask(s.replace(/\n+/g, " / ")).slice(0, 300)}`);
    }
  }
  console.log(`直近${DAYS}日 下書き×実送信（お客様への返答・YUMA除く）`);
  console.log("■ 内覧の流れ × 台帳の見方 × 『日程の問い／詳細は後で連絡』");
  for (const [k, xs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${k.padEnd(56)} ${String(xs.length).padStart(4)}組 そのまま ${pct(xs.filter((x) => x.used).length, xs.length).padStart(6)} ／下書き ${xs.filter((x) => x.draftBad).length}・実送信 ${xs.filter((x) => x.sentBad).length}`);
  }
  console.log(`■ シンプル締め（isViewingAppointmentAck）の判定: お客様の了承 ${ackN}組 — 1行目だけ ${fire1}／全文 ${fireAll}`);
  console.log(`   うち scheduled（決まった内覧）${ackSched}組 — 1行目だけ ${fire1S}（${pct(fire1S, ackSched)}）／全文 ${fireAllS}（${pct(fireAllS, ackSched)}）／全文だと scheduled 以外にも ${fireAll - fireAllS}組立つ`);
  if (process.env.OUT) { writeFileSync(process.env.OUT, out.join("\n")); console.log(`実物 ${out.filter((l) => l.startsWith("\n####")).length}件 → OUT`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
