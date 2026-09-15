// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-09 Fable5 G1「行動台帳（Action Ledger）」
//   我々が【何をしたか＝done】／【何をすると言ったか＝promised】を一次証拠から決定論で1回だけ構築し、
//   生成（【📒 我々の行動台帳】・staffContextNote・往復文脈 classifyLastStaffTurn・hedge.searched・aixDone）
//   ・検査（final-check runLedgerChecks / UNSENT_CLAIM / JUSHU_BEFORE_SEND / STAGE）
//   ・check-reply・brain-core・tpo_debug / reply_context_snapshot の四者が同一オブジェクトを参照する（四者同名）。
//   設計原則: ルールではなく証拠／state 非依存／宣言（未来形）と実行（過去形・成果物・AIX ログ）を分ける。
//   証拠の信頼度: aix_usage_logs(3) > line_tasks・brain last_aix_history(2) > スタッフ本文 regex(1)
//   ※ aix 行の ±3分にあるスタッフ発言は本文 regex を当てない（estimate_sheet 本文の「🌟割引」「[画像]」を物件送付と誤カウントしない）
//   依存方向: action-ledger → reply-context（runtime）。reply-context 側は `import type` のみ（循環 import による TDZ を構造的に回避）
// ─────────────────────────────────────────────────────────────────────────────
import {
  analyzeSubstance, classifyCustomerResponse,
  STAFF_PICKUP_DECL_RE, STAFF_PROPERTIES_DONE_RE, STAFF_ESTIMATE_WORD_RE, STAFF_ESTIMATE_DECL_RE, staffEstimateDelivered,
  STAFF_NON_PROPERTY_RE, STAFF_CONFIRM_DECL_RE, STAFF_CONFIRM_REPORT_RE, STAFF_VIEWING_INVITE_RE,
  STAFF_APPLY_PUSH_RE, STAFF_CONDITION_ASK_RE, STAFF_QUESTION_RE, REDO_CLAIM_RE,
  LEDGER_OUTBOUND_SOURCES, pickupRound, redoWord,
  type StaffTurn, type StaffTurnKind, type CustomerResponseKind,
} from './reply-context';
// 2026-09-12 竹内方針D: JST の日付表示は jst-date に一本化
import { jstMDHm, jstParts, jstDayStartMs } from './jst-date';
// 再 export（生成・検査が action-ledger 経由でも同じ定数を得る）
export { STAFF_PICKUP_DECL_RE, STAFF_PROPERTIES_DONE_RE, REDO_CLAIM_RE, LEDGER_OUTBOUND_SOURCES };

export type LedgerKind =
  | 'pickup_declared' | 'properties_sent' | 'estimate_declared' | 'estimate_sent'
  | 'viewing_invited' | 'meeting_place_sent' | 'question_asked'
  | 'confirmation_promised' | 'confirmation_reported' | 'condition_asked'
  | 'application_guided' | 'followup_sent' | 'media_sent'
  /** 2026-09-12 竹内（あや事例）: AIX【初期費用を説明】で仕組み＋貸主からの報酬・還元額を説明した */
  | 'cost_explained'
  /** 2026-09-15 竹内（ゆうこ事例）: AIX【初期費用について】で御見積書の内訳（含まれる項目・家賃だけで入居できるか）を説明した */
  | 'cost_breakdown_explained'
  /** 2026-09-15 竹内（H 事例）: AIX【電話をかける】で LINEコールの「電話をかける」ボタンと案内文を送った（お客様からの電話待ち） */
  | 'call_requested'
  /** 2026-09-15 竹内（H 事例）: AIX【電話終了後】で電話でお話しした内容のまとめを送った（電話は済み） */
  | 'call_followup_sent';
export type LedgerStatus = 'promised' | 'done';
export type LedgerSource = 'aix_log' | 'line_task' | 'aix_history' | 'staff_text';
export type ReactionKind = CustomerResponseKind | 'none';

export interface LedgerEntry {
  kind: LedgerKind;
  status: LedgerStatus;
  at: string | null;
  source: LedgerSource;
  /** 3=aix_usage_logs / 2=line_tasks・brain history / 1=本文 regex */
  confidence: 3 | 2 | 1;
  evidence: string;
  detail: {
    propertyCount?: number;
    propertyNames?: string[];
    estimateFor?: string[];
    checkPattern?: string | null;
    object?: string | null;
    taskStatus?: string | null;
    /** meeting_place_sent: 案内した内覧の待ち合わせ（日付 M/D・時刻・場所）。AIX 待ち合わせ場所の本文・スタッフ本文から */
    appointment?: ViewingAppointment | null;
  };
  /** done 直後（次のスタッフ発言より前）の顧客返答（往復文脈の一般化） */
  customerReactionAfter?: ReactionKind;
  /** promised が後続の done で履行された場合、その entries index */
  fulfilledBy?: number | null;
}

/** 案内した内覧の待ち合わせ（M/D は日本時間。「本日」「明日」は案内した日から決める） */
export type ViewingAppointment = { dateMD: string | null; time: string | null; place: string | null };

export interface LedgerFacts {
  /** 2026-09-14 竹内（名無しの権兵衛事例）: 最後に案内した内覧の待ち合わせ（今日以降の分だけ）。
   *  「着きました」「遅れます」はこの内覧の当日連絡。旧: 台帳の要約に無く、当日の「着きました！」に新しい内覧日程を打診した */
  viewingAppointment: (ViewingAppointment & { day: 'today' | 'tomorrow' | 'later' | 'unknown'; sentAt: string | null }) | null;
  propertiesSentCount: number;
  propertiesSentNames: string[];
  lastPropertiesSentAt: string | null;
  /** 顧客最新メッセージ以降に物件を送った（resolveHedgeAllowance.searched と同値にする） */
  propertiesSentSinceCustomerLatest: boolean;
  estimateSent: boolean;
  estimateSentFor: string[];
  pickupPromisedUnfulfilled: boolean;
  pickupPromisedAt: string | null;
  pickupPromisedCount: number;
  estimatePromisedUnfulfilled: boolean;
  confirmationPromisedUnfulfilled: boolean;
  confirmationPromisedObject: string | null;
  confirmationReported: boolean;
  confirmationReportPattern: string | null;
  viewingInvited: boolean;
  meetingPlaceSent: boolean;
  applicationGuided: boolean;
  conditionAsked: boolean;
  lastDoneKind: LedgerKind | null;
  lastDoneAt: string | null;
  lastPromisedKind: LedgerKind | null;
  lastPromisedAt: string | null;
  /** 直前スタッフ発言に対応するエントリ（classifyLastStaffTurn の一次証拠） */
  lastStaffEntry: LedgerEntry | null;
  /** 直前スタッフ発言が AIX の時、その本文に書き足された約束（送信時の記録・aixTextPromises）。約束の履行の AIX の判定だけが使う（2026-09-15 ゆうこ事例） */
  lastStaffAixTextPromise?: LedgerEntry | null;
  /** 72h 以内の done（route.ts aixDone 互換フラグ） */
  recentDone: { vacancyCheck: boolean; mgmtCheck: boolean; propertySend: boolean; viewingInvite: boolean; meetingPlace: boolean };
  /** 「再度／改めて／追加で／別の物件」が使えるか（= 物件送付実績あり） */
  redoAllowed: boolean;
}

export interface ActionLedger {
  entries: LedgerEntry[];
  facts: LedgerFacts;
  /** ログ・tpo_debug 用の1行要約 */
  summary: string;
}

export type LedgerAixRow = {
  aix_type: string | null;
  check_pattern?: string | null;
  created_at: string | null;
  sent_at?: string | null;
  line_message_id?: string | null;
  generated_text?: string | null;
  property_names?: string[] | null;
  estimate_sent?: boolean | null;
  template_name?: string | null;
};
export type LedgerMessage = { sender: string; text: string; createdAt?: string; isAix?: boolean; lineMessageId?: string | null };
export type LedgerTask = {
  task_type: string; status: string; created_at?: string | null; completed_at?: string | null;
  /** 2026-09-10 Fable5 Sさん事例: property_check の確認結果（available / taken / second_position / move_out_planned）。
   *  NULL は「AIX 送信で機械的に閉じられただけ＝顧客に報告していない」ことを意味する */
  result?: string | null;
};
export interface LedgerInput {
  recentAixRows?: LedgerAixRow[];
  /** oldest-first（route.ts recentMessages と同じ並び） */
  messages: LedgerMessage[];
  lineTasks?: LedgerTask[];
  lastAixHistory?: string | null;
  lastCustomerAt?: string | null;
  now?: number;
  /** 送信時の記録（sent_facts）。一次証拠として本文の読み直しより優先する。メッセージの取得範囲より古い記録も台帳に入る（範囲外でも忘れない） */
  recordedFacts?: RecordedFact[];
}

// ─── 台帳固有の正規表現（往復文脈と共有する STAFF_* は reply-context.ts が定義・export する）──
/** 物件ラベル: 「🌟エストレーラ 305号室」「【エストレーラ 305号室】」 */
export const PROPERTY_LABEL_RE = /(?:🌟|【)\s*([^\n【】🌟]{2,40}?)\s*([0-9０-９]{1,4})\s*号室/g;
const MEDIA_ONLY_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/;
const CONFIRM_OBJECT_RE = /募集状況|空室|空き|内覧可能|入居可能日|割引|番手|管理会社|オーナー|退去|審査|交渉|ペット|駐車場|保証会社/;
/** 手打ち送付の成果物マーカー（物件 URL・複数号室）。countSentProperties（estimate-context）と同じ一次証拠を採る */
const STAFF_URL_SEND_RE = /https?:\/\//;

