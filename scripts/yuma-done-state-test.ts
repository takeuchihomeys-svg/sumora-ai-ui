// YUMA で「済んだ事・もう言った約束・決まった内覧」（app/lib/done-state.ts）の前後を比べる
//
// 2026-09-26 竹内「ここの部分改善する根本的に」（3つの穴）:
//   (1) 約束の言い直し (2) 前に送った物の中身を知らない (3) お客様の返事を、こちらの問い・提案への答えとして読めない
//
// やること（場面ごと）:
//   ① YUMA の messages（と必要なら aix_usage_logs）に場面の発言を入れる（id を控え、終わったら必ず消す）
//   ② ブレインの判断を 前（HEAD の worktree）・後（作業コピー）で1回ずつ取る（analyzeConversation＝保存しない・Claude）
//   ③ 前の判断を conversations.suggested_aix_meta に置いて 前のサーバー（BEFORE_URL）で N 回、
//      後の判断を置いて 後のサーバー（AFTER_URL）で N 回、返信本文を生成する（DeepSeek・LLM_ALT_ACTIONS=reply_generate）
//   ④ 場面の発言を消す
// 最後に YUMA の副作用（conversations の列・knowledge_apply_log・reply_mode_shadow_logs・closing_strategy_logs・
//   brain_decision_logs・aix_action_items・line_tasks・aix_generate_log・ai_reply_knowledge.used_count の加算）を始める前に戻す。
//
// 前提:
//   ・前のサーバー: git worktree add --detach .claude/worktrees/tmp-fix-before HEAD（node_modules は junction・.env.local を複写）で next dev -p 3101
//   ・後のサーバー: 作業コピーで next dev -p 3100
//   ・どちらも LINE の鍵・グループID を無効な値、内部認証を起動時の乱数で起動する（売上番長グループに飛ばさない）
//   ・ブレインの判断は scripts/yuma-brain-decision.ts（保存しない）を各木で動かす（前の木には自動で複写）
// 実行: npx tsx --env-file=.env.local scripts/yuma-done-state-test.ts [S1 S2 ...]   （N=3・OUT=結果の JSON）
//        npx tsx --env-file=.env.local scripts/yuma-done-state-test.ts --cleanup    （途中で落ちた時の片付けだけ）
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const MAIN = process.cwd();
const BEFORE_DIR = join(MAIN, ".claude", "worktrees", "tmp-fix-before");
const BEFORE_URL = process.env.BEFORE_URL ?? "http://localhost:3101";
const AFTER_URL = process.env.AFTER_URL ?? "http://localhost:3100";
const N = Number(process.env.N ?? 3);
/** 前・後のどちらを回すか（既定は両方。直した後の確かめは SIDES=after）*/
const SIDES = (process.env.SIDES ?? "before,after").split(",");
const STATE = join(MAIN, "scripts", ".yuma-done-state.json");
const OUT = process.env.OUT ?? join(MAIN, "scripts", ".yuma-done-state-result.json");
const MSG_SEP = "\n⁣\n";

// ── 日付（JST）──
const JST = 9 * 3600_000;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function jstDay(offsetDays: number) {
  const d = new Date(Date.now() + JST + offsetDays * 86_400_000);
  return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, wd: WD[d.getUTCDay()] };
}
const D1 = jstDay(1), D2 = jstDay(2);

type SceneMsg = { s: "staff" | "customer"; text: string; min: number; aix?: { type: string; check_pattern?: string | null; prop_statuses?: string[]; property_names?: string[]; template_name?: string } };
type Scene = { id: string; hole: string; label: string; msgs: SceneMsg[]; bad: RegExp; good?: RegExp; note: string };

