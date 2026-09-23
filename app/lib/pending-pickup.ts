// app/lib/pending-pickup.ts
// 「まだ果たしていない物件ピックアップの宣言」が残っているか（純関数）。
//
// 2026-09-23 竹内「なんでこの場面 AIX の物件ピックアップがセットされていないのか。この状況は物件を次送る状況」
//
// ── 実物（1通）──
//   あっぴさん: 9/22 10:04 スタッフ「新着であっぴさんにオススメ出来るお部屋募集出次第お送りさせて頂きます！！」
//              9/23 13:48 お客様「よろしくお願いしますッ！／条件が合う物件に巡り会えたらいいなと思います」（33字の了承のみ）
//   ブレインの判断: aix=null（ルール⑧「強推し直後の了承には再推奨しない」が発火）。
//   だが同じ日の brain_strategy は「Step2: AIXボタン『物件ピックアップした』を押す」と書いていた＝戦略と毎回の分析のずれ。
//   状況は2つ動いている: ①顧客は9/21に家賃で1件を外した（反応は済み）②9/22 に次のピックアップを宣言（ボールはこちら側）。
//
// ── なぜ既存の規則で拾えなかったか ──
//   aix-task-link.resolveStaffPromiseAix は pickup_declared を
//     ・detail.watch===true（「オススメ出来るお部屋を随時**確認**し…出次第お送り」）
//     ・または「次第」を含まない宣言
//   の時だけ拾う。9/22 の文は「確認」が無いので watch=false・「次第」を含む → どちらにも当たらない。
//   さらに直前スタッフ発言でないと見ない（この日は顧客の了承が最後）。
//
// ── 実測した線 ──
//   ①「出次第お送りします」型の宣言（365日・104件）の履行率: 14日以内に実際に物件送付 83件（79.8%）・3日以内 66件（63.5%）
//      → 未履行の宣言が残っている間は「次に物件を送る」を要対応にしてよい（過半数が守っている形）。
//   ② brain_no_aix で取り下げた property_send 11件（YUMAテスト6件除く）のうち、14日以内にスタッフが実際に物件を送ったのは 6/11（55%）
//      ＝取り下げが過半数で間違い。送らなかった5件はいずれも取り下げ直後に会話が停止＝失注そのもの。逆方向の誤り（取り下げないと困る例）は0件。
//   ③「同じ約束の繰り返し」を本文から消す案は使えない: スタッフ自身のピックアップ宣言897件のうち、
//      物件を送らないまま再度宣言したのが286件＝31.9%（中央値1.4時間後）→ 出口で消すと誤削除31.9%。
//      正しい答えは文を消すことではなく AIX【物件ピックアップ】を立てて3通目の空約束でなく実物を送らせること。
//
// 台帳（action-ledger）の pickup_declared(promised) → properties_sent(done) の履行判定をそのまま使う。
// この関数は DB を読まない（brain-core・aix-action-items・監査スクリプトが同じ物を読む）。

/** 宣言が古すぎて今の要対応にしない境目（action-ledger.STALE_PROMISE_HOURS と同じ14日。履行の 79.8% はこの中に入る） */
export const PENDING_PICKUP_MAX_HOURS = 14 * 24;

export type PendingPickupFacts = {
  /** 台帳: 未履行のピックアップ宣言がある（宣言の後に物件送付が無い） */
  pickupPromisedUnfulfilled: boolean;
  /** 台帳: その宣言をした時刻 */
  pickupPromisedAt: string | null;
  /** 台帳: 最後に物件を送った時刻 */
  lastPropertiesSentAt: string | null;
};

export type PendingPickupOpts = {
  /** 今（テストで固定する） */
  now?: number;
  /** 申込以降（applying / contract / closed_won）＝次の一手は物件ではない */
  postApply?: boolean;
  /** お客様が「これから自分で物件を送る」と予告している（あや事例・届く前は AIX なし） */
  customerWillSend?: boolean;
};

export type PendingPickupResult = {
  /** 未履行のピックアップ宣言が残っている（＝次にやることは物件を送ること） */
  pending: boolean;
  /** 宣言からの経過時間（時間）。不明なら null */
  hours: number | null;
  /** なぜそう決めたか（digest・監査で読む） */
  reason:
    | "pending_pickup"
    | "no_promise"
    | "fulfilled"
    | "stale"
    | "post_apply"
    | "customer_will_send"
    | "unknown_time";
};

const MS_H = 3_600_000;

/** 未履行のピックアップ宣言が残っているか（決定論・DBに触らない） */
export function resolvePendingPickup(
  facts: PendingPickupFacts,
  opts: PendingPickupOpts = {},
): PendingPickupResult {
  const now = opts.now ?? Date.now();
  const at = Date.parse(facts.pickupPromisedAt ?? "");
  const hours = Number.isFinite(at) ? (now - at) / MS_H : null;
  if (!facts.pickupPromisedUnfulfilled) return { pending: false, hours, reason: "no_promise" };
  // 宣言の後に物件を送っていれば果たし済み（台帳の fulfilledBy と同じ意味。時刻でも二重に見る）
  const sent = Date.parse(facts.lastPropertiesSentAt ?? "");
  if (Number.isFinite(at) && Number.isFinite(sent) && sent >= at) return { pending: false, hours, reason: "fulfilled" };
  if (opts.postApply) return { pending: false, hours, reason: "post_apply" };
  if (opts.customerWillSend) return { pending: false, hours, reason: "customer_will_send" };
  // 2026-09-23 反証者の指摘: 宣言の時刻が無い（line_task 由来の台帳エントリは at が null になり得る）と14日の線も
  //   「宣言の後に送ったか」も効かず常に pending になっていた。時刻が分からない時は立てない（fail-closed）
  if (hours === null) return { pending: false, hours, reason: "unknown_time" };
  if (hours > PENDING_PICKUP_MAX_HOURS) return { pending: false, hours, reason: "stale" };
  return { pending: true, hours, reason: "pending_pickup" };
}
