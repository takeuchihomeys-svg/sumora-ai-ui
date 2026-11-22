// scripts/lib/promise-stuck-dig.ts — 誘導の穴 #414 の掘り（純関数・LLM なし・DB なし・費用0）
//
// 2026-11-19 作業員L（統括役の 11/19 昼の頼み 3）: 誘導の物差し（guide-measure）60日で「物件提案中（proposing）× 返信で約束（reply:promise）」
//   35番のうち 23番が「止まった」。止まった理由を、外れの3つ（①材料が届いていない ②場面の読み違い ③AIX で送るべき番を返信にした）と
//   物差しの作り（④測り方の都合: 約束の番の次の返事は「ありがとうございます」で、約束を果たす前に窓が閉じる）に分けるための1番ごとの記録を作る。
//   1番ごとに: 約束の種類／その時に送れる候補（売上サポの pending）があったか／約束を果たしたか・何時間後・何で（AIX の種類・物件の送付）／
//   果たす前にお客様が返事したか・その返事の型／果たした後の次の返事と駅（測り直し）／竹内さんの次の番の一手。
import { classifyCustomerBurst, type ReactionCat } from "../../app/lib/customer-reaction-predict";
import { MAIN_ROUTE, type RouteNodeId } from "../../app/lib/apply-route-map";
import { closeKindOf, nodeOfStage, type GMsg, type GAix, type GDecision } from "./guide-measure";

export type GSent = { sent_at: string | null };
export type GPick = { created_at: string; expired_at: string | null; sent_at?: string | null; status?: string | null };

/** 約束の中身（竹内さんの文の言葉で決まった形に分ける・作らない） */
export type PromiseKind = "pickup" | "new_arrival" | "check" | "estimate" | "other";
export function promiseKindOf(text: string): PromiseKind {
  const t = text.normalize("NFKC");
  if (/新着/.test(t)) return "new_arrival";
  if (/御?見積/.test(t)) return "estimate";
  if (/ピックアップ/.test(t)) return "pickup";
  if (/確認(?:出来|でき)次第|確認させて頂き|お調べ|管理会社/.test(t)) return "check";
  return "other";
}
export const PROMISE_KIND_JA: Record<PromiseKind, string> = { pickup: "物件のピックアップ", new_arrival: "新着を随時", check: "確認（管理会社・募集）", estimate: "見積書", other: "その他" };

/** 約束を果たした印になる AIX の種類（物件・確認の結果・見積） */
const FULFIL_AIX = /property|recommend|check_result|estimate|pickup|new_arrival/;

export type PromiseDigRow = {
  conv: string; at: string; kind: PromiseKind;
  /** その時に送れる候補（3日以内・期限切れでない・まだ送っていない pending）の数＝③（約束でなく物件を送る AIX の番だった）の候補 */
  pendingAtPromise: number;
  /** 約束を果たした時刻までの時間（AIX の物件・確認の結果・見積、または物件の送付）。null＝窓（72時間）の中で果たしていない */
  fulfilHours: number | null; fulfilBy: string | null;
  /** 果たす前にお客様が返事したか・その返事の型（④ 測り方の都合の見分け） */
  replyBeforeFulfil: ReactionCat | "none";
  /** 約束の番の直後の駅（前）と、果たした後の次のお客様の返事の後の駅（測り直し） */
  before: RouteNodeId | null; afterFulfilReply: RouteNodeId | null; afterFulfilReplyCat: ReactionCat | "silent" | "not_fulfilled";
  /** 測り直しの結果 */
  remeasured: "advanced" | "stuck" | "back" | "left" | "not_fulfilled";
  /** 竹内さんの次の番の一手（約束の後の次の竹内さんの番） */
  nextAct: string | null;
  /** 分け（推定・22時の目で読む時の入口） */
  bucket: "③候補があったのに約束" | "④約束待ちのお礼で窓が閉じた" | "約束を果たさず止まった" | "果たした後も止まった" | "果たして進んだ" | "その他";
};

const idx = (n: RouteNodeId | null) => (n ? MAIN_ROUTE.indexOf(n) : -1);
const H = 36e5;

