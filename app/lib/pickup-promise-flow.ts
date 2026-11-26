// app/lib/pickup-promise-flow.ts — 探す約束の後のお礼だけの番（竹内さんの決め 11/26 01時台・台帳 #744・決まった計算・LLM なし）
// 2026-11-26 作業員A（竹内さん「はい（推奨）」）: 物件をお探しすると約束した後に、お客様が「ありがとうございます」だけ返した時、
//   送れる物件（ピックアップの待ち）がもう揃っていれば返信はせず【物件ピックアップした】、まだ揃っていなければ受けの短い返信（揃い次第お送りします）。
//   根拠（#744・前24時間に物件を送ってきた竹内さん本人の番）: 揃っている時 AIX 2/2・揃っていない時 返信 4／AIX 2（AIX は2時間以上後に揃えてから）。
//   10/21 の決め（お礼には返信せず AIX）は「揃っている時」に当たる。置き方は BRAIN_CHECK_PROMISE_FLOW と同じ（材料の1行・ブレインの判断は上書きしない）。
//   スイッチ BRAIN_PICKUP_PROMISE_FLOW: 既定 off（材料に入れない）／on
import { isAckOnlyTurn } from "./ack-topic-scope";

export function brainPickupPromiseFlowOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_PICKUP_PROMISE_FLOW ?? "").trim().toLowerCase() === "on";
}
/** 探す約束の語（audit-split-turns・PREV_PROMISE_OF の物件の約束と同じ網） */
export const PICKUP_PROMISE_RE = /ピックアップ[^。！\n]{0,20}(?:お送り|させて頂きます|させていただきます)|出次第[^。！\n]{0,10}お送り|お探し(?:して|させて)/;
type Msg = { sender: string; text: string | null; createdAt: string; isAix?: boolean };
type Aix = { aix_type?: string | null; sent_at?: string | null; created_at?: string | null };
export type PickupFlow = { scene: "ack_ready" | "ack_not_ready" | null; promised: boolean; fulfilled: boolean; pending: number | null };

/** 場面（純関数）。pending＝送れる候補（property_pickups の待ち）の数（分からない時は null＝場面にしない） */
export function pickupPromiseFlowOf(messages: ReadonlyArray<Msg>, aixRows: ReadonlyArray<Aix>, pending: number | null, now: number): PickupFlow {
  const ms = messages.filter((m) => Date.parse(m.createdAt) <= now).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let k = ms.length - 1;
  while (k >= 0 && ms[k].sender === "customer") k--;
  const burst = ms.slice(k + 1);
  const none: PickupFlow = { scene: null, promised: false, fulfilled: false, pending };
  if (!burst.length || k < 0) return none;
  const prev = ms[k];
  const burstAt = Date.parse(burst[0].createdAt);
  const promised = prev.sender !== "customer" && !prev.isAix && PICKUP_PROMISE_RE.test(String(prev.text ?? "")) && burstAt - Date.parse(prev.createdAt) <= 86_400_000;
  if (!promised) return none;
  const pAt = Date.parse(prev.createdAt);
  const fulfilled = aixRows.some((a) => /^(?:property_send|property_recommendation)/.test(String(a.aix_type ?? "")) && (() => { const t = Date.parse(String(a.sent_at ?? a.created_at ?? "")); return Number.isFinite(t) && t > pAt && t <= now; })());
  const out: PickupFlow = { scene: null, promised, fulfilled, pending };
  if (fulfilled || pending == null || !isAckOnlyTurn(burst.map((m) => String(m.text ?? "")).join("\n"))) return out;
  return { ...out, scene: pending > 0 ? "ack_ready" : "ack_not_ready" };
}
/** 材料の1行（当たらない時は ""） */
export function pickupPromiseFlowLine(f: PickupFlow | null): string {
  if (!f?.scene) return "";
  return f.scene === "ack_ready"
    ? `【探す約束の後のお礼（竹内さんの決め 11/26）】送れる候補 ${f.pending}件が揃っている → この番は返信を書かず、AIX【物件ピックアップした】（property_send）で約束を果たす（aix の欄は property_send）`
    : "【探す約束の後のお礼（竹内さんの決め 11/26）】送れる候補がまだ揃っていない → 受けの短い返信（「ピックアップ出来次第お送りさせて頂きます」の形・日付や条件を並べ直さない）。揃ったら AIX【物件ピックアップした】";
}
