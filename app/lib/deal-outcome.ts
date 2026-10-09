// app/lib/deal-outcome.ts — 結果の台帳（成約・失注・内覧・申込）の決まり。純関数・DB 依存なし・LLM なし。
//   計画: memory/plan_outcome_ledger.md（2026-10-08 竹内さん「記録のつながり方の計画つくって」・決定 10/08）
//   表: deal_outcomes（会話×案件ごとに1行・結果そのもの）／outcome_events（既存の表から集めた出来事・作り直せる派生）
//   材料の読み込みと書き込みは deal-outcome-server.ts（サーバー専用）。ここは「決まり」だけ。
//
// 竹内さんの決定（2026-10-08）:
//   ① 失注: 申込前で30日連絡がつながらない＝推定の失注（返事が来たら取り消し＝毎日作り直すので自然に戻る）。
//      他で決めた・ブロック・引越し中止は即確定。**失注の理由は弱い参考**（他の不動産屋と並行が多い・理由にとらわれると質が落ちる）
//      → 失注を「負の正解」として学習に使わない・ブレインに理由で重みを付けない。理由は件数の集計程度に使う。
//   ② 自動の成約（申込中で一定日数やり取りなし）は 14→20日（AUTO_SEIYAKU_DAYS）・推定の印。学習と実績の数字には使わない。
//      確定はスタッフか申込のツールが成約にした時。
//   ③ 申込のツールとは今は段階の変化で受ける（いずれ向こうから送ってもらう）。
//   ④ 審査落ちで切り替え＝同じお客様のまま新しい案件。前の案件の内覧・申込の実績は「信頼の強さ」として引き継ぐ（carried_trust_stage）。
//   ⑤ 成約・内覧した物件はオススメの学習で「強い正」（負には使わない）。
//   ⑦ 内覧の実施: 当日のお礼・報告・待ち合わせ後のやり取りがあれば実施（customer-state の viewings の done と同じ読み方）。
//
// 静的な物（段階の順・失注の型・理由の選択肢・日数）はここに固定する（feedback_static_vs_dynamic_db）。DB に置かない。
// 申込中の文（申込フォーマット・本人確認・勤務先）は台帳に写さない。ここが返すのは種類・時刻・物件・id だけ。
import { isApplicationFormMessage } from "./application-form-detect";
import { splitPropertyName, isDecidedElsewhere } from "./customer-state";

/** 台帳の作り方の版（決まりを変えたら上げる・行に残して前後を比べる） */
// ol2（10/08 夕）: 判断の出来事に場面（scene）と段階（vb＝内覧前／内覧後）を足した（申込到達率 application-reach.ts の材料）
export const LEDGER_VERSION = "ol2-20261008";

// ═════════════════════════════════════════════════════════════════════════════
// 日数（竹内さんの決定）
// ═════════════════════════════════════════════════════════════════════════════

/** 申込前で、お客様の最後の発言からこの日数返事が無い＝推定の失注（決定①） */
export const NO_RESPONSE_LOST_DAYS = 30;
/** 自動の成約（auto-seiyaku）の既定の日数（決定②・旧 14）。AUTO_SEIYAKU_DAYS で変えられる */
export const DEFAULT_AUTO_SEIYAKU_DAYS = 20;
export function autoSeiyakuDays(env: Record<string, string | undefined>): number {
  const n = Number((env.AUTO_SEIYAKU_DAYS ?? "").trim());
  return Number.isFinite(n) && n >= 1 && n <= 120 ? Math.floor(n) : DEFAULT_AUTO_SEIYAKU_DAYS;
}
/** auto-seiyaku が会話を成約にした後、学習の書き戻し（closing_strategy_logs・winning_pattern_logs）をするか。既定はしない（決定②）。AUTO_SEIYAKU_WRITEBACK=on で旧 */
export function autoSeiyakuWritesBack(env: Record<string, string | undefined>): boolean {
  return (env.AUTO_SEIYAKU_WRITEBACK ?? "").trim().toLowerCase() === "on";
}
/** auto-seiyaku が stage_history に残す印（台帳はこれで「推定の成約」と読む。旧の行は "cron"） */
export const AUTO_SEIYAKU_TRIGGER = "cron:auto_seiyaku";

// ═════════════════════════════════════════════════════════════════════════════
// 段階・結果・失注の型・理由（固定）
// ═════════════════════════════════════════════════════════════════════════════

export const DEAL_STAGES = ["first_contact", "condition", "property_sent", "viewing", "viewing_held", "applied", "screening", "won"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  first_contact: "初回", condition: "条件", property_sent: "物件送付", viewing: "内覧の予定", viewing_held: "内覧の実施",
  applied: "申込", screening: "審査", won: "成約",
};
const STAGE_RANK: Record<DealStage, number> = Object.fromEntries(DEAL_STAGES.map((s, i) => [s, i])) as Record<DealStage, number>;
export function stageRank(s: DealStage | null | undefined): number { return s ? STAGE_RANK[s] ?? -1 : -1; }

/** won＝成約／lost＝失注／switched＝審査落ち・取り消しで次の案件へ（このお客様のまま）／in_progress＝進行中 */
export type DealResult = "won" | "lost" | "switched" | "in_progress";
export type Certainty = "confirmed" | "estimated";

