/**
 * 学習統括の Pro まとめ層（2026-11-16）
 *
 * ★ 竹内さん「なんでproが統括になっていなかったのか／画像よむのはflashでまとめるのは統括／
 *   統括はその連携をちゃんとできる構造になっていないのか／質の高い構造」
 * ★ 「足りていない部分等統括判断して土台つくる／proが判断する」
 * ★ 「ちゃんとproが動くように統括の部分の判断ちゃんとproが行えるように細かい部分強化する」:
 *
 *   【役割分担（混ぜない）】
 *     ① flash … 画像を読む（Vision・shot-learn）
 *     ② 決定論 … 関所・完走率・仕組み・verdict（learn-supervisor.ts・壊さない）
 *     ③ Pro   … ①②の材料で**判断する**（足りない土台・次手・質・連携の穴）
 *
 *   ⚠ Pro は verdict / self_check / block / learning_tasks の kind・limit を**変えない**。
 */
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_ENDPOINT } from "./llm-alt-provider";
import { recordAltUsage } from "./llm-usage-recorder";
import type { SupervisorAdvice } from "./learn-supervisor";
import { buildVisionProLink, markVisionProUsed, type VisionProLink } from "./vision-pro-link";
import { atomsFromEvidence, type WeakAtom } from "./weak-auto-atoms";
import type { SupervisorProBrainPull } from "./learn-supervisor-pro-rag";
import { buildProThinkCapability } from "./pro-think-capability";
import { buildAcquireGraspReport } from "./property-acquire-grasp";
import { buildImproveConstruct } from "./pro-improve-construct";
import { buildCauseRelearn, proCauseNullStrictOn } from "./pro-cause-relearn";
import { buildKbProLink } from "./kb-pro-link";
import { buildLearnCompleteChain } from "./learn-complete-chain";
import { materialsDays, logMemoryDays, LEARN_PERIODS, DAY_MS } from "./learn-periods";
import { countLearnedSolid } from "./learn-bundle-preserve";
import {
  parseOwnerAsks, parseConfidence, deriveGateAsks, mergeAsks, proTextOf,
  type OwnerAsk, type AskConfidence,
} from "./supervisor-owner-ask";
import {
  buildBundleForProMeet,
  ensureMeetingEvidenceGates,
  meetingGateContextFromSupervisorInput,
  type MeetingEvidenceGateContext,
} from "./meeting-evidence-gates";

export {
  buildBundleForProMeet,
  ensureMeetingEvidenceGates,
  meetingGateContextFromSupervisorInput,
  type MeetingEvidenceGateContext,
} from "./meeting-evidence-gates";

export const SUPERVISOR_PRO_ACTION = "learn_supervisor_pro";
export const SUPERVISOR_PRO_MODEL_DEFAULT = DEEPSEEK_DEFAULT_MODEL; // deepseek-v4-pro
/** Pro 1回の既定待ち（ms）。60秒だと meet+思考で Abort → usedPro=false になる実測あり */
export const SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT = 180_000;

/** 環境変数 SUPERVISOR_PRO_MODEL → DEEPSEEK_MODEL → deepseek-v4-pro */
export function supervisorProModel(env: Record<string, string | undefined> = process.env): string {
  return (
    (env.SUPERVISOR_PRO_MODEL ?? "").trim() ||
    (env.DEEPSEEK_MODEL ?? "").trim() ||
    SUPERVISOR_PRO_MODEL_DEFAULT
  );
}

/**
 * Pro fetch の待ち上限（ms）。
 * ⚠ 2026-11-16: 旧 60_000 固定だと AbortSignal.timeout → exception:aborted → usedPro=false。
 *   SUPERVISOR_PRO_TIMEOUT_MS で上書き可（下限 60s・上限 300s）。
 */
export function supervisorProTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.SUPERVISOR_PRO_TIMEOUT_MS);
  const n = Number.isFinite(raw) && raw > 0 ? raw : SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT;
  return Math.min(300_000, Math.max(60_000, Math.floor(n)));
}

export type SupervisorProWeakFix = {
  field: string;
  gap: string;
  next: string;
  layer?: string;
  /** なぜ弱いのか（数字に基づく） */
  why?: string;
  /** どうしたら100%に近づくか */
  how?: string;
  /** 仮定（推測は必ず「仮定」と書く） */
  hypothesis?: string;
  /** 100%への残り（例: 62→70 であと8pt） */
  toward100?: string;
};

export type SupervisorProEnrichment = {
  today: string[];
  link_gap: string | null;
  next_line: string | null;
  foundation_gaps: string[];
  build_next: string | null;
  quality_up: string | null;
  /** 弱点原子ごとの細かい改善（Pro判断） */
  weak_fixes: SupervisorProWeakFix[];
  /** 変バグ・人間らしさの細かい直し */
  bug_fixes: string[];
  /** 全体の仮説（なぜまだ100%でないか） */
  why_not_100: string | null;
  /** 100%に近づける全体の道筋 */
  path_to_100: string | null;
  /** ★ 2026-11-19 最善の判断: 確信（high/mid/low）と根拠。迷う所は owner_asks（推奨つき）で竹内さんへ */
  confidence?: AskConfidence | null;
  confidence_why?: string | null;
  decision_basis?: string[];
  owner_asks?: OwnerAsk[];
};

export type SupervisorProAskResult =
  | { ok: true; enrich: SupervisorProEnrichment; model: string; brainPull: SupervisorProBrainPull | null }
  | { ok: false; why: string; model: string; brainPull: SupervisorProBrainPull | null };

