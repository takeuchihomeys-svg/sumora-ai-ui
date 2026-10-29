// scripts/aix-desk-eval.ts — 担当の札（ボタン×ピッカーごとの担当）の形を、30日の AIX の外れと当たりに DeepSeek で当てる試し（本番の書き込みなし・LINE に送らない）
//
// 2026-10-29 竹内さん（KB P1 03d2bdd2・ad20192b）・作業員1: AIX の統括が候補を2〜3個に絞る → 候補の担当だけが「自分の番か・どのピッカーか・何が足りないか」を答える →
//   統括が比べて1つ選ぶ（この試しでは担当の点の一番高い物＝決まった計算・LLM を1回減らす）。正解はスタッフの押下（竹内さんの番と従業員の番を分けて数える＝竹内基準）。
//   入力: scripts/audit-aix-miss-causes.ts --json=<path> --hits=60 の出力（外れ134・当たり60）
//   伏せる: 申込の書類の手前で切る・名前（呼び名）・URL・号室・電話等。個人の値が残る番は外す（memory/test_protocol_brain.md 6）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/aix-desk-eval.ts --in=<json> [--n=999] [--max-usd=3] [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AIX_CATALOG, catalogKeyOfPress, buttonOfKey, topicKey } from "../app/lib/aix-catalog";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import type { AixDeskCard } from "../app/lib/aix-desk-types";
// 札は手元だけ（scripts/build-aix-desk-cards.ts の出力・git に入れない）
const AIX_DESK_CARDS: Record<string, AixDeskCard> = (JSON.parse(readFileSync(join(examCacheRoot(), "aix-desk", "cards.json"), "utf8")) as { cards: Record<string, AixDeskCard> }).cards;
import { cutBeforeApplicationMaterial, piiValueSignal, applicationMaterialReason } from "../app/lib/test-pii-guard";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
// --with-brain: LINE の統括（今のブレイン）の AIX を候補に必ず入れ、点が同じ時はブレインの方を選ぶ（壊さない形）
const WITH_BRAIN = process.argv.includes("--with-brain");
// --situation: 作業員2の状況のまとめ（app/lib/situation-summary.ts）を、その番の時刻までの記録だけで作り、統括と担当に渡す（後の出来事を混ぜない）
const WITH_SITUATION = process.argv.includes("--situation");
// --q197=N: 試験の q197（持ち込みの確認＋探す依頼・竹内さんの正解は2段＝約束）を N 回足す。物件確認した の担当が「結果がまだ無い→約束」と差し戻せるか
const Q197 = Number(arg("q197", "0"));
// --compare: 担当を別々に聞かず、統括が候補の札を並べて1回で比べて選ぶ（似たボタンの組は相手も候補に足し、見分けの軸を明示する）
const COMPARE = process.argv.includes("--compare");
const IN = arg("in"); const OUT = arg("out"); const N = Number(arg("n", "999")); const MAX_USD = Number(arg("max-usd", "3"));

type InRow = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; scene_key: string | null; cause: string; staff_aix: string | null; staff_check_pattern: string | null; staff_writer: string; brain_action: string | null; brain_reply_mode: string | null };
type Msg = { sender: string; text: string | null; created_at: string };

