// scripts/route-substate-label.ts — 竹内さんの番を、駅の中の細かい状態（apply-route-substate.ts の15）と誘導先に DeepSeek で割り当てる（作業員M・2026-11-21・台帳 #467 の (2)(3)）
//   統括役の了承（11/21）: (a) 198通×3回＋(b) 別の番（turns-2026-11-04 の残り 833番）×3回・約 $0.85・22時以降・伏せの決まりどおり。
//   使い道: ① 網（turn-aims-after.matchSubstateOf）の本当の当たり（状態ごとの当たりと取りこぼし）を、作る半分と測る半分に分けて見る
//           ② 状態ごとの言い回しの型と潜在の4つ（scripts/route-substate-phrasing.ts --labels=）を15状態全部に広げる
//   テストの決まり（memory/test_protocol_brain.md）: setupLlmTest を最初に・LLM_TEST_MODE=deepseek-all・材料は伏せ済みの customer_gist・body と写しの状況の文 v2 だけ。
//     申込以降の番は turn-application-gate と applicationMaterialReason で外す（anatomy-seven-read と同じ）。DB には書かない（読むのは takeuchi_compose_examples の伏せ済みの欄だけ）。
//   費用の見込み: 1回 入力 約900・出力 約40 トークン ≈ $0.0003（夜の安い時間）。1031番×3回 ≈ $0.9。--cap-usd（既定 1.2）で止める。
// 実行（22時以降）: LLM_TEST_MODE=deepseek-all npx tsx --env-file=<サーバーの鍵のある .env> scripts/route-substate-label.ts [--set=a|b|all] [--votes=3] [--cap-usd=1.2] [--label=l1]
//   出す物: exam-cache/route-substate/labels-<label>.json（番ごとの3回の読み）と majority-<label>.json（2回以上そろった状態 {id: state}・--labels に渡す）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");
const LEADS = ["keep", "viewing", "apply", "estimate", "answer_only", "ask_send", "none"] as const;

