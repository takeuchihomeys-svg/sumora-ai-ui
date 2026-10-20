// scripts/exam-question-candidates.ts — 本番の外れから試験の問題の「候補」を作る（候補だけ・spec.json に足さない・LLM なし・本番 DB は読むだけ）
//
// 2026-10-20 竹内さん（試験のブレインを最優先で改善する・QUALITY⑦）。決め方は scripts/lib/exam-question-candidates.ts（単体テストあり）。
//   源: ①見張り line_watch_turns の道の外れ（app/lib/brain-judge-examples.PATH_MISS_REASONS）②大きく直された番（edited-turn-miner の exam-batch.json・一番新しい日）
//       ③下書きと実送信の直しの型（app/lib/draft-diff-types.ts）＝まだ main に無い → 入ったら足す（今は無いと出す）
//   外す: テストの会話・申込以降（場面の対象外・申込フォームの後）・申込の書類や個人の値が伏せた後も残る番・もう試験に入っている番（同じ会話の6時間以内）
//   正解の道: 見張りは「返事のまとまりで押した AIX が1種類」の番だけ決まる（brain-exam-watch.autoAnswerOf）。他は「人が決める事」に書く
// 実行: npx tsx --env-file=.env.local scripts/exam-question-candidates.ts [--days=2] [--max=20]
// 置き場: <倉庫の根>/.claude/exam-cache/exam-brain/question-candidates/<日付>.json・.md（伏せた文だけ・会話 id は手元だけ）
//   足す時（人が読んでから）: 出した add-batch の JSON から要る物だけ残して npx tsx --env-file=.env.local scripts/brain-exam-add.ts --add-batch=<file>
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestConversation } from "../app/lib/test-conversations";
import { APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { PATH_MISS_REASONS } from "../app/lib/brain-judge-examples";
import { maskExamText } from "./lib/brain-exam-mask";
import { autoAnswerOf } from "./lib/brain-exam-watch";
import { examCacheRoot } from "./lib/llm-cassette";
import { EXAM_BRAIN_DIR, SPEC_FILE } from "./lib/exam-brain-io";
import { piiGate, dedupeCandidates, rankCandidates, toAddBatch, type QCand } from "./lib/exam-question-candidates";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Math.max(1, Number(arg("days", "2")) || 2);
const MAX = Math.max(1, Number(arg("max", "20")) || 20);
const OUT_DIR = join(EXAM_BRAIN_DIR, "question-candidates");
const P = (s: string) => Date.parse(s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const gate = { piiValueSignal, applicationMaterialReason };

type Row = { conversation_id: string; customer_turn_at: string; customer_last_at: string | null; brain_action: string | null; brain_reply_mode: string | null; brain_check_pattern: string | null; scene_key: string | null; verdict_detail: Record<string, unknown> | null; staff_aix: Array<{ aix_type: string; check_pattern: string | null; at: string; burst: boolean }> | null; staff_texts: Array<{ at: string; burst: boolean; text: string }> | null };
type Msg = { sender: string; text: string | null; created_at: string; staff_writer?: string | null };

(async () => {
  const skip: Record<string, number> = {};
  const sk = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  const cands: QCand[] = [];
  // ① 見張りの道の外れ
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, brain_action, brain_reply_mode, brain_check_pattern, scene_key, verdict_detail, staff_aix, staff_texts")
    .gte("customer_turn_at", since).eq("verdict", "different").order("customer_turn_at", { ascending: false }).limit(2000);
  if (error) throw new Error(`line_watch_turns が読めない: ${error.message}`);
  for (const r of (data ?? []) as Row[]) {
    const reason = String(r.verdict_detail?.reason ?? "");
    if (!PATH_MISS_REASONS.has(reason)) { sk("見張り: 道の外れでない"); continue; }
    if (isTestConversation(r.conversation_id)) { sk("テスト会話"); continue; }
    if (String(r.scene_key ?? "").startsWith("対象外")) { sk("申込以降"); continue; }
    const custLast = r.customer_last_at ?? r.customer_turn_at;
    const { data: mm } = await sb.from("messages").select("sender, text, created_at, staff_writer").eq("conversation_id", r.conversation_id).lte("created_at", new Date(P(custLast) + 3 * 3600_000).toISOString()).order("created_at", { ascending: false }).limit(60);
    const msgs = ((mm ?? []) as Msg[]).reverse();
    const before = msgs.filter((m) => P(m.created_at) <= P(custLast));
    if (before.some((m) => m.sender !== "customer" && APPLY_FORM_RE.test(m.text ?? ""))) { sk("申込以降（申込フォームの後）"); continue; }
    const cust = before.filter((m) => m.sender === "customer" && P(m.created_at) >= P(r.customer_turn_at));
    const burst = (r.staff_texts ?? []).filter((x) => x.burst).map((x) => x.text);
    const after = msgs.filter((m) => P(m.created_at) > P(custLast) && m.sender !== "customer");
    const writers = new Set(after.map((m) => m.staff_writer).filter(Boolean));
    const writer = writers.has("employee") ? "employee" : writers.has("takeuchi") ? "takeuchi" : String(r.verdict_detail?.staff_writer ?? "unknown");
    const customer = oneLine(maskExamText(cust.map((m) => m.text ?? "").join("\n"), null)).slice(0, 200);
    const staff = oneLine(maskExamText(burst.join("\n―\n"), null)).slice(0, 300);
    // 生の文で申込の書類を見て、伏せた後の文で個人の値を見る（両方とも通らない番は出さない）
    const g = piiGate([...cust.map((m) => m.text ?? ""), ...burst], { piiValueSignal: () => null, applicationMaterialReason }) ?? piiGate([customer, staff], gate);
    if (g) { sk(`個人情報の網: ${g.replace(/（.*$/, "")}`); continue; }
    const brain = r.brain_reply_mode === "aix" ? `AIX:${r.brain_action ?? "?"}${r.brain_check_pattern ? `/${r.brain_check_pattern}` : ""}` : "返信";
    const pressed = (r.staff_aix ?? []).map((p) => `${p.aix_type}${p.check_pattern ? `/${p.check_pattern}` : ""}${p.burst ? "" : "(後)"}`);
    const ans = writer === "employee" ? null : autoAnswerOf(r);
    cands.push({ source: "見張り", conv: r.conversation_id, at: cust[cust.length - 1]?.created_at ?? custLast, type: ans?.type ?? "返信かAIXか", tags: ["見張り", reason], accept: ans?.accept ?? [], mustNot: ans?.mustNot ?? [brain],
      customer, staff, writer, why: `見張りの道の外れ（${reason}・ブレイン ${brain} → スタッフ ${pressed.join(",") || "手打ち"}）`,
      needs: ans ? ["依頼（asks）の要点"] : ["正解の道（会話を読んで決める）", "依頼（asks）の要点"] });
  }
  // ② 大きく直された番（edited-turn-miner の一番新しい日の exam-batch.json）
  const etDir = join(examCacheRoot(), "edited-turns");
  const etDay = existsSync(etDir) ? readdirSync(etDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() : undefined;
  let etNote = "edited-turn-miner の出力なし（npx tsx --env-file=.env.local scripts/edited-turn-miner.ts で作る）";
  if (etDay && existsSync(join(etDir, etDay, "exam-batch.json"))) {
    const xs = JSON.parse(readFileSync(join(etDir, etDay, "exam-batch.json"), "utf8")) as Array<{ type: string; tags: string[]; conv: string; at: string; accept: string[]; mustNot: string[]; asks?: QCand["asks"]; ng?: string[]; why: string; stage?: "brain" | "draft" }>;
    const old = Date.now() - Date.parse(`${etDay}T00:00:00+09:00`) > (DAYS + 7) * 86_400_000;
    etNote = `edited-turn-miner ${etDay}（${xs.length}件${old ? "・古い＝作り直すと新しい番が入る" : ""}）`;
    for (const x of xs) {
      const texts = [...(x.asks ?? []).flatMap((a) => [a.q, a.point]), ...(x.ng ?? [])];
      const g = piiGate(texts, gate);
      if (g) { sk(`個人情報の網: ${g.replace(/（.*$/, "")}`); continue; }
      cands.push({ source: "直された番", conv: x.conv, at: x.at, type: x.type, tags: x.tags ?? [], accept: x.accept ?? [], mustNot: x.mustNot ?? [], customer: oneLine((x.asks ?? []).map((a) => a.q).join(" ／ ")).slice(0, 200), staff: oneLine((x.asks ?? []).map((a) => a.point).join(" ／ ")).slice(0, 300), writer: "takeuchi", why: x.why, needs: [], asks: x.asks, ng: x.ng, stage: x.stage });
    }
  }
  // ③ 直しの型（draft-diff-types）: まだ main に無い
  const dtNote = existsSync("app/lib/draft-diff-types.ts") ? "app/lib/draft-diff-types.ts はあるが、この候補作りにはまだつないでいない（次の直し）" : "app/lib/draft-diff-types.ts は main にまだ無い（入ったら直しの型ごとの候補を足す）";
  // もう入っている番・重なりを外して並べる
  const spec = (existsSync(SPEC_FILE) ? JSON.parse(readFileSync(SPEC_FILE, "utf8")) : []) as Array<{ conv?: string; at?: string; type?: string }>;
  const d = dedupeCandidates(cands, spec);
  for (const x of d.dropped) sk(x.why);
  const typeCount: Record<string, number> = {};
  for (const s of spec) typeCount[String(s.type ?? "")] = (typeCount[String(s.type ?? "")] ?? 0) + 1;
  const ranked = rankCandidates(d.keep, { typeCount }).slice(0, MAX);
  const jst = new Date(Date.now() + 9 * 3600_000).toISOString();
  const L = [`# 試験の問題の候補（本番の外れから・${jst.slice(0, 16).replace("T", " ")} JST・直近 ${DAYS}日）`, "", `源: 見張り ${cands.filter((c) => c.source === "見張り").length}・${etNote}・${dtNote}`,
    `外した: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join("・") || "0"}`, `候補 ${d.keep.length}（上位 ${ranked.length} を出す）。spec.json には足していない＝人が読んで足す`, ""];
  for (const [i, c] of ranked.entries()) {
    L.push(`## ${i + 1}. [${c.source}] ${c.type}・${c.conv.slice(0, 8)} ${c.at.slice(0, 16)}（点 ${c.score}: ${c.rankWhy.join("・") || "-"}）`);
    L.push(`- 正解の道: ${c.accept.join(" | ") || "（未定）"}／言ってはいけない道: ${c.mustNot.join(" | ") || "-"}`);
    L.push(`- 客「${c.customer.slice(0, 120)}」`, `- 人「${c.staff.slice(0, 160)}」`, `- 理由: ${c.why}`);
    if (c.needs.length) L.push(`- 人が決める事: ${c.needs.join("・")}`);
    L.push("");
  }
  console.log(L.join("\n"));
  mkdirSync(OUT_DIR, { recursive: true });
  const day = jst.slice(0, 10);
  writeFileSync(join(OUT_DIR, `${day}.md`), L.join("\n"));
  writeFileSync(join(OUT_DIR, `${day}.json`), JSON.stringify({ builtAt: new Date().toISOString(), days: DAYS, skip, candidates: ranked }, null, 1));
  // 足せる形（正解の道が決まっている物だけ・人が読んでから --add-batch に渡す）
  const ready = ranked.filter((c) => c.accept.length);
  writeFileSync(join(OUT_DIR, `${day}.add-batch.json`), JSON.stringify(ready.map(toAddBatch), null, 1));
  console.log(`\n保存: ${join(OUT_DIR, `${day}.md`)}・.json・.add-batch.json（正解の道が決まっている ${ready.length}件。読んで要る物だけ残し brain-exam-add.ts --add-batch=<file>）`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