/** 1つの会話から、proposing × reply:promise の番を掘る（古い順の messages・AIX・判断・送付・候補） */
export function promiseStuckRowsOf(
  conv: string, msgs: ReadonlyArray<GMsg>, aix: ReadonlyArray<GAix>, decisions: ReadonlyArray<GDecision>,
  sent: ReadonlyArray<GSent>, picks: ReadonlyArray<GPick>, o: { windowH?: number; fulfilWindowH?: number; beforeNode?: RouteNodeId } = {},
): PromiseDigRow[] {
  const windowH = o.windowH ?? 48, fulfilWindowH = o.fulfilWindowH ?? 72, want = o.beforeNode ?? "proposing";
  const ms = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const ds = [...decisions].filter((d) => d.stage).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const stageAt = (iso: string, after: boolean) => {
    const t = Date.parse(iso);
    const d = after ? ds.find((x) => Date.parse(x.created_at) >= t) : [...ds].reverse().find((x) => Date.parse(x.created_at) <= t);
    return d ? nodeOfStage(d.stage) : null;
  };
  const out: PromiseDigRow[] = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.sender !== "staff" || m.is_aix_generated || m.staff_writer !== "takeuchi") continue;
    if (i > 0 && ms[i - 1].sender === "staff") continue;
    if (!(i > 0 && ms[i - 1].sender === "customer")) continue;
    let k = i; const ours: string[] = []; while (k < ms.length && ms[k].sender !== "customer") { if (!ms[k].is_aix_generated) ours.push(String(ms[k].text ?? "")); k++; }
    const endAt = k < ms.length ? ms[k].created_at : null;
    const aixHere = aix.find((a) => { const at = a.sent_at ?? a.created_at; return at >= m.created_at && (!endAt || at < endAt); });
    if (aixHere) continue;
    const text = ours.join("\n");
    if (closeKindOf(text) !== "promise") continue;
    const before = stageAt(m.created_at, false);
    if (before !== want) continue;
    const t0 = Date.parse(m.created_at);
    // その時に送れる候補（two-stage.freshPickupReady と同じ線: 3日以内・期限切れでない・その時まだ送っていない）
    // 2026-11-21 統括役の決め: 約束が条件の言い直しを受けた新しい探しの約束（全域から・以内・含めて・絞る）なら、直前のお客様の束より前に作られた候補は
    //   古い条件の候補＝③（約束でなく物件を送る番）に数えない
    let custStart = i; while (custStart > 0 && ms[custStart - 1].sender === "customer") custStart--;
    const restateAt = RESTATE_RE.test(text.normalize("NFKC")) && custStart < i ? Date.parse(ms[custStart].created_at) : null;
    const pendingAtPromise = picks.filter((p) => {
      const c = Date.parse(p.created_at);
      if (!(c <= t0) || t0 - c > 3 * 86_400_000) return false;
      if (restateAt != null && c < restateAt) return false;
      if (p.expired_at && Date.parse(p.expired_at) <= t0) return false;
      if (p.sent_at && Date.parse(p.sent_at) <= t0) return false;
      return true;
    }).length;
    // 果たした時: 約束の後（同じ番の中の AIX は上で外した）・窓の中の最初の 物件/確認の結果/見積 の AIX か物件の送付
    const after = (iso: string | null) => iso != null && Date.parse(iso) > t0 && Date.parse(iso) - t0 <= fulfilWindowH * H;
    const fa = aix.filter((a) => after(a.sent_at ?? a.created_at) && FULFIL_AIX.test(String(a.aix_type ?? ""))).map((a) => ({ at: (a.sent_at ?? a.created_at), by: `aix:${a.aix_type}` }));
    const fs = sent.filter((s) => after(s.sent_at)).map((s) => ({ at: s.sent_at as string, by: "sent_properties" }));
    const f = [...fa, ...fs].sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
    const fulfilAt = f ? Date.parse(f.at) : null;
    // 果たす前のお客様の返事
    const custBefore: string[] = []; for (let j = k; j < ms.length && ms[j].sender === "customer" && (fulfilAt == null || Date.parse(ms[j].created_at) < fulfilAt); j++) custBefore.push(String(ms[j].text ?? ""));
    const replyBeforeFulfil: PromiseDigRow["replyBeforeFulfil"] = endAt && (fulfilAt == null || Date.parse(endAt) < fulfilAt) && Date.parse(endAt) - t0 <= windowH * H ? classifyCustomerBurst(custBefore) : "none";
    // 果たした後の次のお客様の返事（測り直し）
    let afterFulfilReply: RouteNodeId | null = null; let afterFulfilReplyCat: PromiseDigRow["afterFulfilReplyCat"] = "not_fulfilled"; let remeasured: PromiseDigRow["remeasured"] = "not_fulfilled";
    if (fulfilAt != null) {
      const ci = ms.findIndex((x) => x.sender === "customer" && Date.parse(x.created_at) > fulfilAt);
      if (ci >= 0 && Date.parse(ms[ci].created_at) - fulfilAt <= windowH * H) {
        const burst: string[] = []; for (let j = ci; j < ms.length && ms[j].sender === "customer"; j++) burst.push(String(ms[j].text ?? ""));
        afterFulfilReplyCat = classifyCustomerBurst(burst);
        afterFulfilReply = stageAt(ms[ci].created_at, true);
        remeasured = idx(afterFulfilReply) > idx(before) ? "advanced" : idx(afterFulfilReply) < idx(before) && idx(afterFulfilReply) >= 0 ? "back" : "stuck";
      } else { afterFulfilReplyCat = "silent"; remeasured = "left"; }
    }
    // 竹内さんの次の番（約束の番の後の、お客様の束の後の竹内さんの最初の通）
    let nextAct: string | null = null;
    for (let j = k; j < ms.length; j++) {
      const x = ms[j];
      if (x.sender === "staff" && !x.is_aix_generated && x.staff_writer === "takeuchi" && ms[j - 1]?.sender === "customer") {
        let e = j; const t: string[] = []; while (e < ms.length && ms[e].sender !== "customer") { if (!ms[e].is_aix_generated) t.push(String(ms[e].text ?? "")); e++; }
        const endJ = e < ms.length ? ms[e].created_at : null;
        const ax = aix.find((a) => { const at = a.sent_at ?? a.created_at; return at >= x.created_at && (!endJ || at < endJ); });
        nextAct = ax?.aix_type ? `aix:${ax.aix_type}` : `reply:${closeKindOf(t.join("\n"))}`;
        break;
      }
    }
    const bucket: PromiseDigRow["bucket"] =
      pendingAtPromise > 0 && (kindIsSend(promiseKindOf(text))) ? "③候補があったのに約束"
      : replyBeforeFulfil === "thanks" ? "④約束待ちのお礼で窓が閉じた"
      : remeasured === "not_fulfilled" ? "約束を果たさず止まった"
      : remeasured === "advanced" ? "果たして進んだ"
      : remeasured === "stuck" || remeasured === "left" ? "果たした後も止まった" : "その他";
    out.push({ conv, at: m.created_at, kind: promiseKindOf(text), pendingAtPromise, fulfilHours: fulfilAt != null ? Math.round(((fulfilAt - t0) / H) * 10) / 10 : null, fulfilBy: f?.by ?? null,
      replyBeforeFulfil, before, afterFulfilReply, afterFulfilReplyCat, remeasured, nextAct, bucket });
  }
  return out;
}
const RESTATE_RE = /全域から|以内|含めて|に絞らせ|絞らせて|条件に含め|ご条件で/;
const kindIsSend = (k: PromiseKind) => k === "pickup" || k === "new_arrival";

/** 分けの数え（分け × 約束の種類） */
export function digSummary(rows: ReadonlyArray<PromiseDigRow>): { byBucket: Record<string, number>; byKind: Record<string, number>; remeasured: Record<string, number>; medianFulfilH: number | null } {
  const c = (f: (r: PromiseDigRow) => string) => rows.reduce<Record<string, number>>((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const hs = rows.map((r) => r.fulfilHours).filter((h): h is number => h != null).sort((a, b) => a - b);
  return { byBucket: c((r) => r.bucket), byKind: c((r) => r.kind), remeasured: c((r) => r.remeasured), medianFulfilH: hs.length ? hs[Math.floor(hs.length / 2)] : null };
}
