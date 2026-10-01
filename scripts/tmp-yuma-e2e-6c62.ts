// 一時のテスト（6c6291ed の通し・YUMA）。終わったら消す。
//   snap                 … 始める前の写しを scratchpad に保存
//   run <場面id...>      … 場面の発言を入れる → ブレイン（保存しない）→ 下書き（:3000・brainMetaDirect・shadowNoWrite）→ 発言を消す
//   cleanup              … 入れた発言・副作用を消す（写しと比べて増えた行だけ）
//   verify               … 写しと今を比べる
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeConversation } from "../app/lib/brain-core";
import { detectTaskTypeByKeywords, decideAutoTask } from "../app/lib/property-check-task";
import { aixButtonText } from "../app/lib/aix-action-text";
import { getCustomerState } from "../app/lib/customer-state-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const PAD = process.env.PAD ?? "";
if (!PAD) throw new Error("PAD（scratchpad）を指定");
const SNAP = join(PAD, "e2e6c62-snap.json");
const STATE = join(PAD, "e2e6c62-inserted.json");
const LOG = join(PAD, "e2e6c62-results.jsonl");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const JST = 9 * 3600_000;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const jd = (o: number) => { const d = new Date(Date.now() + JST + o * 86_400_000); return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, day: d.getUTCDate(), wd: WD[d.getUTCDay()] }; };
const D0 = jd(0), D1 = jd(1), D2 = jd(2);

type M = { s: "staff" | "customer"; text: string; min: number; aix?: { type: string; template_name?: string } };
type Scene = { id: string; label: string; expect: string; msgs: M[]; n: number };

const wish: M = { s: "customer", text: "内覧したいです", min: 200 };
const invite2: M = { s: "staff", text: `YUMAさん\nお世話になっております！！\n\n${D2.md}日ですと13:00〜16:00ご内覧可能です！！\nYUMAさんご都合如何でしょうか😌！！`, min: 180, aix: { type: "viewing_invite", template_name: "内覧日調整" } };
const invite1: M = { s: "staff", text: `YUMAさん\nお世話になっております！！\n\n${D1.md}日ですと13:00〜16:00ご内覧可能です！！\nYUMAさんご都合如何でしょうか😌！！`, min: 180, aix: { type: "viewing_invite", template_name: "内覧日調整" } };
const inviteToday: M = { s: "staff", text: `YUMAさん\nお世話になっております！！\n\n本日ですと20:30〜ご内覧可能です！！\nYUMAさんご都合如何でしょうか😌！！`, min: 60, aix: { type: "viewing_invite", template_name: "内覧日調整" } };
const agree: M = { s: "customer", text: `では${D2.day}日の14時でお願いします`, min: 60 };
const meeting: M = { s: "staff", text: `かしこまりました！！\n${D2.md}（${D2.wd}）14:00〜ご案内させて頂きます！！\n\n${D2.md} 14:00にファーストフィオーレ難波ウエスト 901号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！`, min: 40, aix: { type: "meeting_place", template_name: "待ち合わせ" } };
const last = (text: string): M => ({ s: "customer", text, min: 1 });

