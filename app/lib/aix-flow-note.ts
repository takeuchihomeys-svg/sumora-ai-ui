// app/lib/aix-flow-note.ts
// 「この会話で押した AIX と流れ」をブレインに渡す文を1か所で組む（純関数・DB 依存なし）。
//
// 2026-09-23 竹内「10回に一回のフル分析はどのAIXをつかったのか、どのような流れなのかも分析して
//   成約データを基に流れ踏まえて方向性を考えるようになっているのか」→「３はおこなう」
//
// 【実物】戦略の層（会話全体の戦略）は2つの経路で作られる:
//   ・ゼロから（3回に1回）: analyzeConversation の全項目の分析 → 押した AIX・流れ・成約の次打ちマップ・行動台帳を読む
//   ・普段の整理（3回に2回・実測 40会話）: 前回の戦略＋毎回の分析の要点＋セーブポイント＋プロフィール＋類似の成約パターン だけ。
//     要点の中の「AIX:」は**ブレインが提案した AIX**で、スタッフが実際に押した AIX ではない（提案と違うボタンを押すのは34%）。
//   → 普段の整理にも同じ材料を渡す。文は毎回の分析（analyzeConversation）と**同じ関数**で組む（四者同名）。
//
// 【中身】
//   【直近AIXアクション（新→旧順）】最新:… → 2回前:…（時刻・何時間前つき）
//   【成約実績・次打ちマップ】直近AIXが X の場合、成約会話では Y が N回…（aix_transition_stats＝成約会話の遷移の実測）
//   【⚠️ 自己ループ警告】property_check_result が2回以上連続した時だけ
//   【会話全体で使用済みのAIXアクション（回数と最後に押した時刻）】
//   ※ 文面は 2026-09-23 までの brain-core 内の組み立てをそのまま移した（動的ブロックなので変えてもキャッシュは割れないが、意味を変えない）

import { jstAgo, jstMDHm } from "./jst-date";

export type AixFlowLog = {
  aix_type: string | null;
  created_at: string;
  template_name?: string | null;
  check_pattern?: string | null;
};

/** from_aix_type → [{to, count}]（count 降順） */
export type AixTransitionMap = Record<string, Array<{ to: string; count: number }>>;

export function buildAixTransitionMap(rows: ReadonlyArray<{ from_aix_type: string; to_aix_type: string; count: number }>): AixTransitionMap {
  const map: AixTransitionMap = {};
  for (const row of rows) {
    if (!map[row.from_aix_type]) map[row.from_aix_type] = [];
    map[row.from_aix_type].push({ to: row.to_aix_type, count: row.count });
  }
  return map;
}

export type AixFlowNote = {
  /** 全体（会話に AIX が1つも無ければ pcrLoopWarning だけ＝通常は空文字） */
  text: string;
  /** 直近3件の並び（meta.last_aix_history にそのまま入る） */
  recentAixSeqText: string;
  /** property_check_result の連続警告（2回以上の時だけ） */
  pcrLoopWarning: string;
  /** この会話で使った種類（重複なし・新→旧） */
  usedAixTypes: string[];
};

/**
 * aixLogs は**新→旧**（brain-core の読み出し順）。
 * nowMs はテスト用（本番は今）。
 */
export function buildAixFlowNote(aixLogs: ReadonlyArray<AixFlowLog>, aixTransitionMap: AixTransitionMap, opts: { nowMs?: number } = {}): AixFlowNote {
  const agoText = (iso: string | null | undefined): string => jstAgo(iso, opts.nowMs ?? Date.now());
  const usedAixTypes = [...new Set(aixLogs.map((l) => l.aix_type).filter((t): t is string => Boolean(t)))];
  const aixUsageDigest = usedAixTypes.map((t) => {
    const rows = aixLogs.filter((l) => l.aix_type === t);
    const lastAt = rows[0]?.created_at ?? null;
    const when = lastAt ? `${jstMDHm(lastAt)}・${agoText(lastAt)}` : "時刻不明";
    return `${t}${rows.length > 1 ? `×${rows.length}回` : ""}（最後 ${when}）`;
  });
  const recentAixSeqText = aixLogs.slice(0, 3).length > 0
    ? `\n【直近AIXアクション（新→旧順）】${aixLogs.slice(0, 3).map((l, i) => `${i === 0 ? "最新" : `${i + 1}回前`}:${l.aix_type ?? "?"}${l.template_name ? `(${l.template_name})` : ""}${l.check_pattern ? `(結果:${l.check_pattern})` : ""}${l.created_at ? `[${jstMDHm(l.created_at)}・${agoText(l.created_at)}]` : ""}`).join(" → ")}`
    : "";
  let consecutivePcr = 0;
  for (const l of aixLogs) {
    if (l.aix_type === "property_check_result") consecutivePcr++;
    else break;
  }
  const pcrLoopWarning = consecutivePcr >= 2
    ? "\n【⚠️ 自己ループ警告（最重要）】property_check_result が直近" + consecutivePcr + "回連続しています。同じ物件の確認を繰り返しても会話が前進しません。次のアクションは必ず viewing_invite（内覧誘導）または estimate_sheet（見積書）にエスカレーションしてください。property_check_result の再選択は絶対禁止です。"
    : "";
  const lastAixType = aixLogs[0]?.aix_type ?? null;
  const transitions = lastAixType ? (aixTransitionMap[lastAixType] ?? []) : [];
  const nextActionMapText = lastAixType && transitions.length > 0
    ? `\n【成約実績・次打ちマップ】直近AIXが ${lastAixType} の場合、成約会話では${transitions.slice(0, 3).map((t) => `${t.to}が${t.count}回`).join("・")}。※推奨候補。会話の実態（顧客の返信内容・フェーズ制約・募集状況未確認での内覧誘導禁止）と「物件送付直後で顧客の反応待ちなら aix:null」ルールが常に優先。`
    : "";
  const text = (usedAixTypes.length > 0 || pcrLoopWarning)
    ? `${recentAixSeqText}${nextActionMapText}${pcrLoopWarning}\n【会話全体で使用済みのAIXアクション（回数と最後に押した時刻）】${aixUsageDigest.join(" / ")}\n※既に使用済みのアクションを再提案する場合は理由が必要。原則は次の段階のアクションを提案すること。ただし物件送付直後で顧客の反応がまだ無い場合は aix:null（何も提案しない）が正解。顧客の反応を待たずに viewing_invite 等へ先走らないこと。`
    : pcrLoopWarning;
  return { text, recentAixSeqText, pcrLoopWarning, usedAixTypes };
}

/**
 * 戦略の層（STRATEGY_SYSTEM）に足す1行。成約の典型順は brain-core の「黄金フロー」と同じ並びで、
 * 実データ（申込以降まで進んだ37会話の AIX 初出順: 物件送付1.57→オススメ2.41→物件確認2.74→見積3.00→内覧3.93→待合せ4.62→申込4.96）に合う。
 * 物件確認はお客様が物件を持ってきた時に入る（成約側の65.5%で3番目）。
 */
export const STRATEGY_FLOW_LINE =
  "- closing_strategy・next_steps は、成約の典型順（条件 → 物件送付 → オススメ →（お客様が物件を持ってきたら）募集状況の確認 → 見積書 → 内覧 → 待ち合わせ → 申込）と、"
  + "【この会話で押した AIX】【行動台帳】を踏まえて書く。既に押した AIX・既に伝えた事を Step にもう一度書かず、次の段階を書く。"
  + "【成約実績・次打ちマップ】は推奨候補で、直前に送った物への反応が無い間は待つ（先走らない）。";
