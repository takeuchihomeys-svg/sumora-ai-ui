// scripts/lib/read-windows.ts — 穴の型③「読む窓が狭くて届かない」の決め（純関数・作業員N2・2026-11-21・台帳 #505）
//
// 統括役 11/21（竹内さん「他に土台として弱い部分があれば強化する そして細部も強化する」）の5つの型の③。
//   実例: 時系列の帳面がブレインの窓（直近20通）の中のお客様の発言しか読まず、入居の時期「11月末」など窓の外の言葉が漏れていた（作業員L f69a989aa・SITUATION_TIMELINE_WIDE）。
//   材料を読む所ごとに「その会話で、材料が窓の外にあるか」を決める。窓の外にある会話の割合が高い窓＝広げるか、要約・別読みで補う候補。
//   一覧（where はコードの場所・limit は今の読む上限）。窓を変えたらこの一覧も変える（点検が古い窓で数えないように）。
import { buildTimeline } from "../../app/lib/situation-timeline";

export type WinMsg = { sender: string; text: string | null; atMs: number };
/** 会話1つ・判断1回の材料の数（新しい順の発言・その他は数だけ） */
export type WinCase = {
  conv: string;
  atMs: number;
  /** 判断の時までの発言（新しい順・読めた所まで） */
  msgs: ReadonlyArray<WinMsg>;
  /** 判断の時までの発言の総数 */
  total: number;
  /** その時の最新のセーブデータの位置（message_count_at_creation）・無ければ null */
  cpAt: number | null;
  sentProps: number;
  sharedProps: number;
  /** カレンダーの予定のうち判断の60日前より後に始まる物 */
  calendar60: number;
  /** 送ったピックアップ（status=sent）のうち60日より前の物・60日の中の物 */
  pickupsOld: number;
  pickups60: number;
  estimates: number;
};

export type ReadWindow = { id: string; label: string; where: string; limit: string; stage: string; outside: (c: WinCase, o: WinOpts) => boolean; why: string };
/** 本番の既定の窓（呼ぶ側がスイッチから入れる）。sentPropsLimit は SENT_PROPS_FULL（既定 count）で80・off で20 */
export type WinOpts = { brainWindow: number; timelineWide: boolean; sentPropsLimit?: number };

const DAY = 86_400_000;
const PROPERTY_HINT = /https?:\/\/|号室|マンション|ハイツ|コーポ|レジデンス|ハイム|荘/;

/** 窓の外の発言のうち、まだ先（判断の時より後）を指す時の言葉があるか */
function futureTimeWordOutside(c: WinCase, outsideCustomer: ReadonlyArray<WinMsg>): boolean {
  if (!outsideCustomer.length) return false;
  const words = buildTimeline({ customerMsgs: [...outsideCustomer].reverse(), calendar: [], nowMs: c.atMs }).words;
  return words.some((w) => (w.toMs ?? w.fromMs ?? 0) >= c.atMs);
}

