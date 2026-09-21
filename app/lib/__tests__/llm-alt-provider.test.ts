// app/lib/__tests__/llm-alt-provider.test.ts
// 2026-09-19 竹内「この方向性でいく」＝ 返信文 → 分類 → ブレイン の順に DeepSeek へ替え、学習は Claude のまま。
// 実行: npx tsx app/lib/__tests__/llm-alt-provider.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import {
  readAltConfig, shouldRouteAlt, resolveRouteName, toOpenAIBody, fromOpenAIResponse, flattenContent, ROUTE_MARKERS,
  isAutoSendCall, isPostApplyCall, isPostApplyStatus, willRouteAlt, createSseConverter,
  DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_FLASH_MODEL,
} from "../llm-alt-provider";
import { LLM_AUTO_SEND_HEADER, LLM_POST_APPLY_HEADER } from "../llm-usage-recorder";
import { AIX_SHARED_SYSTEM_PREFIX, buildSystemBlocks } from "../aix-system-blocks";
import { createMasker } from "../pii-pseudonym";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const AZURE: Record<string, string | undefined> = {
  LLM_ALT_PROVIDER: "azure",
  AZURE_AI_ENDPOINT: "https://x.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  AZURE_AI_KEY: "key",
  AZURE_AI_MODEL: "DeepSeek-V4-Flash",
  LLM_ALT_ACTIONS: "reply_generate",
};

