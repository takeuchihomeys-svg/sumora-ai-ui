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
export function promiseDropKindOf(text: string): PdKind | null {
  const t = String(text ?? "").normalize("NFKC");
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
  let promise: { at: string; kind: PdKind } | null = null;
  for (const m of ms) {
    if (m.sender !== "staff" || m.is_aix_generated) continue;
    const k = promiseDropKindOf(String(m.text ?? ""));
    if (k) promise = { at: m.created_at, kind: k };
  }
  if (!promise) return null;
  const t0 = Date.parse(promise.at);
  const ageH = (nowMs - t0) / 36e5;
  if (!(ageH >= minH) || ageH > maxDays * 24) return null;
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > t0;
  if (input.aix.some((a) => after(a.sent_at ?? a.created_at) && FULFIL_AIX.test(String(a.aix_type ?? "")))) return null;
  if (input.sent.some((s) => after(s.sent_at))) return null;
  const custAfter = ms.filter((m) => m.sender === "customer" && after(m.created_at));
  if (custAfter.some((m) => STOPPED_RE.test(String(m.text ?? "").normalize("NFKC")))) return null;
  if (promise.kind === "check" && ms.some((m) => m.sender === "staff" && !m.is_aix_generated && after(m.created_at) && CHECK_ANSWERED_RE.test(String(m.text ?? "").normalize("NFKC")))) return null;
  if (ms.some((m) => m.sender === "staff" && after(m.created_at) && STAFF_CLOSED_RE.test(String(m.text ?? "").normalize("NFKC")))) return null;
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
