// app/lib/__tests__/prefix-warm.test.ts
// 2026-09-29 竹内「クロードの部分、キャッシュを営業時間中温める」: 3つの前置き（最終チェック4段・お客様の要約・次の一手）が
//   ①お客様・下書き・時刻に依存せず同じ鍵（sys_key_full）になる ②本物の body と温めの body の鍵に入る部分（model・output_config・system）が同じ
//   ③材料（DB ルール・改善ルール・フロー運用ガイド）が変わった時だけ・変わるべきブロックだけ替わる ④判断・分類の閾値、を固定する。
// 実行: npx tsx app/lib/__tests__/prefix-warm.test.ts（自己完結ハーネス・env 不要。全 OK で exit 0）
import {
  splitPromptForRequest, buildFinalCheckRequestBody, buildFinalCheckWarmBodies, buildRuleCheckPrompt, type FinalCheckContext,
} from "../final-check";
import { buildCustomerSummarySystemBlocks, buildCustomerSummaryWarmBody, buildNextActionRulesNote, CUSTOMER_SUMMARY_SYSTEM } from "../customer-summary-prompt";
import { buildSuggestNextActionSystemBlocks, buildSuggestNextActionWarmBody, type SuggestNextActionPrefixInputs } from "../suggest-next-action-prompt";
import { buildPrefixWarmTargets, classifyPrefixWarmUsage, decidePrefixWarm, prefixWarmHash, PREFIX_WARM_DEFAULTS, PREFIX_WARM_HASH_PREFIX } from "../prefix-warm";
import { systemFullKey, parseAnthropicRequest } from "../llm-usage-recorder";
import { isBrainCall } from "../llm-test-mode";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const sysTexts = (b: { system?: Array<{ text: string }> }) => (b.system ?? []).map((x) => x.text);

// ── 材料（本番の形に寄せた小さな実物風）──
const dbRules = "\n\n【永久ルール（最上位・絶対厳守）】\n・少々お待ちくださいは使わない\n\n【AI学習ルール（参考）】\n・保証料の金額を作らない\n・審査の見通しを言わない";
const finalCheckRules = "・「お待たせ致しました」は指摘する";
const ctxA: FinalCheckContext = {
  dbRules, finalCheckRules, customerName: "田中", lastCustomerMessage: "内覧したいです", conversationStage: "物件提案中", tpoLabel: "前向き",
  recentMessages: [{ sender: "customer", text: "内覧したいです", createdAt: "2026-09-29T02:00:00Z" }],
  brainMeta: { action: "viewing_invite", enforcement_level: "required", reply_direction: "内覧のご案内" }, checkpointFacts: "家賃10万", customerConditionsDb: "rent_max: 100000",
};
const ctxB: FinalCheckContext = {
  dbRules, finalCheckRules, customerName: "鈴木", lastCustomerMessage: "初期費用はいくらですか", conversationStage: "ヒアリング中", tpoLabel: "費用質問",
  recentMessages: [{ sender: "customer", text: "初期費用はいくらですか", createdAt: "2026-09-29T05:00:00Z" }],
  brainMeta: { action: "estimate_sheet", enforcement_level: "recommended" }, ngProperties: ["エクセレント目黒"], clearedFacts: ["家賃8万"], isAix: false,
};

console.log("── splitPromptForRequest（固定の先頭ブロック→system・残り→user）");
{
  const cc = { type: "ephemeral" as const, ttl: "1h" as const };
  t("文字列は system なし", splitPromptForRequest("x").system === null);
  const r = splitPromptForRequest([{ type: "text", text: "a", cache_control: cc }, { type: "text", text: "b", cache_control: cc }, { type: "text", text: "c" }]);
  t("cache_control 付きの先頭2つが system・3つ目が user", r.system?.length === 2 && Array.isArray(r.user) && r.user.length === 1 && r.user[0].text === "c");
  t("cache_control が無い並びは system なし", splitPromptForRequest([{ type: "text", text: "a" }]).system === null);
  t("全部 cache_control の時は user が \".\"", splitPromptForRequest([{ type: "text", text: "a", cache_control: cc }]).user === ".");
}

