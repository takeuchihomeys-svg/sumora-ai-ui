// app/lib/relative-dates.ts — 日付の距離（「3日前に送った」「期限まで2日」「今日」）と古さの印（純関数・DB/LLM なし）
//
// 2026-10-23 竹内さん「約束したことや送った物件などの記憶は日時で把握できるようになっているのか そこ日時で判断出来ればより質高くなる」
//   ＋「原則と応用をつかって人間のように考える・状況に応じたデータを引っ張ってくる」（かなり重要）。
// 旧: ブレインの材料は 10/20 14:05 の様な絶対の日時だけ（行動台帳・送付済みの物件・内覧の予定）で、
//   「今日から何日前か」「期限まであと何日か」を LLM が自分で引き算していた（曜日の計算と同じく間違いやすい・jst-date.ts の方針D）。
// 新（BRAIN_RELATIVE_DATES=on の時だけ・既定 off）:
//   ① system の静的な前置き（キャッシュする側）に読み方の決まり（原則1行＋応用）を1回だけ足す（RELATIVE_DATES_RULE）
//   ② 毎回の材料の最後の方（キャッシュしない側）に【日付の距離】を足す: 送った物件・御見積書・確認の報告・約束・内覧・申込の案内・お客様の最後の発言を
//      日本時間の日付＋今日からの距離（決定論）＋古さの印（物件資料 7日以上→空き確認が要る／約束の期限切れ／見積の条件が古い 等）で並べる
//   ③ 下書き（generate-reply）にも送った物の距離と言い方の目安（「本日お送りした」／「先日お送りした」）を1ブロックで渡す（relativeDatesWriterNote）
// 今日は Date.now()（試験は場面の日付を実行日へずらす＝EXAM_DATE_SHIFT。ブレインの他の時計と同じ値を使うので、ずらした場面でも距離は合う）。
// 日付の計算は jst-date.ts の関数だけ（+9h してから getUTC*）。線の日数は資料の古さの印（stale-material.ts）と同じ STALE_MATERIAL_DAYS（既定 7）。
// テスト: app/lib/__tests__/relative-dates.test.ts
import { JST_OFFSET_MS, jstParts, WEEKDAYS_JA } from "./jst-date";
import { parseContactPromise } from "./contact-promise";
import type { LedgerEntry } from "./action-ledger";

const DAY_MS = 86_400_000;

