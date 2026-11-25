// scripts/audit-promise-kinds.ts — 約束の種類ごとの網の当たりと「その他」の割合（読むだけ・LLM を呼ばない・費用0）
//
// 2026-11-23 作業員L（竹内さん 11/23 P0「お客さんとの約束の部分もぬけや、足りていない土台がないか、細部まで確認して強化する」・統括役の割り振り・KB 0f38f47f の型）。
//   こちらの手打ちの文（sender=staff・is_aix_generated=false）を節に分け、約束の形の節（広い網: させて頂きます・致します・次第…ご連絡 等・挨拶とお願いを除く）ごとに、
//   どの網が拾うかを並べる: 見張り（promise-drop-watch.promiseKindNameOf）・行動台帳（action-ledger.classifyStaffTextFacts の promised）・
//   連絡日（contact-promise.parseContactPromise）・待ち合わせ（meeting-promise.MEETING_PROMISE_RE）。
//   種類（探す・確認・見積・内覧・連絡・電話・その他）に割り、「その他」＝種類の網のどれにも入らない約束の形の節の割合と、入らない言い回しの型を数える。
//   記録の段: 同じ通の sent_facts（line_message_id か ±2分）と calendar_events の【必ず】【連絡日】の行（作った時刻 ±10分）があるか。
// 出すのは数・会話の頭8字・伏せた型だけ（お客様の文・名前は出さない）。昼は14日（日付で絞る）・60日は夜。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-kinds.ts [--days=14] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { promiseClausesOf, promiseKindNameOf, promiseOpenEnded, promiseFulfilledBy, promiseClosedConversation, promiseDeadlineMs, promiseWideKindOf, type PromiseKindName, type PdMsg, type PdAix, type PdSent } from "../app/lib/promise-drop-watch";
import { classifyStaffTextFacts, confirmObjectOf } from "../app/lib/action-ledger";
import { parseContactPromise } from "../app/lib/contact-promise";
import { MEETING_PROMISE_RE } from "../app/lib/meeting-promise";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

/** 約束の形の節（広い網）。挨拶・お願い・お礼・了解・お待ちは除く */
export const PROMISE_SHAPE_RE = /させて(?:頂|いただ)きます|(?:致|いた)します|(?:お送り|ご連絡|お伝え|ご報告|お調べ|確認)(?:します|しますね)|次第[^。！!？?\n]{0,20}(?:ご連絡|お送り|お伝え|ご報告)|(?:後ほど|追って|改めて|折り返し)[^。！!？?\n]{0,20}(?:ご連絡|お送り|お電話|お伝え)/;
export const NOT_PROMISE_RE = /(?:お願い|失礼|承知|かしこまり|宜しくお願い|よろしくお願い|感謝|お待ち)(?:致|いた)し|(?:お待ち|楽しみに)(?:して)?(?:おり|い)ます|ご案内させて(?:頂|いただ)きます(?:ので|ね)?[^。]*(?:当日|よろしく)|お気軽に|(?:頂|いただ)ければ幸い/;
export type PromiseType = "探す" | "確認" | "見積" | "内覧" | "連絡" | "電話" | "その他";

export function promiseShapeClauses(text: string): string[] {
  return promiseClausesOf(text).split(/(?<=[。！!？?\n])/).map((c) => c.trim()).filter((c) => c && PROMISE_SHAPE_RE.test(c) && !(NOT_PROMISE_RE.test(c) && !/(?:確認|お調べ|お送り|ご連絡|ピックアップ|見積|お電話)させて/.test(c)));
}

/** 節の種類（網の当たりから）。網のどれにも入らない時は言葉で寄せず「その他」 */
export function promiseTypeOf(o: { watch: string | null; ledger: string[]; contact: boolean; meeting: boolean }): PromiseType {
  if (o.watch === "pickup" || o.ledger.includes("pickup_declared")) return "探す";
  if (o.watch === "estimate" || o.ledger.includes("estimate_declared")) return "見積";
  if (o.watch === "check" || o.ledger.includes("confirmation_promised")) return "確認";
  if (o.watch === "viewing_slot" || o.meeting) return "内覧";
  if (o.contact) return "連絡";
  if (o.watch === "callback") return "電話";
  return "その他";
}

/**
 * 「その他」の分け（網に入らない節の中身）: 申込以降（対象外）・約束でない説明（発生いたします・担当させて頂きます）・
 *   内覧の当日の案内（日時の決まった案内＝内覧の予定の行が持つ）・気持ちの言葉（全力で・尽力・最善）・種類の網の候補（wide）・残り
 */