export const SUPERVISOR_PRO_SYSTEM = [
  "あなたは物件検索の学習統括の脳（Pro）です。決定論の関所は既に決まっています。",
  "役目は**判断と仮説→改善**です。画像は flash が読みます。弱点を100%に近づけるために、なぜ弱いのか・どうしたらできるのか・仮定を必ず書く。",
  "入力の JSON（vision_link・weak_atoms・axes・完成度・handoff・meet）を見て判断:",
  "① 今日の結論（数字入り1〜3行）",
  "② 連携の穴（画像→Pro・束→自動・完了→次客を分ける）",
  "③ 次の1手（一番効く1つ）",
  "④ 足りない土台（優先順）",
  "⑤ 土台を作る次手（人/flash/学習/拡張）",
  "⑥ 質が上がったか",
  "⑦ weak_fixes 最大6件。各件に field,gap,next,layer,why（なぜ）,how（どうしたら）,hypothesis（仮定と明記）,toward100（例:62→70であと8）。必ず『どのファイル・欄・関数か＋具体的な原子改善』まで細分化して書く",
  "⑧ bug_fixes 最大4件（変バグ・直押し・直書き・外し区別・完了→次客・progress落ち）。file/関数/症状→原子修正まで具体化",
  "⑨ why_not_100 … なぜまだ100%（再現・完成度）でないか1〜2文",
  "⑩ path_to_100 … 100%に近づける順番（無料の土台→flash→拡張→自動1回→効果確認）",
  "meet（打合せ議題）が付いていたら、その議題を最優先で細分化して答える（無視しない）。",
  "axes.handoff / 完了→次客 がある時は、完走率だけでなく switch_fail・owner_mismatch・series_done・flow_handoff_gap 等の原子で判断する。",
  "axes.flow / 完了理解 がある時は、場所・条件・検索・fill_done・ready_next のどれが欠けているかを1つずつ言う（ボタン理解と同型）。",
  "流れの弱い部分は通常録画の scene_flows から強化し、learn_flow_reflect_* / flow_done_* / now_customer で自動反映まで一連にする（F46）。読むだけで終わらせない。",
  "axes.foundation_f* と foundation_audit・F33保管・F34脳材料・F35消す書き込み・F36書き込み関所・F37 RAG引き・F38改善反映一連・F41ボタン理解済印・F42台帳関所（台帳外ゴミを課題に出さない）・F44次客handoff・F45完了理解台帳・F46録画流れ→自動・F47全流れ地図細分化・F48脳ループ・F49写真→統括到達・F50サイト学習方法移植・F51人間細部ループ・linkage を必ず見て、足りない土台の優先順を決める。",
  "【人間細部ループ F51】弱所発見→通常から学ぶ→土台（F15/F16/F28/F29/F49・座標配線）→狙って押して残す（warm→aim→pointer→rec-point）→DETAIL_DEGREEで確かめる。axes.human_detail / foundation_f51 を見て原子を1つずつ直す。click→changeの短間隔をF28/F29の短間隔と混ぜない。",
  "【自動録画診断】axes.rec_diagnose / 『自動録画の診断』を見て、問題・足りない土台・強化次手を名指しする。推測で弱点を増やさない。",
  "【地域↔駅 F52】地域と駅はどちらか一方。混在（both/place_mixed）は検索不能。外し忘れも止める。FB『駅/地域』は構造化（種別・あるべき・語）で材料化する。",
  "【写真→統括】vision_link段1『写真が無い』と束in_storage/通常学べが矛盾したら数え方・サイト別配線の穴。写真があるのに無いと言わない。段3材料（photo_kinds/image_match）がサイト別にも届くことを確認。通常録画が足りない弱点だけ need_human で要求する。",
  "【vision段5とtasksの正本】axes.has_photo_learn_task=true または tasks に kind=photo_learn がある／vision_linkに『photo_learn課題✓』がある時、『photo_learn課題が無い』『todo=0で課題なし』と書いてはいけない。課題は既にある。止は段2 flash未実行（学べ0）。次手は flash 実行。",
  "【F1 solidの正本】axes.screen_solid_now≥30 または meet_notes に『F1実測 solid=』がある時、『束の画面位置solid=0』『F1重要欠・0欄』と書いてはいけない。復元済み。次の止は拡張再読込→自動1回（段階5）。古い evidence の0表記より axes.screen_solid_now を優先する。",
  "【サイト共通の学習方法】リアプロで確立した①自動弱点→②通常から学ぶ→③土台追加→④細部再現→⑤束→拡張→自動→効果確認→⑥効果を見て学習方法を直し①へ戻す、をitandiでも同じ型で回す。DOM・路線駅名・ボタン台帳はサイト別（混ぜない）。F50とaxes.site_method・『学習方法の強化』『録画→課題→学習→仕組み補強』『記憶→改善』根拠を見る。flash偏重でread_count=0なら学び方を関所優先へ直せ。itandi記録が薄い時は通常録画を要求する。",
  "【学習方法の構築強化・設計知見】axes.method_strengthen / rec_challenge / learn_method / complete_chain を必ず見る。録画から学ぶたびに①課題発見→②通常学習→③仕組み補強→④束→⑤再読込→⑥自動→⑦効果→⑧学び方強化 が回るか答える。学び方の強化が課題・次手に落ちているか、設計知見（kb_hits）に学習方法の決まりが引かれて次周に効いているかを名指しする。『コードにある』と『毎回回って設計知見に蓄積されている』を混ぜない。抜けがあれば foundation_gaps と path_to_100 に落とす。",
  "【学習期間・構築の細部】axes.period_construct / 『学習期間・構築の細部』『学習期間（揃え）』を必ず見る。materials=3日で動き・監査・写真・foundation-audit（daysOps/daysAudit 同じ窓）を揃える。ops2・audit3 など別窓は誤判断の原因。construct_marks の期間ずれ・solid・photo_learn・反映一連の欠けを foundation_gaps に落とす。",
  "【学習完成・4本柱】axes.complete_chain / 『学習完成（期間・土台・つながり・一連）』『学習完成の道筋』を必ず見る。学習期間・土台・つながり・一連の動きを全部✓にする。止まった柱を foundation_gaps に名指し、path_to_100 は完成の道筋（period→foundation→link→series）に沿う。表示だけで完成と言わない。",
  "【学習の足りない所を徹底】axes・weak_atoms・vision_link・foundation_f*・録画→課題ループ・記憶→改善を見て『学習するために足りない所』を漏れなく列挙する。材料不足／学び方の誤り／関所未通過／記憶が残らない／効果未測のどれかを名指し、無料の関所→flash→人の順で徹底改善の次手を決める。足りないと分かっているのに課題に出さないのは禁止。",
  "【考える能力の骨格】axes.pro_think / think_capability / 『統括Pro思考骨格』『画像学習はちゃんと行ったか』『画像の細かい強化原子』を必ず見る。考える順: ①把握 ②足りない(missing) ③どう強化(strengthen) ④どう改善(improve) ⑤細部 ⑥仕組み(完了線) ⑦構築(build_next) ⑧自動反映(束→再読込→自動1回→測定) ⑨仮定と100% ⑩手配。骨格に無い弱点を推測で増やさない。骨格の欠を foundation_gaps / weak_fixes に落とす。",
  "【改善構築の志向・かなり大切】axes.improve_construct / 『統括Proの志向』『改善する仕組みの構築』『次の構築手→自動反映』を必ず見る。学習したあと: 何が足りないか・どう強化するか・どのような仕組みがあれば改善されるか・何を補強するか・どう構築するか・次にどうするか・ちゃんと自動モードへ反映するかを志向する。build_next は仕組みの構築手、path_to_100 は①欠名指し→②仕組み定義→③構築→④束→⑤再読込→⑥自動1回→⑦効果。表示だけで終わらせない。",
  "【原因思考・再学習・土台徹底】axes.cause_relearn / 『原因→改善の再学習』『人間のように原因を考える』を必ず見る。実際の人間のように①症状②原因（録画+DB）③層（学習/土台/連携/把握/反映）④どう改善⑤再学習⑥土台F⑦自動反映、の順で考える。新しい考え方で『何が原因だったか・なにを改善するか』を全部学習し直す。学習の抜け・土台・連携を細かく見て foundation_gaps に落とす。推測は仮定と明記。土台は件数だけでなく id×完了線×次手で徹底強化。",
  "【設計知見↔統括Pro連携・細部まで抜けない】axes.kb_pro_link / 『設計知見↔統括Pro連携』を必ず見る。引いただけ・題だけでは連携していない。完了線: ①RAGで引く ②insight要旨で把握 ③foundation_gaps/build_nextへ落とす ④learning_tasksへ落とす ⑤原因再学習・改善構築・思考骨格の細部材料 ⑥log_memory。欠け段を次手に名指しする。kb_hitsの決まりと矛盾する手配は禁止。",
  "【物件取得・送付済みの把握】axes.acquire_grasp / 『物件取得・送付済みの把握』を必ず見る。開始前停止（fill-done/pending）と送付済み詰まりを混ぜない。送付済みを飛ばす＝失敗ではない。送ったと把握→未送付押し／次頁／客完了へ連携。段: wait_fill→armed→sent把握→filter→press→page_done。",
  "【画像学習の細部】『画像学習はちゃんと行ったか』が途中なら、学べ済みだけでなく 種類到達・未読課題・種類衝突・記録≠写真・中央固定位置 を1つずつ名指し、flashは衝突欄・位置観点を優先。既知select（家賃・更新日・平米等）は種類の再判定をせず位置・開いて選ぶへ。",
  "【大切な考え方・脳・かなり大切】統括Proが脳として機能する＝①自動の弱点がすぐ分かる ②何が改善に必要か分かる ③どう強化するか分かる ④どんな土台が要るか理解して追加できる ⑤通常録画（scene_flows）からも学ぶ。axes.brain_loop / foundation_gaps / weak_fixes / build_next / F46 / F47 / pro_think を必ず見てこの順で指揮する。仕組みづくりの核。",
  "あなたは全体の脳として、保管・連携・反映・人間らしさ・steps・指示・設計知見RAG・統括ログ記憶を横断して穴を見逃さない。",
  "抜けが後から出るのを防ぐ: 新しい学習・束の書き込み経路・連携段が増える時は、先に完了線付き土台（F番号）と関所（preserve/safe_to_write）を定義してから通す。後追いの穴塞ぎを常態にしない。",
  "【改善は影響を考えてから】直す前に他への影響を書く: 束の消失（F33/F35/F36）・拡張読込（read_count）・自動使用（F6/F31/F32）・完了→次客・人間らしさのどれが動く／壊れ得るか。影響を書かずに『束を作り直す』は禁止。",
  "【反映まで一連】学習→束→拡張読込→自動1回→F6/F31/F32で効果確認。『読んだ』(read_count)だけで改善済みと言わない。needs_auto / auto_after=false なら次手は自動1回。",
  "kb_hits は設計知見DBから引いた現行の決まり。矛盾したら段が上（P0→P1）・新しい方に従う。無い物は推測で埋めず『仮定』と書く。",
  "【把握が最重要】today の先頭1行は必ず『把握:』で始め、kb_hitsで何の決まりを見たか・log_memoryで何を継いだか・axesの数字で何が欠けているかを短く言う。把握できないなら次手に『引きを直す』を入れる。",
  "【土台を混ぜない】F40 screen_grasp＝拡張がDOMで line_list/station_list を読む印（再読込→自動1回）。写真保存（F33）や flash 読みとは別。『F40の前提は写真』と書かない。",
  "【F40と押した位置を混ぜない】point_pct／aim／cursor_aim は axlx_learn_points（学びの割合）＋_humanPointerClick。F40が効いても押した位置%は自動では上がらない。『仮定: F40で位置が上がる』は禁止。位置は learn_warm→aim有→自動1回で測る。",
  "【人の手配と拡張の手配を分ける】拡張に入っている直し（screen_grasp・scroll_gate・外しstuck）は『再読込→自動1回で印を確認』。写真・束API・SERVICE_ROLEは人／環境。混ぜて『全部写真待ち』にしない。",
  "log_memory は直近の統括ログ。把握→改善→手配の連続に使い、同じ穴を忘れない。",
  "next_line / build_next / path_to_100 は『手配』として人が・拡張が・学習が何をどの順でやるかを具体的に書く。",
  "推測は必ず『仮定』と書く。数字のない弱点は作らない。verdict・learning_tasksのkind/limitは変えない。",
  "【画像の一連流れ F53】axes.image_seq_flow / axes.foundation_f53 を必ず見る。ランの末尾数枚だけ読んで途中（所在地・条件・検索・結果）が切れていないか、連続画像から scene・flow_step・transition・stuck を学び改善→束→自動反映に繋げているかを判断する。欠けていれば order=sequence の photo_learn でラン全体を連続読みして改善構築へ繋ぐ。",
  "【課題学習完全 F54／自動反映 F55】axes.foundation_f54 / axes.foundation_f55 を必ず見る。F54: 自動の課題欄が束 points と shots.learned の両方に載っているか・通常未学習が残っていないか。欠け欄は名指しして photo_learn→束更新。F55: read≥1・新束後自動≥1・本番監査に learn_reflect_ok|learn_flow_reflect_ok|aim有 のいずれかがあるか（F6+F31+F43+F46 統合）。止まった段を foundation_gaps と path_to_100 に書く。",
  "【完走責任】統括Proは『連続画像で詰まり/弱点/直接入力を発見→コード/土台を構築→細部まで強化→束→拡張反映→自動1回でF55/F15/F28/human_like改善実証』まで一連の責任を持つ。束に載せただけ・コードを直しただけで完了と言わず、F55(read≥1∧新束後自動≥1∧reflect|flow_reflect|aim有≥1)と直接入力0・動き近さが通るまで、未達の段・弱い欄・人の手を順番に名指しして回し続ける。",
  "【作業員の規模】axes.worker_scale / 『作業員の規模』を必ず見る。推奨人数は実測（並列≈・弱い欄・未学習・課題数）の正本だけ使う。推測で人数を作らない。増やすべき時は next_line / build_next に『作業員N人で並列』と書く。scale_workers の limit は変えない。勝手に起動せず判断だけ。",
  "【最善の判断・迷ったら竹内さんへ推奨つきで確認】判断の順: ①実データ（axes・束・監査・meet_notes の数字）②設計知見（kb_hits。P0→P1→新しい順）③影響範囲。候補が2つ以上残る時は、根拠の数字で並べて1つに絞る。絞れない・根拠の数字が無い時は推測で決めず、確信を low にして owner_asks に出す。",
  "確信（confidence）: high=数字と設計知見の両方が同じ方を指す／mid=数字はあるが設計知見が薄い（または逆）／low=候補が拮抗・根拠の数字が無い・統括の言葉同士が食い違う。confidence_why に1文、decision_basis に根拠（数字・kb の id）を最大4つ。",
  "聞く場面（owner_asks に出す）: ①費用が出る（photo_learn・flash の実行）②DB の構造変更 ③一括・次のお客さんへの進み方など動き方の方針の変更 ④本番（main/Vercel）への反映 ⑤統括の言葉同士の矛盾（例: 到達が高いのに反映の実証 read=0）⑥確信が low。聞かずに決めてよいのは『無料・元に戻せる・既に決まった方針の中』だけ。",
  "owner_asks の各件: {question（竹内さんがそのまま読んで答えられる1文）, options（2〜4個・短く）, recommended（必ず options の1つ・自分が最善と考える方）, why（推奨の根拠＝数字か設計知見・1文）, trigger（cost|db_change|policy|deploy|contradiction|low_confidence|other）}。推奨は『何もしない』ではなく根拠のある最善案にする（根拠が無ければ保留を推奨）。聞きすぎない（最大3件・meet の議題を言い換えただけの質問は禁止）。答えが来るまで、その作業は next_line に『確認待ち』と書いて進めない。",
  "出力は JSON だけ: {\"confidence\":\"high|mid|low\",\"confidence_why\":\"…\",\"decision_basis\":[\"…\"],\"owner_asks\":[{\"question\":\"…\",\"options\":[\"…\",\"…\"],\"recommended\":\"…\",\"why\":\"…\",\"trigger\":\"cost\"}],\"today\":[\"…\"],\"link_gap\":\"…\"|null,\"next_line\":\"…\"|null,\"foundation_gaps\":[\"…\"],\"build_next\":\"…\"|null,\"quality_up\":\"…\"|null,\"weak_fixes\":[{\"field\":\"…\",\"gap\":\"…\",\"next\":\"…\",\"layer\":\"flash\",\"why\":\"…\",\"how\":\"…\",\"hypothesis\":\"仮定: …\",\"toward100\":\"…\"}],\"bug_fixes\":[\"…\"],\"why_not_100\":\"…\",\"path_to_100\":\"…\"}",
].join("\n");

/** Cursor／打合せから Pro に渡す追加議題 */
export type SupervisorProMeetOpts = {
  /** 打合せの議題（細分化して答えてもらう） */
  meet?: string[];
  /** 追加のメモ（事実・DB数字など） */
  notes?: string[];
  /**
   * ★ 2026-11-18: 本番 meeting が薄い時、束の weak/learn_plan/shots から
   *   思考骨格を補完する（axes null で Pro が空回りする穴を塞ぐ）。
   */
  bundle?: Record<string, unknown> | null;
};

function bundleNum(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * 束の shots.learned（画面ごとの写真から読んだ欄）から、種類の数・欄の名前・位置付き・押した欄との一致を数える。
 */
export function learnedFieldsSummary(learned: unknown, points?: unknown): {
  kindsN: number;
  names: number;
  withPos: number;
  matched: number;
} {
  const out = { kindsN: 0, names: 0, withPos: 0, matched: 0 };
  if (!learned || typeof learned !== "object") return out;
  const names = new Set<string>();
  for (const list of Object.values(learned as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const f of list as Array<Record<string, unknown> | null>) {
      if (!f || typeof f !== "object") continue;
      if (typeof f.kind === "string" && f.kind) out.kindsN++;
      if (typeof f.x === "number" && typeof f.y === "number") out.withPos++;
      if (typeof f.name === "string" && f.name) names.add(f.name);
    }
  }
  out.names = names.size;
  const pressed = points && typeof points === "object" ? new Set(Object.keys(points as object)) : new Set<string>();
  for (const nm of names) if (pressed.has(nm)) out.matched++;
  return out;
}

/** 束／foundation／source から写真到達を測る（Pro 前の正本・0を落とさない） */
export function photoReachFromBundle(bundle?: Record<string, unknown> | null): {
  photoReach: number;
  inStorage: number;
  learnedOk: number;
  todo: number;
  photoKindsN: number;
  imageFields: number;
  withScreenPos: number;
  matched: number;
  f49Line: string | null;
  f49Ok: boolean | null;
  /** 2026-11-21 作業員G: 束に shot_gaps も shot_gaps_normal も無い（学べ済み・未読の数が分からない）。PHOTO_LEARN_UNKNOWN_NULL=off で常に false */
  learnedUnknown: boolean;
} {
  const src = (bundle?.source && typeof bundle.source === "object")
    ? (bundle.source as Record<string, unknown>)
    : {};
  const shots = (bundle?.shots && typeof bundle.shots === "object")
    ? (bundle.shots as Record<string, unknown>)
    : {};
  const br = (bundle?.bundle_reflect && typeof bundle.bundle_reflect === "object")
    ? (bundle.bundle_reflect as Record<string, unknown>)
    : {};
  const gn = (bundle?.shot_gaps_normal && typeof bundle.shot_gaps_normal === "object")
    ? (bundle.shot_gaps_normal as Record<string, unknown>)
    : {};
  const g = (bundle?.shot_gaps && typeof bundle.shot_gaps === "object")
    ? (bundle.shot_gaps as Record<string, unknown>)
    : {};
  let inStorage = bundleNum(shots.in_storage);
  let f49Line: string | null = null;
  let f49Ok: boolean | null = null;
  const fa = bundle?.foundation_audit as {
    key?: Record<string, { ok?: boolean; line?: string }>;
    items?: Array<{ id?: string; ok?: boolean; line?: string }>;
  } | undefined;
  const f49 = fa?.key?.F49_vision_photo_reach
    || fa?.items?.find((x) => x?.id === "F49_vision_photo_reach");
  if (f49?.line) {
    f49Line = String(f49.line);
    f49Ok = f49.ok === true ? true : f49.ok === false ? false : null;
    const m = f49Line.match(/束in_storage=(\d+)/);
    if (m) inStorage = Math.max(inStorage, bundleNum(m[1]));
  }
  const learnedOk = bundleNum(gn.learnedOk) || bundleNum(g.learnedOk);
  const todo = bundleNum(gn.todo) || bundleNum(g.todo);
  let photoKindsN = 0;
  if (shots.kinds && typeof shots.kinds === "object") {
    photoKindsN = Object.values(shots.kinds as Record<string, number>)
      .reduce((a, b) => a + (Number(b) || 0), 0);
  }
  const pk = bundle?.photo_kinds;
  if (pk && typeof pk === "object") {
    photoKindsN = Math.max(
      photoKindsN,
      Object.values(pk as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0),
    );
  }
  const im = bundle?.image_match as { imageFields?: number; withScreenPos?: number; matched?: number } | undefined;
  let imageFields = bundleNum(im?.imageFields);
  let withScreenPos = bundleNum(im?.withScreenPos);
  let matched = bundleNum(im?.matched);
  // ★ 2026-11-19: 本番の束には photo_kinds / image_match が無い（統括の入力でだけ数えていた）。
  //   写真から読んだ欄そのもの（shots.learned）は束にあるので、無い時はそこから数える。
  const fromLearned = learnedFieldsSummary(shots.learned, bundle?.points);
  if (!photoKindsN) photoKindsN = fromLearned.kindsN;
  if (!imageFields) imageFields = fromLearned.names;
  if (!withScreenPos) withScreenPos = fromLearned.withPos;
  if (!matched) matched = fromLearned.matched;
  const photoReach = Math.max(
    inStorage,
    bundleNum(shots.total),
    bundleNum(shots.n),
    bundleNum(br.photo_in_storage),
    bundleNum(gn.total),
    learnedOk + todo,
    bundleNum(src.rows),
  );
  return {
    photoReach,
    inStorage,
    learnedOk,
    todo,
    photoKindsN,
    imageFields,
    withScreenPos,
    matched,
    f49Line,
    f49Ok,
    learnedUnknown: photoLearnUnknownNullOn() && !bundle?.shot_gaps_normal && !bundle?.shot_gaps,
  };
}

/** 2026-11-21 作業員G（統括Pro 段A）: 学べ済みの数が束に無い時に 0（flash未実行）と書かない。段Aで確かめて既定 on（戻す: PHOTO_LEARN_UNKNOWN_NULL=off） */
export function photoLearnUnknownNullOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PHOTO_LEARN_UNKNOWN_NULL ?? "").trim().toLowerCase() !== "off";
}

