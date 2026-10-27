// app/lib/link-brain-watch.ts — つなぎのブレイン 段1「見張り」（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-20 竹内さん（設計知見 e07a8b73・98bca000・72d92e4f）: 線を管轄する『つなぎのブレイン』を作る。
//   仕事 ①共通の芯を配る ②渡るべき物が渡っているかを見張る ③切れを次の一手かスタッフへ ④毎晩型で数える。
//   LINE のブレインと同じ構造（司令塔＋分野の読み手・決まった計算が先）。ここは段1＝②と④の決まった計算だけ。
//   設計の案: memory/design_docs/link-brain-design.md（弱いつなぎ①〜⑤＋10/21 の答え A1・申込歴・やることリスト）
//
// 構造: 分野の読み手（READERS・つなぎ1本に1つ）が会話ごとに「渡るべき物が次のブレインに届いたか」を ok / 切れ（型つき）/ まだ（判定前）で返し、
//   司令塔（watchLinks）が窓と熟す時間で数えてまとめる。判定は今ある関数を使う（約束の並び buildPromiseQueue・確認の対象→ピッカー checkPatternForConfirmTopic 等）。
//   熟す時間（matureMs）: 約束は 72時間（PROMISE_QUEUE_MAX_AGE_MS）たって初めて「果たしていない」と言える。数える窓はつなぎごとに熟す時間だけ前へずらす
//   ＝毎晩の数えが日ごとに重ならない（[from-熟す, to-熟す] に起点がある物だけ）。
// テスト: app/lib/__tests__/link-brain-watch.test.ts
import { buildPromiseQueue, promisesInStaffText, PROMISE_QUEUE_MAX_AGE_MS, PROMISE_QUEUE_NOTE_PREFIX, type PromiseStep, type QueueAixLog, type QueueMsg } from "./promise-queue";
import { linkPromisePickerEnabled, confirmTopicsForCheckPattern, confirmObjectOf, checkPatternForConfirmTopic, findConfirmReportSentence, isConfirmPartyObject } from "./action-ledger";
import { isPreApplyForNudge } from "./apply-stage-nudge";
import { REAPPLY_MEMO_ID, reapplyMarkEnabled } from "./reapply-customer";
import { maskPII } from "./pii-mask";
import { PICKUP_FRESH_DAYS } from "./two-stage";

const H = 3600_000;
const DAY = 24 * H;

/** 切替: やることリストへ切れを足す（既定 off・on で入る）。見張りの数え（cron_run_logs）は切替に関係なく行う */
export function linkBrainTodoEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINK_BRAIN_TODO ?? "").trim().toLowerCase() === "on";
}
/** 切替: 毎晩の見張り（既定 on・止める =off）。外へ（LINE）は何も送らない */
export function linkBrainWatchEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINK_BRAIN_WATCH ?? "").trim().toLowerCase() !== "off";
}

// ───────── 材料（DB の行をそのまま・読むだけ） ─────────
export type LinkConversation = { id: string; customer_name: string | null; status: string | null; status_manual_back_at?: string | null };
export type LinkMessage = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export type LinkAixLog = { aix_type: string; check_pattern: string | null; sent_at: string | null; created_at: string; estimate_sent?: boolean | null; generated_text?: string | null; send_mode?: string | null };
export type LinkFact = { kind: string; status: string; sent_at: string; detail?: Record<string, unknown> | null };
export type LinkStaffAix = { at: string; burst?: boolean; aix_type: string; check_pattern?: string | null };
export type LinkStaffText = { at: string; text: string | null; burst?: boolean };
export type LinkTurn = { customer_turn_at: string; brain_action: string | null; brain_check_pattern: string | null; staff_first_at: string | null; brain_at?: string | null; staff_aix: LinkStaffAix[] | null; staff_texts?: LinkStaffText[] | null };
export type LinkAixItem = { action: string; check_pattern: string | null; status: string; created_at: string; done_at: string | null; resolution_note: string | null; dismissed_reason?: string | null };
export type LinkPickup = { created_at: string; sent_at: string | null; expired_at?: string | null; status: string | null; verdict: string | null; summary_text?: string | null; search_conditions?: unknown };
export type LinkJudgment = { created_at: string; profile_snapshot: unknown };
export type LinkMemoItem = { text?: string | null; sourceAt?: string | null; updatedAt?: string | null };

/** 1会話分の材料 */
export type LinkConvInput = {
  conv: LinkConversation;
  messages: ReadonlyArray<LinkMessage>;
  aixLogs: ReadonlyArray<LinkAixLog>;
  facts: ReadonlyArray<LinkFact>;
  turns: ReadonlyArray<LinkTurn>;
  aixItems: ReadonlyArray<LinkAixItem>;
  pickups: ReadonlyArray<LinkPickup>;
  judgments: ReadonlyArray<LinkJudgment>;
  memoItems: ReadonlyArray<LinkMemoItem>;
};