const SCENES: Scene[] = [
  { id: "A1", label: "内覧したいです", expect: "viewing_invite・物件確認タスクなし", msgs: [last("内覧したいです")], n: 1 },
  { id: "A2", label: `候補日（${D1.md}）の後「${D2.day}日はどうですか？」`, expect: "viewing_invite（もう一度）・meeting_place にしない", msgs: [wish, invite1, last(`${D2.day}日はどうですか？`)], n: 1 },
  { id: "A3a", label: "内覧調整中「夜職なのですがアリバイ会社使えますか？」", expect: "質問にだけ答える・内覧の語なし・段階進めない", msgs: [wish, invite2, last("夜職なのですがアリバイ会社使えますか？")], n: 2 },
  { id: "A3b", label: "内覧調整中「初期費用分割は難しいですよね」", expect: "質問にだけ答える（カード払いのみ可・3.24%）・内覧の語なし", msgs: [wish, invite2, last("初期費用分割は難しいですよね")], n: 2 },
  { id: "A4", label: `「では${D2.day}日の14時でお願いします」`, expect: "meeting_place", msgs: [wish, invite2, { ...agree, min: 1 }], n: 1 },
  { id: "A5", label: "待ち合わせ場所の後に別の質問（アリバイ会社）", expect: "meeting_place をもう一度出さない・当日よろしく系は可", msgs: [wish, invite2, agree, meeting, last("夜職なのですがアリバイ会社使えますか？")], n: 2 },
  { id: "A5b", label: "待ち合わせ場所の後に別の質問（初期費用分割）", expect: "同上", msgs: [wish, invite2, agree, meeting, last("初期費用分割は難しいですよね")], n: 1 },
  { id: "A6a", label: "候補日の後「27日以降で18時頃って可能でしょうか？」", expect: "日にち決定にしない（viewing_invite）", msgs: [wish, invite2, last("27日以降で18時頃って可能でしょうか？")], n: 1 },
  { id: "A6b", label: "候補が本日「今日ではなくていいのですが」", expect: "日にち決定にしない（viewing_invite）", msgs: [wish, inviteToday, last("今日ではなくていいのですが")], n: 1 },
  { id: "B", label: "この物件の管理会社はどこですか？", expect: "property_check_result＋mgmt_company（確認した→管理会社について）", msgs: [last("この物件の管理会社はどこですか？")], n: 1 },
  { id: "C", label: "審査ってどのくらいかかりますか？", expect: "AIX なし・返信で説明・内覧に触れない", msgs: [last("審査ってどのくらいかかりますか？")], n: 2 },
  { id: "C2", label: "内覧調整中「審査ってどのくらいかかりますか？」", expect: "AIX なし（または2択）・返信で説明・内覧に触れない", msgs: [wish, invite2, last("審査ってどのくらいかかりますか？")], n: 2 },
];

const CHECKS: Array<[string, RegExp]> = [
  ["お待たせ", /お待たせ/],
  ["作業メモ", /【[^】]*(?:注記|決定論|台帳|ブレイン|AIX)[^】]*】|※|WE DO|AIX|<<<|>>>|ブレイン|下書き|スタッフ/],
  ["内覧の先走り", new RegExp(`(?:内覧|内見)(?:時|の際|の時|当日)|(?:内覧|内見)[^\\n。！!]{0,12}(?:よろしく|宜しく|楽しみ|お待ちして)|当日は?[^\\n。！!]{0,8}(?:よろしく|宜しく)|(?<![0-9])${D2.day}日|${D2.md.replace("/", "\\/")}`)],
  ["内覧の語", /内覧|内見/],
  ["待ち合わせ", /待ち合わせ|現地エントランス/],
];

type St = { msgIds: string[]; aixIds: string[] };
const loadSt = (): St => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) as St : { msgIds: [], aixIds: [] });
const saveSt = (s: St) => writeFileSync(STATE, JSON.stringify(s), "utf8");

const SIDE: Array<[string, string, string]> = [
  ["aix_action_items", "conversation_id", "created_at"], ["line_tasks", "conversation_id", "created_at"], ["scheduled_messages", "conversation_id", "created_at"],
  ["brain_decision_logs", "conversation_id", "created_at"], ["jev_shadow_logs", "conversation_id", "created_at"], ["knowledge_apply_log", "conversation_id", "applied_at"],
  ["reply_mode_shadow_logs", "conversation_id", "created_at"], ["closing_strategy_logs", "conversation_id", "proposed_at"], ["aix_generate_log", "conversation_id", "created_at"],
  ["calendar_events", "conversation_id", "created_at"], ["property_condition_history", "customer_id", "created_at"], ["messages", "conversation_id", "created_at"], ["aix_usage_logs", "conversation_id", "created_at"],
];
async function ids(table: string, col: string): Promise<string[] | string> {
  const { data, error } = await sb.from(table).select("id").eq(col, col === "customer_id" ? PC : Y).limit(5000);
  if (error) return `ERR ${error.message}`;
  return ((data ?? []) as Array<{ id: string | number }>).map((r) => String(r.id));
}
async function takeSnap() {
  const { data: conv } = await sb.from("conversations").select("*").eq("id", Y).maybeSingle();
  const { data: pc } = await sb.from("property_customers").select("*").eq("id", PC).maybeSingle();
  const side: Record<string, string[] | string> = {};
  for (const [t, c] of SIDE) side[t] = await ids(t, c);
  const { data: pend } = await sb.from("aix_action_items").select("*").eq("conversation_id", Y).eq("status", "pending");
  const { data: tasks } = await sb.from("line_tasks").select("*").eq("conversation_id", Y).in("status", ["pending", "in_progress"]);
  const { data: sched } = await sb.from("scheduled_messages").select("*").eq("conversation_id", Y);
  return { at: new Date().toISOString(), conv, pc, side, pendingAix: pend ?? [], openTasks: tasks ?? [], scheduled: sched ?? [] };
}

