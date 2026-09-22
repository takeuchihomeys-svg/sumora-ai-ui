// 「毎回の分析（fresh）」と「フル分析（combined）」で、LLM に渡る中身と個人情報がどう違うかを実物で比べる（読み取りのみ）
// 2026-09-23 竹内「毎回の分析とフル分析だと個人情報が渡る部分が違うってことかな？」
// ⚠ 会話には書き込まない（propertyCustomerId=null）。Claude を2回呼ぶ費用はかかる。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-layer-pii-diff.ts [--n=2]
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const N = Number(arg("n", "2"));
process.env.LLM_ALT_ACTIONS = "";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const captured: Array<{ action: string | null; text: string }> = [];
function installCapture() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url?.startsWith("https://api.anthropic.com/v1/messages") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as { system?: unknown; messages?: Array<{ content?: unknown }> };
        const headers = new Headers(init.headers ?? undefined);
        const flat = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : "";
        captured.push({ action: headers.get("x-sumora-llm-action"), text: `${flat(body.system)}\n${(body.messages ?? []).map((m) => flat(m.content)).join("\n")}` });
      } catch { /* 読めなければ素通り */ }
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}

/** 個人に関わる材料が入っているか（中身は出さない・有無と量だけ） */
const MARKERS: Array<[string, RegExp]> = [
  ["会話履歴", /会話履歴（\[AIX/],
  ["お客様の条件（エリア・家賃・間取り）", /【(?:お客様の)?(?:ご)?希望条件|条件: |エリア: /],
  ["お客様の要約（ai_summary）", /お客様の要約|ai_summary|【お客様像】/],
  ["顧客タイプ・性格", /顧客タイプ|人物像|personality/],
  ["セーブポイント", /セーブポイント|チェックポイント/],
  ["前回の全体分析", /前回(?:の)?(?:全体)?分析|prevMeta|前回確定/],
  ["成約事例（他のお客様）", /成約|勝ちパターン|類似ケース/],
  ["申込フォームの中身", /氏名[^\n：:]{0,6}[：: 　]+[^\s\[]/],
  ["携帯番号", /(?<!\d)0[789]0[-‐−ー\s]?\d{4}[-‐−ー\s]?\d{4}(?!\d)/],
];

async function main() {
  installCapture();
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: msgs } = await sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).limit(200);
  const ids = [...new Set(((msgs ?? []) as Array<{ conversation_id: string }>).map((m) => m.conversation_id))].slice(0, N * 3);
  const { data: convs } = await sb.from("conversations").select("id, status, customer_name, brain_strategy, last_brain_meta").in("id", ids);
  const pool = ((convs ?? []) as Array<{ id: string; status: string | null; customer_name: string | null; brain_strategy: unknown; last_brain_meta: unknown }>)
    .filter((c) => c.brain_strategy).sort((a, b) => a.id.localeCompare(b.id)).slice(0, N);

  for (const c of pool) {
    const texts: Record<string, string> = {};
    for (const layer of ["fresh", "combined"] as const) {
      captured.length = 0;
      try {
        await analyzeConversation(c.id, false, c.status, null, "shadow", {
          mode: layer === "fresh" ? "incremental" : "full", layer,
          strategy: (c.brain_strategy ?? null) as never, prevMeta: (c.last_brain_meta ?? undefined) as never,
          customerName: c.customer_name ?? undefined,
        });
      } catch (e) { console.log(`   ⚠ ${layer}: ${e instanceof Error ? e.message.slice(0, 60) : e}`); }
      const brainCalls = captured.filter((x) => (x.action ?? "").startsWith("brain_"));
      texts[layer] = (brainCalls.length ? brainCalls : captured).map((x) => x.text).join("\n");
    }
    console.log(`\n=== ${c.id.slice(0, 8)} ${c.status ?? ""} ===`);
    console.log(`   送信の大きさ: 毎回の分析 ${texts.fresh.length}字 ／ フル分析 ${texts.combined.length}字`);
    console.log(`   材料                                   毎回 ／ フル`);
    for (const [label, re] of MARKERS) {
      const a = re.test(texts.fresh) ? "あり" : "なし";
      const b = re.test(texts.combined) ? "あり" : "なし";
      console.log(`   ${label.padEnd(34)} ${a.padEnd(4)} ／ ${b}`);
    }
  }
  console.log(`\n※ 「あり」は材料がその層に入っていること。中身は出していない`);
}
main().catch((e) => { console.error(e); process.exit(1); });
