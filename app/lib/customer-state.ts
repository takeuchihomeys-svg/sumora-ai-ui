// app/lib/customer-state.ts
// お客様の「今の段階」と「お部屋ごとの状況」を1か所で決める（純関数・DB 依存なし・画面からも import できる）。
//
// 2026-09-26 竹内「お客さん気に入ったお部屋あって、今はそのお部屋の内覧前の状態なども認識できるように。
//   ステータスや内覧予定をブレインに持たせたら文の質も状況の理解力も上がる」
//   「LINE のトークの上に今の状況を把握しているステータスのような物が表示されていたら、ズレがあった際にわかりやすい。
//   物件検索や提案中の部分もステータスを細分化するイメージ」
//
// ── なぜ1か所か（設計知見「お客様の状況は5か所に別々にあり、互いを見ていない」）──
//   状況は ①conversations.status（審査管理の同期が viewing を残す）②ブレインの phase（戦略文の語から推定・69%が7日以上古い）
//   ③セーブデータの situation（LLM の自由文）④viewing_history（lapsed の34/42件は内覧後のお礼を送っている）⑤sent_facts・台帳
//   に別々にあり、書く人が別々で古い値が残る。ここでは「一次事実（送った時の記録・本文の決まった形）」から毎回決め直し、
//   古い値との食い違いは conflicts として並べる（直すのはスタッフ。画面の「⚠ずれ」）。
//
// ── 入力の優先（強い順）──
//   1. conversations.status の 申込以降・成約・失注（スタッフが手で決める／申込以降は正）
//   2. 行動台帳（action-ledger: aix_usage_logs・sent_facts・本文）… 送った・約束した・内覧の待ち合わせ・内覧後のお礼
//   3. viewing_history（内覧の記録）… lapsed でも内覧後のお礼があれば実施済みとして**読む**（行は書き換えない）
//   4. AIX の本文の【】ラベル（見積書）・物件確認の property_names / prop_statuses
//   5. お客様の共有物件（SUUMO 等）・送った建物名への言及
//   6. ブレインの phase / situation … 表示に添えるだけ（段階は決めない。食い違いの比較だけ）
//
// ── お部屋の照合（設計知見「お部屋ごとの状況は結べる所と結べない所がはっきり分かれる」）──
//   鍵は「建物（normalizePropertyName＋NFKC）＋部屋（数字の0を外す）」。表記ゆれ（号室の0埋め・長音・Ⅱ/II・大文字小文字と空白）は寄せる。
//   似ている度だけで寄る物（誤読「CITY SPIRE↔CITY SPIKE」・略称）は**寄せず**、別の候補として「未確認の候補（〇〇と同じ？）」を付ける
//   （property-name-match の fail-closed と同じ考え。誤って寄せると別の物件の見積・内覧を持ち込む）。
//
// ⚠ サーバー専用ライブラリ（supabase 等）を import しない（画面から import すると本番ビルドだけ落ちる）。材料の読み込みは customer-state-server.ts
import {
  buildActionLedger, extractPropertyLabels, extractViewingAppointment, appointmentYmd,
  type LedgerAixRow, type LedgerTask, type RecordedFact, type ActionLedger, type LedgerEntry,
} from "./action-ledger";
import { resolveViewingThread, STAFF_VIEWING_DONE_RE, CUSTOMER_VIEWING_WISH_RE, CUSTOMER_VIEWING_CANCEL_RE } from "./viewing-thread";
import { resolveViewingScheduled } from "./done-state";
import { normalizePropertyName, similarity, MATCH_MIN_SCORE } from "./property-name-match";
import { customerSharedPropertyNames } from "./customer-property-names";
import { isApplicationFormMessage } from "./application-form-detect";
import { parseEstimateItems } from "./estimate-profit";
import { jstParts, jstYmd, WEEKDAYS_JA } from "./jst-date";

// ═════════════════════════════════════════════════════════════════════════════
// 型
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 今の段階。区分は「スタッフの動きが変わる境目」（調査1の区分案＋実データで確かめた・scripts/audit-customer-state.ts の CS 節）。
 *   first            初回（こちらがまだ文字を送っていない）
 *   searching        物件検索中（こちらの番: まだ物件を送っていない／探す約束が未履行）
 *   proposing        提案中（物件を送った・お客様の反応待ち）
 *   interested       気に入った物件あり（確認結果の報告・送った物件への言及・お客様の共有）
 *   estimate_sent    見積送付済み
 *   viewing_arranging 内覧調整中（打診した・お客様が内覧を希望・日時はまだ決まっていない）
 *   viewing_scheduled 内覧予定（日時つき）
 *   viewed           内覧後
 *   apply_prep       申込準備（申込のフォーマットを送った／お客様がフォームを返した・状態はまだ申込前）
 *   applying         申込・審査中（状態が申込以降）
 *   won              成約
 *   dropped          見送り・他社決定（状態が失注、またはお客様が他で決めたと言った）
 */
export type CustomerStage =
  | "first" | "searching" | "proposing" | "interested" | "estimate_sent"
  | "viewing_arranging" | "viewing_scheduled" | "viewed" | "apply_prep" | "applying" | "won" | "dropped";

export const STAGE_LABEL: Record<CustomerStage, string> = {
  first: "初回", searching: "物件検索中", proposing: "提案中", interested: "気に入った物件あり", estimate_sent: "見積送付済み",
  viewing_arranging: "内覧調整中", viewing_scheduled: "内覧予定", viewed: "内覧後", apply_prep: "申込準備", applying: "申込・審査中",
  won: "成約", dropped: "見送り・他社決定",
};
export const STAGE_ICON: Record<CustomerStage, string> = {
  first: "👋", searching: "🔍", proposing: "📨", interested: "💡", estimate_sent: "🧾",
  viewing_arranging: "📅", viewing_scheduled: "🏠", viewed: "✅", apply_prep: "📝", applying: "📝", won: "🎉", dropped: "⏸",
};

/** お部屋ごとの状態（順位の低い→高い。ended / declined は別扱い） */
export type RoomStatus =
  | "candidate" | "checking" | "available" | "estimate_sent" | "viewing_scheduled" | "viewing_unconfirmed" | "viewed" | "applying"
  | "ended";
export const ROOM_STATUS_LABEL: Record<RoomStatus, string> = {
  candidate: "候補", checking: "確認中", available: "募集中", estimate_sent: "見積済", viewing_scheduled: "内覧予定",
  viewing_unconfirmed: "内覧日経過(未確認)", viewed: "内覧済", applying: "申込中", ended: "終了",
};
const ROOM_RANK: Record<RoomStatus, number> = {
  candidate: 0, checking: 1, available: 2, estimate_sent: 3, viewing_scheduled: 4, viewing_unconfirmed: 4.5, viewed: 5, applying: 6, ended: -1,
};

export type RoomEventKind =
  | "sent" | "customer_shared" | "customer_mentioned" | "check_available" | "check_vacating" | "check_unavailable"
  | "estimate" | "viewing_scheduled" | "viewing_done" | "viewing_unconfirmed" | "viewing_cancelled" | "application";
export type RoomEvent = { kind: RoomEventKind; at: string; source: string };

export type RoomState = {
  /** 照合の鍵（建物の正規化＋部屋。部屋が分からない時は建物だけ） */
  key: string;
  /** 表示の名前（最初に見えた表記。部屋があれば「建物 部屋号室」） */
  name: string;
  building: string;
  room: string | null;
  status: RoomStatus;
  statusLabel: string;
  /** 退去予定（物件確認の結果） */
  vacating: boolean;
  /** 見積を送った（状態が内覧・申込に進んでも残す） */
  estimateSent: boolean;
  /** お客様が名指し・共有した */
  customerInterest: boolean;
  /** こちらが送った物件か（false＝お客様が見つけた・手打ちで決めた物件） */
  sentByUs: boolean;
  firstAt: string;
  lastAt: string;
  events: RoomEvent[];
  /** 似ているが寄せなかった別の候補（「未確認: 〇〇と同じ？」） */
  maybeSameAs: string[];
};

export type ConflictCode =
  | "STATUS_VIEWING_STALE"        // 状態＝内覧（審査管理の同期）なのに、これからの内覧が無い
  | "VIEWING_DONE_BUT_LAPSED"     // 予定表は「日付経過（未確認）」だが内覧後のお礼を送っている（読む側で実施済みにした）
  | "VIEWING_UNCONFIRMED"         // 内覧日が過ぎたが、実施したかの記録（お礼・完了）が無い
  | "PHASE_MISMATCH"              // ブレインの phase が今の段階と違う
  | "FORM_BUT_PROPOSING"          // 申込フォームを受けたが状態は申込前
  | "DECIDED_ELSEWHERE_OPEN"      // お客様は他で決めたと言っているが状態は失注でない
  | "UPCOMING_VIEWING_NO_ROOM"    // これからの内覧の物件名が記録に無い
  | "APPLY_NO_ROOM";             // 申込準備・申込中なのに、申込の物件名が記録にも本文にも無い
export type Conflict = {
  code: ConflictCode;
  /** warn＝画面で「⚠ずれ」を出す（スタッフが直す）／info＝読む側で吸収済み・参考 */
  severity: "warn" | "info";
  detail: string;
};

export type UpcomingViewing = {
  ymd: string | null;
  time: string | null;
  /** 「9/28(月)14:00」 */
  label: string;
  roomKey: string | null;
  name: string | null;
  /** 物件名を記録から推定した（直前の見積・確認の1件） */
  inferred: boolean;
  source: "viewing_history" | "meeting_place" | "customer_accepted" | "staff_meeting_text";
};

export type CustomerViewingStatus = "scheduled" | "done" | "unconfirmed" | "cancelled";
export type CustomerViewing = {
  ymd: string; time: string | null; name: string | null; status: CustomerViewingStatus;
  /** 内覧後のお礼を送った時刻（done の根拠） */
  thankedAt: string | null;
};
export const VIEWING_STATUS_LABEL: Record<CustomerViewingStatus, string> = {
  scheduled: "予定", done: "実施済み", unconfirmed: "日付経過（実施の記録なし）", cancelled: "キャンセル",
};