export const READ_WINDOWS: ReadWindow[] = [
  {
    id: "brain.msg", label: "ブレインの会話の窓", where: "app/lib/brain-core.ts analyzeConversation（messages・BRAIN_MSG_WINDOW）", limit: "直近20通", stage: "read",
    why: "セーブデータ（15通ごとの要約）の位置から窓の始まりまでの発言が、要約にも窓にも載らない（audit-brain-window と同じ数え方）",
    outside: (c, o) => c.total - (c.cpAt ?? 0) - o.brainWindow > 0,
  },
  {
    id: "timeline.customer", label: "時系列の帳面（お客様の発言）", where: "app/lib/brain-core.ts situationTimeline（SITUATION_TIMELINE_WIDE=on で40通）", limit: "窓の中のお客様の発言（WIDE=on で直近40通）", stage: "read",
    why: "まだ先を指す時の言葉（入居の時期・内覧の日など）が読む窓より前の発言にある（直近200通まで見る）",
    outside: (c, o) => {
      const cust = c.msgs.filter((m) => m.sender === "customer");
      const inWin = o.timelineWide ? 40 : c.msgs.slice(0, o.brainWindow).filter((m) => m.sender === "customer").length;
      return futureTimeWordOutside(c, cust.slice(inWin, 200));
    },
  },
  {
    id: "promise.14d", label: "約束の台帳（直近14日）", where: "app/lib/brain-core.ts promiseRows（古い順に limit 400）", limit: "14日・400通", stage: "read",
    why: "14日の発言が400通を超えると、古い順に読むので新しい方（今の約束）が落ちる",
    outside: (c) => c.msgs.filter((m) => m.atMs >= c.atMs - 14 * DAY).length > 400,
  },
  {
    id: "researcher.customer_shared", label: "調べる係: お客様が送ってきた物件", where: "app/lib/brain-researcher-server.ts customer_shared", limit: "お客様の発言 200通", stage: "read",
    why: "お客様の発言200通より前に、物件の URL・号室・建物名らしい発言がある",
    outside: (c) => c.msgs.filter((m) => m.sender === "customer").slice(200).some((m) => PROPERTY_HINT.test(m.text ?? "")),
  },
  {
    id: "researcher.past_lines", label: "調べる係: 過去の会話の一節", where: "app/lib/brain-researcher-server.ts past_lines", limit: "直近400通", stage: "read",
    why: "会話が400通を超え、それより前の一節は探せない",
    outside: (c) => c.total > 400,
  },
  {
    id: "sent_props", label: "送った物件（再提案しない・NG の元）", where: "app/lib/brain-core.ts sentProps（SENT_PROPS_FULL 既定 count で80件・off で20件）", limit: "80件（off で20件）", stage: "read",
    why: "送った物件が読む上限（既定80件）を超え、古い物件が「もう送った」から外れる（2026-11-21 実物で照らした: 上限を20と置いて数えると13.8%と高く見えた＝本番は SENT_PROPS_FULL=count で80件）",
    outside: (c, o) => c.sentProps > (o.sentPropsLimit ?? 80),
  },
  {
    id: "shared_props", label: "共有した物件（line_group）", where: "app/lib/brain-core.ts sentProps の共有のみ", limit: "20件", stage: "read",
    why: "共有した物件が20件を超え、ng_properties・再提案しないから外れる",
    outside: (c) => c.sharedProps > 20,
  },
  {
    id: "pickups.sent60d", label: "送ったピックアップの入居時期（審査の部屋）", where: "app/lib/brain-core.ts buildScreeningRoomsBrainText（60日・60件）", limit: "60日・60件", stage: "tool_rank",
    why: "60日より前に送ったピックアップがある（その部屋の入居時期・条件が窓の外）か、60日で60件を超える",
    outside: (c) => c.pickupsOld > 0 || c.pickups60 > 60,
  },
  {
    id: "calendar.60d", label: "カレンダー（時系列の帳面）", where: "app/lib/brain-core.ts situationTimeline の calendar_events（60日・40件）", limit: "60日・40件", stage: "read",
    why: "60日の予定が40件を超え、新しい予定が落ちる（古い順に読む）",
    outside: (c) => c.calendar60 > 40,
  },
  {
    id: "estimates", label: "見積の記録", where: "app/lib/brain-core.ts estimate_records（20件）", limit: "20件", stage: "tool_api",
    why: "見積の記録が20件を超え、古い見積が材料から外れる",
    outside: (c) => c.estimates > 20,
  },
];

export type WindowMiss = { id: string; label: string; where: string; limit: string; stage: string; why: string; n: number; outside: number; rate: number | null; convs: string[] };

/** 窓ごとに「材料が窓の外にある会話」の数と割合（純関数）。convs は会話の id の頭8字だけ */
export function windowMissOf(cases: ReadonlyArray<WinCase>, o: WinOpts, windows: ReadonlyArray<ReadWindow> = READ_WINDOWS): WindowMiss[] {
  return windows.map((w) => {
    const hit = cases.filter((c) => { try { return w.outside(c, o); } catch { return false; } });
    return { id: w.id, label: w.label, where: w.where, limit: w.limit, stage: w.stage, why: w.why, n: cases.length, outside: hit.length, rate: cases.length ? Math.round((hit.length / cases.length) * 1000) / 10 : null, convs: hit.map((c) => c.conv.slice(0, 8)) };
  });
}

/** 穴にする線: 割合 5% 以上かつ2会話以上 */
export const WINDOW_MISS_LINE = { rate: 5, convs: 2 };
export const isWindowGap = (m: WindowMiss) => m.rate != null && m.rate >= WINDOW_MISS_LINE.rate && m.outside >= WINDOW_MISS_LINE.convs;