export type OtherBucket = "申込以降" | "約束でない" | "内覧当日" | "気持ち" | "候補" | "残り";
export const AFTER_APPLY_RE = /お?申(?:し)?込(?:み)?(?:し|を|させて|手続き|完了|変更)|審査|内定通知書|契約書|鍵のお渡し|お部屋(?:を)?(?:抑え|押さえ)|身分証明書|ご入力とお写真/;
export const NOT_A_PROMISE_RE = /発生(?:いた|致)します|担当させて(?:頂|いただ)きます|と申しま|お手数をおかけ|ご報告させて(?:頂|いただ)きます(?:[！!。]|$)|ご判断/;
export const FEELING_RE = /全力で|尽力|最善を尽く|出来る限り(?:の|抑え)|しっかり|無事[^。]{0,12}(?:よう|様)|ご安心/;
export const SET_PHRASE_RE = /(?:初期費用|費用)[^。！!？?\n]{0,10}?最大限(?:割引|お安く|抑え)[^。！!？?\n]{0,4}?させて(?:頂|いただ)きます/;
export const VIEWING_DAY_RE = /ご案内させて(?:頂|いただ)きます|(?:ご内覧日|お時間|ご内覧時間)(?:を)?変更させて/;
// 種類の網の候補は promise-drop-watch.promiseWideKindOf（PROMISE_KIND_WIDE で見張りに足す物と同じ）
export function otherBucketOf(clause: string): OtherBucket {
  const t = clause.normalize("NFKC");
  if (AFTER_APPLY_RE.test(t)) return "申込以降";
  if (promiseWideKindOf(t)) return "候補";
  if (NOT_A_PROMISE_RE.test(t)) return "約束でない";
  if (VIEWING_DAY_RE.test(t)) return "内覧当日";
  if (FEELING_RE.test(t)) return "気持ち";
  // 2026-11-25 作業員L（#664・統括役の頼み）: 「初期費用を最大限割引させて頂きます」だけの節は締めの決まり文句（竹内さん本人 60日 77回: 締めの位置 68%・72時間以内の見積の AIX 19%）＝約束に数えない
  if (SET_PHRASE_RE.test(t) && !/御?見積/.test(t)) return "気持ち";
  return "残り";
}

/** 伏せた型（名前・物件名・数字を伏せ、約束の動詞の前後だけ） */
export function maskedShape(clause: string): string {
  let s = clause.normalize("NFKC")
    .replace(/[^\s、。！!？?]{1,12}(?:様|さん)/g, "〇〇様")
    .replace(/[ァ-ヴー・]{3,}/g, "＊")
    .replace(/[0-9]+/g, "0")
    .replace(/https?:\/\/\S+/g, "URL");
  const m = s.match(/.{0,18}(?:させて(?:頂|いただ)きます|(?:致|いた)します|します|次第|後ほど|追って|改めて|折り返し).{0,6}/);
  if (m) s = m[0];
  return s.slice(0, 40);
}