/** その番の時刻（asOf）までの記録だけで状況のまとめを作り、短い文にする（読めない時は ""） */
async function situationText(conversationId: string, asOf: string, convStatus: string | null, turnText: string): Promise<string> {
  try {
    const { resolveCustomerState } = await import("../app/lib/customer-state");
    const { buildActionLedger } = await import("../app/lib/action-ledger");
    const { buildPromiseQueue } = await import("../app/lib/promise-queue");
    const { itemsFromLedger, bindReaction, explainedItemsOf } = await import("../app/lib/sent-ledger-bind");
    const { buildSituationSummary, withTurnBrought } = await import("../app/lib/situation-summary");
    const { broughtThisTurnNames } = await import("../app/lib/aix-commander");
    const nowMs = Date.parse(asOf);
    const [msgs, aix, facts, vh, sp, tasks] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, line_message_id").eq("conversation_id", conversationId).lte("created_at", asOf).order("created_at", { ascending: false }).limit(300),
      sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, prop_statuses, estimate_sent, template_name").eq("conversation_id", conversationId).lte("created_at", asOf).order("created_at", { ascending: false }).limit(200),
      sb.from("sent_facts").select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence").eq("conversation_id", conversationId).lte("sent_at", asOf).order("sent_at", { ascending: false }).limit(300),
      sb.from("viewing_history").select("scheduled_date, scheduled_time, status, property_name, actual_date, viewing_report, created_at").eq("conversation_id", conversationId).lte("created_at", asOf),
      sb.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", conversationId).lte("sent_at", asOf).order("sent_at", { ascending: false }).limit(300),
      sb.from("line_tasks").select("task_type, status, created_at, resolved_at, result").eq("conversation_id", conversationId).lte("created_at", asOf).order("created_at", { ascending: false }).limit(30),
    ]);
    const m2 = ((msgs.data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null }>).reverse();
    const messages = m2.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: m.line_message_id }));
    const aixRows = ((aix.data ?? []) as any[]).reverse();
    const recordedFacts = ((facts.data ?? []) as any[]).reverse();
    const lineTasks = ((tasks.data ?? []) as any[]).map((t) => ({ task_type: t.task_type, status: t.status, created_at: t.created_at, completed_at: t.resolved_at, result: t.result }));
    const lastCustomerAt = [...messages].reverse().find((m) => m.sender === "customer")?.createdAt ?? null;
    const ledger = buildActionLedger({ recentAixRows: aixRows.filter((r: any) => !!r.aix_type), messages: messages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: m.isAix, lineMessageId: m.lineMessageId })), lineTasks, lastCustomerAt, now: nowMs, recordedFacts } as any);
    const state = resolveCustomerState({ now: nowMs, status: convStatus, messages, aixRows, recordedFacts, lineTasks, viewingHistory: (vh.data ?? []) as any, sentProperties: ((sp.data ?? []) as any[]).reverse(), ledger } as any);
    const promises = buildPromiseQueue(messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: m.isAix })), aixRows.map((l: any) => ({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.sent_at ?? l.created_at, estimateSent: l.estimate_sent, text: l.generated_text })), nowMs);
    const staffItems = messages.filter((m) => m.sender !== "customer" && (m.text ?? "").trim()).slice(-10).flatMap((m) => explainedItemsOf(m.text ?? "", m.createdAt, m.lineMessageId));
    const bind = bindReaction({ customerText: turnText, items: [...itemsFromLedger(ledger.entries as any), ...staffItems], nowMs });
    const sum = withTurnBrought(buildSituationSummary({ state, promises, emotion: null, bind, pickupReady: null, nowMs }), broughtThisTurnNames(turnText));
    const nf = sum.nowFulfillable;
    const j = (a: string[]) => (a.length ? a.slice(0, 6).join("・") : "なし");
    return [
      `【状況のまとめ（この番の時点の記録だけ）】段階: ${sum.stageLabel}`,
      `まだ果たしていない約束: ${sum.openPromises.length ? sum.openPromises.slice(0, 5).map((p) => `${p.kind}${p.object ? `（${p.object}）` : ""}`).join("・") : "なし"}`,
      `今すぐ果たせる物: 募集中と確認済み=${j(nf.confirmed)}／見積を作れる=${j(nf.estimateReady)}／見積を送った=${j(nf.estimated)}／まだ確認が要る=${j(nf.needCheck)}`,
      `今の発言が指す送った事: ${sum.bind ? `${sum.bind.kind}${sum.bind.name ? `（${sum.bind.name}）` : ""}${sum.bind.topic ? `・${sum.bind.topic}` : ""}` : "不明"}`,
    ].join("\n");
  } catch (e) { console.warn(`  状況のまとめ失敗: ${e instanceof Error ? e.message : e}`); return ""; }
}