console.log("── 最終チェック: 前置きは下書き・お客様・ブレイン判定に依存しない（同じ鍵）");
{
  const realA = buildFinalCheckRequestBody(buildRuleCheckPrompt("田中さんお世話になっております！！内覧のご案内をさせて頂きます！！", ctxA), "claude-haiku-4-5-20251001", 2400, { structured: true });
  const realB = buildFinalCheckRequestBody(buildRuleCheckPrompt("鈴木さん、御見積書をお送りします。", ctxB), "claude-haiku-4-5-20251001", 2400, { structured: true });
  t("rule_check: system が1ブロック・1h", realA.system?.length === 1 && realA.system[0].cache_control?.ttl === "1h");
  t("rule_check: 別のお客様・別の下書きでも system の文面が同じ", sysTexts(realA).join("\n\n") === sysTexts(realB).join("\n\n"));
  t("rule_check: user は下書き・お客様で違う", JSON.stringify(realA.messages) !== JSON.stringify(realB.messages));
  t("rule_check: user に [REPLY] と ngProperty 注記（ctxB）", JSON.stringify(realB.messages).includes("[REPLY]") && JSON.stringify(realB.messages).includes("エクセレント目黒"));
  t("rule_check: system に [RULES] の会社ルールが入る（文面はそのまま）", sysTexts(realA)[0].includes("[RULES]") && sysTexts(realA)[0].includes("保証料の金額を作らない"));
  // llm_usage_logs の記録（parseAnthropicRequest）が sys_key / sys_key_full を持てる
  const parsed = parseAnthropicRequest(JSON.stringify(realA));
  t("記録の出口が sys_key / sys_key_full / sys_head を読める", !!parsed.sys_key && !!parsed.sys_key_full && (parsed.sys_head ?? "").startsWith("返信文を以下の観点で確認してください"), parsed);
  t("output_config（構造化出力）と thinking disabled が本物の body にある", realA.output_config?.format.type === "json_schema" && realA.thinking.type === "disabled");

  const warm = buildFinalCheckWarmBodies({ dbRules, finalCheckRules });
  t("温めの body は4つ（rule_check / anomaly_scan / context_check / revision）", warm.map((w) => w.pass).join(",") === "rule_check,anomaly_scan,context_check,revision", warm.map((w) => w.pass));
  const wr = warm.find((w) => w.pass === "rule_check")!;
  t("rule_check: 温めの system が本物と一字一句同じ（鍵が同じ）", systemFullKey(wr.body.system) === systemFullKey(realA.system) && sysTexts(wr.body).join("|") === sysTexts(realA).join("|"));
  t("rule_check: 温めは model・output_config が同じで max_tokens 1・user \".\"",
    wr.body.model === realA.model && JSON.stringify(wr.body.output_config) === JSON.stringify(realA.output_config) && wr.body.max_tokens === 1 && wr.body.messages[0].content === ".");
  const wrev = warm.find((w) => w.pass === "revision")!;
  t("revision: system が2ブロック（固定の指示＋会社ルール）・output_config なし・Sonnet", wrev.body.system.length === 2 && !("output_config" in wrev.body) && wrev.model === "claude-sonnet-5");
  const wctx = warm.find((w) => w.pass === "context_check")!;
  t("context_check: 現在時刻は system に入らない（user 側）", !sysTexts(wctx.body).join("").includes("【現在時刻】") || !/\d{4}\/\d{1,2}\/\d{1,2}/.test(sysTexts(wctx.body).join("")));
  t("anomaly_scan: Haiku・1ブロック", warm.find((w) => w.pass === "anomaly_scan")!.body.system.length === 1 && warm.find((w) => w.pass === "anomaly_scan")!.model === "claude-haiku-4-5-20251001");
  // 材料が変わった時だけ鍵が変わる
  const warm2 = buildFinalCheckWarmBodies({ dbRules: dbRules + "\n・新しいルール", finalCheckRules });
  t("dbRules が変わると rule_check と revision の鍵だけ変わる（anomaly / context は同じ）",
    systemFullKey(warm2[0].body.system) !== systemFullKey(warm[0].body.system) && systemFullKey(warm2[3].body.system) !== systemFullKey(warm[3].body.system)
    && systemFullKey(warm2[1].body.system) === systemFullKey(warm[1].body.system) && systemFullKey(warm2[2].body.system) === systemFullKey(warm[2].body.system));
  const warm3 = buildFinalCheckWarmBodies({ dbRules, finalCheckRules: finalCheckRules + "\n・別の指摘" });
  t("finalCheckRules が変わると rule_check / anomaly / context の鍵が変わり revision は同じ",
    systemFullKey(warm3[0].body.system) !== systemFullKey(warm[0].body.system) && systemFullKey(warm3[1].body.system) !== systemFullKey(warm[1].body.system)
    && systemFullKey(warm3[2].body.system) !== systemFullKey(warm[2].body.system) && systemFullKey(warm3[3].body.system) === systemFullKey(warm[3].body.system));
  t("revision の会社ルールブロックは本物の同じ関数（selectRulesForCheckCached）の文面", sysTexts(wrev.body)[1].startsWith("[RULES]（会社ルール）") && sysTexts(wrev.body)[1].includes("保証料の金額を作らない"));
  t("2回作っても同じ鍵（決定性）", systemFullKey(buildFinalCheckWarmBodies({ dbRules, finalCheckRules })[0].body.system) === systemFullKey(wr.body.system));
}

