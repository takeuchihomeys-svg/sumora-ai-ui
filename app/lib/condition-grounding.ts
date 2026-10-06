// app/lib/condition-grounding.ts（純関数・DB 依存なし）
// 条件の欄の希望エリアの語ごとに「根拠の発言」を辿る。根拠の無い語（お客様が条件として言っていない駅・区）を見つけるための物。
//
// 2026-09-30 竹内（黒明様の事例）「条件の欄の各項目に根拠の発言を持たせる／根拠の無い項目を見つけられるように」:
//   後で拡張の画面の見張り（screen-watch-expect）が「条件の欄にあるがお客様の発言に根拠が無い駅・区で検索した」を知らせるのに使う。
//   読み方（順番）:
//     ① 条件の変更履歴（property_condition_history）の source_message_id（"p4:<id>" 等・condition-history.ts conditionSourceTag）→ その発言
//     ② うちのフォーマット・最初の条件の原文（raw_format_text）の条件の部分
//     ③ お客様の発言（条件の部分だけ＝condition-source-gate.classifyConditionTurn の conditionText）
//     ④ 画面・拡張からの編集（source_message_id が "screen_edit"）＝人の判断（電話で聞いた等）が大半。根拠ありとして扱うが via で分ける
//   物件の問い合わせ・申込の書類・物件のスクショの中にだけある語は grounded=false（via="inquiry_only"）。
import { classifyConditionTurn, areaTokenCore, areaTokenGroundedIn, splitAreaTokens, type ConditionTurnKind } from "./condition-source-gate";
import { parseConditionSource } from "./condition-history";

export type GroundingMessage = { id: string; text: string | null; created_at?: string | null };
export type GroundingHistory = { changed_field: string; old_value: string | null; new_value: string | null; source_message_id: string | null; created_at?: string | null };

export type AreaTokenGrounding = {
  token: string;
  core: string;
  grounded: boolean;
  /** 根拠の種類 */
  via: "history_source" | "format" | "message" | "screen_edit" | "inquiry_only" | "none";
  messageId?: string;
  /** 根拠（または物件の話）の発言の種類 */
  kind?: ConditionTurnKind;
  excerpt?: string;
};

const cut = (s: string, n = 60) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

/**
 * 希望エリアの語ごとに根拠を辿る。customerMessages はお客様の発言（申込以降も読むだけなら入れてよい・古い順でも新しい順でもよい）。
 */
export function groundAreaTokens(input: {
  desiredArea: string | null | undefined;
  rawFormatText?: string | null;
  customerMessages: ReadonlyArray<GroundingMessage>;
  history?: ReadonlyArray<GroundingHistory>;
}): AreaTokenGrounding[] {
  const tokens = [...new Set(splitAreaTokens(input.desiredArea))];
  const msgs = input.customerMessages.map((m) => ({ ...m, turn: classifyConditionTurn(m.text ?? "") }));
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const formTurn = input.rawFormatText ? classifyConditionTurn(input.rawFormatText) : null;
  const hist = (input.history ?? []).filter((h) => h.changed_field === "desired_area");
  const out: AreaTokenGrounding[] = [];
  for (const token of tokens) {
    const core = areaTokenCore(token);
    const base = { token, core };
    // ① 履歴の根拠の発言（この語を足した行）
    const addRows = hist.filter((h) => splitAreaTokens(h.new_value).some((x) => areaTokenCore(x) === core) && !splitAreaTokens(h.old_value).some((x) => areaTokenCore(x) === core));
    let found: AreaTokenGrounding | null = null;
    for (const h of addRows) {
      const src = parseConditionSource(h.source_message_id);
      // 2026-10-06 画面の「元に戻す」（undo）・LINE の「元々の条件で」（restore）は前にあった値へ戻しただけ＝人の手直しと同じ扱い
      if (src.writer === "screen_edit" || src.writer === "undo" || src.writer === "restore") { found = { ...base, grounded: true, via: "screen_edit" }; break; }
      const m = src.messageId ? byId.get(src.messageId) : undefined;
      if (m && areaTokenGroundedIn(token, m.turn.conditionText)) { found = { ...base, grounded: true, via: "history_source", messageId: m.id, kind: m.turn.kind, excerpt: cut(m.turn.conditionText) }; break; }
    }
    if (found) { out.push(found); continue; }
    // ② 最初の条件の原文
    if (formTurn && areaTokenGroundedIn(token, formTurn.conditionText)) { out.push({ ...base, grounded: true, via: "format", kind: formTurn.kind, excerpt: cut(formTurn.conditionText) }); continue; }
    // ③ お客様の発言の条件の部分
    const hit = msgs.find((m) => m.turn.conditionText && areaTokenGroundedIn(token, m.turn.conditionText));
    if (hit) { out.push({ ...base, grounded: true, via: "message", messageId: hit.id, kind: hit.turn.kind, excerpt: cut(hit.turn.conditionText) }); continue; }
    // 物件の話・書類・スクショの中にだけある
    const inq = msgs.find((m) => m.turn.dropped.some((d) => areaTokenGroundedIn(token, d.text)));
    if (inq) { out.push({ ...base, grounded: false, via: "inquiry_only", messageId: inq.id, kind: inq.turn.kind, excerpt: cut(inq.turn.dropped.map((d) => d.text).join(" ")) }); continue; }
    if (formTurn && formTurn.dropped.some((d) => areaTokenGroundedIn(token, d.text))) { out.push({ ...base, grounded: false, via: "inquiry_only", kind: formTurn.kind, excerpt: cut(input.rawFormatText ?? "") }); continue; }
    out.push({ ...base, grounded: false, via: "none" });
  }
  return out;
}

/** 根拠の無い語だけ（screen-watch 等が「根拠の無い駅・区で検索した」を知らせる時に使う）。inquiry_only は物件の話にだけある＝混入の疑いが強い */
export function ungroundedAreaTokens(g: ReadonlyArray<AreaTokenGrounding>): AreaTokenGrounding[] {
  return g.filter((x) => !x.grounded);
}
