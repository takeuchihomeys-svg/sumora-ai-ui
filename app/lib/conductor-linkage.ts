// app/lib/conductor-linkage.ts — 統括同士の連携の表（純関数・DB/LLM なし・作業員5・11/06）
//
// 竹内さんの決定（11/06・KB P1「試験から改善の仕方もちゃんと強化し、統括同士連携させていく」）・P0 575a7cd5（統括の芯）・P1 0dbfbc97（順番の表・後の役は決め直さない）。
//   1行＝1つの統括: 持っている段（FOCUS_ORDER の段）・読む印・書く印・止めるスイッチ・前の統括の決めた事を決め直す所（redecides）。
//   作業員8の「試験の外れの自動の切り分け」（scripts/lib）が、答案から出した印（decision:・two_stage:・scene_net:・demoted:・writer・final_check・log:）を
//   writes の前方一致で引いて持ち主を出す（11/06 作業員8と形を合わせた）。表は記録とコードを読んで作った（LLM なし）。持ち主は 11/06 統括役の決め（未定は無し）。
// 置き場: 統括の名簿（conductor-roles.ts の ROSTER）の近く。roadmap の memory/project_conductor_roadmap.md に1段。
export type ConductorStage = "read" | "rough" | "detail" | "compose" | "verify" | "exam";
export type ConductorLink = {
  id: "intake" | "brain" | "two_stage" | "scene_net" | "rules" | "conductor_record" | "aix_desk" | "aix_second" | "two_msg" | "compose_plan" | "compose" | "writer" | "final_check" | "exam";
  name: string; owner: string; files: string[]; stage: ConductorStage;
  /** 読む印（meta.* / digest.* / trace.*） */
  reads: string[];
  /** 書く印（作業員8の切り分けの印の名前・前方一致） */
  writes: string[];
  switch: string | null;
  /** 前の統括が決めた事を決め直す所（ぶつかる所）。of＝決め直される側・field＝何を */
  redecides: Array<{ of: ConductorLink["id"]; field: string; where: string; why: string; example?: string }>;
};