async function snap() {
  if (existsSync(SNAP)) { console.log("写しは既にある（上書きしない）:", SNAP); return; }
  const s = await takeSnap();
  writeFileSync(SNAP, JSON.stringify(s, null, 1), "utf8");
  console.log("写した:", SNAP);
  for (const [k, v] of Object.entries(s.side)) console.log(`  ${k.padEnd(28)} ${Array.isArray(v) ? v.length : v}`);
  console.log(`  未処理 AIX要対応 ${s.pendingAix.length}・開いているタスク ${s.openTasks.length}・予約送信 ${s.scheduled.length}`);
  const { data: lu } = await sb.from("llm_usage_logs").select("created_at, action, model, env").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(5);
  console.log("  直近の llm_usage_logs:", JSON.stringify(lu));
}

async function drop(st: St) {
  if (st.msgIds.length) { const { error } = await sb.from("messages").delete().in("id", st.msgIds); if (error) console.log("⚠ messages:", error.message); else st.msgIds = []; }
  if (st.aixIds.length) { const { error } = await sb.from("aix_usage_logs").delete().in("id", st.aixIds); if (error) console.log("⚠ aix_usage_logs:", error.message); else st.aixIds = []; }
  saveSt(st);
}

async function insert(st: St, sc: Scene) {
  const now = Date.now();
  for (const m of sc.msgs) {
    const at = new Date(now - m.min * 60_000).toISOString();
    const { data, error } = await sb.from("messages").insert({ conversation_id: Y, sender: m.s, text: m.text, created_at: at, is_aix_generated: !!m.aix }).select("id").single();
    if (error) throw new Error(`messages insert: ${error.message}`);
    st.msgIds.push((data as { id: string }).id); saveSt(st);
    if (m.aix) {
      const { data: a, error: e2 } = await sb.from("aix_usage_logs").insert({ conversation_id: Y, aix_type: m.aix.type, template_name: m.aix.template_name ?? null, generated_text: m.text, sent_at: at, created_at: at, conversation_status: "proposing" }).select("id").single();
      if (e2) throw new Error(`aix_usage_logs insert: ${e2.message}`);
      st.aixIds.push((a as { id: string }).id); saveSt(st);
    }
  }
}

async function buildBody() {
  const { data: conv } = await sb.from("conversations").select("customer_name, status, has_viewed").eq("id", Y).maybeSingle();
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(60);
  const all = ((ms ?? []) as Array<Record<string, unknown>>).reverse();
  const lastStaffIdx = all.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
  const after = lastStaffIdx !== undefined ? all.slice(lastStaffIdx + 1) : all;
  const unreplied = after.filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10).map((m) => String(m.text));
  const message = unreplied.join("\n⁣\n");
  const c = (conv ?? {}) as Record<string, unknown>;
  return { message, customerMessages: unreplied, state: String(c.status ?? "proposing"), conversationId: Y, customerName: "YUMA", hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
    recentMessages: all.slice(-25).map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated })),
    oldest: all.map((m) => ({ sender: String(m.sender), text: String(m.text ?? "") })) };
}

