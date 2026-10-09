// scripts/brain-exam-rejudge.ts — ブレインの試験の保存した答案を、判定役（DeepSeek）だけもう一度採点して揺れを見る（ブレインは回さない・YUMA に書かない）
//
// 2026-10-09 竹内さん「試験を90%超えたい」→ 落ちた問題のうち「判定役の揺れ」で落ちた物を分ける。
//   brain-exam.ts の judge と同じ指示文（写し・変えたら合わせる）で、保存した答案（row.brain＝planOf 済み）を --repeat 回採点し、
//   依頼（asks）・言ってはいけない事（ng）の判定が回ごとに同じか、元の判定と同じかを出す。
//   --route-fix: 出し切りの決まりで正解が AIX 全力サポートだけになった問題の依頼（route=reply）を aix として採点し直す（試験の正解の食い違いの直しの試し）
// 使い方: npx tsx --env-file=.env.local scripts/brain-exam-rejudge.ts --label=base-ds-1009 [--repeat=3] [--only=q001] [--route-fix] [--out=<jsonl>]
// 費用: 1回 約$0.001（DeepSeek 直）。終わりに回数と費用を出す
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import type { ExamProblem } from "./brain-exam-add";
import { brainPathCode, judgePath, type BrainExamOutput } from "./lib/brain-exam-score";
import { shiftExamText } from "./lib/brain-exam-dates";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const LABEL = arg("label", "base-ds-1009");
const REPEAT = Math.max(1, Number(arg("repeat", "3")));
const ONLY = arg("only").split(",").filter(Boolean);
const ROUTE_FIX = args.includes("--route-fix");
const OUT = arg("out");
// 10/09 --measures: 今の正解（出し切りの依頼の答え方・q048 等の直し・日付のずらし）で採点し直し、物差し（①道 ②依頼の答え方 ③要点）を出す
const MEASURES = args.includes("--measures");
function shiftP(p: ExamProblem): ExamProblem {
  const jd = (x: number) => Math.floor((x + 9 * 3600_000) / 86_400_000);
  const diff = jd(Date.now()) - jd(Date.parse(p.at)); const days = diff <= 0 ? 0 : Math.ceil(diff / 7) * 7;
  if (!days || (p as ExamProblem & { noDateShift?: boolean }).noDateShift) return p;
  const atMs = Date.parse(p.at), yr = new Date(atMs + 9 * 3600_000).getUTCFullYear();
  const sh = (t: string, ref = atMs) => shiftExamText(t, days, yr, ref);
  return { ...p, context: p.context.map((m) => ({ ...m, t: sh(m.t, atMs - m.ago * 60_000) })), customer: sh(p.customer), asks: (p.asks ?? []).map((a) => ({ ...a, q: sh(a.q), point: sh(a.point) })), ng: (p.ng ?? []).map((x) => sh(x)) };
}
const cost = { calls: 0, usd: 0, fail: 0 };

const AIX_JA: Record<string, string> = { property_recommendation: "物件オススメ", property_send: "物件を送る（ピックアップした）", property_pickup: "物件ピックアップ", property_search: "物件検索", viewing_invite: "内覧調整", meeting_place: "待ち合わせ場所（内覧の確定）", application_push: "申込へ", property_check_result: "物件確認した（管理会社に確認した結果）", acknowledge_check: "確認した", estimate_sheet: "見積書送る", cost_explain: "初期費用を説明", cost_breakdown: "初期費用について", condition_hearing: "条件ヒアリング（フォーム）", guarantor_info: "保証会社について", phone_call: "電話をかける", zenryoku_support: "全力サポート", followup_revive: "追客フォロー" };
const ROUTE_JA: Record<string, string> = { reply: "返信の本文で答える", promise: "後でやると約束する返信（確認・見積・ピックアップ・撮影・交渉）", aix: "AIX（スタッフが確かめた事・検索の結果・見積・内覧の段取りを送る）", none: "答えない" };

