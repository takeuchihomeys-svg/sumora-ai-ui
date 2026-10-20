// 申込までの地図（app/lib/apply-route-map.ts）を本番の会話に当て、位置の分布と「次の一手の候補」がスタッフの実際の次の動きと合うかを数える。
// 読み取りのみ（SELECT）・LLM なし・書き込みなし。2026-10-20 竹内さん（55bf37b6）。
//
//   直近 DAYS 日（既定 60）にお客様の発言がある会話から SAMPLE 件（既定 100・会話 ID の指紋で決まった並び）を選び、
//   各会話の「スタッフが応えた最後のお客様の連投」の時刻 T で customer-state を作り直し（T より後の材料は外す・申込以降の状態は T で分からないので外す）、
//   位置（本線の駅・分かれ道）と次の一手の候補を出す。次のお客様の発言までのこちらの動き（AIX の種類・本文）と比べる。
//   お客様の名前は伏せる（会話ID先頭8桁・発言は60字まで）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-route-map.ts   （DAYS=60 SAMPLE=100 SPOT=15）
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { resolveCustomerState, type CustomerStateInput } from "../app/lib/customer-state";
import { buildActionLedger } from "../app/lib/action-ledger";
import { routeTypeOf } from "../app/lib/brain-route-type";
import { isAckOnlyTurn } from "../app/lib/ack-topic-scope";
import { sceneEvidenceForTurn } from "../app/lib/brain-aix-feedback";
import { extractCircumstances, validCircumstances, holdFirstReason } from "../app/lib/customer-circumstances";
import { locateApplyRoute, buildApplyRouteBrainText, ROUTE_NODES, ROUTE_BRANCHES, type ApplyRouteLocation } from "../app/lib/apply-route-map";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 60);
const SAMPLE = Number(process.env.SAMPLE ?? 100);
const SPOT = Number(process.env.SPOT ?? 15);
const id8 = (s: string) => s.slice(0, 8);
const mask = (s: string | null | undefined, n = 60) => /記入欄|氏名|生年月日/.test(s ?? "") ? "[申込フォーム]" : (s ?? "").replace(/https?:\/\/\S+/g, "[URL]").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ").slice(0, n);
const cnt = (a: string[]) => { const m: Record<string, number> = {}; for (const v of a) m[v] = (m[v] ?? 0) + 1; return Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("・"); };
const POST = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost"]);

function cutAt(input: CustomerStateInput, t: number): CustomerStateInput {
  const le = (s: string | null | undefined) => !s || Date.parse(s) <= t;
  return {
    ...input, now: t,
    status: input.status && POST.has(input.status) ? null : input.status, isPostApply: null,
    messages: input.messages.filter((m) => le(m.createdAt)),
    aixRows: input.aixRows.filter((r) => le(r.sent_at ?? r.created_at)),
    recordedFacts: input.recordedFacts.filter((f) => le((f as { sent_at?: string | null }).sent_at ?? null)),
    viewingHistory: input.viewingHistory.filter((v) => le(v.created_at ?? null)),
    sentProperties: input.sentProperties.filter((s) => le(s.sent_at)),
    lineTasks: (input.lineTasks ?? []).filter((x) => le(x.created_at)),
    ledger: null,
  };
}

/** スタッフの本文だけの動きを粗く分ける（比べるためだけ） */
function staffTextKind(t: string): string {
  const s = t.normalize("NFKC");
  if (/ピックアップ|お探し|探させ|新着/.test(s) && /(?:させて(?:頂|いただ)きます|次第)/.test(s)) return "text:探す約束";
  if (/見積/.test(s) && /(?:させて(?:頂|いただ)きます)/.test(s)) return "text:見積の約束";
  if (/確認/.test(s) && /(?:させて(?:頂|いただ)きます|次第)/.test(s)) return "text:確認の約束";
  if (/申込|お申し込み/.test(s)) return "text:申込の話";
  if (/内覧|内見|ご案内/.test(s)) return "text:内覧の話";
  if (/条件|エリア|ご予算|間取り|ご希望/.test(s) && /[?？]|でしょうか|ございますか/.test(s)) return "text:条件を伺う";
  return "text:返信";
}

type Row = { id: string; loc: ApplyRouteLocation; turn: string; actual: string[]; match: "aix一致" | "2段一致" | "返信一致" | "受けだけの番" | "不一致" | "次なし"; chars: number; rt: string | null };
/** 約束の本文（2段の1段目）が果たす AIX */
const PROMISE_TO_AIX: Record<string, string> = { "text:探す約束": "property_send", "text:見積の約束": "estimate_sheet", "text:確認の約束": "property_check_result" };