console.log("── ★ 設定が欠けていたら何もしない（今までどおり Anthropic）");
{
  t("そろっていれば有効", readAltConfig(AZURE) !== null);
  for (const key of ["AZURE_AI_ENDPOINT", "AZURE_AI_KEY", "AZURE_AI_MODEL", "LLM_ALT_ACTIONS"]) {
    const env = { ...AZURE };
    delete env[key];
    t(`${key} が無ければ null（切り替えない）`, readAltConfig(env) === null);
  }
  t("空の環境では null", readAltConfig({}) === null);
  t("provider の指定が無ければ null", readAltConfig({ ...AZURE, LLM_ALT_PROVIDER: "" }) === null);
  t("知らない provider は null", readAltConfig({ ...AZURE, LLM_ALT_PROVIDER: "openai" }) === null);
  t("bedrock は AWS の鍵がそろって初めて有効",
    readAltConfig({ LLM_ALT_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1", BEDROCK_DEEPSEEK_MODEL_ID: "m", LLM_ALT_ACTIONS: "a", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" }) !== null
    && readAltConfig({ LLM_ALT_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1", BEDROCK_DEEPSEEK_MODEL_ID: "m", LLM_ALT_ACTIONS: "a" }) === null);
}

console.log("── ★ 順番に替えられる（返信文 → 分類 → ブレイン）");
{
  // 返信生成・ブレインは x-sumora-llm-action を持たないので、system の先頭で見分ける
  t("★ 返信文の生成 → reply_generate", resolveRouteName(null, "【指示の優先順位（競合時はこの順で解決すること）】ハードゲート…") === "reply_generate");
  t("★ ブレイン（次の1アクション） → brain", resolveRouteName(null, "あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを…") === "brain");
  t("★ ブレイン（戦略の整理） → brain", resolveRouteName(null, "あなたは賃貸仲介（スモラ）の LINE 接客の「会話全体の戦略」を整理する担当です。") === "brain");
  t("それ以外 → classify", resolveRouteName(null, "あなたは不動産営業AIのアドバイザーです。") === "classify");
  t("AIX は action の名前をそのまま使う", resolveRouteName("property_send", "なんでも") === "property_send");

  const cfg = readAltConfig(AZURE)!;   // LLM_ALT_ACTIONS=reply_generate
  t("★ 返信文だけ替わる", shouldRouteAlt(cfg, "reply_generate"));
  t("★ ブレインは替わらない（竹内さんの方針: シャドーで確かめてから）", !shouldRouteAlt(cfg, "brain"));
  t("★ 分類も替わらない", !shouldRouteAlt(cfg, "classify"));
  t("AIX も替わらない", !shouldRouteAlt(cfg, "property_send"));

  const step2 = readAltConfig({ ...AZURE, LLM_ALT_ACTIONS: "reply_generate,classify" })!;
  t("2段階目: 分類も足せる", shouldRouteAlt(step2, "classify") && !shouldRouteAlt(step2, "brain"));
  t("★ 「all」という指定は無い（全部いっぺんに替えない）", !shouldRouteAlt(readAltConfig({ ...AZURE, LLM_ALT_ACTIONS: "all" })!, "brain"));
  t("設定が無ければ常に false", !shouldRouteAlt(null, "reply_generate"));
}

console.log("── ★ 自動返信オンの会話は、何を指定していても Claude のまま（2026-09-19 竹内）");
{
  // 人の目を通さずに送る文なので、LLM_ALT_ACTIONS に何を書いていても別のクラウドに回さない
  const h = (v?: string) => { const x = new Headers(); if (v !== undefined) x.set(LLM_AUTO_SEND_HEADER, v); return x; };
  t("★ 印があれば自動返信の下書き（切り替えない）", isAutoSendCall(h("1")));
  t("true でも同じ", isAutoSendCall(h("true")));
  t("印が無ければ通常の下書き", !isAutoSendCall(h()));
  t("0 は自動返信ではない", !isAutoSendCall(h("0")));
  t("空文字は自動返信ではない", !isAutoSendCall(h("")));
  // 返信文を切り替える設定でも、自動返信の会話は守られる（実装では isAutoSendCall を先に見る）
  const cfg = readAltConfig({ ...AZURE, LLM_ALT_ACTIONS: "reply_generate" })!;
  t("★ 設定上は返信文を切り替える指定でも…", shouldRouteAlt(cfg, "reply_generate"));
  t("★ …自動返信の印があれば回さない（印の判定が先）", isAutoSendCall(h("1")));
}

console.log("── ★ 申込以降は渡さない（竹内「申込までのツールなので」・スイッチは用意しない）");
{
  const h = (v?: string) => { const x = new Headers(); if (v !== undefined) x.set(LLM_POST_APPLY_HEADER, v); return x; };
  t("★ 印があれば申込以降（切り替えない）", isPostApplyCall(h("1")));
  t("true でも同じ", isPostApplyCall(h("true")));
  t("印が無ければ申込前", !isPostApplyCall(h()));
  t("0 は申込以降ではない", !isPostApplyCall(h("0")));

  // 状態の集合は conversation-status を正とする（同じ事実を2か所に置かない）
  for (const s of ["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost", "lost"]) {
    t(`★ ${s} は申込以降`, isPostApplyStatus(s));
  }
  for (const s of ["hearing", "condition_hearing", "property_search", "proposing", "property_recommendation", "availability_check", "estimate_request", "viewing", "first_reply", ""]) {
    t(`${s || "(空)"} は申込前`, !isPostApplyStatus(s));
  }
  t("null / undefined は申込前（既定）", !isPostApplyStatus(null) && !isPostApplyStatus(undefined));

  const provider = readFileSync("app/lib/llm-alt-provider.ts", "utf8");
  t("★ fetch の入口で申込以降なら Anthropic へ戻している",
    /isPostApplyCall\(headers\)\)\s*return original/.test(provider),
    "この1行が消えると申込以降の会話が別クラウドに流れる");
  t("★ 申込以降には「開くスイッチ」を作っていない",
    !/LLM_ALT_POST_APPLY/.test(provider), "竹内『申込までのツールなので』＝開ける必要が無い");
}

console.log("── ★ DeepSeek 本家（OpenAI 互換・Azure と同じ変換で通る）");
{
  t("★ DEEPSEEK_API_KEY があれば有効",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "property_recommendation" })?.provider === "deepseek");
  t("★ 宛先は api.deepseek.com の chat/completions",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "a" })?.endpoint === DEEPSEEK_ENDPOINT);
  // 竹内「deepseek-v4-proで文生成した方が良いね V4.1よりも」
  //   実測（AIX 30日118回）: 今の Sonnet $8.46 → Pro $3.46 / Flash $0.78。差は月$2.7 なので質を取る
  t("★ 文生成の既定は deepseek-v4-pro",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "a" })?.model === DEEPSEEK_DEFAULT_MODEL
    && DEEPSEEK_DEFAULT_MODEL === "deepseek-v4-pro");
  t("安い方（V4.1-Flash）にも切り替えられる",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: DEEPSEEK_FLASH_MODEL, LLM_ALT_ACTIONS: "a" })?.model === "deepseek-flash");
  t("★ 鍵が無ければ null（今までどおり Anthropic）",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", LLM_ALT_ACTIONS: "a" }) === null);
  // 竹内「AIX用と返信用分けた方が良いかな？」: DEEPSEEK_API_KEY は既に物件評価・駅名解決が使っている
  t("★ 専用の鍵（LLM_ALT_DEEPSEEK_KEY）があればそちらを使う＝費用が混ざらない",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "old", LLM_ALT_DEEPSEEK_KEY: "aix", LLM_ALT_ACTIONS: "a" })?.apiKey === "aix");
  t("専用の鍵が無ければ既存の DEEPSEEK_API_KEY を使う",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "old", LLM_ALT_ACTIONS: "a" })?.apiKey === "old");
  // 2026-09-21 竹内「自動返信の部分もDeepsheekに切り替える」→ 自動返信の歯止めは外した（既定 開）。
  //   申込以降の歯止めは残っている（別のテストで確かめる）。
  t("★ 自動返信は DeepSeek でも回る（竹内 2026-09-21 の判断・既定 開）",
    readAltConfig({ LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "a" })?.allowAutoSend === true);
}