/** 同じ言い回しの型でまとめる鍵（動詞の直前の語） */
export function shapeKey(clause: string): string {
  const t = clause.normalize("NFKC");
  const m = t.match(/([^\s、。！!？?]{0,6}?)(?:を|に|の|も)?(確認|お調べ|お送り|ご連絡|お伝え|ご報告|ご案内|ご用意|お探し|手配|お取り置き|交渉|お問い合わせ|お手続き|ご提案|お作り|作成|お電話|調整|ご相談|お預かり|お申込|送付|共有|ご紹介|ご準備)/);
  return m ? m[2] : "（動詞なし）";
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("audit-promise-kinds.ts")) {
  (async () => {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const days = Number(arg("days", "14")) || 14;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const page = async <T,>(table: string, sel: string, f: (q: never) => never): Promise<T[]> => {
      const out: T[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await (f(sb.from(table).select(sel) as never) as unknown as { range: (a: number, b: number) => Promise<{ data: T[] | null; error: { message: string } | null }> }).range(from, from + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      return out;
    };
    type M = { conversation_id: string; text: string | null; created_at: string; line_message_id: string | null };
    const msgs = (await page<M>("messages", "conversation_id, text, created_at, line_message_id",
      (q) => (q as unknown as { eq: (a: string, b: unknown) => { eq: (a: string, b: unknown) => { gte: (a: string, b: string) => { order: (a: string, b: object) => never } } } })
        .eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).order("created_at", { ascending: true })))
      .filter((m) => !isTestConversation(m.conversation_id) && !isNoLineTestConversation(m.conversation_id) && !STAFF_INTERNAL_CONVERSATION_IDS.includes(m.conversation_id as never));
    type F = { conversation_id: string; kind: string; status: string; sent_at: string; line_message_id: string | null };
    const facts = await page<F>("sent_facts", "conversation_id, kind, status, sent_at, line_message_id",
      (q) => (q as unknown as { eq: (a: string, b: string) => { gte: (a: string, b: string) => { order: (a: string, b: object) => never } } }).eq("status", "promised").gte("sent_at", new Date(Date.parse(since) - 86_400_000).toISOString()).order("sent_at", { ascending: true }));
    type C = { conversation_id: string | null; notes: string | null; created_at: string; is_done: boolean | null; done_at?: string | null };
    const cal = await page<C>("calendar_events", "conversation_id, notes, created_at, is_done, done_at",
      (q) => (q as unknown as { gte: (a: string, b: string) => { order: (a: string, b: object) => never } }).gte("created_at", new Date(Date.parse(since) - 15 * 86_400_000).toISOString()).order("created_at", { ascending: true }));

    type Row = { conv: string; at: string; type: PromiseType; watch: string | null; ledger: string[]; contact: boolean; meeting: boolean; openEnded: boolean; fact: boolean; calendar: boolean; calBefore: boolean; key: string; shape: string; bucket: OtherBucket | null; wide: string | null; text: string; convFull: string };
    const rows: Row[] = [];
    for (const m of msgs) {
      const text = String(m.text ?? "");
      const clauses = promiseShapeClauses(text);
      if (!clauses.length) continue;
      const atMs = Date.parse(m.created_at);
      const contact = !!parseContactPromise(text, m.created_at);
      const fact = facts.some((f) => f.conversation_id === m.conversation_id && ((m.line_message_id && f.line_message_id === m.line_message_id) || Math.abs(Date.parse(f.sent_at) - atMs) <= 120_000));
      const calendar = cal.some((c) => c.conversation_id === m.conversation_id && /^\s*(?:【必ず】|【連絡日 )/.test(c.notes ?? "") && Math.abs(Date.parse(c.created_at) - atMs) <= 600_000);
      // 前からの【必ず】の行がこの通の時に開いていた（planPromiseInsert が同じ種類の行を重ねない＝カレンダーに新しい行が無くても記録はある）。done_at の無い済みの行は時刻が分からないので「開いていた」に数えない
      const calBefore = cal.some((c) => c.conversation_id === m.conversation_id && /^\s*【必ず】/.test(c.notes ?? "") && Date.parse(c.created_at) < atMs - 600_000 && (!c.is_done || (!!c.done_at && Date.parse(c.done_at) > atMs)));
      for (const c of clauses) {
        const watch = promiseKindNameOf(c, { PROMISE_KIND_WIDE: argv.includes("--wide") ? "on" : "off", PROMISE_KIND_WIDE2: argv.includes("--wide2") ? "on" : "off" });
        const ledger = classifyStaffTextFacts(c, m.created_at).filter((e) => e.status === "promised").map((e) => String(e.kind));
        const meeting = MEETING_PROMISE_RE.test(c.normalize("NFKC"));
        const cContact = contact && !!parseContactPromise(c, m.created_at);
        const type = promiseTypeOf({ watch: watch === "other" ? null : watch, ledger: ledger.length ? ledger : [], contact: cContact, meeting });
        rows.push({ conv: m.conversation_id.slice(0, 8), at: m.created_at, type, watch, ledger, contact: cContact, meeting, openEnded: promiseOpenEnded(c), fact, calendar, calBefore, key: shapeKey(c), shape: maskedShape(c), bucket: type === "その他" ? otherBucketOf(c) : null, wide: type === "その他" ? promiseWideKindOf(c) : null, text: c, convFull: m.conversation_id });
      }
    }
    const by = <K extends string>(xs: Row[], f: (r: Row) => K) => xs.reduce((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);
    const total = rows.length;
    const other = rows.filter((r) => r.type === "その他");
    const typed = rows.filter((r) => r.type !== "その他");
    // 網どうしのずれ: 見張りが拾うが台帳が拾わない（記録に残らない＝画面のカレンダーに出ない）・台帳が拾うが見張りが拾わない（期日超えに出ない）
    const watchOnly = typed.filter((r) => r.watch && r.watch !== "other" && ["pickup", "check", "estimate"].includes(r.watch) && !r.ledger.length);
    const ledgerOnly = typed.filter((r) => r.ledger.length && (!r.watch || r.watch === "other"));
    const recordedOf = (xs: Row[]) => ({ n: xs.length, fact: xs.filter((r) => r.fact).length, calendar: xs.filter((r) => r.calendar).length, calOpenBefore: xs.filter((r) => !r.calendar && r.calBefore).length, noCalendar: xs.filter((r) => !r.calendar && !r.calBefore).length });
    const shapes = Object.entries(by(other, (r) => r.key)).sort((a, b) => b[1] - a[1]);
    const samples: Record<string, string[]> = {};
    for (const r of other) { (samples[r.key] ??= []); if (samples[r.key].length < 4 && !samples[r.key].includes(r.shape)) samples[r.key].push(`${r.conv} ${r.shape}`); }
    const out = {
      days, since, staffMsgs: msgs.length, promiseClauses: total,
      byType: by(rows, (r) => r.type),
      otherShare: total ? Math.round((other.length / total) * 1000) / 10 : 0,
      otherWatchOther: other.filter((r) => r.watch === "other").length,
      recordedByType: Object.fromEntries((["探す", "確認", "見積", "内覧", "連絡", "電話", "その他"] as PromiseType[]).map((t) => [t, recordedOf(rows.filter((r) => r.type === t))])),
      watchOnly: { n: watchOnly.length, byWatch: by(watchOnly, (r) => r.watch ?? "-"), samples: watchOnly.slice(0, 8).map((r) => `${r.conv} ${r.watch} ${r.shape}`) },
      ledgerOnly: { n: ledgerOnly.length, byLedger: by(ledgerOnly, (r) => r.ledger.join("+")), samples: ledgerOnly.slice(0, 8).map((r) => `${r.conv} ${r.ledger.join("+")} ${r.shape}`) },
      openEnded: rows.filter((r) => r.openEnded).length,
      otherBuckets: by(other, (r) => r.bucket ?? "-"),
      otherWide: by(other.filter((r) => r.wide), (r) => r.wide ?? "-"),
      otherRest: other.filter((r) => r.bucket === "残り").slice(0, 30).map((r) => `${r.conv} ${r.shape}`),
      otherShapes: shapes.slice(0, 20),
      otherSamples: Object.fromEntries(shapes.slice(0, 12).map(([k]) => [k, samples[k]])),
    };
    // 候補（wide）の約束を果たしたか（見張りと同じ promiseFulfilledBy・判定できる pickup・check だけ）。候補の会話だけ・日付で絞って読む
    const cands = rows.filter((r) => r.wide === "pickup" || r.wide === "check");
    const fulfil: Array<{ conv: string; at: string; wide: string; state: string; by: string | null; shape: string }> = [];
    const nowMs = Date.now();
    for (const conv of [...new Set(cands.map((r) => r.convFull))]) {
      const [cv, mm, aa] = await Promise.all([
        sb.from("conversations").select("status, line_user_id").eq("id", conv).maybeSingle(),
        sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", conv).gte("created_at", since).order("created_at").limit(1500),
        sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", conv).gte("created_at", since).limit(400),
      ]);
      const c = cv.data as { status?: string | null; line_user_id?: string | null } | null;
      const { data: pcs } = c?.line_user_id ? await sb.from("property_customers").select("id").eq("line_user_id", c.line_user_id).limit(5) : { data: [] };
      const pcIds = ((pcs ?? []) as Array<{ id: string }>).map((x) => x.id);
      const orq = pcIds.length ? [`conversation_id.eq.${conv}`, ...pcIds.map((id) => `property_customer_id.eq.${id}`)].join(",") : `conversation_id.eq.${conv}`;
      const sp = await sb.from("sent_properties").select("sent_at").or(orq).or("source.is.null,source.neq.line_group").gte("sent_at", since).limit(400);
      const ev = { msgs: (mm.data ?? []) as PdMsg[], aix: (aa.data ?? []) as PdAix[], sent: (sp.data ?? []) as PdSent[] };
      for (const r of cands.filter((x) => x.convFull === conv)) {
        const closed = promiseClosedConversation(c?.status ?? null, ev.msgs, r.at);
        const f0 = promiseFulfilledBy({ at: r.at, kind: r.wide as PromiseKindName, text: r.text }, ev, { checkObjectOf: (t: string) => confirmObjectOf(t) });
        const f = f0 && typeof f0 === "object" ? f0 : null;
        const dl = promiseDeadlineMs(r.text, Date.parse(r.at)).ms;
        const state = closed ? "外す（申込以降・決めた）" : f ? (Date.parse(f.at) <= dl ? "期限内" : "遅れて") : nowMs > dl ? "期限超え・未" : "期限前";
        fulfil.push({ conv: r.conv, at: r.at.slice(5, 16), wide: r.wide ?? "-", state, by: f?.by ?? null, shape: r.shape });
      }
    }
    const byState: Record<string, number> = {};
    for (const f of fulfil) byState[f.state] = (byState[f.state] ?? 0) + 1;
    const outAll = { ...out, wideFulfil: { n: fulfil.length, byState, rows: fulfil } };
    console.log(JSON.stringify(outAll, null, 1));
    const o = arg("out");
    if (o) writeFileSync(o, JSON.stringify({ ...outAll, rows: rows.map(({ text: _t, convFull: _c, ...r }) => r) }, null, 1));
  })().catch((e) => { console.error(e); process.exit(1); });
}