// ───────── つなぎの一覧（弱いつなぎ①〜⑤＋10/21） ─────────
export type LinkId =
  | "promise_picker"      // ① 約束の台帳 → AIX のピッカー（確認・見積・写真・内覧の約束をピッカーで果たしたか）
  | "result_brain"        // ② 約束の結果（確認済み・届いた物件）→ LINE のブレインの次の一手
  | "reaction_condition"  // ③ お客様の反応（外す地域・広さ）→ 物件の条件・メモ
  | "brain_second"        // ④ ブレイン（約束の中身）→ AIX の2通目
  | "pickup_vs_watch"     // ⑤ 新着（見張り）とピックアップの区別
  | "direct_aix"          // 10/21 A1 確かめれば分かる問い → すぐ AIX（ブレインも同じ AIX か）
  | "reapply_memo"        // 10/21 申込から戻ったお客様 → メモ『申込歴あり（再探し）』
  | "staff_todo";         // 10/21 要対応（やることリスト）→ スタッフが果たしたか

export const LINK_JA: Record<LinkId, string> = {
  promise_picker: "①約束→ピッカー",
  result_brain: "②約束の結果→ブレイン",
  reaction_condition: "③反応→物件の条件",
  brain_second: "④ブレイン→2通目",
  pickup_vs_watch: "⑤新着とピックアップ",
  direct_aix: "A1 すぐAIX",
  reapply_memo: "申込歴→メモ",
  staff_todo: "要対応→スタッフ",
};
export const LINK_IDS = Object.keys(LINK_JA) as LinkId[];
/** やることリストへ足した要対応の印（aix_action_items.resolution_note）。同じ夜に cron が2回走っても同じ約束を2度立てない（立った物は「要対応は立った」に数える） */
export const LINK_BRAIN_NOTE_PREFIX = "rule:link_brain";

/** 切れの型の日本語（数えの表に出す） */
export const BREAK_JA: Record<string, string> = {
  no_picker_key: "確認の対象がピッカーに結べない",
  unsent_queued: "72時間果たしていない（要対応は立った）",
  unsent_not_queued: "72時間果たしていない（要対応も無い）",
  hand_only: "手打ちで果たした（ピッカー未使用）",
  picker_mismatch: "別のピッカーで返した",
  pickup_ready_brain_other: "送れる物件が揃ったのにブレインが物件の AIX にしない",
  check_result_brain_other: "確認の結果を返す番でブレインが物件確認したにしない",
  ignored_in_search: "外した地域が後の検索に残る",
  not_recorded: "反応がメモ・条件に入っていない",
  second_lacks_promise: "2通目に約束の中身が無い",
  kind_unrecorded: "ピックアップの宣言に新着/ピックアップの印が無い",
  mislabeled: "新着とピックアップのボタンの取り違え",
  brain_not_direct: "スタッフはすぐ AIX・ブレインは別の一手",
  memo_missing: "メモに申込歴の印が無い",
  late_done: "要対応を果たすまで24時間超",
  stale_pending: "要対応が24時間以上残る",
  dismissed: "要対応を果たさないまま48時間で片付けられた",
};

export type LinkVerdict = { link: LinkId; at: string; ok: boolean; breakType?: string; detail?: string;
  /** やることリストへ足す時の AIX（切れの一部だけ） */ todo?: { action: string; checkPattern: string | null } };

export type LinkWindow = { fromMs: number; toMs: number; nowMs: number };

// ───────── 共通の手伝い ─────────
const PROPERTY_AIX = new Set(["property_send", "property_recommendation", "property_send_new_arrival", "property_send_widen"]);
const RESULT_AIX = new Set(["property_check_result", "estimate_sheet"]);
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const toQueueMsgs = (m: ReadonlyArray<LinkMessage>): QueueMsg[] => m.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated }));
const toQueueLogs = (l: ReadonlyArray<LinkAixLog>): QueueAixLog[] => l.map((x) => ({ aixType: x.aix_type, checkPattern: x.check_pattern, sentAt: x.sent_at ?? x.created_at, estimateSent: x.estimate_sent, text: x.generated_text }));
/** 熟す時間をずらした窓に起点が入るか */
const inWin = (atMs: number, w: LinkWindow, matureMs: number) => Number.isFinite(atMs) && atMs >= w.fromMs - matureMs && atMs < w.toMs - matureMs && atMs <= w.nowMs - matureMs;
/** その時点で開いている約束（atMs より前の約束で、まだ果たしていない） */
function openStepsAt(input: LinkConvInput, atMs: number): PromiseStep[] {
  return buildPromiseQueue(toQueueMsgs(input.messages), toQueueLogs(input.aixLogs), atMs - 1, { windowDays: 7 })
    .filter((s) => s.status === "pending" && Date.parse(s.promisedAt) < atMs);
}
const burstAix = (t: LinkTurn) => (t.staff_aix ?? []).filter((a) => a.burst).map((a) => (a.aix_type === "property_check" ? "property_check_result" : a.aix_type));

// ───────── 分野の読み手（つなぎ1本に1つ） ─────────
type Reader = { link: LinkId; matureMs: number; read: (input: LinkConvInput, w: LinkWindow) => LinkVerdict[] };