export const CONDUCTOR_LINKS: readonly ConductorLink[] = [
  {
    id: "intake", name: "入口の統括（表→背景→重点・近い番）", owner: "作業員4（入口の読み）・作業員5（重点）", stage: "read",
    files: ["app/lib/conductor-intake.ts", "app/lib/conductor-intake-server.ts", "app/lib/conductor-focus.ts", "app/lib/conductor-focus-server.ts"],
    reads: ["messages（今の番・直前のこちら）", "facts ledger（事実の帳面）", "meta.conductor_meta（前の番）", "conductor_turn_vectors（近い番・match_conductor_focus）"],
    writes: ["meta.conductor_intake", "meta.conductor_focus", "digest.ci", "digest.fc"],
    switch: "CONDUCTOR_INTAKE・CONDUCTOR_FOCUS（既定 shadow）", redecides: [],
  },
  {
    id: "brain", name: "判断のブレイン（返信か AIX か・依頼ごとの道 turn_contract）", owner: "統括役（brain-core は共用）", stage: "rough",
    files: ["app/lib/brain-core.ts", "app/lib/turn-contract.ts", "app/lib/brain-need.ts"],
    reads: ["材料（場面で絞る brain-scene）", "meta.conductor_focus（深く読み直す時だけ・brain-depth）", "meta.aix_recheck（AIX の統括の差し戻し・読み直しの口 brain-recheck）"],
    writes: ["meta.action", "meta.turn_contract", "meta.key_topics", "meta.reply_direction", "meta.reply_mode", "digest.la", "digest.tc", "digest.nd", "digest.tl", "digest.mp", "essence", "decision:llm", "log:", "brain:asks",
      // 2026-11-12 作業員7（作業員22 の欄ごとの連携の表 conductor-field-links の作り手どおり）: ブレインの JSON の欄（どれも既定 off のスイッチの時だけ出る・ここは表だけ）
      //   道の前の事実: now_vs_later・read_candidates・our_send_uptake（作業員16）・customer_mindset（作業員21）／道の後: judge_basis（作業員22）・seven_read・latent_read（作業員10）
      //   aix_now は brain-core の aixNowOf（now_vs_later から・作業員16）
      "meta.now_vs_later", "meta.aix_now", "meta.read_candidates", "meta.our_send_uptake", "meta.customer_mindset", "meta.judge_basis", "meta.seven_read", "meta.latent_read"],
    switch: null,
    // 入口の統括の重点は、判断の時には読まない（shadow・判断を変えない）＝今は並んで走るだけ。深く読み直す時だけ重点に沿わせる
    redecides: [],
  },
  {
    id: "two_stage", name: "2段（送れる物が無い時は約束の返信・answerable_direct で AIX に戻す）", owner: "作業員7（11/06 統括役の決め・S3・送った物件への反応・持ち込みの書き換えを持つ）", stage: "detail",
    files: ["app/lib/two-stage.ts", "app/lib/brain-core.ts（answerableDirect・4853〜5060行あたり）"],
    reads: ["meta.action（ブレインの AIX）", "売上サポの送れる物件・確認の結果・御見積書の有無", "turn_contract.asks"],
    writes: ["two_stage:", "decision:two_stage_promise", "decision:answerable_direct", "demoted:two_stage", "demoted:answerable", "log:answerable-direct", "log:screening", "text:direction_tail"],
    switch: "TWO_STAGE_*・TWO_STAGE_ANSWERABLE_DIRECT・BRAIN_DEMOTE_*",
    redecides: [
      { of: "brain", field: "action（AIX → 約束の返信）", where: "two-stage.resolveTwoStageOrDirect", why: "送れる物が無い時は先に約束（10/02 竹内さん）" },
      { of: "two_stage", field: "2段の約束 → AIX（answerable_direct）", where: "brain-core.ts answerableDirect（2段の後）", why: "すぐ答えられる番は AIX で（10/21 竹内さん A1）", example: "q136: 礼金の調整の依頼で 2段:check が正解なのに、2段の後で answerable_direct が AIX に戻す＝同じ統括の中で決めて決め直す（順番の表の外）" },
    ],
  },
  {
    id: "scene_net", name: "場面の網（場面の証拠・場面で AIX の候補を立てる）", owner: "作業員1（11/06 統括役の決め）", stage: "detail",
    files: ["app/lib/aix-scene-evidence.ts", "app/lib/reply-scene.ts", "app/lib/brain-scene.ts", "app/lib/reply-subscene.ts"],
    reads: ["今の番のお客様の文（決まった計算）", "主のお部屋（customer-state）"],
    writes: ["scene_net:", "meta.scene_evidence", "decision:scene"],
    switch: "SCENE_EVIDENCE_*",
    redecides: [
      { of: "brain", field: "action（場面の証拠で AIX の候補を立てる・返信を AIX に）", where: "brain-core.ts sceneEvidence のガード（5193行あたり）", why: "見積・確認の結果の依頼の取りこぼし（9/12〜）", example: "q332: 竹内さんは電話の AIX 1通（AIX の中で答える）。場面の網が別の場面（審査・費用）で候補を立てると、ブレインの phone_call と食い違う" },
    ],
  },
  {
    id: "rules", name: "決まった計算の上書き（rule:* の道の決め）", owner: "作業員1（11/06 統括役の決め・書き換えの棚卸し 106か所と brain-core）", stage: "detail",
    files: ["app/lib/brain-core.ts（rule:closed_ack_wait・viewing_day_ack・procedure_question_reply ほか）", "app/lib/turn-contract.ts（SENT_REACTION_VIEW_INVITE）"],
    reads: ["meta.action", "turn_contract", "送った物・帳面"],
    writes: ["decision:", "demoted:", "log:sent-reaction"],
    switch: "各 rule のスイッチ・BRAIN_DEMOTE_*",
    redecides: [
      { of: "brain", field: "action と turn_contract（rule:* の道）", where: "brain-core.ts の rule:*（30種）", why: "取りこぼしの網（決まった計算は候補と安全の線だけ・P0）" },
      { of: "two_msg", field: "返信の受け持ち（内覧の誘いを足す）", where: "turn-contract.ts sentReactionViewInvite（SENT_REACTION_VIEW_INVITE 既定 on）", why: "送った物件に反応した番は返信で内覧の誘い", example: "q055: 正解は 返信 か AIX:viewing_invite のどちらも可。返信に誘いを足す網と、AIX【内覧調整】を選ぶブレイン・2通の組み合わせが同じ「誘い」を別々に持つ（11/06 統括役: 作業員7が1つにまとめる）" },
    ],
  },
  {
    // 2026-11-12 作業員7（作業員22 の欄ごとの連携の表 conductor-field-links の作り手どおり）: ブレインの後の決まった計算が meta に足す統括の記録。
    //   道は変えない（記録・指示書だけ）。field-links の受け取る所「conductor」（統括の記録）はこの行の外の読み手で、ここは書く側。
    id: "conductor_record", name: "統括の記録（判断の順番の型・統括の指示書）", owner: "作業員22（配線・指示書）・作業員16（順番の型の表）", stage: "detail",
    files: ["app/lib/check-order-wire.ts", "app/lib/conductor-brief.ts", "app/lib/conductor-doubt.ts"],
    reads: ["meta.turn_contract", "meta.read_candidates", "meta.our_send_uptake", "meta.customer_mindset", "meta.judge_basis", "facts ledger"],
    writes: ["meta.check_order", "meta.conductor_brief"],
    switch: "CHECK_ORDER_TABLE・CONDUCTOR_BRIEF（既定 off）",
    redecides: [],
  },
  {
    id: "aix_desk", name: "AIX の統括（ボタン×ピッカー・差し戻し）", owner: "作業員1", stage: "detail",
    files: ["app/lib/aix-commander.ts", "app/lib/aix-commander-server.ts"],
    reads: ["meta.action", "meta.check_pattern", "aix_desk_cards", "facts ledger（AIX の分）"],
    writes: ["digest.ad", "meta.aix_recheck", "meta.aix_desk"],
    switch: "AIX_DESK_COMMAND・AIX_DESK_CONSULT",
    // 黙って書き換えない: 違う時は読み直しの口へ（brain-recheck）。決め直しはブレインが行う
    redecides: [],
  },
  {
    // 2026-11-12 作業員7（作業員25 の点検・b861eb78 aix-second-link）: AIX の2通目（✨）の書き手。1通目（AIX のテンプレート）の後に続く文を書く。
    //   順: 材料（second-message-materials・既定 on）→ 訴求の判断（second-appeal-judge・LLM・既定 on）→ 書き手 → 締めを揃える（recommend-cta.setRecommendClosing）。
    //   道（返信か AIX か）は決めない（aix-second-link も材料だけ）。
    //   宿題（2026-11-12 統括役・作業員25）: 違う番の読み直し（AIX_SECOND_REREAD）でも twoMsgPlan の planFromMeta(brainMeta)（meta.two_message_plan）は外していない。
    //     今は CONDUCTOR_COMBINE が既定 off で置かれないので効かない。CONDUCTOR_COMBINE を on にする時に、違う番では planFromMeta を読まない（turn_contract.asks から作り直す）ようにする。
    id: "aix_second", name: "AIX の2通目の書き手（✨・材料→訴求の判断→書き手→締めを揃える）", owner: "作業員25（点検）・作業員5（訴求の判断）", stage: "compose",
    files: ["app/api/aix-template-generate/route.ts", "app/lib/second-appeal-judge.ts", "app/lib/second-message-materials.ts", "app/lib/aix-second-link.ts", "app/lib/aix-second-reread.ts", "app/lib/recommend-cta.ts"],
    reads: ["meta.action（AIX の種類）", "AIX の1通目（sentMessage・second-message-materials.sentThisTurn）", "meta.customer_mindset（決め手の残り decideGap・AIX_SECOND_LINK）", "meta.two_message_plan（この通で答える質問）", "meta.engagement_stance", "recommend-cta の刺さり具合の網（締め）"],
    writes: ["aix_second_writer", "log:aix-template-generate:second-appeal-judge", "log:aix-template-generate:recommend-cta", "log:aix-template-generate:second-reread"],
    switch: "SECOND_MSG_MATERIALS（既定 on）・AIX_SECOND_APPEAL_JUDGE（既定 on）・AIX_SECOND_LINK・PROMISE_READ_UNIFIED・AIX_SECOND_REREAD（既定 off）",
    redecides: [
      // 2026-11-12 竹内さんの決定「Aでおねがい」（作業員25）: ブレインの勧めた AIX と押された AIX が違う番は、押された AIX を正としてブレインがその意味で読み直す（2通目の材料だけ・道は押された AIX）
      { of: "brain", field: "ブレインの方向（返信方向・勝ちパターン・成約戦略・判断理由・続けて送る物）→ 押された AIX の意味での読み直し（なぜ今・何に応えるか・押さえる要点）", where: "aix-template-generate aix-second-reread（AIX_SECOND_REREAD・既定 off）", why: "押された AIX が正。古い方向（「出来次第お送りする」等）を2通目に渡さない。読み直せない時は方向を渡さず押された AIX と会話だけ（案B）", example: "実物 48組（押したのは全部 物件オススメ）のうちブレインの一手が違う番 36（返信 25・物件確認した 8・見積書 2・全力サポート 1）。#2 は返信方向「…出来次第お送りする旨を、待ちの形で」が注意書きも無く渡っていた" },
      { of: "aix_second", field: "2通目の締め（recommend-cta の刺さり具合の網が決めた 内覧へ／申込へ／ご査収）", where: "aix-template-generate second-appeal-judge の締め（recCta.kind の上書き）", why: "訴求の判断（LLM）が網と違う締めを選ぶと recCta.kind を closingWhy で書き換える。スタッフが画面で内覧／申込を選んだ時は書き換えない", example: "10/29 同じ30番2回: 締めが竹内さんと同じ 10→21・申込の締め 2/4→0/4（11/04 grp-aix の悪化 2a95c137 は網と違うご査収だけを選んだ）" },
    ],
  },
  {
    id: "two_msg", name: "2通の組み合わせ（何通・どの順・各通の受け持ち）", owner: "作業員7（中身）・作業員5（combine の配線）", stage: "compose",
    files: ["app/lib/two-message-plan.ts", "app/lib/conductor-combine.ts"],
    reads: ["meta.turn_contract.asks", "meta.action", "meta.conductor_focus（訴求できる場面か）", "meta.analyzed_msg_ts"],
    writes: ["meta.two_message_plan", "digest.tm", "digest.or"],
    switch: "CONDUCTOR_COMBINE（既定 off）・TWO_MESSAGE_PLAN",
    redecides: [],
  },
  {
    // 2026-11-12 作業員10（KB P1 c3673fba・80586f34）: 一通の読みと竹内さんの7つの欄から1文ずつの設計図。道の確かめは前の答えの brain から設計図の主の行が出るかで見る（exam-path-check.composePlanMarkers）
    id: "compose_plan", name: "文の統括の1文ずつの設計図（役目・何を・どうやって・次へ・主/従）", owner: "作業員10", stage: "compose",
    files: ["app/lib/compose-sentence-plan.ts", "app/lib/compose-how-table.ts"],
    reads: ["meta.turn_read.main/subs", "meta.seven_read", "meta.turn_contract.asks", "meta.appeal_timing", "meta.customer_concern", "場面（compose-how-table）"],
    writes: ["compose_plan:", "digest.compose_plan"],
    switch: "COMPOSE_SENTENCE_PLAN（11/12 既定 on・戻す =off）",
    redecides: [],
  },
  {
    id: "compose", name: "文の統括（この通の重点・構成→書き手→確かめ）", owner: "作業員9", stage: "compose",
    files: ["app/lib/reply-compose-conductor.ts", "app/api/generate-reply/route.ts（7655行あたりで呼ぶ）"],
    reads: ["meta.conductor_focus", "meta.two_message_plan", "場面", "前の流れ"],
    writes: ["compose_conductor（generate-reply の記録・composeConductorDigest）", "text:turn_contract"],
    switch: "COMPOSE_CONDUCTOR",
    redecides: [
      { of: "intake", field: "重点（meta.conductor_focus が無い時に場面から決め直す）", where: "reply-compose-conductor.ts（read:[] の時）", why: "重点が届いていない時の代わり", example: "q023・q164: 11/06 まで meta.conductor_focus が本番に無く、場面から決め直して読み違えた → CONDUCTOR_FOCUS を既定 shadow に（90ca4b57）" },
    ],
  },
  {
    id: "writer", name: "書き手（返信の文）", owner: "作業員9（11/06 統括役の決め）", stage: "compose",
    files: ["app/api/generate-reply/route.ts", "app/lib/flash-writer.ts"],
    reads: ["meta.turn_contract", "meta.key_topics", "meta.reply_direction", "meta.two_message_plan（planFromMeta）"],
    writes: ["writer", "draft"],
    switch: null,
    redecides: [
      { of: "brain", field: "道（path.code と draft.code の違い）", where: "generate-reply の下書き", why: "下書きが判断と違う道で書く（AIX の番を返信で書く等）" },
      // 2026-11-06 作業員9の気付き（統括役）: 書き手は下に足した注記より、ブレインの方向の文（reply_direction・two-stage の direction）に従う
      { of: "rules", field: "下に足した注記（方向の文の外の1行）", where: "generate-reply の下書き（材料の注記 vs reply_direction）", why: "注記は従われにくく、方向の文は従われる", example: "夜の明日の例: 注記は 9通中2通・方向の文は 3/3 で書かれた" },
      { of: "rules", field: "方向の文に足した線", where: "generate-reply（本質の帯 turn_contract の proposals・customer_questions が上位）", why: "本質の帯が方向の文に足した線より勝つ", example: "q174: 方向の文に足した線が本質の帯に負けて書かれなかった" },
      // 2026-11-06 作業員9: 決まった型の注記が、初回か2回目以降かを見ずに条件の番の締めを決めている（直しは CONDITION_SHAPE_KEEP_FIRST_ONLY・既定 off）
      { of: "brain", field: "条件の番の締め（「全力でサポートさせて頂きます😌！！で締める」）", where: "generate-reply conditionChangeShapeNote の④・newConditionRequestNote の⑤", why: "初回か2回目以降かを見ない決まった型", example: "q010: 竹内さんがこの締めを使うのは初回 80%・2回目以降 39%" },
    ],
  },
  {
    id: "final_check", name: "最終チェック（送る前の確かめ・書き直し）", owner: "作業員9（11/06 統括役の決め）", stage: "verify",
    files: ["app/lib/final-check.ts", "app/lib/final-check-*.ts"],
    reads: ["draft", "材料（事実の出所）"],
    writes: ["final_check", "log:mgmt-"],
    switch: "FINAL_CHECK_*",
    redecides: [
      { of: "writer", field: "下書きの文（要点が消える書き直し）", where: "final-check.ts の書き直し", why: "安全の線（誤った事実・決まり）。ブレインの判断を落とす書き直しは止める（10/08 竹内さん）" },
      // 2026-11-06 作業員9の気付き（統括役）
      { of: "writer", field: "竹内さんの決まりどおりの夜の約束（AIX_BOUNDARY_PROMISE と読んで消す）", where: "final-check.ts rule_check", why: "AIX の境の約束と取り違える", example: "closing2-q136: 夜の約束が rule_check で消えた。方向の文で1文にすると消されない" },
    ],
  },
  {
    id: "exam", name: "試験の統括（何を・何回・どこまで・切り分け）", owner: "作業員8", stage: "exam",
    files: ["scripts/exam-conductor.ts", "scripts/lib/exam-plan.ts"],
    reads: ["答案の trace・digest・essence・path・draft", "CONDUCTOR_LINKS（この表）"],
    writes: ["exam-cache/exam-plans.jsonl", "results/*.json"],
    switch: null, redecides: [],
  },
];

