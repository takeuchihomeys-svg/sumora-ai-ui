// 2026-09-24 竹内「実装する」（ブレインの前置きの温め）: 『本物と温めが同じ鍵』をテストで固定する（ずれると費用だけ増えて静かに壊れる）。
//   固定の BrainSystemInputs で buildBrainSystemBlocks → brainRequestBase → JSON.stringify → llm-usage-recorder.parseAnthropicRequest の sys_key_full が
//   brainSysKeyFull と一致すること、system 配列の形（cache_control 1h・dynamic 空ならブロック省略・thinking disabled・tools/temperature 無し）、
//   同率の actionWinRates が action_type 順で決定的に並ぶことを固定する。DB・LLM は呼ばない（brain-core の import に必要な env はダミーを入れる）。
// 実行: npx tsx app/lib/__tests__/brain-system-blocks.test.ts（自己完結ハーネス。全 OK で exit 0。import が落ちる時は npx tsx --env-file=.env.local で）
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "dummy-anon-key";
process.env.ANTHROPIC_API_KEY ||= "dummy-anthropic-key";

import { parseAnthropicRequest } from "../llm-usage-recorder";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

async function main() {
  const core = await import("../brain-core");
  const { buildBrainSystemBlocks, brainRequestBase, brainSysKeyFull, STATIC_BRAIN_SYSTEM, BRAIN_MODEL } = core;
  type Inputs = import("../brain-core").BrainSystemInputs;

  const empty: Inputs = { promptRules: [], knowledgePrinciples: [], boundaryPromptRules: [], boundaryTriggerRules: [], actionWinRates: [] };
  const full: Inputs = {
    promptRules: [{ rule_text: "来阪という語は使わない", priority: 10 }, { rule_text: "お待たせ致しましたは使わない", priority: 9 }],
    knowledgePrinciples: [{ content: "見積書は物件が届いた時だけ", importance: 10 }],
    boundaryPromptRules: [{ rule_key: "BOUNDARY-1", action_type: "estimate_sheet", rule_text: "初期費用の質問" }, { rule_key: "BOUNDARY-2", action_type: null, rule_text: "内覧日の確定" }],
    boundaryTriggerRules: [{ keyword: "BOUNDARY-X", action_type: "generate_reply", rule_text: "雑談" }],
    actionWinRates: [
      { action_type: "property_send", avg_win_rate: 0.31, total_usage: 120 },
      { action_type: "estimate_sheet", avg_win_rate: 0.25, total_usage: 80 },
      { action_type: "viewing_invite", avg_win_rate: 0.25, total_usage: 40 },
    ],
  };

  console.log("── 本物と温めが同じ鍵（sys_key_full）");
  for (const [label, inputs] of [["全部入り", full], ["全空", empty]] as const) {
    const b = buildBrainSystemBlocks(inputs);
    const body = JSON.stringify({ ...brainRequestBase(b), max_tokens: 1, messages: [{ role: "user", content: "." }] });
    const parsed = parseAnthropicRequest(body);
    t(`${label}: parseAnthropicRequest(body).sys_key_full === brainSysKeyFull(blocks)`, parsed.sys_key_full === brainSysKeyFull(b), { parsed: parsed.sys_key_full, ours: brainSysKeyFull(b) });
    t(`${label}: max_tokens は鍵に入らない（4000 でも同じ sys_key_full）`, parseAnthropicRequest(JSON.stringify({ ...brainRequestBase(b), max_tokens: 4000, messages: [{ role: "user", content: "x" }] })).sys_key_full === brainSysKeyFull(b));
    t(`${label}: model claude-sonnet-5・thinking disabled`, parsed.model === "claude-sonnet-5" && parsed.thinking_mode === "disabled");
  }

  console.log("── system 配列の形");
  {
    const e = buildBrainSystemBlocks(empty);
    t("inputs 全空 → blocks は static 1つだけ・dynamicText \"\"・system.length 1", e.blocks.length === 1 && e.dynamicText === "" && brainRequestBase(e).system.length === 1);
    t("static ブロックは cache_control ephemeral 1h", e.blocks[0].cache_control.type === "ephemeral" && e.blocks[0].cache_control.ttl === "1h" && e.blocks[0].type === "text");
    const one = buildBrainSystemBlocks({ ...empty, promptRules: [{ rule_text: "r1", priority: 1 }] });
    t("promptRules 1件だけ → system.length 2・system[1].cache_control.ttl \"1h\"", one.blocks.length === 2 && one.blocks[1].cache_control.ttl === "1h" && one.dynamicText.includes("r1"));
    const f = buildBrainSystemBlocks(full);
    t("system[0].text は inputs に依存しない（2組の inputs で同じ・STATIC_BRAIN_SYSTEM と同じ）", e.blocks[0].text === f.blocks[0].text && f.blocks[0].text === STATIC_BRAIN_SYSTEM && f.staticText === STATIC_BRAIN_SYSTEM);
    t("static は ≈26k トークン相当の長さ（15,000字以上）・冒頭が「あなたはスモラAI。」", STATIC_BRAIN_SYSTEM.length > 15_000 && STATIC_BRAIN_SYSTEM.startsWith("あなたはスモラAI。"));
    const base = brainRequestBase(f) as Record<string, unknown>;
    t("brainRequestBase に tools・temperature キーが無い・thinking.type \"disabled\"・model \"claude-sonnet-5\"", !("tools" in base) && !("temperature" in base) && (base.thinking as { type: string }).type === "disabled" && base.model === BRAIN_MODEL && BRAIN_MODEL === "claude-sonnet-5");
    t("brainRequestBase のキーは model / thinking / system の3つだけ", Object.keys(base).sort().join(",") === "model,system,thinking");
    t("dynamicText は4節を \\n\\n で結合（先頭 \\n を trim・空節は省略）", f.dynamicText.startsWith("【絶対ルール") && f.dynamicText.includes("\n\n【重要原則】") && f.dynamicText.includes("\n\n【線引きルール") && f.dynamicText.includes("\n\n【成約につながりやすいアクション"), f.dynamicText.slice(0, 200));
    t("線引きルール: action_type 付き → AIX・null / generate_reply → 自動返信禁止", f.boundaryText.includes("初期費用の質問 → AIX: estimate_sheet") && f.boundaryText.includes("内覧日の確定 → 自動返信禁止") && f.boundaryText.includes("雑談 → 自動返信禁止"));
    t("勝率表: 成約率 xx.x% (n=…) の形", f.actionWinRateText.includes("- property_send: 成約率31.0% (n=120)"));
  }

  console.log("── 決定性");
  {
    const a = buildBrainSystemBlocks(full);
    const reversed = buildBrainSystemBlocks({ ...full, actionWinRates: [...full.actionWinRates].reverse() });
    t("同じ avg_win_rate の actionWinRates を逆順で渡しても dynamicText が同じ（tie-break: action_type 昇順）", a.dynamicText === reversed.dynamicText);
    t("同率は action_type 昇順（estimate_sheet が viewing_invite より先）", a.dynamicText.indexOf("estimate_sheet: 成約率25.0%") < a.dynamicText.indexOf("viewing_invite: 成約率25.0%"));
    t("buildBrainSystemBlocks を2回呼んでも同じ文字列（純関数）", JSON.stringify(a.blocks) === JSON.stringify(buildBrainSystemBlocks(full).blocks) && brainSysKeyFull(a) === brainSysKeyFull(buildBrainSystemBlocks(full)));
    t("入力を変えれば鍵が変わる（promptRules 1件追加）", brainSysKeyFull(a) !== brainSysKeyFull(buildBrainSystemBlocks({ ...full, promptRules: [...full.promptRules, { rule_text: "新ルール", priority: 1 }] })));
    t("入力の配列を後から変えても出力は変わらない（コピーして並べている）", (() => { const arr = [...full.actionWinRates]; const b = buildBrainSystemBlocks({ ...full, actionWinRates: arr }); arr.reverse(); return b.dynamicText === a.dynamicText && JSON.stringify(arr) !== JSON.stringify(full.actionWinRates); })());
  }

  console.log(`\n${passed} OK / ${failed} NG`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
