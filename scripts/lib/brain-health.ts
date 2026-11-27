// scripts/lib/brain-health.ts — 朝の1枚の「ブレインの健康」の欄（#817・純関数・新しく数えない・2026-11-27 作業員A）
//
// 今ある物差しを1つの欄に束ねる（数え直さない・渡された結果を並べるだけ）:
//   ① 届き … 部品が届いた割合（試験の辞書の届きの関所 dictReachGate の答え・core:* の割合）
//   ② 効き … on の部品の本番の効き・悪化の兆し（switch-regress-watch・rollout-watch の決定）
//   ③ 費用 … 試験と本番の費用（前の24時間の試験の費用と確かな悪化・night-capacity の空き枠）
//   ④ 行き止まり … 地図の行き止まりの節（#804・本番の記録に載ってから）
//   ⑤ 答え漏れ … まだ答えていない事（#814・UNANSWERED_ASKS_LINE を on にした後の material_marks.unanswered）
// 並べ方: 悪い所（持ち主つき）→ 変わらない所 → 分からない所（番が少ない・記録が無い）。
// 台帳: 悪い所だけを work_items（origin=found_gap）に積む候補にする。積むのは BRAIN_HEALTH_LEDGER=on の時だけ（既定 off・記録だけから・題で重ねない）。

export type HealthArea = "届き" | "効き" | "費用" | "行き止まり" | "答え漏れ";
export type HealthStatus = "bad" | "ok" | "unknown";
export type HealthItem = { area: HealthArea; label: string; status: HealthStatus; owner: string; why: string; next?: string };
type Env = Record<string, string | undefined>;
export const brainHealthLedgerOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_HEALTH_LEDGER ?? "").trim().toLowerCase() === "on";
const DEFAULT_OWNER = "統括役";

// ── ① 届き ──────────────────────────────────────────────
/** 辞書の届きの関所の答え（スイッチごと）: 届かず＝悪い・比べる＝変わらない・印なし＝分からない */
export function reachItems(rows: ReadonlyArray<{ sw: string; verdict: "比べる" | "届かず" | "印なし"; reached?: number; targets?: number; owner?: string | null }>): HealthItem[] {
  return rows.map((r) => {
    const cnt = r.targets != null ? `${r.reached ?? 0}/${r.targets}問` : "";
    if (r.verdict === "届かず") return { area: "届き", label: r.sw, status: "bad", owner: r.owner ?? DEFAULT_OWNER, why: `on の試験で目当ての印が出た問題が少ない（${cnt}）`, next: "材料がどこで落ちるかを件数で追う（入口の条件・時刻の窓・写しの中身）" };
    if (r.verdict === "印なし") return { area: "届き", label: r.sw, status: "unknown", owner: r.owner ?? DEFAULT_OWNER, why: "届きの印が無い（印を足すのが先）" };
    return { area: "届き", label: r.sw, status: "ok", owner: r.owner ?? DEFAULT_OWNER, why: `届いた ${cnt}` };
  });
}
/** 割合の物差し（core:* の xx%・n）: n が minN 未満は分からない・line 未満は悪い */
export function shareItem(o: { label: string; pct: number | null | undefined; n: number | null | undefined; owner?: string | null; line?: number; minN?: number; area?: HealthArea }): HealthItem {
  const line = o.line ?? 50, minN = o.minN ?? 3, owner = o.owner ?? DEFAULT_OWNER, area = o.area ?? "届き";
  if (o.pct == null || !o.n || o.n < minN) return { area, label: o.label, status: "unknown", owner, why: `数が少ない（${o.n ?? 0}）` };
  return o.pct < line ? { area, label: o.label, status: "bad", owner, why: `${o.pct}%（${o.n}・線 ${line}%）`, next: "低い所の行を朝の1枚の芯の欄で読む" } : { area, label: o.label, status: "ok", owner, why: `${o.pct}%（${o.n}）` };
}

