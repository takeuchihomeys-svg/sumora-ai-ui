// npx tsx app/lib/__tests__/compose-sentence-plan.test.ts
import assert from "node:assert/strict";
import {
  composeSentencePlanOn, readTurnUnderstanding, readSevenFields, buildSentencePlan, sentencePlanNote, sentencePlanDigest,
  understandingCoverage, planFieldsOf, scoreFields, tallyFields, appealPointsOf, latentKindOf, type TakeuchiGold,
} from "../compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("スイッチは既定 on（11/12・戻す =off）", () => {
  assert.equal(composeSentencePlanOn({}), true);
  assert.equal(composeSentencePlanOn({ COMPOSE_SENTENCE_PLAN: "on" }), true);
  assert.equal(composeSentencePlanOn({ COMPOSE_SENTENCE_PLAN: "off" }), false);
});

// 実物（q088・試験の答案の brain）: 畳の交換の問い＝確認の約束
const q088 = {
  appeal_timing: { kind: "none", level: "avoid", reason: "質問＝答えるだけ" },
  turn_contract: { situation: "DWELL 204号室の畳交換可否を確認している段階", asks: [{ quote: "こちら畳は変えて頂けるのですか？？", route: "promise", about: "property_equipment", property: "DWELL お客様NO 204" }], lead_with: 0, close_only: false },
};

t("材料が今ある物だけ: 主＝約束・物件と何の事が設計図に出る・7つの欄は空のまま（作り話で埋めない）", () => {
  const u = readTurnUnderstanding(q088);
  assert.equal(u.main?.role, "promise");
  assert.equal(u.main?.property, "DWELL お客様NO 204");
  assert.equal(u.src.main, "turn_contract");
  const s = readSevenFields(q088);
  assert.equal(s.leadTo, null); // avoid は誘導先にしない
  assert.equal(s.latentCover, null);
  const p = buildSentencePlan(u, s);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].rank, "main");
  assert.match(p.rows[0].part ?? "", /DWELL お客様NO 204の 物件の設備・間取り/);
  assert.ok(p.empty.includes("訴求") && p.empty.includes("要点の押さえ方") && p.empty.includes("信頼の作り方"));
  const note = sentencePlanNote(p);
  assert.match(note, /1\. 【主】確かめる約束/);
  assert.doesNotMatch(note, /【従】/);
  const cov = understandingCoverage(u, s, p);
  assert.equal(cov["何の物件"].got && cov["何の物件"].inPlan, true);
  assert.equal(cov["今の状況"].got, true);
  assert.equal(cov["今の状況"].inPlan, false);
  assert.equal(cov["訴求"].got, false);
});

t("AIX の番の主は返信の行にしない（注記は空＝今まで通り）", () => {
  const u = readTurnUnderstanding({ turn_contract: { asks: [{ quote: "初期費用は？", route: "aix", about: "property_cost" }], lead_with: 0 } });
  const p = buildSentencePlan(u, readSevenFields({}));
  assert.equal(p.aixMain, true);
  assert.equal(sentencePlanNote(p), "");
  assert.match(sentencePlanDigest(p), /主=aix/);
});

t("作業員14 の主と従が来ればそれに従う（turn_contract より先）", () => {
  const u = readTurnUnderstanding({
    turn_read: { main: { what: "土曜日の内覧の日の確定", about: "viewing_day", role: "viewing" }, subs: [{ what: "審査の相談", about: "procedure", route: "reply" }] },
    turn_contract: { asks: [{ quote: "審査通りますか", route: "reply", about: "procedure" }] },
  });
  assert.equal(u.src.main, "turn_read");
  const p = buildSentencePlan(u, readSevenFields({}));
  assert.deepEqual(p.rows.map((r) => [r.rank, r.role]), [["main", "viewing"], ["sub", "answer"]]);
});

