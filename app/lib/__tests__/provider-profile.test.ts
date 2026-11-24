// npx tsx app/lib/__tests__/provider-profile.test.ts
// 2026-11-24 作業員L（台帳 #670 の子）: 係ごとの使い方の表・版・OpenAI を呼ぶ所が全部表を通っているか
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_PROFILES, DEFAULT_VERSIONS, profileFor, profileByVersion, profileRoleOf, openaiRequestOf, examProfileVersions, openaiProfileGate, moveExamplesFirst, shapeHintOf } from "../provider-profile";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("版の名前は重ならない・既定の版は全部表にある", () => {
  const vs = PROVIDER_PROFILES.map((p) => p.version);
  assert.equal(new Set(vs).size, vs.length);
  for (const v of Object.values(DEFAULT_VERSIONS)) assert.ok(profileByVersion(v), v);
});

t("係: 名札から（ブレイン・統括・書き手・最終チェック・判定・軽い係）", () => {
  assert.equal(profileRoleOf("brain_fresh"), "brain");
  assert.equal(profileRoleOf("conductor_intake"), "conductor");
  assert.equal(profileRoleOf("reply_generate"), "writer");
  assert.equal(profileRoleOf("final_check_rule_check"), "final_check");
  assert.equal(profileRoleOf("classify_condition"), "light");
});

t("既定の版・試験の印からの版・名指しの版（知らない版は null）", () => {
  assert.equal(profileFor("openai", "reply_generate", {})?.version, "openai-writer-v1");
  assert.equal(profileFor("openai", "reply_generate", { EXAM_WRITER_GPT_NOTE: "on" })?.version, "openai-writer-v1-note");
  assert.equal(profileFor("openai", "reply_generate", { EXAM_WRITER_GPT_NOTE: "on", EXAM_WRITER_LEN_HINT: "on" })?.version, "openai-writer-v1-note-len");
  assert.equal(profileFor("openai", "brain_full", { EXAM_BRAIN_JSON_KEYS: "on" })?.version, "openai-brain-v1-keys");
  assert.equal(profileFor("openai", "reply_generate", { OPENAI_PROFILE_WRITER: "openai-writer-v1-note" })?.version, "openai-writer-v1-note");
  assert.equal(profileFor("openai", "reply_generate", { OPENAI_PROFILE_WRITER: "openai-writer-v9" }), null);
  assert.equal(profileFor("deepseek", "brain_fresh", {})?.version, "deepseek-brain-v1");
});

t("OpenAI の要求の部品: 上限の欄・temperature・深さ（env が先）・cache key・言い添え", () => {
  const w = openaiRequestOf(profileFor("openai", "reply_generate", { EXAM_WRITER_GPT_NOTE: "on" })!, { routeName: "reply_generate", maxTokens: 3000, env: {} });
  assert.deepEqual([w.maxField, w.maxTokens, w.sendTemperature, w.reasoningEffort, w.promptCacheKey], ["max_completion_tokens", 8192, false, "low", "sumora-reply_generate"]);
  assert.match(w.notes ?? "", /全然大丈夫です/);
  assert.equal(openaiRequestOf(profileFor("openai", "reply_generate", {})!, { routeName: "reply_generate", env: { EXAM_WRITER_REASONING: "medium" } }).reasoningEffort, "medium");
  const b = openaiRequestOf(profileFor("openai", "brain_full", { EXAM_BRAIN_JSON_KEYS: "on" })!, { routeName: "brain_full", maxTokens: 6000, env: {} });
  assert.equal(b.jsonObject, true);
  assert.match(b.keysNote ?? "", /reply_mode/);
  assert.equal(b.maxTokens, 12000);
});