const AIX_KIND: Record<string, { kind: LedgerKind; status: LedgerStatus }> = {
  property_send: { kind: 'properties_sent', status: 'done' },
  property_recommendation: { kind: 'properties_sent', status: 'done' },
  property_send_new_arrival: { kind: 'properties_sent', status: 'done' },
  property_send_widen: { kind: 'properties_sent', status: 'done' },
  estimate_sheet: { kind: 'estimate_sent', status: 'done' },
  property_check_result: { kind: 'confirmation_reported', status: 'done' },
  acknowledge_check: { kind: 'confirmation_promised', status: 'promised' },
  viewing_invite: { kind: 'viewing_invited', status: 'done' },
  meeting_place: { kind: 'meeting_place_sent', status: 'done' },
  condition_hearing: { kind: 'condition_asked', status: 'done' },
  application_push: { kind: 'application_guided', status: 'done' },
  followup_revive: { kind: 'followup_sent', status: 'done' },
  zenryoku_support: { kind: 'followup_sent', status: 'done' },
  cost_explain: { kind: 'cost_explained', status: 'done' },
  cost_breakdown: { kind: 'cost_breakdown_explained', status: 'done' },
  phone_call: { kind: 'call_requested', status: 'done' },
  phone_followup: { kind: 'call_followup_sent', status: 'done' },
};
/** promised → それを履行する done */
const FULFILLS: Partial<Record<LedgerKind, LedgerKind>> = {
  pickup_declared: 'properties_sent',
  estimate_declared: 'estimate_sent',
  confirmation_promised: 'confirmation_reported',
};
export const LEDGER_KIND_JA: Record<LedgerKind, string> = {
  pickup_declared: '物件ピックアップ', properties_sent: '物件送付', estimate_declared: '見積書作成', estimate_sent: '御見積書送付',
  viewing_invited: '内覧打診', meeting_place_sent: '待ち合わせ案内', question_asked: 'お客様への質問',
  confirmation_promised: '募集状況等の確認', confirmation_reported: '確認結果の報告', condition_asked: '条件ヒアリング',
  application_guided: '申込打診', followup_sent: 'フォロー', media_sent: '画像送付（内容不明）',
  cost_explained: '初期費用の説明（仕組み・還元額）',
  cost_breakdown_explained: '初期費用の内訳の説明（御見積書）',
  call_requested: '電話をかけるボタンの送付（お客様からの電話待ち）',
  call_followup_sent: '電話後のまとめの送付',
};
/** ledger kind → 往復文脈 StaffTurnKind（'pickup_declared' は reply-context 側 union に追加済み。reply-context の LEDGER_KIND_TO_STAFF と同値） */
const LEDGER_TO_STAFF: Record<LedgerKind, StaffTurnKind> = {
  pickup_declared: 'pickup_declared', properties_sent: 'property_send', estimate_declared: 'estimate_promised', estimate_sent: 'estimate_send',
  viewing_invited: 'viewing_invite', meeting_place_sent: 'viewing_invite', question_asked: 'question_to_customer',
  confirmation_promised: 'confirmation_promise', confirmation_reported: 'check_result', condition_asked: 'condition_ask',
  application_guided: 'apply_push', followup_sent: 'other', media_sent: 'other', cost_explained: 'other', cost_breakdown_explained: 'other',
  call_requested: 'other', call_followup_sent: 'other',
};
const STAFF_TO_LEDGER: Partial<Record<StaffTurnKind, LedgerKind>> = {
  property_send: 'properties_sent', pickup_declared: 'pickup_declared', estimate_send: 'estimate_sent', estimate_promised: 'estimate_declared', viewing_invite: 'viewing_invited', check_result: 'confirmation_reported',
  confirmation_promise: 'confirmation_promised', condition_ask: 'condition_asked', apply_push: 'application_guided', question_to_customer: 'question_asked',
};

const MIN = 60 * 1000;
const AIX_ATTACH_WINDOW_MS = 3 * MIN;
const DEDUP_WINDOW_MS = 3 * MIN;
const TASK_DONE_GUARD_MS = 10 * MIN;
const RECENT_DONE_WINDOW_MS = 72 * 60 * MIN;
const TASK_DONE_STATUSES = new Set(['completed', 'resolved', 'done']);

function ms(iso: string | null | undefined): number { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : NaN; }
function near(a: number, b: number, w: number): boolean { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= w; }
function uniq(xs: string[]): string[] { return [...new Set(xs.map((s) => s.trim()).filter(Boolean))]; }

export function extractPropertyLabels(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(PROPERTY_LABEL_RE)) out.push(`${m[1].trim()} ${m[2]}号室`);
  return uniq(out);
}

// ─── 内覧の待ち合わせ（AIX 待ち合わせ場所の本文・スタッフ本文）───
//   AIX: 「9/14 12:00にメゾン加美北 305号室\n現地エントランスお待ち合わせで…」／スタッフ本文: 「本日12:00に昭和グランドハイツ恵美須現地エントランス前待ち合わせの程…」
const MEETING_WORD_RE = /待ち合わせ|現地(?:エントランス|集合)|集合場所/;
const MEETING_TIME_RE = /([0-9０-９]{1,2})\s*[:：]\s*([0-9０-９]{2})|([0-9０-９]{1,2})\s*時(?!間)(半|[0-9０-９]{1,2}分)?/;
const toHalf = (s: string) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
/** 本文から内覧の待ち合わせの日付・時刻・場所を取り出す（待ち合わせの語＋時刻が無ければ null） */
export function extractViewingAppointment(text: string | null | undefined, sentAt: string | null): ViewingAppointment | null {
  const t = toHalf(text ?? '');
  if (!MEETING_WORD_RE.test(t) || !MEETING_TIME_RE.test(t)) return null;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const mi = lines.findIndex((l) => MEETING_WORD_RE.test(l));
  // 待ち合わせの行と、その直前の行（「9/14 12:00にメゾン加美北 305号室」＋「現地エントランスお待ち合わせ」）
  const near2 = [lines[mi - 1] ?? '', lines[mi] ?? ''].join(' ');
  const scope = MEETING_TIME_RE.test(near2) ? near2 : t;
  // 時刻は待ち合わせの語の直前のもの（「9/9 15:00…リーダースパーク21から先にご案内…15:00にリーダースパーク21現地…」の2つ目）
  const meetIdx = scope.search(MEETING_WORD_RE);
  const allTimes = [...scope.matchAll(new RegExp(MEETING_TIME_RE.source, 'g'))];
  const tm = (allTimes.filter((x) => (x.index ?? 0) < meetIdx).at(-1) ?? allTimes[0]) as RegExpMatchArray;
  const min = tm[1] ? tm[2] : tm[4] === '半' ? '30' : tm[4] ? String(Number(tm[4].replace('分', ''))).padStart(2, '0') : '00';
  const time = `${Number(tm[1] ?? tm[3])}:${min}`;
  // 日付は待ち合わせの行を先に、無ければ1通全体から（「6/22（月）15:00よりご案内…」→「15:00にクラウンハイム夕陽丘現地…」）
  const dateScope = /([0-9]{1,2})\s*[\/月]\s*([0-9]{1,2})|本日|今日|明日|(?<![0-9\/月])[0-9]{1,2}\s*日(?!間)/.test(scope) ? scope : t;
  const md = dateScope.match(/([0-9]{1,2})\s*[\/月]\s*([0-9]{1,2})/);
  let dateMD: string | null = md ? `${Number(md[1])}/${Number(md[2])}` : null;
  if (!dateMD && Number.isFinite(Date.parse(sentAt ?? ''))) {
    const base = Date.parse(sentAt!);
    const dOnly = dateScope.match(/(?<![0-9\/月])([0-9]{1,2})\s*日(?!間)/);
    if (/本日|今日/.test(dateScope)) { const p = jstParts(base); dateMD = `${p.m}/${p.d}`; }
    else if (/明後日/.test(dateScope)) { const p = jstParts(base + 2 * 86_400_000); dateMD = `${p.m}/${p.d}`; }
    else if (/明日/.test(dateScope)) { const p = jstParts(base + 86_400_000); dateMD = `${p.m}/${p.d}`; }
    else if (dOnly) {
      // 「10日12時半に」: 月は案内した日から（案内日より前の日なら翌月）
      const p = jstParts(base); const d = Number(dOnly[1]);
      const m = d >= p.d ? p.m : p.m === 12 ? 1 : p.m + 1;
      if (d >= 1 && d <= 31) dateMD = `${m}/${d}`;
    }
  }
  // 場所: 時刻の後ろ「に〇〇」〜「現地／待ち合わせ／エントランス」の前（無ければ待ち合わせの行）
  const after = scope.slice((tm.index ?? 0) + tm[0].length).replace(/^\s*(?:分|半)?\s*(?:より|から|〜|~)?\s*に?\s*/, '');
  //   「11:50分に現地エントランス前」のように場所を書いていない時は null（行全体を場所にしない）
  const place = (after.split(/現地|待ち合わせ|お待ち合わせ|エントランス|集合|住所|〒/)[0] ?? '').replace(/[、。！!\s]+$/g, '').trim().slice(0, 40) || null;
  return { dateMD, time, place };
}