async function deepseekJson(sys: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 1400, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(90_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(String(e)); } }
  }
  return null;
}
function contextText(p: ExamProblem) {
  const lastStaff = [...p.context].reverse().filter((m) => m.s === "staff").slice(0, 2).reverse().map((m) => `${m.aix ? "【AIX】" : ""}${m.t}`.slice(0, 300));
  return `【お客様の今の発言（連投）】\n${p.customer}\n\n【直前のこちらの送信】\n${lastStaff.join("\n―\n") || "（なし＝初回）"}`;
}
function asksNgText(p: ExamProblem) {
  return `【正解の依頼の一覧】\n${(p.asks ?? []).map((a, i) => `${i + 1}. 「${a.q}」→ 答え方: ${[a.route, ...(a.routes ?? []).filter((r) => r !== a.route)].map((r) => ROUTE_JA[r]).join(" または ")}／要点: ${a.point}`).join("\n") || "（なし）"}\n\n【言ってはいけない事】\n${(p.ng ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n") || "（なし）"}`;
}
async function judge(p: ExamProblem, plan: Record<string, unknown>): Promise<{ asks: boolean[]; ng: boolean[]; route: boolean[] } | null> {
  const asks = p.asks ?? [], ng = p.ng ?? [];
  if (!asks.length && !ng.length) return { asks: [], ng: [], route: [] };
  const act = String(plan.action ?? "");
  const sys = [
    "あなたは賃貸仲介の LINE 接客で『次の一手を決める AI（ブレイン）』の答案を採点する係です。",
    "ブレインの答案は JSON（reply_mode=aix なら action の AIX をスタッフが送る番／two_stage は約束の返信の種類／reply_direction は返信の方向／key_topics は返信に必ず入れる事／avoid_topics は言わない事／customer_questions はお客様の質問の一覧／turn_contract・asks があればこの番の依頼の一覧と答え方）。",
    "採点は推測で甘くしない。答案のどこにも書かれていない事は『入っていない』。",
    "① asks: 正解の依頼ごとに、答案がその依頼を『正解の答え方』で扱う指示になっているか（covered）。",
    "  - 答え方 reply: 返信の中で答える指示がある（要点と食い違わない）。確認すると約束して答えを保留する指示なら false。",
    "  - 答え方 promise: 後でやる（確認・見積・ピックアップ・撮影・交渉）と約束する指示がある。約束の中身が要点と違えば false。",
    "  - 答え方 aix: 答案の AIX（action/alt_actions）がその依頼に合う種類か、方向がその AIX で応えると言っている。",
    "  - 要点に具体の中身（時間・金額・仕組み）がある時、答案がそれと食い違う中身を指示していたら false。中身が無くても『答える』指示があれば true。",
    "  - route: 要点の中身は見ずに、答え方（reply＝返信の本文で答える／promise＝後でやると約束する／aix＝AIX で応える／none＝触れない）の区別だけが正解と同じか。",
    "② ng: 正解の『言ってはいけない事』ごとに、答案がそれを言う／する指示になっているか（violated）。はっきり指示している時だけ true。",
    '出力は JSON だけ: {"asks":[{"i":1,"route":true,"covered":true,"why":"20字"}],"ng":[{"i":1,"violated":false,"why":"20字"}]}',
  ].join("\n");
  const user = [contextText(p), `【ブレインの答案（最終）】\n${JSON.stringify(plan, null, 1)}${act ? `\n（AIX の名前: ${AIX_JA[act] ?? act}）` : ""}`, asksNgText(p)].join("\n\n");
  const o = await deepseekJson(sys, user);
  if (!o) return null;
  const A = (o.asks ?? []) as Array<{ i: number; covered: boolean; route?: boolean }>, G = (o.ng ?? []) as Array<{ i: number; violated: boolean }>;
  return { route: asks.map((_, i) => { const x = A.find((y) => y.i === i + 1); return !!x?.covered || x?.route !== false; }), asks: asks.map((_, i) => !!A.find((x) => x.i === i + 1)?.covered), ng: ng.map((_, i) => !!G.find((x) => x.i === i + 1)?.violated) };
}