console.log("── お客様の要約: SYSTEM＋改善ルールの2ブロック");
{
  const rules = ["ルールA", " ", "ルールB"];
  const b = buildCustomerSummarySystemBlocks(CUSTOMER_SUMMARY_SYSTEM, rules);
  t("2ブロック・どちらも 1h", b.length === 2 && b.every((x) => x.cache_control?.ttl === "1h"));
  t("[0] は SYSTEM そのまま", b[0].text === CUSTOMER_SUMMARY_SYSTEM && CUSTOMER_SUMMARY_SYSTEM.startsWith("あなたは賃貸仲介の営業アシスタントです。"));
  t("[1] は改善ルールの注記（空文字は落とす・--- で結ぶ・文面は旧 route と同じ）", b[1].text === "【next_action予測の改善ルール（実際の行動との差分から学習済み・next_action生成時に必ず参照すること）】\nルールA\n---\nルールB");
  t("改善ルールが無ければ1ブロック", buildCustomerSummarySystemBlocks(CUSTOMER_SUMMARY_SYSTEM, []).length === 1 && buildNextActionRulesNote([]) === "");
  t("ai_prompts の上書きがあればそれが [0]", buildCustomerSummarySystemBlocks("上書き", rules)[0].text === "上書き");
  const w = buildCustomerSummaryWarmBody(b);
  t("温め body: Sonnet 5・max_tokens 1・thinking disabled・user \".\"", w.model === "claude-sonnet-5" && w.max_tokens === 1 && w.thinking.type === "disabled" && w.messages[0].content === ".");
  t("鍵は system の文面だけで決まる（同じ材料→同じ鍵）", systemFullKey(buildCustomerSummarySystemBlocks(CUSTOMER_SUMMARY_SYSTEM, rules)) === systemFullKey(b));
}