/** スタッフ本文1通 → 台帳エントリ（本文 regex＝confidence 1）。時制で promised / done を分ける */
export function classifyStaffTextForLedger(text: string, at: string | null): LedgerEntry | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const base = (kind: LedgerKind, status: LedgerStatus, evidence: string, detail: LedgerEntry['detail'] = {}): LedgerEntry =>
    ({ kind, status, at, source: 'staff_text', confidence: 1, evidence: evidence.slice(0, 40), detail });
  if (MEDIA_ONLY_RE.test(t)) return base('media_sent', 'done', t);
  const lastLine = t.split('\n').filter(Boolean).slice(-1)[0] ?? '';
  const isEstimate = STAFF_ESTIMATE_WORD_RE.test(t);
  // 実行（過去形・成果物）を先に判定。見積語があれば物件ではなく見積の送付（staffEstimateDelivered: 見積の文そのものの時制・成果物の印。ゆうこ事例）
  if (isEstimate && staffEstimateDelivered(t)) {
    return base('estimate_sent', 'done', t.match(STAFF_ESTIMATE_WORD_RE)![0], { estimateFor: extractPropertyLabels(t) });
  }
  // 内覧の待ち合わせの案内（手打ちで場所・時刻を変えた時も AIX 待ち合わせ場所と同じ事実）。内覧打診より先に見る
  //   日程の打診（「ご都合よろしいお日にち」「いかがでしょうか」＝まだ決まっていない）は含めない
  const appt = /ご都合|いかが|でしょうか|ございますか/.test(t) ? null : extractViewingAppointment(t, at);
  if (appt) return base('meeting_place_sent', 'done',`${appt.dateMD ?? ''} ${appt.time ?? ''} ${appt.place ?? ''}`.trim(), { appointment: appt });
  // 2026-09-14: 文ごとに見る。物件を送った文（見積の語が無い文に完了形・URL）があれば物件送付。
  //   見積書の約束は条件なしの文だけ（「お気に召されましたら…御見積書もお送りさせていただきます」は案内で約束ではない）
  //   旧: 1通に見積の語があると物件送付に数えず、「お送りさせていただきました（物件）＋お気に召されましたら御見積書も」を見積書の送付にしていた
  const sentences = t.split(/\n|(?<=[。！!？?])(?![。！!？?])/);
  const propsDone = !STAFF_NON_PROPERTY_RE.test(t)
    && sentences.some((s) => (STAFF_PROPERTIES_DONE_RE.test(s) || STAFF_URL_SEND_RE.test(s)) && !STAFF_ESTIMATE_WORD_RE.test(s));
  const estDecl = sentences.find((s) => STAFF_ESTIMATE_DECL_RE.test(s) && !/お気に召され|ございましたら|ございますれば|でしたら|あれば|(?:頂|いただ)けましたら/.test(s));
  if (estDecl && !propsDone) return base('estimate_declared', 'promised', estDecl.match(STAFF_ESTIMATE_DECL_RE)![0], { estimateFor: extractPropertyLabels(t) });
  if (propsDone || (!isEstimate && !STAFF_NON_PROPERTY_RE.test(t) && (STAFF_PROPERTIES_DONE_RE.test(t) || STAFF_URL_SEND_RE.test(t)))) {
    const names = extractPropertyLabels(t);
    const ev = t.match(STAFF_PROPERTIES_DONE_RE)?.[0] ?? t.match(STAFF_URL_SEND_RE)![0];
    return base('properties_sent', 'done', ev, { propertyNames: names, propertyCount: Math.max(1, names.length) });
  }
  if (STAFF_VIEWING_INVITE_RE.test(t)) return base('viewing_invited', 'done', t.match(STAFF_VIEWING_INVITE_RE)![0]);
  if (STAFF_APPLY_PUSH_RE.test(t)) return base('application_guided', 'done', t.match(STAFF_APPLY_PUSH_RE)![0]);
  if (STAFF_CONDITION_ASK_RE.test(t)) return base('condition_asked', 'done', t.match(STAFF_CONDITION_ASK_RE)![0]);
  if (STAFF_CONFIRM_REPORT_RE.test(t)) return base('confirmation_reported', 'done', t.match(STAFF_CONFIRM_REPORT_RE)![0], { object: t.match(CONFIRM_OBJECT_RE)?.[0] ?? null });
  // 宣言（未来形）。ピックアップ宣言は確認約束より先（「ピックアップ出来次第お送り」を確認約束にしない）
  if (STAFF_PICKUP_DECL_RE.test(t)) return base('pickup_declared', 'promised', t.match(STAFF_PICKUP_DECL_RE)![0]);
  if (STAFF_CONFIRM_DECL_RE.test(t)) return base('confirmation_promised', 'promised', t.match(STAFF_CONFIRM_DECL_RE)![0], { object: t.match(CONFIRM_OBJECT_RE)?.[0] ?? null });
  if (STAFF_QUESTION_RE.test(lastLine)) return base('question_asked', 'done', lastLine.slice(-30));
  return null;
}

/**
 * スタッフ本文1通 → 台帳エントリの配列（1通に複数の行為があれば全部）。先頭が主な行為（classifyStaffTextForLedger と同じ）。
 * 2026-09-14 竹内（ゆうこ事例）: 1通に「お支払いの説明＋御見積書を作成しお送り（約束）＋お部屋ピックアップさせて頂きます（約束）」があっても
 *   1つの種類しか記録されず、ピックアップの約束が消えていた。見積書の約束・待ち合わせ・ピックアップの約束・確認の約束は、主な行為と別でも記録する。
 * 送信時の記録（sent_facts・send-line-message）と、記録の無い古いメッセージの読み直し（buildActionLedger ②）が同じ関数
 */
export function classifyStaffTextFacts(text: string, at: string | null): LedgerEntry[] {
  const primary = classifyStaffTextForLedger(text, at);
  if (!primary) return [];
  const out: LedgerEntry[] = [primary];
  if (primary.kind === 'media_sent') return out;
  const t = (text ?? '').trim();
  const has = (...ks: LedgerKind[]) => out.some((e) => ks.includes(e.kind));
  const add = (kind: LedgerKind, status: LedgerStatus, evidence: string, detail: LedgerEntry['detail'] = {}) =>
    out.push({ kind, status, at, source: 'staff_text', confidence: 1, evidence: evidence.slice(0, 40), detail });
  const sentences = t.split(/\n|(?<=[。！!？?])(?![。！!？?])/);
  if (!has('estimate_sent', 'estimate_declared')) {
    const s = sentences.find((x) => STAFF_ESTIMATE_DECL_RE.test(x) && !/お気に召され|ございましたら|ございますれば|でしたら|あれば|(?:頂|いただ)けましたら/.test(x));
    if (s) add('estimate_declared', 'promised', s.match(STAFF_ESTIMATE_DECL_RE)![0], { estimateFor: extractPropertyLabels(t) });
  }
  if (!has('meeting_place_sent') && !/ご都合|いかが|でしょうか|ございますか/.test(t)) {
    const appt = extractViewingAppointment(t, at);
    if (appt) add('meeting_place_sent', 'done', `${appt.dateMD ?? ''} ${appt.time ?? ''} ${appt.place ?? ''}`.trim(), { appointment: appt });
  }
  if (!has('pickup_declared', 'properties_sent', 'condition_asked') && STAFF_PICKUP_DECL_RE.test(t) && !STAFF_CONDITION_ASK_RE.test(t)) {
    add('pickup_declared', 'promised', t.match(STAFF_PICKUP_DECL_RE)![0]);
  }
  if (!has('confirmation_promised', 'confirmation_reported') && STAFF_CONFIRM_DECL_RE.test(t) && !STAFF_PICKUP_DECL_RE.test(t)) {
    add('confirmation_promised', 'promised', t.match(STAFF_CONFIRM_DECL_RE)![0], { object: t.match(CONFIRM_OBJECT_RE)?.[0] ?? null });
  }
  return out;
}

/** AIX 待ち合わせ場所の画面入力（「9/14（月）」「12:00〜14:00」）→ 待ち合わせ（送信時の記録 sent_facts・内覧の記録） */
export function appointmentFromMeetingInput(m: { date?: string | null; time?: string | null; propertyName?: string | null } | null | undefined): ViewingAppointment | null {
  if (!m?.date) return null;
  const md = m.date.normalize('NFKC').match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (!md) return null;
  const tm = (m.time ?? '').normalize('NFKC').match(/(\d{1,2})\s*[:：時]\s*(\d{2})?/);
  return { dateMD: `${Number(md[1])}/${Number(md[2])}`, time: tm ? `${Number(tm[1])}:${tm[2] ?? '00'}` : null, place: (m.propertyName ?? '').trim() || null };
}

