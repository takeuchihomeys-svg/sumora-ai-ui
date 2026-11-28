// scripts/lib/unfinished-audit.ts — 打ち合わせして抜けている部分の棚卸し（純関数・DB なし・LLM なし）
// 2026-11-27 作業員L（竹内さん 11/27「打ち合わせして抜けてしまってる部分もちゃんと作業行ったら」・統括役の頼み・memory feedback_finish_all_unfinished.md と同じ考え）
//   3つに分ける: ① 決まったのに台帳に行が無い（現行の P0/P1 の竹内さんの決定・承認・指示の行で、台帳の kb_ids・題・次の手・スイッチ名のどれにもつながらず、
//                 applied_to が空か「未・予定・待ち・これから」の物＝作ったと書いていない）
//               ② 台帳にあるのに動いていない（todo・building のまま・頼まれて 14日以上・最後の動きから QUIET_DAYS 日以上。台帳は 11/18 からなので頼まれた日で見る）
//               ③ 作ったが off のまま（スイッチの一生の表の候補＝試す・印が先・退役／作って 14日以上・試験が無いか 14日以上前）
//   分野と効く見込み（高・中・低）は決まった言葉の当てはめ。決めるのは統括役
export type Area = "返信" | "AIX" | "地図" | "統括" | "物件検索" | "見積" | "内覧" | "費用" | "その他";
const AREA_RES: Array<[Area, RegExp]> = [
  ["物件検索", /拡張|物件検索|リアプロ|itandi|ITANDI|レインズ|reins|playbook|手順書|Chrome/],
  ["見積", /見積|estimate/],
  ["内覧", /内覧|viewing/],
  ["費用", /費用の上限|API 費用|API費用|コスト|プロンプトキャッシュ|DeepSeek に回|OpenAI|Claude の特典|llm_usage|試験の費用|試験の効率/],
  ["地図", /地図|駅|申込まで|逆算|apply-route|route_|ROUTE_|BACKPLAN|細かい状態|substate/],
  ["AIX", /AIX|aix|ボタン|ピッカー|2通目|物件確認した|物件ピックアップした|オススメ|RECOMMEND/],
  ["統括", /統括|conductor|CONDUCTOR|ブレイン|brain|BRAIN|材料|判断の順番|連鎖|土台|細分化|弱い所|約束|PROMISE|CHECK_ORDER|LINK_/],
  ["返信", /返信|書き手|文の|下書き|reply|REPLY|締め|言い回し|手本|最終チェック|final-check/],
];
export function areaOf(text: string): Area { for (const [a, re] of AREA_RES) if (re.test(text)) return a; return "その他"; }
/** 効く見込み（決まった当てはめ）: P0・「最優先／絶対／かなり重要／大切に」は高・P1 の決定は中・それ以外は低 */
export function impactOf(i: { priority?: number | null; text: string }): "高" | "中" | "低" {
  if (i.priority === 0 || /最優先|絶対|かなり重要|大切に|ここ大切|質が(?:一気に|大きく)上が/.test(i.text)) return "高";
  if (i.priority === 1 || /竹内さんの(?:決定|決め|承認|指示)/.test(i.text)) return "中";
  return "低";
}
export const NOT_BUILT_RE = /未(?:実装|着手|配線|作成|定)|予定|これから|待ち|案の段|作っていない|配線していない/;
export type KbDecision = { id: string; title: string; tags: string[] | null; applied_to: string | null; priority: number | null; created_at: string };
export type LedgerRow = { id: number; title: string; stage: string; owner: string | null; switch_name: string | null; kb_ids: string[] | null; next_step: string | null; requested_at: string | null; lastAt: string | null; priority: number | null };
const SW_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** ① 台帳につながらない決定（純関数） */
export function decisionsWithoutLedger(kb: readonly KbDecision[], ledger: readonly LedgerRow[], excludeDay: string): KbDecision[] {
  const ids = new Set<string>(); const text = ledger.map((l) => `${l.title} ${l.next_step ?? ""}`).join("\n");
  for (const l of ledger) for (const k of l.kb_ids ?? []) ids.add(String(k).slice(0, 8));
  const sws = new Set(ledger.map((l) => l.switch_name).filter((x): x is string => !!x));
  return kb.filter((r) => {
    if (r.created_at.slice(0, 10) >= excludeDay) return false;
    const id8 = r.id.slice(0, 8); if (ids.has(id8) || text.includes(id8)) return false;
    const names = `${r.title} ${r.applied_to ?? ""}`.match(SW_RE) ?? []; if (names.some((n) => sws.has(n))) return false;
    const ap = (r.applied_to ?? "").trim();
    return !ap || NOT_BUILT_RE.test(ap);
  });
}
export const QUIET_DAYS = 5, STALE_DAYS = 14;
const days = (from: string | null, nowIso: string) => (from ? Math.floor((Date.parse(nowIso) - Date.parse(from)) / 86_400_000) : null);
/** ② 動いていない台帳の行（純関数） */
export function stalledLedger(ledger: readonly LedgerRow[], nowIso: string): Array<LedgerRow & { reqDays: number; quietDays: number }> {
  const out: Array<LedgerRow & { reqDays: number; quietDays: number }> = [];
  for (const l of ledger) {
    if (l.stage !== "todo" && l.stage !== "building") continue;
    const req = days(l.requested_at, nowIso), quiet = days(l.lastAt, nowIso);
    if (req == null || req < STALE_DAYS || quiet == null || quiet < QUIET_DAYS) continue;
    out.push({ ...l, reqDays: req, quietDays: quiet });
  }
  return out;
}
export type Unfinished = { kind: "台帳に無い" | "動いていない" | "off のまま"; ref: string; title: string; area: Area; impact: "高" | "中" | "低"; owner: string | null; why: string };
const RANK = { 高: 0, 中: 1, 低: 2 } as const;
const KIND_RANK = { "台帳に無い": 0, "動いていない": 1, "off のまま": 2 } as const;
export function rankUnfinished(xs: readonly Unfinished[]): Unfinished[] { return [...xs].sort((a, b) => RANK[a.impact] - RANK[b.impact] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.ref.localeCompare(b.ref)); }
export function countByArea(xs: readonly Unfinished[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const x of xs) { const m = out[x.area] ?? {}; m[x.kind] = (m[x.kind] ?? 0) + 1; m.計 = (m.計 ?? 0) + 1; out[x.area] = m; }
  return out;
}
export function unfinishedLedgerTitle(x: Unfinished): string { return `【抜けの棚卸し】${x.ref}: ${x.title.slice(0, 60)}`; }