console.log("── ★ プロンプトキャッシュ: 前置きが変わらないこと（竹内「今の仕組とおなじように」）");
{
  // DeepSeek のコンテキストキャッシュは「前置きの完全一致」で効く（一致は不一致の 1/30〜1/50 の値段）。
  // Anthropic の cache_control は変換で捨てるが、**ブロックの順番はそのまま**なので
  // 静的（shared → semiStatic → routeStatic）→ 動的、という今の構成がそのまま効く。
  // ここが崩れると「効かなくなったことに誰も気付かない」ので、変換の前後で前置きを照合する。
  const shared = AIX_SHARED_SYSTEM_PREFIX;
  const blocksFor = (dyn: string) => buildSystemBlocks(
    { shared, semiStatic: "【永久ルール】".padEnd(2000, "あ"), routeStatic: "【物件オススメ】".padEnd(2000, "い") },
    { dynamicSuffix: dyn },
  );
  const bodyFor = (dyn: string) => toOpenAIBody(
    { system: blocksFor(dyn), messages: [{ role: "user", content: [{ type: "text", text: dyn }] }], max_tokens: 500 } as Parameters<typeof toOpenAIBody>[0],
    "deepseek-v4-pro",
  ) as { messages: Array<{ role: string; content: string }> };

  const a = bodyFor("【お客様】田中さん 090-1111-2222");
  const b = bodyFor("【お客様】佐藤さん 080-3333-4444");
  const sysA = a.messages.find((m) => m.role === "system")!.content;
  const sysB = b.messages.find((m) => m.role === "system")!.content;

  t("★ 変換後の system は全経路共通の前置きで始まる（ここが一致するとキャッシュが効く）",
    sysA.startsWith(shared), sysA.slice(0, 40));
  t("★ 顧客が違っても前置きは1バイトも変わらない",
    sysA.slice(0, shared.length + 4000) === sysB.slice(0, shared.length + 4000));
  t("★ 動的な所は system の**末尾**にある（前に来ると前置きが顧客ごとに割れる）",
    sysA.endsWith("【お客様】田中さん 090-1111-2222"), sysA.slice(-40));
  t("★ 静的な部分が入力の大半（AIX の共通前置きだけで 4万トークン規模）",
    shared.length > 40_000, `${shared.length} 字`);

  // 読み替えを掛けても前置きが変わらないこと（マスクは dynamic だけに当てる設計）
  const m1 = createMasker({ conversationId: "conv-A", customerName: "田中", thisYear: 2026 });
  const m2 = createMasker({ conversationId: "conv-A", customerName: "田中", thisYear: 2026 });
  t("★ 同じ会話なら読み替えの結果も毎回同じ（違うとキャッシュが毎回割れる）",
    m1.mask("田中さん 090-1111-2222") === m2.mask("田中さん 090-1111-2222"));
  const masked = bodyFor(m1.mask("【お客様】田中さん 090-1111-2222"));
  t("★ 読み替えても前置きは変わらない（触るのは動的な所だけ）",
    (masked.messages.find((m) => m.role === "system")!.content).startsWith(shared));

  // 2026-09-19 竹内「AIX用と返信用分けた方が良いかな？プロンプトキャッシュ用などに」を調べて分かった罠:
  //   DeepSeek のキャッシュは**アカウント単位**なので API キーを分けても共有される（分けて良い）。
  //   ただし user_id を渡すと**わざとキャッシュを分離する**仕様があり、顧客ごとに渡すと
  //   共通の前置き4万トークンが顧客ごとに別キャッシュになって効果が消える。
  //   「顧客ごとに分けた方が安全では」と後から足されると静かに高くなるので、ここで塞ぐ。
  const raw = bodyFor("x") as unknown as Record<string, unknown>;
  t("★ user_id を渡していない（渡すとキャッシュが顧客ごとに割れる）",
    !("user_id" in raw) && !("user" in raw), JSON.stringify(Object.keys(raw)));
  const provider = readFileSync("app/lib/llm-alt-provider.ts", "utf8");
  t("★ コードのどこでも user_id を送っていない",
    !/user_id/.test(provider), "キャッシュを分離する指定なので足さない");
}