/** ① 約束→ピッカー: 確認・見積・写真・内覧の確認の約束（探し続ける約束・後に回した依頼は除く）が、72時間のうちに結ばれたピッカーの AIX で果たされたか */
const promisePicker: Reader = {
  link: "promise_picker", matureMs: PROMISE_QUEUE_MAX_AGE_MS,
  read(input, w) {
    const steps = buildPromiseQueue(toQueueMsgs(input.messages), toQueueLogs(input.aixLogs), w.nowMs, { windowDays: Math.ceil((w.nowMs - w.fromMs) / DAY) + 4 });
    const out: LinkVerdict[] = [];
    for (const s of steps) {
      if (s.kind === "pickup" || s.watch || s.deferred) continue;
      const at = Date.parse(s.promisedAt);
      if (!inWin(at, w, this.matureMs)) continue;
      const base = { link: this.link, at: s.promisedAt, detail: `${s.kind}:${s.object ?? "-"}「${s.evidence}」` } as const;
      if (s.kind === "confirm" && !s.checkPattern) { out.push({ ...base, ok: false, breakType: "no_picker_key" }); continue; }
      if (s.status === "dropped") { out.push({ ...base, ok: true }); continue; }
      const doneMs = ms(s.doneAt);
      if (s.status === "pending" || doneMs - at > PROMISE_QUEUE_MAX_AGE_MS) {
        const queued = input.aixItems.some((i) => [PROMISE_QUEUE_NOTE_PREFIX, LINK_BRAIN_NOTE_PREFIX].some((p) => (i.resolution_note ?? "").startsWith(p)) && ms(i.created_at) >= at - 60_000);
        out.push({ ...base, ok: false, breakType: queued ? "unsent_queued" : "unsent_not_queued", todo: s.status === "pending" && !queued ? { action: s.action, checkPattern: s.checkPattern } : undefined });
        continue;
      }
      if (s.doneBy === "返信") { out.push({ ...base, ok: false, breakType: "hand_only" }); continue; }
      if (s.checkPattern) {
        const log = input.aixLogs.find((l) => (l.sent_at ?? l.created_at) === s.doneAt);
        if (log && log.check_pattern && log.check_pattern !== s.checkPattern) { out.push({ ...base, ok: false, breakType: "picker_mismatch", detail: `${base.detail} → ${log.check_pattern}` }); continue; }
      }
      out.push({ ...base, ok: true });
    }
    return out;
  },
};

/**
 * 送れる物件（property_pickups の未送付・ブレインが通す pass）がその番の時点で揃っているか（30分の余裕・保留 hold は数えない）。
 *   新しさはブレインの材料（two-stage.ts freshPickupReady）と同じ線: 期限切れ（expired_at）でない・作って PICKUP_FRESH_DAYS 日以内・最後に物件を送った時刻より後に作った。
 *   （レビュー 2026-10-21: 新しさを見ないと、送らずに残った古いピックアップ（220〜400時間前）が何日も「揃った」になり、②の切れ 14件中 13件がこれだった）
 */
export function pickupReadyAt(pickups: ReadonlyArray<LinkPickup>, atMs: number, lastPropertiesSentMs: number = NaN): boolean {
  return pickups.some((k) => {
    const c = ms(k.created_at);
    if (!Number.isFinite(c) || c > atMs + 30 * 60_000 || atMs - c > PICKUP_FRESH_DAYS * DAY) return false;
    if (k.expired_at && ms(k.expired_at) <= atMs) return false;
    if (Number.isFinite(lastPropertiesSentMs) && c <= lastPropertiesSentMs) return false;
    return (!k.sent_at || ms(k.sent_at) > atMs) && k.status !== "misattributed" && k.verdict === "pass";
  });
}
/** その時点より前に最後に物件を送った時刻（sent_facts properties_sent done・無ければ NaN） */
function lastPropertiesSentBefore(facts: ReadonlyArray<LinkFact>, atMs: number): number {
  const t = facts.filter((f) => f.kind === "properties_sent" && f.status === "done" && ms(f.sent_at) < atMs).map((f) => ms(f.sent_at)).filter(Number.isFinite);
  return t.length ? Math.max(...t) : NaN;
}