/** M/D → YYYY-MM-DD（日本時間。送った日から見て半年以上前の月なら翌年＝12月に 1/5 の案内） */
export function appointmentYmd(dateMD: string, sentAt: string): string | null {
  const [m, d] = dateMD.split('/').map(Number);
  if (!m || !d) return null;
  const p = jstParts(Number.isFinite(Date.parse(sentAt)) ? sentAt : Date.now());
  const y = m < p.m - 6 ? p.y + 1 : m > p.m + 6 ? p.y - 1 : p.y;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** AIX の種類 → 台帳の行為（log-aix-usage が送信時の記録 sent_facts を書く時と、台帳 ① が同じ対応表） */
export function aixLedgerKind(aixType: string | null | undefined): { kind: LedgerKind; status: LedgerStatus } | null {
  return aixType ? AIX_KIND[aixType] ?? null : null;
}

/**
 * AIX の本文に書き足された「これからやる約束」（ピックアップ・見積書・確認）。その AIX 自身が届けた物の約束は除く。
 * 2026-09-15 竹内（ゆうこ事例）: AIX【初期費用について】の末尾に「南向き・5階以上・御堂筋線沿線のご条件でも改めてオススメできるお部屋
 *   ピックアップさせて頂きます！！」と書き足して送った → 送信時の記録は「初期費用の説明」だけで約束が残らず、ブレインは約束の履行
 *   （AIX【物件ピックアップした】）と判定できなかった（一覧に AIX が出ない）。AIX の本文も手打ちと同じ分類で約束を読む
 */
export function aixTextPromises(aixType: string | null | undefined, text: string | null | undefined, at: string | null, opts: { estimateEnclosed?: boolean } = {}): LedgerEntry[] {
  const t = (text ?? '').trim();
  if (!t) return [];
  const self = aixLedgerKind(aixType)?.kind ?? null;
  return classifyStaffTextFacts(t, at).filter((e) => e.status === 'promised'
    && (e.kind === 'pickup_declared' || e.kind === 'estimate_declared' || e.kind === 'confirmation_promised')
    && !(e.kind === 'pickup_declared' && self === 'properties_sent')
    && !(e.kind === 'estimate_declared' && (self === 'estimate_sent' || opts.estimateEnclosed === true))
    && !(e.kind === 'confirmation_promised' && (self === 'confirmation_reported' || self === 'confirmation_promised')));
}

/**
 * 送信時の記録（sent_facts）の1行。送った時に1回だけ書く（2026-09-14 竹内「自分が送った内容を記憶して次の解析に引き継ぐ」）。
 *   origin=aix: log-aix-usage（AIX の種類・画面入力の待ち合わせの日時・物件・見積の同封）／origin=staff_text: send-line-message（手打ちの本文を classifyStaffTextFacts で1回分類）
 */
export type RecordedFact = {
  sent_at: string;
  origin: 'aix' | 'staff_text';
  aix_type?: string | null;
  kind: string;
  status: string;
  line_message_id?: string | null;
  detail?: LedgerEntry['detail'] | null;
  evidence?: string | null;
};
const LEDGER_KINDS = new Set<string>(['pickup_declared', 'properties_sent', 'estimate_declared', 'estimate_sent', 'viewing_invited', 'meeting_place_sent', 'question_asked',
  'confirmation_promised', 'confirmation_reported', 'condition_asked', 'application_guided', 'followup_sent', 'media_sent', 'cost_explained', 'cost_breakdown_explained',
  'call_requested', 'call_followup_sent']);
function entryFromRecorded(f: RecordedFact): LedgerEntry | null {
  if (!LEDGER_KINDS.has(f.kind) || (f.status !== 'done' && f.status !== 'promised')) return null;
  return {
    kind: f.kind as LedgerKind, status: f.status as LedgerStatus, at: f.sent_at,
    // 送信時の記録: AIX は aix_log（conf3）、手打ちは本文（送った時に1回分類して保存＝conf2）
    source: f.origin === 'aix' ? 'aix_log' : 'staff_text', confidence: f.origin === 'aix' ? 3 : 2,
    evidence: (f.evidence ?? `${f.origin}:${f.aix_type ?? f.kind}`).slice(0, 40), detail: { ...(f.detail ?? {}) },
  };
}

/** ブレインに渡す台帳の行（中身つき・新しい順に最大 max 件）。ブレインには物件名も渡す（返信生成の台帳注記は物件名を書かない＝竹内方針2） */
export function buildLedgerLinesForBrain(ledger: ActionLedger, max = 8): string {
  const rows = ledger.entries.filter((e) => e.kind !== 'media_sent').slice(-max);
  if (rows.length === 0) return '';
  const src = (e: LedgerEntry) => e.source === 'aix_log' ? 'AIX' : e.source === 'staff_text' ? (e.confidence >= 2 ? '手打ち・送信時の記録' : '手打ち') : e.source === 'line_task' ? 'やること' : '履歴';
  const det = (e: LedgerEntry) => {
    const d = e.detail ?? {};
    if (e.kind === 'meeting_place_sent' && d.appointment) return `${d.appointment.dateMD ?? '?'} ${d.appointment.time ?? ''} ${d.appointment.place ?? ''}`.trim();
    if (e.kind === 'properties_sent') return `${d.propertyCount ?? 1}件${d.propertyNames?.length ? `: ${d.propertyNames.slice(0, 3).join('・')}` : ''}`;
    if ((e.kind === 'estimate_sent' || e.kind === 'estimate_declared') && d.estimateFor?.length) return d.estimateFor.slice(0, 3).join('・');
    if (d.checkPattern) return `結果=${d.checkPattern}`;
    if (d.object) return `対象=${d.object}`;
    return '';
  };
  const lines = rows.map((e) => {
    const what = e.status === 'promised' ? `${LEDGER_KIND_JA[e.kind]}を宣言（${e.fulfilledBy == null ? 'まだ履行していない' : '履行済み'}）` : `${LEDGER_KIND_JA[e.kind]}を実行`;
    const d = det(e);
    return `・${fmtJst(e.at)} ${what}${d ? `（${d}）` : ''}［${src(e)}］`;
  });
  return `\n【こちらが送ったこと・約束したこと（行動台帳・古→新・確定事実）】\n${lines.join('\n')}`;
}

/** 直前スタッフ発言に対応する台帳エントリを選ぶ。
 *  2026-09-10 Fable5 Sさん事例: AIX 送信は page.tsx → line-tasks/complete により、その会話の全 pending タスクを
 *  直後に completed にするため `line_tasks.completed_at > aix.sent_at` が **構造上 常に成立**する
 *  （差は数百ms〜数秒＝必ず ±3分窓内）。旧実装は「at が後」というだけで conf2 の記帳行を採用し、
 *  AIX 自身を別の行動で上書きしていた（Sさん事例は 0.898 秒差で敗北）。さらに完全同時刻でも
 *  ⑤ の confidence 降順 → stable sort → .reverse() で低信頼が勝つ逆向きだった。
 *  優先順位: ①顧客に送られた証拠か ②confidence ③実発言時刻への近さ ④at（安定化） */
function pickLastStaffEntry(merged: LedgerEntry[], lastStaffAt: number): LedgerEntry | null {
  const win = merged.filter((e) => near(ms(e.at), lastStaffAt, AIX_ATTACH_WINDOW_MS));
  if (win.length === 0) return null;
  const rank = (e: LedgerEntry): number[] => [
    LEDGER_OUTBOUND_SOURCES.has(e.source) ? 1 : 0,
    e.confidence,
    -Math.abs(ms(e.at) - lastStaffAt),
    ms(e.at) || 0,
  ];
  return [...win].sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0] ?? null;
}