// 作業員5 の SevenRead（takeuchi-seven-read.ts の形）。竹内さんの q072（9/13 以降の内覧・埋まるか）を読んだ形
const sevenQ072 = {
  point: { what: "9/13まで空いているか", how: "埋まる可能性が高いと言い切る", skipped: null },
  bridge: { what: "撮影・オンライン内見で抑えた状態で13日以降に内覧", how: "時間枠を出す" },
  lead: "apply",
  appeal: { property: "スプランディッド難波WESTⅡ", point: "好条件", how: "同じ条件の方も申込む" },
  latent: { what: "9/13まで待つ間に埋まって逃す", fact: "同じ条件で探している方も申込む", how: "先に抑える道を出す" },
  point_how: ["assert", "name_property"], trust_how: ["preempt", "effort"],
  push: { push: true, strength: "strong", reason: "物件の残り×日程を出した" },
};

t("7つの欄（作業員5 の形）: 主→心配→信頼→誘導の順・訴求は誘導の行・押す強さと理由", () => {
  const meta = { seven_read: sevenQ072, turn_contract: { asks: [{ quote: "今見てる物件埋まる可能性高いですかね", route: "reply", about: "vacancy", property: "スプランディッド難波WESTⅡ" }] } };
  const s = readSevenFields(meta);
  assert.equal(s.src.leadTo, "seven_read");
  assert.equal(s.latentCover?.kind, "先に取られる");
  assert.deepEqual(s.appeal?.points, ["条件の合い方"]);
  const p = buildSentencePlan(readTurnUnderstanding(meta), s);
  assert.deepEqual(p.rows.map((r) => r.role), ["answer", "worry", "trust", "apply"]);
  assert.equal(p.rows[0].rank, "main");
  assert.match(p.rows[0].how ?? "", /言い切る・物件名・号室で名指し/);
  assert.match(p.rows[0].next ?? "", /オンライン内見で抑えた/);
  assert.match(p.rows[1].part ?? "", /待つ間に埋まって逃す／使う事実/);
  assert.match(p.rows[1].how ?? "", /先回り・事実の裏付け|先回り/);
  assert.match(p.rows[2].how ?? "", /こちらの手間を見せる/);
  assert.match(p.rows[3].part ?? "", /^訴求: スプランディッド難波WESTⅡの 好条件/);
  assert.match(p.rows[3].how ?? "", /押す強さ: 強.*物件の残り/);
  const note = sentencePlanNote(p);
  assert.match(note, /2\. 【従】奥の心配への答え/);
  assert.match(note, /材料（会話・資料・会社の事実）に無い事実/);
});

t("材料の網: 気持ちの型（不安の型だけ）と appeal_timing の suggest", () => {
  const s = readSevenFields({ turn_read: { intent: "内覧したい", mood: { base: "審査の不安", object: "職業・収入", degree: "中" }, feeling: "収入が少なく通るか" }, appeal_timing: { kind: "viewing", level: "suggest" } });
  assert.equal(s.latentCover?.kind, "審査");
  assert.equal(s.latentCover?.what, "収入が少なく通るか");
  assert.equal(s.leadTo, "viewing");
  const s2 = readSevenFields({ turn_read: { mood: { base: "刺さっている", object: "家賃" } } });
  assert.equal(s2.latentCover, null);
});

t("訴求・潜在の言葉の型", () => {
  assert.deepEqual(appealPointsOf("敷金礼金0円でフリーレント"), ["初期費用"]);
  assert.equal(latentKindOf("年末にかかる引越しを避けたい"), "入居日・時期");
  assert.equal(latentKindOf("一人になっても探してもらえるか"), "事情の変化");
});

t("物差し: 欄ごとの当たり（竹内さんに値がある番だけ当たりを数える・空を埋めたら extra）", () => {
  const gold: TakeuchiGold = { id: "x", roles: ["greet", "answer", "apply", "apply", "viewing"], mainRole: "answer", property: "スプランディッド難波WESTⅡ", about: "vacancy", part: "9/13まで空いているか", leadTo: "apply", bridgeRole: "apply", appeal: ["条件の合い方"], latent: "先に取られる", keyHow: ["assert"], trustHow: ["preempt"] };
  const meta = { seven_read: sevenQ072, turn_contract: { asks: [{ quote: "埋まる可能性高いですかね", route: "reply", about: "vacancy", property: "スプランディッド難波WESTⅡ" }] } };
  const u = readTurnUnderstanding(meta), s = readSevenFields(meta);
  const f = scoreFields(gold, planFieldsOf(u, s, buildSentencePlan(u, s)));
  assert.equal(f["主の役目"], "hit");
  assert.equal(f["何の物件"], "hit");
  assert.equal(f["何の事"], "hit");
  assert.equal(f["誘導先"], "hit");
  assert.equal(f["潜在意識のカバー"], "hit");
  assert.equal(f["役目の組み合わせ"], "miss"); // 竹内さんは worry・trust の文を別に書いていない
  assert.equal(f["主→従の順"], "hit");
  const empty = scoreFields(gold, planFieldsOf(readTurnUnderstanding({}), readSevenFields({}), buildSentencePlan(readTurnUnderstanding({}), readSevenFields({}))));
  assert.equal(empty["訴求"], "miss");
  assert.equal(empty["主の役目"], "miss");
  const tl = tallyFields([f, empty]);
  assert.equal(tl["主の役目"].goldHas, 2);
  assert.equal(tl["主の役目"].hit, 1);
});