(async () => {
  const jstHour = (new Date().getUTCHours() + 9) % 24;
  if (jstHour >= 8 && jstHour < 22) { console.error("22時〜翌8時だけ流す（試験と重い数えの決まり）"); process.exit(1); }
  const h = await setupLlmTest("route-substate-label");
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    const { sumoraLlmMarks } = await import("../app/lib/llm-usage-recorder");
    const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
    const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
    const { applicationMaterialReason } = await import("../app/lib/test-pii-guard");
    const { SUBSTATES } = await import("../app/lib/apply-route-substate");
    h.assertYuma(YUMA_CONVERSATION_ID, "駅の中の状態の割り当て");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const roles = new Set((JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as Array<{ id: string }>).map((r) => r.id));
    const turns = JSON.parse(readFileSync(join(CACHE, "conductor-focus", "turns-2026-11-04.json"), "utf8")) as Array<{ id: string; conv: string; at: string; scene: string; v2: string }>;
    const set = arg("set", "all");
    const want = turns.filter((t) => (set === "a" ? roles.has(t.id) : set === "b" ? !roles.has(t.id) : true));
    const rows = new Map<string, { body: string; customer_gist: string | null }>();
    for (let i = 0; i < want.length; i += 100) {
      const { data, error } = await sb.from("takeuchi_compose_examples").select("message_id, body, customer_gist").in("message_id", want.slice(i, i + 100).map((t) => t.id));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ message_id: string; body: string; customer_gist: string | null }>) rows.set(r.message_id, r);
      await new Promise((res) => setTimeout(res, 150));
    }
    // 申込以降の番を外す（1会話ずつ・間を空けて引く）
    const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
    const pick: typeof want = [];
    let gated = 0, noRow = 0;
    for (const t of want) {
      const r = rows.get(t.id);
      if (!r?.body || !r.customer_gist) { noRow++; continue; }
      if (!recs.has(t.conv)) { recs.set(t.conv, await loadTurnApplicationRecords(sb, t.conv)); await new Promise((res) => setTimeout(res, 100)); }
      if (turnApplicationReason(recs.get(t.conv), t.at) || applicationMaterialReason(r.customer_gist) || applicationMaterialReason(r.body) || applicationMaterialReason(t.v2)) { gated++; continue; }
      pick.push(t);
    }
    console.log(`読む ${pick.length}番（申込以降の疑いで外した ${gated}・材料が無い ${noRow}）`);
    const stateList = SUBSTATES.map((s) => `${s.id}: ${s.label}`).join("\n");
    const system = `あなたは不動産仲介の LINE のやり取りを分類する係です。お客様の今の連投（伏せ済みの要旨）と状況の文から、お客様が今どの細かい状態にいるかを下の一覧から1つ選びます（当てはまらなければ none）。` +
      `次にスタッフの返信の文から、スタッフがどこへ誘導したかを1つ選びます（${LEADS.join("・")}／keep＝関係をつなぐ・ピックアップや確認の約束、answer_only＝答えて閉じる）。` +
      `状態はお客様の側だけで決めます（スタッフの返信で決めない）。JSON だけを返す: {"state":"<id か none>","lead":"<誘導先>"}\n\n状態の一覧:\n${stateList}`;
    const votes = Math.max(1, Math.min(3, Number(arg("votes", "3")) || 3));
    const capUsd = Number(arg("cap-usd", "1.2")) || 1.2;
    const est = Number(arg("est", "0.0004")) || 0.0004;
    const ids = new Set(SUBSTATES.map((s) => s.id));
    let calls = 0, bad = 0;
    const ask = async (user: string) => {
      calls++;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_anatomy", YUMA_CONVERSATION_ID) },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 80, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) { bad++; return null; }
      const d = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const m = (d.content?.find((b) => b.type === "text")?.text ?? "").match(/\{[^{}]*\}/);
      try {
        const o = JSON.parse(m?.[0] ?? "") as { state?: string; lead?: string };
        const state = o.state && ids.has(o.state) ? o.state : "none";
        const lead = (LEADS as readonly string[]).includes(String(o.lead)) ? String(o.lead) : "none";
        return { state, lead };
      } catch { bad++; return null; }
    };
    const out: Array<{ id: string; set: "a" | "b"; scene: string; reads: Array<{ state: string; lead: string } | null> }> = [];
    for (let i = Number(arg("from", "0")) || 0; i < pick.length; i += 5) {
      if ((calls + 5 * votes) * est > capUsd) { console.log(`費用の上限 $${capUsd} の見込みで止めた（${i}/${pick.length}番）`); break; }
      await Promise.all(pick.slice(i, i + 5).map(async (t) => {
        const r = rows.get(t.id)!;
        const user = `【お客様の今の連投（要旨・伏せ済み）】\n${r.customer_gist}\n\n【状況の文】\n${t.v2}\n\n【スタッフの返信】\n${r.body.slice(0, 600)}`;
        const reads = await Promise.all(Array.from({ length: votes }, () => ask(user).catch(() => null)));
        out.push({ id: t.id, set: roles.has(t.id) ? "a" : "b", scene: t.scene, reads });
      }));
    }
    const dir = join(CACHE, "route-substate"); mkdirSync(dir, { recursive: true });
    const label = arg("label", "l1");
    writeFileSync(join(dir, `labels-${label}.json`), JSON.stringify(out, null, 1));
    // 2回以上そろった状態だけ（そろわない番は入れない＝揺れを正解にしない）
    const majority: Record<string, string> = {};
    const leadMaj: Record<string, string> = {};
    for (const o of out) {
      const c: Record<string, number> = {}, l: Record<string, number> = {};
      for (const r of o.reads) if (r) { c[r.state] = (c[r.state] ?? 0) + 1; l[r.lead] = (l[r.lead] ?? 0) + 1; }
      const [s, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      if (n >= Math.min(2, votes)) majority[o.id] = s;
      const [ld, ln] = Object.entries(l).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      if (ln >= Math.min(2, votes)) leadMaj[o.id] = ld;
    }
    writeFileSync(join(dir, `majority-${label}.json`), JSON.stringify(majority, null, 1));
    writeFileSync(join(dir, `lead-${label}.json`), JSON.stringify(leadMaj, null, 1));
    // 網の当たりを測る材料（伏せ済みの要旨だけ・exam-cache の中＝倉庫に上げない）: audit-route-substate-takeuchi.ts --labels=majority-<label>.json --gists=gists-<label>.json
    writeFileSync(join(dir, `gists-${label}.json`), JSON.stringify(Object.fromEntries(out.map((o) => [o.id, rows.get(o.id)?.customer_gist ?? ""])), null, 1));
    const agree = Object.keys(majority).length;
    console.log(`# 割り当て ${label}: ${out.length}番・2回以上そろった ${agree}（${out.length ? Math.round((agree / out.length) * 100) : 0}%）・読めなかった ${bad}・呼び出し ${calls}回`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
