// app/lib/learn-supervisor.ts
//
// 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく。必要ならテーブルを作るなどして強化していく」
//
// なぜ要るか:
//   今までの `learn_plan` は「弱い所の一覧」を返すだけで、**判断**をしていなかった。
//     「写真と記録で種類が違う」が13件並ぶ → どれから直すのか・今の学びは使えるのか・
//     自動検索に渡してよいのかが分からない。
//   → 統括が**判断**する形にする:
//     ① 今の学びは **使えるか**（使える／まだ早い／危ない）＝ 1つの結論
//     ② **次にやる事**を優先順位つきで（どの欄から・なぜ・どう直すか）
//     ③ **サイトごと**（リアプロ／itandi）に分けて判断（性質が違うため）
//     ④ 前回と比べて**良くなったか悪くなったか**（数字で）
//
// ⚠ この関数は**判断だけ**をする（DBに書かない・サイトを触らない）。純関数。

/**
 * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
 *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
 *   場面の名前（日本語）と、場面ごとの手順の読み上げを**統括の言葉**として使う。
 */
import {
  SCENE_JA, describeSceneFlow, findWeakScenes, linkFieldsToScenes, qualityCycleLine,
  type SceneFlow,
} from "./learn-flow-steps";
import { improveLoopTasks, type ImproveLoop } from "./improve-loop";
import { buildHumanDetailLoop } from "./human-detail-loop";
import { diagnoseAutoRecording } from "./auto-rec-diagnose";
import { buildRecChallengeReinforce } from "./rec-challenge-reinforce";
import { buildLearnMemoryLoop } from "./learn-memory-loop";
import { buildOneRecLearnLoop } from "./one-rec-learn-loop";
import { buildProThinkCapability } from "./pro-think-capability";
import { buildAcquireGraspReport } from "./property-acquire-grasp";
import { buildImproveConstruct } from "./pro-improve-construct";
import { ensureGaplessLearnTasks } from "./ensure-gapless-learn";
import { catalogTargetsOnly } from "./button-catalog-targets";
import {
  atomsToTaskHints, linkageLine, subdivideReproduceGaps, summarizeAtoms,
} from "./reproduce-foundation";
import {
  DETAIL_DEGREE, detectPlaceNotRedone, detectSearchBeforeBasic, detectSearchBeforePlace, detailDegreeLine,
  fineGapsToTaskHints, fineLearnEvidenceLine, fineLearnNextSteps, measureAutoCompletion,
  measurePrecision, precisionEvidenceLine, precisionLeversLinked, precisionLeversToTasks,
  scoreFieldsFine, supervisorLearnPower, weakDetailFields,
  type AutoCompletion, type FieldLearnStatus, type PrecisionLever,
} from "./learn-improve-mech";
import { photoLearnLimitFor } from "./shot-learn-limit";
import { buildVisionProLink, type VisionProLink } from "./vision-pro-link";
import { atomsFromEvidence, atomsLine } from "./weak-auto-atoms";
import { DAY_MS, LEARN_PERIODS, logMemoryDays, materialsDays, periodLabelJa } from "./learn-periods";
import { buildLearnPeriodConstruct } from "./learn-period-construct";
import { buildLearnCompleteChain } from "./learn-complete-chain";
import { siteLearnMethodEvidence } from "./site-learn-method";
import {
  ensureMeetingEvidenceGates,
  meetingGateContextFromSupervisorInput,
} from "./meeting-evidence-gates";
import { countSitesParallel, recommendWorkerScale } from "./supervisor-worker-scale";
import type { ImageSequenceFlowSummary } from "./shot-learn";
export { SCENE_JA };

/**
 * ★ 2026-11-16 竹内さん「学習した仕組みも統括ちゃんと理解してよりよく学習できるように
 *   統括じたいの学習能力も上げる」／「学習面の強化を細かく」「仕組みで強化していく形」
 *   ／「より精度上げれるように／精度上げる部分も強化／統括これらの部分ちゃんと連携」
 *   ／「完成度わかればよりよい／完成度も理解して学習する仕組みを統括もつ」:
 *   仕組みは根拠表示だけでなく次手に効かせる。⑨完成度を測り、上がる学習を選ぶ。
 */
export const LEARN_MECHANISMS = [
  "操作のselectをVisionのtextで上書きしない",
  "区は選ぶだけでなく前客の残りを外す",
  "区を選ぶ＝所在地場面",
  "材料点は量・人間動作は再現%と完走率",
  "まとめ文言は学ばない",
  "欄×観点で細かく学ぶ（種類・位置・押して変化・カーソル・外し・場面）",
  "学習改善は仕組みで回す（表示だけで終わらせない）",
  "精度は測って上げる・一連（束→拡張→自動）と食い違う次手は出さない",
  "自動モード完成度を測り、完成度が上がる学習を選ぶ",
  "弱い部分を見つけたらそこを改善する（細部の度を補強・人間の動きになるまで）",
  "動きは毎回変則（学んだ直接の組だけ守る・カーソル出発/狙い/待ちを散らす）",
  "完走優先（保険で途中切り上げない・検索はカーソル移動してから押す）",
  "直接入力しない（カーソル移動→開いて選ぶ／押して打つ。value代入だけで条件を入れない）",
  "画像はflash・まとめはPro（役割を混ぜない。連携: 読む→材料→統括まとめ→課題）",
  "画像flash→材料→Pro判断を細分化してつなぐ（保存→flash読→材料→突合→photo_learn課題→Pro）",
  "サイト別統括にも写真材料を同じ形で渡す（shot_bytes/photo_kinds/image_match・F49写真→統括到達・段1誤報禁止）",
  "人間として自動化する細部改善は F51（弱所→学ぶ→土台→狙って残す→度）で原子1つずつ回す。間隔は動作間だけ測る",
  "自動録画から問題・足りない土台・強化次手を diagnose（auto-rec-diagnose）で出す。地域と駅は F52 でどちらか一方（混在禁止）",
  "弱い所は録画で把握→改善→また録画で強化（足りない通常録画は need_human で要求・土台は先に追加）",
  "学習方法①〜⑤はサイト共通（リアプロで確立→itandiでも同じ型）。DOM・路線駅名・ボタン台帳だけサイト別（F50）",
  "弱点は原子に分けて画像分析→Pro判断→人間らしさ改善（直押し・直書き・外し区別の変バグも細かく直す）",
  "統括Proはなぜ弱い・どうしたらできる・仮定・100%への道を書いてから強化する（推測は仮定と明記）",
  /**
   * ★ 2026-11-16 竹内さん「学習した部分も学習していく／仕組み化の部分も強化」:
   *   一度読んだ欄でも、欄×観点・原子が弱い間は再学習→束→拡張→自動→効果確認を止めない。
   */
  "学んだ欄も弱い間は再強化する（一度読んで終わりにしない・原子が残る限り photo_learn→反映→自動→効果確認）",
  /**
   * ★ 2026-11-16 竹内さん「ほかのお客さんでもずれが起きない／間違えた部分を把握して根本改善／カーソルもクリックも」:
   *   1客のバグ直しで終わらせず、誤りを型にして根元ガードにする。
   */
  "現場の誤りは型で根元改善する（途中進み・畳み欄の直押し・見切れ選択・一覧の上下・カーソル無aimを他客でも再発させない）",
  /**
   * ★ 2026-11-16 竹内さん「統括の部分画像から学習して弱い部分を徹底的に改善し
   *   弱い部分を強化していく仕組みもあわせてつくる」:
   *   弱い欄・原子が残る限り、通常画像→束→拡張→自動→効果確認を周回する（scripts/weak-strengthen.ts）。
   */
  "弱い部分は画像から徹底学習し、弱さが残る限り強化ループを回す（特定→photo_learn→反映→自動→効果→また特定）",
  /**
   * ★ 2026-11-16 竹内さん「1つずつリアプロのボタンのことを理解すればより強化する／
   *   1つずつそれぞれ強化するようにする」:
   *   まとめて読まず、確定・沿線・賃料などボタン／欄ごとに位置・押し方・種類を学ぶ。
   */
  "リアプロのボタンは1つずつ理解して強化する（まとめて読まない・欄ごとにphoto_learn→それぞれ束へ）",
  /**
   * ★ 2026-11-16 竹内さん「proの部分がちゃんと統括できるように連携が弱い部分があれば強化／
   *   改善する際も統括のproと打合せ／細かく細分化／打合せここでするとき統括のproとも連携」:
   *   Cursor の改善も Pro と打合せ（--meet）し、材料を細分化してから直す。
   */
  "改善は統括Proと打合せしてから進める（手元の推測だけで直さない・meetで議題を渡し協力して強化）",
  /**
   * ★ 2026-11-16: 学習期間を揃えないと Pro が別窓の数字で誤判断する。
   */
  "学習材料の期間は揃える（動き・監査・写真は同じ主期間・learn-periods.ts が正本）",
  /**
   * ★ 2026-11-16: 完了→次客は完走率だけでは見えない。
   */
  "完了→次客を原子で把握する（switch_fail・owner_mismatch・no_fill_start・batch_timeout・pipeline_busy・series_done・flow_handoff_gap）",
  "完了理解を段ごとに把握する（place・conditions・search・fill_done・ready_next＝F45）",
  /**
   * ★ 2026-11-17 統括Pro「抜けが後から出る構造原因＝書き込み関所が無い」:
   *   束書き込みは必ず preserve／safe_to_write。新経路は F35/F36 とテスト関所を先に通す。
   */
  "束の書き込みは消さない関所を先に通す（inherit・safe_to_write・F35/F36・新経路は関所テストを先に）",
  /**
   * ★ 2026-11-17 竹内さん「抜けなどあとあと出てこないように統括proはブレインとして仕組みや土台をちゃんとつくる」:
   *   症状が出てから塞ぐのではなく、連携段・保管・反映の完了線を先に定義する。
   */
  "抜けは後追いで塞がず、先に完了線付き土台を作る（F番号・連携段・保管・反映を脳が先回りで定義）",
  /**
   * ★ 2026-11-17 竹内さん「学習の引き・RAG・DB整備／統括proを真のブレインに」:
   *   判断前に設計知見を引き、ログ記憶と手配まで一連にする。
   */
  "統括Proは判断前に設計知見RAGと統括ログを引く（axesだけに頼らない・F37・把握→改善→手配）",
  /**
   * ★ 2026-11-17 竹内さん「把握できるのはかなり重要／設計知見と統括proの連携を細部まで」:
   *   引いただけでは足りない。要旨・ログ・数字を根拠に残し、today先頭で把握を言う。
   */
  "統括Proは把握を根拠に残す（統括Pro把握＝知見要旨＋ログ記憶／todayは把握:で始める）",
  /**
   * ★ 2026-11-17 竹内さん「改善するときも他への影響を考える／学習しても改善されない／拡張へちゃんと反映」:
   *   直す前に影響を洗い、束→拡張→自動→効果確認まで一連。読むだけで終わらせない。
   */
  "改善は他への影響を考えてから行う（消失・読込・自動使用・次客・人間らしさのどれが動くかを書いてから直す）",
  "学習の反映は束→拡張読込→自動1回→F6/F31/F32で確かめる（read_countだけでは改善済みにしない・needs_autoなら自動を手配）",
  /**
   * ★ 2026-11-17 竹内さん「この考え方をかなり大切にする」:
   *   統括Proが脳として機能し、自動の弱点がすぐ分かり、何が改善に必要か・どう強化するか・
   *   どんな土台が要るかを理解して追加できる。録画からも学ぶ。仕組みづくりの核。
   */
  "統括Proは脳として自動の弱点をすぐ把握し、必要な土台・強化の仕方を理解して追加する（自動録画で弱所→通常録画から学ぶ→土台F番号を足す→細分化強化→効果確認／F46録画反映・F47流れ地図）",
  /**
   * ★ 2026-11-18 竹内さん「1度の録画で学習と改善と反映」:
   *   弱所は1本に全部ある。学び・仕組み直し・反映・学び方強化を同じ周で抜けなく回す。
   */
  "1度の録画で学習→改善→反映まで完走する（one-rec-learn-loop・原子抽出→仕組み直し→再読込→自動1回→verify印→学び方強化）",
  /**
   * ★ 2026-11-18 HONOKA: 間取り部分完了禁止・検索リロード生存。
   */
  "間取りは欲しい全部がhitするまで完了にしない／検索はclick直前にsearch_armedで物件取得を生存させる（Case C）",
  /**
   * ★ 2026-11-18 竹内さん「何が足りないか／どう強化・改善するか考える能力」:
   */
  "統括Proは足りない→どう強化→どう改善を考える骨格を持つ（pro-think-capability・画像細部原子・仮定と100%への道）",
  "画像学習は学べ枚数だけでなく種類到達・未読課題・衝突・記録≠写真・位置細部まで徹底する（中央固定だらけは未達）",
  /**
   * ★ 2026-11-18 竹内さん「送付済みは送ったと把握／取得タイミングと連携」:
   */
  "送付済み物件は『送った』と把握してから次へ進む（飛ばす＝失敗ではない・all_sent→次頁／客完了）",
  "物件取得は段で把握する（wait_fill→armed→sent把握→filter→press→page_done）／開始前と送付済詰まりを分けて測る",
  /**
   * ★ 2026-11-18 竹内さん「学習→どう強化／仕組み／足りない／補強／改善構築／次／反映／志向／自動」:
   */
  "統括Proは学習のあと改善する仕組みを構築する（足りない→どう強化→どんな仕組み→構築→束→拡張→自動1回→効果）",
  "統括Proの志向は『次にどう構築し自動へ反映するか』まで（build_next・path_to_100・verify_improveを欠かさない）",
  /**
   * ★ 2026-11-18 竹内さん「学習の抜け・土台・連携／人間のように原因思考／再学習／録画+DB徹底／土台徹底」:
   */
  "統括Proは学習・土台・連携の抜けを録画とDBから細かく見て、人間のように原因→どう改善を考える",
  "新しい考え方で原因と改善対象を全部再学習する（症状→原因→層→手→土台F→自動反映）",
  "土台は件数だけでなく id×完了線×次手で徹底強化する（抜けを後追いで塞がない）",
  /**
   * ★ 2026-11-18 竹内さん「設計知見と統括Proともちゃんと連携／細かい部分も抜けない」:
   */
  "設計知見と統括Proは引く→要旨把握→土台/次手へ落とす→課題へ落とす→細部材料まで一連で連携する（題だけ・引きっぱなし禁止）",
] as const;

/** 操作がプルダウンと分かっている欄（Visionのtext割れを次手にしない） */
const KNOWN_SELECT_FIELD_RE =
  /^(rental_cost|update_date|square_meter|structured_date|transportation_id|required_time)/i;

export function isKnownSelectField(name: string): boolean {
  return KNOWN_SELECT_FIELD_RE.test(String(name || "").trim());
}

/** Vision select/text 誤割れを次手から落とす（操作がselectなら位置学習へ） */
export function isFalseKindConflict(
  kind: string,
  name: string,
  why: string,
): boolean {
  if (String(kind) !== "kind_conflict_in_photo") return false;
  const w = String(why || "");
  if (!/select/.test(w) || !/text/.test(w)) return false;
  return isKnownSelectField(name) || /プルダウン|select/.test(w);
}

type MechTask = {
  kind: string;
  what: string;
  why: string;
  cost: string;
  limit?: number;
  order?: "newest" | "time" | "size" | "sequence";
  runId?: string;
  fields?: string[];
};

/**
 * 学習の仕組みを課題に効かせる（表示用の証拠と同じ定数を使う）。
 * ・photo_learn の既知select欄 → 「種類の再判定」ではなく位置・押し方
 * ・くれあ型の外し（toggles.off）→ ward-off 土台を課題に載せる
 */
export function applyLearnedMechanismsToTasks(
  tasks: MechTask[],
  opts?: { togglesOff?: number; togglesOn?: number; togglesUnknown?: number },
): MechTask[] {
  const out = tasks.map((t) => ({ ...t, fields: t.fields ? [...t.fields] : undefined }));
  for (const t of out) {
    if (t.kind !== "photo_learn" || !t.fields?.length) continue;
    const selects = t.fields.filter(isKnownSelectField);
    if (!selects.length) continue;
    if (!/selectをVision|位置・押し方|操作のselect/.test(t.why)) {
      t.why = `${t.why}／仕組み①: ${selects.slice(0, 4).join("・")}は操作のselectを優先（Visionのtextで上書きしない・位置・押し方を学ぶ）`;
    }
    if (!/位置|押し方|select/.test(t.what)) {
      t.what = t.what.replace(/欄の種類・位置/, "欄の位置・押し方（種類は操作のselectを優先）");
      if (!/位置・押し方|selectを優先/.test(t.what)) {
        t.what = `${t.what}（既知selectは位置・押し方）`;
      }
    }
  }
  const offN = opts?.togglesOff ?? 0;
  const onN = opts?.togglesOn ?? 0;
  const unkN = opts?.togglesUnknown ?? 0;
  if (offN > 0 && !out.some((t) => t.kind === "build_foundation" && /区|外す|ward|くれあ/.test(t.what + t.why))) {
    const existing = out.find((t) => t.kind === "build_foundation");
    if (existing) {
      if (!/くれあ|区.*外|前客/.test(existing.why)) {
        existing.why = `${existing.why}／仕組み②: 外し${offN}件（選んだ${onN}件）→条件外の区だけ外し・条件内は触らない`;
      }
    } else {
      out.push({
        kind: "build_foundation",
        what: "区の外し土台（くれあ型: 条件外だけOFF・条件内は触らない）",
        why: `仕組み②: 前客の残りを外す操作が${offN}件（選んだ${onN}件）。区は選ぶだけでなく外す型を束へ`,
        cost: "無料",
        fields: undefined,
      });
    }
  }
  /**
   * ★ 2026-11-16 DB実測: 外し/選びが全部「区別できない」（was/now 0件）なのに
   *   仕組み②を学べないまま次へ進むと、くれあ型の区外しが永遠に再現できない。
   *   → 区別できない時は was/now が届く録画を課題にする。
   */
  if (unkN > 50 && offN === 0 && onN === 0
    && !out.some((t) => /was\/now|外し.*区別|区別できない/.test(t.what + t.why))) {
    out.push({
      kind: "build_foundation",
      what: "区の外し/選びを区別できる記録（was/now）を通常録画で取る",
      why: `仕組み②の材料が無い: 区別できない ${unkN}件・外し0・選び0。拡張再読込後、通常で区を1つ外す→1つ選ぶを録画して was/now がDBに残るか確かめる`,
      cost: "無料（人の手間だけ）",
      fields: undefined,
    });
  }
  return out;
}

/** 判断に使う材料（学習の束から作る） */
export type SupervisorInput = {
  /** 元にした記録の数と期間 */
  rows: number;
  /** 押す順番が学べた通り数 */
  next: number;
  /** 押す位置が学べた要素数 */
  points: number;
  /** 開き方が学べた要素数 */
  opens: number;
  /** 画面ごとの手順が学べた種類数 */
  screens: number;
  /** 一連の動きの手数 */
  sequence: number;
  /** 操作の間（中央値 ms） */
  gap_ms: number | null;
  /** 弱い所（種類・名前） */
  weak: ReadonlyArray<{ kind: string; name: string; why?: string }>;
  /** モード別の記録数（normal / staff / aix …） */
  mode_counts?: Record<string, number>;
  /**
   * ★ 2026-11-15 竹内さん「ほかのPCでやってもちゃんと学習されるようになっているか」（main 側の決定を取り込み・2026-11-19 統合）:
   *   **端末ごとの記録数**。⚠ 1台だけなら `single_device: true`（他のPCが学習に参加していない）。
   */
  device_count?: number;
  devices?: Array<{ device: string; n: number; with_ops: number }>;
  single_device?: boolean;
  /** サイト別の記録数（realpro / itandi） */
  site_counts?: Record<string, number>;
  /** 材料（操作の並び）がある記録の数 */
  with_ops?: number;
  /** 前回の判断（比較用・無ければ null） */
  prev?: {
    at: string | null;
    rows: number;
    next: number;
    points: number;
    opens: number;
    weak: number;
    /**
     * ★ 2026-11-15 竹内さん「学習も弱い部分を見つけて強化できるようにするために」:
     *   **前回の弱い所の一覧**（`kind|name`）。これと比べて
     *   「直った（前回あって今回無い）」と「まだ直っていない（両方ある）」を分ける。
     *   ⚠ 無い（旧い記録）時は比べない（初回と同じ扱い）。
     */
    prevWeak?: Array<{ kind?: string; name?: string }> | null;
  } | null;
  /** サイト（この判断がどのサイトの物か・all なら全体） */
  site?: string;
  /**
   * 2026-11-14 竹内さん「打ち合わせは絶対にここの統括が話をしてくるようにする」:
   *   「押したら何が開くか」のうち**推測**で埋めた数（実測ではない）。
   *   ⚠ 推測を実測と同じ重さで点数に入れると、学べていないのに高得点になる。
   */
  guessed_opens?: number;
  /** 2026-11-14: 写真がある記録の数（写真の割合を実データから出す） */
  shot_rows?: number;
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」
   *   「統括がちゃんと学習にの指示だし把握できるように細かい部分まで徹底する」:
   *   **人が押した操作**と**拡張が押した操作**の数。
   *   ⚠ 自動検索の改善に使えるのは**人の手本**だけ（機械の動きを学ぶと自分の癖を強める）。
   */
  human_ops?: number;
  auto_ops?: number;
  /**
   * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
   *   **同じ画面が続いている**記録（`same_runs`）。多ければ**撮影の仕組みが壊れている**疑い。
   */
  same_runs?: { n: number; max_same: number } | null;
  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする。統括がこのような部分もはんだんできるようにする」:
   *   **写真の容量と枚数**。1枚が大きすぎる・合計が重すぎる時に言えるようにする。
   *
   * ★ 2026-11-15「画像データベースの保存されている／統括は把握する」:
   *   `in_storage`＝Storage（human-motion-shots）に shot_key で保存済みの枚数。
   *   ⚠ `shot_in_db`／行内 b64 空＝未保存ではない（正本は Storage）。
   */
  shot_bytes?: {
    n: number;
    total_bytes: number;
    max_bytes: number;
    in_storage?: number;
    in_row_b64?: number;
    large?: number;
  } | null;
  /**
   * 2026-11-14 竹内さん
   *   「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   **場面ごとの手順**（`app/lib/learn-flow-steps.ts` の `learnSceneFlows` の結果）。
   *   ⚠ 写真が1枚も取れていなくても学べる材料（`search_audits.filled.ops` に人の順番が残っている）。
   *     実測: 7日で 56件中32件に押した順番があり、所在地17回・条件18回・駅14回・検索18回・物件16回。
   */
  scene_flows?: Array<{
    scene: import("./learn-flow-steps").FlowScene;
    runs: number;
    ops: number;
    raw_ops?: number;
    steps: string[];
    variants: number;
    gap_ms: number | null;
  }> | null;
  /** 手本が1件も無い場面の数（「学べていない」と言うため） */
  scene_missing?: number;
  /** 手本が無い場面の名前（日本語・読点区切り） */
  scene_missing_names?: string;
  /** 止まった回が一番多い場面（`search_audits` の status が finished でない回の最後の場面） */
  stopped_scene?: string | null;
  /**
   * 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」:
   *   **今日なにを強化したか**（`learn_improvements` の集計）。
   *   ⚠ 判断の材料ではなく**実績**（点は上げない・効いたかは数字で確かめる）。
   */
  improvements?: {
    total: number;
    by_area: Array<{ area: string; n: number }>;
    /**
     * ★ 2026-11-15 竹内さん「このように進化した部分ちゃんと統括にはいるようにする」（main 側の決定を取り込み）:
     *   直した**中身**（題・なぜ・どう・効果）。統括が言葉にする（点は上げない）。
     */
    recent?: Array<{ at: string; area: string; title: string; why: string; how: string; effect: string }>;
  } | null;
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の結果**（`search_audits` の集計）。これが無いと統括は現場の現実を知らない
   *   （実測: 60回中56回が途中で止まっていたのに「渡してよい」と言っていた）。
   */
  audits?: {
    runs: number;
    finished: number;
    abandoned: number;
    /** ⚠ 2026-11-15: 判断できない回（操作の記録が無い）。完走率の分母から外す */
    unknown?: number;
    finish_rate: number;
    /** 止まった場所（日本語・多い順） */
    stalled_at?: Array<{ stage: string; n: number }>;
    causes?: Array<{ cause: string; n: number }>;
    bad?: number;
    top_problem?: string | null;
    advice?: string | null;
    /**
     * ★ 2026-11-16: 完了→次客の細分化（switch_fail / owner_mismatch 等）
     *   Pro が「完走率だけ」で終わらせず、次客に移れない穴を把握する材料。
     */
    handoff?: {
      switch_fail: number;
      owner_mismatch: number;
      no_fill_start: number;
      batch_timeout: number;
      pipeline_busy: number;
      tab_reload?: number;
      supersede?: number;
      series_done?: number;
      flow_handoff_gap?: number;
      line: string;
      top?: Array<{ id: string; n: number }>;
    } | null;
    /** ★ F45 完了理解台帳 */
    flow?: {
      place_ok: number;
      conditions_ok: number;
      search_ok: number;
      fill_done_ok: number;
      ready_next: number;
      series_done: number;
      gaps: number;
      line: string;
      top?: Array<{ id: string; n: number }>;
    } | null;
  } | null;
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示（自動便・一括検索）が詰まっていないか**（`automation_commands` の集計）。
   *   ⚠ これを入れないと、統括は「検索は止まっていない」と言いながら
   *     **指示が溜まったまま／失敗したまま**という現場の詰まりを見落とす。
   */
  commands?: {
    /** 期間内の指示の数 */
    total: number;
    /** 終わった数 */
    done: number;
    /** 失敗した数 */
    failed: number;
    /** まだ拾われていない（pending） */
    pending: number;
    /** 実行中（running） */
    running: number;
    /** 失敗の理由（多い順） */
    errors?: Array<{ error: string; n: number }>;
    /** 一番の問題を1文で */
    top_problem?: string | null;
    /** 「自動/AIXモードのPCが無かった」で終わった数（運用の問題・処理ではない） */
    mode_absent?: { aix_absent: number; brain_absent: number } | null;
  } | null;
  /**
   * ★ 2026-11-15 竹内さん「3組目の悠さんは駅での検索なので、前に残っていた
   *   泉大津市・西成区・住之江区・浪速区を外すために押している。
   *   選択しているのではなくて押すことで前に残っている部分をはずしている」
   *
   *   **外した数・選んだ数**（押す前と後の checked から決める・`toggle-meaning.ts`）。
   *   ⚠ これが無いと統括は「泉大津市を選んでいる」と**正反対に読む**（実測で2回誤読）。
   *   `off` が多い回は「前のお客さんの条件が残っていた」証拠。
   */
  toggles?: { off: number; on: number; unknown: number } | null;
  /**
   * ★ 2026-11-15 竹内さん「統括の部分に学習した部分が届いていない…必ず届くように」:
   *   **写真から読んだ欄の種類の内訳**（`{select:12, checkbox:8, ...}`）。
   *   ⚠ 実測: 写真から415件学んでいたのに、統括には数（total/with_ops）しか渡っていなかった。
   */
  photoKinds?: Record<string, number> | null;
  /**
   * ★ 2026-11-15 竹内さん「押した位置も通常モードの録画の画像から連続で読み取れば理解できる
   *   それを自動に学習させる」「統括お願い」:
   *   **通常モードの画像×押した位置**の突き合わせ（`image-point-match.ts`）。
   *   ⚠ これが無いと統括は「押した位置も画像で分かる」と言えない。
   */
  image_match?: {
    /** 画像から読んだ欄（通常モード） */
    imageFields: number;
    /** 押した位置がある欄 */
    pressedFields: number;
    /** 両方にある欄 */
    matched: number;
    /** 画面の位置（x/y）が取れた欄 */
    withScreenPos: number;
    /** 統括が言える事（悪い所だけ） */
    say: Array<{ what: string; why: string; next: string }>;
    line: string;
  } | null;
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   **学んだ位置が自動まで届いているか**（束にある／拡張が読んだ／自動が新束のあと走った）。
   *   ⚠ 実測: 束に x/y 71欄あったのに `read_count=0`・自動は束より前 → **学んだのに現場に未反映**。
   */
  bundle_reflect?: {
    /** 拡張が使う（n≥3 かつ x/y）欄数 */
    screen_solid: number;
    /** x/y がある欄数 */
    screen_all: number;
    /** 束を拡張が読んだ回数（0＝未取得）。※作った時点の値は「前の束」の読まれ数（prev_read_count と同じ）。判定には judged_read_count を使う */
    read_count: number;
    /** ★ 2026-11-20: **判断する束**（この束）の読まれ数。作る時は必ず 0（作ったばかり）・統括Pro では DB の最新行の今の値 */
    judged_read_count?: number;
    /** ★ 2026-11-20: 作った時点の前の束の読まれ数（今、拡張が使っている束） */
    prev_read_count?: number;
    read_at?: string | null;
    /** 最新束のあとに自動モードの記録があるか */
    auto_after: boolean;
    line: string;
    /** ★ 2026-11-15: 止まっている段階（会話でボトルネックを言う） */
    bottleneck?: string | null;
    bottleneck_n?: number | null;
    photo_in_storage?: number;
    steps?: Array<{ n: number; name: string; ok: boolean; detail: string }>;
  } | null;
  /**
   * ★ 2026-11-15: 自動モードが人間のように動けているか（`human-like-audit.ts`）
   */
  human_like?: {
    ops: number;
    typedOnChoose: number;
    clickedThenChanged: number;
    clickedThenChangedFields?: string[];
    changedWithoutClick: number;
    changedWithoutClickFields?: string[];
    withCursor: number;
    withPoint: number;
    rows: number;
    handCursorClicks?: number;
    handCursorFields?: string[];
  } | null;
  /** ★ 2026-11-18: 欄×観点の細部採点に使う既存材料（画像位置判明欄・操作種別判明欄） */
  image_position_fields?: string[] | null;
  ops_kind_fields?: string[] | null;
  /**
   * ★ 2026-11-17 統括Pro: 通常vs自動の近さ差分（許可線つき）
   *   human-nearness.ts と同じ式。束に載せて Pro / 関所が使う。
   */
  human_nearness?: {
    score: number;
    allowed: boolean;
    line: string;
    gaps?: string[];
    auto_fast400pct?: number | null;
    normal_fast400pct?: number | null;
    auto_humanBandPct?: number | null;
    normal_humanBandPct?: number | null;
    auto_p50?: number | null;
    normal_p50?: number | null;
    auto_gN?: number;
    normal_gN?: number;
    allow_scoreMin?: number;
    allow_fast400MaxPct?: number;
    allow_humanBandMinPct?: number;
  } | null;
  /**
   * ★ 2026-11-17 竹内さん「統括は土台を理解して統括できるように」:
   *   foundation-audit の圧縮形（F29近さ・F31反映・F32連携など）。
   */
  foundation_audit?: import("./learn-foundation-audit").FoundationForSupervisor | null;
  /** 学習の抜け（全モード） */
  shot_gaps?: { total: number; unlearnedBig: number; unlearnedSmall: number; learnedButEmpty: number; learnedOk: number; todo: number } | null;
  /**
   * ★ 2026-11-15「通常モードの録画で画像のデータあるのだから底から学習」:
   *   通常モードだけの写真抜け（手本。自動は混ぜない）。
   */
  shot_gaps_normal?: { total: number; unlearnedBig: number; unlearnedSmall: number; learnedButEmpty: number; learnedOk: number; todo: number } | null;
  /**
   * ★ 2026-11-15「画像は最新で録画したらそのことも把握」
   */
  recording_freshness?: {
    normalLatestAt?: string | null; autoLatestAt?: string | null;
    normalLast24h?: number; autoLast24h?: number;
    normalLatestLearned?: boolean | null; line?: string;
  } | null;
  /** 自動モードの最新課題（通常から改善する対象） */
  latest_auto_challenge?: {
    runs?: number; extVersion?: string | null; fields?: string[];
    changedNoClick?: string[]; retries?: string[]; line?: string;
    challenges?: Array<{ what: string; why: string; field?: string }>;
  } | null;
  /** 自動の最新課題を通常から直す計画 */
  improve_from_normal?: {
    fields?: string[]; what?: string; why?: string; how?: string; preferNewest?: boolean;
  } | null;
  /**
   * ★ 2026-11-15「改善につながるまで一連」: 段階1〜6と次の一手
   */
  improve_loop?: {
    improve_line?: string;
    bottleneck_n?: number | null;
    bottleneck?: string | null;
    next_n?: number | null;
    next_kind?: string | null;
    steps?: Array<{ n: number; name: string; ok: boolean; detail: string }>;
  } | null;
  /**
   * ★ 2026-11-15「画像から学習した部分はちゃんと改善して更新」:
   *   最新自動の課題欄のうち、束に x/y がまだ無いもの。
   */
  challenge_missing_in_bundle?: string[] | null;
  /** 自動モードの改善候補（統括が順番を決める） */
  auto_fix?: Array<{ key: string; what: string; why: string; how: string; cost: string; effect: string }> | null;
  /** ★ 2026-11-18: 連続画像ランから学んだ場面連鎖・詰まり・未読ラン */
  image_flows?: ImageSequenceFlowSummary | null;
};