// ── ② 効き ──────────────────────────────────────────────
/** switch-regress-watch の答え（SwitchVerdict の形だけ受け取る） */
export function regressItems(vs: ReadonlyArray<{ name: string; onDay: string; verdict: "down" | "keep" | "unknown"; metrics: ReadonlyArray<{ metric: string; scope: string; verdict: string; why: string }> }>, ownerOf: (name: string) => string = () => DEFAULT_OWNER): HealthItem[] {
  return vs.map((v) => {
    const d = v.metrics.find((m) => m.verdict === "down");
    if (v.verdict === "down") return { area: "効き", label: v.name, status: "bad", owner: ownerOf(v.name), why: `${v.onDay} に on・${d ? `${d.metric}/${d.scope} ${d.why}` : "物差しが下がった"}`, next: "下がった番を実物で読み、原因を3つ（材料が届いていない・場面の読み違い・AIX の番を返信にした）で分ける。戻すのは段階で読む部品だけ（rollout-watch）" };
    if (v.verdict === "unknown") return { area: "効き", label: v.name, status: "unknown", owner: ownerOf(v.name), why: `${v.onDay} に on・番が少ない` };
    return { area: "効き", label: v.name, status: "ok", owner: ownerOf(v.name), why: `${v.onDay} に on・変わらない` };
  });
}
/** rollout-watch の決定（WatchDecision の形だけ）: down＝悪い（夜の見張りが1段戻した／戻す）・thin＝分からない */
export function rolloutItems(ds: ReadonlyArray<{ name: string; action: "down" | "keep" | "thin"; from: string; to?: string; why: string }>, ownerOf: (name: string) => string = () => DEFAULT_OWNER): HealthItem[] {
  return ds.map((d) => d.action === "down"
    ? { area: "効き", label: d.name, status: "bad", owner: ownerOf(d.name), why: `段 ${d.from}→${d.to ?? "?"}（${d.why}）`, next: "戻した理由の番を実物で読み、直してから段を上げ直す（竹内さんに知らせる）" }
    : d.action === "thin" ? { area: "効き", label: d.name, status: "unknown", owner: ownerOf(d.name), why: d.why }
    : { area: "効き", label: d.name, status: "ok", owner: ownerOf(d.name), why: `段 ${d.from}・${d.why}` });
}

// ── ③ 費用 ──────────────────────────────────────────────
/** 前の24時間の試験: 上限（竹内さんの決まり 1日 $5〜10 の $10）を超えた・確かな悪化のあった本がある＝悪い */
export function examCostItems(o: { runs: number; costUsd: number; worseLabels: readonly string[]; capUsd?: number; capacityLine?: string | null }): HealthItem[] {
  const cap = o.capUsd ?? 10, out: HealthItem[] = [];
  if (!o.runs) out.push({ area: "費用", label: "試験の費用", status: "unknown", owner: DEFAULT_OWNER, why: "前の24時間に試験が無い" });
  else out.push(o.costUsd > cap ? { area: "費用", label: "試験の費用", status: "bad", owner: DEFAULT_OWNER, why: `$${o.costUsd}（${o.runs}本・上限 $${cap} を超えた）`, next: "組の数を空き枠（night-capacity）の内に戻す" } : { area: "費用", label: "試験の費用", status: "ok", owner: DEFAULT_OWNER, why: `$${o.costUsd}（${o.runs}本・上限 $${cap}）${o.capacityLine ? `・${o.capacityLine.replace(/^- /, "")}` : ""}` });
  if (o.worseLabels.length) out.push({ area: "費用", label: "試験の確かな悪化", status: "bad", owner: DEFAULT_OWNER, why: `${o.worseLabels.length}本（${o.worseLabels.slice(0, 4).join("・")}）`, next: "悪化した問題を重点的に調べ、原因を3つで分けて直す（KB c2ffff73）" });
  return out;
}
/** 本番の月の見込み: 特典を超える見込み＝悪い */
export function spendItems(ls: ReadonlyArray<{ provider: string; spendUsd: number | string; forecastUsd: number | string; creditUsd?: number | string | null; overCredit?: boolean }>): HealthItem[] {
  return ls.filter((l) => Number(l.creditUsd ?? 0) > 0).map((l) => l.overCredit
    ? { area: "費用", label: `${l.provider} の月`, status: "bad", owner: DEFAULT_OWNER, why: `今月 ${l.spendUsd}・月末の見込み ${l.forecastUsd}（特典 ${l.creditUsd} を超える見込み）`, next: "振り分け（LLM_BUDGET_ROUTE）の線を見直す" }
    : { area: "費用", label: `${l.provider} の月`, status: "ok", owner: DEFAULT_OWNER, why: `今月 ${l.spendUsd}・見込み ${l.forecastUsd}（特典 ${l.creditUsd}）` });
}

