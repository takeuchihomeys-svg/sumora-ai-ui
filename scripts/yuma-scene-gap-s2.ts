// 場面 S2（物件送付・オススメ後の反応: 費用の質問・写真の依頼・条件変更）を YUMA で測る
// 「ブレインごと1回（bg-async）＋生成側3回（generate-reply 直接）」の2段
//
// 2026-09-23 竹内「学んだことを活かして、実際の成約データや直近の今月のLINEをお手本にして
//   生成される文にギャップが生まれないか確認する」
//
// 【設計】（設計知見の2本は矛盾ではなく順番の話）
//   ・bg-async でブレインを新しくしてから **60秒以内** に generate-reply を画面と同じ body で直接叩く
//     （route.ts の stale rerun は brain が fresh でない＋60秒超の時だけ走る）→ 判断は写した場面の物のまま生成できる。
//   ・場面は想像で作らない。今月の実物（お客様の発言 id）を指定し、その発言までの直近20通を YUMA に写す。
//     created_at は「対象発言 = now−60秒」になるよう平行移動して間隔を保つ（返信の速さの材料が本番と同じ形）。
//   ・前提が作れたかを毎回3つで確かめる（最新発言・brain_analyzed_at・analyzed_msg_ts）。1つでも違えば「無効」。
//   ・YUMA に紐付く property_customers（条件）は元会話の物に一時的に差し替えて戻す。
//     ai_summary は「対象発言より前に作られた物」だけ渡す（後の要約は未来を漏らすので渡さない）。
//   ・⚠ 同じ時間帯に他の場面のエージェントも YUMA を使う。開始前に「3分間動きが無い」まで待ち、
//     自分の控え（scripts/.yuma-backup-s2.json）を取り、場面ごとに戻す。前提の3点が崩れた回は無効として数えない。
//
// ⚠ 書き込みは YUMA（dd34f5b0…）だけ。写した messages・aix_action_items・automation_commands は終了時に消し、
//   conversations と property_customers は控えから戻す。売上番長グループへの通知は .env.local に LINE 系が無いので出ない。
//
// 実行: dev サーバー（3000）が動いている状態で
//   npx tsx --env-file=.env.local scripts/yuma-scene-gap-s2.ts [REPS=3] [ONLY=A,B] [IDLE_SEC=180] [BASE_URL=...]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { MSG_SEP } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BACKUP = "scripts/.yuma-backup-s2.json";
const OUT_DIR = process.env.OUT_DIR ?? "scripts/.out";
const IDLE_SEC = Number(process.env.IDLE_SEC ?? 180);
const CONV_COLS = "id, customer_name, status, ai_draft, ai_draft_check, suggested_aix_meta, last_brain_meta, brain_analyzed_at, brain_strategy, draft_pending_at, draft_attempted_at, last_message, last_sender, updated_at";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Scene = {
  key: string; label: string; sub: "費用の質問" | "写真の依頼" | "条件変更";
  sourceConv: string; targetMsgId: string; statusAtTime: string;
  actual: { reply: string; aix: string; note?: string };
};
const SCENES: Scene[] = [
  {
    key: "A", label: "費用の質問（🌟物件カードの直後）・成約側", sub: "費用の質問",
    sourceConv: "749c5559-2715-4e55-85d2-0c0906cdf148", targetMsgId: "c336b752-e36c-4d2e-b7ad-5435f86f8feb", statusAtTime: "viewing",
    actual: { reply: "〈お客様〉さん\nお世話になっております！！\n初期費用確認出来次第、最大限割引させて頂いた御見積書お送りさせて頂きます😌！！", aix: "2時間後 AIX【見積書】→ 添え文「お気に召されましたらお申込みしお部屋抑えさせて頂きます」→ 申込へ", note: "AI 下書きはあった（T1・PS_QUESTION）。スタッフは「確認させて頂きます／とあわせてご連絡」を短く直した（似ている度0.65）" },
  },
  {
    key: "B", label: "写真の依頼（新着オススメの直後）・成約側", sub: "写真の依頼",
    sourceConv: "fb8ab8d5-5e2c-4fe5-8dc5-ad88a37c5cd3", targetMsgId: "67329fe3-e10a-44ea-8df1-af6b34eaa1c3", statusAtTime: "property_recommendation",
    actual: { reply: "（室内イメージ）\n〈URL〉\nこちら室内のイメージとなります！！\n築年数も10年以内の築浅物件ですので、内装、設備綺麗です😊！", aix: "3分後 AIX【物件確認した/室内イメージ】→ 2時間後 AIX【内覧のご案内】", note: "ブレインの判断は property_recommendation（実際に押されたのは物件確認した＝取り違え）" },
  },
  {
    key: "C", label: "条件変更（エリアの追加・同条件で再ピックアップ）", sub: "条件変更",
    sourceConv: "cd6e3d68-2725-4a11-9dba-e714a78f6a6f", targetMsgId: "cb12cf47-377b-4395-b0c4-0ab264f19d3d", statusAtTime: "property_recommendation",
    actual: { reply: "かしこまりました！！\n\n谷町線大日駅周辺全域から鉄骨造・水回りが綺麗な2LDK・3LDKのお部屋、〈お客様〉さんにオススメできるお部屋新着状況随時確認させて頂きオススメ出来るお部屋募集に出次第お送りさせて頂きます😊！！\n\n〈お客様〉さんにご満足頂けるお部屋が見つかるまで引き続き全力でサポートさせて頂きます！！", aix: "翌日 AIX【物件送付】（大日駅周辺でピックアップ）", note: "AI 下書きをそのまま送信（似ている度1.00）。ブレイン property_send・一致" },
  },
  {
    key: "D", label: "条件変更（他にないか＋初期費用の予算）", sub: "条件変更",
    sourceConv: "1191b1eb-12c6-44f9-805d-808132474592", targetMsgId: "5f52eca1-a0ef-40a2-a072-86c59c67dd7a", statusAtTime: "property_recommendation",
    actual: { reply: "かしこまりました！！\n\n新着で初期費用20万円以内でご入居可能なお部屋で次第随時お送りさせていただきます😊！！", aix: "AIX なし（12時間後にスタッフの手打ち）", note: "ブレイン property_send（AIX 誘導）・下書きなし" },
  },
];

