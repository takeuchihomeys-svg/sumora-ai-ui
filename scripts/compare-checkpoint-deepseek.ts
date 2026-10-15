// scripts/compare-checkpoint-deepseek.ts — セーブデータ（brain_checkpoint）を Claude と DeepSeek で同じ入力から作って比べる（DB に書かない）
//
// 2026-10-15 竹内「核となるブレインはアンソロピック（Claude）に。核じゃない所を DeepSeek にする。個人情報は渡さないのを徹底」:
//   ブレインの部品のうち「今の番の判断に直接は効かない」候補だったセーブデータを、移してよいか確かめる。
//   入力: 試験の問題（scripts/brain-exam/problems.json＝伏せた会話の写し・申込より前で切った物）の会話を、本番と同じ形（buildCheckpointUserContent・maskPII）にする。
//   Claude は1回だけ（答えを --cache に録る・2回目からは録った答えを使う）。DeepSeek は2回（自分同士の揺れ・設計知見 224edc43）。
//   物差し（決定論・LLM の採点なし）:
//     ①読めたか（parseCheckpointOutput）
//     ②創作の疑い: 出力の数字（金額・日付・号室・駅の分数）のうち、入力に無い物の数（このセーブデータは返信の事実確認の正解データ＝創作は事故）
//     ③stage が Claude と同じか ④key_facts の数・summary の長さ
//   個人情報: DeepSeek に送る本文に出口の網（alt-pii-gate.altPiiSignal）を当て、当たった問題は送らない。
// 実行: npx tsx --env-file=.env.local scripts/compare-checkpoint-deepseek.ts [--n=5] [--problems=<path>] [--cache=<json>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "5"));
const PROBLEMS = arg("problems", "scripts/brain-exam/problems.json");
const CACHE = arg("cache", "scripts/.replay-out/compare-checkpoint-cache.json");
const CLAUDE_MODEL = "claude-sonnet-5-5";

type Ctx = { s: string; t: string; aix?: boolean; ago?: number };
type Problem = { id: string; conv: string; at: string; context: Ctx[] };

/** 出力の数字（3桁以上の金額・日付 M/D・号室等）。カンマ・全角を揃える */
function numberTokens(s: string): string[] {
  const t = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/(\d),(\d{3})/g, "$1$2");
  return [...new Set(t.match(/\d+(?:\.\d+)?/g) ?? [])].filter((x) => x.length >= 2);
}
function normInput(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/(\d),(\d{3})/g, "$1$2");
}

