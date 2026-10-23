// app/lib/link-hub-brain.ts — つなぎの芯（ハブ）の「開いている事」を LINE のブレインの材料にする（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-24 弱い所 4「つなぎの芯（ハブ・司令塔）が LINE のブレインに未接続」（竹内さん 10/23「全部をつないで道を選ぶ力を上げるために足りない所は？」の穴②）。
//   設計知見 98bca000（4つが同じ『今どこ・何を約束したか・次の一手』を見る）・e07a8b73（多くは計算・迷う所だけ）・P0 9eb6aa9c（判断はすべてブレイン基準・決定論は候補の網）。
//
// 何が届いていなかったか（本番 21日・お客様の番 579・scripts で数えた・読むだけ）:
//   スタッフが AIX を押した 220番のうち、ブレインが外した 130番（うち 108番は返信と言った）。
//   その時点でハブにあって、ブレインの材料に無かった物 = 開いている要対応（aix_action_items）・約束の並び（promise-queue＝果たす AIX とピッカーつき）・
//   カレンダーの【必ず】。これが今の番の前から開いていて、スタッフがその AIX を押した番が 37（property_send 19・property_check_result 13 …）。
//   司令塔の1行（LINK_CONDUCTOR_BRAIN）は1つに絞るので 14 にしか届かない。
//   ただし開いている事は返信だけで済んだ番にも 84/359 ある（物件送付の要対応は 80番中スタッフが押したのは 31）＝**一覧があるだけで AIX にしてはいけない**。
//
// だから形は「答え」でなく「事実の一覧」（候補の網）: 何が・いつから・期限・果たす AIX。どれを今するかはブレインが今の発言と会話から決める（P0）。
//   今のお客様の番の後に立った要対応（同じ番のブレイン自身の提案のこだま）は入れない。果たした記録がある要対応も入れない。
//   約束の文（promise-tracker）・お客様の依頼（request-ledger）・送れる物件の有無はブレインに別の材料で届いている → ここでは重ねない。
//
// 切替: LINK_HUB_BRAIN=on の時だけ（既定 off＝プロンプトは1文字も変わらない）。置き場所は行動台帳の塊の中（毎回変わる所＝キャッシュの印の外）。
// テスト: app/lib/__tests__/link-hub-brain.test.ts
import type { CustomerHub, HubContradiction, HubInput } from "./customer-hub";
import { aixItemKey } from "./customer-hub";
import { maskPII } from "./pii-mask";

const H = 3600_000;
const DAY = 24 * H;
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function linkHubBrainEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LINK_HUB_BRAIN ?? "").trim().toLowerCase() === "on";
}

/** 1つの開いている事（ブレインに渡す1行の元） */
export type HubOpenItem = {
  from: "aix_item" | "queue" | "calendar" | "contact";
  action: string | null;
  checkPattern: string | null;
  /** 何の約束か（伏せる前・queue と calendar だけ） */
  what: string | null;
  openedAt: string;
  dueAt: string | null;
};

/** 今のお客様の番（最後のスタッフの通より後のお客様の連投）の始まり。お客様の番でなければ null */
export function customerTurnStartMs(messages: ReadonlyArray<{ sender: string; createdAt: string }>, nowMs: number): number | null {
  const ordered = [...messages].filter((m) => ms(m.createdAt) <= nowMs).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  let i = ordered.length;
  while (i > 0 && ordered[i - 1].sender === "customer") i--;
  return i < ordered.length ? ms(ordered[i].createdAt) : null;
}

