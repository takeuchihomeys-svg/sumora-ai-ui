// app/lib/brain-strategy-note.ts
// ブレインの判断（suggested_aix_meta）を「プロンプトに渡してよい形」に整える（純関数・DB 依存なし）。
//
// 2026-09-18 竹内「AIXテンプレートにはブレインちゃんととってるんかな？テンプレートよくわからん文生成されるから」
//
// 調査で分かったこと: ブレインは取れている（brainMeta=ok）。問題は**取れた後の渡し方**で、
// 返信AI（generate-reply）には竹内さんとの積み重ねで安全装置が入っているのに、
// テンプレート（aix-template-generate）は同じ材料を**生で、しかも「必ず入れろ」と強制**していた。
//
//   | 項目 | 返信AI | テンプレート（旧） |
//   |---|---|---|
//   | 古い判断 | 鮮度ゲートで落とす | 警告文を足してそのまま注入 |
//   | repeated_concern | 触れている時に「限り」・触れていなければ一切言及しない | 「橋渡し文で必ず拾う」 |
//   | latent_intent | 応え方を切替・先回りを剥がす | 「最低1つ本文に含めること」 |
//   | winning_pattern | WE DO 宣言1文に統合 | 「このパターンを応用すること」（生） |
//
// さらに repeated_concern は brain-core が**20字で機械的に切って**おり、実データの20字ちょうど5件は
// 全部途中で切れていた（「契約書類・手続きの確認（引き落とし口座書」「在籍証明が用意できない（審査書類不備の不」）。
// 切れた文字列を「必ず拾う」と渡せば、文が崩れて当たり前だった。
//
// 設計知見「入口は1つの関数にまとめる」「読む側は1つの整形関数を全員が使う（四者同名）」に従い、
// 整形（切れた文字列の扱い）と渡し方（鮮度・条件付き）をここに集約する。

// ── ① 切れた文字列を渡さない ───────────────────────────────────────────

/** 文の区切り（ここで切れば意味が残る） */
const BOUNDARY_CHARS = "・／/、。）】」』\n";
/** 助詞・接続で終わる＝文の途中 */
const MID_SENTENCE_RE = /(?:の|を|が|に|と|で|は|へ|や|も|から|まで|など|ため|より)$/;
/** 開いたまま閉じていない括弧 */
const OPEN_BRACKETS: Record<string, string> = { "（": "）", "(": ")", "「": "」", "『": "』", "【": "】", "［": "］", "[": "]" };

/** 閉じていない括弧が残っているか */
function hasUnclosedBracket(text: string): boolean {
  const stack: string[] = [];
  for (const ch of text) {
    if (OPEN_BRACKETS[ch]) stack.push(OPEN_BRACKETS[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
  }
  return stack.length > 0;
}

/**
 * 文の途中で切れている文字列か（＝そのままプロンプトに渡すと文が崩れる）。
 * ・閉じていない括弧が残っている
 * ・助詞・接続で終わっている
 * ・読点で終わっている
 */
export function isTruncatedText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (hasUnclosedBracket(t)) return true;
  if (/[、,]$/.test(t)) return true;
  return MID_SENTENCE_RE.test(t);
}

/**
 * 上限に収まるよう、**文の区切りで**切る（機械的な slice をやめる）。
 * 区切りが見つからない・切ると短すぎる（4字未満）時は null（渡さない方が安全）。
 */
export function truncateAtBoundary(text: string | null | undefined, limit: number): string | null {
  let out = (text ?? "").trim();
  if (!out) return null;

  // ① 閉じていない括弧は、その括弧ごと落とす（中身が途中で切れているため）。
  //    「契約書類・手続きの確認（引き落とし口座書」→「契約書類・手続きの確認」
  //    ※区切りで切るより先に行う（先に「・」で切ると「契約書類」まで縮んで意味が痩せる）
  out = dropUnclosedBracket(out);

  // ② 上限を超えていたら区切りまで戻す
  if (out.length > limit) {
    out = out.slice(0, limit);
    let cut = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (BOUNDARY_CHARS.includes(out[i])) { cut = i; break; }
    }
    if (cut >= 0) out = out.slice(0, /[、。）】」』]/.test(out[cut]) ? cut + 1 : cut);
    out = dropUnclosedBracket(out);
  }

  // ③ それでも文の途中で終わっているなら、最後の区切りまで戻す
  if (isTruncatedText(out)) {
    let cut = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (BOUNDARY_CHARS.includes(out[i])) { cut = i; break; }
    }
    if (cut >= 0) out = out.slice(0, /[、。）】」』]/.test(out[cut]) ? cut + 1 : cut);
  }

  out = out.replace(/[、,・／/\s]+$/, "").trim();
  if (out.length < 4 || isTruncatedText(out)) return null;
  return out;
}

