// scripts/conductor-conflict-eval.ts — 統括が「返信／約束／AIX／返信＋AIX」を1か所で決める形の試し（DeepSeek・本番に書き込まない）
// ⚠ 2026-11-03: 番ごとに DB を読む（数百回）。営業時間（9〜22時 JST）には回さない（11/3 10:31 の DB の混雑の一因）。材料は先に手元へ書き出して使い回す
//
// 2026-11-03 竹内さん（KB 7bbb1760「ぶつかっている所を統括して AIX なら AIX と判断できるように」・0f4604a9 の順）・指揮役の指示:
//   決め方の順: ①この番に要る「スタッフしか分からない事」→ ②それが手元にあるか → 手元にあれば AIX（どの担当か）／まだ無ければ約束（差し戻し）／要らなければ返信。
//   返信で答えられる事と AIX で送る事の両方があれば2通（返信＋AIX・feedback_promise_order_split）。
//   入力: scripts/audit-conflict-kinds.ts --out の外れ（ぶつかりの種類つき）と audit-aix-miss-causes.ts --json の当たり。
//   正解: 外れ＝スタッフが押した AIX（同じ返しで手打ちの文もあれば「返信＋AIX」）／当たり＝ブレインの判断（スタッフと同じ）。
//   材料: その番までの会話（伏せ字）・ブレインの最終の判断と LLM の最初の AIX・担当の札（aix_desk_cards の「送る中身」「似たボタンとの線」）。
// 使い方: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/conductor-conflict-eval.ts --kinds=<conflict-kinds.json> --hits=<aix-miss.json> [--limit=N]
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
type Turn = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; cause: string; staff_aix: string; brain_action: string; decision_id: string | null; kind?: string; staffText?: boolean; la?: string | null };
type Out = { needs: string[]; have: boolean; decision: "reply" | "promise" | "aix" | "both"; aix: string | null; why: string };
const FAMILY = (k: string | null | undefined) => String(k ?? "").split("/")[0];

