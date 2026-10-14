// scripts/audit-brain-deep-check.ts — ブレインが「確認の約束」「材料が無い」「聞き返し」に倒れた番のうち、
//   実は手元の材料（物件の資料の読み・送った物件の読み・売上サポ・過去の会話・お客様のメモ・会社の事実）に答えがあった番を数える（読むだけ・LLM なし・費用0）
//
// 2026-10-15 竹内さん（設計知見 56ecf24a・P1）「自信が無い時・根拠が見つからない時は深く調査する…全部に毎回かけない」
//   → どこで「自信が無い」を測るか（ブレインの追加の調査をかける番）を実データで決めるための物差し。
// 番 = ブレインの判断（brain_decision_logs・会話×分析した発言で最後の1行）のうち
//   ①本質に約束がある（digest.tc の p≥1）／②見張りの下書き（line_watch_turns.draft_last）が確認の約束・材料が無い・聞き返しの形
// 型 = お客様の問いの種類（駐車場・ペット・敷金礼金・保証会社・入居時期・間取り/広さ・設備・ネット・入居者の条件・更新・駅/徒歩・建物・会社の事実・手続き・待ち合わせ）。
//   管理会社しか知らない事（空き・募集・内覧の可否/日程・審査・交渉・見積の金額・写真）は数えない（AIX が正しい・竹内さん 10/14）
// 材料の有無 = その番の時点より前の 送った物件の読み（sent_image_properties.facts・image_details.lines）・売上サポ（rent_observations・名前で）・
//   お客様が貼った物件の文（ポータルの書き起こし）・こちらが前に言った文・お客様のメモ・会社の事実（matchCompanyFacts）に、その型の語があるか
// 人の答え = 次のお客様の発言（6時間まで）までのスタッフの文: 約束の語なしで返した（answered）／確認の約束（promised）／AIX（aix）／無し
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-deep-check.ts [--days=30] [--show=40] [--json=<out・伏せた行>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { detectProcedureQuestion, isProcedureReplyQuestion } from "../app/lib/procedure-question";
import { detectMaterialQuestion } from "../app/lib/material-question";
import { detectEquipmentQuestion } from "../app/lib/equipment-question";
import { classifyDeepCheckTopics, STAFF_ONLY_RE, type DeepCheckTopic } from "../app/lib/brain-deep-check";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const SHOW = Number(arg("show", "40"));
const JSON_OUT = arg("json");
const SINCE = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const H = 3_600_000;

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 300_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const mask = (s: string) => String(s ?? "").replace(/https?:\/\/\S+/g, "<URL>").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "<TEL>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<MAIL>").replace(/\s+/g, " ");

/** 型ごとの「材料にその事が書いてあるか」の語（材料の文・facts の JSON に当てる） */
const MATERIAL_RE: Record<DeepCheckTopic, RegExp> = {
  parking: /駐車|駐輪|パーキング|バイク置/,
  pet: /ペット|犬|猫|"pet"/,
  deposit_key: /敷金|礼金|保証金|敷引|deposit|key_money/,
  guarantor: /保証会社|保証人|保証委託|guarantor/,
  move_in: /入居(?:可能|時期|日)|即入居|即入|退去予定|入居予定|vacan|move_in/,
  layout: /間取り|帖|畳|㎡|m²|洋室|LDK|洗面|トイレ|浴室|バス|floor_plan|area_sqm|階/,
  equipment: /設備|エアコン|コンロ|IH|オートロック|宅配|エレベーター|独立洗面|追い?焚|浴室乾燥|洗濯|ウォシュレット|温水洗浄|モニター|equipment/,
  internet: /インターネット|ネット|wi-?fi|光回線/i,
  occupancy: /二人入居|2人入居|子供|子ども|お子様|ファミリー|楽器|事務所|SOHO|法人|ルームシェア|同棲|高齢/,
  renewal: /更新/,
  access: /駅|徒歩|station|walk/,
  building: /築|構造|鉄筋|RC|鉄骨|木造|built|総戸数|階建/,
  company: /^$/, // 会社の事実は matchCompanyFacts で見る
  procedure: /^$/, // 手続き（審査の期間・必要書類）は会社の事実と同じ扱い（資料ではなく手順の知識）
  meeting: /待ち合わせ|現地|集合|パーキング|お停め|コインパーキング|駐車/,
};

type Dec = { id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; digest: Record<string, unknown> | null; suggested_action: string | null; decision_source: string | null; conversation_status: string | null };
type Watch = { conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_last: string | null; draft_first: string | null; staff_aix: unknown };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