t("受けが主の番（検討します）: 主の役目と順は受け同士で当たり", () => {
  const gold: TakeuchiGold = { id: "y", roles: ["uke", "uke", "viewing"], mainRole: "uke", property: null, about: "reaction_to_sent", part: null, leadTo: "viewing", bridgeRole: "viewing", appeal: [], latent: null, keyHow: [], trustHow: [] };
  const meta = { turn_contract: { asks: [], close_only: true }, appeal_timing: { kind: "viewing", level: "suggest" } };
  const u = readTurnUnderstanding(meta), s = readSevenFields(meta);
  const p = buildSentencePlan(u, s);
  assert.deepEqual(p.rows.map((r) => r.role), ["uke", "viewing"]);
  const f = scoreFields(gold, planFieldsOf(u, s, p));
  assert.equal(f["主の役目"], "hit");
  assert.equal(f["役目の組み合わせ"], "hit");
  assert.equal(f["訴求"], "both_empty");
});



t("主が確かめる約束の時は、確かめる中身を言い切らせない行（q145 の悪化の直し）", () => {
  const note = sentencePlanNote(buildSentencePlan(readTurnUnderstanding(q088), readSevenFields(q088)));
  assert.match(note, /確かめる中身（最短の日・できる\/できない・日付・金額）を本文で言い切らない/);
  assert.doesNotMatch(note, /足さない/);
});

t("案B: 番の材料に「どうやって」が無い時は場面×誘導先の傾向表で埋める・行は増やさない・了承の番にサポートの姿勢を足さない", () => {
  const u = readTurnUnderstanding(q088), s = readSevenFields(q088);
  const p0 = buildSentencePlan(u, s);
  const p = buildSentencePlan(u, s, { scene: "question" });
  assert.equal(p.rows.length, p0.rows.length);
  assert.equal(p.how?.src, "table");
  assert.equal(p.how?.tableKey, "question");
  assert.match(p.rows[0].how ?? "", /結論を先に/);
  assert.doesNotMatch(p.rows[0].how ?? "", /サポートの姿勢/); // 継続・信頼の行が無い番
  assert.match(p.rows[0].how ?? "", /信頼: お客様の立場の言葉/);
  // 条件の番の keep（探す約束）はサポートの姿勢を添えてよい
  const kc = { turn_contract: { asks: [{ quote: "家賃6万までで", route: "promise", about: "search_condition" }] } };
  const pk = buildSentencePlan(readTurnUnderstanding(kc), readSevenFields(kc), { scene: "conditions" });
  assert.equal(pk.rows[0].role, "keep");
  assert.equal(pk.how?.tableKey, "conditions|keep");
  assert.match(pk.rows[0].how ?? "", /お客様の言葉・条件を拾う・結論を先に／信頼: サポートの姿勢・こちらの手間を見せる/);
  // 番の材料（作業員5 の形）があれば表を使わない
  const meta = { seven_read: sevenQ072, turn_contract: { asks: [{ quote: "埋まりますか", route: "reply", about: "vacancy" }] } };
  assert.equal(buildSentencePlan(readTurnUnderstanding(meta), readSevenFields(meta), { scene: "viewing" }).how?.src, "turn");
});