const SCENES: Scene[] = [
  {
    id: "S1", hole: "穴1", label: "見積書を待ちの形で約束した20分後の相槌",
    msgs: [
      { s: "customer", text: "テストハイツ梅田気になってます！初期費用ってどれくらいになりますか？", min: 70 },
      { s: "staff", text: "かしこまりました😊！！\nテストハイツ梅田 最大限割引しました初期費用の御見積書を作成出来次第お送りさせて頂きます！！", min: 20 },
      { s: "customer", text: "ありがとうございます！", min: 1 },
    ],
    bad: /作成(?:出来|でき)次第|ご査収|作成しお送り|御見積書を[^。！!\n]{0,20}お送り/, note: "20分前の見積の約束・まだ送っていない物への「ご査収」を書き直さない",
  },
  {
    id: "S2", hole: "穴1", label: "管理会社への確認を待ちの形で約束した20分後の相槌",
    msgs: [
      { s: "customer", text: "テストハイツ梅田って駐車場空いてますか？", min: 40 },
      { s: "staff", text: "かしこまりました😊！！\nテストハイツ梅田の駐車場の空き状況管理会社に確認出来次第ご連絡させて頂きます！！", min: 20 },
      { s: "customer", text: "ありがとうございます😊よろしくお願いします！", min: 1 },
    ],
    bad: /確認(?:出来|でき)次第|確認させて|確認し(?:て)?ご連絡|分かり次第/, note: "20分前の確認の約束を言い直さない",
  },
  {
    id: "S3", hole: "穴2", label: "AIX 物件確認した（募集中1・募集終了1）の3分後の連投",
    msgs: [
      { s: "customer", text: "テストハイツ梅田とサンプルコート中津って今も空いてますか？", min: 15 },
      { s: "staff", text: "YUMAさんお送りいただきました物件の中で\nテストハイツ梅田 302号室現在募集中となります！！\n\nYUMAさんお送りいただきました他1件は\n募集終了しておりました😢", min: 3,
        aix: { type: "property_check_result", check_pattern: "available", prop_statuses: ["available", "unavailable"], property_names: ["テストハイツ梅田 302号室", "サンプルコート中津 205号室"], template_name: "内覧誘導" } },
    ],
    bad: /(?:募集状況|空き状況|空室)[^。！!\n]{0,12}確認|確認させて|確認(?:出来|でき)次第|確認し(?:て)?ご連絡/, note: "報告済みの物件を「確認します」と約束しない",
  },
  {
    id: "S4", hole: "穴2", label: "募集中を全て送った後の「見てみます」",
    msgs: [
      { s: "customer", text: "梅田周辺で1Kの物件他にもありますか？", min: 60 },
      { s: "staff", text: "YUMAさんのご条件に合うお部屋で現在募集中のものは全てお送りさせて頂きました！！\n🌟テストハイツ梅田 302号室\n家賃62,000円・梅田駅徒歩8分\n\n🌟サンプルコート中津 205号室\n家賃58,000円・中津駅徒歩4分", min: 12 },
      { s: "customer", text: "ありがとうございます！見てみます！", min: 1 },
    ],
    bad: /ピックアップ(?:出来|でき)次第|改めて[^。！!\n]{0,10}ピックアップ|ピックアップさせて/, note: "全て送った後に改めてピックアップすると書かない（今回は直していない・観察）",
  },
  {
    id: "S5", hole: "穴3", label: `こちらが ${D2.md}(${D2.wd})16:00 を1つ打診 →「はい！大丈夫です！」`,
    msgs: [
      { s: "customer", text: "テストハイツ梅田内覧したいです！", min: 120 },
      { s: "staff", text: `かしこまりました😊！！\n${D2.md}(${D2.wd})16:00よりご案内可能ですが、ご都合如何でしょうか？`, min: 30 },
      { s: "customer", text: "はい！大丈夫です！", min: 1 },
    ],
    bad: /ご都合(?:の)?よろしいお日にち|詳細[^。！!\n]{0,12}ご連絡|改めてご連絡/, good: new RegExp(`${D2.md.replace("/", "\\/")}|${D2.md.split("/")[1]}日|${D2.wd}曜|16[:時]`),
    note: "提案した日時への受諾を日程調整に戻さない（決まった日時で受ける）",
  },
  {
    id: "S6", hole: "穴3", label: "AIX 待ち合わせ（明日13:00）の後の「よろしくお願いします！」",
    msgs: [
      { s: "customer", text: "明日の13時で内覧お願いします！", min: 180 },
      { s: "staff", text: `かしこまりました！！\n${D1.md}（${D1.wd}）ご案内させて頂きます！！\n\n${D1.md} 13:00にテストハイツ梅田 302号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市北区テスト町1丁目2-3`, min: 120,
        aix: { type: "meeting_place", template_name: "待ち合わせ" } },
      { s: "customer", text: "よろしくお願いします！", min: 1 },
    ],
    bad: /ご都合(?:の)?よろしいお日にち|詳細[^。！!\n]{0,12}ご連絡|改めてご連絡/, good: /明日/, note: "決まった内覧を未定に戻さない",
  },
  {
    id: "S7", hole: "穴3", label: "「どちらのお部屋をご内覧」の問いの後に別の質問（未回答の問い）",
    msgs: [
      { s: "customer", text: "テストハイツ梅田とサンプルコート中津内覧したいです！", min: 60 },
      { s: "staff", text: "かしこまりました😊！！\nテストハイツ梅田とサンプルコート中津どちらのお部屋もご内覧されますでしょうか？", min: 30 },
      { s: "customer", text: "ちなみに駐車場ってありますか？", min: 1 },
    ],
    bad: /ご都合(?:の)?よろしいお日にち/, good: /どちら|両方|2件|お部屋も/, note: "未回答の問いを引き継ぐか（今回は直していない・観察）",
  },
];