console.log("── ★ willRouteAlt: 呼び出し側が「マスクするか」を決める（歯止めと同じ条件を見る）");
{
  const env = { LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "property_recommendation,property_send" };
  t("★ 指定した AIX は回る＝マスクする", willRouteAlt("property_recommendation", {}, env));
  t("指定していない AIX は回らない＝マスクしない", !willRouteAlt("estimate_sheet", {}, env));
  t("★ 申込以降は回らない（マスク以前に送らない）", !willRouteAlt("property_recommendation", { postApply: true }, env));
  // 2026-09-21 竹内「自動返信の部分もDeepsheekに切り替える」→ 既定で回る
  t("★ 自動返信も既定で回る", willRouteAlt("property_recommendation", { autoSend: true }, env));
  t("LLM_ALT_AUTO_SEND=off なら自動返信は Claude のまま（戻し道）",
    !willRouteAlt("property_recommendation", { autoSend: true }, { ...env, LLM_ALT_AUTO_SEND: "off" }));
  t("★ 設定が無ければ回らない＝今までどおり Claude・マスクもしない", !willRouteAlt("property_recommendation", {}, {}));
  t("action が無ければ回らない", !willRouteAlt(null, {}, env));
}

console.log("── ★ 自動返信も DeepSeek に回す（竹内 2026-09-21「自動返信の部分もDeepsheekに切り替える」）");
{
  // 2026-09-19 竹内「慣れて問題なければ切り変えていく」→ 既定は閉で作った。
  // 2026-09-21 竹内「自動返信の部分もDeepsheekに切り替える。そうすれば変にAPI消費することもないので」
  //   → **既定を開に反転**。Vercel の環境変数は権限が無くて設定できない（403）ので、
  //     設計知見「環境変数を入れなくても正しく動く既定値にする」に従いコードの既定を変えた。
  t("★ 既定は開（環境変数を書かなくても自動返信が DeepSeek に回る）",
    readAltConfig(AZURE)!.allowAutoSend === true);
  t("★ off と書けば閉まる（戻し道）",
    readAltConfig({ ...AZURE, LLM_ALT_AUTO_SEND: "off" })!.allowAutoSend === false);
  t("OFF（大文字）・前後の空白でも閉まる",
    readAltConfig({ ...AZURE, LLM_ALT_AUTO_SEND: " OFF " })!.allowAutoSend === false);
  t("on と書けば開く（今までどおり）",
    readAltConfig({ ...AZURE, LLM_ALT_AUTO_SEND: "on" })!.allowAutoSend === true);
  t("bedrock 側にも同じスイッチがある",
    readAltConfig({ LLM_ALT_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1", BEDROCK_DEEPSEEK_MODEL_ID: "m", LLM_ALT_ACTIONS: "a", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" })!.allowAutoSend === true);
  // ⚠ 歯止めは残っている: 申込以降は回らない／対象は LLM_ALT_ACTIONS に書いた経路だけ
  t("★ 申込以降は自動返信でも回らない（歯止めは外していない）",
    !willRouteAlt("property_recommendation", { postApply: true, autoSend: true }, { LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "property_recommendation" }));
  t("★ LLM_ALT_ACTIONS に無い経路は自動返信でも回らない",
    !willRouteAlt("estimate_sheet", { autoSend: true }, { LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "property_recommendation" }));

  // 実装の順番（印を先に見て、開いていなければ即戻す）が残っているか実ファイルで確かめる
  const provider = readFileSync("app/lib/llm-alt-provider.ts", "utf8");
  t("★ fetch の入口で「印あり かつ 閉」なら Anthropic へ戻している",
    /isAutoSendCall\(headers\)\s*&&\s*!cfg\.allowAutoSend/.test(provider),
    "この1行が消えると自動返信が黙って別クラウドに流れる");
}