export type SearchingMark = {
  active: boolean;
  reason: "pickup_promised" | "watch_promised" | "sent_after_focus" | null;
  since: string | null;
};

export type CustomerState = {
  stage: CustomerStage;
  stageLabel: string;
  /** 今の段階になった出来事の時刻 */
  since: string | null;
  /** 段階に添える一言（内覧の日時・「実施未確認」等） */
  stageDetail: string | null;
  upcomingViewing: UpcomingViewing | null;
  /**
   * 内覧の一覧（日付で束ねた・古い順・直近8件）。2026-09-26 段3: ブレインの【内覧履歴・予定】の代わり。
   *   viewing_history の lapsed でも内覧後のお礼があれば done（実施済み）・物件名の無い内覧も日付だけで残す
   */
  viewings: CustomerViewing[];
  /** 主のお部屋（今の段階の相手。無ければ null） */
  focusKey: string | null;
  properties: RoomState[];
  searching: SearchingMark;
  conflicts: Conflict[];
  /** トークの上に出す1行（「🏠 内覧予定 9/28(月)14:00 ジュネスニッコー1003｜見積済 他1件」） */
  headline: string;
  /** 材料の状態（表示・監査用） */
  statusRaw: string | null;
  brainPhase: string | null;
  brainSituation: string | null;
};

export type CustomerStateMessage = {
  sender: string; text: string | null; createdAt: string; isAix?: boolean; lineMessageId?: string | null;
};
export type ViewingHistoryRow = {
  scheduled_date: string; scheduled_time?: string | null; status?: string | null; property_name?: string | null;
  actual_date?: string | null; viewing_report?: string | null; created_at?: string | null;
};
export type SentPropertyRow = { property_name: string | null; room_no?: string | null; sent_at: string | null };
export type CustomerStateAixRow = LedgerAixRow & { prop_statuses?: string[] | null };

export type CustomerStateInput = {
  now?: number;
  status: string | null;
  isPostApply?: boolean | null;
  statusManualBackAt?: string | null;
  /** conversations.conversation_direction.current_phase と updated_at */
  brainPhase?: string | null;
  brainPhaseUpdatedAt?: string | null;
  /** property_customers.ai_summary_json.situation（LLM の自由文・表示に添えるだけ） */
  brainSituation?: string | null;
  /** 古い順 */
  messages: CustomerStateMessage[];
  aixRows: CustomerStateAixRow[];
  recordedFacts: RecordedFact[];
  lineTasks?: LedgerTask[];
  viewingHistory: ViewingHistoryRow[];
  sentProperties: SentPropertyRow[];
  /** 既に作った台帳があれば渡す（無ければ中で作る） */
  ledger?: ActionLedger | null;
};

// ═════════════════════════════════════════════════════════════════════════════
// お部屋の照合
// ═════════════════════════════════════════════════════════════════════════════

export type RoomRef = { building: string; buildingKey: string; room: string | null; floor: string | null; display: string };

const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC");
/** 「〇〇 305号室」「〇〇305号室」「〇〇 305号」 */
const ROOM_WITH_GO_RE = /^(.*?)[\s]*([0-9]{1,4}[A-Za-z]?)\s*号室?\s*$/;
/** 「〇〇 1003」（空白で区切った3〜4桁）。建物名が数字で終わる「リーダースパーク21」は部屋にしない（2桁・空白なし） */
const ROOM_SPACED_RE = /^(.*\S)\s+([0-9]{3,4}[A-Za-z]?)\s*$/;
const FLOOR_RE = /^(.*?)[\s]*([0-9]{1,3})\s*階\s*$/;
/** 部屋の数字（0埋めを外す・英字は大文字） */
export function normalizeRoomNo(room: string | null | undefined): string | null {
  const r = nfkc(room).replace(/号室?/g, "").replace(/\s/g, "").replace(/^0+(?=\d)/, "");
  return /^\d{1,4}[A-Za-z]?$/.test(r) ? r.toUpperCase() : null;
}
/** 建物名の照合の鍵（NFKC で Ⅱ→II・全角→半角 → normalizePropertyName で記号・空白・長音を外し小文字） */
export function buildingKeyOf(name: string | null | undefined): string {
  return normalizePropertyName(nfkc(name).replace(/[〜~～]/g, ""));
}

/** 物件名を建物と部屋に分ける（部屋を別に持っていればそれを使う） */
export function splitPropertyName(raw: string | null | undefined, roomNo?: string | null): RoomRef | null {
  let t = nfkc(raw).replace(/[\s]+/g, " ").trim();
  // 先頭の番号「①」「【1】」「1.」、囲み「【】」「🌟」を外す
  t = t.replace(/^[🌟★☆\s]+/u, "").replace(/^(?:【\s*\d{1,2}\s*】|[①-⑳]|\d{1,2}\s*[.．)）])\s*/, "").replace(/^【\s*|\s*】$/g, "").trim();
  if (!t) return null;
  let building = t;
  let room: string | null = normalizeRoomNo(roomNo);
  let floor: string | null = null;
  const g = t.match(ROOM_WITH_GO_RE);
  if (g && g[1].trim()) { building = g[1].trim(); room = room ?? normalizeRoomNo(g[2]); }
  else {
    const s = t.match(ROOM_SPACED_RE);
    if (s) { building = s[1].trim(); room = room ?? normalizeRoomNo(s[2]); }
    else {
      const f = t.match(FLOOR_RE);
      if (f && f[1].trim()) { building = f[1].trim(); floor = f[2]; }
    }
  }
  const buildingKey = buildingKeyOf(building);
  if (buildingKey.length < 2) return null;
  return { building, buildingKey, room, floor, display: room ? `${building} ${room}号室` : building };
}

export type RoomMatch = "same_room" | "same_building" | "different_room" | "maybe" | "different";
/**
 * 2つのお部屋が同じか。
 *   same_room      建物の鍵が同じ・部屋も同じ
 *   same_building  建物の鍵が同じ・片方に部屋が無い（建物だけで寄せてよい）
 *   different_room 建物の鍵が同じ・部屋が違う（同じ建物の別の部屋＝別に持つ）
 *   maybe          似ている（0.7以上）・片方がもう片方を含む（略称・誤読）… **寄せない**（未確認）
 *   different      別物
 * 空白なしの「ジュネスニッコー1003」は、もう片方が「ジュネスニッコー 1003号室」なら同じ部屋として読む
 */
export function matchRoomRefs(a: RoomRef, b: RoomRef): RoomMatch {
  const tail = (x: RoomRef, y: RoomRef): boolean => !x.room && !!y.room && x.buildingKey === y.buildingKey + y.room.toLowerCase();
  if (tail(a, b) || tail(b, a)) return "same_room";
  if (a.buildingKey === b.buildingKey) {
    if (a.room && b.room) return a.room === b.room ? "same_room" : "different_room";
    return "same_building";
  }
  const ka = a.buildingKey, kb = b.buildingKey;
  if (ka.length >= 3 && kb.length >= 3 && (ka.includes(kb) || kb.includes(ka))) return "maybe";
  if (similarity(ka, kb) >= MATCH_MIN_SCORE) return "maybe";
  return "different";
}

/**
 * 物件名として使える形に整える（使えなければ null）。
 *   本文から読んだ名前は文の頭や挨拶が混ざる（「お部屋ご案内させて頂きます!! アーバネックス堺筋本町」→「アーバネックス堺筋本町」）。
 *   区切り（！。?）の後の最後のかたまりを採り、それでも文（させて頂・ます・お願い 等）なら捨てる。
 */
//   2026-09-26 監査で読んだ実物: 待ち合わせの場所に人の呼び名（「〇〇さん」c000080f）・共有文の前の行がお客様の文（「バルコニーを必要としていないので、…」e68fd1e2）・
//   「(室内イメージ)」「物件1」（画面の既定の名前）→ 全部捨てる
const SENTENCE_WORD_RE = /させて|頂き|いただ|ます|ました|ません|ください|下さい|お願い|ご案内|ご確認|ありがと|お世話|よろしく|宜しく|です|でした|URL|手順|署名|登録|ギフト|お見逃し|ので|かも|しれ|けど|[、，]|室内イメージ|(?:さん|様|くん|ちゃん)$|^物件\s*\d*$/;
export function cleanBuildingName(raw: string | null | undefined): string | null {
  let t = nfkc(raw).replace(/\s+/g, " ").trim();
  if (!t) return null;
  const segs = t.split(/[!！。?？]+/).map((s) => s.trim()).filter(Boolean);
  t = segs.at(-1) ?? "";
  if (!t || t.length > 45 || SENTENCE_WORD_RE.test(t)) return null;
  if (!/[ァ-ヶー一-龯A-Za-z]{2,}/.test(t)) return null;
  return t;
}
/** お客様が共有した物件として読む URL（物件の載るポータル。実データ180日の上位） */
export const PROPERTY_PORTAL_URL_RE = /suumo\.jp|homes\.co\.jp|myhome\.nifty\.com|smocca\.jp|athome\.co\.jp|sumaity\.com|pethomeweb\.com|realestate\.yahoo\.co\.jp|chintai-ex\.jp|realnetpro\.com|canary-app\.jp|canary\.go\.link|eheya\.net|designers-osaka-chintai|pitat\.com|lavio\.jp|house\.goo\.ne\.jp|homemate\.co\.jp|sumaisagashi|shamaison\.com|door\.ac|chintai\.net|oshimaland|ieselect\.com|apamanshop|minimini\.jp|able\.co\.jp|izumi-realestate/i;
/** 申込より前の状態（conversations.status） */
const PRE_APPLY_STATUS_RE = /^(?:hearing|condition_hearing|first_reply|property_search|new_inquiry|proposing|property_recommendation|availability_check|estimate_request|viewing)$/;

/** 見積書の本文（AIX【見積書送る】）の【】ラベルから物件名（「建物 部屋号室」）。物件でない見出し（欄・誘導 等）は外す */
const NON_PROPERTY_HEAD_RE = /欄|誘導|注意|ご案内|お知らせ|初期費用|見積|内訳|合計|割引|キャンペーン|フォーマット|必要書類/;
export function estimateNamesFromText(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const it of parseEstimateItems(text)) {
    const name = (it.propertyName ?? "").trim();
    if (!name || NON_PROPERTY_HEAD_RE.test(name)) continue;
    const ref = splitPropertyName(name, it.roomNo);
    if (ref) out.push(ref.display);
  }
  return [...new Set(out)];
}