/** 開いている事を集める（決まった計算・候補の網）。重なり（同じ AIX×ピッカー）は古い方を残す */
export function hubOpenItems(hub: CustomerHub, contradictions: ReadonlyArray<HubContradiction>, input: HubInput): HubOpenItem[] {
  const now = input.nowMs;
  const turnStart = customerTurnStartMs(input.state.messages.map((m) => ({ sender: m.sender, createdAt: m.createdAt })), now) ?? now;
  const pausedPickup = contradictions.some((c) => c.type === "pickup_promise_vs_viewing");
  const doneKeys = new Set(contradictions.filter((c) => c.type === "aix_item_open_promise_done").map((c) => c.detail.split("・果たした")[0]));
  const out: HubOpenItem[] = [];
  for (const i of input.aixItems) {
    if (i.status !== "pending") continue;
    // 今の番の後に立った要対応は、この番のブレイン自身の提案のこだま＝入れない
    if (!(ms(i.created_at) < turnStart)) continue;
    if (doneKeys.has(aixItemKey(i.action, i.check_pattern, i.created_at))) continue;
    out.push({ from: "aix_item", action: i.action, checkPattern: i.check_pattern ?? null, what: null, openedAt: i.created_at, dueAt: null });
  }
  for (const p of hub.promises) {
    if (p.source !== "queue" && p.source !== "calendar" && p.source !== "contact") continue;
    if (p.watch || p.deferred) continue;
    if (pausedPickup && p.source === "queue" && p.kind === "pickup") continue; // 内覧が決まった後のピックアップの約束は保留（司令塔の決定3）
    if (!(ms(p.promisedAt) < turnStart)) continue;
    out.push({ from: p.source, action: p.action, checkPattern: p.pickerKey ?? p.checkPattern ?? null, what: p.label, openedAt: p.promisedAt, dueAt: p.dueAt });
  }
  // 同じ AIX×ピッカーは1つ（要対応と約束が同じ物を指す）。期限のある方の期限を残す
  const byKey = new Map<string, HubOpenItem>();
  for (const it of out.sort((a, b) => ms(a.openedAt) - ms(b.openedAt))) {
    // ピッカーの鍵が種類と同じ（ピックアップの約束は pickerKey=property_send）なら鍵なしと同じ
    const k = it.action ? `${it.action}|${it.checkPattern && it.checkPattern !== it.action ? it.checkPattern : ""}` : `${it.from}|${it.what ?? ""}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, it);
    else if (!prev.dueAt && it.dueAt) byKey.set(k, { ...prev, dueAt: it.dueAt, what: prev.what ?? it.what });
    else if (!prev.what && it.what) byKey.set(k, { ...prev, what: it.what });
  }
  return [...byKey.values()];
}

const FROM_JA: Record<HubOpenItem["from"], string> = { aix_item: "要対応", queue: "約束", calendar: "【必ず】の約束", contact: "連絡日の約束" };

function ageJa(fromMs: number, nowMs: number): string {
  const h = Math.max(0, Math.round((nowMs - fromMs) / H));
  return h < 1 ? "1時間以内に立った" : h < 48 ? `${h}時間前に立った` : `${Math.round(h / 24)}日前に立った`;
}
/** 約束の札の整え: 約束の並びの札の「→ AIX【…】」（行の AIX と重なる）・お客様の名前（カレンダーの題・1文字の名前も）・「お客様」を外す */
export function cleanWhat(what: string, customerName?: string | null): string {
  let t = what.replace(/\s*→\s*AIX【[^】]*】/g, "");
  const name = (customerName ?? "").trim();
  if (name) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 短い名前（1文字等）は区切り（空白・】・頭）に挟まれた時だけ外す（「あ」の名前で札の中の「あ」を消さない）
    t = t.replace(new RegExp(`(^|[\\s】])${esc(name)}(?=[\\s　]|$)`, "g"), "$1 ");
    for (const part of [name, ...name.split(/[\s　]+/)].filter((x) => x.length >= 2)) t = t.split(part).join(" ");
  }
  return t.replace(/お客様/g, " ").replace(/\s+/g, " ").trim();
}
function dueJa(dueMs: number, nowMs: number): string {
  if (!Number.isFinite(dueMs)) return "";
  const d = dueMs - nowMs;
  if (d < 0) { const h = Math.round(-d / H); return h < 48 ? `期限を${Math.max(1, h)}時間過ぎ` : `期限を${Math.round(-d / DAY)}日過ぎ`; }
  const h = Math.round(d / H);
  return h < 48 ? `期限まであと${Math.max(1, h)}時間` : `期限まであと${Math.round(d / DAY)}日`;
}

export const HUB_BRAIN_MAX_ITEMS = 5;

/**
 * ブレインの材料（無ければ ""）。行の形: 「・要対応 AIX【property_check_result/mgmt_parking】（3時間前から・期限まであと1日）」
 *   締めの1行は原則→応用（今の発言に答えるのが先・続きの番だけその AIX・関係が無ければ使わない・スタッフしか分からない結果は下書きに書かない）
 */
export function renderHubBrainNote(items: ReadonlyArray<HubOpenItem>, o: { nowMs: number; pausedPickup?: boolean; customerName?: string | null }): string {
  if (!items.length && !o.pausedPickup) return "";
  const m = (t: string) => maskPII(cleanWhat(t, o.customerName), [o.customerName ?? null]).replace(/\s+/g, " ").slice(0, 40);
  const lines: string[] = [];
  const sorted = [...items].sort((a, b) => (ms(a.dueAt) || Infinity) - (ms(b.dueAt) || Infinity) || ms(a.openedAt) - ms(b.openedAt));
  for (const it of sorted.slice(0, HUB_BRAIN_MAX_ITEMS)) {
    const cp = it.checkPattern && it.checkPattern !== it.action ? it.checkPattern : null;
    const btn = it.action ? ` AIX【${it.action}${cp ? `/${cp}` : ""}】` : "";
    const w = it.what ? m(it.what) : "";
    const what = w ? ` ${w}` : "";
    const when = [ageJa(ms(it.openedAt), o.nowMs), it.dueAt ? dueJa(ms(it.dueAt), o.nowMs) : ""].filter(Boolean).join("・");
    lines.push(`・${FROM_JA[it.from]}${what}${btn}（${when}）`);
  }
  if (items.length > HUB_BRAIN_MAX_ITEMS) lines.push(`・ほか ${items.length - HUB_BRAIN_MAX_ITEMS}件`);
  if (o.pausedPickup) lines.push("・内覧が決まったので、ピックアップの約束は内覧の結果まで保留");
  return `\n【つなぎの芯: 今の番の前から開いている事（事実・候補）】\n${lines.join("\n")}\n※一覧は候補。まず今の発言に答える。今の発言がこの続き（結果を待っている・同じ物件・同じ確認）の時だけ、その AIX を次の一手に選べる。関係が無ければ使わない（開いているだけで AIX にしない）。スタッフしか分からない結果（物件確認の結果・見積の金額）は下書きに書かない。`;
}

/** ハブから1回で（サーバーの読み手が使う） */
export function hubBrainNote(hub: CustomerHub, contradictions: ReadonlyArray<HubContradiction>, input: HubInput): string {
  // 申込以降・見送り・成約はつなぎの対象外（司令塔と同じ線）。2番手で申込中は並行で探すので対象
  const stage = hub.where.stage;
  const postApply = (hub.where.isPostApply || stage === "applying") && hub.flags.parallelSecond !== true;
  if (postApply || stage === "dropped" || stage === "won") return "";
  const pausedPickup = contradictions.some((c) => c.type === "pickup_promise_vs_viewing");
  return renderHubBrainNote(hubOpenItems(hub, contradictions, input), { nowMs: input.nowMs, pausedPickup, customerName: input.conv.customer_name });
}