/** 試験の外れの印（例 "decision:two_stage_promise(check)"・"scene_net:S4_viewing"・"demoted:answerable_direct"）から、書いた統括を引く（前方一致・長い一致を先） */
export function ownersOfMarker(marker: string): ConductorLink[] {
  const m = String(marker ?? "").trim();
  if (!m) return [];
  const hits = CONDUCTOR_LINKS.map((c) => ({ c, len: Math.max(0, ...c.writes.filter((w) => m.startsWith(w) || w.startsWith(m)).map((w) => w.length)) })).filter((x) => x.len > 0);
  const best = Math.max(0, ...hits.map((h) => h.len));
  return hits.filter((h) => h.len === best).map((h) => h.c);
}
/** ある統括の出力を、後の統括が読んでいるか（reads に入っているか）／決め直しているか（redecides）の一覧（1行ずつ） */
export function linkageLines(): string[] {
  const out: string[] = [];
  for (const c of CONDUCTOR_LINKS) {
    for (const w of c.writes.filter((x) => x.startsWith("meta."))) {
      const readers = CONDUCTOR_LINKS.filter((d) => d.id !== c.id && d.reads.some((r) => r.startsWith(w))).map((d) => d.id);
      out.push(`${c.id} → ${w}: 読む ${readers.length ? readers.join("・") : "（無し）"}`);
    }
    for (const r of c.redecides) out.push(`${c.id} が ${r.of} の「${r.field}」を決め直す（${r.where}）${r.example ? `＝${r.example}` : ""}`);
  }
  return out;
}