export function buildActionLedger(input: LedgerInput): ActionLedger {
  const now = input.now ?? Date.now();
  const msgs = input.messages ?? [];
  const aixRows = (input.recentAixRows ?? []).filter((r) => !!r.aix_type);
  const entries: LedgerEntry[] = [];
  // 送信時の記録（sent_facts）: 使ったものに印を付け、最後に残りを足す（取得範囲より古い送信も忘れない）
  const recorded = (input.recordedFacts ?? []).map((f) => ({ f, used: false }));
  const recordedAixNear = (aixType: string, at: number) => recorded.filter((x) => x.f.origin === 'aix' && x.f.aix_type === aixType && near(ms(x.f.sent_at), at, AIX_ATTACH_WINDOW_MS));

  // ① aix_usage_logs（confidence 3）— 実行の一次証拠。sent_at > created_at
  for (const r of aixRows) {
    const map = AIX_KIND[r.aix_type as string];
    if (!map) continue;
    const at = r.sent_at ?? r.created_at ?? null;
    const names = uniq([...(r.property_names ?? []), ...extractPropertyLabels(r.generated_text)]);
    const e: LedgerEntry = {
      kind: map.kind, status: map.status, at, source: 'aix_log', confidence: 3,
      evidence: `${r.aix_type}${r.check_pattern ? '/' + r.check_pattern : ''}@${at ?? '?'}`,
      detail: { checkPattern: r.check_pattern ?? null },
    };
    if (map.kind === 'properties_sent') { e.detail.propertyNames = names; e.detail.propertyCount = Math.max(1, names.length); }
    if (map.kind === 'estimate_sent') e.detail.estimateFor = names;
    if (map.kind === 'meeting_place_sent') e.detail.appointment = extractViewingAppointment(r.generated_text, at);
    // 送信時の記録があれば中身（画面で入力した待ち合わせの日時・物件 等）はそちらを正にする
    for (const x of recordedAixNear(r.aix_type as string, ms(at))) {
      // AIX 本文に書き足した約束（aixTextPromises）はこの AIX の行とは別の行として ②' で入れる（2026-09-15 ゆうこ事例: ここで使用済みにして捨てていた）
      if (x.f.kind !== map.kind && !(x.f.kind === 'estimate_sent' && r.estimate_sent === true)) continue;
      x.used = true;
      if (x.f.kind === map.kind && x.f.detail) e.detail = { ...e.detail, ...x.f.detail };
    }
    entries.push(e);
    // estimate_sent=true の別 aix_type（property_check_result 等に見積添付）→ estimate_sent も立てる
    if (map.kind !== 'estimate_sent' && r.estimate_sent === true) {
      entries.push({ kind: 'estimate_sent', status: 'done', at, source: 'aix_log', confidence: 3, evidence: `estimate_sent@${r.aix_type}`, detail: { estimateFor: names } });
    }
  }

  // ② スタッフ本文（confidence 1）— aix 行 ±3分 or line_message_id 一致の発言は regex を当てない（AIX 本文の誤カウント防止）
  //    時刻の無いメッセージ（check-reply 経路）は AIX 行が1件でもあれば「送付系」を本文から採らない（AIX ログと二重計上しない）
  const aixTimes = aixRows.map((r) => ms(r.sent_at ?? r.created_at));
  const aixIds = new Set(aixRows.map((r) => r.line_message_id).filter(Boolean));
  const staffEntryByMsgIdx = new Map<number, LedgerEntry>();
  msgs.forEach((m, i) => {
    if (m.sender !== 'staff') return;
    const t = ms(m.createdAt);
    const coveredByAix = (m.lineMessageId && aixIds.has(m.lineMessageId)) || aixTimes.some((a) => near(a, t, AIX_ATTACH_WINDOW_MS));
    if (coveredByAix) return;
    // 送信時の記録（この発言を送った時に1回分類して保存したもの）があればそれを使う。無ければ本文を読み直す（記録前の古いメッセージ）
    //   画像だけの行（本文の1秒前に保存される）には当てない。line_message_id の一致を優先し、無ければ送信時刻 ±2分
    const isMedia = MEDIA_ONLY_RE.test((m.text ?? '').trim());
    const byId = m.lineMessageId ? recorded.filter((x) => x.f.origin === 'staff_text' && !x.used && x.f.line_message_id === m.lineMessageId) : [];
    const rec = isMedia ? [] : byId.length > 0 ? byId
      : recorded.filter((x) => x.f.origin === 'staff_text' && !x.used && !x.f.line_message_id && near(ms(x.f.sent_at), t, 2 * MIN));
    if (rec.length > 0) {
      const recEntries = rec.map((x) => { x.used = true; return entryFromRecorded(x.f); }).filter((e): e is LedgerEntry => !!e);
      if (recEntries.length > 0) {
        // 時刻は実際の発言の時刻に揃える（直前スタッフ発言の対応づけ ±3分）
        for (const re of recEntries) { if (m.createdAt) re.at = m.createdAt; entries.push(re); }
        staffEntryByMsgIdx.set(i, recEntries[0]);
        return;
      }
    }
    const facts = classifyStaffTextFacts(m.text ?? '', m.createdAt ?? null);
    const e = facts[0];
    if (!e) return;
    if (!Number.isFinite(t) && aixRows.length > 0 && (e.kind === 'properties_sent' || e.kind === 'estimate_sent')) return;
    // [画像] 単独は隣接（±3分）のスタッフ本文エントリに吸収。孤立画像は media_sent（件数に数えない）
    if (e.kind === 'media_sent') {
      const sib = [...staffEntryByMsgIdx.values()].find((s) => near(ms(s.at), t, AIX_ATTACH_WINDOW_MS));
      if (sib) return;
    }
    staffEntryByMsgIdx.set(i, e);
    entries.push(e);
    // 1通に複数の行為（見積書の約束＋ピックアップの約束 等）があれば残りも記録する
    for (const extra of facts.slice(1)) entries.push(extra);
  });

  // ②' 送信時の記録で、上のメッセージに対応しなかったもの（取得範囲より古い送信・画面の保存に失敗した送信）も台帳に入れる
  for (const x of recorded) {
    if (x.used) continue;
    const e = entryFromRecorded(x.f);
    if (e) entries.push(e);
  }

  // ③ line_tasks（confidence 2）— 宣言(pending)／履行(completed) の状態機械。completed property_send は「ご査収」キーワード由来なので見積送付 ±10分は除外
  for (const task of input.lineTasks ?? []) {
    const status = task.status;
    const isDone = TASK_DONE_STATUSES.has(status);
    if (task.task_type === 'property_send') {
      if (status === 'pending') entries.push({ kind: 'pickup_declared', status: 'promised', at: task.created_at ?? null, source: 'line_task', confidence: 2, evidence: 'line_tasks.property_send=pending', detail: { taskStatus: status } });
      else if (isDone && task.completed_at) {
        // 2026-09-11 統合設計（経路E3・みく/Aoi 事例）: AIX 送信は会話の pending タスクを全て閉じるため、condition_hearing /
        //   property_check_result / zenryoku_support で機械的に閉じられた property_send まで「物件送付」になっていた（偽送付→送付件数の水増し・
        //   ピックアップ約束の偽の履行）。近くに物件系 AIX または本文の物件送付がある時だけ記帳する（property_check result=NULL と同じ原則）
        const tc = ms(task.completed_at);
        const nearEstimate = entries.some((e) => e.kind === 'estimate_sent' && near(ms(e.at), tc, TASK_DONE_GUARD_MS));
        const nearPropertyExec =
          aixRows.some((r) => AIX_KIND[r.aix_type as string]?.kind === 'properties_sent' && near(ms(r.sent_at ?? r.created_at), tc, TASK_DONE_GUARD_MS)) ||
          entries.some((e) => e.kind === 'properties_sent' && e.source === 'staff_text' && near(ms(e.at), tc, TASK_DONE_GUARD_MS));
        if (!nearEstimate && nearPropertyExec) entries.push({ kind: 'properties_sent', status: 'done', at: task.completed_at, source: 'line_task', confidence: 2, evidence: `line_tasks.property_send=${status}`, detail: { propertyCount: 1, propertyNames: [], taskStatus: status } });
      }
    } else if (task.task_type === 'estimate_sheet' && isDone) {
      entries.push({ kind: 'estimate_sent', status: 'done', at: task.completed_at ?? task.created_at ?? null, source: 'line_task', confidence: 2, evidence: `line_tasks.estimate_sheet=${status}`, detail: { estimateFor: [], taskStatus: status } });
    } else if (task.task_type === 'property_check') {
      if (status === 'pending') entries.push({ kind: 'confirmation_promised', status: 'promised', at: task.created_at ?? null, source: 'line_task', confidence: 2, evidence: 'line_tasks.property_check=pending', detail: { object: '募集状況', taskStatus: status } });
      // 2026-09-10 Fable5 Sさん事例: 「顧客へ報告した」と言えるのは result（available/taken/second_position/
      //   move_out_planned）が入っている時だけ。AIX 送信が機械的に閉じた result=NULL 行は報告ではない。
      //   isDone && !task.result → 台帳に何も立てない（偽の直前発言を作らない）
      else if (isDone && task.result) entries.push({ kind: 'confirmation_reported', status: 'done', at: task.completed_at ?? null, source: 'line_task', confidence: 2, evidence: `line_tasks.property_check=${status}/result=${task.result}`, detail: { object: '募集状況', checkPattern: task.result, taskStatus: status } });
    }
  }

  // ④ brain last_aix_history（confidence 2・時刻なし）— aix 行もスタッフ本文も無い時だけの最終フォールバック（「最新:」のみ）
  if (aixRows.length === 0 && !msgs.some((m) => m.sender === 'staff' && (m.text ?? '').trim())) {
    const m = /最新:([a-z_]+)/.exec(input.lastAixHistory ?? '');
    const map = m ? AIX_KIND[m[1]] : undefined;
    if (m && map) entries.push({ kind: map.kind, status: map.status, at: null, source: 'aix_history', confidence: 2, evidence: m[0], detail: {} });
  }

  // ⑤ 重複除去: 同 kind+status で ±3分 → 高信頼を残し propertyNames は和集合
  //   2026-09-11 統合設計（経路E4・楓馬事例）: 顧客への送信証拠（LEDGER_OUTBOUND_SOURCES）を優先して残す。旧実装は confidence 降順のみで、
  //   手打ち宣言（staff_text, conf1）の約1秒後に webhook が作る line_task pending（conf2）が勝ち、送信の証拠が消えていた
  const rank = (e: LedgerEntry) => (LEDGER_OUTBOUND_SOURCES.has(e.source) ? 10 : 0) + e.confidence;
  const merged: LedgerEntry[] = [];
  for (const e of [...entries].sort((a, b) => rank(b) - rank(a))) {
    const dup = merged.find((x) => x.kind === e.kind && x.status === e.status && (x.at === e.at || near(ms(x.at), ms(e.at), DEDUP_WINDOW_MS)));
    if (dup) {
      dup.confidence = Math.max(dup.confidence, e.confidence) as 3 | 2 | 1;
      dup.detail.propertyNames = uniq([...(dup.detail.propertyNames ?? []), ...(e.detail.propertyNames ?? [])]);
      if (dup.detail.propertyNames.length) dup.detail.propertyCount = Math.max(dup.detail.propertyCount ?? 0, dup.detail.propertyNames.length);
      dup.detail.estimateFor = uniq([...(dup.detail.estimateFor ?? []), ...(e.detail.estimateFor ?? [])]);
      continue;
    }
    merged.push({ ...e, detail: { ...e.detail } });
  }
  merged.sort((a, b) => (ms(a.at) || Infinity) - (ms(b.at) || Infinity));

  // ⑥ 履行リンク: promised の後に同系 done があれば fulfilledBy
  merged.forEach((p, i) => {
    if (p.status !== 'promised') return;
    const doneKind = FULFILLS[p.kind];
    if (!doneKind) return;
    const j = merged.findIndex((d, k) => k > i && d.status === 'done' && d.kind === doneKind);
    p.fulfilledBy = j >= 0 ? j : null;
  });

  // ⑦ 顧客反応: done/promised 直後（次のスタッフ発言より前）の最初の顧客メッセージを classifyCustomerResponse
  for (const e of merged) {
    const t = ms(e.at);
    if (!Number.isFinite(t)) continue;
    const idx = msgs.findIndex((m) => m.sender === 'customer' && ms(m.createdAt) > t);
    if (idx < 0) { e.customerReactionAfter = 'none'; continue; }
    const staffBetween = msgs.slice(0, idx).some((m) => m.sender === 'staff' && ms(m.createdAt) > t + AIX_ATTACH_WINDOW_MS);
    if (staffBetween) { e.customerReactionAfter = 'none'; continue; }
    const staffTurn: StaffTurn = { kind: staffKindOf(e) ?? 'other', source: 'ledger', evidence: e.evidence };
    const sub = analyzeSubstance(msgs[idx].text ?? '', undefined, { staffAskedQuestion: e.kind === 'question_asked' });
    e.customerReactionAfter = classifyCustomerResponse(sub, staffTurn).kind;
  }

  // ⑧ facts
  const sentDone = merged.filter((e) => e.kind === 'properties_sent' && e.status === 'done');
  const custAt = ms(input.lastCustomerAt);
  const lastStaffMsg = [...msgs].reverse().find((m) => m.sender === 'staff' && (m.text ?? '').trim() && !MEDIA_ONLY_RE.test(m.text ?? ''));
  const lastStaffAt = ms(lastStaffMsg?.createdAt);
  const lastStaffEntry = Number.isFinite(lastStaffAt)
    ? pickLastStaffEntry(merged, lastStaffAt)
    : [...merged].reverse().find((e) => e.source === 'aix_history') ?? null;
  const promises = merged.filter((e) => e.status === 'promised');
  const unfulfilled = (k: LedgerKind) => promises.filter((p) => p.kind === k && p.fulfilledBy == null);
  const pickupOpen = unfulfilled('pickup_declared');
  const estimateOpen = unfulfilled('estimate_declared');
  const confirmOpen = unfulfilled('confirmation_promised');
  const reports = merged.filter((e) => e.kind === 'confirmation_reported');
  const recent = merged.filter((e) => e.status === 'done' && Number.isFinite(ms(e.at)) && now - ms(e.at) <= RECENT_DONE_WINDOW_MS);
  const lastDone = [...merged].reverse().find((e) => e.status === 'done' && e.kind !== 'media_sent') ?? null;
  const lastPromised = [...promises].reverse()[0] ?? null;
  // 最後に案内した内覧の待ち合わせ（今日以降の分だけ。日付が読めない時は案内から48時間以内）
  const lastMeeting = [...merged].reverse().find((e) => e.kind === 'meeting_place_sent' && e.detail.appointment) ?? null;
  const viewingAppointment = ((): LedgerFacts['viewingAppointment'] => {
    const a = lastMeeting?.detail.appointment;
    if (!lastMeeting || !a) return null;
    const today = jstDayStartMs(now);
    if (a.dateMD) {
      const [m, d] = a.dateMD.split('/').map(Number);
      const p = jstParts(now);
      // 年またぎ: 12月に 1/5 → 翌年
      const y = m < p.m - 6 ? p.y + 1 : m > p.m + 6 ? p.y - 1 : p.y;
      const day = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000;
      if (day < today) return null;
      return { ...a, day: day === today ? 'today' : day === today + 86_400_000 ? 'tomorrow' : 'later', sentAt: lastMeeting.at };
    }
    return now - ms(lastMeeting.at) <= 48 * 3600 * 1000 ? { ...a, day: 'unknown', sentAt: lastMeeting.at } : null;
  })();
  const facts: LedgerFacts = {
    viewingAppointment,
    propertiesSentCount: sentDone.reduce((n, e) => n + (e.detail.propertyCount ?? 1), 0),
    propertiesSentNames: uniq(sentDone.flatMap((e) => e.detail.propertyNames ?? [])),
    lastPropertiesSentAt: sentDone.at(-1)?.at ?? null,
    propertiesSentSinceCustomerLatest: Number.isFinite(custAt) && sentDone.some((e) => ms(e.at) >= custAt),
    estimateSent: merged.some((e) => e.kind === 'estimate_sent'),
    estimateSentFor: uniq(merged.filter((e) => e.kind === 'estimate_sent').flatMap((e) => e.detail.estimateFor ?? [])),
    pickupPromisedUnfulfilled: pickupOpen.length > 0,
    pickupPromisedAt: pickupOpen.at(-1)?.at ?? null,
    pickupPromisedCount: pickupOpen.length,
    estimatePromisedUnfulfilled: estimateOpen.length > 0,
    confirmationPromisedUnfulfilled: confirmOpen.length > 0,
    confirmationPromisedObject: confirmOpen.at(-1)?.detail.object ?? null,
    confirmationReported: reports.length > 0,
    confirmationReportPattern: reports.at(-1)?.detail.checkPattern ?? null,
    viewingInvited: merged.some((e) => e.kind === 'viewing_invited'),
    meetingPlaceSent: merged.some((e) => e.kind === 'meeting_place_sent'),
    applicationGuided: merged.some((e) => e.kind === 'application_guided'),
    conditionAsked: merged.some((e) => e.kind === 'condition_asked'),
    lastDoneKind: lastDone?.kind ?? null,
    lastDoneAt: lastDone?.at ?? null,
    lastPromisedKind: lastPromised?.kind ?? null,
    lastPromisedAt: lastPromised?.at ?? null,
    lastStaffEntry,
    // 同じ送信（最後のスタッフ発言の前後3分）に記録した AIX 本文の約束で、まだ履行していない物。
    //   AIX の行の時刻は AIX 記録の作成時刻（送信の1〜2秒後）のこともあるので、行の前後ではなく発言の時刻で見る
    lastStaffAixTextPromise: lastStaffEntry && lastStaffEntry.source === 'aix_log' && lastStaffEntry.status === 'done' && Number.isFinite(lastStaffAt)
      ? promises.find((p) => p.source === 'aix_log' && p.fulfilledBy == null && near(ms(p.at), lastStaffAt, AIX_ATTACH_WINDOW_MS)) ?? null
      : null,
    recentDone: {
      vacancyCheck: recent.some((e) => e.kind === 'confirmation_reported'),
      mgmtCheck: recent.some((e) => (e.detail.checkPattern ?? '').startsWith('mgmt_')),
      propertySend: recent.some((e) => e.kind === 'properties_sent'),
      viewingInvite: recent.some((e) => e.kind === 'viewing_invited'),
      meetingPlace: recent.some((e) => e.kind === 'meeting_place_sent'),
    },
    redoAllowed: sentDone.length > 0,
  };
  // 2026-09-11 竹内方針2（E3-e）: summary は {ledger} 経由で生成プロンプトに入るので物件名を含めない（件数だけ）。
  //   物件名（propertiesSentNames）は照合用の事実として facts に残す（前向き反応の指名照合・CONFIRM の対象照合）
  const summary =
    `物件送付${facts.propertiesSentCount}件` +
    // 見積書を送ったかの一次証拠は AIX 見積書送る（aix_log）。本文だけの時は（本文）と分ける。約束だけで未送付も書く（ゆうこ事例）
    `／見積${facts.estimateSent ? `送付済(${merged.some((e) => e.kind === 'estimate_sent' && e.source === 'aix_log') ? 'AIX' : '本文'})` : facts.estimatePromisedUnfulfilled ? '約束済み・未送付' : '未'}` +
    `／ピックアップ約束${facts.pickupPromisedUnfulfilled ? `未履行×${facts.pickupPromisedCount}` : 'なし'}` +
    `／確認約束${facts.confirmationPromisedUnfulfilled ? '未履行' : facts.confirmationReported ? '報告済' : 'なし'}` +
    `／直前=${lastStaffEntry ? `${LEDGER_KIND_JA[lastStaffEntry.kind]}(${lastStaffEntry.status}/${lastStaffEntry.source})` : '不明'}` +
    (viewingAppointment ? `／内覧の待ち合わせ=${appointmentLabel(viewingAppointment)}` : '');
  return { entries: merged, facts, summary };
}

