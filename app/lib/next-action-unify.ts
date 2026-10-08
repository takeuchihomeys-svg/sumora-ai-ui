// app/lib/next-action-unify.ts
// 「次の一手の提案」（/api/suggest-next-action）をブレインの判断に一本化する部品（純関数・依存なし・画面とサーバーの共用）
//
// 2026-10-08 竹内さん「一本化する」: 次の一手の LLM（Haiku・本番7日 735回・$3.03＝月 約$13）をやめ、AIX の推しはブレインの判断だけにする。
//   決まり（feedback_brain_owns_aix）: AIX が要るか・どの AIX かはブレインだけが判断する。
//   点検で分かった事:
//   - 帯（P8）はブレインと同じ AIX の時だけ出る＝LLM の答えは帯に何も足していなかった
//   - テンプレート一覧の「💡〇〇がオススメ」・推奨カテゴリ・色・推奨テンプレの順番は、ブレインを見ずに LLM／固定ルールの答えをそのまま出していた＝決まりとずれ
//   - 学習の記録（aix_usage_logs.suggested_action）は 9/27 からブレインの値。aix-shadow-eval は使われていない予想の当たり率を測っていただけ
//   直し:
//   ① LLM の段（ai_fallback）は既定で呼ばない（SUGGEST_NEXT_ACTION_LLM=on で戻す）。ルールの段・DB の集計（templateRec・sub_mode_stats）はそのまま
//   ② テンプレート一覧の 💡・カテゴリ・色・推奨テンプレの順番は、ブレインの判断の AIX（帯と同じ値 aixView.brainAixAction）から引く。AIX なし＝出さない
//   ③ 画面の重ね呼び（同じ会話・同じ最新のお客様の発言・同じ last_aix・同じ空室・同じ最後の送り手）は前の結果を使い回す
//   ④ aix-shadow-eval はブレインの値（aix_usage_logs.suggested_action）を測る形にする（API も LLM も呼ばない）
//   ⑤ 次の一手の前置きの温め（suggest_next_action_warm）も LLM を止めている間は温めない

/** 「on」「1」「true」の時だけ true（既定は off） */
export function isOnSwitch(v: string | null | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "on" || s === "1" || s === "true";
}

/** 次の一手の LLM（Haiku・ai_fallback）を呼ぶか。既定は呼ばない。戻す: SUGGEST_NEXT_ACTION_LLM=on */
export function suggestNextActionLlmEnabled(envValue: string | null | undefined): boolean {
  return isOnSwitch(envValue);
}

// ─────────────────────────────────────────────────────────────
// ② テンプレート一覧の「💡〇〇がオススメ」をブレインの判断から引く
// ─────────────────────────────────────────────────────────────

/** 物件確認した（property_check_result）の確認先 → テンプレートのカテゴリ（page.tsx の templateCategoryForLatestAix と同じ分け方） */
export function checkPatternTemplateCategory(checkPattern: string | null | undefined): string | undefined {
  const cp = checkPattern ?? "";
  if (cp === "nearby_parking") return "近隣の月極駐車場を確認した【AIX】";
  if (cp === "owner_other") return "オーナーに確認した【AIX】";
  if (cp.startsWith("mgmt_") || cp === "vacate_date") return "管理会社に確認した【AIX】";
  return undefined;
}

export type TemplateRec = {
  recommended_template_id?: string | null;
  recommended_template_sequence?: Array<{ id: string; seq: number }> | null;
};

export type BrainTemplateSuggestion = {
  category?: string;
  color?: string;
  label?: string;
  priorityTemplateIds?: string[];
};

/**
 * ブレインの判断の AIX → テンプレート一覧の推し（カテゴリ・色・💡の文・推奨テンプレの順番）。
 * brainAction が無い（ブレインが「AIX なし」・古い判断）なら全部 undefined（💡 を出さない）。
 * actionMeta は page.tsx の AIX_ACTION_META（画面の表の1か所を渡す）。
 * buttonLabel: 画面のボタンの名前（brainAixButtonLabel の「AIX 」を外した物）。確認した（条件・交渉）を分けて出すのに使う。
 * recByAction: /api/suggest-next-action が返す AIX ごとの推奨テンプレ（template_rec_by_action）。無ければ順番は出さない。
 */
