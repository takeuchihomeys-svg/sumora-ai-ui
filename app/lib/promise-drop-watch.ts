// app/lib/promise-drop-watch.ts — 約束の取りこぼしの見張り（純関数・DB も LINE も持たない）
//
// 2026-11-21 作業員L（統括役の頼み・誘導の穴 #414 の掘りで見つけた本当の取りこぼし3件）:
//   ピックアップ・確認を約束した後、物件の AIX も送付も無いまま 15〜29日お客様を待たせていた（会話 6e77895d・83391dda・44fd59ab）。
//   約束の見張りはどれも「何かが起きた時」にしか動かない（promise-queue＝送った時だけ・7日／ブレイン＝お客様の発言の時だけ／
//   AIX_OVERDUE_REMIND＝pending の要対応の 24〜48時間だけ）ので、約束の後にお客様が黙った・お礼が1回来て黙った・要対応を取り下げた会話は
//   どこにも出なかった（外れの原因の ①材料・仕組みが届いていない）。
//   → 1日1回、約束から 72時間を過ぎて果たしていない会話を並べる。形は売上番長グループの決まり（「〇〇さん → AIX【ボタン】」・feedback_group_aix_only）。
// 切替 PROMISE_DROP_WATCH: 既定（未設定）は記録だけ（shadow: cron_run_logs に何件・誰が出るはずだったかを残す・LINE に出さない）／
//   on＝売上番長グループに送る（竹内さんの OK の後）／off＝何もしない。
// テスト: app/lib/__tests__/promise-drop-watch.test.ts
import { aixButtonText } from "./aix-action-text";
import { promiseDueDay } from "./promise-due";