/** ② 約束の結果→ブレイン: 開いた約束があり結果が手元にある番で、ブレインが結果を送る AIX を次の一手にしたか */
const resultBrain: Reader = {
  link: "result_brain", matureMs: 6 * H,
  read(input, w) {
    const out: LinkVerdict[] = [];
    for (const t of input.turns) {
      const at = ms(t.customer_turn_at);
      if (!inWin(at, w, this.matureMs) || !t.staff_first_at || t.brain_at === null) continue; // ブレインが読んでいない番は数えない
      const open = openStepsAt(input, at);
      const brain = t.brain_action ?? "";
      const staff = burstAix(t);
      // 確認の結果はお礼の番の後で送る事が多い（すぐの並びに入らない）＝この番の後のスタッフの AIX 全部で見る
      const staffAll = (t.staff_aix ?? []).map((a) => (a.aix_type === "property_check" ? "property_check_result" : a.aix_type));
      // 2026-10-28 調べ（あかり 10/26 の②の切れ 2件）: お客様が持ち込んだ物件の募集状況を確かめるために拡張で探した行（送る為の行ではない）が
      //   「送れる物件が揃った」に数えられ、確認の約束を果たした番（ブレイン=物件確認した・スタッフ=物件確認した）まで切れにしていた。
      //   確認の約束が開いていてスタッフがこの番の後に物件確認したで果たした時は、確認の側で見る（LINK_WATCH_CHECK_FIRST=on の時だけ・既定 off）
      const checkFirst = (process.env.LINK_WATCH_CHECK_FIRST ?? "").toLowerCase() === "on"
        && open.some((s) => s.kind === "check" || s.kind === "confirm" || s.kind === "photo") && staffAll.includes("property_check_result");
      if (!checkFirst && open.some((s) => s.kind === "pickup") && pickupReadyAt(input.pickups, at, lastPropertiesSentBefore(input.facts, at))) {
        const ok = PROPERTY_AIX.has(brain);
        out.push({ link: this.link, at: t.customer_turn_at, ok, breakType: ok ? undefined : "pickup_ready_brain_other", detail: `ブレイン=${brain || "返信"} スタッフ=${staff.join("+") || "手打ち"}` });
      } else if (open.some((s) => s.kind === "check" || s.kind === "confirm" || s.kind === "photo") && staffAll.includes("property_check_result")) {
        const ok = brain === "property_check_result";
        out.push({ link: this.link, at: t.customer_turn_at, ok, breakType: ok ? undefined : "check_result_brain_other", detail: `ブレイン=${brain || "返信"} 約束=${open.map((s) => s.object ?? s.kind).join("・")}` });
      }
    }
    return out;
  },
};

/**
 * お客様の反応のうち、物件の条件に戻すべき物（決まった語で拾える物だけ）。
 *   外す地域: 「肥後橋は外して」「〇〇以外で」「〇〇はNG」 → token=地名
 *   広さ: 「リビング10帖以上」「25㎡以上」 → token=数＋単位
 */
const EXCLUDE_RE = /([一-龯ァ-ヶー々]{2,8})(?:駅|エリア|周辺|方面|辺り|あたり)?(?:は|も)?(?:外して|外す|除いて|以外で|以外が|NG|ＮＧ|避けたい|やめて|無しで|なしで)/g;
const SIZE_RE = /(?:リビング|LDK|洋室|お部屋|部屋)?[^\n。]{0,4}?([0-9０-９]{1,2}(?:[.．][0-9])?)\s*(帖|畳|㎡|平米)以上/g;
/** 地名でない語（「保証人は無しで」「礼金なしで」等は条件の話で地域ではない） */
const NOT_PLACE_RE = /^(?:家賃|初期費用|ロフト|ユニットバス|和室|一階|バス|トイレ|洗濯機|築年数|条件|それ|こちら|お部屋|物件|管理費|定期借家|角部屋|北向き|募集)$|保証|敷金|礼金|手数料|ペット|駐車|駐輪|鍵|クリーニング|費用|保険|更新|家具|エアコン|審査|電話|連絡|内覧|内見/;
/** 地名でない副詞・時の語（「一旦無しで」「とりあえずなしで」「今回は無しで」） */
const NOT_PLACE_ADVERB_RE = /^(?:一旦|いったん|とりあえず|取り敢えず|ひとまず|今回|今は|今回は|今のところ|当面|しばらく)$|一旦|とりあえず/;
export function reactionTokensOf(text: string | null | undefined): Array<{ kind: "exclude" | "size"; token: string }> {
  const t = String(text ?? "").normalize("NFKC");
  const out: Array<{ kind: "exclude" | "size"; token: string }> = [];
  // 2026-10-28 調べ（③の切れ 2件＝10/21 孝成さんの「一旦無しで通して貰ってもいいですか」＝連帯保証人の話・申込の後）: 「一旦」「とりあえず」等の副詞を
  //   外す地域と読んでいた。LINK_WATCH_REACTION_STRICT=on の時だけ副詞・時の語を地名にしない（既定 off）
  const strict = (process.env.LINK_WATCH_REACTION_STRICT ?? "").toLowerCase() === "on";
  for (const m of t.matchAll(EXCLUDE_RE)) if (!NOT_PLACE_RE.test(m[1]) && !(strict && NOT_PLACE_ADVERB_RE.test(m[1]))) out.push({ kind: "exclude", token: m[1] });
  for (const m of t.matchAll(SIZE_RE)) out.push({ kind: "size", token: `${m[1]}${m[2] === "畳" ? "帖" : m[2] === "平米" ? "㎡" : m[2]}` });
  return out;
}
const jsonText = (v: unknown) => { try { return typeof v === "string" ? v : JSON.stringify(v ?? ""); } catch { return ""; } };