// 下書き全体で見る物（場面によらず）
const GLOBAL_BAD: Array<[string, RegExp]> = [
  ["お待たせ", /お待たせ/],
  ["作業メモ", /【[^】]*(?:注記|決定論|台帳|ブレイン|AIX)[^】]*】|※|WE DO|AIX|<<<|>>>/],
];

type State = { t0: string; conv: Record<string, unknown>; bdl: Array<{ id: string; body_block_code: unknown }>; msgIds: string[]; aixIds: string[] };
const loadState = (): State | null => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : null);
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2), "utf8");

async function begin(): Promise<State> {
  const { data: conv } = await sb.from("conversations").select("*").eq("id", Y).maybeSingle();
  const { data: bdl } = await sb.from("brain_decision_logs").select("id, body_block_code").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(20);
  const s: State = { t0: new Date().toISOString(), conv: (conv ?? {}) as Record<string, unknown>, bdl: (bdl ?? []) as State["bdl"], msgIds: [], aixIds: [] };
  saveState(s);
  // 本番の brain-sweep（suggested_aix_meta IS NULL かつ last_sender=customer）に拾われないよう、場面の間は判断の置き場を空にしない
  await sb.from("conversations").update({ suggested_aix_meta: { action: "", reply_mode: "auto_reply", source: "cached", enforcement_level: "optional", analyzed_msg_ts: null } }).eq("id", Y);
  return s;
}

async function dropSceneRows(s: State) {
  if (s.msgIds.length) {
    const { error } = await sb.from("messages").delete().in("id", s.msgIds);
    if (error) console.log(`⚠ messages を消せない: ${error.message}`); else s.msgIds = [];
  }
  if (s.aixIds.length) {
    const { error } = await sb.from("aix_usage_logs").delete().in("id", s.aixIds);
    if (error) console.log(`⚠ aix_usage_logs を消せない: ${error.message}`); else s.aixIds = [];
  }
  saveState(s);
}

