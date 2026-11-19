// scripts/audit-combo-mismatch.ts — 本番の番で「ブレインの組」と「スタッフが送った組」が違った番を、型ごとに数と実例（伏せた形）で出す（読むだけ・LLM なし・費用 0）
//   2026-11-13 作業員C（統括役の頼み1・作業員7b の audit-combo-vs-takeuchi.ts の続き）。
//   基準は竹内さん本人の番（その番の手が全部 竹内さん＝返信も押した AIX も）。従業員だけの番・混ざりの番は参考として別に数える。
//   違いの型: 道が違う（返信／AIX／2段）＝判断の誤りの候補 ／ 道は同じで組の形が違う（2通目・AIX の後の返信 等）＝組の表が off で組を出していない ／ AIX の種類が違う
//   申込以降（スタッフの通に申込の書類の文）の会話は外す。営業時間（JST 9〜22時）は流さない。本文は伏せて80字まで。
//   実行: npx tsx --env-file=<鍵のある .env> scripts/audit-combo-mismatch.ts [--days=14] [--out=<json>] [--examples=4]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns, readDecisionSources, aixFamily } from "./lib/prod-yardstick-db";
import { pickSendCombo, type SendCombo } from "../app/lib/send-combo-table";
import { takeuchiCombo, type StaffMove } from "./lib/combo-of-moves";
import { maskPII } from "../app/lib/pii-mask";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (jstHour >= 9 && jstHour < 22) { console.error("営業時間（JST 9〜22時）は流さない"); process.exit(1); }
const days = Number(arg("days", "14")) || 14;
const nEx = Number(arg("examples", "4")) || 4;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const POST_APPLY_RE = /記入欄】|・氏名、フリガナ|申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)|ご契約(?:書|手続)/;
const PROMISE_RE = /確認させて頂|確認させていただ|確認出来次第|お調べ|ピックアップ(?:し|して)?(?:お送り|させ)|作成しお送り|ご用意させ|お送りさせて頂きます|次第(?:随時)?お送り/;
const MASK = (t: string, len = 80) => maskPII(t).replace(/[\p{Script=Han}\p{Script=Katakana}A-Za-z]{1,12}(?:さん|様)/gu, "〇〇さん")
  .replace(/(^|[^\p{Script=Hiragana}])[\p{Script=Hiragana}ー]{1,6}さん/gu, "$1〇〇さん").replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\s+/g, " ").slice(0, len);