/**
 * 失注の型（計画 2-3）。L5（審査落ちの後の離脱）は型でなく after_screening_fail の印で持つ（型は L1〜L4・L6 のどれか）。
 */
export const LOST_TYPES = {
  declined_elsewhere: "L1 他で決めた・辞退",
  blocked: "L2 ブロック",
  no_response: "L3 無反応（30日）",
  move_cancelled: "L4 引越し中止・延期",
  application_cancelled: "L6 申込の取り消し",
} as const;
export type LostType = keyof typeof LOST_TYPES;

/**
 * 失注の理由（選択肢を固定）。⚠ 弱い参考（決定①）: 件数の集計だけに使い、ブレイン・学習に重みとして渡さない。
 */
export const LOSS_REASONS = {
  other_company: "他社で決定", no_match: "合う物件が無い（条件）", cost: "費用", timing_delayed: "時期が延びた",
  move_cancelled: "引越し中止", screening: "審査", no_contact: "連絡が途絶えた", unknown: "不明",
} as const;
export type LossReason = keyof typeof LOSS_REASONS;
/** 型から決まる理由（決定論）。DeepSeek で読むのは declined_elsewhere・move_cancelled の時だけ（段4・弱い参考） */
export function ruleLossReason(type: LostType, afterScreeningFail: boolean): LossReason {
  if (type === "declined_elsewhere") return "other_company";
  if (type === "move_cancelled") return "move_cancelled";
  if (type === "no_response") return afterScreeningFail ? "screening" : "no_contact";
  if (type === "application_cancelled") return afterScreeningFail ? "screening" : "unknown";
  return "unknown";
}
/** DeepSeek で理由を読んでよい型（それ以外は型で足りる・送らない） */
export function lossReasonNeedsText(type: LostType | null | undefined): boolean {
  return type === "declined_elsewhere" || type === "move_cancelled";
}

// ═════════════════════════════════════════════════════════════════════════════
// 会話の状態（conversations.status）
// ═════════════════════════════════════════════════════════════════════════════

/** 申込以降（成約を除く）。旧の別名も含める（auto-seiyaku の APPLYING_STATUSES と同じ） */
export const APPLYING_STATUSES: ReadonlySet<string> = new Set(["applying", "application", "screening", "contract"]);
const WON_STATUS = "closed_won";
export function isApplyingStatus(s: string | null | undefined): boolean { return APPLYING_STATUSES.has((s ?? "").trim()); }
function isPreApplyStatus(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  return !!t && !APPLYING_STATUSES.has(t) && t !== WON_STATUS && t !== "closed_lost";
}

// ═════════════════════════════════════════════════════════════════════════════
// 本文の型（決定論・お客様／こちらの文）
// ═════════════════════════════════════════════════════════════════════════════

const sentencesOf = (text: string | null | undefined) => String(text ?? "").normalize("NFKC").split(/\n|(?<=[。！!])/);
/**
 * 審査に落ちた（否決）の報告。こちらの報告・お客様の文のどちらでも（文ごとに見る）。
 *   監査（scripts/audit-outcome-ledger.ts --texts・200日）: 「否決」1語では 85通の大半が「1番手の方がキャンセル・否決の場合に繰り上がり」の説明（仮定）だった
 *   → 結果の言い方（否決とのご連絡・否決となってしまい・審査継続不能・審査が通りませんでした）だけにし、仮定・質問・2番手で審査中の文は外す
 */
export const SCREENING_REJECTED_RE = /否決(?:とのご連絡|となって(?:しまい|しまっ)|となりました|となり[、,]?(?:審査継続|引き続き)|でした|になりました)|審査(?:継続)?不(?:可能|能)|審査(?:に|が)?(?:落ちてしまい|落ちました|落ちてしまっ|通りませんでした|通らなかった)/;
const SCREENING_REJECTED_NEGATE_RE = /場合|際|割合|可能性|もし|たら|かも|ないか|ですか|ますか|\?|？|審査中/;
export function isScreeningRejectedText(text: string | null | undefined): boolean {
  return sentencesOf(text).some((x) => SCREENING_REJECTED_RE.test(x) && !SCREENING_REJECTED_NEGATE_RE.test(x));
}
/**
 * 申込の取り消し（お客様）。監査: 「申込…キャンセル」の語だけでは 9通全部が「キャンセルできますか」の質問だった
 *   → 頼む・決めた言い方（キャンセルでお願い・キャンセルさせて頂き・取り消します）だけ・質問と仮定は外す
 */
export const APPLICATION_CANCEL_RE = /(?:申し?込み?|申込|審査|物件|お部屋)[^\n。]{0,15}(?:キャンセル|取り消し?|取消|取りやめ|取り下げ|辞退)(?:で(?:お願い|よろしく)|させて(?:頂|いただ)|します|しました|いたします|致します|お願い)/;
const APPLICATION_CANCEL_NEGATE_RE = /できる|出来る|可能|ますか|ですか|でしょうか|場合|たら|難しい|認識|\?|？|内見|内覧|予約/;
export function isApplicationCancelText(text: string | null | undefined): boolean {
  return sentencesOf(text).some((x) => APPLICATION_CANCEL_RE.test(x) && !APPLICATION_CANCEL_NEGATE_RE.test(x));
}
/**
 * 引越しそのものの中止・延期（お客様）。物件1件の見送り（「この物件は見送ります」）は当てない＝案件の失注ではない。
 *   ⚠ 「延期」だけ・「更新」だけは当てない（内覧の延期・更新料の話がある）
 */