console.log("── 次の一手: 絶対ルール＋発動条件（key 順）と、毎日替わるフロー運用ガイドを分ける");
{
  const base: SuggestNextActionPrefixInputs = {
    aixLogicRows: [{ key: "aix_logic_viewing_invite", content: "内覧: 内覧したい" }, { key: "aix_logic_application_push", content: "申込: 申し込みたい" }],
    boundaryRuleRows: [
      { rule_key: "BOUNDARY-1-gr", action_type: "generate_reply", rule_text: "住所は AIX で送る" },
      { rule_key: "BOUNDARY-1-aix", action_type: "meeting_place", rule_text: "住所は AIX で送る" },
      { rule_key: "BOUNDARY-2-aix", action_type: "viewing_invite", rule_text: "  " },
    ],
    aixFlowGuide: "ガイド v1",
  };
  const b = buildSuggestNextActionSystemBlocks(base);
  t("2ブロック・どちらも 1h", b.length === 2 && b.every((x) => x.cache_control?.ttl === "1h"));
  t("[0] は絶対ルールで始まり基本フロー→発動条件", b[0].text.startsWith("あなたは不動産営業AIのアドバイザーです。\n\n## 絶対ルール") && b[0].text.includes("不動産賃貸営業の基本フロー: ヒアリング → 物件提案 → 内覧 → 見積 → 申込 の順で顧客を次のステップへ進める。\n\n## 各AIXボタンの発動条件（管理UIで設定済み）\n"));
  t("[0] の aix_logic は key 順（application_push → viewing_invite）", b[0].text.indexOf("申込: 申し込みたい") < b[0].text.indexOf("内覧: 内覧したい"));
  t("[0] の線引きは -aix を優先し rule_text で重複排除・空は落とす", b[0].text.includes("- [meeting_place] 住所は AIX で送る") && !b[0].text.includes("[通常返信] 住所は AIX で送る") && !b[0].text.includes("[viewing_invite]"));
  t("[1] はフロー運用ガイド", b[1].text === "## AIXフロー運用ガイド（学習済み）\nガイド v1");
  const shuffled = buildSuggestNextActionSystemBlocks({ ...base, aixLogicRows: [...base.aixLogicRows].reverse() });
  t("aix_logic の DB の並びが変わっても鍵は同じ", systemFullKey(shuffled) === systemFullKey(b));
  const dayN = buildSuggestNextActionSystemBlocks({ ...base, aixFlowGuide: "ガイド v2（翌日）" });
  t("フロー運用ガイドが替わっても [0] は同じ・[1] だけ替わる", dayN[0].text === b[0].text && dayN[1].text !== b[1].text);
  const noGuide = buildSuggestNextActionSystemBlocks({ ...base, aixFlowGuide: "" });
  t("ガイドが無ければ1ブロック", noGuide.length === 1 && noGuide[0].text === b[0].text);
  t("ガイドは 1000 字で切る（旧 route と同じ）", buildSuggestNextActionSystemBlocks({ ...base, aixFlowGuide: "あ".repeat(1500) })[1].text.length === "## AIXフロー運用ガイド（学習済み）\n".length + 1000);
  const w = buildSuggestNextActionWarmBody(b);
  t("温め body: Haiku 4.5・max_tokens 1・thinking なし（本物も付けない）", w.model === "claude-haiku-4-5-20251001" && w.max_tokens === 1 && !("thinking" in w));
}