type Env = Record<string, string | undefined>;
export type PromiseDropMode = "off" | "shadow" | "on";
export function promiseDropWatchMode(env: Env = typeof process !== "undefined" ? process.env : {}): PromiseDropMode {
  const v = (env.PROMISE_DROP_WATCH ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "off" ? "off" : "shadow";
}

export const PROMISE_DROP_MIN_H = 72;
export const PROMISE_DROP_MAX_DAYS = 30;
export const PROMISE_DROP_KEY = "promise_drop_watch_last_at";
export const PROMISE_DROP_TEXT_KEY = "promise_drop_watch_text";

export type PdMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export type PdAix = { aix_type: string | null; sent_at: string | null; created_at: string };
export type PdSent = { sent_at: string | null };
export type PdItem = { action: string; status: string; created_at: string };
export type PdPick = { created_at: string; status?: string | null; sent_at?: string | null; expired_at?: string | null };
export type PdInput = { conversationId: string; customerName: string | null; status: string | null; msgs: ReadonlyArray<PdMsg>; aix: ReadonlyArray<PdAix>; sent: ReadonlyArray<PdSent>; items: ReadonlyArray<PdItem>; picks: ReadonlyArray<PdPick> };

/** 約束の種類（こちらの手打ちの文の言葉で・作らない）。新着を随時は期日が無いので見張らない */
export type PdKind = "pickup" | "check";
/**
 * 約束を読む前に、約束でない節を落とす（2026-11-21 作業員N の B1 の確かめで見つかった穴）:
 *   穴1 過去形の報告（「御見積書をお送りさせて頂きました」「確認させて頂きましたところ」）は約束でない
 *   穴2 条件つき（「ご条件お送り頂きますと、ピックアップさせて頂きます」）は、お客様が条件を送るまで期限が始まらない＝約束に数えない
 *   節は 。！!？?・改行 で切る（同じ節の中に条件の言葉があれば、その節だけ落とす）
 */
export function promiseClausesOf(text: string): string {
  const t = String(text ?? "").normalize("NFKC");
  // 条件ヒアリングの用紙を送った直後の「ご条件に合ったお部屋ピックアップさせて頂きます！！お手隙の際にご入力ください」も条件つき（お客様の入力待ち・dfa8a68f）
  if (/ご入力(?:ください|下さい|の程|をお願い|頂けますと)/.test(t)) return "";
  return t.split(/(?<=[。！!？?\n])/).filter((c) =>
    !/(?:頂き|いただき|致し|いたし)ました(?:[！!。？?\n]|ところ|$)/.test(c) &&
    !/(?:頂き|いただき)ますと|(?:頂|いただ)ければ|(?:頂|いただ)けましたら|(?:頂|いただ)けますと|(?:下さ|くださ)いましたら/.test(c),
  ).join("");
}
export function promiseDropKindOf(text: string): PdKind | null {
  const t = promiseClausesOf(text);
  if (/新着/.test(t) && !/ピックアップ/.test(t)) return null;
  if (/ピックアップ(?:させて頂|して(?:お送り|送らせ)|出来次第お送り|でき次第お送り)|お部屋(?:を)?(?:新たに)?(?:探|お探し)して(?:お送り|送らせ)/.test(t)) return "pickup";
  if (/(?:募集状況|空き状況|空室状況)(?:を)?(?:確認|お調べ)させて頂|管理会社(?:に|へ)(?:確認|交渉)させて頂/.test(t)) return "check";
  return null;
}
/** 約束を果たした印（物件・確認の結果・見積の AIX か、物件の送付） */
const FULFIL_AIX = /property|recommend|check_result|estimate|pickup/;
/** お客様が探すのを止めた・他で決めた（見張らない） */
// 2026-11-21 本番の試しで直した: お客様の「部屋決まった」・こちらの締め（「無事お部屋決まりよかったです」「またお引越しの機会」）も止めた印
// 確認の約束は、こちらの手打ちの文で結果を伝えて果たす事もある（「管理会社より…」「確認させて頂きましたところ」）
const CHECK_ANSWERED_RE = /確認(?:させて頂き|致し|いたし|し)ましたところ|管理会社(?:より|から|様より)|募集(?:中|終了|が終了|停止)|(?:申込|お申込み?)(?:が)?(?:入って|入り)/;
const STAFF_CLOSED_RE = /お部屋(?:が)?決まり(?:よかった|良かった|おめでとう)|またお引越しの機会/;
const STOPPED_RE = /部屋(?:が|は)?決ま(?:った|りました|りまし)|他(?:社|の(?:所|ところ|不動産))?で(?:決ま|決め)|決まりました|見送|(?:もう|一旦|いったん)(?:大丈夫|結構|探すのをやめ)|探すのをやめ|キャンセル(?:で|します)/;
const STOP_STATUS = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost", "closed", "cancelled", "lost", "dropped", "won"]);

// ─── 2026-11-21 作業員N（信頼の土台 B1・約束を期限内に果たした割合）と線をそろえた共有の決まり ───
/** 約束の種類の名前（B1 と #435 で同じ文字列）。果たした判定ができるのは pickup・check・estimate だけ */
export const PROMISE_KIND_NAMES = ["pickup", "check", "estimate", "viewing_slot", "callback", "other"] as const;
export type PromiseKindName = typeof PROMISE_KIND_NAMES[number];
export const PROMISE_KIND_JUDGEABLE: ReadonlySet<PromiseKindName> = new Set<PromiseKindName>(["pickup", "check", "estimate"]);
/** こちらの手打ちの文の約束の種類（約束でなければ null）。新着を随時は期日が無いので null */
export function promiseKindNameOf(text: string): PromiseKindName | null {
  const k = promiseDropKindOf(text);
  if (k) return k;
  const t = promiseClausesOf(text);
  if (/新着/.test(t) && !/ピックアップ/.test(t)) return null;
  if (/御?見積(?:書)?(?:を)?(?:作成|お作り)(?:して|させて頂)|御?見積(?:書)?(?:を)?お送りさせて頂/.test(t)) return "estimate";
  if (/内覧(?:の)?(?:候補日?|日程|ご日程|お日にち)(?:を)?(?:確認|お調べ|お送り)させて頂|ご案内(?:可能な)?(?:日時|お時間)(?:を)?確認させて頂/.test(t)) return "viewing_slot";
  if (/(?:折り返し|改めて)(?:お電話|ご連絡のお電話)させて頂|お電話させて頂/.test(t)) return "callback";
  if (/させて頂きます/.test(t) && /(?:確認|お調べ|お送り|ご連絡)/.test(t)) return "other";
  return null;
}
/** 期限: 約束の文の期限の言葉（promise-due.promiseDueDay・「明日」「本日中」「週明け」「〇日までに」）ならその日の終わり（JST 24時）、無ければ 72時間 */
export function promiseDeadlineMs(text: string, atMs: number): { ms: number; by: "words" | "default72h" } {
  const t = String(text ?? "").normalize("NFKC");
  // 「出来次第」「確認出来次第」は期限の言葉にしない（作業員N と決めた）。挨拶の「本日はお時間…」も期限にしない
  const scrubbed = t.replace(/(?:確認)?(?:出来|でき)次第/g, "").replace(/本日は(?:お時間|ご内覧|お電話|ありがとう)[^。！\n]*/g, "");
  const d = promiseDueDay(scrubbed, atMs);
  return d != null ? { ms: d + 86_400_000 - 9 * 3_600_000, by: "words" } : { ms: atMs + PROMISE_DROP_MIN_H * 3_600_000, by: "default72h" };
}
const ESTIMATE_SENT_RE = /(?:御見積書|お見積(?:もり|り)?書?)(?:と)?(?:なります|になります|お送りさせて頂きました|お送り致しました|送らせて頂きました|添付)/;
export type PromiseEvidence = { msgs: ReadonlyArray<PdMsg>; aix: ReadonlyArray<PdAix>; sent: ReadonlyArray<PdSent> };
/**
 * 果たした印（約束の後の最初の物）。pickup・check・estimate だけ判定し、他は "n/a"（判定なし）。果たしていなければ null。
 *   AIX（物件・確認の結果・見積・ピックアップ。estimate は見積だけ）／お客様に届いた物件の送付（line_group は呼ぶ側で外す）／
 *   check はこちらの手打ちの文で結果を伝えた時も
 */
export function promiseFulfilledBy(promise: { at: string; kind: PromiseKindName }, ev: PromiseEvidence): { by: string; at: string } | null | "n/a" {
  if (!PROMISE_KIND_JUDGEABLE.has(promise.kind)) return "n/a";
  const t0 = Date.parse(promise.at);
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > t0;
  const re = promise.kind === "estimate" ? /estimate/ : FULFIL_AIX;
  const cands: Array<{ by: string; at: string }> = [];
  for (const a of ev.aix) { const at = a.sent_at ?? a.created_at; if (after(at) && re.test(String(a.aix_type ?? ""))) cands.push({ by: `aix:${a.aix_type}`, at }); }
  if (promise.kind !== "estimate") for (const s of ev.sent) if (after(s.sent_at)) cands.push({ by: "sent_properties", at: s.sent_at as string });
  if (promise.kind === "check") for (const m of ev.msgs) if (m.sender === "staff" && !m.is_aix_generated && after(m.created_at) && CHECK_ANSWERED_RE.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "staff_text", at: m.created_at });
  // 2026-11-21 作業員N の B1 の数え（見積の約束2つが AIX 無しで「果たしていない」）: こちらの手打ちの文で御見積書を送った番も果たした
  //   （「御見積書となります」「お見積りお送りさせて頂きました」。「作成させて頂きます」は約束なので数えない。画像だけの送付は中身が分からないので数えない）
  if (promise.kind === "estimate") for (const m of ev.msgs) if (m.sender === "staff" && !m.is_aix_generated && after(m.created_at) && ESTIMATE_SENT_RE.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "staff_text", at: m.created_at });
  // 穴3（作業員N）: 見積を確認の結果の AIX（物件確認した）に同封した番＝こちらの AIX の文に「御見積書」「初期費用」があれば果たした
  if (promise.kind === "estimate") for (const m of ev.msgs) if (m.sender === "staff" && m.is_aix_generated && after(m.created_at) && /御見積書|お見積(?:もり|り)?書?|初期費用/.test(String(m.text ?? "").normalize("NFKC"))) cands.push({ by: "aix_text", at: m.created_at });
  return cands.sort((x, y) => x.at.localeCompare(y.at))[0] ?? null;
}
/** 見張らない会話か（申込以降・お客様が決めた・こちらが締めた）。約束の時刻より後の発言で見る */
export function promiseClosedConversation(status: string | null, msgs: ReadonlyArray<PdMsg>, sinceIso: string): boolean {
  if (status && STOP_STATUS.has(status)) return true;
  const t0 = Date.parse(sinceIso);
  return msgs.some((m) => Date.parse(m.created_at) > t0 && (
    (m.sender === "customer" && STOPPED_RE.test(String(m.text ?? "").normalize("NFKC"))) ||
    (m.sender === "staff" && STAFF_CLOSED_RE.test(String(m.text ?? "").normalize("NFKC")))));
}