t("DeepSeek の行は今の使い方のまま（思考を切る・待ち時間 15秒／60秒・cache key なし）", () => {
  for (const p of PROVIDER_PROFILES.filter((x) => x.provider === "deepseek")) {
    assert.equal(p.reasoning.deepseekThinking, "disabled");
    assert.deepEqual(p.timeouts, { firstTokenMs: 15_000, totalMs: 60_000 });
    assert.equal(p.cache.promptCacheKey, false);
    assert.equal(p.request.tokenField, "max_tokens");
  }
});

t("試験の答案に残す版（openai の時だけ・知らない版は unknown）", () => {
  assert.deepEqual(examProfileVersions({}), { brain: null, writer: null, unknown: [] });
  assert.deepEqual(examProfileVersions({ EXAM_WRITER_PROVIDER: "openai", EXAM_WRITER_GPT_NOTE: "on" }), { brain: null, writer: "openai-writer-v1-note", unknown: [] });
  assert.equal(examProfileVersions({ EXAM_BRAIN_PROVIDER: "openai", OPENAI_PROFILE_BRAIN: "nope" }).unknown.length, 1);
});

t("今ある直の呼び出しの印（知らない版は投げる）", () => {
  assert.equal(openaiProfileGate("openai-legacy-direct-v1").provider, "openai");
  assert.throws(() => openaiProfileGate("openai-unknown"));
  assert.throws(() => openaiProfileGate("deepseek-brain-v1"));
});

t("OpenAI の chat/completions を呼ぶ所は全部表を通っている（app/ を探す）", () => {
  const root = join(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === "__tests__" || f === "node_modules") continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
  walk(root);
  const callers = files.filter((f) => { const s = readFileSync(f, "utf8"); return /api\.openai\.com\/v1\/chat\/completions|OPENAI_CHAT_ENDPOINT/.test(s) && !/provider-profile\.ts$/.test(f); });
  assert.ok(callers.length >= 3, `呼ぶ所が見つからない（${callers.length}）`);
  for (const f of callers) {
    const s = readFileSync(f, "utf8");
    assert.ok(/from ["'][^"']*provider-profile["']/.test(s) && /(openaiRequestOf|openaiProfileGate|profileFor)\(/.test(s), `${f.slice(root.length)} が使い方の表を通っていない`);
  }
});

t("v2: 手本の塊を system の先頭に（見出しが無ければそのまま）", () => {
  const sys = ["【指示】Aをする", "【場面別・正しいスモラスタイル例文】", "「質問」", "→ 答え！！", "", "【別の決まり】Bをする"].join("\n");
  const out = moveExamplesFirst(sys);
  assert.ok(out.startsWith("【竹内さんの文の手本"));
  assert.match(out, /→ 答え！！/);
  assert.ok(out.indexOf("【指示】") > out.indexOf("答え"));
  assert.ok(out.includes("【別の決まり】Bをする"));
  assert.equal(moveExamplesFirst("手本なし"), "手本なし");
  assert.equal(profileFor("openai", "reply_generate", { OPENAI_PROFILE_WRITER: "openai-writer-v2-note" })?.cache.examplesFirst, true);
});

t("v2: 詳しさ（verbosity）と文の形の版", () => {
  const v = openaiRequestOf(profileByVersion("openai-writer-v2-verb-high")!, { routeName: "reply_generate", env: {} });
  assert.equal(v.verbosity, "high");
  assert.equal(openaiRequestOf(profileByVersion("openai-writer-v1")!, { routeName: "reply_generate", env: {} }).verbosity, null);
  assert.equal(openaiRequestOf(profileByVersion("openai-writer-v2-shape")!, { routeName: "reply_generate", env: {} }).shapeHint, true);
  const u = ["前の文", "【竹内さんの近い番の組み立て（場面が同じ・文は写さない）】", "並び: greet > uke > close", "1. greet: …"].join(String.fromCharCode(10));
  assert.match(shapeHintOf(u) ?? "", /3つの段（greet→uke→close）/);
  assert.equal(shapeHintOf("並びなし"), null);
});

console.log(`provider-profile: ${n} ok`);