/**
 * 1件に決まる「今の相手のお部屋」の推定。
 *   ⚠ 2026-09-26 監査で半分外れた（内覧 一致2・別2／申込 本文と比べて13通中6通一致）ので、**物件名を付けるのには使わない**（監査で比べる時だけ）。
 *   直前 windowDays 日の「関心の出来事」（見積・内覧の待ち合わせ・物件確認の結果・申込の案内）のうち**最後の1つ**が
 *   1つの建物だけを指している時だけ、その名前を返す。複数の物件を並べた見積・確認の直後は決められない（null）。
 *   ＝ 迷う時は付けない（誤った物件名は付けないより悪い）
 */
export function pickSingleFocusName(
  events: ReadonlyArray<{ at: string | null; names: ReadonlyArray<string> }>,
  beforeIso: string,
  windowDays = 21,
): string | null {
  const before = Date.parse(beforeIso);
  if (!Number.isFinite(before)) return null;
  const inWin = events
    .filter((e) => { const t = Date.parse(e.at ?? ""); return Number.isFinite(t) && t <= before && before - t <= windowDays * 86_400_000 && e.names.some((n) => !!splitPropertyName(n)); })
    .sort((x, y) => Date.parse(x.at ?? "") - Date.parse(y.at ?? ""));
  const last = inWin.at(-1);
  if (!last) return null;
  const refs = last.names.map((n) => splitPropertyName(n)).filter((r): r is RoomRef => !!r);
  const keys = new Set(refs.map((r) => r.buildingKey));
  if (keys.size !== 1) return null;
  // 部屋まである表記を優先
  return (refs.find((r) => r.room) ?? refs[0]).display;
}

/**
 * 続けて送った出来事（前の出来事から gapMs 以内）を1つに束ねる。
 *   見積書を1物件ずつ1分おきに5通送る回（d25e07d1）を「最後の1通＝1物件」と読まないため
 */