async function main() {
  const { CHECKPOINT_STATIC_SYSTEM, buildCheckpointUserContent } = await import("../app/lib/brain-core");
  const { parseCheckpointOutput } = await import("../app/lib/checkpoint-format");
  const { maskPII } = await import("../app/lib/pii-mask");
  const { jstMD } = await import("../app/lib/jst-date");
  const { toOpenAIBody, fromOpenAIResponse, DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPiiSignal } = await import("../app/lib/alt-pii-gate");

  const raw = JSON.parse(readFileSync(PROBLEMS, "utf8"));
  const all = (Array.isArray(raw) ? raw : raw.problems) as Problem[];
  const seen = new Set<string>();
  const picked = all
    .filter((p) => (p.context?.length ?? 0) >= 25)
    .sort((a, b) => b.context.filter((c) => c.s === "customer").length - a.context.filter((c) => c.s === "customer").length)
    .filter((p) => (seen.has(p.conv) ? false : (seen.add(p.conv), true)))
    .slice(0, N);

  const cache: Record<string, string> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const save = () => writeFileSync(CACHE, JSON.stringify(cache, null, 1), "utf8");
  const dsModel = (process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL).trim();
  const dsKey = (process.env.LLM_ALT_DEEPSEEK_KEY ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  let claudeCalls = 0, dsCalls = 0, claudeUsd = 0, dsUsd = 0;

  const rows: Array<Record<string, unknown>> = [];
  for (const p of picked) {
    const atMs = new Date(p.at).getTime();
    const history = p.context.map((m) => {
      const role = m.s === "customer" ? "顧客" : (m.aix ? "スタッフ(AIX)" : "スタッフ");
      const ts = new Date(atMs - (m.ago ?? 0) * 1000).toISOString();
      return `${role} ${jstMD(ts)}: ${(m.t ?? "").slice(0, 600)}`;
    }).join("\n");
    const user = maskPII(buildCheckpointUserContent(null, history, p.context.length, p.context.length, 0), []);
    const body = {
      model: CLAUDE_MODEL, max_tokens: 4000, thinking: { type: "disabled" as const },
      system: [{ type: "text", text: CHECKPOINT_STATIC_SYSTEM }],
      messages: [{ role: "user", content: user }],
    };
    const pii = altPiiSignal(`${CHECKPOINT_STATIC_SYSTEM}\n${user}`);
    if (pii) { rows.push({ id: p.id, skipped: `個人情報の印（${pii}）` }); continue; }

    const kC = `claude:${p.id}`;
    if (!cache[kC]) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, ""), "anthropic-version": "2023-06-01" },
        // 本番は claude-model-map が Sonnet 5.5 に写す時に thinking:disabled → between_tools にする（同じ形で送る）
        body: JSON.stringify({ ...body, thinking: { type: "between_tools" } }),
      });
      const j = await r.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };
      if (!r.ok) throw new Error(`claude ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      claudeCalls++; claudeUsd += ((j.usage?.input_tokens ?? 0) * 2 + (j.usage?.output_tokens ?? 0) * 10) / 1e6;
      cache[kC] = JSON.stringify({ text: j.content?.find((c) => c.type === "text")?.text ?? "", stop: j.stop_reason });
      save();
    }
    const outs: Array<{ who: string; text: string; stop: string | null }> = [{ who: "claude", ...JSON.parse(cache[kC]) }];
    for (const n of [1, 2]) {
      const kD = `ds:${dsModel}:${p.id}:${n}`;
      if (!cache[kD]) {
        const ob = toOpenAIBody(body as never, dsModel, { disableThinking: true });
        const r = await fetch(DEEPSEEK_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dsKey}` }, body: JSON.stringify(ob) });
        const j = await r.json();
        if (!r.ok) throw new Error(`deepseek ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
        const a = fromOpenAIResponse(j, dsModel) as { content: Array<{ text: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
        dsCalls++; dsUsd += (a.usage.input_tokens * 0.66 + a.usage.cache_read_input_tokens * 0.022 + a.usage.output_tokens * 1.98) / 1e6;
        cache[kD] = JSON.stringify({ text: a.content[0]?.text ?? "", stop: a.stop_reason });
        save();
      }
      outs.push({ who: `ds${n}`, ...JSON.parse(cache[kD]) });
    }
    const inputNorm = normInput(user);
    const r: Record<string, unknown> = { id: p.id, msgs: p.context.length };
    let claudeStage: string | null = null;
    let claudeNums: string[] = [];
    for (const o of outs) {
      const parsed = parseCheckpointOutput(o.text, o.stop);
      if (!parsed.ok) { r[o.who] = { ok: false, reason: parsed.reason }; continue; }
      const v = parsed.value as { summary: string; key_facts: Array<{ value: string }>; stage: string };
      const outText = `${v.summary}\n${(v.key_facts ?? []).map((k) => k.value).join("\n")}`;
      const invented = numberTokens(outText).filter((x) => !inputNorm.includes(x));
      const nums = numberTokens(outText).filter((x) => inputNorm.includes(x));
      if (o.who === "claude") { claudeStage = v.stage; claudeNums = nums; }
      // ⑤落とした数字: Claude が残した（入力にある）数字のうち、この出力に無い物の数（家賃・初期費用・号室・日付＝「永久保持」の芯の目安）
      const dropped = o.who === "claude" ? null : claudeNums.filter((x) => !nums.includes(x)).length;
      r[o.who] = { ok: true, stage: v.stage, sameStage: o.who === "claude" ? null : v.stage === claudeStage, facts: v.key_facts?.length ?? 0, len: v.summary.length, invented, nums: nums.length, dropped };
    }
    rows.push(r);
  }
  for (const r of rows) console.log(JSON.stringify(r));
  console.log(JSON.stringify({ claudeCalls, claudeUsd: +claudeUsd.toFixed(4), dsCalls, dsUsd: +dsUsd.toFixed(4), dsModel }));
}
main().catch((e) => { console.error(e); process.exit(1); });