// ── 2026-11-12 作業員7（統括役の決め・作業員24 の根B）: 決め直しの勝ち負けの表 ─────────────────────────────
//   1行＝1つの決め直す所。勝つ側・答案の数（11/08〜・本質は正解なのに最後が外れ＝壊した／その逆＝直した）・決め直してよい条件・記録の印・差し戻し先。
//   決まり: 書き手（writer）は判断の道を決め直さない＝違う道で書いたら差し戻すだけ（mustNotRedecide）。
//   見張り: CONDUCTOR_LINKS の redecides の where が全部この表にあるか（app/lib/__tests__/conductor-linkage.test.ts）。
export type RedecideRule = {
  where: string; by: ConductorLink["id"]; of: ConductorLink["id"]; winner: ConductorLink["id"];
  /** 答案の数（"壊した/直した" か、印が無く数えられない時はその説明） */
  count: string;
  allowWhen: string; mark: string; sendBackTo: ConductorLink["id"] | null;
  /** 決め直してはいけない（差し戻すだけ） */
  mustNotRedecide?: boolean;
};
export const REDECIDE_RULES: readonly RedecideRule[] = [
  { where: "two-stage.resolveTwoStageOrDirect", by: "two_stage", of: "brain", winner: "two_stage", count: "37/139", allowWhen: "確かめる前の依頼で、送れる物・結果が手元に無い時だけ", mark: "decision:two_stage_promise", sendBackTo: "brain" },
  { where: "brain-core.ts answerableDirect（2段の後）", by: "two_stage", of: "two_stage", winner: "two_stage", count: "3/5", allowWhen: "管理会社に確かめれば分かる問いで結果を出せる時（10/21 A1）", mark: "decision:answerable_direct", sendBackTo: "two_stage" },
  { where: "brain-core.ts sceneEvidence のガード（5193行あたり）", by: "scene_net", of: "brain", winner: "scene_net", count: "3/18（viewing_flow_date_wish）", allowWhen: "場面の証拠が強く、ブレインが場面に触れていない時", mark: "scene_net:・signal:", sendBackTo: "brain" },
  { where: "brain-core.ts の rule:*（30種）", by: "rules", of: "brain", winner: "rules", count: "手続きの問い 0/66・初回 0/31・確認の約束を果たす 0/39・出し切りの返信戻し 17/10・2択の見積の絞り 23/15", allowWhen: "P0 の安全の線と、竹内さんの決定のある線だけ（壊した数が直した数より多い線は絞る）", mark: "decision:rule:*", sendBackTo: "brain" },
  { where: "turn-contract.ts sentReactionViewInvite（SENT_REACTION_VIEW_INVITE 既定 on）", by: "rules", of: "two_msg", winner: "rules", count: "外れの切り分け 2/134（log:sent-reaction-no-rewrite）", allowWhen: "送った物件への反応の番だけ", mark: "log:sent-reaction", sendBackTo: "two_msg" },
  { where: "reply-compose-conductor.ts（read:[] の時）", by: "compose", of: "intake", winner: "compose", count: "答案に印が無い（compose の read を答案に残していない）", allowWhen: "meta.conductor_focus が無い時だけ", mark: "compose read:[]", sendBackTo: "intake" },
  { where: "generate-reply の下書き", by: "writer", of: "brain", winner: "brain", count: "外れの切り分け writer:asks 49/134", allowWhen: "決め直してはいけない（差し戻すだけ・下書きの作り直し）", mark: "draft.code≠path・writer:", sendBackTo: "brain", mustNotRedecide: true },
  { where: "generate-reply（本質の帯 turn_contract の proposals・customer_questions が上位）", by: "writer", of: "rules", winner: "rules", count: "答案に印が無い", allowWhen: "本質の帯が勝つ（方向の文に足した線は従）", mark: "text:direction_tail", sendBackTo: "rules", mustNotRedecide: true },
  { where: "generate-reply の下書き（材料の注記 vs reply_direction）", by: "writer", of: "rules", winner: "rules", count: "答案に印が無い", allowWhen: "注記は従・方向の文が主", mark: "text:", sendBackTo: "rules", mustNotRedecide: true },
  { where: "generate-reply conditionChangeShapeNote の④・newConditionRequestNote の⑤", by: "writer", of: "brain", winner: "brain", count: "答案に印が無い", allowWhen: "初回か出し切りの後だけ（10/13 竹内さん）", mark: "conditionChangeShapeNote", sendBackTo: "brain", mustNotRedecide: true },
  { where: "final-check.ts の書き直し", by: "final_check", of: "writer", winner: "final_check", count: "答案に印が無い（試験は最終チェックの前の下書きで採点）", allowWhen: "誤った事実・決まりの線だけ（判断を落とす書き直しは止める）", mark: "final_check", sendBackTo: "writer" },
  // 2026-11-12 作業員7（作業員25 の点検）: AIX の2通目の締め。勝つのは訴求の判断（網＝recommend-cta は材料・設計図の時は網の締めと理由を判断に渡す）。スタッフが画面で選んだ締めは書き換えない
  { where: "aix-template-generate second-appeal-judge の締め（recCta.kind の上書き）", by: "aix_second", of: "aix_second", winner: "aix_second", count: "答案に印が無い（試験は返信の段・AIX の2通目は採点外）。10/29 同じ30番2回で締めが竹内さんと同じ 10→21・申込の締め 2/4→0/4", allowWhen: "スタッフが画面で内覧／申込を選んでいない時だけ（ctaPreference が先）・engagement_stance=wait の時はご査収のまま", mark: "log:aix-template-generate:second-appeal-judge・recommend-cta-closing", sendBackTo: null },
  // 2026-11-12 竹内さんの決定「Aでおねがい」（作業員25）: 押された AIX が勝つ（ブレインは押された AIX の意味で読み直すだけ・道は変えない）
  { where: "aix-template-generate aix-second-reread（AIX_SECOND_REREAD・既定 off）", by: "aix_second", of: "brain", winner: "aix_second", count: "答案に印が無い（AIX の2通目は採点外）。実物 48組で違う番 36（物件ピックアップした→物件オススメの 12 は同じ一手）", allowWhen: "ブレインの一手（meta.action・空＝返信）と押された AIX が違う時だけ（物件ピックアップした⇔物件オススメは同じ）・古い判断は読み直さず案B", mark: "log:aix-template-generate:second-reread", sendBackTo: "brain" },
  { where: "final-check.ts rule_check", by: "final_check", of: "writer", winner: "writer", count: "答案に印が無い", allowWhen: "夜の約束（竹内さんの決まりどおり）は消さない", mark: "final_check:rule_check", sendBackTo: "writer" },
];
