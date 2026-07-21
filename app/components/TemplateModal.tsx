"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchCalendarSlots, type CalendarDayResult } from "../lib/calendarSlots";

// iOS風スクロールホイールピッカー
function WheelPicker({ items, selectedIdx, onSelect }: {
  items: string[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ITEM_H = 36;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = selectedIdx * ITEM_H;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = useCallback(() => {
    if (!ref.current) return;
    const idx = Math.round(ref.current.scrollTop / ITEM_H);
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    ref.current.scrollTo({ top: clamped * ITEM_H, behavior: "smooth" });
    onSelect(clamped);
  }, [items.length, onSelect]);

  const handleScroll = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(settle, 200);
  };

  return (
    <div className="relative overflow-hidden" style={{ height: ITEM_H * 3 }}>
      <div className="pointer-events-none absolute inset-x-1" style={{ top: ITEM_H, height: ITEM_H, background: "rgba(21,101,192,0.08)", borderRadius: 8, borderTop: "1px solid #b3d9f7", borderBottom: "1px solid #b3d9f7" }} />
      <div
        ref={ref}
        onScroll={handleScroll}
        style={{ height: ITEM_H * 3, overflowY: "scroll", scrollSnapType: "y mandatory", scrollbarWidth: "none" }}
      >
        <div style={{ height: ITEM_H }} />
        {items.map((item, i) => (
          <div key={i} style={{ height: ITEM_H, scrollSnapAlign: "center" }} className={`flex items-center justify-center text-[14px] ${i === selectedIdx ? "font-bold text-[#1565C0]" : "text-[#aaa]"}`}>
            {item}
          </div>
        ))}
        <div style={{ height: ITEM_H }} />
      </div>
    </div>
  );
}

function lastDayOfMonth(month: number) {
  return new Date(new Date().getFullYear(), month, 0).getDate();
}

// 退去予定日ピッカー（月＋日の2カラム）
function VacatingDatePicker({ value, onChange }: {
  value: { month: number; day: number } | null;
  onChange: (date: { month: number; day: number } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentMonth = new Date().getMonth() + 1;
  const [selMonth, setSelMonth] = useState(value?.month ?? currentMonth);
  const [selDay, setSelDay]   = useState(value?.day   ?? 1);

  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
  const maxDay = lastDayOfMonth(selMonth);
  const days   = Array.from({ length: maxDay }, (_, i) => {
    const d = i + 1;
    return d === maxDay ? `${d}日（末日）` : `${d}日`;
  });

  const handleMonthSelect = (idx: number) => {
    const m = idx + 1;
    setSelMonth(m);
    const max = lastDayOfMonth(m);
    if (selDay > max) setSelDay(max);
  };

  const handleConfirm = () => {
    onChange({ month: selMonth, day: selDay });
    setOpen(false);
  };

  const displayValue = value
    ? `${value.month}月${value.day >= lastDayOfMonth(value.month) ? "末日" : `${value.day}日`}`
    : null;

  return (
    <div className="mb-3 rounded-xl border border-[#e0e8ff] bg-[#f0f5ff] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-[#5c6bc0]">退去予定日</span>
        {displayValue ? (
          <>
            <span className="text-[12px] font-bold text-[#1565C0]">{displayValue}</span>
            <button onClick={() => onChange(null)} className="text-[10px] text-[#aaa] underline">クリア</button>
          </>
        ) : (
          <span className="text-[10px] text-[#aaa]">未設定（日付なしで生成）</span>
        )}
        <button
          onClick={() => setOpen(v => !v)}
          className="ml-auto shrink-0 rounded-full bg-[#1565C0] px-2.5 py-0.5 text-[10px] font-bold text-white active:opacity-70"
        >{open ? "閉じる" : "設定"}</button>
      </div>

      {open && (
        <div className="mt-2 overflow-hidden rounded-xl border border-[#d0d8f7] bg-white">
          <div className="flex">
            <div className="flex-1 border-r border-[#e0e8f7]">
              <WheelPicker items={months} selectedIdx={selMonth - 1} onSelect={handleMonthSelect} />
            </div>
            <div className="flex-1">
              <WheelPicker key={selMonth} items={days} selectedIdx={Math.min(selDay - 1, days.length - 1)} onSelect={(i) => setSelDay(i + 1)} />
            </div>
          </div>
          <div className="flex border-t border-[#e0e8f7]">
            <button onClick={() => setOpen(false)} className="flex-1 py-2 text-[12px] text-[#aaa]">キャンセル</button>
            <button onClick={handleConfirm} className="flex-1 border-l border-[#e0e8f7] py-2 text-[12px] font-bold text-[#1565C0]">決定</button>
          </div>
        </div>
      )}
    </div>
  );
}

// "H:MM" / "HH:MM" → "HH:MM"（type="time" 用にゼロ埋め）
function padCalTime(t: string): string {
  const [h, m] = (t || "").split(":");
  return `${(h ?? "0").padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
}

// CalendarDayResult.label（"本日 7/12(日)"）→ "7月12日（日）"
function calDateLabel(label: string): string {
  const m = label.match(/(\d{1,2})\/(\d{1,2})\(?(.)\)?/);
  if (!m) return label;
  return `${parseInt(m[1], 10)}月${parseInt(m[2], 10)}日（${m[3]}）`;
}

interface CalendarDatePickerProps {
  templateText: string;           // 元テンプレートテキスト（[日程]を含む）
  customerName: string;
  onInsert: (resolvedText: string) => void;  // [日程]置換後のテキストを返す
}

// [日程]プレースホルダー付きテンプレート用カレンダーピッカー
// VacatingDatePickerと同じパターンで実装
function CalendarDatePicker({ templateText, customerName, onInsert }: CalendarDatePickerProps) {
  const [days, setDays]         = useState<CalendarDayResult[]>([]);
  const [loading, setLoading]   = useState(true);
  const [enabled, setEnabled]   = useState<boolean[]>([]);
  const [starts, setStarts]     = useState<string[]>([]);
  const [ends, setEnds]         = useState<string[]>([]);
  const [override, setOverride] = useState<boolean[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { days: d } = await fetchCalendarSlots();
        if (cancelled) return;
        setDays(d);
        setEnabled(d.map(x => !x.fullyBooked));
        setStarts(d.map(x => x.slots.length > 0 ? padCalTime(x.slots[0].split("〜")[0]) : "11:00"));
        setEnds(d.map(x => x.slots.length > 0 ? padCalTime(x.slots[x.slots.length - 1].split("〜")[1] ?? "18:00") : "18:00"));
        setOverride(d.map(() => false));
      } catch {
        if (!cancelled) setDays([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeIdx = days
    .map((_, i) => i)
    .filter(i => enabled[i] && (!days[i].fullyBooked || override[i]));

  const handleInsert = () => {
    const scheduleText = activeIdx
      .map(i => `${calDateLabel(days[i].label)} ${padCalTime(starts[i] ?? "11:00")}〜${padCalTime(ends[i] ?? "18:00")}`)
      .join("\n");
    let resolved = templateText.replace("[日程]", scheduleText);
    if (customerName) resolved = resolved.replace(/アカウント名/g, customerName);
    onInsert(resolved);
  };

  return (
    <div className="mb-3 rounded-xl border border-[#e0e8ff] bg-[#f0f5ff] px-3 py-2.5">
      <p className="mb-2 text-[11px] font-bold text-[#5c6bc0]">内覧可能日時（カレンダーから自動取得）</p>
      {loading ? (
        <div className="flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2.5 text-[12px] text-[#8696a0]">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#1565C0] border-t-transparent" />
          カレンダー読み込み中...
        </div>
      ) : days.length === 0 ? (
        <div className="rounded-xl bg-white/70 px-3 py-2 text-[12px] text-[#8696a0]">カレンダー情報を取得できませんでした</div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {days.map((d, i) => {
              const active = enabled[i] && (!d.fullyBooked || override[i]);
              return (
                <div key={i} className={`rounded-xl px-3 py-2 transition-all ${
                  d.fullyBooked
                    ? (override[i] ? "border border-[#b3d9f7] bg-white" : "bg-[#fdecea]")
                    : (enabled[i] ? "border border-[#b3d9f7] bg-white" : "bg-[#f0f2f5]")
                }`}>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (d.fullyBooked) {
                          setOverride(prev => { const n = [...prev]; n[i] = !n[i]; return n; });
                          setEnabled(prev => { const n = [...prev]; n[i] = true; return n; });
                        } else {
                          setEnabled(prev => { const n = [...prev]; n[i] = !n[i]; return n; });
                        }
                      }}
                      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-all ${
                        d.fullyBooked
                          ? (override[i] ? "bg-[#1565C0] text-white" : "bg-red-200 text-red-500")
                          : (enabled[i] ? "bg-[#1565C0] text-white" : "bg-[#d1d7db] text-[#8696a0]")
                      }`}
                    >{d.fullyBooked && !override[i] ? "×" : "○"}</button>
                    <span className={`flex-shrink-0 text-[12px] font-bold ${
                      active ? "text-[#1565C0]" : (d.fullyBooked && !override[i]) ? "text-red-400" : "text-[#54656f]"
                    }`}>{d.label}</span>
                    {d.fullyBooked && !override[i] && (
                      <span className="text-[10px] text-red-400">予定あり（タップで手動追加）</span>
                    )}
                  </div>
                  {active && (
                    <div className="mt-2 flex items-center gap-1.5 pl-7">
                      <input
                        type="time"
                        value={starts[i] ?? "11:00"}
                        onChange={(e) => setStarts(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                        className="rounded-lg border border-[#b3d9f7] bg-white px-2 py-1 text-[12px] font-bold text-[#1565C0] outline-none"
                      />
                      <span className="text-[12px] font-bold text-[#8696a0]">〜</span>
                      <input
                        type="time"
                        value={ends[i] ?? "18:00"}
                        onChange={(e) => setEnds(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                        className="rounded-lg border border-[#b3d9f7] bg-white px-2 py-1 text-[12px] font-bold text-[#1565C0] outline-none"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button
            onClick={handleInsert}
            disabled={activeIdx.length === 0}
            className="mt-2.5 w-full rounded-full py-2 text-[12px] font-bold text-white disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
          >この日程を挿入する</button>
        </>
      )}
    </div>
  );
}

export type StructureBlock = { label: string; text: string };

export interface Template {
  id: string;
  category: string;
  label: string;
  text: string;
  structure: StructureBlock[] | null;
  sort_order: number | null;
  use_count?: number | null;
  win_rate?: number | null;
  recommend_shown_count?: number | null;
  recommend_picked_count?: number | null;
  // H4: conversation_status 別の送信実績（calc-template-scene-stats cron が週1更新）
  status_pick_stats?: Record<string, number> | null;
  requires_image: boolean;
  second_msg_type: string | null;
  second_msg_delay: number | null;
}

interface AiTemplateCandidate {
  id: string;
  action_type: string;
  category: string;
  suggested_title: string;
  template_text: string;
  created_at: string;
  is_adopted: boolean;
  is_dismissed: boolean;
  source?: string;
  original_text?: string | null;
  // P1: 候補の根拠・同一編集パターンの観測回数
  reason?: string | null;
  evidence_count?: number | null;
  dismissed_reason?: string | null;
}

// P4: AIX機能改善提案（corpus2skill 週次Opusが生成 → aix_feature_suggestions テーブル）
// + aix_edit候補を統合するために拡張フィールドを追加
interface AixFeatureSuggestion {
  id: string;
  suggestion_type: string;
  action_type: string | null;
  suggested_title: string;
  description: string | null;
  reason: string | null;
  evidence_count: number | null;
  status: string;
  created_at: string;
  proposal_category?: 'new_aix_button' | 'new_picker' | 'new_button' | 'text_improvement' | 'mismatch_fix' | 'other';
  // auto-judge knowledge_question: { knowledge_id, original_content }
  implementation_notes?: string | null;
  // 統合フィールド: aix_edit候補をここに統合する際に付与
  _source?: 'aix_candidates' | 'suggestions';
  template_text?: string | null;
  original_text?: string | null;
  is_adopted?: boolean;
  is_dismissed?: boolean;
  category?: string;
}

// hypothesis ナレッジ（手動承認待ち → confirmed で AIX に注入される）
interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  category: string | null;
  conversation_state: string | null;
  importance: number | null;
  correct_count: number | null;
  wrong_count: number | null;
  apply_count: number | null;
  created_at: string;
}

// AI盲点フィードバック（corpus2skill 週次Opusが生成 → ai_feedback_items テーブル）
// 「❓ AI質問」タブで竹内さんが回答 → /api/ai-feedback がSonnetで知識化する
interface FeedbackItem {
  id: string;
  question: string;
  speculation: string | null;
  category: string | null;
  evidence: string | null;
  confidence: string | null;
  user_answer: string | null;
  status: string;
  applied_rule: string | null;
  created_at: string;
  answered_at: string | null;
}

// AI質問フェーズ: 英語キー → 日本語ラベル（question本文に埋め込まれた "フェーズ: xxx" を変換）
const AI_QUESTION_PHASE_LABELS: Record<string, string> = {
  viewing_invite:    "内見案内",
  viewing_confirm:   "内見後確認",
  initial_contact:   "初回接触",
  follow_up:         "フォローアップ",
  contract:          "契約手続き",
  first_reply:       "初回返信",
  hearing:           "ヒアリング",
  proposing:         "物件提案中",
  applying:          "申込",
  closed_won:        "成約済み",
  application:       "申込手続き",
  screening:         "審査中",
  viewing:           "内覧調整",
  property_search:   "物件検索中",
  condition_hearing: "条件ヒアリング",
  estimate_request:  "見積もり説明",
};

// AI質問カテゴリ: 英語キー → 日本語ラベル（question本文に埋め込まれた "category: xxx" を変換）
const AI_QUESTION_CATEGORY_LABELS: Record<string, string> = {
  pattern:    "パターン学習",
  rule:       "ルール",
  knowledge:  "ナレッジ",
  behavior:   "行動パターン",
  preference: "顧客傾向",
  flow:       "会話フロー",
  phrase:     "フレーズ",
  scene:      "シーン",
  general:    "一般",
};

// AI質問の表示整形: question本文からメタ情報（フェーズ・重要度・category）を抽出して返す
// [knowledge_id:UUID] タグは全箇所から除去、"フェーズ: xxx / 重要度: x" 行・"category: xxx" 行も取り除く
type AiQuestionMeta = {
  cleanText: string;
  phase: string | null;
  importance: number | null;
  embeddedCategory: string | null;
  aiDraftExample: string | null;
  staffSentExample: string | null;
};
function parseAiQuestion(question: string): AiQuestionMeta {
  // [knowledge_id:UUID] タグを全箇所から除去（先頭だけでなく本文内も）
  let text = question.replace(/\[knowledge_id:[^\]]+\]\n?/g, "");

  // "フェーズ: xxx / 重要度: x" 行を抽出して除去
  let phase: string | null = null;
  let importance: number | null = null;
  text = text.replace(/フェーズ[:：]\s*([A-Za-z_]+)\s*[/／]\s*重要度[:：]\s*(\d+)\s*/g, (_, p, i) => {
    phase = p.trim();
    importance = parseInt(i, 10);
    return "";
  });

  // "category: xxx" 行を抽出して除去（行単位）
  let embeddedCategory: string | null = null;
  text = text.replace(/^category[:：]\s*([A-Za-z_]+)\s*$/gm, (_, c) => {
    embeddedCategory = c.trim();
    return "";
  });

  // 【AI案】...【/AI案】 ブロックを抽出して除去（複数行対応）
  let aiDraftExample: string | null = null;
  text = text.replace(/【AI案】\n?([\s\S]*?)【\/AI案】\n?/g, (_, content) => {
    aiDraftExample = content.trim();
    return "";
  });

  // 【送信例】...【/送信例】 ブロックを抽出して除去（複数行対応）
  let staffSentExample: string | null = null;
  text = text.replace(/【送信例】\n?([\s\S]*?)【\/送信例】\n?/g, (_, content) => {
    staffSentExample = content.trim();
    return "";
  });

  return { cleanText: text.trim(), phase, importance, embeddedCategory, aiDraftExample, staffSentExample };
}

// 矛盾系質問テキストから新ルール・既存ルール・会話例ブロックを抽出する
type ContradictionContent = {
  newRuleBlock: string | null;
  oldRuleBlock: string | null;
  conversationBlock: string | null;
};
function parseContradictionContent(rawQuestion: string): ContradictionContent {
  // 新ルールブロック: 「━━ 【新しいルール（仮説）】━━」と次の「━━」の間
  const newRuleMatch = rawQuestion.match(/━━ 【新しいルール（仮説）】━━\n([\s\S]*?)(?=\n\n━━|$)/);
  const newRuleBlock = newRuleMatch ? newRuleMatch[1].trim() : null;

  // 既存ルールブロック: 「━━ 【既存のルール...】━━」と次の「━━」の間（HUMAN最優先バリアントも対応）
  const oldRuleMatch = rawQuestion.match(/━━ 【既存のルール[^━]*】━━\n([\s\S]*?)(?=\n\n━━|$)/);
  const oldRuleBlock = oldRuleMatch ? oldRuleMatch[1].trim() : null;

  // 会話例ブロック: 「━━ 今回の会話（実例）━━」と次の「━━」の間
  const convMatch = rawQuestion.match(/━━ 今回の会話（実例）━━\n([\s\S]*?)(?=\n\n━━|$)/);
  const conversationBlock = convMatch ? convMatch[1].trim() : null;

  return { newRuleBlock, oldRuleBlock, conversationBlock };
}

// ナレッジタイトルの内部タグ（[修正対比] [差分学習] [原則] [パターン] 等）を除去して表示用タイトルを返す
function cleanKnowledgeTitle(title: string): string {
  return title.replace(/^\[.*?\]\s*/, "").trim();
}

const FEEDBACK_CATEGORY_LABEL: Record<string, string> = {
  new_flow: "新フロー発見",
  missing_keyword: "未登録キーワード",
  weak_scene: "苦手な場面",
  new_aix_needed: "新AIXが必要",
  phrase_contamination: "使用条件の確認",
  knowledge_gap: "知識不足（AIの誤事実）",
  prompt_ambiguity: "プロンプト曖昧さ検知",
  adapt_feedback: "会話を合わせる（追加分析）",
  general: "一般",
};

const FEEDBACK_CONFIDENCE_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

// P5: 却下理由チップ（dismissed_reason に保存され corpus2skill 週次学習の材料になる）
const DISMISS_REASONS = [
  "既存テンプレで足りる",
  "文が不自然",
  "場面が違う",
  "情報が古い",
];

// 案D: 候補カードのカテゴリバッジ色（action_type → カラー）
const ACTION_TO_COLOR: Record<string, string> = {
  property_send: "#2196F3",
  property_check_result: "#059669",
  property_recommendation: "#7B1FA2",
  viewing_invite: "#9C27B0",
  estimate_sheet: "#D97706",
  follow_up: "#0891B2",
};
function getCategoryColor(actionType: string): string {
  return ACTION_TO_COLOR[actionType] ?? "#54656f";
}

// AIX候補レビューパネル: action_type → 日本語ラベル（/api/ai-template-review と同一定義）
const ACTION_LABELS: Record<string, string> = {
  property_send: "物件ピックアップ送り",
  property_check_result: "物件確認結果",
  viewing_invite: "内覧誘導",
  application_push: "申込み促進",
  greeting: "挨拶",
  acknowledge_check: "確認への返答",
  docs_request: "書類案内",
  meeting_place: "待ち合わせ",
  estimate_sheet: "見積書",
};

// AIX候補タブ: suggested_title の "[編集] " プレフィックスを表示時のみ除去（DBは変更しない）
function stripEditPrefix(title: string): string {
  return title.replace(/^\[編集\]\s*/, "");
}

// ズレ自動検出カード: action_type（conversationState / AIXステート）→ 人間が読める名前
// save-reply-example の registerAlignmentFix が入れる値を網羅する
// （新5段階フェーズ・旧ステート・AIXアクションステート・T02サブパターン）
const AIX_ACTION_LABELS: Record<string, string> = {
  ...ACTION_LABELS,
  // 新5段階フェーズ
  first_reply:  "初回返信フェーズ",
  hearing:      "ヒアリングフェーズ",
  proposing:    "物件提案中フェーズ",
  applying:     "申込フェーズ",
  closed_won:   "成約済みフェーズ",
  // 旧ステート（後方互換）
  condition_hearing:  "お部屋探し条件ヒアリング",
  property_search:    "物件検索中",
  viewing:            "内覧調整",
  estimate_request:   "見積もり説明",
  availability_check: "空室確認",
  application:        "申込手続き",
  screening:          "審査中",
  contract:           "契約手続き",
  // AIXボタン（AixModal の title と一致させる）
  property_send:          "物件ピックアップした",
  property_recommendation:"物件オススメ（1件特にオススメする）",
  property_check_result:  "物件確認した",
  estimate_sheet:         "見積書送る",
  viewing_invite:         "内覧へ！",
  application_push:       "申込へ！",
  meeting_place:          "待ち合わせ",
  acknowledge_check:      "確認します",
  followup_revive:        "追客する",
  greeting_viewing:       "内覧後の挨拶",
  // T02サブパターン（property_check_result）
  property_check_result_available:         "物件確認した（募集中）",
  property_check_result_unavailable:       "物件確認した（満室）",
  property_check_result_alternative:       "物件確認した（代替提案）",
  property_check_result_vacate_date:       "物件確認した（退去予定日）",
  property_check_result_mgmt_guarantor:    "物件確認した（保証人）",
  property_check_result_mgmt_move_in:      "物件確認した（入居日）",
  property_check_result_mgmt_initial_cost: "物件確認した（初期費用）",
  property_check_result_mgmt_parking:      "物件確認した（駐車場）",
  property_check_result_mgmt_pet:          "物件確認した（ペット）",
  // T02サブパターン（application_push / property_send）
  application_push_push:         "申込へ！（後押し）",
  application_push_confirm:      "申込へ！（意思確認）",
  application_push_docs_request: "申込へ！（書類依頼）",
  property_send_new_arrival:     "物件ピックアップした（新着）",
  property_send_widen:           "物件ピックアップした（条件拡大）",
};
function getAixActionLabel(actionType: string): string {
  return AIX_ACTION_LABELS[actionType] ?? actionType;
}

// ズレ自動検出カード: ズレの種類 → 日本語ラベル（save-reply-example の ALIGNMENT_DIFF_LABEL と同一定義）
const ALIGNMENT_MISMATCH_LABELS: Record<string, string> = {
  date_mismatch:   "日付のズレ",
  time_mismatch:   "時刻のズレ",
  number_mismatch: "数値のズレ",
  large_rewrite:   "大幅書き換え",
};

// ズレ自動検出カード: implementation_notes（JSON）から構造化データを取り出す
// 新形式（mismatch_type / ai_draft / sent_text / explanation）と
// 旧形式（diff_type / ai_text_preview / sent_text_preview）の両方に対応する
type AlignmentNotes = {
  mismatchLabel: string;
  aiDraft: string | null;
  sentText: string | null;
  similarity: number | null;
  explanation: string;
};
function parseAlignmentNotes(notes?: string | null): AlignmentNotes | null {
  const t = notes?.trim();
  if (!t || !t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    const str = (k: string): string | null => {
      const v = obj[k];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const mismatchType = str("mismatch_type") ?? str("diff_type");
    const aiDraft = str("ai_draft") ?? str("ai_text_preview");
    const sentText = str("sent_text") ?? str("sent_text_preview");
    if (!mismatchType && !aiDraft && !sentText) return null;
    return {
      mismatchLabel: str("mismatch_label")
        ?? (mismatchType ? (ALIGNMENT_MISMATCH_LABELS[mismatchType] ?? mismatchType) : "ズレ"),
      aiDraft,
      sentText,
      similarity: typeof obj.similarity === "number" ? obj.similarity : null,
      explanation: str("explanation")
        ?? "このズレを解消すればスタッフの手修正が不要になり、AIX生成の精度が上がります",
    };
  } catch {
    return null;
  }
}

// 改善案タブ: フィルターで使う表示カテゴリを導出する
// DBの proposal_category が 'other'・未知値（knowledge_quality等）でも、
// suggestion_type から正しいフィルター（①AIXボタン/②ピッカー/③ボタン追加/ズレ修正）に割り当てる。
// これがないと new_picker 提案が「②ピッカー」に出ず全部「その他」に落ちる。
const KNOWN_PROPOSAL_CATEGORIES = ['new_aix_button', 'new_picker', 'new_button', 'text_improvement', 'mismatch_fix'] as const;
function getEffectiveProposalCategory(s: AixFeatureSuggestion): string {
  const pc = s.proposal_category;
  if (pc && (KNOWN_PROPOSAL_CATEGORIES as readonly string[]).includes(pc)) return pc;
  switch (s.suggestion_type) {
    case "new_aix": return "new_aix_button";
    case "new_picker": return "new_picker";
    case "new_button": return "new_button";
    case "alignment_fix":
    case "mismatch_fix": return "mismatch_fix";
    default: return "other";
  }
}

// 改善案カード: implementation_notes から人間が読める要点を抽出する
// JSON（knowledge_aix_align の {knowledge_id, append_text} 等）はパースしてテキスト部分のみ、
// 自由テキストはそのまま返す。表示できる内容がなければ null。
function extractNotesSummary(notes?: string | null): string | null {
  const t = notes?.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const parts = ["append_text", "summary", "why", "reason", "expected_effect", "spec", "ai_text_preview", "sent_text_preview"]
        .map((k) => {
          const v = obj[k];
          return typeof v === "string" && v.trim() ? `${k === "ai_text_preview" ? "AI文: " : k === "sent_text_preview" ? "実送信: " : ""}${v.trim()}` : null;
        })
        .filter((v): v is string => v !== null);
      return parts.length > 0 ? parts.join("\n") : null;
    } catch { /* JSONでなければそのまま表示 */ }
  }
  return t;
}

// 改善案タブ: suggestion_type → バッジのラベル・色
const SUGGESTION_TYPE_BADGE: Record<string, { label: string; className: string }> = {
  new_aix: { label: "新AIX", className: "bg-purple-50 text-purple-600" },
  new_picker: { label: "新ピッカー", className: "bg-blue-50 text-blue-600" },
  new_button: { label: "新ボタン", className: "bg-green-50 text-green-600" },
  new_sub_mode: { label: "新サブモード", className: "bg-orange-50 text-orange-600" },
  alignment_fix: { label: "ズレ自動検出", className: "bg-red-50 text-red-600" },
};

interface TemplateModalProps {
  onClose: () => void;
  onSelect?: (text: string, imageFiles?: File[], label?: string, category?: string, secondMsg?: { type: string; delay: number } | null, templateId?: string, wasAdapted?: boolean, recommendedRank?: number | null) => void;
  onOpenAixWithFocus?: (focusPoints: string[], templateInfo?: { id?: string; name: string; category: string; structure?: Array<{ label: string; text: string }>; sample?: string; secondMsg?: { type: string; delay: number } | null }) => void;
  /** 親からのキャッシュデータ（提供されれば即時表示・背景で再検証） */
  initialTemplates?: Template[];
  /** テンプレ一覧更新時に親のキャッシュを更新するコールバック */
  onCacheUpdate?: (templates: Template[]) => void;
  /** 親が管理するテンプレ一覧（SSoT）。渡された場合モーダル側ではfetchしない */
  templates?: Template[];
  /** テンプレ追加・採用・更新・削除後に親へ再取得を通知するコールバック */
  onRefresh?: () => void;
  customerName?: string;
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
  linkedCustomer?: { id: string; name: string; conditions: string };
  initialCategory?: string;
  highlightKeyword?: string;
  highlightLabel?: string;
  suggestedCategory?: string;   // suggest-next-action由来の推薦カテゴリ
  suggestedColor?: string;      // アクション別カラー（hex）
  suggestedLabel?: string;      // バッジテキスト
  // 予約送信待ちのAIXメッセージ（物件情報の読み取り元）
  pendingScheduledMessages?: Array<{ text: string | null }>;
  // 今日スタッフがすでに送信済みか（挨拶切り替えに使用）
  staffMessagedToday?: boolean;
  // 開いた時に検索をプリセットする（新着フィルター等）
  initialSearch?: string;
  // AIX送信後（post_aix）に開かれた場合のコンテキスト。AIおすすめテンプレのハイライトに使用
  postAixContext?: {
    conversationId: string;
    actionType: string;
    sentMessage: string;
  };
  // 会話ID（テンプレート選択ログ記録用）
  conversationId?: string;
  // CHAIN-1/CHAIN-2: suggest-next-action 由来の推奨テンプレID配列（送る順番の定番シーケンス）。
  // 配列順で最上位に昇格し、1番目に「🎯 この流れの定番」、2番目以降に「📋 次に続けて送ることが多い」バッジを表示する
  priorityTemplateIds?: string[] | null;
}

const AVAIL_CHECK_TYPES = [
  { key: "物件あった",         color: "#059669" },
  { key: "別の部屋",           color: "#1565C0" },
  { key: "物件なかった",       color: "#DC2626" },
  { key: "入居日確認した",     color: "#D97706" },
  { key: "室内写真を確認した", color: "#7C3AED" },
] as const;

function getAvailCheckTag(label: string): string | null {
  for (const { key } of AVAIL_CHECK_TYPES) {
    if (label.startsWith(`【${key}】`)) return key;
  }
  return null;
}

function stripAvailCheckTag(label: string): string {
  for (const { key } of AVAIL_CHECK_TYPES) {
    if (label.startsWith(`【${key}】`)) return label.slice(`【${key}】`.length);
  }
  return label;
}

const AIX_PURPOSE_TAGS = [
  { key: "内覧誘導", color: "#1565C0" },
  { key: "申込誘導", color: "#7B1FA2" },
] as const;

const SECOND_MSG_TYPES = [
  { key: "内覧誘導", color: "#059669", text: "[お客様名]ご都合よろしいお日にちにご案内させて頂きます😊！！" },
  { key: "申込誘導", color: "#7B1FA2", text: "[お客様名]さんお気に召されましたらお申込みしお部屋抑えさせて頂きます！！\nお手隙の際にご査収ください😌！！" },
] as const;

const SECOND_MSG_DELAYS = [15, 30, 60] as const;

function getAixPurposeTag(label: string): string | null {
  for (const { key } of AIX_PURPOSE_TAGS) {
    if (label.startsWith(`【${key}】`)) return key;
  }
  return null;
}

function stripAixPurposeTag(label: string): string {
  for (const { key } of AIX_PURPOSE_TAGS) {
    if (label.startsWith(`【${key}】`)) return label.slice(`【${key}】`.length);
  }
  return label;
}

function inferAvailCheckType(label: string): string | null {
  const tag = getAvailCheckTag(label);
  if (tag) return tag;
  if (/別の部屋|2番手/.test(label)) return "別の部屋";
  if (/物件なし|物件なかった/.test(label)) return "物件なかった";
  if (/入居日|退去日/.test(label)) return "入居日確認した";
  if (/写真/.test(label)) return "室内写真を確認した";
  return "物件あった";
}

const PROPERTY_SEND_SUB_TYPES = [
  { key: "初回まとめ",     color: "#2196F3" },
  { key: "新着まとめ",     color: "#4CAF50" },
  { key: "条件広げまとめ", color: "#FF9800" },
  { key: "代替物件送り",   color: "#9C27B0" },
] as const;

const VIEWING_SUB_TYPES = [
  { key: "通常内覧", color: "#9C27B0" },
  { key: "日程変更", color: "#E53935" },
] as const;

function getPropertySendSubTag(label: string): string | null {
  for (const { key } of PROPERTY_SEND_SUB_TYPES) {
    if (label.startsWith(`【${key}】`)) return key;
  }
  return null;
}
function stripPropertySendSubTag(label: string): string {
  for (const { key } of PROPERTY_SEND_SUB_TYPES) {
    if (label.startsWith(`【${key}】`)) return label.slice(`【${key}】`.length);
  }
  return label;
}
function getViewingSubTag(label: string): string | null {
  for (const { key } of VIEWING_SUB_TYPES) {
    if (label.startsWith(`【${key}】`)) return key;
  }
  return null;
}
function stripViewingSubTag(label: string): string {
  for (const { key } of VIEWING_SUB_TYPES) {
    if (label.startsWith(`【${key}】`)) return label.slice(`【${key}】`.length);
  }
  return label;
}

export default function TemplateModal({
  onClose, onSelect, onOpenAixWithFocus, customerName, conversationState, recentMessages, linkedCustomer, initialCategory, highlightKeyword, highlightLabel, suggestedCategory, suggestedColor, suggestedLabel, pendingScheduledMessages, staffMessagedToday, initialSearch,
  initialTemplates, onCacheUpdate, templates: templatesProp, onRefresh, postAixContext, conversationId, priorityTemplateIds,
}: TemplateModalProps) {
  const [templates, setTemplates] = useState<Template[]>(templatesProp ?? initialTemplates ?? []);
  // UX改善④: alert() の代替。モーダル上部にトースト表示して4秒で自動消去（モバイルでブロッキングしない）
  const [modalError, setModalError] = useState<string | null>(null);
  const modalErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showModalError = useCallback((msg: string) => {
    setModalError(msg);
    if (modalErrorTimerRef.current) clearTimeout(modalErrorTimerRef.current);
    modalErrorTimerRef.current = setTimeout(() => setModalError(null), 4000);
  }, []);
  useEffect(() => () => { if (modalErrorTimerRef.current) clearTimeout(modalErrorTimerRef.current); }, []);
  // 成功トースト（緑・4秒で自動消去）
  const [modalSuccess, setModalSuccess] = useState<string | null>(null);
  const modalSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showModalSuccess = useCallback((msg: string) => {
    setModalSuccess(msg);
    if (modalSuccessTimerRef.current) clearTimeout(modalSuccessTimerRef.current);
    modalSuccessTimerRef.current = setTimeout(() => setModalSuccess(null), 4000);
  }, []);
  useEffect(() => () => { if (modalSuccessTimerRef.current) clearTimeout(modalSuccessTimerRef.current); }, []);
  // 親からのデータ（props/キャッシュ）があれば即時表示、なければローディング表示
  const [loading, setLoading] = useState(!templatesProp && (!initialTemplates || initialTemplates.length === 0));
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  const [category, setCategory] = useState(initialCategory || "全般");
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState(initialSearch ?? "");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState("全般");
  const [newText, setNewText] = useState("");
  const [newRequiresImage, setNewRequiresImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [adaptingId, setAdaptingId] = useState<string | null>(null);
  const [adaptedTexts, setAdaptedTexts] = useState<Record<string, string>>({});
  const [adaptErrors, setAdaptErrors] = useState<Record<string, string>>({});
  const [displaySource, setDisplaySource] = useState<Record<string, "extracted" | "adapted" | "raw">>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editRequiresImage, setEditRequiresImage] = useState(false);
  const [editStructure, setEditStructure] = useState<StructureBlock[]>([]);
  const [structureViewId, setStructureViewId] = useState<string | null>(null);
  const [sampleViewIds, setSampleViewIds] = useState<Set<string>>(new Set());
  const [editSaving, setEditSaving] = useState(false);
  const [noEmoji, setNoEmoji] = useState(false);
  const [aixPurposeFilter, setAixPurposeFilter] = useState<"内覧" | "申込" | null>(null);
  const [availCheckFilter, setAvailCheckFilter] = useState<string | null>(null);
  const [propertySendSubFilter, setPropertySendSubFilter] = useState<string | null>(null);
  const [viewingSubFilter, setViewingSubFilter] = useState<string | null>(null);
  const [editAvailCheckType, setEditAvailCheckType] = useState<string | null>(null);
  const [editAixPurposeTag, setEditAixPurposeTag] = useState<string | null>(null);
  const [editPropertySendSub, setEditPropertySendSub] = useState<string | null>(null);
  const [editViewingSub, setEditViewingSub] = useState<string | null>(null);
  const [editSecondMsgType, setEditSecondMsgType] = useState<string | null>(null);
  const [editSecondMsgDelay, setEditSecondMsgDelay] = useState<number | null>(null);
  const [aixKeywordFilter, setAixKeywordFilter] = useState('');
  const [vacatingDates, setVacatingDates] = useState<Record<string, { month: number; day: number } | null>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [templateImages, setTemplateImages] = useState<Record<string, File[]>>({});
  const [templateImagePreviews, setTemplateImagePreviews] = useState<Record<string, string[]>>({});
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [extractedTexts, setExtractedTexts] = useState<Record<string, string>>({});
  const [extractErrors, setExtractErrors] = useState<Record<string, string>>({});
  const addFormRef = useRef<HTMLDivElement | null>(null);
  const templateImageInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const categoryTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const categoryScrollRef = useRef<HTMLDivElement | null>(null);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const categoryEditInputRef = useRef<HTMLInputElement | null>(null);
  // 推薦/ハイライトカードへの自動スクロールを1回に制限
  const hasScrolled = useRef(false);
  // AIXカテゴリ: テンプレートカードごとの訴求ポイント選択状態
  const [focusPointsMap, setFocusPointsMap] = useState<Record<string, string[]>>({});
  const [soloEntry, setSoloEntry] = useState(false);
  // AIXテンプレート候補タブ
  const [isCandidateTabActive, setIsCandidateTabActive] = useState(false);
  // AIX候補サブタブ: "all" = 全候補（従来のAIXテンプレ候補タブ）, "aix_edit" = スタッフ編集候補のみ,
  // "suggestions" = P4 AIX改善案（aix_feature_suggestions）, "feedback" = AI盲点フィードバック（ai_feedback_items）
  const [candidateSubTab, setCandidateSubTab] = useState<"all" | "suggestions" | "feedback" | "knowledge" | "rules">("all");
  const [candidates, setCandidates] = useState<AiTemplateCandidate[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  // 採用前ブラッシュアップチャット: 対象候補・会話履歴・現在の提案テキスト・入力欄
  const [reviewCandidate, setReviewCandidate] = useState<AiTemplateCandidate | null>(null);
  const [reviewMessages, setReviewMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [reviewCurrentText, setReviewCurrentText] = useState(""); // Opusが最後に提案した修正版
  const [reviewInput, setReviewInput] = useState("");
  const [reviewSending, setReviewSending] = useState(false);
  // 改善案打ち合わせパネル: 改善案候補をOpus 4.8と打ち合わせて実装仕様を固め aix_feature_suggestions へ転送する
  const [meetingCandidate, setMeetingCandidate] = useState<AiTemplateCandidate | null>(null);
  const [meetingMessages, setMeetingMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [meetingInput, setMeetingInput] = useState("");
  const [meetingSending, setMeetingSending] = useState(false);
  const [meetingFinalized, setMeetingFinalized] = useState(false);
  const [meetingConfirming, setMeetingConfirming] = useState(false);
  // P4: AIX改善案（aix_feature_suggestions の pending 一覧）
  const [suggestions, setSuggestions] = useState<AixFeatureSuggestion[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  // 改善案タブ カテゴリフィルタ
  const [suggestionCategoryFilter, setSuggestionCategoryFilter] = useState<string>('all');
  // 🧠ナレッジ承認タブ（hypothesis → confirmed 手動昇格）
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  // 承認待ちナレッジの総数（knowledge-review API の total。表示中との差 = limit で切れている件数）
  const [knowledgeTotal, setKnowledgeTotal] = useState<number | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [confirmingKnowledgeId, setConfirmingKnowledgeId] = useState<string | null>(null);
  const [rejectingKnowledgeId, setRejectingKnowledgeId] = useState<string | null>(null);
  // 🤝 打ち合わせ（Sonnet とのチャット形式でナレッジを詰める）
  const [knowledgeChatOpen, setKnowledgeChatOpen] = useState<string | null>(null);  // 開いているナレッジID
  const [knowledgeChatMessages, setKnowledgeChatMessages] = useState<Record<string, Array<{ role: "user" | "assistant"; content: string }>>>({});
  const [knowledgeChatInput, setKnowledgeChatInput] = useState<Record<string, string>>({});
  const [knowledgeChatSending, setKnowledgeChatSending] = useState<string | null>(null);  // 送信中のID
  const [knowledgeFinalizing, setKnowledgeFinalizing] = useState<string | null>(null);  // 確定中のID
  // ✏️ 優先反映（clarify）: HUMAN-{id} priority=10 でグローバルprompt_rulesに注入する直接修正フロー
  const [clarifyingKnowledgeId, setClarifyingKnowledgeId] = useState<string | null>(null);
  const [clarifyContent, setClarifyContent] = useState<Record<string, string>>({});
  const [submittingClarify, setSubmittingClarify] = useState<string | null>(null);
  // 🔍 ナレッジタブ フィルタ・ソート
  const [knowledgeCategoryFilter, setKnowledgeCategoryFilter] = useState<string>("all");
  const [knowledgeSortBy, setKnowledgeSortBy] = useState<"importance" | "created_at">("importance");
  // 打ち合わせチャットの吹き出しコンテナ（最新メッセージへ自動スクロール用。同時に開けるのは1件のみ）
  const knowledgeChatScrollRef = useRef<HTMLDivElement | null>(null);

  // AI盲点フィードバック（❓ AI質問タブ）
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);
  // Tier2承認質問（knowledge_gap・pending）のサーバカウント（バッジ表示用）
  const [knowledgeGapPendingCount, setKnowledgeGapPendingCount] = useState(0);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackAnswers, setFeedbackAnswers] = useState<Record<string, string>>({});
  const [submittingFeedback, setSubmittingFeedback] = useState<string | null>(null);
  // 矛盾系質問の補足コメント（任意）: per-item テキスト入力の状態
  const [contradictionComments, setContradictionComments] = useState<Record<string, string>>({});
  // P5: 却下理由チップを表示中の候補/提案ID
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  // AI質問のスキップ理由チップを表示中のフィードバックID
  const [dismissingFeedbackId, setDismissingFeedbackId] = useState<string | null>(null);
  // AI質問 打ち合わせ機能
  const [discussingItemId, setDiscussingItemId] = useState<string | null>(null);
  const [discussionMessages, setDiscussionMessages] = useState<Record<string, Array<{role:"user"|"assistant", content:string}>>>({});
  const [discussionInput, setDiscussionInput] = useState("");
  const [discussionSending, setDiscussionSending] = useState(false);
  // AI質問タブ: auto-judgeが生成したナレッジ品質確認質問（aix_feature_suggestions type=knowledge_question）
  const [knowledgeQuestions, setKnowledgeQuestions] = useState<AixFeatureSuggestion[]>([]);
  const [knowledgeQuestionsLoading, setKnowledgeQuestionsLoading] = useState(false);
  const [knowledgeQuestionAnswers, setKnowledgeQuestionAnswers] = useState<Record<string, string>>({});
  const [submittingKnowledgeQuestion, setSubmittingKnowledgeQuestion] = useState<string | null>(null);
  // 案1: サブカテゴリ別アコーディオンの折りたたみ状態（key: セクションID, true=折りたたみ中）
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  // AIおすすめテンプレ（post_aix時のみ）: recommend-templates APIの結果（最大3件）
  const [aiRecommendations, setAiRecommendations] = useState<Array<{ id: string; score: number; reason: string }>>([]);
  const [recommendLoading, setRecommendLoading] = useState(false);
  // モーダル1回のオープンにつき1回だけフェッチする
  const recommendFetchedRef = useRef(false);
  // ⭐ 永久ルール管理タブ（HUMAN-* is_permanent フラグ管理）
  interface HumanRule { id: string; rule_key: string; rule_text: string; is_permanent: boolean; updated_at: string | null; priority: number; }
  const [humanRulesList, setHumanRulesList] = useState<HumanRule[]>([]);
  const [humanRulesLoading, setHumanRulesLoading] = useState(false);
  const [promotingRuleId, setPromotingRuleId] = useState<string | null>(null);

  function applyVacatingDates(text: string, vd: { month: number; day: number } | null): string {
    const lastDayOf = (m: number) => new Date(new Date().getFullYear(), m, 0).getDate();
    const C = '[◯○〇]';
    let t = text;
    let vacStr: string | null = null;
    let viewStr: string | null = null;
    if (vd) {
      const vacDay = Math.min(vd.day, lastDayOf(vd.month));
      vacStr = `${vd.month}月${vacDay}日`;
      let vm = vd.month; let vday = vacDay + 1;
      if (vday > lastDayOf(vm)) { vday = 1; vm = vm === 12 ? 1 : vm + 1; }
      viewStr = `${vm}月${vday}日`;
    }
    t = t.replace(new RegExp(`${C}+月${C}+日退去の為${C}+月${C}+日以降ご内覧可能`, 'g'),
      vacStr && viewStr ? `${vacStr}退去の為${viewStr}以降ご内覧可能` : '退去の為内覧可能日以降ご内覧可能');
    t = t.replace(new RegExp(`${C}+月${C}+退去予定の為${C}+月${C}+日以降ご内覧可能`, 'g'),
      vacStr && viewStr ? `${vacStr}退去予定の為${viewStr}以降ご内覧可能` : '退去予定の為内覧可能日以降ご内覧可能');
    t = t.replace(new RegExp(`${C}+月${C}+日以降ご内覧可能`, 'g'),
      viewStr ? `${viewStr}以降ご内覧可能` : '内覧可能日以降ご内覧可能');
    t = t.replace(new RegExp(`${C}+月${C}+日退去予定`, 'g'),
      vacStr ? `${vacStr}退去予定` : '退去予定');
    return t;
  }

  function applySoloEntry(text: string): string {
    const SOLO_RE = /同居人|配偶者|同居者|家族構成|入居人数|お子様|子ども|子供|同居|ご家族/;
    return text
      .split("\n")
      .filter(line => !SOLO_RE.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function highlightTemplateVars(text: string): ReactNode[] {
    const parts = text.split(/(アカウント名|〇〇|○○)/g);
    return parts.map((part, i) => {
      if (part === "アカウント名") return <mark key={i} className="bg-orange-100 text-orange-700 rounded px-0.5 font-bold not-italic">アカウント名</mark>;
      if (part === "〇〇" || part === "○○") return <mark key={i} className="bg-sky-100 text-sky-700 rounded px-0.5 font-bold not-italic">{part}</mark>;
      return <span key={i}>{part}</span>;
    });
  }

  function detectTemplateElements(text: string): { emoji: string; label: string; bg: string; fg: string }[] {
    const el: { emoji: string; label: string; bg: string; fg: string }[] = [];
    if (/🌟|⭐|【新築|【物件/.test(text)) el.push({ emoji: "🌟", label: "物件名", bg: "bg-amber-100", fg: "text-amber-800" });
    if (/内覧.*?(?:できません|出来ません|未完成|完成前|予定)|現在内覧/.test(text)) el.push({ emoji: "🚧", label: "内覧不可フォロー（突っ込まれ防止）", bg: "bg-orange-100", fg: "text-orange-800" });
    else if (/内覧|ご案内/.test(text)) el.push({ emoji: "🏠", label: "内覧誘導", bg: "bg-blue-100", fg: "text-blue-800" });
    if (/条件|ご希望/.test(text)) el.push({ emoji: "✅", label: "条件一致アピール", bg: "bg-emerald-100", fg: "text-emerald-800" });
    if (/家賃|万円|[0-9]円/.test(text)) el.push({ emoji: "💴", label: "家賃・費用訴求", bg: "bg-green-100", fg: "text-green-800" });
    if (/徒歩[0-9]|[0-9]分|駅.*徒歩/.test(text)) el.push({ emoji: "🚃", label: "アクセス訴求", bg: "bg-sky-100", fg: "text-sky-800" });
    if (/新築|築浅/.test(text)) el.push({ emoji: "🏗️", label: "新築・築浅訴求", bg: "bg-teal-100", fg: "text-teal-800" });
    if (/申込|仮押さえ/.test(text)) el.push({ emoji: "📝", label: "申込誘導", bg: "bg-purple-100", fg: "text-purple-800" });
    if (/潜在|意識/.test(text)) el.push({ emoji: "🧠", label: "潜在意識への訴求", bg: "bg-violet-100", fg: "text-violet-800" });
    return el;
  }

  function matchAvailCheckFilter(label: string, filter: string): boolean {
    const tag = getAvailCheckTag(label);
    if (tag) return tag === filter;
    if (filter === "別の部屋") return /別の部屋|2番手/.test(label);
    if (filter === "物件なかった") return /物件なし|物件なかった/.test(label);
    if (filter === "入居日確認した") return /入居日|退去日/.test(label);
    if (filter === "室内写真を確認した") return /写真/.test(label);
    return !/別の部屋|2番手|物件なし|物件なかった|入居日|退去日|写真/.test(label);
  }

  const loadTemplates = async () => {
    setLoading(true);
    setTemplateLoadError(null);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = await res.json() as { ok: boolean; templates: Template[] };
      if (data.ok) {
        setTemplates(data.templates);
        onCacheUpdate?.(data.templates); // 親のキャッシュを更新（次回オープン時に即時表示）
        const cats = Array.from(new Set(data.templates.map((t) => t.category)));
        if (cats.length > 0 && !cats.includes(category)) setCategory(cats[0]);
      } else {
        throw new Error("API returned ok: false");
      }
    } catch (e) {
      console.error("[TemplateModal] テンプレート取得失敗:", e);
      setTemplateLoadError("テンプレートの読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  // props優先: 親からtemplatesが渡されていればそれを使い、渡されていなければ従来通りfetch（後方互換）
  useEffect(() => {
    if (templatesProp) {
      setTemplates(templatesProp);
      setLoading(false);
      setTemplateLoadError(null);
      const cats = Array.from(new Set(templatesProp.map((t) => t.category)));
      if (cats.length > 0 && !cats.includes(category)) setCategory(cats[0]);
    } else {
      loadTemplates();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatesProp]);

  // post_aix でモーダルが開いたとき、sent_message からサブカテゴリを自動検出してフィルターを適用
  useEffect(() => {
    if (!postAixContext) return;
    const msg = postAixContext.sentMessage ?? "";
    const at = postAixContext.actionType;
    if (at === "property_send") {
      if (/新着/.test(msg)) setPropertySendSubFilter("新着まとめ");
      else if (/条件.{0,6}(広げ|広め|緩め)|エリア.{0,6}広げ|範囲.{0,6}広/.test(msg)) setPropertySendSubFilter("条件広げまとめ");
      else if (/代わり|代替|別の物件|別のお部屋|別のお部屋|他の物件/.test(msg)) setPropertySendSubFilter("代替物件送り");
      // 初回まとめ相当: キーワードなし = フィルターなし（全件表示）
    } else if (at === "viewing_invite") {
      if (/日程変更|ご変更|変更させて|別のお日|別の日/.test(msg)) setViewingSubFilter("日程変更");
      else setViewingSubFilter("通常内覧");
    }
  // postAixContext は mount 時に固定されるため初回のみ実行
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postAixContext?.conversationId]);

  // post_aix でモーダルが開いたら AIおすすめテンプレを取得（失敗しても通常表示にフォールバック）
  useEffect(() => {
    if (!postAixContext || recommendFetchedRef.current) return;
    const candidateTemplates = templates.filter((t) => t.category === category);
    if (candidateTemplates.length === 0) return;
    recommendFetchedRef.current = true;
    setRecommendLoading(true);
    // sent_message からサブカテゴリを直接計算（stateの非同期更新を避けるため再計算）
    const _msg = postAixContext.sentMessage ?? "";
    const _at = postAixContext.actionType;
    let detectedSubCategory: string | null = null;
    if (_at === "property_send") {
      if (/新着/.test(_msg)) detectedSubCategory = "新着まとめ";
      else if (/条件.{0,6}(広げ|広め|緩め)|エリア.{0,6}広げ|範囲.{0,6}広/.test(_msg)) detectedSubCategory = "条件広げまとめ";
      else if (/代わり|代替|別の物件|別のお部屋|他の物件/.test(_msg)) detectedSubCategory = "代替物件送り";
    } else if (_at === "viewing_invite") {
      detectedSubCategory = /日程変更|ご変更|変更させて|別のお日|別の日/.test(_msg) ? "日程変更" : "通常内覧";
    }
    fetch("/api/recommend-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: postAixContext.conversationId,
        action_type: postAixContext.actionType,
        sent_message: postAixContext.sentMessage,
        category,
        templates: candidateTemplates.map((t) => ({ id: t.id, label: t.label, text: t.text, use_count: t.use_count ?? 0, win_rate: t.win_rate ?? null, recommend_shown_count: t.recommend_shown_count ?? null, recommend_picked_count: t.recommend_picked_count ?? null })),
        customer_conditions: linkedCustomer?.conditions ?? null,
        sub_category: detectedSubCategory,
      }),
    })
      .then((res) => res.json())
      .then((data: { ok: boolean; recommendations?: Array<{ id: string; score: number; reason: string }> }) => {
        if (data.ok && Array.isArray(data.recommendations)) {
          setAiRecommendations(data.recommendations);
          // おすすめとして表示したテンプレのshown_countをインクリメント（fire-and-forget）
          if (data.recommendations.length > 0) {
            fetch("/api/learn-template-selection", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                phase: "shown",
                template_ids: data.recommendations.map((r) => r.id),
              }),
            }).catch(() => {});
          }
        }
      })
      .catch((e) => console.error("recommend-templates error:", e))
      .finally(() => setRecommendLoading(false));
  }, [postAixContext, templates, category]);

  // テンプレ変更後の再取得: 親管理（props）なら親に通知、単独利用なら自前でfetch
  const refreshTemplates = async () => {
    if (templatesProp) {
      onRefresh?.();
    } else {
      await loadTemplates();
      onRefresh?.();
    }
  };
  useEffect(() => { setSoloEntry(false); hasScrolled.current = false; }, [category]);

  const loadCandidates = useCallback(async () => {
    setCandidateLoading(true);
    try {
      const res = await fetch("/api/ai-template-candidates");
      const json = await res.json() as { ok: boolean; candidates: AiTemplateCandidate[] };
      if (json.ok) setCandidates(json.candidates);
    } catch { /* silent */ }
    finally { setCandidateLoading(false); }
  }, []);

  useEffect(() => {
    if (isCandidateTabActive) loadCandidates();
  }, [isCandidateTabActive, loadCandidates]);

  // P4: AIX改善案（pending）+ AIX候補（aix_edit）を同時取得して統合
  const loadSuggestions = useCallback(async () => {
    setSuggestionLoading(true);
    try {
      const [sugRes, aixRes] = await Promise.all([
        fetch("/api/aix-feature-suggestions"),
        fetch("/api/ai-template-candidates"),
      ]);
      const sugData = await sugRes.json() as { ok: boolean; suggestions: AixFeatureSuggestion[] };
      const aixData = await aixRes.json() as { ok: boolean; candidates: AiTemplateCandidate[] };
      const baseList: AixFeatureSuggestion[] = sugData.ok ? sugData.suggestions : [];
      // aix_edit候補をproposal_category='new_aix_button'として先頭に統合
      const aixItems: AixFeatureSuggestion[] = (aixData.ok ? aixData.candidates : [])
        .filter(c => !c.is_adopted && !c.is_dismissed && c.source === "aix_edit")
        .map(c => ({
          id: c.id,
          suggestion_type: "new_aix",
          action_type: c.action_type,
          suggested_title: stripEditPrefix(c.suggested_title),
          description: c.template_text,
          reason: c.reason ?? null,
          evidence_count: c.evidence_count ?? null,
          status: "pending",
          created_at: c.created_at,
          proposal_category: "new_aix_button" as const,
          _source: "aix_candidates" as const,
          template_text: c.template_text,
          original_text: c.original_text ?? null,
          is_adopted: c.is_adopted,
          is_dismissed: c.is_dismissed,
          category: c.category,
        }));
      setSuggestions([...aixItems, ...baseList]);
    } catch (e) {
      console.error("[TemplateModal] loadSuggestions 失敗:", e);
    }
    finally { setSuggestionLoading(false); }
  }, []);

  useEffect(() => {
    if (isCandidateTabActive && candidateSubTab === "suggestions") loadSuggestions();
  }, [isCandidateTabActive, candidateSubTab, loadSuggestions]);

  // AI盲点フィードバック（pending + answered）の読み込み
  const loadFeedbackItems = useCallback(async () => {
    setFeedbackLoading(true);
    try {
      const res = await fetch("/api/ai-feedback");
      const json = await res.json() as { ok: boolean; items: FeedbackItem[]; total_knowledge_gap_pending?: number };
      if (json.ok) {
        setFeedbackItems(json.items ?? []);
        setKnowledgeGapPendingCount(json.total_knowledge_gap_pending ?? 0);
      }
    } catch (e) {
      console.error("[TemplateModal] loadFeedbackItems 失敗:", e);
    }
    finally { setFeedbackLoading(false); }
  }, []);

  useEffect(() => {
    if (isCandidateTabActive && candidateSubTab === "feedback") loadFeedbackItems();
  }, [isCandidateTabActive, candidateSubTab, loadFeedbackItems]);

  // マウント時に1回読み込み（タブを開かなくてもバッジ件数を表示するため）
  useEffect(() => {
    loadFeedbackItems();
  }, [loadFeedbackItems]);

  // auto-judgeが生成したナレッジ品質確認質問（aix_feature_suggestions type=knowledge_question）の読み込み
  const loadKnowledgeQuestions = useCallback(async () => {
    setKnowledgeQuestionsLoading(true);
    try {
      const res = await fetch("/api/aix-feature-suggestions?type=knowledge_question");
      const json = await res.json() as { ok: boolean; suggestions: AixFeatureSuggestion[] };
      if (json.ok) setKnowledgeQuestions(json.suggestions ?? []);
    } catch (e) {
      console.error("[TemplateModal] loadKnowledgeQuestions 失敗:", e);
    }
    finally { setKnowledgeQuestionsLoading(false); }
  }, []);

  useEffect(() => {
    if (isCandidateTabActive && candidateSubTab === "feedback") loadKnowledgeQuestions();
  }, [isCandidateTabActive, candidateSubTab, loadKnowledgeQuestions]);

  // ナレッジ品質確認質問への回答送信: clarify (HUMAN-* priority=10) → aix_suggestion を implemented に更新
  const submitKnowledgeQuestionAnswer = useCallback(async (item: AixFeatureSuggestion) => {
    const answer = knowledgeQuestionAnswers[item.id]?.trim();
    if (!answer) return;
    setSubmittingKnowledgeQuestion(item.id);
    try {
      // 1. implementation_notes から knowledge_id を取得
      let knowledgeId: string | undefined;
      try {
        const notes = JSON.parse(item.implementation_notes ?? "{}") as { knowledge_id?: string };
        knowledgeId = notes.knowledge_id;
      } catch { /* noop */ }

      // 2. clarify: ai_reply_knowledge を更新 + HUMAN-{id} priority=10 ルールを作成
      if (knowledgeId) {
        const clarifyRes = await fetch("/api/knowledge-review", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: knowledgeId, action: "clarify", new_content: answer }),
        });
        const clarifyJson = await clarifyRes.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!clarifyRes.ok || !clarifyJson?.ok) {
          showModalError(`回答の反映に失敗しました${clarifyJson?.error ? `（${clarifyJson.error}）` : ""}。もう一度お試しください。`);
          return; // 回答テキストは保持
        }
      }

      // 3. aix_feature_suggestions を implemented に更新
      const res = await fetch("/api/aix-feature-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: "implemented" }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        showModalError(`回答の送信に失敗しました${json?.error ? `（${json.error}）` : ""}。もう一度お試しください。`);
        return; // 回答テキストは保持
      }

      // 4. リストから除外
      setKnowledgeQuestions(prev => prev.filter(q => q.id !== item.id));
      setKnowledgeQuestionAnswers(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      showModalSuccess("回答を反映しました（次の返信生成から即時適用）");
    } catch {
      showModalError("回答の送信に失敗しました（通信エラー）。もう一度お試しください。");
    }
    finally { setSubmittingKnowledgeQuestion(null); }
  }, [knowledgeQuestionAnswers, showModalSuccess, showModalError]);

  // 🧠ナレッジ承認: hypothesis ナレッジ一覧の読み込み
  const loadKnowledgeItems = useCallback(async () => {
    setKnowledgeLoading(true);
    try {
      const res = await fetch("/api/knowledge-review");
      const json = await res.json() as { rules: KnowledgeItem[]; total?: number };
      setKnowledgeItems(json.rules ?? []);
      setKnowledgeTotal(typeof json.total === "number" ? json.total : null);
    } catch (e) {
      console.error("[TemplateModal] loadKnowledgeItems 失敗:", e);
    }
    finally { setKnowledgeLoading(false); }
  }, []);

  useEffect(() => {
    if (isCandidateTabActive && candidateSubTab === "knowledge") loadKnowledgeItems();
  }, [isCandidateTabActive, candidateSubTab, loadKnowledgeItems]);

  // ⭐ 永久ルール管理タブ: HUMAN-* ルール一覧を取得
  const loadHumanRules = useCallback(async () => {
    setHumanRulesLoading(true);
    try {
      const res = await fetch("/api/prompt-rules");
      const json = await res.json().catch(() => null) as { rules?: HumanRule[] } | null;
      setHumanRulesList(json?.rules ?? []);
    } catch (e) {
      console.error("[TemplateModal] loadHumanRules 失敗:", e);
    } finally {
      setHumanRulesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isCandidateTabActive && candidateSubTab === "rules") void loadHumanRules();
  }, [isCandidateTabActive, candidateSubTab, loadHumanRules]);

  // ⭐ 永久ルール昇格/降格
  const togglePermanentRule = useCallback(async (rule: HumanRule) => {
    setPromotingRuleId(rule.id);
    try {
      const res = await fetch("/api/prompt-rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, is_permanent: !rule.is_permanent }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; message?: string; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setHumanRulesList(prev => prev.map(r => r.id === rule.id ? { ...r, is_permanent: !rule.is_permanent } : r));
      showModalSuccess(json?.message ?? (rule.is_permanent ? "通常ルールに降格しました" : "永久ルールに昇格しました"));
    } catch (e) {
      showModalError(`操作に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPromotingRuleId(null);
    }
  }, [showModalSuccess, showModalError]);

  // API失敗時はリストから除去せずエラー表示する（silent catchだと承認できていないのに消えたように見える）
  const confirmKnowledge = useCallback(async (id: string) => {
    setConfirmingKnowledgeId(id);
    try {
      const res = await fetch("/api/knowledge-review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "confirm" }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setKnowledgeItems(prev => prev.filter(k => k.id !== id));
      setKnowledgeTotal(prev => (prev === null ? prev : Math.max(0, prev - 1)));
    } catch (e) {
      showModalError(`承認に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    finally { setConfirmingKnowledgeId(null); }
  }, [showModalError]);

  const rejectKnowledge = useCallback(async (id: string) => {
    setRejectingKnowledgeId(id);
    try {
      const res = await fetch("/api/knowledge-review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "reject" }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setKnowledgeItems(prev => prev.filter(k => k.id !== id));
      setKnowledgeTotal(prev => (prev === null ? prev : Math.max(0, prev - 1)));
    } catch (e) {
      showModalError(`却下に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    finally { setRejectingKnowledgeId(null); }
  }, [showModalError]);

  // 打ち合わせチャット: メッセージ追加・送信中インジケータ表示時に最新メッセージまで自動スクロール
  useEffect(() => {
    const el = knowledgeChatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [knowledgeChatMessages, knowledgeChatSending, knowledgeChatOpen]);

  // 🤝 打ち合わせチャット: 履歴 + 入力を Sonnet に送り、返答を吹き出しに追加する
  const sendKnowledgeChat = useCallback(async (item: KnowledgeItem) => {
    const input = (knowledgeChatInput[item.id] || "").trim();
    if (!input || knowledgeChatSending || knowledgeFinalizing) return;
    const history = knowledgeChatMessages[item.id] || [];
    const nextMessages: Array<{ role: "user" | "assistant"; content: string }> = [...history, { role: "user", content: input }];
    setKnowledgeChatMessages(prev => ({ ...prev, [item.id]: nextMessages }));
    setKnowledgeChatInput(prev => ({ ...prev, [item.id]: "" }));
    setKnowledgeChatSending(item.id);
    try {
      const res = await fetch("/api/knowledge-discuss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          title: item.title,
          content: item.content,
          category: item.category,
          conversation_state: item.conversation_state,
          messages: history,       // 履歴（今回の入力は含めない）
          userMessage: input,      // 今回の入力は userMessage で渡す（API 必須パラメータ）
        }),
      });
      const data = await res.json() as { ok?: boolean; reply?: string; error?: string };
      setKnowledgeChatMessages(prev => ({
        ...prev,
        [item.id]: [...nextMessages, { role: "assistant", content: data.reply || `返答の取得に失敗しました${data.error ? `（${data.error}）` : ""}` }],
      }));
    } catch {
      setKnowledgeChatMessages(prev => ({
        ...prev,
        [item.id]: [...nextMessages, { role: "assistant", content: "返答の取得に失敗しました（通信エラー）" }],
      }));
    } finally {
      setKnowledgeChatSending(null);
    }
  }, [knowledgeChatInput, knowledgeChatMessages, knowledgeChatSending, knowledgeFinalizing]);

  // 🤝 打ち合わせ確定: チャット内容を踏まえて ai_prompt_rules に反映し、ナレッジを一覧から除外する
  const finalizeKnowledge = useCallback(async (item: KnowledgeItem) => {
    setKnowledgeFinalizing(item.id);
    try {
      const res = await fetch("/api/knowledge-discuss?action=finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          title: item.title,
          content: item.content,
          category: item.category,
          conversation_state: item.conversation_state,
          messages: knowledgeChatMessages[item.id] || [],
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setKnowledgeItems(prev => prev.filter(k => k.id !== item.id));
        setKnowledgeTotal(prev => (prev === null ? prev : Math.max(0, prev - 1)));
        setKnowledgeChatOpen(null);
        setKnowledgeChatMessages(prev => { const next = { ...prev }; delete next[item.id]; return next; });
        setKnowledgeChatInput(prev => { const next = { ...prev }; delete next[item.id]; return next; });
      } else {
        alert(`確定に失敗しました: ${data?.error || `HTTP ${res.status}`}`);
      }
    } catch {
      alert("確定に失敗しました（通信エラー）。もう一度お試しください。");
    }
    finally { setKnowledgeFinalizing(null); }
  }, [knowledgeChatMessages]);

  // ✏️ 優先反映（clarify）: 内容を直接修正して HUMAN-{id} priority=10 で ai_prompt_rules に永続保存
  // HUMAN-* は LEARN-*(priority=8) / FEEDBACK-*(priority=8) より高優先度で全アクションに注入される
  const submitClarify = useCallback(async (id: string, fallbackContent: string) => {
    const content = (clarifyContent[id] ?? fallbackContent).trim();
    if (!content) return;
    setSubmittingClarify(id);
    try {
      const res = await fetch("/api/knowledge-review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "clarify", new_content: content }),
      });
      const data = await res.json() as { ok: boolean; rule_key?: string; error?: string };
      if (data.ok) {
        setKnowledgeItems(prev => prev.filter(k => k.id !== id));
        setKnowledgeTotal(prev => (prev === null ? prev : Math.max(0, prev - 1)));
        setClarifyingKnowledgeId(null);
        setClarifyContent(prev => { const n = { ...prev }; delete n[id]; return n; });
      } else {
        showModalError(`優先反映に失敗しました${(data as { error?: string }).error ? `（${(data as { error?: string }).error}）` : ""}。もう一度お試しください。`);
      }
    } catch (e) {
      showModalError(`優先反映に失敗しました（通信エラー）: ${e instanceof Error ? e.message : String(e)}`);
    }
    finally { setSubmittingClarify(null); }
  }, [clarifyContent, showModalError]);

  // 回答を送信 → Sonnetが知識化（trigger_action_rules / ai_prompts に保存）
  // choice が指定された場合（矛盾系質問）: 自動でanswerテキストを生成し choice をbodyに含める
  // extraComment: 矛盾系質問での任意補足コメント（使い分け条件・理由など）
  const submitFeedbackAnswer = useCallback(async (id: string, choice?: 'new' | 'old' | 'keep' | 'remove', extraComment?: string) => {
    let baseAnswer = choice === 'new' ? '① 新しいルールが正しい'
      : choice === 'old' ? '② 既存のルールが正しい'
      : choice === 'keep' ? '✅ 正しい（維持）'
      : choice === 'remove' ? '❌ 間違い（無効化）'
      : feedbackAnswers[id]?.trim();
    if (!baseAnswer) return;
    // 補足コメントがある場合は回答テキストに付加（Opusがルール抽出する際の文脈として使用）
    const trimmedComment = extraComment?.trim();
    const answer = (trimmedComment && (choice === 'new' || choice === 'old'))
      ? `${baseAnswer}\n補足: ${trimmedComment}`
      : baseAnswer;
    setSubmittingFeedback(id);
    try {
      const res = await fetch("/api/ai-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, answer, ...(choice ? { choice } : {}) }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        // 失敗時は回答テキストを保持したままエラー表示（偽成功トーストを出さない）
        showModalError(`回答の送信に失敗しました${json?.error ? `（${json.error}）` : ""}。もう一度お試しください。`);
        return;
      }
      await loadFeedbackItems();
      setFeedbackAnswers(prev => { const next = { ...prev }; delete next[id]; return next; });
      setContradictionComments(prev => { const next = { ...prev }; delete next[id]; return next; });
      showModalSuccess("回答を反映しました（次の返信生成から即時適用）");
    } catch {
      showModalError("回答の送信に失敗しました（通信エラー）。もう一度お試しください。");
    }
    finally { setSubmittingFeedback(null); }
  }, [feedbackAnswers, contradictionComments, loadFeedbackItems, showModalSuccess, showModalError]);

  const sendDiscussionMessage = useCallback(async (item: FeedbackItem) => {
    const msg = discussionInput.trim();
    if (!msg || discussionSending) return;
    setDiscussionSending(true);
    const prevMessages = discussionMessages[item.id] ?? [];
    const newMessages = [...prevMessages, { role: "user" as const, content: msg }];
    setDiscussionMessages(prev => ({ ...prev, [item.id]: newMessages }));
    setDiscussionInput("");
    try {
      const res = await fetch("/api/ai-question-discuss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.id,
          question: item.question,
          messages: prevMessages,
          user_message: msg,
        }),
      });
      const json = await res.json() as { ok?: boolean; reply?: string; error?: string };
      if (json.ok && json.reply) {
        setDiscussionMessages(prev => ({
          ...prev,
          [item.id]: [...newMessages, { role: "assistant" as const, content: json.reply! }],
        }));
      } else {
        showModalError(json.error ?? "送信に失敗しました");
      }
    } catch (e) {
      showModalError("通信エラーが発生しました");
      console.error("[TemplateModal] discussion send failed:", e);
    } finally {
      setDiscussionSending(false);
    }
  }, [discussionInput, discussionMessages, discussionSending, showModalError]);

  // スキップ（status="dismissed"・理由があれば dismissed_reason として保存しAIの学習材料にする）
  // API失敗時はリストから除去せずエラー表示する（silent catchだとスキップが効いていないのに消えたように見える）
  const dismissFeedback = useCallback(async (id: string, reason?: string) => {
    try {
      const res = await fetch("/api/ai-feedback", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...(reason ? { dismissedReason: reason } : {}) }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setFeedbackItems(prev => prev.filter(f => f.id !== id));
    } catch (e) {
      showModalError(`スキップの保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDismissingFeedbackId(null);
    }
  }, [showModalError]);

  // P5: 候補の却下（理由チップ付き）
  // API失敗時は状態を変えずエラー表示する（silent catchだと「却下したのに翌回復活する」ように見える）
  const dismissCandidate = useCallback(async (id: string, reason?: string) => {
    try {
      const res = await fetch("/api/ai-template-candidates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss", ...(reason ? { dismissedReason: reason } : {}) }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCandidates(prev => prev.map(c => c.id === id ? { ...c, is_dismissed: true } : c));
    } catch (e) {
      showModalError(`却下の保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDismissingId(null);
    }
  }, [showModalError]);

  // 改善案タブに統合表示している aix_edit 候補の却下（suggestions / candidates 両方の状態を更新）
  const dismissMergedAixCandidate = useCallback(async (id: string, reason?: string) => {
    try {
      const res = await fetch("/api/ai-template-candidates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss", ...(reason ? { dismissedReason: reason } : {}) }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSuggestions(prev => prev.filter(s => s.id !== id));
      setCandidates(prev => prev.map(c => c.id === id ? { ...c, is_dismissed: true } : c));
    } catch (e) {
      showModalError(`却下の保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDismissingId(null);
    }
  }, [showModalError]);

  // ブラッシュアップチャットを開く（初回フィードバックを非同期取得）
  const openReviewPanel = (candidate: AiTemplateCandidate) => {
    setReviewCandidate(candidate);
    setReviewMessages([]);
    setReviewCurrentText(candidate.template_text);
    setReviewInput("");
    setReviewSending(true);
    // 初回フィードバックを自動取得
    fetch("/api/ai-template-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposed: candidate.template_text,
        original: candidate.original_text ?? undefined,
        actionType: candidate.action_type,
        reason: candidate.reason ?? undefined,
        evidenceCount: candidate.evidence_count ?? undefined,
        messages: [], // 空=初回
      }),
    })
      .then(r => r.json())
      .then((data: { ok: boolean; reply: string; revisedTemplate?: string | null }) => {
        if (data.ok) {
          const assistantMsg = { role: "assistant" as const, content: data.reply };
          setReviewMessages([assistantMsg]);
          if (data.revisedTemplate) setReviewCurrentText(data.revisedTemplate);
        }
      })
      .catch(() => {
        setReviewMessages([{ role: "assistant", content: "フィードバックの取得に失敗しました。" }]);
      })
      .finally(() => setReviewSending(false));
  };

  // チャット送信（Opusにブラッシュアップ要望を伝える）
  const sendReviewMessage = async () => {
    if (!reviewInput.trim() || reviewSending || !reviewCandidate) return;
    const userMsg = { role: "user" as const, content: reviewInput.trim() };
    const nextMessages = [...reviewMessages, userMsg];
    setReviewMessages(nextMessages);
    setReviewInput("");
    setReviewSending(true);
    try {
      const res = await fetch("/api/ai-template-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposed: reviewCurrentText, // 最新の提案テキストを渡す
          original: reviewCandidate.original_text ?? undefined,
          actionType: reviewCandidate.action_type,
          reason: reviewCandidate.reason ?? undefined,
          evidenceCount: reviewCandidate.evidence_count ?? undefined,
          messages: nextMessages,
        }),
      });
      const data = await res.json() as { ok: boolean; reply: string; revisedTemplate?: string | null };
      if (data.ok) {
        setReviewMessages(prev => [...prev, { role: "assistant", content: data.reply }]);
        if (data.revisedTemplate) setReviewCurrentText(data.revisedTemplate);
      }
    } catch {
      setReviewMessages(prev => [...prev, { role: "assistant", content: "エラーが発生しました。" }]);
    } finally {
      setReviewSending(false);
    }
  };

  // レビュー承認後の採用処理（customTextでブラッシュアップ後の本文を採用できる）
  const adoptCandidate = async (candidate: AiTemplateCandidate, customText?: string) => {
    // aix_feature_suggestions 由来の擬似候補: templatesにはINSERTせず提案ステータスを採用済みにする
    if (candidate.source === "suggestion") {
      setReviewCandidate(null);
      await updateSuggestionStatus(candidate.id, "adopted");
      return;
    }
    setAdoptingId(candidate.id);
    setReviewCandidate(null);
    try {
      const res = await fetch("/api/ai-template-candidates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: candidate.id, action: "adopt", ...(customText ? { customText } : {}) }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      // API失敗時は状態を変えずエラー表示（楽観更新で失敗を隠さない）
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setCandidates(prev =>
        prev.map(c => c.id === candidate.id ? { ...c, is_adopted: true } : c)
      );
      // 統合表示中のsuggestionsからも除去（aix_edit候補を改善案タブに統合しているため）
      setSuggestions(prev => prev.filter(s => s.id !== candidate.id));
      // 採用したテンプレを一覧に即反映して該当カテゴリへ移動
      setIsCandidateTabActive(false);
      setCategory(candidate.category);
      await refreshTemplates();
    } catch (e) {
      showModalError(`採用の保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    finally { setAdoptingId(null); }
  };

  // 改善案打ち合わせパネルを開く（Opus 4.8がパターン分析して打ち合わせ開始）
  const openMeetingPanel = async (candidate: AiTemplateCandidate) => {
    setMeetingCandidate(candidate);
    setMeetingMessages([]);
    setMeetingInput("");
    setMeetingFinalized(false);
    setMeetingSending(true);
    try {
      const res = await fetch("/api/aix/improvement-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", candidateId: candidate.id }),
      });
      const data = await res.json() as { ok: boolean; message?: string };
      if (data.ok && data.message) {
        setMeetingMessages([{ role: "assistant", content: data.message }]);
      } else {
        setMeetingMessages([{ role: "assistant", content: "分析の取得に失敗しました。もう一度お試しください。" }]);
      }
    } catch {
      setMeetingMessages([{ role: "assistant", content: "通信エラーが発生しました。" }]);
    } finally {
      setMeetingSending(false);
    }
  };

  // 打ち合わせチャット送信（Opus 4.8と実装仕様を詰める）
  const sendMeetingMessage = async () => {
    if (!meetingInput.trim() || meetingSending || !meetingCandidate) return;
    const userMsg = meetingInput.trim();
    setMeetingInput("");
    const nextMessages = [...meetingMessages, { role: "user" as const, content: userMsg }];
    setMeetingMessages(nextMessages);
    setMeetingSending(true);
    try {
      const res = await fetch("/api/aix/improvement-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "chat", candidateId: meetingCandidate.id, messages: nextMessages, userMessage: userMsg }),
      });
      const data = await res.json() as { ok: boolean; message?: string };
      if (data.ok && data.message) {
        setMeetingMessages(prev => [...prev, { role: "assistant" as const, content: data.message! }]);
      }
    } catch {
      setMeetingMessages(prev => [...prev, { role: "assistant" as const, content: "エラーが発生しました。" }]);
    } finally {
      setMeetingSending(false);
    }
  };

  // 仕様を確定して aix_feature_suggestions へ転送（実装待ちとして表示される）
  const finalizeMeeting = async () => {
    if (!meetingCandidate || meetingSending) return;
    setMeetingSending(true);
    try {
      const res = await fetch("/api/aix/improvement-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", candidateId: meetingCandidate.id, messages: meetingMessages }),
      });
      const data = await res.json() as { ok: boolean; spec?: unknown; error?: string };
      if (data.ok) {
        setMeetingFinalized(true);
        // 改善案タブから除外（採用済み扱い）
        setCandidates(prev => prev.map(c => c.id === meetingCandidate.id ? { ...c, is_adopted: true } : c));
        // 転送された仕様（実装待ち）を改善案タブに反映
        setTimeout(() => loadSuggestions(), 500);
      } else {
        showModalError(data.error || "仕様の転送に失敗しました");
      }
    } catch {
      showModalError("通信エラーが発生しました");
    } finally {
      setMeetingSending(false);
    }
  };

  // P4/P5: AIX改善案のステータス更新（adopted / dismissed / implemented + 理由）
  // API失敗時は一覧から消さずエラー表示する（silent catchだと却下が効いていないのに消えたように見える）
  const updateSuggestionStatus = useCallback(async (id: string, status: "adopted" | "dismissed" | "implemented", reason?: string) => {
    // new_picker/new_button/new_aix は採用後も「採用済み・実装待ち」としてリストに残す
    const IMPL_TRACKING_TYPES = ["new_picker", "new_button", "new_aix"];
    const targetSg = suggestions.find(s => s.id === id);
    const needsImplTracking = status === "adopted" && !!targetSg && IMPL_TRACKING_TYPES.includes(targetSg.suggestion_type);
    try {
      // adopted 時: ナレッジ連動フィールドを添付する
      // （knowledge_aix_align / knowledge_brushup を採用したらAPI側で実際にナレッジへ反映されるようにする）
      const extra: Record<string, string> = {};
      if (status === "adopted") {
        if (targetSg) {
          extra.suggestion_type = targetSg.suggestion_type;
          try {
            const notes = JSON.parse(targetSg.implementation_notes ?? "{}") as { knowledge_id?: string; append_text?: string };
            if (notes.knowledge_id) extra.knowledge_id = notes.knowledge_id;
            if (notes.append_text) extra.append_text = notes.append_text;
          } catch { /* implementation_notes がJSONでない提案は連動対象外 */ }
        }
      }
      const res = await fetch("/api/aix-feature-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status, ...extra, ...(reason ? { dismissedReason: reason } : {}) }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (needsImplTracking) {
        // 実装待ちとしてリストに残す（statusだけ更新）
        setSuggestions(prev => prev.map(s => s.id === id ? { ...s, status: "adopted" } : s));
      } else {
        setSuggestions(prev => prev.filter(s => s.id !== id));
      }
    } catch (e) {
      showModalError(`ステータス更新に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDismissingId(null);
    }
  }, [showModalError, suggestions]);

  const commitCategoryRename = async () => {
    const oldCat = editingCategory;
    const newCat = editingCategoryName.trim();
    setEditingCategory(null);
    if (!oldCat || !newCat || oldCat === newCat) return;
    try {
      const res = await fetch("/api/templates/rename-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldCategory: oldCat, newCategory: newCat }),
      });
      if (!res.ok) throw new Error("rename failed");
      setTemplates(prev => prev.map(t => t.category === oldCat ? { ...t, category: newCat } : t));
      setCategory(newCat);
      onRefresh?.();
    } catch {
      showModalError("カテゴリ名の変更に失敗しました");
    }
  };

  useEffect(() => {
    if (showAddForm) setTimeout(() => addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }, [showAddForm]);

  // ハイライト対象カードを中央にスクロール
  useEffect(() => {
    if (!highlightKeyword || loading) return;
    const timer = setTimeout(() => {
      document.querySelector('[data-highlighted="true"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => clearTimeout(timer);
  }, [highlightKeyword, loading]);

  useEffect(() => {
    if (!category) return;
    setTimeout(() => {
      const btn = categoryTabRefs.current[category];
      const container = categoryScrollRef.current;
      if (btn && container) {
        const offset = btn.offsetLeft - 16;
        container.scrollTo({ left: Math.max(0, offset), behavior: "smooth" });
      }
    }, 80);
  }, [category]);

  const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
    "ヒアリング【AIX】": "お部屋探し条件ヒアリング",
    "物件オススメ【AIX】": "1件特にオススメする",
    "物件確認した【AIX】": "物件確認した（募集状況）",
    "物件ピックアップした【AIX】": "物件ピックアップした",
  };

  // 改善案タブ用: source="improvement" の候補（テンプレ変更ではなくAIX/ピッカーの機能改善提案として扱う）
  const improvementCandidates = candidates.filter(
    c => !c.is_adopted && !c.is_dismissed && c.source === "improvement"
  );

  const categories = Array.from(new Set(templates.map((t) => t.category)));
  const normalCategories = categories.filter(c => !c.includes("AIX"));
  const AIX_CATEGORY_ORDER = [
    "物件ピックアップした【AIX】",
    "物件オススメ【AIX】",
    "物件確認した【AIX】",
    "管理会社に確認した【AIX】",
    "代表に確認した【AIX】",
    "見積書送る【AIX】",
    "ヒアリング【AIX】",
    "挨拶【AIX】",
    "内覧へ！【AIX】",
    "内覧【AIX】",
    "申込へ！【AIX】",
    "追客【AIX】",
    "確認します【AIX】",
  ];
  const rawAixCategories = categories.filter(c => c.includes("AIX"));
  const aixCategories = [
    ...AIX_CATEGORY_ORDER.filter(c => rawAixCategories.includes(c)),
    ...rawAixCategories.filter(c => !AIX_CATEGORY_ORDER.includes(c)),
  ];
  const isAixCategoryActive = category.includes("AIX");
  const isSearching = searchQuery.trim().length > 0;
  // 複合スコア: use_count*0.4 + win_rate*100*0.4 + adoptionRate*100*0.2
  // 採用率 = おすすめとして提示→実際に選ばれた率。全テンプレがスコア0のうちは sort_order 順。
  const templateScore = (t: Template) => {
    const adoptionRate = (t.recommend_shown_count ?? 0) > 0
      ? (t.recommend_picked_count ?? 0) / (t.recommend_shown_count ?? 1)
      : 0;
    return (t.use_count ?? 0) * 0.4 + (t.win_rate ?? 0) * 100 * 0.4 + adoptionRate * 100 * 0.2;
  };
  // H4: 現在の会話ステータスでの送信実績（calc-template-scene-stats cron 集計・上位5テンプレのみ値あり）
  const scenePickCount = (t: Template): number =>
    conversationState && t.status_pick_stats ? (t.status_pick_stats[conversationState] ?? 0) : 0;
  const compareTemplates = (a: Template, b: Template) => {
    // CHAIN-1/CHAIN-2: AIX→テンプレのチェーン統計で推奨されたテンプレを配列順（=送る順番）で最優先昇格
    if (priorityTemplateIds?.length) {
      const ai = priorityTemplateIds.indexOf(a.id);
      const bi = priorityTemplateIds.indexOf(b.id);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        if (ai !== bi) return ai - bi;
      }
    }
    // H4: このシーン（ステータス）でよく送信されているテンプレを最上部に昇格
    const sceneDiff = scenePickCount(b) - scenePickCount(a);
    if (sceneDiff !== 0) return sceneDiff;
    const diff = templateScore(b) - templateScore(a);
    if (diff !== 0) return diff;
    return (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
  };
  const filtered = (isSearching
    ? templates.filter((t) =>
        t.label.includes(searchQuery) || t.text.includes(searchQuery) || t.category.includes(searchQuery)
      )
    : templates
        .filter((t) => t.category === category)
        .filter((t) => {
          if (!aixKeywordFilter.trim()) return true;
          const kw = aixKeywordFilter.trim().toLowerCase();
          const inLabel = t.label.toLowerCase().includes(kw);
          const inText = t.text.toLowerCase().includes(kw);
          const inStructure = t.structure?.some(
            (b) => b.label.toLowerCase().includes(kw) || b.text.toLowerCase().includes(kw)
          ) ?? false;
          return inLabel || inText || inStructure;
        })
  ).sort(compareTemplates);

  const isAixCategory = category === "物件オススメ【AIX】" && !isSearching;
  const isAvailCheckCategory = category === "物件確認した【AIX】" && !isSearching;
  const isPropertySendCategory = category === "物件ピックアップした【AIX】" && !isSearching;
  const isViewingCategory = (category === "内覧へ！【AIX】" || category === "内覧【AIX】") && !isSearching;
  const displayFiltered =
    isAixCategory && aixPurposeFilter !== null
      ? filtered.filter(t => {
          const tagFromLabel = getAixPurposeTag(stripAvailCheckTag(t.label));
          const els = detectTemplateElements(t.text);
          if (aixPurposeFilter === "内覧") return tagFromLabel === "内覧誘導" || els.some(e => e.label === "内覧誘導");
          return tagFromLabel === "申込誘導" || els.some(e => e.label === "申込誘導");
        })
    : isAixCategory
      ? [...filtered].sort((a, b) => {
          const getOrder = (t: typeof a) => {
            const tagFromLabel = getAixPurposeTag(stripAvailCheckTag(t.label));
            const els = detectTemplateElements(t.text);
            if (tagFromLabel === "内覧誘導" || els.some(e => e.label === "内覧誘導")) return 0;
            if (tagFromLabel === "申込誘導" || els.some(e => e.label === "申込誘導")) return 1;
            return 2;
          };
          const oa = getOrder(a), ob = getOrder(b);
          if (oa !== ob) return oa - ob;
          return compareTemplates(a, b);
        })
    : isAvailCheckCategory && availCheckFilter !== null
      ? filtered.filter(t => inferAvailCheckType(t.label) === availCheckFilter)
    : isAvailCheckCategory
      ? [...filtered].sort((a, b) => {
          const ia = AVAIL_CHECK_TYPES.findIndex(t => t.key === inferAvailCheckType(a.label));
          const ib = AVAIL_CHECK_TYPES.findIndex(t => t.key === inferAvailCheckType(b.label));
          if (ia !== ib) return ia - ib;
          return compareTemplates(a, b);
        })
    : isPropertySendCategory && propertySendSubFilter !== null
      ? filtered.filter(t => getPropertySendSubTag(t.label) === propertySendSubFilter)
    : isPropertySendCategory
      ? [...filtered].sort((a, b) => {
          const ia = PROPERTY_SEND_SUB_TYPES.findIndex(t => t.key === getPropertySendSubTag(a.label));
          const ib = PROPERTY_SEND_SUB_TYPES.findIndex(t => t.key === getPropertySendSubTag(b.label));
          const ia2 = ia === -1 ? PROPERTY_SEND_SUB_TYPES.length : ia;
          const ib2 = ib === -1 ? PROPERTY_SEND_SUB_TYPES.length : ib;
          if (ia2 !== ib2) return ia2 - ib2;
          return compareTemplates(a, b);
        })
    : isViewingCategory && viewingSubFilter !== null
      ? filtered.filter(t => getViewingSubTag(t.label) === viewingSubFilter)
    : isViewingCategory
      ? [...filtered].sort((a, b) => {
          const ia = VIEWING_SUB_TYPES.findIndex(t => t.key === getViewingSubTag(a.label));
          const ib = VIEWING_SUB_TYPES.findIndex(t => t.key === getViewingSubTag(b.label));
          const ia2 = ia === -1 ? VIEWING_SUB_TYPES.length : ia;
          const ib2 = ib === -1 ? VIEWING_SUB_TYPES.length : ib;
          if (ia2 !== ib2) return ia2 - ib2;
          return compareTemplates(a, b);
        })
    : filtered;

  const handleAdd = async () => {
    if (!newLabel.trim() || !newText.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: newCategory || "全般", label: newLabel, text: newText, requires_image: newRequiresImage }),
      });
      const data = await res.json() as { ok: boolean };
      if (data.ok) {
        setNewLabel(""); setNewText(""); setNewCategory("全般"); setNewRequiresImage(false); setShowAddForm(false);
        await refreshTemplates();
      } else {
        showModalError("テンプレートの追加に失敗しました");
      }
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (tmpl: Template) => {
    setEditingId(tmpl.id);
    setEditAvailCheckType(getAvailCheckTag(tmpl.label));
    const withoutAvail = stripAvailCheckTag(tmpl.label);
    setEditPropertySendSub(getPropertySendSubTag(withoutAvail));
    const withoutPropSend = stripPropertySendSubTag(withoutAvail);
    setEditViewingSub(getViewingSubTag(withoutPropSend));
    const withoutViewing = stripViewingSubTag(withoutPropSend);
    setEditAixPurposeTag(getAixPurposeTag(withoutViewing));
    setEditLabel(stripAixPurposeTag(withoutViewing));
    setEditText(tmpl.text);
    setEditCategory(tmpl.category);
    setEditRequiresImage(tmpl.requires_image);
    setEditStructure(tmpl.structure ?? []);
    setEditSecondMsgType(tmpl.second_msg_type);
    setEditSecondMsgDelay(tmpl.second_msg_delay);
    setConfirmDeleteId(null);
  };

  const handleUpdate = async () => {
    if (!editingId || !editLabel.trim() || !editText.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, category: editCategory || "全般", label: (editAvailCheckType && editCategory === "物件確認した【AIX】" ? `【${editAvailCheckType}】` : "") + (editPropertySendSub && editCategory === "物件ピックアップした【AIX】" ? `【${editPropertySendSub}】` : "") + (editViewingSub && (editCategory === "内覧へ！【AIX】" || editCategory === "内覧【AIX】") ? `【${editViewingSub}】` : "") + (editAixPurposeTag && editCategory.includes("AIX") && editCategory !== "物件確認した【AIX】" && editCategory !== "物件ピックアップした【AIX】" && editCategory !== "内覧へ！【AIX】" && editCategory !== "内覧【AIX】" ? `【${editAixPurposeTag}】` : "") + editLabel, text: editText, structure: editStructure.length > 0 ? editStructure : null, requires_image: editRequiresImage, second_msg_type: editSecondMsgType, second_msg_delay: editSecondMsgType ? editSecondMsgDelay : null }),
      });
      const data = await res.json() as { ok: boolean };
      if (data.ok) {
        setEditingId(null);
        await refreshTemplates();
      } else {
        showModalError("テンプレートの更新に失敗しました");
      }
    } finally {
      setEditSaving(false);
    }
  };

  const handleReorder = async (list: Template[], index: number, direction: "up" | "down") => {
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= list.length) return;

    const a = list[index];
    const b = list[swapIndex];
    // list はソート済みなのでインデックスに * 10 を掛けてスパースな値を確保
    const aOrder = a.sort_order ?? index * 10;
    const bOrder = b.sort_order ?? swapIndex * 10;

    const prevTemplates = templates;
    setTemplates((prev) =>
      prev.map((t) =>
        t.id === a.id ? { ...t, sort_order: bOrder } :
        t.id === b.id ? { ...t, sort_order: aOrder } : t
      )
    );

    try {
      const res = await fetch("/api/templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: [{ id: a.id, sort_order: bOrder }, { id: b.id, sort_order: aOrder }] }),
      });
      if (!res.ok) throw new Error("reorder failed");
      onRefresh?.();
    } catch {
      setTemplates(prevTemplates);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch(`/api/templates?id=${id}`, { method: "DELETE" });
      setTemplates((prev) => {
        const next = prev.filter((t) => t.id !== id);
        const cats = Array.from(new Set(next.map((t) => t.category)));
        if (cats.length > 0 && !cats.includes(category)) setCategory(cats[0]);
        return next;
      });
      setConfirmDeleteId(null);
      onRefresh?.();
    } finally {
      setDeletingId(null);
    }
  };

  const handleAdapt = async (tmpl: Template) => {
    setAdaptingId(tmpl.id);
    setAdaptErrors((prev) => { const n = { ...prev }; delete n[tmpl.id]; return n; });
    try {
      const res = await fetch("/api/templates/adapt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // OCR抽出済みテキストがあれば優先（物件名・住所の消失防止）
          templateText: extractedTexts[tmpl.id] ?? tmpl.text,
          templateCategory: tmpl.category,
          customerName,
          conversationState,
          recentMessages,
          customerConditions: linkedCustomer?.conditions,
          noEmoji,
          soloEntry,
          // 予約送信待ちのAIXメッセージを渡す（物件情報の優先ソース）
          pendingScheduledMessages: (pendingScheduledMessages ?? []).filter(m => m.text),
          vacatingDate: vacatingDates[tmpl.id] ?? null,
          staffMessagedToday: staffMessagedToday ?? false,
        }),
      });
      const data = await res.json() as { ok: boolean; adapted?: string; error?: string };
      if (data.ok && data.adapted) {
        setAdaptedTexts((prev) => ({ ...prev, [tmpl.id]: data.adapted! }));
        setDisplaySource((prev) => ({ ...prev, [tmpl.id]: "adapted" }));
      } else {
        setAdaptErrors((prev) => ({ ...prev, [tmpl.id]: data.error || "AI最適化に失敗しました" }));
      }
    } catch {
      setAdaptErrors((prev) => ({ ...prev, [tmpl.id]: "通信エラーが発生しました" }));
    } finally {
      setAdaptingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* UX改善④: alert() 代替のエラートースト */}
      {modalError && (
        <div
          className="fixed top-4 left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-full bg-red-500 px-5 py-2.5 text-[12px] font-bold text-white shadow-lg"
          onClick={() => setModalError(null)}
        >
          {modalError}
        </div>
      )}
      {/* 成功トースト（緑・4秒自動消去） */}
      {modalSuccess && (
        <div
          className="fixed top-4 left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-full bg-green-600 px-5 py-2.5 text-[12px] font-bold text-white shadow-lg"
          onClick={() => setModalSuccess(null)}
        >
          {modalSuccess}
        </div>
      )}
      <div className="relative w-full max-w-lg rounded-t-3xl bg-white shadow-2xl flex flex-col" style={{ maxHeight: "90vh" }}>
        {/* 改善案打ち合わせパネル（Opus 4.8と実装仕様を固めて転送する） */}
        {meetingCandidate && (
          <div className="absolute inset-0 bg-white z-10 flex flex-col overflow-hidden rounded-t-3xl">
            {/* ヘッダー */}
            <div className="flex items-center gap-2 p-3 border-b bg-violet-50 shrink-0">
              <button onClick={() => { setMeetingCandidate(null); }} className="text-gray-500 hover:text-gray-700 text-sm">← 戻る</button>
              <span className="font-bold text-violet-700 text-sm flex-1">🤝 Opus 4.8と打ち合わせ</span>
              <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full shrink-0">{ACTION_LABELS[meetingCandidate.action_type] ?? meetingCandidate.action_type}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold shrink-0 ${(meetingCandidate.evidence_count ?? 1) >= 3 ? "bg-red-100 text-red-600" : "bg-gray-100 text-gray-600"}`}>{meetingCandidate.evidence_count ?? 1}件</span>
            </div>

            {/* パターン理由 */}
            <div className="mx-3 mt-2 p-2 bg-violet-50 rounded text-xs text-violet-800 shrink-0">
              📋 {meetingCandidate.reason || "スタッフが繰り返し追加したパターン"}
            </div>

            {/* チャットエリア */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {meetingMessages.length === 0 && meetingSending && (
                <div className="text-sm text-gray-400 animate-pulse">Opus 4.8 が分析中...</div>
              )}
              {meetingMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${msg.role === "user" ? "bg-orange-500 text-white rounded-br-sm" : "bg-gray-100 text-gray-800 rounded-bl-sm"}`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {meetingSending && meetingMessages.length > 0 && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2 text-sm text-gray-400 animate-pulse">入力中...</div>
                </div>
              )}
              {meetingFinalized && (
                <div className="mx-auto text-center py-4">
                  <div className="text-green-600 font-bold text-sm">✅ 仕様を転送しました</div>
                  <div className="text-xs text-gray-500 mt-1">改善案タブ上部に「実装待ち」として表示されます</div>
                </div>
              )}
            </div>

            {/* 入力エリア */}
            {!meetingFinalized ? (
              <div className="p-3 border-t space-y-2 shrink-0">
                <textarea
                  className="w-full border border-gray-300 rounded-lg p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-violet-400"
                  rows={3}
                  placeholder="Opus 4.8に伝えたいことを入力..."
                  value={meetingInput}
                  onChange={e => setMeetingInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMeetingMessage(); } }}
                  disabled={meetingSending}
                />
                {meetingConfirming && (
                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 mb-2">
                    <p className="text-sm text-amber-800 font-medium mb-2.5">⚠️ 本当に転送しますか？<br className="hidden" />転送後は打ち合わせを再開できません。</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setMeetingConfirming(false)}
                        className="flex-1 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 bg-white"
                      >キャンセル</button>
                      <button
                        onClick={() => { setMeetingConfirming(false); void finalizeMeeting(); }}
                        className="flex-1 py-2 text-sm rounded-lg bg-green-600 text-white font-bold"
                      >確定・転送する</button>
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => void sendMeetingMessage()}
                    disabled={!meetingInput.trim() || meetingSending}
                    className="flex-1 bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold py-2 rounded-lg disabled:opacity-50 transition"
                  >送信</button>
                  <button
                    onClick={() => setMeetingConfirming(true)}
                    disabled={meetingMessages.length < 2 || meetingSending || meetingConfirming}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-bold py-2 rounded-lg disabled:opacity-50 transition"
                  >✅ 仕様を確定・転送する</button>
                </div>
                <div className="text-xs text-gray-400 text-center">Enterで送信 • 仕様が固まったら「確定・転送」</div>
              </div>
            ) : (
              <div className="p-3 border-t shrink-0">
                <button onClick={() => setMeetingCandidate(null)} className="w-full bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-bold py-2 rounded-lg transition">閉じる</button>
              </div>
            )}
          </div>
        )}
        {/* AIX候補 ブラッシュアップチャット（モーダル本体全体に重ねる） */}
        {reviewCandidate && (
          <div className="absolute inset-0 bg-white z-10 flex flex-col overflow-hidden rounded-t-3xl">
            {/* ヘッダー */}
            <div className="flex items-center gap-2 px-4 py-3 border-b bg-orange-50 shrink-0">
              <button onClick={() => setReviewCandidate(null)} className="text-gray-500 hover:text-gray-700 text-sm">← 戻る</button>
              <span className="font-bold text-orange-700 flex-1 text-center text-sm">テンプレートをブラッシュアップ</span>
            </div>

            {/* バッジ行 */}
            <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b shrink-0">
              <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-xs">
                {ACTION_LABELS[reviewCandidate.action_type] ?? reviewCandidate.action_type}
              </span>
              {reviewCandidate.source === "aix_edit" && (
                <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs">スタッフ編集版</span>
              )}
              {(reviewCandidate.evidence_count ?? 0) > 1 && (
                <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs">{reviewCandidate.evidence_count}回確認済み</span>
              )}
            </div>

            {/* 現在の提案テンプレ（Opusが修正するたびに更新） */}
            <div className="px-4 py-2 border-b bg-green-50 shrink-0">
              <div className="text-xs font-bold text-green-700 mb-1">現在の提案テンプレ</div>
              <div className="text-sm text-gray-800 whitespace-pre-wrap max-h-24 overflow-y-auto">{reviewCurrentText}</div>
            </div>

            {/* チャットエリア */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {reviewMessages.length === 0 && reviewSending && (
                <div className="text-sm text-indigo-400 animate-pulse">Opus 4.8 が分析中...</div>
              )}
              {reviewMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-orange-500 text-white rounded-br-sm"
                      : "bg-gray-100 text-gray-800 rounded-bl-sm"
                  }`}>
                    {msg.role === "assistant"
                      ? msg.content.replace(/【修正版】[\s\S]*?【\/修正版】/g, "↑ テンプレを更新しました").trim()
                      : msg.content}
                  </div>
                </div>
              ))}
              {reviewSending && reviewMessages.length > 0 && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2 text-sm text-gray-400 animate-pulse">入力中...</div>
                </div>
              )}
            </div>

            {/* 入力エリア */}
            <div className="border-t px-3 py-2 flex gap-2 items-end shrink-0">
              <textarea
                value={reviewInput}
                onChange={e => setReviewInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendReviewMessage(); } }}
                placeholder="「短くして」「もっと丁寧に」など..."
                className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm resize-none"
                rows={2}
                disabled={reviewSending}
              />
              <button
                onClick={() => void sendReviewMessage()}
                disabled={reviewSending || !reviewInput.trim()}
                className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 text-white rounded-xl px-3 py-2 text-sm font-bold"
              >送信</button>
            </div>

            {/* 採用ボタン */}
            <div className="border-t px-4 py-3 shrink-0">
              <button
                onClick={() => void adoptCandidate(reviewCandidate, reviewCurrentText !== reviewCandidate.template_text ? reviewCurrentText : undefined)}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 rounded-xl text-sm"
              >
                ✅ 承認して採用する（現在の提案テンプレを採用）
              </button>
            </div>
          </div>
        )}
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between rounded-t-3xl px-5 py-4 shrink-0"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          <div className="text-[17px] font-bold text-white">テンプレート一覧</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowAddForm((v) => !v); setNewCategory(category); }}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-white text-lg font-bold"
              title="新規テンプレートを追加"
            >
              ＋
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
            >
              ✕
            </button>
          </div>
        </div>
        {/* 検索欄 */}
        <div className="px-4 py-2 bg-white border-b border-[#f0f2f5] shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="🔍 テンプレートを検索..."
            className="w-full rounded-full border border-[#d1d7db] px-4 py-1.5 text-[12px] outline-none focus:border-[#2196F3] bg-[#f8f9fa]"
          />
        </div>

        {/* カテゴリタブ（検索中は非表示） */}
        {!showAddForm && !isSearching && (
          <>
            {/* メインタブ行（一般グループ + AIXグループ） */}
            <div ref={categoryScrollRef} className="flex gap-2 overflow-x-auto border-b border-[#f0f2f5] bg-white px-4 py-2.5 shrink-0 scroll-smooth" style={{ scrollbarWidth: "none" }}>
              {categories.length === 0 && !loading && (
                <span className="text-[12px] text-[#aaa] py-1">カテゴリなし（テンプレートを追加してください）</span>
              )}
              {/* 一般まとめボタン */}
              {normalCategories.length > 0 && (
                <button
                  onClick={() => {
                    setIsCandidateTabActive(false);
                    if (isAixCategoryActive || !category) setCategory(normalCategories[0]);
                  }}
                  className="shrink-0 rounded-full px-4 py-1.5 text-[12px] font-bold transition"
                  style={
                    !isAixCategoryActive && !isCandidateTabActive
                      ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white" }
                      : { backgroundColor: "#f0f2f5", color: "#54656f" }
                  }
                >
                  一般 ({templates.filter(t => !t.category.includes("AIX")).length})
                </button>
              )}
              {/* AIXまとめボタン */}
              {aixCategories.length > 0 && (
                <button
                  onClick={() => {
                    setIsCandidateTabActive(false);
                    if (!isAixCategoryActive) setCategory(aixCategories[0]);
                  }}
                  className="shrink-0 rounded-full px-4 py-1.5 text-[12px] font-bold transition"
                  style={
                    isAixCategoryActive && !isCandidateTabActive
                      ? { background: "linear-gradient(135deg, #7B1FA2, #9C27B0)", color: "white" }
                      : { backgroundColor: "#f0f2f5", color: "#54656f" }
                  }
                >
                  【AIX】
                </button>
              )}
              {/* 🤖AI提案まとめタブ（候補・AIX候補・改善案・AI質問を集約） */}
              <button
                onClick={() => {
                  setIsCandidateTabActive(true);
                  setCandidateSubTab("all");
                  setCategory(""); // 一般・AIXタブを非アクティブに
                }}
                className="shrink-0 rounded-full px-4 py-1.5 text-[12px] font-bold transition"
                style={
                  isCandidateTabActive
                    ? { background: "linear-gradient(135deg, #059669, #10B981)", color: "white" }
                    : { backgroundColor: "#f0f2f5", color: "#54656f" }
                }
              >
                🤖AI提案{(() => {
                  // aix_edit候補はsuggestionsに統合されているため二重カウントを避ける
                  // adopted（実装待ち）はバッジ件数から除外する
                  const total =
                    candidates.filter(c => !c.is_adopted && !c.is_dismissed && c.source !== "aix_edit").length +
                    suggestions.filter(s => s.status !== "adopted").length +
                    feedbackItems.filter(f => f.status === "pending").length;
                  return total > 0 ? ` (${total})` : "";
                })()}
              </button>
            </div>
            {/* 一般サブタブ行（一般カテゴリ選択中のみ表示） */}
            {!isCandidateTabActive && !isAixCategoryActive && normalCategories.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto border-b border-[#e3e8ef] bg-[#f8f9fb] px-4 py-2 shrink-0 scroll-smooth" style={{ scrollbarWidth: "none" }}>
                {normalCategories.map((cat) => (
                  <div
                    key={cat}
                    ref={el => { categoryTabRefs.current[cat] = el as unknown as HTMLButtonElement; }}
                    className="shrink-0 flex items-center rounded-full text-[11px] font-bold transition overflow-hidden"
                    style={
                      category === cat
                        ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white" }
                        : { backgroundColor: "#e8edf2", color: "#54656f" }
                    }
                  >
                    {editingCategory === cat ? (
                      <input
                        ref={categoryEditInputRef}
                        value={editingCategoryName}
                        onChange={e => setEditingCategoryName(e.target.value)}
                        onBlur={commitCategoryRename}
                        onKeyDown={e => {
                          if (e.key === "Enter") { e.preventDefault(); void commitCategoryRename(); }
                          if (e.key === "Escape") { setEditingCategory(null); }
                        }}
                        className="bg-transparent outline-none min-w-[60px] max-w-[120px] px-3 py-1.5 text-[11px] font-bold"
                        style={{ color: "white" }}
                      />
                    ) : (
                      <>
                        <button onClick={() => setCategory(cat)} className="pl-3 py-1.5 pr-1">
                          {cat}
                          <span className={`ml-1 text-[9px] ${category === cat ? "opacity-70" : "opacity-50"}`}>
                            ({templates.filter(t => t.category === cat).length})
                          </span>
                        </button>
                        <button
                          onClick={() => {
                            setCategory(cat);
                            setEditingCategory(cat);
                            setEditingCategoryName(cat);
                            setTimeout(() => { categoryEditInputRef.current?.select(); }, 20);
                          }}
                          className="pr-2 py-1.5 opacity-60 hover:opacity-100"
                          title="カテゴリ名を編集"
                        >✏️</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* AIXサブタブ行（AIXカテゴリ選択中のみ表示） */}
            {!isCandidateTabActive && isAixCategoryActive && aixCategories.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto border-b border-purple-100 bg-[#faf5ff] px-4 py-2 shrink-0 scroll-smooth" style={{ scrollbarWidth: "none" }}>
                {aixCategories.map((cat) => (
                  <div
                    key={cat}
                    ref={el => { categoryTabRefs.current[cat] = el as unknown as HTMLButtonElement; }}
                    className="shrink-0 flex items-center rounded-full text-[11px] font-bold transition overflow-hidden"
                    style={
                      category === cat
                        ? { background: "linear-gradient(135deg, #7B1FA2, #9C27B0)", color: "white" }
                        : { backgroundColor: "#ede7f6", color: "#7B1FA2" }
                    }
                  >
                    {editingCategory === cat ? (
                      <input
                        ref={categoryEditInputRef}
                        value={editingCategoryName}
                        onChange={e => setEditingCategoryName(e.target.value)}
                        onBlur={commitCategoryRename}
                        onKeyDown={e => {
                          if (e.key === "Enter") { e.preventDefault(); void commitCategoryRename(); }
                          if (e.key === "Escape") { setEditingCategory(null); }
                        }}
                        className="bg-transparent outline-none min-w-[60px] max-w-[120px] px-3 py-1.5 text-[11px] font-bold"
                        style={{ color: "white" }}
                      />
                    ) : (
                      <>
                        <button onClick={() => setCategory(cat)} className="pl-3 py-1.5 pr-1">
                          {CATEGORY_DISPLAY_NAMES[cat] ?? cat.replace("【AIX】", "").trim()}
                          <span className={`ml-1 text-[9px] ${category === cat ? "opacity-70" : "opacity-50"}`}>
                            ({templates.filter(t => t.category === cat).length})
                          </span>
                        </button>
                        <button
                          onClick={() => {
                            setCategory(cat);
                            setEditingCategory(cat);
                            setEditingCategoryName(cat);
                            setTimeout(() => { categoryEditInputRef.current?.select(); }, 20);
                          }}
                          className="pr-2 py-1.5 opacity-60 hover:opacity-100"
                          title="カテゴリ名を編集"
                        >✏️</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* AI提案サブタブ行（AI提案タブ選択中のみ表示） */}
            {isCandidateTabActive && (
              <div className="flex gap-1.5 overflow-x-auto border-b border-emerald-100 bg-[#f0fdf4] px-4 py-2 shrink-0 scroll-smooth" style={{ scrollbarWidth: "none" }}>
                {/* ✨候補 */}
                <button
                  onClick={() => setCandidateSubTab("all")}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    candidateSubTab === "all"
                      ? { background: "linear-gradient(135deg, #059669, #10B981)", color: "white" }
                      : { backgroundColor: "#e8edf2", color: "#54656f" }
                  }
                >
                  ✨候補{(() => {
                    const count = candidates.filter(c => !c.is_adopted && !c.is_dismissed && c.source !== "aix_edit" && c.source !== "improvement").length;
                    return count > 0 ? ` (${count})` : "";
                  })()}
                </button>
                {/* ✏️AIX候補 → 改善案タブ「① AIXボタン」フィルタへリダイレクト */}
                <button
                  onClick={() => { setCandidateSubTab("suggestions"); setSuggestionCategoryFilter("new_aix_button"); }}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    candidateSubTab === "suggestions" && suggestionCategoryFilter === "new_aix_button"
                      ? { background: "linear-gradient(135deg, #059669, #10B981)", color: "white" }
                      : { backgroundColor: "#e8edf2", color: "#54656f" }
                  }
                >
                  ✏️AIX候補{(() => {
                    const count = suggestions.filter(s => s.proposal_category === "new_aix_button").length
                      || candidates.filter(c => !c.is_adopted && !c.is_dismissed && c.source === "aix_edit").length;
                    return count > 0 ? ` (${count})` : "";
                  })()}
                </button>
                {/* 💡改善案 */}
                <button
                  onClick={() => setCandidateSubTab("suggestions")}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    candidateSubTab === "suggestions"
                      ? { background: "linear-gradient(135deg, #059669, #10B981)", color: "white" }
                      : { backgroundColor: "#e8edf2", color: "#54656f" }
                  }
                >
                  💡改善案{(() => {
                    // adopted（実装待ち）はバッジ件数から除外する
                    const count = suggestions.filter(s => s.status !== "adopted").length + improvementCandidates.length;
                    return count > 0 ? ` (${count})` : "";
                  })()}
                </button>
                {/* ❓AI質問 */}
                <button
                  onClick={() => setCandidateSubTab("feedback")}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    candidateSubTab === "feedback"
                      ? { background: "linear-gradient(135deg, #059669, #10B981)", color: "white" }
                      : { backgroundColor: "#e8edf2", color: "#54656f" }
                  }
                >
                  ❓AI質問{(() => {
                    const count = feedbackItems.filter(f => f.status === "pending").length;
                    return count > 0 ? ` (${count})` : "";
                  })()}
                  {knowledgeGapPendingCount > 0 && (
                    <span className="ml-1 rounded-full bg-orange-500 px-1.5 text-[10px] text-white">
                      承認{knowledgeGapPendingCount}
                    </span>
                  )}
                </button>
                {/* 🧠ナレッジ承認 */}
                <button
                  onClick={() => setCandidateSubTab("knowledge")}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    candidateSubTab === "knowledge"
                      ? { background: "linear-gradient(135deg, #7B1FA2, #AB47BC)", color: "white" }
                      : { backgroundColor: "#e8edf2", color: "#54656f" }
                  }
                >
                  🧠ナレッジ{knowledgeItems.length > 0 ? ` (${knowledgeItems.length})` : ""}
                </button>
                {/* ⭐永久ルール管理 */}
                <button
                  onClick={() => setCandidateSubTab("rules")}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    candidateSubTab === "rules"
                      ? { background: "linear-gradient(135deg, #D97706, #F59E0B)", color: "white" }
                      : { backgroundColor: "#e8edf2", color: "#54656f" }
                  }
                >
                  ⭐永久ルール{humanRulesList.filter(r => r.is_permanent).length > 0 ? ` (${humanRulesList.filter(r => r.is_permanent).length})` : ""}
                </button>
              </div>
            )}
          </>
        )}

        {/* スクロール領域 */}
        <div className="flex-1 overflow-y-auto">

          {/* 新規追加フォーム */}
          {showAddForm && (
            <div ref={addFormRef} className="p-4 border-b border-[#f0f2f5] bg-[#f8f9fa]">
              <div className="text-[13px] font-bold text-[#1565C0] mb-3">新しいテンプレートを追加</div>
              <div className="flex flex-col gap-2.5">
                <div>
                  <div className="text-[11px] text-[#667781] mb-1">カテゴリ</div>
                  <div className="flex gap-2 flex-wrap">
                    {["全般", "初回応対", "物件探し中", "内覧", "申込・審査", "契約・成約", "その他"].map((c) => (
                      <button
                        key={c}
                        onClick={() => setNewCategory(c)}
                        className="rounded-full px-3 py-1 text-[11px] font-bold border transition"
                        style={
                          newCategory === c
                            ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white", borderColor: "transparent" }
                            : { backgroundColor: "white", color: "#54656f", borderColor: "#d1d7db" }
                        }
                      >
                        {c}
                      </button>
                    ))}
                    <input
                      className="rounded-full border border-[#d1d7db] px-3 py-1 text-[11px] outline-none w-32"
                      placeholder="カテゴリ名を入力"
                      value={["全般","初回応対","物件探し中","内覧","申込・審査","契約・成約","その他"].includes(newCategory) ? "" : newCategory}
                      onChange={(e) => setNewCategory(e.target.value || "全般")}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-[#667781] mb-1">テンプレート名</div>
                  <input
                    className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="例：内覧お誘い"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                </div>
                <div>
                  <div className="text-[11px] text-[#667781] mb-1">テンプレート本文</div>
                  <textarea
                    className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3] resize-none"
                    rows={5}
                    placeholder="LINEで送るテンプレート文を入力..."
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                  />
                </div>
                <button
                  onClick={() => setNewRequiresImage(v => !v)}
                  className={`w-full rounded-xl border py-2 text-[12px] font-bold transition ${newRequiresImage ? "border-orange-400 bg-orange-50 text-orange-600" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                >
                  📎 {newRequiresImage ? "画像添付必要（オン）" : "画像添付必要（オフ）"}
                </button>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setShowAddForm(false); setNewLabel(""); setNewText(""); setNewCategory("全般"); setNewRequiresImage(false); }}
                    className="rounded-full px-4 py-2 text-[12px] font-bold text-[#667781] border border-[#d1d7db]"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleAdd}
                    disabled={saving || !newLabel.trim() || !newText.trim()}
                    className="rounded-full px-5 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AIXテンプレート候補一覧（✨ 全候補タブ） */}
          {!showAddForm && isCandidateTabActive && candidateSubTab === "all" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {candidateLoading && (
                <p className="text-center text-gray-400 py-8">読み込み中...</p>
              )}
              {!candidateLoading && candidates.filter(c => !c.is_adopted && !c.is_dismissed && c.source !== "aix_edit" && c.source !== "improvement").length === 0 && (
                <div className="text-center text-gray-400 py-12">
                  <p className="text-2xl mb-2">🤖</p>
                  <p className="text-sm">AIXボタンで送信した文が候補として表示されます</p>
                </div>
              )}
              {!candidateLoading && (() => {
                const pending = candidates.filter(c => !c.is_adopted && !c.is_dismissed && c.source !== "aix_edit" && c.source !== "improvement");
                // カテゴリ順でグルーピング
                const byCategory: Record<string, AiTemplateCandidate[]> = {};
                for (const c of pending) {
                  if (!byCategory[c.category]) byCategory[c.category] = [];
                  byCategory[c.category].push(c);
                }
                return Object.entries(byCategory).map(([cat, items]) => (
                  <div key={cat}>
                    <p className="text-xs font-semibold text-emerald-600 mb-2 px-1">{cat}</p>
                    {items.map(candidate => (
                      <div
                        key={candidate.id}
                        className="bg-white rounded-xl border border-gray-200 p-3 mb-2 shadow-sm"
                      >
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {/* カテゴリバッジ */}
                          {candidate.category && (
                            <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0"
                              style={{ backgroundColor: getCategoryColor(candidate.action_type) + "20", color: getCategoryColor(candidate.action_type) }}>
                              {CATEGORY_DISPLAY_NAMES[candidate.category] ?? candidate.category.replace("【AIX】", "").trim()}
                            </span>
                          )}
                          <p className="text-xs text-gray-500 font-medium">{candidate.suggested_title}</p>
                          {(candidate.evidence_count ?? 1) >= 2 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium shrink-0">
                              📊 {candidate.evidence_count}回同じ編集パターン
                            </span>
                          )}
                        </div>
                        {candidate.reason && (
                          <p className="text-[11px] text-gray-400 mb-1">{candidate.reason}</p>
                        )}
                        <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed mb-3">
                          {candidate.template_text}
                        </p>
                        <div className="flex gap-2">
                          <button
                            disabled={adoptingId === candidate.id}
                            onClick={() => openReviewPanel(candidate)}
                            className="flex-1 py-1.5 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 disabled:opacity-50 transition"
                          >
                            {adoptingId === candidate.id ? "採用中..." : "✅ 採用"}
                          </button>
                          <button
                            onClick={() => setDismissingId(dismissingId === candidate.id ? null : candidate.id)}
                            className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-500 text-sm hover:bg-gray-200 transition"
                          >
                            却下
                          </button>
                        </div>
                        {/* P5: 却下理由チップ */}
                        {dismissingId === candidate.id && (
                          <div className="mt-2 rounded-lg bg-gray-50 p-2">
                            <p className="text-[11px] text-gray-400 mb-1.5">却下理由を選ぶとAIが学習します</p>
                            <div className="flex flex-wrap gap-1.5">
                              {DISMISS_REASONS.map(r => (
                                <button
                                  key={r}
                                  onClick={() => dismissCandidate(candidate.id, r)}
                                  className="px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-600 text-[11px] hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition"
                                >
                                  {r}
                                </button>
                              ))}
                              <button
                                onClick={() => dismissCandidate(candidate.id)}
                                className="px-2 py-1 rounded-full bg-white border border-gray-100 text-gray-400 text-[11px] hover:bg-gray-100 transition"
                              >
                                理由なしで却下
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ));
              })()}
            </div>
          )}

          {/* P4: AIX改善案一覧（💡 aix_feature_suggestions の pending） */}
          {!showAddForm && isCandidateTabActive && candidateSubTab === "suggestions" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {suggestionLoading && (
                <p className="text-center text-gray-400 py-8">読み込み中...</p>
              )}
              {!suggestionLoading && suggestions.length === 0 && improvementCandidates.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-gray-400">
                  <span className="text-3xl">💡</span>
                  <p className="text-sm font-medium">改善案はまだありません</p>
                  <p className="text-xs text-center">毎週日曜朝5時にAIが分析して<br/>改善案を自動追加します</p>
                </div>
              )}
              {!suggestionLoading && suggestions.length > 0 && (() => {
                // 各フィルターの件数を getEffectiveProposalCategory（suggestion_type込みの正しい分類）で集計
                const catCounts: Record<string, number> = { all: suggestions.length };
                for (const s of suggestions) {
                  const c = getEffectiveProposalCategory(s);
                  catCounts[c] = (catCounts[c] ?? 0) + 1;
                }
                return (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {[
                    { key: 'all', label: 'すべて' },
                    { key: 'new_aix_button', label: '① AIXボタン' },
                    { key: 'new_picker', label: '② ピッカー' },
                    { key: 'new_button', label: '③ ボタン追加' },
                    { key: 'text_improvement', label: '✏️ 文の改善' },
                    { key: 'mismatch_fix', label: '🔄 ズレ修正' },
                    { key: 'other', label: '💡 その他' },
                  ].map(cat => (
                    <button
                      key={cat.key}
                      onClick={() => setSuggestionCategoryFilter(cat.key)}
                      style={{
                        padding: '3px 10px',
                        borderRadius: 20,
                        border: '1px solid #ccc',
                        background: suggestionCategoryFilter === cat.key ? '#1a56db' : '#f3f4f6',
                        color: suggestionCategoryFilter === cat.key ? '#fff' : '#374151',
                        fontSize: 12,
                        cursor: 'pointer',
                        fontWeight: suggestionCategoryFilter === cat.key ? 600 : 400,
                      }}
                    >{cat.label}{(catCounts[cat.key] ?? 0) > 0 ? ` ${catCounts[cat.key]}` : ''}</button>
                  ))}
                </div>
                );
              })()}
              {!suggestionLoading && (() => {
                // 【フィルター分離】proposal_category が 'other'/未知値でも suggestion_type から
                // 正しいカテゴリに割り当てる（①AIXボタンと②ピッカーに同じカードが出るバグの修正）
                const filteredSuggestions = suggestionCategoryFilter === 'all'
                  ? suggestions
                  : suggestions.filter(s => getEffectiveProposalCategory(s) === suggestionCategoryFilter);
                const PROPOSAL_CAT_MAP: Record<string, { label: string; color: string }> = {
                  new_aix_button: { label: '① AIXボタン', color: '#7e3af2' },
                  new_picker: { label: '② ピッカー', color: '#1a56db' },
                  new_button: { label: '③ ボタン追加', color: '#057a55' },
                  text_improvement: { label: '✏️ 文の改善', color: '#c27803' },
                  mismatch_fix: { label: '🔄 ズレ修正', color: '#c81e1e' },
                  other: { label: '💡 改善案', color: '#6b7280' },
                };
                if (filteredSuggestions.length === 0 && suggestionCategoryFilter !== 'all' && suggestions.length > 0) {
                  return (
                    <p className="text-center text-gray-400 text-sm py-6">このカテゴリの改善案はありません</p>
                  );
                }
                return filteredSuggestions.map(suggestion => {
                  // --- aix_edit候補（統合）: diff view カードスタイル ---
                  if (suggestion._source === 'aix_candidates') {
                    return (
                      <div key={suggestion.id} className="bg-white rounded-xl border border-orange-200 p-3 mb-2 shadow-sm">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 12, background: '#7e3af2', color: '#fff', fontSize: 11, flexShrink: 0 }}>
                            ① AIXボタン
                          </span>
                          {suggestion.action_type && (
                            <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0"
                              style={{ backgroundColor: getCategoryColor(suggestion.action_type) + "20", color: getCategoryColor(suggestion.action_type) }}>
                              {ACTION_LABELS[suggestion.action_type] ?? suggestion.action_type}
                            </span>
                          )}
                          <p className="text-xs text-gray-500 font-medium">{suggestion.suggested_title}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                            (suggestion.evidence_count ?? 1) >= 3
                              ? "bg-red-50 text-red-600 font-bold"
                              : "bg-gray-100 text-gray-500 font-medium"
                          }`}>
                            ✏️ {suggestion.evidence_count ?? 1}件の編集
                          </span>
                        </div>
                        {suggestion.reason && (
                          <p className="text-[11px] text-gray-400 mb-2">{suggestion.reason}</p>
                        )}
                        {/* 差分ビュー: AI原文 → スタッフ編集後 */}
                        {suggestion.original_text ? (
                          <div className="mb-2 rounded-lg overflow-hidden border border-gray-100 text-xs">
                            <div className="bg-gray-50 px-2 py-1 text-[10px] font-bold text-gray-400 tracking-wide">AIが生成した原文</div>
                            <p className="px-2 py-2 text-gray-400 whitespace-pre-wrap leading-relaxed line-through decoration-gray-300">
                              {suggestion.original_text}
                            </p>
                            <div className="bg-orange-50 px-2 py-1 text-[10px] font-bold text-orange-400 tracking-wide">スタッフが編集した文（送信済み）</div>
                            <p className="px-2 py-2 text-gray-800 whitespace-pre-wrap leading-relaxed">
                              {suggestion.template_text}
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed mb-3">
                            {suggestion.template_text}
                          </p>
                        )}
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => {
                              const cand: AiTemplateCandidate = {
                                id: suggestion.id,
                                action_type: suggestion.action_type ?? "",
                                category: suggestion.category ?? "",
                                suggested_title: suggestion.suggested_title,
                                template_text: suggestion.template_text ?? "",
                                original_text: suggestion.original_text ?? null,
                                reason: suggestion.reason ?? null,
                                evidence_count: suggestion.evidence_count ?? null,
                                created_at: suggestion.created_at,
                                is_adopted: false,
                                is_dismissed: false,
                                source: "aix_edit",
                              };
                              openReviewPanel(cand);
                            }}
                            className="flex-1 py-1.5 rounded-lg bg-orange-400 text-white text-sm font-semibold hover:bg-orange-500 transition"
                          >
                            ✅ 確認して採用
                          </button>
                          <button
                            onClick={() => setDismissingId(dismissingId === suggestion.id ? null : suggestion.id)}
                            className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-500 text-sm hover:bg-gray-200 transition"
                          >
                            却下
                          </button>
                        </div>
                        {dismissingId === suggestion.id && (
                          <div className="mt-2 rounded-lg bg-gray-50 p-2">
                            <p className="text-[11px] text-gray-400 mb-1.5">却下理由を選ぶとAIが学習します</p>
                            <div className="flex flex-wrap gap-1.5">
                              {DISMISS_REASONS.map(r => (
                                <button
                                  key={r}
                                  onClick={() => void dismissMergedAixCandidate(suggestion.id, r)}
                                  className="px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-600 text-[11px] hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition"
                                >
                                  {r}
                                </button>
                              ))}
                              <button
                                onClick={() => void dismissMergedAixCandidate(suggestion.id)}
                                className="px-2 py-1 rounded-full bg-white border border-gray-100 text-gray-400 text-[11px] hover:bg-gray-100 transition"
                              >
                                理由なしで却下
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }
                  // --- 通常の改善案カード（aix_feature_suggestions） ---
                  const propCat = PROPOSAL_CAT_MAP[getEffectiveProposalCategory(suggestion)] ?? PROPOSAL_CAT_MAP.other;
                  // ズレ自動検出カード: implementation_notes から AI文/実送信文/ズレ種類を構造化表示する
                  const alignNotes = suggestion.suggestion_type === "alignment_fix"
                    ? parseAlignmentNotes(suggestion.implementation_notes)
                    : null;
                  return (
                  <div
                    key={suggestion.id}
                    className="bg-white rounded-xl border border-violet-200 p-3 shadow-sm"
                  >
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${
                        (SUGGESTION_TYPE_BADGE[suggestion.suggestion_type] ?? SUGGESTION_TYPE_BADGE.new_picker).className
                      }`}>
                        {(SUGGESTION_TYPE_BADGE[suggestion.suggestion_type] ?? SUGGESTION_TYPE_BADGE.new_picker).label}
                      </span>
                      {/* 打ち合わせ済み（status="approved"）: Opus 4.8との打ち合わせで確定した実装待ち仕様 */}
                      {suggestion.status === "approved" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-bold shrink-0">
                          🤝 打ち合わせ済み
                        </span>
                      )}
                      {/* 採用済み・実装待ち（new_picker/new_button/new_aix の adopted） */}
                      {suggestion.status === "adopted" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-bold shrink-0">
                          ✅ 採用済み・実装待ち
                        </span>
                      )}
                      {/* AIXボタン名バッジ（action_typeがある場合） */}
                      {suggestion.action_type && (
                        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0"
                          style={{ backgroundColor: getCategoryColor(suggestion.action_type) + "20", color: getCategoryColor(suggestion.action_type) }}>
                          {getAixActionLabel(suggestion.action_type)}
                        </span>
                      )}
                      <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 12, background: propCat.color, color: '#fff', fontSize: 11, marginBottom: 4, flexShrink: 0 }}>
                        {propCat.label}
                      </span>
                      <p className="text-sm text-gray-800 font-semibold">{suggestion.suggested_title}</p>
                      {(suggestion.evidence_count ?? 1) >= 2 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium shrink-0">
                          📊 {suggestion.evidence_count}回同じパターン
                        </span>
                      )}
                    </div>
                    {/* ズレ自動検出: AIXボタン名・ズレの種類・AI文/実送信文を構造化して表示 */}
                    {alignNotes && (
                      <div className="mb-2 space-y-2">
                        <p className="text-sm font-bold text-gray-800">
                          🤖 AIX: {getAixActionLabel(suggestion.action_type ?? "")}
                          {suggestion.action_type && (
                            <span className="ml-2 text-[10px] font-normal text-gray-400">（{suggestion.action_type}）</span>
                          )}
                        </p>
                        <p className="text-sm text-red-600 font-medium">
                          ⚡ ズレの種類: {alignNotes.mismatchLabel}
                          {alignNotes.similarity != null && (
                            <span className="ml-1 text-xs font-normal text-gray-400">（一致度 {Math.round(alignNotes.similarity * 100)}%）</span>
                          )}
                        </p>
                        {alignNotes.aiDraft && (
                          <div className="bg-blue-50 rounded-lg p-2">
                            <p className="text-[11px] text-blue-600 font-bold mb-1">🤖 AIが生成した文</p>
                            <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{alignNotes.aiDraft}</p>
                          </div>
                        )}
                        {alignNotes.sentText && (
                          <div className="bg-green-50 rounded-lg p-2">
                            <p className="text-[11px] text-green-600 font-bold mb-1">✏️ スタッフが実際に送った文</p>
                            <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{alignNotes.sentText}</p>
                          </div>
                        )}
                        <p className="text-sm text-gray-600">💡 {alignNotes.explanation}</p>
                      </div>
                    )}
                    {/* 📋 なぜこの改善が必要か: description 全文（承認/却下の判断材料） */}
                    {/* ズレ自動検出カードは構造化表示（上）に集約するため description は出さない（重複防止） */}
                    {suggestion.description && !alignNotes && (
                      <div className="mb-2">
                        <p className="text-[11px] font-bold text-violet-500 mb-0.5">📋 なぜこの改善が必要か</p>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                          {suggestion.description}
                        </p>
                      </div>
                    )}
                    {/* 📊 根拠: reason ＋ 観察回数 */}
                    {(suggestion.reason || (suggestion.evidence_count ?? 0) >= 2) && (
                      <div className="mb-2">
                        <p className="text-[11px] font-bold text-gray-500 mb-0.5">📊 根拠</p>
                        <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">
                          {[
                            suggestion.reason,
                            (suggestion.evidence_count ?? 0) >= 2 ? `同じパターンが${suggestion.evidence_count}回観察されました` : null,
                          ].filter(Boolean).join("\n")}
                        </p>
                      </div>
                    )}
                    {/* 🔧 実装メモ: implementation_notes の要点（JSONはパースして表示） */}
                    {/* ズレ自動検出カードは構造化表示で全内容を出しているため実装メモは省略 */}
                    {(() => {
                      if (alignNotes) return null;
                      const notes = extractNotesSummary(suggestion.implementation_notes);
                      if (!notes || notes === suggestion.description) return null;
                      return (
                        <details className="mb-2">
                          <summary className="text-[11px] text-gray-400 cursor-pointer select-none">🔧 実装メモ・詳細を見る</summary>
                          <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed mt-1 bg-gray-50 rounded-lg p-2">
                            {notes}
                          </p>
                        </details>
                      );
                    })()}
                    <div className="flex gap-2">
                      {(suggestion.status === "approved" || suggestion.status === "adopted") ? (
                        <button
                          onClick={() => updateSuggestionStatus(suggestion.id, "implemented")}
                          className="flex-1 py-1.5 rounded-lg bg-green-500 text-white text-sm font-semibold hover:bg-green-600 transition"
                        >
                          🚀 実装完了
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            // aix_feature_suggestions を AiTemplateCandidate 形式に変換してレビューパネルへ
                            const pseudoCandidate: AiTemplateCandidate = {
                              id: suggestion.id,
                              action_type: suggestion.action_type ?? "",
                              category: suggestion.action_type ?? "",
                              suggested_title: suggestion.suggested_title,
                              template_text: suggestion.description ?? suggestion.suggested_title,
                              original_text: null,
                              reason: suggestion.reason,
                              evidence_count: suggestion.evidence_count,
                              created_at: suggestion.created_at,
                              is_adopted: false,
                              is_dismissed: false,
                              source: "suggestion",
                            };
                            openReviewPanel(pseudoCandidate);
                          }}
                          className="flex-1 py-1.5 rounded-lg bg-violet-500 text-white text-sm font-semibold hover:bg-violet-600 transition"
                        >
                          ✅ 確認して採用
                        </button>
                      )}
                      {/* 採用済みは却下不要なので非表示 */}
                      {suggestion.status !== "adopted" && (
                        <button
                          onClick={() => setDismissingId(dismissingId === suggestion.id ? null : suggestion.id)}
                          className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-500 text-sm hover:bg-gray-200 transition"
                        >
                          却下
                        </button>
                      )}
                    </div>
                    {/* P5: 却下理由チップ */}
                    {dismissingId === suggestion.id && suggestion.status !== "adopted" && (
                      <div className="mt-2 rounded-lg bg-gray-50 p-2">
                        <p className="text-[11px] text-gray-400 mb-1.5">却下理由を選ぶとAIが学習します</p>
                        <div className="flex flex-wrap gap-1.5">
                          {DISMISS_REASONS.map(r => (
                            <button
                              key={r}
                              onClick={() => updateSuggestionStatus(suggestion.id, "dismissed", r)}
                              className="px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-600 text-[11px] hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition"
                            >
                              {r}
                            </button>
                          ))}
                          <button
                            onClick={() => updateSuggestionStatus(suggestion.id, "dismissed")}
                            className="px-2 py-1 rounded-full bg-white border border-gray-100 text-gray-400 text-[11px] hover:bg-gray-100 transition"
                          >
                            理由なしで却下
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                });
              })()}
              {/* 追加パターン検出（ai_template_candidates source="improvement"）: スタッフがAI文に情報を追加したパターン。
                  カテゴリ未分類の生データのため「すべて」フィルターのみに表示する
                  （①②③のカテゴリフィルターに漏れて同じカードが全フィルターに出るバグの修正） */}
              {!suggestionLoading && suggestionCategoryFilter === 'all' && improvementCandidates.map(candidate => (
                <div
                  key={candidate.id}
                  className="bg-white rounded-xl border border-violet-200 p-3 shadow-sm"
                >
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {/* AIXボタン名バッジ */}
                    {candidate.category && (
                      <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0"
                        style={{ backgroundColor: getCategoryColor(candidate.action_type) + "20", color: getCategoryColor(candidate.action_type) }}>
                        {CATEGORY_DISPLAY_NAMES[candidate.category] ?? candidate.category.replace("【AIX】", "").trim()}
                      </span>
                    )}
                    <p className="text-xs text-gray-500 font-medium">
                      {candidate.suggested_title || (candidate.reason ?? "").slice(0, 50)}
                    </p>
                    {(candidate.evidence_count ?? 1) >= 2 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium shrink-0">
                        📊 {candidate.evidence_count}回同じ編集パターン
                      </span>
                    )}
                  </div>
                  {/* 📋 なぜこの改善が必要か: 承認/却下の判断材料になる説明 */}
                  <div className="mb-2">
                    <p className="text-[11px] font-bold text-violet-500 mb-0.5">📋 なぜこの改善が必要か</p>
                    <p className="text-xs text-gray-600 leading-relaxed">
                      スタッフがAIの生成文へ同じ内容を{candidate.evidence_count ?? 1}回手動で追加していました。
                      この情報をピッカー/ボタンで選べるようにすれば、毎回の手入力が不要になり、AIが最初から完成した文を生成できます。
                    </p>
                  </div>
                  {candidate.reason && (
                    <p className="text-[11px] text-gray-400 mb-2">📊 根拠: {candidate.reason}</p>
                  )}
                  {/* 差分ビュー: AI原文 → スタッフが追加した文 */}
                  {candidate.original_text && (
                    <div className="mb-2 rounded-lg overflow-hidden border border-gray-100 text-xs">
                      <div className="bg-gray-50 px-2 py-1 text-[10px] font-bold text-gray-400 tracking-wide">AIが生成した原文</div>
                      <p className="px-2 py-2 text-gray-400 whitespace-pre-wrap leading-relaxed line-through decoration-gray-300">
                        {candidate.original_text}
                      </p>
                      <div className="bg-orange-50 px-2 py-1 text-[10px] font-bold text-orange-400 tracking-wide">スタッフが編集した文（送信済み）</div>
                      <p className="px-2 py-2 text-gray-800 whitespace-pre-wrap leading-relaxed">
                        {candidate.template_text}
                      </p>
                    </div>
                  )}
                  {!candidate.original_text && (
                    <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed mb-3">
                      {candidate.template_text}
                    </p>
                  )}
                  <div className="flex gap-2 mt-2">
                    <button
                      disabled={adoptingId === candidate.id}
                      onClick={() => void openMeetingPanel(candidate)}
                      className="flex-1 py-1.5 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 transition"
                    >
                      🤝 Opus 4.8と打ち合わせ
                    </button>
                    <button
                      onClick={() => setDismissingId(dismissingId === candidate.id ? null : candidate.id)}
                      className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-500 text-sm hover:bg-gray-200 transition"
                    >
                      却下
                    </button>
                  </div>
                  {/* P5: 却下理由チップ */}
                  {dismissingId === candidate.id && (
                    <div className="mt-2 rounded-lg bg-gray-50 p-2">
                      <p className="text-[11px] text-gray-400 mb-1.5">却下理由を選ぶとAIが学習します</p>
                      <div className="flex flex-wrap gap-1.5">
                        {DISMISS_REASONS.map(r => (
                          <button
                            key={r}
                            onClick={() => dismissCandidate(candidate.id, r)}
                            className="px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-600 text-[11px] hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition"
                          >
                            {r}
                          </button>
                        ))}
                        <button
                          onClick={() => dismissCandidate(candidate.id)}
                          className="px-2 py-1 rounded-full bg-white border border-gray-100 text-gray-400 text-[11px] hover:bg-gray-100 transition"
                        >
                          理由なしで却下
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* AI盲点フィードバック一覧（❓ ai_feedback_items の pending + answered） */}
          {!showAddForm && isCandidateTabActive && candidateSubTab === "feedback" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {(feedbackLoading || knowledgeQuestionsLoading) && (
                <p className="text-center text-gray-400 py-8">読み込み中...</p>
              )}
              {!feedbackLoading && !knowledgeQuestionsLoading && feedbackItems.length === 0 && knowledgeQuestions.length === 0 && (
                <div className="text-center text-gray-400 py-12">
                  <p className="text-2xl mb-2">❓</p>
                  <p className="text-sm font-medium text-gray-500">AIからの質問はまだありません</p>
                  <p className="text-sm text-gray-400">（週次corpus2skillで生成されます）</p>
                </div>
              )}
              {/* 🔍 ナレッジ品質確認: auto-judgeが生成した quality_question（knowledge_question type） */}
              {!knowledgeQuestionsLoading && knowledgeQuestions.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs font-bold text-blue-600 flex items-center gap-1">🔍 ナレッジ品質確認 <span className="font-normal text-blue-400">（自動判定で要確認フラグがついたルール）</span></p>
                  {knowledgeQuestions.map((item) => {
                    let parsedNotes: { knowledge_id?: string; original_content?: string } = {};
                    try { parsedNotes = JSON.parse(item.implementation_notes ?? "{}") as { knowledge_id?: string; original_content?: string }; } catch { /* noop */ }
                    return (
                      <div key={item.id} className="border border-blue-200 rounded-xl p-4 bg-blue-50">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-bold">
                            🔍 ナレッジ品質確認
                          </span>
                          {item.action_type && (
                            <span className="text-xs text-blue-400">{item.action_type}</span>
                          )}
                        </div>
                        <p className="font-medium text-gray-800 text-sm mb-2">❓ {item.description}</p>
                        {parsedNotes.original_content && (
                          <p className="text-xs text-gray-500 mb-3 bg-white rounded-lg p-2 border border-blue-100 line-clamp-3">
                            📄 {parsedNotes.original_content.slice(0, 200)}
                          </p>
                        )}
                        <textarea
                          value={knowledgeQuestionAnswers[item.id] ?? ""}
                          onChange={e => setKnowledgeQuestionAnswers(prev => ({ ...prev, [item.id]: e.target.value }))}
                          placeholder="修正内容・確認事項を入力してください（そのままでOKなら「このルールで問題ない」と入力）..."
                          className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
                        />
                        <div className="mt-2">
                          <button
                            onClick={() => void submitKnowledgeQuestionAnswer(item)}
                            disabled={!knowledgeQuestionAnswers[item.id]?.trim() || submittingKnowledgeQuestion === item.id}
                            className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition"
                          >
                            {submittingKnowledgeQuestion === item.id ? "反映中..." : "✅ この回答で最高優先反映（HUMAN-ルール作成）"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* adapt_feedback（会話を合わせる）は他のカテゴリと分けて一番下にまとめて表示する */}
              {!feedbackLoading && (() => {
                const renderFeedbackItem = (item: FeedbackItem) => {
                  const { cleanText, phase, importance, embeddedCategory, aiDraftExample, staffSentExample } = parseAiQuestion(item.question);
                  // 矛盾系質問の判定: questionに「どちら」「矛盾」「既存」「[old_knowledge_id:」が含まれる場合、選択ボタンUIに切り替える
                  const isContradiction = item.question.includes('どちら') || item.question.includes('矛盾') || item.question.includes('[old_knowledge_id:');
                  // ルール再確認の判定: questionに「[feedback_rule_key:」が含まれる場合、維持/無効化ボタンUIに切り替える
                  const isFeedbackRuleReconfirm = item.question.includes('[feedback_rule_key:');
                  return (
                <div key={item.id} className="border border-orange-200 rounded-xl p-4 bg-orange-50">
                  {/* カテゴリバッジ・フェーズ・重要度・埋め込みカテゴリ */}
                  <div className="flex flex-wrap items-center gap-1.5 mb-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-bold">
                      {FEEDBACK_CATEGORY_LABEL[item.category ?? ""] ?? item.category ?? "一般"}
                    </span>
                    {phase && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                        {AI_QUESTION_PHASE_LABELS[phase] ?? phase}
                      </span>
                    )}
                    {importance !== null && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium">
                        重要度 {importance}
                      </span>
                    )}
                    {embeddedCategory && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                        {AI_QUESTION_CATEGORY_LABELS[embeddedCategory] ?? embeddedCategory}
                      </span>
                    )}
                    <span className="text-xs text-gray-400 ml-auto">
                      確信度: {FEEDBACK_CONFIDENCE_LABEL[item.confidence ?? ""] ?? item.confidence ?? "中"}
                    </span>
                  </div>

                  {/* 質問本文（内部タグ・メタ行を除去済み・改行を保持して全文表示） */}
                  <p className="font-medium text-gray-800 text-sm mb-1 whitespace-pre-wrap">{cleanText}</p>

                  {/* 憶測 */}
                  {item.speculation && (
                    <p className="text-xs text-gray-500 mb-1 italic">💭 {item.speculation}</p>
                  )}

                  {/* 根拠 */}
                  {item.evidence && (
                    <p className="text-xs text-gray-400 mb-3">📊 {item.evidence}</p>
                  )}

                  {/* AI生成文の例（水色背景） */}
                  {aiDraftExample && (
                    <div className="rounded-lg px-3 py-2.5 mb-2 bg-cyan-50 border border-cyan-200">
                      <p className="text-[11px] font-bold text-cyan-600 mb-1 flex items-center gap-1">
                        🤖 <span>AI生成文の例</span>
                      </p>
                      <p className="text-xs text-cyan-900 whitespace-pre-wrap leading-relaxed">{aiDraftExample}</p>
                    </div>
                  )}

                  {/* スタッフ実送信文（緑背景） */}
                  {staffSentExample && (
                    <div className="rounded-lg px-3 py-2.5 mb-3 bg-green-50 border border-green-200">
                      <p className="text-[11px] font-bold text-green-600 mb-1 flex items-center gap-1">
                        ✅ <span>スタッフ実送信文</span>
                      </p>
                      <p className="text-xs text-green-900 whitespace-pre-wrap leading-relaxed">{staffSentExample}</p>
                    </div>
                  )}

                  {item.status === "pending" ? (
                    <>
                      {isFeedbackRuleReconfirm ? (
                        /* ルール再確認質問: 維持 vs 無効化 ボタン */
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button
                            onClick={() => submitFeedbackAnswer(item.id, 'keep')}
                            disabled={submittingFeedback === item.id}
                            style={{ flex: 1, padding: "8px 12px", background: "#22c55e", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, opacity: submittingFeedback === item.id ? 0.5 : 1 }}
                          >
                            ✅ 正しい（維持）
                          </button>
                          <button
                            onClick={() => submitFeedbackAnswer(item.id, 'remove')}
                            disabled={submittingFeedback === item.id}
                            style={{ flex: 1, padding: "8px 12px", background: "#ef4444", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, opacity: submittingFeedback === item.id ? 0.5 : 1 }}
                          >
                            ❌ 間違い（無効化）
                          </button>
                        </div>
                      ) : isContradiction ? (
                        /* 矛盾系質問: ルールプレビュー + 補足コメント + 選択ボタン */
                        (() => {
                          const { newRuleBlock, oldRuleBlock } = parseContradictionContent(item.question);
                          return (
                            <div className="flex flex-col gap-2 mt-2">
                              {/* 新ルール（仮説）プレビュー */}
                              {newRuleBlock && (
                                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                                  <p className="text-[11px] font-bold text-blue-600 mb-1">【新しいルール（仮説）】</p>
                                  <p className="text-xs text-blue-900 whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto">{newRuleBlock}</p>
                                </div>
                              )}
                              {/* 既存ルール（確定済み）プレビュー */}
                              {oldRuleBlock && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                                  <p className="text-[11px] font-bold text-amber-700 mb-1">【既存のルール（確定済み）】</p>
                                  <p className="text-xs text-amber-900 whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto">{oldRuleBlock}</p>
                                </div>
                              )}
                              {/* 選択ボタン */}
                              <button
                                onClick={() => void submitFeedbackAnswer(item.id, 'new', contradictionComments[item.id])}
                                disabled={submittingFeedback === item.id}
                                className="w-full bg-blue-500 text-white rounded-lg py-3 text-sm font-bold disabled:opacity-50 hover:bg-blue-600 transition text-left px-4"
                              >
                                ① 新しいルールが正しい
                              </button>
                              <button
                                onClick={() => void submitFeedbackAnswer(item.id, 'old', contradictionComments[item.id])}
                                disabled={submittingFeedback === item.id}
                                className="w-full bg-gray-500 text-white rounded-lg py-3 text-sm font-bold disabled:opacity-50 hover:bg-gray-600 transition text-left px-4"
                              >
                                ② 既存のルールが正しい
                              </button>
                              {/* 補足コメント入力（任意） */}
                              <textarea
                                value={contradictionComments[item.id] ?? ""}
                                onChange={e => setContradictionComments(prev => ({ ...prev, [item.id]: e.target.value }))}
                                placeholder="補足・使い分け条件など（任意）"
                                className="w-full border border-orange-200 rounded-lg px-3 py-2 text-xs resize-none h-16 focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white text-gray-700"
                              />
                              {submittingFeedback === item.id && (
                                <p className="text-xs text-center text-gray-400 mt-1">送信中...</p>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        /* 通常質問: 自由テキスト入力 */
                        <>
                          {/* テキスト入力 */}
                          <textarea
                            value={feedbackAnswers[item.id] ?? ""}
                            onChange={e => setFeedbackAnswers(prev => ({ ...prev, [item.id]: e.target.value }))}
                            placeholder="ここに回答を入力してください..."
                            className="w-full border border-orange-300 rounded-lg px-3 py-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white"
                          />
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() => submitFeedbackAnswer(item.id)}
                              disabled={!feedbackAnswers[item.id]?.trim() || submittingFeedback === item.id}
                              className="flex-1 bg-orange-500 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 hover:bg-orange-600 transition"
                            >
                              {submittingFeedback === item.id ? "送信中..." : "✅ 回答して適用"}
                            </button>
                            <button
                              onClick={() => setDismissingFeedbackId(dismissingFeedbackId === item.id ? null : item.id)}
                              disabled={submittingFeedback === item.id}
                              className="px-3 py-2 text-gray-400 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition"
                            >
                              スキップ
                            </button>
                          </div>
                        </>
                      )}
                      {/* 矛盾系質問のスキップボタン（通常質問はテキスト入力行内に配置済み） */}
                      {isContradiction && (
                        <div className="flex justify-end mt-1">
                          <button
                            onClick={() => setDismissingFeedbackId(dismissingFeedbackId === item.id ? null : item.id)}
                            disabled={submittingFeedback === item.id}
                            className="px-3 py-1.5 text-gray-400 text-xs border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition"
                          >
                            スキップ
                          </button>
                        </div>
                      )}
                      {dismissingFeedbackId === item.id && (
                        <div className="mt-2 rounded-lg bg-gray-50 p-2">
                          <p className="text-[11px] text-gray-400 mb-1.5">スキップ理由（AIが学習します）</p>
                          <div className="flex flex-wrap gap-1.5">
                            {["既に知ってる", "質問の前提が違う", "今は関係ない", "意味がわからない"].map(r => (
                              <button
                                key={r}
                                onClick={() => dismissFeedback(item.id, r)}
                                className="px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-600 text-[11px] hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition"
                              >
                                {r}
                              </button>
                            ))}
                            <button
                              onClick={() => dismissFeedback(item.id)}
                              className="px-2 py-1 rounded-full bg-white border border-gray-100 text-gray-400 text-[11px] hover:bg-gray-100 transition"
                            >
                              理由なしでスキップ
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (item.status === "answered" || item.status === "applied") ? (
                    <div className={`rounded-lg p-2 mt-1 border ${item.status === "applied" ? "bg-gray-50 border-gray-200" : "bg-green-50 border-green-100"}`}>
                      <p className={`text-xs font-semibold ${item.status === "applied" ? "text-gray-500" : "text-green-700"}`}>
                        ✅ 回答済み{item.status === "applied" ? "（ルール反映済み）" : ""}
                      </p>
                      <p className={`text-xs mt-0.5 ${item.status === "applied" ? "text-gray-500" : "text-green-700"}`}>{item.user_answer}</p>
                      {item.applied_rule && (
                        <p className={`text-xs mt-1 ${item.status === "applied" ? "text-gray-400" : "text-green-600"}`}>→ 適用ルール: {item.applied_rule}</p>
                      )}
                    </div>
                  ) : null}
                  {/* 打ち合わせ機能 */}
                  <div className="mt-3 border-t border-orange-100 pt-3">
                    <button
                      onClick={() => setDiscussingItemId(discussingItemId === item.id ? null : item.id)}
                      className="text-xs text-orange-500 font-bold hover:text-orange-700 flex items-center gap-1"
                    >
                      💬 {discussingItemId === item.id ? "打ち合わせを閉じる" : "AIと打ち合わせする"}
                    </button>
                    {discussingItemId === item.id && (
                      <div className="mt-2 space-y-2">
                        {/* 過去の会話 */}
                        {(discussionMessages[item.id] ?? []).map((msg, idx) => (
                          <div key={idx} className={`rounded-xl px-3 py-2 text-sm ${
                            msg.role === "user"
                              ? "bg-orange-50 text-gray-800 ml-6 text-right"
                              : "bg-gray-50 text-gray-700 mr-6"
                          }`}>
                            <span className="text-[10px] font-bold text-gray-400 block mb-0.5">
                              {msg.role === "user" ? "竹内さん" : "🤖 AI"}
                            </span>
                            <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                          </div>
                        ))}
                        {/* 入力欄 */}
                        <div className="flex gap-2">
                          <textarea
                            value={discussionInput}
                            onChange={e => setDiscussionInput(e.target.value)}
                            placeholder="気軽に返信してください..."
                            rows={2}
                            className="flex-1 rounded-xl border border-orange-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-orange-300"
                            onKeyDown={e => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void sendDiscussionMessage(item);
                              }
                            }}
                          />
                          <button
                            onClick={() => void sendDiscussionMessage(item)}
                            disabled={discussionSending || !discussionInput.trim()}
                            className="px-3 py-2 rounded-xl bg-orange-400 text-white text-sm font-bold hover:bg-orange-500 disabled:opacity-40 transition"
                          >
                            {discussionSending ? "..." : "送信"}
                          </button>
                        </div>
                        <p className="text-[10px] text-gray-400">Enterで送信 / Shift+Enterで改行</p>
                      </div>
                    )}
                  </div>
                </div>
                  );
                };
                const normalItems = feedbackItems.filter(f => f.category !== "adapt_feedback");
                const adaptItems = feedbackItems.filter(f => f.category === "adapt_feedback");
                return (
                  <>
                    {normalItems.map(renderFeedbackItem)}
                    {adaptItems.length > 0 && (
                      <div className="pt-3 border-t border-gray-200">
                        <p className="text-xs font-bold text-gray-500 mb-2">🔁 会話を合わせる（追加分析）</p>
                        <div className="space-y-4">
                          {adaptItems.map(renderFeedbackItem)}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* 🧠ナレッジ承認タブ */}
          {!showAddForm && isCandidateTabActive && candidateSubTab === "knowledge" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {/* 改善6: ヘッダー説明文を日本語のみに改善 */}
              <div className="bg-pink-50 rounded-xl p-3 mb-1 text-sm text-pink-700">
                <p className="font-bold mb-0.5">✅ 承認するとAIに即反映されます</p>
                <p className="text-xs text-pink-500">
                  確認中のナレッジは AIX・LINE返信生成時にまだ使われていません。
                  「承認」を押すと次回から自動でプロンプトに注入されます。
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  表示中: {knowledgeItems.length}件 / 全{knowledgeTotal ?? knowledgeItems.length}件
                </p>
              </div>

              {/* 改善4: カテゴリフィルタ + ソート切り替え */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {(["all", "pattern", "rule", "phrase", "principle"] as const).map(cat => (
                  <button
                    key={cat}
                    onClick={() => setKnowledgeCategoryFilter(cat)}
                    className={`shrink-0 px-3 py-1 rounded-full text-xs font-bold transition ${
                      knowledgeCategoryFilter === cat
                        ? "bg-pink-500 text-white"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {cat === "all" ? "すべて" : cat === "pattern" ? "パターン" : cat === "rule" ? "ルール" : cat === "phrase" ? "フレーズ" : "原則"}
                  </button>
                ))}
                <button
                  onClick={() => setKnowledgeSortBy(s => s === "importance" ? "created_at" : "importance")}
                  className="shrink-0 px-3 py-1 rounded-full text-xs bg-gray-100 text-gray-500 font-bold"
                >
                  {knowledgeSortBy === "importance" ? "重要度順" : "新着順"}
                </button>
              </div>

              {knowledgeLoading && (
                <p className="text-center text-gray-400 py-8">読み込み中...</p>
              )}
              {!knowledgeLoading && knowledgeItems.length === 0 && (
                <div className="text-center text-gray-400 py-12">
                  <p className="text-2xl mb-2">🧠</p>
                  <p className="text-sm font-medium text-gray-500">承認待ちのナレッジはありません</p>
                  <p className="text-sm text-gray-400">（analyze-diffs が毎日自動抽出します）</p>
                </div>
              )}
              {!knowledgeLoading && (() => {
                // 改善4: フィルタ + ソート適用
                const filteredKnowledge = knowledgeItems
                  .filter(item => knowledgeCategoryFilter === "all" || item.category === knowledgeCategoryFilter)
                  .sort((a, b) => knowledgeSortBy === "importance"
                    ? ((b.importance as number) ?? 0) - ((a.importance as number) ?? 0)
                    : new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()
                  );
                return filteredKnowledge.map((item) => {
                  // 改善1: タイトルから内部タグを除去
                  const displayTitle = cleanKnowledgeTitle(item.title);
                  const hasTag = displayTitle !== item.title;
                  // 改善2: フェーズを日本語表示
                  const phaseLabel = item.conversation_state
                    ? (AI_QUESTION_PHASE_LABELS[item.conversation_state] ?? item.conversation_state)
                    : "全フェーズ共通";
                  return (
                    <div key={item.id} className="border border-purple-200 rounded-xl p-3.5 bg-purple-50">
                      {/* ヘッダー: カテゴリ・会話フェーズ（日本語） */}
                      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                          item.conversation_state
                            ? "bg-purple-100 text-purple-700"
                            : "bg-gray-100 text-gray-500"
                        }`}>
                          {phaseLabel}
                        </span>
                        {item.category && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                            {item.category}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-gray-400">
                          重要度 {item.importance ?? "-"}
                        </span>
                      </div>
                      {/* 改善1: タグ除去後タイトル + 元タグを出典として薄く表示 */}
                      <p className="font-bold text-sm text-gray-800 mb-0.5">{displayTitle}</p>
                      {hasTag && (
                        <p className="text-[10px] text-gray-400 mb-1.5">{item.title.match(/^\[.*?\]/)?.[0] ?? ""}</p>
                      )}
                      {/* 改善3: ナレッジの意味セクション */}
                      <div className="mb-2 bg-blue-50 rounded-xl p-3">
                        <p className="text-[11px] font-bold text-blue-500 mb-1">📖 このナレッジの意味</p>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                          {item.content}
                        </p>
                      </div>
                      {/* 改善5: スコア表示を絵文字付きで分かりやすく */}
                      <div className="flex gap-3 text-xs text-gray-400 mt-1 mb-2.5 flex-wrap">
                        <span>✅ 正解 {item.correct_count ?? 0}回</span>
                        <span>❌ 誤り {item.wrong_count ?? 0}回</span>
                        <span>📊 適用 {item.apply_count ?? 0}回</span>
                        {(item.apply_count ?? 0) === 0 && (
                          <span className="text-orange-400 font-bold">⚠️ まだ未使用</span>
                        )}
                      </div>
                      {/* ボタン */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => confirmKnowledge(item.id)}
                          disabled={confirmingKnowledgeId === item.id || rejectingKnowledgeId === item.id || knowledgeFinalizing === item.id}
                          className="flex-1 rounded-lg py-2 text-[12px] font-bold text-white disabled:opacity-50 transition"
                          style={{ background: "linear-gradient(135deg, #7B1FA2, #AB47BC)" }}
                        >
                          {confirmingKnowledgeId === item.id ? "承認中..." : "✅ 承認（confirmed）"}
                        </button>
                        <button
                          onClick={() => setKnowledgeChatOpen(prev => prev === item.id ? null : item.id)}
                          disabled={confirmingKnowledgeId === item.id || rejectingKnowledgeId === item.id || knowledgeFinalizing === item.id}
                          className="px-3 py-2 rounded-lg text-[12px] font-bold text-white bg-blue-600 disabled:opacity-50 transition"
                        >
                          🤝 打ち合わせ
                        </button>
                        <button
                          onClick={() => {
                            if (clarifyingKnowledgeId === item.id) {
                              setClarifyingKnowledgeId(null);
                            } else {
                              setClarifyingKnowledgeId(item.id);
                              setClarifyContent(prev => ({ ...prev, [item.id]: item.content }));
                            }
                          }}
                          disabled={confirmingKnowledgeId === item.id || rejectingKnowledgeId === item.id || knowledgeFinalizing === item.id}
                          className="px-3 py-2 rounded-lg text-[12px] font-bold border disabled:opacity-50 transition"
                          style={clarifyingKnowledgeId === item.id
                            ? { background: "#f97316", color: "white", borderColor: "transparent" }
                            : { background: "#fff7ed", color: "#ea580c", borderColor: "#fed7aa" }}
                        >
                          ✏️ 優先反映
                        </button>
                        <button
                          onClick={() => rejectKnowledge(item.id)}
                          disabled={confirmingKnowledgeId === item.id || rejectingKnowledgeId === item.id || knowledgeFinalizing === item.id}
                          className="px-4 py-2 text-gray-400 text-[12px] border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition"
                        >
                          {rejectingKnowledgeId === item.id ? "..." : "却下"}
                        </button>
                      </div>
                      {/* ✏️ 優先反映インラインエディタ */}
                      {clarifyingKnowledgeId === item.id && (
                        <div className="mt-2.5 rounded-lg border border-orange-200 bg-orange-50 p-2.5">
                          <p className="text-[10px] font-bold text-orange-700 mb-1">✏️ 内容を修正して優先反映（priority=10・全アクションに永続注入）</p>
                          <p className="text-[10px] text-orange-500 mb-1.5">修正内容は HUMAN-{"{id}"} として保存され、LEARN/FEEDBACK より高優先度で注入されます</p>
                          <textarea
                            value={clarifyContent[item.id] ?? item.content}
                            onChange={e => setClarifyContent(prev => ({ ...prev, [item.id]: e.target.value }))}
                            className="w-full border border-orange-300 rounded-lg px-3 py-2 text-[12px] resize-none h-24 focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white"
                          />
                          <div className="flex gap-1.5 mt-1.5">
                            <button
                              onClick={() => submitClarify(item.id, item.content)}
                              disabled={submittingClarify === item.id || !(clarifyContent[item.id] ?? item.content).trim()}
                              className="flex-1 bg-orange-500 text-white rounded-lg py-1.5 text-[12px] font-bold disabled:opacity-50 hover:bg-orange-600 transition"
                            >
                              {submittingClarify === item.id ? "反映中..." : "この内容で優先反映"}
                            </button>
                            <button
                              onClick={() => setClarifyingKnowledgeId(null)}
                              className="px-3 py-1.5 text-gray-400 text-[12px] border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition"
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      )}
                      {/* 🤝 打ち合わせチャット */}
                      {knowledgeChatOpen === item.id && (
                        <div className="mt-2.5 rounded-lg border border-blue-200 bg-white p-2.5">
                          <p className="text-[10px] font-bold text-blue-700 mb-1.5">🤝 打ち合わせ中</p>
                          <div ref={knowledgeChatScrollRef} className="max-h-64 overflow-y-auto bg-gray-50 rounded-lg p-2 flex flex-col gap-1.5">
                            {(knowledgeChatMessages[item.id] || []).length === 0 && (
                              <p className="text-[11px] text-gray-400 text-center py-2">このナレッジについて気になる点を送信してください</p>
                            )}
                            {(knowledgeChatMessages[item.id] || []).map((msg, i) => (
                              msg.role === "user" ? (
                                <div key={i} className="bg-blue-600 text-white rounded-lg px-3 py-2 ml-auto max-w-[80%] text-[12px] whitespace-pre-wrap">
                                  {msg.content}
                                </div>
                              ) : (
                                <div key={i} className="bg-white border border-gray-200 rounded-lg px-3 py-2 max-w-[80%] text-[12px] text-gray-700 whitespace-pre-wrap">
                                  {msg.content}
                                </div>
                              )
                            ))}
                            {knowledgeChatSending === item.id && (
                              <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 max-w-[80%] text-[12px] text-gray-400 flex items-center gap-1.5">
                                <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
                                考え中...
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1.5 mt-2">
                            <input
                              type="text"
                              value={knowledgeChatInput[item.id] || ""}
                              onChange={(e) => setKnowledgeChatInput(prev => ({ ...prev, [item.id]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing && knowledgeChatSending !== item.id && knowledgeFinalizing !== item.id) {
                                  e.preventDefault();
                                  sendKnowledgeChat(item);
                                }
                              }}
                              placeholder="メッセージを入力..."
                              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-[12px] focus:outline-none focus:border-blue-400"
                            />
                            <button
                              onClick={() => sendKnowledgeChat(item)}
                              disabled={knowledgeChatSending === item.id || knowledgeFinalizing === item.id || !(knowledgeChatInput[item.id] || "").trim()}
                              className="px-3 py-2 rounded-lg text-[12px] font-bold text-white bg-blue-600 disabled:opacity-50 transition flex items-center gap-1.5"
                            >
                              {knowledgeChatSending === item.id ? (
                                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                              ) : (
                                "送信"
                              )}
                            </button>
                          </div>
                          <button
                            onClick={() => finalizeKnowledge(item)}
                            disabled={knowledgeFinalizing === item.id || knowledgeChatSending === item.id}
                            className="mt-2 w-full rounded-lg py-2 text-[12px] font-bold text-white disabled:opacity-50 transition"
                            style={{ background: "linear-gradient(135deg, #2E7D32, #66BB6A)" }}
                          >
                            {knowledgeFinalizing === item.id ? "確定中..." : "✅ 確定して ai_prompt_rules に反映"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {/* ⭐ 永久ルール管理タブ */}
          {!showAddForm && isCandidateTabActive && candidateSubTab === "rules" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {/* ヘッダー説明 */}
              <div className="bg-amber-50 rounded-xl p-3 mb-1 text-sm text-amber-800">
                <p className="font-bold mb-0.5">⭐ 永久ルール（卒業メカニズム）</p>
                <p className="text-xs text-amber-600">
                  昇格したルールは <strong>50件上限の対象外</strong> となり、どれほど HUMAN-* が増えても常に最優先で注入されます。
                  重要度が高く確実に守ってほしいルールを昇格してください。
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  永久ルール: {humanRulesList.filter(r => r.is_permanent).length}件 / 通常ルール: {humanRulesList.filter(r => !r.is_permanent).length}件
                </p>
              </div>

              {humanRulesLoading && (
                <p className="text-center text-gray-400 py-8">読み込み中...</p>
              )}
              {!humanRulesLoading && humanRulesList.length === 0 && (
                <div className="text-center text-gray-400 py-12">
                  <p className="text-2xl mb-2">⭐</p>
                  <p className="text-sm font-medium text-gray-500">HUMAN-* ルールがありません</p>
                  <p className="text-sm text-gray-400">（AI質問タブで「最高優先反映」すると追加されます）</p>
                </div>
              )}
              {!humanRulesLoading && humanRulesList.length > 0 && (
                <>
                  {/* 永久ルール一覧 */}
                  {humanRulesList.filter(r => r.is_permanent).length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-bold text-amber-600 flex items-center gap-1">
                        ⭐ 永久ルール（上限なし・常時注入）
                        <span className="font-normal text-amber-400">{humanRulesList.filter(r => r.is_permanent).length}件</span>
                      </p>
                      {humanRulesList.filter(r => r.is_permanent).map(rule => (
                        <div key={rule.id} className="border border-amber-300 rounded-xl p-3 bg-amber-50 flex flex-col gap-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm text-gray-800 flex-1 leading-relaxed">{rule.rule_text}</p>
                            <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-amber-200 text-amber-800 font-bold">⭐ 永久</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-400">{rule.rule_key}</span>
                            <button
                              onClick={() => void togglePermanentRule(rule)}
                              disabled={promotingRuleId === rule.id}
                              className="text-[11px] px-2.5 py-1 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 font-medium transition disabled:opacity-50"
                            >
                              {promotingRuleId === rule.id ? "処理中..." : "⬇ 通常ルールに降格"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 通常ルール一覧（昇格ボタン付き） */}
                  {humanRulesList.filter(r => !r.is_permanent).length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-bold text-gray-500 flex items-center gap-1 mt-2">
                        通常ルール（50件上限あり）
                        <span className="font-normal text-gray-400">{humanRulesList.filter(r => !r.is_permanent).length}件</span>
                      </p>
                      {humanRulesList.filter(r => !r.is_permanent).map(rule => (
                        <div key={rule.id} className="border border-gray-200 rounded-xl p-3 bg-white flex flex-col gap-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm text-gray-700 flex-1 leading-relaxed">{rule.rule_text}</p>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-400">{rule.rule_key}</span>
                            <button
                              onClick={() => void togglePermanentRule(rule)}
                              disabled={promotingRuleId === rule.id}
                              className="text-[11px] px-2.5 py-1 rounded-lg font-medium transition disabled:opacity-50"
                              style={{ background: "linear-gradient(135deg, #D97706, #F59E0B)", color: "white" }}
                            >
                              {promotingRuleId === rule.id ? "処理中..." : "⬆ 永久ルールに昇格"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* テンプレート一覧 */}
          {!showAddForm && !isCandidateTabActive && (
            <div className="p-4">
              {!loading && filtered.length > 0 && (
                <div className="mb-3 flex flex-col gap-2">
                  {isAixCategoryActive && (
                    <div>
                      <input
                        type="text"
                        value={aixKeywordFilter}
                        onChange={(e) => setAixKeywordFilter(e.target.value)}
                        placeholder="どう伝えたいか入力して絞り込む..."
                        className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3] bg-[#f8f9fa]"
                      />
                      {aixKeywordFilter && (
                        <p className="mt-1 pl-1 text-[11px] text-[#888]">{filtered.length}件が一致</p>
                      )}
                    </div>
                  )}
                  {/* AIXカテゴリ：大きな内覧誘導/申込誘導セレクター */}
                  {isAixCategory && (
                    <div className="flex flex-col gap-1">
                      <p className="text-center text-[12px] font-bold text-[#667781]">訴求方法を選択する！！</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setAixPurposeFilter(prev => prev === "内覧" ? null : "内覧")}
                          className={`flex-1 py-3.5 rounded-2xl text-[15px] font-bold transition-all shadow-sm ${
                            aixPurposeFilter === "内覧"
                              ? "bg-[#1565C0] text-white scale-[1.02] shadow-md"
                              : "bg-white text-[#667781] border-2 border-[#d1d7db]"
                          }`}
                        >🏃 内覧に誘う！！</button>
                        <button
                          onClick={() => setAixPurposeFilter(prev => prev === "申込" ? null : "申込")}
                          className={`flex-1 py-3.5 rounded-2xl text-[15px] font-bold transition-all shadow-sm ${
                            aixPurposeFilter === "申込"
                              ? "bg-purple-600 text-white scale-[1.02] shadow-md"
                              : "bg-white text-[#667781] border-2 border-[#d1d7db]"
                          }`}
                        >🚀 申込へ押し込む！！</button>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className={`flex-1 flex items-center gap-1.5 rounded-xl px-3 py-2 ${linkedCustomer ? "bg-emerald-50 border border-emerald-200" : "bg-amber-50 border border-amber-200"}`}>
                      <span className={`text-[11px] ${linkedCustomer ? "text-emerald-700" : "text-amber-700"}`}>
                        {linkedCustomer ? `🔗 ${linkedCustomer.name}さんの希望条件で最適化します` : "👤 お客様を紐付けると駅名・間取りが自動で合わせられます"}
                      </span>
                    </div>
                    <div className="flex rounded-full border border-[#d1d7db] overflow-hidden text-[10px] font-bold shrink-0">
                      <button
                        onClick={() => setNoEmoji(false)}
                        className={`px-2.5 py-1 transition-colors ${!noEmoji ? "bg-[#1565C0] text-white" : "bg-white text-[#888]"}`}
                      >絵文字あり</button>
                      <button
                        onClick={() => setNoEmoji(true)}
                        className={`px-2.5 py-1 transition-colors ${noEmoji ? "bg-[#1565C0] text-white" : "bg-white text-[#888]"}`}
                      >絵文字なし</button>
                    </div>
                  </div>
                  {!isSearching && (category === "申込・審査" || displayFiltered.some(t => /同居人|配偶者/.test(t.text))) && (
                    <div className="flex justify-end">
                      <button
                        onClick={() => setSoloEntry(v => !v)}
                        className={`rounded-full px-3 py-1 text-[10px] font-bold border transition-colors ${soloEntry ? "bg-pink-500 text-white border-transparent shadow-sm" : "bg-white text-[#667781] border-[#d1d7db]"}`}
                      >
                        {soloEntry ? "✓ 1人入居モード" : "👤 1人入居"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* サブカテゴリ件数サマリー（物件確認した/ピックアップした/内覧カテゴリのみ） */}
              {!loading && !isSearching && (isAvailCheckCategory || isPropertySendCategory || isViewingCategory) && displayFiltered.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {isAvailCheckCategory && AVAIL_CHECK_TYPES.map(({ key, color }) => {
                    const count = displayFiltered.filter(t => inferAvailCheckType(t.label) === key).length;
                    if (count === 0) return null;
                    return (
                      <span key={key} className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: color + "20", color }}>
                        {key}({count})
                      </span>
                    );
                  })}
                  {isPropertySendCategory && PROPERTY_SEND_SUB_TYPES.map(({ key, color }) => {
                    const count = displayFiltered.filter(t => getPropertySendSubTag(t.label) === key).length;
                    if (count === 0) return null;
                    return (
                      <span key={key} className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: color + "20", color }}>
                        {key}({count})
                      </span>
                    );
                  })}
                  {isViewingCategory && VIEWING_SUB_TYPES.map(({ key, color }) => {
                    const count = displayFiltered.filter(t => getViewingSubTag(t.label) === key).length;
                    if (count === 0) return null;
                    return (
                      <span key={key} className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: color + "20", color }}>
                        {key}({count})
                      </span>
                    );
                  })}
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-[13px] text-[#aaa]">読み込み中...</div>
              ) : templateLoadError && templates.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <p className="text-sm text-red-500">{templateLoadError}</p>
                  <button
                    onClick={() => { setTemplateLoadError(null); void loadTemplates(); }}
                    className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
                  >
                    再試行
                  </button>
                </div>
              ) : displayFiltered.length === 0 ? (
                <div className="py-8 text-center">
                  <div className="text-[13px] text-[#aaa] mb-3">このカテゴリにテンプレートがありません</div>
                  <button
                    onClick={() => setShowAddForm(true)}
                    className="rounded-full px-4 py-2 text-[12px] font-bold text-white"
                    style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                  >
                    ＋ 追加する
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {recommendLoading && (
                    <div className="py-2 text-center text-[12px] text-[#6b7280]">✨ AIがおすすめを選定中...</div>
                  )}
                  {(() => {
                    // テンプレートカード描画（アコーディオン/フラット両方から呼ぶ。中身は従来のまま）
                    const renderTemplateCard = (tmpl: Template) => {
                    const idx = displayFiltered.indexOf(tmpl);
                    const adapted = adaptedTexts[tmpl.id];
                    const extracted = extractedTexts[tmpl.id];
                    const isOcrTemplate = tmpl.text.includes("[物件名]") && tmpl.text.includes("[住所]");
                    const src = displaySource[tmpl.id];
                    const _rawText = src === "extracted" ? (extracted || tmpl.text)
                      : src === "adapted" ? (adapted || tmpl.text)
                      : (extracted || adapted || tmpl.text);
                    let displayText = applyVacatingDates(_rawText, vacatingDates[tmpl.id] ?? null);
                    if (soloEntry) displayText = applySoloEntry(displayText);
                    if (customerName) displayText = displayText.replace(/アカウント名/g, customerName);
                    // AIおすすめ（post_aix時のみ・上位2件のみ表示）。1位=金「特にオススメ」 2位=緑「オススメ」
                    const aiRecIdx = postAixContext ? aiRecommendations.findIndex((r) => r.id === tmpl.id) : -1;
                    const aiRec = aiRecIdx >= 0 && aiRecIdx < 2 ? aiRecommendations[aiRecIdx] : undefined;
                    const aiRecRank = aiRec ? aiRecIdx + 1 : null; // 1 or 2
                    const isSuggested = !aiRec && !!suggestedCategory && tmpl.category === suggestedCategory;
                    const isHighlighted = !aiRec && !isSuggested && !!highlightKeyword && (tmpl.label.includes(highlightKeyword) || tmpl.text.includes(highlightKeyword));
                    // H4: このシーン（会話ステータス）での送信実績バッジ（AIおすすめバッジと重複時はそちらを優先）
                    const scenePicks = scenePickCount(tmpl);
                    const isVacating = tmpl.label.includes("退去予定") || /[◯○〇]月[◯○〇]/.test(tmpl.text) || /退去予定|退去後|以降ご内覧可能/.test(tmpl.text);
                    // [日程]プレースホルダー付きテンプレはカレンダー連携ピッカーで完結
                    const isScheduled = tmpl.text.includes("[日程]");
                    return (
                      <div
                        key={tmpl.id}
                        ref={(el) => {
                          // 最初の推薦/ハイライトカードにスクロール（1回のみ）。特にオススメ優先
                          if ((aiRecRank === 1 || isSuggested || isHighlighted) && el && !hasScrolled.current) {
                            hasScrolled.current = true;
                            setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }), 150);
                          }
                        }}
                        data-highlighted={isHighlighted ? "true" : undefined}
                        className={`rounded-2xl p-4 ${
                          aiRec && aiRecRank === 1 ? "border-2 border-amber-400 bg-amber-50" :
                          aiRec && aiRecRank === 2 ? "border-2 border-emerald-500 bg-emerald-50" :
                          isSuggested ? "border-2" :
                          isHighlighted ? "border-2 border-orange-400 bg-orange-50" :
                          "border border-[#e9edef] bg-[#f8f9fa]"
                        }`}
                        style={isSuggested && suggestedColor ? {
                          borderColor: suggestedColor,
                          backgroundColor: suggestedColor + "18",  // 約10%透過
                        } : undefined}
                      >
                        {/* タイトル行 */}
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-bold text-[#1565C0] leading-snug line-clamp-2">
                              {isAvailCheckCategory ? stripAvailCheckTag(tmpl.label)
                                : isPropertySendCategory ? stripPropertySendSubTag(tmpl.label)
                                : isViewingCategory ? stripViewingSubTag(tmpl.label)
                                : tmpl.label}
                            </span>
                            {isAvailCheckCategory && (() => {
                              const type = inferAvailCheckType(tmpl.label);
                              const info = AVAIL_CHECK_TYPES.find(t => t.key === type);
                              return info ? (
                                <span className="mt-0.5 block w-fit rounded-full px-2 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: info.color }}>{type}</span>
                              ) : null;
                            })()}
                            {isPropertySendCategory && (() => {
                              const sub = getPropertySendSubTag(tmpl.label);
                              const info = PROPERTY_SEND_SUB_TYPES.find(t => t.key === sub);
                              return info ? (
                                <span className="mt-0.5 block w-fit rounded-full px-2 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: info.color }}>{sub}</span>
                              ) : null;
                            })()}
                            {isViewingCategory && (() => {
                              const sub = getViewingSubTag(tmpl.label);
                              const info = VIEWING_SUB_TYPES.find(t => t.key === sub);
                              return info ? (
                                <span className="mt-0.5 block w-fit rounded-full px-2 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: info.color }}>{sub}</span>
                              ) : null;
                            })()}
                            {isAixCategory && (() => {
                              const tagFromLabel = getAixPurposeTag(stripAvailCheckTag(tmpl.label));
                              const els = detectTemplateElements(tmpl.text);
                              const isNairan = tagFromLabel === "内覧誘導" || els.some(e => e.label === "内覧誘導");
                              const isMoushikomi = tagFromLabel === "申込誘導" || els.some(e => e.label === "申込誘導");
                              if (isNairan) return <span className="mt-0.5 block w-fit rounded-full px-2 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: "#1565C0" }}>内覧誘導</span>;
                              if (isMoushikomi) return <span className="mt-0.5 block w-fit rounded-full px-2 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: "#7B1FA2" }}>申込誘導</span>;
                              return null;
                            })()}
                          </div>
                          {aiRec && aiRecRank === 1 && (
                            <span
                              className="shrink-0 rounded-full bg-amber-400 px-2.5 py-0.5 text-[10px] font-bold text-white shadow-sm"
                              title={aiRec.reason || undefined}
                            >
                              ⭐ 特にオススメ
                            </span>
                          )}
                          {aiRec && aiRecRank === 2 && (
                            <span
                              className="shrink-0 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white"
                              title={aiRec.reason || undefined}
                            >
                              ✓ オススメ
                            </span>
                          )}
                          {isSuggested && suggestedColor && (
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                              style={{ backgroundColor: suggestedColor }}
                            >
                              {suggestedLabel ?? "💡 AIオススメ"}
                            </span>
                          )}
                          {isHighlighted && (
                            <span className="shrink-0 rounded-full bg-orange-400 px-2 py-0.5 text-[10px] font-bold text-white">{highlightLabel ?? "💡 次のアクション"}</span>
                          )}
                          {priorityTemplateIds?.[0] === tmpl.id && !aiRec && (
                            <span className="shrink-0 rounded-full bg-[#7B1FA2] px-2 py-0.5 text-[10px] font-bold text-white">🎯 この流れの定番</span>
                          )}
                          {(priorityTemplateIds ? priorityTemplateIds.indexOf(tmpl.id) : -1) >= 1 && !aiRec && (
                            <span className="shrink-0 rounded-full bg-[#0D9488] px-2 py-0.5 text-[10px] font-bold text-white">📋 次に続けて送ることが多い</span>
                          )}
                          {scenePicks > 0 && !aiRec && (
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                              style={{ backgroundColor: "#0891B2" }}
                              title={`このステータスで${scenePicks}回送信されています`}
                            >
                              📈 この状況でよく使われる
                            </span>
                          )}
                          {isSearching && !isHighlighted && (
                            <span className="shrink-0 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-[10px] font-bold text-[#1565C0]">{tmpl.category}</span>
                          )}
                          {editingId !== tmpl.id && (
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              {tmpl.requires_image && (
                                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-600">📸 画像必要</span>
                              )}
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => handleReorder(displayFiltered, idx, "up")}
                                  disabled={idx === 0}
                                  className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-[#bbb] hover:text-[#1565C0] disabled:opacity-20 transition"
                                  title="上へ"
                                >↑</button>
                                <button
                                  onClick={() => handleReorder(displayFiltered, idx, "down")}
                                  disabled={idx === displayFiltered.length - 1}
                                  className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-[#bbb] hover:text-[#1565C0] disabled:opacity-20 transition"
                                  title="下へ"
                                >↓</button>
                                <div className="w-px h-3 bg-[#e0e0e0] mx-0.5" />
                                <button
                                  onClick={() => setInspectingId(inspectingId === tmpl.id ? null : tmpl.id)}
                                  className={`text-[11px] transition font-medium ${inspectingId === tmpl.id ? "text-[#1565C0]" : "text-[#aaa] hover:text-[#1565C0]"}`}
                                >確認</button>
                                <button
                                  onClick={() => startEdit(tmpl)}
                                  className="text-[11px] text-[#aaa] hover:text-[#1565C0] transition font-medium"
                                >編集</button>
                                <button
                                  onClick={() => setConfirmDeleteId(tmpl.id)}
                                  className="text-[11px] text-[#ccc] hover:text-red-400 transition font-medium"
                                >削除</button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* 退去予定日ピッカー */}
                        {isVacating && editingId !== tmpl.id && (
                          <VacatingDatePicker
                            value={vacatingDates[tmpl.id] ?? null}
                            onChange={(date) => setVacatingDates(prev => ({ ...prev, [tmpl.id]: date }))}
                          />
                        )}

                        {/* [日程]付きテンプレ: カレンダー連携ピッカー */}
                        {isScheduled && editingId !== tmpl.id && onSelect && (
                          <CalendarDatePicker
                            templateText={_rawText}
                            customerName={customerName ?? ""}
                            onInsert={(resolved) => {
                              const secondMsg = tmpl.second_msg_type && tmpl.second_msg_delay
                                ? { type: tmpl.second_msg_type, delay: tmpl.second_msg_delay }
                                : null;
                              onSelect(resolved, [], tmpl.label, tmpl.category, secondMsg, tmpl.id, false, undefined);
                              onClose();
                            }}
                          />
                        )}

                        {/* インライン編集フォーム */}
                        {editingId === tmpl.id ? (
                          <div className="flex flex-col gap-2">
                            {/* カテゴリ変更 */}
                            <div className="flex gap-1.5 flex-wrap">
                              {["全般", "初回応対", "物件探し中", "内覧", "申込・審査", "契約・成約", "その他", ...categories.filter(c => !["全般","初回応対","物件探し中","内覧","申込・審査","契約・成約","その他"].includes(c))].map((c) => (
                                <button
                                  key={c}
                                  onClick={() => setEditCategory(c)}
                                  className="rounded-full px-2.5 py-1 text-[10px] font-bold border transition"
                                  style={editCategory === c ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white", border: "none" } : { backgroundColor: "#f0f2f5", color: "#54656f", borderColor: "#d1d7db" }}
                                >{c}</button>
                              ))}
                            </div>
                            {/* 物件確認した種別タグ選択 */}
                            {editCategory === "物件確認した【AIX】" && (
                              <div>
                                <p className="mb-1 text-[10px] font-bold text-[#54656f]">確認結果の種別</p>
                                <div className="flex gap-1 flex-wrap">
                                  {AVAIL_CHECK_TYPES.map(({ key, color }) => {
                                    const sel = editAvailCheckType === key;
                                    return (
                                      <button
                                        key={key}
                                        type="button"
                                        onClick={() => setEditAvailCheckType(prev => prev === key ? null : key)}
                                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${sel ? "text-white border-transparent" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                        style={sel ? { backgroundColor: color, borderColor: color } : undefined}
                                      >{key}</button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {/* 物件ピックアップした：送り方サブカテゴリ選択 */}
                            {editCategory === "物件ピックアップした【AIX】" && (
                              <div>
                                <p className="mb-1 text-[10px] font-bold text-[#54656f]">送り方サブカテゴリ</p>
                                <div className="flex gap-1 flex-wrap">
                                  {PROPERTY_SEND_SUB_TYPES.map(({ key, color }) => {
                                    const sel = editPropertySendSub === key;
                                    return (
                                      <button
                                        key={key}
                                        type="button"
                                        onClick={() => setEditPropertySendSub(prev => prev === key ? null : key)}
                                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${sel ? "text-white border-transparent" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                        style={sel ? { backgroundColor: color, borderColor: color } : undefined}
                                      >{key}</button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {/* 内覧カテゴリ：内覧種別サブカテゴリ選択 */}
                            {(editCategory === "内覧へ！【AIX】" || editCategory === "内覧【AIX】") && (
                              <div>
                                <p className="mb-1 text-[10px] font-bold text-[#54656f]">内覧種別サブカテゴリ</p>
                                <div className="flex gap-1 flex-wrap">
                                  {VIEWING_SUB_TYPES.map(({ key, color }) => {
                                    const sel = editViewingSub === key;
                                    return (
                                      <button
                                        key={key}
                                        type="button"
                                        onClick={() => setEditViewingSub(prev => prev === key ? null : key)}
                                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${sel ? "text-white border-transparent" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                        style={sel ? { backgroundColor: color, borderColor: color } : undefined}
                                      >{key}</button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {/* AIX用途タグ選択（物件確認した・物件ピックアップした・内覧以外のAIXカテゴリ） */}
                            {editCategory.includes("AIX") && editCategory !== "物件確認した【AIX】" && editCategory !== "物件ピックアップした【AIX】" && editCategory !== "内覧へ！【AIX】" && editCategory !== "内覧【AIX】" && (
                              <div>
                                <p className="mb-1 text-[10px] font-bold text-[#54656f]">用途タグ（内覧誘導 / 申込誘導）</p>
                                <div className="flex gap-1 flex-wrap">
                                  {AIX_PURPOSE_TAGS.map(({ key, color }) => {
                                    const sel = editAixPurposeTag === key;
                                    return (
                                      <button
                                        key={key}
                                        type="button"
                                        onClick={() => setEditAixPurposeTag(prev => prev === key ? null : key)}
                                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${sel ? "text-white border-transparent" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                        style={sel ? { backgroundColor: color, borderColor: color } : undefined}
                                      >{key}</button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            <input
                              className="w-full rounded-xl border border-[#b3d0f7] px-3 py-2 text-[12px] outline-none focus:border-[#2196F3]"
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              placeholder="テンプレート名"
                            />
                            <textarea
                              className="w-full rounded-xl border border-[#b3d0f7] px-3 py-2 text-[12px] outline-none focus:border-[#2196F3] resize-none"
                              rows={5}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              placeholder="本文"
                            />
                            <button
                              onClick={() => setEditRequiresImage(v => !v)}
                              className={`w-full rounded-xl border py-1.5 text-[11px] font-bold transition ${editRequiresImage ? "border-orange-400 bg-orange-50 text-orange-600" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                            >📸 {editRequiresImage ? "画像添付必要（オン）" : "画像添付必要（オフ）"}</button>
                            {/* 2通目設定 */}
                            <div className="rounded-xl border border-[#d1d7db] bg-white p-2.5">
                              <p className="mb-1.5 text-[10px] font-bold text-[#54656f]">📤 2通目設定（自動送信）</p>
                              <div className="flex gap-1 flex-wrap mb-2">
                                <button
                                  type="button"
                                  onClick={() => { setEditSecondMsgType(null); setEditSecondMsgDelay(null); }}
                                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${!editSecondMsgType ? "text-white border-transparent bg-[#90a4ae]" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                >なし</button>
                                {SECOND_MSG_TYPES.map(({ key, color }) => {
                                  const sel = editSecondMsgType === key;
                                  return (
                                    <button
                                      key={key}
                                      type="button"
                                      onClick={() => { setEditSecondMsgType(key); if (!editSecondMsgDelay) setEditSecondMsgDelay(30); }}
                                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${sel ? "text-white border-transparent" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                      style={sel ? { backgroundColor: color, borderColor: color } : undefined}
                                    >{key}</button>
                                  );
                                })}
                              </div>
                              {editSecondMsgType && (
                                <>
                                  <p className="mb-1 text-[10px] text-[#90a4ae]">時間差</p>
                                  <div className="flex gap-1 mb-2">
                                    {SECOND_MSG_DELAYS.map(sec => {
                                      const sel = editSecondMsgDelay === sec;
                                      return (
                                        <button
                                          key={sec}
                                          type="button"
                                          onClick={() => setEditSecondMsgDelay(sec)}
                                          className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border-2 transition ${sel ? "text-white border-transparent" : "bg-white text-[#54656f] border-[#d1d7db]"}`}
                                          style={sel ? { backgroundColor: "#1565C0", borderColor: "#1565C0" } : undefined}
                                        >{sec === 60 ? "1分" : `${sec}秒`}</button>
                                      );
                                    })}
                                  </div>
                                  <p className="text-[10px] text-[#90a4ae] leading-relaxed whitespace-pre-line">
                                    {SECOND_MSG_TYPES.find(t => t.key === editSecondMsgType)?.text ?? ""}
                                  </p>
                                </>
                              )}
                            </div>
                            {/* 構成ブロック編集 */}
                            <div className="rounded-xl border border-[#d1d7db] bg-white p-2">
                              <div className="mb-1.5 flex items-center justify-between">
                                <p className="text-[10px] font-bold text-[#54656f]">📐 構成ブロック（任意）</p>
                                <button
                                  onClick={() => setEditStructure(prev => [...prev, { label: `ブロック${prev.length + 1}`, text: "" }])}
                                  className="rounded-full bg-[#e3f0ff] px-2 py-0.5 text-[10px] font-bold text-[#1565C0]"
                                >＋ 追加</button>
                              </div>
                              {editStructure.length === 0 && (
                                <p className="text-[10px] text-[#aaa] text-center py-1">ブロックなし（例文のみ）</p>
                              )}
                              {editStructure.map((block, bi) => (
                                <div key={bi} className="mb-1.5 flex gap-1 items-start">
                                  <div className="flex flex-col gap-1 flex-1 min-w-0">
                                    <input
                                      value={block.label}
                                      onChange={(e) => setEditStructure(prev => prev.map((b, i) => i === bi ? { ...b, label: e.target.value } : b))}
                                      placeholder="ブロック名（例: ①申込状況の説明）"
                                      className="w-full rounded-lg border border-[#d1d7db] px-2 py-1 text-[10px] outline-none focus:border-[#2196F3] font-bold"
                                    />
                                    <textarea
                                      value={block.text}
                                      onChange={(e) => setEditStructure(prev => prev.map((b, i) => i === bi ? { ...b, text: e.target.value } : b))}
                                      placeholder="例文テキスト"
                                      rows={2}
                                      className="w-full rounded-lg border border-[#d1d7db] px-2 py-1 text-[10px] outline-none focus:border-[#2196F3] resize-none"
                                    />
                                  </div>
                                  <button
                                    onClick={() => setEditStructure(prev => prev.filter((_, i) => i !== bi))}
                                    className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-red-100 text-[10px] text-red-500"
                                  >×</button>
                                </div>
                              ))}
                            </div>
                            <div className="flex gap-2 justify-end mt-1">
                              <button
                                onClick={() => setEditingId(null)}
                                className="rounded-full px-3 py-1.5 text-[11px] font-bold text-[#667781] border border-[#d1d7db]"
                              >キャンセル</button>
                              <button
                                onClick={handleUpdate}
                                disabled={editSaving || !editLabel.trim() || !editText.trim()}
                                className="rounded-full px-4 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                                style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                              >{editSaving ? "保存中..." : "保存"}</button>
                            </div>
                          </div>
                        ) : (
                          <>
                        {/* 削除確認 */}
                        {confirmDeleteId === tmpl.id && (
                          <div className="mb-2 flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
                            <span className="text-[12px] text-red-600 flex-1">削除しますか？</span>
                            <button
                              onClick={() => handleDelete(tmpl.id)}
                              disabled={deletingId === tmpl.id}
                              className="rounded-full px-3 py-1 text-[11px] font-bold text-white bg-red-500 disabled:opacity-50"
                            >
                              {deletingId === tmpl.id ? "..." : "削除"}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-full px-3 py-1 text-[11px] font-bold text-[#667781] border border-[#d1d7db]"
                            >
                              戻る
                            </button>
                          </div>
                        )}

                        {/* AI最適化エラー */}
                        {adaptErrors[tmpl.id] && (
                          <div className="mb-1.5 flex items-center gap-1 rounded-xl bg-red-50 border border-red-200 px-2 py-1">
                            <span className="text-[10px] text-red-600">⚠️ {adaptErrors[tmpl.id]}</span>
                            <button
                              onClick={() => setAdaptErrors((p) => { const n = { ...p }; delete n[tmpl.id]; return n; })}
                              className="ml-auto text-[10px] text-[#aaa] underline"
                            >
                              閉じる
                            </button>
                          </div>
                        )}

                        {/* AI最適化済みバッジ */}
                        {adapted && (
                          <div className="mb-1.5 flex items-center gap-1">
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✨ AIで最適化済み</span>
                            <button
                              onClick={() => { setAdaptedTexts((p) => { const n = { ...p }; delete n[tmpl.id]; return n; }); setDisplaySource((p) => { const n = { ...p }; delete n[tmpl.id]; return n; }); }}
                              className="text-[10px] text-[#aaa] underline"
                            >
                              元に戻す
                            </button>
                          </div>
                        )}

                        {/* 例文 / 構成 トグル（非AIXのみ） */}
                        {tmpl.structure && tmpl.structure.length > 0 && !tmpl.category.includes("AIX") && (() => {
                          const showingSample = structureViewId !== tmpl.id;
                          return (
                            <div className="mb-2 flex gap-1">
                              <button
                                onClick={() => setStructureViewId(null)}
                                className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${showingSample ? "bg-[#1565C0] text-white" : "border border-[#d1d7db] bg-white text-[#54656f]"}`}
                              >例文</button>
                              <button
                                onClick={() => setStructureViewId(tmpl.id)}
                                className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${!showingSample ? "bg-[#7B1FA2] text-white" : "border border-[#d1d7db] bg-white text-[#54656f]"}`}
                              >📐 構成</button>
                            </div>
                          );
                        })()}
                        {/* 構成ビュー or テキスト */}
                        {(() => {
                          const isAix = tmpl.category.includes("AIX");
                          const hasStructure = !!(tmpl.structure && tmpl.structure.length > 0);
                          // AIXは常に見本テキストを表示（構成は訴求ポイントの上で別途表示）
                          const showStructure = hasStructure && !isAix && structureViewId === tmpl.id;
                          if (showStructure) {
                            return (
                              <div className="mb-3 flex flex-col gap-2">
                                {tmpl.structure!.map((block, bi) => (
                                  <div key={bi} className="rounded-xl border border-[#e3eaf2] bg-white p-2.5">
                                    <p className="mb-1 text-[10px] font-bold text-[#7B1FA2]">{block.label}</p>
                                    <p className="whitespace-pre-wrap text-[12px] leading-5 text-[#111b21]">{block.text ? block.text : <span className="text-[#aaa]">（説明未設定）</span>}</p>
                                  </div>
                                ))}
                              </div>
                            );
                          }
                          return <p className="whitespace-pre-wrap text-[13px] leading-5 text-[#111b21] mb-3">{displayText}</p>;
                        })()}

                        {/* 確認パネル */}
                        {inspectingId === tmpl.id && (() => {
                          const elements = detectTemplateElements(tmpl.text);
                          const hasVars = /アカウント名|〇〇|○○/.test(tmpl.text);
                          const hasStation = /徒歩[0-9]|[0-9]分|駅.*徒歩|電車.*本|線.*駅/.test(tmpl.text);
                          const hasPropertyName = /🌟|⭐|【新築|【物件|マンション名|物件名/.test(tmpl.text);
                          return (
                            <div className="mb-3 rounded-xl border border-[#e3eaf2] bg-[#f8fafc] px-3 py-3 flex flex-col gap-3">
                              {/* テンプレートは構成のもの — 説明 */}
                              <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
                                <p className="text-[10px] font-bold text-blue-700 mb-1">📐 これは構成テンプレートです</p>
                                <p className="text-[10px] text-blue-600 leading-relaxed">「AIで最適化」を押すと、お客様の条件・会話履歴をもとに内容が自動で書き換わります。固定の物件名や駅情報はお客様に合わせて変動します。</p>
                              </div>
                              {/* 変動箇所ハイライト */}
                              {(hasVars || hasPropertyName || hasStation) && (
                                <div>
                                  <p className="mb-1.5 text-[10px] font-bold text-[#54656f]">✏️ AIが自動で変える箇所</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {/アカウント名/.test(tmpl.text) && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700">アカウント名 → お客様名</span>}
                                    {/〇〇|○○/.test(tmpl.text) && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-700">〇〇 → 物件・条件情報</span>}
                                    {hasPropertyName && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">物件名 → 今回の物件名</span>}
                                    {hasStation && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">🚃 駅情報 → 希望なければ省略</span>}
                                  </div>
                                </div>
                              )}
                              {/* 駅情報の注意書き */}
                              {hasStation && (
                                <div className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-1.5 flex items-start gap-1.5">
                                  <span className="text-[13px] flex-shrink-0">⚠️</span>
                                  <p className="text-[10px] text-amber-700 leading-relaxed">このテンプレートに駅情報が含まれています。お客様が希望エリア・駅・徒歩分数を指定していない場合、AIは自動でその部分を省略します。</p>
                                </div>
                              )}
                              {/* メッセージ要素 */}
                              {elements.length > 0 && (
                                <div>
                                  <p className="mb-1.5 text-[10px] font-bold text-[#54656f]">📋 このテンプレートの構成要素</p>
                                  <div className="flex flex-col gap-1">
                                    {elements.map((e, i) => (
                                      <div key={i} className={`flex items-center gap-1.5 rounded-lg px-2 py-1 ${e.bg}`}>
                                        <span className="text-[13px]">{e.emoji}</span>
                                        <span className={`text-[11px] font-bold ${e.fg}`}>{e.label}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        </>
                        )}

                        {/* 画像必要テンプレ: 複数画像ピッカー */}
                        {editingId !== tmpl.id && tmpl.requires_image && (
                          <div className="mb-3">
                            {/* サムネイル一覧 */}
                            {(templateImagePreviews[tmpl.id] ?? []).length > 0 && (
                              <div className="mb-2 flex flex-wrap gap-2">
                                {(templateImagePreviews[tmpl.id] ?? []).map((preview, idx) => (
                                  <div key={idx} className="relative w-20 h-20 rounded-xl overflow-hidden border border-sky-200 flex-shrink-0">
                                    <img src={preview} className="w-full h-full object-cover" alt={`画像${idx + 1}`} />
                                    <button
                                      onClick={() => {
                                        setTemplateImages(prev => {
                                          const arr = [...(prev[tmpl.id] ?? [])];
                                          arr.splice(idx, 1);
                                          return { ...prev, [tmpl.id]: arr };
                                        });
                                        setTemplateImagePreviews(prev => {
                                          const arr = [...(prev[tmpl.id] ?? [])];
                                          arr.splice(idx, 1);
                                          return { ...prev, [tmpl.id]: arr };
                                        });
                                      }}
                                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center"
                                    >×</button>
                                  </div>
                                ))}
                                {/* 追加ボタン */}
                                {!isOcrTemplate && (
                                  <button
                                    onClick={() => templateImageInputRefs.current[tmpl.id]?.click()}
                                    className="w-20 h-20 rounded-xl border-2 border-dashed border-sky-300 bg-sky-50 text-sky-500 text-[11px] font-bold flex flex-col items-center justify-center gap-1"
                                  >
                                    <span className="text-lg">📎</span>
                                    <span>追加</span>
                                  </button>
                                )}
                              </div>
                            )}
                            {/* 初回添付ボタン */}
                            {(templateImagePreviews[tmpl.id] ?? []).length === 0 && (
                              <button
                                onClick={() => templateImageInputRefs.current[tmpl.id]?.click()}
                                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-300 py-3 text-[11px] font-bold text-sky-600 bg-sky-50"
                              >📎 {isOcrTemplate ? "物件資料を読み込む（物件名・住所を自動取得）" : "物件資料画像を添付（必須）"}</button>
                            )}
                            {extractErrors[tmpl.id] && (
                              <p className="mt-1 text-[10px] text-red-500">{extractErrors[tmpl.id]}</p>
                            )}
                            {extractingId === tmpl.id && (
                              <div className="mt-1 flex items-center gap-2 text-[11px] text-sky-600 font-bold">
                                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
                                物件名・住所を読み取り中...
                              </div>
                            )}
                            <input
                              type="file" accept="image/*" multiple className="hidden"
                              ref={el => { templateImageInputRefs.current[tmpl.id] = el; }}
                              onChange={async (e) => {
                                const files = Array.from(e.target.files ?? []);
                                if (files.length === 0) return;
                                e.target.value = "";
                                for (const f of files) {
                                  await new Promise<void>((resolve) => {
                                    const reader = new FileReader();
                                    reader.onload = async () => {
                                      const dataUrl = String(reader.result ?? "");
                                      setTemplateImages(prev => ({ ...prev, [tmpl.id]: [...(prev[tmpl.id] ?? []), f] }));
                                      setTemplateImagePreviews(prev => ({ ...prev, [tmpl.id]: [...(prev[tmpl.id] ?? []), dataUrl] }));

                                      if (isOcrTemplate) {
                                        setExtractingId(tmpl.id);
                                        setExtractErrors(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                        try {
                                          const base64 = dataUrl.split(",")[1];
                                          const mime = dataUrl.split(";")[0].split(":")[1] as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
                                          const res = await fetch("/api/extract-meeting-place", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ image_base64: base64, media_type: mime }),
                                          });
                                          const data = await res.json() as { ok: boolean; name?: string; address?: string; error?: string };
                                          if (data.ok && (data.name || data.address)) {
                                            // UX改善⑥: replaceAll で全出現箇所を置換（replace は最初の1箇所のみで後続が残っていた）
                                            const filled = tmpl.text
                                              .replaceAll("[物件名]", data.name || "[物件名]")
                                              .replaceAll("[住所]", data.address || "[住所]");
                                            setExtractedTexts(prev => ({ ...prev, [tmpl.id]: filled }));
                                            setDisplaySource(prev => ({ ...prev, [tmpl.id]: "extracted" }));
                                          } else {
                                            setExtractErrors(prev => ({ ...prev, [tmpl.id]: data.error || "読み取り失敗 — 手動で入力してください" }));
                                          }
                                        } catch {
                                          setExtractErrors(prev => ({ ...prev, [tmpl.id]: "通信エラー — 手動で入力してください" }));
                                        } finally {
                                          setExtractingId(null);
                                        }
                                      }
                                      resolve();
                                    };
                                    reader.readAsDataURL(f);
                                  });
                                }
                              }}
                            />
                          </div>
                        )}

                        {/* AIXカテゴリ: 構成ブロック常時表示（見本の下・訴求ポイントの上） */}
                        {editingId !== tmpl.id && tmpl.category.includes("AIX") && tmpl.structure && tmpl.structure.length > 0 && (
                          <div className="mb-3">
                            <p className="mb-1.5 text-[10px] font-bold text-[#7B1FA2]">構成</p>
                            <div className="rounded-xl border border-[#e3eaf2] bg-white overflow-hidden">
                              {tmpl.structure.map((block, bi) => (
                                <div key={bi} className={`px-3 py-2 ${bi > 0 ? "border-t border-[#f0f2f5]" : ""}`}>
                                  <p className="mb-0.5 text-[10px] font-bold text-[#7B1FA2]">{block.label}</p>
                                  {block.text ? (
                                    <p className="whitespace-pre-wrap text-[11px] leading-4 text-[#54656f]">{block.text}</p>
                                  ) : (
                                    <p className="text-[10px] text-[#aaa]">（説明未設定）</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* AIXカテゴリ: 訴求ポイント選択 */}
                        {editingId !== tmpl.id && tmpl.category.includes("AIX") && (
                          <div className="mb-2">
                            <p className="mb-1.5 text-[11px] font-semibold text-[#8696a0]">訴求ポイント（任意）</p>
                            <div className="flex flex-wrap gap-1.5">
                              {(["家賃", "初期費用", "部屋の条件"] as const).map((pt) => {
                                const selected = (focusPointsMap[tmpl.id] ?? []).includes(pt);
                                return (
                                  <button
                                    key={pt}
                                    type="button"
                                    onClick={() => {
                                      setFocusPointsMap(prev => {
                                        const current = prev[tmpl.id] ?? [];
                                        const next = selected ? current.filter(p => p !== pt) : [...current, pt];
                                        return { ...prev, [tmpl.id]: next };
                                      });
                                    }}
                                    className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                                      selected
                                        ? "border-orange-400 bg-orange-400 text-white"
                                        : "border-[#d1d7db] bg-white text-[#667781]"
                                    }`}
                                  >
                                    {selected ? "✓ " : ""}{pt}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* 2通目設定表示 */}
                        {editingId !== tmpl.id && tmpl.second_msg_type && tmpl.second_msg_delay && (
                          <div className="mb-2 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5">
                            <div className="mb-1 flex items-center gap-1.5">
                              <span className="text-[11px] font-bold text-emerald-700">📤 2通目</span>
                              <span
                                className="rounded-full px-2 py-0.5 text-[9px] font-bold text-white"
                                style={{ backgroundColor: SECOND_MSG_TYPES.find(t => t.key === tmpl.second_msg_type)?.color ?? "#888" }}
                              >{tmpl.second_msg_type}</span>
                              <span className="text-[10px] text-emerald-600 font-bold">
                                {tmpl.second_msg_delay === 60 ? "1分後" : `${tmpl.second_msg_delay}秒後`}に自動送信
                              </span>
                            </div>
                            <p className="text-[11px] text-emerald-700 leading-relaxed whitespace-pre-line">
                              {SECOND_MSG_TYPES.find(t => t.key === tmpl.second_msg_type)?.text ?? ""}
                            </p>
                          </div>
                        )}

                        {/* ボタン行（[日程]テンプレはCalendarDatePickerで完結するため非表示） */}
                        {editingId !== tmpl.id && !isScheduled && <div className="flex items-center gap-2 flex-wrap">
                          {onSelect && (
                            <button
                              onClick={() => {
                                // AIXカテゴリはAIXモーダルを開く（訴求ポイント引き継ぎ）
                                const secondMsg = tmpl.second_msg_type && tmpl.second_msg_delay
                                  ? { type: tmpl.second_msg_type, delay: tmpl.second_msg_delay }
                                  : null;
                                if (tmpl.category.includes("AIX") && onOpenAixWithFocus) {
                                  onOpenAixWithFocus(focusPointsMap[tmpl.id] ?? [], { id: tmpl.id, name: tmpl.label, category: tmpl.category, structure: tmpl.structure ?? undefined, sample: tmpl.text || undefined, secondMsg });
                                  onClose();
                                  return;
                                }
                                if (tmpl.requires_image && (templateImages[tmpl.id] ?? []).length === 0) {
                                  showModalError("📎 物件資料を画像で読み込んでください");
                                  return;
                                }
                                if (isOcrTemplate && extractingId === tmpl.id) return;
                                // OCRテンプレートは画像をLINEに添付しない（物件名・住所抽出のみ）
                                // AIX推薦採否ログ（postAixContext時のみ）
                                if (postAixContext?.conversationId) {
                                  const recMatch = aiRecommendations.find((r) => r.id === tmpl.id);
                                  fetch("/api/learn-action-patterns", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      action: "log",
                                      conversation_status: `post_aix_${postAixContext.actionType}`,
                                      action_type: tmpl.category,
                                      customer_msg_summary: tmpl.label,
                                      source: recMatch ? "recommendation_accepted" : "recommendation_bypassed",
                                      conversation_id: postAixContext.conversationId,
                                    }),
                                  }).catch(() => {});
                                }
                                const wasAdapted = displaySource[tmpl.id] === "adapted";
                                const recIdx = aiRecommendations.findIndex((r) => r.id === tmpl.id);
                                const recommendedRank = recIdx >= 0 && recIdx < 2 ? recIdx + 1 : null;
                                onSelect(displayText, isOcrTemplate ? undefined : (templateImages[tmpl.id] ?? []), tmpl.label, tmpl.category, secondMsg, tmpl.id, wasAdapted, recommendedRank);
                                onClose();
                              }}
                              disabled={isOcrTemplate && extractingId === tmpl.id}
                              className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                              style={{ background: "linear-gradient(135deg, #06c755, #06a043)" }}
                            >
                              {tmpl.category.includes("AIX") ? "AIXで生成" : "そのまま使う"}
                            </button>
                          )}
                          <button
                            onClick={() => handleAdapt(tmpl)}
                            disabled={adaptingId === tmpl.id}
                            className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50 flex items-center gap-1"
                            style={{ background: "linear-gradient(135deg, #f59e0b, #d97706)" }}
                          >
                            {adaptingId === tmpl.id ? (
                              <>
                                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                最適化中...
                              </>
                            ) : (
                              <>
                                ✨ AIで最適化
                                {linkedCustomer && (
                                  <span className="ml-1 rounded-full bg-white/30 px-1.5 py-0.5 text-[9px] font-bold">👤条件あり</span>
                                )}
                              </>
                            )}
                          </button>
                          {adapted && onSelect && (
                            <button
                              onClick={() => {
                                const secondMsg = tmpl.second_msg_type && tmpl.second_msg_delay
                                  ? { type: tmpl.second_msg_type, delay: tmpl.second_msg_delay }
                                  : null;
                                if (tmpl.requires_image && (templateImages[tmpl.id] ?? []).length === 0) {
                                  showModalError("📎 物件資料を画像で読み込んでください");
                                  return;
                                }
                                // AIX推薦採否ログ（postAixContext時のみ）—「そのまま使う」と同一の記録
                                if (postAixContext?.conversationId) {
                                  const recMatch = aiRecommendations.find((r) => r.id === tmpl.id);
                                  fetch("/api/learn-action-patterns", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      action: "log",
                                      conversation_status: `post_aix_${postAixContext.actionType}`,
                                      action_type: tmpl.category,
                                      customer_msg_summary: tmpl.label,
                                      source: recMatch ? "recommendation_accepted" : "recommendation_bypassed",
                                      conversation_id: postAixContext.conversationId,
                                    }),
                                  }).catch(() => {});
                                }
                                // 「最適化版を使う」は必ず adapted テキストを使用（displaySourceがextracted等でもボタンのラベル通りに動く）
                                let adaptedText = applyVacatingDates(adapted, vacatingDates[tmpl.id] ?? null);
                                if (soloEntry) adaptedText = applySoloEntry(adaptedText);
                                if (customerName) adaptedText = adaptedText.replace(/アカウント名/g, customerName);
                                // 定義: AIで最適化して送信したものも「選択」。was_adapted=true と推薦順位を必ず記録する
                                const recIdx = aiRecommendations.findIndex((r) => r.id === tmpl.id);
                                const recommendedRank = recIdx >= 0 && recIdx < 2 ? recIdx + 1 : null;
                                onSelect(adaptedText, isOcrTemplate ? undefined : (templateImages[tmpl.id] ?? []), tmpl.label, tmpl.category, secondMsg, tmpl.id, true, recommendedRank);
                                onClose();
                              }}
                              className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white"
                              style={{ background: "linear-gradient(135deg, #06c755, #06a043)" }}
                            >
                              最適化版を使う
                            </button>
                          )}
                        </div>}
                      </div>
                    );
                    };

                    // 案1: サブカテゴリ別アコーディオン表示（フィルター未選択時のみ）
                    const renderAccordion = (
                      subTypes: ReadonlyArray<{ readonly key: string; readonly color: string }>,
                      getTag: (label: string) => string | null,
                      sectionPrefix: string,
                    ) => {
                      const noTag: Template[] = [];
                      const byTag: Record<string, Template[]> = Object.fromEntries(subTypes.map(s => [s.key, []]));
                      for (const t of displayFiltered) {
                        const tag = getTag(t.label);
                        if (tag && byTag[tag]) byTag[tag].push(t);
                        else noTag.push(t);
                      }
                      return (
                        <>
                          {subTypes.map(({ key, color }) => {
                            const items = byTag[key] ?? [];
                            if (items.length === 0) return null;
                            const sectionKey = `${sectionPrefix}_${key}`;
                            const isCollapsed = !!collapsedSections[sectionKey];
                            return (
                              <div key={key} className="mb-3">
                                {/* セクションヘッダー */}
                                <button
                                  onClick={() => setCollapsedSections(prev => ({ ...prev, [sectionKey]: !prev[sectionKey] }))}
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl mb-2 font-bold text-[12px] text-white transition-all"
                                  style={{ backgroundColor: color }}
                                >
                                  <span>{key} ({items.length})</span>
                                  <span className="text-[14px]">{isCollapsed ? "▶" : "▼"}</span>
                                </button>
                                {/* テンプレートカード（折りたたみ時は非表示） */}
                                {!isCollapsed && (
                                  <div className="flex flex-col gap-3">
                                    {items.map((tmpl) => renderTemplateCard(tmpl))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {/* タグなしのもの */}
                          {noTag.length > 0 && (
                            <div className="flex flex-col gap-3">
                              {noTag.map((tmpl) => renderTemplateCard(tmpl))}
                            </div>
                          )}
                        </>
                      );
                    };

                    if (isPropertySendCategory && propertySendSubFilter === null) {
                      return renderAccordion(PROPERTY_SEND_SUB_TYPES, getPropertySendSubTag, "prop_send");
                    }
                    if (isAvailCheckCategory && availCheckFilter === null) {
                      return renderAccordion(AVAIL_CHECK_TYPES, inferAvailCheckType, "avail_check");
                    }
                    if (isViewingCategory && viewingSubFilter === null) {
                      return renderAccordion(VIEWING_SUB_TYPES, getViewingSubTag, "viewing");
                    }
                    // 従来通りの flat 表示
                    return displayFiltered.map((tmpl) => renderTemplateCard(tmpl));
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