console.log("── ★ 切り替えの判断材料（どの会話の下書きを、どのモデルが作ったか）");
{
  // 竹内「性質理解して穴を防げるようになったら」を判断するには、後から会話ごとに追える必要がある。
  // 自動返信はスタッフが下書きを直さないので ai_reply_examples の一致度では測れない。
  // せめて llm_usage_logs に会話 ID を残し、「この会話の下書きはどのモデルか」を辿れるようにする。
  const replyRoute = readFileSync("app/api/generate-reply/route.ts", "utf8");
  t("★ 返信生成が会話 ID の印も付けている（今まで付いていなかった）",
    /\[LLM_CONVERSATION_HEADER\]:\s*conversationId/.test(replyRoute),
    "app/api/generate-reply/route.ts で LLM_CONVERSATION_HEADER を付けること");
  const recorder = readFileSync("app/lib/llm-usage-recorder.ts", "utf8");
  t("★ 会話 ID は llm_usage_logs に記録され、Anthropic には送られない",
    /conversation_id/.test(recorder) && /copy\.delete\(LLM_CONVERSATION_HEADER\)/.test(recorder));
}

console.log("── ★ 見分けの語が実際のプロンプトと合っているか（静かに壊れるのを防ぐ）");
{
  // プロンプトの冒頭を書き換えると判定が外れ、気づかないうちに切り替えの対象が変わる。
  // ここで実ファイルと照合しておけば、文面を変えた時にこのテストが落ちて気付ける。
  const replyRoute = readFileSync("app/api/generate-reply/route.ts", "utf8");
  t("★ 返信生成の system 先頭（priorityOrderNote）に『ハードゲート』がある",
    new RegExp(`priorityOrderNote\\s*=\\s*"【指示の優先順位[^"]*${ROUTE_MARKERS.reply_generate}`).test(replyRoute),
    "app/api/generate-reply/route.ts の priorityOrderNote を変えたらここも直す");

  const brainCore = readFileSync("app/lib/brain-core.ts", "utf8");
  t("★ ブレインのプロンプトに『スモラAI』か『会話全体の戦略』がある",
    ROUTE_MARKERS.brain.some((m) => brainCore.includes(m)),
    "app/lib/brain-core.ts のプロンプト冒頭を変えたらここも直す");

  const aixTemplate = readFileSync("app/api/aix-template-generate/route.ts", "utf8");
  t("★ AIX テンプレ生成に『ハルシネーション絶対禁止』がある（返信文と混ざらない）",
    aixTemplate.includes(ROUTE_MARKERS.aix_template));

  // 自動返信の印が、返信生成の呼び出しに実際に付いているか（付け忘れると守れない）
  t("★ 返信生成が自動返信の会話に印を付けている",
    /auto_send_enabled/.test(replyRoute) && /\[LLM_AUTO_SEND_HEADER\]:\s*"1"/.test(replyRoute),
    "app/api/generate-reply/route.ts で auto_send_enabled を読んで LLM_AUTO_SEND_HEADER を付けること");
  t("★ 修正ループ（再生成）にも同じ印が付いている",
    (replyRoute.match(/createGenerationModel\(\{ defaultHeaders: autoSendHeaders \}\)/g) ?? []).length >= 2,
    "1回目の生成と修正ループの両方に付ける");

  const recorder = readFileSync("app/lib/llm-usage-recorder.ts", "utf8");
  t("★ 印は Anthropic に送る前に取り除かれる",
    recorder.includes("LLM_AUTO_SEND_HEADER") && /copy\.delete\(LLM_AUTO_SEND_HEADER\)/.test(recorder));

  // 実データ（llm_usage_logs の sys_head）そのままで判定を確かめる
  t("★ 実データ: 返信生成 → reply_generate",
    resolveRouteName(null, "【指示の優先順位（競合時はこの順で解決すること）】ハードゲート（内覧日時・見積・物件事実制約）> 場面と返信方針") === "reply_generate");
  t("★ 実データ: AIX テンプレ生成 → aix_template（返信文と混ざらない）",
    resolveRouteName(null, "【指示の優先順位（競合時はこの順で解決すること）】 ハルシネーション絶対禁止 > 役割") === "aix_template");
  t("★ 実データ: ブレイン → brain",
    resolveRouteName(null, "あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを2") === "brain");
  t("★ 実データ: 戦略の整理 → brain",
    resolveRouteName(null, "あなたは賃貸仲介（スモラ）の LINE 接客の「会話全体の戦略」を整理する担当です。") === "brain");
  t("★ 実データ: AIX 本文生成は action 名で分かれる（system が同じでも混ざらない）",
    resolveRouteName("property_send", "あなたはスモラ（賃貸仲介）のLINE営業担当です。 お客様へのLINE返信を") === "property_send");
  t("★ 実データ: 画像の読み取りは classify（そもそも画像なので対象外になる）",
    resolveRouteName(null, "以下の画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文・") === "classify");
}