type MsgRow = { id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };
type PcRow = Record<string, unknown>;
const PC_COLS = ["desired_area", "floor_plan", "rent_min", "rent_max", "walk_minutes", "move_in_time", "building_age", "preferences", "ng_points", "other_requests", "additional_conditions", "initial_cost_limit", "ai_summary", "ai_summary_at", "ai_summary_json"];

/** 画面の formatConditions と同じ形 */
function formatConditions(c: PcRow): string {
  const lines: string[] = [];
  if (c.desired_area) lines.push(`エリア: ${c.desired_area}`);
  if (c.floor_plan) lines.push(`間取り: ${c.floor_plan}`);
  const rent: string[] = [];
  if (c.rent_min) rent.push(`${Number(c.rent_min) / 10000}万円〜`);
  if (c.rent_max) rent.push(`${Number(c.rent_max) / 10000}万円以内`);
  if (rent.length) lines.push(`家賃: ${rent.join("")}`);
  if (c.walk_minutes) lines.push(`駅徒歩: ${c.walk_minutes}分以内`);
  if (c.move_in_time) lines.push(`入居: ${c.move_in_time}`);
  if (c.building_age) lines.push(`築年数: ${c.building_age}年以内`);
  if (c.preferences) lines.push(`希望: ${c.preferences}`);
  if (c.ng_points) lines.push(`NG: ${c.ng_points}`);
  if (c.other_requests) lines.push(`その他: ${c.other_requests}`);
  if (typeof c.additional_conditions === "string" && c.additional_conditions) {
    const clean = c.additional_conditions.split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
    if (clean) lines.push(`追加条件: ${clean}`);
  }
  return lines.join("\n");
}
function maskName(text: string, names: string[]): string {
  let t = text;
  for (const n of names) {
    if (!n) continue;
    t = t.split(n).join("YUMA");
    const noSpace = n.replace(/\s+/g, "");
    if (noSpace !== n) t = t.split(noSpace).join("YUMA");
  }
  return t;
}
const maskOut = (s: string) => s.replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\d{2,4}-\d{2,4}-\d{3,4}/g, "〈電話〉");