/** 内覧の待ち合わせの表示（生成プロンプトに入るので物件名＝場所は書かない・竹内方針2。場所は facts にだけ持つ） */
export function appointmentLabel(a: NonNullable<LedgerFacts['viewingAppointment']>): string {
  const day = a.day === 'today' ? '（本日）' : a.day === 'tomorrow' ? '（明日）' : '';
  return `${a.dateMD ?? ''} ${a.time ?? ''}${day} 現地待ち合わせ`.trim();
}

/** 直前スタッフ発言の往復文脈 kind（classifyLastStaffTurn の一次証拠。aix_log 行より先に見る） */
export function staffKindOf(e: LedgerEntry | null | undefined): StaffTurnKind | null {
  return e ? LEDGER_TO_STAFF[e.kind] : null;
}
export function ledgerKindOfStaffTurn(k: StaffTurnKind): LedgerKind | null { return STAFF_TO_LEDGER[k] ?? null; }

function fmtJst(iso: string | null): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '時刻不明';
  return jstMDHm(t);
}

/** dynamicBlock 注入用【📒 我々の行動台帳】（往復文脈ブロックの直前）。禁止語と代替表現をリテラルで渡す */
export function buildActionLedgerNote(ledger: ActionLedger, opts: { customerName?: string; maxEntries?: number } = {}): string {
  // 2026-09-11 統合設計（経路B）: 名前不明時に「〇〇さん」を書かない（呼びかけごと省く）
  const name = opts.customerName ? `${opts.customerName}さん` : '';
  const nameNi = name ? `${name}に` : '';
  const f = ledger.facts;
  const shown = ledger.entries.filter((e) => e.kind !== 'media_sent').slice(-(opts.maxEntries ?? 6));
  const lines: string[] = ['【📒 我々の行動台帳 — 確定事実（履歴の推測より上位・往復文脈の前提）】'];
  if (shown.length === 0) lines.push('これまでに我々がしたこと: 記録なし（物件0件・見積書未送付・約束なし）');
  else {
    lines.push('これまでに我々がしたこと（古→新）:');
    shown.forEach((e, i) => {
      const what = e.status === 'promised' ? `${LEDGER_KIND_JA[e.kind]}を**宣言**（未実行）` : `${LEDGER_KIND_JA[e.kind]}を**実行**`;
      // 2026-09-11 竹内方針2: 物件名は列挙しない（生成に物件名を持ち込む経路を断つ）
      const det = e.kind === 'properties_sent' ? `${e.detail.propertyCount ?? 1}件`
        : e.kind === 'estimate_sent' && e.detail.estimateFor?.length ? `${e.detail.estimateFor.length}件分`
        : e.detail.checkPattern ? `結果=${e.detail.checkPattern}` : e.detail.object ? `対象=${e.detail.object}` : '';
      const ful = e.status === 'promised' ? (e.fulfilledBy == null ? '→ まだ履行していない' : '→ 履行済み') : '';
      const react = e.customerReactionAfter && e.customerReactionAfter !== 'none' ? `／お客様の反応: ${e.customerReactionAfter}` : '';
      lines.push(`${['①', '②', '③', '④', '⑤', '⑥'][i] ?? i + 1} ${fmtJst(e.at)} ${what}${det ? `（${det}）` : ''}${ful}${react}`);
    });
  }
  lines.push(`確定: 物件はこれまで${f.propertiesSentCount === 0 ? '1件も送っていない' : `${f.propertiesSentCount}件送付済み`}。見積書は${f.estimateSent ? '送付済み' : f.estimatePromisedUnfulfilled ? '作成してお送りすると約束しただけで、まだ送っていない（AIX 見積書送るの記録なし）' : '未送付'}。${f.pickupPromisedUnfulfilled ? `ピックアップは${fmtJst(f.pickupPromisedAt)}に約束済みで未履行。` : ''}${f.confirmationPromisedUnfulfilled ? `「${f.confirmationPromisedObject ?? '確認'}」の確認を約束済みで未報告。` : ''}`);
  if (!f.redoAllowed) {
    lines.push('→ したがって「再度」「改めて」「もう一度」「追加で」「別の物件」「先ほどお送りした物件」「ご査収ください」は使えない（1件も送っていないため二度目は存在しない）。');
    lines.push(f.pickupPromisedUnfulfilled
      ? `→ 使える表現: 「${nameNi}オススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！」／条件が変わった場合は「（追加条件）に絞らせて頂き、…ピックアップさせて頂きます！！」（宣言は1文・条件列挙の全文再掲はしない）`
      : `→ 使える表現: 「${nameNi}オススメできるお部屋ピックアップしてお送りさせて頂きます！！」`);
  } else {
    // 2026-09-11 竹内方針2: 物件名は書かない（「先にお送りしたお部屋」で受ける）
    lines.push(`→ 送付済みのお部屋（${f.propertiesSentCount}件）は「先にお送りしたお部屋」として言及可（物件名・号室は書かない）。新条件なら「再度ピックアップしてお送り」可。送付済み物件を「これからお送りします」と未来形で再宣言しない。`);
  }
  if (f.estimateSent) lines.push('→ 御見積書は送付済み。「御見積書を作成しお送りします」の再宣言は禁止（金額変更依頼がある場合のみ「再作成」）。');
  else lines.push('→ 御見積書は未送付。「先ほどお送りした御見積書」「ご検討の程」は使えない。');
  if (f.recentDone.vacancyCheck || f.recentDone.mgmtCheck) lines.push(`→ 募集状況の確認は実行・報告済み（結果=${f.confirmationReportPattern ?? '報告済'}）。「確認します」の再宣言は禁止（新しい物件の提示がある場合のみ正当）。`);
  // 2026-09-14 竹内（名無しの権兵衛事例）: 内覧の約束は送った内容の中でも鮮度が高い。当日の「着きました」に新しい内覧日程を打診しない
  //   （文例はスタッフの実送信: 着いた→「まもなく到着いたします！！少々お待ちください」／遅れる→「かしこまりました！！お気をつけてお越しください」）
  if (f.viewingAppointment) {
    lines.push(`→ 内覧の待ち合わせを案内済み: ${appointmentLabel(f.viewingAppointment)}。この内覧は決まっている。新しい内覧日程の打診（「ご都合よろしいお日にち」「ご案内させて頂きます」）は書かない。` +
      (f.viewingAppointment.day === 'today' ? 'お客様の「着きました」「遅れます」「向かってます」はこの内覧の当日の連絡（着いた→「まもなく到着いたします！！少々お待ちください」／遅れる→「かしこまりました！！お気をつけてお越しください」）。' : ''));
  }
  return lines.join('\n') + '\n\n';
}