type Msg = StaffMove & { text: string; aixType?: string };
const routeOfCombo = (c: SendCombo): "reply" | "aix" | "two_stage" => (c === "reply_only" || c === "reply_reply" ? "reply" : c === "promise_then_aix_later" ? "two_stage" : "aix");

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  const msgs = new Map<string, Msg[]>();
  const readFrom = new Date(Date.parse(since) - 30 * 86_400_000).toISOString();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, staff_writer, is_aix_generated, text").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", readFrom).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = msgs.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), aix: !!r.is_aix_generated, writer: (r.staff_writer as string | null) ?? null, customer: r.sender === "customer", text: String(r.text ?? "") });
        msgs.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const src = await readDecisionSources(sb, [...new Set(turns.map((t) => t.decision_id).filter((x): x is string => !!x))]);
  type Row = { group: string; scene: string; brainAction: string; brainRoute: string; brainCombo: SendCombo; staffCombo: SendCombo; staffAix: string; kind: string; cust: string; staff: string; conv: string; at: string };
  const rows: Row[] = [];
  let postApply = 0, noMove = 0;
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    const all = msgs.get(t.conversation_id) ?? [];
    if (all.some((m) => !m.customer && m.at <= at + 24 * 3_600_000 && POST_APPLY_RE.test(m.text))) { postApply++; continue; }
    const after = all.filter((m) => m.at > at);
    const moves: Msg[] = [];
    for (const m of after) { if (m.customer || m.at - at >= 24 * 3_600_000) break; moves.push(m); }
    const sc = takeuchiCombo(at, after);
    if (!sc || !moves.length) { noMove++; continue; }
    const writers = new Set(moves.map((m) => m.writer ?? "unknown"));
    const group = writers.size === 1 && writers.has("takeuchi") ? "竹内さん" : writers.size === 1 && writers.has("employee") ? "従業員" : "混ざり";
    const ds = t.decision_id ? src.get(String(t.decision_id)) ?? "" : "";
    const route: "reply" | "two_stage" | "aix" = /two_stage_promise/.test(String(ds)) ? "two_stage" : aixFamily(t.brain_action) !== "返信" ? "aix" : "reply";
    const bp = pickSendCombo({ type: null, route, cues: { firstContact: /condition_hearing/.test(String(t.scene_key ?? "")), hearing: /condition_hearing/.test(String(t.brain_action ?? "")) } });
    const bc: SendCombo = bp?.combo ?? (route === "aix" ? "aix_only" : route === "two_stage" ? "promise_then_aix_later" : "reply_only");
    const staffAixKinds = (t.staff_aix ?? []).map((a) => aixFamily(a.aix_type)).filter((x) => x !== "返信");
    const staffAix = staffAixKinds[0] ?? (moves.some((m) => m.aix) ? "AIX(種類不明)" : "");
    const sr = routeOfCombo(sc);
    const brainFam = aixFamily(t.brain_action);
    let kind = "同じ";
    if (route !== sr) kind = `道が違う: ブレイン ${route}${route === "aix" ? `(${brainFam})` : ""} ／ スタッフ ${sr}${staffAix ? `(${staffAix})` : ""}`;
    else if (bc !== sc) kind = `組の形が違う: ブレイン ${bc} ／ スタッフ ${sc}`;
    // 読みのゆれを分ける（作業員C）: ①約束の返信だけで果たしの AIX が次のお客様の発言の後か24時間の外＝ブレインの2段と同じ道 ②同じ AIX の束（画像＋文が60秒より空いて続く・種類は1つ）
    const firstReply = moves.find((m) => !m.aix)?.text ?? "";
    if (route === "two_stage" && sr === "reply" && PROMISE_RE.test(firstReply)) kind = "同じ扱い: 約束の返信（果たしの AIX は番の外）";
    if (sc === "aix_then_aix" && route === "aix" && bc === "aix_only" && new Set(staffAixKinds).size <= 1) {
      // 同じ種類の AIX が続く（物件を何件も送る束）＝1つの AIX。束の後に返信があれば AIX→返信
      const ri = moves.findIndex((m) => !m.aix);
      kind = ri < 0 ? "同じ扱い: 同じ AIX の束（画像＋文）" : `組の形が違う: ブレイン ${bc} ／ スタッフ aix_then_reply`;
    }
    if (kind.startsWith("同じ") && route === "aix" && staffAix && staffAix !== "AIX(種類不明)" && brainFam !== staffAix) kind = `AIX の種類が違う: ブレイン ${brainFam} ／ スタッフ ${staffAix}`;
    const lastStaffBefore = [...all].reverse().find((m) => !m.customer && m.at <= at)?.at ?? 0;
    const cust = all.filter((m) => m.customer && m.at <= at && m.at > lastStaffBefore).slice(-3).map((m) => m.text).join(" / ");
    const ri = moves.findIndex((m) => !m.aix);
    const staff = moves.slice(0, 3).map((m) => (m.aix ? `[AIX]${m.text}` : m.text).slice(0, 60)).join(" → ") + (ri >= 3 ? ` …(AIX ${ri}通)→ ${moves[ri].text.slice(0, 60)}` : "");
    rows.push({ group, scene: String(t.scene_key ?? "（場面なし）"), brainAction: String(t.brain_action ?? ""), brainRoute: route, brainCombo: bc, staffCombo: sc, staffAix, kind, cust: MASK(cust), staff: MASK(staff, 220), conv: t.conversation_id.slice(0, 8), at: t.customer_turn_at });
  }
  const groups = ["竹内さん", "従業員", "混ざり"];
  console.log(`# 組の違い（直近 ${days}日・見張りの番 ${turns.length}・申込以降で外した ${postApply}・スタッフの手が無い ${noMove}）`);
  const out: Record<string, unknown> = {};
  for (const g of groups) {
    const rs = rows.filter((r) => r.group === g);
    const byKind = new Map<string, Row[]>();
    for (const r of rs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
    const sorted = [...byKind].sort((a, b) => b[1].length - a[1].length);
    console.log(`\n## ${g} の番 ${rs.length}（同じ ${byKind.get("同じ")?.length ?? 0}）`);
    for (const [k, list] of sorted) {
      if (k.startsWith("同じ")) { console.log(`- ${k}: ${list.length}`); continue; }
      const scenes = new Map<string, number>(); for (const r of list) scenes.set(r.scene, (scenes.get(r.scene) ?? 0) + 1);
      console.log(`- ${k}: ${list.length}（場面 ${[...scenes].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join("・")}）`);
      for (const r of list.slice(0, g === "竹内さん" ? nEx : 2)) console.log(`    · ${r.at.slice(5, 16)} ${r.conv} [${r.scene}] 客「${r.cust}」→ 竹内「${r.staff}」（ブレイン ${r.brainAction || "返信"}）`);
    }
    out[g] = sorted.map(([k, list]) => ({ kind: k, n: list.length, rows: list }));
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