console.log("── 温めの対象（6つ）・名札・鍵・hash");
{
  const targets = buildPrefixWarmTargets({
    finalCheck: { dbRules, finalCheckRules },
    summary: { systemPrompt: CUSTOMER_SUMMARY_SYSTEM, nextActionRuleContents: ["ルールA"] },
    nextAction: { aixLogicRows: [{ key: "aix_logic_x", content: "x" }], boundaryRuleRows: [], aixFlowGuide: "g" },
  });
  t("6つ", targets.length === 6, targets.map((x) => x.name));
  t("名札は brain で始まらない（llm-test-mode.isBrainCall がブレイン扱いにしない）", targets.every((x) => !x.name.startsWith("brain") && !isBrainCall(x.name, x.body.system[0].text)));
  t("鍵は8桁の hex・llm_usage_logs の sys_key_full と同じ計算", targets.every((x) => /^[0-9a-f]{8}$/.test(x.key) && x.key === parseAnthropicRequest(JSON.stringify(x.body)).sys_key_full));
  t("本物の名札（realActions）が付いている", targets.map((x) => x.realActions[0]).join(",") === "final_check_rule_check,final_check_anomaly_scan,final_check_context_check,final_check_revision,customer_summary,suggest_next_action");
  t("hash は warm: で始まり keep-warm の候補から外れる形", targets.every((x) => prefixWarmHash(x).startsWith(PREFIX_WARM_HASH_PREFIX + x.name + ":")) && PREFIX_WARM_HASH_PREFIX === "warm:");
  t("1ブロックの対象は staticHitMinRead=Infinity・2ブロックは有限（revision 2000・summary 1500・next 4000）",
    targets[0].staticHitMinRead === Infinity && targets[3].staticHitMinRead === 2000 && targets[4].staticHitMinRead === 1500 && targets[5].staticHitMinRead === 4000);
  t("chars は system の文字数", targets.every((x) => x.chars === x.body.system.reduce((n, b) => n + b.text.length, 0) && x.chars > 0));
  t("既定: JST 9-22・1日20回", PREFIX_WARM_DEFAULTS.hoursJst === "9-22" && PREFIX_WARM_DEFAULTS.maxPerDay === 20);
}

console.log("── 判断（ブレインの温めと同じ）と usage の読み方");
{
  const NOW = Date.parse("2026-09-29T01:00:00Z"); // 10:00 JST
  const ago = (m: number) => NOW - m * 60_000;
  const d = (o: Partial<Parameters<typeof decidePrefixWarm>[0]>) => decidePrefixWarm({ nowMs: NOW, lastRealCallMs: ago(55), lastWarmedMs: null, retiredMs: null, warmedTodayCount: 0, enabled: true, altRouted: false, hoursJst: "9-22", maxPerDay: 20, ...o });
  t("55分前の本物 → warm", d({}).reason === "warm");
  t("本物の記録が無い → no_prior_call（最初の本物に書かせる）", d({ lastRealCallMs: null }).reason === "no_prior_call");
  t("59分前 → cold_skip（冷えていたら温めない）", d({ lastRealCallMs: ago(59) }).reason === "cold_skip");
  t("22:00 JST → outside_hours_jst(9-22)", d({ nowMs: Date.parse("2026-09-29T13:00:00Z") }).reason === "outside_hours_jst(9-22)");
  t("DeepSeek に回っている名札は温めない（alt_routed）", d({ altRouted: true }).reason === "alt_routed");
  t("hit: write 0・read >0", classifyPrefixWarmUsage({ cache_read: 27494, cache_write_1h: 0 }, Infinity) === "hit");
  t("cold: 1ブロックで write >0", classifyPrefixWarmUsage({ cache_read: 0, cache_write_1h: 27494 }, Infinity) === "cold");
  t("dynamic_rewrite: revision で先頭 3k 当たり・会社ルールだけ書いた", classifyPrefixWarmUsage({ cache_read: 3053, cache_write_1h: 22832 }, 2000) === "dynamic_rewrite");
  t("cold: revision で read が閾値未満", classifyPrefixWarmUsage({ cache_read: 0, cache_write_1h: 25885 }, 2000) === "cold");
  t("no_cache: 両方 0（最低長未満か cache_control が効いていない）", classifyPrefixWarmUsage({ cache_read: 0, cache_write_1h: 0 }, Infinity) === "no_cache");
  t("5m の書きも write に数える", classifyPrefixWarmUsage({ cache_read: 0, cache_write_1h: 0, cache_write_5m: 100 }, Infinity) === "cold");
}

console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed === 0 ? 0 : 1);