async function run(idsArg: string[]) {
  if (!existsSync(SNAP)) throw new Error("先に snap");
  const st = loadSt();
  if (st.msgIds.length || st.aixIds.length) { console.log("前の場面の行が残っている → 消す"); await drop(st); }
  const { data: c0 } = await sb.from("conversations").select("status, brain_strategy, conversation_direction, last_sender").eq("id", Y).maybeSingle();
  const cc = (c0 ?? {}) as Record<string, unknown>;
  for (const sc of SCENES.filter((s) => idsArg.includes(s.id))) {
    console.log(`\n${"═".repeat(70)}\n【${sc.id}】${sc.label}\n  期待: ${sc.expect}`);
    const rec: Record<string, unknown> = { id: sc.id, label: sc.label, expect: sc.expect, at: new Date().toISOString() };
    try {
      await insert(st, sc);
      const { data: ls } = await sb.from("conversations").select("last_sender").eq("id", Y).maybeSingle();
      if ((ls as { last_sender?: string } | null)?.last_sender !== cc.last_sender) throw new Error("last_sender が変わった → 止める");
      const lastText = sc.msgs[sc.msgs.length - 1].text;
      const body = await buildBody();
      // タスクの判定（webhook autoDetectTask と同じ純関数）
      const kw = detectTaskTypeByKeywords(lastText);
      const task = kw ? decideAutoTask(lastText, body.oldest.slice(-30) as never) : null;
      rec.task = { keyword: kw, decided: task };
      console.log(`  タスク判定: 語=${kw ?? "なし"} → 作る=${task ?? "なし"}`);
      const cs = await getCustomerState(Y).catch(() => null);
      rec.stateLine = cs ? { stage: (cs as unknown as Record<string, unknown>).stage, headline: (cs as unknown as Record<string, unknown>).headline ?? (cs as unknown as Record<string, unknown>).line } : null;
      console.log("  状況表示:", JSON.stringify(rec.stateLine));
      const strategy = (cc.brain_strategy ?? null) as never;
      const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
      const vfLogs: string[] = [];
      const origInfo = console.info;
      console.info = (...a: unknown[]) => { const s = a.map(String).join(" "); if (/\[brain:(viewing-flow|confirm-topic|procedure-answer)/.test(s)) vfLogs.push(s); };
      let meta: Record<string, unknown> | null = null;
      try {
        meta = await analyzeConversation(Y, true, String(cc.status ?? "proposing"), null, "brain", {
          autoSendEnabled: false, customerName: "YUMA",
          prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
          prevAix: typeof prevDir?.suggested_aix_button === "string" ? prevDir.suggested_aix_button : null,
          mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
        }) as Record<string, unknown> | null;
      } finally { console.info = origInfo; }
      const b = meta ? { action: meta.action || null, check_pattern: meta.check_pattern ?? null, reply_mode: meta.reply_mode ?? null, two_choice_mode: meta.two_choice_mode ?? null, decision_source: meta.decision_source ?? null,
        button: meta.action ? aixButtonText(String(meta.action), (meta.check_pattern as string | null) ?? null) : null, note: meta.note ?? null, reply_direction: meta.reply_direction ?? null, reply_direction_label: meta.reply_direction_label ?? null,
        key_topics: meta.key_topics ?? null, avoid_topics: meta.avoid_topics ?? null, customer_questions: meta.customer_questions ?? null, next_steps: meta.next_steps ?? null, reason: meta.reason ?? null, analyzed_msg_ts: meta.analyzed_msg_ts ?? null } : null;
      rec.brain = b; rec.vfLogs = vfLogs;
      console.log("  ブレイン:", JSON.stringify(b, null, 1));
      for (const l of vfLogs) console.log("  ", l.slice(0, 600));
      const gens: unknown[] = [];
      for (let i = 0; i < sc.n; i++) {
        const t0 = new Date().toISOString();
        const { oldest: _o, ...gb } = body; void _o;
        const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...gb, shadowNoWrite: true, includeStopReason: true,
          brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: prevDir, brainAnalyzedAt: new Date().toISOString() } }) });
        const raw = await res.text(); const nl = raw.indexOf("\n");
        let head: unknown = null; try { head = JSON.parse(nl >= 0 ? raw.slice(0, nl) : raw); } catch { head = null; }
        const text = (nl >= 0 && head ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
        const tags = [...raw.matchAll(/<<<([A-Z_]{3,}):([\s\S]*?)>>>/g)].map((m) => `${m[1]}:${m[2].slice(0, 300)}`);
        await new Promise((r) => setTimeout(r, 2500));
        const { data: logs } = await sb.from("llm_usage_logs").select("action, model, env").eq("conversation_id", Y).gte("created_at", t0).order("created_at");
        const models = ((logs ?? []) as Array<Record<string, unknown>>).map((l) => `${l.action}:${l.model}(${l.env})`);
        const hits = CHECKS.filter(([, re]) => re.test(text)).map(([k]) => k);
        gens.push({ http: res.status, head, text, tags, models, hits });
        console.log(`  ── 下書き#${i + 1}（HTTP ${res.status}）当たり: ${hits.join(",") || "なし"}\n${text.split("\n").map((l) => "     " + l).join("\n")}\n     head=${JSON.stringify(head)?.slice(0, 300)}\n     tags=${tags.join(" | ").slice(0, 400)}\n     models=${models.join(" / ")}`);
      }
      rec.gens = gens;
    } catch (e) { rec.error = String(e); console.log("⚠", e); }
    finally { await drop(st); appendFileSync(LOG, JSON.stringify(rec) + "\n", "utf8"); }
  }
}