async function convRow() {
  const { data } = await sb.from("conversations").select(CONV_COLS).eq("id", YUMA).maybeSingle();
  return (data ?? {}) as Record<string, unknown>;
}
async function restoreConversation() {
  const b = JSON.parse(readFileSync(BACKUP, "utf8")) as Record<string, unknown>;
  const { id: _i, customer_name: _n, updated_at: _u, ...rest } = b; void _i; void _n; void _u;
  const { error } = await sb.from("conversations").update(rest).eq("id", YUMA);
  if (error) throw new Error(`restore 失敗: ${error.message}`);
}
/** 他のエージェントが YUMA を使っていないか（IDLE_SEC の間: 新しい messages なし・draft_attempted_at が古い・local の LLM 呼び出しなし） */
async function waitForIdle(maxWaitMs = 40 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const sinceIso = new Date(Date.now() - IDLE_SEC * 1000).toISOString();
    const [{ count: m }, { count: l }, row] = await Promise.all([
      sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).gte("created_at", sinceIso),
      sb.from("llm_usage_logs").select("id", { count: "exact", head: true }).eq("env", "local").gte("created_at", sinceIso),
      convRow(),
    ]);
    const attempted = Date.parse(String(row.draft_attempted_at ?? "")) || 0;
    const busy = (m ?? 0) > 0 || (l ?? 0) > 0 || attempted >= Date.now() - IDLE_SEC * 1000 || (row.ai_draft_check as Record<string, unknown> | null)?.owner === "scene-gap";
    if (!busy) return true;
    if (Date.now() - t0 > maxWaitMs) return false;
    console.log(`  … YUMA を他が使用中（messages ${m}・local LLM ${l}・attempted ${attempted ? new Date(attempted).toISOString().slice(11, 19) : "-"}）。${IDLE_SEC}秒静かになるまで待つ`);
    await sleep(30_000);
  }
}
async function waitForDraft(sinceMs: number, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const row = await convRow();
    const d = String(row.ai_draft ?? "");
    const analyzed = Date.parse(String(row.brain_analyzed_at ?? "")) || 0;
    if (d && d !== "__SHOWN__") return { row, draft: d, timedOut: false };
    if (analyzed >= sinceMs && !row.draft_attempted_at && Date.now() - t0 > 20_000) return { row, draft: "", timedOut: false };
  }
  const row = await convRow();
  return { row, draft: String(row.ai_draft ?? ""), timedOut: true };
}
type GenResult = { body: string; meta: string; finalCheck: string; suggestedAix: string; skipped: string; ms: number; sinceBrainMs: number };
async function generateDirect(body: Record<string, unknown>, sinceBrainMs: number): Promise<GenResult> {
  const t = Date.now();
  const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { body: "", meta: JSON.stringify(j), finalCheck: "", suggestedAix: "", skipped: String(j.skipped ? `skipped:${j.reason ?? ""}` : j.error ?? "json"), ms: Date.now() - t, sinceBrainMs };
  }
  const raw = await res.text();
  const nl = raw.indexOf("\n");
  const meta = nl >= 0 ? raw.slice(0, nl) : "";
  let text = nl >= 0 ? raw.slice(nl + 1) : raw;
  const pick = (tag: string) => { const m = text.match(new RegExp(`\\n?<<<${tag}:([\\s\\S]*?)>>>`)); return m ? m[1] : ""; };
  const finalCheck = pick("FINAL_CHECK"), suggestedAix = pick("SUGGESTED_AIX");
  text = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
  return { body: text, meta, finalCheck, suggestedAix, skipped: "", ms: Date.now() - t, sinceBrainMs };
}