async function cleanup(s: State) {
  await dropSceneRows(s);
  const t0 = s.t0;
  // knowledge_apply_log → ai_reply_knowledge.used_count の加算を戻す（generate-reply の incrementKnowledgeUsage と同じ件数）
  const { data: kal } = await sb.from("knowledge_apply_log").select("id, knowledge_id").eq("conversation_id", Y).gte("applied_at", t0);
  const kc = new Map<string, number>();
  for (const r of (kal ?? []) as Array<{ knowledge_id: string | null }>) if (r.knowledge_id) kc.set(r.knowledge_id, (kc.get(r.knowledge_id) ?? 0) + 1);
  let dec = 0;
  for (const [id, n] of kc) {
    const { data: k } = await sb.from("ai_reply_knowledge").select("used_count").eq("id", id).maybeSingle();
    const cur = Number((k as { used_count?: number } | null)?.used_count ?? 0);
    const { error } = await sb.from("ai_reply_knowledge").update({ used_count: Math.max(0, cur - n) }).eq("id", id);
    if (!error) dec += n;
  }
  const del = async (table: string, col: string) => {
    const { count, error } = await sb.from(table).delete({ count: "exact" }).eq("conversation_id", Y).gte(col, t0);
    console.log(`  ${table.padEnd(24)} ${error ? `⚠ ${error.message}` : `${count ?? 0}行消した`}`);
  };
  console.log("── 片付け ──");
  console.log(`  ai_reply_knowledge.used_count  ${kc.size}件で合計 ${dec} 戻した`);
  await del("knowledge_apply_log", "applied_at");
  await del("reply_mode_shadow_logs", "created_at");
  await del("closing_strategy_logs", "proposed_at");
  await del("brain_decision_logs", "created_at");
  await del("aix_action_items", "created_at");
  await del("line_tasks", "created_at");
  await del("aix_generate_log", "created_at");
  for (const r of s.bdl) await sb.from("brain_decision_logs").update({ body_block_code: r.body_block_code }).eq("id", r.id);
  // conversations: 変わった列だけ元に戻す（updated_at は戻さない）
  const { data: now } = await sb.from("conversations").select("*").eq("id", Y).maybeSingle();
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((now ?? {}) as Record<string, unknown>)) {
    if (k === "updated_at" || k === "id") continue;
    if (JSON.stringify(v) !== JSON.stringify(s.conv[k])) patch[k] = s.conv[k] ?? null;
  }
  if (Object.keys(patch).length) {
    const { error } = await sb.from("conversations").update(patch).eq("id", Y);
    console.log(`  conversations            ${error ? `⚠ ${error.message}` : `戻した列: ${Object.keys(patch).join(", ")}`}`);
  } else console.log("  conversations            変わった列なし");
  const { count: left } = await sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", Y).gte("created_at", new Date(Date.now() - 4 * 3600_000).toISOString()).like("text", "%テストハイツ%");
  console.log(`  場面の発言の残り         ${left ?? 0}`);
  unlinkSync(STATE);
}

async function insertScene(s: State, sc: Scene) {
  const now = Date.now();
  for (const m of sc.msgs) {
    const at = new Date(now - m.min * 60_000).toISOString();
    const { data, error } = await sb.from("messages").insert({ conversation_id: Y, sender: m.s, text: m.text, created_at: at, is_aix_generated: !!m.aix }).select("id").single();
    if (error) throw new Error(`messages insert: ${error.message}`);
    s.msgIds.push((data as { id: string }).id); saveState(s);
    if (m.aix) {
      const { data: a, error: e2 } = await sb.from("aix_usage_logs").insert({
        conversation_id: Y, aix_type: m.aix.type, check_pattern: m.aix.check_pattern ?? null, prop_statuses: m.aix.prop_statuses ?? null,
        property_names: m.aix.property_names ?? null, template_name: m.aix.template_name ?? null, generated_text: m.text, sent_at: at, created_at: at,
        conversation_status: "proposing",
      }).select("id").single();
      if (e2) throw new Error(`aix_usage_logs insert: ${e2.message}`);
      s.aixIds.push((a as { id: string }).id); saveState(s);
    }
  }
}