/** staffContextNote に付ける1行注記（直前スタッフ発言の宣言／実行の解釈） */
export function buildLastStaffAnnotation(ledger: ActionLedger): string {
  const e = ledger.facts.lastStaffEntry;
  if (!e) return '';
  // 2026-09-11 統合設計（経路E1）: 「再度」の可否は redoWord(ledger) の1関数だけで書く（旧実装は同じ台帳から buildActionLedgerNote が「再度可」、
  //   ここが「再度不成立」と逆の指示を出していた）。ラウンドの文言は pickupRound(ledger).note
  if (e.status === 'promised') return `※この発言は「${LEDGER_KIND_JA[e.kind]}」の【宣言のみ】で、まだ履行していない（${pickupRound(ledger).note}）。${redoWord(ledger) ? '送付済み物件は以前のもの。この宣言を「完了した」と書かない。' : '「再度」「改めて」は成立しない（1件も送っていないため二度目は存在しない）。'}`;
  return `※この発言は「${LEDGER_KIND_JA[e.kind]}」を【実行済み】（根拠: ${e.source}）。同じ行動を未来形で再宣言しない。`;
}

// ═════════════════════════════════════════════════════════════════════════════
// 実行前提語ゲート — DONE_PRESUPPOSING_VOCAB（2026-09-09 Fable5 みく事例）
//   「その行為を我々が1回完了した証拠（台帳 facts）がある時だけ使える語」を語＋行為対象で検出する。
//   四者同名: 生成 buildLedgerNote（禁止語＋代替リテラル）／検査 final-check runLedgerChecks／
//            修正ループ applyLedgerAutoFix（Sonnet 不使用の決定論置換）／tpo_debug.ledger.gated
//   根拠: ai_reply_examples 60日で「再度/改めて＋ピックアップ」が編集で削除された3件は全て送付実績0、
//        正解で使われた10件は全て同一行為の完了実績あり。裸の「改めてご連絡」（未来予告）は対象外。
//        顧客が主語の文（〜いただ／〜頂け／〜ください）は除外。
// ═════════════════════════════════════════════════════════════════════════════
export type LedgerFactKey = 'propertiesSent' | 'estimateSent' | 'viewingInvited' | 'applicationGuided' | 'confirmationReported' | 'meetingPlaceSent';
export const LEDGER_FACT_JA: Record<LedgerFactKey, string> = {
  propertiesSent: '物件送付', estimateSent: '見積書送付', viewingInvited: '内覧打診', applicationGuided: '申込打診', confirmationReported: '募集状況確認', meetingPlaceSent: '待ち合わせ案内',
};
export function hasFact(f: LedgerFacts, k: LedgerFactKey): boolean {
  switch (k) {
    case 'propertiesSent': return f.propertiesSentCount > 0;
    case 'estimateSent': return f.estimateSent;
    case 'viewingInvited': return f.viewingInvited;
    case 'applicationGuided': return f.applicationGuided;
    case 'confirmationReported': return f.confirmationReported;
    case 'meetingPlaceSent': return f.meetingPlaceSent;
  }
}
export type PresupCode = 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE' | 'UNSENT_CLAIM';
export interface DonePresupVocab {
  key: string;
  re: RegExp;
  /** 必要な実績（配列＝いずれか1つで充足／'by_object'＝語中の対象で決める／関数＝任意述語） */
  requires: LedgerFactKey[] | 'by_object' | ((f: LedgerFacts) => boolean);
  requiresLabel: string;
  code: PresupCode;
  severity: 'block' | 'warning';
  label: string;
  exemptOnCustomerRef?: boolean;
  exemptOnCustomerAsksMore?: boolean;
  exemptOnDeliverable?: boolean;
  /** 未実行時の代替。生成ノート・検査 suggestion・自動修正の三者で同じ文 */
  fix: (m: string, o: { name: string; ledger: ActionLedger }) => string;
}
const NX = '[^\\n。！!]';
const NOT_CUST = `(?!${NX}{0,24}(?:いただ|頂い|頂け|ください|下さい))`;
const REDO = /(?:再度|改めて|もう一度)/;
// 2026-09-11 統合設計（経路B）: name="" なら呼びかけごと省く（旧実装は呼び出し側の「〇〇さん」フォールバックを本文に書き込んでいた）
const DECL = (name: string) => `${name ? `${name}に` : ''}オススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！`;
/** 顧客が先に既送付物へ言及（「先ほどの物件」「送ってもらった見積」）→ 復唱免除 */
export const CUSTOMER_PRIOR_REF_RE = /(?:先ほど|先程|さっき|前回|以前|こちら|上記|送って(?:いただい|もらっ|くれ)た|頂いた|届いた)[^\n]{0,8}(?:物件|お部屋|見積|資料|写真)|(?:物件|お部屋|見積書?)[^\n]{0,6}(?:ありがとう|拝見|見ました|確認しました|届きました)/;
/** 顧客が「他の／別の／追加で」を先に言った → 「他の物件も」免除 */
export const CUSTOMER_ASKS_MORE_RE = /(?:他|別|違う|もっと|追加)(?:の|に|で)?[^\n]{0,8}(?:物件|お部屋|候補|ピックアップ|探し)/;
/** この返信自体に成果物（物件ラベル・見積書）が添付されている（reply-context DELIVERABLE_RE から完了形動詞を除いた「添付物」だけの判定。
 *  「ピックアップさせて頂きました」だけの完了形は添付ではないので PROMISE_ECHO_MISMATCH / JUSHU_BEFORE_SEND の対象に残す） */