/** --note 無しでも Pro に渡す事実メモ（F49・shots・到達枚数） */
export function proMeetNotesFromBundle(bundle?: Record<string, unknown> | null): string[] {
  const pr = photoReachFromBundle(bundle);
  const notes: string[] = [];
  {
    const solidBundle = countLearnedSolid(bundle).solid;
    const faSolid = Number((bundle as { foundation_audit?: { screen_solid?: number } } | null)?.foundation_audit?.screen_solid) || 0;
    const solid = Math.max(solidBundle, faSolid);
    if (solid > 0) {
      notes.push(`F1実測 solid=${solid}（束=${solidBundle}／FA=${faSolid}）${solid >= 30 ? "・完了線クリア→次は拡張再読込→自動1回" : "・まだ<30"}`);
    }
  }
  if (pr.photoReach > 0) {
    notes.push(
      `束/DB写真到達≈${pr.photoReach}枚（in_storage=${pr.inStorage || pr.photoReach}）`
        + (pr.learnedOk || pr.todo ? `／通常学べ${pr.learnedOk}+未読${pr.todo}` : ""),
    );
  }
  if (pr.f49Line) {
    const staleF49 = /束in_storage=0\b|in_storage=0\b/.test(pr.f49Line) && pr.photoReach > 0;
    if (staleF49) {
      notes.push(
        `F49: 写真→統括到達 束in_storage=${pr.inStorage || pr.photoReach}（foundation古い行・束実測で上書き）`,
      );
    } else {
      notes.push(`F49: ${pr.f49Line.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } else if (pr.photoReach > 0) {
    notes.push(`F49: 写真→統括到達 束in_storage=${pr.inStorage || pr.photoReach}（束実測・foundation未同期）`);
  }
  if (pr.photoReach > 0 && pr.f49Ok === false) {
    notes.push("DB/束に写真あり・vision配線穴（段1を写真無しと言わない）");
  }
  const imf = (bundle as { image_flows?: { line?: string; unlearned_runs?: Array<{ run_id?: string; mode?: string; learned?: number; total?: number }> } } | null)?.image_flows;
  if (imf?.line) {
    const topUn = imf.unlearned_runs?.[0];
    notes.push(`F53連続画像: ${imf.line}${topUn ? `／未連続=${topUn.run_id}(${topUn.mode} ${topUn.learned}/${topUn.total})` : ""}`.slice(0, 210));
  }
  return notes.slice(0, 6);
}

/**
 * 薄い本番 meeting で vision_pro_link が NULL／段1誤報になる穴を Pro 前に塞ぐ。
 */
export function ensureVisionPhotoReachEvidence(
  adv: SupervisorAdvice,
  bundle?: Record<string, unknown> | null,
): SupervisorAdvice {
  const pr = photoReachFromBundle(bundle);
  if (pr.photoReach <= 0) return adv;
  const meeting = {
    ...(adv.meeting || {
      today: [] as string[],
      agenda: [],
      questions: [],
      evidence: [] as Array<{ label: string; value: string; guessed?: boolean }>,
    }),
  };
  const ev = [...(meeting.evidence || [])];
  const hasVisionEv = ev.some((e) => /^画像学習→統括Pro連携$/.test(String(e.label || "")));
  const prevLink = (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link;
  const prevPhoto = bundleNum(prevLink?.counts?.photo_in_storage);
  // 前の連携の数が束の実数より小さい（学べ0・材料0 なのに束にはある）時も作り直す
  const prevUnder = !!prevLink && (
    (bundleNum(prevLink.counts?.learned_ok) <= 0 && pr.learnedOk > 0)
    || (bundleNum(prevLink.counts?.image_fields) <= 0 && pr.imageFields > 0)
    || (bundleNum(prevLink.counts?.matched) <= 0 && pr.matched > 0)
  );
  const needsLink = !prevLink || (prevPhoto <= 0 && pr.photoReach > 0) || !hasVisionEv || prevUnder;
  const f49Stale = pr.f49Line != null && /束in_storage=0\b|in_storage=0\b/.test(pr.f49Line) && pr.photoReach > 0;
  if (!needsLink && pr.f49Line && !f49Stale
    && ev.some((e) => /F49_vision_photo_reach|土台 F49/.test(String(e.label || "")))) {
    return adv;
  }
  const hasPhotoLearnTask = (meeting.learning_tasks || []).some((t) => t.kind === "photo_learn");
  if (needsLink) {
    const vision_pro_link = buildVisionProLink({
      photoInStorage: pr.photoReach,
      learnedOk: pr.learnedOk,
      learnedUnknown: pr.learnedUnknown,
      todo: pr.todo,
      photoKindsN: pr.photoKindsN,
      imageFields: pr.imageFields,
      withScreenPos: pr.withScreenPos,
      matched: pr.matched,
      hasPhotoLearnTask,
      usedPro: prevLink?.counts?.used_pro ?? null,
    });
    (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link = vision_pro_link;
    const filt = ev.filter((e) => !/^画像学習→統括Pro連携$|^画像学習の役割/.test(String(e.label || "")));
    filt.unshift({
      label: "画像学習→統括Pro連携",
      value: vision_pro_link.line
        + (prevPhoto <= 0 && pr.photoReach > 0 ? "／束・DB到達で段1補完（配線穴）" : ""),
      guessed: vision_pro_link.bottleneck_n != null,
    });
    filt.unshift({
      label: "画像学習の役割（flash/Pro）",
      value: `読む=${vision_pro_link.roles.flash_model}／まとめる=${vision_pro_link.roles.pro_model}／関所=決定論。混ぜない`,
      guessed: false,
    });
    meeting.evidence = filt;
  }
  const ev2 = [...(meeting.evidence || [])];
  const f49Val = (() => {
    if (pr.photoReach > 0 && (f49Stale || !pr.f49Line)) {
      return `写真→統括到達 束in_storage=${pr.inStorage || pr.photoReach} vision補完（束実測・F49同期）`;
    }
    if (pr.f49Line) return pr.f49Line.slice(0, 220);
    return null;
  })();
  const f49Idx = ev2.findIndex((e) => /土台 F49|F49_vision_photo_reach/.test(String(e.label || "")));
  if (f49Val) {
  if (f49Idx >= 0) {
    const old = String(ev2[f49Idx].value || "");
    const oldZero = /束in_storage=0\b|in_storage=0\b/.test(old) && pr.photoReach > 0;
    if (oldZero || f49Stale) {
      ev2[f49Idx] = {
        ...ev2[f49Idx],
        label: "土台 F49_vision_photo_reach",
        value: f49Val.slice(0, 220),
        guessed: pr.f49Ok !== true && !f49Stale,
      };
    }
  } else {
    ev2.unshift({
      label: "土台 F49_vision_photo_reach",
      value: f49Val.slice(0, 220),
      guessed: pr.f49Ok !== true && !f49Stale,
    });
  }
  }
  meeting.evidence = ev2;
  return { ...adv, meeting };
}

/**
 * 本番の薄い meeting でも「足りない→強化→改善」根拠を載せる。
 */
export function ensureProThinkEvidence(
  adv: SupervisorAdvice,
  bundle?: Record<string, unknown> | null,
): SupervisorAdvice {
  const meeting = {
    ...(adv.meeting || { today: [] as string[], agenda: [], questions: [], evidence: [] as Array<{ label: string; value: string; guessed?: boolean }> }),
  };
  const ev = [...(meeting.evidence || [])];
  if (ev.some((e) => /統括Pro思考骨格|画像学習はちゃんと行ったか/.test(String(e.label || "")))) {
    return adv;
  }
  const weak = Array.isArray(bundle?.weak)
    ? (bundle!.weak as Array<{ kind?: string; name?: string }>)
    : [];
  const planItems = Array.isArray((bundle?.learn_plan as { items?: unknown } | undefined)?.items)
    ? ((bundle!.learn_plan as { items: Array<{ kind?: string; name?: string }> }).items)
    : [];
  const conflictFields = weak
    .filter((w) => String(w.kind || "") === "kind_conflict_in_photo")
    .map((w) => String(w.name || ""))
    .filter(Boolean);
  const vsOnly = planItems
    .filter((w) => String(w.kind || "") === "photo_vs_record")
    .map((w) => String(w.name || ""))
    .filter(Boolean);
  const shots = (bundle?.shots && typeof bundle.shots === "object")
    ? (bundle.shots as { total?: number; with_ops?: number; in_storage?: number; kinds?: Record<string, number> })
    : {};
  const bundleReflect = bundle?.bundle_reflect as { photo_in_storage?: number } | undefined;
  const kindsFromShots = shots.kinds
    ? Object.values(shots.kinds).reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const points = (bundle?.points && typeof bundle.points === "object")
    ? (bundle.points as Record<string, { x?: number; y?: number; w_src?: string }>)
    : {};
  let centerOnly = 0;
  let solidPos = 0;
  let photoSrc = 0;
  for (const p of Object.values(points)) {
    if (!p || typeof p !== "object") continue;
    if (String(p.w_src || "") === "photo") photoSrc++;
    const x = Number(p.x);
    const y = Number(p.y);
    if (x === 0.5 && y === 0.5) centerOnly++;
    else if (Number.isFinite(x) && Number.isFinite(y)) solidPos++;
  }
  const think = buildProThinkCapability({
    photoInStorage:
      Number(shots.in_storage)
      || Number(bundleReflect?.photo_in_storage)
      || Number(shots.total)
      || Number(shots.with_ops)
      || photoSrc
      || null,
    learnedOk: photoSrc || null,
    todo: conflictFields.length + vsOnly.length || null,
    photoKindsN: kindsFromShots || photoSrc || null,
    centerOnlyPosN: centerOnly || null,
    solidPosN: solidPos || null,
    kindConflictN: conflictFields.length || null,
    kindConflictFields: conflictFields.slice(0, 12),
    photoVsRecordN: vsOnly.length || null,
    photoVsRecordFields: vsOnly.slice(0, 12),
    hasPhotoLearnTask: false,
    readCount: null,
    autoAfter: null,
  });
  ev.unshift({
    label: "画像学習はちゃんと行ったか",
    value: think.image_learn.line
      + (think.image_learn.gaps[0] ? `／穴: ${think.image_learn.gaps.slice(0, 3).join("・")}` : ""),
    guessed: think.image_learn.done !== true,
  });
  ev.unshift({
    label: "統括Pro思考骨格（足りない→強化→改善）",
    value: think.line + "／" + think.scaffold,
    guessed: think.missing.length > 0,
  });
  if (think.fine_atoms.length) {
    ev.unshift({
      label: "画像の細かい強化原子",
      value: think.fine_atoms.slice(0, 8).map((a) => `${a.field}[${a.facet}]: ${a.next}`).join("／"),
      guessed: true,
    });
  }
  meeting.evidence = ev;
  return { ...adv, meeting };
}

/**
 * 決定論の行（「土台 F55_…」「土台 F38_…」→ 前の形の「学習完成・つながり」）の read=N（無ければ null）。
 * 「（統括Pro）」の付いた LLM の文の行は読まない（前の判断の言い回しが数として戻ってくるのを避ける）。
 */
export function readCountFromFoundationLines(ev: Array<{ label?: string; value?: string }>): number | null {
  for (const re of [/^土台 F55_/, /^土台 F38_/, /^学習完成・つながり$/]) {
    const row = ev.find((e) => re.test(String(e?.label || "")));
    const m = row ? /(?:^|[\s（(])read=(\d+)/.exec(String(row.value || "")) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * 2026-11-21 作業員G（統括Pro 段A）: 根拠の行から原因の再学習（決定論）を組む部分だけを外に出した。
 *   ensureCauseRelearnEvidence と同じ計算（中身は動かしていない）。凍結した問題集の再生（search-pro-exam）と quality_daily の原因の型の数で使う。
 */
export function causeRelearnFromEvidence(
  ev: Array<{ label?: string; value?: string; guessed?: boolean }>,
  hint?: {
    auditStatus?: string | null;
    auditExt?: string | null;
    filledNull?: boolean | null;
    layoutOps?: number | null;
    searchOps?: number | null;
    diagnoseIds?: string[] | null;
    diagnoseText?: string | null;
    foundationFails?: Array<{ id: string; line?: string; next?: string }> | null;
    foundationMissingN?: number | null;
    readCount?: number | null;
    autoAfter?: boolean | null;
    reflectOk?: number | null;
    linkPipelineOk?: boolean | null;
    photoTodo?: number | null;
    hasPhotoLearnTask?: boolean | null;
    kindConflictN?: number | null;
    photoVsRecordN?: number | null;
    stuckBeforeAcquire?: boolean | null;
    acquireArmed?: boolean | null;
    sentGrasped?: boolean | null;
    thinkMissingN?: number | null;
  } | null,
): ReturnType<typeof buildCauseRelearn> {
  const joined = ev.map((e) => `${e.label} ${e.value}`).join("\n");
  const failFromEv: Array<{ id: string; line?: string; next?: string }> = [];
  for (const e of ev) {
    if (!/土台 F|foundation|F\d+_/.test(String(e.label || "") + String(e.value || ""))) continue;
    const m = String(e.value || "").match(/(F\d+[_\w]*)/);
    if (m) failFromEv.push({ id: m[1], line: String(e.value || "").slice(0, 120) });
  }
  const acq = buildAcquireGraspReport({
    auditStatus: hint?.auditStatus || (/status=started|abandoned/.test(joined) ? "started" : null),
    searchArmed: /search_armed|acq_armed/.test(joined) ? true : /開始前|wait_fill/.test(joined) ? false : null,
    fillDone: /fill-done/.test(joined) ? true : null,
    acquireStarted: /press_start|PDF押し/.test(joined) ? true : false,
    stepText: joined,
  });
  return buildCauseRelearn({
    auditStatus: hint?.auditStatus || (/status=started|abandoned|監査.*started/.test(joined) ? "started" : null),
    auditExt: hint?.auditExt || null,
    filledNull: hint?.filledNull ?? (/filled[=: ]*null|filledNull/.test(joined) ? true : null),
    layoutOps: hint?.layoutOps ?? (/layoutOps[=: ]*0/.test(joined) ? 0 : null),
    searchOps: hint?.searchOps ?? null,
    diagnoseIds: hint?.diagnoseIds || null,
    diagnoseText: hint?.diagnoseText || joined,
    foundationFails: (hint?.foundationFails && hint.foundationFails.length)
      ? hint.foundationFails
      : failFromEv.slice(0, 10),
    foundationMissingN: hint?.foundationMissingN
      ?? (/土台欠\s*(\d+)/.exec(joined)?.[1] ? Number(/土台欠\s*(\d+)/.exec(joined)![1]) : null),
    // 2026-11-21 作業員G（PRO_CAUSE_NULL_STRICT=on の時）: 今の根拠の行は「土台 F55/F38 … read=N」の形。文の中の「read_count=0」
    //   （前の Pro の思考骨格の言い回しが根拠に残った物）より、土台の行の数を先に読む（read=14 なのに「読んでいない」になっていた）
    readCount: hint?.readCount ?? ((proCauseNullStrictOn() ? readCountFromFoundationLines(ev) : null)
      ?? (/read_count[=: ]*0/.test(joined) ? 0 : /read_count[=: ]*[1-9]/.test(joined) ? 2 : null)),
    autoAfter: hint?.autoAfter ?? (/新束のあとの自動走行 0|auto_after[=: ]*false|自動走行 0件/.test(joined) ? false : null),
    reflectOk: hint?.reflectOk ?? (/reflect_ok=0|learn_reflect_ok.*0/.test(joined) ? 0 : null),
    linkPipelineOk: hint?.linkPipelineOk ?? (/連携一連.*✗|止: 3\.|F32.*✗/.test(joined) ? false : null),
    photoTodo: hint?.photoTodo ?? (/未学習(\d+)/.exec(joined)?.[1] ? Number(/未学習(\d+)/.exec(joined)![1]) : null),
    hasPhotoLearnTask: hint?.hasPhotoLearnTask ?? /photo_learn/.test(joined),
    kindConflictN: hint?.kindConflictN ?? (/種類衝突(\d+)/.exec(joined)?.[1] ? Number(/種類衝突(\d+)/.exec(joined)![1]) : null),
    photoVsRecordN: hint?.photoVsRecordN ?? (/記録≠写真(\d+)/.exec(joined)?.[1] ? Number(/記録≠写真(\d+)/.exec(joined)![1]) : null),
    stuckBeforeAcquire: hint?.stuckBeforeAcquire ?? acq.stuck_before_acquire,
    acquireArmed: hint?.acquireArmed ?? (acq.phases_ok.includes("armed") ? true : acq.stuck_before_acquire ? false : null),
    sentGrasped: hint?.sentGrasped ?? acq.sent_grasped,
    thinkMissingN: hint?.thinkMissingN ?? (/思考欠(\d+)/.exec(joined)?.[1] ? Number(/思考欠(\d+)/.exec(joined)![1]) : /足りない(\d+)/.exec(joined)?.[1] ? Number(/足りない(\d+)/.exec(joined)![1]) : null),
  });
}

/**
 * 原因思考・再学習・土台/連携抜けを Pro 材料に載せる（竹内さん 2026-11-18）。
 */
export function ensureCauseRelearnEvidence(
  adv: SupervisorAdvice,
  hint?: Parameters<typeof causeRelearnFromEvidence>[1],
): SupervisorAdvice {
  const meeting = {
    ...(adv.meeting || { today: [] as string[], agenda: [], questions: [], evidence: [] as Array<{ label: string; value: string; guessed?: boolean }> }),
  };
  const ev = [...(meeting.evidence || [])];
  if (ev.some((e) => /原因→改善の再学習/.test(String(e.label || "")))) {
    return adv;
  }
  const report = causeRelearnFromEvidence(ev, hint);
  ev.unshift({
    label: "人間のように原因を考える",
    value: report.think_like_human.join(" → "),
    guessed: false,
  });
  ev.unshift({
    label: "原因→改善の再学習",
    value: report.line + "／" + report.relearn_line
      + (report.atoms[0] ? `／原子: ${report.atoms.slice(0, 4).map((a) => `${a.id}:${a.cause.slice(0, 28)}`).join("・")}` : ""),
    guessed: report.atoms.length > 0,
  });
  if (report.foundation_gaps.length) {
    ev.unshift({
      label: "足りない土台（原因再学習・決定論）",
      value: report.foundation_gaps.map((g, i) => `${i + 1}.${g}`).join(" → "),
      guessed: false,
    });
  }
  meeting.evidence = ev;
  /** agenda にも原因再学習を載せる */
  const agenda = [...(meeting.agenda || [])];
  if (report.atoms[0] && !agenda.some((a) => /原因→改善|再学習/.test(String(a.topic || "")))) {
    agenda.unshift({
      priority: 0,
      topic: "原因→改善を再学習し土台を徹底強化",
      why: report.atoms.slice(0, 3).map((a) => a.symptom).join("／"),
      decide: [
        report.relearn_line,
        ...report.atoms.slice(0, 3).map((a) => `${a.how}（${a.foundation}）`),
      ].filter(Boolean).join(" → "),
    });
  }
  meeting.agenda = agenda.slice(0, 12);
  return { ...adv, meeting };
}

/**
 * 改善構築の志向を Pro 材料に必ず載せる（竹内さん 2026-11-18）。
 * 学習→足りない→強化→仕組み→構築→自動反映。
 */
export function ensureImproveConstructEvidence(
  adv: SupervisorAdvice,
  bundle?: Record<string, unknown> | null,
): SupervisorAdvice {
  const meeting = {
    ...(adv.meeting || { today: [] as string[], agenda: [], questions: [], evidence: [] as Array<{ label: string; value: string; guessed?: boolean }> }),
  };
  const ev = [...(meeting.evidence || [])];
  if (ev.some((e) => /改善する仕組みの構築|統括Proの志向/.test(String(e.label || "")))) {
    return adv;
  }
  const joined = ev.map((e) => `${e.label} ${e.value}`).join("\n");
  const weak = Array.isArray(bundle?.weak)
    ? (bundle!.weak as Array<{ kind?: string }> )
    : [];
  const shots = (bundle?.shots && typeof bundle.shots === "object")
    ? (bundle.shots as { total?: number; with_ops?: number })
    : {};
  const acq = buildAcquireGraspReport({
    auditStatus: /status=started|監査.*started/.test(joined) ? "started" : null,
    searchArmed: /search_armed|生存印|acq_armed/.test(joined) ? true : /blocked_need_fill_done|wait_fill|開始前/.test(joined) ? false : null,
    fillDone: /fill-done|fill_done/.test(joined) ? true : null,
    acquireStarted: /press_start|PDF押し|物件取得.*始/.test(joined) ? true : false,
    stepText: joined,
  });
  const thinkMiss = (joined.match(/足りない(\d+)/) || [])[1];
  const construct = buildImproveConstruct({
    learnedOk: Number(shots.with_ops) || Number(shots.total) || null,
    photoTodo: weak.filter((w) => /photo|conflict|vs_record/i.test(String(w.kind || ""))).length || null,
    hasPhotoLearnTask: /photo_learn/.test(joined),
    readCount: /read_count[=: ]*0/.test(joined) ? 0 : /read_count[=: ]*[1-9]/.test(joined) ? 1 : null,
    autoAfter: /auto_after|新束後の自動/.test(joined) ? /auto_after[=: ]*true|自動1回済/.test(joined) : null,
    reflectOk: /learn_reflect_ok|reflect_ok[=: ]*[1-9]/.test(joined) ? 1 : 0,
    thinkMissingN: thinkMiss ? Number(thinkMiss) : (/Pro思考骨格: 止=/.test(joined) ? 1 : null),
    acquireArmed: acq.phases_ok.includes("armed") ? true : (acq.stuck_before_acquire ? false : null),
    acquireSentGrasped: acq.sent_grasped,
    stuckBeforeAcquire: acq.stuck_before_acquire,
    mechanismApplied: /改善する仕組みを構築|LEARN_MECHANISMS/.test(joined) ? true : false,
  });
  ev.unshift({
    label: "統括Proの志向（改善構築→自動反映）",
    value: construct.orientations.slice(0, 5).map((o) => o.aim).join("／"),
    guessed: false,
  });
  ev.unshift({
    label: "改善する仕組みの構築",
    value: construct.line + "／" + construct.scaffold,
    guessed: construct.gaps.length > 0,
  });
  ev.unshift({
    label: "次の構築手→自動反映",
    value: construct.next_construct + " → " + construct.next_reflect + "／" + construct.path_line,
    guessed: construct.gaps.length > 0,
  });
  meeting.evidence = ev;
  return { ...adv, meeting };
}

/**
 * 物件取得・送付済み把握を Pro 材料に必ず載せる（竹内さん 2026-11-18）。
 * 開始前停止と送付済詰まりを混ぜない。
 */
export function ensureAcquireGraspEvidence(
  adv: SupervisorAdvice,
  hint?: {
    auditStatus?: string | null;
    searchArmed?: boolean | null;
    fillDone?: boolean | null;
    acquireStarted?: boolean | null;
    sentSkipped?: number | null;
    sentMarked?: number | null;
    pressedSent?: number | null;
    allowedN?: number | null;
    stepText?: string | null;
    timingKeys?: string[] | null;
  } | null,
): SupervisorAdvice {
  const meeting = {
    ...(adv.meeting || { today: [] as string[], agenda: [], questions: [], evidence: [] as Array<{ label: string; value: string; guessed?: boolean }> }),
  };
  const ev = [...(meeting.evidence || [])];
  if (ev.some((e) => /物件取得・送付済みの把握/.test(String(e.label || "")))) {
    return adv;
  }
  const joinedEv = ev.map((e) => `${e.label} ${e.value}`).join("\n");
  const acq = buildAcquireGraspReport({
    auditStatus: hint?.auditStatus
      ?? (/status=started|監査.*started/.test(joinedEv) ? "started" : null),
    searchArmed: hint?.searchArmed
      ?? (/search_armed|生存印/.test(joinedEv) ? true : /blocked_need_fill_done|wait_fill/.test(joinedEv) ? false : null),
    fillDone: hint?.fillDone
      ?? (/fill-done|fill_done/.test(joinedEv) ? true : null),
    acquireStarted: hint?.acquireStarted
      ?? (/物件取得.*始|press_start|PDF押し/.test(joinedEv) ? true : false),
    sentSkipped: hint?.sentSkipped ?? null,
    sentMarked: hint?.sentMarked ?? null,
    pressedSent: hint?.pressedSent ?? null,
    allowedN: hint?.allowedN ?? null,
    stepText: hint?.stepText || joinedEv,
    timingKeys: hint?.timingKeys || null,
  });
  ev.unshift({
    label: "物件取得・送付済みの把握",
    value: acq.line
      + (acq.atoms[0] ? `／原子: ${acq.atoms[0].problem} → ${acq.atoms[0].next}` : "")
      + `／次: ${acq.next_line}`,
    guessed: acq.stuck_before_acquire || acq.stuck_on_sent || !acq.sent_grasped,
  });
  meeting.evidence = ev;
  return { ...adv, meeting };
}

/** evidence からラベル部分一致で1行取る */
function evidenceValue(
  evidence: Array<{ label: string; value: string; guessed?: boolean }>,
  re: RegExp,
): string | null {
  const hit = evidence.find((e) => re.test(String(e.label || "")));
  return hit ? String(hit.value || "").slice(0, 220) : null;
}

/**
 * Pro に渡す材料（細かく・個人情報なし）。
 * ⚠ 決定論の evidence をそのまま長く渡すとノイズになるので、判断に必要な軸だけ抜く。
 */
export function buildSupervisorProPayload(
  adv: SupervisorAdvice,
  meetOpts?: SupervisorProMeetOpts | null,
  brainPull?: SupervisorProBrainPull | null,
): Record<string, unknown> {
  const m = adv.meeting || { today: [], agenda: [], questions: [], evidence: [] };
  const ev = m.evidence || [];
  const meetNotes = Array.isArray(meetOpts?.notes) ? [...meetOpts.notes] : [];
  const visionAxis = evidenceValue(ev, /^画像学習→統括Pro連携$/);
  if (!visionAxis) {
    const pr = photoReachFromBundle(meetOpts?.bundle);
    if (pr.photoReach > 0) {
      const fact = `DB/束に写真あり（到達≈${pr.photoReach}枚・in_storage=${pr.inStorage || pr.photoReach}）／vision根拠無し＝配線穴（段1誤報禁止）`;
      if (!meetNotes.some((n) => /配線穴|写真あり/.test(n))) meetNotes.push(fact);
    }
  }
  return {
    verdict: adv.verdict,
    headline: adv.headline,
    block: adv.block,
    self_check: adv.self_check,
    score: adv.score,
    /** 設計知見RAG＋統括ログ記憶（真のブレインの引き） */
    kb_hits: (brainPull?.kb_hits || []).slice(0, 6).map((h) => ({
      id8: h.id8,
      title: h.title,
      insight: h.insight,
      priority: h.priority,
      score: h.score,
      tags: h.tags,
    })),
    kb_query: brainPull?.query || null,
    log_memory: (brainPull?.log_memory || []).slice(0, 3),
    /** 軸だけ抜いた数字（Proが細かく判断するための材料） */
    axes: {
      completion: evidenceValue(ev, /自動モード完成度|完成度/),
      reproduce: evidenceValue(ev, /人間らしさの再現|再現（あと/),
      human_like: evidenceValue(ev, /自動モードの人間らしさ/),
      human_nearness: evidenceValue(ev, /人間との差分（近さ・許可線）|差分の未達（許可線）/),
      foundation_audit: evidenceValue(ev, /学習土台点検（F番号）/),
      foundation_f29: evidenceValue(ev, /土台 F29_human_nearness/),
      foundation_f31: evidenceValue(ev, /土台 F31_learn_reflect_station/),
      foundation_f32: evidenceValue(ev, /土台 F32_link_pipeline/),
      foundation_f33: evidenceValue(ev, /土台 F33_learn_db_persist/),
      foundation_f34: evidenceValue(ev, /土台 F34_pro_brain_ready/),
      foundation_f35: evidenceValue(ev, /土台 F35_wipe_write_gate/),
      foundation_f36: evidenceValue(ev, /土台 F36_write_path_gate/),
      foundation_f37: evidenceValue(ev, /土台 F37_pro_rag_brain/),
      foundation_f38: evidenceValue(ev, /土台 F38_improve_reflect_chain/),
      foundation_f6: evidenceValue(ev, /土台 F6_auto_after_bundle/),
      pro_rag: evidenceValue(ev, /統括Pro RAG/),
      pro_grasp: evidenceValue(ev, /統括Pro把握/),
      foundation_f28: evidenceValue(ev, /土台 F28_auto_gap_floor/),
      foundation_f18: evidenceValue(ev, /土台 F18_fill_progress_steps/),
      foundation_f27: evidenceValue(ev, /土台 F27_op_path_kind/),
      foundation_f8: evidenceValue(ev, /土台 F8_commands_flow/),
      foundation_f9: evidenceValue(ev, /土台 F9_stalled_signal/),
      foundation_f4: evidenceValue(ev, /土台 F4_hand_cs/),
      foundation_f53: evidenceValue(ev, /土台 F53_image_seq_flow/),
      foundation_f54: evidenceValue(ev, /土台 F54_challenge_learn_complete|F54|課題学習完全|課題欄の学習が未完/),
      foundation_f55: evidenceValue(ev, /土台 F55_auto_reflect_verified|F55|自動反映確認|自動モードへの反映が未確認/),
      foundation_f56: evidenceValue(ev, /土台 F56_pro_reflect_responsibility|統括Pro完走責任/),
      image_seq_flow: evidenceValue(ev, /画像の一連流れ（連続読み）/),
      linkage: evidenceValue(ev, /学習→自動の連携|連携のボトルネック/),
      vision_link: evidenceValue(ev, /画像学習→統括Pro連携/),
      /** 関所後の正本: photo_learn が既にあるか（Proが「課題なし」誤報しない） */
      has_photo_learn_task: (m.learning_tasks || []).some((t) => t.kind === "photo_learn"),
      /** ★ 2026-11-18: 作業員増やす判断（evidence 正本） */
      worker_scale: evidenceValue(ev, /作業員の規模/),
      scale_workers_task: (m.learning_tasks || []).some((t) => t.kind === "scale_workers"),
      /** F1 正本（古い evidence の solid=0 より優先・axes 重複禁止） */
      screen_solid_now: (() => {
        const fromFa = Number((meetOpts?.bundle as { foundation_audit?: { screen_solid?: number } } | undefined)?.foundation_audit?.screen_solid) || 0;
        const fromBundle = countLearnedSolid(meetOpts?.bundle).solid;
        return Math.max(fromFa, fromBundle);
      })(),
      vision_roles: evidenceValue(ev, /画像学習の役割|学習APIの役割|役割分担/),
      photo_kinds: evidenceValue(ev, /写真から読んだ欄の種類/),
      image_match: evidenceValue(ev, /通常モードの画像×押した位置|画像×押した位置/),
      shot_gaps: evidenceValue(ev, /学習の抜け|通常の読める未学習|未学習/),
      foundation: evidenceValue(ev, /通常録画→完全再現の土台|土台の細分化|質を上げる循環/),
      hand_cs: evidenceValue(ev, /手の形|人間らしさの再現/),
      precision: evidenceValue(ev, /精度|欄×観点/),
      search_order: evidenceValue(ev, /基本条件→検索|検索押し|直接入力|検索の順番/),
      roles: evidenceValue(ev, /学習APIの役割|役割分担/),
      audits: evidenceValue(ev, /実際の検索/),
      /** ★ 完了→次客（完走率と別軸） */
      handoff: evidenceValue(ev, /完了→次客|一連ロック|次客/),
      /** ★ F45 完了理解（何が完了しているか） */
      flow: evidenceValue(ev, /完了理解|流れ台帳|flow_done_|一連完了|次客へ渡してよい/),
      foundation_f44: evidenceValue(ev, /土台 F44_next_customer_handoff|F44/),
      foundation_f45: evidenceValue(ev, /土台 F45_flow_completion_ledger|F45/),
      foundation_f46: evidenceValue(ev, /土台 F46_flow_record_to_auto|F46|録画流れ/),
      foundation_f47: evidenceValue(ev, /土台 F47_flow_map_subdivide|F47|流れ地図/),
      foundation_f48: evidenceValue(ev, /土台 F48_pro_brain_loop|F48|脳ループ/),
      foundation_f49: evidenceValue(ev, /土台 F49_vision_photo_reach|F49|写真→統括/),
      foundation_f50: evidenceValue(ev, /土台 F50_site_method_parity|F50|サイト学習方法/),
      foundation_f51: evidenceValue(ev, /土台 F51_human_detail_loop|F51|人間細部ループ/),
      foundation_f52: evidenceValue(ev, /土台 F52_place_xor|F52|地域↔駅|place_mixed|混在/),
      human_detail: evidenceValue(ev, /人間細部ループ/),
      rec_diagnose: evidenceValue(ev, /自動録画の診断/),
      site_method: evidenceValue(ev, /サイト共通の学習方法/),
      learn_method: evidenceValue(ev, /学習方法（考え方）|学習方法の強化/),
      method_strengthen: evidenceValue(ev, /学習方法の強化（効果で直して周回）|1録画の学び方強化|学習方法の強化|設計知見候補（学び方強化）/),
      rec_challenge: evidenceValue(ev, /録画→課題→学習→仕組み補強|1録画→学習→改善→反映|録画→課題/),
      brain_loop: evidenceValue(ev, /統括Pro脳ループ|弱点→土台→強化→録画学習/),
      learn_period: evidenceValue(ev, /学習期間（揃え）|材料の期間/),
      period_construct: evidenceValue(ev, /学習期間・構築の細部/),
      complete_chain: evidenceValue(ev, /学習完成（期間・土台・つながり・一連）/),
      complete_path: evidenceValue(ev, /学習完成の道筋/),
      complete_period: evidenceValue(ev, /学習完成・学習期間/),
      complete_foundation: evidenceValue(ev, /学習完成・土台/),
      complete_link: evidenceValue(ev, /学習完成・つながり/),
      complete_series: evidenceValue(ev, /学習完成・一連/),
      mechanisms: evidenceValue(ev, /学習の仕組み（統括が使う）/),
      /** ★ 2026-11-18: 足りない→強化→改善を考える骨格 */
      pro_think: evidenceValue(ev, /統括Pro思考骨格|足りない→強化→改善/),
      image_learn_done: evidenceValue(ev, /画像学習はちゃんと行ったか/),
      image_fine_atoms: evidenceValue(ev, /画像の細かい強化原子/),
      acquire_grasp: evidenceValue(ev, /物件取得・送付済みの把握|送付済みの把握/),
      improve_construct: evidenceValue(ev, /改善する仕組みの構築/),
      pro_orientation: evidenceValue(ev, /統括Proの志向/),
      next_construct_reflect: evidenceValue(ev, /次の構築手→自動反映/),
      cause_relearn: evidenceValue(ev, /原因→改善の再学習/),
      human_cause_think: evidenceValue(ev, /人間のように原因を考える/),
      kb_pro_link: evidenceValue(ev, /設計知見↔統括Pro連携/),
    },
    /** Cursor 打合せの議題（あれば最優先） */
    meet: Array.isArray(meetOpts?.meet) ? meetOpts!.meet!.slice(0, 8).map((s) => String(s).slice(0, 200)) : [],
    meet_notes: meetNotes.slice(0, 8).map((s) => String(s).slice(0, 220)),
    /** 細分化した画像→Pro連携（あれば段階ごとに渡す） */
    vision_link: (() => {
      const vpl = (m as { vision_pro_link?: VisionProLink }).vision_pro_link;
      if (!vpl) return null;
      return {
        line: vpl.line,
        bottleneck: vpl.bottleneck,
        bottleneck_n: vpl.bottleneck_n,
        steps: (vpl.steps || []).map((s) => ({
          n: s.n, name: s.name, ok: s.ok, role: s.role, detail: String(s.detail || "").slice(0, 120),
        })),
        counts: vpl.counts,
        roles: vpl.roles,
      };
    })(),
    /** 弱点原子（決定論で細分化済み → Proが優先順を判断） */
    weak_atoms: (() => {
      const atoms: WeakAtom[] = atomsFromEvidence(ev);
      return atoms.slice(0, 12).map((a) => ({
        id: a.id,
        name: a.name,
        score: a.score ?? null,
        need: a.need ?? null,
        layer: a.layer,
        next: a.next.slice(0, 100),
      }));
    })(),
    today: (m.today || []).slice(0, 6),
    agenda: (m.agenda || []).slice(0, 6).map((a) => ({
      topic: a.topic,
      why: String(a.why || "").slice(0, 140),
      decide: String(a.decide || "").slice(0, 140),
    })),
    tasks: (m.learning_tasks || []).slice(0, 8).map((t) => ({
      kind: t.kind,
      what: String(t.what || "").slice(0, 90),
      why: String(t.why || "").slice(0, 120),
      cost: t.cost,
      limit: t.limit ?? null,
    })),
    questions: (m.questions || []).slice(0, 3).map((q) => ({
      q: String(q.q || "").slice(0, 120),
      why: String(q.why || "").slice(0, 100),
    })),
  };
}

/** finish=length で JSON が途中切れでも、取れたキーだけで読む（100%への道を落とさない）。 */
function tryParseProJson(raw: string): Record<string, unknown> | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // 閉じ `}` が無い途中切れも先頭 `{` から全部使う
  const m = s.match(/\{[\s\S]*\}/);
  const body = m ? m[0] : (s.includes("{") ? s.slice(s.indexOf("{")) : s);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    // 閉じ括弧を足して再試行（配列・オブジェクトの途中切れ）
    for (const pad of ["]}", "\"}]}", "}}", "\"]}", "null}"]) {
      try {
        return JSON.parse(body + pad) as Record<string, unknown>;
      } catch { /* next */ }
    }
    // キー単位で拾う（最低限 today / path_to_100 / why_not_100）
    const out: Record<string, unknown> = {};
    const todayM = body.match(/"today"\s*:\s*\[([\s\S]*?)\]/);
    if (todayM) {
      const items = [...todayM[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1]);
      if (items.length) out.today = items;
    }
    for (const k of ["link_gap", "next_line", "build_next", "quality_up", "why_not_100", "path_to_100"] as const) {
      const km = body.match(new RegExp(`"${k}"\\s*:\\s*("((?:\\\\.|[^"\\\\])*)"|null)`));
      if (km) out[k] = km[1] === "null" ? null : km[2]?.replace(/\\"/g, '"');
    }
    const gapsM = body.match(/"foundation_gaps"\s*:\s*\[([\s\S]*?)\]/);
    if (gapsM) {
      const items = [...gapsM[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1]);
      if (items.length) out.foundation_gaps = items;
    }
    return Object.keys(out).length ? out : null;
  }
}