function runBrain(dir: string, out: string): Record<string, unknown> | null {
  // 前の木（HEAD の worktree）には無いので複写する（worktree ごと消えるので作業コピーは汚れない）
  const runner = join(dir, "scripts", "yuma-brain-decision.ts");
  // 2026-09-26: 使い回し（BRAIN_CACHE_LABEL）を読めるよう、前の木にある古い版も作業コピーの版で上書きする
  const runnerSrc = readFileSync(join(MAIN, "scripts", "yuma-brain-decision.ts"), "utf8");
  if (!existsSync(runner) || readFileSync(runner, "utf8") !== runnerSrc) writeFileSync(runner, runnerSrc, "utf8");
  // 2026-09-26 テストの3段の②: ブレインは場面ごとに Claude で1回取って使い回す（BRAIN_REUSE=0 で毎回取る・BRAIN_REFRESH=1 で取り直す）。
  //   使い回しの名前に「その木のブレインのコード（brain-core.ts）の中身のハッシュ」を入れる＝ブレインを直したら自動で取り直しになる
  const reuse = process.env.BRAIN_REUSE !== "0";
  const brainSrc = join(dir, "app", "lib", "brain-core.ts");
  const codeHash = existsSync(brainSrc) ? createHash("sha1").update(readFileSync(brainSrc)).digest("hex").slice(0, 8) : "nocode";
  const env = reuse
    ? { ...process.env, BRAIN_CACHE_LABEL: `${dir.includes("tmp-fix-before") ? "before" : "after"}-${codeHash}`, BRAIN_CACHE_DIR: join(MAIN, "scripts", ".brain-cache") }
    : process.env;
  const r = spawnSync(`npx tsx --env-file=.env.local scripts/yuma-brain-decision.ts "${out}"`, { cwd: dir, shell: true, encoding: "utf8", timeout: 240_000, env });
  if (reuse && /brain reused/.test(r.stdout ?? "")) console.log(`  （ブレイン ${dir.includes("tmp-fix-before") ? "前" : "後"}: 保存した判断を使い回し＝Claude を呼んでいない）`);
  if (r.status !== 0) { console.log(`⚠ brain (${dir.includes("tmp-fix-before") ? "前" : "後"}) 失敗: ${(r.stderr ?? "").slice(-400)}`); return null; }
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> | null;
}

async function buildBody() {
  const { data: conv } = await sb.from("conversations").select("customer_name, status, has_viewed").eq("id", Y).maybeSingle();
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(60);
  const all = ((ms ?? []) as Array<Record<string, unknown>>).reverse();
  // page.tsx generateReply と同じ組み立て
  const lastStaffIdx = all.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
  const after = lastStaffIdx !== undefined ? all.slice(lastStaffIdx + 1) : all;
  const unreplied = after.filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10).map((m) => String(m.text));
  const lastCust = [...all].reverse().find((m) => m.sender === "customer");
  const message = unreplied.length ? unreplied.join(MSG_SEP) : String(lastCust?.text ?? "");
  const last25 = all.slice(-25);
  const c = (conv ?? {}) as Record<string, unknown>;
  return {
    message, customerMessages: unreplied.length ? unreplied : [message], state: String(c.status ?? "proposing"), conversationId: Y,
    customerName: String(c.customer_name ?? "YUMA"), hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
    recentMessages: last25.map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated })),
  };
}