export function brainTemplateSuggestion(input: {
  brainAction: string | null | undefined;
  checkPattern?: string | null;
  buttonLabel?: string | null;
  actionMeta: Record<string, { label: string; color: string; templateCategory: string }>;
  recByAction?: Record<string, TemplateRec> | null;
}): BrainTemplateSuggestion {
  const action = input.brainAction === "property_check" ? "property_check_result" : input.brainAction;
  if (!action) return {};
  const meta = input.actionMeta[action];
  if (!meta) return {};
  const cpCategory = action === "property_check_result" ? checkPatternTemplateCategory(input.checkPattern) : undefined;
  const category = cpCategory ?? (meta.templateCategory || undefined);
  const name = (input.buttonLabel ?? "").replace(/^AIX\s*/, "").trim() || meta.label;
  // 確認先が管理会社・オーナー・駐車場（別のカテゴリ）の時は、AIX ごとの推奨テンプレ（募集状況の確認の定番）を推さない
  const rec = cpCategory ? null : (input.recByAction?.[action] ?? null);
  const seq = rec?.recommended_template_sequence?.map((s) => s.id).filter(Boolean) ?? [];
  const single = rec?.recommended_template_id ?? null;
  const priorityTemplateIds = seq.length ? seq : single ? [single] : undefined;
  return { category, color: meta.color, label: `💡 ${name}がオススメ`, priorityTemplateIds };
}

/** ブレインの判断の check_pattern（同じ AIX の判断の物だけ。帯の判断と違う AIX の check_pattern は使わない） */
export function brainCheckPatternFor(
  brainAction: string | null | undefined,
  metas: Array<{ action?: string | null; check_pattern?: string | null } | null | undefined>,
): string | null {
  if (!brainAction) return null;
  const norm = (x: string | null | undefined) => (x === "property_check" ? "property_check_result" : x ?? null);
  for (const m of metas) {
    if (m && norm(m.action) === norm(brainAction) && m.check_pattern) return m.check_pattern;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ③ 重ね呼びの使い回し
// ─────────────────────────────────────────────────────────────

/** 使い回してよい時間（会話のステータスの変化等、鍵に入らない変化を拾うため長くはしない） */
export const NEXT_ACTION_REUSE_MS = 10 * 60 * 1000;

/**
 * 重ね呼びの鍵。サーバーの答えを決める物（最新のお客様の発言・最後の送り手・last_aix・空室・ステータス）が同じなら同じ鍵。
 * 最新のお客様の発言の時刻が分からない時は null（使い回さない）。
 */
export function nextActionFetchKey(i: {
  convId: string;
  latestCustomerTs: string | null | undefined;
  lastSender: string | null | undefined;
  lastAixAction: string | null | undefined;
  available: boolean | null | undefined;
  status?: string | null;
}): string | null {
  if (!i.convId || !i.latestCustomerTs) return null;
  const av = i.available === true ? "1" : i.available === false ? "0" : "-";
  return [i.convId, i.latestCustomerTs, i.lastSender ?? "-", i.lastAixAction ?? "-", av, i.status ?? "-"].join("|");
}

export type NextActionCacheEntry<T> = { key: string; at: number; value: T };

/** 前の結果を使い回せるか（同じ鍵・時間内）。使えれば値、使えなければ undefined */
export function reusableNextAction<T>(entry: NextActionCacheEntry<T> | undefined, key: string | null, nowMs: number, reuseMs = NEXT_ACTION_REUSE_MS): T | undefined {
  if (!entry || !key || entry.key !== key) return undefined;
  if (nowMs - entry.at > reuseMs || nowMs < entry.at) return undefined;
  return entry.value;
}

// ─────────────────────────────────────────────────────────────
// ④ aix-shadow-eval をブレインの値で測る
// ─────────────────────────────────────────────────────────────

/**
 * aix_usage_logs の1行 → ブレインの予想と当たり。
 * suggested_action はログを書く時に brain_decision_logs の押す前の一番新しい判断（48h）から入る（AIX なし＝"none"・判断なし＝null）。
 * 判断が無い行（null）は測らない（こちらから送った AIX 等）。"none" は「AIX なしと予想して外れた」として数える。
 * property_check は property_check_result の旧名なので同じ扱い。
 */
export function brainShadowEval(row: { aix_type: string; suggested_action: string | null }): { evaluated: false } | { evaluated: true; predicted: string | null; matched: boolean } {
  const s = row.suggested_action;
  if (s == null || s === "") return { evaluated: false };
  const predicted = s === "none" ? null : s;
  const norm = (x: string) => (x === "property_check" ? "property_check_result" : x);
  const matched = predicted !== null && norm(predicted) === norm(row.aix_type);
  return { evaluated: true, predicted, matched };
}

/** aix-shadow-eval の予想の出所。既定はブレイン。旧（suggest-next-action を呼ぶ）に戻す: AIX_SHADOW_PREDICTOR=suggest */
export function shadowPredictor(envValue: string | null | undefined): "brain" | "suggest" {
  return (envValue ?? "").trim().toLowerCase() === "suggest" ? "suggest" : "brain";
}