/** 閉じていない括弧を、その開き括弧ごと落とす */
function dropUnclosedBracket(text: string): string {
  let out = text;
  while (out && hasUnclosedBracket(out)) {
    let open = -1;
    for (let i = out.length - 1; i >= 0; i--) if (OPEN_BRACKETS[out[i]]) { open = i; break; }
    if (open < 0) break;
    out = out.slice(0, open).replace(/[、,・／/\s]+$/, "").trim();
  }
  return out;
}

/** ブレインの短い語をプロンプトに渡す形にする（切れていれば縮める・縮められなければ渡さない） */
export function safeBrainPhrase(text: string | null | undefined, limit = 60): string | null {
  return truncateAtBoundary(text, limit);
}

// ── ② 渡し方（返信AI と同じ扱いに揃える）─────────────────────────────

/** 返信AI（generate-reply）と同じ軸: 「最新の顧客発言」に従属する項目は fresh の時だけ使う */
export const FRESH_DEPENDENT_FIELDS = [
  "customer_questions", "repeated_concern", "current_property",
  "condition_change_type", "hesitancy_pattern", "future_timeline",
  "latent_intent", "customer_emotion", "engagement_stance", "purchase_signal_level",
] as const;

export type BrainStrategyMeta = {
  closing_strategy?: string | null;
  reply_direction?: string | null;
  winning_pattern?: string | null;
  human_type_label?: string | null;
  checkpoint_stage?: string | null;
  reason?: string | null;
  template_hint?: string | null;
  recommended_tone?: string | null;
  key_topics?: string[] | null;
  avoid_topics?: string[] | null;
  urgency_appropriate?: boolean | null;
  // ── 鮮度従属 ──
  customer_questions?: string[] | null;
  repeated_concern?: string | null;
  current_property?: string | null;
  future_timeline?: string | null;
  latent_intent?: string | null;
  customer_emotion?: string | null;
  engagement_stance?: string | null;
  purchase_signal_level?: string | null;
  last_aix_history?: string | string[] | null;
};

export type BrainStrategyNoteOptions = {
  /** ブレインの判断が最新の顧客発言を見たものか（false＝古い＝鮮度従属を落とす） */
  fresh: boolean;
  /** ブレインが別のアクションを想定していた時、その日本語ラベル */
  otherActionLabel?: string | null;
  /** 今回押した AIX の日本語ラベル */
  actionLabel?: string | null;
  /** 再提案禁止の物件名 */
  ngPropertyLabels?: string[];
  /** 購買シグナルの言い換え表（呼び出し側の既存表をそのまま使う） */
  signalGuides?: Record<string, string>;
};

/** 「必ず入れろ」ではなく「今回の場面に関係する時だけ」に変える（創作を誘発しない言い方） */
const ONLY_IF_RELEVANT = "今回の場面に関係する時だけ本文で触れる（関係しなければ書かない）";