async function generate(url: string, body: unknown) {
  const t0 = Date.now();
  const res = await fetch(`${url}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  const nl = raw.indexOf("\n");
  let meta: Record<string, unknown> | null = null; let text = raw;
  if (nl >= 0) { try { meta = JSON.parse(raw.slice(0, nl)); text = raw.slice(nl + 1); } catch { meta = null; } }
  const aixM = text.match(/<<<SUGGESTED_AIX:([\s\S]*?)>>>/);
  let aix: string | null = null;
  if (aixM) { try { const j = JSON.parse(aixM[1]) as Record<string, unknown>; aix = String(j.action ?? j.aix ?? "") || null; } catch { aix = "?"; } }
  const visible = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
  return { status: res.status, ms: Date.now() - t0, text: visible, aix, metaOk: meta?.ok ?? null, metaReason: meta?.reason ?? null };
}

async function main() {
  const args = process.argv.slice(2);
  const leftover = loadState();
  if (args.includes("--cleanup")) { if (leftover) await cleanup(leftover); else console.log("控えが無い（片付け済み）"); return; }
  if (leftover) { console.log("前回の控えが残っている → 先に片付ける"); await cleanup(leftover); }
  const only = args.filter((a) => /^S\d+$/.test(a));
  const scenes = only.length ? SCENES.filter((s) => only.includes(s.id)) : SCENES;
  for (const u of [BEFORE_URL, AFTER_URL]) {
    const ok = await fetch(u).then(() => true, () => false);
    if (!ok) { console.log(`⚠ サーバーが無い: ${u}`); return; }
  }
  const results: unknown[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as unknown[]) : [];
  const s = await begin();
  try {
    for (const sc of scenes) {
      console.log(`\n${"═".repeat(72)}\n【${sc.id} ${sc.hole}】${sc.label}\n  見る所: ${sc.note}`);
      await insertScene(s, sc);
      // 発言を入れても会話の last_sender が変わらない（本番の cron が拾わない）ことを確かめてから進む
      const { data: ls } = await sb.from("conversations").select("last_sender").eq("id", Y).maybeSingle();
      if ((ls as { last_sender?: string } | null)?.last_sender !== s.conv.last_sender) throw new Error("last_sender が変わった（cron が拾う恐れ）→ 止める");
      const tmpB = join(MAIN, "scripts", `.tmp-fix-brain-before-${sc.id}.json`), tmpA = join(MAIN, "scripts", `.tmp-fix-brain-after-${sc.id}.json`);
      const metaB = SIDES.includes("before") ? runBrain(BEFORE_DIR, tmpB) : null;
      const metaA = runBrain(MAIN, tmpA);
      for (const f of [tmpB, tmpA]) if (existsSync(f)) unlinkSync(f);
      const brainOf = (m: Record<string, unknown> | null) => m ? { action: m.action || null, check_pattern: m.check_pattern ?? null, reply_mode: m.reply_mode ?? null, reply_direction: String(m.reply_direction ?? "").slice(0, 160) } : null;
      console.log(`  ブレイン 前: ${JSON.stringify(brainOf(metaB))}\n  ブレイン 後: ${JSON.stringify(brainOf(metaA))}`);
      const sceneRes: Record<string, unknown> = { id: sc.id, hole: sc.hole, label: sc.label, brain: { before: brainOf(metaB), after: brainOf(metaA) }, gens: { before: [], after: [] } };
      for (const [side, url, meta] of ([["before", BEFORE_URL, metaB], ["after", AFTER_URL, metaA]] as const).filter(([sd]) => SIDES.includes(sd))) {
        await sb.from("conversations").update({ suggested_aix_meta: meta, brain_analyzed_at: new Date().toISOString(), ai_draft: null, draft_pending_at: null }).eq("id", Y);
        const body = await buildBody();
        for (let i = 0; i < N; i++) {
          const g = await generate(url, body);
          const bad = sc.bad.test(g.text);
          const good = sc.good ? sc.good.test(g.text) : null;
          const gl = GLOBAL_BAD.filter(([, re]) => re.test(g.text)).map(([k]) => k);
          (sceneRes.gens as Record<string, unknown[]>)[side].push({ ...g, bad, good, global: gl });
          console.log(`  ── ${side === "before" ? "前" : "後"}#${i + 1} (${(g.ms / 1000).toFixed(1)}s) ${bad ? "✗言い直し型あり" : "○"}${good === null ? "" : good ? "・決まった日時あり" : "・日時なし"}${gl.length ? ` ⚠${gl.join(",")}` : ""} AIX=${g.aix ?? "なし"}${g.metaOk === false ? ` meta=${g.metaReason}` : ""}\n     ${g.text.replace(/\n/g, " ／ ")}`);
        }
      }
      results.push(sceneRes);
      writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
      await dropSceneRows(s);
    }
  } finally {
    await cleanup(s);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