/** ③ 反応→物件の条件: 物件を送った後のお客様の反応（外す地域・広さ）が、メモ・ブレインの見立て（profile_snapshot）・後の検索の条件に入ったか */
const reactionCondition: Reader = {
  link: "reaction_condition", matureMs: 72 * H,
  read(input, w) {
    const out: LinkVerdict[] = [];
    const firstSentMs = Math.min(...input.facts.filter((f) => f.kind === "properties_sent" && f.status === "done").map((f) => ms(f.sent_at)).filter(Number.isFinite), Infinity);
    if (!Number.isFinite(firstSentMs)) return out;
    for (const m of input.messages) {
      if (m.sender !== "customer") continue;
      const at = ms(m.created_at);
      if (!inWin(at, w, this.matureMs) || at < firstSentMs) continue;
      for (const r of reactionTokensOf(m.text)) {
        const num = r.token.replace(/[^0-9.]/g, "");
        const inText = (s: string) => (r.kind === "exclude" ? s.includes(r.token) : s.includes(r.token) || (num.length > 0 && new RegExp(`${num.replace(".", "\\.")}\\s*(?:帖|畳|㎡)`).test(s)));
        const memo = input.memoItems.some((i) => inText(String(i.text ?? "")));
        const judged = input.judgments.some((j) => ms(j.created_at) > at && inText(jsonText((j.profile_snapshot as { notes?: unknown } | null)?.notes)));
        const later = input.pickups.filter((p) => ms(p.created_at) > at);
        const base = { link: this.link, at: m.created_at, detail: `${r.kind}:${r.token}` } as const;
        if (r.kind === "exclude" && later.some((p) => inText(jsonText(p.search_conditions)) || inText(String(p.summary_text ?? "")))) { out.push({ ...base, ok: false, breakType: "ignored_in_search" }); continue; }
        if (memo || judged) { out.push({ ...base, ok: true }); continue; }
        out.push({ ...base, ok: false, breakType: "not_recorded" });
      }
    }
    return out;
  },
};

/** 約束の中身を表す語（対象の語＋その対象のピッカーの語） */
export function promiseWordsOf(s: Pick<PromiseStep, "object" | "checkPattern">): string[] {
  const words = new Set<string>();
  if (s.object) for (const x of s.object.split(/[・、,]/)) if (x.trim().length >= 2) words.add(x.trim());
  for (const x of confirmTopicsForCheckPattern(s.checkPattern)) words.add(x);
  // 募集状況の確認の答えは「募集中」「空き」「お申込みが入って」等で書く（語そのものは出ない）
  if (words.has("募集状況") || words.has("空室")) for (const x of ["募集", "空き", "空室", "お申込", "申込が入"]) words.add(x);
  return [...words];
}

/** ④ ブレイン→2通目: 中身のある約束を果たした AIX の本文（2通目）と直後5分のこちらの文に、約束の中身の語が入ったか */
const brainSecond: Reader = {
  link: "brain_second", matureMs: 0,
  read(input, w) {
    const out: LinkVerdict[] = [];
    const steps = buildPromiseQueue(toQueueMsgs(input.messages), toQueueLogs(input.aixLogs), w.nowMs, { windowDays: Math.ceil((w.nowMs - w.fromMs) / DAY) + 4 });
    for (const s of steps) {
      if (s.status !== "done" || !s.doneBy?.startsWith("AIX") || (s.kind !== "confirm" && s.kind !== "check")) continue;
      const words = promiseWordsOf(s);
      if (!words.length) continue;
      const at = ms(s.doneAt);
      if (!inWin(at, w, this.matureMs)) continue;
      const log = input.aixLogs.find((l) => (l.sent_at ?? l.created_at) === s.doneAt);
      // 答えを運ぶのは【物件確認した】（見積書・保証会社について 等で果たした確認は、答えが別の形＝ここでは見ない）
      if (log?.aix_type !== "property_check_result") continue;
      // 2026-10-28 調べ（④の切れ＝10/23 未来穂さん）: AIX の記録が「開いただけ」（sent_at・本文なし・07:59）で、実際の送信（答え「celeste東中島 504号室、
      //   現在募集中」）は10分後の 08:09 だった＝5分の窓の外で「2通目に約束の中身が無い」と数えていた。本文の無い記録の時は30分まで見る
      //   （LINK_WATCH_SECOND_WIDE=on の時だけ・既定 off）
      const wide = (process.env.LINK_WATCH_SECOND_WIDE ?? "").toLowerCase() === "on" && !log?.generated_text && !log?.sent_at;
      const follow = input.messages.filter((m) => m.sender !== "customer" && ms(m.created_at) >= at - 60_000 && ms(m.created_at) <= at + (wide ? 30 : 5) * 60_000).map((m) => m.text ?? "").join("\n");
      const body = `${log?.generated_text ?? ""}\n${follow}`;
      const ok = words.some((x) => body.includes(x));
      out.push({ link: this.link, at: s.doneAt!, ok, breakType: ok ? undefined : "second_lacks_promise", detail: `${s.doneBy} 約束=${words.join("・")}` });
    }
    return out;
  },
};

/**
 * ⑤ 新着とピックアップ: 新着の約束を【物件ピックアップ】・ピックアップの約束を【物件オススメ】で果たしていないか
 *   ※ 宣言の記録（sent_facts.detail.watch）は新着の時だけ true を書き、ピックアップの時は書かない（無い＝ピックアップ・action-ledger の作り）。
 *     「印が無い」を切れに数えると宣言のほぼ全部が切れになる（14日で 100/105）＝記録の作りの数え違い → 数えない（レビュー 2026-10-21）
 */