export type SupervisorVerdict = "ready" | "almost" | "not_yet" | "unsafe";

/** 結論の日本語（1か所だけで持つ） */
const HEAD: Record<SupervisorVerdict, string> = {
  ready: "学べています（自動検索に渡してよい）",
  almost: "もう少しで使えます（一部は自動に渡しています）",
  not_yet: "まだ学べていません（自動に渡すと危ない）",
  unsafe: "危ない（自動に渡さない方がよい）",
};

export type SupervisorAdvice = {
  /** ① 結論（1つ） */
  verdict: SupervisorVerdict;
  /** 人が読む1行の結論 */
  headline: string;
  /** ② 次にやる事（優先順位つき・最大8件） */
  actions: Array<{ priority: number; what: string; why: string; how: string; name?: string }>;
  /** ③ 数で見た状態 */
  score: {
    /** 学びの材料がどれだけ揃っているか（0〜100） */
    coverage: number;
    /** 弱い所の数（少ないほど良い） */
    weak: number;
    /** 前回より良くなったか（+良くなった / -悪くなった / 0同じ / null比べられない） */
    delta: { rows: number; next: number; points: number; opens: number; weak: number } | null;
  };
  /** ④ 止めるべき理由（危ない時だけ・無ければ null） */
  block: string | null;
  /** ⑤ 人が読む行（画面・報告用） */
  lines: string[];
  /**
   * ★ 2026-11-15 竹内さん「学習も弱い部分を見つけて強化できるようにするために」（main 側の決定を取り込み）:
   *   **直った物**（前回あって今回無い）。⚠ 点は上げない（言葉にするだけ）。
   */
  fixed?: Array<{ kind: string; name: string }>;
  /** 前回も同じ指摘（まだ直っていない）の数 */
  ongoing?: number;
  /**
   * 2026-11-14 竹内さん「打ち合わせは絶対にここの統括が話をしてくるようにする」:
   *   **打ち合わせで統括自身が話す内容**（議題・根拠・竹内さんへの質問）。
   *   ⚠ ただの数字の列ではなく「**何を決めたいか**」を出す。
   *   ・today     … 今日の結論（1〜3行）
   *   ・agenda    … 議題（決めたい事・相談したい事）優先順位つき
   *   ・questions … 竹内さんに聞く事（統括だけでは決められない）
   *   ・evidence  … 根拠（数字・実測。推測は「推測」と明記）
   */
  meeting: {
    /** 今日の結論（そのまま読み上げられる形） */
    today: string[];
    /** 議題（優先順位つき） */
    agenda: Array<{ priority: number; topic: string; why: string; decide: string }>;
    /** 竹内さんに聞く事（判断を委ねる） */
    questions: Array<{ q: string; options?: string[]; why: string }>;
    /** ★ 2026-11-19 統括Pro が迷った所（推奨つき・trigger つき）。台帳 owner_questions へは supervisor-pro.ts --save が入れる */
    owner_asks?: Array<{ question: string; options: string[]; recommended: string; why: string; trigger: string; source: "pro" | "gate"; key: string }>;
      /** 根拠（数字。推測は guessed:true） */
    evidence: Array<{ label: string; value: string; guessed?: boolean }>;
    /**
     * 2026-11-14 竹内さん「必要な部分を統括が判断して学習すれば強化される」:
     *   **統括が決めた「次に学ぶ事」**（優先順・費用つき）。
     *   `supervisor-do` がこれを読んで上から実行する（竹内さんが毎回指図しなくてよい形）。
     *   ⚠ `photo_learn` は1枚ごとに費用がかかるので `limit` を必ず付ける。
     */
    learning_tasks?: Array<{ kind: string; what: string; why: string; cost: string; limit?: number; order?: "newest" | "time" | "size" | "sequence"; runId?: string; fields?: string[] }>;
    /**
     * ★ 2026-11-16: 画像flash→材料→Pro の細かい連携（vision-pro-link.ts）。
     *   学習→自動の一連（bundle-reflect）とは別軸。統括が「画像学習のどこで止まっているか」を言う。
     */
    vision_pro_link?: VisionProLink;
    };
  /**
   * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい」:
   *   **統括が自分の判断を点検した結果**（矛盾が無いか）。
   *   ⚠ 矛盾があれば `ok:false` と `issues` に理由を出す。会話では先にこれを言う。
   */
  self_check: {
    ok: boolean;
    /** 見つけた矛盾（人が読める形） */
    issues: string[];
    /** 上限をかけた理由（あれば） */
    capped_by: string | null;
  };
};

/** 弱い所の種類ごとに「どう直すか」 */
const FIX: Record<string, { what: string; how: string; priority: number }> = {
  photo_vs_record: {
    what: "記録と写真で欄の種類が違う",
    how: "実際の画面を見て、その欄が select（プルダウン）か input（入力）かを確かめる。`shot_learn` を写真から読み直す",
    priority: 1,
  },
  kind_conflict_in_photo: {
    what: "同じ欄が写真の中で違う種類に見えた",
    how: "2枚以上の写真で同じ欄を読み、多い方を採る（1枚だけで決めない）",
    priority: 2,
  },
  kind_unknown: {
    what: "欄の種類が分からない",
    how: "名前から推す（`room_layout_id[]`→チェック、`rental_cost2`→プルダウン、`required_time`→入力）",
    priority: 3,
  },
  pressed_disabled: {
    what: "押せない（グレー）物を押そうとした",
    how: "押す前に「押せるか」を見る（`disabled` / `pointer-events:none` / グレーの見た目）",
    priority: 1,
  },
};

/**
 * 統括の判断（純関数）。
 *   ① 今の学びが**使えるか**を1つに決める
 *   ② **次にやる事**を優先順位で並べる
 *   ③ 数字で良し悪しを出す
 */