const cost = { usd: 0, calls: 0, fail: 0, hit: 0, miss: 0 };
async function deepseekJson(sys: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  if (piiValueSignal(user)) { cost.fail++; return null; }
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 600, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++; cost.hit += j.usage?.prompt_cache_hit_tokens ?? 0; cost.miss += j.usage?.prompt_cache_miss_tokens ?? 0;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(`  失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}

function maskForLlm(text: string, names: string[]): string {
  return maskExamText(text, null, names)
    .replace(/https?:\/\/\S+/g, "［URL］")
    .replace(/[0-9０-９]{2,4}\s*号室/g, "［号室］")
    .replace(/\[(画像|動画|ファイル)\][^\n]{60,}/g, (m) => m.slice(0, 80));
}

const SELECTABLE = AIX_CATALOG.filter((e) => e.brainSelectable);
const LIST_TEXT = SELECTABLE.map((e) => `- ${e.key}｜${e.button}${e.picker ? `→${e.picker.label}` : ""}｜${(e.staffOnly || "定型").slice(0, 50)}`).join("\n");
const COMMANDER_SYS = [
  "あなたは大阪の賃貸仲介（スモラ）の LINE 接客で、AIX（スタッフが確かめた事・資料を送る道具）のボタン×ピッカーを選ぶ「AIX の統括」です。",
  "今のお客様の発言と前の流れを読み、スタッフがこの後に押す AIX の候補を一覧から3つまで、ありそうな順に選びます。",
  "スタッフだけが知る事（管理会社に確認した結果・見積の金額・内覧の空き・撮った写真など）が要る番は AIX。会話・資料・会社の事実だけで答えられる番は AIX ではない（not_aix）。",
  "鍵は一覧の鍵をそのまま書く。",
  "【一覧（鍵｜ボタン→ピッカー｜送るスタッフだけが知る事）】",
  LIST_TEXT,
  "AIX の番ではないと思う時も、押すならこれという候補を3つ書く（後で比べ直す）。",
  '出力は JSON だけ: {"aix_turn":true,"candidates":["鍵1","鍵2","鍵3"],"why":"短く"}',
].join("\n");
/** 取り違えやすい組（②の実データ）: 片方が候補にあれば相手も比べる */
const PAIRS: Record<string, string[]> = {
  property_check_result: ["estimate_sheet", "acknowledge_check"], estimate_sheet: ["property_check_result"], acknowledge_check: ["property_check_result"],
  property_recommendation: ["property_send"], property_send: ["property_recommendation"],
  viewing_invite: ["meeting_place"], meeting_place: ["viewing_invite"],
  guarantor_info: ["phone_call"], zenryoku_support: ["property_send", "property_recommendation"],
};
/** 組の見分けの軸（竹内さんの決定・カタログの線・②の外れの読み） */
const PAIR_AXES = [
  "・物件確認した ↔ 見積書送る: その物件の募集中がもう分かっている（状況のまとめの「募集中と確認済み」「見積を作れる」にある）なら見積書送る。まだ確認が要る物件（持ち込み・募集の確認がまだ）は物件確認した（募集中なら見積書を同封する）。",
  "・物件オススメ ↔ 物件ピックアップした: 1件に絞って推す（強い1件・新着1件・送った中から1件）は物件オススメ。何件かをまとめて送る（新規・新着の束・条件を広げた束）は物件ピックアップした。",
  "・内覧調整 ↔ 待ち合わせ: お客様が候補から日と時刻を決めた・了承した（「〇日〇時でお願いします」）は待ち合わせ。日時なしの内覧の希望・空きを聞く・日だけで時刻なしは内覧調整。",
  "・確認した（条件・交渉）↔ 物件確認した: 物件を特定する物（URL・画像・物件名＋募集の問い）は物件確認した。礼金・家賃・設備など条件の交渉・確認は確認した。",
  "・保証会社・審査の相談（夜職・無職・ブラック・滞納など本人の事情）は電話も候補（文で言い切らない）。",
  "・全力サポートはお客様の返信の後・送った物件が刺さらず送れる物件が無い時だけ。持ち込みの物件や新着がある時は物件の AIX。",
];
const COMPARE_SYS = [
  "あなたは大阪の賃貸仲介（スモラ）の「AIX の統括」です。候補のボタン×ピッカーの担当の札を読み比べ、この番の後にスタッフ（竹内さん＝社長の基準）が送る物を1つ選びます。",
  "選べる答え: 候補の鍵のどれか／reply（AIX ではなく返信で答える番・会話や資料や会社の事実で答えられる）／promise（スタッフだけが知る事が要るが、結果がまだ無く、同じ連投に約束で受けるべき依頼もある＝まず約束の返信・結果が出てから AIX）。",
  "確認の結果（募集中か終了か等）はスタッフが確かめてから選ぶので、結果がまだ会話に無い事だけでは promise にしない。promise は探す・見積の作成などの依頼が一緒にあって、まとめて約束で受けるのが自然な時。",
  "【取り違えやすい組の見分けの軸】",
  ...PAIR_AXES,
  '出力は JSON だけ: {"pick":"鍵 か reply か promise","second":"2番目","why":"見分けの軸に沿って短く"}',
].join("\n");
const deskSys = (key: string) => [
  "あなたは大阪の賃貸仲介（スモラ）の AIX の担当です。下の札があなたの担当のボタン×ピッカーの中身です（竹内さん＝社長の送り方が基準）。",
  "今の番の後に、スタッフがあなたの担当のボタン×ピッカーを押して送る流れかを答えます。確認の結果（募集中か終了か・管理会社の答え）はスタッフが確かめてから選ぶので、結果がまだ会話に無い事は理由にしない（約束の返信にするか、その場で AIX にするかは別の所で決める）。",
  AIX_DESK_CARDS[key]?.text ?? `■担当 ${key}`,
  "あなたの番の内容が要るのに、その確認の結果がまだ無く（状況のまとめの「まだ確認が要る」にある等）、同じ連投に約束で受けるべき依頼（探す・見積の作成 等）もある時は send_back を promise にする（まず約束の返信で受け、結果が出てから AIX）。AIX の番ではない（会話・資料で答えられる）と思う時は not_aix。",
  '出力は JSON だけ: {"mine":true,"score":0.0〜1.0,"picker":"別のピッカーを勧める時だけ鍵","missing":["足りない材料"],"send_back":null,"why":"短く"}',
].join("\n");

(async () => {
  if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("LLM_TEST_MODE=deepseek-all を付けて流す");
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest("aix-desk-eval");
  try {
    const input = JSON.parse(readFileSync(IN, "utf8")) as { misses: InRow[]; hits: InRow[] };
    const q197Rows: InRow[] = Array.from({ length: Q197 }, () => ({ id: 197, conversation_id: "d88bc551-ef58-48f2-bb25-1f0eedd056a9", customer_turn_at: "2026-10-20T09:20:00.000Z", customer_last_at: "2026-10-20T09:34:17.999Z", scene_key: "返信:質問", cause: "q197", staff_aix: null, staff_check_pattern: null, staff_writer: "takeuchi", brain_action: "property_check_result", brain_reply_mode: "aix" }));
    const rows = [...input.misses, ...input.hits].slice(0, N).concat(q197Rows);
    type Res = { row: InRow; gold: string; goldBtn: string; brainBtn: string; aixTurn: boolean | null; cands: string[]; pick: string | null; sendBack: string | null; desks: Array<{ key: string; mine: boolean; score: number; why: string; missing: string[]; sendBack: string | null }>; skipped?: string };
    const results: Res[] = [];
    const work = async (r: InRow): Promise<Res> => {
      const gold = catalogKeyOfPress({ aix_type: r.staff_aix, check_pattern: r.staff_check_pattern }).key;
      const base: Res = { row: r, gold, goldBtn: buttonOfKey(gold), brainBtn: r.brain_reply_mode === "aix" ? String(r.brain_action ?? "") : "返信", aixTurn: null, cands: [], pick: null, sendBack: null, desks: [] };
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).lte("created_at", r.customer_last_at ?? r.customer_turn_at).order("created_at", { ascending: false }).limit(12);
      const msgs = ((data ?? []) as Msg[]).reverse();
      const cut = cutBeforeApplicationMaterial(msgs);
      if (cut.cutAt != null && cut.kept.length < msgs.length) return { ...base, skipped: "申込の書類より後" };
      const names = addressNamesOf(msgs.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
      const turnAt = Date.parse(r.customer_turn_at);
      const lines = msgs.map((m) => `${Date.parse(m.created_at) >= turnAt && m.sender === "customer" ? "★" : ""}${m.sender === "customer" ? "お客様" : "こちら"}: ${maskForLlm(m.text ?? "", names).replace(/\s+/g, " ").slice(0, 220)}`);
      if (lines.some((l) => applicationMaterialReason(l) || piiValueSignal(l))) return { ...base, skipped: "個人の値" };
      const turnText = msgs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= turnAt).map((m) => m.text ?? "").join("\n");
      const sit = WITH_SITUATION ? maskForLlm(await situationText(r.conversation_id, r.customer_last_at ?? r.customer_turn_at, r.cause === "q197" ? null : ((await sb.from("line_watch_turns").select("conv_status").eq("id", r.id).maybeSingle()).data as { conv_status?: string | null } | null)?.conv_status ?? null, turnText), names) : "";
      const user = `${sit ? `${sit}\n\n` : ""}【会話（★が今の番のお客様の発言）】\n${lines.join("\n")}`;
      if (process.argv.includes("--show-sit") && r.cause === "q197") console.log(`
[q197 の入力]
${user.slice(0, 2500)}
`);
      const c = await deepseekJson(COMMANDER_SYS, user);
      let cands = (Array.isArray(c?.candidates) ? (c!.candidates as unknown[]).map(String) : []).filter((k) => !!AIX_DESK_CARDS[k]).slice(0, 3);
      let brainKey: string | null = null;
      if (WITH_BRAIN && r.brain_reply_mode === "aix" && r.brain_action) {
        brainKey = cands.find((k) => buttonOfKey(k) === r.brain_action) ?? (AIX_DESK_CARDS[r.brain_action] ? r.brain_action : Object.keys(AIX_DESK_CARDS).find((k) => buttonOfKey(k) === r.brain_action) ?? null);
        if (brainKey && !cands.includes(brainKey)) cands = [...cands, brainKey];
      }
      base.aixTurn = c?.aix_turn === false ? false : true; base.cands = cands;
      if (COMPARE) {
        // 組の相手を足す（候補のボタンの相手のボタンの札を1枚ずつ・最大6）
        const btns = new Set(cands.map(buttonOfKey));
        for (const k of [...cands]) for (const pb of PAIRS[buttonOfKey(k)] ?? []) {
          if (btns.has(pb) || cands.length >= 6) continue;
          const pk = AIX_DESK_CARDS[pb] ? pb : Object.keys(AIX_DESK_CARDS).find((x) => buttonOfKey(x) === pb);
          if (pk) { cands.push(pk); btns.add(pb); }
        }
        base.cands = cands;
        const cardsText = cands.map((k) => AIX_DESK_CARDS[k]?.text ?? `■担当 ${k}`).join("\n\n");
        const o = await deepseekJson(COMPARE_SYS, `${user}\n\n【候補の担当の札】\n${cardsText}\n\n【候補の鍵】${cands.join(" / ")} / reply / promise`);
        const pk = String(o?.pick ?? "");
        if (pk === "promise" || pk === "reply") { base.pick = null; base.sendBack = pk === "promise" ? "promise" : "not_aix"; }
        else base.pick = AIX_DESK_CARDS[pk] ? pk : null;
        base.desks = [{ key: "compare", mine: !!base.pick, score: 1, why: String(o?.why ?? "").slice(0, 120), missing: [], sendBack: base.sendBack }];
        return base;
      }
      const desks = await Promise.all(cands.map(async (k) => {
        const d = await deepseekJson(deskSys(k), user);
        const sbk = typeof d?.send_back === "string" && /^(promise|not_aix)$/.test(d.send_back) ? d.send_back : null;
        return { key: k, mine: d?.mine === true, score: Number(d?.score ?? 0) || 0, why: String(d?.why ?? "").slice(0, 80), missing: Array.isArray(d?.missing) ? (d!.missing as unknown[]).map(String).slice(0, 3) : [], sendBack: sbk };
      }));
      base.desks = desks;
      const mine = desks.filter((d) => d.mine).sort((a, b) => b.score - a.score || (a.key === brainKey ? -1 : b.key === brainKey ? 1 : 0));
      base.pick = mine[0]?.key ?? null;
      base.sendBack = (mine[0] ?? [...desks].sort((a, b) => b.score - a.score)[0])?.sendBack ?? null;
      return base;
    };
    for (let i = 0; i < rows.length; i += 6) {
      if (cost.usd > MAX_USD) { console.log(`費用の上限 $${MAX_USD} で止める（${i}番まで）`); break; }
      results.push(...await Promise.all(rows.slice(i, i + 6).map(work)));
      if (i % 30 === 0) console.log(`  ${Math.min(i + 6, rows.length)}/${rows.length} $${cost.usd.toFixed(3)}`);
    }
    const done = results.filter((x) => !x.skipped);
    const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
    const summarize = (xs: Res[], label: string) => {
      const btnOk = xs.filter((x) => x.pick && buttonOfKey(x.pick) === x.goldBtn).length;
      const keyOk = xs.filter((x) => x.pick && topicKey(x.pick) === topicKey(x.gold)).length;
      const candHas = xs.filter((x) => x.cands.some((k) => buttonOfKey(k) === x.goldBtn)).length;
      const noPick = xs.filter((x) => !x.pick).length;
      console.log(`| ${label} | ${xs.length} | ${btnOk}（${pct(btnOk, xs.length)}） | ${keyOk}（${pct(keyOk, xs.length)}） | ${candHas}（${pct(candHas, xs.length)}） | ${noPick} |`);
    };
    console.log(`\n# 担当の札の試し（DeepSeek・本番の書き込みなし）: ${done.length}番（外した ${results.length - done.length}: 申込の書類より後・個人の値）`);
    console.log("今の選び方の正解の数: 外れの番は 0（定義どおり）・当たりの番は全部（同じボタン）。\n");
    console.log("| 組 | 番 | ボタンが合った | ボタン×ピッカーが合った（結果のピッカーは寄せる） | 候補3つにボタンが入った | 担当が誰も手を挙げない |");
    console.log("|---|---|---|---|---|---|");
    const miss = done.filter((x) => x.row.cause !== "hit" && x.row.cause !== "q197"), hit = done.filter((x) => x.row.cause === "hit");
    summarize(miss, "外れの番（全部）");
    for (const c of ["①返信と AIX の取り違え", "②AIX の種類違い", "③約束かその場か", "④スタッフだけが知る事", "⑤材料が届いていない"]) summarize(miss.filter((x) => x.row.cause === c), `　${c}`);
    summarize(miss.filter((x) => x.row.staff_writer === "takeuchi"), "　うち竹内さんの番");
    summarize(hit, "当たりの番（壊さないか）");
    summarize(hit.filter((x) => x.row.staff_writer === "takeuchi"), "　うち竹内さんの番");
    const q = results.filter((x) => x.row.cause === "q197");
    if (q.length) console.log(`\nq197（正解は約束の返信）: ${q.length}回のうち 差し戻し promise ${q.filter((x) => x.sendBack === "promise").length}・選んだ AIX ${q.map((x) => x.pick ?? "なし").join(",")}${q.some((x) => x.skipped) ? `（外した: ${q.find((x) => x.skipped)?.skipped}）` : ""}`);
    const sbMiss = miss.filter((x) => x.sendBack), sbHit = hit.filter((x) => x.sendBack);
    console.log(`差し戻し: 外れの番 ${sbMiss.length}（promise ${sbMiss.filter((x) => x.sendBack === "promise").length}）・当たりの番 ${sbHit.length}（promise ${sbHit.filter((x) => x.sendBack === "promise").length}）`);
    console.log(`統括の絞りすぎ: 外れの番で AIX の番ではないとした ${miss.filter((x) => x.aixTurn === false || !x.cands.length).length}・候補が3つ未満 ${miss.filter((x) => x.cands.length > 0 && x.cands.length < 3).length}`);
    console.log(`\n費用: DeepSeek ${cost.calls}回 $${cost.usd.toFixed(3)}（入力のキャッシュ ${pct(cost.hit, cost.hit + cost.miss)}・失敗 ${cost.fail}）／Claude 0回`);
    if (OUT) writeFileSync(OUT, JSON.stringify(results.map((x) => ({ id: x.row.id, cause: x.row.cause, writer: x.row.staff_writer, gold: x.gold, brain: x.brainBtn, cands: x.cands, pick: x.pick, desks: x.desks, skipped: x.skipped })), null, 1));
  } finally { await h.finish(); }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
})();