async function main() {
  const reps = Number(process.env.REPS ?? 3);
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const scenes = SCENES.filter((s) => !only.length || only.includes(s.key));
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`=== S2 ／ ${scenes.length}場面 × (ブレイン1 + 生成${reps}) ／ BASE=${BASE} ===`);
  const idle = await waitForIdle();
  if (!idle) throw new Error("YUMA が空かない（他のエージェントが使用中）。後で再実行する");
  // 自分の控え（静かになった時点の状態）
  const base = await convRow();
  writeFileSync(BACKUP, JSON.stringify(base, null, 2), "utf8");
  const T0 = Date.now(); const T0iso = new Date(T0).toISOString();
  const yumaPcId = String(base.property_customer_id ?? "");
  const { data: yconv } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle();
  const pcId = String((yconv as Record<string, unknown> | null)?.property_customer_id ?? yumaPcId);
  const { data: ypc } = await sb.from("property_customers").select(PC_COLS.join(",")).eq("id", pcId).maybeSingle();
  const yumaPcBackup = (ypc ?? {}) as PcRow;
  writeFileSync(`${OUT_DIR}/.yuma-pc-backup-s2.json`, JSON.stringify(yumaPcBackup, null, 2), "utf8");
  console.log(`控え: status=${String(base.status)} ai_draft=${String(base.ai_draft ?? "").slice(0, 30).replace(/\n/g, " ")} ／ pc=${pcId} ／ T0=${T0iso}\n`);

  const results: Array<Record<string, unknown>> = [];
  for (const s of scenes) {
    console.log(`\n${"═".repeat(90)}\n【${s.key}】${s.label}`);
    const insertedIds: string[] = [];
    const sceneStart = Date.now();
    const rec: Record<string, unknown> = { key: s.key, label: s.label, sub: s.sub, sourceConv: s.sourceConv.slice(0, 8), targetMsgId: s.targetMsgId, statusAtTime: s.statusAtTime, actual: s.actual, sceneStart: new Date(sceneStart).toISOString() };
    try {
      await restoreConversation();
      const { data: srcConv } = await sb.from("conversations").select("customer_name, property_customer_id").eq("id", s.sourceConv).maybeSingle();
      const src = (srcConv ?? {}) as Record<string, unknown>;
      const srcPcId = String(src.property_customer_id ?? "");
      const { data: spc } = srcPcId ? await sb.from("property_customers").select(["customer_name", ...PC_COLS].join(",")).eq("id", srcPcId).maybeSingle() : { data: null };
      const srcPc = (spc ?? null) as PcRow | null;
      const names = [String(src.customer_name ?? ""), String(srcPc?.customer_name ?? "")].filter((n) => n && n !== "YUMA");
      const { data: tgt } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("id", s.targetMsgId).maybeSingle();
      if (!tgt) throw new Error("対象発言が無い");
      const target = tgt as MsgRow;
      const { data: hist } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated")
        .eq("conversation_id", s.sourceConv).lte("created_at", target.created_at).order("created_at", { ascending: false }).limit(20);
      const rows = ((hist ?? []) as MsgRow[]).reverse();
      if (rows[rows.length - 1]?.id !== target.id) throw new Error("直近20通の最後が対象発言ではない");
      const shift = (Date.now() - 60_000) - Date.parse(target.created_at);
      const idMap = new Map<string, string>();
      const toInsert = rows.map((m) => {
        const id = randomUUID(); idMap.set(m.id, id);
        return { id, conversation_id: YUMA, sender: m.sender, text: m.text == null ? null : maskName(m.text, names), image_url: m.image_url, created_at: new Date(Date.parse(m.created_at) + shift).toISOString(), is_aix_generated: !!m.is_aix_generated };
      });
      const targetNewId = idMap.get(target.id)!;
      const targetNewAt = toInsert[toInsert.length - 1].created_at;
      const ins = await sb.from("messages").insert(toInsert).select("id");
      if (ins.error) throw new Error(`写せない: ${ins.error.message}`);
      insertedIds.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
      rec.copied = toInsert.map((m) => ({ sender: m.sender, aix: m.is_aix_generated, at: m.created_at, text: maskOut((m.text ?? "").slice(0, 100)) }));
      if (srcPc && pcId) {
        const summaryOk = !!srcPc.ai_summary_at && Date.parse(String(srcPc.ai_summary_at)) <= Date.parse(target.created_at);
        const patch: PcRow = {};
        for (const k of PC_COLS) patch[k] = srcPc[k] ?? null;
        if (!summaryOk) { patch.ai_summary = null; patch.ai_summary_at = null; patch.ai_summary_json = null; }
        if (typeof patch.other_requests === "string") patch.other_requests = maskName(patch.other_requests as string, names);
        if (typeof patch.additional_conditions === "string") patch.additional_conditions = maskName(patch.additional_conditions as string, names);
        const up = await sb.from("property_customers").update(patch).eq("id", pcId);
        if (up.error) throw new Error(`pc 差し替え失敗: ${up.error.message}`);
        rec.pcSwapped = { summaryPassed: summaryOk, conditions: formatConditions(patch) };
      }
      const arm = await sb.from("conversations").update({
        status: s.statusAtTime, last_sender: "customer", ai_draft: null, ai_draft_check: { owner: "scene-gap", scene: `S2-${s.key}` },
        draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
        last_message: maskName((target.text ?? "").slice(0, 200), names),
      }).eq("id", YUMA);
      if (arm.error) throw new Error(`武装失敗: ${arm.error.message}`);
      const brainStart = Date.now();
      let skipped = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`${BASE}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: YUMA, source: "direct" }) });
          const j = (await res.json()) as Record<string, unknown>;
          skipped = String(j.skipped ?? "");
        } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
        if (skipped !== "in_progress") break;
        await sleep(20_000);
      }
      rec.bgSkipped = skipped;
      const w = skipped ? { row: await convRow(), draft: "", timedOut: false } : await waitForDraft(brainStart);
      const row = w.row;
      const meta = (row.suggested_aix_meta ?? null) as Record<string, unknown> | null;
      const { data: latest } = await sb.from("messages").select("id, created_at").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const analyzedAt = Date.parse(String(row.brain_analyzed_at ?? "")) || 0;
      const analyzedMsgTs = Date.parse(String(meta?.analyzed_msg_ts ?? "")) || 0;
      const premise = {
        latestIsTarget: (latest as Record<string, unknown> | null)?.id === targetNewId,
        brainRanAfterStart: analyzedAt >= brainStart - 1000,
        analyzedMsgIsTarget: Math.abs(analyzedMsgTs - Date.parse(targetNewAt)) < 2000,
        skipped, timedOut: w.timedOut,
      };
      const valid = premise.latestIsTarget && premise.brainRanAfterStart && premise.analyzedMsgIsTarget && !skipped;
      rec.premise = premise; rec.valid = valid;
      const { data: bdl } = await sb.from("brain_decision_logs").select("created_at, suggested_action, suggested_reply_mode, suggested_check_pattern, scene_evidence, analyzed_msg_ts, digest").eq("conversation_id", YUMA).gte("created_at", new Date(brainStart).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const log = (bdl ?? null) as Record<string, unknown> | null;
      const digest = (log?.digest ?? null) as Record<string, unknown> | null;
      const brain = {
        action: meta?.action ?? null, reply_mode: meta?.reply_mode ?? null, suggested_next_aix: row.suggested_next_aix ?? null,
        reply_direction: meta?.reply_direction ?? null, digest_dir: digest?.dir ?? null,
        pending_pickup: digest?.pending_pickup ?? meta?.pending_pickup ?? null, dropped_direction: digest?.dropped_direction ?? meta?.dropped_direction ?? null,
        scene_evidence: log?.scene_evidence ?? meta?.scene_evidence ?? null, decision_source: meta?.decision_source ?? null,
        log_action: log?.suggested_action ?? null, log_reply_mode: log?.suggested_reply_mode ?? null,
        customer_questions: meta?.customer_questions ?? null, avoid_topics: meta?.avoid_topics ?? null, next_steps: meta?.next_steps ?? null,
        key_topics: meta?.key_topics ?? null, action_ledger: meta?.action_ledger ?? null, draft_last_error: row.draft_last_error ?? null,
      };
      rec.brain = brain;
      const bgDraft = /^\s*\[(AIX誘導中|返信不要)\]\s*$/.test(w.draft) ? "" : w.draft;
      rec.bgDraftRaw = w.draft; rec.bgDraft = maskOut(bgDraft);
      rec.bgDraftCheck = row.ai_draft_check ?? null;
      console.log(`  前提: 最新=対象 ${premise.latestIsTarget} ／ ブレイン再実行 ${premise.brainRanAfterStart} ／ analyzed_msg=対象 ${premise.analyzedMsgIsTarget} ／ skipped=${skipped || "-"} ／ timeout=${w.timedOut} → ${valid ? "有効" : "⚠ 無効"}`);
      console.log(`  ブレイン: action=${String(brain.action)} reply_mode=${String(brain.reply_mode)} log=${String(brain.log_action)}/${String(brain.log_reply_mode)} src=${String(brain.decision_source)} scene=${String(brain.scene_evidence ?? "-").slice(0, 90)}`);
      console.log(`  方向: ${String(brain.reply_direction ?? brain.digest_dir ?? "-").slice(0, 140)}`);
      console.log(`  bg-async の下書き: ${w.draft ? maskOut(w.draft).replace(/\n/g, " / ").slice(0, 220) : "（なし）"}`);

      // 生成側（画面と同じ body）
      const { data: ymsgs } = await sb.from("messages").select("id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(60);
      const all = ((ymsgs ?? []) as MsgRow[]).reverse().map((m) => ({ id: m.id, sender: m.sender, text: m.text || (m.image_url ? "[画像]" : ""), imageUrl: m.image_url ?? undefined, rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated }));
      const lastStaffIdx = all.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
      const afterStaff = lastStaffIdx !== undefined ? all.slice(lastStaffIdx + 1) : all;
      const unreplied = afterStaff.filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10);
      const message = unreplied.map((m) => m.text).join(MSG_SEP);
      const last25 = all.slice(-25);
      const hasStaff = last25.some((m) => m.sender === "staff");
      const lastStaff = !hasStaff ? [...all].reverse().find((m) => m.sender === "staff") : undefined;
      const recentMessages = (lastStaff ? [lastStaff, ...last25] : last25).map((m) => ({ sender: m.sender, text: m.text, imageUrl: m.imageUrl, createdAt: m.rawCreatedAt, isAix: m.isAix }));
      const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
      const shortLines = lines.filter((l) => l.length <= 25);
      const COND = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
      const ACT = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
      const PICK = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
      let replyHint = "";
      const estProp = (() => { for (const m of all.filter((x) => x.sender === "staff").slice(-8).reverse()) { const mm = (m.text || "").match(/^【([^\s】]+)/); if (mm) return mm[1]; } return null; })();
      if (estProp) replyHint = `【見積書の物件名固定】直近に送った見積書の物件「${estProp}」を使うこと。会話に出てくる他の物件名は絶対に使わない`;
      if (shortLines.length >= 3) replyHint = (replyHint ? replyHint + "\n" : "") + `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}`;
      else if (lines.some((l) => COND.test(l) && ACT.test(l)) || lines.some((l) => PICK.test(l))) replyHint = (replyHint ? replyHint + "\n" : "") + `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${lines.join("・")}`;
      const pcForGen = (rec.pcSwapped ? (await sb.from("property_customers").select(PC_COLS.join(",")).eq("id", pcId).maybeSingle()).data : null) as PcRow | null;
      const body: Record<string, unknown> = {
        message, customerMessages: unreplied.map((m) => m.text), state: s.statusAtTime, conversationId: YUMA, customerName: "YUMA",
        customerConditions: pcForGen ? formatConditions(pcForGen) || undefined : undefined,
        customerSummary: pcForGen?.ai_summary ?? undefined,
        customerStructured: pcForGen ? { move_in_time: pcForGen.move_in_time ?? null, rent_max: pcForGen.rent_max ?? null, desired_area: pcForGen.desired_area ?? null, walk_minutes: pcForGen.walk_minutes ?? null, floor_plan: pcForGen.floor_plan ?? null, initial_cost_limit: pcForGen.initial_cost_limit ?? null, building_age: pcForGen.building_age ?? null, other_requests: pcForGen.other_requests ?? pcForGen.preferences ?? null } : undefined,
        replyHint: replyHint || undefined, hasViewed: false, activeTaskTypes: [], recentMessages,
      };
      rec.genBody = { message: maskOut(message), replyHint, state: s.statusAtTime, recentCount: recentMessages.length, hasConditions: !!body.customerConditions, hasSummary: !!body.customerSummary };
      const gens: GenResult[] = [];
      const directReps = bgDraft ? reps - 1 : reps;
      for (let k = 0; k < directReps; k++) {
        const g = await generateDirect(body, Date.now() - analyzedAt);
        gens.push(g);
        console.log(`  生成[${k + 1}]${g.sinceBrainMs > 60_000 ? "（⚠ ブレインから60秒超）" : ""} ${g.skipped ? `出なかった: ${g.skipped}` : maskOut(g.body).replace(/\n/g, " / ").slice(0, 240)}`);
      }
      rec.gens = gens.map((g) => ({ ...g, body: maskOut(g.body) }));
      const after = await convRow();
      rec.brainUnchangedAfterGen = Date.parse(String(after.brain_analyzed_at ?? "")) === analyzedAt;
      const { data: items } = await sb.from("aix_action_items").select("action, check_pattern, status, dismissed_reason").eq("conversation_id", YUMA).gte("created_at", new Date(sceneStart).toISOString());
      rec.aixItems = items ?? [];
      console.log(`  要対応: ${JSON.stringify(items ?? [])} ／ ブレイン不変=${rec.brainUnchangedAfterGen}`);
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      console.log(`  ⚠ ${rec.error}`);
    } finally {
      if (insertedIds.length) await sb.from("messages").delete().in("id", insertedIds);
      await sb.from("aix_action_items").delete().eq("conversation_id", YUMA).gte("created_at", new Date(sceneStart).toISOString());
      if (pcId) {
        const { data: cmds } = await sb.from("automation_commands").select("id, payload, customer_ids").gte("created_at", new Date(sceneStart).toISOString());
        const mine = ((cmds ?? []) as Array<{ id: string; payload: Record<string, unknown> | null; customer_ids: string[] | null }>)
          .filter((c) => (c.customer_ids ?? []).includes(pcId) && String(c.payload?.source ?? "") === "aix").map((c) => c.id);
        if (mine.length) { await sb.from("automation_commands").delete().in("id", mine); rec.deletedAutoCmds = mine.length; }
        const back: PcRow = {}; for (const k of PC_COLS) back[k] = yumaPcBackup[k] ?? null;
        await sb.from("property_customers").update(back).eq("id", pcId);
      }
      await restoreConversation();
      results.push(rec);
    }
  }
  const { data: usage } = await sb.from("llm_usage_logs").select("route, model, input_uncached, cache_read, cache_write, output_tokens").eq("env", "local").gte("created_at", T0iso);
  const u = (usage ?? []) as Array<{ route: string; model: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null }>;
  const byModel: Record<string, { calls: number; in: number; cr: number; cw: number; out: number }> = {};
  for (const r of u) { const k = `${r.model}`; byModel[k] ??= { calls: 0, in: 0, cr: 0, cw: 0, out: 0 }; byModel[k].calls++; byModel[k].in += r.input_uncached ?? 0; byModel[k].cr += r.cache_read ?? 0; byModel[k].cw += r.cache_write ?? 0; byModel[k].out += r.output_tokens ?? 0; }
  const out = { scene: "S2", T0: T0iso, reps, results, usage: byModel };
  const file = `${OUT_DIR}/yuma-scene-gap-S2-${T0iso.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log(`\n=== 費用（local・T0以降・他のエージェント分も混ざり得る） ===`);
  for (const [m, v] of Object.entries(byModel)) console.log(`  ${m.padEnd(36)} ${v.calls}回 in=${v.in} cache_read=${v.cr} cache_write=${v.cw} out=${v.out}`);
  console.log(`\n保存: ${file}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