console.log("── Anthropic の形 → Azure（OpenAI 互換）の形");
{
  const body = {
    system: [{ type: "text", text: "あなたはスモラの担当者です" }, { type: "text", text: "追加の指示" }],
    messages: [{ role: "user", content: "初期費用はいくらですか？" }],
    max_tokens: 800, temperature: 0.3,
  };
  const o = toOpenAIBody(body, "DeepSeek-V4-Flash") as { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number; temperature: number };
  t("system は先頭の1件にまとめる", o.messages[0].role === "system" && o.messages[0].content === "あなたはスモラの担当者です\n追加の指示");
  t("user が続く", o.messages[1].role === "user" && o.messages[1].content === "初期費用はいくらですか？");
  t("model はデプロイ名", o.model === "DeepSeek-V4-Flash");
  t("max_tokens / temperature が移る", o.max_tokens === 800 && o.temperature === 0.3);
}

console.log("── ★ 思考モードを切る（実際に叩いて分かった穴・2026-09-19）");
{
  // DeepSeek V4 は思考モードが既定でオン（effort=high）。思考は reasoning_content に入るが
  // **max_tokens は思考ぶんも食う**。max_tokens=64 で試したら思考だけで使い切って本文が空だった。
  // AIX の max_tokens は 256〜1500 なので、そのままだと空の下書きが返ることがある。
  const src = { system: "s", messages: [{ role: "user", content: "u" }], max_tokens: 256, thinking: { type: "disabled" as const } };
  const ds = toOpenAIBody(src as Parameters<typeof toOpenAIBody>[0], "deepseek-v4-pro", { disableThinking: true })!;
  t("★ DeepSeek 宛ては thinking を切る", JSON.stringify(ds.thinking) === JSON.stringify({ type: "disabled" }));
  const noSpec = toOpenAIBody({ system: "s", messages: [{ role: "user", content: "u" }] } as Parameters<typeof toOpenAIBody>[0], "deepseek-v4-pro", { disableThinking: true })!;
  t("★ 呼び出し側が指定していなくても切る（既定オンなので黙って本文が空になる）",
    JSON.stringify(noSpec.thinking) === JSON.stringify({ type: "disabled" }));
  const enabled = toOpenAIBody({ system: "s", messages: [{ role: "user", content: "u" }], thinking: { type: "enabled" } } as Parameters<typeof toOpenAIBody>[0], "deepseek-v4-pro", { disableThinking: true })!;
  t("呼び出し側が明示的に思考させたい時はその指定を尊重する",
    JSON.stringify(enabled.thinking) === JSON.stringify({ type: "enabled" }));
  const azure = toOpenAIBody(src as Parameters<typeof toOpenAIBody>[0], "DeepSeek-V4-Pro")!;
  t("★ Azure には付けない（知らない項目で 400 を返す相手がいる）", !("thinking" in azure));

  const provider = readFileSync("app/lib/llm-alt-provider.ts", "utf8");
  t("★ DeepSeek の時だけ切る指定を渡している",
    /disableThinking: cfg\.provider === "deepseek"/.test(provider));
}