/** 同じ番（次のお客様の発言まで）の後ろの通で、条件の用紙（AIX の「ご希望のお部屋探しご条件」）か「ご入力ください」を送った＝お客様の入力待ちの約束（dfa8a68f の形） */
function inputWaitTurn(ms: ReadonlyArray<PdMsg>, j: number): boolean {
  for (let x = j + 1; x < ms.length && ms[x].sender !== "customer"; x++) {
    const t = String(ms[x].text ?? "").normalize("NFKC");
    if (/ご希望のお部屋探しご条件|ご入力(?:ください|下さい|の程|をお願い|頂けますと)/.test(t)) return true;
  }
  return false;
}

/** 1つの会話の、期限を過ぎて果たしていない約束（全部・同じ種類の言い直しは新しい方1つ）。事実だけ（作業員N の統括の材料 CONDUCTOR_OVERDUE_PROMISES 用） */
export type OverduePromise = { kind: PromiseKindName; promisedAt: string; dueAt: string; dueBy: "words" | "default72h"; daysOver: number };
export function overduePromisesOf(input: Pick<PdInput, "status" | "msgs" | "aix" | "sent">, nowMs: number, o: { maxDays?: number } = {}): OverduePromise[] {
  const maxDays = o.maxDays ?? PROMISE_DROP_MAX_DAYS;
  const ms = [...input.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byKind = new Map<PromiseKindName, { at: string; text: string }>();
  for (let j = 0; j < ms.length; j++) {
    const m = ms[j];
    if (m.sender !== "staff" || m.is_aix_generated || inputWaitTurn(ms, j)) continue;
    const k = promiseKindNameOf(String(m.text ?? ""));
    if (!k || !PROMISE_KIND_JUDGEABLE.has(k)) continue;
    // 種類ごとに一番新しい約束1つ（果たす前の言い直しは新しい方にまとまる・果たした後の新しい約束も新しい方を見る）
    byKind.set(k, { at: m.created_at, text: String(m.text ?? "") });
  }
  const out: OverduePromise[] = [];
  for (const [kind, p] of byKind) {
    const t0 = Date.parse(p.at);
    if ((nowMs - t0) / 864e5 > maxDays) continue;
    const due = promiseDeadlineMs(p.text, t0);
    if (nowMs < due.ms) continue;
    if (promiseFulfilledBy({ at: p.at, kind }, { msgs: ms, aix: input.aix, sent: input.sent })) continue;
    if (promiseClosedConversation(input.status, ms, p.at)) continue;
    out.push({ kind, promisedAt: p.at, dueAt: new Date(due.ms).toISOString(), dueBy: due.by, daysOver: Math.floor((nowMs - due.ms) / 864e5) });
  }
  return out.sort((a, b) => a.promisedAt.localeCompare(b.promisedAt));
}

export type PromiseDrop = {
  conversationId: string; customerName: string | null; kind: PdKind; promisedAt: string; days: number;
  /** 約束の後にお客様の発言があったか（お礼1回で黙った等） */
  customerSpokeAfter: boolean;
  /** 約束の後に取り下げた要対応の数（ブレインが立てたがスタッフが外した） */
  dismissedAfter: number;
  /** 約束の後に作られ、まだ送っていない売上サポの候補の数 */
  readyPicksAfter: number;
};

/** 1つの会話: 一番新しい約束が 72時間を過ぎて果たされていなければ1件（それ以外は null） */
export function promiseDropOf(input: PdInput, nowMs: number, o: { minH?: number; maxDays?: number } = {}): PromiseDrop | null {
  if (input.status && STOP_STATUS.has(input.status)) return null;
  const minH = o.minH ?? PROMISE_DROP_MIN_H, maxDays = o.maxDays ?? PROMISE_DROP_MAX_DAYS;
  const ms = [...input.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let promise: { at: string; kind: PdKind; text: string } | null = null;
  for (let j = 0; j < ms.length; j++) {
    const m = ms[j];
    if (m.sender !== "staff" || m.is_aix_generated || inputWaitTurn(ms, j)) continue;
    const k = promiseDropKindOf(String(m.text ?? ""));
    if (k) promise = { at: m.created_at, kind: k, text: String(m.text ?? "") };
  }
  if (!promise) return null;
  const t0 = Date.parse(promise.at);
  const ageH = (nowMs - t0) / 36e5;
  // 期限（作業員N の B1 と同じ）: 文の期限の言葉の日の終わり／無ければ 72時間。minH を渡された時はそれを使う（テスト）
  const due = o.minH != null ? t0 + minH * 36e5 : promiseDeadlineMs(promise.text, t0).ms;
  if (!(nowMs >= due) || ageH > maxDays * 24) return null;
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > t0;
  if (promiseFulfilledBy({ at: promise.at, kind: promise.kind }, { msgs: ms, aix: input.aix, sent: input.sent })) return null;
  if (promiseClosedConversation(input.status, ms, promise.at)) return null;
  const custAfter = ms.filter((m) => m.sender === "customer" && after(m.created_at));
  return {
    conversationId: input.conversationId, customerName: input.customerName, kind: promise.kind, promisedAt: promise.at,
    days: Math.floor(ageH / 24), customerSpokeAfter: custAfter.length > 0,
    dismissedAfter: input.items.filter((i) => i.status === "dismissed" && after(i.created_at)).length,
    readyPicksAfter: input.picks.filter((p) => after(p.created_at) && !p.sent_at && !p.expired_at && (p.status ?? "pending") === "pending").length,
  };
}

/** 売上番長グループに出す文（対象が無ければ null）。古い順・最大 maxLines 行 */
export function buildPromiseDropPost(drops: ReadonlyArray<PromiseDrop>, nowMs: number, maxLines = 20): string | null {
  if (!drops.length) return null;
  const d = new Date(nowMs + 9 * 3600_000);
  const head = `【AIX要対応・お約束した物件がまだ届いていません】${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const sorted = [...drops].sort((a, b) => a.promisedAt.localeCompare(b.promisedAt));
  const lines = sorted.slice(0, maxLines).map((x) => {
    const button = aixButtonText(x.kind === "pickup" ? "property_send" : "property_check_result");
    const notes = [`お約束から${x.days}日`, x.readyPicksAfter ? `候補${x.readyPicksAfter}件あり` : "", x.dismissedAfter ? "要対応を外した後" : ""].filter(Boolean).join("・");
    return `・${x.customerName || "お客様"}さん → ${button}（${notes}）`;
  });
  return [head, "", ...lines, "", `${drops.length}件${drops.length > maxLines ? `（古い順に${maxLines}件）` : ""}。送ったら自動で外れます`].join("\n");
}

/** 1日1回か（その日にまだ出していない時だけ・JST の日付） */
export function promiseDropDue(lastIso: string | null | undefined, nowMs: number): boolean {
  if (!lastIso) return true;
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const last = Date.parse(lastIso);
  return !Number.isFinite(last) || day(last) < day(nowMs);
}
