// app/lib/conductor-linkage.ts — 統括同士の連携の表（純関数・DB/LLM なし・作業員5・11/06）
//
// 竹内さんの決定（11/06・KB P1「試験から改善の仕方もちゃんと強化し、統括同士連携させていく」）・P0 575a7cd5（統括の芯）・P1 0dbfbc97（順番の表・後の役は決め直さない）。
//   1行＝1つの統括: 持っている段（FOCUS_ORDER の段）・読む印・書く印・止めるスイッチ・前の統括の決めた事を決め直す所（redecides）。
//   作業員8の「試験の外れの自動の切り分け」（scripts/lib）が、答案から出した印（decision:・two_stage:・scene_net:・demoted:・writer・final_check・log:）を
//   writes の前方一致で引いて持ち主を出す（11/06 作業員8と形を合わせた）。表は記録とコードを読んで作った（LLM なし）。持ち主が決まっていない所は "未定"。
// 置き場: 統括の名簿（conductor-roles.ts の ROSTER）の近く。roadmap の memory/project_conductor_roadmap.md に1段。
export type ConductorStage = "read" | "rough" | "detail" | "compose" | "verify" | "exam";
export type ConductorLink = {
  id: "intake" | "brain" | "two_stage" | "scene_net" | "rules" | "aix_desk" | "two_msg" | "compose" | "writer" | "final_check" | "exam";
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
    writes: ["meta.action", "meta.turn_contract", "meta.key_topics", "meta.reply_mode", "digest.la", "digest.tc", "digest.nd", "digest.tl", "digest.mp", "essence"],
    switch: null,
    // 入口の統括の重点は、判断の時には読まない（shadow・判断を変えない）＝今は並んで走るだけ。深く読み直す時だけ重点に沿わせる
    redecides: [],
  },
  {
    id: "two_stage", name: "2段（送れる物が無い時は約束の返信・answerable_direct で AIX に戻す）", owner: "未定（作業員1 の書き換えの棚卸しで洗い出し済み）", stage: "detail",
    files: ["app/lib/two-stage.ts", "app/lib/brain-core.ts（answerableDirect・4853〜5060行あたり）"],
    reads: ["meta.action（ブレインの AIX）", "売上サポの送れる物件・確認の結果・御見積書の有無", "turn_contract.asks"],
    writes: ["two_stage:", "decision:two_stage_promise", "decision:answerable_direct", "demoted:two_stage", "demoted:answerable"],
    switch: "TWO_STAGE_*・TWO_STAGE_ANSWERABLE_DIRECT・BRAIN_DEMOTE_*",
    redecides: [
      { of: "brain", field: "action（AIX → 約束の返信）", where: "two-stage.resolveTwoStageOrDirect", why: "送れる物が無い時は先に約束（10/02 竹内さん）" },
      { of: "two_stage", field: "2段の約束 → AIX（answerable_direct）", where: "brain-core.ts answerableDirect（2段の後）", why: "すぐ答えられる番は AIX で（10/21 竹内さん A1）", example: "q136: 礼金の調整の依頼で 2段:check が正解なのに、2段の後で answerable_direct が AIX に戻す＝同じ統括の中で決めて決め直す（順番の表の外）" },
    ],
  },
  {
    id: "scene_net", name: "場面の網（場面の証拠・場面で AIX の候補を立てる）", owner: "未定", stage: "detail",
    files: ["app/lib/aix-scene-evidence.ts", "app/lib/reply-scene.ts", "app/lib/brain-scene.ts", "app/lib/reply-subscene.ts"],
    reads: ["今の番のお客様の文（決まった計算）", "主のお部屋（customer-state）"],
    writes: ["scene_net:", "meta.scene_evidence", "decision:scene"],
    switch: "SCENE_EVIDENCE_*",
    redecides: [
      { of: "brain", field: "action（場面の証拠で AIX の候補を立てる・返信を AIX に）", where: "brain-core.ts sceneEvidence のガード（5193行あたり）", why: "見積・確認の結果の依頼の取りこぼし（9/12〜）", example: "q332: 竹内さんは電話の AIX 1通（AIX の中で答える）。場面の網が別の場面（審査・費用）で候補を立てると、ブレインの phone_call と食い違う" },
    ],
  },
  {
    id: "rules", name: "決まった計算の上書き（rule:* の道の決め）", owner: "未定（作業員1 の棚卸し 106か所）", stage: "detail",
    files: ["app/lib/brain-core.ts（rule:closed_ack_wait・viewing_day_ack・procedure_question_reply ほか）", "app/lib/turn-contract.ts（SENT_REACTION_VIEW_INVITE）"],
    reads: ["meta.action", "turn_contract", "送った物・帳面"],
    writes: ["decision:", "demoted:"],
    switch: "各 rule のスイッチ・BRAIN_DEMOTE_*",
    redecides: [
      { of: "brain", field: "action と turn_contract（rule:* の道）", where: "brain-core.ts の rule:*（30種）", why: "取りこぼしの網（決まった計算は候補と安全の線だけ・P0）" },
      { of: "two_msg", field: "返信の受け持ち（内覧の誘いを足す）", where: "turn-contract.ts sentReactionViewInvite（SENT_REACTION_VIEW_INVITE 既定 on）", why: "送った物件に反応した番は返信で内覧の誘い", example: "q055: 正解は 返信 か AIX:viewing_invite のどちらも可。返信に誘いを足す網と、AIX【内覧調整】を選ぶブレイン・2通の組み合わせが同じ「誘い」を別々に持つ" },
    ],
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
    id: "two_msg", name: "2通の組み合わせ（何通・どの順・各通の受け持ち）", owner: "作業員7（中身）・作業員5（combine の配線）", stage: "compose",
    files: ["app/lib/two-message-plan.ts", "app/lib/conductor-combine.ts"],
    reads: ["meta.turn_contract.asks", "meta.action", "meta.conductor_focus（訴求できる場面か）", "meta.analyzed_msg_ts"],
    writes: ["meta.two_message_plan", "digest.tm", "digest.or"],
    switch: "CONDUCTOR_COMBINE（既定 off）・TWO_MESSAGE_PLAN",
    redecides: [],
  },
  {
    id: "compose", name: "文の統括（この通の重点・構成→書き手→確かめ）", owner: "作業員9", stage: "compose",
    files: ["app/lib/reply-compose-conductor.ts", "app/api/generate-reply/route.ts（7655行あたりで呼ぶ）"],
    reads: ["meta.conductor_focus", "meta.two_message_plan", "場面", "前の流れ"],
    writes: ["compose_conductor（generate-reply の記録・composeConductorDigest）"],
    switch: "COMPOSE_CONDUCTOR",
    redecides: [
      { of: "intake", field: "重点（meta.conductor_focus が無い時に場面から決め直す）", where: "reply-compose-conductor.ts（read:[] の時）", why: "重点が届いていない時の代わり", example: "q023・q164: 11/06 まで meta.conductor_focus が本番に無く、場面から決め直して読み違えた → CONDUCTOR_FOCUS を既定 shadow に（90ca4b57）" },
    ],
  },
  {
    id: "writer", name: "書き手（返信の文）", owner: "未定", stage: "compose",
    files: ["app/api/generate-reply/route.ts", "app/lib/flash-writer.ts"],
    reads: ["meta.turn_contract", "meta.key_topics", "meta.reply_direction", "meta.two_message_plan（planFromMeta）"],
    writes: ["writer", "draft"],
    switch: null,
    redecides: [
      { of: "brain", field: "道（path.code と draft.code の違い）", where: "generate-reply の下書き", why: "下書きが判断と違う道で書く（AIX の番を返信で書く等）" },
    ],
  },
  {
    id: "final_check", name: "最終チェック（送る前の確かめ・書き直し）", owner: "未定", stage: "verify",
    files: ["app/lib/final-check.ts", "app/lib/final-check-*.ts"],
    reads: ["draft", "材料（事実の出所）"],
    writes: ["final_check", "log:"],
    switch: "FINAL_CHECK_*",
    redecides: [
      { of: "writer", field: "下書きの文（要点が消える書き直し）", where: "final-check.ts の書き直し", why: "安全の線（誤った事実・決まり）。ブレインの判断を落とす書き直しは止める（10/08 竹内さん）" },
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