export function relativeDatesEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_RELATIVE_DATES ?? "").trim().toLowerCase() === "on";
}
export function relativeStaleDays(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): number {
  const n = Number(env.STALE_MATERIAL_DAYS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 7;
}

const toMs = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v;
  // 'YYYY-MM-DD' だけの日付は日本時間のその日の 0:00
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00+09:00`);
  return Date.parse(v);
};
/** 日本時間の暦の日の番号（日の差を取るため） */
const dayIndex = (ms: number) => Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
/** 暦の日の差（at の日 − 今日）。過去は負 */
export function jstDayDiff(at: string | number | null | undefined, nowMs: number): number | null {
  const t = toMs(at);
  if (!Number.isFinite(t)) return null;
  return dayIndex(t) - dayIndex(nowMs);
}
/** 「10/20(月)」 */
export function mdw(at: string | number): string {
  const p = jstParts(toMs(at));
  return `${p.m}/${p.d}(${WEEKDAYS_JA[p.dow]})`;
}
/** 過去の距離: 今日／昨日／n日前（未来の日付なら futureLabel） */
export function pastLabel(diff: number): string {
  if (diff > 0) return futureLabel(diff);
  if (diff === 0) return "今日";
  if (diff === -1) return "昨日";
  return `${-diff}日前`;
}
/** 先の距離: 今日／明日／明後日／n日後（過去の日付なら pastLabel） */
export function futureLabel(diff: number): string {
  if (diff < 0) return pastLabel(diff);
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  if (diff === 2) return "明後日";
  return `${diff}日後`;
}
/** 期限の距離: 期限まで n日／期限は今日／期限を n日過ぎ */
export function deadlineLabel(diff: number): string {
  if (diff > 0) return `期限まで${diff}日`;
  if (diff === 0) return "期限は今日";
  return `期限を${-diff}日過ぎ`;
}
/** 1つの日付の札「10/20(月)（3日前）」 */
export function datedPast(at: string | number, nowMs: number): string {
  const d = jstDayDiff(at, nowMs);
  return d == null ? "" : `${mdw(at)}（${pastLabel(d)}）`;
}

/** 約束の文の期限（決定論）。「〇月〇日に…ご連絡」（contact-promise）→ 今日中／本日中 → 明日／明日中 の順。読めなければ null */
export function promiseDueYmdMs(sentence: string, at: string): number | null {
  const atMs = toMs(at);
  if (!Number.isFinite(atMs)) return null;
  const c = parseContactPromise(sentence, at);
  if (c) return Date.parse(`${c.contact.y}-${String(c.contact.m).padStart(2, "0")}-${String(c.contact.d).padStart(2, "0")}T00:00:00+09:00`);
  if (/本日中|今日中|本日[^。\n]{0,10}(?:ご連絡|お送り|ご報告)/.test(sentence)) return atMs;
  if (/明日/.test(sentence) && !/明後日/.test(sentence)) return atMs + DAY_MS;
  if (/明後日/.test(sentence)) return atMs + 2 * DAY_MS;
  return null;
}

// ─── 入力（ブレインの材料からそのまま渡せる形） ──────────────────────────────
export type RdSentProp = { property_name: string; room_no?: string | null; sent_at: string; shared_only?: boolean };
export type RdViewing = { ymd: string | null; time?: string | null; name?: string | null; status?: string | null };
export type RdOpenPromise = { kind: string; sentence: string; at: string; status?: string; hasDeadline?: boolean };
export type RelativeDatesInput = {
  ledgerEntries?: ReadonlyArray<LedgerEntry>;
  sentProps?: ReadonlyArray<RdSentProp>;
  viewings?: ReadonlyArray<RdViewing>;
  openPromises?: ReadonlyArray<RdOpenPromise>;
  lastCustomerAt?: string | null;
};

/** 内覧の行（customer-state の一覧 か viewing_history の行）を1つの形に */
export function normalizeViewings(csViewings: ReadonlyArray<{ ymd: string | null; time?: string | null; name?: string | null; status?: string | null }> | null | undefined,
  rawViewings: ReadonlyArray<{ viewing_date: string; viewing_time?: string | null; status?: string | null; property_name?: string | null }> | null | undefined): RdViewing[] {
  if (csViewings && csViewings.length) return csViewings.map((v) => ({ ymd: v.ymd, time: v.time ?? null, name: v.name ?? null, status: v.status ?? null }));
  return (rawViewings ?? []).map((v) => ({ ymd: String(v.viewing_date ?? "").slice(0, 10) || null, time: v.viewing_time ? String(v.viewing_time).slice(0, 5) : null, name: v.property_name ?? null, status: v.status ?? null }));
}

const CANCELLED_RE = /cancel|キャンセル/i;
const DONE_RE = /^(?:done|completed|完了)$/i;
const looseHas = (hay: ReadonlyArray<string> | undefined, name: string) => {
  const n = name.replace(/\s+/g, "");
  return !!n && (hay ?? []).some((h) => { const x = String(h ?? "").replace(/\s+/g, ""); return !!x && (x.includes(n) || n.includes(x)); });
};

/**
 * 【日付の距離】の材料（毎回変わる側・キャッシュしない所）。何も無ければ空文字。
 * 行は種類ごとに新しい物から最大数件。古さの印は「⚠」で始める（言うか・確認するかはブレインが決める）。
 */
export function buildRelativeDatesNote(input: RelativeDatesInput, nowMs: number, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): string {
  const stale = relativeStaleDays(env);
  const L: string[] = [];
  const entries = [...(input.ledgerEntries ?? [])].filter((e) => e.at && Number.isFinite(toMs(e.at)));
  const confirmations = entries.filter((e) => e.kind === "confirmation_reported" && e.status === "done");

  // ① 送った物件（お客様に届けた物だけ・送った日ごとにまとめる）
  const delivered = (input.sentProps ?? []).filter((p) => !p.shared_only && Number.isFinite(toMs(p.sent_at)));
  const byDay = new Map<number, { at: string; names: string[] }>();
  for (const p of delivered) {
    const k = dayIndex(toMs(p.sent_at));
    const g = byDay.get(k) ?? { at: p.sent_at, names: [] };
    const nm = `${p.property_name}${p.room_no ? ` ${p.room_no}` : ""}`.trim();
    if (nm && !g.names.includes(nm)) g.names.push(nm);
    if (toMs(p.sent_at) > toMs(g.at)) g.at = p.sent_at;
    byDay.set(k, g);
  }
  // sent_properties が無い会話は台帳の物件送付（AIX・手打ち）で
  if (byDay.size === 0) {
    for (const e of entries.filter((x) => x.kind === "properties_sent" && x.status === "done")) {
      const k = dayIndex(toMs(e.at!));
      const g = byDay.get(k) ?? { at: e.at!, names: [] };
      for (const nm of e.detail?.propertyNames ?? []) if (!g.names.includes(nm)) g.names.push(nm);
      byDay.set(k, g);
    }
  }
  const sendDays = [...byDay.entries()].sort((a, b) => b[0] - a[0]).slice(0, 4);
  for (const [, g] of sendDays) {
    const diff = jstDayDiff(g.at, nowMs)!;
    const names = g.names.slice(0, 4).join("・") + (g.names.length > 4 ? ` ほか${g.names.length - 4}件` : "");
    let line = `・物件の送付 ${datedPast(g.at, nowMs)}${names ? `: ${names}` : ""}`;
    if (-diff >= stale) {
      // その物件の募集状況をその後に確かめていれば（線の日数より新しい確認）印は出さない
      const fresh = confirmations.filter((c) => toMs(c.at!) > toMs(g.at) && -(jstDayDiff(c.at!, nowMs) ?? -999) < stale
        && (!g.names.length || !(c.detail?.propertyNames ?? []).length || g.names.some((nm) => looseHas(c.detail?.propertyNames, nm.split(" ")[0]))));
      if (fresh.length) line += `（その後 ${datedPast(fresh.at(-1)!.at!, nowMs)} に募集状況を確認済み）`;
      else line += `\n  ⚠ ${stale}日以上前の資料: この物件の空き・内覧・申込・費用の話なら、今の空きの根拠にせず念のため募集状況を確認する（AIX【物件確認した】・竹内さんの方針 10/14）`;
    }
    L.push(line);
  }

  // ② 御見積書
  const est = entries.filter((e) => e.kind === "estimate_sent" && e.status === "done").slice(-2).reverse();
  for (const e of est) {
    const diff = jstDayDiff(e.at!, nowMs)!;
    const forWhat = (e.detail?.estimateFor ?? []).slice(0, 3).join("・");
    L.push(`・御見積書の送付 ${datedPast(e.at!, nowMs)}${forWhat ? `: ${forWhat}` : ""}${-diff >= stale ? `\n  ⚠ ${stale}日以上前の見積: 家賃・キャンペーン・日割り・入居日などの条件が今と違う可能性。金額を言い直す・申込を進める前に今の条件と合うか確かめる` : ""}`);
  }

  // ③ 募集状況の確認の報告（新しい物から2件）
  for (const e of confirmations.slice(-2).reverse()) {
    const diff = jstDayDiff(e.at!, nowMs)!;
    const names = (e.detail?.propertyNames ?? []).slice(0, 3).join("・");
    L.push(`・募集状況の確認の報告 ${datedPast(e.at!, nowMs)}${names ? `: ${names}` : ""}${-diff >= stale ? `\n  ⚠ ${stale}日以上前の確認: 空きは変わり得る（今の空きとして言い切らない）` : ""}`);
  }

  // ④ まだ果たしていない約束（約束の追跡の open・新しい物から4件）
  const promises = [...(input.openPromises ?? [])].filter((p) => Number.isFinite(toMs(p.at))).sort((a, b) => toMs(b.at) - toMs(a.at)).slice(0, 4);
  for (const p of promises) {
    const due = promiseDueYmdMs(p.sentence, p.at);
    const dueDiff = due != null ? jstDayDiff(due, nowMs) : null;
    const s = p.sentence.length > 40 ? `${p.sentence.slice(0, 40)}…` : p.sentence;
    let line = `・約束（${p.kind}・まだ果たしていない）${datedPast(p.at, nowMs)}「${s}」`;
    if (dueDiff != null) line += ` 期限 ${mdw(due!)}（${deadlineLabel(dueDiff)}）`;
    else line += "（期限の語なし）";
    if (p.status && /待ち/.test(p.status)) line += "・相手の結果待ち";
    if (dueDiff != null && dueDiff < 0) line += "\n  ⚠ 期限切れの約束: 今回の返信で触れるなら、遅れの一言と今どうなっているか（いつ果たすか）を先に伝える";
    else if (dueDiff === 0) line += "\n  ⚠ 期限は今日: 今日中に果たす（果たせないなら今日のうちに状況を伝える）";
    else if (dueDiff == null && jstDayDiff(p.at, nowMs)! <= -3 && !(p.status && /待ち/.test(p.status))) line += "\n  ⚠ 3日以上たった約束: お客様から見ると止まっている。今回触れるなら今の状況から伝える";
    L.push(line);
  }

  // ⑤ 内覧（取り消しを除き、近い物から3件）
  const vs = (input.viewings ?? []).filter((v) => v.ymd && !CANCELLED_RE.test(String(v.status ?? "")) && Number.isFinite(toMs(v.ymd)))
    .map((v) => ({ v, diff: jstDayDiff(v.ymd!, nowMs)! }))
    .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff)).slice(0, 3)
    .sort((a, b) => a.diff - b.diff);
  for (const { v, diff } of vs) {
    const when = `${mdw(v.ymd!)}${v.time ? ` ${v.time}` : ""}`;
    const done = DONE_RE.test(String(v.status ?? ""));
    const tail = diff >= 0 ? futureLabel(diff) : `${pastLabel(diff)}・${done ? "済み" : "済んだかの記録なし"}`;
    L.push(`・内覧 ${when}（${tail}）${v.name ? `: ${v.name}` : ""}`);
  }

  // ⑥ 申込の案内・内覧の打診・待ち合わせ（最後の物だけ）
  for (const k of ["application_guided", "viewing_invited", "meeting_place_sent"] as const) {
    const e = entries.filter((x) => x.kind === k && x.status === "done").at(-1);
    if (!e) continue;
    const ja = k === "application_guided" ? "申込の案内" : k === "viewing_invited" ? "内覧の打診" : "待ち合わせ場所の案内";
    L.push(`・${ja} ${datedPast(e.at!, nowMs)}`);
  }

  // ⑦ お客様の最後の発言
  if (input.lastCustomerAt && Number.isFinite(toMs(input.lastCustomerAt))) L.push(`・お客様の最後の発言 ${datedPast(input.lastCustomerAt, nowMs)}`);

  if (!L.length) return "";
  return `\n\n【日付の距離（今日 ${mdw(nowMs)} から・決定論で計算済み・自分で引き算しない）】\n${L.join("\n")}`;
}

/** system の静的な前置きに足す読み方（原則1行＋応用）。キャッシュする側に1回だけ */
export const RELATIVE_DATES_RULE = `

【日付の距離の読み方】
- 原則: 人間の営業マンは「いつの事か」で動きを変える。材料の【日付の距離】（送った物件・御見積書・確認の報告・約束・内覧・申込の案内ごとの日本時間の日付と、今日からの距離＝今日／昨日／n日前／明日／n日後／期限まで n日／期限を n日過ぎ）は決定論で計算済みなので、距離は自分で引き算せずこの値で判断する。
- 応用: ①7日以上前の物件資料・確認の報告は今の空きの根拠にしない（その物件の空き・内覧・申込・費用の話なら念のため募集状況を確認）②7日以上前の御見積書は条件が変わり得る（金額を言い直す前に確かめる）③期限を過ぎた約束は、触れるなら遅れの一言と今の状況を先に・期限が今日の約束は今日中に果たす ④内覧が明日・今日なら当日の段取りが中心、済んだ内覧は内覧後の話 ⑤⚠ の印は事実と方針だけで、言うか・確認するかは今の番の依頼で決める（聞かれていない古さを長々と説明しない）。
- turn_contract の answer・situation・background に送った物・約束・内覧を書く時は距離を添える（例「10/20（3日前）に送ったA」「期限を1日過ぎた確認の約束」）。下書きの言い方の目安: 今日送った物は「本日お送りした」・昨日は「昨日お送りした」・それより前は「先日お送りした」（今日の物に「先日」と書かない）。`;

/** 静的な前置き（BRAIN_RELATIVE_DATES=on の時だけ読み方を足す・off なら同じ文字列） */
export function withRelativeDatesRule(staticText: string, env?: Record<string, string | undefined>): string {
  return relativeDatesEnabled(env) ? staticText + RELATIVE_DATES_RULE : staticText;
}

/** ブレインの材料の1か所から呼ぶ形（brain-core のフック）。off なら空文字 */
export function relativeDatesBrainNoteFor(i: {
  ledgerEntries: ReadonlyArray<LedgerEntry>;
  sentProps: ReadonlyArray<RdSentProp>;
  csViewings?: ReadonlyArray<{ ymd: string | null; time?: string | null; name?: string | null; status?: string | null }> | null;
  rawViewings?: ReadonlyArray<{ viewing_date: string; viewing_time?: string | null; status?: string | null; property_name?: string | null }> | null;
  openPromises: ReadonlyArray<RdOpenPromise>;
  lastCustomerAt: string | null;
}, nowMs: number = Date.now(), env?: Record<string, string | undefined>): string {
  if (!relativeDatesEnabled(env)) return "";
  try {
    return buildRelativeDatesNote({
      ledgerEntries: i.ledgerEntries, sentProps: i.sentProps, viewings: normalizeViewings(i.csViewings, i.rawViewings),
      openPromises: i.openPromises, lastCustomerAt: i.lastCustomerAt,
    }, nowMs, env);
  } catch { return ""; }
}

/**
 * 下書き（generate-reply）に渡す1ブロック: 送った物の日付の距離と言い方の目安。off・送った物が無ければ空文字。
 * ブレインの turn_contract にも距離は入るが、本質の帯が無い番（古い判断・夜の見送り）でも言い方が合う様に台帳から直接作る。
 */
export function relativeDatesWriterNote(entries: ReadonlyArray<LedgerEntry>, nowMs: number = Date.now(), env?: Record<string, string | undefined>): string {
  if (!relativeDatesEnabled(env)) return "";
  const KINDS: Array<[LedgerEntry["kind"], string]> = [["properties_sent", "物件の資料"], ["estimate_sent", "御見積書"], ["confirmation_reported", "募集状況の確認の報告"], ["meeting_place_sent", "待ち合わせ場所の案内"]];
  const L: string[] = [];
  for (const [k, ja] of KINDS) {
    const e = entries.filter((x) => x.kind === k && x.status === "done" && x.at && Number.isFinite(toMs(x.at))).at(-1);
    if (!e) continue;
    const diff = jstDayDiff(e.at!, nowMs)!;
    const say = diff === 0 ? "本日お送りした" : diff === -1 ? "昨日お送りした（先日お送りした）" : "先日お送りした";
    L.push(`- ${ja}: ${datedPast(e.at!, nowMs)} → 触れるなら「${say}」の形${k !== "meeting_place_sent" && -diff >= relativeStaleDays(env) ? `（${relativeStaleDays(env)}日以上前・今の空き/金額として言い切らない）` : ""}`);
  }
  if (!L.length) return "";
  return `\n\n【📅 送った日と今日の距離（今日 ${mdw(nowMs)}・決定論）】\n${L.join("\n")}\n- 今日送った物に「先日」、前の日に送った物に「本日」と書かない。日付・距離は自分で計算しない。`;
}