// ── 2026-11-12 受け渡しの漏れ0（竹内さん「細分化された判断が文の構成に届くように」「ブレインの進化にともなって」） ──
import { readFileSync as rf } from "node:fs";
import { join as pj } from "node:path";
import { readComposeContext, handoffLeaks, HANDOFF_FIELDS, BRAIN_FIELD_ROUTE, leadFromDirection } from "../compose-sentence-plan";
const ROOT = pj(__dirname, "..", "..", "..");
const planNoteOf = (meta: unknown, scene: string | null = null) => sentencePlanNote(buildSentencePlan(readTurnUnderstanding(meta), readSevenFields(meta), { scene, ctx: readComposeContext(meta) }));

t("ブレインの欄は全部、文の側の受け口が決まっている（新しい欄を足したらここが落ちる）", () => {
  const src = rf(pj(ROOT, "app/lib/brain-core.ts"), "utf8").split(/\r?\n/);
  const start = src.findIndex((l) => l.startsWith("export type SuggestedAixMeta = {"));
  assert.ok(start >= 0);
  const keys: string[] = [];
  for (let i = start + 1; i < src.length && !src[i].startsWith("}"); i++) { const m = src[i].match(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/); if (m) keys.push(m[1]); }
  assert.ok(keys.length > 80, String(keys.length));
  const missing = keys.filter((k) => !(k in BRAIN_FIELD_ROUTE));
  assert.deepEqual(missing, [], `受け口の無いブレインの欄: ${missing.join(",")}（compose-sentence-plan.ts の BRAIN_FIELD_ROUTE に plan/other/none を書き、plan なら HANDOFF_FIELDS にも行を足す）`);
  const planKeys = Object.entries(BRAIN_FIELD_ROUTE).filter(([, v]) => v === "plan").map(([k]) => k);
  const noRow = planKeys.filter((k) => !HANDOFF_FIELDS.some((h) => h.key === k || h.key.startsWith(`${k}.`) || h.key.startsWith(`${k}(`) || h.key.split("・").includes(k)));
  assert.deepEqual(noRow, [], `plan なのに受け渡しの表に行が無い: ${noRow.join(",")}`);
});

t("実物の meta（試験の答案の brain 24番）で、ブレインに値があるのに設計図に出ない欄は0", () => {
  const brains = JSON.parse(rf(pj(ROOT, "scripts/compose-understanding/brains-1112.json"), "utf8")) as Array<{ id: string; brain: Record<string, unknown> }>;
  let checked = 0;
  for (const b of brains) {
    const note = planNoteOf(b.brain);
    if (!note) continue;
    checked++;
    assert.deepEqual(handoffLeaks(b.brain, note), [], b.id);
  }
  assert.ok(checked >= 15, String(checked));
});