async function diff(doDelete: boolean) {
  const base = JSON.parse(readFileSync(SNAP, "utf8")) as Awaited<ReturnType<typeof takeSnap>>;
  const now = await takeSnap();
  let clean = true;
  for (const [t] of SIDE) {
    const b = base.side[t], n = now.side[t];
    if (!Array.isArray(b) || !Array.isArray(n)) { console.log(`  ${t.padEnd(28)} 読めない（前:${Array.isArray(b) ? "ok" : b} 今:${Array.isArray(n) ? "ok" : n}）`); continue; }
    const added = n.filter((x) => !b.includes(x)), gone = b.filter((x) => !n.includes(x));
    console.log(`  ${t.padEnd(28)} 前 ${b.length} 今 ${n.length} 増 ${added.length} 減 ${gone.length}`);
    if (added.length || gone.length) clean = false;
    if (added.length) {
      const { data } = await sb.from(t).select("*").in("id", added.slice(0, 50));
      for (const r of (data ?? []) as Array<Record<string, unknown>>) console.log("     +", JSON.stringify(r).slice(0, 260));
      if (doDelete && process.env.DELETE_TABLES?.split(",").includes(t)) { const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", added); console.log(`     → 消した ${error ? error.message : count}`); }
    }
  }
  const cDiff: string[] = [];
  for (const [k, v] of Object.entries((now.conv ?? {}) as Record<string, unknown>)) if (JSON.stringify(v) !== JSON.stringify((base.conv as Record<string, unknown>)[k])) cDiff.push(k);
  const pDiff: string[] = [];
  for (const [k, v] of Object.entries((now.pc ?? {}) as Record<string, unknown>)) if (JSON.stringify(v) !== JSON.stringify((base.pc as Record<string, unknown>)[k])) pDiff.push(k);
  console.log(`  conversations 変わった列: ${cDiff.join(", ") || "なし"}`);
  console.log(`  property_customers 変わった列: ${pDiff.join(", ") || "なし"}`);
  console.log(`  未処理 AIX要対応 前 ${base.pendingAix.length} 今 ${now.pendingAix.length}／開いているタスク 前 ${base.openTasks.length} 今 ${now.openTasks.length}／予約送信 前 ${base.scheduled.length} 今 ${now.scheduled.length}`);
  console.log(clean && !cDiff.length && !pDiff.length ? "  ＝写しと同じ" : "  ＝差あり（上を読む）");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "snap") await snap();
  else if (cmd === "run") await run(rest);
  else if (cmd === "cleanup") { await drop(loadSt()); await diff(true); }
  else if (cmd === "verify") await diff(false);
  else console.log("snap|run|cleanup|verify");
  setTimeout(() => process.exit(0), 800);
}
main().catch((e) => { console.error(e); process.exit(1); });