/**
 * ブレインの判断を AIX テンプレート生成の指示にする。
 * 返信AI（generate-reply の brainGuidanceNote）と同じ扱い:
 *  ・古い判断（fresh=false）では鮮度従属フィールドを**落とす**（警告を足して渡さない）
 *  ・「必ず含める」の強制をやめ、関係する時だけに条件付ける
 *  ・winning_pattern と closing_strategy は WE DO 宣言1文に統合する（生の行動計画を本文に流さない）
 *  ・途中で切れた文字列は渡さない（safeBrainPhrase）
 */
export function buildBrainStrategyNote(meta: BrainStrategyMeta | null | undefined, o: BrainStrategyNoteOptions): string {
  if (!meta) return "";
  const L: string[] = [];
  L.push("━━━━━━━━━━━━━━━━━━━━");
  L.push("【🧠 Brain戦略 — 生成の方向性】");
  L.push("━━━━━━━━━━━━━━━━━━━━");
  if (!o.fresh) {
    L.push("⚠️ この戦略は最新のお客様の発言より前の分析。会話履歴と矛盾する場合は会話履歴を優先すること");
  }
  if (o.otherActionLabel && o.actionLabel) {
    L.push(`⚠️ Brainは別アクション（${o.otherActionLabel}）推奨時点の戦略。今回のボタン種別（${o.actionLabel}）と矛盾する指示は無視すること`);
  }

  // ── 戦略（会話全体のもの。古くても使える＝返信AI と同じ扱い）──
  const wp = safeBrainPhrase(meta.winning_pattern, 120);
  const cs = safeBrainPhrase(meta.closing_strategy, 200);
  // 2026-09-18: winning_pattern は「鍵受け渡し最短時間を管理会社に確認し…」のような**スタッフの行動計画**。
  //   生のまま「応用しろ」と渡すと、お客様向けの文に社内の段取りが混ざる。返信AI と同じく WE DO 宣言1文に統合する
  if (wp && cs) {
    L.push(`・勝ちパターン×成約戦略: 【勝ちパターン】${wp} ／ 【成約戦略】${cs} → 両者を統合した1アクションを「〜させて頂きます！！」の形の宣言で**1文だけ**入れる（社内の段取り＝管理会社への確認・調整の手順はお客様向けの文に書かない）`);
  } else if (wp) {
    L.push(`・勝ちパターン: ${wp} → このパターンに沿った1アクションを「〜させて頂きます！！」の形の宣言で**1文だけ**入れる（社内の段取りはそのまま書かない）`);
  } else if (cs) {
    L.push(`・成約戦略: ${cs} → この戦略の核になる1アクションを「〜させて頂きます！！」の形の宣言で**1文だけ**入れる`);
  }
  const rd = safeBrainPhrase(meta.reply_direction, 200);
  if (rd) L.push(`・返信方向: ${rd}`);
  if (meta.checkpoint_stage) L.push(`・チェックポイント: ${meta.checkpoint_stage}`);
  const reason = safeBrainPhrase(meta.reason, 60);
  if (reason) L.push(`・Brainの判断理由: ${reason}`);
  if (meta.template_hint) L.push(`・Brainのテンプレヒント（推奨カテゴリ）: ${meta.template_hint}`);
  if (meta.human_type_label) L.push(`・顧客タイプ: ${meta.human_type_label}`);
  if (meta.recommended_tone) L.push(`・推奨トーン: ${meta.recommended_tone}（トーンにだけ反映する。気持ちを代弁・同調する文は書かない）`);

  const keyTopics = (meta.key_topics ?? []).map((t) => safeBrainPhrase(t, 40)).filter((t): t is string => !!t);
  if (keyTopics.length) L.push(`・主要トピック: ${keyTopics.join("・")} → ${ONLY_IF_RELEVANT}`);
  if (meta.avoid_topics?.length) L.push(`・禁止話題（絶対に触れない）: ${meta.avoid_topics.join("・")}`);
  if (meta.urgency_appropriate === false) {
    L.push("・緊急・煽り表現（「早い者勝ち」「お早めに」等）は使用禁止（この会話では不適切と判定済み）");
  }

  // ── 鮮度従属（返信AI と同じく fresh の時だけ）──
  if (o.fresh) {
    const emotion = safeBrainPhrase(meta.customer_emotion, 40);
    if (emotion) L.push(`・顧客感情: ${emotion}（トーンにだけ反映する）`);
    if (meta.purchase_signal_level) {
      const guide = o.signalGuides?.[meta.purchase_signal_level];
      L.push(`・購買シグナル強度: ${meta.purchase_signal_level}${guide ? `（${guide}）` : ""}`);
    }
    if (meta.engagement_stance) {
      L.push(`・局面スタンス: ${meta.engagement_stance}${meta.engagement_stance === "wait"
        ? "（今は押してはいけない局面 — 申込・内覧の強いCTAは入れず、不安解消と情報提供にとどめる）"
        : "（押してよい局面 — 次の一歩を明確に促す）"}`);
    }
    const prop = safeBrainPhrase(meta.current_property, 60);
    if (prop) L.push(`・注目物件: ${prop}`);
    // 2026-09-18: 旧「この動機・不安を解消する訴求を最低1つ本文に含めること」は
    //   「〇〇の1文を添えろ」型の強制指示＝創作の入口（feedback_no_invented_phrases）。判断材料に下げる
    const latent = safeBrainPhrase(meta.latent_intent, 120);
    if (latent) L.push(`・潜在動機（裏の不安）: ${latent} → **訴求の選び方の判断にだけ使う**。不安の言葉そのもの・気持ちの代弁は本文に書かない`);
    const timeline = safeBrainPhrase(meta.future_timeline, 60);
    if (timeline) L.push(`・入居希望タイムライン: ${timeline}`);
    // 2026-09-18: repeated_concern は会話全体の論点であって「今回の発言が懸念だ」ではない（返信AI と同じ扱い）
    const concern = safeBrainPhrase(meta.repeated_concern, 60);
    if (concern) L.push(`・会話全体を通じた関心事: このお客様は会話全体で「${concern}」を繰り返し確認している（※会話の論点であって「今回が懸念だ」という意味ではない）→ 今回の場面がこの論点に触れている時に**限り**事実で答える。触れていなければ**一切言及しない**`);
    const questions = (meta.customer_questions ?? []).map((q) => safeBrainPhrase(q, 40)).filter((q): q is string => !!q);
    if (questions.length) L.push(`・お客様が質問していること:\n${questions.map((q) => `  ・${q}`).join("\n")}\n  → ${ONLY_IF_RELEVANT}`);
  }

  if (meta.last_aix_history) {
    const hist = Array.isArray(meta.last_aix_history) ? meta.last_aix_history.join(" → ") : meta.last_aix_history;
    if (hist) L.push(`・直前のAIX履歴: ${hist}`);
  }
  if (o.ngPropertyLabels?.length) {
    L.push(`・再提案禁止物件（既に送付済み・NG — 絶対に再度オススメしない）: ${o.ngPropertyLabels.join("、")}`);
  }
  L.push("※Brain戦略の各項目（行動パターン・潜在動機等）は本文中でそのままラベル名・分析の言葉を転記しない。訴求の判断根拠として使い、物件・場面と結びつけた言い方にする。");
  return L.join("\n") + "\n\n";
}

/** ログ・監査用（何を渡して何を落としたか） */
export function describeBrainStrategyNote(meta: BrainStrategyMeta | null | undefined, o: { fresh: boolean }): string {
  if (!meta) return "brain=none";
  const dropped: string[] = [];
  if (!o.fresh) dropped.push("fresh_dependent");
  for (const [k, v] of [["repeated_concern", meta.repeated_concern], ["latent_intent", meta.latent_intent], ["winning_pattern", meta.winning_pattern]] as const) {
    if (v && !safeBrainPhrase(v, 120)) dropped.push(`${k}:truncated`);
  }
  return `brain=ok fresh=${o.fresh}${dropped.length ? ` dropped=${dropped.join(",")}` : ""}`;
}