let h: LlmTestHarness | null = null;
(async () => {
  h = await setupLlmTest("conductor-conflict-eval");
  const { callDeepSeekRead } = await import("../app/lib/vision-alt-provider");
  const { maskPII } = await import("../app/lib/pii-mask");
  const kinds = JSON.parse(readFileSync(arg("kinds")!, "utf8")) as Turn[];
  const hitsAll = (JSON.parse(readFileSync(arg("hits")!, "utf8")) as { hits: Turn[] }).hits;
  const limit = Number(arg("limit") ?? 0);
  const misses = limit ? kinds.slice(0, limit) : kinds;
  const hits = limit ? hitsAll.slice(0, Math.ceil(limit / 2)) : hitsAll;
  // 担当の札（短く: 鍵・ボタン→ピッカー・送る中身・似たボタンとの線）＝前置き（キャッシュに乗る）
  const { data: cards } = await sb.from("aix_desk_cards").select("key, button, picker, card_text").order("key");
  const line = (c: { key: string; button: string | null; picker: string | null; card_text: string | null }) => {
    const t = String(c.card_text ?? "");
    const send = t.match(/送る中身（スタッフだけが知る事）:\s*([^\n]+)/)?.[1] ?? "";
    const near = t.match(/似たボタンとの線:\s*([^\n]+)/)?.[1] ?? "";
    return `- ${c.key}｜${c.button ?? ""}${c.picker ? `→${c.picker}` : ""}｜送る中身: ${send.slice(0, 90)}｜線: ${near.slice(0, 110)}`;
  };
  const SYSTEM = `あなたは不動産仲介の LINE の統括です。お客様の今の連投に、スタッフが何を返すべきかを1か所で決めます。
決め方の順（竹内さんの決定）:
1. この番に要る「スタッフしか分からない事」を挙げる（例: その部屋の今の空き・管理会社の判断や交渉の結果・まだ作っていない見積の金額・内覧の空き日・室内の写真・電話で打ち合わせる審査の事情）。会話・こちらが送った資料・会社の事実で答えられる事は入れない。
2. それが手元にあるか、スタッフが今すぐ取れるか（竹内さんの決定 5aa28356「管理会社に確かめれば分かる問い（空き・見積など）は約束を挟まずすぐ AIX で返す」）:
   今すぐ取れる（スタッフが数分〜数十分で調べて送れる）＝空き・募集状況（業者の物件サイト）／届いた資料・送った物件・お客様が送ってきた物件の見積／新しい条件での物件探し（スタッフが今探して物件オススメ・ピックアップで送る）／決まった内覧の日時。
   取れない（約束にする）＝管理会社の判断・交渉の結果（家賃・礼金の交渉・設備の交換・ペットの相談）／管理会社の営業時間外（18時以降・土日の一部）に管理会社にしか答えられない確認／スタッフの手元に無い室内の写真。
   スタッフが今すぐ取れる事は、約束を挟まずその場で AIX にする（竹内さんの実際の動き）。
3. 手元にある・今すぐ取れるなら AIX（下の担当の鍵から1つ）。取れないなら約束の返信（確かめる・探す・作ると約束する＝promise）。スタッフしか分からない事が要らなければ返信（reply）。
4. 返信で答える事と、AIX で送る事の両方があれば2通（both・返信＋AIX）。約束を1通に詰めない。
ブレインの判断（材料）と違うと思えば変えてよい。お礼・了承だけの番でも、こちらがまだ果たしていない約束や送れる物があれば AIX の番になりうる。
AIX の担当（鍵｜ボタン→ピッカー｜送る中身｜似たボタンとの線）:
${(cards ?? []).map(line).join("\n")}
出力は JSON だけ: {"needs":["スタッフしか分からない事"],"have":true|false,"decision":"reply"|"promise"|"aix"|"both","aix":"担当の鍵（aix・both の時）か null","why":"40字以内"}`;
  const parse = (t: string): Out | null => { try { const m = t.match(/\{[\s\S]*\}/); if (!m) return null; const o = JSON.parse(m[0]); return o && o.decision ? o as Out : null; } catch { return null; } };
  const rows: Array<{ id: number; set: "miss" | "hit"; kind: string; truth: string; brain: string; out: Out | null; ok: boolean; brainOk: boolean }> = [];
  const run = async (t: Turn, set: "miss" | "hit") => {
    const { data: ms } = await sb.from("messages").select("sender, text, is_aix_generated, created_at").eq("conversation_id", t.conversation_id).lte("created_at", t.customer_last_at ?? t.customer_turn_at).order("created_at", { ascending: false }).limit(12);
    const hist = ((ms ?? []) as Array<{ sender: string; text: string | null; is_aix_generated: boolean | null }>).reverse()
      .map((m) => `${m.sender === "customer" ? "客" : m.is_aix_generated ? "我(AIX)" : "我"}: ${maskPII(String(m.text ?? "").replace(/\s+/g, " ").slice(0, 220))}`).join("\n");
    const brain = t.brain_action ? `AIX ${t.brain_action}` : "返信";
    const jst = new Date(Date.parse(t.customer_last_at ?? t.customer_turn_at) + 9 * 3_600_000);
    const user = `【今の時刻】${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, "0")}（日本時間）
【会話（古い→新しい・最後が今のお客様の連投）】\n${hist}\n\n【ブレインの判断（材料）】最終: ${brain}${t.la ? `／LLM の最初の AIX: ${t.la}` : ""}`;
    const r = await callDeepSeekRead(SYSTEM, user, { maxTokens: 400, timeoutMs: 40_000 }, parse);
    const out = r.value ?? null;
    const truth = set === "miss" ? (t.staffText ? `both:${t.staff_aix}` : `aix:${t.staff_aix}`) : (t.brain_action ? `aix:${t.brain_action}` : "reply");
    const [tk, tKey] = truth.split(":");
    const okKey = (k: string | null | undefined) => !tKey || FAMILY(k) === FAMILY(tKey) || String(k ?? "") === tKey;
    const ok = !!out && (tk === "reply" ? out.decision === "reply" || out.decision === "promise" : tk === "both" ? (out.decision === "both" || out.decision === "aix") && okKey(out.aix) : (out.decision === "aix" || out.decision === "both") && okKey(out.aix));
    const brainOk = set === "hit";
    rows.push({ id: t.id, set, kind: t.kind ?? (set === "hit" ? "hit" : "?"), truth, brain, out, ok, brainOk });
  };
  for (const t of misses) await run(t, "miss");
  for (const t of hits) await run({ ...t, kind: "hit" }, "hit");
  const fixed = rows.filter((r) => r.set === "miss" && r.ok).length, kept = rows.filter((r) => r.set === "hit" && r.ok).length;
  console.log(`\n外れ ${misses.length} 番のうち統括で直る ${fixed}・当たり ${hits.length} 番のうち統括でも当たり ${kept}（落とす ${hits.length - kept}）`);
  const byKind: Record<string, { n: number; ok: number }> = {};
  for (const r of rows.filter((x) => x.set === "miss")) { const k = r.kind.split("（")[0]; const s = (byKind[k] ??= { n: 0, ok: 0 }); s.n++; if (r.ok) s.ok++; }
  console.log("ぶつかりの種類ごと（直る／番）:", Object.entries(byKind).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join("・"));
  const lost = rows.filter((r) => r.set === "hit" && !r.ok).map((r) => `#${r.id} 正解=${r.truth} 統括=${r.out?.decision}:${r.out?.aix ?? "-"}`);
  if (lost.length) console.log("当たりを落とした番:", lost.slice(0, 12).join(" ／ "));
  if (arg("out")) writeFileSync(arg("out")!, JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await h?.finish(); });