const pickupVsWatch: Reader = {
  link: "pickup_vs_watch", matureMs: 0,
  read(input, w) {
    const out: LinkVerdict[] = [];
    const steps = buildPromiseQueue(toQueueMsgs(input.messages), toQueueLogs(input.aixLogs), w.nowMs, { windowDays: Math.ceil((w.nowMs - w.fromMs) / DAY) + 4 });
    for (const s of steps) {
      if (s.kind !== "pickup" || s.status !== "done" || !s.doneBy?.startsWith("AIX") || !inWin(ms(s.doneAt), w, this.matureMs)) continue;
      const log = input.aixLogs.find((l) => (l.sent_at ?? l.created_at) === s.doneAt);
      if (!log || !PROPERTY_AIX.has(log.aix_type)) continue;
      const wrong = isPickupButtonMislabeled(!!s.watch, log.aix_type, log.send_mode);
      out.push({ link: this.link, at: s.doneAt!, ok: !wrong, breakType: wrong ? "mislabeled" : undefined, detail: `${s.watch ? "新着" : "ピックアップ"}の約束→${log.aix_type}${log.send_mode ? `/${log.send_mode}` : ""}` });
    }
    return out;
  },
};

/**
 * ⑤ の取り違えか。新着のボタンは 物件オススメ（新着・1件）か 物件ピックアップした の「新着まとめ」（send_mode=new_arrival・条件を広げた／代替も可）。
 *   2026-10-21 LINK_PROMISE_PICKER: 旧は send_mode を見ず、新着の約束を 物件ピックアップした で果たした3件を全部取り違えに数えていたが、
 *   3件とも send_mode=new_arrival（新着まとめ）＝正しい新着のボタンだった（数え違い）。send_mode が初回（normal）・不明の時だけ取り違え
 */
/**
 * 2026-10-28 竹内さんの決定（owner_questions・「全部いれてよい」）: ピックアップの約束を、見つかったのが1件の時に AIX【物件オススメ】で果たすのは正しい
 *   （1件ならオススメ・複数ならピックアップ＝新着の約束 ef5b7dbe・代わりの物件 5cb4bd2f と同じ考え）。14日の切れ 9件は全部この形の数え違い。
 *   LINK_WATCH_PICKUP_BY_RECOMMEND=on の時は取り違えに数えない（既定 off）
 */
export function linkWatchPickupByRecommendEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINK_WATCH_PICKUP_BY_RECOMMEND ?? "").trim().toLowerCase() === "on";
}
export function isPickupButtonMislabeled(watch: boolean, aixType: string, sendMode: string | null | undefined, env?: Record<string, string | undefined>): boolean {
  if (!watch) return aixType === "property_recommendation" && !linkWatchPickupByRecommendEnabled(env);
  if (aixType !== "property_send") return false;
  if (!linkPromisePickerEnabled(env)) return true;
  return !["new_arrival", "widen", "alternative"].includes(String(sendMode ?? ""));
}

/** A1 すぐ AIX: 約束の無い番でスタッフがすぐ結果の AIX（物件確認した・見積書送る）を送った時、ブレインも同じ AIX だったか */
const directAix: Reader = {
  link: "direct_aix", matureMs: 6 * H,
  read(input, w) {
    const out: LinkVerdict[] = [];
    for (const t of input.turns) {
      const at = ms(t.customer_turn_at);
      if (!inWin(at, w, this.matureMs) || !t.staff_first_at || t.brain_at === null) continue; // ブレインが読んでいない番は数えない
      const staff = burstAix(t).filter((a) => RESULT_AIX.has(a));
      if (!staff.length) continue;
      if (openStepsAt(input, at).some((s) => s.kind === "check" || s.kind === "confirm" || s.kind === "estimate" || s.kind === "photo")) continue; // ②の番
      // スタッフもすぐの並びで約束を挟んだ番（2段）はブレインの約束の返信が正しい＝A1 の番でない
      if ((t.staff_texts ?? []).some((x) => x.burst && promisesInStaffText(x.text, x.at).length > 0)) continue;
      const ok = staff.includes(t.brain_action ?? "");
      out.push({ link: this.link, at: t.customer_turn_at, ok, breakType: ok ? undefined : "brain_not_direct", detail: `スタッフ=${staff.join("+")} ブレイン=${t.brain_action || "返信"}` });
    }
    return out;
  },
};