export function bundleFocusEvents(events: ReadonlyArray<{ at: string; names: ReadonlyArray<string> }>, gapMs = 3 * 60_000): Array<{ at: string; names: string[] }> {
  const sorted = [...events].filter((e) => Number.isFinite(Date.parse(e.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Array<{ at: string; names: string[]; last: number }> = [];
  for (const e of sorted) {
    const t = Date.parse(e.at);
    const cur = out.at(-1);
    if (cur && t - cur.last <= gapMs) { cur.names = [...new Set([...cur.names, ...e.names])]; cur.last = t; cur.at = e.at; }
    else out.push({ at: e.at, names: [...new Set(e.names)], last: t });
  }
  return out.map(({ at, names }) => ({ at, names }));
}

/**
 * こちらの本文の「〇〇 102号室お申込みさせていただきます」から申込の物件を読む（無ければ null）。
 *   2026-09-26 監査（申込の案内75通の前後の本文を目で読んだ）: スタッフは申込の案内の直前・直後に
 *   「かしこまりました！！ RIDGE江坂102号室お申込みさせていただきます」「S-RESIDENCE江坂Eminence601 お申込させて頂きます」
 *   「KANOACIA602号室お申込みさせていただきます」と物件を書く。直前の見積からの推定（pickSingleFocusName）は
 *   見積の後に別の物件へ申込んだ回（7beca4f5・288d474a・60e6d3ab）で外れるので、本文に書いてあればそちらを正にする。
 */
const APPLY_NAME_RE = /([^\s！!。、「」（）()・:：]{2,40}?)\s*(?:([0-9]{2,4}[A-Za-z]?)\s*号室?|([0-9]{3,4}[A-Za-z]?))?\s*(?:の|を)?\s*(?:お部屋)?\s*(?:お)?申し?込み?(?:を)?(?:させ|審査|進め)/g;
//   監査で読んだ誤り: 「2番手で」「代理契約で」「お部屋抑えた状態で」（助詞「で」で終わる＝物件名でない）
const APPLY_NAME_STOP_RE = /^(?:お部屋|こちら|こちらの|先に|是非|ぜひ|一度|まず|すぐ|そのまま|同時|並行|本日|明日|早め|今回|今|ご|の|今すぐ)$|^(?:こちらの|先に|是非)|で$|番手|代理契約|状態|審査|お部屋|明日|本日|確定|すぐ|予定/;
/** 英字の物件名は空白を含む（「J's Garden」「Vino East」）→ 直前の英字の語を足す */
const LATIN_WORDS_TAIL_RE = /(?:[A-Za-z0-9'’.&-]+ )+$/;
export function applicationPropertyFromText(text: string | null | undefined): string | null {
  const t = nfkc(text);
  for (const m of t.matchAll(APPLY_NAME_RE)) {
    let name = (m[1] ?? "").replace(/^(?:かしこまりました|承知しました|はい|では|それでは)+/, "").trim();
    if (!name || APPLY_NAME_STOP_RE.test(name)) continue;
    if (/^[A-Za-z]/.test(name)) { const pre = t.slice(0, m.index ?? 0).match(LATIN_WORDS_TAIL_RE); if (pre) name = `${pre[0]}${name}`.trim(); }
    // 「こちらの1212号室」のように部屋だけの時は物件名が無い（null）
    const clean = cleanBuildingName(name);
    if (!clean) continue;
    const ref = splitPropertyName(clean, m[2] ?? m[3] ?? null);
    if (ref && ref.buildingKey.length >= 3) return ref.display;
  }
  return null;
}

/**
 * 送信時の記録（sent_facts）から、申込の案内の物件を推定する（log-aix-usage → recordAixFacts が使う）。
 *   見積の estimateFor・待ち合わせの place・物件確認の propertyNames（1件の時）・前の申込の案内の propertyNames
 */
export function focusEventsFromFacts(facts: ReadonlyArray<Pick<RecordedFact, "sent_at" | "kind" | "detail">>): Array<{ at: string; names: string[] }> {
  const out: Array<{ at: string; names: string[] }> = [];
  for (const f of facts) {
    const d = f.detail ?? {};
    if (f.kind === "estimate_sent" && d.estimateFor?.length) out.push({ at: f.sent_at, names: d.estimateFor });
    else if (f.kind === "meeting_place_sent" && d.appointment?.place) out.push({ at: f.sent_at, names: [d.appointment.place] });
    else if (f.kind === "confirmation_reported" && d.propertyNames?.length) out.push({ at: f.sent_at, names: d.propertyNames });
    else if (f.kind === "application_guided" && d.propertyNames?.length) out.push({ at: f.sent_at, names: d.propertyNames });
  }
  return out;
}

/**
 * AIX の記録（aix_usage_logs）から関心の出来事: 見積書（本文の【】ラベル）・物件確認（募集中・退去予定の物件）・待ち合わせ（画面で選んだ物件は sent_facts 側）。
 *   sent_facts の estimateFor は 9/26 より前の送信で84%が空なので、本文のラベルで補う
 */
export function focusEventsFromAixRows(rows: ReadonlyArray<Pick<CustomerStateAixRow, "aix_type" | "sent_at" | "created_at" | "generated_text" | "property_names" | "prop_statuses" | "estimate_sent">>): Array<{ at: string; names: string[] }> {
  const out: Array<{ at: string; names: string[] }> = [];
  for (const r of rows) {
    const at = r.sent_at ?? r.created_at;
    if (!at) continue;
    if (r.aix_type === "estimate_sheet") {
      const names = estimateNamesFromText(r.generated_text);
      if (names.length || r.property_names?.length) out.push({ at, names: names.length ? names : [...(r.property_names ?? [])] });
    } else if (r.aix_type === "property_check_result" && r.property_names?.length) {
      const ok = r.property_names.filter((_, i) => { const s = String(r.prop_statuses?.[i] ?? ""); return s === "available" || s === "vacating"; });
      if (ok.length) out.push({ at, names: ok });
    } else if (r.estimate_sent === true && r.property_names?.length) {
      out.push({ at, names: [...r.property_names] });
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// 本文の決まった形
// ═════════════════════════════════════════════════════════════════════════════

/** こちらが申込のフォーマットを送った（AIX【申込へ】の本文・手打ちで貼った定型） */
export const APPLY_FORMAT_SENT_RE = /記入欄】|申込(?:み)?時フォーマット|お申込(?:み)?(?:に|の)?必要なご情報/;
/**
 * お客様が「他で決めた」と言った（他社決定）。
 *   ⚠ 「他社で決まる前に」「他で決まってしまうかも」（心配）・「他の物件で決めたい」（こちらの別の物件）は当てない
 */
//   実物（365日・広い候補52通を目で読んだ）: 「他の不動産屋で審査通しており…そちらで物件決まりました」「〇〇様で契約を進めることになりました…このような結果となり申し訳ありません」
//   「諦めて他社で探します」の3通。「他社で紹介して頂いて見積もりも」「別の不動産で仮押さえしてもらってる」「他社より安いため契約させて頂きたい」は当てない
export const DECIDED_ELSEWHERE_RE = /(?:他社|他の不動産|別の不動産|ほかの不動産|他の業者|別の業者)[^\n]{0,40}?(?:決まりました|決めました|契約(?:しました|を進める事に|を進めることに|することに(?:なり|し))|申し?込み?(?:しました|をしました))|(?:他社|他の不動産(?:屋|会社)?|別の不動産(?:屋|会社)?)で探します|(?:他|ほか)で(?:決め|決まり)ました/;
/** 会社名を伏せた断り（「〇〇様で契約を進めることになりました」＋同じ発言の「申し訳」「このような結果」）は発言全体で見る */
const DECIDED_ELSEWHERE_WHOLE_RE = /で契約を進める(?:事|こと)になりました/;
const DECLINE_APOLOGY_RE = /申し訳|このような結果|すみません/;
const DECIDED_ELSEWHERE_NEGATE_RE = /前に|場合|たら|かも|しれ|ないか|ように|心配|不安|予定|比較|検討中|まだ|\?|？/;
export function isDecidedElsewhere(text: string | null | undefined): boolean {
  const t = nfkc(text);
  if (IMAGE_TEXT_RE.test(t)) return false;
  for (const s of t.split(/\n|(?<=[。！!])/)) {
    if (DECIDED_ELSEWHERE_RE.test(s) && !DECIDED_ELSEWHERE_NEGATE_RE.test(s)) return true;
  }
  return DECIDED_ELSEWHERE_WHOLE_RE.test(t) && DECLINE_APOLOGY_RE.test(t);
}
/** 画像の読み取り文（お客様の言葉ではない） */
const IMAGE_TEXT_RE = /^\s*\[画像\]/;
/**
 * 決まった内覧の取りやめ（お客様）。viewing-thread の CUSTOMER_VIEWING_CANCEL_RE は「難しく」「都合が」を単独で拾う（費用が難しく 等）ので、
 * 取りやめの語そのもの、または内覧・日付の語と一緒の時だけにする
 */
export const VIEWING_CANCEL_STRICT_RE = /キャンセル|中止|延期|行けなく(?:なり|なっ)|(?:内覧|内見|見学|明日|明後日|当日|予定)[^\n]{0,15}(?:難しく|都合が(?:悪|つか)|やめ|見送)/;
const VIEWING_WISH_NEGATE_RE =/まだ|考えて(?:い)?ません|考えてない|後で|いったん|一旦|しません|しないです|もう少し|もっと|他も|ほかも/;

// ═════════════════════════════════════════════════════════════════════════════
// 本体
// ═════════════════════════════════════════════════════════════════════════════

type StageEvent = { t: number; stage: CustomerStage; roomKey?: string | null; source: string };
const APPLY_STATUSES = new Set(["applying", "application", "screening", "approved"]);
const WON_STATUSES = new Set(["closed_won", "contract"]);
const LOST_STATUSES = new Set(["closed_lost", "lost"]);
const DAY = 86_400_000;
const ms = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : NaN; };
const iso = (t: number) => new Date(t).toISOString();
/** YYYY-MM-DD の次の日 */
const nextYmd = (ymd: string) => jstYmd(Date.parse(`${ymd}T12:00:00+09:00`) + DAY);
/** 「9/28(月)14:00」 */
export function viewingLabel(ymd: string | null, time: string | null): string {
  if (!ymd) return time ?? "";
  const [, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(Number(ymd.slice(0, 4)), m - 1, d)).getUTCDay();
  return `${m}/${d}(${WEEKDAYS_JA[dow]})${time ? String(time).slice(0, 5) : ""}`;
}
/** 「9/7(月) 16:00〜」→ { ymd, time }（年は now から） */
function parseSlotLabel(label: string | null, nowMs: number): { ymd: string | null; time: string | null } {
  const t = nfkc(label);
  const md = t.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  const tm = t.match(/(\d{1,2}):(\d{2})/);
  const ymd = md ? appointmentYmd(`${Number(md[1])}/${Number(md[2])}`, iso(nowMs)) : null;
  return { ymd, time: tm ? `${Number(tm[1])}:${tm[2]}` : null };
}
/** ブレインの phase を段階の大きな組に（比べるだけ） */
function phaseGroup(p: string | null | undefined): "early" | "viewing" | "apply" | "won" | null {
  const s = (p ?? "").trim();
  if (!s) return null;
  if (/^(?:hearing|condition_hearing|first_reply|property_search|proposing|property_recommendation|availability_check|estimate_request|searching|proposal)$/.test(s)) return "early";
  if (/viewing/.test(s)) return "viewing";
  if (/^(?:applying|application|screening|approved|closing)$/.test(s)) return "apply";
  if (/^(?:contract|closed_won|won)$/.test(s)) return "won";
  return null;
}
function stageGroup(s: CustomerStage): "early" | "viewing" | "apply" | "won" | "dropped" {
  if (s === "viewing_arranging" || s === "viewing_scheduled" || s === "viewed") return "viewing";
  if (s === "apply_prep" || s === "applying") return "apply";
  if (s === "won") return "won";
  if (s === "dropped") return "dropped";
  return "early";
}

export function resolveCustomerState(input: CustomerStateInput): CustomerState {
  const now = input.now ?? Date.now();
  const todayYmd = jstYmd(now);
  const status = (input.status ?? "").trim() || null;
  /**
   * 申込以降か（スタッフが決める状態が正）。申込後の印（is_post_apply）は、状態を手で提案中に戻していない時だけ効かせる
   * （否決・見送りで提案中に戻した会話を申込中と読まない）
   */
  const applyActive = !!status && (APPLY_STATUSES.has(status) || WON_STATUSES.has(status))
    || (!!input.isPostApply && !input.statusManualBackAt && !LOST_STATUSES.has(status ?? "") && !PRE_APPLY_STATUS_RE.test(status ?? ""));
  const msgs = [...(input.messages ?? [])].filter((m) => Number.isFinite(ms(m.createdAt))).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const staffText = msgs.filter((m) => m.sender === "staff" && (m.text ?? "").trim() && !/^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/.test(m.text ?? ""));
  const cust = msgs.filter((m) => m.sender === "customer" && (m.text ?? "").trim());
  const aixSent = (input.aixRows ?? []).filter((r) => !!r.aix_type && (r.sent_at || r.created_at));
  const lastCustomerAt = cust.at(-1)?.createdAt ?? null;
  const ledger = input.ledger ?? buildActionLedger({
    recentAixRows: aixSent,
    messages: msgs.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: !!m.isAix, lineMessageId: m.lineMessageId ?? null })),
    lineTasks: input.lineTasks ?? [],
    lastCustomerAt,
    now,
    recordedFacts: input.recordedFacts ?? [],
  });
  const entries: LedgerEntry[] = ledger.entries;

  // ─── お部屋の一覧を作る（出来事を時刻順に当てる）───
  const rooms: Array<RoomState & { ref: RoomRef }> = [];
  type Obs = { name: string; roomNo?: string | null; kind: RoomEventKind; at: string; source: string };
  const obs: Obs[] = [];
  const push = (name: string | null | undefined, kind: RoomEventKind, at: string | null | undefined, source: string, roomNo?: string | null) => {
    const clean = cleanBuildingName(name);
    if (!clean || !at || !Number.isFinite(ms(at))) return;
    obs.push({ name: clean, roomNo: roomNo ?? null, kind, at, source });
  };
  for (const s of input.sentProperties ?? []) push(s.property_name, "sent", s.sent_at, "sent_properties", s.room_no ?? null);
  for (const e of entries) {
    if (e.kind === "properties_sent" && e.status === "done") for (const n of e.detail.propertyNames ?? []) push(n, "sent", e.at, `ledger:${e.source}`);
    if (e.kind === "estimate_sent") for (const n of e.detail.estimateFor ?? []) push(n, "estimate", e.at, `ledger:${e.source}`);
  }
  for (const r of aixSent) {
    const at = r.sent_at ?? r.created_at;
    if (r.aix_type === "estimate_sheet") {
      const names = estimateNamesFromText(r.generated_text);
      for (const n of names.length ? names : (r.property_names ?? [])) push(n, "estimate", at, "aix:estimate_label");
    } else if (r.estimate_sent === true) {
      for (const n of r.property_names ?? []) push(n, "estimate", at, `aix:${r.aix_type}+estimate`);
    }
    if (r.aix_type === "property_check_result" && r.property_names?.length) {
      r.property_names.forEach((n, i) => {
        const st = String(r.prop_statuses?.[i] ?? "");
        const kind: RoomEventKind = st === "unavailable" ? "check_unavailable" : st === "vacating" ? "check_vacating" : st === "available" ? "check_available" : "sent";
        push(n, kind, at, "aix:property_check_result");
      });
    }
    if ((r.aix_type === "property_recommendation" || r.aix_type === "property_send") && r.generated_text) {
      for (const n of extractPropertyLabels(r.generated_text)) push(n, "sent", at, `aix:${r.aix_type}:label`);
    }
  }
  // お客様が共有した物件（SUUMO 等）
  //   2026-09-26 監査: 物件の載るポータルの URL の時だけ（ギフトの案内・口座振替・契約書の URL の直前の行を物件にしていた 914a82e9・4ef4daa8・68464362 型）
  for (const c of customerSharedPropertyNames(cust.map((m) => ({ sender: "customer", text: m.text, createdAt: m.createdAt })), { limit: 30 })) {
    if (c.url && PROPERTY_PORTAL_URL_RE.test(c.url)) push(c.name, "customer_shared", c.at, "customer_shared");
  }

  // 内覧: viewing_history と待ち合わせの案内を日付で束ねる
  type Viewing = { ymd: string; time: string | null; name: string | null; nameInferred: boolean; vhStatus: string | null; fromVh: boolean; fromMeeting: boolean; sentAt: string | null; done: boolean; thankedAt: string | null; cancelled: boolean };
  const viewings = new Map<string, Viewing>();
  const getV = (ymd: string) => { let v = viewings.get(ymd); if (!v) { v = { ymd, time: null, name: null, nameInferred: false, vhStatus: null, fromVh: false, fromMeeting: false, sentAt: null, done: false, thankedAt: null, cancelled: false }; viewings.set(ymd, v); } return v; };
  //   待ち合わせは台帳の行（画面で入力した日時・物件が正）に加え、こちらの全ての本文からも読む。
  //   2026-09-26 監査（4aef01ff）: AIX【内覧に誘う】の本文で待ち合わせを案内した回は、台帳では「内覧打診」の行になり（AIX の ±3分は本文を読まない）待ち合わせが残らなかった
  const meetings: Array<{ at: string; appointment: { dateMD: string | null; time: string | null; place: string | null } }> = [];
  for (const e of entries) if (e.kind === "meeting_place_sent" && e.detail.appointment?.dateMD && e.at) meetings.push({ at: e.at, appointment: e.detail.appointment });
  for (const m of staffText) {
    const a = extractViewingAppointment(m.text, m.createdAt);
    if (a?.dateMD && !meetings.some((x) => Math.abs(ms(x.at) - ms(m.createdAt)) <= 3 * 60_000 && x.appointment.dateMD === a.dateMD)) meetings.push({ at: m.createdAt, appointment: a });
  }
  for (const mt of meetings.sort((a, b) => ms(a.at) - ms(b.at))) {
    const ymd = appointmentYmd(mt.appointment.dateMD!, mt.at);
    if (!ymd) continue;
    const v = getV(ymd);
    v.fromMeeting = true; v.time = mt.appointment.time ?? v.time; v.sentAt = v.sentAt && ms(v.sentAt) > ms(mt.at) ? v.sentAt : mt.at;
    //   本文から読んだ場所は文の頭が混ざる（「お部屋ご案内させて頂きます!! アーバネックス堺筋本町」d9d1f3c5）→ cleanBuildingName で最後の区切りだけ
    const placeName = cleanBuildingName(mt.appointment.place);
    if (placeName && !/駅|改札|出口|エントランス|現地/.test(placeName)) v.name = v.name ?? placeName;
  }
  for (const h of input.viewingHistory ?? []) {
    if (!h.scheduled_date) continue;
    const v = getV(h.scheduled_date.slice(0, 10));
    v.fromVh = true; v.vhStatus = h.status ?? null;
    v.time = h.scheduled_time ? String(h.scheduled_time).slice(0, 5).replace(/^0/, "") : v.time;
    if (h.property_name?.trim()) v.name = h.property_name.trim();
    v.sentAt = v.sentAt ?? h.created_at ?? null;
    if (h.status === "done") v.done = true;
    if (h.status === "cancelled") v.cancelled = true;
  }
  // 内覧のキャンセル: 案内の後〜内覧日の終わりまでに、お客様のキャンセル・延期の言葉／こちらの「キャンセル承りました」（4aef01ff）。
  //   その後に同じ日の待ち合わせをもう一度案内していればキャンセルではない
  for (const v of viewings.values()) {
    if (v.done || !v.sentAt) continue;
    const from = ms(v.sentAt), to = ms(`${v.ymd}T23:59:59+09:00`);
    const cancelMsg = msgs.find((m) => ms(m.createdAt) > from && ms(m.createdAt) <= to && !/^\s*\[画像\]/.test(m.text ?? "") && (
      (m.sender === "customer" && VIEWING_CANCEL_STRICT_RE.test(nfkc(m.text)) && !/別日|他の日/.test(nfkc(m.text)))
      || (m.sender === "staff" && /キャンセル(?:を)?(?:承|かしこまり|了解)|内覧(?:の)?キャンセル/.test(nfkc(m.text)))));
    if (!cancelMsg) continue;
    const reAnnounced = meetings.some((mt) => ms(mt.at) > ms(cancelMsg.createdAt) && appointmentYmd(mt.appointment.dateMD!, mt.at) === v.ymd);
    if (!reAnnounced) v.cancelled = true;
  }
  // 内覧後のお礼（当日〜翌日）で実施済みにする（viewing_history の lapsed は書き換えずに読む）
  const thanks = staffText.filter((m) => STAFF_VIEWING_DONE_RE.test(nfkc(m.text)));
  for (const v of viewings.values()) {
    const th = thanks.find((m) => { const d = jstYmd(ms(m.createdAt)); return d === v.ymd || d === nextYmd(v.ymd); });
    if (th) { v.done = true; v.thankedAt = th.createdAt; }
  }
  if (ledger.facts.viewingDone?.appointment.dateMD && ledger.facts.viewingDone.thankedAt) {
    const ymd = appointmentYmd(ledger.facts.viewingDone.appointment.dateMD, ledger.facts.viewingDone.thankedAt);
    const v = ymd ? viewings.get(ymd) : undefined;
    if (v) { v.done = true; v.thankedAt = v.thankedAt ?? ledger.facts.viewingDone.thankedAt; }
  }
  // お礼はあるが予定の記録が無い内覧（当日の手打ちで決めた等）: お礼の日を内覧日として持つ
  for (const th of thanks) {
    const d = jstYmd(ms(th.createdAt));
    const y = jstYmd(ms(th.createdAt) - DAY);
    const said = /昨日/.test(nfkc(th.text)) ? y : d;
    if (!viewings.has(said) && !viewings.has(d) && !viewings.has(y)) { const v = getV(said); v.done = true; v.thankedAt = th.createdAt; }
  }
  // 関心の出来事（推定の材料）は先に集める: 見積・確認・待ち合わせ・申込
  const focusEvents: Array<{ at: string; names: string[] }> = [];
  for (const o of obs) if (o.kind === "estimate" || o.kind === "check_available" || o.kind === "check_vacating") focusEvents.push({ at: o.at, names: [o.name] });
  // 続けて送った見積（複数の物件・1物件ずつ続けて）は1つの出来事に束ねる（「1件に決まる」を正しく判定する）
  const focusBundles = bundleFocusEvents([...focusEvents, ...[...viewings.values()].filter((v) => v.name && v.sentAt).map((v) => ({ at: v.sentAt!, names: [v.name!] }))]);
  // 物件名の無い内覧（画面の挨拶ピッカー経由 67%）に「直前の関心の出来事の1件」で名前を付ける案は**入れない**。
  //   2026-09-26 監査（scripts/audit-customer-state.ts CS-4）: 名前のある内覧の記録で名前を隠して推定を当てると 一致2・別の物件2・決まらない13。
  //   申込の案内でも本文に物件名がある13通で推定は6通しか合わず（見積の後に別の物件へ申込む・同じ建物の別の部屋）、半分外れる推定は付けない（誤った物件名は付けないより悪い）。
  //   → 名前の無い内覧は「物件名が記録に無い」（UPCOMING_VIEWING_NO_ROOM）として出し、入口（viewing_history に物件名を入れる）で直す
  void focusBundles;
  for (const v of viewings.values()) {
    if (!v.name) continue;
    const at = v.sentAt ?? `${v.ymd}T09:00:00+09:00`;
    const upcoming = !v.done && !v.cancelled && v.ymd >= todayYmd;
    if (v.cancelled) push(v.name, "viewing_cancelled", at, "viewing");
    else if (v.done) push(v.name, "viewing_done", v.thankedAt ?? `${v.ymd}T20:00:00+09:00`, "viewing");
    else if (upcoming) push(v.name, "viewing_scheduled", at, "viewing");
    else push(v.name, "viewing_unconfirmed", `${v.ymd}T20:00:00+09:00`, "viewing");
  }

  // 申込の案内（AIX【申込へ】・手打ちのフォーマット）とお客様のフォーム
  const applyEvents: Array<{ t: number; source: string; names: string[] }> = [];
  for (const r of aixSent) {
    if (r.aix_type !== "application_push") continue;
    const at = r.sent_at ?? r.created_at!;
    const rec = (input.recordedFacts ?? []).find((f) => f.kind === "application_guided" && f.origin === "aix" && Math.abs(ms(f.sent_at) - ms(at)) <= 3 * 60_000);
    const names = rec?.detail?.propertyNames ?? r.property_names ?? [];
    applyEvents.push({ t: ms(at), source: "aix:application_push", names: names.length ? names : (applicationPropertyFromText(r.generated_text) ? [applicationPropertyFromText(r.generated_text)!] : []) });
  }
  for (const m of staffText) {
    if (m.isAix) continue;
    if (APPLY_FORMAT_SENT_RE.test(nfkc(m.text)) && !applyEvents.some((a) => Math.abs(a.t - ms(m.createdAt)) <= 3 * 60_000)) applyEvents.push({ t: ms(m.createdAt), source: "staff_text:format", names: [] });
  }
  let formAt: number | null = null;
  for (const m of cust) {
    const t = m.text ?? "";
    if (t.length > 40 && isApplicationFormMessage(t).detected) { if (formAt === null || ms(m.createdAt) > formAt) formAt = ms(m.createdAt); applyEvents.push({ t: ms(m.createdAt), source: "customer_form", names: [] }); }
  }
  applyEvents.sort((a, b) => a.t - b.t);
  //   物件名の優先: 画面・記録の物件名 → 案内の前後30分のこちらの本文の「〇〇 102号室お申込みさせていただきます」→ 7日以内の前の申込の物件（お客様のフォーム）。
  //   直前の関心の出来事からの推定は付けない（本文と比べて半分外れた・上の内覧と同じ監査）
  let lastApply: { name: string; t: number } | null = null;
  for (const a of applyEvents) {
    let name: string | null = a.names[0] ?? null;
    let how = "";
    if (!name) {
      const near = staffText.filter((m) => Math.abs(ms(m.createdAt) - a.t) <= 30 * 60_000).sort((x, y) => Math.abs(ms(x.createdAt) - a.t) - Math.abs(ms(y.createdAt) - a.t));
      for (const m of near) { const n = applicationPropertyFromText(m.text); if (n) { name = n; how = ":text"; break; } }
    }
    if (!name && lastApply && a.t - lastApply.t <= 7 * DAY) { name = lastApply.name; how = ":prev_apply"; }
    if (name) { push(name, "application", iso(a.t), a.source + how); lastApply = { name, t: a.t }; }
  }

  // 送った建物名へのお客様の言及（送った後の発言だけ・建物の鍵4文字以上）
  obs.sort((a, b) => ms(a.at) - ms(b.at));
  const sentRefs = obs.filter((o) => o.kind === "sent").map((o) => ({ ref: splitPropertyName(o.name, o.roomNo), at: ms(o.at), name: o.name, roomNo: o.roomNo }));
  for (const m of cust) {
    const t = buildingKeyOf(m.text);
    const hit = sentRefs.find((s) => s.ref && s.ref.buildingKey.length >= 4 && s.at < ms(m.createdAt) && t.includes(s.ref.buildingKey));
    if (hit) push(hit.name, "customer_mentioned", m.createdAt, "customer_mention", hit.roomNo);
  }
  obs.sort((a, b) => ms(a.at) - ms(b.at));

  // 当てる
  const findRoom = (ref: RoomRef): { room: (typeof rooms)[number] | null; maybe: string[] } => {
    const maybe: string[] = [];
    let exact: (typeof rooms)[number] | null = null;
    const sameB: Array<(typeof rooms)[number]> = [];
    for (const r of rooms) {
      const m = matchRoomRefs(ref, r.ref);
      if (m === "same_room") { exact = r; break; }
      if (m === "same_building") sameB.push(r);
      if (m === "maybe") maybe.push(r.name);
    }
    if (exact) return { room: exact, maybe };
    if (sameB.length) {
      if (!ref.room) {
        // 部屋の無い言及: その建物のお部屋が1つだけならそこへ（複数なら建物だけの行へ）
        const withRoom = sameB.filter((r) => r.room);
        if (withRoom.length <= 1) return { room: withRoom[0] ?? sameB[0], maybe };
        const bOnly = sameB.find((r) => !r.room);
        return { room: bOnly ?? null, maybe };
      }
      // 部屋のある言及: 建物だけの行が1つなら部屋を付けて寄せる
      const bOnly = sameB.filter((r) => !r.room);
      if (bOnly.length === 1 && sameB.length === 1) return { room: bOnly[0], maybe };
    }
    return { room: null, maybe };
  };
  for (const o of obs) {
    const ref = splitPropertyName(o.name, o.roomNo);
    if (!ref) continue;
    const found = findRoom(ref);
    let r = found.room;
    if (r && !r.room && ref.room) { r.room = ref.room; r.ref = { ...r.ref, room: ref.room, display: ref.display }; r.name = ref.display; r.key = `${r.ref.buildingKey}#${ref.room}`; }
    if (!r) {
      r = {
        ref, key: `${ref.buildingKey}${ref.room ? `#${ref.room}` : ""}`, name: ref.display, building: ref.building, room: ref.room,
        status: "candidate", statusLabel: ROOM_STATUS_LABEL.candidate, vacating: false, estimateSent: false, customerInterest: false, sentByUs: false,
        firstAt: o.at, lastAt: o.at, events: [], maybeSameAs: [],
      };
      rooms.push(r);
      for (const n of found.maybe) if (!r.maybeSameAs.includes(n)) r.maybeSameAs.push(n);
    }
    r.events.push({ kind: o.kind, at: o.at, source: o.source });
    if (ms(o.at) > ms(r.lastAt)) r.lastAt = o.at;
  }
  // 状態を決める
  const latestApplyKey = [...rooms].map((r) => ({ key: r.key, t: Math.max(0, ...r.events.filter((e) => e.kind === "application").map((e) => ms(e.at))) }))
    .filter((x) => x.t > 0).sort((a, b) => b.t - a.t)[0]?.key ?? null;
  for (const r of rooms) {
    let best: RoomStatus = "candidate";
    let bestAt = 0;
    let unavailableAt = 0;
    for (const e of r.events) {
      const t = ms(e.at);
      let st: RoomStatus | null = null;
      if (e.kind === "sent") r.sentByUs = true;
      if (e.kind === "customer_shared" || e.kind === "customer_mentioned") r.customerInterest = true;
      if (e.kind === "check_available") st = "available";
      if (e.kind === "check_vacating") { st = "available"; r.vacating = true; }
      if (e.kind === "check_unavailable") { unavailableAt = Math.max(unavailableAt, t); continue; }
      if (e.kind === "estimate") { st = "estimate_sent"; r.estimateSent = true; }
      if (e.kind === "viewing_scheduled") st = "viewing_scheduled";
      if (e.kind === "viewing_unconfirmed") st = "viewing_unconfirmed";
      if (e.kind === "viewing_done") st = "viewed";
      if (e.kind === "application") st = "applying";
      if (!st) continue;
      if (ROOM_RANK[st] >= ROOM_RANK[best]) { best = st; bestAt = Math.max(bestAt, t); }
    }
    // 内覧予定の後に内覧が済んだ・未確認になった: 済んだ方を正に（予定は過去の出来事）
    if (best === "viewing_scheduled" && r.events.some((e) => e.kind === "viewing_done")) best = "viewed";
    // 申込は状態が申込以降の時で、最後に申込の案内・フォームがあったお部屋だけ「申込中」
    //   申込前（申込準備）・否決や見送りで提案中に戻した後・前に申込んだ別のお部屋は、申込の手前の状態のまま（7beca4f5: 2部屋とも申込中になっていた）
    if (best === "applying" && !(applyActive && latestApplyKey === r.key)) {
      const prev = r.events.filter((e) => e.kind !== "application").reduce<RoomStatus>((b, e) => {
        const map: Partial<Record<RoomEventKind, RoomStatus>> = { check_available: "available", check_vacating: "available", estimate: "estimate_sent", viewing_scheduled: "viewing_scheduled", viewing_unconfirmed: "viewing_unconfirmed", viewing_done: "viewed" };
        const s = map[e.kind]; return s && ROOM_RANK[s] > ROOM_RANK[b] ? s : b;
      }, "candidate");
      best = prev;
    }
    // 募集終了が、それより上の出来事の後に来ていれば終了
    if (unavailableAt && unavailableAt >= bestAt && best !== "applying") best = "ended";
    r.status = best;
    r.statusLabel = ROOM_STATUS_LABEL[best] + (r.vacating && best === "available" ? "(退去予定)" : "");
  }

  // ─── これからの内覧 ───
  let upcoming: UpcomingViewing | null = null;
  const futureV = [...viewings.values()].filter((v) => !v.done && !v.cancelled && v.ymd >= todayYmd).sort((a, b) => a.ymd.localeCompare(b.ymd));
  const roomKeyOfName = (n: string | null): string | null => {
    if (!n) return null; const ref = splitPropertyName(n); if (!ref) return null;
    return findRoom(ref).room?.key ?? null;
  };
  if (futureV[0]) {
    const v = futureV[0];
    upcoming = { ymd: v.ymd, time: v.time, label: viewingLabel(v.ymd, v.time), roomKey: roomKeyOfName(v.name), name: v.name, inferred: v.nameInferred, source: v.fromMeeting ? "meeting_place" : "viewing_history" };
  } else {
    // 待ち合わせの記録は無いが、こちらの出した日時をお客様が受けた（done-state と同じ判定）
    const thread = resolveViewingThread(msgs.map((m) => ({ sender: m.sender, text: m.text ?? "", rawCreatedAt: m.createdAt })), { nowMs: now });
    const vs = resolveViewingScheduled({ appointment: ledger.facts.viewingAppointment, viewingDone: ledger.facts.viewingDone, thread, customerText: cust.at(-1)?.text ?? null, nowMs: now });
    if (vs.scheduled && vs.source !== "meeting_place") {
      const p = parseSlotLabel(vs.label, now);
      if (!p.ymd || p.ymd >= todayYmd) {
        upcoming = { ymd: p.ymd, time: p.time, label: p.ymd ? viewingLabel(p.ymd, p.time) : "日時は履歴で確認", roomKey: null, name: null, inferred: false, source: vs.source === "customer_accepted" ? "customer_accepted" : "staff_meeting_text" };
      }
    }
  }

  // ─── 段階の出来事（時刻順）───
  const ev: StageEvent[] = [];
  if (msgs[0]) ev.push({ t: ms(msgs[0].createdAt), stage: "first", source: "first_message" });
  if (staffText[0]) ev.push({ t: ms(staffText[0].createdAt), stage: "searching", source: "staff_engaged" });
  for (const e of entries) {
    const t = ms(e.at);
    if (!Number.isFinite(t)) continue;
    if (e.kind === "properties_sent" && e.status === "done") ev.push({ t, stage: "proposing", source: `properties_sent:${e.source}` });
    if (e.kind === "pickup_declared" && e.status === "promised" && e.fulfilledBy == null) ev.push({ t, stage: "searching", source: "pickup_promised" });
    if (e.kind === "confirmation_reported" && (e.detail.propertyNames?.length ?? 0) > 0) ev.push({ t, stage: "interested", source: "check_reported" });
    if (e.kind === "estimate_sent") ev.push({ t, stage: "estimate_sent", source: `estimate:${e.source}` });
    if (e.kind === "meeting_place_sent") ev.push({ t, stage: "viewing_scheduled", source: "meeting_place" });
  }
  for (const r of aixSent) if (r.aix_type === "viewing_invite") ev.push({ t: ms(r.sent_at ?? r.created_at), stage: "viewing_arranging", source: "aix:viewing_invite" });
  for (const r of rooms) for (const e of r.events) {
    if (e.kind === "customer_shared" || e.kind === "customer_mentioned") ev.push({ t: ms(e.at), stage: "interested", roomKey: r.key, source: e.kind });
  }
  for (const m of cust) {
    const t = nfkc(m.text);
    // 画像の読み取り文（「[画像] 物件情報 … 内見予約」）はお客様の言葉ではない
    if (IMAGE_TEXT_RE.test(t)) continue;
    const wish = t.split(/\n|(?<=[。！!？?])/).some((s) => CUSTOMER_VIEWING_WISH_RE.test(s) && !VIEWING_WISH_NEGATE_RE.test(s) && !CUSTOMER_VIEWING_CANCEL_RE.test(s));
    if (wish) ev.push({ t: ms(m.createdAt), stage: "viewing_arranging", source: "customer_viewing_wish" });
    if (isDecidedElsewhere(t)) ev.push({ t: ms(m.createdAt), stage: "dropped", source: "customer_decided_elsewhere" });
  }
  for (const v of viewings.values()) {
    if (v.cancelled) continue;
    if (v.done) ev.push({ t: ms(v.thankedAt ?? `${v.ymd}T20:00:00+09:00`), stage: "viewed", source: v.thankedAt ? "viewing_thanks" : "viewing_done" });
    else if (v.ymd < todayYmd) ev.push({ t: ms(`${v.ymd}T20:00:00+09:00`), stage: "viewed", source: "viewing_date_passed" });
    if (v.sentAt && v.fromVh && !v.fromMeeting) ev.push({ t: ms(v.sentAt), stage: "viewing_scheduled", source: "viewing_history" });
  }
  for (const a of applyEvents) ev.push({ t: a.t, stage: "apply_prep", source: a.source });
  ev.sort((a, b) => a.t - b.t);

  // ─── 今の段階 ───
  let stage: CustomerStage = "first";
  let since: number | null = msgs[0] ? ms(msgs[0].createdAt) : null;
  let stageDetail: string | null = null;
  const lastEv = ev.at(-1);
  if (lastEv) { stage = lastEv.stage; since = lastEv.t; }
  if (!staffText.length) stage = "first";
  // 内覧日が過ぎて記録の無い内覧の後は「内覧後（実施未確認）」
  if (stage === "viewed" && lastEv?.source === "viewing_date_passed") stageDetail = "実施は未確認";
  if (stage === "viewing_scheduled" && !upcoming) {
    // 待ち合わせを案内したが日付が過ぎた・読めない → 内覧後（未確認）
    stage = "viewed"; stageDetail = "実施は未確認";
  }
  if (upcoming && !(status && (APPLY_STATUSES.has(status) || WON_STATUSES.has(status) || LOST_STATUSES.has(status)))) {
    stage = "viewing_scheduled";
    stageDetail = upcoming.label;
    const vEv = [...ev].reverse().find((e) => e.stage === "viewing_scheduled");
    since = vEv?.t ?? since;
  }
  // 状態（スタッフが決める・申込以降は正）
  if (status && WON_STATUSES.has(status)) { stage = "won"; stageDetail = null; }
  else if (status && LOST_STATUSES.has(status)) { stage = "dropped"; stageDetail = null; }
  else if (applyActive) {
    stage = "applying"; stageDetail = status === "screening" ? "審査中" : null;
    const hist = [...ev].reverse().find((e) => e.stage === "apply_prep");
    since = hist?.t ?? since;
  }
  // 物件をまだ送っていない「物件検索中」は、それと分かる一言を添える
  if (stage === "searching" && !entries.some((e) => e.kind === "properties_sent" && e.status === "done") && !(input.sentProperties ?? []).length) stageDetail = stageDetail ?? "まだ物件は未送付";

  // ─── 主のお部屋 ───
  const liveRooms = rooms.filter((r) => r.status !== "ended");
  const byRankRecent = (a: RoomState, b: RoomState) => ROOM_RANK[b.status] - ROOM_RANK[a.status] || ms(b.lastAt) - ms(a.lastAt);
  let focus: RoomState | null = null;
  if (upcoming?.roomKey) focus = rooms.find((r) => r.key === upcoming!.roomKey) ?? null;
  if (!focus && (stage === "applying" || stage === "apply_prep")) focus = [...rooms].filter((r) => r.events.some((e) => e.kind === "application")).sort((a, b) => ms(b.lastAt) - ms(a.lastAt))[0] ?? null;
  if (!focus && stage === "interested" && lastEv?.roomKey) focus = rooms.find((r) => r.key === lastEv.roomKey) ?? null;
  if (!focus) {
    const top = [...liveRooms].filter((r) => ROOM_RANK[r.status] >= ROOM_RANK.available || r.customerInterest).sort(byRankRecent)[0];
    focus = top ?? null;
  }

  // ─── 探し続けている印 ───
  const f = ledger.facts;
  let searching: SearchingMark = { active: false, reason: null, since: null };
  const pickupAt = ms(f.pickupPromisedAt);
  if (f.pickupPromisedUnfulfilled && Number.isFinite(pickupAt)) {
    const open = entries.filter((e) => e.kind === "pickup_declared" && e.status === "promised" && e.fulfilledBy == null);
    const watch = open.some((e) => e.detail.watch);
    const limitDays = watch ? 30 : 14;
    if (now - pickupAt <= limitDays * DAY) searching = { active: true, reason: watch ? "watch_promised" : "pickup_promised", since: f.pickupPromisedAt };
  }
  if (!searching.active && focus && ROOM_RANK[focus.status] >= ROOM_RANK.estimate_sent) {
    const focusMainAt = Math.max(...focus.events.filter((e) => ["estimate", "viewing_scheduled", "viewing_done", "application"].includes(e.kind)).map((e) => ms(e.at)), 0);
    const sentAfter = entries.filter((e) => e.kind === "properties_sent" && e.status === "done" && ms(e.at) > focusMainAt && now - ms(e.at) <= 14 * DAY);
    if (focusMainAt && sentAfter.length) searching = { active: true, reason: "sent_after_focus", since: sentAfter[0].at };
  }

  // ─── 食い違い ───
  const conflicts: Conflict[] = [];
  const pastV = [...viewings.values()].filter((v) => v.ymd < todayYmd || v.done).sort((a, b) => a.ymd.localeCompare(b.ymd));
  const lastPast = pastV.at(-1);
  if (status === "viewing" && !upcoming) {
    conflicts.push({ code: "STATUS_VIEWING_STALE", severity: "warn", detail: `状態＝内覧のまま（審査管理の同期）・これからの内覧なし${lastPast ? `（最後の内覧 ${viewingLabel(lastPast.ymd, null)} ${lastPast.done ? "実施済み" : "実施未確認"}）` : "（内覧の記録なし）"}` });
  }
  for (const h of input.viewingHistory ?? []) {
    if (h.status !== "lapsed") continue;
    const v = viewings.get(h.scheduled_date.slice(0, 10));
    if (v?.thankedAt) conflicts.push({ code: "VIEWING_DONE_BUT_LAPSED", severity: "info", detail: `予定表は ${viewingLabel(v.ymd, null)} を「日付経過（未確認）」のまま・内覧後のお礼を送付済み → 実施済みとして読んだ` });
  }
  // 最後の内覧が実施未確認（お礼も完了の記録も無い）で、その後に動きが無い
  if (lastPast && !lastPast.done && !upcoming && !(status && (APPLY_STATUSES.has(status) || WON_STATUSES.has(status) || LOST_STATUSES.has(status)))) {
    const afterT = ms(`${lastPast.ymd}T23:59:00+09:00`);
    const laterStaff = staffText.some((m) => ms(m.createdAt) > afterT);
    conflicts.push({ code: "VIEWING_UNCONFIRMED", severity: "info", detail: `${viewingLabel(lastPast.ymd, lastPast.time)} の内覧は実施の記録（内覧後のお礼・完了）が無い${laterStaff ? "" : "・その後こちらの送信なし"}` });
  }
  const pg = phaseGroup(input.brainPhase);
  const sg = stageGroup(stage);
  if (pg && sg !== "dropped" && pg !== sg) {
    const age = Number.isFinite(ms(input.brainPhaseUpdatedAt)) ? Math.floor((now - ms(input.brainPhaseUpdatedAt)) / DAY) : null;
    conflicts.push({ code: "PHASE_MISMATCH", severity: "info", detail: `ブレインの段階＝${input.brainPhase}${age != null ? `（${age}日前）` : ""}・今の段階＝${STAGE_LABEL[stage]}` });
  }
  if (formAt !== null && status && !APPLY_STATUSES.has(status) && !WON_STATUSES.has(status) && !LOST_STATUSES.has(status) && !input.statusManualBackAt) {
    conflicts.push({ code: "FORM_BUT_PROPOSING", severity: "info", detail: `お客様から申込のフォームが届いている（${viewingLabel(jstYmd(formAt), null)}）・状態は申込前（${status}）` });
  }
  const decided = [...cust].reverse().find((m) => !IMAGE_TEXT_RE.test(m.text ?? "") && isDecidedElsewhere(m.text));
  if (decided && !(status && LOST_STATUSES.has(status))) {
    const afterDecided = ev.filter((e) => e.t > ms(decided.createdAt) && e.source !== "customer_decided_elsewhere" && e.stage !== "first");
    const custAfter = cust.filter((m) => ms(m.createdAt) > ms(decided.createdAt) + 60_000);
    if (!afterDecided.length && custAfter.length <= 2) {
      conflicts.push({ code: "DECIDED_ELSEWHERE_OPEN", severity: "warn", detail: `お客様が他で決めたと言っている（${viewingLabel(jstYmd(ms(decided.createdAt)), null)}）・状態は${status ?? "未設定"}` });
    }
  }
  if ((stage === "apply_prep" || stage === "applying") && !rooms.some((r) => r.events.some((e) => e.kind === "application"))) {
    conflicts.push({ code: "APPLY_NO_ROOM", severity: "info", detail: "申込の物件名が記録に無い（案内の前後に「〇〇号室お申込み」の本文が無い）" });
  }
  if (upcoming && !upcoming.name) conflicts.push({ code: "UPCOMING_VIEWING_NO_ROOM", severity: "info", detail: `${upcoming.label} の内覧の物件名が記録に無い` });

  // ─── 並べる・1行 ───
  const properties = [...rooms].map(({ ref: _ref, ...r }) => r).sort((a, b) => {
    if (focus && a.key === focus.key) return -1;
    if (focus && b.key === focus.key) return 1;
    if ((a.status === "ended") !== (b.status === "ended")) return a.status === "ended" ? 1 : -1;
    return byRankRecent(a, b);
  });
  // 同じ中身の食い違いは1つに（予定表の同じ日の行が2つある会話 d25e07d1）
  const seenC = new Set<string>();
  for (let i = conflicts.length - 1; i >= 0; i--) { const k = conflicts[i].code + conflicts[i].detail; if (seenC.has(k)) conflicts.splice(i, 1); else seenC.add(k); }
  const headline = buildCustomerStateHeadline({ stage, stageDetail, upcoming, focus, properties, searching, conflicts });
  const viewingList: CustomerViewing[] = [...viewings.values()].sort((a, b) => a.ymd.localeCompare(b.ymd)).slice(-8).map((v) => ({
    ymd: v.ymd, time: v.time, name: v.name, thankedAt: v.thankedAt,
    status: v.cancelled ? "cancelled" : v.done ? "done" : v.ymd >= todayYmd ? "scheduled" : "unconfirmed",
  }));
  return {
    stage, stageLabel: STAGE_LABEL[stage], since: since != null && Number.isFinite(since) ? iso(since) : null, stageDetail,
    upcomingViewing: upcoming, viewings: viewingList, focusKey: focus?.key ?? null, properties, searching, conflicts, headline,
    statusRaw: status, brainPhase: input.brainPhase ?? null, brainSituation: input.brainSituation ?? null,
  };
}

/** トークの上の1行: 「🏠 内覧予定 9/28(月)14:00 ジュネスニッコー1003｜見積済 他1件・探し中 ⚠ずれ」 */
export function buildCustomerStateHeadline(s: {
  stage: CustomerStage; stageDetail: string | null; upcoming: UpcomingViewing | null; focus: RoomState | null;
  properties: RoomState[]; searching: SearchingMark; conflicts: Conflict[];
}): string {
  const parts: string[] = [`${STAGE_ICON[s.stage]} ${STAGE_LABEL[s.stage]}`];
  if (s.stageDetail) parts.push(s.stageDetail);
  const focusName = s.focus?.name ?? (s.stage === "viewing_scheduled" ? s.upcoming?.name ?? null : null);
  if (focusName) parts.push(`${focusName}${s.upcoming?.inferred && s.upcoming.roomKey === s.focus?.key ? "(推定)" : ""}`);
  const tail: string[] = [];
  if (s.focus && s.focus.status !== "candidate") {
    const lbl = s.focus.estimateSent && s.focus.status !== "estimate_sent" ? `${s.focus.statusLabel}・見積済` : s.focus.statusLabel;
    // 段階と同じ言葉は繰り返さない（内覧予定の段階で「内覧予定」）
    if (!(s.stage === "viewing_scheduled" && s.focus.status === "viewing_scheduled" && !s.focus.estimateSent)) tail.push(lbl.replace(/^内覧予定・/, ""));
  }
  // 「他N件」は何か進んだお部屋だけ数える（送っただけの候補は数えない。数十件の「他40件」は読めない）
  const others = s.properties.filter((p) => p.key !== s.focus?.key && p.status !== "ended" && (ROOM_RANK[p.status] >= ROOM_RANK.available || p.customerInterest || p.estimateSent)).length;
  if (others > 0) tail.push(`他${others}件`);
  if (s.searching.active && s.stage !== "searching") tail.push("探し中");
  let line = parts.join(" ");
  if (tail.length) line += `｜${tail.join(" ")}`;
  if (s.conflicts.some((c) => c.severity === "warn")) line += " ⚠ずれ";
  return line;
}

/** 1行の材料が無い時（読み込み失敗）の既定 */
export function emptyCustomerState(status: string | null): CustomerState {
  return {
    stage: "first", stageLabel: STAGE_LABEL.first, since: null, stageDetail: null, upcomingViewing: null, viewings: [], focusKey: null, properties: [],
    searching: { active: false, reason: null, since: null }, conflicts: [], headline: "", statusRaw: status, brainPhase: null, brainSituation: null,
  };
}

/** 日付の表示（テスト・監査で使う） */
export function jstMdOf(isoStr: string): string { const p = jstParts(isoStr); return `${p.m}/${p.d}`; }

/**
 * 画面（トークの上の1行と、押すと開く中身）に渡す軽い形（段2・2026-09-26）。
 *   丸ごとだと1会話 最大約30KB（送っただけの候補と出来事の一覧）。画面で見せるのは「何か進んだお部屋」と根拠の直近だけなので、
 *   候補は件数だけにし、出来事はお部屋ごとに新しい方から maxEvents 件に絞る。ブレイン・生成は getCustomerState の丸ごとを使う（ここは画面専用）。
 */
export type CustomerStateView = Omit<CustomerState, "properties" | "brainSituation"> & {
  properties: RoomState[];
  /** 送っただけの候補（画面の一覧には出さない件数） */
  candidateCount: number;
  /** 進んだお部屋のうち maxRooms を超えて一覧から外した件数 */
  hiddenNotable: number;
  propertiesTotal: number;
};
export function compactCustomerStateForView(s: CustomerState, opts: { maxRooms?: number; maxEvents?: number } = {}): CustomerStateView {
  const maxRooms = opts.maxRooms ?? 12;
  const maxEvents = opts.maxEvents ?? 6;
  const notable = (p: RoomState) => p.key === s.focusKey || p.status !== "candidate" || p.customerInterest || p.estimateSent || p.vacating;
  const picked = s.properties.filter(notable).sort((a, b) => {
    if (a.key === s.focusKey) return -1;
    if (b.key === s.focusKey) return 1;
    const ra = a.status === "ended" ? -1 : ROOM_RANK[a.status];
    const rb = b.status === "ended" ? -1 : ROOM_RANK[b.status];
    if (ra !== rb) return rb - ra;
    return (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
  });
  // 同じ日の同じ出来事（写真と本文の2通の送付・見積の2通）は1つに畳んでから直近だけ残す（「9/21 送付 · 9/21 送付」を読ませない）
  const dedupe = (evs: RoomEvent[]) => evs.filter((e, i) => { const prev = evs[i - 1]; return !prev || prev.kind !== e.kind || jstYmd(prev.at) !== jstYmd(e.at); });
  const properties = picked.slice(0, maxRooms).map((p) => ({ ...p, events: dedupe(p.events).slice(-maxEvents) }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { properties: _all, brainSituation: _sit, ...rest } = s;
  return { ...rest, properties, candidateCount: s.properties.length - picked.length, hiddenNotable: Math.max(0, picked.length - maxRooms), propertiesTotal: s.properties.length };
}

// ═════════════════════════════════════════════════════════════════════════════
// ブレイン・返信生成に渡す形（段3・2026-09-26）
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ブレインのプロンプト（毎回変わる所・キャッシュの前置きには入れない）に渡す「今の状況」のブロック。
 *   旧: 【内覧履歴・予定】（viewing_history の行をそのまま・lapsed は「実施は未確認」）＋【内覧済み顧客・重要】（完了が1回でもあれば申込へを優先）。
 *   新: resolveCustomerState の値を決定論で並べる（段階・主のお部屋・進んだお部屋・探し続けているか・内覧の一覧・warn の食い違い）。
 *   セーブデータ（LLM の要約の【提案物件】【見送り・終了】）と食い違う時はこちらが正（送った記録と本文から毎回決め直した値）。
 *   長さの上限: お部屋は主＋進んだ物 最大8・内覧は直近6（1会話で約1,000字まで）
 */
export function buildCustomerStateBrainBlock(s: CustomerState, opts: { maxRooms?: number } = {}): string {
  const maxRooms = opts.maxRooms ?? 8;
  const md = (isoStr: string | null | undefined) => (isoStr && Number.isFinite(ms(isoStr)) ? jstMdOf(isoStr) : "");
  const lines: string[] = ["\n【お客様の今の状況（決定論・送った記録と本文から毎回決め直した値。セーブデータの要約・前回の段階の推定と食い違う時はこちらが正）】"];
  lines.push(`- 今の段階: ${s.stageLabel}${s.stageDetail ? `（${s.stageDetail}）` : ""}${s.since ? `・${md(s.since)}〜` : ""}`);
  const roomLine = (p: RoomState) => {
    const marks = [p.estimateSent && p.status !== "estimate_sent" ? "見積済" : null, p.customerInterest ? "お客様が指名" : null, !p.sentByUs ? "お客様の持ち込み" : null].filter(Boolean);
    const lastEv = p.events.at(-1);
    return `${p.name} — ${p.statusLabel}${marks.length ? `・${marks.join("・")}` : ""}${lastEv ? `（${md(lastEv.at)}）` : ""}${p.maybeSameAs.length ? `〔${p.maybeSameAs.slice(0, 2).join("・")} と同じかは未確認〕` : ""}`;
  };
  const focus = s.properties.find((p) => p.key === s.focusKey) ?? null;
  if (focus) lines.push(`- 主のお部屋: ${roomLine(focus)}`);
  const notable = s.properties.filter((p) => p.key !== s.focusKey && p.status !== "ended" && (p.status !== "candidate" || p.customerInterest || p.estimateSent));
  if (notable.length) lines.push(`- ほかに進んだお部屋（${notable.length}件）: ${notable.slice(0, maxRooms).map(roomLine).join("／")}${notable.length > maxRooms ? ` ほか${notable.length - maxRooms}件` : ""}`);
  const ended = s.properties.filter((p) => p.status === "ended");
  if (ended.length) lines.push(`- 募集終了のお部屋: ${ended.slice(0, 5).map((p) => p.name).join("・")}${ended.length > 5 ? ` ほか${ended.length - 5}件` : ""}（再提案・募集状況の再確認をしない）`);
  const candidates = s.properties.filter((p) => p.key !== s.focusKey && p.status === "candidate" && !p.customerInterest && !p.estimateSent).length;
  if (candidates) lines.push(`- 送っただけの候補: ${candidates}件`);
  if (!s.properties.length) lines.push("- お部屋: まだ送った・話に出たお部屋なし");
  if (s.searching.active) {
    const why = s.searching.reason === "pickup_promised" ? "こちらがピックアップを約束してまだ送っていない" : s.searching.reason === "watch_promised" ? "新着が出たら送ると約束している" : "見積・内覧・申込の後にも別のお部屋を送っている";
    lines.push(`- 探し続けている: はい（${why}・${md(s.searching.since)}〜）`);
  }
  if (s.viewings.length) {
    lines.push(`- 内覧: ${s.viewings.slice(-6).map((v) => `${viewingLabel(v.ymd, v.time)} ${v.name ?? "物件名の記録なし"}（${VIEWING_STATUS_LABEL[v.status]}${v.status === "done" && v.thankedAt ? "・内覧後のお礼を送付済み" : ""}）`).join("／")}`);
  }
  const warns = s.conflicts.filter((c) => c.severity === "warn");
  if (warns.length) lines.push(`- 記録のずれ（古い値を正にしない）: ${warns.map((c) => c.detail).join("／")}`);
  return lines.join("\n");
}

/** 内覧の話が今あるか（返信生成の「内覧」の手引きを使ってよいか・status=viewing の残りでは使わない） */
export function customerStateHasViewing(s: Pick<CustomerState, "stage" | "upcomingViewing" | "viewings"> | null | undefined, nowMs: number = Date.now()): boolean {
  if (!s) return false;
  if (s.upcomingViewing) return true;
  if (s.stage === "viewing_arranging" || s.stage === "viewing_scheduled") return true;
  // 内覧後（直近7日に内覧した）も内覧の手引き（内覧後のお礼・感想）の範囲
  const today = jstYmd(nowMs);
  const weekAgo = jstYmd(nowMs - 7 * DAY);
  return s.stage === "viewed" && s.viewings.some((v) => v.status === "done" && v.ymd >= weekAgo && v.ymd <= today);
}
