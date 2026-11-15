// app/lib/promise-close-link.ts — 果たした通（AIX・返信）を送った時に、どの開いている約束を果たしたかを決まった形で結ぶ（純関数・DB/LLM なし）
//
// 2026-11-15 作業員L（竹内さん 11/15「約束の部分も把握や完了の部分が今弱い」・統括役の頼み4）。
//   今の行動台帳（sent_facts）は、約束の行（confirmation_promised・pickup_declared・estimate_declared）が status=promised のまま変わらず、
//   果たした行（confirmation_reported・properties_sent・estimate_sent）と結ぶ列が無い（30日: 約束 342・結び付き 0・2日以内に重ねた 105）。
//   読む側は7つの部品が別々に「後に同じ種類の済みがあるか」を時間の順で見ていて、どの物件の確認を果たしたかまでは合わない。
// ここで決める: 済みの行1つ → 結ぶ約束の行1つ（同じ会話・前に出た・まだ結ばれていない・同じ種類）。
//   物件・要件が両方に書いてあれば一致する物を全部（重ねた約束も同じ約束）、無ければ名前の無い約束を全部。結べない時は結ばない（開いたまま残す＝統括とスタッフへの指示で「果たしたか確かめる」）。
// 書き方: 約束の行の status は変えない（読む側7つの動きを変えない）。detail.closed_by に {kind, sent_at, aix_type, line_message_id, how} を足すだけ。
//   スイッチ PROMISE_CLOSE_LINK（11/15 統括役の決めで既定 on＝記録だけ・止める =off）。書くのは sent-facts.upsertFacts の後。1週間の見本（scripts/audit-promise-close-sample.ts）で確かめてから読む側を closed_by に揃える。
export const PROMISE_OF_DONE: Readonly<Record<string, string>> = { confirmation_reported: "confirmation_promised", properties_sent: "pickup_declared", estimate_sent: "estimate_declared" };
export const UNNAMED_CLOSE_MAX_MS = 7 * 86_400_000;
export const promiseCloseLinkOn = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_CLOSE_LINK ?? "on").trim().toLowerCase() !== "off"; // 2026-11-15 統括役の決め: 記録だけ（detail.closed_by を足す・status は変えない）で既定 on。止める PROMISE_CLOSE_LINK=off

export type FactForLink = { id?: string | number; kind: string; status: string; sent_at: string; aix_type?: string | null; line_message_id?: string | null; detail?: Record<string, unknown> | null };
export type CloseLink = { promiseId: string | number; closedBy: { kind: string; sent_at: string; aix_type: string | null; line_message_id: string | null; how: "same_object" | "unnamed" } };

const words = (d: Record<string, unknown> | null | undefined): string[] => {
  const o = d ?? {};
  const xs = [o.object, ...(Array.isArray(o.propertyNames) ? o.propertyNames : []), ...(Array.isArray(o.estimateFor) ? o.estimateFor : [])];
  return xs.map((x) => String(x ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/[0-9]{1,4}号室?$/, "")).filter((x) => x.length >= 2);
};

/** 済みの行（done）ごとに結ぶ約束を選ぶ（同じ会話の行の並び・古い順でも新しい順でもよい） */
export function linkPromiseClosures(rows: ReadonlyArray<FactForLink>, done: ReadonlyArray<FactForLink>): CloseLink[] {
  const used = new Set<string>(rows.filter((r) => r.detail && (r.detail as { closed_by?: unknown }).closed_by).map((r) => String(r.id)));
  const out: CloseLink[] = [];
  for (const d of [...done].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))) {
    const pk = PROMISE_OF_DONE[d.kind];
    if (!pk || d.status !== "done") continue;
    const at = Date.parse(d.sent_at);
    const cands = rows.filter((r) => r.id != null && r.kind === pk && r.status === "promised" && Date.parse(r.sent_at) < at && !used.has(String(r.id)))
      .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
    if (!cands.length) continue;
    const dw = words(d.detail);
    const match = (c: FactForLink) => { const cw = words(c.detail); return cw.length > 0 && cw.some((x) => dw.some((y) => x.includes(y) || y.includes(x))); };
    // 物件・要件が合う約束があればそれを全部（同じ約束を重ねた行も同じ約束＝一緒に閉じる）。無ければ、名前の無い約束を全部（両方に名前があって合わない約束は閉じない）
    const same = dw.length ? cands.filter(match) : [];
    // 2026-11-15 見本の目視（14日・20組）で直した: 名前の無い済みの行が「初期費用」の確認の約束を 289時間後に閉じていた（募集状況の報告で費用の約束を閉じる誤り）。
    //   名前の付いた約束は、名前の合う済みの行でしか閉じない。名前の無い約束を名前で閉じない時も、7日より前の約束は閉じない（別の話の報告で古い約束を閉じない）
    const picks = same.length ? same : cands.filter((c) => !words(c.detail).length && at - Date.parse(c.sent_at) <= UNNAMED_CLOSE_MAX_MS);
    for (const pick of picks) {
      used.add(String(pick.id));
      out.push({ promiseId: pick.id!, closedBy: { kind: d.kind, sent_at: d.sent_at, aix_type: d.aix_type ?? null, line_message_id: d.line_message_id ?? null, how: same.length ? "same_object" : "unnamed" } });
    }
  }
  return out;
}
/** 読む側が使う: 約束の行が結ばれて閉じたか */
export const promiseClosedOf = (row: { detail?: Record<string, unknown> | null }): boolean => !!(row.detail && (row.detail as { closed_by?: unknown }).closed_by);