export const REAPPLY_MEMO_RE = /申込歴|再探し|再申込|申込から戻った理由/;
/** 申込歴→メモ: 申込以降から手で戻した会話（今は申込前）のメモに『申込歴あり（再探し）』の印があるか */
const reapplyMemo: Reader = {
  link: "reapply_memo", matureMs: 0,
  read(input, w) {
    const back = input.conv.status_manual_back_at;
    if (!back || !inWin(ms(back), w, this.matureMs) || !isPreApplyForNudge(input.conv.status)) return [];
    // 2026-10-27: 申込歴はブレインに記録から届く（reapply-customer・REAPPLY_MARK 既定 on）。メモは理由をスタッフが選んだ時だけの行
    //   （10/21 決定 c2909936・id=REAPPLY_MEMO_ID・「申込から戻った理由：…」）＝旧の語（申込歴・再探し）が無いのを切れと数えていた（14日 5件中5件）
    const ok = reapplyMarkEnabled() || input.memoItems.some((i) => (i as { id?: string }).id === REAPPLY_MEMO_ID || REAPPLY_MEMO_RE.test(String(i.text ?? "")));
    return [{ link: this.link, at: back, ok, breakType: ok ? undefined : "memo_missing", detail: `status=${input.conv.status}` }];
  },
};

/** 要対応→スタッフ: 立った要対応（やることリストに載る物）を24時間のうちに果たしたか */
const staffTodo: Reader = {
  link: "staff_todo", matureMs: 24 * H,
  read(input, w) {
    const out: LinkVerdict[] = [];
    for (const i of input.aixItems) {
      const at = ms(i.created_at);
      if (!inWin(at, w, this.matureMs)) continue;
      const base = { link: this.link, at: i.created_at, detail: `${i.action}${i.check_pattern ? `/${i.check_pattern}` : ""}` } as const;
      if (i.status === "dismissed") {
        // ブレインが取り下げた（brain_no_aix・お客様が止まった 等）・内覧の日が過ぎた物はスタッフの切れではない。48時間放っておかれて片付けられた物だけ数える
        if (i.dismissed_reason === "stale_customer_turn") out.push({ ...base, ok: false, breakType: "dismissed" });
        continue;
      }
      if (i.status === "pending") { out.push({ ...base, ok: false, breakType: "stale_pending" }); continue; }
      const late = ms(i.done_at) - at > 24 * H;
      out.push({ ...base, ok: !late, breakType: late ? "late_done" : undefined });
    }
    return out;
  },
};

/**
 * 手打ちで果たした約束の中身（決まった語で分ける・読むだけの監査用）。ピッカーがあればその AIX（action・checkPattern）、無ければ action=null（新しいピッカーの候補）。
 *   P0（4b744a33）: スタッフしか分からない事（確認の結果・見積の金額・審査の結果）は AIX で送る＝手打ちで果たした約束の続きはこのピッカーを指す
 */
export function classifyHandFulfillment(text: string | null | undefined): { topic: string; action: string | null; checkPattern: string | null } {
  const t = String(text ?? "").normalize("NFKC");
  const ended = /終了|停止|ストップ|申込(?:み)?(?:が)?(?:入|はい)|成約|満室|専任/.test(t);
  if (/御?見積書|お見積|初期費用(?:の)?(?:合計|総額)|[0-9,]{4,}円/.test(t) && !/交渉/.test(t)) return { topic: "見積書の金額", action: "estimate_sheet", checkPattern: null };
  if (/審査(?:通過|否決|結果|が通|に通|落ち|NG|OK|承認|可決|(?:を)?継続(?:出来|でき)な)/.test(t)) return { topic: "審査の結果", action: null, checkPattern: null };
  if (/^\s*(?:\[(?:画像|動画)\]\s*)+$/.test(t) || /写真|動画|撮影/.test(t)) return { topic: "室内写真", action: "property_check_result", checkPattern: "interior_photo" };
  if (/募集(?:されて|して)いるお部屋(?:の)?一覧|募集中のお部屋(?:の)?一覧/.test(t)) return { topic: "募集号室（一覧）", action: "property_check_result", checkPattern: "room_vacancies" };
  if (/内覧|内見|ご案内(?:可能|出来|でき)/.test(t)) return { topic: "内覧の可否・日程", action: "viewing_invite", checkPattern: null };
  // 2026-10-23 入居者の条件について のピッカーができた（2d860ddb）。「子供のご入居が可能か」は 入居時期 の語にも当たるので先に見る
  if (/(?:小学生|未就学|お子様|子供|子ども|年齢)[^\n。！!]{0,20}入居/.test(t)) return { topic: "入居者の条件（お子様・年齢）", action: "property_check_result", checkPattern: "mgmt_occupant" };
  const sentence = findConfirmReportSentence(t) ?? t;
  const o = confirmObjectOf(sentence) ?? confirmObjectOf(t);
  if (o && !isConfirmPartyObject(o)) {
    if (o === "募集状況" || o === "空室") return { topic: "空き（募集状況）", action: "property_check_result", checkPattern: ended ? "unavailable" : "available" };
    if (o === "番手") return { topic: "申込状況", action: "property_check_result", checkPattern: "mgmt_application_status" };
    const cp = checkPatternForConfirmTopic(o);
    return { topic: o, action: cp ? "property_check_result" : null, checkPattern: cp };
  }
  if (/小型犬|大型犬|犬|猫|[0-9０-９一二]匹|飼育/.test(t)) return { topic: "ペット", action: "property_check_result", checkPattern: "mgmt_pet" };
  if (/水道(?:代|料)|ガス代|電気代/.test(t)) return { topic: "水道代・光熱費", action: null, checkPattern: null };
  if (/募集(?:が)?(?:中|終了|して|停止|ストップ)|空き|空室|申込(?:み)?(?:が)?(?:入|はい)|専任|掲載/.test(t)) return { topic: "空き（募集状況）", action: "property_check_result", checkPattern: ended ? "unavailable" : "available" };
  return { topic: "その他", action: null, checkPattern: null };
}