export const MOVE_CANCELLED_RE = /(?:転勤|異動)(?:の件|の話)?(?:が|は)?(?:無くな|なくな|白紙|延期|中止)|(?:引っ?越し?|引越し?|お部屋探し|部屋探し|転居)(?:自体|の話|の予定|の件)?(?:は|が|を)?[^\n。]{0,10}(?:やめ|中止|見送|取りやめ|なくな|無くな|白紙|延期|保留)|(?:今の(?:家|部屋|お部屋)|今住んで(?:いる|る)(?:家|部屋|ところ))[^\n。]{0,15}更新(?:する|すること|しよう)|更新すること(?:に|と)(?:なり|し)ました/;
const MOVE_CANCELLED_NEGATE_RE = /かも|しれ|ないか|場合|たら|\?|？|まだ|迷|悩/;
/**
 * 他で決めた・辞退（お客様）。customer-state の isDecidedElsewhere（365日の実物で線を引いた物）＋案件の辞退の語。
 *   監査: 「そちらの物件拝見しましたが 今回はやめておきます」は物件1件の見送り（案件の失注ではない）→ 「やめ」は入れず・物件を指す発言は外す
 */
const DEAL_DECLINE_RE = /(?:今回は|今回の(?:お部屋探し|お話)は)[^\n。]{0,10}(?:見送|辞退)|(?:お部屋探し|物件探し)[^\n。]{0,8}(?:終わり|終了)(?:に|と)(?:し|なり)/;
const PROPERTY_LEVEL_RE = /(?:この|その|こちらの|そちらの|あちらの)(?:物件|お部屋|部屋)|物件(?:を)?拝見/;
export type DealLossText = "declined_elsewhere" | "move_cancelled" | null;
export function detectDealLossText(text: string | null | undefined): DealLossText {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim() || /^\s*\[画像\]/.test(t)) return null;
  if (isDecidedElsewhere(t)) return "declined_elsewhere";
  for (const s of t.split(/\n|(?<=[。！!])/)) {
    if (MOVE_CANCELLED_RE.test(s) && !MOVE_CANCELLED_NEGATE_RE.test(s)) return "move_cancelled";
    if (DEAL_DECLINE_RE.test(s) && !MOVE_CANCELLED_NEGATE_RE.test(s) && !PROPERTY_LEVEL_RE.test(t)) return "declined_elsewhere";
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 成約の確かさ（決定②）
// ═════════════════════════════════════════════════════════════════════════════

export type StageHistoryRow = { from_status: string | null; to_status: string | null; changed_at: string; trigger: string | null };
/** auto-seiyaku の始まり（2026-07-23）。それより前の成約は自動ではない */
export const AUTO_SEIYAKU_STARTED_AT = "2026-07-23T00:00:00Z";

export type WonCertainty = { certainty: Certainty; evidence: string; at: string | null };
/**
 * 今の成約（status=closed_won）の確かさ。
 *   確定: スタッフが成約にした（manual）／申込のツールの同期（sync_screening・screening_last_status=closed_won）／自動が始まる前（7/23 より前）の成約
 *   推定: auto-seiyaku（trigger が cron で始まる）／履歴の無い成約で更新の時刻が auto-seiyaku の走る JST 9:00（UTC 0:00〜0:02）
 *   迷う物（履歴が無く 7/23 以降・時刻も合わない）は推定に倒す（学習・実績に入れない側）＝evidence に ambiguous
 */
export function closedWonCertainty(i: { history: ReadonlyArray<StageHistoryRow>; updatedAt: string | null; screeningLastStatus: string | null }): WonCertainty {
  const wonRows = i.history.filter((h) => h.to_status === WON_STATUS).sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
  const last = wonRows[wonRows.length - 1];
  if (last) {
    const trg = (last.trigger ?? "").trim();
    if (trg.startsWith("cron")) return { certainty: "estimated", evidence: "auto_seiyaku", at: last.changed_at };
    if (trg.startsWith("sync_screening")) return { certainty: "confirmed", evidence: "screening_tool", at: last.changed_at };
    if (trg.startsWith("manual")) return { certainty: "confirmed", evidence: "staff", at: last.changed_at };
    return { certainty: "estimated", evidence: `trigger:${trg || "none"}`, at: last.changed_at };
  }
  if ((i.screeningLastStatus ?? "").trim() === WON_STATUS) return { certainty: "confirmed", evidence: "screening_tool", at: i.updatedAt };
  if (i.updatedAt) {
    const ms = Date.parse(i.updatedAt);
    if (Number.isFinite(ms) && ms < Date.parse(AUTO_SEIYAKU_STARTED_AT)) return { certainty: "confirmed", evidence: "before_auto_seiyaku", at: null };
    const d = new Date(ms);
    if (d.getUTCHours() === 0 && d.getUTCMinutes() < 3) return { certainty: "estimated", evidence: "auto_seiyaku_legacy", at: i.updatedAt };
  }
  return { certainty: "estimated", evidence: "no_history_ambiguous", at: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// 物件の照合（計画 2-2）
// ═════════════════════════════════════════════════════════════════════════════

export type ClueKind = "screening_tool" | "application_text" | "estimate" | "aix" | "viewing" | "brain" | "image";
/** 手がかりの順（小さいほど強い）。1〜4 は確定寄り・5〜6 は推定 */
export const CLUE_RANK: Record<ClueKind, number> = { screening_tool: 1, application_text: 1.5, estimate: 2, aix: 3, viewing: 4, brain: 5, image: 6 };
export type DealPropertyClue = { kind: ClueKind; at: string; name: string; room?: string | null; sourceTable: string; sourceId: string };
export type DealProperty = { name: string; buildingKey: string; room: string | null; evidence: string; certainty: Certainty; sourceId: string };

/** 申込の前に見る長さ（見積・AIX・内覧・お客様が送った物件） */
const CLUE_LOOKBACK_MS = 45 * 86_400_000;
/** ブレインの判断の物件は申込の前後1日だけ */
const BRAIN_WINDOW_MS = 86_400_000;
/** 画像は申込の前7日 */
const IMAGE_LOOKBACK_MS = 7 * 86_400_000;

/**
 * 申込（または案件の終わり）の時刻 refMs に対して、どの物件で決まった（落ちた）か。
 *   一番強い種類の中で refMs に一番近い（前の）物を採る。物件名が建物として読めない物は捨てる。
 */
export function pickDealProperty(clues: ReadonlyArray<DealPropertyClue>, refMs: number, fromMs: number): DealProperty | null {
  let best: { c: DealPropertyClue; rank: number; at: number; ref: NonNullable<ReturnType<typeof splitPropertyName>> } | null = null;
  for (const c of clues) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    const lookback = c.kind === "image" ? IMAGE_LOOKBACK_MS : c.kind === "brain" ? BRAIN_WINDOW_MS : CLUE_LOOKBACK_MS;
    const ahead = c.kind === "brain" || c.kind === "application_text" || c.kind === "screening_tool" ? BRAIN_WINDOW_MS : 0;
    if (at < Math.max(fromMs, refMs - lookback) || at > refMs + ahead) continue;
    const ref = splitPropertyName(c.name, c.room ?? null);
    if (!ref) continue;
    const rank = CLUE_RANK[c.kind];
    if (!best || rank < best.rank || (rank === best.rank && Math.abs(refMs - at) < Math.abs(refMs - best.at))) best = { c, rank, at, ref };
  }
  if (!best) return null;
  return {
    name: best.ref.display, buildingKey: best.ref.buildingKey, room: best.ref.room,
    evidence: best.c.kind, certainty: best.rank <= 4 ? "confirmed" : "estimated", sourceId: `${best.c.sourceTable}:${best.c.sourceId}`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 案件（エピソード）と結果
// ═════════════════════════════════════════════════════════════════════════════

export type DealMessage = { sender: string; text: string | null; createdAt: string };
export type DealViewing = { ymd: string; status: "scheduled" | "done" | "unconfirmed" | "cancelled"; thankedAt: string | null; name: string | null };

export type DealInput = {
  conversationId: string;
  nowMs: number;
  status: string | null;
  lineStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  statusManualBackAt: string | null;
  isPostApply: boolean | null;
  screeningLastStatus: string | null;
  stageHistory: ReadonlyArray<StageHistoryRow>;
  /** 古い順（全部でなくてよい・最初の発言の時刻は firstMessageAt で渡す） */
  messages: ReadonlyArray<DealMessage>;
  firstMessageAt: string | null;
  /** customer-state の viewings（lapsed でもお礼があれば done） */
  viewings: ReadonlyArray<DealViewing>;
  /** 物件を送った時刻（sent_facts properties_sent・オススメの控え・物件の AIX） */
  propertySentAts: ReadonlyArray<string>;
  /** 条件を聞いた／聞けた時刻（sent_facts condition_asked・段階 condition_hearing） */
  conditionAts: ReadonlyArray<string>;
  clues: ReadonlyArray<DealPropertyClue>;
};

export type SwitchReason = "screening_rejected" | "application_cancelled" | "unknown";
export type DealEpisode = {
  episodeNo: number;
  startedAt: string | null;
  endedAt: string | null;
  stageAt: Partial<Record<DealStage, string>>;
  /** 申込の時刻が修理（repair:*）の時刻しか無い＝本当の申込の時刻ではない */
  appliedAtEstimated: boolean;
  maxStage: DealStage;
  result: DealResult;
  certainty: Certainty;
  evidence: string;
  resultAt: string | null;
  lostType: LostType | null;
  lostReason: LossReason | null;
  switchReason: SwitchReason | null;
  afterScreeningFail: boolean;
  /** 前の案件までに届いた一番上の段階（決定④・信頼の強さ）。最初の案件は null */
  carriedTrustStage: DealStage | null;
  /** 申込前の無反応で、こちらは最後のお客様の発言の後に送っていた（追いかけた） */
  chased: boolean | null;
  property: DealProperty | null;
};

const DAY = 86_400_000;
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const iso = (n: number) => new Date(n).toISOString();
const minIso = (xs: ReadonlyArray<string>, from: number, to: number): string | null => {
  let best = Infinity;
  for (const x of xs) { const t = ms(x); if (Number.isFinite(t) && t >= from && t < to && t < best) best = t; }
  return Number.isFinite(best) ? iso(best) : null;
};

type Boundary = { atMs: number; reason: SwitchReason };

/**
 * 案件の区切り: 申込以降（申込中・審査中）→ 申込前 に戻った時。
 *   本当の申込だった（申込フォームの受け取り・審査中・否決の文・取り消しの文のどれかがある）時だけ新しい案件にする。
 *   どれも無い戻し（自動の申込の誤り等）は「直し」として、その間の申込の印を捨てる（ignoreApplyBefore）。
 */
export function episodeBoundaries(input: Pick<DealInput, "stageHistory" | "messages" | "statusManualBackAt">): { boundaries: Boundary[]; ignoredApplyRanges: Array<[number, number]> } {
  const hist = [...input.stageHistory].sort((a, b) => ms(a.changed_at) - ms(b.changed_at));
  const backs: number[] = hist.filter((h) => isApplyingStatus(h.from_status) && isPreApplyStatus(h.to_status)).map((h) => ms(h.changed_at)).filter(Number.isFinite);
  const manual = ms(input.statusManualBackAt);
  if (Number.isFinite(manual) && !backs.some((b) => Math.abs(b - manual) < DAY)) backs.push(manual);
  backs.sort((a, b) => a - b);
  const boundaries: Boundary[] = [];
  const ignored: Array<[number, number]> = [];
  let segStart = -Infinity;
  for (const b of backs) {
    const inSeg = (m: DealMessage) => { const t = ms(m.createdAt); return t >= segStart && t <= b + 2 * DAY; };
    const near = (m: DealMessage) => { const t = ms(m.createdAt); return t >= Math.max(segStart, b - 21 * DAY) && t <= b + 2 * DAY; };
    const rejected = input.messages.some((m) => near(m) && isScreeningRejectedText(m.text));
    const cancelled = input.messages.some((m) => near(m) && m.sender === "customer" && isApplicationCancelText(m.text));
    const form = input.messages.some((m) => inSeg(m) && m.sender === "customer" && isApplicationFormMessage(m.text ?? "").detected);
    const screening = hist.some((h) => { const t = ms(h.changed_at); return t >= segStart && t <= b && h.to_status === "screening"; });
    if (rejected || cancelled || form || screening) {
      boundaries.push({ atMs: b, reason: rejected ? "screening_rejected" : cancelled ? "application_cancelled" : "unknown" });
      segStart = b;
    } else {
      ignored.push([segStart, b]);
    }
  }
  // 段階を戻していない審査落ち: こちらの「審査否決とのご連絡」の報告そのものを区切りにする（申込はあった・否決で次の案件へ）。
  //   監査（200日）: 否決の報告 19通のうち、段階の履歴に申込→戻しが無い会話が多い（スタッフが状態を申込にしないまま審査に出している）。
  //   同じ申込の報告の重なり（翌日の補足など）は 14日以内を1つにまとめる
  const REJECT_MERGE_MS = 14 * DAY;
  for (const m of input.messages) {
    if (m.sender === "customer" || !isScreeningRejectedText(m.text)) continue;
    const t = ms(m.createdAt);
    if (!Number.isFinite(t) || boundaries.some((b) => Math.abs(b.atMs - t) <= REJECT_MERGE_MS)) continue;
    boundaries.push({ atMs: t, reason: "screening_rejected" });
  }
  boundaries.sort((a, b) => a.atMs - b.atMs);
  return { boundaries, ignoredApplyRanges: ignored };
}

function maxStageOf(stageAt: Partial<Record<DealStage, string>>, fallback: DealStage): DealStage {
  let best: DealStage = fallback;
  for (const s of DEAL_STAGES) if (stageAt[s] && stageRank(s) > stageRank(best)) best = s;
  return best;
}

/** 会話の案件と結果を決める（毎日作り直す前提・同じ入力なら同じ答え） */
export function resolveDealOutcomes(input: DealInput): DealEpisode[] {
  const now = input.nowMs;
  const msgs = [...input.messages].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const hist = [...input.stageHistory].sort((a, b) => ms(a.changed_at) - ms(b.changed_at));
  const { boundaries, ignoredApplyRanges } = episodeBoundaries({ stageHistory: hist, messages: msgs, statusManualBackAt: input.statusManualBackAt });
  const ignoredApply = (t: number) => ignoredApplyRanges.some(([a, b]) => t >= a && t <= b);

  // 申込の印（時刻）: お客様の申込フォーム（確定）＞ 段階の変化（修理以外）＞ 修理（repair:*）の時刻（申込の時刻としては推定）
  const formAts = msgs.filter((m) => m.sender === "customer" && isApplicationFormMessage(m.text ?? "").detected).map((m) => m.createdAt);
  const histApplyAts = hist.filter((h) => isApplyingStatus(h.to_status) && !isApplyingStatus(h.from_status) && h.from_status !== WON_STATUS && !(h.trigger ?? "").startsWith("repair")).map((h) => h.changed_at);
  const repairApplyAts = hist.filter((h) => isApplyingStatus(h.to_status) && (h.trigger ?? "").startsWith("repair")).map((h) => h.changed_at);
  const screeningAts = hist.filter((h) => h.to_status === "screening").map((h) => h.changed_at);
  const wonRows = hist.filter((h) => h.to_status === WON_STATUS);

  const firstAt = input.firstMessageAt ?? msgs[0]?.createdAt ?? input.createdAt;
  const starts = [ms(firstAt), ...boundaries.map((b) => b.atMs)];
  const episodes: DealEpisode[] = [];
  let carried: DealStage | null = null;
  for (let k = 0; k < starts.length; k++) {
    const isLast = k === starts.length - 1;
    const from = k === 0 ? -Infinity : starts[k];
    const to = isLast ? Infinity : starts[k + 1];
    const stageAt: Partial<Record<DealStage, string>> = {};
    const startIso = Number.isFinite(starts[k]) ? iso(starts[k]) : null;
    if (startIso) stageAt.first_contact = startIso;
    const cond = minIso(input.conditionAts, from, to); if (cond) stageAt.condition = cond;
    const sent = minIso(input.propertySentAts, from, to); if (sent) stageAt.property_sent = sent;
    const vs = input.viewings.filter((v) => v.status !== "cancelled").map((v) => `${v.ymd}T12:00:00+09:00`);
    const vAt = minIso(vs, from, to); if (vAt) stageAt.viewing = vAt;
    const held = input.viewings.filter((v) => v.status === "done").map((v) => v.thankedAt ?? `${v.ymd}T20:00:00+09:00`);
    const hAt = minIso(held, from, to); if (hAt) { stageAt.viewing_held = hAt; if (!stageAt.viewing || ms(stageAt.viewing) > ms(hAt)) stageAt.viewing = hAt; }
    const realApply = [...formAts, ...histApplyAts].filter((x) => !ignoredApply(ms(x)) || formAts.includes(x));
    let appliedAtEstimated = false;
    let aAt = minIso(realApply, from, to);
    if (!aAt) { aAt = minIso(repairApplyAts, from, to); if (aAt) appliedAtEstimated = true; }
    if (aAt) stageAt.applied = aAt;
    const sAt = minIso(screeningAts, from, to); if (sAt) stageAt.screening = sAt;

    let result: DealResult = "in_progress";
    let certainty: Certainty = "estimated";
    let evidence = "open";
    let resultAt: string | null = null;
    let lostType: LostType | null = null;
    let switchReason: SwitchReason | null = null;
    let chased: boolean | null = null;
    const afterScreeningFail = k > 0 && boundaries[k - 1].reason === "screening_rejected";
    const segMsgs = msgs.filter((m) => { const t = ms(m.createdAt); return t >= from && t < to; });
    const segCustomer = segMsgs.filter((m) => m.sender === "customer");

    if (!isLast) {
      result = "switched";
      switchReason = boundaries[k].reason;
      certainty = switchReason === "unknown" ? "estimated" : "confirmed";
      evidence = `back_to_pre_apply:${switchReason}`;
      resultAt = iso(boundaries[k].atMs);
      if (!stageAt.applied) { stageAt.applied = resultAt; appliedAtEstimated = true; }
    } else if ((input.status ?? "").trim() === WON_STATUS) {
      const w = closedWonCertainty({ history: wonRows, updatedAt: input.updatedAt, screeningLastStatus: input.screeningLastStatus });
      result = "won"; certainty = w.certainty; evidence = w.evidence;
      resultAt = w.at ?? input.updatedAt;
      if (resultAt) stageAt.won = resultAt;
      // 成約は申込を通っている。申込の時刻が分からなければ修理の時刻→成約の時刻（どちらも推定の時刻）
      if (!stageAt.applied) { const a = minIso(repairApplyAts, from, to) ?? resultAt; if (a) { stageAt.applied = a; appliedAtEstimated = true; } }
    } else if (isApplyingStatus(input.status) || (input.isPostApply && !isPreApplyStatus(input.status))) {
      result = "in_progress"; evidence = "applying";
      if (!stageAt.applied) { const r = minIso(repairApplyAts, from, to); if (r) { stageAt.applied = r; appliedAtEstimated = true; } }
    } else {
      // 申込前（またはこの案件で申込に届いていない）
      const lastCust = segCustomer[segCustomer.length - 1];
      const lastAny = segMsgs[segMsgs.length - 1];
      const tail = segCustomer.slice(-3);
      const lossMsg = [...tail].reverse().find((m) => detectDealLossText(m.text) !== null);
      if ((input.lineStatus ?? "").trim() === "unfollowed") {
        result = "lost"; lostType = "blocked"; certainty = "confirmed"; evidence = "line_unfollowed";
        resultAt = lastAny?.createdAt ?? input.updatedAt;
      } else if (lossMsg) {
        const kind = detectDealLossText(lossMsg.text)!;
        result = "lost"; lostType = kind; certainty = "confirmed"; evidence = `customer_text:${kind}`;
        resultAt = lossMsg.createdAt;
      } else {
        const lastCustMs = lastCust ? ms(lastCust.createdAt) : Number.isFinite(starts[k]) ? starts[k] : ms(input.createdAt);
        if (Number.isFinite(lastCustMs) && now - lastCustMs >= NO_RESPONSE_LOST_DAYS * DAY) {
          result = "lost"; lostType = "no_response"; certainty = "estimated"; evidence = `no_reply_${NO_RESPONSE_LOST_DAYS}d`;
          resultAt = iso(lastCustMs);
          chased = segMsgs.some((m) => m.sender !== "customer" && ms(m.createdAt) > lastCustMs);
        }
      }
    }

    const maxStage = maxStageOf(stageAt, "first_contact");
    // 物件: 申込に届いた案件は申込の時刻で・届いていない案件は終わり（今）の時刻で（後者は推定）
    const refMs = stageAt.applied ? ms(stageAt.applied) : resultAt ? ms(resultAt) : Math.min(now, to);
    let property = pickDealProperty(input.clues, refMs, k === 0 ? -Infinity : from - 30 * DAY);
    if (property && !stageAt.applied) property = { ...property, certainty: "estimated", evidence: `focus:${property.evidence}` };

    episodes.push({
      episodeNo: k + 1,
      startedAt: startIso,
      endedAt: isLast ? (result === "in_progress" ? null : resultAt) : iso(starts[k + 1]),
      stageAt, appliedAtEstimated, maxStage, result, certainty, evidence, resultAt,
      lostType, lostReason: lostType ? ruleLossReason(lostType, afterScreeningFail) : null,
      switchReason, afterScreeningFail, carriedTrustStage: carried, chased, property,
    });
    if (stageRank(maxStage) > stageRank(carried)) carried = maxStage;
  }
  return episodes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 表の行（deal_outcomes / outcome_events）
// ═════════════════════════════════════════════════════════════════════════════

export type DealOutcomeRow = {
  conversation_id: string; episode_no: number;
  started_at: string | null; ended_at: string | null;
  first_contact_at: string | null; condition_at: string | null; property_sent_at: string | null;
  viewing_at: string | null; viewing_held_at: string | null; applied_at: string | null; applied_at_estimated: boolean;
  screening_at: string | null; won_at: string | null; lost_at: string | null;
  max_stage: DealStage; result: DealResult; result_certainty: Certainty; result_evidence: string;
  lost_type: LostType | null; lost_reason: LossReason | null; lost_reason_source: "rule" | "deepseek" | null;
  switch_reason: SwitchReason | null; after_screening_fail: boolean; carried_trust_stage: DealStage | null; chased: boolean | null;
  property_name: string | null; building_key: string | null; room_no: string | null; property_evidence: string | null; property_certainty: Certainty | null; property_source_id: string | null;
  ledger_version: string; computed_at: string;
};
export function toDealOutcomeRow(conversationId: string, e: DealEpisode, computedAt: string): DealOutcomeRow {
  return {
    conversation_id: conversationId, episode_no: e.episodeNo,
    started_at: e.startedAt, ended_at: e.endedAt,
    first_contact_at: e.stageAt.first_contact ?? null, condition_at: e.stageAt.condition ?? null, property_sent_at: e.stageAt.property_sent ?? null,
    viewing_at: e.stageAt.viewing ?? null, viewing_held_at: e.stageAt.viewing_held ?? null, applied_at: e.stageAt.applied ?? null, applied_at_estimated: e.appliedAtEstimated,
    screening_at: e.stageAt.screening ?? null, won_at: e.result === "won" ? e.resultAt : null, lost_at: e.result === "lost" ? e.resultAt : null,
    max_stage: e.maxStage, result: e.result, result_certainty: e.certainty, result_evidence: e.evidence,
    lost_type: e.lostType, lost_reason: e.lostReason, lost_reason_source: e.lostReason ? "rule" : null,
    switch_reason: e.switchReason, after_screening_fail: e.afterScreeningFail, carried_trust_stage: e.carriedTrustStage, chased: e.chased,
    property_name: e.property?.name ?? null, building_key: e.property?.buildingKey ?? null, room_no: e.property?.room ?? null,
    property_evidence: e.property?.evidence ?? null, property_certainty: e.property?.certainty ?? null, property_source_id: e.property?.sourceId ?? null,
    ledger_version: LEDGER_VERSION, computed_at: computedAt,
  };
}

/** 出来事の種類（固定）。返信・お客様の発言そのものは写さない（messages が正・申込中の文を持たない） */
export const OUTCOME_EVENT_KINDS = [
  "brain_decision", "aix_sent", "estimate", "recommendation", "image_sent", "fact", "stage_change",
  "viewing_scheduled", "viewing_held", "applied", "screening", "won", "lost", "switched",
] as const;
export type OutcomeEventKind = (typeof OUTCOME_EVENT_KINDS)[number];
export type RawOutcomeEvent = {
  at: string; kind: OutcomeEventKind; sourceTable: string; sourceId: string;
  propertyName?: string | null; room?: string | null; decisionId?: string | null; detail?: Record<string, unknown> | null;
};
export type OutcomeEventRow = {
  conversation_id: string; episode_no: number; at: string; kind: OutcomeEventKind;
  property_name: string | null; building_key: string | null; room_no: string | null;
  source_table: string; source_id: string; decision_id: string | null; detail: Record<string, unknown> | null; ledger_version: string;
};
/** 出来事に案件の番号を付け、結果の出来事（申込・審査・成約・失注・切り替え・内覧の実施）を足す */
export function buildOutcomeEventRows(conversationId: string, raw: ReadonlyArray<RawOutcomeEvent>, episodes: ReadonlyArray<DealEpisode>): OutcomeEventRow[] {
  const startOf = episodes.map((e) => (e.episodeNo === 1 ? -Infinity : ms(e.startedAt)));
  const episodeAt = (t: number) => { let no = 1; for (let i = 0; i < startOf.length; i++) if (t >= startOf[i]) no = episodes[i].episodeNo; return no; };
  const out: OutcomeEventRow[] = [];
  const push = (e: RawOutcomeEvent, episodeNo?: number) => {
    const t = ms(e.at); if (!Number.isFinite(t)) return;
    const ref = e.propertyName ? splitPropertyName(e.propertyName, e.room ?? null) : null;
    out.push({
      conversation_id: conversationId, episode_no: episodeNo ?? episodeAt(t), at: iso(t), kind: e.kind,
      property_name: ref?.display ?? (e.propertyName ? String(e.propertyName).slice(0, 80) : null), building_key: ref?.buildingKey ?? null, room_no: ref?.room ?? null,
      source_table: e.sourceTable, source_id: e.sourceId, decision_id: e.decisionId ?? null, detail: e.detail ?? null, ledger_version: LEDGER_VERSION,
    });
  };
  for (const e of raw) push(e);
  for (const ep of episodes) {
    const p = ep.property;
    const base = { sourceTable: "deal_outcomes", propertyName: p?.name ?? null, room: p?.room ?? null };
    if (ep.stageAt.applied) push({ ...base, at: ep.stageAt.applied, kind: "applied", sourceId: `${ep.episodeNo}:applied`, detail: ep.appliedAtEstimated ? { at_estimated: true } : null }, ep.episodeNo);
    if (ep.stageAt.screening) push({ ...base, at: ep.stageAt.screening, kind: "screening", sourceId: `${ep.episodeNo}:screening` }, ep.episodeNo);
    if (ep.result !== "in_progress" && ep.resultAt) {
      push({ ...base, at: ep.resultAt, kind: ep.result as OutcomeEventKind, sourceId: `${ep.episodeNo}:${ep.result}`,
        detail: { certainty: ep.certainty, evidence: ep.evidence, ...(ep.lostType ? { lost_type: ep.lostType } : {}), ...(ep.switchReason ? { switch_reason: ep.switchReason } : {}) } }, ep.episodeNo);
    }
  }
  // 同じ元の行・種類は1つ（source_table, source_id, kind が一意）
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.source_table}|${r.source_id}|${r.kind}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => ms(a.at) - ms(b.at));
}

// ═════════════════════════════════════════════════════════════════════════════
// 実績の数え方（段5・段6 で使う。学習と実績は確定の成約だけ＝決定②）
// ═════════════════════════════════════════════════════════════════════════════

/** 学習・実績の数字に入れてよい成約か（確定だけ） */
export function countsAsConfirmedWin(r: Pick<DealOutcomeRow, "result" | "result_certainty">): boolean {
  return r.result === "won" && r.result_certainty === "confirmed";
}
/** オススメの学習の「強い正」にしてよいか（決定⑤: 内覧・申込・確定の成約。負には使わない＝失注は false を返すだけで負のラベルにしない） */
export function strongPositiveStage(r: Pick<DealOutcomeRow, "max_stage" | "result" | "result_certainty">): "won" | "applied" | "viewing_held" | null {
  if (countsAsConfirmedWin(r)) return "won";
  if (stageRank(r.max_stage) >= stageRank("applied")) return "applied";
  if (stageRank(r.max_stage) >= stageRank("viewing_held")) return "viewing_held";
  return null;
}
/**
 * 強い正の重み（2026-10-08 竹内さん「申込で良いけど、さらにちゃんと成約したのはより良いデータとして入れておく」）。
 *   オススメの学習（段6・計画④）で「送った＝正（1）」に足す重み: 確定の成約 3／申込 2／内覧の実施 1／それ以外 0。負は無い（失注は 0＝ラベルにしない）。
 *   WIN_CONFIRMED_WEIGHT=off の時は確定の成約も申込と同じ 2（旧＝申込までで同じ扱い）
 */
export function strongPositiveWeight(stage: ReturnType<typeof strongPositiveStage>, env: Record<string, string | undefined> = process.env): number {
  if (stage === "won") return (env.WIN_CONFIRMED_WEIGHT ?? "").trim().toLowerCase() === "off" ? 2 : 3;
  if (stage === "applied") return 2;
  if (stage === "viewing_held") return 1;
  return 0;
}