export const ATTACHED_DELIVERABLE_RE = /🌟|[0-9０-９]{2,4}号室|御見積書|お見積書|見積書同封|https?:\/\//;
/** 完了形の送付報告（約束未履行時に禁止） */
export const COMPLETED_SEND_RE = /お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ました|ピックアップ(?:させて(?:頂|いただ)き|いたし|致し|し)ました|ご査収ください/;
export const DONE_PRESUPPOSING_VOCAB: DonePresupVocab[] = [
  { key: 'redo_pickup', re: new RegExp(`(?:再度|改めて|もう一度)${NX}{0,16}?(?:ピックアップ|お探し|お調べ|お部屋(?:を)?探)${NOT_CUST}`),
    requires: ['propertiesSent'], requiresLabel: '物件送付 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「再度／改めてピックアップ」（1回目の送付が完了している前提）', fix: (m) => m.replace(REDO, '') },
  { key: 'additional_pickup', re: new RegExp(`(?:追加で|さらに|更に|他にも)${NX}{0,12}(?:ピックアップ|お探し|お送りさせて|お送りし|ご提案)(?!(?:い?ただ|頂い|頂け))`),
    requires: ['propertiesSent'], requiresLabel: '物件送付 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「追加で／さらにピックアップ」（初回送付済みの前提）', exemptOnCustomerAsksMore: true, fix: (m) => m.replace(/(?:追加で|さらに|更に|他にも)/, '') },
  { key: 'other_properties', re: new RegExp(`(?:他|別|ほか)の(?:お部屋|物件)(?:も|を)?${NX}{0,12}(?:ピックアップ|お探し|お送り|ご提案)`),
    requires: ['propertiesSent'], requiresLabel: '物件送付 ≥1（または顧客が「他の物件」を依頼）', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「他の／別の物件も」（既送付物件の存在が前提）', exemptOnCustomerAsksMore: true, fix: (m) => m.replace(/(?:他|別|ほか)の(?:お部屋|物件)(?:も|を)?/, 'お部屋') },
  { key: 'these_properties', re: /(?:こちら|上記|先ほど|先程)の(?:お部屋|物件)/,
    requires: ['propertiesSent'], requiresLabel: '物件送付 ≥1／顧客提示物件／この返信自体が送付文', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「こちらの／上記の物件」（指示対象が会話上に存在する前提）', exemptOnCustomerRef: true, exemptOnDeliverable: true, fix: (m) => m.replace(/(?:こちら|上記|先ほど|先程)の/, '') },
  { key: 'prior_sent_claim', re: /(?:先ほど|先程|先日|以前|前回)?お送り(?:させて(?:頂|いただ)い|し)た(?:御|お)?(?:見積(?:書)?|物件|お部屋|資料|写真)/,
    requires: 'by_object', requiresLabel: '対象の送付実績', code: 'UNSENT_CLAIM', severity: 'block',
    label: '「お送りした〇〇」（送付完了の前提）', exemptOnCustomerRef: true, exemptOnDeliverable: true,
    fix: (m, o) => /見積/.test(m) ? '御見積書作成しお送りさせて頂きます' : /写真/.test(m) ? '撮影出来次第お写真お送りさせて頂きます' : DECL(o.name) },
  { key: 'prior_proposed', re: /(?:ご提案|ご紹介|ピックアップ)(?:した|させて(?:頂|いただ)いた)(?:お部屋|物件)/,
    requires: ['propertiesSent'], requiresLabel: '物件送付 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「ご提案した物件」（提案送付済みの前提）', exemptOnCustomerRef: true, exemptOnDeliverable: true, fix: (_m, o) => DECL(o.name) },
  { key: 'redo_estimate', re: new RegExp(`(?:再度|改めて|もう一度)${NX}{0,12}?(?:御見積|お見積|見積)`),
    requires: ['estimateSent'], requiresLabel: '見積書送付 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「再度見積書」（見積書を1度送付済みの前提）', fix: (m) => m.replace(REDO, '') },
  { key: 'redo_viewing', re: new RegExp(`(?:再度|改めて|もう一度)${NX}{0,12}?(?:ご案内|ご内覧|内覧)`),
    requires: ['viewingInvited'], requiresLabel: '内覧打診 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「再度ご案内」（内覧打診・案内が1度済んでいる前提）', fix: (m) => m.replace(REDO, '') },
  { key: 'redo_apply', re: new RegExp(`(?:再度|改めて|もう一度)${NX}{0,12}?お申込`),
    requires: ['applicationGuided'], requiresLabel: '申込打診 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'block',
    label: '「再度お申込み」（申込が1度成立している前提）', fix: (m) => m.replace(REDO, '') },
  { key: 'redo_vacancy', re: new RegExp(`(?:再度|改めて|もう一度)${NX}{0,12}?(?:空室|募集状況|管理会社)${NX}{0,8}確認`),
    requires: ['confirmationReported'], requiresLabel: '募集状況確認 ≥1（または顧客の再確認依頼）', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'warning',
    label: '「再度空室確認」（1回目の確認が完了している前提）', fix: (m) => m.replace(REDO, '') },
  { key: 'keep_sent_option', re: /(?:お部屋|物件|号室)[^\n。！!]{0,6}も(?:含め|選択肢|並行|候補)/,
    requires: ['propertiesSent'], requiresLabel: '物件送付 ≥1', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'warning',
    label: '「〇〇号室も含め／選択肢に」（残す送付済み物件の存在が前提）', exemptOnCustomerRef: true, fix: () => '' },
  { key: 'continue_marker', re: /引き続き(?:新着|お部屋|ピックアップ)|随時ピックアップ|募集に出次第/,
    requires: (f) => f.propertiesSentCount > 0 || f.pickupPromisedUnfulfilled, requiresLabel: '物件送付 ≥1 または未履行のピックアップ宣言（1回目の探索が存在）', code: 'DONE_PRESUPPOSED_WITHOUT_EVIDENCE', severity: 'warning',
    label: '継続語「引き続き新着／随時／募集に出次第」（1回目の探索が存在する前提）', fix: (_m, o) => DECL(o.name) },
];

function requiredKeys(v: DonePresupVocab, m: string): LedgerFactKey[] | ((f: LedgerFacts) => boolean) {
  if (v.requires !== 'by_object') return v.requires;
  return /見積/.test(m) ? ['estimateSent'] : /写真/.test(m) ? [] : ['propertiesSent']; // 写真は台帳外（従来 staffHist 判定を final-check に残す）
}

export interface PresupHit {
  key: string; code: PresupCode; severity: 'block' | 'warning'; label: string; requiresLabel: string;
  evidence: string; sentence: string; missing: LedgerFactKey[]; exempt: string | null; fixed: string;
}
export interface PresupOpts { customerMessage: string; name: string; isDeliverableReply?: boolean }

/** 生成側・検査側・修正ループが同じ結果を得る唯一の評価関数 */
export function checkDonePresupposition(text: string, ledger: ActionLedger, o: PresupOpts): PresupHit[] {
  const out: PresupHit[] = [];
  const sentences = (text ?? '').split(/(?<=[。！!\n])/).map((s) => s.trim()).filter(Boolean);
  const custRef = (o.customerMessage ?? '').match(CUSTOMER_PRIOR_REF_RE);
  const asksMore = CUSTOMER_ASKS_MORE_RE.test(o.customerMessage ?? '');
  for (const v of DONE_PRESUPPOSING_VOCAB) {
    for (const s of sentences) {
      const m = s.match(v.re);
      if (!m) continue;
      const need = requiredKeys(v, m[0]);
      const missing = typeof need === 'function' ? (need(ledger.facts) ? [] : ['propertiesSent' as LedgerFactKey]) : need.filter((k) => !hasFact(ledger.facts, k));
      let exempt: string | null = null;
      if (missing.length === 0) exempt = 'evidence';
      else if (v.exemptOnDeliverable && o.isDeliverableReply) exempt = 'deliverable_reply';
      else if (v.exemptOnCustomerRef && custRef) exempt = `customer_ref:${custRef[0]}`;
      else if (v.exemptOnCustomerAsksMore && asksMore) exempt = 'customer_asks_more';
      const rep = v.fix(m[0], { name: o.name, ledger });
      const fixed = (rep === '' ? '' : s.replace(m[0], rep)).replace(/^[、,]/, '');
      out.push({ key: v.key, code: v.code, severity: v.severity, label: v.label, requiresLabel: v.requiresLabel, evidence: m[0], sentence: s, missing, exempt, fixed });
      break; // 語ごとに最初の1文だけ（修正ループの evidence 一意性）
    }
  }
  return out;
}

/** 決定論の自動修正（Sonnet を呼ばず「再度→削除／お送りした→未来形／完了形→出来次第」）。生成直後と検査修正ループが同じ関数 */
export function applyLedgerAutoFix(text: string, ledger: ActionLedger, o: PresupOpts): { text: string; applied: string[] } {
  let cur = text;
  const applied: string[] = [];
  for (const h of checkDonePresupposition(cur, ledger, o)) {
    if (h.exempt || h.severity !== 'block') continue;
    cur = cur.replace(h.sentence, h.fixed);
    applied.push(`${h.key}:「${h.evidence}」→「${h.fixed.slice(0, 40)}」`);
  }
  if (ledger.facts.pickupPromisedUnfulfilled && ledger.facts.propertiesSentCount === 0 && !o.isDeliverableReply) {
    const m = cur.match(COMPLETED_SEND_RE);
    if (m) { cur = cur.replace(m[0], 'ピックアップ出来次第お送りさせて頂きます'); applied.push(`promise_echo:「${m[0]}」→未来形`); }
  }
  return { text: cur.replace(/\n{3,}/g, '\n\n'), applied };
}

/** 現在ゲート中（実績が無いため使えない）の語キー */
export function gatedVocabKeys(ledger: ActionLedger): string[] {
  return DONE_PRESUPPOSING_VOCAB.filter((v) => {
    const need = v.requires === 'by_object' ? (['propertiesSent'] as LedgerFactKey[]) : v.requires;
    return typeof need === 'function' ? !need(ledger.facts) : need.some((k) => !hasFact(ledger.facts, k));
  }).map((v) => v.key);
}

/** dynamicBlock 注入用【📒 我々の行動台帳】＝ buildActionLedgerNote ＋ 語彙ゲート行。turnPairNote の直前に置く */
export function buildLedgerNote(ledger: ActionLedger, opts: { customerName?: string; maxEntries?: number } = {}): string {
  const base = buildActionLedgerNote(ledger, opts).replace(/\n\n$/, '');
  const gated = gatedVocabKeys(ledger);
  const lines = [base];
  if (gated.length) lines.push(`→ 現在ゲート中の語（実績が無いので本文に書かない）: ${gated.join('／')}`);
  lines.push('→ 判断は上記の確定事実のみ。会話履歴の「ピックアップしてお送りします」は宣言であって実行ではない。');
  return lines.join('\n') + '\n\n';
}