export function superviseLearn(input: SupervisorInput): SupervisorAdvice {
  const inp = input || ({} as SupervisorInput);
  const site = String(inp.site || "all");
  const rows = num(inp.rows);
  const next = num(inp.next);
  const points = num(inp.points);
  const opens = num(inp.opens);
  const screens = num(inp.screens);
  const sequence = num(inp.sequence);
  const withOps = num(inp.with_ops);
  const weakList = Array.isArray(inp.weak) ? inp.weak : [];
  const weakN = weakList.length;

  /**
   * ★ 2026-11-15 竹内さん「学習も弱い部分を見つけて強化できるようにするために」（main 側の決定を取り込み・2026-11-19 統合）:
   *   ⚠ **実測で判明（統括が「直ったか」を確かめていなかった）**:
   *     同じ指摘「欄の種類が分からない」が **1,241回**出ていた。
   *     ところが**直近の束では全部判定済み**（photo 26個・name 32個・なしは5個だけ）。
   *     ＝ もう直っているのに、統括は**過去の記録を数え続けて**同じ事を言っていた。
   *   前回の指摘と比べて3つに分ける。
   *     ・`fixed`    … 前回あって今回**無い**（直った）→ 言葉で「直りました」と言う（点は上げない）
   *     ・`ongoing`  … 前回も今回もある（まだ直っていない）→ **優先度を上げる**（同じ事を言い続けない）
   *     ・`new`      … 今回だけ（新しい指摘）
   *     ⚠ 前回が無い（初回）時は全部 `new`（比べる相手が無い）。
   */
  const prevWeak: ReadonlyArray<{ kind?: string; name?: string }> =
    inp.prev && Array.isArray(inp.prev.prevWeak) ? inp.prev.prevWeak : [];
  const keyOf = (w: { kind?: string; name?: string }) => String(w.kind || "") + "|" + String(w.name || "");
  const prevKeys = new Set(prevWeak.map(keyOf).filter((k) => !k.startsWith("|") && k !== "|"));
  const nowKeys = new Set(weakList.filter((w) => w && w.name).map((w) => keyOf(w)));
  /** 前回あって今回無い＝直った（最大6件・名前つき） */
  const fixedWeak = prevKeys.size
    ? prevWeak.filter((w) => { const k = keyOf(w); return k && !nowKeys.has(k); }).slice(0, 6)
      .map((w) => ({ kind: String(w.kind || ""), name: String(w.name || "").slice(0, 40) }))
    : [];
  /** 前回も今回もある＝まだ直っていない（優先度を上げる） */
  const ongoingKeys = new Set([...prevKeys].filter((k) => nowKeys.has(k)));

  /**
   * 材料の揃い具合（0〜100）。何が「学べた」と言えるかの目安:
   *   ・押す順番 10通り以上 … 25点
   *   ・押す場所 20個以上 … 25点
   *   ・開き方 5個以上 … 15点
   *   ・画面ごとの手順 2種類以上 … 15点
   *   ・材料（操作の並び）がある記録が 50件以上 … 20点
   */
  let coverage = 0;
  if (next >= 10) coverage += 25; else if (next >= 5) coverage += 15; else if (next >= 1) coverage += 8;
  if (points >= 20) coverage += 25; else if (points >= 10) coverage += 15; else if (points >= 1) coverage += 8;
  if (opens >= 5) coverage += 15; else if (opens >= 1) coverage += 8;
  if (screens >= 2) coverage += 15; else if (screens >= 1) coverage += 8;
  if (withOps >= 50) coverage += 20; else if (withOps >= 10) coverage += 12; else if (withOps >= 1) coverage += 5;

  const actions: SupervisorAdvice["actions"] = [];
  const seen = new Set<string>();

  // ── ② 次にやる事 ──
  /**
   * ★ 2026-11-15 竹内さん「通常モードの録画で画像のデータあるのだから底から学習」
   *   「画像を読み取れば学習できる」「弱い部分強化するためによみとる」:
   *   弱い所がある＋通常の読める写真が未学習 → **録画を増やせではなく画像を読め**。
   */
  const gapsN0 = (() => {
    const g = (inp as unknown as Record<string, unknown>).shot_gaps_normal
      ?? (inp as unknown as Record<string, unknown>).shot_gaps;
    if (!g || typeof g !== "object") return null;
    const o = g as Record<string, unknown>;
    const todo = num(o.todo);
    return todo > 0 ? { todo, learnedOk: num(o.learnedOk), total: num(o.total) } : null;
  })();
  /**
   * ★ 2026-11-15「改善につながるまで一連」:
   *   段階4なら拡張再読み込みが先頭（画像を足しても自動は改善されない）。
   */
  const loop0 = (inp as unknown as Record<string, unknown>).improve_loop as {
    bottleneck_n?: number | null; improve_line?: string; bottleneck?: string;
  } | null | undefined;
  const improve0 = (inp as unknown as Record<string, unknown>).improve_from_normal as {
    what?: string; why?: string; how?: string; fields?: string[];
  } | null | undefined;
  if (loop0 && loop0.bottleneck_n === 4) {
    actions.push({
      priority: 0,
      what: "拡張を再読み込みして、最新の束を取り直す（改善までの一連・段階4）",
      why: loop0.bottleneck || loop0.improve_line || "read_count=0。学んだ位置が拡張に届いていない",
      how: "拡張 2.8.25 を再読み込み → ポップアップを開く（束取得）→ コンソールで「連携完了」→ 自動を1回 → 効果を数字で確かめる",
    });
  } else if (loop0 && loop0.bottleneck_n === 5) {
    actions.push({
      priority: 0,
      what: "自動モードで1回検索する（改善までの一連・段階5）",
      why: loop0.bottleneck || "拡張は読んだが新束のあとの自動が無い",
      how: "自動モードで1回検索 → 課題欄が減ったか verify_improve",
    });
  } else if (improve0 && improve0.what && Array.isArray(improve0.fields) && improve0.fields.length) {
    actions.push({
      priority: 0,
      what: String(improve0.what),
      why: String(improve0.why || ""),
      how: String(improve0.how || "通常モードの最新画像から photo_learn（newest）"),
    });
  } else if (weakN > 0 && gapsN0) {
    actions.push({
      priority: 0,
      what: "通常モードの画像を読んで弱い所を強化する",
      why: `通常の読める未学習写真 ${gapsN0.todo}枚（弱い所 ${weakN}件・学べ済み ${gapsN0.learnedOk}枚）`,
      how: "通常モードの録画画像から欄の種類・位置を読む（photo_learn・mode=normal・上限あり）",
    });
  }
  for (const w of weakList) {
    if (!w || !w.name) continue;
    const key = String(w.kind) + "|" + String(w.name);
    if (seen.has(key)) continue;
    /**
     * ★ 2026-11-16: Vision の select/text 誤割れを次手にしない（操作がプルダウンなら位置学習へ）。
     *   統括が「種類割れ」を永久に最上段にすると、完走・手の形・束反映が後回しになる。
     *   → 仕組み①と同じ判定（isFalseKindConflict）で落とす。
     */
    if (isFalseKindConflict(String(w.kind), String(w.name), String(w.why || ""))) {
      continue;
    }
    seen.add(key);
    const f = FIX[String(w.kind)] || {
      what: "学びが弱い",
      how: gapsN0
        ? "通常モードの録画画像から読んで強化する（photo_learn）。録画を増やす前に、すでにある画像を読む"
        : "記録を増やしてもう一度学ぶ",
      priority: 9,
    };
    /**
     * ⚠ **前回も同じ指摘**なら優先度を上げる（1つ上＝数字を1つ下げる）。
     *   同じ事を言い続けている物を後回しにしない（現場が直す順番を誤らない）。
     */
    const isOngoing = ongoingKeys.has(key);
    actions.push({
      priority: Math.max(1, f.priority - (isOngoing ? 1 : 0)),
      what: f.what,
      why: String(w.why || ""),
      how: f.how,
      name: String(w.name),
    });
  }

  /**
   * 材料が足りない時の「次にやる事」。
   *   ⚠ 「弱い所」だけを見ていると、**そもそも記録が無い**事に気づけない（実測: 自動が0件のまま
   *     「追加で強化する所は無し」と言っていた）。
   */
  if (withOps === 0 && rows > 0) {
    actions.push({
      priority: 0,
      what: "写真に操作が付いていない（材料ゼロ）",
      why: `${rows}件の記録があるのに、操作の並びが付いた記録が0件`,
      how: "録画の時に `shot_ops` が空。`axlx_rec_ops` を見て「届いていない／輪が空」を切り分ける",
    });
  } else if (withOps > 0 && rows > 0 && withOps / rows < 0.1) {    actions.push({
      priority: 1,
      what: "操作が付く記録が少なすぎる",
      why: `${rows}件中 ${withOps}件だけ（1割未満）`,
      /**
       * 2026-11-14: ⚠ 旧は「写真と操作を結ぶ道を点検する」とだけ書いていたので、
       *   `shot_learn` を埋め直す（`/api/learn-fill-shot`）を実行しても**直らなかった**。
       *   `shot_learn` は写真から読んだ種類、`shot_ops` は**録画の時に拡張が送る操作の並び**で**別物**。
       *   → **何が足りないか**を名指しし、**どこを見るか**を具体的に書く。
       */
      how: "`shot_ops`（録画の時の操作の並び）が届いていない。`axlx_rec_ops` の `why`（ring_empty / no_answer）を見て、拡張側の記録の経路を直す。※ `shot_learn` を埋めても増えない（別物）",
    });
  }
  const mc = inp.mode_counts || {};
  const aixRows = num(mc.aix);
  if (aixRows === 0) {
    actions.push({
      priority: 2,
      what: "AIX（自動）の記録が無い",
      why: "自動モードの動きがDBに届いていない",
      how: "自動モードで1回検索して録画し、`mode_counts` に aix が出るか確かめる",
    });
  }
  const scount = inp.site_counts || {};
  const siteKeys = Object.keys(scount);
  if (siteKeys.length === 1 && site === "all") {
    actions.push({
      priority: 3,
      what: `${siteKeys[0]} だけで、もう片方のサイトの記録が無い`,
      why: `記録があるのは ${siteKeys.join("・")} だけ`,
      how: "もう片方のサイトでも1回検索して録画する（サイトごとに性質が違うため）",
    });
  }
  if (sequence === 0 && next > 0) {
    actions.push({
      priority: 4,
      what: "一連の動き（手順の鎖）が作れていない",
      why: `押す順番は ${next}通りあるのに、一連の型が0手`,
      how: "録画を続けて、同じ日の同じ並びを2回以上作る",
    });
  }
  /**
   * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
   *   **同じ画面が続いている**＝撮影の仕組みが壊れている疑い（学びが増えない一番の原因）。
   */
  const sr = inp.same_runs && typeof inp.same_runs === "object" ? inp.same_runs : null;
  if (sr && num(sr.max_same) >= 5) {
    actions.push({
      priority: 0,
      what: "同じ画面の写真が続いている（撮影がおかしい）",
      why: `同じ画像が最大 ${num(sr.max_same)}枚続いた（${num(sr.n)}回）`,
      how: "撮る前にリアプロのタブを前に出しているか確かめる（別のタブを撮っている疑い）／画面が本当に止まっていないか見る",
    });
  }
  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする」:
   *   **1枚が大きすぎる**／**合計が重すぎる**時に、容量を落とすよう言う。
   *   ⚠ 1枚 200KB 超は重い（今は 11KB なので問題ない＝基準を超えた時だけ言う）。
   */
  const sb = inp.shot_bytes && typeof inp.shot_bytes === "object" ? inp.shot_bytes : null;
  if (sb && num(sb.n) > 0) {
    const maxKb = Math.round(num(sb.max_bytes) / 1024);
    const totalMb = Math.round((num(sb.total_bytes) / (1024 * 1024)) * 10) / 10;
    if (maxKb > 200) {
      actions.push({
        priority: 1,
        what: "写真1枚が重い",
        why: `1枚 ${maxKb}KB（目安 200KB 以下）`,
        how: "撮る時の長辺と品質を下げる（`SHOT_SEND_SIDE` / `SHOT_SEND_Q`）",
      });
    } else if (totalMb > 50) {
      actions.push({
        priority: 2,
        what: "写真の合計が重い",
        why: `合計 ${totalMb}MB（${num(sb.n)}枚）`,
        how: "残す枚数を減らす／古い写真を消す",
      });
    }
  }

  actions.sort((a, b) => a.priority - b.priority);

  // ── ④ 危ない（止める）判断 ──
  /**
   * ⚠ **場所（区・駅）が入らないまま検索する**のが一番危ない（お客様に無関係な物件が飛ぶ）。
   *   ただし「止める」は実際の検索の判断（page-script）が持つ。ここでは**警告**として出す。
   *   ⚠ 材料がゼロ（`withOps === 0`）の時は「押す場所0」は**当然**（まだ何も学べていない）なので、
   *     `unsafe` ではなく `not_yet`（これから学ぶ段階）にする。
   */
  const block =
    points === 0 && rows > 0 && withOps > 0
      ? "押す場所が1つも学べていない（区・駅を押せない恐れ）"
      : null;

  // ── ① 結論 ──
  /**
   * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい。統括がちゃんと整理して会話できるようにする」:
   *
   *   ⚠ **統括自身が矛盾していた**（本番の実測）:
   *     結論=「学べています（自動検索に渡してよい）」材料85点
   *     同時に 議題=「写真は撮れているのに、操作が付いていない（7%）」
   *   → 配点は「材料つき記録が50件以上で満点20点」なので **4121件中303件（7%）でも満点**になり、
   *     85点に届いて `ready` を出していた。**中身が薄いのに「渡してよい」と言っていた**。
   *
   *   → 結論を出す前に**材料の割合で上限をかける**（統括が自分で整理する）:
   *     ・材料ゼロ … not_yet（今まで通り）
   *     ・材料つき記録が 30% 未満 … **ready にしない**（最大 almost）
   *   ⚠ `unsafe` は上限で緩めない（危ない物は危ないまま）。
   */
  const opsRatio = rows > 0 ? withOps / rows : 0;
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
   *   **人の手本**がどれだけあるか。
   *   ⚠ 自動検索を良くするには**人が実際にやった動き**が要る。
   *     機械の動き（拡張が押した物）を学ぶと**自分の癖を強める**だけ。
   */
  const humanOps = num((input as unknown as Record<string, unknown>).human_ops);
  const autoOps = num((input as unknown as Record<string, unknown>).auto_ops);
  const byTotal = humanOps + autoOps;
  const humanShare = byTotal > 0 ? humanOps / byTotal : null;
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示が詰まっていないか**も判断材料にする（`automation_commands`）。
   *   ⚠ 検索は動いていても、**指示が拾われないまま／失敗したまま**なら現場は詰まっている。
   */
  const cm = inp.commands && typeof inp.commands === "object" ? inp.commands : null;
  const cmdTotal = num(cm?.total);
  const cmdStale = cm?.top_problem ? String(cm.top_problem) : null;
  const capByRatio: SupervisorVerdict | null =
    rows > 0 && withOps === 0 ? "not_yet"
      : rows > 0 && opsRatio < 0.3 ? "almost"
        : null;

  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の完走率**でも上限をかける（人の動きを学べていても、実際の検索が止まるなら渡せない）。
   *   ⚠ 実測: 60回中56回が途中で止まっていた（完走率 7%）。
   *     これを知らないまま `ready` を出していたのが一番の問題だった。
   */
  const au = inp.audits && typeof inp.audits === "object" ? inp.audits : null;
  const auditRuns = num(au?.runs);
  const auditRate = auditRuns > 0 ? num(au?.finish_rate) : null;
  const capByAudit: SupervisorVerdict | null =
    auditRuns === 0 ? null
      : auditRate == null ? null
        : auditRate < 50 ? "not_yet"     // 半分も完走しない＝自動に渡せない
          : auditRate < 90 ? "almost"     // たまに止まる＝まだ「渡してよい」とは言えない
            : null;
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
   *   **人の手本が少なすぎる**時は「渡してよい」にしない。
   *   ⚠ 実測: `by`（人/機械）を記録していなかったので、機械の動きまで手本にしていた。
   *   → 人の手本が 3割未満なら最大 almost（自動を良くする材料が足りない）。
   */
  const capByHuman: SupervisorVerdict | null =
    byTotal === 0 ? null                    // まだ `by` が無い（旧記録）→ 制限しない
      : humanShare == null ? null
        : humanShare < 0.3 ? "almost"
          : null;

  /**
   * ★ 2026-11-15 竹内さん「統括学習した部分を自動モード強化できないのか」「ちゃんと反映まで」:
   *   画面位置は学んだのに拡張未取得／自動未走行なら **ready にしない**（最大 almost）。
   *   ⚠ 実測: 束に n≥3 が33欄あっても read_count=0 → 「渡してよい」は嘘になる。
   */
  const brIn = inp.bundle_reflect && typeof inp.bundle_reflect === "object" ? inp.bundle_reflect : null;
  /** ★ 2026-11-20: 判定に使うのは「判断する束」の読まれ数（作ったばかりの束は 0 ＝まだ拡張が読んでいない） */
  const judgedRead = brIn ? judgedReadCount(brIn) : 0;
  const capByReflect: SupervisorVerdict | null =
    brIn && num(brIn.screen_solid) >= 3 && ((judgedRead <= 0) || brIn.auto_after !== true)
      ? "almost"
      : null;

  /**
   * ★ 2026-11-16 竹内さん「完全に再現できるようになるまで／足りない部分は統括が土台を作って強化」:
   *   自己点検だけだと `ready` のまま議題に「人間らしくない」が出て**矛盾**する（実測: ready と almost が交互）。
   *   → **人間らしさの再現が未完なら ready にしない**（最大 almost）。
   *   完了線: DETAIL_DEGREE（カーソル≥70・押した位置≥60・直書き0・手の形あり）。
   * ★ 2026-11-16「度だが必要なら補強して細かい部分も強化」: 押した位置 50→60 に補強。
   */
  const hlIn = inp.human_like && typeof inp.human_like === "object" ? inp.human_like : null;
  const hlCursorPct = hlIn && num(hlIn.rows) > 0 ? Math.round((num(hlIn.withCursor) / num(hlIn.rows)) * 100) : null;
  const hlPointPct = hlIn && num(hlIn.rows) > 0 ? Math.round((num(hlIn.withPoint) / num(hlIn.rows)) * 100) : null;
  const hlHand = hlIn ? num(hlIn.handCursorClicks) : 0;
  const hlOps = hlIn ? num(hlIn.ops) : 0;
  const hlDirect = hlIn ? num(hlIn.changedWithoutClick) : 0;
  const hlTyped = hlIn ? num(hlIn.typedOnChoose) : 0;
  const humanLikeIncomplete = !!(hlIn && hlOps > 0 && (
    hlDirect > 0 || hlTyped > 0
    || (hlCursorPct != null && hlCursorPct < DETAIL_DEGREE.CURSOR_OK)
    || (hlPointPct != null && hlPointPct < DETAIL_DEGREE.POINT_OK)
    || (hlOps >= 20 && hlHand === 0)
  ));
  const capByHumanLike: SupervisorVerdict | null = humanLikeIncomplete ? "almost" : null;
  /**
   * ★ 2026-11-17 統括Pro「許可線の数値基準」:
   *   近さ未達なら ready にしない（実測: ready と「引き渡し保留」が矛盾した）。
   */
  const hnIn = inp.human_nearness && typeof inp.human_nearness === "object" ? inp.human_nearness : null;
  const hnScore = hnIn ? num(hnIn.score) : 0;
  const hnAllowed = !!(hnIn && hnIn.allowed === true);
  const hnHasSample = !!(hnIn && num(hnIn.auto_gN) >= 30 && num(hnIn.normal_gN) >= 30);
  const nearnessIncomplete = !!(hnHasSample && !hnAllowed);
  const capByNearness: SupervisorVerdict | null = nearnessIncomplete ? "almost" : null;
  /** 再現の進み（0〜100・人が「あとどれくらい」を見る用） */
  /**
   * ★ 2026-11-16: 残り表示は**未達の理由**を書く（旧は失敗時も「直書き0」と出て誤読された）。
   */
  const reproduceParts: Array<{ ok: boolean; w: number; remain: string }> = [
    {
      ok: hlDirect === 0 && hlTyped === 0,
      w: 35,
      remain: hlDirect > 0 ? `直書き${hlDirect}` : (hlTyped > 0 ? `選ぶ欄打ち込み${hlTyped}` : "直書きあり"),
    },
    {
      ok: hlCursorPct != null && hlCursorPct >= DETAIL_DEGREE.CURSOR_OK,
      w: 25,
      remain: `カーソル${hlCursorPct ?? 0}%（要≥${DETAIL_DEGREE.CURSOR_OK}）`,
    },
    {
      ok: hlPointPct != null && hlPointPct >= DETAIL_DEGREE.POINT_OK,
      w: 20,
      remain: `押した位置${hlPointPct ?? 0}%（要≥${DETAIL_DEGREE.POINT_OK}）`,
    },
    {
      ok: hlOps < 20 || hlHand > 0,
      w: 20,
      remain: "手の形なし（通常でボタン録画→cs）",
    },
  ];
  const reproducePct = hlOps > 0
    ? reproduceParts.reduce((s, p) => s + (p.ok ? p.w : 0), 0)
    : null;
  const reproduceRemain = reproduceParts.filter((p) => !p.ok).map((p) => p.remain);

  /**
   * ★ 2026-11-16 竹内さん「人間として自動モード動くようにできているのか、統括ちゃんと判断」:
   *   材料点は**量**の点。完走が低い／人間らしさ未完なのに 85点のまま出すと「もういける」と誤読される。
   *   → 人間として自動できない時は材料点の上限を 55 にする（ready の閾値65に届かせない＝判断を濁さない）。
   */
  const coverageRaw = coverage;
  if (humanLikeIncomplete || nearnessIncomplete || (auditRate != null && auditRate < 50)) {
    coverage = Math.min(coverage, 55);
  }

  let verdict: SupervisorVerdict;
  if (withOps === 0 && rows > 0) verdict = "not_yet";   // 材料ゼロは「これから」段階（危ないの一歩手前）
  else if (block) verdict = "unsafe";
  else if (coverage >= 65 && weakN <= 5) verdict = "ready";
  else if (coverage >= 40) verdict = "almost";
  else verdict = "not_yet";

  if (capByRatio && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByRatio]) verdict = capByRatio;
  }
  if (capByAudit && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByAudit]) verdict = capByAudit;
  }
  if (capByHuman && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByHuman]) verdict = capByHuman;
  }
  if (capByReflect && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByReflect]) verdict = capByReflect;
  }
  if (capByHumanLike && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByHumanLike]) verdict = capByHumanLike;
  }
  if (capByNearness && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByNearness]) verdict = capByNearness;
  }
  /** 上限が効いたか（点検・会話で「なぜ ready でないか」を言えるように） */
  const cappedParts: string[] = [];
  if (capByRatio && rank2(verdict) <= rank2(capByRatio)) {
    cappedParts.push(`材料つき記録が ${Math.round(opsRatio * 100)}%（${withOps}/${rows}）なので「渡してよい」にはしない`);
  }
  if (capByAudit && rank2(verdict) <= rank2(capByAudit)) {
    cappedParts.push(`実際の検索の完走率が ${auditRate}%（${num(au?.finished)}/${auditRuns}回）なので「渡してよい」にはしない`);
  }
  if (capByHuman && rank2(verdict) <= rank2(capByHuman)) {
    cappedParts.push(`人の手本が ${Math.round((humanShare ?? 0) * 100)}%（人${humanOps}/機械${autoOps}回）なので「渡してよい」にはしない`);
  }
  if (capByReflect && rank2(verdict) <= rank2(capByReflect)) {
    const why = judgedRead <= 0
      ? `学んだ画面位置（n≥3 ${num(brIn!.screen_solid)}欄）の束は作ったばかりで、拡張がまだ読んでいない（判断する束の読まれ数 0）`
      : "新束のあとの自動走行がまだ無い（反映の効果を確かめていない）";
    cappedParts.push(`${why}ので「渡してよい」にはしない`);
  }
  if (capByHumanLike && rank2(verdict) <= rank2(capByHumanLike)) {
    const bits = [
      hlDirect > 0 ? `直書き${hlDirect}` : null,
      hlTyped > 0 ? `選ぶ欄打ち込み${hlTyped}` : null,
      hlCursorPct != null && hlCursorPct < 70 ? `カーソル${hlCursorPct}%` : null,
      hlPointPct != null && hlPointPct < 50 ? `押した位置${hlPointPct}%` : null,
      hlOps >= 20 && hlHand === 0 ? "手の形0" : null,
    ].filter(Boolean);
    cappedParts.push(`人間らしさの再現が未完（${bits.join("・")}／再現 ${reproducePct ?? 0}%）なので「渡してよい」にはしない`);
  }
  if (capByNearness && rank2(verdict) <= rank2(capByNearness)) {
    const g = Array.isArray(hnIn!.gaps) && hnIn!.gaps!.length ? hnIn!.gaps!.join("・") : `近さ${hnScore}`;
    cappedParts.push(`人間との近さ差分が許可線未達（${g}）なので「渡してよい」にはしない`);
  }
  if (coverageRaw > coverage) {
    cappedParts.push(`材料の量の点 ${coverageRaw}→${coverage}（人間として自動できる状態ではないので点数を抑えた）`);
  }
  const cappedBy: string | null = cappedParts.length ? cappedParts.join(" ／ ") : null;

  // ── ③ 前回との比較 ──
  const prev = inp.prev && typeof inp.prev === "object" ? inp.prev : null;
  const delta = prev
    ? {
      rows: rows - num(prev.rows),
      next: next - num(prev.next),
      points: points - num(prev.points),
      opens: opens - num(prev.opens),
      weak: weakN - num(prev.weak),
    }
    : null;

  // ── ⑤ 人が読む行 ──
  const lines: string[] = [];
  lines.push(`【統括】${site === "all" ? "全体" : site}: ${HEAD[verdict]}`);
  lines.push(`  材料の揃い: ${coverage}/100（順番${next}通り・場所${points}個・開き方${opens}個・画面${screens}種類・一連${sequence}手）`);
  lines.push(`  弱い所: ${weakN}件`);
  if (block) lines.push(`  ⚠ ${block}`);
  /**
   * ★ 2026-11-15 竹内さん「このように進化した部分ちゃんと統括にはいるようにする」（main 側の決定を取り込み・2026-11-19 統合）:
   *   旧は**件数だけ**渡していたので、統括は「5件強化した」とは言えても**何を直したか**を言葉にしていなかった。
   *   → **直した中身を統括の言葉に出す**（題だけ・最大5件）。⚠ 点は上げない（強化した事で点数を甘くしない）。
   *   ⚠ 「次にやる事」の**前**に出す（何を直したかを先に言い、その上で次を決める）。
   */
  const impRows = inp.improvements && Array.isArray(inp.improvements.recent) ? inp.improvements.recent : [];
  /**
   * ★ 2026-11-15 竹内さん「学習も弱い部分を見つけて強化できるようにするために」:
   *   **直った物を言葉にする**。⚠ 点は上げない（直った事で甘くしない）。「直りました」と言うだけ。
   *   ⚠ 前回の記録が無い時は何も言わない（比べる相手が無い）。
   */
  if (fixedWeak.length) {
    lines.push(`  前回から直った事（${fixedWeak.length}件）:`);
    for (const f of fixedWeak) {
      lines.push(`    ・[${f.kind}] ${f.name}`);
    }
  }
  if (ongoingKeys.size) {
    lines.push(`  ⚠ 前回も同じ指摘（${ongoingKeys.size}件・優先度を上げています）`);
  }
  if (impRows.length) {
    lines.push(`  今日 強化した事（${num(inp.improvements?.total)}件のうち ${Math.min(5, impRows.length)}件）:`);
    for (const r of impRows.slice(0, 5)) {
      const area = String((r as { area?: unknown }).area ?? "");
      const title = String((r as { title?: unknown }).title ?? "").slice(0, 70);
      const effect = String((r as { effect?: unknown }).effect ?? "").slice(0, 60);
      lines.push(`    ・[${area}] ${title}${effect ? ` … ${effect}` : ""}`);
    }
  } else if (inp.improvements && num(inp.improvements.total) > 0) {
    lines.push(`  今日 強化した事: ${num(inp.improvements.total)}件（中身はまだ記録されていません）`);
  }
  if (delta) {
    const up = (v: number, label: string) => {
      if (v > 0) return `${label}+${v}`;
      if (v < 0) return `${label}${v}`;
      return `${label}±0`;
    };
    lines.push(`  前回から: ${up(delta.rows, "記録")}・${up(delta.next, "順番")}・${up(delta.points, "場所")}・${up(delta.opens, "開き方")}・${up(delta.weak, "弱い所")}`);
  }
  if (actions.length) {
    lines.push("  次にやる事:");
    for (const a of actions.slice(0, 5)) {
      lines.push(`    ・${a.what}${a.name ? `（${a.name}）` : ""} … ${a.how}`);
    }
  } else {
    lines.push("  次にやる事: 追加で強化する所は無し（このまま録画を続ける）");
  }

  /**
   * ★ 2026-11-15: 会議を先に作り、自己点検に learning_tasks を渡す
   *   （弱い所＋通常未学習なのに photo_learn が無い矛盾を検知するため）。
   */
  const meeting = buildMeeting({
      site, verdict, coverage, rows, next, points, opens, screens, sequence,
      withOps, weakN, weak: weakList, block, actions, delta,
      reproducePct, reproduceRemain,
      /** 推測で埋めた開き方の数（実測ではない物） */
      guessedOpens: num((input as unknown as Record<string, unknown>).guessed_opens),
      siteCounts: inp.site_counts || {},
      modeCounts: inp.mode_counts || {},
      /** ★ 2026-11-15 竹内さん「ほかのPCでやってもちゃんと学習されるようになっているか」（main 側の決定を取り込み） */
      deviceCount: num((inp as { device_count?: unknown }).device_count),
      devices: Array.isArray((inp as { devices?: unknown }).devices)
        ? ((inp as { devices: Array<{ device: string; n: number; with_ops: number }> }).devices) : [],
      singleDevice: (inp as { single_device?: unknown }).single_device === true,
      shotRows: num((input as unknown as Record<string, unknown>).shot_rows),
      /** 2026-11-14: 実際の検索の結果も議題に使う */
      audits: au,
      /** 2026-11-14: 現場への指示の詰まりも議題に使う */
      commands: cm,
      /** 2026-11-14: 人の手本と機械の動き */
      humanOps,
      autoOps,
  /** 2026-11-14: 同じ画面の続き・写真の容量 */
  sameRuns: sr,
  shotBytes: sb,
  /**
   * ★ 2026-11-15 竹内さん「ここの記憶の部分は自動検索でお客さんを連続で検索するにあたってかなり重要になる」
   *   「また理解できていない部分は土台作って細分化する考えを統括は大切にする」
   *
   *   ⚠ 実測で判明: `toggles` を作ったのに**ここで渡していなかった**ので、
   *     統括の根拠にも議題にも**出ていなかった**（＝作った意味が無かった）。
   *   → **必ず渡す**。`off`（前に残っていたのを外した）が多い回は
   *     「前のお客さんの条件が残っている」＝**連続検索で一番危ない状態**。
   */
  toggles: (() => {
    const t = (input as unknown as Record<string, unknown>).toggles as { off?: unknown; on?: unknown; unknown?: unknown } | null | undefined;
    if (!t || typeof t !== "object") return null;
    return { off: num(t.off), on: num(t.on), unknown: num(t.unknown) };
  })(),
  /**
   * ★ 2026-11-15: **写真から読んだ欄の種類**を統括に届ける
   *   （実測: 415件学んでいたのに数しか渡っていなかった）。
   */
  learnPlan: (() => {
    const lp = (input as unknown as Record<string, unknown>).learn_plan as { items?: unknown } | null | undefined;
    if (!lp || !Array.isArray(lp.items)) return null;
    return {
      items: lp.items.slice(0, 40).map((it) => {
        const o = it as { kind?: string; name?: string };
        return { kind: String(o.kind || ""), name: String(o.name || "") };
      }),
    };
  })(),
  photoKinds: (() => {
    const k = (input as unknown as Record<string, unknown>).photo_kinds;
    if (!k || typeof k !== "object") return null;
    const out: Record<string, number> = {};
    for (const [key, v] of Object.entries(k as Record<string, unknown>)) {
      const n = num(v);
      if (n > 0) out[String(key).slice(0, 12)] = n;
    }
    return Object.keys(out).length ? out : null;
  })(),
  /**
   * ★ 2026-11-15 竹内さん「押した位置も通常モードの録画の画像から…統括お願い」:
   *   **画像×押した位置**を統括に届ける（作ったのに渡さない失敗をしない）。
   */
  imageMatch: (() => {
    const im = (input as unknown as Record<string, unknown>).image_match as SupervisorInput["image_match"];
    if (!im || typeof im !== "object") return null;
    return im;
  })(),
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   **反映の到達点**を統括に届ける（作ったのに渡さない失敗をしない）。
   */
  bundleReflect: (() => {
    const br = (input as unknown as Record<string, unknown>).bundle_reflect as SupervisorInput["bundle_reflect"];
    if (!br || typeof br !== "object") return null;
    return br;
  })(),
  /**
   * ★ 2026-11-15: **自動モードが人間のように動けているか**を統括に届ける
   *   （実測: 自動はカーソル35%・押さずに値が変わる4件。通常は96%で問題なし）。
   */
  humanLike: (() => {
    const h = (input as unknown as Record<string, unknown>).human_like;
    if (!h || typeof h !== "object") return null;
    const o = h as Record<string, unknown>;
    const r = {
      ops: num(o.ops), typedOnChoose: num(o.typedOnChoose), clickedThenChanged: num(o.clickedThenChanged),
      clickedThenChangedFields: Array.isArray(o.clickedThenChangedFields) ? o.clickedThenChangedFields.map(String).slice(0, 20) : [],
      changedWithoutClick: num(o.changedWithoutClick),
      changedWithoutClickFields: Array.isArray(o.changedWithoutClickFields) ? o.changedWithoutClickFields.map(String).slice(0, 8) : [],
      withCursor: num(o.withCursor), withPoint: num(o.withPoint), rows: num(o.rows),
      handCursorClicks: num(o.handCursorClicks),
      handCursorFields: Array.isArray(o.handCursorFields) ? o.handCursorFields.map(String).slice(0, 8) : [],
    };
    return r.ops > 0 ? r : null;
  })(),
  imagePositionFields: (() => {
    const a = (input as unknown as Record<string, unknown>).image_position_fields;
    return Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 80) : [];
  })(),
  opsKindFields: (() => {
    const a = (input as unknown as Record<string, unknown>).ops_kind_fields;
    return Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 80) : [];
  })(),
  /**
   * ★ 2026-11-17 統括Pro: 近さ差分＋許可線を議題材料へ
   */
  humanNearness: (() => {
    const n = (input as unknown as Record<string, unknown>).human_nearness;
    if (!n || typeof n !== "object") return null;
    const o = n as Record<string, unknown>;
    const score = num(o.score);
    if (!(score > 0) && num(o.auto_gN) < 1) return null;
    return {
      score,
      allowed: o.allowed === true,
      line: String(o.line || "").slice(0, 400),
      gaps: Array.isArray(o.gaps) ? o.gaps.map(String).slice(0, 6) : [],
      auto_fast400pct: o.auto_fast400pct == null ? null : num(o.auto_fast400pct),
      normal_fast400pct: o.normal_fast400pct == null ? null : num(o.normal_fast400pct),
      auto_humanBandPct: o.auto_humanBandPct == null ? null : num(o.auto_humanBandPct),
      normal_humanBandPct: o.normal_humanBandPct == null ? null : num(o.normal_humanBandPct),
      auto_p50: o.auto_p50 == null ? null : num(o.auto_p50),
      normal_p50: o.normal_p50 == null ? null : num(o.normal_p50),
      auto_gN: num(o.auto_gN),
      normal_gN: num(o.normal_gN),
      allow_scoreMin: num(o.allow_scoreMin) || 70,
      allow_fast400MaxPct: num(o.allow_fast400MaxPct) || 12,
      allow_humanBandMinPct: num(o.allow_humanBandMinPct) || 50,
    };
  })(),
  /**
   * ★ 2026-11-17: 学習土台点検（F29〜F32）を統括材料へ
   */
  foundationAudit: (() => {
    const f = (input as unknown as Record<string, unknown>).foundation_audit;
    if (!f || typeof f !== "object") return null;
    const o = f as Record<string, unknown>;
    const missing = Array.isArray(o.missing) ? o.missing : [];
    const key = o.key && typeof o.key === "object" ? o.key as Record<string, { ok?: boolean; line?: string }> : {};
    return {
      ok_n: num(o.ok_n),
      missing_n: num(o.missing_n),
      total: num(o.total),
      summary: String(o.summary || "").slice(0, 200),
      screen_solid: num(o.screen_solid),
      missing: missing.slice(0, 24).map((x) => {
        const r = x as Record<string, unknown>;
        return {
          id: String(r.id || "").slice(0, 40),
          line: String(r.line || "").slice(0, 180),
          next: String(r.next || "").slice(0, 120),
          layer: String(r.layer || "free").slice(0, 12),
        };
      }),
      key: Object.fromEntries(
        Object.entries(key).slice(0, 48).map(([id, v]) => [
          id,
          { ok: !!(v && v.ok), line: String((v && v.line) || "").slice(0, 220) },
        ]),
      ),
    };
  })(),
  /**
   * ★ 2026-11-15 竹内さん「ここの抜けていた部分もちゃんと統括は把握できるように」:
   *   **学習の抜け**を統括に届ける。
   */
  shotGaps: (() => {
    const g = (input as unknown as Record<string, unknown>).shot_gaps;
    if (!g || typeof g !== "object") return null;
    const o = g as Record<string, unknown>;
    const r = { total: num(o.total), unlearnedBig: num(o.unlearnedBig), unlearnedSmall: num(o.unlearnedSmall), learnedButEmpty: num(o.learnedButEmpty), learnedOk: num(o.learnedOk), todo: num(o.todo) };
    return r.total > 0 ? r : null;
  })(),
  shotGapsNormal: (() => {
    const g = (input as unknown as Record<string, unknown>).shot_gaps_normal;
    if (!g || typeof g !== "object") return null;
    const o = g as Record<string, unknown>;
    const r = { total: num(o.total), unlearnedBig: num(o.unlearnedBig), unlearnedSmall: num(o.unlearnedSmall), learnedButEmpty: num(o.learnedButEmpty), learnedOk: num(o.learnedOk), todo: num(o.todo) };
    return r.total > 0 ? r : null;
  })(),
  recordingFreshness: (() => {
    const f = (input as unknown as Record<string, unknown>).recording_freshness;
    return f && typeof f === "object" ? f as SupervisorInput["recording_freshness"] : null;
  })(),
  latestAutoChallenge: (() => {
    const c = (input as unknown as Record<string, unknown>).latest_auto_challenge;
    return c && typeof c === "object" ? c as SupervisorInput["latest_auto_challenge"] : null;
  })(),
  improveFromNormal: (() => {
    const p = (input as unknown as Record<string, unknown>).improve_from_normal;
    return p && typeof p === "object" ? p as SupervisorInput["improve_from_normal"] : null;
  })(),
  improveLoop: (() => {
    const p = (input as unknown as Record<string, unknown>).improve_loop;
    return p && typeof p === "object" ? p as SupervisorInput["improve_loop"] : null;
  })(),
  challengeMissingInBundle: (() => {
    const a = (input as unknown as Record<string, unknown>).challenge_missing_in_bundle;
    if (!Array.isArray(a) || !a.length) return null;
    return a.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 12);
  })(),
  /**
   * ★ 2026-11-15 竹内さん「自動モードの改善は録画している学習データから統括が改善する」:
   *   **改善候補**を統括に届ける（統括が順番を決める）。
   */
  autoFix: (() => {
    const a = (input as unknown as Record<string, unknown>).auto_fix;
    if (!Array.isArray(a) || !a.length) return null;
    return (a as Array<Record<string, unknown>>).slice(0, 8).map((x) => ({
      key: String(x.key ?? "").slice(0, 20),
      what: String(x.what ?? "").slice(0, 80),
      why: String(x.why ?? "").slice(0, 120),
      how: String(x.how ?? "").slice(0, 120),
      cost: String(x.cost ?? "").slice(0, 40),
      effect: String(x.effect ?? "").slice(0, 80),
    }));
  })(),
      /**
       * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
       *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
       *   **場面ごとの手順**を統括の議題・根拠に使う。
       */
      scene_flows: Array.isArray(inp.scene_flows) ? (inp.scene_flows as SceneFlow[]) : null,
      scene_missing: num(inp.scene_missing),
      scene_missing_names: typeof inp.scene_missing_names === "string" ? inp.scene_missing_names : "",
      stopped_scene: typeof inp.stopped_scene === "string" ? inp.stopped_scene : null,
      /** 2026-11-14 竹内さん「強化したら統括に保存しておく」: 今日の強化の実績（点は上げない） */
      improvements: inp.improvements && typeof inp.improvements === "object"
        ? {
          total: num(inp.improvements.total),
          by_area: Array.isArray(inp.improvements.by_area) ? inp.improvements.by_area : [],
          recent: Array.isArray(inp.improvements.recent) ? inp.improvements.recent : undefined,
        }
        : null,
      imageFlows: (input as unknown as { image_flows?: ImageSequenceFlowSummary | null }).image_flows ?? null,
  });

  const advice: SupervisorAdvice = {
    verdict,
    headline: HEAD[verdict],
    actions: actions.slice(0, 8),
    score: { coverage, weak: weakN, delta },
    block,
    lines,
    /**
     * ★ 2026-11-15: **直った物**（前回あって今回無い）。APIが保存して次回の比較に使う。
     *   ⚠ 次回の `prev.prevWeak` に「今回の弱い所」を入れるのは API の役目。
     */
    fixed: fixedWeak,
    /** 前回も同じ指摘（まだ直っていない）の数 */
    ongoing: ongoingKeys.size,
    self_check: selfCheck({
      verdict, coverage, weakN, rows, withOps, opsRatio, cappedBy, block,
      guessedOpens: num((input as unknown as Record<string, unknown>).guessed_opens), opens,
      audits: au ? {
        runs: num(au.runs), finished: num(au.finished), finish_rate: num(au.finish_rate), stalled_at: au.stalled_at,
      } : null,
      humanLike: (() => {
        const h = (input as unknown as Record<string, unknown>).human_like;
        if (!h || typeof h !== "object") return null;
        const o = h as Record<string, unknown>;
        return {
          ops: num(o.ops), typedOnChoose: num(o.typedOnChoose), clickedThenChanged: num(o.clickedThenChanged),
          clickedThenChangedFields: Array.isArray(o.clickedThenChangedFields) ? o.clickedThenChangedFields.map(String).slice(0, 20) : [],
          changedWithoutClick: num(o.changedWithoutClick),
          changedWithoutClickFields: Array.isArray(o.changedWithoutClickFields) ? o.changedWithoutClickFields.map(String).slice(0, 8) : [],
          withCursor: num(o.withCursor), withPoint: num(o.withPoint), rows: num(o.rows),
          handCursorClicks: num(o.handCursorClicks),
          handCursorFields: Array.isArray(o.handCursorFields) ? o.handCursorFields.map(String).slice(0, 8) : [],
        };
      })(),
      bundleReflect: (() => {
        const br = (input as unknown as Record<string, unknown>).bundle_reflect as SupervisorInput["bundle_reflect"];
        return br && typeof br === "object" ? br : null;
      })(),
      shotGapsNormal: (() => {
        const g = (input as unknown as Record<string, unknown>).shot_gaps_normal;
        if (!g || typeof g !== "object") return null;
        const todo = num((g as Record<string, unknown>).todo);
        return todo > 0 ? { todo } : null;
      })(),
      learningTasks: meeting.learning_tasks || [],
      challengeMissingInBundle: (() => {
        const a = (input as unknown as Record<string, unknown>).challenge_missing_in_bundle;
        if (!Array.isArray(a) || !a.length) return null;
        return a.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 12);
      })(),
      togglesOff: (() => {
        const t = (input as unknown as Record<string, unknown>).toggles as { off?: unknown } | null | undefined;
        return t && typeof t === "object" ? num(t.off) : 0;
      })(),
      photoKinds: (() => {
        const k = (input as unknown as Record<string, unknown>).photo_kinds;
        if (!k || typeof k !== "object") return null;
        const out: Record<string, number> = {};
        for (const [key, v] of Object.entries(k as Record<string, unknown>)) {
          const n0 = num(v);
          if (n0 > 0) out[String(key).slice(0, 12)] = n0;
        }
        return Object.keys(out).length ? out : null;
      })(),
      imageMatch: (() => {
        const im = (input as unknown as Record<string, unknown>).image_match as SupervisorInput["image_match"];
        return im && typeof im === "object" ? im : null;
      })(),
    }),
    meeting,
  };
  /** 薄い site 別 meeting でも土台・完成・録画学習・連携・課題を必ず載せる */
  return ensureMeetingEvidenceGates(
    advice,
    meetingGateContextFromSupervisorInput(inp as unknown as Record<string, unknown>, site),
  );
}

/** 結論の強さの順（上限をかける時に使う） */
function rank2(v: SupervisorVerdict): number {
  return v === "unsafe" ? 3 : v === "ready" ? 2 : v === "almost" ? 1 : 0;
}

/**
 * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい。統括がちゃんと整理して会話できるようにする」:
 *   **統括が自分の判断を点検する**（純関数）。
 *
 *   ⚠ 実際に起きた矛盾:
 *     結論=「学べています（自動検索に渡してよい）」＋材料85点
 *     同時に 議題=「操作が付いているのは303/4121件（7%）」
 *   → 「渡してよい」と言いながら「材料が7%」は**矛盾**。人が読むと信用を失う。
 *
 *   点検する事:
 *     ① `ready` なのに材料の割合が低い（30%未満）
 *     ② `ready` なのに弱い所が5件より多い
 *     ③ 点数が高い（65以上）のに材料の割合が低い（**点数の意味が薄い**）
 *     ④ 開き方が全部推測なのに点数に入っている
 *     ⑤ `unsafe` なのに「次にやる事」が無い（何をすればよいか分からない）
 */