// ── ④ 行き止まり・⑤ 答え漏れ ─────────────────────────────
/** 記録に載った数（前の日と比べる）。記録が無ければ分からない（今は #804 は手元の json・#814 は on の後） */
export function countItem(o: { area: HealthArea; label: string; now: number | null | undefined; prev?: number | null; owner?: string | null; noRecordWhy: string; next?: string }): HealthItem {
  const owner = o.owner ?? DEFAULT_OWNER;
  if (o.now == null) return { area: o.area, label: o.label, status: "unknown", owner, why: o.noRecordWhy };
  if (o.prev != null && o.now > o.prev) return { area: o.area, label: o.label, status: "bad", owner, why: `${o.prev}→${o.now}（増えた）`, next: o.next };
  return { area: o.area, label: o.label, status: "ok", owner, why: `${o.now}${o.prev != null ? `（前 ${o.prev}）` : ""}` };
}

// ── 束ねる ──────────────────────────────────────────────
const ORDER: HealthArea[] = ["効き", "届き", "答え漏れ", "行き止まり", "費用"];
/** 朝の1枚の欄（悪い所→変わらない所→分からない所・短く） */
export function brainHealthLines(items: ReadonlyArray<HealthItem>, maxBad = 8): string[] {
  const by = (s: HealthStatus) => items.filter((x) => x.status === s).sort((a, b) => ORDER.indexOf(a.area) - ORDER.indexOf(b.area));
  const bad = by("bad"), ok = by("ok"), unk = by("unknown");
  const group = (xs: HealthItem[]) => ORDER.map((a) => { const g = xs.filter((x) => x.area === a); return g.length ? `${a} ${g.length}（${g.slice(0, 4).map((x) => x.label).join("・")}${g.length > 4 ? "…" : ""}）` : ""; }).filter(Boolean).join("・");
  return [
    `### ブレインの健康（悪い ${bad.length}・変わらない ${ok.length}・分からない ${unk.length}）`,
    ...(bad.length ? bad.slice(0, maxBad).map((x) => `- 悪い｜${x.area}｜${x.label}｜${x.owner}｜${x.why.slice(0, 90)}`) : ["- 悪い所: なし"]),
    ...(bad.length > maxBad ? [`- 悪い所 ほか ${bad.length - maxBad}`] : []),
    `- 変わらない: ${group(ok) || "なし"}`,
    `- 分からない（番が少ない・記録が無い）: ${group(unk) || "なし"}`,
  ];
}
export type HealthLedgerRow = { title: string; owner: string; next: string; area: string; priority: number };
/** 台帳に積む候補（悪い所だけ・既に開いている題は積まない）。積むかは呼ぶ側が brainHealthLedgerOn で決める */
export function brainHealthLedger(items: ReadonlyArray<HealthItem>, openTitles: readonly string[]): HealthLedgerRow[] {
  const have = new Set(openTitles);
  return items.filter((x) => x.status === "bad").map((x) => ({ title: `ブレインの健康: ${x.area}: ${x.label}`, owner: x.owner, next: `${x.why}${x.next ? `／次: ${x.next}` : ""}`.slice(0, 400), area: "ブレインの健康", priority: x.area === "効き" ? 10 : 20 }))
    .filter((r) => !have.has(r.title));
}
