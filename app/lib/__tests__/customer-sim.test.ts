// app/lib/__tests__/customer-sim.test.ts
// お客様役（テスト・YUMA 専用）の鍵・印・筋書き・検査と、webhook を変えていないことの固定。
// 2026-09-27 竹内「YUMA で自動的に YUMA から自動返信が来て、返信を繰り返せたら理想」
// 実行: npx tsx app/lib/__tests__/customer-sim.test.ts（全 PASS で exit 0・DB にはつながない）
import { readFileSync } from "node:fs";

// supabase の口は import 時に作られる（読まない・書かない）。値が無い環境でも読み込めるよう仮の値を入れる
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

async function main() {
  const guard = await import("../customer-sim-guard");
  const sim = await import("../customer-sim");
  const { YUMA_CONVERSATION_ID } = await import("../test-conversations");
  const REAL = "0b5c3f6e-1111-4222-8333-444455556666"; // テスト用でない会話（形だけ本物の id）

  console.log("── ★ 入口の鍵（本物のお客様には一切動かない）");
  {
    const ok = guard.checkCustomerSimAccess({ authOk: true, enabled: true, conversationId: YUMA_CONVERSATION_ID });
    t("YUMA＋認証＋スイッチ入 → 通る", ok.ok === true);
    const real = guard.checkCustomerSimAccess({ authOk: true, enabled: true, conversationId: REAL });
    t("★ テスト用でない会話は 403", !real.ok && real.status === 403, JSON.stringify(real));
    const noAuth = guard.checkCustomerSimAccess({ authOk: false, enabled: true, conversationId: YUMA_CONVERSATION_ID });
    t("★ 認証なしは 401（YUMA でも）", !noAuth.ok && noAuth.status === 401);
    const off = guard.checkCustomerSimAccess({ authOk: true, enabled: false, conversationId: YUMA_CONVERSATION_ID });
    t("★ スイッチ切は 403（YUMA でも）", !off.ok && off.status === 403);
    const bad = guard.checkCustomerSimAccess({ authOk: true, enabled: true, conversationId: "" });
    t("会話 id なしは 400", !bad.ok && bad.status === 400);
    const upper = guard.checkCustomerSimAccess({ authOk: true, enabled: true, conversationId: YUMA_CONVERSATION_ID.toUpperCase() });
    t("★ 大文字にした YUMA の id も一覧に無い扱い（403）", !upper.ok && upper.status === 403);
    t("スイッチは 1 / true だけ", guard.customerSimEnabled("1") && guard.customerSimEnabled("TRUE") && guard.customerSimEnabled(" true "));
    t("★ スイッチの書き間違い・空・0 は切", !guard.customerSimEnabled("") && !guard.customerSimEnabled("0") && !guard.customerSimEnabled("yes") && !guard.customerSimEnabled(undefined) && !guard.customerSimEnabled("false"));
  }

  console.log("── ★ お客様役の印（line_message_id の頭）");
  {
    const id = guard.newSimLineMessageId();
    t("新しい印は sim- で始まる", id.startsWith("sim-") && guard.isSimLineMessageId(id));
    t("★ LINE の本物の id（数字）はお客様役ではない", !guard.isSimLineMessageId("512345678901234567") && !guard.isSimLineMessageId(null) && !guard.isSimLineMessageId(""));
    t("毎回ちがう印（重複保存の防止に効く）", guard.newSimLineMessageId() !== guard.newSimLineMessageId());
    const r = await guard.isSimulatedCustomerTurn(REAL);
    t("★ テスト用でない会話は DB を読まずに false（本物の経路は今まで通り通知する）", r === false);
    t("null の会話も false", (await guard.isSimulatedCustomerTurn(null)) === false);
  }

  console.log("── ★ webhook は同じ関数を通す（コピーしていない・署名の確認は残る）");
  {
    const route = readFileSync("app/api/line-webhook/route.ts", "utf8");
    const lib = readFileSync("app/lib/line-webhook-text.ts", "utf8");
    const server = readFileSync("app/lib/customer-sim-server.ts", "utf8");
    t("★ webhook に handleTextMessage の本体は無い（lib から import）", !/async function handleTextMessage\s*\(/.test(route) && /import \{[^}]*handleTextMessage[^}]*\} from "@\/app\/lib\/line-webhook-text"/.test(route));
    t("★ 本体は lib に1つだけ", (lib.match(/export async function handleTextMessage\s*\(/g) ?? []).length === 1);
    t("★ お客様役も同じ関数を import している", /import \{[^}]*handleTextMessage[^}]*\} from "@\/app\/lib\/line-webhook-text"/.test(server));
    const sigAt = route.indexOf("await verifySignature(rawBody");
    const firstHandle = route.indexOf("await handleTextMessage(");
    t("★ webhook は署名の確認の後にだけ文字の発言を処理する", sigAt > 0 && firstHandle > sigAt);
    t("★ webhook はお客様役の入口・スイッチを読まない", !/customer-sim|CUSTOMER_SIM_ENABLED/.test(route));
    t("★ lib の中のお客様役の判定は通知の3か所だけ（保存・下書き・ブレインの流れは触らない）", (lib.match(/await isSimulatedCustomerTurn\(convId\)/g) ?? []).length === 3);
    t("webhook の文字の発言の呼び出し（テキスト・スタンプ）は今まで通りの引数", /handleTextMessage\(userId, text, matchedAccount, lineMessageId, quotedMessageId, skipDraft\)/.test(route) && /handleTextMessage\(userId, "\[スタンプ\]", matchedAccount, lineMessageId, undefined, true\)/.test(route));
  }

  console.log("── ★ 入口は鍵の前に何もしない");
  {
    const r = readFileSync("app/api/test/customer-sim/route.ts", "utf8");
    const post = r.slice(r.indexOf("export async function POST"));
    const gateAt = post.indexOf("const denied = gate(");
    t("★ POST は鍵（gate）を最初に通す", gateAt > 0 && gateAt < post.indexOf("generateCustomerReply(") && gateAt < post.indexOf("injectCustomerMessage("));
    const get = r.slice(r.indexOf("export async function GET"), r.indexOf("export async function POST"));
    t("GET も鍵を通す", /const denied = gate\(/.test(get));
    t("★ 鍵は requireInternalAuth・スイッチ・会話の一覧の3つ", /requireInternalAuth\(req\)/.test(r) && /customerSimEnabled\(\)/.test(r) && /checkCustomerSimAccess\(/.test(r));
    const server = readFileSync("app/lib/customer-sim-server.ts", "utf8");
    t("★ 入れる直前にもテスト用の会話かを見る（二重）", /if \(!isTestConversation\(conversationId\)\) throw/.test(server));
  }

  console.log("── ★ お客様役の番は売上番長グループに出さない");
  {
    const items = readFileSync("app/lib/aix-action-items.ts", "utf8");
    const fn = items.slice(items.indexOf("export async function syncAixActionItem"));
    const skipAt = fn.indexOf("isSimulatedCustomerTurn(conversationId)");
    t("★ AIX要対応は登録・通知・自動検索の前に止める", skipAt > 0 && skipAt < fn.indexOf(".from(\"aix_action_items\")") && skipAt < fn.indexOf("pushToHanbancyoGroup(") && skipAt < fn.indexOf("enqueueAixPropertySearch("));
    const brain = readFileSync("app/lib/brain-core.ts", "utf8");
    t("カレンダーの登録はお客様役の番では止める", /isFreshAixTurn\(snapshot\.meta\.analyzed_msg_ts\) && !\(await isSimulatedCustomerTurn\(conversationId\)\)/.test(brain));
    const pb = readFileSync("app/lib/property-brain-core.ts", "utf8");
    t("条件の矛盾の通知はお客様役の番では止める", /parsed\.contradiction && !\(await import\("@\/app\/lib\/customer-sim-guard"\)/.test(pb));
  }

  console.log("── 筋書き");
  {
    const errs = sim.validateScenarios();
    t("★ 筋書きの形が正しい", errs.length === 0, errs.join(" / "));
    t("4本ある", sim.listScenarios().length >= 4);
    t("1段目は固定文（DeepSeek を呼ばずに始められる）", sim.listScenarios().every((s) => !!s.steps[0].fixed));
    t("壊れた筋書きを見つける", sim.validateScenarios([{ id: "Bad Id", title: "", persona: { label: "", tone: "", facts: "" }, steps: [] }]).length >= 3);
    const sc = sim.getScenario("like_estimate_viewing")!;
    const a = sim.advanceCursor(sc, { stepIndex: 0, turnsOnStep: 0 }, false);
    t("固定文の段は1回で次へ", a.stepIndex === 1 && a.turnsOnStep === 0 && !a.finished);
    const b = sim.advanceCursor(sc, { stepIndex: 1, turnsOnStep: 0 }, false);
    t("目的に届かない返事は同じ段に留まる（max_turns 2）", b.stepIndex === 1 && b.turnsOnStep === 1);
    const c = sim.advanceCursor(sc, { stepIndex: 1, turnsOnStep: 1 }, false);
    t("回数を使い切ったら次へ", c.stepIndex === 2 && c.turnsOnStep === 0);
    const d = sim.advanceCursor(sc, { stepIndex: 1, turnsOnStep: 0 }, true);
    t("目的に届けば次へ", d.stepIndex === 2);
    const last = sim.advanceCursor(sc, { stepIndex: sc.steps.length - 1, turnsOnStep: 0 }, true);
    t("最後の段の後は finished", last.finished);
    t("筋書きの外は finished", sim.advanceCursor(sc, { stepIndex: 99, turnsOnStep: 0 }, true).finished);
  }

  console.log("── DeepSeek の前置き・返事の読み取り");
  {
    t("前置きは固定（動く物を含まない＝前置きキャッシュ）", !/\$\{/.test(sim.CUSTOMER_SIM_SYSTEM) && sim.CUSTOMER_SIM_SYSTEM.includes("JSON"));
    const u = sim.buildCustomerSimUser({
      scenario: sim.getScenario("like_estimate_viewing")!, cursor: { stepIndex: 1, turnsOnStep: 1 },
      history: [{ sender: "customer", text: "探してます" }, { sender: "staff", text: "[画像]", hasImage: true }, { sender: "staff", text: "ご査収ください" }],
      sentPropertyNames: ["テストハイツ 201"], estimateSent: false, nowLabel: "9/27（日）10:00",
    });
    t("入力に段の目的・届いた物件・見積の有無・会話が入る", u.includes("この段の目的") && u.includes("テストハイツ 201") && u.includes("まだ届いていない") && u.includes("担当者: ［画像を送った") && u.includes("この段の2回目"));
    const p = sim.parseCustomerSimReply('```json\n{"text": "お客様: 2つ目の物件いいですね！", "goal_reached": true}\n```');
    t("JSON を読み、名札を外す", p?.text === "2つ目の物件いいですね！" && p?.goalReached === true);
    t("goal_reached が無ければ false", sim.parseCustomerSimReply('{"text":"まだですか？"}')?.goalReached === false);
    t("読めない返事は null", sim.parseCustomerSimReply("はい") === null && sim.parseCustomerSimReply('{"text":""}') === null);
    t("かぎかっこだけの文は外す", sim.sanitizeCustomerText("「ありがとうございます」") === "ありがとうございます");
  }

  console.log("── ★ 往復の検査（お待たせ・作業メモ・創作・約束の言い直し・状況の取り違え）");
  {
    const hist = [
      { sender: "customer", text: "家賃7万までで探してます" },
      { sender: "staff", text: "かしこまりました！！条件に合うお部屋をお探しさせて頂きます😊" },
      { sender: "customer", text: "よろしくお願いします" },
    ];
    const f1 = sim.auditSimTurn({ sentText: "お待たせ致しました！！物件をお送りします", historyBefore: hist });
    t("★ お待たせを拾う", f1.some((x) => x.kind === "waited"));
    const f2 = sim.auditSimTurn({ sentText: "9/22（火）14:20時点、直前に物件送付済み・見積は未送付\nかしこまりました！！", historyBefore: hist });
    t("★ 作業メモの行を拾う", f2.some((x) => x.kind === "work_note"));
    const f3 = sim.auditSimTurn({ sentText: "初期費用は12万円になります！！", historyBefore: hist });
    t("★ 会話に無い金額は創作の疑い", f3.some((x) => x.kind === "invented" && x.detail.includes("12万円")));
    const f4 = sim.auditSimTurn({ sentText: "家賃7万円までで承知しました！！", historyBefore: hist });
    t("会話にある数字は創作にしない", !f4.some((x) => x.kind === "invented"));
    const f5 = sim.auditSimTurn({ sentText: "承知しました！！引き続きお部屋をお探しさせて頂きます😊", historyBefore: hist });
    t("★ 物件を送らないまま宣言をもう一度＝約束の言い直し", f5.some((x) => x.kind === "repeat_promise"));
    const f6 = sim.auditSimTurn({ sentText: "引き続きお部屋をお探しさせて頂きます😊", historyBefore: [...hist, { sender: "staff", text: "[画像]" }, { sender: "staff", text: "3件お送りさせて頂きました！！ご査収ください" }] });
    t("物件を送った後の宣言は言い直しにしない", !f6.some((x) => x.kind === "repeat_promise"));
    const f7 = sim.auditSimTurn({ sentText: null, historyBefore: hist, expectStage: "viewing", brainStage: "proposing", stateConflicts: 2 });
    t("★ 段階の食い違い・表示のずれを拾う", f7.some((x) => x.kind === "stage_mismatch") && f7.some((x) => x.kind === "state_conflict"));
    const f8 = sim.auditSimTurn({ sentText: "かしこまりました！！ご確認ありがとうございます😊", historyBefore: hist, expectStage: "hearing", brainStage: "hearing" });
    t("ふつうの文は何も拾わない", f8.length === 0, JSON.stringify(f8));
    const sum = sim.summarizeSimAudit([{ findings: f1 }, { findings: f3 }, { findings: f7 }]);
    t("要約は種類ごとの件数", sum.find((s) => s.kind === "waited")?.count === 1 && sum.find((s) => s.kind === "invented")?.count === 1 && sum.length === 6);
  }

  console.log("── スタッフ役の決め方");
  {
    t("判断が無ければ待つ", sim.planStaffAction(null).kind === "wait");
    t("AIX なしは下書き", sim.planStaffAction({ action: null, reply_mode: "auto_reply" }).kind === "draft");
    t("action があっても reply_mode が aix でなければ下書き", sim.planStaffAction({ action: "viewing_invite", reply_mode: "auto_reply" }).kind === "draft");
    t("会話だけで作れる AIX は作る", sim.planStaffAction({ action: "application_push", reply_mode: "aix" }).kind === "aix");
    t("★ 材料が要る AIX（見積書・物件）は止めて人に渡す", sim.planStaffAction({ action: "estimate_sheet", reply_mode: "aix" }).kind === "aix_needs_material" && sim.planStaffAction({ action: "property_send", reply_mode: "aix" }).kind === "aix_needs_material");
  }

  console.log(`\n合計: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