t("全部の欄が入った meta でも漏れ0（作業員14 の潜在の4欄・主と従・作業員5 の7つの欄の受け口）", () => {
  const full = {
    reply_direction: "移動先が確定したらお部屋探しを再開できる旨を伝え、関係を切らずに待つ", current_property: "スプランディッド難波WESTⅡ 604号室",
    turn_contract: { situation: "内覧の日程の相談中", background: "9/13以降しか行けない", asks: [{ quote: "埋まる可能性高いですかね", route: "reply", about: "vacancy", property: "スプランディッド難波WESTⅡ", answer: "好条件で埋まる可能性が高い", when: "viewing_day" }, { quote: "審査は", route: "reply", about: "procedure", answer: "通過の見込み" }], lead_with: 0, must_not: ["空いていると断言"] },
    turn_read: { target: { kind: "送った物件", property: "スプランディッド難波WESTⅡ", detail: "9/13まで空いているか" }, intent: "内覧したい", intent2: "申込したい・抑えたい", lead: { kind: "内覧", answer: "応じた" }, feeling: "埋まらないか心配", mood: { base: "先に取られる不安", object: "人気の物件", degree: "中" },
      latent: { trigger: "内覧が9/13以降", part: "待つ間の空き", feeling: "取られたくない", strength: "中", want: "内覧まで部屋を確保したい" } },
    main_point: "埋まる可能性が高い", three_layer: { surface: "埋まるか", worry: "待つ間に取られる", relief: "抑えておける事" }, latent_intent: "第一候補を逃したくない",
    customer_concern: { topic: "時期", object: "埋まる" }, appeal_timing: { kind: "apply", level: "suggest", reason: "好条件で残りが少ない" }, conductor_focus: { focus: "answer", why: "埋まるかへの答え" },
    plan_ahead: { goal: "今週中に申込" }, future_timeline: "9月13日以降", hesitancy_pattern: "timeline", customer_emotion: "焦り", customer_mindset: { state: "先に取られる不安", anxiety: { target: "空き", direction: "前向き" }, hesitation: null },
    engagement_stance: "push", purchase_signal_level: "soft",
    message_plan: { background: "内覧が先になるので空きが心配", parts: [{ rank: 1, meaning: "審査の詳しい説明", include: "omit" }], messages: [] },
    seven_read: { point: { what: "9/13まで空いているか", how: "言い切る", skipped: "審査の詳しい話" }, bridge: { what: "撮影・オンライン内見で抑える", how: "時間枠" }, lead: "apply", appeal: { property: "スプランディッド難波WESTⅡ", point: "好条件", how: "同じ条件の方も申込む" }, latent: { what: "9/13まで待つ間に埋まる", fact: "同じ条件の方も申込む", how: "先に抑える" }, point_how: ["assert"], trust_how: ["preempt"], push: { push: true, strength: "strong", reason: "物件の残り×日程" } },
  };
  const note = planNoteOf(full, "viewing");
  assert.deepEqual(handoffLeaks(full, note), []);
  assert.match(note, /潜在: きっかけ 内覧が9\/13以降・何の部分 待つ間の空き・気持ち 取られたくない（中）・本当はしたい事 内覧まで部屋を確保したい/);
  assert.match(note, /今回は入れない・後に回す: 審査の詳しい説明／審査の詳しい話/);
});

t("方向の文から誘導先を写す（作業員5 の外れの束 10番）・customer_concern を潜在で先に（q072）", () => {
  assert.equal(leadFromDirection("内覧キャンセルの申し出を快く受け止め、移動先が確定したらまたお部屋探しを再開できる旨を伝える。再開時期の伺いも添え、関係を切らずに待つ姿勢を示す。"), "keep");
  assert.equal(leadFromDirection("2階は上階に比べ虫が入りやすいと正直に答え、7階以上が虫対策に良い旨を伝えて不安を解消する"), "answer_only");
  assert.equal(leadFromDirection("ご希望の条件を伺い、お送り頂ければ探す"), "ask_send");
  assert.equal(leadFromDirection("好条件なので申込で抑える事を勧める"), "apply");
  assert.equal(leadFromDirection("同じ発言の他のご希望にも一言ずつ応える（頼まれていない内覧・申込の一文は足さない）。"), null);
  const s = readSevenFields({ customer_concern: { topic: "時期", object: "埋まる" }, turn_read: { mood: { base: "安くしたい" } } });
  assert.equal(s.latentCover?.kind, "先に取られる");
});

t("作業員14 の turn_focus・turn_topics（main に入った新しい欄）も設計図に届く・後で答える従は行にせず「後に回す」へ（主が AIX の番は今まで通り注記なし）", () => {
  const meta = {
    turn_contract: { asks: [{ quote: "土曜日でお願いします", route: "reply", about: "viewing_day" }, { quote: "審査って通りますか", route: "reply", about: "procedure", answer: "通過の見込み" }] },
    turn_focus: { main: { about: "内覧の日・場所", intent: "日程の調整・連絡", move: "日の確定" }, sub: { about: "手続き・審査", intent: "手続き・審査の質問", move: "後で答える" } },
    turn_topics: [{ n: 1, about: "内覧の日・場所", intent: "日程の調整・連絡", quote: "土曜日でお願いします", ref: null, role: "主" }, { n: 2, about: "手続き・審査", intent: "手続き・審査の質問", quote: "審査って通りますか", ref: "前に送った見積書", role: "従" }],
  };
  const note = planNoteOf(meta);
  assert.deepEqual(handoffLeaks(meta, note), []);
  assert.match(note, /話題（出てきた順）: 主: 土曜日でお願いします／従: 審査って通りますか（前の話: 前に送った見積書）/);
  assert.match(note, /今回は入れない・後に回す: 手続き・審査・手続き・審査の質問（後で答える）/);
});
console.log(`${n} pass`);
