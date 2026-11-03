// app/lib/kb-insert-judge.ts — 設計知見を入れる時の統括（新しい行と近い行の関係を決める・指示と読み取りは純関数・呼び出しは DeepSeek 1回）
//
// 2026-11-03 作業員6（竹内さん KB P1「設計知見そのものにも統括を作る」②）。kb-insert が近さ 0.72 以上の既存の行を出し、1行ずつ次のどれかに決める:
//   same（同じ）／child（子＝新しい行の parent にする）／supersede（上書き＝古い行の退役の案）／conflict（ぶつかる＝P0 → 新しい決定 → 実データ の順で解き、竹内さんへの確認事項の下書きに）／unrelated
//   名札 kb_insert_judge（DeepSeek・1行あたり1回・設計知見の文だけ＝お客様の文は入らない）。自動で退役はしない（案を出すだけ）。parent は新しい行にだけ付ける。
// テスト: app/lib/__tests__/kb-insert-judge.test.ts
import { DEEPSEEK_ENDPOINT } from "./llm-alt-provider";

export const KB_JUDGE_ACTION = "kb_insert_judge";
export const KB_JUDGE_MIN_SIM = 0.72;
export type KbRel = "same" | "child" | "supersede" | "conflict" | "unrelated";
export type KbRowLite = { id: string; title: string; insight: string; priority: number | null; created_at?: string | null };
export type KbJudge = { rel: KbRel; why: string; resolve: string | null };

export const KB_JUDGE_SYSTEM = [
  "あなたは設計知見（社内の決まり・知見の帳面）の整理役です。新しい行と既存の行1つの関係を1つ決めます。",
  "same＝同じ事を言っている／child＝新しい行は既存の行の具体・一部（既存の行が上の決まり）／supersede＝新しい行が既存の行の決まりを変える・置き換える",
  "conflict＝両方が今の決まりとして食い違う（どちらに従うか決まらない）／unrelated＝関係が薄い。",
  "conflict の時は resolve に解き方を1文で: 段 P0 が先 → 竹内さんの新しい決定が先 → 実データが先 → 古い決まり、の順で。",
  "出力は JSON だけ: {\"rel\":\"same|child|supersede|conflict|unrelated\",\"why\":\"…\",\"resolve\":\"…\"|null}",
].join("\n");
export function kbJudgePrompt(newRow: KbRowLite, old: KbRowLite, sim: number): string {
  const f = (r: KbRowLite) => `段 P${r.priority ?? 2}${r.created_at ? `・${r.created_at.slice(0, 10)}` : ""}\n題: ${r.title.slice(0, 160)}\n中身: ${r.insight.slice(0, 600)}`;
  return `## 新しい行\n${f(newRow)}\n\n## 既存の行（近さ ${sim.toFixed(2)}）\n${f(old)}`;
}
export function parseKbJudge(text: string): KbJudge | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const rel = String(o.rel);
    if (!["same", "child", "supersede", "conflict", "unrelated"].includes(rel)) return null;
    const resolve = o.resolve == null || String(o.resolve) === "null" ? null : String(o.resolve).slice(0, 160);
    return { rel: rel as KbRel, why: String(o.why ?? "").replace(/\s+/g, " ").slice(0, 160), resolve };
  } catch { return null; }
}
/** 親にしてよいか（段が上か同じ・P0 の行には親を付けない・自分自身は不可） */
export function canBeParent(child: Pick<KbRowLite, "id" | "priority">, parent: Pick<KbRowLite, "id" | "priority">): boolean {
  const c = child.priority ?? 2, p = parent.priority ?? 2;
  return child.id !== parent.id && c !== 0 && p <= c;
}
/** DeepSeek に1回だけ聞く（鍵が無い・失敗は null＝判断なしで今までどおり被りの表示だけ） */
export async function judgeKbRelation(newRow: KbRowLite, old: KbRowLite, sim: number, env: Record<string, string | undefined> = process.env): Promise<KbJudge | null> {
  const key = env.LLM_ALT_DEEPSEEK_KEY || env.DEEPSEEK_API_KEY || "";
  if (!key) return null;
  try {
    const r = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "x-sumora-action": KB_JUDGE_ACTION },
      body: JSON.stringify({ model: env.KB_JUDGE_MODEL ?? "deepseek-flash", max_tokens: 300, temperature: 0, messages: [{ role: "system", content: KB_JUDGE_SYSTEM }, { role: "user", content: kbJudgePrompt(newRow, old, sim) }] }),
    });
    if (!r.ok) return null;
    const d = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return parseKbJudge(d.choices?.[0]?.message?.content ?? "");
  } catch { return null; }
}