async function main() {
  const probs = new Map((JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")) as Array<ExamProblem & { acceptWhen?: { searchExhausted?: string[] } }>).map((p) => [p.id, p]));
  const f = `scripts/brain-exam/results/${LABEL}.jsonl`;
  if (!existsSync(f)) throw new Error(`${f} が無い`);
  const rows = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; brain: Record<string, unknown> | null; asks: Array<{ covered: boolean }> | null; ng: Array<{ violated: boolean }> | null; error?: string })
    .filter((r) => !r.error && r.brain && (!ONLY.length || ONLY.includes(r.id)));
  if (OUT) writeFileSync(OUT, "");
  const L: string[] = [];
  const meas: Array<{ id: string; path: boolean; route: boolean; point: boolean }> = [];
  let flipAsks = 0, flipNg = 0, nAsks = 0, nNg = 0, passChange = 0;
  for (const r of rows) {
    let p = probs.get(r.id)!;
    if (MEASURES) { const ea = (p.acceptWhen as { searchExhaustedAsks?: ExamProblem["asks"] } | undefined)?.searchExhaustedAsks; p = shiftP(ea?.length ? { ...p, asks: ea } : p); }
    if (ROUTE_FIX && p.acceptWhen?.searchExhausted?.length && String(r.brain!.action ?? "") === "zenryoku_support") p = { ...p, asks: (p.asks ?? []).map((a) => a.route === "reply" ? { ...a, route: "aix" as const } : a) };
    const accept = p.acceptWhen?.searchExhausted?.length ? p.acceptWhen.searchExhausted : p.accept;
    const pathOk = judgePath(brainPathCode(r.brain as BrainExamOutput), accept, p.mustNot ?? []).ok;
    if (!(p.asks ?? []).length && !(p.ng ?? []).length) { meas.push({ id: r.id, path: pathOk, route: pathOk, point: pathOk }); continue; }
    const orig = { asks: (r.asks ?? []).map((a) => a.covered), ng: (r.ng ?? []).map((g) => g.violated) };
    const reps: Array<{ asks: boolean[]; ng: boolean[]; route: boolean[] }> = [];
    for (let k = 0; k < REPEAT; k++) { const j = await judge(p, r.brain!); if (j) reps.push(j); }
    // 過半数
    const maj = (xs: boolean[]) => xs.filter(Boolean).length * 2 > xs.length;
    const mAsks = (p.asks ?? []).map((_, i) => maj(reps.map((x) => x.asks[i])));
    const mNg = (p.ng ?? []).map((_, i) => maj(reps.map((x) => x.ng[i])));
    const mRoute = (p.asks ?? []).map((_, i) => maj(reps.map((x) => x.route[i])));
    meas.push({ id: r.id, path: pathOk, route: pathOk && mRoute.every(Boolean) && !mNg.some(Boolean), point: pathOk && mAsks.every(Boolean) && !mNg.some(Boolean) });
    const unstableA = (p.asks ?? []).map((_, i) => new Set(reps.map((x) => x.asks[i])).size > 1);
    const unstableN = (p.ng ?? []).map((_, i) => new Set(reps.map((x) => x.ng[i])).size > 1);
    nAsks += mAsks.length; nNg += mNg.length;
    flipAsks += mAsks.filter((v, i) => orig.asks[i] !== undefined && v !== orig.asks[i]).length;
    flipNg += mNg.filter((v, i) => orig.ng[i] !== undefined && v !== orig.ng[i]).length;
    const origOk = orig.asks.every(Boolean) && !orig.ng.some(Boolean), newOk = mAsks.every(Boolean) && !mNg.some(Boolean);
    if (origOk !== newOk) passChange++;
    L.push(`${r.id} 依頼 元=${orig.asks.map((x) => x ? "○" : "✕").join("")} 過半数=${mAsks.map((x) => x ? "○" : "✕").join("")}${unstableA.some(Boolean) ? `（回ごとに揺れ ${unstableA.filter(Boolean).length}）` : ""}${mNg.length ? ` ｜NG 元=${orig.ng.map((x) => x ? "✕" : "○").join("")} 過半数=${mNg.map((x) => x ? "✕" : "○").join("")}${unstableN.some(Boolean) ? "（揺れ）" : ""}` : ""}${origOk !== newOk ? `  ★依頼とNGの合否が ${origOk ? "○→✕" : "✕→○"}` : ""}`);
    if (OUT) appendFileSync(OUT, JSON.stringify({ id: r.id, orig, reps, mAsks, mNg }) + "\n");
  }
  L.push(`\n依頼 ${nAsks} 件のうち元の判定と過半数が違う ${flipAsks}・NG ${nNg} 件のうち ${flipNg}・依頼とNGの合否が変わった問題 ${passChange}`);
  if (MEASURES) { const n = meas.length, c = (k: "path" | "route" | "point") => `${meas.filter((m) => m[k]).length}/${n}（${n ? Math.round(meas.filter((m) => m[k]).length / n * 100) : 0}%）`; L.push(`物差し（今の正解で採点し直し・1回の答案）: ①道 ${c("path")}｜②依頼の答え方 ${c("route")}｜③要点まで ${c("point")}`); L.push(`  ②で落ちた: ${meas.filter((m) => !m.route).map((m) => m.id).join(" ")}`); }
  L.push(`判定 ${cost.calls}回 $${cost.usd.toFixed(4)}${cost.fail ? `・失敗 ${cost.fail}` : ""}（DeepSeek 直）${ROUTE_FIX ? "・--route-fix" : ""}`);
  console.log(L.join("\n"));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