function judge(loc: ApplyRouteLocation, actual: string[], rt: string | null): Row["match"] {
  if (!actual.length) return "次なし";
  const aix = actual.filter((a) => !a.startsWith("text:"));
  const want = loc.next?.aix ?? [];
  if (want.length && aix.some((a) => want.includes(a))) return "aix一致";
  if (!want.length && !aix.length) return "返信一致";
  // 2段（約束の返信→後で AIX）: 約束の本文が候補の AIX を果たす約束なら一致とみる
  if (want.length && actual.some((a) => PROMISE_TO_AIX[a] && want.includes(PROMISE_TO_AIX[a]))) return "2段一致";
  // 受けだけ（お礼・了承）の番は、その番の答えは短い返信か何もしない＝地図の次の一手とは比べない
  if (rt && rt.startsWith("ack_")) return "受けだけの番";
  return "不一致";
}

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const ids = new Set<string>();
  for (let i = 0; i < 20000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since).range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (r.conversation_id && r.conversation_id !== YUMA) ids.add(r.conversation_id as string);
    if (!data || data.length < 1000) break;
  }
  const pool = [...ids].sort((a, b) => createHash("md5").update(a).digest("hex").localeCompare(createHash("md5").update(b).digest("hex")));
  console.log(`対象の会話 ${ids.size}（直近${DAYS}日にお客様の発言）→ 先頭から最大${SAMPLE}件`);
  const rows: Row[] = [];
  let skipped = 0;
  for (const id of pool) {
    if (rows.length >= SAMPLE) break;
    let input: CustomerStateInput | null = null;
    try { input = await loadCustomerStateInput(id); } catch { skipped++; continue; }
    if (!input) { skipped++; continue; }
    const msgs = input.messages; // 古い順
    // スタッフが応えた最後のお客様の連投（窓の中）
    let endIdx = -1;
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (msgs[i].sender === "customer" && msgs[i + 1].sender !== "customer" && Date.parse(msgs[i].createdAt) >= Date.parse(since)) { endIdx = i; break; }
    }
    if (endIdx < 0) { skipped++; continue; }
    const T = Date.parse(msgs[endIdx].createdAt) + 1000;
    const cut = cutAt(input, T);
    const ledger = buildActionLedger({ recentAixRows: cut.aixRows, messages: cut.messages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: m.isAix, lineMessageId: m.lineMessageId })), lineTasks: cut.lineTasks, recordedFacts: cut.recordedFacts, now: T });
    const state = resolveCustomerState({ ...cut, ledger });
    const newestFirst = [...cut.messages].reverse().map((m) => ({ sender: m.sender, text: m.text, created_at: m.createdAt }));
    const turn = (() => { const b: string[] = []; let img = false; for (const m of newestFirst) { if (m.sender !== "customer") break; const t = (m.text ?? "").trim(); if (/^\[画像\]/.test(t)) { img = true; continue; } if (t) b.push(t); } return { text: b.reverse().join("\n"), hasImage: img }; })();
    const prevStaff = newestFirst.find((m) => m.sender !== "customer")?.text ?? "";
    let ts = cut.messages.length; while (ts > 0 && cut.messages[ts - 1].sender === "customer") ts--;
    const turnStart = ts < cut.messages.length ? Date.parse(cut.messages[ts].createdAt) : T;
    const recentStaff: string[] = [];
    for (let j = ts - 1; j >= 0 && cut.messages[j].sender !== "customer"; j--) { if (turnStart - Date.parse(cut.messages[j].createdAt) > 72 * 3600_000) break; recentStaff.push(cut.messages[j].text ?? ""); }
    const scene = sceneEvidenceForTurn({ text: turn.text, hasImage: turn.hasImage }, {
      sentPropertyCount: ledger.facts.propertiesSentCount,
      aixHistory: cut.aixRows.slice(-10).map((r) => ({ aix_type: r.aix_type, check_pattern: r.check_pattern ?? null })),
      recentMessages: cut.messages.slice(-15).map((m) => ({ sender: m.sender, text: m.text })),
    });
    const hold = holdFirstReason(validCircumstances(extractCircumstances(cut.messages.filter((m) => m.sender === "customer").map((m) => ({ text: m.text, createdAt: m.createdAt })), turnStart), T), T);
    const rtNow = routeTypeOf({ customerText: turn.text, prevStaffText: prevStaff, ackOnly: !turn.hasImage && isAckOnlyTurn(turn.text) });
    const loc = locateApplyRoute({
      stage: state.stage, searching: state.searching, ledger: ledger.facts,
      routeType: rtNow,
      sceneId: scene?.scene ?? null, customerTurnText: turn.text, recentStaffTexts: recentStaff, holdReason: hold, lastStaffAtIfStaffLast: null, nowMs: T,
    });
    // 次のお客様の発言までのこちらの動き
    const actual: string[] = [];
    let nextCustAt = Infinity;
    for (let i = endIdx + 1; i < msgs.length; i++) { if (msgs[i].sender === "customer") { nextCustAt = Date.parse(msgs[i].createdAt); break; } }
    for (const r of input.aixRows) { const at = Date.parse(r.sent_at ?? r.created_at ?? ""); if (at > T - 1000 && at < nextCustAt && r.aix_type) actual.push(r.aix_type); }
    for (let i = endIdx + 1; i < msgs.length && msgs[i].sender !== "customer"; i++) if (!msgs[i].isAix && msgs[i].text) actual.push(staffTextKind(msgs[i].text ?? ""));
    const uniq = [...new Set(actual)];
    rows.push({ id, loc, turn: turn.text || (turn.hasImage ? "[画像]" : ""), actual: uniq, match: judge(loc, uniq, rtNow), chars: buildApplyRouteBrainText(loc).length, rt: rtNow });
  }
  console.log(`測った会話 ${rows.length}（飛ばした ${skipped}）`);
  console.log(`\n■ 本線の位置: ${cnt(rows.map((r) => r.loc.node ? ROUTE_NODES[r.loc.node].name : "unknown"))}`);
  console.log(`■ 分かれ道: ${cnt(rows.map((r) => r.loc.branch ? ROUTE_BRANCHES[r.loc.branch].name : "なし"))}`);
  console.log(`■ unknown（位置なし）: ${rows.filter((r) => !r.loc.node && !r.loc.branch).length}`);
  console.log(`■ 材料の文の長さ: 最大 ${Math.max(...rows.map((r) => r.chars))}字・平均 ${Math.round(rows.reduce((a, r) => a + r.chars, 0) / Math.max(1, rows.length))}字`);
  console.log(`■ 次の一手の候補 vs 実際: ${cnt(rows.map((r) => r.match))}`);
  const byNode: Record<string, string[]> = {};
  for (const r of rows) (byNode[r.loc.branch ? `分:${ROUTE_BRANCHES[r.loc.branch].name}` : r.loc.node ? ROUTE_NODES[r.loc.node].name : "unknown"] ??= []).push(r.match);
  for (const [k, v] of Object.entries(byNode)) console.log(`   ${k}: ${cnt(v)}`);
  console.log(`\n■ 実際の動き（全体）: ${cnt(rows.flatMap((r) => r.actual))}`);
  // 抜き取り: 位置ごとに散らして SPOT 件（不一致を優先）
  const spot: Row[] = [];
  const keys = Object.keys(byNode);
  const pick = (want: Row["match"] | null) => { for (const k of keys) { const r = rows.find((x) => !spot.includes(x) && (want ? x.match === want : true) && (x.loc.branch ? `分:${ROUTE_BRANCHES[x.loc.branch].name}` : x.loc.node ? ROUTE_NODES[x.loc.node].name : "unknown") === k); if (r && spot.length < SPOT) spot.push(r); } };
  pick("不一致"); pick(null); pick(null);
  console.log(`\n■ 抜き取り ${spot.length}件（位置 → 候補 ｜ 実際）`);
  for (const r of spot) {
    console.log(`- ${id8(r.id)} [${r.match}] ${r.loc.node ? ROUTE_NODES[r.loc.node].name : "unknown"}${r.loc.branch ? `／分:${ROUTE_BRANCHES[r.loc.branch].name}` : ""}（${r.loc.evidence.join("・")}）`);
    console.log(`    お客様（型:${r.rt ?? "—"}）: ${mask(r.turn)}`);
    console.log(`    候補: ${r.loc.next?.label ?? "—"}${r.loc.next?.aix.length ? `（${r.loc.next.aix.join("・")}）` : ""} ｜ 実際: ${r.actual.join("・") || "なし"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