console.log("── ★ 別クラウドの呼び出しも llm_usage_logs に残す（本番の検証で見つけた穴）");
{
  // fetch の出口の記録は api.anthropic.com 宛てだけを見ている。llm-alt-provider は
  // Anthropic 宛てを横取りして DeepSeek の URL を叩くので、切り替わった分は1行も残らなかった
  // （費用も質も後から追えない＝静かに壊れる）。
  const provider = readFileSync("app/lib/llm-alt-provider.ts", "utf8");
  t("★ 成功した呼び出しを記録している", /recordAltUsage\(\{[\s\S]{0,300}?status: 200/.test(provider));
  t("★ 失敗した呼び出しも記録している（フォールバックの回数が数えられる）",
    /errorType: "alt_failed"/.test(provider));
  t("★ action と会話 ID を残している（どの AIX・どの会話かを後から追える）",
    /action: routeName, conversationId/.test(provider));
  t("★ 応答を clone してから読む（本来の応答を壊さない）", /res\.clone\(\)/.test(provider));

  const recorder = readFileSync("app/lib/llm-usage-recorder.ts", "utf8");
  t("★ 書き込みの口は recorder 側に1つだけ置いている（記録の仕組みを2か所に分けない）",
    /export function recordAltUsage/.test(recorder) && /altRecorder = deps/.test(recorder));
  t("★ キャッシュ一致を cache_read に入れている",
    /cache_read: num\(input\.usage\.cache_read_input_tokens\)/.test(recorder));
}

console.log("── ★ 1文字ずつの形（返信文の生成）を Anthropic の形に組み直す");
{
  // 2026-09-19 竹内「返信の部分も deepseek に切り替えよかな」
  //   返信文は .stream() で呼ぶ。呼び出し側は LangChain の ChatAnthropic で Anthropic のイベント名しか読めない。
  //   ここがズレると「生成が途中で止まる・空になる」という形で静かに壊れるのでテストで固定する。
  const c = createSseConverter("deepseek-v4-pro");
  const ev: string[] = [];
  ev.push(...c.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "かしこ" } }] })}`));
  ev.push(...c.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "まりました！！" } }] })}`));
  ev.push(...c.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 12, prompt_cache_hit_tokens: 30000, prompt_cache_miss_tokens: 400 } })}`));
  ev.push(...c.push("data: [DONE]"));
  ev.push(...c.end());
  const all = ev.join("");
  t("★ message_start から始まる", all.startsWith("event: message_start\ndata: {"), all.slice(0, 40));
  t("★ content_block_start が1回だけ出る", (all.match(/event: content_block_start/g) ?? []).length === 1);
  t("★ 文字が text_delta で出る", /"type":"text_delta","text":"かしこ"/.test(all) && /"text":"まりました！！"/.test(all));
  t("★ content_block_stop → message_delta → message_stop の順で閉じる",
    all.indexOf("content_block_stop") < all.indexOf("message_delta") && all.indexOf("message_delta") < all.indexOf("message_stop"));
  t("★ 終わり方（stop_reason）が入る", /"stop_reason":"end_turn"/.test(all));
  t("★ 出力トークン数が message_delta に入る", /"usage":\{"output_tokens":12\}/.test(all));
  t("★ [DONE] は何も出さない（Anthropic には無いイベント）", !all.includes("[DONE]"));
  t("★ キャッシュ一致を拾える（記録に残すため）",
    c.usage().cache_read_input_tokens === 30000 && c.usage().input_tokens === 400 && c.usage().output_tokens === 12);

  const c2 = createSseConverter("m");
  const empty = [...c2.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`), ...c2.end()].join("");
  t("★ 1文字も来なくても形を壊さない（message_start 〜 message_stop が揃う）",
    empty.includes("message_start") && empty.includes("content_block_start") && empty.includes("message_stop"));

  const c3 = createSseConverter("m");
  t("data 以外の行（コメント・空行）は無視する", c3.push(": ping").length === 0 && c3.push("").length === 0);
  t("壊れた JSON でも落ちない", c3.push("data: {壊れている").length === 0);
  t("★ 長さで切れたら max_tokens にする",
    [...c3.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "あ" }, finish_reason: "length" }] })}`), ...c3.end()].join("").includes('"stop_reason":"max_tokens"'));
  t("end() を2回呼んでも二重に閉じない", c3.end().length === 0);

  // 本文の変換側: stream を通す時だけ stream:true を付ける
  const src = { system: "s", messages: [{ role: "user", content: "u" }], stream: true, max_tokens: 500 };
  t("★ 通してよい相手なら stream を付けて渡す",
    (toOpenAIBody(src as Parameters<typeof toOpenAIBody>[0], "deepseek-v4-pro", { allowStream: true }) as Record<string, unknown>)?.stream === true);
  t("★ usage を最後に返してもらう指定を付ける（記録のため）",
    JSON.stringify((toOpenAIBody(src as Parameters<typeof toOpenAIBody>[0], "m", { allowStream: true }) as Record<string, unknown>)?.stream_options) === JSON.stringify({ include_usage: true }));
  t("★ 変換を用意していない相手（Bedrock 等）は今までどおり対象外",
    toOpenAIBody(src as Parameters<typeof toOpenAIBody>[0], "m") === null);

  const provider = readFileSync("app/lib/llm-alt-provider.ts", "utf8");
  t("★ 1文字ずつを通すのは DeepSeek だけ", /const allowStream = cfg\.provider === "deepseek"/.test(provider));
  t("★ 途中で切れても形を閉じる（呼び出し側の parser を壊さない）",
    /catch \(e\)[\s\S]{0,200}?conv\.end\(\)/.test(provider));
}

console.log("── ★ 対象外はそのまま Anthropic へ（null を返す）");
{
  t("ストリーミングは対象外", toOpenAIBody({ stream: true, messages: [{ role: "user", content: "x" }] }, "m") === null);
  t("★ 画像つき（Vision）は対象外",
    toOpenAIBody({ messages: [{ role: "user", content: [{ type: "image" }, { type: "text", text: "この物件" }] }] }, "m") === null);
  t("messages が空なら対象外", toOpenAIBody({ messages: [] }, "m") === null);
  t("system だけで user が無ければ対象外", toOpenAIBody({ system: "x", messages: [] }, "m") === null);
  t("flattenContent: 画像ブロックがあれば null", flattenContent([{ type: "image" }]) === null);
}

console.log("── 応答は Anthropic の形に戻す（呼び出し側は違いに気付かない）");
{
  const r = fromOpenAIResponse({
    choices: [{ message: { content: "かしこまりました！！" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
  }, "DeepSeek-V4-Flash");
  t("content[0].text に本文", eq((r.content as Array<{ text: string }>)[0].text, "かしこまりました！！"));
  t("type/role が Anthropic と同じ", r.type === "message" && r.role === "assistant");
  // 2026-09-19 竹内「プロンプトキャッシュも使う」: DeepSeek は usage に一致/不一致を返す。
  // ここで Anthropic の形（cache_read_input_tokens）に移さないと、全部が新規入力として記録され
  // 「キャッシュが効いているか」を後から確かめられない（一致は不一致の50分の1の値段）
  const ds = fromOpenAIResponse({
    choices: [{ message: { content: "はい" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12000, completion_tokens: 90, prompt_cache_hit_tokens: 11000, prompt_cache_miss_tokens: 1000 },
  }, "deepseek-flash") as { usage: Record<string, number> };
  t("★ キャッシュ一致が cache_read_input_tokens に入る", ds.usage.cache_read_input_tokens === 11000);
  t("★ 新規入力は「不一致」の方（prompt_tokens ではない）", ds.usage.input_tokens === 1000);
  t("★ DeepSeek はキャッシュ書き込みを別課金しない（0）", ds.usage.cache_creation_input_tokens === 0);
  const noCache = fromOpenAIResponse({
    choices: [{ message: { content: "はい" } }], usage: { prompt_tokens: 500, completion_tokens: 10 },
  }, "x") as { usage: Record<string, number> };
  t("キャッシュの情報が無い相手（Azure 等）は今までどおり prompt_tokens を使う",
    noCache.usage.input_tokens === 500 && noCache.usage.cache_read_input_tokens === 0);

  t("★ usage が入る（llm_usage_logs がそのまま書ける）",
    eq(r.usage, { input_tokens: 1234, output_tokens: 56, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
  t("★ model が DeepSeek（あとで費用と品質を見分けられる）", r.model === "DeepSeek-V4-Flash");
  t("length で切れたら max_tokens", fromOpenAIResponse({ choices: [{ message: { content: "…" }, finish_reason: "length" }] }, "m").stop_reason === "max_tokens");
  t("応答が空でも落ちない", fromOpenAIResponse({}, "m").content !== undefined);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