const CONFIRM_RE = /確認(?:させて|致し|いたし|して(?:参り|まいり))|お調べ(?:し|させ)|調べさせて|確認出来次第|確認でき次第/;
const MISSING_RE = /記載(?:が|は)?(?:ござい)?(?:ません|ない|無い|なく)|資料(?:に|では)[^。\n]{0,10}(?:分かり|わかり)かね|分かりかね|わかりかね/;
const ASKBACK_RE = /(?:教えて|お聞かせ)(?:頂け|いただけ|下さ|ください)|どちらの(?:お部屋|物件)[^。\n]{0,10}(?:でしょうか|ですか)|(?:お部屋|物件)名[^。\n]{0,10}(?:頂け|いただけ)/;

function fallKind(draft: string | null | undefined): Array<"confirm" | "missing" | "askback"> {
  const d = String(draft ?? "");
  const out: Array<"confirm" | "missing" | "askback"> = [];
  if (CONFIRM_RE.test(d)) out.push("confirm");
  if (MISSING_RE.test(d)) out.push("missing");
  if (ASKBACK_RE.test(d)) out.push("askback");
  return out;
}

async function main() {
  const decs = await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, digest, suggested_action, decision_source, conversation_status").gte("created_at", SINCE).order("created_at").range(f, t));
  const watches = await readAll<Watch>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, draft_last, draft_first, staff_aix").gte("customer_turn_at", SINCE).range(f, t));
  // 会話×分析した発言で最後の判断
  const lastDec = new Map<string, Dec>();
  for (const d of decs) {
    if (isTestConversation(d.conversation_id) || isPostApplyStatus(d.conversation_status)) continue;
    if (!d.analyzed_msg_ts) continue;
    lastDec.set(`${d.conversation_id}|${ms(d.analyzed_msg_ts)}`, d);
  }
  const convIds = [...new Set([...lastDec.values()].map((d) => d.conversation_id))];
  const msgs: Msg[] = [];
  for (let i = 0; i < convIds.length; i += 40) {
    const ids = convIds.slice(i, i + 40);
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").in("conversation_id", ids).gte("created_at", new Date(ms(SINCE) - 60 * 86_400_000).toISOString()).order("created_at").range(f, t)));
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  // 材料（送った物件の読み・資料の書き起こし・メモ・売上サポ）
  const sip: Array<{ conversation_id: string; property_name: string | null; created_at: string; facts: unknown; image_url: string | null }> = [];
  const det: Array<{ conversation_id: string | null; lines: unknown; read_at: string | null; kind: string | null }> = [];
  const sent: Array<{ conversation_id: string; property_name: string | null; sent_at: string }> = [];
  const memos: Array<{ conversation_id: string; items: unknown }> = [];
  for (let i = 0; i < convIds.length; i += 40) {
    const ids = convIds.slice(i, i + 40);
    sip.push(...await readAll<typeof sip[number]>((f, t) => sb.from("sent_image_properties").select("conversation_id, property_name, created_at, facts, image_url").in("conversation_id", ids).range(f, t)));
    det.push(...await readAll<typeof det[number]>((f, t) => sb.from("image_details").select("conversation_id, lines, read_at, kind").in("conversation_id", ids).eq("kind", "property").range(f, t)));
    sent.push(...await readAll<typeof sent[number]>((f, t) => sb.from("sent_properties").select("conversation_id, property_name, sent_at").in("conversation_id", ids).range(f, t)));
    memos.push(...await readAll<typeof memos[number]>((f, t) => sb.from("customer_memos").select("conversation_id, items").in("conversation_id", ids).range(f, t)));
  }
  const names = [...new Set([...sip, ...sent].map((r) => (r.property_name ?? "").trim()).filter((n) => n.length >= 3))];
  const ro: Array<{ property_name: string; equipment: unknown; pet: unknown; deposit_months: unknown; key_money_months: unknown; floor_plan: unknown; area_sqm: unknown; station: unknown; walk_minutes: unknown; built_year: unknown; structure: unknown; floor: unknown; first_seen_at: string }> = [];
  for (let i = 0; i < names.length; i += 60) {
    const ns = names.slice(i, i + 60);
    ro.push(...await readAll<typeof ro[number]>((f, t) => sb.from("rent_observations").select("property_name, equipment, pet, deposit_months, key_money_months, floor_plan, area_sqm, station, walk_minutes, built_year, structure, floor, first_seen_at").in("property_name", ns).range(f, t)));
  }
  const roByName = new Map<string, typeof ro>();
  for (const r of ro) { const a = roByName.get(r.property_name) ?? []; a.push(r); roByName.set(r.property_name, a); }

  // 番を作る
  type Row = {
    conv: string; at: string; status: string | null; turn: string; draft: string; falls: string[]; tc: string | null;
    topics: DeepCheckTopic[]; staffOnly: boolean; human: "answered" | "promised" | "aix" | "none"; humanText: string;
    evidence: Partial<Record<DeepCheckTopic, string[]>>; brainAix: string | null; ds: string | null;
  };
  const rows: Row[] = [];
  const watchBy = new Map<string, Watch>();
  for (const w of watches) watchBy.set(`${w.conversation_id}|${ms(w.customer_last_at ?? w.customer_turn_at)}`, w);
  for (const d of lastDec.values()) {
    const tcStr = typeof d.digest?.tc === "string" ? d.digest.tc as string : null;
    const promiseN = tcStr ? Number(/p(\d+)/.exec(tcStr)?.[1] ?? 0) : 0;
    const t = ms(d.analyzed_msg_ts);
    const w = watchBy.get(`${d.conversation_id}|${t}`) ?? null;
    const draft = w?.draft_last ?? w?.draft_first ?? "";
    const falls = [...(promiseN > 0 ? ["promise"] : []), ...fallKind(draft)];
    if (!falls.length) continue;
    const cm = byConv.get(d.conversation_id) ?? [];
    // お客様の番＝前のスタッフの文の後から分析した発言まで
    const upto = cm.filter((m) => ms(m.created_at) <= t);
    let k = upto.length - 1; const turnMsgs: Msg[] = [];
    while (k >= 0 && upto[k].sender === "customer" && turnMsgs.length < 8) { turnMsgs.unshift(upto[k]); k--; }
    if (!turnMsgs.length) continue;
    const turn = turnMsgs.map((m) => m.text ?? "").join("\n⁣\n");
    const turnStart = ms(turnMsgs[0].created_at);
    // 人の答え
    const after = cm.filter((m) => ms(m.created_at) > t);
    const nextCust = after.find((m) => m.sender === "customer");
    const until = Math.min(nextCust ? ms(nextCust.created_at) : Infinity, t + 6 * H);
    const staffAfter = after.filter((m) => m.sender !== "customer" && ms(m.created_at) <= until);
    const staffText = staffAfter.filter((m) => !m.is_aix_generated && (m.text ?? "").trim() && !/^\[(?:画像|ファイル|スタンプ)\]/.test((m.text ?? "").trim()));
    const aixAfter = staffAfter.filter((m) => m.is_aix_generated);
    const firstText = staffText[0]?.text ?? "";
    const human: Row["human"] = staffText.length && !CONFIRM_RE.test(firstText) && !(aixAfter[0] && ms(aixAfter[0].created_at) < ms(staffText[0].created_at)) ? "answered"
      : staffText.length && CONFIRM_RE.test(firstText) ? "promised" : aixAfter.length ? "aix" : "none";
    const topics = classifyDeepCheckTopics(turn);
    // 会社の事実・手続き（網）
    if (matchCompanyFacts(turn).length && !topics.includes("company")) topics.push("company");
    if (isProcedureReplyQuestion(detectProcedureQuestion(turn)) && !topics.includes("procedure")) topics.push("procedure");
    if (detectMaterialQuestion(turn) && !topics.includes("layout")) topics.push("layout");
    if (detectEquipmentQuestion(turn) && !topics.includes("equipment")) topics.push("equipment");
    const staffOnly = STAFF_ONLY_RE.test(turn);
    // 材料（時点より前）
    const before = (iso: string | null | undefined) => ms(iso) < turnStart;
    const sipBefore = sip.filter((r) => r.conversation_id === d.conversation_id && before(r.created_at));
    const detBefore = det.filter((r) => r.conversation_id === d.conversation_id && before(r.read_at));
    const sentNames = [...new Set([...sipBefore.map((r) => r.property_name), ...sent.filter((r) => r.conversation_id === d.conversation_id && before(r.sent_at)).map((r) => r.property_name)].filter(Boolean) as string[])];
    const roBefore = sentNames.flatMap((n) => (roByName.get(n) ?? []).filter((r) => before(r.first_seen_at)));
    const pastCust = cm.filter((m) => m.sender === "customer" && ms(m.created_at) < turnStart).map((m) => m.text ?? "").join("\n");
    const pastStaff = cm.filter((m) => m.sender !== "customer" && ms(m.created_at) < turnStart).map((m) => m.text ?? "").join("\n");
    const turnSelf = turnMsgs.filter((m) => /^\[画像\]|【物件の(?:資料|画面|写真)】|by SUUMO|万円|管理費/.test(m.text ?? "")).map((m) => m.text ?? "").join("\n");
    const memoText = JSON.stringify(memos.find((m) => m.conversation_id === d.conversation_id)?.items ?? "");
    const srcText: Record<string, string> = {
      sent_reading: JSON.stringify(sipBefore.map((r) => r.facts ?? "")) + JSON.stringify(detBefore.map((r) => r.lines ?? "")),
      sales_support: JSON.stringify(roBefore),
      customer_pasted: `${pastCust}\n${turnSelf}`,
      staff_said: pastStaff,
      memo: memoText,
    };
    const evidence: Row["evidence"] = {};
    for (const tp of topics) {
      if (tp === "company" || tp === "procedure") { evidence[tp] = ["company_fact"]; continue; }
      const re = MATERIAL_RE[tp];
      const hit = Object.entries(srcText).filter(([, v]) => re.test(v)).map(([k2]) => k2);
      if (hit.length) evidence[tp] = hit;
    }
    rows.push({
      conv: d.conversation_id, at: d.analyzed_msg_ts!, status: d.conversation_status, turn, draft, falls, tc: tcStr,
      topics, staffOnly, human, humanText: firstText, evidence, brainAix: d.suggested_action, ds: d.decision_source,
    });
  }

  // 集計
  const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
  console.log(`=== ブレインが約束・材料なし・聞き返しに倒れた番（${DAYS}日・申込以降/テストを除く）: ${rows.length} ===`);
  console.log(`  本質に約束あり ${cnt((r) => r.falls.includes("promise"))}／下書きが確認の約束 ${cnt((r) => r.falls.includes("confirm"))}／材料なし ${cnt((r) => r.falls.includes("missing"))}／聞き返し ${cnt((r) => r.falls.includes("askback"))}`);
  console.log(`  管理会社しか知らない事だけ（空き・内覧・審査・交渉・見積・写真で、資料で答えられる型なし）: ${cnt((r) => r.staffOnly && !r.topics.length)}`);
  console.log(`  資料で答えられる型あり: ${cnt((r) => r.topics.length > 0)}`);
  const ans = rows.filter((r) => r.topics.length > 0);
  const tps = [...new Set(ans.flatMap((r) => r.topics))];
  console.log(`\n型 | 番 | 手元に材料あり | うち人が約束なしで答えた | 材料の出どころ（番の数）`);
  for (const tp of tps.sort()) {
    const rs = ans.filter((r) => r.topics.includes(tp));
    const ev = rs.filter((r) => r.evidence[tp]);
    const evAns = ev.filter((r) => r.human === "answered");
    const srcCount: Record<string, number> = {};
    for (const r of ev) for (const s of r.evidence[tp] ?? []) srcCount[s] = (srcCount[s] ?? 0) + 1;
    console.log(`${tp} | ${rs.length} | ${ev.length} | ${evAns.length} | ${Object.entries(srcCount).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  }
  console.log(`\n人の答え: answered ${cnt((r) => r.human === "answered")}／promised ${cnt((r) => r.human === "promised")}／aix ${cnt((r) => r.human === "aix")}／none ${cnt((r) => r.human === "none")}`);
  const cand = ans.filter((r) => Object.keys(r.evidence).length && r.human === "answered");
  console.log(`\n=== 候補（型あり×材料あり×人は約束なしで答えた）${cand.length} 番 — 目で読んで「答えが手元にあった」を決める ===`);
  for (const r of cand.slice(0, SHOW)) {
    console.log(`\n■ ${r.conv.slice(0, 8)} ${r.at.slice(5, 16)} [${r.falls.join(",")}] tc=${r.tc ?? "-"} aix=${r.brainAix ?? "-"} 型=${r.topics.join(",")} 材料=${JSON.stringify(r.evidence)}${r.staffOnly ? " ※管理会社の事も含む" : ""}`);
    console.log(`  お客様: ${mask(r.turn).slice(0, 220)}`);
    console.log(`  下書き: ${mask(r.draft).slice(0, 160)}`);
    console.log(`  人　　: ${mask(r.humanText).slice(0, 160)}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, rows.map((r) => JSON.stringify({ ...r, turn: mask(r.turn).slice(0, 600), draft: mask(r.draft).slice(0, 400), humanText: mask(r.humanText).slice(0, 400) })).join("\n"));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