export function parseSupervisorPro(text: string): SupervisorProEnrichment | null {
  try {
    const o = tryParseProJson(text);
    if (!o) return null;
    const todayRaw = Array.isArray(o.today) ? o.today : [];
    const today = todayRaw
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((s) => s.slice(0, 200));
    const link_gap = o.link_gap == null || String(o.link_gap) === "null"
      ? null
      : String(o.link_gap).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    const next_line = o.next_line == null || String(o.next_line) === "null"
      ? null
      : String(o.next_line).replace(/\s+/g, " ").trim().slice(0, 220) || null;
    const gapsRaw = Array.isArray(o.foundation_gaps) ? o.foundation_gaps : [];
    const foundation_gaps = gapsRaw
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((s) => s.slice(0, 180));
    const build_next = o.build_next == null || String(o.build_next) === "null"
      ? null
      : String(o.build_next).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    const quality_up = o.quality_up == null || String(o.quality_up) === "null"
      ? null
      : String(o.quality_up).replace(/\s+/g, " ").trim().slice(0, 220) || null;
    const weakRaw = Array.isArray(o.weak_fixes) ? o.weak_fixes : [];
    const weak_fixes: SupervisorProWeakFix[] = [];
    for (const x of weakRaw) {
      if (!x || typeof x !== "object") continue;
      const r = x as Record<string, unknown>;
      const field = String(r.field ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const gap = String(r.gap ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const next = String(r.next ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const layer = String(r.layer ?? "").trim().slice(0, 20) || undefined;
      const why = String(r.why ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
      const how = String(r.how ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
      let hypothesis = String(r.hypothesis ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
      if (hypothesis && !/仮定/.test(hypothesis)) hypothesis = "仮定: " + hypothesis;
      const toward100 = String(r.toward100 ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || undefined;
      if (!field && !next) continue;
      weak_fixes.push({
        field: field || "弱点", gap: gap || "不足", next: next || "細かく直す", layer,
        why, how, hypothesis, toward100,
      });
      if (weak_fixes.length >= 6) break;
    }
    const bugRaw = Array.isArray(o.bug_fixes) ? o.bug_fixes : [];
    const bug_fixes = bugRaw
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((s) => s.slice(0, 160));
    const why_not_100 = o.why_not_100 == null || String(o.why_not_100) === "null"
      ? null
      : String(o.why_not_100).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    const path_to_100 = o.path_to_100 == null || String(o.path_to_100) === "null"
      ? null
      : String(o.path_to_100).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    if (!today.length && !link_gap && !next_line && !foundation_gaps.length && !build_next && !weak_fixes.length
      && !why_not_100 && !path_to_100) return null;
    const confidence = parseConfidence(o.confidence);
    const confidence_why = o.confidence_why == null ? null : String(o.confidence_why).replace(/\s+/g, " ").trim().slice(0, 160) || null;
    const decision_basis = (Array.isArray(o.decision_basis) ? o.decision_basis : [])
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 4).map((s) => s.slice(0, 140));
    const owner_asks = parseOwnerAsks(o.owner_asks);
    return {
      today, link_gap, next_line, foundation_gaps, build_next, quality_up,
      weak_fixes, bug_fixes, why_not_100, path_to_100,
      confidence, confidence_why, decision_basis, owner_asks,
    };
  } catch {
    return null;
  }
}

const PRO_EV_LABEL = /^(統括Proまとめ|足りない土台（統括Pro判断）|土台を作る次手（統括Pro）|役割分担（画像\/統括）|統括Pro|統括Pro RAG|統括Pro把握|統括Pro手配|弱点の細かい改善（統括Pro）|変バグの細かい直し（統括Pro）|なぜ100%でないか（統括Pro）|100%への道（統括Pro）|統括Pro確信（迷い）)$/;
const PRO_AGENDA_TOPIC = /統括Pro/;

/** Pro のまとめを advice に載せる（verdict / self_check / learning_tasks の kind は変えない）。 */
export function mergeSupervisorPro(
  adv: SupervisorAdvice,
  enrich: SupervisorProEnrichment,
  meta?: { model?: string; usedPro?: boolean; brainPull?: SupervisorProBrainPull | null; screenSolid?: number | null },
): SupervisorAdvice {
  const meeting = { ...(adv.meeting || { today: [], agenda: [], questions: [], evidence: [] }) };
  // 再Enrichでも二重にならないよう、前回の Pro 行を先に落とす
  let baseEvidence = (meeting.evidence || []).filter((e) => !PRO_EV_LABEL.test(String(e.label || "")));
  const baseAgenda = (meeting.agenda || []).filter((a) => !PRO_AGENDA_TOPIC.test(String(a.topic || "")));
  const baseToday = (meeting.today || []).filter((t) => !/^【(結論|連携の穴|次の1手)】/.test(String(t)));

  /**
   * ★ 2026-11-18: photo_learn があるのに「課題が無い」／solid≥30なのに「solid=0」を関所で落とす
   */
  const hasPl = (meeting.learning_tasks || []).some((t) => t?.kind === "photo_learn");
  const solidNow = Math.max(0, Number(meta?.screenSolid) || 0);
  if ((hasPl || solidNow >= 30) && Array.isArray(enrich.foundation_gaps)) {
    enrich = {
      ...enrich,
      foundation_gaps: enrich.foundation_gaps.filter((g) => {
        const s = String(g);
        if (hasPl && /photo_learn課題が無|課題が無.*photo_learn|todo=0.*photo_learn|photo_learn.*課題なし/i.test(s)) return false;
        if (solidNow >= 30 && /solid\s*=\s*0|画面位置が0欄|F1_screen_pos.*0欄|最新solid=0|束の画面位置solid=0/i.test(s)) return false;
        return true;
      }),
    };
  }

  // 画像flash→Pro 連携の step6 を確定し、根拠行を差し替え
  const prevLink = (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link;
  if (prevLink) {
    const nextLink = markVisionProUsed(prevLink, meta?.usedPro !== false, meta?.model);
    (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link = nextLink;
    baseEvidence = baseEvidence.filter((e) => !/^画像学習→統括Pro連携$/.test(String(e.label || "")));
    baseEvidence.unshift({
      label: "画像学習→統括Pro連携",
      value: nextLink.line,
      guessed: nextLink.bottleneck_n != null,
    });
  }

  const today = [...(enrich.today || [])];
  if (!today.length && enrich.next_line) today.push(enrich.next_line);
  for (const t of baseToday) {
    if (!today.includes(t)) today.push(t);
  }
  meeting.today = today.slice(0, 8);

  const evidence = [...baseEvidence];
  evidence.unshift({
    label: "統括Proまとめ",
    value: [
      enrich.quality_up ? `質: ${enrich.quality_up}` : null,
      enrich.next_line ? `次: ${enrich.next_line}` : null,
      enrich.link_gap ? `連携: ${enrich.link_gap}` : null,
      meta?.model ? `model=${meta.model}` : null,
    ].filter(Boolean).join("／") || "Proまとめあり",
    guessed: false,
  });
  if (enrich.foundation_gaps.length) {
    evidence.unshift({
      label: "足りない土台（統括Pro判断）",
      value: enrich.foundation_gaps.map((g, i) => `${i + 1}.${g}`).join(" → "),
      guessed: false,
    });
  }
  if (enrich.build_next) {
    evidence.unshift({
      label: "土台を作る次手（統括Pro）",
      value: enrich.build_next,
      guessed: false,
    });
  }
  if (enrich.why_not_100) {
    evidence.unshift({
      label: "なぜ100%でないか（統括Pro）",
      value: enrich.why_not_100,
      guessed: /仮定/.test(enrich.why_not_100),
    });
  }
  if (enrich.path_to_100) {
    evidence.unshift({
      label: "100%への道（統括Pro）",
      value: enrich.path_to_100,
      guessed: false,
    });
  }
  if (enrich.weak_fixes.length) {
    evidence.unshift({
      label: "弱点の細かい改善（統括Pro）",
      value: enrich.weak_fixes
        .map((f, i) => {
          const bits = [
            `${f.field}:${f.gap}→${f.next}`,
            f.why ? `なぜ:${f.why}` : null,
            f.how ? `どう:${f.how}` : null,
            f.hypothesis || null,
            f.toward100 ? `100%:${f.toward100}` : null,
            f.layer ? `(${f.layer})` : null,
          ].filter(Boolean);
          return `${i + 1}.` + bits.join("｜");
        })
        .join(" ／ "),
      guessed: enrich.weak_fixes.some((f) => /仮定/.test(String(f.hypothesis || ""))),
    });
  }
  if (enrich.bug_fixes.length) {
    evidence.unshift({
      label: "変バグの細かい直し（統括Pro）",
      value: enrich.bug_fixes.map((b, i) => `${i + 1}.${b}`).join(" ／ "),
      guessed: false,
    });
  }
  evidence.unshift({
    label: "役割分担（画像/統括）",
    value: "画像読み=flash／統括まとめ=Pro／関所・verdict=決定論。混ぜない",
    guessed: false,
  });
  if (meta?.brainPull) {
    const bp = meta.brainPull;
    evidence.unshift({
      label: "統括Pro RAG",
      value: bp.line + (bp.kb_hits.length
        ? "／" + bp.kb_hits.slice(0, 4).map((h) => `${h.id8}:${h.title.slice(0, 28)}`).join("・")
        : ""),
      guessed: !bp.ok,
    });
    /** ★ 把握の正本: 引いた決まりの要旨＋ログ記憶を人が読める形で残す（題だけだと把握できない） */
    const graspBits: string[] = [];
    if (bp.kb_hits.length) {
      graspBits.push(
        "知見" + bp.kb_hits.slice(0, 3).map((h) =>
          `${h.id8}「${h.title.slice(0, 36)}」:${h.insight.slice(0, 70)}`,
        ).join("｜"),
      );
    } else {
      graspBits.push("知見0件（引き失敗または空）");
    }
    if (bp.log_memory.length) {
      graspBits.push(
        "ログ" + bp.log_memory.slice(0, 2).map((l) =>
          `${String(l.at).slice(0, 16)}:${l.today.slice(0, 50)}`,
        ).join("｜"),
      );
    } else {
      graspBits.push("ログ記憶0");
    }
    if (bp.query) graspBits.push("問い:" + bp.query.slice(0, 80));
    evidence.unshift({
      label: "統括Pro把握",
      value: graspBits.join(" ／ ").slice(0, 420),
      guessed: !bp.ok,
    });
  }
  {
    const arrange = [enrich.next_line, enrich.build_next, enrich.path_to_100].filter(Boolean).join(" → ");
    if (arrange) {
      evidence.unshift({
        label: "統括Pro手配",
        value: arrange.slice(0, 280),
        guessed: false,
      });
    }
  }
  meeting.evidence = evidence.slice(0, 110);

  const agendaHead: Array<{ priority: number; topic: string; why: string; decide: string }> = [];
  if (enrich.link_gap) {
    agendaHead.push({
      priority: 0,
      topic: "連携の穴（統括Pro）",
      why: enrich.link_gap,
      decide: enrich.next_line || "画像flash→材料→Proまとめ→課題の順で穴を塞ぐ",
    });
  }
  if (enrich.foundation_gaps.length || enrich.build_next) {
    agendaHead.push({
      priority: 0,
      topic: "足りない土台をそろえる（統括Pro判断）",
      why: enrich.foundation_gaps.join("／") || "土台不足",
      decide: enrich.build_next || "通常録画から足りない土台を作る",
    });
  }
  for (const f of enrich.weak_fixes.slice(0, 3)) {
    agendaHead.push({
      priority: 0,
      topic: `弱点細分化（統括Pro）: ${f.field}`,
      why: [f.gap, f.why ? `なぜ:${f.why}` : null, f.hypothesis || null].filter(Boolean).join("／"),
      decide: [f.how || f.next, f.toward100 ? `100%へ:${f.toward100}` : null, f.layer ? `層=${f.layer}` : null]
        .filter(Boolean).join("／"),
    });
  }
  if (enrich.path_to_100 || enrich.next_line || enrich.build_next) {
    agendaHead.push({
      priority: 0,
      topic: "手配（統括Pro）: 把握→改善→実行の順",
      why: enrich.why_not_100 || enrich.link_gap || "抜けを塞ぎ学習を進める",
      decide: [enrich.next_line, enrich.build_next, enrich.path_to_100].filter(Boolean).join(" → "),
    });
  }
  if (enrich.path_to_100) {
    agendaHead.push({
      priority: 0,
      topic: "100%へ近づける道（統括Pro）",
      why: enrich.why_not_100 || "再現・完成度が100%未満",
      decide: enrich.path_to_100,
    });
  }
  if (enrich.bug_fixes.length) {
    agendaHead.push({
      priority: 0,
      topic: "変バグを細かく直す（統括Pro）",
      why: enrich.bug_fixes.join("／"),
      decide: "直押し・直書き・外し区別を人間の動きに揃える（拡張の細かい直し）",
    });
  }
  meeting.agenda = [...agendaHead, ...baseAgenda].slice(0, 14);

  // photo_learn 課題の why に Pro の弱点名指しを足す（kind/limit は変えない）
  if (enrich.weak_fixes.length && Array.isArray(meeting.learning_tasks)) {
    meeting.learning_tasks = meeting.learning_tasks.map((t) => {
      if (!t || t.kind !== "photo_learn") return t;
      const flashFixes = enrich.weak_fixes.filter((f) => !f.layer || f.layer === "flash").slice(0, 4);
      if (!flashFixes.length) return t;
      const tip = flashFixes.map((f) => f.field).join("・");
      if (/統括Pro弱点/.test(t.why)) return t;
      return { ...t, why: `${t.why}／統括Pro弱点: ${tip}` };
    });
  }

  /**
   * ★ 2026-11-18: 設計知見↔統括Pro連携を細部まで測り、欠け段を証拠・課題に落とす
   */
  {
    const evLabels = (meeting.evidence || []).map((e) => String(e.label || ""));
    const link = buildKbProLink({
      brainPull: meta?.brainPull || null,
      foundationGaps: enrich.foundation_gaps,
      buildNext: enrich.build_next,
      pathTo100: enrich.path_to_100,
      today: meeting.today || [],
      evidenceLabels: evLabels,
      learningTaskKinds: (meeting.learning_tasks || []).map((t) => String(t?.kind || "")),
      hasCauseRelearn: evLabels.some((l) => /原因→改善の再学習/.test(l)),
      hasImproveConstruct: evLabels.some((l) => /改善する仕組みの構築|統括Proの志向/.test(l)),
      hasAcquireGrasp: evLabels.some((l) => /物件取得・送付済みの把握/.test(l)),
      hasProThink: evLabels.some((l) => /統括Pro思考骨格|画像学習はちゃんと/.test(l)),
    });
    meeting.evidence = (meeting.evidence || []).filter((e) => !/^設計知見↔統括Pro連携$/.test(String(e.label || "")));
    meeting.evidence.unshift({
      label: "設計知見↔統括Pro連携",
      value: link.line
        + (link.gaps[0] ? `／穴: ${link.gaps.slice(0, 3).map((g) => g.what).join("・")}` : "")
        + `／段: ${link.stages.map((s) => `${s.id}${s.ok ? "✓" : "✗"}`).join("")}`,
      guessed: !link.ok,
    });
    if (link.from_kb_gaps.length) {
      const hasGapsEv = (meeting.evidence || []).some((e) => /足りない土台/.test(String(e.label || "")));
      if (!hasGapsEv) {
        meeting.evidence.unshift({
          label: "足りない土台（設計知見から落下）",
          value: link.from_kb_gaps.map((g, i) => `${i + 1}.${g}`).join(" → "),
          guessed: false,
        });
      } else {
        meeting.evidence.unshift({
          label: "設計知見から追加の土台",
          value: link.from_kb_gaps.slice(0, 4).join(" → "),
          guessed: false,
        });
      }
    }
    if (link.task_hints.length && Array.isArray(meeting.learning_tasks)) {
      const kinds = new Set((meeting.learning_tasks || []).map((t) => String(t?.kind || "")));
      for (const h of link.task_hints) {
        if (kinds.has(h.kind)) continue;
        meeting.learning_tasks.push({
          kind: h.kind,
          what: h.what,
          why: h.why,
          cost: h.kind === "photo_learn"
            ? "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）"
            : "無料",
        });
        kinds.add(h.kind);
      }
    }
    if (!link.ok) {
      meeting.agenda = [
        {
          priority: 0,
          topic: "設計知見↔統括Pro連携の抜けを塞ぐ",
          why: link.gaps.map((g) => g.what).join("／") || link.line,
          decide: link.gaps[0]?.how || "引く→把握→土台→課題→細部の欠け段を埋める",
        },
        ...(meeting.agenda || []),
      ].slice(0, 14);
    }
    meeting.evidence = (meeting.evidence || []).slice(0, 110);
  }
  /**
   * ★ 2026-11-19 竹内さん「判断も統括pro最善の判断できるように／迷ったら俺に推奨で確認とるかたちで」:
   *   Pro の確信と根拠を根拠行に残し、迷う所（Pro の owner_asks＋決定論の関所）を推奨つきの問いにして meeting.questions / owner_asks に載せる。
   *   関所は Pro の出した文だけを見る（meet の議題＝竹内さんの言葉では鳴らさない）。台帳 owner_questions へは scripts/supervisor-pro.ts --save が入れる。
   */
  {
    const evVals = (meeting.evidence || []).filter((e) => !PRO_EV_LABEL.test(String(e.label || ""))).map((e) => String(e.value || ""));
    const gate = deriveGateAsks({
      proText: proTextOf(enrich),
      verdict: adv.verdict,
      coverage: adv.score?.coverage ?? null,
      evidenceValues: evVals,
      confidence: enrich.confidence ?? null,
      confidenceWhy: enrich.confidence_why ?? null,
    });
    const asks = mergeAsks(enrich.owner_asks ?? [], gate);
    (meeting as { owner_asks?: OwnerAsk[] }).owner_asks = asks;
    meeting.questions = [
      ...asks.map((a) => ({ q: `【統括Pro】${a.question}`, options: a.options, why: `オススメ: ${a.recommended}（${a.why}）` })),
      ...(meeting.questions || []).filter((q) => !/^【統括Pro】/.test(String(q?.q || ""))),
    ].slice(0, 8);
    meeting.evidence = [
      {
        label: "統括Pro確信（迷い）",
        value: `確信=${enrich.confidence ?? "未申告"}${enrich.confidence_why ? `（${enrich.confidence_why}）` : ""}／迷い${asks.length}件${asks.length ? `（${asks.map((a) => a.trigger).join("・")}）` : ""}`
          + (enrich.decision_basis?.length ? `／根拠: ${enrich.decision_basis.join("｜")}` : ""),
        guessed: !enrich.confidence,
      },
      ...(meeting.evidence || []).filter((e) => !/^統括Pro確信（迷い）$/.test(String(e.label || ""))),
    ].slice(0, 110);
  }
  return { ...adv, meeting };
}

async function callProOnce(
  adv: SupervisorAdvice,
  model: string,
  key: string,
  maxTokens: number,
  meetOpts?: SupervisorProMeetOpts | null,
  timeoutMs: number = SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT,
  brainPull?: SupervisorProBrainPull | null,
): Promise<{ text: string; finish: string; status: number }> {
  const hasMeet = !!(meetOpts?.meet && meetOpts.meet.length);
  const hasKb = !!(brainPull?.kb_hits && brainPull.kb_hits.length);
  const lead = [
    hasMeet
      ? "【打合せ】次の meet 議題を最優先で細分化して判断してください。材料の axes/handoff/weak_atoms/kb_hits と突き合わせて答える。"
      : "次の統括材料を細かく判断してください。足りない土台と次手・手配を優先して。",
    hasKb
      ? "【RAG】kb_hits は設計知見から引いた現行の決まり。矛盾したら段が上・新しい方。無い物は仮定と書く。"
      : "【RAG】kb_hits が空。設計知見を引く経路を次手に含める。",
  ].join("\n") + "\n";
  const t0 = Date.now();
  const r = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "x-sumora-action": SUPERVISOR_PRO_ACTION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      // ⚠ 思考が max_tokens を食って本文0字になるのを防ぐ（実測 finish=length）
      thinking: { type: "disabled" },
      messages: [
        // ★ 固定の指示を先頭に置く（DeepSeek は同じ先頭を自動でキャッシュする）。動く材料は後ろ。
        { role: "system", content: SUPERVISOR_PRO_SYSTEM },
        {
          role: "user",
          content: lead + JSON.stringify(buildSupervisorProPayload(adv, meetOpts, brainPull)),
        },
      ],
    }),
  });
  /**
   * ★ 2026-11-20 竹内さん「プロンプトキャッシュの効果を測る」: 統括Pro の呼び出しは今まで使用量を残していなかった
   *   （ヘッダ x-sumora-action は送るだけで読む所が無い＝llm_usage_logs に1行も無い）。
   *   → キャッシュに当たった入力（prompt_cache_hit_tokens）を cache_read に入れて残す。記録の失敗で統括は止めない。
   */
  const recordUsage = (
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null,
    status: number,
    errorType: string | null,
  ) => {
    try {
      recordAltUsage({
        model, action: SUPERVISOR_PRO_ACTION, conversationId: null,
        usage: usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        status, errorType, durationMs: Date.now() - t0,
        sysHead: SUPERVISOR_PRO_SYSTEM.slice(0, 200), sysKeyFull: null, maxTokens,
      });
    } catch { /* 記録の失敗で統括は止めない */ }
  };
  if (!r.ok) {
    await r.text().catch(() => "");
    recordUsage(null, r.status, `http_${r.status}`);
    return { text: "", finish: `http_${r.status}`, status: r.status };
  }
  const d = await r.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
  };
  const hit = Number(d.usage?.prompt_cache_hit_tokens ?? 0) || 0;
  const miss = Number(d.usage?.prompt_cache_miss_tokens ?? Math.max(0, (Number(d.usage?.prompt_tokens ?? 0) || 0) - hit)) || 0;
  recordUsage({ input_tokens: miss, output_tokens: Number(d.usage?.completion_tokens ?? 0) || 0, cache_read_input_tokens: hit }, r.status, null);
  const text = String(d.choices?.[0]?.message?.content ?? "").trim();
  const finish = String(d.choices?.[0]?.finish_reason ?? "");
  return { text, finish, status: r.status };
}

/**
 * DeepSeek Pro に聞く。失敗理由を返す（握りつぶさない＝Proが動いているか分かる）。
 */
export async function askSupervisorPro(
  adv: SupervisorAdvice,
  env: Record<string, string | undefined> = process.env,
  meetOpts?: SupervisorProMeetOpts | null,
): Promise<SupervisorProAskResult> {
  const model = supervisorProModel(env);
  if ((env.SUPERVISOR_PRO ?? "on").toLowerCase() === "off") {
    return { ok: false, why: "SUPERVISOR_PRO=off", model, brainPull: null };
  }
  const key = (env.LLM_ALT_DEEPSEEK_KEY || env.DEEPSEEK_API_KEY || "").trim();
  if (!key) return { ok: false, why: "no_api_key", model, brainPull: null };

  /** ★ 2026-11-17: 判断前に設計知見RAG＋統括ログを引く（真のブレイン） */
  let brainPull: SupervisorProBrainPull | null = null;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = (env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
    const sk = (env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
    if (url && sk) {
      const { fetchSupervisorProBrainPull } = await import("./learn-supervisor-pro-rag");
      brainPull = await fetchSupervisorProBrainPull(createClient(url, sk), adv, meetOpts);
    } else {
      brainPull = {
        query: "",
        kb_hits: [],
        log_memory: [],
        line: "統括Pro RAGスキップ（Supabase鍵なし）",
        ok: false,
        why: "no_supabase",
      };
    }
  } catch (e) {
    brainPull = {
      query: "",
      kb_hits: [],
      log_memory: [],
      line: "統括Pro RAG失敗: " + String((e as Error)?.message || e).slice(0, 80),
      ok: false,
      why: String((e as Error)?.message || e).slice(0, 100),
    };
  }

  // ★ 2026-11-16: why/how/hypothesis 追加後に finish=length で JSON 途中切れ→parse_fail が再発。
  //   既定 4000・失敗時は増やして再試行（空本文だけでなく parse_fail も）。
  // ★ 2026-11-16: Abort 60s が Pro 未使用の主因 → 既定 180s＋abort 時は1回だけ再試行。
  const max1 = Math.max(2000, Number(env.SUPERVISOR_PRO_MAX_TOKENS) || 4000);
  const timeoutMs = supervisorProTimeoutMs(env);
  const runOnce = (tok: number) => callProOnce(adv, model, key, tok, meetOpts, timeoutMs, brainPull);
  try {
    let hit = await runOnce(max1);
    let enrich = hit.text ? parseSupervisorPro(hit.text) : null;
    // 空本文 or 途中切れ JSON → トークン倍で1回だけ再試行（HTTP失敗は増やさない）
    if ((!hit.text || !enrich) && hit.status < 400) {
      hit = await runOnce(Math.min(8000, Math.max(max1 * 2, 6000)));
      enrich = hit.text ? parseSupervisorPro(hit.text) : null;
    }
    if (hit.status >= 400) {
      return { ok: false, why: `deepseek_http_${hit.status}:${hit.finish}`, model, brainPull };
    }
    if (!hit.text) {
      return { ok: false, why: `empty_content(finish=${hit.finish || "?"})`, model, brainPull };
    }
    if (!enrich) {
      return { ok: false, why: "parse_fail:" + hit.text.slice(0, 80), model, brainPull };
    }
    return { ok: true, enrich, model, brainPull };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // Abort/timeout は一時揺れが多い → 同じ上限でもう1回だけ（無限に伸ばさない）
    if (/aborted|timeout|TimeoutError/i.test(msg)) {
      try {
        const hit2 = await runOnce(Math.min(8000, Math.max(max1 * 2, 6000)));
        const enrich2 = hit2.text ? parseSupervisorPro(hit2.text) : null;
        if (hit2.status >= 400) {
          return { ok: false, why: `deepseek_http_${hit2.status}:${hit2.finish}(after_abort_retry)`, model, brainPull };
        }
        if (enrich2) return { ok: true, enrich: enrich2, model, brainPull };
        if (!hit2.text) {
          return { ok: false, why: `empty_content(finish=${hit2.finish || "?"};after_abort_retry)`, model, brainPull };
        }
        return { ok: false, why: "parse_fail(after_abort_retry):" + hit2.text.slice(0, 80), model, brainPull };
      } catch (e2) {
        return {
          ok: false,
          why: `exception:${msg.slice(0, 80)}|retry:${String((e2 as Error)?.message || e2).slice(0, 60)}|timeout_ms=${timeoutMs}`,
          model,
          brainPull,
        };
      }
    }
    return { ok: false, why: "exception:" + msg.slice(0, 120), model, brainPull };
  }
}

/**
 * 学習完成（期間・土台・つながり・一連）を Pro 材料に必ず載せる。
 * 薄い本番 meeting でも 4本柱の完成線を測る。
 */
export function ensureCompleteChainEvidence(
  adv: SupervisorAdvice,
  hint?: {
    foundationMissingN?: number | null;
    foundationOkN?: number | null;
    foundationTotalN?: number | null;
    keyFoundationFails?: string[] | null;
    screenSolid?: number | null;
    readCount?: number | null;
    autoAfter?: boolean | null;
    linkLine?: string | null;
    improveBottleneckN?: number | null;
    improveLine?: string | null;
  } | null,
): SupervisorAdvice {
  const meeting = {
    ...(adv.meeting || { today: [] as string[], agenda: [], questions: [], evidence: [] as Array<{ label: string; value: string; guessed?: boolean }> }),
  };
  const ev = [...(meeting.evidence || [])];
  if (ev.some((e) => /学習完成（期間・土台・つながり・一連）/.test(String(e.label || "")))) {
    return adv;
  }
  const joined = ev.map((e) => `${e.label} ${e.value}`).join("\n");
  const matD = materialsDays();
  const solidM = joined.match(/solid[=: ]*(\d+)/i) || joined.match(/画面位置[^\d]*(\d+)/);
  const readM = joined.match(/read[_ ]?count[=: ]*(\d+)/i) || joined.match(/read[=: ]*(\d+)/i);
  const missM = joined.match(/欠[=: ]*(\d+)/) || joined.match(/missing_n[=: ]*(\d+)/i);
  const okM = joined.match(/(\d+)\s*\/\s*(\d+)\s*✓/);
  const solid = hint?.screenSolid ?? (solidM ? Number(solidM[1]) : null);
  const read = hint?.readCount ?? (readM ? Number(readM[1]) : null);
  const autoAfter = hint?.autoAfter
    ?? (/auto_after[=: ]*true|新束後の自動.*✓|自動1回済/.test(joined) ? true
      : /auto_after[=: ]*false|新束後の自動未|自動未確認/.test(joined) ? false : null);
  const improveBn = hint?.improveBottleneckN
    ?? (() => {
      const m = joined.match(/一連[^\d]*段階\s*(\d+)/) || joined.match(/improve.*止[=: ]*段階?\s*(\d+)/i);
      return m ? Number(m[1]) : null;
    })();
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
      screenSolid: solid,
      autoAfter,
      readCount: read,
    },
    foundationMissingN: hint?.foundationMissingN ?? (missM ? Number(missM[1]) : null),
    foundationOkN: hint?.foundationOkN ?? (okM ? Number(okM[1]) : null),
    foundationTotalN: hint?.foundationTotalN ?? (okM ? Number(okM[2]) : null),
    keyFoundationFails: hint?.keyFoundationFails || null,
    linkLine: hint?.linkLine || null,
    readCount: read,
    autoAfter,
    screenSolid: solid,
    improveBottleneckN: improveBn,
    improveLine: hint?.improveLine || (improveBn != null ? `一連 止=段階${improveBn}` : null),
  });
  ev.unshift({
    label: "学習完成の道筋",
    value: complete.path_to_complete,
    guessed: !complete.ok,
  });
  ev.unshift({
    label: "学習完成（期間・土台・つながり・一連）",
    value: complete.line + (complete.ok ? "" : `／次=${complete.next_line}`),
    guessed: !complete.ok,
  });
  for (const p of complete.pillars) {
    ev.push({
      label: `学習完成・${p.name}`,
      value: `${p.ok ? "✓" : "✗"} ${p.line}${p.ok ? "" : `／次=${p.next}`}`,
      guessed: !p.ok,
    });
  }
  meeting.evidence = ev;
  if (!complete.ok && complete.bottleneck) {
    const agenda = [...(meeting.agenda || [])];
    if (!agenda.some((a) => /学習期間・土台・つながり・一連/.test(String(a.topic || "")))) {
      agenda.unshift({
        priority: 0,
        topic: "学習期間・土台・つながり・一連を完成させる",
        why: complete.bottleneck,
        decide: complete.path_to_complete,
      });
      meeting.agenda = agenda.slice(0, 8);
    }
  }
  return { ...adv, meeting };
}

/** 決定論の advice を Pro で判断。失敗時は元のまま＋why。meetOpts で Cursor 打合せ議題を渡せる */
export async function enrichSupervisorWithPro(
  adv: SupervisorAdvice,
  env: Record<string, string | undefined> = process.env,
  meetOpts?: SupervisorProMeetOpts | null,
): Promise<{ advice: SupervisorAdvice; usedPro: boolean; model: string | null; why: string | null }> {
  const bundleRaw = meetOpts?.bundle && typeof meetOpts.bundle === "object"
    ? meetOpts.bundle
    : null;
  const gateCtx: MeetingEvidenceGateContext = bundleRaw
    ? meetingGateContextFromSupervisorInput({
      site: "all",
      foundation_audit: bundleRaw.foundation_audit,
      bundle_reflect: bundleRaw.bundle_reflect,
      human_like: bundleRaw.human_like,
      improve_loop: bundleRaw.improve_loop,
      shot_gaps_normal: bundleRaw.shot_gaps_normal,
      shot_gaps: bundleRaw.shot_gaps,
      shot_bytes: bundleRaw.shot_bytes,
      shots: bundleRaw.shots,
      photo_kinds: bundleRaw.photo_kinds,
      image_match: bundleRaw.image_match,
      shot_rows: bundleRaw.shot_rows,
    }, "all")
    : { site: "all" };
  /** ★ Pro 前に束で写真到達を測り vision 根拠を補完（NULL＝写真無し誤報を防ぐ） */
  const advWithVision = bundleRaw ? ensureVisionPhotoReachEvidence(adv, bundleRaw) : adv;
  /** superviseLearn 後でも Pro 前に再度関所（本番薄い meeting 対策） */
  let advReady = ensureMeetingEvidenceGates(advWithVision, gateCtx);
  /** ★ 2026-11-18: 薄い本番 meeting でも思考骨格を載せてから Pro に渡す */
  advReady = ensureProThinkEvidence(advReady, meetOpts?.bundle || null);
  /** ★ 送付済み把握 × 取得タイミング（開始前と送付済詰まりを分けて測る） */
  advReady = ensureAcquireGraspEvidence(advReady, null);
  /** ★ 改善構築の志向（学習→仕組み→構築→自動反映） */
  advReady = ensureImproveConstructEvidence(advReady, meetOpts?.bundle || null);
  /** ★ 学習完成 4本柱（期間・土台・つながり・一連） */
  advReady = ensureCompleteChainEvidence(advReady, (() => {
    const fa = meetOpts?.bundle && (meetOpts.bundle as {
      foundation_audit?: {
        missing_n?: number;
        ok_n?: number;
        total?: number;
        screen_solid?: number;
        items?: Array<{ id?: string; ok?: boolean }>;
      };
      bundle_reflect?: { read_count?: number; auto_after?: boolean; line?: string; bottleneck?: string; screen_solid?: number };
      improve_loop?: { bottleneck_n?: number; improve_line?: string };
    }).foundation_audit;
    const br = meetOpts?.bundle && (meetOpts.bundle as {
      bundle_reflect?: { read_count?: number; auto_after?: boolean; line?: string; bottleneck?: string; screen_solid?: number };
    }).bundle_reflect;
    const loop = meetOpts?.bundle && (meetOpts.bundle as {
      improve_loop?: { bottleneck_n?: number; improve_line?: string };
    }).improve_loop;
    const items = fa?.items || [];
    const keyFails = items
      .filter((x) => x && x.ok === false && x.id && /F1_|F6_|F31_|F32_|F33_|F34_|F37_|F38_|F43_/.test(String(x.id)))
      .map((x) => String(x.id));
    return {
      foundationMissingN: fa?.missing_n ?? null,
      foundationOkN: fa?.ok_n ?? null,
      foundationTotalN: fa?.total ?? null,
      keyFoundationFails: keyFails,
      screenSolid: fa?.screen_solid ?? br?.screen_solid ?? null,
      readCount: br?.read_count ?? null,
      autoAfter: br?.auto_after ?? null,
      linkLine: br?.bottleneck || br?.line || null,
      improveBottleneckN: loop?.bottleneck_n ?? null,
      improveLine: loop?.improve_line ?? null,
    };
  })());
  /** ★ 原因思考・再学習・土台/連携抜け（録画+DB） */
  advReady = ensureCauseRelearnEvidence(advReady, {
    foundationMissingN: (() => {
      const fa = meetOpts?.bundle && (meetOpts.bundle as { foundation_audit?: { missing_n?: number; items?: Array<{ id?: string; ok?: boolean; line?: string; next?: string }> } }).foundation_audit;
      return fa?.missing_n ?? null;
    })(),
    foundationFails: (() => {
      const fa = meetOpts?.bundle && (meetOpts.bundle as { foundation_audit?: { items?: Array<{ id?: string; ok?: boolean; line?: string; next?: string }> } }).foundation_audit;
      const items = fa?.items || [];
      return items.filter((x) => x && x.ok === false && x.id).slice(0, 12).map((x) => ({
        id: String(x.id),
        line: x.line,
        next: x.next,
      }));
    })(),
  });
  const got = await askSupervisorPro(advReady, env, meetOpts);
  if (!got.ok) {
    // 失敗も根拠に残す（Proが動いていないのを隠さない）＋画像連携 step6 を✗に
    const meeting = { ...(adv.meeting || { today: [], agenda: [], questions: [], evidence: [] }) };
    const prevLink = (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link;
    if (prevLink) {
      const nextLink = markVisionProUsed(prevLink, false, got.model);
      (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link = nextLink;
      meeting.evidence = (meeting.evidence || [])
        .filter((e) => !/^画像学習→統括Pro連携$/.test(String(e.label || "")));
      meeting.evidence.unshift({
        label: "画像学習→統括Pro連携",
        value: nextLink.line,
        guessed: true,
      });
    }
    const evidence = [...(meeting.evidence || [])];
    if (got.brainPull) {
      evidence.unshift({
        label: "統括Pro RAG",
        value: got.brainPull.line,
        guessed: !got.brainPull.ok,
      });
    }
    evidence.unshift({
      label: "統括Pro",
      value: `未使用（${got.why}）／model=${got.model} → 決定論のみ`,
      guessed: false,
    });
    if (got.brainPull) {
      const link = buildKbProLink({
        brainPull: got.brainPull,
        foundationGaps: [],
        evidenceLabels: evidence.map((e) => String(e.label || "")),
        learningTaskKinds: (meeting.learning_tasks || []).map((t) => String(t?.kind || "")),
        today: meeting.today || [],
        hasCauseRelearn: evidence.some((e) => /原因→改善の再学習/.test(String(e.label || ""))),
        hasImproveConstruct: evidence.some((e) => /改善する仕組み|志向/.test(String(e.label || ""))),
        hasProThink: evidence.some((e) => /統括Pro思考骨格|画像学習はちゃんと/.test(String(e.label || ""))),
      });
      evidence.unshift({
        label: "設計知見↔統括Pro連携",
        value: link.line + (link.gaps[0] ? `／穴: ${link.gaps[0].what}` : ""),
        guessed: !link.ok,
      });
    }
    meeting.evidence = evidence.slice(0, 110);
    return { advice: { ...adv, meeting }, usedPro: false, model: got.model, why: got.why };
  }
  return {
    advice: mergeSupervisorPro(advReady, got.enrich, {
      model: got.model,
      usedPro: true,
      brainPull: got.brainPull,
      screenSolid: Math.max(
        countLearnedSolid(bundleRaw).solid,
        Number((bundleRaw as { foundation_audit?: { screen_solid?: number } } | null)?.foundation_audit?.screen_solid) || 0,
      ),
    }),
    usedPro: true,
    model: got.model,
    why: null,
  };
}