function selfCheck(m: {
  verdict: SupervisorVerdict;
  coverage: number;
  weakN: number;
  rows: number;
  withOps: number;
  opsRatio: number;
  cappedBy: string | null;
  block: string | null;
  guessedOpens: number;
  opens: number;
  /** 2026-11-14: 実際の検索の結果（完走率が低いのに「渡してよい」を防ぐ） */
  audits?: { runs: number; finished: number; finish_rate: number; stalled_at?: Array<{ stage: string; n: number }> } | null;
  /** ★ 2026-11-15: 自動モードが人間のように動けているか（17%・12%で ready になる矛盾を防ぐ） */
  humanLike?: {
    ops: number; typedOnChoose: number; clickedThenChanged: number; clickedThenChangedFields?: string[]; changedWithoutClick: number;
    changedWithoutClickFields?: string[]; withCursor: number; withPoint: number; rows: number;
    handCursorClicks?: number; handCursorFields?: string[];
  } | null;
  /** ★ 2026-11-15「ちゃんと反映までやるようにする統括」: 位置はあるのに未反映で ready を防ぐ */
  bundleReflect?: SupervisorInput["bundle_reflect"];
  /**
   * ★ 2026-11-15 竹内さん「この考え方統括ちゃんと把握なぜできていないのか」:
   *   弱い所＋通常の読める未学習があるのに photo_learn が課題に無い → 矛盾。
   */
  shotGapsNormal?: { todo: number } | null;
  learningTasks?: Array<{ kind: string; why?: string; what?: string; fields?: string[] }> | null;
  /** 課題欄が束に無いもの（段階4と photo_learn の矛盾点検用） */
  challengeMissingInBundle?: string[] | null;
  /** くれあ型の外し件数（仕組み②の点検） */
  togglesOff?: number;
  /** ★ 2026-11-16: 画像材料が統括に届いているか（flash→材料の穴） */
  photoKinds?: Record<string, number> | null;
  imageMatch?: SupervisorInput["image_match"];
}): { ok: boolean; issues: string[]; capped_by: string | null } {
  const issues: string[] = [];
  const pct = Math.round((m.opsRatio || 0) * 100);

  if (m.rows > 0 && m.opsRatio < 0.3) {
    if (m.verdict === "ready") {
      issues.push(`「渡してよい」と言っていますが、材料つき記録は ${m.withOps}/${m.rows}（${pct}%）だけです`);
    }
    if (m.coverage >= 65) {
      issues.push(`材料 ${m.coverage}点は高すぎます（材料つき記録が${pct}%しかないので、点数の意味が薄い）`);
    }
  }
  if (m.verdict === "ready" && m.weakN > 5) {
    issues.push(`「渡してよい」と言っていますが、弱い所が ${m.weakN}件あります`);
  }
  if (m.opens > 0 && m.guessedOpens >= m.opens && m.coverage >= 65) {
    issues.push(`「押したら何が開くか」${m.opens}個が全部推測なのに、材料 ${m.coverage}点に数えています`);
  }
  if (m.verdict === "unsafe" && !m.block) {
    issues.push("「危ない」と言っていますが、理由（block）がありません");
  }
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の完走率**が低いのに「渡してよい」と言っていたら矛盾。
   *   ⚠ これが今まで見えていなかった一番の問題（実測: 完走率7%で `ready` を出していた）。
   */
  const ar = m.audits && num(m.audits.runs) > 0 ? num(m.audits.finish_rate) : null;
  if (ar != null && ar < 90) {
    const top = Array.isArray(m.audits?.stalled_at) && m.audits!.stalled_at!.length ? m.audits!.stalled_at![0] : null;
    if (m.verdict === "ready") {
      issues.push(`「渡してよい」と言っていますが、実際の検索は ${m.audits!.finished}/${m.audits!.runs}回しか完走していません（完走率 ${ar}%）`);
    }
    if (ar < 50) {
      issues.push(`実際の検索が半分も完走していません（${ar}%）${top ? `。一番止まるのは「${top.stage}」（${top.n}回）` : ""}`);
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「反映させる」→ **実測で矛盾を発見**:
   *
   *   ⚠ 自動モードのカーソル記録 17%・押した位置 12% なのに `verdict: ready`（渡してよい）になっていた。
   *     「人間のように動けていない」のに「渡してよい」は**矛盾**。
   *     統括の自己点検がこの組み合わせを見ていなかった。
   *
   *   → **自動モードが人間のように動けていない時は「渡してよい」にしない**。
   *     ⚠ 閾値は 50%（半分未満なら人の真似ができていない・実測: 通常モードは96%）。
   */
  const hl = m.humanLike && m.humanLike.ops > 0 ? m.humanLike : null;
  if (hl) {
    const cursorPct = hl.rows > 0 ? Math.round((hl.withCursor / hl.rows) * 100) : 0;
    const pointPct = hl.rows > 0 ? Math.round((hl.withPoint / hl.rows) * 100) : 0;
    const hand0 = hl.ops >= 20 && (hl.handCursorClicks ?? 0) === 0;
    /** ★ 2026-11-16: 再現完了線（DETAIL_DEGREE）と自己点検を一致 */
    const notHuman = hl.changedWithoutClick > 0 || hl.typedOnChoose > 0
      || cursorPct < DETAIL_DEGREE.CURSOR_OK
      || pointPct < DETAIL_DEGREE.POINT_OK
      || hand0;
    if (notHuman && m.verdict === "ready") {
      const why: string[] = [];
      if (hl.changedWithoutClick > 0) why.push(`押さずに値が変わった ${hl.changedWithoutClick}件`);
      if (hl.typedOnChoose > 0) why.push(`選ぶ欄に打ち込んだ ${hl.typedOnChoose}件`);
      if (cursorPct < DETAIL_DEGREE.CURSOR_OK) why.push(`カーソル ${cursorPct}%`);
      if (pointPct < DETAIL_DEGREE.POINT_OK) why.push(`押した位置 ${pointPct}%`);
      if (hand0) why.push("手の形 0回");
      issues.push(`「渡してよい」と言っていますが、自動モードは人間のように動けていません（${why.join("／")}）`);
    }
    if (notHuman && m.coverage >= 65) {
      issues.push(`材料 ${m.coverage}点は高すぎます（自動モードが人間のように動けていません: カーソル${cursorPct}%・押した位置${pointPct}%・度 ${DETAIL_DEGREE.CURSOR_OK}/${DETAIL_DEGREE.POINT_OK}）`);
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   画面位置は学んだのに拡張未取得／自動未走行なのに「渡してよい」は矛盾。
   */
  const br = m.bundleReflect;
  if (br && br.screen_solid >= 3 && m.verdict === "ready") {
    if (judgedReadCount(br) <= 0) {
      issues.push(`「渡してよい」と言っていますが、学んだ画面の位置の束を拡張がまだ読んでいません（n≥3 ${br.screen_solid}欄・判断する束の読まれ数 0）`);
    } else if (!br.auto_after) {
      issues.push(`「渡してよい」と言っていますが、新束のあとの自動走行がまだありません（反映の効果を確かめていない）`);
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「通常モードの画像があるのだから底から学習」「弱い部分強化するためによみとる」
   *   「この打ち合わせ何度もしているのでちゃんとできるようにする」:
   *   弱い所があり、通常の読める未学習があるのに、次に学ぶ事に photo_learn が無い → **把握できていない**。
   *   ⚠ ただし段階4（拡張未読）で止まっている時は photo_learn より need_ext_reload が正しい。
   */
  const todoN = num(m.shotGapsNormal?.todo);
  const tasks = Array.isArray(m.learningTasks) ? m.learningTasks : [];
  const bn = (() => {
    const br = m.bundleReflect;
    if (br && judgedReadCount(br) <= 0 && (br.screen_solid ?? 0) >= 3) return 4;
    if (br && judgedReadCount(br) > 0 && !br.auto_after) return 5;
    return 0;
  })();
  if (m.weakN > 0 && todoN > 0 && bn < 4) {
    if (!tasks.some((t) => t && t.kind === "photo_learn")) {
      issues.push(`弱い所 ${m.weakN}件なのに、通常モードの読める未学習 ${todoN}枚を読む課題（photo_learn）が無い（画像を読めば学習できるのに把握できていない）`);
    }
  }
  /**
   * ★ 2026-11-15「改善につながるまで一連」:
   *   画面位置はあるのに拡張未読なのに、拡張再読込の課題が無い → 学習しても改善に繋がらない。
   */
  if (bn === 4 && !tasks.some((t) => t && (t.kind === "need_ext_reload" || t.kind === "reflect_auto"))) {
    issues.push("学んだ画面位置の束を拡張がまだ読んでいない（判断する束の読まれ数 0）のに、拡張再読み込み／反映確認の課題が無い（改善につながる一連が切れている）");
  }
  if (bn === 4 && tasks[0]?.kind === "photo_learn") {
    const miss = (m.challengeMissingInBundle || []).length;
    if (miss <= 0) {
      issues.push("段階4（拡張が束を読んでいない）なのに先頭課題が photo_learn（読んでも自動に届かない）");
    }
    // 課題欄が束に無い時の photo_learn 先頭は正しい（更新してから拡張へ）
  }
  /**
   * ★ 2026-11-16 竹内さん「学習方法／考え方もちゃんと強化」:
   *   自動が人間らしくないのに、学習方法の次手が課題に無い → 考え方が抜けている。
   */
  {
    const hl = m.humanLike;
    const autoWeak = !!(hl && hl.ops > 0 && (hl.changedWithoutClick > 0 || (hl.rows > 0 && hl.withCursor / hl.rows < 0.5)));
    const hasLearnPath = tasks.some((t) =>
      t && (t.kind === "photo_learn" || t.kind === "need_ext_reload" || t.kind === "need_auto_run" || t.kind === "verify_improve" || t.kind === "fix_scene" || t.kind === "build_foundation"),
    );
    if (autoWeak && !hasLearnPath && todoN > 0) {
      issues.push("自動が人間らしくないのに、学習方法の次手（通常から読む／一連の段階）が課題に無い");
    }
  }
  /**
   * ★ 2026-11-16 竹内さん「学んだら強化していくように／そういう仕組みをつくっていくように」:
   *   読む課題があるのに、強化（反映〜効果確認）が無い → 仕組みが切れている。
   */
  {
    const hasLearn = tasks.some((t) => t && t.kind === "photo_learn");
    const hasStrengthen = tasks.some((t) =>
      t && (t.kind === "reflect_auto" || t.kind === "need_ext_reload" || t.kind === "need_auto_run" || t.kind === "verify_improve"),
    );
    if (hasLearn && !hasStrengthen) {
      issues.push("学ぶ（photo_learn）課題があるのに、強化（反映〜拡張〜自動〜効果確認）の次手が無い（学んだら強化の仕組みが切れている）");
    }
  }
  /**
   * ★ 2026-11-16: 画像flash→材料→Pro の細かい連携が切れていないか。
   *   写真はあるのに材料が統括に届いていない／未読なのに課題が無い、を矛盾として出す。
   */
  {
    const photo = num(m.bundleReflect?.photo_in_storage);
    const kinds = m.photoKinds ? Object.values(m.photoKinds).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    const img = num(m.imageMatch?.imageFields);
    if (photo > 0 && kinds <= 0 && img <= 0) {
      issues.push(`写真 ${photo}枚あるのに、flashで読んだ材料（種類・画像欄）が統括に届いていない（画像学習→統括の連携が切れている）`);
    }
  }
  /**
   * ★ 2026-11-16「統括じたいの学習能力」: 仕組みを次手に効かせているか自己点検。
   *   既知select欄の photo_learn なのに仕組み①が why に無い → 理解していない。
   *   外しが多いのに区外し土台が無い → 仕組み②が抜けている。
   */
  {
    for (const t of tasks) {
      if (!t || t.kind !== "photo_learn") continue;
      const sels = (t.fields || []).filter(isKnownSelectField);
      if (sels.length && !/selectをVision|操作のselect|位置・押し方/.test(String(t.why || "") + String(t.what || ""))) {
        issues.push(`仕組み①が課題に効いていない（${sels.slice(0, 3).join("・")}の photo_learn に「操作のselectを優先」が無い）`);
      }
    }
    if ((m.togglesOff ?? 0) > 0) {
      const hasWard = tasks.some((t) =>
        t && t.kind === "build_foundation" && /区|外す|くれあ|ward|前客/.test(String(t.what || "") + String(t.why || "")),
      );
      if (!hasWard) {
        issues.push(`仕組み②が課題に効いていない（外し${m.togglesOff}件なのに区の外し土台が無い）`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    capped_by: m.cappedBy,
  };
}

/**
 * 2026-11-14 竹内さん「打ち合わせは絶対にここの統括が話をしてくるようにする」:
 *   **統括が打ち合わせで話す内容**を作る（純関数）。
 *   ⚠ 「数字を並べる」のではなく、**決めたい事・聞きたい事**を出す。
 */
function buildMeeting(m: {
  site: string; verdict: SupervisorVerdict; coverage: number;
  rows: number; next: number; points: number; opens: number; screens: number; sequence: number;
  withOps: number; weakN: number;
  /** 弱い所の中身（画像衝突・細部強化の原子用） */
  weak?: ReadonlyArray<{ kind: string; name: string; why?: string }>;
  block: string | null;
  actions: SupervisorAdvice["actions"];
  delta: SupervisorAdvice["score"]["delta"];
  guessedOpens: number;
  siteCounts: Record<string, number>;
  modeCounts: Record<string, number>;
  /** ★ 2026-11-15: 端末ごとの記録数（他のPCが学習に参加しているか・main 側の決定を取り込み） */
  deviceCount?: number;
  devices?: Array<{ device: string; n: number; with_ops: number }>;
  singleDevice?: boolean;
  /** learn_plan の items（photo_vs_record 等） */
  learnPlan?: { items?: Array<{ kind?: string; name?: string }> } | null;
  /** 2026-11-14: 実際の検索の結果も議題に使う */
  audits?: SupervisorInput["audits"];
  /** 2026-11-14: 現場への指示の詰まりも議題に使う */
  commands?: SupervisorInput["commands"];
  /** 2026-11-14: 人の手本と機械の動きの数（人の割合で判断を制限する） */
  humanOps?: number;
  autoOps?: number;
  /** 2026-11-15: 外した数・選んだ数（押す前と後の checked から・`toggle-meaning.ts`） */
  toggles?: { off: number; on: number; unknown: number } | null;
  /**
   * ★ 2026-11-15 竹内さん「この自動モードの改善は録画している学習データから統括が改善する」:
   *   **自動モードの改善候補**を統括の材料に入れる（統括が順番を決める）。
   *   ⚠ 私は何度も「コードを読んで推測で直す」をやって失敗した（2回誤読・2回渡し忘れ）。
   *     → 統括に決めさせる。私は材料を揃える係に徹する。
   */
  auto_fix?: Array<{ key: string; what: string; why: string; how: string; cost: string; effect: string }> | null;
  /** 2026-11-15: 写真から読んだ欄の種類の内訳（統括が「プルダウンが何個」と言える） */
  photoKinds?: Record<string, number> | null;
  /**
   * ★ 2026-11-15 竹内さん「押した位置も通常モードの録画の画像から連続で読み取れば理解できる」:
   *   通常モードの画像×押した位置の突き合わせ。
   */
  imageMatch?: SupervisorInput["image_match"];
  /** 2026-11-15: 学んだ位置が自動まで届いているか */
  bundleReflect?: SupervisorInput["bundle_reflect"];
  /** 2026-11-15: 自動モードが人間のように動けているかの点検結果 */
  humanLike?: {
    ops: number; typedOnChoose: number; clickedThenChanged: number; clickedThenChangedFields?: string[]; changedWithoutClick: number;
    changedWithoutClickFields?: string[]; withCursor: number; withPoint: number; rows: number;
    handCursorClicks?: number; handCursorFields?: string[];
  } | null;
  imagePositionFields?: string[];
  opsKindFields?: string[];
  /** ★ 2026-11-17 統括Pro: 人間との近さ差分＋許可線 */
  humanNearness?: {
    score: number; allowed: boolean; line: string; gaps?: string[];
    auto_fast400pct?: number | null; normal_fast400pct?: number | null;
    auto_humanBandPct?: number | null; normal_humanBandPct?: number | null;
    auto_p50?: number | null; normal_p50?: number | null;
    auto_gN?: number; normal_gN?: number;
    allow_scoreMin?: number; allow_fast400MaxPct?: number; allow_humanBandMinPct?: number;
  } | null;
  /** ★ 2026-11-17: 学習土台点検（統括が把握・統括する材料） */
  foundationAudit?: {
    ok_n: number;
    missing_n: number;
    total: number;
    summary: string;
    screen_solid: number;
    missing: Array<{ id: string; line: string; next: string; layer: string }>;
    key: Record<string, { ok: boolean; line: string }>;
  } | null;
  /** 2026-11-15: 学習の抜け（未学習・欄0・小さすぎる） */
  shotGaps?: { total: number; unlearnedBig: number; unlearnedSmall: number; learnedButEmpty: number; learnedOk: number; todo: number } | null;
  /**
   * ★ 2026-11-15 竹内さん「通常モードの録画で画像のデータあるのだから底から学習」:
   *   **通常モードだけ**の写真抜け（手本画像。自動は混ぜない）。
   */
  shotGapsNormal?: { total: number; unlearnedBig: number; unlearnedSmall: number; learnedButEmpty: number; learnedOk: number; todo: number } | null;
  recordingFreshness?: SupervisorInput["recording_freshness"];
  latestAutoChallenge?: SupervisorInput["latest_auto_challenge"];
  improveFromNormal?: SupervisorInput["improve_from_normal"];
  improveLoop?: SupervisorInput["improve_loop"];
  challengeMissingInBundle?: string[] | null;
  /** 2026-11-15: 自動モードの改善候補（統括が順番を決める） */
  autoFix?: Array<{ key: string; what: string; why: string; how: string; cost: string; effect: string }> | null;
  /** 2026-11-14: 同じ画面が続いた記録 / 写真の容量 */
  sameRuns?: { n: number; max_same: number } | null;
  shotBytes?: {
    n: number;
    total_bytes: number;
    max_bytes: number;
    in_storage?: number;
    in_row_b64?: number;
    large?: number;
  } | null;
  /** 写真がある記録の数（写真の割合を実データから出すため） */
  shotRows?: number;
  /**
   * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
   *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
   *   **場面ごとの手順**（人が実際に押した順）と、手本が無い場面・止まった場面。
   */
  scene_flows?: SceneFlow[] | null;
  scene_missing?: number;
  scene_missing_names?: string;
  stopped_scene?: string | null;
  /** 2026-11-14: 今日の強化の実績（点は上げない・根拠に出すだけ） */
  improvements?: {
    total: number;
    by_area: Array<{ area: string; n: number }>;
    recent?: Array<{ at: string; area: string; title: string; why: string; how: string; effect: string }>;
  } | null;
  /** ★ 2026-11-16: 人間らしさの再現進度（0〜100・残りラベル） */
  reproducePct?: number | null;
  reproduceRemain?: string[];
  imageFlows?: ImageSequenceFlowSummary | null;
}): SupervisorAdvice["meeting"] {
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const who = m.site === "all" ? "全体" : m.site;
  const today: string[] = [];
  const agenda: SupervisorAdvice["meeting"]["agenda"] = [];
  /** 2026-11-14: 統括が決めた「次に学ぶ事」（`supervisor-do` が上から実行する） */
  let learning_tasks: Array<{ kind: string; what: string; why: string; cost: string; limit?: number; order?: "newest" | "time" | "size" | "sequence"; runId?: string; fields?: string[] }> = [];
  /** ★ 2026-11-16: 土台細分化の結果（根拠と課題で共有） */
  let subdividedAtoms: ReturnType<typeof subdivideReproduceGaps> = [];
  /** ★ 2026-11-16: 欄×観点の細かい学習（仕組み⑥） */
  let fineStatuses: FieldLearnStatus[] = [];
  /** ★ 2026-11-16: 精度レバー（仕組み⑧・一連と連携） */
  let precisionLevers: PrecisionLever[] = [];
  let precisionLinkedOk = true;
  /** ★ 2026-11-16: 自動モード完成度（仕組み⑨） */
  let autoCompletion: AutoCompletion | null = null;
  const questions: SupervisorAdvice["meeting"]["questions"] = [];
  const evidence: SupervisorAdvice["meeting"]["evidence"] = [];

  // ── 根拠（数字）──
  evidence.push({ label: "結論", value: `${HEAD[m.verdict]}（材料 ${m.coverage}/100・弱い所 ${m.weakN}件）` });
  /**
   * 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」:
   *   **今日なにを強化したか**を統括が言えるようにする（根拠に出す）。
   *   ⚠ これは判断の材料ではなく**実績の記録**。数が増えても材料の点は上げない
   *     （「直したから賢くなった」と自動で決めない・効いたかは数字で確かめる）。
   */
  if (m.improvements && m.improvements.total > 0) {
    const by = m.improvements.by_area.map((x) => `${x.area} ${x.n}`).join("・");
    evidence.push({ label: "今日の強化", value: `${m.improvements.total}件（${by}）` });
  }
  evidence.push({ label: "記録", value: `${m.rows}件（うち操作が付いている ${m.withOps}件）` });
  evidence.push({ label: "押す順番", value: `${m.next}通り` });
  evidence.push({ label: "押す場所", value: `${m.points}個` });
  if (m.opens > 0) {
    evidence.push({
      label: "押したら何が開くか",
      value: `${m.opens}個（うち推測 ${m.guessedOpens}個・実測 ${Math.max(0, m.opens - m.guessedOpens)}個）`,
      guessed: m.guessedOpens >= m.opens,
    });
  }
  evidence.push({ label: "画面ごとの手順", value: `${m.screens}種類` });
  evidence.push({ label: "一連の動き", value: `${m.sequence}手` });
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の結果**を根拠に出す（これが無いと現場の現実を無視した判断になる）。
   */
  // ★ 学習期間の正本を根拠に出す（Proが別窓の数字を混ぜない）
  evidence.push({
    label: "学習期間（揃え）",
    value: `材料=${periodLabelJa(LEARN_PERIODS.materialsMs)}（動き・監査・写真）／指示=${periodLabelJa(LEARN_PERIODS.commandsMs)}／履歴=${periodLabelJa(LEARN_PERIODS.historyMs)}`,
    guessed: false,
  });
  if (m.audits && num(m.audits.runs) > 0) {
    /**
     * ⚠ 2026-11-15: `runs` は**全部の回**、`finish_rate` は**判断できる回だけ**で数える。
     *   そのまま並べると「12回中 完走7回（完走率100%）」と**数字が食い違って見える**。
     *   → 判断できない回（古い版で操作の記録が無い等）があれば**その数を添える**。
     */
    const unk = num(m.audits.unknown);
    const judged = Math.max(0, num(m.audits.runs) - unk);
    evidence.push({
      label: "実際の検索",
      value: `${m.audits.runs}回中 完走${m.audits.finished}回（完走率 ${m.audits.finish_rate}%）・途中で止まった ${m.audits.abandoned}回`
        + (unk > 0 ? `・判断できない ${unk}回（操作の記録が無い＝古い版。${judged}回で数えています）` : ""),
    });
    /**
     * ★ 2026-11-15 竹内さん「統括てきにいま弱い部分はあるのか確認する／あれば細かく強化する」（main 側の決定を取り込み）:
     *   ⚠ **実測で判明（統括が古い版に引っぱられていた）**: 全1,197件のうち新しい版は8件だけで、大半が v2.5.91 などの古い記録。
     *   → **一番新しい版の完走率**を根拠に出す（「いまの版でどうか」が分かる）。
     *     ⚠ 新しい版の件数が少ない時は「まだ少ない」と正直に言う（推測で良しとしない）。
     */
    {
      const au = m.audits as unknown as { latest?: { version?: string; n?: number; finish_rate?: number } | null };
      if (au && au.latest && num(au.latest.n) > 0) {
        const ln = num(au.latest.n);
        const lr = num(au.latest.finish_rate);
        evidence.push({
          label: "いまの版の実際の検索",
          value: `v${String(au.latest.version)} で ${ln}回・完走率 ${lr}%`
            + (ln < 5 ? "（⚠ 件数がまだ少ない＝判断は保留）" : ""),
        });
      }
    }
    if (Array.isArray(m.audits.stalled_at) && m.audits.stalled_at.length) {
      evidence.push({ label: "止まりやすい場所", value: m.audits.stalled_at.slice(0, 3).map((x) => `${x.stage}（${x.n}回）`).join("・") });
    }
    // ★ 完了→次客（統括Proが把握する細分化）
    // ★ 2026-11-17: handoffが無いと axes.handoff=null → 把握の穴。無い時も必ず根拠を残す。
    if (m.audits.handoff && m.audits.handoff.line) {
      const h = m.audits.handoff;
      const any =
        (h.switch_fail || 0) + (h.owner_mismatch || 0) + (h.no_fill_start || 0)
        + (h.batch_timeout || 0) + (h.pipeline_busy || 0)
        + (h.tab_reload || 0) + (h.flow_handoff_gap || 0);
      evidence.push({
        label: "完了→次客（細分化）",
        value: h.line + ((h.series_done || 0) > 0 ? `／一連完了${h.series_done}回` : ""),
        guessed: any > 0,
      });
      if (any > 0) {
        agenda.push({
          priority: 0,
          topic: "完了してから次のお客さんに移れない穴がある",
          why: h.line,
          decide: "一連ロック解除の競合・切替失敗・送る相手不一致・完了理解不足を原子ごとに直す（拡張→自動1回で確認）",
        });
      }
    } else {
      evidence.push({
        label: "完了→次客（細分化）",
        value: "handoff材料なし（audits未集計＝把握の穴・F44）",
        guessed: true,
      });
    }
    // ★ F45 完了理解台帳（何が完了しているか）
    if (m.audits.flow && m.audits.flow.line) {
      const f = m.audits.flow;
      evidence.push({
        label: "完了理解（流れ台帳）",
        value: f.line,
        guessed: (f.gaps || 0) > 0 || (f.ready_next || 0) === 0,
      });
      if ((f.gaps || 0) > 0 || ((f.place_ok || 0) + (f.search_ok || 0) + (f.fill_done_ok || 0) === 0)) {
        agenda.push({
          priority: 0,
          topic: "何が完了しているかを理解していない（流れの抜け）",
          why: f.line,
          decide: "place→conditions→search→fill_done→ready_next の印を1つずつ揃えてから次客へ（F45・2.8.80）",
        });
      }
    } else {
      evidence.push({
        label: "完了理解（流れ台帳）",
        value: "flow材料なし（完了印が監査に届いていない＝つなぎの穴・F45/F46）",
        guessed: true,
      });
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「この拡張ツール使ってほかのPCでやってもちゃんと学習されるようになっているか」（main 側の決定を取り込み・2026-11-19 統合）:
   *   ⚠ **実測**: 全6,027件の記録のうち、**端末は1台だけ**。統括は `install_id` を一度も読んでいなかったので「1台しか無い」と言えなかった。
   *   → **端末の数を根拠に出す**。1台だけなら「他のPCが参加していない」と**名指しで言う**。
   *     ⚠ 端末のIDは先頭8文字だけ出す（長いIDを並べても読めない）。
   */
  {
    const devN = num(m.deviceCount);
    const devList = Array.isArray(m.devices) ? m.devices : [];
    if (devN > 0) {
      if (devN === 1 || m.singleDevice === true) {
        evidence.push({
          label: "⚠ 記録している端末",
          value: `1台だけ（${devList[0] ? String(devList[0].device) : "?"}・${num(devList[0]?.n)}件）。`
            + "他のPCは学習に参加していない（そのPCで検索していない／記録が届いていない）",
        });
      } else {
        evidence.push({
          label: "記録している端末",
          value: `${devN}台（` + devList.slice(0, 4).map((d) => `${String(d.device)}:${num(d.n)}件/操作${num(d.with_ops)}`).join("・") + "）",
        });
      }
    }
  }
  /**
   * 2026-11-14 竹内さん
   *   「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごとの手順**（`search_audits.filled.ops` の人の実測）を根拠に出す。
   *     ⚠ これは統括の**中心の考え方**にする:
   *       ① 手順は「場面」に分けて持つ（所在地・条件・検索・物件の取得・次のページ）
   *       ② 人の実測を手本にする（機械の動きは混ぜない）
   *       ③ **手本が無い場面**は「学べていない」と言う（できない事をできると言わない）
   *       ④ 順番が毎回違う場面は「迷い」と見て、決まりにする提案をする
   */
  const flows = Array.isArray(m.scene_flows) ? m.scene_flows : null;
  if (flows && flows.length) {
    for (const f of flows.slice(0, 6)) {
      evidence.push({ label: `場面: ${SCENE_JA[f.scene]}`, value: describeSceneFlow(f).replace(`${SCENE_JA[f.scene]}: `, "") });
    }
  }
  if (typeof m.scene_missing === "number" && m.scene_missing > 0) {
    evidence.push({ label: "手本が無い場面", value: `${m.scene_missing}場面（${String(m.scene_missing_names ?? "").trim() || "－"}）` });
  }
  if (typeof m.stopped_scene === "string" && m.stopped_scene) {
    evidence.push({ label: "止まった回が多い場面", value: m.stopped_scene });
  }
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示（自動便・一括検索）の詰まり**も根拠に出す。
   */
  if (m.commands && num(m.commands.total) > 0) {
    evidence.push({
      label: "現場への指示",
      value: `${m.commands.total}件（完了${m.commands.done}・失敗${m.commands.failed}・待ち${m.commands.pending}・実行中${m.commands.running}）`,
    });
  }
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
   *   **人の手本と機械の動き**を分けて根拠に出す（自動を良くする材料は人の動き）。
   */
  if (typeof m.humanOps === "number" || typeof m.autoOps === "number") {
    const h = num(m.humanOps), a = num(m.autoOps), t = h + a;
    if (t > 0) {
      evidence.push({
        label: "手本にできる動き",
        value: `人の操作 ${h}回 / 機械の操作 ${a}回（人の割合 ${Math.round((h / t) * 100)}%）`,
      });
    }
  }
  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする。統括がこのような部分もはんだんできるようにする」:
   *   写真の容量と、同じ画面が続いた回数を根拠に出す。
   *
   * ★ 2026-11-15 竹内さん「画像データベースの保存されている／そのこともちゃんと統括は把握する」:
   *   Storage 保存（shot_key）を正とする。行内 b64 空でも「保存されていない」と言わない。
   */
  if (m.shotBytes && (num(m.shotBytes.n) > 0 || num(m.shotBytes.in_storage) > 0)) {
    const stored = num(m.shotBytes.in_storage) || num(m.shotBytes.n);
    const rowB64 = num(m.shotBytes.in_row_b64);
    const large = num(m.shotBytes.large);
    const maxKb = Math.round(num(m.shotBytes.max_bytes) / 1024);
    const totalMb = Math.round((num(m.shotBytes.total_bytes) / (1024 * 1024)) * 10) / 10;
    const parts = [
      `Storage保存 ${stored}枚（human-motion-shots・shot_keyあり＝保存済み）`,
      `行内b64 ${rowB64}枚（通常0・正本はStorage）`,
    ];
    if (large > 0) parts.push(`大きい写真 ${large}枚`);
    if (maxKb > 0 || totalMb > 0) parts.push(`行内残 最大${maxKb}KB・合計${totalMb}MB`);
    evidence.push({ label: "写真", value: parts.join("／") });
  }
  if (m.sameRuns && num(m.sameRuns.max_same) > 0) {
    evidence.push({ label: "同じ画面の続き", value: `最大 ${num(m.sameRuns.max_same)}枚（${num(m.sameRuns.n)}回）` });
  }
  const sc = Object.entries(m.siteCounts).filter(([k]) => k && k !== "(空)");
  if (sc.length) evidence.push({ label: "サイト別の記録", value: sc.map(([k, v]) => `${k} ${v}件`).join("・") });
  /**
   * ★ 2026-11-15 竹内さん「統括はこのこと理解するために必要な土台作り細部まで理解できるようにする」:
   *   **「外した」と「選んだ」を分けて出す**。
   *   ⚠ これが無いと統括は「泉大津市を選んでいる」と**正反対に読む**（実測で2回誤読）。
   *   `off` が多い＝前のお客さんの条件が残っていた証拠。
   */
  if (m.toggles && (m.toggles.off > 0 || m.toggles.on > 0 || m.toggles.unknown > 0)) {
    const tg = m.toggles;
    const parts: string[] = [];
    if (tg.off > 0) parts.push(`前に残っていたのを外した ${tg.off}件`);
    if (tg.on > 0) parts.push(`選んだ ${tg.on}件`);
    if (tg.unknown > 0 && !tg.off && !tg.on) {
      parts.push(`区別できない ${tg.unknown}件（was/now未到着・仕組み②が学べない）`);
    } else if (tg.unknown > 0) {
      parts.push(`区別できない ${tg.unknown}件`);
    }
    evidence.push({ label: "押した操作の中身", value: parts.join("／") });
  }
  /**
   * ★ 2026-11-15 竹内さん「統括の部分に学習した部分が届いていないのはなぜなのか…必ず届くように」:
   *   **写真から読んだ欄の種類**を根拠に出す。
   *   ⚠ 実測: 写真から415件学んでいたのに、統括には**数（total/with_ops）しか渡っていなかった**。
   *     統括が「プルダウンが何個・チェックが何個」と言えるようにする。
   */
  if (m.photoKinds && Object.keys(m.photoKinds).length) {
    const KJ: Record<string, string> = { select: "プルダウン", text: "入力", checkbox: "チェック", radio: "選択1つ", button: "押す", link: "リンク" };
    const txt = Object.entries(m.photoKinds)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${KJ[k] ?? k} ${n}`)
      .join("・");
    evidence.push({ label: "写真から読んだ欄の種類", value: txt });
  }
  /**
   * ★ 2026-11-15 竹内さん「押した位置も通常モードの録画の画像から連続で読み取れば理解できる
   *   それを自動に学習させる」「統括お願い」:
   *   **通常モードの画像×押した位置**を根拠に出す（統括が「どこを押しているか」を言える）。
   */
  if (m.imageMatch && (m.imageMatch.imageFields > 0 || m.imageMatch.pressedFields > 0)) {
    const im = m.imageMatch;
    evidence.push({
      label: "通常モードの画像×押した位置",
      value: `${im.line}／画面の位置あり ${im.withScreenPos}欄`,
      guessed: im.withScreenPos === 0,
    });
  }
  if (m.imageFlows && m.imageFlows.total_runs > 0) {
    const imf = m.imageFlows;
    const topUn = (imf.unlearned_runs || []).find((u) => u.total >= 5 && u.pct < 50) || imf.unlearned_runs?.[0];
    const stuckTxt = imf.stuck_points?.[0]
      ? `／詰まり ${imf.stuck_points[0].scene}:${imf.stuck_points[0].why}(${imf.stuck_points[0].n})`
      : "";
    const unTxt = topUn
      ? `／未連続 ${topUn.run_id}(${topUn.mode} ${topUn.learned}/${topUn.total}枚=${topUn.pct}%・欠:${topUn.missing_scenes.slice(0, 4).join(",") || "なし"})`
      : "";
    const scrTxt = `／画面 form=${imf.screens.form} modal=${imf.screens.modal} result=${imf.screens.result}`;
    evidence.push({
      label: "画像の一連流れ（連続読み）",
      value: `${imf.line}${scrTxt}${unTxt}${stuckTxt}`,
      guessed: imf.learned_with_scene < 5 || imf.seq_learned_runs === 0 || (imf.screens.result === 0),
    });
    if (imf.stuck_points && imf.stuck_points.length) {
      const topS = imf.stuck_points[0];
      agenda.push({
        priority: 1,
        topic: `画像の一連流れで詰まりを検出（${topS.scene}）`,
        why: `連続画像から「${topS.why}」を${topS.n}回検出（画面構成 form=${imf.screens.form}/modal=${imf.screens.modal}/result=${imf.screens.result}）`,
        decide: "詰まりの原因箇所を土台/拡張で修正→order=sequence で再読→束→自動1回で改善確認",
      });
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   **束→拡張→自動**の到達を根拠に出す（学んだのに現場に無い、を見落さない）。
   *
   * ★ 2026-11-15「ボトルネック改善／会話の時統括把握」:
   *   段階と止まっている所を必ず出す（写真Storage含む）。
   */
  if (m.bundleReflect) {
    evidence.push({
      label: "学習→自動の連携",
      value: m.bundleReflect.line,
      guessed: (m.bundleReflect.read_count ?? 0) <= 0 || !m.bundleReflect.auto_after,
    });
    if (m.bundleReflect.bottleneck) {
      evidence.push({
        label: "連携のボトルネック",
        value: m.bundleReflect.bottleneck,
        guessed: true,
      });
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「この問題なども把握して補強していくようにする」:
   *   **自動モードが人間のように動けているか**を根拠に出す。
   *   ⚠ 実測: 自動はカーソル35%・押した位置35%・押さずに値が変わる4件。通常は96%で問題なし。
   *     この差を統括が言えれば「自動モードのどこを直すか」を自分で決められる。
   */
  if (m.humanLike && m.humanLike.ops > 0) {
    const h = m.humanLike;
    const p = (n: number) => (h.rows > 0 ? Math.round((n / h.rows) * 100) : 0);
    const parts: string[] = [];
    parts.push(`操作 ${h.ops}件`);
    if (h.typedOnChoose > 0) parts.push(`⚠ 選ぶ欄に打ち込み ${h.typedOnChoose}件`);
    if (h.changedWithoutClick > 0) parts.push(`⚠ 押さずに値が変わった ${h.changedWithoutClick}件`);
    else parts.push(`押してから変えた ${h.clickedThenChanged}件`);
    parts.push(`カーソル ${p(h.withCursor)}%・押した位置 ${p(h.withPoint)}%`);
    if ((h.handCursorClicks ?? 0) > 0) parts.push(`手の形 ${h.handCursorClicks}回`);
    else if (h.ops >= 20) parts.push("⚠ 手の形 0回");
    evidence.push({ label: "自動モードの人間らしさ", value: parts.join("／"), guessed: h.typedOnChoose > 0 || h.changedWithoutClick > 0 });
  }
  /**
   * ★ 2026-11-17 統括Pro「近さ加重スコアを統括束に接続／許可線を数値固定」:
   *   F26〜F28＋近さ点を毎回根拠に出す（手元計算だけにしない）。
   */
  /**
   * ★ 2026-11-17 竹内さん「統括は土台を理解して統括できるように」:
   *   F29〜F32 を毎回根拠に出す（Pro が steps だけに偏らない材料）。
   */
  if (m.foundationAudit) {
    const fa = m.foundationAudit;
    evidence.push({
      label: "学習土台点検（F番号）",
      value: fa.summary + (fa.missing.length
        ? `／欠: ${fa.missing.slice(0, 6).map((x) => x.id.replace(/^F\d+_/, "")).join("・")}`
        : "／欠なし"),
      guessed: fa.missing_n > 0,
    });
    const keyOrder = [
      "F29_human_nearness",
      "F31_learn_reflect_station",
      "F32_link_pipeline",
      "F33_learn_db_persist",
      "F34_pro_brain_ready",
      "F35_wipe_write_gate",
      "F36_write_path_gate",
      "F37_pro_rag_brain",
      "F38_improve_reflect_chain",
      "F41_button_done_marks",
      "F42_catalog_targets_gate",
      "F43_improve_to_auto_link",
      "F44_next_customer_handoff",
      "F45_flow_completion_ledger",
      "F46_flow_record_to_auto",
      "F47_flow_map_subdivide",
      "F48_pro_brain_loop",
      "F53_image_seq_flow",
      "F54_challenge_learn_complete",
      "F55_auto_reflect_verified",
      "F56_pro_reflect_responsibility",
      "F6_auto_after_bundle",
      "F4_hand_cs",
      "F14_station_clear_cursor",
      "F28_auto_gap_floor",
      "F18_fill_progress_steps",
      "F27_op_path_kind",
      "F8_commands_flow",
      "F9_stalled_signal",
    ];
    for (const id of keyOrder) {
      const k = fa.key[id];
      if (!k) continue;
      evidence.push({
        label: `土台 ${id}`,
        value: `${k.ok ? "✓" : "✗"} ${k.line}`,
        guessed: !k.ok,
      });
    }
  }
  if (m.humanNearness && (m.humanNearness.auto_gN ?? 0) > 0) {
    const n = m.humanNearness;
    evidence.push({
      label: "人間との差分（近さ・許可線）",
      value: n.line || `近さ${n.score}点`,
      guessed: !n.allowed,
    });
    if (!n.allowed && Array.isArray(n.gaps) && n.gaps.length) {
      evidence.push({
        label: "差分の未達（許可線）",
        value: n.gaps.join("／"),
        guessed: true,
      });
    }
  }
  if (typeof m.reproducePct === "number") {
    const rem = Array.isArray(m.reproduceRemain) && m.reproduceRemain.length
      ? `残り ${m.reproduceRemain.join("・")}`
      : "条件クリア";
    evidence.push({
      label: "人間らしさの再現（あとどれくらい）",
      value: `${m.reproducePct}%（完了線: 直書き0・カーソル≥${DETAIL_DEGREE.CURSOR_OK}%・押した位置≥${DETAIL_DEGREE.POINT_OK}%・手の形あり）／${rem}`,
      guessed: m.reproducePct < 100,
    });
  }
  /**
   * ★ 2026-11-16: 今日明かした学習の仕組みを統括が持つ（次の学習の判断に使う）。
   *   表示と課題適用は LEARN_MECHANISMS を共有（ズレ防止）。
   */
  {
    const marks = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳", "㉑", "㉒", "㉓", "㉔"];
    evidence.push({
      label: "学習の仕組み（統括が使う）",
      value: LEARN_MECHANISMS.map((s, i) => `${marks[i] || `${i + 1}.`}${s}`).join(" "),
      guessed: false,
    });
    evidence.push({
      label: "毎回違う人間の動き（変則）",
      value: "お客・検索ごとにカーソル出発・狙い点・待ち・条件順を散らす。学んだ「Aの次はB」だけ守る。同じ動きのクローンにしない（v2.8.15）",
      guessed: false,
    });
    /**
     * ★ 2026-11-17 竹内さん「この考え方をかなり大切にする」:
     *   脳ループの現状を毎回根拠に出す（弱点がすぐ分かるか／土台／録画学習）。
     */
    {
      const fa = m.foundationAudit;
      const flows = Array.isArray(m.scene_flows) ? m.scene_flows : [];
      const flowRuns = flows.reduce((n, f) => n + (Number(f.runs) || 0), 0);
      const f46 = fa?.key?.["F46_flow_record_to_auto"];
      const f47 = fa?.key?.["F47_flow_map_subdivide"];
      const f34 = fa?.key?.["F34_pro_brain_ready"];
      const miss = (fa?.missing || []).slice(0, 5).map((x) => x.id.replace(/^F\d+_/, "")).join("・");
      const brainOk = !!(f34?.ok) && flowRuns >= 1;
      evidence.push({
        label: "統括Pro脳ループ（弱点→土台→強化→録画学習）",
        value:
          `脳材料=${f34?.ok ? "✓" : "✗"}` +
          `／録画場面手順 runs=${flowRuns}${flows.length ? `（${flows.length}場面）` : "（無し）"}` +
          `／F46録画→自動=${f46 ? (f46.ok ? "✓" : "✗") : "?"}` +
          `／F47流れ地図=${f47 ? (f47.ok ? "✓" : "✗") : "?"}` +
          (miss ? `／欠土台=${miss}` : "／欠土台なし") +
          `（完了線: 脳材料✓・場面手順≥1・F46で録画が自動に届く）`,
        guessed: !brainOk || !(f46?.ok),
      });
    }
  }
  /**
   * ★ 2026-11-16 竹内さん「通常モードの録画があれば完全に再現できるようになっていくために
   *   必要な土台をそろえる／この考え方大切にする／統括お願い」:
   *   通常録画の有無と、再現に足りない土台を**毎回**根拠に出す（録画を増やす前に、ある物から揃える）。
   */
  {
    const normalN = num(m.modeCounts?.normal);
    if (normalN > 0 || (m.shotGapsNormal && m.shotGapsNormal.total > 0)) {
      const h = m.humanLike;
      const foundation: string[] = [];
      foundation.push(`通常録画 ${normalN || m.shotGapsNormal?.total || 0}`);
      if (m.shotGapsNormal) {
        foundation.push(m.shotGapsNormal.todo > 0
          ? `⚠ 通常の読める未学習 ${m.shotGapsNormal.todo}枚`
          : "通常画像の未学習なし");
      }
      if (h && h.ops > 0) {
        const cp = h.rows > 0 ? Math.round((h.withCursor / h.rows) * 100) : 0;
        const pp = h.rows > 0 ? Math.round((h.withPoint / h.rows) * 100) : 0;
        foundation.push(h.changedWithoutClick > 0 ? `⚠ 直書き疑い ${h.changedWithoutClick}` : "直書き0");
        foundation.push(cp >= 70 ? `カーソル${cp}%` : `⚠ カーソル${cp}%`);
        foundation.push(pp >= DETAIL_DEGREE.POINT_OK ? `押した位置${pp}%` : `⚠ 押した位置${pp}%`);
        foundation.push((h.handCursorClicks ?? 0) > 0 ? `手の形${h.handCursorClicks}回` : "⚠ 手の形0（通常でボタン録画→cs）");
      }
      if (m.bundleReflect) {
        foundation.push((m.bundleReflect.read_count ?? 0) > 0
          ? `拡張が束を読んだ（read ${m.bundleReflect.read_count}）`
          : "⚠ 拡張が束未読（read_count=0→2.8.25再読込／ポップアップ開く）");
      }
      if (m.imageMatch && m.imageMatch.imageFields > m.imageMatch.matched) {
        const onlyImg = m.imageMatch.imageFields - m.imageMatch.matched;
        if (onlyImg > 0) foundation.push(`画像にあるが押していない ${onlyImg}欄（通常画像から位置を学べる）`);
      }
      evidence.push({
        label: "原則（通常録画があれば完全再現へ）",
        value: "通常モードの録画があれば完全に再現できるようになっていく。足りない土台は統括がそろえる。録画を増やす前に、すでにある通常録画（画像・操作・手の形）から学ぶ",
        guessed: false,
      });
      evidence.push({
        label: "通常録画→完全再現の土台",
        value: foundation.join("／"),
        guessed: typeof m.reproducePct === "number" ? m.reproducePct < 100 : true,
      });
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「ここの抜けていた部分もちゃんと統括は把握できるように」:
   *   **学習の抜け**（未学習の大きい写真・欄0・小さすぎる）を根拠に出す。
   *   ⚠ 実測: 102枚読んだが**まだ374枚**未学習。統括が「次はこれを読む」と決められる。
   */
  if (m.shotGaps && m.shotGaps.total > 0) {
    const g = m.shotGaps;
    const parts: string[] = [];
    parts.push(`写真 ${g.total}枚（学べた ${g.learnedOk}枚）`);
    if (g.todo > 0) parts.push(`⚠ まだ読める ${g.todo}枚（未学習${g.unlearnedBig}・欄0が${g.learnedButEmpty}）`);
    if (g.unlearnedSmall > 0) parts.push(`小さいので読めない ${g.unlearnedSmall}枚`);
    if (!g.todo && !g.unlearnedSmall) parts.push("抜けなし");
    evidence.push({ label: "学習の抜け", value: parts.join("／"), guessed: g.todo > 0 });
  }
  /**
   * ★ 2026-11-15 竹内さん「通常モードの録画で画像のデータあるのだから底から学習」:
   *   通常モードの画像抜けを根拠に出す（弱い所の強化はここから）。
   */
  if (m.shotGapsNormal && m.shotGapsNormal.total > 0) {
    const g = m.shotGapsNormal;
    const parts: string[] = [];
    parts.push(`通常モード ${g.total}枚（学べた ${g.learnedOk}枚）`);
    if (g.todo > 0) parts.push(`⚠ まだ読める ${g.todo}枚 → 弱い所の強化はここから読む`);
    if (g.unlearnedSmall > 0) parts.push(`小さい ${g.unlearnedSmall}枚`);
    if (!g.todo) parts.push("通常の読める未学習なし");
    evidence.push({ label: "通常モードの画像学習", value: parts.join("／"), guessed: g.todo > 0 });
  }
  /**
   * ★ 2026-11-15 竹内さん「この打ち合わせ何度もしているのでちゃんとできるようにする」:
   *   原則を毎回根拠に出す（会話のたびに思い出す土台。忘れない）。
   */
  if ((m.shotGapsNormal?.todo ?? 0) > 0 || (m.shotGaps?.todo ?? 0) > 0 || m.weakN > 0 || m.latestAutoChallenge?.fields?.length) {
    evidence.push({
      label: "原則（自動最新課題→通常から改善）",
      value: "最新で録画した画像も把握する。自動モードで最新の課題を見つける。課題欄は通常モードの最新〜近い画像から読んで改善する。自動の画像は手本にしない",
      guessed: false,
    });
  }
  /**
   * ★ 2026-11-16 竹内さん「学習方法とかも重要な部分ちゃんと学習して強化／統括ちゃんと把握して強化／考え方もちゃんと強化」:
   *   統括が毎回**学習のやり方（考え方）**を根拠に出す（忘れない・会話の土台）。
   *   ①自動の録画で弱い所を見つける ②通常の録画（画像・操作）から学ぶ ③順番・カーソルなど細部を直す
   *   ④束→拡張が読む→自動で使う→効果確認 ⑤推測で埋めない・自動画像は手本にしない
   */
  if (m.weakN > 0 || m.latestAutoChallenge?.fields?.length || m.improveLoop || (m.humanLike && m.humanLike.ops > 0)) {
    const bn = m.improveLoop?.bottleneck_n;
    const stepHint =
      bn === 4 ? "今は段階4（拡張が束を読む）で止まっている → 再読み込みが先（学習方法の順番を守る）"
      : bn === 5 ? "今は段階5（自動で使う）→ 自動1回が先"
      : bn === 6 ? "今は段階6（効果確認）→ 数字で確かめる"
      : "弱い所があれば通常から学び、足りなければ土台を作り、再現まで回す";
    evidence.push({
      label: "学習方法（考え方）",
      value: `①自動録画で弱い所を見つける → ②通常録画（画像・操作）から学ぶ → ③足りなければ土台を作る → ④細部を直して再現 → ⑤束→拡張→自動→効果確認。${stepHint}`,
      guessed: false,
    });
    /**
     * ★ 2026-11-17 竹内さん「学んだ学習方法をitandiでも完全に活用」:
     *   方法①〜⑤はサイト共通。DOM・台帳・路線駅名だけサイト別。
     */
    evidence.push(siteLearnMethodEvidence(m.site));
    const chFields = [
      ...(m.latestAutoChallenge?.fields || []),
      ...(m.improveFromNormal?.fields || []),
      ...(m.humanLike?.changedWithoutClickFields || []),
    ];
    const foundationGaps = (() => {
      let n = 0;
      const h = m.humanLike;
      if (h && h.ops > 0) {
        if (h.changedWithoutClick > 0) n++;
        if (h.rows > 0 && Math.round((h.withCursor / h.rows) * 100) < 70) n++;
        if (h.rows > 0 && Math.round((h.withPoint / h.rows) * 100) < 50) n++;
        if ((h.handCursorClicks ?? 0) === 0 && h.ops >= 20) n++;
      }
      if (m.bundleReflect && (m.bundleReflect.read_count ?? 0) <= 0 && (m.bundleReflect.screen_solid ?? 0) >= 3) n++;
      return n;
    })();
    evidence.push({
      label: "質を上げる循環（統括が土台構築も含めて回す）",
      value: qualityCycleLine({
        reproducePct: typeof m.reproducePct === "number" ? m.reproducePct : null,
        bottleneckN: bn ?? null,
        challengeFields: [...new Set(chFields.map(String).filter(Boolean))].length,
        foundationGaps,
      }),
      guessed: false,
    });
    /** 課題欄 ↔ 学習場面の連動 */
    const links = linkFieldsToScenes(
      [...new Set(chFields.map(String).filter(Boolean))].slice(0, 10),
      Array.isArray(m.scene_flows) ? m.scene_flows : null,
    );
    if (links.length) {
      const parts = links.map((l) =>
        `${l.field}→${l.sceneJa}` + (l.hasExample ? `（手本${l.runs}回・${l.ops}手）` : "（⚠場面の手本薄い）"),
      );
      evidence.push({
        label: "学習場面の連動（課題欄↔場面）",
        value: parts.join("／"),
        guessed: links.some((l) => !l.hasExample),
      });
    }
    /**
     * ★ 2026-11-16「土台強化細分化して強化」「自動録画で弱い部分を見つける」「細部にこだわる」:
     *   足りない物を「実際に何が必要か」まで分解し、自動→通常→土台→細部→確かめるを連動させる。
     */
    {
      const atoms = subdivideReproduceGaps({
        reproducePct: typeof m.reproducePct === "number" ? m.reproducePct : null,
        reproduceRemain: m.reproduceRemain,
        humanLike: m.humanLike,
        challengeFields: [
          ...(m.latestAutoChallenge?.fields || []),
          ...(m.latestAutoChallenge?.changedNoClick || []),
        ],
        reclickFields: m.latestAutoChallenge?.retries || [],
        autoFixTop: (m.autoFix || []).slice(0, 3).map((x) => ({ what: x.what, why: x.why, how: x.how })),
        bundleReflect: m.bundleReflect,
        sceneFlows: Array.isArray(m.scene_flows) ? m.scene_flows : null,
        stoppedScene: m.stopped_scene ?? null,
      });
      if (atoms.length) {
        subdividedAtoms = atoms;
        const sum = summarizeAtoms(atoms);
        evidence.push({
          label: "土台の細分化（実際に何が必要か）",
          value: sum.line + (sum.topNeeds.length ? `／例: ${sum.topNeeds.slice(0, 3).join("・")}` : ""),
          guessed: sum.byLayer.foundation > 0 || sum.byLayer.find > 0,
        });
        evidence.push({
          label: "弱所発見→学習→土台→細部の連動",
          value: linkageLine(atoms),
          guessed: false,
        });
        evidence.push({
          label: "原則（細部にこだわれば人間の動き）",
          value: "自動録画で弱所を見つけ、通常録画から学び、足りなければ土台を細分化して作る。細部（カーソル・手・順番・間）まで徹底すれば完全に人間の動きで行える",
          guessed: false,
        });
      }
    }
    /**
     * ★ 2026-11-16「学習面の強化を細かく／細かくまなんでいく／仕組みで強化」:
     *   欄ごとに観点（種類・位置・押して変化・カーソル・外し・場面）へ分解し、
     *   足りない観点だけを次手にする（粗い「弱い所を読む」で終わらせない）。
     */
    {
      const h = m.humanLike;
      const cursorPct = h && h.rows > 0 ? Math.round((h.withCursor / h.rows) * 100) : null;
      const pointPct = h && h.rows > 0 ? Math.round((h.withPoint / h.rows) * 100) : null;
      const rawTargets = [...new Set([
        ...(m.latestAutoChallenge?.fields || []),
        ...(m.latestAutoChallenge?.changedNoClick || []),
        ...(m.humanLike?.changedWithoutClickFields || []),
        ...(m.improveFromNormal?.fields || []),
      ].map(String).filter(Boolean))];
      // ★ 2026-11-18: 監査ステップノート等の非欄を台帳正名に正規化（無い環境では元を維持）
      const siteScope = m.site === "itandi" ? "itandi" : "realpro";
      const catTargets = catalogTargetsOnly(rawTargets, siteScope);
      const targetFields = (catTargets.length ? catTargets : rawTargets).slice(0, 12);
      const sceneLinked = linkFieldsToScenes(targetFields, Array.isArray(m.scene_flows) ? m.scene_flows : null)
        .filter((l) => l.hasExample)
        .map((l) => l.field);
      const opsKind = [...new Set([
        ...targetFields.filter(isKnownSelectField),
        ...(m.opsKindFields || []),
      ])];
      fineStatuses = scoreFieldsFine({
        fields: targetFields,
        opsKindFields: opsKind,
        imagePositionFields: m.imagePositionFields || [],
        clickChangeFields: m.humanLike?.clickedThenChangedFields || [],
        directWriteFields: [
          ...(m.latestAutoChallenge?.changedNoClick || []),
          ...(m.humanLike?.changedWithoutClickFields || []),
        ],
        reclickFields: m.latestAutoChallenge?.retries || [],
        toggleOff: m.toggles?.off ?? 0,
        toggleOn: m.toggles?.on ?? 0,
        toggleUnknown: m.toggles?.unknown ?? 0,
        cursorPct,
        pointPct,
        handClicks: h?.handCursorClicks ?? 0,
        sceneLinkedFields: sceneLinked,
      });
      if (fineStatuses.length) {
        const steps = fineLearnNextSteps(fineStatuses, 6);
        const weakFs = weakDetailFields(fineStatuses);
        const fineAvg0 = Math.round(fineStatuses.reduce((s, x) => s + x.score, 0) / fineStatuses.length);
        evidence.push({
          label: "細かく学ぶ（欄×観点）",
          value: fineLearnEvidenceLine(fineStatuses)
            + (steps.length
              ? `／次の観点: ${steps.slice(0, 4).map((g) => `${g.field}:${g.facet}`).join("・")}`
              : ""),
          guessed: fineStatuses.some((s) => s.score < 100),
        });
        evidence.push({
          label: "細部の度（補強）",
          value: detailDegreeLine({
            cursorPct,
            pointPct,
            fineAvg: fineAvg0,
            weakFields: weakFs,
          }) + "／弱い部分を見つけたら必ず改善する",
          guessed: weakFs.length > 0 || fineAvg0 < DETAIL_DEGREE.FINE_AVG_OK,
        });
      }
      /**
       * ★ 2026-11-16「より精度上げれる／精度上げる部分も強化／統括ちゃんと連携」:
       *   精度を測り、一連の段階と食い違わないレバーを出す（仕組み⑧）。
       */
      {
        const auditRate = m.audits && num(m.audits.runs) > 0 ? num(m.audits.finish_rate) : null;
        const chN = [
          ...(m.latestAutoChallenge?.fields || []),
          ...(m.humanLike?.changedWithoutClickFields || []),
        ].filter(Boolean).length;
        const precision = measurePrecision({
          fineStatuses,
          reproducePct: typeof m.reproducePct === "number" ? m.reproducePct : null,
          auditFinishRate: auditRate,
          challengeFieldCount: chN || (m.latestAutoChallenge?.fields?.length ?? 0),
        });
        precisionLevers = precisionLeversLinked({
          precision,
          fineStatuses,
          bottleneckN: m.improveLoop?.bottleneck_n ?? null,
          reproduceRemain: m.reproduceRemain,
          hasToggleUnknown: !!(m.toggles && m.toggles.unknown > 50 && m.toggles.off === 0 && m.toggles.on === 0),
        });
        const bn = m.improveLoop?.bottleneck_n ?? null;
        const top = precisionLevers[0];
        /** 段階4〜5なのに先頭が photo_learn だけなら連携が切れている */
        precisionLinkedOk = !(bn != null && bn >= 4 && bn <= 5 && top && top.kind === "photo_learn" && top.lift >= 80);
        evidence.push({
          label: "精度（測って上げる・一連と連携）",
          value: precisionEvidenceLine(precision, precisionLevers, bn),
          guessed: precision.score < 80,
        });
        /**
         * ★ 2026-11-16「完成度わかればよりよい／完成度も理解して学習する仕組みを統括もつ」:
         *   一連・再現・欄×観点・精度・人間として可 を1本の完成度にし、学習ヒントを付ける。
         */
        {
          const humanAutoOk = (() => {
            const h = m.humanLike;
            if (!h || h.ops <= 0) return false;
            if (h.changedWithoutClick > 0 || (h.typedOnChoose ?? 0) > 0) return false;
            const cp = h.rows > 0 ? Math.round((h.withCursor / h.rows) * 100) : 0;
            const pp = h.rows > 0 ? Math.round((h.withPoint / h.rows) * 100) : 0;
            if (cp < DETAIL_DEGREE.CURSOR_OK || pp < DETAIL_DEGREE.POINT_OK) return false;
            if (h.ops >= 20 && (h.handCursorClicks ?? 0) === 0) return false;
            const br = m.bundleReflect;
            if (br && ((br.read_count ?? 0) <= 0 || !br.auto_after)) return false;
            return true;
          })();
          autoCompletion = measureAutoCompletion({
            improveSteps: m.improveLoop?.steps || null,
            bottleneckN: m.improveLoop?.bottleneck_n ?? null,
            reproducePct: typeof m.reproducePct === "number" ? m.reproducePct : null,
            reproduceRemain: m.reproduceRemain,
            fineAvg: precision.fineAvg,
            precisionScore: precision.score,
            humanAutoOk,
            challengeN: chN || (m.latestAutoChallenge?.fields?.length ?? 0),
          });
          evidence.push({
            label: "自動モード完成度",
            value: `${autoCompletion.line}／内訳: ${autoCompletion.parts.map((p) => `${p.label}${p.score}/${p.max}`).join("・")}／残り: ${autoCompletion.remain.slice(0, 4).join("・") || "なし"}／${autoCompletion.learnHint}`,
            guessed: autoCompletion.score < 85,
          });
        }
      }
    }
  }
  /**
   * ★ 2026-11-16 竹内さん「学んだら強化していくように／そういう仕組みをつくっていくように」:
   *   学習と強化を分けない。読んだら必ず強化まで回す、が統括の土台。
   */
  {
    const bn = m.improveLoop?.bottleneck_n;
    const learnedToday = (m.improvements?.total ?? 0) > 0;
    const pending = bn != null && bn >= 3;
    evidence.push({
      label: "学んだら強化（仕組み）",
      value: learnedToday && pending
        ? `今日の強化 ${m.improvements!.total}件あり／まだ段階${bn}で止まっている → 学んだあと強化（反映〜自動〜効果）を完了させる`
        : "学ぶだけで終わらない。photo_learn のあとに必ず reflect→拡張再読込→自動1回→効果確認を付ける",
      guessed: false,
    });
  }
  /**
   * ★ 2026-11-16 竹内さん「続きのお客さんも地域または駅を選択してから検索／先に検索になってそのあと指定ではなく」:
   *   統括が毎回出す決まり。駅だけ外して大阪全件、を防ぐ。
   * ★ 2026-11-16「続き客で所在地や駅をやりなおす／もともとの条件はずして新しい条件」:
   *   やり直しが薄いのも弱い部分として出す（細部まで強化）。
   */
  {
    const sampleSteps = Array.isArray((m as { lastAuditSteps?: string[] }).lastAuditSteps)
      ? (m as { lastAuditSteps?: string[] }).lastAuditSteps!
      : [];
    const slip = sampleSteps.length ? detectSearchBeforePlace(sampleSteps) : null;
    const basicSlip = sampleSteps.length ? detectSearchBeforeBasic(sampleSteps) : null;
    const redo = sampleSteps.length ? detectPlaceNotRedone(sampleSteps) : null;
    evidence.push({
      label: "検索の順番（場所→条件→検索）",
      value: slip
        ? slip.line
        : "続きの客でも地域または駅を入れてから検索する。場所の前に検索しない（大阪全件防止・v2.8.18）",
      guessed: !!(slip && slip.earlySearch),
    });
    evidence.push({
      label: "基本条件→検索（間取り・敷礼）",
      value: basicSlip
        ? basicSlip.line
        : "間取り・敷礼なしまで入れてから検索。保険は条件完了後の控えのみ・途中切り上げ禁止（v2.8.18）",
      guessed: !!(basicSlip && basicSlip.earlySearch),
    });
    evidence.push({
      label: "検索押し（カーソル）",
      value: "本線も控え保険も直接clickせず、カーソル移動してから検索ボタンを押す（v2.8.18）",
      guessed: false,
    });
    evidence.push({
      label: "直接入力しない（仕組み⑬）",
      value: "プルダウンは開いて選ぶ・文字は欄を押して打つ・value代入だけで条件を入れない。徒歩締めも chooseSelectLikeHuman（v2.8.18）",
      guessed: false,
    });
    evidence.push({
      label: "学習APIの役割分担",
      value: "画像読み=deepseek-flash／統括まとめ=deepseek-v4-pro（learn-supervisor-pro）／関所・verdict=決定論。旧はまとめ層が無く Pro が統括になっていなかった",
      guessed: false,
    });
    evidence.push({
      label: "続き客の所在地/駅やり直し",
      value: redo
        ? redo.line
        : "前客の地域・駅を外してから新しい条件を選ぶ（v2.8.18）",
      guessed: !!(redo && redo.weak),
    });
    if ((slip && slip.earlySearch) || (basicSlip && basicSlip.earlySearch) || (redo && redo.weak)) {
      agenda.push({
        priority: 0,
        topic: "検索の順番が弱い（場所/基本条件の前に検索）",
        why: [
          slip?.earlySearch ? slip.line : null,
          basicSlip?.earlySearch ? basicSlip.line : null,
          redo?.weak ? redo.line : null,
        ].filter(Boolean).join("／"),
        decide: "拡張2.8.18再読込→連続別客で 場所→間取り・敷礼→検索。保険が先に走らない／検索・入力はカーソル経由（直接入力しない）",
      });
    }
  }
  if (m.recordingFreshness && m.recordingFreshness.line) {
    evidence.push({
      label: "最新録画の画像",
      value: String(m.recordingFreshness.line),
      guessed: m.recordingFreshness.normalLatestLearned === false,
    });
  }
  if (m.latestAutoChallenge && m.latestAutoChallenge.line) {
    evidence.push({
      label: "自動モードの最新課題",
      value: String(m.latestAutoChallenge.line),
      guessed: (m.latestAutoChallenge.fields?.length ?? 0) > 0,
    });
  }
  /**
   * ★ 2026-11-15「改善につながるまで一連の流れをちゃんと統括はできるようにする」
   */
  if (m.improveLoop && m.improveLoop.improve_line) {
    evidence.push({
      label: "改善までの一連",
      value: String(m.improveLoop.improve_line),
      guessed: (m.improveLoop.bottleneck_n ?? 0) > 0,
    });
  }
  /**
   * ★ 2026-11-17 統括Pro「人間として自動化／細部改善の仕組みと土台」:
   *   弱所→学ぶ→土台→狙って残す→度、を根拠に出す（F51）。
   */
  {
    try {
      const hl = m.humanLike;
      const pointPct = hl && hl.rows > 0 ? Math.round((hl.withPoint / hl.rows) * 100) : null;
      const cursorPct = hl && hl.rows > 0 ? Math.round((hl.withCursor / hl.rows) * 100) : null;
      const fa = m.foundationAudit as { key?: Record<string, { ok?: boolean; line?: string }> } | null | undefined;
      const key = fa?.key || {};
      const f49 = key.F49_vision_photo_reach;
      const f28 = key.F28_auto_gap_floor;
      const f29 = key.F29_human_nearness;
      const f6 = key.F6_auto_after_bundle;
      const f15 = key.F15_cursor_aim_hit;
      const f16 = key.F16_learn_warm;
      let aimAri = 0, aimNashi = 0, warmN = 0, shortPct: number | null = null, nearScore: number | null = null;
      const aimM = String(f15?.line || "").match(/aim有=(\d+).*aim無=(\d+)/);
      if (aimM) { aimAri = Number(aimM[1]) || 0; aimNashi = Number(aimM[2]) || 0; }
      const warmM = String(f16?.line || "").match(/learn_warm=(\d+)/);
      if (warmM) warmN = Number(warmM[1]) || 0;
      const shortM = String(f28?.line || "").match(/（([\d.]+)%/);
      if (shortM) shortPct = Number(shortM[1]);
      const nearM = String(f29?.line || "").match(/近さ(\d+)点/);
      if (nearM) nearScore = Number(nearM[1]);
      const hdl = buildHumanDetailLoop({
        pointPct,
        cursorPct,
        aimAri,
        aimNashi,
        learnWarmN: warmN,
        shortGapPct: shortPct,
        nearnessAllowed: f29?.ok === true,
        nearnessScore: nearScore,
        visionPhotoOk: f49?.ok === true,
        fireAtPointWired: true,
        changedWithoutClick: hl?.changedWithoutClick ?? null,
        autoAfterBundle: f6?.ok === true,
      });
      evidence.push({
        label: "人間細部ループ",
        value: hdl.line,
        guessed: hdl.bottleneck_n != null,
      });
      evidence.push({
        label: "土台 F51_human_detail_loop",
        value: hdl.degree_line + (hdl.atoms[0] ? `／次原子: ${hdl.atoms[0].what}` : "／原子なし"),
        guessed: hdl.bottleneck_n != null,
      });
      const diag = diagnoseAutoRecording({
        humanLike: hl
          ? {
              withPoint: hl.withPoint,
              withCursor: hl.withCursor,
              rows: hl.rows,
              changedWithoutClick: hl.changedWithoutClick,
            }
          : null,
        aimAri,
        aimNashi,
        learnWarmN: warmN,
        visionPhotoOk: f49?.ok === true,
        gate: {
          area_ok_by: /both/.test(String(f29?.line || "")) ? "both" : null,
        },
      });
      evidence.push({
        label: "自動録画の診断（問題→土台→次手）",
        value: diag.line + (diag.atoms[0]
          ? `／例: ${diag.atoms[0].problem} → 土台 ${diag.atoms[0].missing_foundation} → ${diag.atoms[0].need}`
          : ""),
        guessed: diag.atoms.length > 0,
      });
      if (diag.place.mixed || diag.place.clear_miss) {
        evidence.push({
          label: "土台 F52_place_xor",
          value: diag.place.mixed
            ? "地域と駅が混在（どちらか一方にする）"
            : "外し忘れ疑い（反対側が残る）",
          guessed: true,
        });
      }
      /**
       * ★ 2026-11-18 竹内さん「録画して課題見つけて改善と学習して足りない仕組みは補強」:
       *   診断・細部・弱強化を1本にし、仕組みギャップを次手に載せる。
       */
      try {
        const f32 = key.F32_link_pipeline;
        const f31 = key.F31_learn_reflect_station;
        const f38 = key.F38_improve_reflect_chain;
        const readM = String(f32?.line || f38?.line || "").match(/read[_=]?(\d+)/i)
          || String(f38?.line || "").match(/read=(\d+)/);
        const readCount = readM ? Number(readM[1]) : (/拡張が束を読む✗|read_count=0/.test(String(f32?.line || "")) ? 0 : null);
        const solidM = String(f38?.line || "").match(/solid=(\d+)/);
        const refM = String(f31?.line || "").match(/reflect_ok=(\d+)/);
        const hitM = String(f31?.line || "").match(/flow_hit=(\d+)/);
        const rcr = buildRecChallengeReinforce({
          pointPct,
          cursorPct,
          aimAri,
          aimNashi,
          learnWarmN: warmN,
          shortGapPct: shortPct,
          nearnessAllowed: f29?.ok === true,
          nearnessScore: nearScore,
          visionPhotoOk: f49?.ok === true,
          fireAtPointWired: true,
          extVersion: "2.8.93",
          changedWithoutClick: hl?.changedWithoutClick ?? null,
          autoAfterBundle: f6?.ok === true,
          readCount: readCount,
          screenSolid: solidM ? Number(solidM[1]) : null,
          reflectOk: refM ? Number(refM[1]) : null,
          flowHit: hitM ? Number(hitM[1]) : null,
          humanLike: hl
            ? {
                withPoint: hl.withPoint,
                withCursor: hl.withCursor,
                rows: hl.rows,
                changedWithoutClick: hl.changedWithoutClick,
              }
            : null,
        });
        evidence.push({
          label: "録画→課題→学習→仕組み補強",
          value: rcr.line + (rcr.mech_gaps[0]
            ? `／仕組み: ${rcr.mech_gaps[0].what} → ${rcr.mech_gaps[0].how}`
            : "") + (rcr.tasks[0] ? `／次手: ${rcr.tasks[0].what}` : ""),
          guessed: rcr.bottleneck_n != null,
        });
        evidence.push({
          label: "学習方法の強化（効果で直して周回）",
          value: rcr.method.line + "／" + rcr.method.next_method_line
            + (rcr.continue_loop ? "／完全ループ継続" : "／ループ完了"),
          guessed: rcr.method.upgrades.length > 0,
        });
        /**
         * ★ 2026-11-18 竹内さん「1度の録画で学習と改善と反映」:
         *   直近自動の steps / status / 間取り hit を1本の関所に載せる。
         */
        try {
          const mAny = m as unknown as {
            lastAutoSteps?: Array<{ k?: string; m?: string; d?: string | null } | string>;
            autoSteps?: Array<{ k?: string; m?: string; d?: string | null } | string>;
          };
          const lastSteps = Array.isArray(mAny.lastAutoSteps)
            ? mAny.lastAutoSteps
            : (Array.isArray(mAny.autoSteps) ? mAny.autoSteps : null);
          const one = buildOneRecLearnLoop({
            steps: lastSteps || null,
            gate: null,
            humanLike: hl
              ? {
                  withPoint: hl.withPoint,
                  withCursor: hl.withCursor,
                  rows: hl.rows,
                  changedWithoutClick: hl.changedWithoutClick,
                }
              : null,
            aimAri,
            aimNashi,
            learnWarmN: warmN,
            visionPhotoOk: f49?.ok === true,
            auditStatus: (m as { lastAuditStatus?: string }).lastAuditStatus || null,
            layoutWantN: (m as { lastLayoutWantN?: number }).lastLayoutWantN ?? null,
            layoutHitN: (m as { lastLayoutHitN?: number }).lastLayoutHitN ?? null,
            searchArmed: (m as { lastSearchArmed?: boolean }).lastSearchArmed ?? null,
            fillDoneReached: (m as { lastFillDone?: boolean }).lastFillDone ?? null,
            propertyAcquireStarted: (m as { lastPropertyAcquire?: boolean }).lastPropertyAcquire ?? null,
            extVersion: "2.8.93",
            readCount,
            autoAfterBundle: f6?.ok === true,
            reflectOk: refM ? Number(refM[1]) : null,
            pointPct,
            unreadNormal: null,
            usedKinds: ["one_rec_loop"],
          });
          evidence.push({
            label: "1録画→学習→改善→反映",
            value: one.line
              + (one.bottleneck ? `／止: ${one.bottleneck}` : "")
              + (one.atoms[0] ? `／原子: ${one.atoms[0].problem}` : "")
              + `／検証: ${one.verify_marks.slice(0, 2).join("・")}`,
            guessed: one.bottleneck_n != null,
          });
          evidence.push({
            label: "1録画の学び方強化",
            value: one.method.line + "／" + one.method.next_method_line
              + (one.continue_loop ? "／次の1録画へ継続" : "／この録画周は完了"),
            guessed: one.continue_loop,
          });
          /** ★ 送付済み把握 × 物件取得タイミング */
          const acq = buildAcquireGraspReport({
            auditStatus: (m as { lastAuditStatus?: string }).lastAuditStatus || null,
            searchArmed: (m as { lastSearchArmed?: boolean }).lastSearchArmed ?? null,
            fillDone: (m as { lastFillDone?: boolean }).lastFillDone ?? null,
            acquireStarted: (m as { lastPropertyAcquire?: boolean }).lastPropertyAcquire ?? null,
            sentSkipped: (m as { lastSentSkipped?: number }).lastSentSkipped ?? null,
            sentMarked: (m as { lastSentMarked?: number }).lastSentMarked ?? null,
            pressedSent: (m as { lastPressedSent?: number }).lastPressedSent ?? null,
            allowedN: (m as { lastAllowedN?: number }).lastAllowedN ?? null,
            stepText: (lastSteps || []).map((s) => (typeof s === "string" ? s : [s.k, s.m, s.d].filter(Boolean).join(" "))).join("\n"),
          });
          evidence.push({
            label: "物件取得・送付済みの把握",
            value: acq.line
              + (acq.atoms[0] ? `／原子: ${acq.atoms[0].problem}` : "")
              + `／次: ${acq.next_line}`,
            guessed: acq.stuck_before_acquire || acq.stuck_on_sent || !acq.sent_grasped,
          });
        } catch (_) { /* 1録画ループ未配線でも止めない */ }
        const f33Line = String(m.foundationAudit?.key?.F33_learn_db_persist?.line || "");
        const f34Line = String(m.foundationAudit?.key?.F34_pro_brain_ready?.line || "");
        const f37Line = String(m.foundationAudit?.key?.F37_pro_rag_brain?.line || "");
        const memLogN = Number((f33Line.match(/統括ログ\d*日=(\d+)/) || [])[1]) || 0;
        const memProN = Number((f34Line.match(/ログPro=(\d+)/) || [])[1]) || 0;
        const memRagN = Number((f37Line.match(/ログRAG成功=(\d+)/) || [])[1]) || 0;
        const mem = buildLearnMemoryLoop({
          supervisorLogN: memLogN,
          hasProLog: memProN >= 1,
          logMemoryN: memRagN,
          improvementN: m.improvements?.total ?? 0,
          continueLoop: rcr.continue_loop,
          afterPointPct: pointPct,
          afterReadCount: readCount,
        });
        evidence.push({
          label: "記憶→改善",
          value: mem.line + `／残す: ${mem.remember_line}`,
          guessed: mem.bottleneck_n != null,
        });
      } catch (_) { /* 補強ループ未配線でも止めない */ }
    } catch (_) { /* 土台未配線でも統括は止めない */ }
  }
  /**
   * ★ 2026-11-15 竹内さん「自動モードの改善は録画している学習データから統括が改善する」:
   *   **改善候補**を根拠に出す（統括が順番を決める材料）。
   */
  if (Array.isArray(m.autoFix) && m.autoFix.length) {
    const top = m.autoFix[0];
    evidence.push({
      label: "自動モードの改善候補",
      value: `${m.autoFix.length}件。一番は「${top.what}」（${top.why}・${top.cost}）`,
      guessed: false,
    });
  }
  const mc = Object.entries(m.modeCounts);
  if (mc.length) evidence.push({ label: "モード別の記録", value: mc.map(([k, v]) => `${k} ${v}件`).join("・") });

  // ── 今日の結論（読み上げられる形）──
  today.push(`【${who}】${HEAD[m.verdict]}`);
  if (autoCompletion) {
    today.push(autoCompletion.line);
    if (autoCompletion.remain.length) {
      today.push(`完成度の残り: ${autoCompletion.remain.slice(0, 5).join("・")}`);
    }
    today.push(autoCompletion.learnHint);
  }
  today.push(`材料 ${m.coverage}点／弱い所 ${m.weakN}件／記録 ${m.rows}件（操作が付いているのは ${m.withOps}件）`);
  if (typeof m.reproducePct === "number") {
    const rem = Array.isArray(m.reproduceRemain) && m.reproduceRemain.length
      ? `／残り: ${m.reproduceRemain.join("・")}`
      : "／再現の条件は揃った";
    today.push(`人間らしさの再現 ${m.reproducePct}%${rem}`);
  }
  /**
   * ★ 2026-11-16「人間として自動モード動くようにできているのか、統括ちゃんと判断」:
   *   材料点・弱い所の件数だけでは「もう人間みたいに動ける」か分からない。
   *   → **可否を1行で先に言う**（完走・再現・束反映・手の形）。不可なら理由を並べる。
   */
  {
    const reasons: string[] = [];
    const ar = m.audits && num(m.audits.runs) > 0 ? num(m.audits.finish_rate) : null;
    if (ar != null && ar < 90) reasons.push(`完走率${ar}%`);
    if (typeof m.reproducePct === "number" && m.reproducePct < 70) reasons.push(`再現${m.reproducePct}%`);
    if (Array.isArray(m.reproduceRemain) && m.reproduceRemain.length) {
      for (const x of m.reproduceRemain.slice(0, 3)) reasons.push(String(x));
    }
    const br2 = m.bundleReflect;
    if (br2 && num(br2.screen_solid) >= 3 && num(br2.read_count) <= 0) reasons.push("拡張が束未読");
    if (br2 && br2.auto_after !== true && num(br2.screen_solid) >= 3) reasons.push("新束後の自動未確認");
    if (m.humanLike && num(m.humanLike.ops) >= 20 && num(m.humanLike.handCursorClicks) === 0) reasons.push("手の形0");
    if (m.humanLike && num(m.humanLike.changedWithoutClick) > 0) reasons.push(`直書き${m.humanLike.changedWithoutClick}`);
    if (m.verdict === "ready" && reasons.length === 0) {
      today.push("人間として自動できるか: 可（完走・再現・反映の線を満たす）");
    } else {
      const uniq = [...new Set(reasons)].slice(0, 6);
      today.push(`人間として自動できるか: 不可${uniq.length ? `（${uniq.join("・")}）` : `（結論=${HEAD[m.verdict]}）`}`);
    }
  }
  if (m.delta) {
    const d = m.delta;
    const parts: string[] = [];
    if (d.rows) parts.push(`記録${d.rows > 0 ? "+" : ""}${d.rows}`);
    if (d.next) parts.push(`順番${d.next > 0 ? "+" : ""}${d.next}`);
    if (d.points) parts.push(`場所${d.points > 0 ? "+" : ""}${d.points}`);
    /**
     * 2026-11-14 竹内さん「ちゃんと判断できるようになっているか」:
     *   ⚠ `opens`（押したら何が開くか）が `parts` に入っていなかったので、
     *     `delta` が `opens` だけ動いた時に**「前回から」が出なかった**（実測: opens -13 なのに黙っていた）。
     *   → 5つ全部を出す（記録・順番・場所・開き方・弱い所）。
     */
    if (d.opens) parts.push(`開き方${d.opens > 0 ? "+" : ""}${d.opens}`);
    if (d.weak) parts.push(`弱い所${d.weak > 0 ? "+" : ""}${d.weak}`);
    if (parts.length) today.push(`前回から: ${parts.join("・")}`);
  }

  // ── 議題（決めたい事）──
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示が詰まっている**のも議題（検索が動いていても現場は止まる）。
   */
  if (m.commands && num(m.commands.total) > 0 && m.commands.top_problem) {    const ma = m.commands.mode_absent;
    const absent = ma ? num(ma.aix_absent) + num(ma.brain_absent) : 0;
    agenda.push({
      priority: 0,
      topic: absent > 0 ? "自動/AIXモードになっていない時間が長い（指示が届かない）" : "現場への指示が詰まっている",
      why: String(m.commands.top_problem),
      /**
       * 2026-11-14 竹内さん「ここも調べる」→ 実測:
       *   ⚠ 失敗の **187件が「AIXモードのPCが3時間なかった」**。指示の処理は壊れていない。
       *   → **直す所を間違えない**ように、運用（モードを保つ）と処理（コード）を分けて言う。
       */
      decide: absent > 0
        ? "拡張を自動/AIXモードのままにしておく（PCを閉じない・モードを戻さない）／指示の期限を延ばすか"
        : "指示が拾われるようにする／失敗の理由を直す",
    });
    questions.push({
      q: absent > 0
        ? `指示の失敗 ${absent}件は「自動/AIXモードのPCが3時間なかった」ためです。どちらを直しますか？`
        : `現場への指示: ${m.commands.top_problem} どれから直しますか？`,
      options: absent > 0
        ? ["モードを保つ運用を直す（推奨）", "指示の期限を延ばす", "今のままでよい"]
        : ["拾われていない指示から（推奨）", "失敗の理由から", "今のままでよい"],
      why: absent > 0
        ? "指示の処理は壊れていない。拡張がモードになっていない時間が長いのが原因"
        : "検索が動いていても、指示が届かなければ物件が出ない",
    });
  }
  /**
   * 2026-11-14 竹内さん
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごと**に手本があるかを見る。手本が無い場面があれば、それが一番の弱い所
   *     （できない事を「学べている」と言わない）。
   *   ⚠ 優先度は高め（1）だが「止まっている」（0）より後ろ。止まるのを直さないと手本が増えない。
   */
  /**
   * 2026-11-14 竹内さん
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごと**に手本があるかを見る。手本が無い場面があれば、それが一番の弱い所。
   *
   *   ⚠ 2026-11-14 テストで発覚: 優先度2に置いたら、既存の議題（優先度0〜1が4件）に
   *     押し出されて**画面から消えていた**（`agenda.slice(0, 6)`・`questions.slice(0, 4)`）。
   *     「順番が毎回違う＝迷い」は**実際に人が迷っている**という一番確かな材料なので、
   *     手本が無い場面と同じ優先度1にする。
   */
  {
    const sf = Array.isArray(m.scene_flows) ? (m.scene_flows as SceneFlow[]) : [];
    /**
     * ⚠ 場面の材料が**1件も無い**時は「手本が無い」と言わない（分からないだけ）。
     *   `search_audits` に押した順番が入っていないと全場面が no_example になり、
     *   実際には人がやっているのに「学べていない」と言ってしまう（テストで発覚）。
     *   → **1場面でも手本がある時だけ**、無い場面を名指しする。
     */
    const weakScenes = sf.length ? findWeakScenes(sf) : [];
    const missing = weakScenes.filter((w) => w.kind === "no_example");
    const unstable = weakScenes.filter((w) => w.kind === "unstable");
    if (missing.length) {
      const names = missing.map((w) => SCENE_JA[w.scene]);
      agenda.push({
        priority: 1,
        topic: "手本が無い場面がある（そこは学べていない）",
        why: `${names.join("・")}の手本がありません（人がまだ1回もやっていない／記録できていない）`,
        decide: "その場面を人が1回やる（記録の経路も同時に確かめる）／今のままでよいか",
      });
      questions.push({
        q: `${names.join("・")}の手本が1件もありません。どれから増やしますか？`,
        options: [
          // 無い場面を全部出す（多い時は3つまで）＝竹内さんが選べる
          ...names.slice(0, 3).map((n, i) => `${n}を人が1回やる${i === 0 ? "（推奨）" : ""}`),
          "記録の経路（操作がDBに届くか）を先に直す",
          "今のままでよい",
        ],
        why: "手本が無い場面は自動にできません（推測で動かすと現場が壊れる）",
      });
    }
    if (unstable.length) {
      const u = unstable[0];
      agenda.push({
        priority: 1,
        topic: `${SCENE_JA[u.scene]}の順番が毎回違う（迷いの疑い）`,
        why: u.why,
        decide: `${u.next}／今のままでよいか`,
      });
      questions.push({
        q: `${SCENE_JA[u.scene]}の順番が毎回違います。決まりにしますか？`,
        options: [
          `一番多い順番を決まりにする（推奨）`,
          "人がもう数回やってから決める",
          "今のままでよい",
        ],
        why: "順番が毎回違う＝迷っている疑い。決まりにすると自動でも同じ順で動ける",
      });
    }
  }
  /**
   * 2026-11-14 竹内さん「所在地での検索の動かし方…弱い部分の学習を強化する」:
   *   **実際に止まった場面**（`abandoned` の最後の場面）が分かっていれば、それを名指しする。
   *   ⚠ 「完走率が低い」だけより**どこで止まるか**が分かる方が直せる。
   */
  if (typeof m.stopped_scene === "string" && m.stopped_scene) {
    agenda.push({
      priority: 1,
      topic: `止まる回が多いのは「${m.stopped_scene}」`,
      why: `途中で止まった回の最後の場面は ${m.stopped_scene} が一番多い`,
      decide: `${m.stopped_scene}の動かし方を直す（手本と違う所を探す）／今のままでよいか`,
    });
  }

  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **一番大事な議題は「実際の検索が止まっている」**（人の動きを学べていても意味がない）。
   *   ⚠ 実測: 60回中56回が途中で止まっていた。
   */
  if (m.audits && num(m.audits.runs) > 0 && num(m.audits.finish_rate) < 90) {    const top = Array.isArray(m.audits.stalled_at) && m.audits.stalled_at.length ? m.audits.stalled_at[0] : null;
    agenda.push({
      priority: 0,
      topic: "実際の検索が途中で止まっている",
      why: `${m.audits.runs}回中 完走は ${m.audits.finished}回だけ（完走率 ${m.audits.finish_rate}%）${top ? `。一番多いのは「${top.stage}」で止まる（${top.n}回）` : ""}`,
      decide: top ? `「${top.stage}」を直す／このままでよいか` : "止まる原因を調べる",
      ...(m.audits.advice ? { why: `${m.audits.runs}回中 完走は ${m.audits.finished}回だけ（完走率 ${m.audits.finish_rate}%）。${top ? `一番多いのは「${top.stage}」（${top.n}回）。` : ""}${m.audits.advice}` } : {}),
    });
    questions.push({
      q: `実際の検索が ${m.audits.runs}回中 ${m.audits.finished}回しか完走していません（完走率 ${m.audits.finish_rate}%）。どれから直しますか？`,
      options: top ? [`「${top.stage}」から直す（推奨）`, "別の所から直す", "今のままでよい"] : ["止まる原因を調べる（推奨）", "今のままでよい"],
      why: "人の動きを学べていても、実際の検索が止まるなら自動には渡せない",
    });
  }

  /**
   * ⚠ 一番大事な議題は「**材料が足りない**」事。数字が良くても中身が薄い事がある。
   */
  if (m.humanOps != null || m.autoOps != null) {
    const h = num(m.humanOps), a = num(m.autoOps), t = h + a;
    if (t > 0 && h / t < 0.3) {
      agenda.push({
        priority: 1,
        topic: "人の手本が少ない（自動を良くする材料が足りない）",
        why: `手本にできる人の操作が ${h}回、機械の操作が ${a}回（人の割合 ${Math.round((h / t) * 100)}%）`,
        /**
         * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
         *   ⚠ 機械の動きを学んでも**自分の癖を強める**だけ。自動を良くするのは人の手本。
         */
        decide: "通常モードで人が実際に検索して録画する（自動モードの動きは手本にしない）",
      });
      questions.push({
        q: `自動を良くする「人の手本」が ${Math.round((h / t) * 100)}% しかありません（人${h}回/機械${a}回）。どうしますか？`,
        options: ["通常モードで人が検索して録画を増やす（推奨）", "機械の動きも半分の重さで学ぶ", "今のままでよい"],
        why: "機械の動きを手本にすると、自動の癖を強めてしまう",
      });
    }
  }
  /**
   * ⚠ 一番大事な議題は「**材料が足りない**」事。数字が良くても中身が薄い事がある。
   */
  if (m.rows > 0 && m.withOps / m.rows < 0.3) {
    agenda.push({
      priority: 0,
      topic: "写真は撮れているのに、操作が付いていない",
      why: `記録 ${m.rows}件のうち、操作の並びが付いているのは ${m.withOps}件（${Math.round((m.withOps / m.rows) * 100)}%）`,
      decide: "操作を付ける仕組みを直す（録画の経路）／このままでよいか",
    });
  }
  if (m.opens > 0 && m.guessedOpens >= m.opens) {
    agenda.push({
      priority: 1,
      topic: "「押したら何が開くか」が全部推測",
      why: `実測が0で、名前から推測した ${m.guessedOpens}個だけ`,
      decide: "推測を点数に入れるか／実測が入るまで点を下げるか",
    });
  }
  if (m.block) {
    agenda.push({ priority: 0, topic: "自動に渡すと危ない状態", why: m.block, decide: "自動を止めるか、警告だけで続けるか" });
  }
  /**
   * ★ 2026-11-15 竹内さん「統括はこのこと理解するために必要な土台作り細部まで理解できるようにする」:
   *   **前のお客さんの条件を外す仕事が多い**時は議題にする。
   *   ⚠ 「外した」が多い＝前のお客さんの条件が残っている＝**別のお客さんの条件で検索する危険**。
   *     統括がこれを自分から言えれば、私は「選んでいる」と誤読しない。
   */
  if (m.toggles && m.toggles.off > 0) {
    agenda.push({
      priority: 1,
      topic: "前のお客さんの条件を外す仕事が発生している",
      why: `押した操作のうち **${m.toggles.off}件が「前に残っていたのを外した」**（選んだのは ${m.toggles.on}件）。くれあ型: 条件外の区だけ外し・条件内（北・中央・西など）は触らない`,
      decide: "条件外だけ1つずつ外す型を束と自動preclearへ写す（was/nowで外しを記録）／このままでよいか",
    });
  } else if (m.toggles && m.toggles.unknown > 50 && m.toggles.off === 0 && m.toggles.on === 0) {
    agenda.push({
      priority: 1,
      topic: "区の外し/選びが区別できない（was/nowがDBに無い）",
      why: `区別できない ${m.toggles.unknown}件・外し0・選び0。仕組み②（前客の残りを外す）を学べない`,
      decide: "拡張再読込→通常で区を1つ外す・1つ選ぶを録画→shot_opsに was/now が残るか確かめる",
    });
  }
  /**
   * ★ 2026-11-15 竹内さん「この問題なども把握して補強していくようにする」:
   *   **自動モードが人間のように動けない**時は議題にする。
   *   ⚠ 実測: 自動はカーソル35%・押さずに値が変わる4件で、通常モード（96%・問題なし）と差があった。
   *     「自動モードは人の真似ができていない」と統括が自分から言えるようにする。
   */
  if (m.humanLike && m.humanLike.ops > 0) {
    const h = m.humanLike;
    const cursorPct = h.rows > 0 ? Math.round((h.withCursor / h.rows) * 100) : 0;
    const pointPct = h.rows > 0 ? Math.round((h.withPoint / h.rows) * 100) : 0;
    const directFields = Array.isArray(h.changedWithoutClickFields) ? h.changedWithoutClickFields : [];
    /** 完了線と同じ度で議題化（旧: カーソル<50 だと 50〜69% が放置された） */
    if (h.changedWithoutClick > 0 || h.typedOnChoose > 0
      || cursorPct < DETAIL_DEGREE.CURSOR_OK
      || pointPct < DETAIL_DEGREE.POINT_OK) {
      const why: string[] = [];
      if (h.changedWithoutClick > 0) {
        why.push(`直書き疑い（押さず変化） ${h.changedWithoutClick}件` + (directFields.length ? `（${directFields.slice(0, 4).join("・")}）` : ""));
      }
      if (h.typedOnChoose > 0) why.push(`選ぶ欄に打ち込んだ ${h.typedOnChoose}件`);
      if (cursorPct < DETAIL_DEGREE.CURSOR_OK) {
        why.push(`カーソルの記録が ${cursorPct}%（要≥${DETAIL_DEGREE.CURSOR_OK}）`);
      }
      if (pointPct < DETAIL_DEGREE.POINT_OK) {
        why.push(`押した位置の記録が ${pointPct}%（要≥${DETAIL_DEGREE.POINT_OK}）`);
      }
      agenda.push({
        priority: 1,
        topic: "自動モードが人間のように動けていない（直書き・カーソル・細部の度）",
        why: why.join("／"),
        decide: "直書きをやめカーソル→開く→押す。弱い欄は通常モード録画から細部まで学ぶ。見つかった弱い部分は必ず改善する",
      });
    }
    if ((h.handCursorClicks ?? 0) === 0 && h.ops >= 20) {
      agenda.push({
        priority: 1,
        topic: "手の形（pointer）を通常モードから学ぶ土台がまだ薄い",
        why: "shot_ops.cs=pointer の記録が無い（ボタン上で手が付く押しを通常で録画して学ぶ）",
        decide: "通常モードでボタン操作を録画 → 束の cursor_hand → 見えるカーソルが手に変わる",
      });
    }
  }
  /**
   * ★ 2026-11-15 竹内さん「ここの抜けていた部分もちゃんと統括は把握できるように」:
   *   **まだ読める写真が残っている**時は議題にする（統括が「次はこれを読む」と決める）。
   *   ⚠ 費用がかかるので**枚数と概算**を付ける（1枚 0.17円・実測）。
   */
  if (m.improveFromNormal && Array.isArray(m.improveFromNormal.fields) && m.improveFromNormal.fields.length) {
    agenda.push({
      priority: 0,
      topic: String(m.improveFromNormal.what || "自動の最新課題を通常から改善する"),
      why: String(m.improveFromNormal.why || ""),
      decide: `${m.improveFromNormal.how || "通常の最新画像を読む"}（枚数は統括が課題に応じて決める・解けるまで）／後でよいか`,
    });
  } else {
    const gn = m.shotGapsNormal && m.shotGapsNormal.todo > 0 ? m.shotGapsNormal : null;
    const g = gn || (m.shotGaps && m.shotGaps.todo > 0 ? m.shotGaps : null);
    if (g) {
      const fromNormal = !!gn;
      const lim = photoLearnLimitFor({ todo: g.todo, fieldCount: m.weakN });
      agenda.push({
        priority: m.weakN > 0 ? 0 : 1,
        topic: fromNormal
          ? "通常モードの画像を読んで弱い所を強化する"
          : "まだ学習していない写真が残っている",
        why: fromNormal
          ? `通常モードの読める未学習 ${g.todo}枚（弱い所 ${m.weakN}件・画像を読めば学習できる）`
          : `${g.todo}枚が読めるのに未学習（未学習${g.unlearnedBig}・欄0が${g.learnedButEmpty}）`,
        decide: `通常モードの画像を読む（統括が ${lim}枚と判断・約${Math.max(1, Math.round(lim * 0.17))}円・1枚0.17円・課題が解けるまで）／後でよいか`,
      });
    }
  }
  if (m.recordingFreshness?.normalLatestAt && m.recordingFreshness.normalLatestLearned === false) {
    agenda.push({
      priority: 1,
      topic: "最新の通常録画画像がまだ未学習",
      why: `通常 最新 ${String(m.recordingFreshness.normalLatestAt).slice(0, 19)}（直近24h ${m.recordingFreshness.normalLast24h ?? 0}枚）`,
      decide: "最新から読む（order=newest）／後でよいか",
    });
  }
  /**
   * ★ 2026-11-15 竹内さん「押した位置も通常モードの録画の画像から…統括お願い」:
   *   画像×押した位置の突き合わせで出た**悪い所**を議題にする。
   */
  if (m.imageMatch && Array.isArray(m.imageMatch.say) && m.imageMatch.say.length) {
    for (const s of m.imageMatch.say.slice(0, 2)) {
      agenda.push({
        priority: 1,
        topic: s.what,
        why: s.why,
        decide: s.next,
      });
    }
  }
  if (m.imageMatch && m.imageMatch.withScreenPos >= 3) {
    agenda.push({
      priority: 2,
      topic: "通常モードの画像から読んだ画面の位置を自動に渡す",
      why: `画面の位置あり ${m.imageMatch.withScreenPos}欄（両方にある ${m.imageMatch.matched}欄）`,
      decide: "束を作り直して拡張に届ける／このままでよいか",
    });
  }
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   位置はあるのに拡張が読んでいない／自動が新束のあと走っていない → **最優先で議題**。
   */
  if (m.bundleReflect && (m.bundleReflect.screen_solid >= 3 || (m.bundleReflect.photo_in_storage ?? 0) > 0)) {
    const br = m.bundleReflect;
    if ((br.read_count ?? 0) <= 0 && br.screen_solid >= 3) {
      agenda.push({
        priority: 0,
        topic: "連携ボトルネック: 拡張が束を読んでいない（段階4）",
        why: br.bottleneck || br.line || `画面位置 n≥3 が ${br.screen_solid}欄あるのに read_count=0`,
        decide: "拡張 2.8.25 を再読み込み → ポップアップを開く → コンソールで「連携完了」→ 自動を1回",
      });
    } else if (br.screen_solid >= 3 && !br.auto_after) {
      agenda.push({
        priority: 0,
        topic: "連携ボトルネック: 新束のあと自動がまだ無い（段階5）",
        why: br.bottleneck || br.line || `read_count=${br.read_count}・自動はまだ束より前`,
        decide: "自動モードで1回検索して、位置が効いているか数字で確かめる",
      });
    }
  }
  /**
   * ★ 2026-11-17 竹内さん「統括は土台を理解して統括できるように」:
   *   F31/F32/F29 が欠けていれば議題の先頭付近に出す（Proが steps だけに偏らない）。
   */
  if (m.foundationAudit && m.foundationAudit.missing_n > 0) {
    const fa = m.foundationAudit;
    const keyMiss = ["F32_link_pipeline", "F31_learn_reflect_station", "F29_human_nearness", "F6_auto_after_bundle"]
      .map((id) => fa.key[id])
      .filter((k) => k && !k.ok);
    const top = fa.missing[0];
    agenda.push({
      priority: 0,
      topic: "学習土台の欠落をそろえる（統括が把握した土台）",
      why: fa.summary + (keyMiss.length
        ? `／重要欠: ${keyMiss.map((k) => (k!.line || "").slice(0, 80)).join(" ・ ")}`
        : (top ? `／先頭欠 ${top.id}: ${top.line.slice(0, 80)}` : "")),
      decide: top
        ? `${top.next}（層=${top.layer}）／後でよいか`
        : "foundation-audit の欠を上から1本ずつ／後でよいか",
    });
  }
  if (m.shotGaps && m.shotGaps.unlearnedSmall > 0 && m.shotGaps.unlearnedBig === 0) {
    agenda.push({
      priority: 2,
      topic: "小さい写真しか残っていない",
      why: `${m.shotGaps.unlearnedSmall}枚（480px では欄が読めない・実測）`,
      decide: "今の版（2.7.78）で録画し直す（費用0）",
    });
  }
  /**
   * ★ 2026-11-15 竹内さん「自動モードの改善は録画している学習データから統括が改善する」:
   *   **改善候補を議題に出す**（統括が「これからやる」と宣言する）。
   *   ⚠ 費用がかかる物は「読む＝約N円／後でよいか」の形で竹内さんに聞く。
   */
  if (Array.isArray(m.autoFix) && m.autoFix.length) {
    for (const f of m.autoFix.slice(0, 3)) {
      agenda.push({
        priority: f.cost.includes("0円") ? 1 : 2,
        topic: `自動モードを直す: ${f.what}`,
        why: `${f.why}（効く事: ${f.effect}）`,
        decide: `${f.how}（${f.cost}）`,
      });
    }
  }
  const siteKeys = Object.keys(m.siteCounts).filter((k) => k && k !== "(空)");
  if (siteKeys.length === 1 && m.site === "all") {
    agenda.push({
      priority: 2,
      topic: `片方のサイト（${siteKeys[0]}）しか記録が無い`,
      why: `${siteKeys[0]} だけ。もう片方は運用されていない`,
      decide: "もう片方も運用するか／片方だけでよいか",
    });
  }
  if (m.coverage >= 65 && m.weakN > 5) {
    agenda.push({
      priority: 3,
      topic: "点数は高いのに弱い所が多い",
      why: `材料 ${m.coverage}点なのに弱い所 ${m.weakN}件`,
      decide: "点数の配点を見直すか／弱い所を先に潰すか",
    });
  }
  for (const a of m.actions.slice(0, 3)) {
    if (agenda.length >= 5) break;
    agenda.push({
      priority: 4,
      topic: a.what + (a.name ? `（${a.name}）` : ""),
      why: a.why || "",
      decide: a.how,
    });
  }
  /**
   * 2026-11-14 竹内さん「必要な部分を統括が判断して学習すれば強化される」:
   *   統括が**自分で「次に何を学ぶか」を決める**（竹内さんが毎回指図しなくてよい形）。
   *
   * ★ 2026-11-15「改善につながるまで一連の流れをちゃんと統括はできるようにする」:
   *   ⚠ 実測: 画像学習・束まで進んでも read_count=0 で自動は改善されない。
   *     「もっと読め」だけ出して段階4を課題にしなかった。
   *   → **improve_loop（段階1〜6）の止まっている所から課題を出す**。
   *     段階4なら拡張再読み込みが先（学習を足しても改善に繋がらない）。
   */
  {
    const tasks: Array<{ kind: string; what: string; why: string; cost: string; limit?: number; order?: "newest" | "time" | "size" | "sequence"; runId?: string; fields?: string[] }> = [];
    const shotPct = m.shotRows != null && m.rows > 0 ? Math.round((m.shotRows / m.rows) * 100) : null;
    const opsPct = m.rows > 0 ? Math.round((m.withOps / Math.max(1, m.rows)) * 100) : 0;

    /** ① 改善までの一連（止まっている段階の次の一手） */
    if (m.improveLoop && (m.improveLoop.bottleneck_n != null || m.improveLoop.improve_line)) {
      const loop = {
        steps: Array.isArray(m.improveLoop.steps) ? m.improveLoop.steps : [],
        bottleneck_n: m.improveLoop.bottleneck_n ?? null,
        bottleneck: m.improveLoop.bottleneck ?? null,
        line: "",
        improve_line: m.improveLoop.improve_line || "",
        next_n: m.improveLoop.next_n ?? null,
        next_kind: (m.improveLoop.next_kind as ImproveLoop["next_kind"]) ?? null,
      } as ImproveLoop;
      const loopTasks = improveLoopTasks({
        loop,
        unreadNormal: m.shotGapsNormal?.todo ?? m.shotGaps?.todo ?? 0,
        challengeFields: m.latestAutoChallenge?.fields || m.improveFromNormal?.fields || [],
        preferNewest: true,
        missingInBundle: m.challengeMissingInBundle || [],
      });
      for (const t of loopTasks) tasks.push({ ...t });
      if (m.improveLoop.bottleneck_n != null) {
        agenda.push({
          priority: 0,
          topic: `改善までの一連: 段階${m.improveLoop.bottleneck_n}で停止`,
          why: m.improveLoop.improve_line || m.improveLoop.bottleneck || "",
          decide: loopTasks[0]
            ? `${loopTasks[0].what}（${loopTasks[0].cost}）`
            : "止まっている段階の次の一手を進める",
        });
      }
    } else {
      /** 一連が無い時の旧ルート（反映・写真） */
      if (m.bundleReflect && m.bundleReflect.screen_solid >= 3
        && ((m.bundleReflect.read_count ?? 0) <= 0 || !m.bundleReflect.auto_after)) {
        tasks.push({
          kind: "reflect_auto",
          what: "学んだ画面の位置を束に載せ直し、拡張・自動への反映状態を確かめる",
          why: m.bundleReflect.line || `画面位置 n≥3 が ${m.bundleReflect.screen_solid}欄・反映が途中で止まっている`,
          cost: "無料",
        });
      }
      const gn = m.shotGapsNormal && m.shotGapsNormal.todo > 0 ? m.shotGapsNormal : null;
      const gAll = m.shotGaps && m.shotGaps.todo > 0 ? m.shotGaps : null;
      const g = gn || gAll;
      const byOpsGap = shotPct != null && shotPct >= 50 && opsPct < 60;
      const improve = m.improveFromNormal;
      const hasImprove = !!(improve && Array.isArray(improve.fields) && improve.fields.length);
      if (g || byOpsGap || hasImprove) {
        const todo = g ? g.todo : Math.min(20, Math.max(1, Math.round((shotPct ?? 0) / 5)));
        const lim = photoLearnLimitFor({
          todo,
          fieldCount: hasImprove ? (improve!.fields!.length) : m.weakN,
        });
        const task: (typeof tasks)[number] = {
          kind: "photo_learn",
          what: hasImprove
            ? "自動の最新課題を、通常モードの最新画像から改善する（欄の種類・位置）"
            : "通常モードの画像を読んで弱い所を強化する（欄の種類・位置）",
          why: hasImprove
            ? `${improve!.why}／読める未学習 ${todo || "?"}枚`
            : g
              ? `通常モードの読める未学習 ${todo}枚（弱い所 ${m.weakN}件）`
              : `写真は${shotPct}%・操作は${opsPct}%`,
          cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
          limit: lim,
          order: "newest",
        };
        if (hasImprove) task.fields = improve!.fields!.slice(0, 8);
        // ★ 2026-11-16: 直書き疑いの欄も通常画像学習の対象に載せる
        const direct = (m.humanLike && Array.isArray(m.humanLike.changedWithoutClickFields))
          ? m.humanLike.changedWithoutClickFields : [];
        if (direct.length) {
          const merged = [...(task.fields || []), ...direct].filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
          task.fields = merged;
          if (!hasImprove) {
            task.what = "直書き疑いの欄を、通常モードの画像・押し方から改善する";
            task.why = `直書き疑い ${direct.join("・")}／${task.why}`;
          }
        }
        tasks.push(task);
      } else if (m.humanLike && Array.isArray(m.humanLike.changedWithoutClickFields) && m.humanLike.changedWithoutClickFields.length) {
        const direct = m.humanLike.changedWithoutClickFields;
        const lim = photoLearnLimitFor({ todo: Math.max(8, direct.length * 4), fieldCount: direct.length });
        tasks.push({
          kind: "photo_learn",
          what: "直書き疑いの欄を、通常モードの最新画像から改善する",
          why: `押さず変化の欄: ${direct.join("・")}`,
          cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
          limit: lim,
          order: "newest",
          fields: direct.slice(0, 8),
        });
      }
    }
    /**
     * ★ 2026-11-18 竹内さん「課題学習の完全化／自動モードへの反映」:
     *   F54・F55 が ✗ のとき議題と learning_tasks に必ず載せる（抜け止め）。
     */
    {
      const k54 = m.foundationAudit?.key?.F54_challenge_learn_complete;
      const k55 = m.foundationAudit?.key?.F55_auto_reflect_verified;
      if (k54 && k54.ok === false) {
        agenda.push({
          priority: 0,
          topic: "課題欄の学習が未完（F54）",
          why: String(k54.line || "").slice(0, 200),
          decide: "最新自動の課題欄を通常で学び、束の points と learned の両方へ載せる",
        });
        const missBundle = (m.challengeMissingInBundle || []).slice(0, 10);
        const missFields = missBundle.length
          ? missBundle
          : (m.latestAutoChallenge?.fields || m.improveFromNormal?.fields || []).slice(0, 10);
        if (missFields.length) {
          const pl = tasks.find((t) => t.kind === "photo_learn");
          if (pl) {
            pl.fields = [...new Set([...(pl.fields || []), ...missFields])].slice(0, 10);
            if (!/F54|points|learned/.test(pl.why)) pl.why = `F54 ✗（束欠）／${pl.why}`;
          } else {
            const todo = m.shotGapsNormal?.todo ?? m.shotGaps?.todo ?? 8;
            tasks.push({
              kind: "photo_learn",
              what: "課題欄を通常画像から学び、束の points と learned の両方へ載せる（F54）",
              why: `F54 ✗／${String(k54.line || "").slice(0, 120)}／欄: ${missFields.slice(0, 5).join("・")}`,
              cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
              limit: photoLearnLimitFor({ todo: Math.max(8, todo), fieldCount: missFields.length }),
              order: "newest",
              fields: missFields,
            });
          }
        }
      }
      if (k55 && k55.ok === false) {
        agenda.push({
          priority: 0,
          topic: "自動モードへの反映が未確認（F55）",
          why: String(k55.line || "").slice(0, 200),
          decide: "拡張再読込→自動1回→ learn_reflect_ok / aim有 を監査で確認",
        });
        const line55 = String(k55.line || "");
        if ((/read[= ]0\b|read_count=0/.test(line55) || (m.bundleReflect?.read_count ?? 0) <= 0)
          && !tasks.some((t) => t.kind === "need_ext_reload")) {
          tasks.push({
            kind: "need_ext_reload",
            what: "拡張を再読み込みして束を読む（F55・read未達）",
            why: line55.slice(0, 160) || "F55 read<1",
            cost: "無料",
          });
        }
        if ((/新束後自動=0\b/.test(line55) || m.bundleReflect?.auto_after === false)
          && !tasks.some((t) => t.kind === "need_auto_run")) {
          tasks.push({
            kind: "need_auto_run",
            what: "新束のあと自動モードで1回検索（F55・反映測定）",
            why: line55.slice(0, 160) || "F55 新束後自動なし",
            cost: "無料",
          });
        }
        if (/reflect_ok=0|flow_reflect=0|aim有=0|止=reflect/.test(line55)
          && !tasks.some((t) => t.kind === "verify_improve" || t.kind === "reflect_auto")) {
          tasks.push({
            kind: "verify_improve",
            what: "自動監査で learn_reflect_ok / learn_flow_reflect_ok / aim有 を確認（F55）",
            why: line55.slice(0, 160) || "F55 反映印なし",
            cost: "無料",
          });
        }
      }
    }
    /** ② 手本が無い場面（推測で動かさない） */
    if (typeof m.scene_missing === "number" && m.scene_missing > 0) {
      tasks.push({
        kind: "need_human",
        what: `${String(m.scene_missing_names || "").trim() || "手本が無い場面"}を人が1回やる`,
        why: "手本が無い場面は自動にできない（推測で動かすと現場が壊れる）",
        cost: "無料（人の手間だけ）",
      });
    }
    /** ③ 止まる場面（一番現場に効く）— 課題欄の場面と連動させる */
    if (typeof m.stopped_scene === "string" && m.stopped_scene) {
      const chForStop = [
        ...(m.latestAutoChallenge?.fields || []),
        ...(m.humanLike?.changedWithoutClickFields || []),
      ];
      const stopLinks = linkFieldsToScenes(chForStop, Array.isArray(m.scene_flows) ? m.scene_flows : null)
        .filter((l) => SCENE_JA[l.scene] === m.stopped_scene || m.stopped_scene!.includes(SCENE_JA[l.scene].slice(0, 2)));
      const linkedWhy = stopLinks.length
        ? `／連動する課題欄: ${stopLinks.map((l) => l.field).slice(0, 4).join("・")}`
        : "";
      tasks.push({
        kind: "fix_scene",
        what: `「${m.stopped_scene}」で止まる原因を、手本と比べて探す`,
        why: `途中で止まった回の最後の場面は「${m.stopped_scene}」が一番多い${linkedWhy}`,
        cost: "無料",
      });
    }
    /**
     * ★ 2026-11-16「統括はここの土台構築の部分もふくめておこなう」:
     *   再現が未完で土台の抜けがある時は、土台点検を課題に載せる（学ぶだけでは循環が止まらない）。
     *   ★ 細分化ヒント（atomsToTaskHints）も載せて、自動で見つけた弱所→通常学習を連動させる。
     */
    {
      const repro = typeof m.reproducePct === "number" ? m.reproducePct : null;
      const h = m.humanLike;
      const needFoundation = (repro != null && repro < 100)
        || (h && h.ops >= 20 && (
          h.changedWithoutClick > 0
          || (h.handCursorClicks ?? 0) === 0
          || (h.rows > 0 && Math.round((h.withCursor / h.rows) * 100) < 70)
        ));
      if (needFoundation && !tasks.some((t) => t.kind === "build_foundation")) {
        const foundN = subdividedAtoms.filter((a) => a.layer === "find").length;
        const foundN2 = subdividedAtoms.filter((a) => a.layer === "foundation").length;
        tasks.push({
          kind: "build_foundation",
          what: "再現に足りない土台を細分化してそろえる（統括の土台構築）",
          why: repro != null
            ? `再現 ${repro}%／細分化 見つける${foundN}・土台${foundN2}／残り ${(m.reproduceRemain || []).join("・") || "－"}`
            : "人間らしさの再現が未完。土台を細分化してから再現する",
          cost: "無料",
        });
      }
      for (const hint of atomsToTaskHints(subdividedAtoms)) {
        if (tasks.some((t) => t.kind === hint.kind && t.what.slice(0, 24) === hint.what.slice(0, 24))) continue;
        if (hint.kind === "photo_learn" && tasks.some((t) => t.kind === "photo_learn")) {
          // 既存 photo_learn に欄をマージ
          const pl = tasks.find((t) => t.kind === "photo_learn")!;
          const merged = [...(pl.fields || []), ...(hint.fields || [])]
            .filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
          pl.fields = merged;
          if (!/細分化|自動で見つけた/.test(pl.what)) {
            pl.what = "自動で見つけた弱所を、通常録画から細分化して学ぶ";
            pl.why = `${hint.why}／${pl.why}`;
          }
          continue;
        }
        if (hint.kind === "build_foundation" && tasks.some((t) => t.kind === "build_foundation")) continue;
        if (hint.kind === "need_auto_run" && tasks.some((t) => t.kind === "need_auto_run")) continue;
        if (hint.kind === "fix_scene" && tasks.some((t) => t.kind === "fix_scene")) continue;
        if (hint.kind === "need_human" && tasks.some((t) => t.kind === "need_human" && /手の形/.test(t.what))) continue;
        const task: (typeof tasks)[number] = {
          kind: hint.kind,
          what: hint.what,
          why: hint.why,
          cost: hint.kind === "photo_learn"
            ? "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）"
            : hint.kind === "need_human" || hint.kind === "need_auto_run"
              ? "無料（人の手間だけ）"
              : "無料",
        };
        if (hint.fields?.length) {
          task.fields = hint.fields;
          task.order = "newest";
          task.limit = photoLearnLimitFor({ todo: Math.max(8, hint.fields.length * 4), fieldCount: hint.fields.length });
        }
        tasks.push(task);
      }
    }
    /** ④ 録画の経路（操作が届いていない） */
    if (m.rows > 0 && m.withOps / m.rows < 0.3 && (!shotPct || shotPct < 50)) {
      tasks.push({
        kind: "fix_record",
        what: "録画の記録（押した操作）がDBに届くようにする",
        why: `記録 ${m.rows}件のうち操作が付いているのは ${m.withOps}件（${opsPct}%）`,
        cost: "無料",
      });
    }
    /**
     * ★ 2026-11-16「通常モードの録画があれば完全に再現…土台をそろえる」:
     *   通常録画があるのに再現が未完 → **録画を増やす前に**足りない土台を課題にする。
     *   ・手の形0 → 2.8.25再読込のあと、通常でボタンを1回録画（cs=pointer）
     *   ・直書き／カーソル／位置 → すでにある通常画像・操作から photo_learn／反映
     */
    {
      const normalN = num(m.modeCounts?.normal) || (m.shotGapsNormal?.total ?? 0);
      const repro = typeof m.reproducePct === "number" ? m.reproducePct : null;
      const h = m.humanLike;
      if (normalN > 0 && repro != null && repro < 100 && h && h.ops > 0) {
        const remain = Array.isArray(m.reproduceRemain) ? m.reproduceRemain : [];
        agenda.push({
          priority: 0,
          topic: "通常録画はあるのに、人間らしさの再現が未完（土台をそろえる）",
          why: `通常 ${normalN}／再現 ${repro}%／残り ${remain.join("・") || "－"}。ある通常録画から学ぶ（増やすのは土台を揃えたあと）`,
          decide: "拡張2.8.25再読込→ポップアップ開く（束取得）→通常の既存画像・操作から学ぶ→手の形が無ければ通常でボタン1回録画→効果確認",
        });
        if ((h.handCursorClicks ?? 0) === 0 && h.ops >= 20) {
          const read0 = m.bundleReflect && (m.bundleReflect.read_count ?? 0) <= 0;
          if (read0) {
            // 再読込が無いと cs も束も届かない → need_ext_reload は一連側で出る
          } else {
            tasks.push({
              kind: "need_human",
              what: "通常モードで手が付くボタン操作を1回録画する（手の形の土台）",
              why: "通常録画はあるが shot_ops.cs=pointer が無い。2.8.25でボタンを押して録画すれば cursor_hand が揃う",
              cost: "無料（人の手間だけ）",
            });
          }
        }
        const direct = Array.isArray(h.changedWithoutClickFields) ? h.changedWithoutClickFields : [];
        const todoN = m.shotGapsNormal?.todo ?? 0;
        if ((direct.length > 0 || remain.some((x) => /カーソル|押した位置/.test(x))) && todoN > 0
          && !tasks.some((t) => t.kind === "photo_learn")) {
          const lim = photoLearnLimitFor({ todo: todoN, fieldCount: Math.max(direct.length, 3) });
          tasks.push({
            kind: "photo_learn",
            what: "通常録画の画像から、再現の残り（直書き・位置）を埋める",
            why: `再現 ${repro}%・通常の読める未学習 ${todoN}枚${direct.length ? `・直書き疑い ${direct.join("・")}` : ""}`,
            cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
            limit: lim,
            order: "newest",
            fields: direct.slice(0, 8),
          });
        }
      }
    }
    /**
     * ★ 2026-11-17: itandi の記録が薄い時は、リアプロと同じ学習方法を回す材料として通常録画を要求。
     *   実測: itandi 3日 motion≈4／通常1。型（F50・ITANDI_BUTTONS）はあっても材料が無いと回らない。
     */
    {
      const itN = num(m.siteCounts?.itandi);
      const isIt = m.site === "itandi" || (m.site === "all" && itN > 0 && itN < 30);
      const thin = m.site === "itandi" ? m.rows < 30 : itN > 0 && itN < 30;
      if (isIt && thin && !tasks.some((t) => t.kind === "need_human" && /ITANDI|itandi/.test(t.what))) {
        tasks.push({
          kind: "need_human",
          what: "ITANDIを通常モードで検索1通し録画する（所在地→路線駅→条件→検索）",
          why: `itandi記録が薄い（site=${m.site} rows=${m.rows}／site_counts.itandi=${itN || 0}）。リアプロと同じ学習方法①〜⑤を回す材料が要る`,
          cost: "無料（人の手間だけ）",
        });
        agenda.push({
          priority: 0,
          topic: "ITANDIでもリアプロと同じ学習方法を回す（通常録画が足りない）",
          why: `itandiの記録が少ない。ITANDI_BUTTONS・サイト別統括の型はあるが、通常録画が無いと①〜⑤が回らない`,
          decide: "ITANDI通常モードで1通し録画→束再生成→supervisor --scope=itandi で弱点把握→photo_learn／土台追加",
        });
      }
    }
    /**
     * ★ 2026-11-16「細かくまなんでいく／学習改善も仕組み強化」:
     *   欄×観点の抜けを課題ヒントに載せてから、仕組み①②を効かせる。
     */
    /**
     * ★ 2026-11-16「弱い部分を見つけたら統括はそこを改善」「細部までこだわった改善」:
     *   欄スコアが度未満なら議題 priority0 ＋ 改善課題必須（見つけただけで終わらせない）。
     */
    {
      const weakFs = weakDetailFields(fineStatuses);
      if (weakFs.length) {
        const avg = Math.round(fineStatuses.reduce((s, x) => s + x.score, 0) / fineStatuses.length);
        agenda.push({
          priority: 0,
          topic: `弱い部分を細部まで改善する（${weakFs.length}欄）`,
          why: `度: 欄${DETAIL_DEGREE.WEAK_FIELD}未満／弱い: ${weakFs.slice(0, 5).join("・")}／欄×観点平均${avg}%（要≥${DETAIL_DEGREE.FINE_AVG_OK}）`,
          decide: "通常録画から観点ごとに学ぶ→束→拡張→自動→効果確認。人間の動きになるまで細部を直す",
        });
      }
    }
    {
      const fineHints = fineGapsToTaskHints(fineLearnNextSteps(fineStatuses, 8));
      for (const hint of fineHints) {
        if (hint.kind === "photo_learn" && tasks.some((t) => t.kind === "photo_learn")) {
          const pl = tasks.find((t) => t.kind === "photo_learn")!;
          const merged = [...(hint.fields || []), ...(pl.fields || [])]
            .filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
          pl.fields = merged;
          if (!/細かく学ぶ|欄×観点/.test(pl.what)) {
            pl.what = "欄を細かく学ぶ（位置・押して変化・仕組みに沿って）";
            pl.why = `${hint.why}／${pl.why}`;
          }
          continue;
        }
        if (hint.kind === "build_foundation" && tasks.some((t) => t.kind === "build_foundation" && /was\/now|くれあ|区/.test(t.what + t.why))) {
          continue;
        }
        if (tasks.some((t) => t.kind === hint.kind && t.what.slice(0, 20) === hint.what.slice(0, 20))) continue;
        const task: (typeof tasks)[number] = {
          kind: hint.kind,
          what: hint.what,
          why: hint.why,
          cost: hint.kind === "photo_learn"
            ? "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）"
            : hint.kind === "need_human"
              ? "無料（人の手間だけ）"
              : "無料",
        };
        if (hint.fields?.length) {
          task.fields = hint.fields;
          if (hint.kind === "photo_learn") {
            task.order = "newest";
            task.limit = photoLearnLimitFor({ todo: Math.max(8, hint.fields.length * 4), fieldCount: hint.fields.length });
          }
        }
        tasks.push(task);
      }
    }
    /**
     * ★ 2026-11-16「完成度も理解して学習する」:
     *   完成度の learnHint を議題と先頭課題の why に載せる（完成度が上がる学習を選ぶ）。
     */
    if (autoCompletion) {
      agenda.push({
        priority: 0,
        topic: `自動モード完成度 ${autoCompletion.score}/100（${autoCompletion.grade}）`,
        why: `内訳 ${autoCompletion.parts.map((p) => `${p.label}${p.score}/${p.max}`).join("・")}／残り ${autoCompletion.remain.slice(0, 3).join("・") || "なし"}`,
        decide: autoCompletion.learnHint,
      });
      if (tasks[0] && !/完成度/.test(tasks[0].why)) {
        tasks[0].why = `${tasks[0].why}／${autoCompletion.learnHint}`;
      }
    }
    /**
     * ★ 2026-11-16「精度上げる部分も強化／統括ちゃんと連携」:
     *   精度レバーを課題に載せる。一連の先頭（拡張再読込・自動1回）と矛盾しない。
     */
    {
      for (const pt of precisionLeversToTasks(precisionLevers)) {
        if (tasks.some((t) => t.kind === pt.kind && (
          t.what.slice(0, 18) === pt.what.slice(0, 18)
          || (pt.kind === "need_ext_reload" || pt.kind === "need_auto_run" || pt.kind === "verify_improve")
        ))) {
          // 既存の一連課題に精度 why を足す
          const ex = tasks.find((t) => t.kind === pt.kind);
          if (ex && !/精度/.test(ex.why)) ex.why = `${ex.why}／${pt.why}`;
          continue;
        }
        if (pt.kind === "photo_learn" && tasks.some((t) => t.kind === "photo_learn")) {
          const pl = tasks.find((t) => t.kind === "photo_learn")!;
          if (!/精度/.test(pl.why)) pl.why = `${pl.why}／${pt.why}`;
          if (!/精度/.test(pl.what)) pl.what = pl.what.includes("細かく") ? pl.what : `精度↑ ${pl.what}`;
          continue;
        }
        tasks.push({
          kind: pt.kind,
          what: pt.what,
          why: pt.why,
          cost: pt.cost,
        });
      }
    }
    /**
     * ★ 2026-11-18 竹内さん「学習ちゃんと画像読み取って連続してよみとって一連の流れを理解して学習して改善して強化する」:
     *   ランの末尾だけ読んで途中（所在地・条件・検索・結果）が切れていたら order=sequence を課題へ載せる。
     */
    if (m.imageFlows && m.imageFlows.total_runs > 0) {
      const imf = m.imageFlows;
      const runs = (imf.unlearned_runs || []).filter((u) => u.total >= 5);
      const normRun = runs.find((u) => u.mode === "normal" && u.pct < 50);
      const anyRun = normRun || runs.find((u) => u.pct < 50) || runs[0] || null;
      const needSeq = imf.learned_with_scene < 5 || imf.seq_learned_runs === 0 || !!normRun || imf.screens.result === 0;
      if (needSeq && anyRun) {
        const existingPl = tasks.find((t) => t.kind === "photo_learn");
        const seqWhy = `連続ラン ${anyRun.run_id}(${anyRun.mode} ${anyRun.learned}/${anyRun.total}枚=${anyRun.pct}%・欠:${anyRun.missing_scenes.join(",") || "なし"})／scene付き=${imf.learned_with_scene}`;
        if (existingPl && !existingPl.fields?.length) {
          existingPl.order = "sequence";
          existingPl.runId = anyRun.run_id;
          if (!/連続/.test(existingPl.what)) {
            existingPl.what = `連続ラン ${anyRun.run_id} を先頭→末尾で連続読み取りし、一連の流れを学ぶ`;
          }
          existingPl.why = `${seqWhy}／${existingPl.why}`;
        } else if (!existingPl || (normRun && existingPl.order !== "sequence")) {
          const limSeq = photoLearnLimitFor({ todo: Math.min(40, Math.max(12, anyRun.total)), fieldCount: 6 });
          tasks.push({
            kind: "photo_learn",
            what: `連続ラン ${anyRun.run_id} を先頭→末尾で連続読み取りし、一連の流れ（場面・遷移・詰まり）を学ぶ`,
            why: seqWhy,
            cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
            limit: limSeq,
            order: "sequence",
            runId: anyRun.run_id,
          });
        }
      }
    }

    /**
     * ★ 2026-11-16「統括じたいの学習能力も上げる」:
     *   仕組みを課題の why／土台に効かせてから並べる（表示だけの証拠にしない）。
     */
    {
      const mech = applyLearnedMechanismsToTasks(tasks, {
        togglesOff: m.toggles?.off ?? 0,
        togglesOn: m.toggles?.on ?? 0,
        togglesUnknown: m.toggles?.unknown ?? 0,
      });
      tasks.length = 0;
      tasks.push(...mech);
    }
    /**
     * 優先: 改善一連の人手（拡張再読込・自動1回）→ 反映確認 → 場面 → 写真。
     *   ⚠ 段階4で止まっている時に photo_learn を先頭にしない。
     *   ★ 例外: 課題欄が束に無い（missing）時は photo_learn が先（更新してから拡張へ）。
     */
    const bn = m.improveLoop?.bottleneck_n ?? null;
    const hasMiss = (m.challengeMissingInBundle || []).length > 0;
    const rank: Record<string, number> = {
      need_ext_reload: hasMiss ? 0 : -3,
      need_auto_run: -2,
      reflect_auto: -1,
      verify_improve: -0.5,
      fix_scene: 0,
      build_foundation: 0.5,
      need_human: 1,
      fix_record: 2,
      photo_learn: hasMiss ? -4 : ((bn != null && bn >= 4) ? 5 : 3),
    };
    tasks.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
    // 同じ kind の重複を落とす
    const seenKind = new Set<string>();
    const dedup = tasks.filter((t) => {
      const k = t.kind + "|" + t.what.slice(0, 40);
      if (seenKind.has(k)) return false;
      seenKind.add(k);
      return true;
    });
    tasks.length = 0;
    tasks.push(...dedup);
    /**
     * ★ 2026-11-18: 抜け止め関所（未学習・solid消失・自動0でも課題が空にならない）
     */
    {
      const sealed = ensureGaplessLearnTasks({
        tasks,
        unreadNormal: m.shotGapsNormal?.todo ?? m.shotGaps?.todo ?? 0,
        weakFields: fineStatuses.length ? weakDetailFields(fineStatuses) : [],
        kindConflictFields: [],
        screenSolid: m.bundleReflect?.screen_solid ?? null,
        readCount: m.bundleReflect?.read_count ?? null,
        autoAfter: m.bundleReflect?.auto_after ?? null,
        reflectOk: null,
        bottleneckN: bn,
      });
      tasks.length = 0;
      tasks.push(...sealed);
    }
    if (tasks.length) {
      const decideOf = (k: string) => {
        if (k === "need_ext_reload") return "拡張を再読み込み→コンソールで連携完了→reflect で確かめる（推奨）";
        if (k === "need_auto_run") return "自動モードで1回検索して効果を数字で見る（推奨）";
        if (k === "verify_improve") return "最新自動の課題欄が減ったか確かめる";
        if (k === "photo_learn") {
          const f0 = tasks.find((t) => t.kind === "photo_learn");
          const hasSel = (f0?.fields || []).some(isKnownSelectField);
          return hasSel
            ? "通常画像で位置・押し方を学ぶ（既知selectはVisionのtextで上書きしない）／一連の手前を先にやるか"
            : "通常モードの画像を読む（費用）／一連の手前を先にやるか";
        }
        if (k === "reflect_auto") return "反映（束→拡張→自動）を確かめる（推奨）";
        if (k === "build_foundation") return "足りない土台をそろえてから再現する（推奨・循環）";
        return `${tasks[0].what} から進めるか`;
      };
      agenda.push({
        priority: 1,
        topic: "次に学ぶ事（統括が決めた順・改善までの一連）",
        why: tasks.map((t, i) => `${i + 1}. ${t.what}（${t.cost}）`).join(" / "),
        decide: decideOf(tasks[0].kind),
      });
    }
    /**
     * ⚠ 課題そのものは**会議の結果に載せる**（議題の文だけだと、実行する側が
     *   「何を・どの順で・いくらで」を取り出せない）。`supervisor-do` がこれを読んで実行する。
     */
    learning_tasks = tasks;
  }

  /**
   * ★ 2026-11-18 竹内さん「統括も作業員増やすの判断できるように」:
   *   課題量・並列レーンから推奨人数を evidence／課題（scale_workers）／議題に載せる。
   *   ⚠ 勝手に Cursor 作業員は起動しない（supervisor-do は人数だけ返す）。
   */
  {
    const unreadNormal = m.shotGapsNormal?.todo ?? m.shotGaps?.todo ?? 0;
    const foundationGapsN = (() => {
      let n = 0;
      const h = m.humanLike;
      if (h && h.ops > 0) {
        if (h.changedWithoutClick > 0) n++;
        if (h.rows > 0 && Math.round((h.withCursor / h.rows) * 100) < 70) n++;
        if (h.rows > 0 && Math.round((h.withPoint / h.rows) * 100) < 50) n++;
        if ((h.handCursorClicks ?? 0) === 0 && h.ops >= 20) n++;
      }
      if (m.bundleReflect && (m.bundleReflect.read_count ?? 0) <= 0 && (m.bundleReflect.screen_solid ?? 0) >= 3) n++;
      return n;
    })();
    const sitesParallel = countSitesParallel(m.siteCounts);
    const reloadOnlyBottleneck = learning_tasks.length <= 1
      && (learning_tasks[0]?.kind === "need_ext_reload"
        || m.improveLoop?.next_kind === "need_ext_reload"
        || (learning_tasks.length === 0 && m.improveLoop?.bottleneck_n === 4));
    const ws = recommendWorkerScale({
      weakN: m.weakN,
      unreadNormal,
      learningTasksN: learning_tasks.length,
      foundationGapsN,
      sitesParallel,
      currentWorkers: 1,
      reloadOnlyBottleneck,
    });
    evidence.push({
      label: "作業員の規模",
      value: `推奨${ws.recommend}人（並列≈${ws.parallelizable}・上限${ws.cap}）／${ws.why}`,
      guessed: false,
    });
    if (ws.recommend >= 2) {
      if (!learning_tasks.some((t) => t.kind === "scale_workers")) {
        learning_tasks.push({
          kind: "scale_workers",
          what: `Cursor作業員を最大${ws.recommend}人に増やす（並列≈${ws.parallelizable}）`,
          why: ws.why,
          cost: "無料",
          limit: ws.recommend,
        });
      }
      agenda.push({
        priority: 2,
        topic: "作業員を増やすか",
        why: ws.why,
        decide: `${ws.recommend}人まで増やして並列で進めるか（上限${ws.cap}・実行は竹内さん判断）`,
      });
    }
  }
  /**
   * ★ 2026-11-20 決まり「順番は無料で効く物が先・お金がかかる物は後ろ」（統括の順番の最後の並べ替え）:
   *   費用ありの課題（Vision 等）は最後へ。無料どうしの順は変えない（土台→止まる場面 の順を守る）。
   */
  {
    const paid = (t: { cost?: string }) => /費用|Vision/.test(t.cost || "");
    const free = learning_tasks.filter((t) => !paid(t));
    const pay = learning_tasks.filter((t) => paid(t));
    learning_tasks = [...free, ...pay];
  }

  // ── 竹内さんに聞く事 ──
  if (m.rows > 0 && m.withOps / m.rows < 0.3) {
    const opsPct = Math.round((m.withOps / Math.max(1, m.rows)) * 100);
    /**
     * ⚠ 写真の割合は**実データ**から出す（旧は「99%」を決め打ちしていた）。
     *   写真がある記録の数が渡されていればそれを使い、無ければ「写真はほとんど撮れている」とだけ言う。
     */
    const shotPct = m.shotRows != null && m.rows > 0 ? Math.round((m.shotRows / m.rows) * 100) : null;
    /**
     * 2026-11-14 竹内さん「必要な部分を統括が判断して学習すれば強化される」:
     *   ⚠ 旧の選択肢は「まず録画の経路を直す」「写真から読む仕組みを先に作る」だった。
     *     だが**写真から読む仕組みはもう作った**（`shot_learn_server`。作ってあるのに
     *     呼ぶ所が0箇所だったのを繋いだ）。だから選択肢が古い。
     *   → 統括が**自分で判断して走らせられる**形にする:
     *     「弱い所の写真だけ読む（費用は1枚ごと）」を第一の選択肢にする。
     *     `photo_learn` を action に載せ、`supervisor-do` がそのまま実行できるようにする。
     */
    const todoN = m.shotGapsNormal?.todo || m.shotGaps?.todo || 0;
    const learnedN = m.shotGapsNormal?.learnedOk ?? m.shotGaps?.learnedOk ?? 0;
    questions.push({
      q: todoN > 0
        ? `通常モードの読める未学習写真が${todoN}枚あります（学べ済み${learnedN}枚）。弱い所の強化のために読みますか？`
        : shotPct != null
          ? `写真は${shotPct}%撮れているのに、操作が付いているのは${opsPct}%だけです。弱い所の写真だけ読みますか？`
          : `写真から学べているのは${opsPct}%だけです。弱い所の写真だけ読みますか？`,
      options: ["通常モードの画像を読んで弱い所を強化する（推奨・1枚ごとに費用）", "まず録画の経路を直す", "今のままでよい"],
      why: todoN > 0
        ? `通常モードの画像はあるのに未学習が残っている（弱い所 ${m.weakN}件・画像を読めば学習できる）`
        : "写真は撮れているのに、操作の並びが薄い記録がある",
    });
  }
  if (m.opens > 0 && m.guessedOpens >= m.opens) {
    questions.push({
      q: "「押したら何が開くか」が全部推測です。点数に入れてよいですか？",
      options: ["実測だけを点にする（推奨）", "推測も半分の点にする", "推測でも今のままでよい"],
      why: "推測を実測と同じ重さにすると、実際には学べていないのに高得点になる",
    });
  }
  if (siteKeys.length === 1 && m.site === "all") {
    questions.push({
      q: `${siteKeys[0]} だけで、もう片方のサイトの記録がありません。どうしますか？`,
      options: ["もう片方も運用する", "片方だけを対象にする（推奨）", "様子を見る"],
      why: "サイトごとに手順が違うので、片方の学びをもう片方で使うと誤適用になる",
    });
  }
  if (!questions.length && m.actions.length) {
    questions.push({
      q: "次に直すのは「" + m.actions[0].what + "」でよいですか？",
      options: ["それで進める（推奨）", "別の物を先に"],
      why: m.actions[0].why || "",
    });
  }

  /**
   * ★ 2026-11-16「統括の学習力も強化／仕組みで強化していく形」:
   *   仕組みを次手に効かせているかを点数化し、今日の結論と根拠に出す。
   *   表示だけの仕組み理解では点を上げない。
   */
  {
    const pl = learning_tasks.find((t) => t.kind === "photo_learn");
    const hasSelectFields = !!(pl?.fields || []).some(isKnownSelectField);
    const weakFsPower = fineStatuses.length ? weakDetailFields(fineStatuses) : [];
    const hasImproveForWeak = learning_tasks.some((t) =>
      t && (t.kind === "photo_learn" || t.kind === "build_foundation" || t.kind === "need_human"
        || t.kind === "fix_scene" || t.kind === "verify_improve" || /細部|細かく|弱い/.test(t.what + t.why)),
    );
    const weakThenImproveOk = weakFsPower.length === 0
      || (hasImproveForWeak && agenda.some((a) => /弱い部分を細部|細部まで改善|人間のように動けて/.test(a.topic)));
    const power = supervisorLearnPower({
      mechanismsInEvidence: evidence.some((e) => e.label.includes("学習の仕組み")),
      photoLearnUsesSelectMech: !hasSelectFields
        || !!(pl && /操作のselect|selectをVision|位置・押し方|細かく学ぶ|精度/.test(pl.why + pl.what)),
      hasFineLearnEvidence: evidence.some((e) => e.label.includes("細かく学ぶ")),
      toggleMechApplied: learning_tasks.some((t) => /was\/now|くれあ|区の外し|外し\/選び/.test(t.what + t.why))
        || ((m.toggles?.unknown ?? 0) <= 50 && (m.toggles?.off ?? 0) === 0),
      softCapWhenNotHuman: m.coverage <= 55
        || (typeof m.reproducePct === "number" && m.reproducePct >= 100)
        || !m.humanLike
        || (m.humanLike.ops > 0 && m.humanLike.changedWithoutClick === 0
          && (m.humanLike.rows > 0 ? m.humanLike.withCursor / m.humanLike.rows >= 0.7 : true)),
      precisionLinked: precisionLinkedOk && evidence.some((e) => e.label.includes("精度")),
      weakThenImproveApplied: weakThenImproveOk,
    });
    if (weakFsPower.length > 0 && !weakThenImproveOk) {
      agenda.push({
        priority: 0,
        topic: "弱い部分を見つけたが改善課題に載っていない",
        why: `弱い欄 ${weakFsPower.slice(0, 5).join("・")}（仕組み⑩違反）`,
        decide: "見つけた弱い部分を必ず photo_learn／土台／人手録画の課題にする",
      });
    }
    evidence.push({
      label: "統括の学習力（仕組み適用）",
      value: power.line + (autoCompletion ? `／完成度${autoCompletion.score}%を見て学習` : ""),
      guessed: power.score < 100,
    });
    today.push(power.line);
    const precEv = evidence.find((e) => e.label.includes("精度") && !e.label.includes("完成"));
    if (precEv) today.push(precEv.value.split("／").slice(0, 2).join("／"));
    if (power.score < 70) {
      agenda.push({
        priority: 1,
        topic: "統括の学習力が低い（仕組みが次手に効いていない）",
        why: power.missing.join("／") || power.line,
        decide: "欄×観点・精度と一連の連携を課題 why に必ず載せる",
      });
    }
    if (!precisionLinkedOk) {
      agenda.push({
        priority: 0,
        topic: "精度上げと一連の連携が切れている",
        why: "段階4〜5なのに精度レバーの先頭が photo_learn（学んでも現場に届かない）",
        decide: "拡張再読込／自動1回を先にし、そのあと欄×観点で精度を上げる",
      });
    }
  }

  /**
   * ★ 2026-11-16 竹内さん「画像学習の部分の連携もちゃんとできるように
   *   flashとproのまとめる部分で判断／細かい部分のつなぐのも徹底して細分化」:
   *   保存→flash読→材料→突合→photo_learn課題→Pro を1本の連携として根拠・議題に載せる。
   */
  /**
   * ★ 2026-11-17 統括Pro: `0 ?? 束` は 0 を正として落ちない。
   *   サイト別で shot_bytes 未配線の時も、通常抜け・shotRows・束の枚数の最大を使う。
   */
  const photoReach = Math.max(
    num(m.shotBytes?.in_storage),
    num(m.shotBytes?.n),
    num(m.bundleReflect?.photo_in_storage),
    num(m.shotGapsNormal?.total),
    num(m.shotGapsNormal?.learnedOk) + num(m.shotGapsNormal?.todo),
    num(m.shotGaps?.learnedOk) + num(m.shotGaps?.todo),
    num(m.shotRows),
  );
  const learnedOkN = m.shotGapsNormal?.learnedOk ?? m.shotGaps?.learnedOk ?? 0;
  const todoN = m.shotGapsNormal?.todo ?? m.shotGaps?.todo ?? 0;
  const photoKindsN = m.photoKinds
    ? Object.values(m.photoKinds).reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const vision_pro_link = buildVisionProLink({
    photoInStorage: photoReach,
    learnedOk: learnedOkN,
    todo: todoN,
    photoKindsN,
    imageFields: m.imageMatch?.imageFields ?? 0,
    withScreenPos: m.imageMatch?.withScreenPos ?? 0,
    matched: m.imageMatch?.matched ?? 0,
    hasPhotoLearnTask: learning_tasks.some((t) => t.kind === "photo_learn"),
    usedPro: null,
  });
  evidence.unshift({
    label: "画像学習→統括Pro連携",
    value: vision_pro_link.line,
    guessed: vision_pro_link.bottleneck_n != null,
  });
  evidence.unshift({
    label: "画像学習の役割（flash/Pro）",
    value: `読む=${vision_pro_link.roles.flash_model}／まとめる=${vision_pro_link.roles.pro_model}／関所=決定論。混ぜない`,
    guessed: false,
  });
  /**
   * ★ 2026-11-18 竹内さん「何が足りないか／どう強化・改善するか考える能力」:
   *   画像の細部穴（衝突・記録≠写真・中央固定位置）も含めて思考骨格を先に組む。
   */
  {
    const weakArr = Array.isArray(m.weak) ? m.weak : [];
    const planItems = Array.isArray(m.learnPlan?.items) ? m.learnPlan!.items! : [];
    const conflictFields = weakArr
      .filter((w) => String(w.kind || "") === "kind_conflict_in_photo")
      .map((w) => String(w.name || ""))
      .filter(Boolean);
    const vsOnly = planItems
      .filter((w) => String(w.kind || "") === "photo_vs_record")
      .map((w) => String(w.name || ""))
      .filter(Boolean);
    const vsFields = [...conflictFields, ...vsOnly];
    /** 画面位置ありでも 中央(0.5)ばかりは細部未達 — imageMatch に無ければ matched との差で近似 */
    const im = m.imageMatch as { withScreenPos?: number; matched?: number; centerOnlyPos?: number; solidPos?: number } | null | undefined;
    const centerOnly = num(im?.centerOnlyPos)
      || (num(im?.withScreenPos) > 0 && num(im?.matched) === 0 ? num(im?.withScreenPos) : 0);
    const solidPos = num(im?.solidPos) || num(im?.matched);
    const think = buildProThinkCapability({
      visionBottleneckN: vision_pro_link.bottleneck_n,
      visionLine: vision_pro_link.line,
      photoInStorage: photoReach,
      learnedOk: learnedOkN,
      todo: todoN,
      photoKindsN,
      withScreenPos: m.imageMatch?.withScreenPos ?? 0,
      matched: m.imageMatch?.matched ?? 0,
      hasPhotoLearnTask: learning_tasks.some((t) => t.kind === "photo_learn"),
      centerOnlyPosN: centerOnly || null,
      solidPosN: solidPos || null,
      kindConflictN: conflictFields.length || null,
      kindConflictFields: conflictFields.slice(0, 12),
      photoVsRecordN: vsOnly.length || null,
      photoVsRecordFields: (vsOnly.length ? vsOnly : vsFields).slice(0, 12),
      readCount: null,
      autoAfter: null,
      foundationMissingN: null,
      oneRecBottleneck: null,
    });
    evidence.unshift({
      label: "画像学習はちゃんと行ったか",
      value: think.image_learn.line
        + (think.image_learn.gaps[0] ? `／穴: ${think.image_learn.gaps.slice(0, 3).join("・")}` : ""),
      guessed: think.image_learn.done !== true,
    });
    evidence.unshift({
      label: "統括Pro思考骨格（足りない→強化→改善）",
      value: think.line + "／" + think.scaffold,
      guessed: think.missing.length > 0,
    });
    if (think.fine_atoms.length) {
      evidence.unshift({
        label: "画像の細かい強化原子",
        value: think.fine_atoms.slice(0, 8).map((a) => `${a.field}[${a.facet}]: ${a.next}`).join("／"),
        guessed: true,
      });
    }
    /** ★ 改善する仕組みを構築し、自動へ反映する志向 */
    const acqHint = buildAcquireGraspReport({
      auditStatus: (m as { lastAuditStatus?: string }).lastAuditStatus || null,
      searchArmed: (m as { lastSearchArmed?: boolean }).lastSearchArmed ?? null,
      fillDone: (m as { lastFillDone?: boolean }).lastFillDone ?? null,
      acquireStarted: (m as { lastPropertyAcquire?: boolean }).lastPropertyAcquire ?? null,
      sentSkipped: (m as { lastSentSkipped?: number }).lastSentSkipped ?? null,
      sentMarked: (m as { lastSentMarked?: number }).lastSentMarked ?? null,
    });
    const construct = buildImproveConstruct({
      learnedOk: learnedOkN,
      photoTodo: todoN,
      hasPhotoLearnTask: learning_tasks.some((t) => t.kind === "photo_learn"),
      readCount: null,
      autoAfter: null,
      reflectOk: null,
      foundationMissingN: null,
      thinkMissingN: think.missing.length,
      acquireArmed: acqHint.phases_ok.includes("armed") ? true : (acqHint.stuck_before_acquire ? false : null),
      acquireSentGrasped: acqHint.sent_grasped,
      stuckBeforeAcquire: acqHint.stuck_before_acquire,
      mechanismApplied: true,
    });
    evidence.unshift({
      label: "統括Proの志向（改善構築→自動反映）",
      value: construct.orientations.slice(0, 4).map((o) => o.aim).join("／"),
      guessed: false,
    });
    evidence.unshift({
      label: "改善する仕組みの構築",
      value: construct.line + "／" + construct.scaffold,
      guessed: construct.gaps.length > 0,
    });
    evidence.unshift({
      label: "次の構築手→自動反映",
      value: construct.next_construct + " → " + construct.next_reflect + "／" + construct.path_line,
      guessed: construct.gaps.length > 0,
    });
    if (construct.gaps.length) {
      agenda.push({
        priority: 0,
        topic: "改善する仕組みを構築し自動へ反映する",
        why: construct.gaps.slice(0, 3).map((g) => g.what).join("／"),
        decide: [construct.next_construct, construct.next_reflect, construct.path_line].filter(Boolean).join(" → "),
      });
    }
    if (think.missing.length) {
      agenda.push({
        priority: 0,
        topic: "統括Proが足りない所→強化→改善を考える",
        why: think.missing.slice(0, 4).map((x) => x.what).join("／"),
        decide: [
          ...think.strengthen.slice(0, 2).map((h) => h.how),
          ...think.improve.slice(0, 2).map((h) => h.how),
        ].filter(Boolean).join(" → ") || think.scaffold,
      });
    }
    if (think.image_learn.done !== true) {
      agenda.push({
        priority: 0,
        topic: "画像学習の細部を徹底強化する",
        why: think.image_learn.line,
        decide: think.strengthen.filter((h) => h.cost === "flash" || h.for_missing.startsWith("kind") || h.for_missing === "pos_detail" || h.for_missing === "photo_learn_task")
          .slice(0, 3)
          .map((h) => h.how)
          .join("／") || "衝突欄・位置観点・photo_learn を細かく回す",
      });
    }
  }
  /**
   * ★ 2026-11-16: 弱点を原子に細分化して Pro に渡す（仕組み⑯）。
   *   根拠が揃ってから作る（この直後の evidence を使う）。
   */
  {
    const weakAtoms = atomsFromEvidence(evidence);
    if (weakAtoms.length) {
      evidence.unshift({
        label: "弱点の細分化（原子）",
        value: atomsLine(weakAtoms),
        guessed: weakAtoms.some((a) => (a.score != null && a.need != null && a.score < a.need) || a.layer === "human"),
      });
      const top = weakAtoms.filter((a) => a.next !== "維持").slice(0, 4);
      if (top.length) {
        agenda.push({
          priority: 0,
          topic: "弱点原子を画像分析→Pro判断で細かく直す",
          why: top.map((a) => a.name).join("・"),
          decide: top.map((a) => `${a.name}: ${a.next}`).join("／"),
        });
      }
    }
  }
  if (vision_pro_link.bottleneck) {
    agenda.push({
      priority: 0,
      topic: "画像学習→統括Proの連携が止まっている",
      why: vision_pro_link.bottleneck,
      decide: vision_pro_link.bottleneck_n === 5
        ? "未学習があるのに photo_learn が無い → 課題に載せる（flashが読む）"
        : vision_pro_link.bottleneck_n != null && vision_pro_link.bottleneck_n <= 2
          ? "写真を保存し flash（photo_learn）で読む"
          : "材料（種類・位置・突合）が統括に届くよう束を更新してから Pro に渡す",
    });
  }

  {
    const matD = materialsDays();
    const fineAvg = fineStatuses.length
      ? Math.round(fineStatuses.reduce((s, x) => s + x.score, 0) / fineStatuses.length)
      : null;
    const periodConstruct = buildLearnPeriodConstruct({
      used: {
        daysOps: matD,
        daysAudit: matD,
        shotLearnDays: matD,
        auditWindowMs: LEARN_PERIODS.materialsMs,
        logMemoryDays: logMemoryDays(),
        commandsDays: Math.round(LEARN_PERIODS.commandsMs / DAY_MS),
      },
      screenSolid: m.foundationAudit?.screen_solid ?? m.bundleReflect?.screen_solid,
      photoLearnTask: learning_tasks.some((t) => t.kind === "photo_learn"),
      unreadNormal: m.shotGapsNormal?.todo,
      autoAfter: m.bundleReflect?.auto_after,
      readCount: m.bundleReflect?.read_count,
      fineLearnAvg: fineAvg,
    });
    evidence.unshift({
      label: "学習期間・構築の細部",
      value: periodConstruct.line + (periodConstruct.gaps.length ? `／${periodConstruct.next_line}` : ""),
      guessed: periodConstruct.gaps.length > 0 || periodConstruct.construct_marks.some((x) => !x.ok),
    });

    /**
     * ★ 2026-11-18 竹内さん「学習期間／土台とつながりと一連の動きを完成させる／統括Pro」:
     *   4本柱（期間・土台・つながり・一連）を完成線として毎回測り、止まった柱を議題にする。
     */
    const keyFailIds = (m.foundationAudit?.missing || [])
      .map((x) => String(x.id || ""))
      .filter((id) =>
        /F1_|F6_|F31_|F32_|F33_|F34_|F37_|F38_|F43_|F54_|F55_/.test(id),
      );
    const complete = buildLearnCompleteChain({
      period: {
        used: {
          daysOps: matD,
          daysAudit: matD,
          shotLearnDays: matD,
          auditWindowMs: LEARN_PERIODS.materialsMs,
          logMemoryDays: logMemoryDays(),
          commandsDays: Math.round(LEARN_PERIODS.commandsMs / DAY_MS),
        },
        screenSolid: m.foundationAudit?.screen_solid ?? m.bundleReflect?.screen_solid,
        photoLearnTask: learning_tasks.some((t) => t.kind === "photo_learn"),
        unreadNormal: m.shotGapsNormal?.todo,
        autoAfter: m.bundleReflect?.auto_after,
        readCount: m.bundleReflect?.read_count,
        fineLearnAvg: fineAvg,
      },
      foundationMissingN: m.foundationAudit?.missing_n ?? null,
      foundationOkN: m.foundationAudit?.ok_n ?? null,
      foundationTotalN: m.foundationAudit?.total ?? null,
      keyFoundationFails: keyFailIds,
      linkBottleneckN: (() => {
        const bn = m.bundleReflect?.bottleneck;
        if (!bn) return null;
        const m2 = String(bn).match(/段階\s*(\d+)/);
        return m2 ? Number(m2[1]) : 1;
      })(),
      linkLine: m.bundleReflect?.bottleneck || m.bundleReflect?.line || null,
      readCount: m.bundleReflect?.read_count ?? null,
      autoAfter: m.bundleReflect?.auto_after ?? null,
      screenSolid: m.foundationAudit?.screen_solid ?? m.bundleReflect?.screen_solid ?? null,
      improveBottleneckN: m.improveLoop?.bottleneck_n ?? null,
      improveLine: m.improveLoop?.improve_line ?? null,
    });
    evidence.unshift({
      label: "学習完成（期間・土台・つながり・一連）",
      value: complete.line + (complete.ok ? "" : `／次=${complete.next_line}`),
      guessed: !complete.ok,
    });
    evidence.unshift({
      label: "学習完成の道筋",
      value: complete.path_to_complete,
      guessed: !complete.ok,
    });
    for (const p of complete.pillars) {
      evidence.push({
        label: `学習完成・${p.name}`,
        value: `${p.ok ? "✓" : "✗"} ${p.line}${p.ok ? "" : `／次=${p.next}`}`,
        guessed: !p.ok,
      });
    }
    if (!complete.ok && complete.bottleneck) {
      agenda.push({
        priority: 0,
        topic: "学習期間・土台・つながり・一連を完成させる",
        why: complete.bottleneck,
        decide: complete.path_to_complete,
      });
    }
  }

  agenda.sort((a, b) => a.priority - b.priority);
  return {
    today,
    agenda: agenda.slice(0, 8),
    questions: questions.slice(0, 4),
    evidence,
    learning_tasks,
    vision_pro_link,
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * ★ 2026-11-20 竹内さん「反映の流れ」（承認済み）: 判断する束の読まれ数。
 *   新しい束（judged_read_count）を優先し、無ければ従来の read_count（古い行の値）。
 *   ⚠ bundle_reflect.read_count は作った時点の**前の束**の値なので、判定にはそのまま使わない。
 */
export function judgedReadCount(br: { read_count?: number; judged_read_count?: number } | null | undefined): number {
  if (!br) return 0;
  const j = br.judged_read_count;
  if (typeof j === "number" && Number.isFinite(j)) return Math.max(0, j);
  return num(br.read_count);
}