export const READERS: readonly Reader[] = [promisePicker, resultBrain, reactionCondition, brainSecond, pickupVsWatch, directAix, reapplyMemo, staffTodo];

// ───────── 司令塔: 会話ごとに読み手を回し、つなぎごとに数える ─────────
export type LinkExample = { conv: string; at: string; breakType: string; text: string };
export type LinkCount = { checked: number; ok: number; broken: number; byType: Record<string, number>; examples: LinkExample[] };
export type LinkWatchSummary = { fromIso: string; toIso: string; conversations: number; links: Record<LinkId, LinkCount>; todo: Array<{ conversationId: string; customerName: string; action: string; checkPattern: string | null; breakType: string; at: string }>;
  /** 段2 LINK_HUB=on の時だけ: お客様ごとの共通の状態（customer-hub）の食い違いの数（型ごと・例の文なし） */
  hub?: { conversations: number; withContradiction: number; byType: Record<string, number>; actors: Record<string, number> };
  /** 段3 LINK_CONDUCTOR=on の時だけ: 司令塔の決定の数（種類ごと・迷い・片付け。例の文なし） */
  conductor?: Record<string, unknown> };

/** 例の文（名前・電話・番号を伏せ・会話 id は頭8文字） */
export function maskedExample(input: LinkConvInput, v: LinkVerdict): LinkExample {
  return { conv: input.conv.id.slice(0, 8), at: v.at, breakType: v.breakType ?? "", text: maskPII(String(v.detail ?? ""), [input.conv.customer_name]).replace(/\s+/g, " ").slice(0, 90) };
}

export function watchConversation(input: LinkConvInput, w: LinkWindow): LinkVerdict[] {
  return READERS.flatMap((r) => r.read(input, w));
}

export function watchLinks(inputs: ReadonlyArray<LinkConvInput>, w: LinkWindow, o: { examplesPerType?: number } = {}): LinkWatchSummary {
  const per = o.examplesPerType ?? 3;
  const links = Object.fromEntries(LINK_IDS.map((id) => [id, { checked: 0, ok: 0, broken: 0, byType: {}, examples: [] } as LinkCount])) as Record<LinkId, LinkCount>;
  const todo: LinkWatchSummary["todo"] = [];
  for (const input of inputs) {
    for (const v of watchConversation(input, w)) {
      const c = links[v.link];
      c.checked++;
      if (v.ok) { c.ok++; continue; }
      c.broken++;
      const t = v.breakType ?? "other";
      c.byType[t] = (c.byType[t] ?? 0) + 1;
      if (c.examples.filter((e) => e.breakType === t).length < per) c.examples.push(maskedExample(input, v));
      if (v.todo) todo.push({ conversationId: input.conv.id, customerName: input.conv.customer_name ?? "", action: v.todo.action, checkPattern: v.todo.checkPattern, breakType: t, at: v.at });
    }
  }
  return { fromIso: new Date(w.fromMs).toISOString(), toIso: new Date(w.toMs).toISOString(), conversations: inputs.length, links, todo };
}

/** cron_run_logs に残す小さなまとめ（例の文は入れない＝個人情報を残さない） */
export function compactLinkSummary(s: LinkWatchSummary): Record<string, unknown> {
  return {
    from: s.fromIso, to: s.toIso, conversations: s.conversations,
    links: Object.fromEntries(LINK_IDS.map((id) => { const c = s.links[id]; return [id, { checked: c.checked, broken: c.broken, byType: c.byType }]; })),
    todo_candidates: s.todo.length,
    ...(s.hub ? { hub: s.hub } : {}),
    ...(s.conductor ? { conductor: s.conductor } : {}),
  };
}

/** 数えの表（監査・朝の確認用の文） */
export function renderLinkSummary(s: LinkWatchSummary, o: { examples?: boolean } = {}): string {
  const lines = [`つなぎの見張り ${s.fromIso.slice(0, 10)}〜${s.toIso.slice(0, 10)}（会話 ${s.conversations}）`];
  const order = [...LINK_IDS].sort((a, b) => s.links[b].broken - s.links[a].broken);
  for (const id of order) {
    const c = s.links[id];
    const rate = c.checked ? Math.round((c.broken / c.checked) * 100) : 0;
    lines.push(`■ ${LINK_JA[id]}: 見た ${c.checked}・切れ ${c.broken}（${rate}%）`);
    for (const [t, n] of Object.entries(c.byType).sort((a, b) => b[1] - a[1])) {
      lines.push(`   - ${BREAK_JA[t] ?? t}: ${n}`);
      if (o.examples) for (const e of c.examples.filter((x) => x.breakType === t)) lines.push(`       例 ${e.conv} ${e.at.slice(5, 16)} ${e.text}`);
    }
  }
  return lines.join("\n");
}
