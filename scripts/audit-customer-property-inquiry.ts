// scripts/audit-customer-property-inquiry.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-property-inquiry.ts      （DAYS=90 既定・読み取りのみ・何も書かない）
//       DUMP=1 …… 変わった判断を全部表示
//
// 2026-10-01 竹内（和樹事例）「ここは物件確認したから送る形なので、そのようにする。またこのような判断基準のズレの部分を改善していく」
//   A. お客様がポータルの URL を送ってきたターンの後、スタッフが最初に押した AIX（実送信で線を引く）
//      あわせて、その時にピックアップの約束（sent_facts pickup_declared）が未履行だったか別に数える
//   B. ブレインの判断（brain_decision_logs）に customer-property-inquiry.correctCustomerPropertyInquiryAix を当て、変わる判断と
//      その後スタッフが押した AIX を並べる（誤って変えた＝スタッフが 確認します を押した回が 0 か）
//   C. 赤帯の並び（promise-calendar.splitPromisesForFreshInquiry）: ブレインが 物件確認した／見積書送る の時に未履行のピックアップの約束が
//      あった回で、スタッフが次に押したのはお客様の物件の AIX かピックアップか
import { createClient } from "@supabase/supabase-js";
import { correctCustomerPropertyInquiryAix } from "../app/lib/customer-property-inquiry";
import { splitPromisesForFreshInquiry } from "../app/lib/promise-calendar";
import { unrepliedCustomerTurn } from "../app/lib/brain-aix-feedback";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 90);
const DUMP = process.env.DUMP === "1";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const SINCE = new Date(Date.now() - DAYS * 86400_000).toISOString();
const PORTAL_URL_RE = /https?:\/\/\S*(?:suumo|homes\.co\.jp|athome|chintai|realestate\.yahoo|eheya|smocca|myhome\.nifty|apamanshop|minimini|ielove|goodrooms|canary|door\.ac|leopalace|homemate)/i;
const PICKUP_AIX = new Set(["property_send", "property_recommendation"]);
const INQUIRY_AIX = new Set(["property_check_result", "estimate_sheet", "acknowledge_check"]);

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Aix = { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null };
type Fact = { conversation_id: string; kind: string; status: string; sent_at: string; detail: { sentence?: string } | null };
type Dec = { id: string; conversation_id: string; created_at: string; suggested_action: string | null; decision_source: string | null; analyzed_msg_ts: string | null; scene_evidence: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const one = (s: string | null | undefined, n = Number(process.env.W ?? 110)) => (s ?? "").replace(/\n+/g, " / ").slice(0, n);
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const show = (title: string, m: Map<string, number>) => { console.log(title); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`); };
const EXTERNAL_WAIT_RE = /(?:新着|募集|出|見つかり)(?:が)?(?:出|で)?次第|新着[^\n。]{0,20}(?:出|で)次第/;

async function main() {
  const decs = (await pageAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, suggested_action, decision_source, analyzed_msg_ts, scene_evidence").gte("created_at", SINCE).order("created_at").range(f, t)))
    .filter((d) => d.conversation_id !== YUMA);
  const custUrlMsgs = (await pageAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").eq("sender", "customer").gte("created_at", SINCE).ilike("text", "%http%").order("created_at").range(f, t)))
    .filter((m) => m.conversation_id !== YUMA && PORTAL_URL_RE.test(m.text ?? ""));
  const convIds = [...new Set([...decs.map((d) => d.conversation_id), ...custUrlMsgs.map((m) => m.conversation_id)])];
  const msgs: Msg[] = [], aix: Aix[] = [], facts: Fact[] = [];
  for (let i = 0; i < convIds.length; i += 80) {
    const ids = convIds.slice(i, i + 80);
    msgs.push(...await pageAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", ids).gte("created_at", new Date(Date.parse(SINCE) - 14 * 86400_000).toISOString()).order("created_at").range(f, t)));
    aix.push(...await pageAll<Aix>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at").in("conversation_id", ids).gte("created_at", SINCE).order("created_at").range(f, t)));
    facts.push(...await pageAll<Fact>((f, t) => sb.from("sent_facts").select("conversation_id, kind, status, sent_at, detail").in("conversation_id", ids).in("kind", ["pickup_declared", "properties_sent"]).order("sent_at").range(f, t)));
  }
  const byConv = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) (m.get(r.conversation_id) ?? m.set(r.conversation_id, []).get(r.conversation_id)!).push(r); return m; };
  const msgBy = byConv(msgs), aixBy = byConv(aix), factBy = byConv(facts);
  const aixAt = (a: Aix) => Date.parse(a.sent_at ?? a.created_at);
  const firstAixAfter = (cid: string, tMs: number, hours = 72) => (aixBy.get(cid) ?? []).filter((a) => aixAt(a) > tMs && aixAt(a) < tMs + hours * 3600_000).sort((a, b) => aixAt(a) - aixAt(b))[0]?.aix_type ?? "(なし)";
  /** その時刻に未履行のピックアップの約束（新着出次第を除く・7日以内・その後に物件送付が無い） */
  const openPickupAt = (cid: string, tMs: number) => {
    const fs = factBy.get(cid) ?? [];
    return fs.some((p) => p.kind === "pickup_declared" && p.status === "promised" && Date.parse(p.sent_at) < tMs && Date.parse(p.sent_at) > tMs - 7 * 86400_000
      && !EXTERNAL_WAIT_RE.test(p.detail?.sentence ?? "")
      && !fs.some((d) => d.kind === "properties_sent" && Date.parse(d.sent_at) > Date.parse(p.sent_at) && Date.parse(d.sent_at) < tMs)
      && !(aixBy.get(cid) ?? []).some((a) => PICKUP_AIX.has(a.aix_type) && aixAt(a) > Date.parse(p.sent_at) && aixAt(a) < tMs));
  };

  // ── A. URL のターン → 最初の AIX ──
  const turns: Msg[] = [];
  for (const m of custUrlMsgs) { const prev = turns.filter((x) => x.conversation_id === m.conversation_id).pop(); if (!prev || Date.parse(m.created_at) - Date.parse(prev.created_at) > 30 * 60_000) turns.push(m); }
  const aAll = new Map<string, number>(), aOpen = new Map<string, number>();
  for (const t of turns) { const k = firstAixAfter(t.conversation_id, Date.parse(t.created_at)); tally(aAll, k); if (openPickupAt(t.conversation_id, Date.parse(t.created_at))) tally(aOpen, k); }
  console.log(`\n== A. お客様がポータルの URL を送ったターン ${turns.length}回（${DAYS}日）→ 72時間以内に最初に押された AIX ==`);
  show("全体", aAll);
  show("うちピックアップの約束が未履行だった回", aOpen);

  // ── B. ブレインの判断の補正 ──
  const changed: Array<{ d: Dec; to: string; src: string; next: string; turn: string }> = [];
  const keptAck = new Map<string, number>();
  for (const d of decs) {
    if (!d.analyzed_msg_ts) continue;
    const tMs = Date.parse(d.analyzed_msg_ts);
    const hist = (msgBy.get(d.conversation_id) ?? []).filter((m) => Date.parse(m.created_at) <= tMs);
    const turn = unrepliedCustomerTurn([...hist].reverse());
    let scene: { scene?: string; property_by?: string } | null = null;
    try { scene = d.scene_evidence ? JSON.parse(d.scene_evidence) : null; } catch { scene = null; }
    const r = correctCustomerPropertyInquiryAix({ finalAix: d.suggested_action, scene: scene ? { scene: scene.scene, propertySpecifiedBy: scene.property_by } : null, customerTurn: turn.text });
    const next = firstAixAfter(d.conversation_id, tMs);
    if (r) changed.push({ d, to: r.action, src: r.decisionSource, next, turn: turn.text });
    else if (d.suggested_action === "acknowledge_check") tally(keptAck, `${scene?.scene ?? "(場面なし)"}/${scene?.property_by ?? "-"} → 次 ${next}`);
  }
  console.log(`\n== B. ブレインの判断 ${decs.length}件に補正を当てる ==`);
  console.log(`変わる判断: ${changed.length}件（確認します → 物件確認した ${changed.filter((c) => c.to === "property_check_result").length}・→ 見積書送る ${changed.filter((c) => c.to === "estimate_sheet").length}）`);
  const nx = new Map<string, number>();
  for (const c of changed) tally(nx, `${c.to} → スタッフの次 ${c.next}`);
  show("変えた先 × スタッフが次に押した AIX（72時間）", nx);
  console.log(`誤って変えた（スタッフが 確認します を押した）: ${changed.filter((c) => c.next === "acknowledge_check").length}件`);
  show("変えなかった 確認します（場面/根拠 → 次）", keptAck);
  const conv = new Set<string>();
  for (const c of changed) {
    if (!DUMP && conv.has(c.d.conversation_id)) continue;
    conv.add(c.d.conversation_id);
    console.log(`  ${jst(c.d.analyzed_msg_ts!)} ${c.d.conversation_id.slice(0, 8)} 確認します→${c.to}（次 ${c.next}）「${one(c.turn)}」`);
  }

  // ── C. 赤帯の並び ──
  const cTally = new Map<string, number>();
  let cCount = 0;
  const cEx: string[] = [];
  for (const d of decs) {
    if (!d.analyzed_msg_ts) continue;
    const tMs = Date.parse(d.analyzed_msg_ts);
    const corrected = changed.find((c) => c.d.id === d.id)?.to ?? d.suggested_action;
    if (!corrected || !INQUIRY_AIX.has(corrected)) continue;
    // 未履行のピックアップの約束（sent_facts）を赤帯の行の形にして当てる（約束の時刻＝送信時刻）
    const fs = (factBy.get(d.conversation_id) ?? []).filter((p) => p.kind === "pickup_declared" && p.status === "promised" && !EXTERNAL_WAIT_RE.test(p.detail?.sentence ?? ""));
    const open = fs.filter((p) => openPickupAt(d.conversation_id, tMs) && Date.parse(p.sent_at) < tMs && Date.parse(p.sent_at) > tMs - 7 * 86400_000)
      .map((p) => ({ event_type: "property_send", start_at: p.sent_at, notes: p.detail?.sentence ?? "" }));
    if (!open.length) continue;
    const split = splitPromisesForFreshInquiry(open, { brainAction: corrected, latestCustomerAt: d.analyzed_msg_ts });
    if (!split.later.length) continue;
    cCount++;
    const next = firstAixAfter(d.conversation_id, tMs);
    tally(cTally, INQUIRY_AIX.has(next) ? `お客様の物件の AIX（${next}）` : PICKUP_AIX.has(next) ? `ピックアップ（${next}）` : next);
    if (cEx.length < 12) cEx.push(`  ${jst(d.analyzed_msg_ts)} ${d.conversation_id.slice(0, 8)} ブレイン ${corrected}・後で「${one(split.later[0].notes, 50)}」→ 次 ${next}`);
  }
  console.log(`\n== C. ピックアップの約束が「後で」に回る判断 ${cCount}件 → スタッフが次に押した AIX ==`);
  show("", cTally);
  for (const e of cEx) console.log(e);

  // ── D. 画像の見出し（image-label・10/01〜）: 場面 S1（画像）の判断で、今回の画像が全部「物件以外」と読めた回 ──
  //   本番の保存は 10/01 の webhook から。過去の行は見出しが無いので、保存時と同じ classifyCustomerImage を画像の書き起こしに当てて見積もる
  const { classifyCustomerImage, imageKindGroup } = await import("../app/lib/image-label");
  const imgMsgs = new Map<string, Array<{ text: string; image_type: string | null; created_at: string }>>();
  for (let i = 0; i < convIds.length; i += 80) {
    const ids = convIds.slice(i, i + 80);
    const rows = await pageAll<{ conversation_id: string; text: string | null; image_type: string | null; created_at: string }>((f, t) =>
      sb.from("messages").select("conversation_id, text, image_type, created_at").in("conversation_id", ids).eq("sender", "customer").like("text", "[画像]%").gte("created_at", SINCE).order("created_at").range(f, t));
    for (const r of rows) (imgMsgs.get(r.conversation_id) ?? imgMsgs.set(r.conversation_id, []).get(r.conversation_id)!).push({ text: r.text ?? "", image_type: r.image_type, created_at: r.created_at });
  }
  const dT = new Map<string, number>();
  const dEx: string[] = [];
  let dAll = 0;
  for (const d of decs) {
    if (!d.analyzed_msg_ts || !/"scene":"S1_vacancy"/.test(d.scene_evidence ?? "") || !/"property_by":"image"/.test(d.scene_evidence ?? "")) continue;
    dAll++;
    const tMs = Date.parse(d.analyzed_msg_ts);
    const hist = (msgBy.get(d.conversation_id) ?? []).filter((m) => Date.parse(m.created_at) <= tMs);
    let k = hist.length - 1; while (k >= 0 && hist[k].sender === "customer") k--;
    const since = Date.parse(hist[k + 1]?.created_at ?? d.analyzed_msg_ts);
    const imgs = (imgMsgs.get(d.conversation_id) ?? []).filter((r) => Date.parse(r.created_at) >= since && Date.parse(r.created_at) <= tMs);
    if (!imgs.length) continue;
    const groups = imgs.map((r) => imageKindGroup(classifyCustomerImage(r.image_type, (r.text ?? "").replace(/^\s*\[画像\]\s*/, ""))));
    const nonProp = groups.every((g) => g === "non_property") || imgs.every((r) => r.image_type === "id_document" || r.image_type === "income_document");
    if (!nonProp) continue;
    const next = firstAixAfter(d.conversation_id, tMs);
    tally(dT, `ブレイン ${d.suggested_action ?? "(なし)"} → スタッフの次 ${next}`);
    if (dEx.length < 10) dEx.push(`  ${jst(d.analyzed_msg_ts)} ${d.conversation_id.slice(0, 8)} 「${one(imgs[0].text, 70)}」→ 次 ${next}`);
  }
  console.log(`\n== D. 場面 S1（画像）の判断 ${dAll}件のうち、画像が全部「物件以外」と読める回（見出しが付けば S1 にならない）==`);
  show("", dT);
  for (const e of dEx) console.log(e);
}
main().catch((e) => { console.error(e); process.exit(1); });
