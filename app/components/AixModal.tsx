"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchCalendarSlots } from "../lib/calendarSlots";
import { detectPlaceholders } from "../lib/validate-reply";

export type AixActionType =
  | "condition_hearing"
  | "property_recommendation"
  | "property_send"
  | "viewing_invite"
  | "application_push"
  | "estimate_sheet"
  | "property_check_result"
  | "meeting_place"
  | "acknowledge_check"
  | "followup_revive";

interface LinkedCustomer {
  id: string;
  name: string;
  conditions: string; // フォーマット済みテキスト
}

interface AixModalProps {
  actionType: AixActionType;
  conversationId: string;
  customerName: string;
  account?: string;
  initialImageFile?: File;
  linkedCustomer?: LinkedCustomer;
  customerConditions?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string; rawCreatedAt?: string }>;
  customerSummary?: string | null;
  lineUserId: string;
  lastScheduledAt?: string;
  lastMessageAt?: string;
  conversationStatus?: string;
  initialFocusPoints?: string[];
  initialTemplateStructure?: Array<{ label: string; text: string }>;
  initialTemplateSample?: string;
  initialSendMode?: "normal" | "new_arrival" | "widen" | "alternative" | null;
  initialViewingReschedule?: boolean;
  initialSendImages?: File[];
  initialViewingSpecificMode?: boolean;
  initialViewingVacancy?: boolean;
  initialIsNewArrival?: boolean;
  initialPickupType?: "新規ピックアップ" | "継続ピックアップ" | "条件広げピックアップ" | "新着1件" | "代替ピックアップ" | null;
  initialEstimateMulti?: boolean;
  initialAppSubMode?: "push" | "confirm" | "format" | "docs_request" | null;
  initialFollowupSubMode?: "apply_supplement" | "search_continue" | null;
  initialInputText?: string;
  initialCheckPattern?: "available" | "vacate_date" | "mgmt_move_in" | "mgmt_initial_cost" | "mgmt_guarantor" | "mgmt_parking" | "mgmt_pet" | "nearby_parking";
  templateId?: string; // テンプレートモーダル経由で開いた場合のtemplate_id（学習ループ紐付け用）
  onClose: () => void;
  onSend: (text: string, imageUrl?: string, isAix?: boolean) => Promise<void>;
  onAfterSend?: (meta?: { suggest2ndHand?: boolean; suggestViewingTemplate?: boolean; suggestViewing?: boolean; scheduled?: boolean; suggestInitialCostTemplate?: boolean; suggestAlternativeSend?: boolean; suggestPropertySend?: boolean; suggestApplicationPush?: boolean; checkPattern?: string; appSubMode?: string; sendMode?: string; wasEdited?: boolean }) => void;
  onDelayedSend?: (seconds: number, sendFn: () => Promise<void>) => void;
  onScheduled?: () => void;
  onVacatingDetected?: (date: string) => void;
  onOpenTemplateFiltered?: (search: string) => void;
}

// 待ち合わせ送信後にカレンダーイベントを作成（fire-and-forget）
function createViewingCalendarEvent(params: {
  meetingDate: string;
  meetingTime: string;
  meetingPropertyName: string;
  meetingPropertyAddress: string;
  customerName: string;
}): void {
  const { meetingDate, meetingTime, meetingPropertyName, meetingPropertyAddress, customerName } = params;
  if (!meetingDate || !meetingTime || !meetingPropertyName) return;

  // 日付パース: "7/2（水）" / "7月2日（水）" → month, day
  const dateMatch = meetingDate.match(/(\d{1,2})[\/月](\d{1,2})/);
  if (!dateMatch) return;
  const month = parseInt(dateMatch[1], 10);
  const day = parseInt(dateMatch[2], 10);
  const now = new Date();
  const candidate = new Date(now.getFullYear(), month - 1, day);
  const year = candidate.getTime() < now.getTime() - 90 * 24 * 3600 * 1000
    ? now.getFullYear() + 1
    : now.getFullYear();

  // 時刻パース: "13:15〜13:45" / "13:15"
  const timeMatch = meetingTime.match(/(\d{1,2}):(\d{2})(?:[〜~-](\d{1,2}):(\d{2}))?/);
  if (!timeMatch) return;
  const startH = parseInt(timeMatch[1], 10);
  const startM = parseInt(timeMatch[2], 10);
  let endH: number, endM: number;
  if (timeMatch[3] && timeMatch[4]) {
    endH = parseInt(timeMatch[3], 10);
    endM = parseInt(timeMatch[4], 10);
  } else {
    const totalMin = startH * 60 + startM + 30;
    endH = Math.floor(totalMin / 60);
    endM = totalMin % 60;
  }

  // JST → UTC（JST = UTC+9）
  const startJST = new Date(year, month - 1, day, startH, startM, 0);
  const endJST   = new Date(year, month - 1, day, endH, endM, 0);
  const toUTC = (d: Date) => new Date(d.getTime() - 9 * 60 * 60 * 1000).toISOString();

  supabase.from("calendar_events").insert({
    title: `${customerName} 内覧 ${meetingPropertyName}`,
    event_type: "viewing",
    customer_name: customerName || null,
    start_at: toUTC(startJST),
    end_at: toUTC(endJST),
    all_day: false,
    notes: meetingPropertyAddress ? `住所: ${meetingPropertyAddress}` : null,
  }).then(
    ({ error }) => { if (error) console.warn("[AixModal] カレンダーイベント作成失敗:", error.message); },
    (e) => { console.warn("[AixModal] カレンダーイベント作成失敗:", e); }
  );
}

// fetchレスポンスのHTTPエラー（4xx/5xx）を例外に変換する共通ヘルパー
// 呼び出し側の catch / .catch でエラー処理する（fire-and-forget系はログのみ、UI系はsetError）
async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as { error?: string }));
    throw new Error((err as { error?: string }).error ?? `HTTPエラー: ${res.status}`);
  }
  return res;
}

function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n /g, "\n")
    .trim();
}

// 会話テキストから複数日を抽出する（「明日」「明後日」両方あれば両方返す）
// 入居・引越・退去文脈の日付は内覧日として抽出しない
function extractMultipleDates(text: string): string[] {
  const today = new Date();
  const results: string[] = [];

  // 「明日」「明後日」は常に内覧文脈 → 最優先で抽出（入居文脈の判定不要）
  if (/明日|あした/.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    results.push(`${d.getMonth() + 1}月${d.getDate()}日`);
  }
  if (/明後日|あさって/.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    results.push(`${d.getMonth() + 1}月${d.getDate()}日`);
  }

  // 「今日」「本日」
  if (results.length === 0 && /今日|本日/.test(text)) {
    results.push(`${today.getMonth() + 1}月${today.getDate()}日`);
  }

  // 「〇月〇日」の直接記載 — 明日・明後日・今日が取れている場合はスキップ
  // 入居・引越・退去を含む文節を丸ごと除去してから日付を抽出（入居希望日の誤抽出防止）
  if (results.length === 0) {
    const withoutMoveInContext = text
      .replace(/[^。\n]*入居[^。\n]*/g, "")
      .replace(/[^。\n]*引越[^。\n]*/g, "")
      .replace(/[^。\n]*退去[^。\n]*/g, "");
    const directMatches = withoutMoveInContext.match(/\d{1,2}月\d{1,2}日/g);
    if (directMatches) {
      for (const d of directMatches) {
        if (!results.includes(d)) results.push(d);
      }
    }
  }

  // 「〇曜日」（今週・来週）
  if (results.length === 0) {
    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    const dayMatches = text.match(/([月火水木金土日])曜/g);
    if (dayMatches) {
      for (const dm of dayMatches) {
        const targetDay = dayNames.indexOf(dm[0]);
        if (targetDay >= 0) {
          const d = new Date(today);
          let diff = targetDay - d.getDay();
          if (diff <= 0) diff += 7;
          d.setDate(d.getDate() + diff);
          const ds = `${d.getMonth() + 1}月${d.getDate()}日`;
          if (!results.includes(ds)) results.push(ds);
        }
      }
    }
  }

  return results;
}

// 抽出した日付リストに一致するカレンダー日のみ true にする配列を返す
function slotsMatchingDates(
  days: Array<{ label: string }>,
  extracted: string[],
): boolean[] {
  return days.map((day) =>
    extracted.some((dateStr) => {
      const mm = dateStr.match(/(\d+)月(\d+)日/);
      if (!mm) return false;
      return day.label.includes(`${parseInt(mm[1])}/${parseInt(mm[2])}`);
    }),
  );
}

const AIX_TEMPLATES: Record<AixActionType, { rules: string[]; template: string }> = {
  condition_hearing: {
    rules: ["挨拶ルールに従い冒頭を自動生成", "①〜⑧の条件フォームを固定テンプレで送信", "一言補足があれば任意入力"],
    template: "[名前]さんお世話になっております！！\nこの度はお問い合わせいただきありがとうございます😊！！\nお部屋探しのお手伝いをさせて頂きます！！\n\n（ご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り\n④ご希望築年数\n⑤ご希望エリア・最寄り駅\n⑥駅からの徒歩分数\n⑦初期費用ご予算\n⑧その他こだわり条件\n\n何卒よろしくお願い致します😌！！",
  },
  property_recommendation: {
    rules: ["物件資料画像をVisionで読み取り", "お客様希望条件と照合", "退去予定あれば自動案内文を追加"],
    template: "🌟【物件名】\n築年数・間取り・面積・駅徒歩\nオススメ①②③④\n初期費用・退去予定（あれば）\n🙇‍♀️[お客様名]さんお気に召されましたらご案内させて頂きます！！",
  },
  property_send: {
    rules: ["物件画像（複数）を添付", "カレンダーから内覧可能日時を自動取得", "退去予定物件は画像から自動読み取り", "内覧誘導 or 申込み誘導モードで切替"],
    template: "○○から[お客様名]さんご希望のご条件に合ったお部屋ピックアップさせて頂きました！！\n[物件情報]\n[カレンダー or 申込み誘導]\n[お客様名]さんお気に召されましたらお部屋ご都合よろしいお日にちにご案内させて頂きます！！",
  },
  property_check_result: {
    rules: ["物件あった → カレンダー自動取得で内覧誘導", "別の部屋（同じ間取り）→ 固定テンプレ厳守", "別の部屋（違う間取り）→ 固定テンプレ厳守", "物件なかった → お詫び＋引き続き探す旨"],
    template: "【同じ間取り】\nお待たせいたしました！！\nお送り頂きました[物件名]◯階部分ですが確認しましたところ募集終了しておりました！！\n別の階数となりますが、同じ間取りで\n[物件名]で現在募集中のお部屋御座いましたので、最大限割引しました御見積書と併せてお送りさせて頂きました！！\nお手隙の際にご査収ください！！\n\n【違う間取り】\nお送り頂きました[物件名]◯階部分ですが確認しましたところ募集終了しておりました！！\n別の階数となりますが\n同じ間取りのお部屋で現在募集中のお部屋が御座いますので、最大限割引しました御見積書と併せてお送りさせて頂きました！！\nお手隙の際にご査収ください！！",
  },
  estimate_sheet: {
    rules: ["見積書画像をVisionでOCR読み取り", "初期費用・割引額・節約額を計算", "固定フォーマットで出力（AI文は不使用）"],
    template: "【物件名 号室】\n初期費用さらに🌟〇〇円割引させて頂き\n初期費用：〇〇円\n[アカウント名]なら一般的な不動産業者より〇〇円節約出来ます！！",
  },
  viewing_invite: {
    rules: ["会話履歴とカレンダーを自動取得", "ワンタップで即生成 → 確認後送信", "カレンダーがあれば内覧可能日時を自動で含める"],
    template: "[お客様名]さんいかがでしょうか！！\nぜひご内覧させていただきたいのですが\n直近ですと\n[日程]\nご都合いかがでしょうか！！",
  },
  application_push: {
    rules: ["申込誘導（シンプル/退去予定/部屋抑えて内覧）or 申込確定を選択", "見積書送信済みか会話から自動検出", "初めての申込のお客様には審査・キャンセル無料の不安解消を1行追加", "ワンタップで即生成 → 確認後送信"],
    template: "[物件名]は[具体的な根拠]でかなりオススメのお部屋となります！！\n[お客様名]さんお気に召されましたらお申込み是非ご検討ください😊！！\n気になる点ございましたらお気軽にお申し付けください！！",
  },
  meeting_place: {
    rules: ["物件資料画像から物件名・住所をAIが自動読み取り", "日程・時間を入力して待ち合わせ文を生成", "時間あり→確定文 / 時間なし→調整文 の2パターン対応"],
    template: "かしこまりました！！\n〇〇日ご案内させて頂きます！！\n\n〇〇日〇〇時に[物件名]\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: [住所]",
  },
  acknowledge_check: {
    rules: ["確認する旨をシンプルに伝える", "補足があれば追加"],
    template: "[名前]確認いたします！！\nお待ちくださいませ！！",
  },
  followup_revive: {
    rules: ["反応が途絶えたお客様への追客メッセージ", "興味を再燃させる一言"],
    template: "[名前]その後いかがでしょうか！！\nお部屋お探しのお手伝いをさせて頂きます！！",
  },
};

const CONFIG: Record<
  AixActionType,
  {
    title: string;
    emoji: string;
    requiresImage: boolean;
    imageLabel: string;
    description: string;
    inputLabel?: string;
    inputPlaceholder?: string;
  }
> = {
  condition_hearing: {
    title: "ヒアリング",
    emoji: "📋",
    requiresImage: false,
    imageLabel: "",
    description: "お客様に希望条件①〜⑧をヒアリングするフォームを送ります。",
    inputLabel: "一言補足（任意）",
    inputPlaceholder: "例：同居人のお部屋探しにあたって...",
  },
  property_recommendation: {
    title: "物件オススメ",
    emoji: "🏠",
    requiresImage: true,
    imageLabel: "物件画像を選択",
    description: "選択した物件画像をもとに、AIが魅力的な紹介文を生成してLINEで送ります。",
    inputLabel: "おすすめポイント（任意）",
    inputPlaceholder: "例：新築、駅徒歩5分、日当たり良好...",
  },
  viewing_invite: {
    title: "内覧へ！",
    emoji: "📅",
    requiresImage: false,
    imageLabel: "",
    description: "内覧の日程調整メッセージをLINEで送ります。",
    inputLabel: "候補日時（任意）",
    inputPlaceholder: "例：3/28（金）14時、3/29（土）午後...",
  },
  application_push: {
    title: "申込へ！",
    emoji: "✏️",
    requiresImage: false,
    imageLabel: "",
    description: "申込を後押しするメッセージをLINEで送ります。",
    inputLabel: "補足情報（任意）",
    inputPlaceholder: "例：審査書類の準備が整っています...",
  },
  estimate_sheet: {
    title: "見積書送る",
    emoji: "",
    requiresImage: true,
    imageLabel: "見積書画像を選択",
    description: "見積書の画像をAIが読み取り、初期費用の内訳をLINEで送ります。",
  },
  property_send: {
    title: "物件ピックアップした",
    emoji: "📤",
    requiresImage: false,
    imageLabel: "",
    description: "ピックアップした物件の画像を送ります。退去予定で案内できないお部屋がある場合はその情報も入力してください。",
    inputLabel: "内覧可能日時（任意）",
    inputPlaceholder: "例：16日16:00〜18:00、17日16:00〜18:00",
  },
  property_check_result: {
    title: "物件確認した",
    emoji: "▶",
    requiresImage: false,
    imageLabel: "物件・部屋の画像を選択（任意）",
    description: "物件確認の結果をお客さんにLINEで報告します。",
  },
  meeting_place: {
    title: "待ち合わせ",
    emoji: "📍",
    requiresImage: false,
    imageLabel: "",
    description: "物件資料画像から物件名・住所を読み取り、日程・時間を指定して待ち合わせメッセージを生成します。",
  },
  acknowledge_check: {
    title: "確認します",
    emoji: "✅",
    requiresImage: false,
    imageLabel: "",
    description: "確認する旨をお客様にLINEで伝えます。",
    inputLabel: "補足情報（任意）",
    inputPlaceholder: "例：少々お時間いただきます",
  },
  followup_revive: {
    title: "追客する",
    emoji: "📣",
    requiresImage: false,
    imageLabel: "",
    description: "反応が途絶えたお客様への追客メッセージをAIが生成します。",
    inputLabel: "追記メモ（任意）",
    inputPlaceholder: "例：先日送った物件について、新着物件あり",
  },
};

const APP_FORMAT_SECTIONS = {
  applicant: `【お申込者様記入欄】
・入居希望日
・氏名、フリガナ
・生年月日
・現住所 〒（住民票記載）
・住居年数
・住居形態
・携帯番号
・メールアドレス
・配偶者
・勤務先名
・勤務先所在地 〒
・勤続年数
・年収
・雇用形態
・勤務先電話番号
・業種
・職種
・保険種類
・駐輪場利用の有無（台数）
・駐車場利用の有無（台数）
・ペット飼育有無`,
  roommate: `【同居人記入欄】
・氏名、フリガナ
・生年月日
・現住所 （住民票記載〒）
・住居年数
・住居形態
・携帯番号
・メールアドレス
・勤務先名
・勤務先所在地
・勤続年数
・年収
・雇用形態
・勤務先電話番号
・保険種類`,
  emergency: `【緊急連絡先欄】
・氏名、フリガナ
・生年月日
・現住所
・住居年数
・携帯番号
・続柄
・勤務先名
・勤務先所在地`,
  guarantor: `【連帯保証人欄】
・氏名、フリガナ
・生年月日
・現住所 〒（住民票記載）
・住居年数
・住居形態
・携帯番号
・続柄
・勤務先名
・勤務先所在地
・勤続年数
・年収
・雇用形態
・勤務先電話番号`,
};

export default function AixModal({
  actionType,
  conversationId,
  customerName,
  account,
  initialImageFile,
  linkedCustomer,
  customerConditions,
  recentMessages,
  customerSummary,
  lineUserId,
  lastScheduledAt,
  lastMessageAt,
  conversationStatus,
  initialFocusPoints,
  initialTemplateStructure,
  initialTemplateSample,
  initialSendMode,
  initialSendImages,
  initialViewingSpecificMode,
  initialViewingVacancy,
  initialViewingReschedule,
  initialIsNewArrival,
  initialPickupType,
  initialEstimateMulti,
  initialAppSubMode,
  initialFollowupSubMode,
  initialInputText,
  initialCheckPattern,
  templateId,
  onClose,
  onSend,
  onAfterSend,
  onDelayedSend,
  onScheduled,
  onVacatingDetected,
  onOpenTemplateFiltered,
}: AixModalProps) {
  const config = CONFIG[actionType];
  // AIX経由の全送信に isAix=true フラグを付与（挨拶判定から除外するため）
  const sendAsAix = (text: string, imageUrl?: string) => onSend(text, imageUrl, true);

  const [showAixScheduleModal, setShowAixScheduleModal] = useState(false);
  const [aixScheduleDateTime, setAixScheduleDateTime] = useState("");
  const [aixScheduleSaving, setAixScheduleSaving] = useState(false);
  const aixLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aixLongPressedRef = useRef(false);
  // NAV-05: 最後に送信成功した画像のindex。送信失敗→「送信する」再押下時に送信済み画像をスキップして重複送信を防ぐ
  const sentImageIndexRef = useRef<number>(-1);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  // 物件オススメ専用: 新着フラグ（ピッカーから新着1件が選ばれた場合は初期ON）
  const [isNewArrival, setIsNewArrival] = useState(initialIsNewArrival ?? false);
  // 物件オススメ専用: お客さんの条件スクショ
  const [conditionImageFile, setConditionImageFile] = useState<File | null>(null);
  const [conditionImagePreview, setConditionImagePreview] = useState<string>("");
  // 物件オススメ専用: 室内イメージURL（任意）
  const [propertyImageUrl, setPropertyImageUrl] = useState("");
  const [inputText, setInputText] = useState(initialInputText ?? "");
  // 物件オススメ専用: 特に強調するポイント（複数選択可）。テンプレートモーダルから引き継ぐ場合は initialFocusPoints で渡す
  const [recommendFocusPoints, setRecommendFocusPoints] = useState<string[]>(initialFocusPoints ?? []);
  const [recSimpleMode, setRecSimpleMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [aiDraft, setAiDraft] = useState<string>("");
  const [aixNotice, setAixNotice] = useState<string>("");
  const [parsedEstimate, setParsedEstimate] = useState<Record<string, string> | null>(null);
  // ① LL-07: 見積書カバーレター（AI生成・送信+学習ループ対象）
  const [estimateCoverLetter, setEstimateCoverLetter] = useState<string>("");
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [previewBackup, setPreviewBackup] = useState<string>("");
  const [useEmoji, setUseEmoji] = useState(true);
  const [showTemplateInfo, setShowTemplateInfo] = useState(false);
  const [topPhrases, setTopPhrases] = useState<{ phrase: string; usage_count: number }[]>([]);
  const [floorPlanTouched, setFloorPlanTouched] = useState(false);
  // 物件確認した専用（vacate_date / mgmt_move_in / mgmt_initial_cost は「管理会社に確認した」ピッカー経由の専用パターン）
  const [checkPattern, setCheckPattern] = useState<"available" | "alternative" | "unavailable" | "exclusive" | "move_in_date" | "interior_photo" | "vacate_date" | "mgmt_move_in" | "mgmt_initial_cost" | "mgmt_guarantor" | "mgmt_parking" | "mgmt_pet" | "nearby_parking" | null>(initialCheckPattern ?? null);
  // 管理会社確認パターンかどうか（テキスト入力のみで生成できる簡易フロー）
  const isMgmtCheck = checkPattern === "vacate_date" || checkPattern === "mgmt_move_in" || checkPattern === "mgmt_initial_cost" || checkPattern === "mgmt_guarantor" || checkPattern === "mgmt_parking" || checkPattern === "mgmt_pet" || checkPattern === "nearby_parking";
  // 初期費用確認: サブパターン選択
  const [mgmtCostType, setMgmtCostType] = useState<"estimate" | "negotiation" | null>(null);
  // 駐車場確認専用: 有無・料金・空き状況
  const [mgmtParkingAvailability, setMgmtParkingAvailability] = useState<"あり" | "なし" | null>(null);
  const [mgmtParkingFee, setMgmtParkingFee] = useState<string>("");
  const [mgmtParkingVacancy, setMgmtParkingVacancy] = useState<"空きあり" | "空きなし" | "要確認" | null>(null);
  // 近隣月極駐車場確認専用: 駐車場名・距離・月額料金・空き状況
  const [nearbyParkingName, setNearbyParkingName] = useState<string>("");
  const [nearbyParkingDistance, setNearbyParkingDistance] = useState<string>("");
  const [nearbyParkingFee, setNearbyParkingFee] = useState<string>("");
  const [nearbyParkingVacancy, setNearbyParkingVacancy] = useState<"空きあり" | "空きなし" | "要確認" | null>(null);
  // ペット飼育確認専用: 可否・条件
  const [mgmtPetPolicy, setMgmtPetPolicy] = useState<"可" | "不可" | "相談可" | null>(null);
  const [mgmtPetCondition, setMgmtPetCondition] = useState<string>("");
  // 保証会社確認専用: 誘導方向
  const [mgmtGuarantorPushType, setMgmtGuarantorPushType] = useState<"apply" | "viewing" | null>(null);
  // 保証会社確認専用: テキスト入力 + タイプ + OCRローディング
  const [mgmtGuarantorPropertyName, setMgmtGuarantorPropertyName] = useState<string>("");
  const [mgmtGuarantorCompanyName, setMgmtGuarantorCompanyName] = useState<string>("");
  const [mgmtGuarantorType, setMgmtGuarantorType] = useState<"独立系" | "LICC系" | "信販系" | "不明" | "">("");
  const [mgmtDocOcrLoading, setMgmtDocOcrLoading] = useState(false);
  // 保証会社確認専用: 画像先送り用URL（generate()後にセット）
  const [previewDocImageUrl, setPreviewDocImageUrl] = useState<string>("");
  // 管理会社確認 全パターン共通: 物件資料添付
  const [mgmtDocImage, setMgmtDocImage] = useState<File | null>(null);
  const [mgmtDocPreview, setMgmtDocPreview] = useState<string>("");
  // 室内写真確認した専用
  const [interiorPhotoUrl, setInteriorPhotoUrl] = useState<string>("");
  const [interiorPhotoFile, setInteriorPhotoFile] = useState<File | null>(null);
  const [interiorPhotoPreview, setInteriorPhotoPreview] = useState<string>("");
  const [interiorPropertyName, setInteriorPropertyName] = useState<string>("");
  // 入居日確認専用: 物件資料画像
  const [moveInImageFile, setMoveInImageFile] = useState<File | null>(null);
  const [moveInImagePreview, setMoveInImagePreview] = useState<string>("");
  // 物件あった専用: 申込状況
  const [checkAvailableApp, setCheckAvailableApp] = useState<"yes" | "no" | null>(null);
  // 物件あった専用: 内覧誘導モード（折りたたみ）
  const [showCheckCalendar, setShowCheckCalendar] = useState(false);
  // 物件確認した「別の部屋」専用
  const [checkEndedFloor, setCheckEndedFloor] = useState<number | null>(null);
  const [checkEndedUnit, setCheckEndedUnit] = useState<string>("");
  const [checkFloorPlan, setCheckFloorPlan] = useState<"same" | "different" | null>(null);
  // 専任物件だった専用: スクショOCR + 物件名・号室
  const [exclusiveImageFile, setExclusiveImageFile] = useState<File | null>(null);
  const [exclusivePropName, setExclusivePropName] = useState("");
  const [exclusiveRoomNo, setExclusiveRoomNo] = useState("");
  const [exclusiveOcrLoading, setExclusiveOcrLoading] = useState(false);
  // 物件確認した専用: 複数画像
  const [checkImageFiles, setCheckImageFiles] = useState<File[]>([]);
  const [checkImagePreviews, setCheckImagePreviews] = useState<string[]>([]);
  // 物件確認した「別の部屋」専用: 見積書画像
  const [checkEstimateFile, setCheckEstimateFile] = useState<File | null>(null);
  const [checkEstimatePreview, setCheckEstimatePreview] = useState<string>("");
  // 複数物件対応: 件数 + per-property 画像・見積書・物件名・退去予定日
  const [checkPropertyCount, setCheckPropertyCount] = useState<1|2|3>(1);
  const [checkPropImages, setCheckPropImages] = useState<File[][]>([[], [], []]);
  const [checkPropImagePreviews, setCheckPropImagePreviews] = useState<string[][]>([[], [], []]);
  const [checkPropEstimates, setCheckPropEstimates] = useState<(File|null)[]>([null, null, null]);
  const [checkPropEstimatePreviews, setCheckPropEstimatePreviews] = useState<string[]>(["", "", ""]);
  const [checkPropNames, setCheckPropNames] = useState<string[]>(["", "", ""]);
  const [checkPropVacancyDates, setCheckPropVacancyDates] = useState<string[]>(["", "", ""]);
  const [checkAllAvailable, setCheckAllAvailable] = useState(false);
  const [checkPropStatuses, setCheckPropStatuses] = useState<string[]>(["available", "available", "available"]);
  const [checkRecommendProp, setCheckRecommendProp] = useState<number | null>(null);
  const [checkIncludeEstimateText, setCheckIncludeEstimateText] = useState(false);
  const [checkApplicationInvite, setCheckApplicationInvite] = useState(false);
  const [estimateTextReady, setEstimateTextReady] = useState("");
  const [sendCountdown, setSendCountdown] = useState(0);
  // 物件確認した「空室あり」専用カレンダー
  const [checkCalendarInfo, setCheckCalendarInfo] = useState<string>("");
  const [checkCalendarDays, setCheckCalendarDays] = useState<Array<{
    label: string; slots: string[]; fullyBooked: boolean; noEvents: boolean;
  }>>([]);
  const [checkCalendarLoading, setCheckCalendarLoading] = useState(false);
  // 物件ピックアップした専用: 複数画像 + 退去予定メモ + カレンダー自動取得
  const [sendImageFiles, setSendImageFiles] = useState<File[]>(initialSendImages ?? []);
  const [sendImagePreviews, setSendImagePreviews] = useState<string[]>([]);
  const [vacatingNote, setVacatingNote] = useState("");
  const [sendKeyword, setSendKeyword] = useState("");
  const [sendExpandedConds, setSendExpandedConds] = useState<Set<string>>(new Set());
  const [showExpandedCond, setShowExpandedCond] = useState(false);
  // analyzeLoading は退去自動検出削除に伴い未使用（将来拡張用に残す）
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  void analyzeLoading; void setAnalyzeLoading;
  // 退去確認ボタン専用: 構造化された退去予定物件リスト
  const [vacatingProperties, setVacatingProperties] = useState<Array<{name: string; moveOut: string; editingDate: boolean}>>([]);
  const [vacatingCheckLoading, setVacatingCheckLoading] = useState(false);
  const [vacatingCheckProgress, setVacatingCheckProgress] = useState("");
  const [calendarInfo, setCalendarInfo] = useState<string>("");
  const [calendarDays, setCalendarDays] = useState<Array<{
    label: string; slots: string[]; fullyBooked: boolean; noEvents: boolean;
  }>>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  // 物件ピックアップ専用: 新規物件 / 新着物件 / 条件を広げた モード
  const [sendMode, setSendMode] = useState<"normal" | "new_arrival" | "widen" | "alternative" | null>(initialSendMode ?? null);
  // 各AIXピッカー コンポーネント別生成結果（差分学習ループ用・全アクション共通）
  const [aiActionComponents, setAiActionComponents] = useState<Record<string, string> | null>(null);
  const [newArrivalApply, setNewArrivalApply] = useState(false);
  const [editableCalendarSlots, setEditableCalendarSlots] = useState<string[]>([]);
  const [includeCalendar, setIncludeCalendar] = useState(true);
  // 内覧へ！専用: カレンダースロット選択
  const [viewingCalendarDays, setViewingCalendarDays] = useState<Array<{label: string; slots: string[]; fullyBooked: boolean; noEvents: boolean}>>([]);
  const [viewingCalendarLoading, setViewingCalendarLoading] = useState(false);
  const [viewingSlotEnabled, setViewingSlotEnabled] = useState<boolean[]>([]);
  const [viewingSlotStarts, setViewingSlotStarts] = useState<string[]>([]);
  const [viewingSlotEnds, setViewingSlotEnds] = useState<string[]>([]);
  const [viewingSlotOverride, setViewingSlotOverride] = useState<boolean[]>([]); // 案内不可日を手動で追加
  // 申込へ！専用: 物件名 + 空室状況 + 退去予定日
  const [appPropertyName, setAppPropertyName] = useState("");
  // 申込パターンはデフォルトで「シンプル申込」を選択済みにする（最頻パターン・生成までのタップ数を減らす）
  const [appPushType, setAppPushType] = useState<"simple" | "scheduled" | "hold_view" | null>("simple");
  const [appAppealPoints, setAppAppealPoints] = useState<string[]>([]);
  const [appMoveOutDate, setAppMoveOutDate] = useState("");
  const [appSubMode, setAppSubMode] = useState<"push" | "confirm" | "format" | "docs_request" | null>(initialAppSubMode ?? null);
  const [appFormatLivingType, setAppFormatLivingType] = useState<"single" | "shared" | null>(null);
  const [appFormatGuarantorType, setAppFormatGuarantorType] = useState<"emergency" | "guarantor" | null>(null);
  const [appConfirmImagePreview, setAppConfirmImagePreview] = useState("");
  const [appConfirmExtractLoading, setAppConfirmExtractLoading] = useState(false);
  // 物件オススメ専用: analyze-propertyで自動抽出した退去予定日
  const [propMoveOutDate, setPropMoveOutDate] = useState("");

  // 待ち合わせ専用
  const [meetingPropertyFile, setMeetingPropertyFile] = useState<File | null>(null);
  const [meetingPropertyPreview, setMeetingPropertyPreview] = useState<string>("");
  const [meetingPropertyName, setMeetingPropertyName] = useState<string>("");
  const [meetingPropertyAddress, setMeetingPropertyAddress] = useState<string>("");
  const [meetingDate, setMeetingDate] = useState<string>("");
  const [meetingTime, setMeetingTime] = useState<string>("");
  const [meetingOcrLoading, setMeetingOcrLoading] = useState(false);

  // 内覧へ！退去予定物件専用
  const [viewingIsVacancy, setViewingIsVacancy] = useState(!!initialViewingVacancy);
  const [viewingVacancyName, setViewingVacancyName] = useState("");
  const [viewingVacancyMoveOut, setViewingVacancyMoveOut] = useState("");
  const [viewingVacancyFile, setViewingVacancyFile] = useState<File | null>(null);
  const [viewingVacancyPreview, setViewingVacancyPreview] = useState("");
  const [viewingVacancyOcrLoading, setViewingVacancyOcrLoading] = useState(false);

  // 内覧へ！内覧日指定あり専用
  const [viewingSpecificMode, setViewingSpecificMode] = useState(!!initialViewingSpecificMode);
  // 内覧へ！日程変更モード専用
  const [viewingRescheduleMode, setViewingRescheduleMode] = useState(!!initialViewingReschedule);
  const [viewingSpecificDate, setViewingSpecificDate] = useState("");
  // 追客サブモード
  const [followupSubMode] = useState<"apply_supplement" | "search_continue" | null>(initialFollowupSubMode ?? null);
  const [followupPropertyName, setFollowupPropertyName] = useState("");
  const [extraInput, setExtraInput] = useState("");
  const [viewingSpecificStart, setViewingSpecificStart] = useState("");
  const [viewingSpecificEnd, setViewingSpecificEnd] = useState("");

  // 物件オススメ専用: 見積書（任意）
  const [recommendEstimateFile, setRecommendEstimateFile] = useState<File | null>(null);
  const [recommendEstimatePreview, setRecommendEstimatePreview] = useState<string>("");
  // 見積書送る専用: 物件資料（任意）
  const [estimatePropertyFile, setEstimatePropertyFile] = useState<File | null>(null);
  const [estimatePropertyPreview, setEstimatePropertyPreview] = useState<string>("");
  // 見積書送る複数件モード
  const [estimateMultiMode] = useState(initialEstimateMulti ?? false);
  const [estimateMultiFiles, setEstimateMultiFiles] = useState<File[]>([]);
  const [estimateMultiPreviews, setEstimateMultiPreviews] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const conditionFileInputRef = useRef<HTMLInputElement | null>(null);
  const checkFileInputRef = useRef<HTMLInputElement | null>(null);
  const checkEstimateInputRef = useRef<HTMLInputElement | null>(null);
  // 複数物件対応: 物件①②③の画像・見積書 refs
  const checkProp1FileRef = useRef<HTMLInputElement | null>(null);
  const checkProp2FileRef = useRef<HTMLInputElement | null>(null);
  const checkProp3FileRef = useRef<HTMLInputElement | null>(null);
  const checkProp1EstRef = useRef<HTMLInputElement | null>(null);
  const checkProp2EstRef = useRef<HTMLInputElement | null>(null);
  const checkProp3EstRef = useRef<HTMLInputElement | null>(null);
  const sendFileInputRef = useRef<HTMLInputElement | null>(null);
  const moveInImageInputRef = useRef<HTMLInputElement | null>(null);
  const recommendEstimateInputRef = useRef<HTMLInputElement | null>(null);
  const estimatePropertyInputRef = useRef<HTMLInputElement | null>(null);
  const estimateMulti1Ref = useRef<HTMLInputElement | null>(null);
  const estimateMulti2Ref = useRef<HTMLInputElement | null>(null);
  const estimateMulti3Ref = useRef<HTMLInputElement | null>(null);
  const estimateMultiRefs = [estimateMulti1Ref, estimateMulti2Ref, estimateMulti3Ref];
  const meetingPropertyInputRef = useRef<HTMLInputElement | null>(null);
  const viewingVacancyInputRef = useRef<HTMLInputElement | null>(null);
  const confirmImageInputRef = useRef<HTMLInputElement | null>(null);
  const mgmtDocInputRef = useRef<HTMLInputElement | null>(null);

  // 会話が変わったらシンプルモードをリセット
  useEffect(() => {
    setRecSimpleMode(false);
    setPreview("");
    setAixNotice("");
  }, [conversationId]);
  // initialAppSubMode（picker/バナー経由の指定）をマウント時に潰さないよう、初期値を尊重してリセット
  useEffect(() => { setAppSubMode(initialAppSubMode ?? null); setPreview(""); }, [actionType, initialAppSubMode]);
  useEffect(() => { setAiActionComponents(null); }, [actionType, conversationId]);
  // actionType 変更時に保証会社確認用ステートをリセット
  useEffect(() => {
    setMgmtDocImage(null);
    setMgmtDocPreview("");
    setMgmtGuarantorPushType(null);
    setMgmtGuarantorPropertyName("");
    setMgmtGuarantorCompanyName("");
    setMgmtGuarantorType("");
    setMgmtDocOcrLoading(false);
    setPreviewDocImageUrl("");
    setMgmtParkingAvailability(null);
    setMgmtParkingFee("");
    setMgmtParkingVacancy(null);
    setMgmtPetPolicy(null);
    setMgmtPetCondition("");
  }, [actionType, conversationId]);

  useEffect(() => {
    if (initialImageFile) {
      if (actionType === "meeting_place") {
        setMeetingPropertyFile(initialImageFile);
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = String(reader.result ?? "");
          setMeetingPropertyPreview(dataUrl);
          setMeetingOcrLoading(true);
          try {
            const base64 = dataUrl.split(",")[1];
            const mime = (dataUrl.split(";")[0].split(":")[1] || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
            const res = await fetch("/api/extract-meeting-place", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image_base64: base64, media_type: mime }),
            });
            await ensureOk(res);
            const data = await res.json() as { ok: boolean; name?: string; address?: string };
            if (data.ok) {
              if (data.name) setMeetingPropertyName(data.name);
              if (data.address) setMeetingPropertyAddress(data.address);
            }
          } catch (e) { console.error("[AixModal] 待ち合わせOCR失敗:", e); } finally { setMeetingOcrLoading(false); }
        };
        reader.readAsDataURL(initialImageFile);
      } else {
        setImageFile(initialImageFile);
        const reader = new FileReader();
        reader.onload = () => setImagePreview(String(reader.result ?? ""));
        reader.readAsDataURL(initialImageFile);
      }
    }
  }, [initialImageFile, actionType]);

  useEffect(() => {
    if (!initialSendImages || initialSendImages.length === 0) return;
    const readPromises = initialSendImages.map(file => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    }));
    Promise.all(readPromises).then(urls => setSendImagePreviews(urls));
  }, []);

  // 申込確定モードでpicker経由で開いた場合: mount時に物件名自動検出（テキスト生成はAIに任せる）
  useEffect(() => {
    if (initialAppSubMode !== "confirm") return;
    const staffMsgs = (recentMessages || []).filter(m => m.sender === "staff").reverse();
    let detected = "";
    for (const msg of staffMsgs) {
      const m = msg.text.match(/^【(.+?)】/);
      if (m) { detected = m[1].trim(); break; }
    }
    if (detected) setAppPropertyName(detected);
  }, []);

  // 物件確認した「空室あり」: 直近3日のカレンダーを取得して内覧日程をアナウンス
  useEffect(() => {
    if (actionType !== "property_check_result" || checkPattern !== "available") {
      setCheckCalendarInfo("");
      setCheckCalendarDays([]);
      return;
    }
    setCheckCalendarLoading(true);
    (async () => {
      try {
        const { days, infoString } = await fetchCalendarSlots();
        setCheckCalendarInfo(infoString);
        setCheckCalendarDays(days);
      } catch {
        setCheckCalendarInfo("");
        setCheckCalendarDays([]);
      } finally {
        setCheckCalendarLoading(false);
      }
    })();
  }, [actionType, checkPattern]);

  // 物件ピックアップした: 直近3日のカレンダー（calendar_events + daily_tasks）を取得して空き枠を計算
  useEffect(() => {
    if (actionType !== "property_send") return;
    setCalendarLoading(true);
    (async () => {
      try {
        const { days, infoString } = await fetchCalendarSlots();
        setCalendarInfo(infoString);
        setCalendarDays(days);
        setEditableCalendarSlots(days.map(d => d.fullyBooked ? "" : (d.slots[0] || "")));
      } catch {
        setCalendarInfo("");
        setCalendarDays([]);
        setEditableCalendarSlots([]);
      } finally {
        setCalendarLoading(false);
      }
    })();
  }, [actionType]);

  // 申込へ！: 直近3日のカレンダー取得（hold_view 内覧案内に使用）
  useEffect(() => {
    if (actionType !== "application_push") return;
    setCalendarLoading(true);
    (async () => {
      try {
        const { days, infoString } = await fetchCalendarSlots();
        setCalendarInfo(infoString);
        setCalendarDays(days);
      } catch {
        setCalendarInfo("");
        setCalendarDays([]);
      } finally {
        setCalendarLoading(false);
      }
    })();
  }, [actionType]);

  // 内覧へ！: カレンダー取得 + お客様指定日の自動検出
  useEffect(() => {
    if (actionType !== "viewing_invite") return;
    setViewingCalendarLoading(true);
    (async () => {
      try {
        const { days } = await fetchCalendarSlots();
        setViewingCalendarDays(days);
        // "11:00〜14:00" → start: "11:00", end: "14:00"
        const parseTime = (slot: string) => {
          const m = slot.match(/(\d{1,2}:\d{2})[〜~\-](\d{1,2}:\d{2})/);
          return m ? { start: m[1].padStart(5, "0"), end: m[2].padStart(5, "0") } : { start: "10:00", end: "18:00" };
        };
        setViewingSlotStarts(days.map(d => parseTime(d.slots[0] || "").start));
        setViewingSlotEnds(days.map(d => parseTime(d.slots[0] || "").end));
        setViewingSlotOverride(days.map(() => false));

        // ★ お客様が内覧日を指定していたら自動でトグルON + 日時プリセット（複数日対応）
        const allCustomerText = (recentMessages || [])
          .filter(m => m.sender === "customer" && m.text)
          .map(m => m.text)
          .join(" ");
        const extracted = extractMultipleDates(allCustomerText);

        if (extracted.length > 0) {
          // 内覧日指定あり: 抽出した日付に一致するカレンダー日のみチェック（本日は指定がなければチェックしない）
          setViewingSpecificMode(true);
          setViewingSpecificDate(extracted.join("・"));
          setViewingSlotEnabled(slotsMatchingDates(days, extracted));
          // 最初の有効スロットの時間をプリセット
          const firstAvail = days.find(d => !d.fullyBooked);
          if (firstAvail) {
            const t = parseTime(firstAvail.slots[0] || "");
            setViewingSpecificStart(t.start);
            setViewingSpecificEnd(t.end);
          }
        } else if (viewingSpecificMode) {
          // 内覧日指定ありモードで日付を抽出できない → 本日(index 0)はチェックしない
          setViewingSlotEnabled(days.map((d, i) => i > 0 && !d.fullyBooked));
        } else {
          // 通常モード: 空きのある日を全てチェック
          setViewingSlotEnabled(days.map(d => !d.fullyBooked));
        }
      } catch {
        setViewingCalendarDays([]);
        setViewingSlotEnabled([]);
        setViewingSlotStarts([]);
        setViewingSlotEnds([]);
        setViewingSlotOverride([]);
      } finally {
        setViewingCalendarLoading(false);
      }
    })();
  }, [actionType]);

  // 内覧日指定あり: ONになったら会話からお客様指定日を自動抽出（複数日対応）
  useEffect(() => {
    if (!viewingSpecificMode || !recentMessages) return;
    if (viewingSpecificDate) return; // 既に入力済みならスキップ
    // お客様メッセージ全体から複数日を抽出（「明日・明後日」等を両方拾う）
    const allCustomerText = [...recentMessages]
      .filter(m => m.sender === "customer" && m.text)
      .map(m => m.text)
      .join(" ");
    const extracted = extractMultipleDates(allCustomerText);
    if (extracted.length > 0) {
      setViewingSpecificDate(extracted.join("・"));
      // 抽出した日付に一致するカレンダー日のみチェック（本日は指定がなければチェックしない）
      if (viewingCalendarDays.length > 0) {
        setViewingSlotEnabled(slotsMatchingDates(viewingCalendarDays, extracted));
      }
    }
    // カレンダーから時間をプリセット（最初の有効スロット）
    const firstSlot = viewingCalendarDays.find((d, i) => d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i]);
    if (firstSlot) {
      const firstIdx = viewingCalendarDays.indexOf(firstSlot);
      if (firstIdx >= 0) {
        if (!viewingSpecificStart) setViewingSpecificStart(viewingSlotStarts[firstIdx] || "");
        if (!viewingSpecificEnd)   setViewingSpecificEnd(viewingSlotEnds[firstIdx] || "");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingSpecificMode]);

  // 待ち合わせ: 会話から日程・時間をAIで抽出してプリセット
  useEffect(() => {
    if (actionType !== "meeting_place") return;
    if (meetingDate) return; // 既に入力済みならスキップ

    const allMsgs = (recentMessages || []).filter(
      (m: { sender?: string; text?: string }) => m.text && m.text !== "[画像]" && m.text !== "[動画]"
    );
    if (!allMsgs.length) return;

    fetch("/api/aix/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "extract_datetime", recent_messages: allMsgs }),
    })
      .then(ensureOk)
      .then(r => r.json())
      .then((d: { ok: boolean; date?: string; time?: string }) => {
        if (d.ok) {
          if (d.date) setMeetingDate(d.date);
          if (d.time) setMeetingTime(d.time);
        }
      })
      .catch((e) => { console.warn("[AixModal] 待ち合わせ日時の自動抽出失敗:", e); });
  // recentMessages を deps に含める（メッセージ読み込み後に再実行。meetingDate 設定後は早期リターンで冪等）
  }, [actionType, recentMessages]);

  // テンプレート画面を開いたときによく使われるフレーズを取得
  useEffect(() => {
    if (!showTemplateInfo) return;
    const status = conversationStatus ?? "hearing";
    fetch(`/api/learn-template-phrases?action_type=${encodeURIComponent(actionType)}&conversation_status=${encodeURIComponent(status)}`)
      .then(ensureOk)
      .then((r) => r.json())
      .then((d: { ok: boolean; phrases?: { phrase: string; usage_count: number }[] }) => {
        if (d.ok && d.phrases?.length) setTopPhrases(d.phrases);
      })
      .catch((e) => { console.error("[AixModal] フレーズ取得失敗:", e); });
  }, [showTemplateInfo, actionType, conversationStatus]);

  const handleConfirmImageUpload = async (file: File) => {
    const dataUrl = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    });
    setAppConfirmImagePreview(dataUrl);
    setAppConfirmExtractLoading(true);
    try {
      const base64 = dataUrl.split(",")[1];
      const mime = (dataUrl.split(";")[0].split(":")[1] || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      const res = await fetch("/api/extract-meeting-place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: base64, media_type: mime }),
      });
      await ensureOk(res);
      const data = await res.json() as { ok: boolean; name?: string };
      if (data.ok && data.name) setAppPropertyName(data.name);
      else if (!data.ok) setError("物件名の自動読み取りに失敗しました");
    } catch (e) { console.error("[AixModal] 申込確定 物件名OCR失敗:", e); setError("物件名の自動読み取りに失敗しました"); }
    setAppConfirmExtractLoading(false);
  };

  const onSelectImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      setImagePreview(dataUrl);
      // 物件オススメ: 退去日を自動抽出（OCR誤読防止）
      if (actionType === "property_recommendation") {
        setPropMoveOutDate("");
        const [header, base64] = dataUrl.split(",");
        const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
        void fetch("/api/aix/analyze-property", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: [{ base64, mediaType }] }),
        }).then(ensureOk)
          .then(res => res.json() as Promise<{ ok: boolean; properties?: Array<{ name: string; status: string; move_out: string }> }>)
          .then(data => {
            if (data.ok && data.properties?.length) {
              const prop = data.properties[0];
              if (prop.status === "scheduled" && prop.move_out) {
                setPropMoveOutDate(prop.move_out);
                onVacatingDetected?.(prop.move_out);
              }
            }
          }).catch((e) => { console.warn("[AixModal] 退去予定日の自動抽出失敗:", e); });
      }
    };
    reader.readAsDataURL(file);
    setPreview("");
    setParsedEstimate(null);
  };

  const onSelectConditionImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setConditionImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setConditionImagePreview(String(reader.result ?? ""));
    reader.readAsDataURL(file);
    setPreview("");
  };

  // 物件確認した専用: 複数画像追加
  const onSelectCheckImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setCheckImageFiles(prev => [...prev, ...files]);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => setCheckImagePreviews(prev => [...prev, String(reader.result ?? "")]);
      reader.readAsDataURL(file);
    });
    setPreview("");
    if (checkFileInputRef.current) checkFileInputRef.current.value = "";
  };

  const removeCheckImage = (i: number) => {
    setCheckImageFiles(prev => prev.filter((_, idx) => idx !== i));
    setCheckImagePreviews(prev => prev.filter((_, idx) => idx !== i));
    setPreview("");
    sentImageIndexRef.current = -1; // 画像リストが変わるとindexがずれるためリセット
  };

  // 複数物件: ref配列（hooks順序は固定なのでここで結合）
  const checkPropFileRefs = [checkProp1FileRef, checkProp2FileRef, checkProp3FileRef];
  const checkPropEstRefs = [checkProp1EstRef, checkProp2EstRef, checkProp3EstRef];

  const onSelectPropImages = (propIdx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setCheckPropImages(prev => prev.map((arr, i) => i === propIdx ? [...arr, ...files] : arr));
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => setCheckPropImagePreviews(prev => prev.map((arr, i) => i === propIdx ? [...arr, String(reader.result ?? "")] : arr));
      reader.readAsDataURL(file);
    });
    if (checkPropFileRefs[propIdx].current) checkPropFileRefs[propIdx].current!.value = "";
    // 読み取りは送信ボタン押下時に行う（onSelectPropImagesでは画像のプレビューのみ）
  };

  // 物件画像から物件名・退去予定日をまとめて読み取るヘルパー（submit時に呼ぶ）
  const extractPropInfoFromImages = async (count: number): Promise<{ name: string; vacancyDate: string }[]> => {
    const results: { name: string; vacancyDate: string }[] = [];
    for (let pi = 0; pi < count; pi++) {
      const manualName = checkPropNames[pi].trim();
      const manualDate = checkPropVacancyDates[pi].trim();
      const firstFile = checkPropImages[pi]?.[0];
      if (firstFile && (!manualName || !manualDate)) {
        try {
          const dataUrl = await new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.readAsDataURL(firstFile);
          });
          const base64 = dataUrl.split(",")[1];
          const mediaType = firstFile.type || "image/jpeg";
          const res = await fetch("/api/extract-vacancy-date", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageBase64: base64, mediaType }),
          });
          await ensureOk(res);
          const data = await res.json() as { propertyName: string | null; vacancyDate: string | null };
          results.push({
            name: manualName || data.propertyName || `物件${["①", "②", "③"][pi]}`,
            vacancyDate: manualDate || data.vacancyDate || "",
          });
        } catch {
          results.push({ name: manualName || `物件${["①", "②", "③"][pi]}`, vacancyDate: manualDate });
        }
      } else {
        results.push({ name: manualName || `物件${["①", "②", "③"][pi]}`, vacancyDate: manualDate });
      }
    }
    return results;
  };

  const removePropImage = (propIdx: number, imgIdx: number) => {
    setCheckPropImages(prev => prev.map((arr, i) => i === propIdx ? arr.filter((_, j) => j !== imgIdx) : arr));
    setCheckPropImagePreviews(prev => prev.map((arr, i) => i === propIdx ? arr.filter((_, j) => j !== imgIdx) : arr));
    sentImageIndexRef.current = -1; // 画像リストが変わるとindexがずれるためリセット
  };

  const onSelectPropEstimate = (propIdx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setCheckPropEstimates(prev => prev.map((v, i) => i === propIdx ? f : v));
    const reader = new FileReader();
    reader.onload = () => setCheckPropEstimatePreviews(prev => prev.map((v, i) => i === propIdx ? String(reader.result ?? "") : v));
    reader.readAsDataURL(f);
    if (checkPropEstRefs[propIdx].current) checkPropEstRefs[propIdx].current!.value = "";
  };

  const removePropEstimate = (propIdx: number) => {
    setCheckPropEstimates(prev => prev.map((v, i) => i === propIdx ? null : v));
    setCheckPropEstimatePreviews(prev => prev.map((v, i) => i === propIdx ? "" : v));
    if (checkPropEstRefs[propIdx].current) checkPropEstRefs[propIdx].current!.value = "";
  };

  // 物件ピックアップした専用: 複数画像追加
  const onSelectSendImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setSendImageFiles(prev => [...prev, ...files]);
    setPreview("");
    if (sendFileInputRef.current) sendFileInputRef.current.value = "";

    // base64に変換してプレビュー表示 + 物件情報自動解析
    const readPromises = files.map(file => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    }));

    void (async () => {
      const dataUrls = await Promise.all(readPromises);
      setSendImagePreviews(prev => [...prev, ...dataUrls]);
      // 退去予定は自動検出しない。「退去確認」ボタンを押したときだけ含まれる
    })();
  };

  const removeSendImage = (i: number) => {
    setSendImageFiles(prev => prev.filter((_, idx) => idx !== i));
    setSendImagePreviews(prev => prev.filter((_, idx) => idx !== i));
    setPreview("");
    sentImageIndexRef.current = -1; // 画像リストが変わるとindexがずれるためリセット
  };

  // 退去予定リストから vacatingNote テキストを再生成
  const syncVacatingNote = (props: Array<{name: string; moveOut: string; editingDate: boolean}>) => {
    const note = props
      .filter((p) => p.name.trim())
      .map((p) => { const d = p.moveOut.replace(/^\d{4}年/, ""); return `◎${p.name}: ${d ? d + "退去予定" : "退去予定"}`; })
      .join("\n");
    setVacatingNote(note);
  };

  // 退去確認ボタン: 画像を1枚ずつ順番にAI分析して退去予定物件を構造化リストに展開
  const handleVacatingCheck = async () => {
    if (sendImagePreviews.length === 0 || vacatingCheckLoading) return;
    setVacatingCheckLoading(true);
    setVacatingProperties([]);
    setVacatingNote("");
    setError("");
    const results: Array<{name: string; moveOut: string; editingDate: boolean}> = [];
    const total = sendImagePreviews.length;
    let failedCount = 0;

    for (let i = 0; i < total; i++) {
      setVacatingCheckProgress(`${i + 1}/${total}`);
      const url = sendImagePreviews[i];
      const [header, base64] = url.split(",");
      const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
      try {
        const res = await fetch("/api/aix/analyze-property", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: [{ base64, mediaType }] }),
        });
        await ensureOk(res);
        const data = await res.json() as { ok: boolean; properties?: Array<{name: string; status: string; move_out: string}> };
        if (data.ok && data.properties) {
          const scheduled = data.properties
            .filter((p) => p.status === "scheduled" && p.name)
            .map((p) => ({ name: p.name, moveOut: (p.move_out || "").replace(/^\d{4}年/, ""), editingDate: false }));
          results.push(...scheduled);
          setVacatingProperties([...results]);
          syncVacatingNote([...results]);
        }
      } catch (e) {
        // 1枚失敗しても続ける（ログのみ残す）
        failedCount++;
        console.warn(`[AixModal] 退去確認: ${i + 1}枚目の解析失敗:`, e);
      }
    }

    // 全枚失敗した場合はユーザーに通知（「退去予定なし」と誤解させない）
    if (failedCount === total && total > 0) {
      setError("退去確認の画像解析に失敗しました。通信状況を確認してもう一度お試しください");
    }

    setVacatingCheckProgress("");
    setVacatingCheckLoading(false);
  };

  const uploadImage = async (file: File, idx?: number): Promise<string> => {
    const ext = file.name.split(".").pop() || "jpg";
    const suffix = idx !== undefined ? `_${idx}` : "";
    const path = `aix/${conversationId}/${Date.now()}${suffix}_${Math.random().toString(36).slice(2, 7)}.${ext}`;

    // 20秒タイムアウト（Supabase storage はキャンセル不可なので Promise.race で制御）
    const uploadPromise = supabase.storage
      .from("property-images")
      .upload(path, file, { upsert: false });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("画像のアップロードがタイムアウトしました（20秒）。通信状況を確認してください")), 20000)
    );
    const { error: uploadError } = await Promise.race([uploadPromise, timeoutPromise]);
    if (uploadError) throw new Error("画像のアップロードに失敗しました: " + uploadError.message);

    const { data } = supabase.storage.from("property-images").getPublicUrl(path);
    return data.publicUrl;
  };

  const generate = async (extraFlags?: Record<string, unknown>) => {
    try {
      setLoading(true);
      setError("");

      const body: Record<string, unknown> = {
        action: actionType,
        account: account ?? "sumora",
        conversation_id: conversationId,
        customer_name: customerName,
      };

      if (actionType === "property_recommendation") {
        if (!imageFile) throw new Error("物件資料を選択してください");
        if (linkedCustomer) {
          // 紐付け済み: DBの条件をテキストで渡す（スクショ不要）
          body.customer_conditions = linkedCustomer.conditions;
          body.image_url = await uploadImage(imageFile);
        } else if (conditionImageFile) {
          // 条件スクショあり: 両方アップロード
          const [conditionUrl, propertyUrl] = await Promise.all([
            uploadImage(conditionImageFile, 0),
            uploadImage(imageFile, 1),
          ]);
          body.condition_image_url = conditionUrl;
          body.image_url = propertyUrl;
        } else {
          // 条件スクショなし: 物件資料のみで生成
          body.image_url = await uploadImage(imageFile);
        }
        // 新着フラグ
        if (isNewArrival) body.is_new_arrival = true;
        // ピックアップ種別（継続ピックアップの場合に追客向けプロンプトを使用）
        if (initialPickupType && initialPickupType !== "新着1件") body.pickup_type = initialPickupType;
        // 自動抽出した退去予定日を注入（OCR誤読防止）
        if (propMoveOutDate) body.move_out_date = propMoveOutDate;
      } else if (actionType === "property_send") {
        if (sendImageFiles.length > 0) {
          const urls = await Promise.all(sendImageFiles.map((f, i) => uploadImage(f, i)));
          body.image_urls = urls;
        }
        if (vacatingNote.trim()) body.vacating_note = vacatingNote.trim();
        body.send_mode = sendMode;
        if (sendMode === "new_arrival" && newArrivalApply) body.new_arrival_apply = true;
        if (includeCalendar) {
          const finalCalendarInfo = calendarDays
            .map((d, i) => {
              if (d.fullyBooked) return "";
              const slot = editableCalendarSlots[i] || d.slots[0] || "";
              return slot ? `${d.label} ${slot}` : "";
            })
            .filter(Boolean)
            .join("\n");
          if (finalCalendarInfo) body.calendar_info = finalCalendarInfo;
        }
        if (customerConditions) body.customer_conditions = customerConditions;
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        if (customerSummary) body.customer_summary = customerSummary;
        if (sendKeyword.trim()) body.keyword = sendKeyword.trim();
        if (lastMessageAt) body.last_message_at = lastMessageAt;
        if (sendExpandedConds.size > 0) body.expanded_conditions = Array.from(sendExpandedConds);
      } else if (actionType === "application_push") {
        if (appSubMode === "format") {
          const parts = [APP_FORMAT_SECTIONS.applicant];
          if (appFormatLivingType === "shared") parts.push(APP_FORMAT_SECTIONS.roommate);
          parts.push(appFormatGuarantorType === "emergency" ? APP_FORMAT_SECTIONS.emergency : APP_FORMAT_SECTIONS.guarantor);
          const text = parts.join("\n\n");
          setAiDraft(text);
          setPreview(text);
          setLoading(false);
          return;
        } else if (appSubMode === "confirm") {
          body.app_sub_mode = "confirm";
          if (appPropertyName.trim()) body.property_name = appPropertyName.trim();
          if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
          if (customerSummary) body.customer_summary = customerSummary;
        } else if (appSubMode === "docs_request") {
          body.app_sub_mode = "docs_request";
          if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
          if (customerSummary) body.customer_summary = customerSummary;
        } else {
          if (!appPushType) throw new Error("申込パターンを選択してください");
          body.vacancy_status = appPushType === "scheduled" ? "scheduled" : "vacant";
          body.app_push_type = appPushType;
          if (appAppealPoints.length > 0) body.appeal_points = appAppealPoints;
          if (appMoveOutDate.trim()) body.move_out_date = appMoveOutDate.trim();
          if (appPropertyName.trim()) body.property_name = appPropertyName.trim();
          // 直近スタッフメッセージから見積書送信済みを自動検出
          const staffMsgs = (recentMessages || []).filter(m => m.sender === "staff").slice(-15);
          const hasEstimate = staffMsgs.some(m => /見積|御見積|初期費用/.test(m.text));
          body.has_estimate = hasEstimate;
          if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
          if (customerSummary) body.customer_summary = customerSummary;
          // カレンダー情報（hold_view: 空室の場合に具体的な内覧時間をAIに渡す）
          if (appPushType === "hold_view" && calendarInfo) body.calendar_info = calendarInfo;
        }
      } else if (actionType === "followup_revive") {
        if (followupSubMode === "apply_supplement" || followupSubMode === "search_continue") {
          body.follow_sub_mode = followupSubMode;
          if (followupPropertyName.trim()) body.property_name = followupPropertyName.trim();
        }
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        if (customerSummary) body.customer_summary = customerSummary;
        if (extraInput.trim()) body.extra_input = extraInput.trim();
      } else if (actionType === "property_check_result" && checkPattern === "interior_photo") {
        // 室内写真確認: AIなしでプレビュー直接生成
        if (interiorPhotoUrl.trim()) {
          const msg = `（室内イメージ）\n${interiorPhotoUrl.trim()}`;
          setAiDraft(msg);
          setPreview(useEmoji ? msg : stripEmoji(msg));
          setLoading(false);
          return;
        }
        if (interiorPhotoFile) {
          const name = interiorPropertyName.trim();
          const msg = name
            ? `こちら${name}の室内写真となります😌！！`
            : "こちら室内写真となります😌！！";
          setAiDraft(msg);
          setPreview(useEmoji ? msg : stripEmoji(msg));
          setLoading(false);
          return;
        }
        throw new Error("URLまたは写真を入力してください");
      } else if (actionType === "property_check_result") {
        if (!checkPattern) throw new Error("確認結果を選択してください");
        body.check_pattern = checkPattern;
        if (checkPattern === "mgmt_initial_cost" && !mgmtCostType) throw new Error("パターンを選択してください");
        if (checkPattern === "mgmt_initial_cost" && mgmtCostType) body.mgmt_cost_type = mgmtCostType;
        if (checkPattern === "mgmt_parking") {
          if (!mgmtParkingAvailability) throw new Error("駐車場の有無を選択してください");
          body.parking_availability = mgmtParkingAvailability;
          if (mgmtParkingFee.trim()) body.parking_fee = mgmtParkingFee.trim();
          if (mgmtParkingVacancy) body.parking_vacancy = mgmtParkingVacancy;
        }
        if (checkPattern === "mgmt_pet") {
          if (!mgmtPetPolicy) throw new Error("ペット飼育の可否を選択してください");
          body.pet_policy = mgmtPetPolicy;
          if (mgmtPetCondition.trim()) body.pet_condition = mgmtPetCondition.trim();
        }
        if (checkPattern === "nearby_parking") {
          if (!nearbyParkingVacancy) throw new Error("空き状況を選択してください");
          body.nearby_parking_vacancy = nearbyParkingVacancy;
          if (nearbyParkingName.trim()) body.nearby_parking_name = nearbyParkingName.trim();
          if (nearbyParkingDistance.trim()) body.nearby_parking_distance = nearbyParkingDistance.trim();
          if (nearbyParkingFee.trim()) body.nearby_parking_fee = nearbyParkingFee.trim();
        }
        if (isMgmtCheck && checkPattern !== "mgmt_initial_cost" && checkPattern !== "mgmt_guarantor" && checkPattern !== "mgmt_parking" && checkPattern !== "mgmt_pet" && checkPattern !== "nearby_parking" && !inputText.trim()) throw new Error("管理会社に確認した内容を入力してください");
        if (checkPattern === "move_in_date") {
          if (!moveInImageFile) throw new Error("物件資料を選択してください");
          body.image_url = await uploadImage(moveInImageFile);
        } else if (checkPattern === "alternative") {
          if (!checkFloorPlan) { setFloorPlanTouched(true); throw new Error("代替お部屋の間取りを選択してください"); }
          if (checkEndedFloor !== null) body.ended_floor = checkEndedFloor;
          if (checkEndedUnit.trim()) body.ended_unit = checkEndedUnit.trim();
          body.floor_plan_match = checkFloorPlan;
        }
        if (checkPattern === "available") {
          // 全件数（1件含む）: 物件カードから画像・名前を取得
          body.property_count = checkPropertyCount;
          body.prop_statuses = checkPropStatuses.slice(0, checkPropertyCount);
          const extractedProps = await extractPropInfoFromImages(checkPropertyCount);
          body.property_names = extractedProps.map(p => p.name);
          body.property_vacancy_dates = extractedProps.map(p => p.vacancyDate);
          const allImageUrls: string[] = [];
          for (let pi = 0; pi < checkPropertyCount; pi++) {
            if (checkPropImages[pi].length > 0) {
              const urls = await Promise.all(checkPropImages[pi].map((f, j) => uploadImage(f, j)));
              allImageUrls.push(...urls);
            }
          }
          if (allImageUrls.length > 0) { body.image_urls = allImageUrls; body.image_url = allImageUrls[0]; }
          const estimateUrls: string[] = [];
          for (let pi = 0; pi < checkPropertyCount; pi++) {
            const ef = checkPropEstimates[pi];
            if (ef) estimateUrls.push(await uploadImage(ef));
          }
          if (estimateUrls.length > 0) body.estimate_image_urls = estimateUrls;
        } else if (checkPattern === "exclusive") {
          // 専任物件: 固定文送信（AI不要）。画像はOCR内部用のみでお客さんには送らない
          if (!exclusivePropName.trim()) throw new Error("物件名を入力してください");
          body.exclusive_prop_name = exclusivePropName.trim();
          body.exclusive_room_no = exclusiveRoomNo.trim();
        } else if (checkPattern === "mgmt_guarantor") {
          // 画像がある場合はアップロード（任意）
          if (mgmtDocImage) {
            const docUrl = await uploadImage(mgmtDocImage, 0);
            body.image_url = docUrl;
          }
          // テキストフィールドの値を渡す
          if (mgmtGuarantorPropertyName.trim()) body.property_name = mgmtGuarantorPropertyName.trim();
          if (mgmtGuarantorCompanyName.trim()) body.guarantor_company_name = mgmtGuarantorCompanyName.trim();
          if (mgmtGuarantorType) body.guarantor_type = mgmtGuarantorType;
          // 誘導方向（任意）
          if (mgmtGuarantorPushType) body.guarantor_push_type = mgmtGuarantorPushType;
        } else {
          if (checkEstimateFile) body.estimate_image_url = await uploadImage(checkEstimateFile);
          if (checkImageFiles.length > 0) {
            const urls = await Promise.all(checkImageFiles.map((f, i) => uploadImage(f, i)));
            body.image_urls = urls;
            body.image_url = urls[0];
          }
          // 管理会社確認パターン: 物件資料を任意添付
          if (isMgmtCheck && mgmtDocImage) {
            const docUrl = await uploadImage(mgmtDocImage, 0);
            (body as Record<string, unknown>).doc_image_url = docUrl;
          }
        }
        if (checkPattern === "available") body.show_viewing_invite = showCheckCalendar;
        if (checkPattern === "available") body.check_application_invite = checkApplicationInvite;
        if (checkPattern === "available" && showCheckCalendar && checkCalendarInfo) body.calendar_info = checkCalendarInfo;
        if (checkPattern === "available" && checkAvailableApp) body.available_application = checkAvailableApp;
        if (checkPattern === "available") body.all_properties_available = checkAllAvailable;
        if (checkPattern === "available" && checkRecommendProp !== null) body.recommend_prop_index = checkRecommendProp;
        if (checkPattern === "available" && checkIncludeEstimateText) body.include_estimate_text = true;
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        if (customerSummary) body.customer_summary = customerSummary;
      } else if (actionType === "estimate_sheet" && estimateMultiMode) {
        if (estimateMultiFiles.length === 0) throw new Error("見積書を1枚以上選択してください");
        const urls = await Promise.all(estimateMultiFiles.map((f, i) => uploadImage(f, i)));
        body.image_urls = urls;
        body.multi_estimate = true;
      } else if (config.requiresImage && imageFile) {
        body.image_url = await uploadImage(imageFile);
      }

      // 内覧へ！内覧日指定ありモード → テンプレで即生成（AI不要）
      // ただし「会話を合わせる」(conversation_match: true)のときはAI生成を優先するためスキップ
      if (actionType === "viewing_invite" && viewingSpecificMode && !extraFlags?.conversation_match) {
        if (!viewingSpecificDate.trim()) throw new Error("日程を入力してください");
        const s = viewingSpecificStart.trim();
        const e = viewingSpecificEnd.trim();
        const timeText = s && e ? `${s}〜${e}` : s || "";
        const msg = `はい😊！！\n${viewingSpecificDate.trim()}ですと${timeText}ご内覧可能です！！\n${customerName}さんご都合如何でしょうか😌！！`;
        setAiDraft(msg);
        setPreview(useEmoji ? msg : stripEmoji(msg));
        setLoading(false);
        return;
      }

      // 内覧へ！退去予定物件モード → テンプレで即生成（AI不要）
      if (actionType === "viewing_invite" && viewingIsVacancy) {
        if (!viewingVacancyName.trim()) throw new Error("物件名を入力してください");
        if (!viewingVacancyMoveOut.trim()) throw new Error("退去予定日を入力してください");

        // 月日から近傍の日付を解決（半年以上過去なら翌年とみなす＝年跨ぎ対応）
        const resolveNearDate = (month: number, day: number): Date => {
          const now = new Date();
          const d = new Date(now.getFullYear(), month - 1, day);
          if (d.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 180) {
            return new Date(now.getFullYear() + 1, month - 1, day);
          }
          return d;
        };

        // 退去翌日を計算（◯月◯日 形式）※「7月20」（日なし）にも対応
        const moveOutText = viewingVacancyMoveOut.trim();
        let viewingFromText = "";
        let viewingFromDate: Date | null = null;
        const jpMatch = moveOutText.match(/(\d{1,2})月(\d{1,2})日?/);
        if (jpMatch) {
          viewingFromDate = resolveNearDate(parseInt(jpMatch[1]), parseInt(jpMatch[2]) + 1);
          viewingFromText = `${viewingFromDate.getMonth() + 1}月${viewingFromDate.getDate()}日`;
        }

        // カレンダースロット取得（退去翌日より前の日付は除外）
        const selectedSlots = viewingCalendarDays
          .map((d, i) => {
            const isEnabled = d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i];
            if (!isEnabled) return "";
            const start = viewingSlotStarts[i] || "";
            const end = viewingSlotEnds[i] || "";
            if (!start) return "";
            // 退去前の日付スロットを除外（label例: "7/3(金)" / "明日 7/3(金)"）
            if (viewingFromDate) {
              const slotMatch = d.label.match(/(\d{1,2})\/(\d{1,2})/);
              if (slotMatch) {
                const slotDate = resolveNearDate(parseInt(slotMatch[1]), parseInt(slotMatch[2]));
                if (slotDate.getTime() < viewingFromDate.getTime()) return "";
              }
            }
            return `${d.label} ${start}${end ? "〜" + end : ""}`;
          })
          .filter(Boolean);

        const fromPhrase = viewingFromText ? `${viewingFromText}以降` : "退去後";
        let msg: string;
        if (selectedSlots.length > 0) {
          msg = `${viewingVacancyName.trim()}現在募集中となります！！\n${moveOutText}退去予定のお部屋で${fromPhrase}でお部屋ご案内可能です！！\n\n直近ですと\n${selectedSlots.join("\n")}\nご案内出来ます！！\n\n${customerName}さんご都合如何でしょうか！！`;
        } else {
          msg = `${viewingVacancyName.trim()}現在募集中となります！！\n${moveOutText}退去予定のお部屋で${fromPhrase}でお部屋ご案内可能です！！\n${customerName}さん${fromPhrase}のご都合よろしいお日にちにご案内させて頂きます😊！！`;
        }

        setAiDraft(msg);
        setPreview(useEmoji ? msg : stripEmoji(msg));
        setLoading(false);
        return;
      }

      if (actionType === "meeting_place") {
        if (!meetingDate.trim()) throw new Error("日程を入力してください");
        if (!meetingPropertyName.trim()) throw new Error("物件名を入力してください（画像読み込みまたは手動入力）");
        const hasTime = !!meetingTime.trim();
        if (hasTime) {
          // 時間あり: 即座にローカル生成
          const meetingDateNoWd = meetingDate.replace(/（[日月火水木金土]）/, "");
          let msg = `かしこまりました！！\n${meetingDate}ご案内させて頂きます！！\n\n${meetingDateNoWd} ${meetingTime}に${meetingPropertyName}\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！`;
          if (meetingPropertyAddress.trim()) msg += `\n住所: ${meetingPropertyAddress}`;
          setAiDraft(msg);
          setPreview(useEmoji ? msg : stripEmoji(msg));
          setLoading(false);
          return;
        }
        // 時間なし: APIでLINEから時間を自動抽出して生成
        body.meeting_date = meetingDate;
        body.meeting_property_name = meetingPropertyName;
        body.meeting_property_address = meetingPropertyAddress;
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        // fall through to API call
      }

      if (actionType === "viewing_invite" && viewingRescheduleMode) {
        body.reschedule_mode = true;
      }

      if (actionType === "viewing_invite" && viewingCalendarDays.length > 0) {
        const selectedSlots = viewingCalendarDays
          .map((d, i) => {
            const isEnabled = d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i];
            if (!isEnabled) return "";
            const start = viewingSlotStarts[i] || "";
            const end = viewingSlotEnds[i] || "";
            if (!start) return "";
            return `${d.label} ${start}${end ? "〜" + end : ""}`;
          })
          .filter(Boolean)
          .join("\n");
        if (selectedSlots) body.calendar_info = selectedSlots;
      }
      // おすすめポイント + 強調ポイントを結合
      const focusPrefix = recommendFocusPoints.length > 0
        ? `【特に強調するポイント: ${recommendFocusPoints.join("・")}】\n`
        : "";
      const combinedExtra = `${focusPrefix}${inputText.trim()}`.trim();
      if (combinedExtra) body.extra_input = combinedExtra;
      if (recSimpleMode) body.simple_mode = true;
      if (extraFlags) Object.assign(body, extraFlags);
      if (parsedEstimate) body.parsed_estimate = parsedEstimate;
      if (!body.recent_messages && recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
      if (initialTemplateStructure && initialTemplateStructure.length > 0) body.template_structure = initialTemplateStructure;
      if (initialTemplateSample) body.template_sample = initialTemplateSample;

      // 60秒タイムアウト（AI生成が遅いと loading=true のまま固まるのを防ぐ）
      const aborter = new AbortController();
      const tid = setTimeout(() => aborter.abort(), 60000);
      let res: Response;
      try {
        res = await fetch("/api/aix/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: aborter.signal,
        });
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
          throw new Error("AI生成がタイムアウトしました（60秒）。もう一度お試しください");
        }
        throw fetchErr;
      } finally {
        clearTimeout(tid);
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `生成に失敗しました（HTTP ${res.status}）`);

      const generatedMsg = data.message_text || "";
      setAiDraft(generatedMsg);
      setPreview(useEmoji ? generatedMsg : stripEmoji(generatedMsg));
      if (data.ai_components) setAiActionComponents(data.ai_components as Record<string, string>);
      setAixNotice(data.notice || "");
      if (data.parsed_estimate) setParsedEstimate(data.parsed_estimate);
      setEstimateTextReady(data.estimate_text || "");
      // ① LL-07: カバーレターを保存（見積書に添える挨拶文）
      if (data.coverLetter) setEstimateCoverLetter(data.coverLetter as string);
      // 保証会社確認: 画像URLをstateに保存（TODO: 画像→本文の順で送る際に使用）
      if (data.doc_image_url) setPreviewDocImageUrl(data.doc_image_url as string);
      setSendCountdown(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  // AIX専用stateを使う（save-reply-exampleのSTATE_NORMALIZEに入らないstateにする）
  // → aix/action/route.ts の AIX_ACTION_TO_STATES と一致させ、☆実例・差分学習ルールを次回生成に届ける
  const ACTION_TO_STATE: Record<string, string> = {
    property_send: "property_send",
    property_recommendation: "property_recommendation",
    property_check_result: "property_check_result",
    estimate_sheet: "estimate_sheet",
    viewing_invite: "viewing_invite",
    application_push: "application_push",
    meeting_place: "meeting_place",
    condition_hearing: "condition_hearing",
    greeting_viewing: "greeting_viewing",
    acknowledge_check: "acknowledge_check",
    followup_revive: "followup_revive",
  };

  // save-reply-example の保存ペイロードを構築（即時送信・予約送信で共通利用）
  // aiDraft / previousStaffMessage を必ず含めることで、差分学習（analyze-diffs）の対象から漏れないようにする
  const buildSaveReplyPayload = (sentReply: string, fallbackCustomerMessage: string) => {
    const lastCustomerMsg = (recentMessages ?? [])
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .at(-1)?.text;
    const lastStaffMsg = (recentMessages ?? [])
      .filter((m) => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .at(-1)?.text;
    // サブパターンをconversationStateに埋め込む（ピッカー選択別に差分学習ルールを分離）
    // property_check_result_available / application_push_confirm / property_send_widen 等
    const stateSubKey =
      actionType === "property_check_result" && checkPattern && checkPattern !== "interior_photo" && checkPattern !== "move_in_date"
        ? `property_check_result_${checkPattern}`
        : actionType === "application_push" && appSubMode
        ? `application_push_${appSubMode}`
        : actionType === "property_send" && sendMode && sendMode !== "normal"
        ? `property_send_${sendMode}`
        : null;
    return {
      conversationState: stateSubKey ?? ACTION_TO_STATE[actionType] ?? "hearing",
      conversationId,
      customerMessage: lastCustomerMsg || fallbackCustomerMessage,
      sentReply,
      aiDraft,
      previousStaffMessage: lastStaffMsg,
      // 改善⑬: sentAt を付与 → save-reply-example の冪等ガード
      // （conversation_id + sent_at + sent_reply の重複チェック）がAIX経由保存でも効くようにする
      sentAt: new Date().toISOString(),
      isStarred: false,
      // AIXからの送信は AIX固有のstate名（property_recommendation / condition_hearing 等）のまま保存する
      // （save-reply-example の STATE_NORMALIZE による proposing / hearing への変換をスキップ）
      skipNormalize: true,
      // 各ピッカー: コンポーネント別AI生成結果（差分学習ループ用・全アクション共通）
      ...(aiActionComponents ? { aiComponents: aiActionComponents } : {}),
      // CRIT-02修正: テンプレートモーダル経由で開いた場合はtemplate_idを付与（テンプレート成果学習ループ用）
      ...(templateId ? { template_id: templateId } : {}),
    };
  };

  // AIX送信文をテンプレート候補として保存（fire-and-forget）
  // wasEdited=true の場合は source="aix_edit" + originalText を付加して保存（スタッフ編集の追跡）
  const saveTemplateCandidate = (sentText: string, wasEdited?: boolean, originalDraft?: string) => {
    if ((account ?? "").toLowerCase() === "yuma") return; // テストアカウントは学習除外
    if (!sentText.trim() || sentText.length < 20) return; // 短すぎるものはスキップ
    // 意味のあるタイトルを自動生成（1行目 or 先頭25文字）
    const firstLine = sentText.split("\n").find(l => l.trim().length > 0) ?? sentText;
    const baseTitle = firstLine.slice(0, 25).trim();
    const suggestedTitle = wasEdited ? `[編集] ${baseTitle}` : baseTitle;
    fetch("/api/ai-template-candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionType,
        templateText: sentText,
        conversationId,
        suggestedTitle,
        // P1: 候補の根拠（同一パターン再送時はサーバ側で evidence_count がカウントアップされる）
        reason: wasEdited ? "AIX生成後に編集された文" : "送信テンプレート",
        ...(wasEdited && originalDraft
          ? { source: "aix_edit", originalText: originalDraft }
          : {}),
      }),
    }).then(ensureOk).catch((e) => { console.warn("[AixModal] テンプレ候補保存失敗:", e); }); // 送信自体は妨げない
  };

  // AIX送信後の学習処理をまとめて実行（fire-and-forget）
  // 通常送信パス・estimate-first（見積書テキスト先送り）パスの両方から呼ぶ（G-05: 早期returnによる学習スキップ防止）
  const runLearning = (sentText: string) => {
    if ((account ?? "").toLowerCase() === "yuma") return; // テストアカウントは学習除外
    const lastCustomerMsg = (recentMessages ?? [])
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .at(-1)?.text;

    // 学習ループに保存
    fetch("/api/save-reply-example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSaveReplyPayload(sentText, inputText.trim() || `（AIX: ${config?.title ?? actionType}）`)),
    }).then(ensureOk).catch((e) => { console.warn("[AixModal] save-reply-example保存失敗:", e); });

    // ① LL-07: 見積書カバーレターを学習ループに別途保存（sentText=estimate表・coverLetter=AI挨拶文で別個学習）
    if (actionType === "estimate_sheet" && estimateCoverLetter.trim()) {
      fetch("/api/save-reply-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildSaveReplyPayload(estimateCoverLetter, "（見積書カバーレター）"),
          aiDraft: estimateCoverLetter,
        }),
      }).then(ensureOk).catch((e) => { console.warn("[AixModal] カバーレター学習保存失敗:", e); });
    }

    // スタッフ編集検知: aiDraft（AI生成原文）と sentText（実際に送った文）が違う場合は source="aix_edit" で記録
    // emoji正規化: 絵文字オフで送信しただけの場合（本文は同じ）は「編集なし」と判定する
    // property_recommendation のみ除外（テキスト自体に物件固有情報が入るため）
    // property_send はテキスト部分（「ピックアップしました！！」等）が汎用化できるため除外しない
    const trimmedDraft = aiDraft.trim();
    const trimmedSent = sentText.trim();
    const wasEdited = trimmedDraft.length > 0
      && trimmedSent !== trimmedDraft
      && stripEmoji(trimmedSent) !== stripEmoji(trimmedDraft);
    if (wasEdited && actionType !== "property_recommendation") {
      saveTemplateCandidate(sentText, true, trimmedDraft);
    }

    // テンプレートフレーズ学習ログ
    if (sentText.trim()) {
      fetch("/api/learn-template-phrases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_type: actionType,
          conversation_status: conversationStatus ?? "hearing",
          sent_text: sentText,
        }),
      }).then(ensureOk).catch((e) => { console.warn("[AixModal] フレーズ学習ログ保存失敗:", e); });
    }

    // MED-06修正: learn-action-patterns の POST を削除（page.tsx の onAfterSend 側に統一して2重INSERTを防ぐ）
    // page.tsx:7468 の onAfterSend で source/predicted_action 等のリッチな情報付きで記録している
  };

  const openAixScheduleModal = () => {
    if (!preview.trim()) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    let baseTime: Date;
    if (lastScheduledAt) {
      const normalized = lastScheduledAt.replace(" ", "T").replace(/\+00$/, "+00:00");
      baseTime = new Date(Math.max(new Date(normalized).getTime() + 60 * 1000, Date.now() + 60 * 1000));
    } else {
      baseTime = new Date(Date.now() + 60 * 60 * 1000);
    }
    const d = new Date(baseTime.getTime() + 9 * 60 * 60 * 1000);
    setAixScheduleDateTime(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
    setShowAixScheduleModal(true);
  };

  const executeAixScheduleSend = async () => {
    if (!preview.trim() || !aixScheduleDateTime) return;
    const leftover = detectPlaceholders(preview);
    if (leftover.length > 0) {
      setError(`未置換のプレースホルダーがあります: ${leftover.join(" ")}`);
      return;
    }
    setAixScheduleSaving(true);
    try {
      const imageUrls: string[] = [];
      let textToSend = preview;

      if (actionType === "property_send") {
        for (let i = 0; i < sendImageFiles.length; i++) imageUrls.push(await uploadImage(sendImageFiles[i], i));
      } else if (actionType === "property_check_result") {
        for (let i = 0; i < checkImageFiles.length; i++) imageUrls.push(await uploadImage(checkImageFiles[i], i));
        if (checkEstimateFile) imageUrls.push(await uploadImage(checkEstimateFile));
      } else if (actionType === "property_recommendation") {
        if (imageFile) imageUrls.push(await uploadImage(imageFile));
        if (recommendEstimateFile) imageUrls.push(await uploadImage(recommendEstimateFile));
        if (propertyImageUrl.trim()) textToSend = `（室内イメージ）\n${propertyImageUrl.trim()}\n\n${preview}`;
      } else if (actionType === "estimate_sheet" && estimateMultiMode) {
        for (let i = 0; i < estimateMultiFiles.length; i++) imageUrls.push(await uploadImage(estimateMultiFiles[i], i));
      } else if (actionType === "estimate_sheet") {
        if (estimatePropertyFile) imageUrls.push(await uploadImage(estimatePropertyFile));
        if (imageFile) imageUrls.push(await uploadImage(imageFile));
      } else {
        if (imageFile) imageUrls.push(await uploadImage(imageFile));
      }

      const cleanDt = aixScheduleDateTime.substring(0, 16);
      const scheduledAt = new Date(`${cleanDt}:00+09:00`).toISOString();
      const { error: insertErr } = await supabase.from("scheduled_messages").insert({
        conversation_id: conversationId,
        line_user_id: lineUserId,
        account: account ?? "sumora",
        text: textToSend || null,
        image_urls: imageUrls,
        scheduled_at: scheduledAt,
      });
      if (insertErr) throw insertErr;

      // 予約送信もパターンとして記録（実際に送る意図が確定しているため）
      const lastCustomerMsg = (recentMessages ?? [])
        .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]")
        .at(-1)?.text ?? "";
      if (conversationStatus) {
        fetch("/api/learn-action-patterns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "log",
            conversation_status: conversationStatus,
            action_type: actionType,
            customer_msg_summary: lastCustomerMsg.slice(0, 150),
          }),
        }).then(ensureOk).catch((e) => { console.warn("[AixModal] アクションパターン学習ログ保存失敗（予約送信）:", e); });
      }

      // 予約送信後の学習ループ保存（fire-and-forget）
      fetch("/api/save-reply-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSaveReplyPayload(textToSend, `（AIX予約: ${config?.title ?? actionType}）`)),
      }).then(ensureOk).catch((e) => { console.warn("[AixModal] save-reply-example保存失敗（予約送信）:", e); });
      // T05: LL-07 見積書カバーレターを予約送信パスでも学習（通常送信パスと対称化）
      if (actionType === "estimate_sheet" && estimateCoverLetter.trim()) {
        fetch("/api/save-reply-example", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...buildSaveReplyPayload(estimateCoverLetter, "（見積書カバーレター）"),
            aiDraft: estimateCoverLetter,
          }),
        }).then(ensureOk).catch((e) => { console.warn("[AixModal] カバーレター学習保存失敗（予約送信）:", e); });
      }

      // フレーズ学習ログ（予約送信パスでも通常送信パスと同様に記録）
      if (textToSend.trim()) {
        fetch("/api/learn-template-phrases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action_type: actionType,
            conversation_status: conversationStatus ?? "hearing",
            sent_text: textToSend,
          }),
        }).then(ensureOk).catch((e) => { console.warn("[AixModal] フレーズ学習ログ保存失敗（予約送信）:", e); });
      }

      // スタッフ編集検知（予約送信）: emoji正規化してから比較（絵文字オフのみの変更は編集扱いしない）
      const schedTrimmedDraft = aiDraft.trim();
      const schedTrimmedSent = textToSend.trim();
      const schedWasEdited = schedTrimmedDraft.length > 0
        && schedTrimmedSent !== schedTrimmedDraft
        && stripEmoji(schedTrimmedSent) !== stripEmoji(schedTrimmedDraft);
      if (schedWasEdited && actionType !== "property_recommendation") {
        saveTemplateCandidate(textToSend, true, schedTrimmedDraft);
      }

      // 待ち合わせ確定後にカレンダーイベントを作成（予約送信の場合も同様）
      if (actionType === "meeting_place" && meetingDate && meetingTime && meetingPropertyName) {
        createViewingCalendarEvent({ meetingDate, meetingTime, meetingPropertyName, meetingPropertyAddress, customerName });
      }

      onAfterSend?.({
        suggest2ndHand: actionType === "property_check_result" && checkAvailableApp === "yes",
        suggestViewingTemplate: actionType === "viewing_invite",
        suggestViewing: actionType === "property_check_result" && checkPattern === "available" && checkAvailableApp !== "yes",
        suggestInitialCostTemplate: actionType === "property_recommendation" && recommendFocusPoints.includes("初期費用"),
        suggestAlternativeSend: actionType === "property_check_result" && checkPattern === "unavailable",
        suggestPropertySend: actionType === "condition_hearing",
        suggestApplicationPush: actionType === "estimate_sheet",
        checkPattern: checkPattern ?? undefined,
        appSubMode: appSubMode ?? undefined,
        sendMode: sendMode ?? undefined,
        scheduled: true,
        wasEdited: schedWasEdited,
      });
      onScheduled?.();
      setShowAixScheduleModal(false);
      onClose();
    } catch (err) {
      setError(`予約失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAixScheduleSaving(false);
    }
  };

  const handleSend = async () => {
    if (!preview.trim()) return;
    const leftover = detectPlaceholders(preview);
    if (leftover.length > 0) {
      setError(`未置換のプレースホルダーがあります: ${leftover.join(" ")}`);
      return;
    }
    try {
      setLoading(true);

      if (actionType === "property_send") {
        // 物件画像を先に送信 → テキストを後で送信（送信済みindexはスキップ＝再押下時の重複送信防止）
        for (let imgIdx = sentImageIndexRef.current + 1; imgIdx < sendImageFiles.length; imgIdx++) {
          const url = await uploadImage(sendImageFiles[imgIdx]);
          await sendAsAix("", url);
          sentImageIndexRef.current = imgIdx;
        }
        await sendAsAix(preview);
        sentImageIndexRef.current = -1;
      } else if (actionType === "property_check_result") {
        if (checkPattern === "interior_photo") {
          // 室内写真: 写真→テキストの順で送信（URLの場合はテキストのみ）
          if (interiorPhotoFile) {
            const photoUrl = await uploadImage(interiorPhotoFile);
            await sendAsAix("", photoUrl);
          }
          await sendAsAix(preview);
        } else if (checkPattern === "move_in_date") {
          // 入居日確認: テキストのみ送信（物件資料はお客さんに送らない）
          await sendAsAix(preview);
        } else if (checkPattern === "available") {
          // available: 物件①資料→見積書①→物件②資料→見積書②→[見積書テキスト→30s]→本文
          const shouldSendEstimateFirst = !!(estimateTextReady && checkIncludeEstimateText);
          // ② 見積書テキストONだが見積書未アップロードの場合は警告
          if (checkIncludeEstimateText && !shouldSendEstimateFirst) {
            const hasEst = checkPropEstimates.slice(0, checkPropertyCount).some(ef => ef !== null);
            if (!hasEst) {
              setError("見積書テキスト同封がONですが、見積書ファイルがアップロードされていません。各物件カードに見積書を追加するか、同封をOFFにしてください。");
              setLoading(false);
              return;
            }
          }
          // 物件ごとに: 資料画像 → 見積書画像 の順で送信（送信済みindexはスキップ＝再押下時の重複送信防止）
          let flatImgIdx = -1;
          for (let pi = 0; pi < checkPropertyCount; pi++) {
            for (const file of (checkPropImages[pi] ?? [])) {
              flatImgIdx++;
              if (flatImgIdx <= sentImageIndexRef.current) continue;
              const url = await uploadImage(file, pi);
              await sendAsAix("", url);
              sentImageIndexRef.current = flatImgIdx;
            }
            const ef = checkPropEstimates[pi];
            if (ef) {
              flatImgIdx++;
              if (flatImgIdx > sentImageIndexRef.current) {
                const estUrl = await uploadImage(ef);
                await sendAsAix("", estUrl);
                sentImageIndexRef.current = flatImgIdx;
              }
            }
          }
          // 見積書テキスト先送り → モーダルを閉じてバックグラウンドで30秒後に本文送信
          if (shouldSendEstimateFirst) {
            await sendAsAix(estimateTextReady);
            sentImageIndexRef.current = -1; // 画像は全件送信済みなのでリセット
            setEstimateTextReady("");
            // 送信関数・本文をクロージャでキャプチャ（宛先が変わっても元の会話に送られる）
            const capturedOnSend = onSend;
            const capturedPreview = preview;
            const capturedOnAfterSend = onAfterSend;
            const capturedActionType: string = actionType;
            const capturedCheckAvailableApp: string | null = checkAvailableApp;
            const capturedCheckPattern: string | null = checkPattern;
            const capturedRecommendFocusPoints: string[] = recommendFocusPoints;
            const capturedAppSubMode: string | null | undefined = appSubMode;
            const capturedSendMode: string | null | undefined = sendMode;
            // 断線④: was_edited を onAfterSend 経由で log-aix-usage に渡す（遅延送信パス）
            const _capDraft = aiDraft.trim();
            const _capSent = preview.trim();
            const capturedWasEdited = _capDraft.length > 0
              && _capSent !== _capDraft
              && stripEmoji(_capSent) !== stripEmoji(_capDraft);
            const sendFn = async () => {
              await capturedOnSend(capturedPreview);
              capturedOnAfterSend?.({
                suggest2ndHand: capturedActionType === "property_check_result" && capturedCheckAvailableApp === "yes",
                suggestViewingTemplate: capturedActionType === "viewing_invite",
                suggestViewing: capturedActionType === "property_check_result" && capturedCheckPattern === "available" && capturedCheckAvailableApp !== "yes",
                suggestInitialCostTemplate: capturedActionType === "property_recommendation" && capturedRecommendFocusPoints.includes("初期費用"),
                suggestAlternativeSend: capturedActionType === "property_check_result" && capturedCheckPattern === "unavailable",
                suggestPropertySend: capturedActionType === "condition_hearing",
                suggestApplicationPush: capturedActionType === "estimate_sheet",
                checkPattern: capturedCheckPattern ?? undefined,
                appSubMode: capturedAppSubMode ?? undefined,
                sendMode: capturedSendMode ?? undefined,
                wasEdited: capturedWasEdited,
              });
            };
            onDelayedSend?.(30, sendFn); // 親がsetTimeoutを管理（キャンセル可能）
            // G-05: 早期returnで学習がスキップされないよう、本文（30秒後に送信される文面）で学習を実行
            runLearning(capturedPreview);
            setLoading(false);
            onClose();
            return;
          }
          await sendAsAix(preview);
          sentImageIndexRef.current = -1;
        } else {
          // alternative / その他: 物件資料画像 → 見積書 → 本文（送信済みindexはスキップ＝再押下時の重複送信防止）
          for (let imgIdx = sentImageIndexRef.current + 1; imgIdx < checkImageFiles.length; imgIdx++) {
            const url = await uploadImage(checkImageFiles[imgIdx]);
            await sendAsAix("", url);
            sentImageIndexRef.current = imgIdx;
          }
          if (checkEstimateFile && sentImageIndexRef.current < checkImageFiles.length) {
            const estUrl = await uploadImage(checkEstimateFile);
            await sendAsAix("", estUrl);
            sentImageIndexRef.current = checkImageFiles.length;
          }
          await sendAsAix(preview);
          sentImageIndexRef.current = -1;
        }
      } else {
        // 物件オススメは物件資料画像をLINEに添付
        let uploadedImageUrl: string | undefined;
        if (actionType === "property_recommendation" && imageFile) {
          uploadedImageUrl = await uploadImage(imageFile);
        } else if (config.requiresImage && imageFile) {
          uploadedImageUrl = await uploadImage(imageFile);
        }
        // 物件オススメ送信順: 物件資料画像 → 見積書 → 室内URL → テキスト
        if (actionType === "property_recommendation") {
          if (uploadedImageUrl) await sendAsAix("", uploadedImageUrl);
          if (recommendEstimateFile) {
            const estUrl = await uploadImage(recommendEstimateFile);
            await sendAsAix("", estUrl);
          }
          if (propertyImageUrl.trim()) await sendAsAix(`（室内イメージ）\n${propertyImageUrl.trim()}`);
          await sendAsAix(preview);
        } else if (actionType === "estimate_sheet" && estimateMultiMode) {
          // 複数件: 見積書を順に送ってから合算テキスト（送信済みindexはスキップ＝再押下時の重複送信防止）
          for (let imgIdx = sentImageIndexRef.current + 1; imgIdx < estimateMultiFiles.length; imgIdx++) {
            const url = await uploadImage(estimateMultiFiles[imgIdx]);
            await sendAsAix("", url);
            sentImageIndexRef.current = imgIdx;
          }
          await sendAsAix(preview);
          sentImageIndexRef.current = -1;
        } else if (actionType === "estimate_sheet") {
          // 送信順: ①カバーレター（AI挨拶文・任意）→ ②物件資料（任意）→ ③見積書 → ④テキスト
          if (estimateCoverLetter.trim()) await sendAsAix(estimateCoverLetter);
          if (estimatePropertyFile) {
            const propUrl = await uploadImage(estimatePropertyFile);
            await sendAsAix("", propUrl);
          }
          if (uploadedImageUrl) await sendAsAix("", uploadedImageUrl);
          await sendAsAix(preview);
        } else {
          await sendAsAix(preview, uploadedImageUrl);
        }
      }

      // 待ち合わせ確定後にカレンダーイベントを作成
      if (actionType === "meeting_place" && meetingDate && meetingTime && meetingPropertyName) {
        createViewingCalendarEvent({ meetingDate, meetingTime, meetingPropertyName, meetingPropertyAddress, customerName });
      }

      // 学習処理（fire-and-forget、G-05: runLearningに集約）
      // 断線④: was_edited を計算してから runLearning に渡し、onAfterSend 経由で log-aix-usage に渡す
      const _sendTrimDraft = aiDraft.trim();
      const _sendTrimSent = preview.trim();
      const _sendWasEdited = _sendTrimDraft.length > 0
        && _sendTrimSent !== _sendTrimDraft
        && stripEmoji(_sendTrimSent) !== stripEmoji(_sendTrimDraft);
      runLearning(preview);

      onAfterSend?.({
        suggest2ndHand: actionType === "property_check_result" && checkAvailableApp === "yes",
        suggestViewingTemplate: actionType === "viewing_invite",
        suggestViewing: actionType === "property_check_result" && checkPattern === "available" && checkAvailableApp !== "yes",
        suggestInitialCostTemplate: actionType === "property_recommendation" && recommendFocusPoints.includes("初期費用"),
        suggestAlternativeSend: actionType === "property_check_result" && checkPattern === "unavailable",
        suggestPropertySend: actionType === "condition_hearing",
        suggestApplicationPush: actionType === "estimate_sheet",
        checkPattern: checkPattern ?? undefined,
        appSubMode: appSubMode ?? undefined,
        sendMode: sendMode ?? undefined,
        wasEdited: _sendWasEdited,
      });
      onClose();
    } catch (err) {
      setError(`送信に失敗しました: ${err instanceof Error ? err.message : "通信エラー"}`);
    } finally {
      setLoading(false);
    }
  };

  // 生成ボタンが押せるか
  const canGenerate = actionType === "property_recommendation"
    ? !!imageFile
    : actionType === "property_check_result"
    ? (checkPattern === "move_in_date" ? !!moveInImageFile
      : checkPattern === "interior_photo" ? (!!interiorPhotoUrl.trim() || !!interiorPhotoFile)
      : checkPattern === "exclusive" ? !!exclusivePropName.trim()
      : isMgmtCheck ? (
          checkPattern === "mgmt_initial_cost"
            ? !!mgmtCostType && (mgmtCostType === "estimate" || !!inputText.trim())
            : checkPattern === "mgmt_guarantor"
            ? mgmtGuarantorCompanyName.trim().length > 0
            : checkPattern === "mgmt_parking"
            ? !!mgmtParkingAvailability
            : checkPattern === "mgmt_pet"
            ? !!mgmtPetPolicy
            : checkPattern === "nearby_parking"
            ? !!nearbyParkingVacancy
            : !!inputText.trim()
        )
      : !!checkPattern)
    : actionType === "property_send"
    ? true
    : actionType === "application_push"
    ? appSubMode === "confirm" ? true : appSubMode === "docs_request" ? true : appSubMode === "format" ? !!(appFormatLivingType && appFormatGuarantorType) : !!appPushType
    : actionType === "meeting_place"
    ? (!!meetingDate.trim() && !!meetingPropertyName.trim())
    : !config.requiresImage || !!imageFile;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center"
      onClick={(e) => {
        if (sendCountdown > 0) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl md:rounded-3xl">
        {/* ヘッダー */}
        <div className="flex items-center justify-between rounded-t-3xl px-5 py-4"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          <div className="text-[17px] font-bold text-white">
            {config.emoji ? `${config.emoji} ` : ""}{config.title}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTemplateInfo(v => !v)}
              className="flex items-center gap-1 rounded-full bg-white/20 px-3 py-1 text-xs font-medium text-white hover:bg-white/30"
            >
              テンプレ確認
            </button>
            <button
              onClick={onClose}
              disabled={sendCountdown > 0}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ✕
            </button>
          </div>
        </div>


        <div className="max-h-[75vh] overflow-y-auto p-5">
          {/* 物件オススメ: テンプレート選択アナウンス */}
          {actionType === "property_recommendation" && (
            <button
              onClick={() => setShowTemplateInfo(true)}
              className="mb-4 w-full flex items-center justify-between rounded-2xl border-2 border-blue-400 bg-blue-50 px-4 py-3 active:bg-blue-100 transition-colors"
            >
              <span className="text-[14px] font-bold text-blue-700">▶ テンプレートを確認する</span>
              <span className="text-blue-400 text-lg">›</span>
            </button>
          )}

          <p className="mb-4 text-sm text-[#667781]">{config.description}</p>

          {/* 物件オススメ専用: 2枚画像エリア */}
          {actionType === "property_recommendation" ? (
            <div className="mb-4 flex flex-col gap-3">
              {/* ①お客さんの条件（任意） */}
              <div>
                <p className="mb-1 text-xs font-bold text-[#54656f]">① お客さんの条件 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                {linkedCustomer ? (
                  // 紐付け済み: DBの条件を自動表示
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-xs font-bold text-emerald-600">🔗 紐付け済み</span>
                      <span className="text-xs text-emerald-600">{linkedCustomer.name}</span>
                    </div>
                    <pre className="whitespace-pre-wrap text-xs text-[#111b21] font-sans leading-5">{linkedCustomer.conditions}</pre>
                  </div>
                ) : conditionImagePreview ? (
                  <div className="relative overflow-hidden rounded-2xl border border-[#d1d7db]">
                    <img src={conditionImagePreview} alt="条件" className="max-h-36 w-full object-contain" />
                    <button
                      onClick={() => { setConditionImageFile(null); setConditionImagePreview(""); setPreview(""); if (conditionFileInputRef.current) conditionFileInputRef.current.value = ""; }}
                      className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                    >変更</button>
                  </div>
                ) : (
                  <button
                    onClick={() => conditionFileInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#d1d7db] py-4 text-sm font-semibold text-[#90a4ae] hover:bg-[#f5f6f7]"
                  >📋 条件スクショを選択（スキップ可）</button>
                )}
                <input ref={conditionFileInputRef} type="file" accept="image/*" onChange={onSelectConditionImage} className="hidden" />
              </div>

              {/* ②物件資料 */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-bold text-[#54656f]">② 物件資料</p>
                  <button
                    type="button"
                    onClick={() => setIsNewArrival(prev => !prev)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold transition ${
                      isNewArrival
                        ? "border-transparent text-white"
                        : "border-[#d1d7db] bg-white text-[#90a4ae]"
                    }`}
                    style={isNewArrival ? { background: "linear-gradient(135deg, #059669, #10b981)" } : {}}
                  >新着</button>
                </div>
                {imagePreview ? (
                  <div className="relative overflow-hidden rounded-2xl border border-[#d1d7db]">
                    <img src={imagePreview} alt="物件" className="max-h-36 w-full object-contain" />
                    <button
                      onClick={() => { setImageFile(null); setImagePreview(""); setPreview(""); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                      className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                    >変更</button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-200 py-5 text-sm font-semibold text-[#2196F3] hover:bg-blue-50"
                  >🏠 物件資料を選択</button>
                )}
                <input ref={fileInputRef} type="file" accept="image/*" onChange={onSelectImage} className="hidden" />
              </div>

              {/* ③室内イメージURL（任意） */}
              <div>
                <p className="mb-1 text-xs font-bold text-[#54656f]">
                  ③ 室内イメージURL <span className="font-normal text-[#90a4ae]">（任意）</span>
                </p>
                <input
                  type="url"
                  value={propertyImageUrl}
                  onChange={(e) => setPropertyImageUrl(e.target.value)}
                  placeholder="https://suumo.jp/..."
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                />
                {propertyImageUrl.trim() && (
                  <p className="mt-1 text-[10px] text-[#8696a0]">
                    送信時に「（室内イメージ）」として別メッセージで自動送信されます
                  </p>
                )}
              </div>

              {/* ④見積書（任意） */}
              <div>
                <p className="mb-1 text-xs font-bold text-[#54656f]">
                  ④ 見積書 <span className="font-normal text-[#90a4ae]">（任意・物件資料と一緒に送る場合）</span>
                </p>
                {recommendEstimatePreview ? (
                  <div className="relative overflow-hidden rounded-2xl border border-[#d1d7db]">
                    <img src={recommendEstimatePreview} alt="見積書" className="max-h-36 w-full object-contain" />
                    <button
                      onClick={() => { setRecommendEstimateFile(null); setRecommendEstimatePreview(""); if (recommendEstimateInputRef.current) recommendEstimateInputRef.current.value = ""; }}
                      className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                    >変更</button>
                  </div>
                ) : (
                  <button
                    onClick={() => recommendEstimateInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#d1d7db] py-3 text-sm font-semibold text-[#90a4ae] hover:bg-[#f5f6f7]"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    見積書を追加する（スキップ可）
                  </button>
                )}
                <input
                  ref={recommendEstimateInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setRecommendEstimateFile(f);
                    const reader = new FileReader();
                    reader.onload = () => setRecommendEstimatePreview(String(reader.result ?? ""));
                    reader.readAsDataURL(f);
                  }}
                  className="hidden"
                />
              </div>
            </div>
          ) : actionType === "property_send" ? (
            /* 物件ピックアップした: モード選択 + カレンダー自動取得 + 複数画像 + 退去予定メモ */
            <div className="mb-4 flex flex-col gap-3">
              {/* 物件画像（複数） */}
              <div>
                <p className="mb-1 text-xs font-bold text-[#54656f]">
                  物件画像 <span className="font-normal text-[#90a4ae]">（複数選択可・任意）</span>
                </p>
                {sendImagePreviews.length > 0 && (
                  <div className="mb-2 grid grid-cols-3 gap-2">
                    {sendImagePreviews.map((src, i) => (
                      <div key={i} className="relative overflow-hidden rounded-xl border border-[#d1d7db] aspect-square">
                        <img src={src} alt={`物件${i + 1}`} className="h-full w-full object-cover" />
                        <button
                          onClick={() => removeSendImage(i)}
                          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => sendFileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-200 py-3 text-sm font-semibold text-[#2196F3] hover:bg-blue-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  {sendImagePreviews.length > 0 ? `追加する（現在${sendImagePreviews.length}枚）` : "物件画像を追加する（スキップ可）"}
                </button>
                <input ref={sendFileInputRef} type="file" accept="image/*" multiple onChange={onSelectSendImages} className="hidden" />
              </div>
              {/* モード選択 */}
              <div>
                <p className="mb-1.5 text-xs font-bold text-[#54656f]">送るモードを選択</p>
                <div className="flex flex-col gap-2 mb-2">
                  {(sendMode === null || sendMode === "normal") && (
                    <button
                      onClick={() => { setSendMode(sendMode === "normal" ? null : "normal"); setPreview(""); }}
                      className={`w-full rounded-full py-2.5 text-sm font-bold transition-all ${
                        sendMode === "normal"
                          ? "bg-[#1565C0] text-white shadow-sm"
                          : "border border-[#d1d7db] bg-white text-[#54656f]"
                      }`}
                    >
                      新規物件
                    </button>
                  )}
                  {(sendMode === null || sendMode === "new_arrival") && (
                    <button
                      onClick={() => { setSendMode(sendMode === "new_arrival" ? null : "new_arrival"); setPreview(""); }}
                      className={`w-full rounded-full py-2.5 text-sm font-bold transition-all ${
                        sendMode === "new_arrival"
                          ? "bg-[#FF6F00] text-white shadow-sm"
                          : "border border-[#d1d7db] bg-white text-[#54656f]"
                      }`}
                    >
                      新着物件
                    </button>
                  )}
                  {(sendMode === null || sendMode === "widen") && (
                    <button
                      onClick={() => { setSendMode(sendMode === "widen" ? null : "widen"); setPreview(""); if (sendMode !== "widen") setSendExpandedConds(new Set()); }}
                      className={`w-full rounded-full py-2.5 text-sm font-bold transition-all ${
                        sendMode === "widen"
                          ? "bg-[#F57C00] text-white shadow-sm"
                          : "border border-[#d1d7db] bg-white text-[#54656f]"
                      }`}
                    >
                      条件を広げた
                    </button>
                  )}
                  {sendMode === "new_arrival" && (
                    <button
                      onClick={() => setNewArrivalApply(prev => !prev)}
                      className={`rounded-full px-4 py-2.5 text-sm font-bold transition-all ${
                        newArrivalApply
                          ? "bg-[#06c755] text-white shadow-sm"
                          : "border border-[#d1d7db] bg-white text-[#54656f]"
                      }`}
                    >
                      申込み誘導
                    </button>
                  )}
                </div>
              </div>
              {/* 条件を広げたモード: チップを直接表示 */}
              {sendMode === "widen" && (
                <div className="flex flex-wrap gap-2">
                  {(["家賃", "礼金", "築年数", "地域", "初期費用"] as const).map((cond) => {
                    const selected = sendExpandedConds.has(cond);
                    return (
                      <button
                        key={cond}
                        onClick={() => {
                          setSendExpandedConds(prev => {
                            const next = new Set(prev);
                            if (next.has(cond)) next.delete(cond); else next.add(cond);
                            return next;
                          });
                          setPreview("");
                        }}
                        className={`rounded-full border px-4 py-1.5 text-[13px] font-bold transition-colors ${selected ? "border-orange-500 bg-orange-500 text-white" : "border-[#d1d7db] bg-white text-[#555]"}`}
                      >{cond}</button>
                    );
                  })}
                </div>
              )}
              {/* カレンダー自動取得（削除済み: 旧内覧誘導モード用） */}
              {false && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-xs font-bold text-[#54656f]">📅 内覧可能な時間帯（自動計算）</p>
                    <button
                      onClick={() => setIncludeCalendar(prev => !prev)}
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition-all ${
                        includeCalendar
                          ? "bg-[#f0f2f5] text-[#54656f]"
                          : "bg-[#2196F3] text-white"
                      }`}
                    >
                      {includeCalendar ? "日程なしにする" : "日程なし（タップで戻す）"}
                    </button>
                  </div>
                  {!includeCalendar && (
                    <div className="rounded-xl bg-[#f0f2f5] px-3 py-2 text-xs text-[#8696a0]">内覧可能日はメッセージに含まれません</div>
                  )}
                  {includeCalendar && calendarLoading ? (
                    <div className="flex items-center gap-2 rounded-xl bg-[#f0f2f5] px-3 py-2.5 text-sm text-[#8696a0]">
                      <span className="inline-block animate-spin">⏳</span>
                      <span>カレンダー読み込み中...</span>
                    </div>
                  ) : includeCalendar ? (
                    <div className="flex flex-col gap-1.5">
                      {calendarDays.length > 0 ? calendarDays.map((d, i) => (
                        <div key={i} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${
                          d.fullyBooked ? "bg-red-50" : "bg-emerald-50"
                        }`}>
                          <span className={`font-bold flex-shrink-0 ${d.fullyBooked ? "text-red-500" : "text-emerald-700"}`}>
                            {d.label}
                          </span>
                          {d.fullyBooked ? (
                            <span className="text-red-400">案内不可（予定詰まり）</span>
                          ) : (
                            <input
                              type="text"
                              value={editableCalendarSlots[i] ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                setEditableCalendarSlots(prev => {
                                  const next = [...prev];
                                  next[i] = v;
                                  return next;
                                });
                              }}
                              className="flex-1 min-w-0 bg-transparent text-emerald-700 outline-none text-xs"
                              placeholder="11:00〜14:00"
                            />
                          )}
                        </div>
                      )) : (
                        <div className="rounded-xl bg-[#f0f2f5] px-3 py-2 text-xs text-[#8696a0]">取得できませんでした</div>
                      )}
                    </div>
                  ) : null}
                  <p className="mt-1 text-[10px] text-[#8696a0]">calendar_events＋screening予定を合算・AIが自動アナウンスします</p>
                </div>
              ) /* end false */}
              {/* 退去予定・案内できない物件 */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold text-[#54656f]">退去予定・案内できない物件</p>
                  <button
                    onClick={handleVacatingCheck}
                    disabled={vacatingCheckLoading || sendImagePreviews.length === 0}
                    className="flex items-center gap-1.5 rounded-full bg-[#ff6b35] px-3 py-1 text-[11px] font-bold text-white disabled:opacity-40 active:opacity-70"
                  >
                    {vacatingCheckLoading ? (
                      <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />{vacatingCheckProgress ? `${vacatingCheckProgress}枚目確認中` : "確認中"}</>
                    ) : "退去確認"}
                  </button>
                </div>
                {/* 構造化リスト（退去確認ボタン後に表示） */}
                {vacatingProperties.length > 0 && (
                  <div className="mb-2 flex flex-col gap-1.5">
                    {vacatingProperties.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-xl border border-[#ffccbc] bg-[#fff3f0] px-2.5 py-2">
                        <input
                          value={p.name}
                          onChange={(e) => {
                            const updated = vacatingProperties.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x);
                            setVacatingProperties(updated);
                            syncVacatingNote(updated);
                          }}
                          className="min-w-0 flex-1 bg-transparent text-[12px] text-[#111b21] outline-none"
                          placeholder="物件名"
                        />
                        {p.editingDate ? (
                          <input
                            value={p.moveOut}
                            autoFocus
                            onChange={(e) => {
                              const updated = vacatingProperties.map((x, idx) => idx === i ? { ...x, moveOut: e.target.value } : x);
                              setVacatingProperties(updated);
                              syncVacatingNote(updated);
                            }}
                            onBlur={() => {
                              const updated = vacatingProperties.map((x, idx) => idx === i ? { ...x, editingDate: false } : x);
                              setVacatingProperties(updated);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                const updated = vacatingProperties.map((x, idx) => idx === i ? { ...x, editingDate: false } : x);
                                setVacatingProperties(updated);
                              }
                            }}
                            className="w-24 shrink-0 rounded-lg border border-[#ff8a65] bg-white px-2 py-0.5 text-[12px] text-[#bf360c] outline-none"
                            placeholder="退去日"
                          />
                        ) : (
                          <button
                            onClick={() => {
                              const updated = vacatingProperties.map((x, idx) => idx === i ? { ...x, editingDate: true } : x);
                              setVacatingProperties(updated);
                            }}
                            className="shrink-0 rounded-lg bg-[#ffccbc] px-2 py-0.5 text-[12px] font-bold text-[#bf360c]"
                          >
                            {p.moveOut || "日程未定"}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            const updated = vacatingProperties.filter((_, idx) => idx !== i);
                            setVacatingProperties(updated);
                            syncVacatingNote(updated);
                          }}
                          className="shrink-0 text-[#8696a0] text-[14px] leading-none"
                        >×</button>
                      </div>
                    ))}
                    <button
                      onClick={() => {
                        const updated = [...vacatingProperties, { name: "", moveOut: "", editingDate: false }];
                        setVacatingProperties(updated);
                      }}
                      className="self-start pl-1 text-[11px] text-[#8696a0]"
                    >＋ 手動追加</button>
                  </div>
                )}
                {/* 退去確認前は何も表示しない（押したら1枚ずつ順番に読み取り結果が表示される） */}
                {vacatingProperties.length === 0 && !vacatingCheckLoading && (
                  <p className="text-[11px] text-[#b0bec5]">退去確認ボタンを押すと画像を1枚ずつ読み取ります</p>
                )}
              </div>

              {/* キーワード */}
              <div>
                <p className="mb-1 text-xs font-bold text-[#54656f]">
                  キーワード <span className="font-normal text-[#90a4ae]">（任意）</span>
                </p>
                <input
                  type="text"
                  value={sendKeyword}
                  onChange={(e) => { setSendKeyword(e.target.value); setPreview(""); }}
                  placeholder="例：築浅・南向き・ペット可 など"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                />
                <p className="mt-1 text-[10px] text-[#8696a0]">入力するとLINEの会話＋キーワードをもとにAIが文を生成します</p>
              </div>
            </div>
          ) : actionType === "application_push" ? (
            /* 申込へ！: 申込誘導 / 申込確定 2分割 */
            <div className="mb-4 flex flex-col gap-3">
              {/* モード選択ボタン (2×2グリッド) */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { setAppSubMode("push"); setPreview(""); setAppConfirmImagePreview(""); setAppConfirmExtractLoading(false); setAppFormatLivingType(null); setAppFormatGuarantorType(null); }}
                  className={`rounded-2xl border-2 px-2 py-3 text-center transition-all ${
                    appSubMode === "push" ? "border-[#1565C0] bg-blue-50" : "border-[#e9edef] bg-[#f8f9fa]"
                  }`}
                >
                  <div className="text-[11px] font-bold text-[#1565C0]">📋 申込誘導</div>
                  <div className="mt-0.5 text-[8px] text-[#8696a0]">後押しメッセージ</div>
                </button>
                <button
                  onClick={() => {
                    setAppSubMode("confirm");
                    setPreview("");
                    setAiDraft("");
                    let detected = appPropertyName.trim();
                    if (!detected) {
                      const staffMsgs = (recentMessages || []).filter(m => m.sender === "staff").reverse();
                      for (const msg of staffMsgs) {
                        const m = msg.text.match(/^【(.+?)】/);
                        if (m) { detected = m[1].trim(); break; }
                      }
                    }
                    if (detected) setAppPropertyName(detected);
                  }}
                  className={`rounded-2xl border-2 px-2 py-3 text-center transition-all ${
                    appSubMode === "confirm" ? "border-emerald-500 bg-emerald-50" : "border-[#e9edef] bg-[#f8f9fa]"
                  }`}
                >
                  <div className="text-[11px] font-bold text-emerald-600">✅ 申込確定</div>
                  <div className="mt-0.5 text-[8px] text-[#8696a0]">確定のご連絡</div>
                </button>
                <button
                  onClick={() => { setAppSubMode("format"); setAppFormatLivingType(null); setAppFormatGuarantorType(null); setPreview(""); }}
                  className={`rounded-2xl border-2 px-2 py-3 text-center transition-all ${
                    appSubMode === "format" ? "border-purple-500 bg-purple-50" : "border-[#e9edef] bg-[#f8f9fa]"
                  }`}
                >
                  <div className="text-[11px] font-bold text-purple-600">📄 フォーマット</div>
                  <div className="mt-0.5 text-[8px] text-[#8696a0]">申込書を送る</div>
                </button>
                <button
                  onClick={() => { setAppSubMode("docs_request"); setPreview(""); setAiDraft(""); setAppConfirmImagePreview(""); setAppConfirmExtractLoading(false); setAppFormatLivingType(null); setAppFormatGuarantorType(null); }}
                  className={`rounded-2xl border-2 px-2 py-3 text-center transition-all ${
                    appSubMode === "docs_request" ? "border-orange-500 bg-orange-50" : "border-[#e9edef] bg-[#f8f9fa]"
                  }`}
                >
                  <div className="text-[11px] font-bold text-orange-600">🔖 書類依頼</div>
                  <div className="mt-0.5 text-[8px] text-[#8696a0]">不足書類の確認・依頼</div>
                </button>
              </div>

              {/* 申込確定: 物件名（自動検出・修正可）＋物件資料読み込み */}
              {appSubMode === "confirm" && (
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                      物件名 <span className="font-normal text-[#90a4ae]">（自動検出・修正可）</span>
                    </label>
                    <input
                      type="text"
                      value={appPropertyName}
                      onChange={(e) => setAppPropertyName(e.target.value)}
                      placeholder="例：マルシェ九条 402号室"
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-emerald-400 placeholder:text-[#8696a0]"
                    />
                  </div>
                  {/* 物件資料から物件名を読み込む */}
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-[#54656f]">
                      物件資料から読み込む <span className="font-normal text-[#90a4ae]">（物件名が不明な場合）</span>
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => confirmImageInputRef.current?.click()}
                        className="flex items-center gap-1.5 rounded-xl border border-[#d1d7db] bg-[#f8f9fa] px-3 py-2 text-xs text-[#54656f] transition hover:bg-[#e9edef]"
                      >
                        <span>📎</span>
                        <span>物件資料を選択</span>
                      </button>
                      {appConfirmExtractLoading && (
                        <span className="text-[11px] text-[#8696a0]">物件名を読み取り中...</span>
                      )}
                      {appConfirmImagePreview && !appConfirmExtractLoading && (
                        <img src={appConfirmImagePreview} className="h-10 w-10 rounded-lg object-cover border border-[#d1d7db]" alt="物件資料" />
                      )}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      ref={confirmImageInputRef}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleConfirmImageUpload(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                </div>
              )}

              {/* 申込フォーマット: 入居形態・保証人タイプ */}
              {appSubMode === "format" && (
                <div className="flex flex-col gap-3">
                  {/* 単独 / 同居 */}
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#54656f]">入居形態を選択 <span className="text-red-400">*</span></p>
                    <div className="flex gap-2">
                      {([
                        { key: "single", label: "単独", sub: "同居人なし" },
                        { key: "shared", label: "同居あり", sub: "同居人記入欄を追加" },
                      ] as const).map((p) => (
                        <button
                          key={p.key}
                          onClick={() => { setAppFormatLivingType(p.key); setPreview(""); }}
                          className={`flex-1 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                            appFormatLivingType === p.key ? "border-purple-400 bg-purple-50" : "border-[#e9edef] bg-[#f8f9fa]"
                          }`}
                        >
                          <span className={`mr-2 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                            appFormatLivingType === p.key ? "border-purple-500 bg-purple-500" : "border-[#d1d7db]"
                          }`}>
                            {appFormatLivingType === p.key && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                          </span>
                          <span className="text-[13px] font-bold text-[#111b21]">{p.label}</span>
                          <div className="mt-0.5 text-[10px] text-[#8696a0]">{p.sub}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 緊急連絡先 / 連帯保証人 */}
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#54656f]">保証人タイプを選択 <span className="text-red-400">*</span></p>
                    <div className="flex gap-2">
                      {([
                        { key: "emergency", label: "緊急連絡先", sub: "電話のみ・支払い義務なし" },
                        { key: "guarantor", label: "連帯保証人", sub: "実印+印鑑証明・支払い義務あり" },
                      ] as const).map((p) => (
                        <button
                          key={p.key}
                          onClick={() => { setAppFormatGuarantorType(p.key); setPreview(""); }}
                          className={`flex-1 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                            appFormatGuarantorType === p.key ? "border-purple-400 bg-purple-50" : "border-[#e9edef] bg-[#f8f9fa]"
                          }`}
                        >
                          <span className={`mr-2 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                            appFormatGuarantorType === p.key ? "border-purple-500 bg-purple-500" : "border-[#d1d7db]"
                          }`}>
                            {appFormatGuarantorType === p.key && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                          </span>
                          <span className="text-[13px] font-bold text-[#111b21]">{p.label}</span>
                          <div className="mt-0.5 text-[10px] text-[#8696a0]">{p.sub}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* 書類依頼: 説明 */}
              {appSubMode === "docs_request" && (
                <div className="rounded-xl bg-orange-50 border border-orange-200 px-4 py-3">
                  <p className="text-[12px] font-bold text-orange-700 mb-1">🔖 書類依頼メッセージを生成します</p>
                  <p className="text-[11px] text-orange-600 leading-relaxed">
                    直近の会話から申込フォームの受信状況・本人確認書類（表裏2枚）の到着状況を自動判断し、不足している書類の依頼文を生成します。
                  </p>
                </div>
              )}

              {/* 申込誘導: 既存フォーム */}
              {appSubMode === "push" && (
                <>
                  {/* 物件名（任意） */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                      物件名 <span className="font-normal text-[#90a4ae]">（任意）</span>
                    </label>
                    <input
                      type="text"
                      value={appPropertyName}
                      onChange={(e) => setAppPropertyName(e.target.value)}
                      placeholder="例：プレサンス心斎橋ブライト"
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                    />
                  </div>
                  {/* 見積書送信済み自動検出 */}
                  {(() => {
                    const staffMsgs = (recentMessages || []).filter(m => m.sender === "staff").slice(-15);
                    const hasEstimate = staffMsgs.some(m => /見積|御見積|初期費用/.test(m.text));
                    return (
                      <div className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs ${
                        hasEstimate ? "bg-emerald-50 text-emerald-700" : "bg-[#f0f2f5] text-[#8696a0]"
                      }`}>
                        <span>{hasEstimate ? "✓" : "−"}</span>
                        <span className="font-semibold">
                          {hasEstimate ? "見積書送信済み（直近メッセージより検出）" : "見積書未送信（見積書のくだりは省略されます）"}
                        </span>
                      </div>
                    );
                  })()}
                  {/* 申込パターン選択 */}
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#54656f]">申込パターンを選択</p>
                    <div className="flex flex-col gap-2">
                      {([
                        { key: "simple",    label: "シンプル申込",  sub: "内覧済み・検討中の方へ申込みを後押し",   color: "emerald" },
                        { key: "scheduled", label: "退去予定",      sub: "内覧不可・先にお申込みでお部屋確保",     color: "orange"  },
                        { key: "hold_view", label: "部屋抑えて内覧", sub: "申込で30日間確保→その状態でご内覧",    color: "blue"    },
                      ] as const).map((p) => (
                        <button
                          key={p.key}
                          onClick={() => { setAppPushType(p.key); setPreview(""); setAppAppealPoints([]); }}
                          className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                            appPushType === p.key
                              ? p.color === "emerald" ? "border-emerald-400 bg-emerald-50"
                              : p.color === "orange"  ? "border-orange-400 bg-orange-50"
                              :                         "border-blue-400 bg-blue-50"
                              : "border-[#e9edef] bg-[#f8f9fa]"
                          }`}
                        >
                          <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 flex-shrink-0 ${
                            appPushType === p.key
                              ? p.color === "emerald" ? "border-emerald-500 bg-emerald-500"
                              : p.color === "orange"  ? "border-orange-500 bg-orange-500"
                              :                         "border-blue-500 bg-blue-500"
                              : "border-[#d1d7db]"
                          }`}>
                            {appPushType === p.key && <span className="h-2 w-2 rounded-full bg-white" />}
                          </span>
                          <div>
                            <div className="text-[13px] font-bold text-[#111b21]">{p.label}</div>
                            <div className="text-[10px] text-[#8696a0]">{p.sub}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 訴求ポイント選択（シンプル申込・部屋抑えて内覧のみ） */}
                  {(appPushType === "simple" || appPushType === "hold_view") && (
                    <div>
                      <p className="mb-2 text-xs font-bold text-[#54656f]">
                        訴求ポイントを選択
                        <span className="ml-1 font-normal text-[#90a4ae]">（複数可）</span>
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        {(["部屋の条件", "初期費用", "家賃"] as const).map((pt) => (
                          <button
                            key={pt}
                            onClick={() => setAppAppealPoints(prev =>
                              prev.includes(pt) ? prev.filter(p => p !== pt) : [...prev, pt]
                            )}
                            className={`rounded-full border-2 px-3 py-1.5 text-xs font-bold transition-all ${
                              appAppealPoints.includes(pt)
                                ? "border-purple-400 bg-purple-50 text-purple-700"
                                : "border-[#e9edef] bg-[#f8f9fa] text-[#54656f]"
                            }`}
                          >
                            {pt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* 退去予定日（退去予定選択時のみ） */}
                  {appPushType === "scheduled" && (
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                        退去予定日 <span className="font-normal text-[#90a4ae]">（任意）</span>
                      </label>
                      <input
                        type="text"
                        value={appMoveOutDate}
                        onChange={(e) => setAppMoveOutDate(e.target.value)}
                        placeholder="例：7月末、8月1日"
                        className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          ) : actionType === "property_check_result" && isMgmtCheck ? (
            /* 管理会社に確認した: パターン選択不要・日付選択またはテキスト入力で生成 */
            <div className="mb-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded-2xl border-2 border-teal-400 bg-teal-50 px-4 py-3">
                <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-teal-500 bg-teal-500 flex-shrink-0">
                  <span className="h-2 w-2 rounded-full bg-white" />
                </span>
                <div>
                  <div className="text-[13px] font-bold text-[#111b21]">
                    {checkPattern === "nearby_parking" ? "近隣の月極駐車場を確認した" : <>管理会社に確認した：{checkPattern === "vacate_date" ? "退去予定日" : checkPattern === "mgmt_move_in" ? "入居可能日" : checkPattern === "mgmt_guarantor" ? "保証会社（審査面）" : checkPattern === "mgmt_parking" ? "駐車場" : checkPattern === "mgmt_pet" ? "ペット飼育" : "初期費用"}</>}
                  </div>
                  <div className="text-[10px] text-[#8696a0]">確認内容を入力するだけでAIが報告文を作成します</div>
                </div>
              </div>

              {/* 退去予定日・入居可能日: 日付ピッカー */}
              {(checkPattern === "vacate_date" || checkPattern === "mgmt_move_in") && (
                <div>
                  <p className="mb-2 text-xs font-bold text-[#54656f]">
                    {checkPattern === "vacate_date" ? "退去予定日" : "入居可能日"}を選択
                  </p>
                  <div className="relative">
                    <input
                      type="date"
                      onChange={(e) => {
                        if (!e.target.value) return;
                        const d = new Date(e.target.value + "T00:00:00");
                        const m = d.getMonth() + 1;
                        const day = d.getDate();
                        const dateStr = `${m}月${day}日`;
                        const prefix = checkPattern === "vacate_date" ? "退去予定日：" : "入居可能日：";
                        setInputText(prefix + dateStr);
                        setPreview("");
                      }}
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-teal-400"
                      style={{ colorScheme: "light" }}
                    />
                  </div>
                </div>
              )}

              {/* 初期費用: サブパターン選択 */}
              {checkPattern === "mgmt_initial_cost" && (
                <div>
                  <p className="mb-2 text-xs font-bold text-[#54656f]">パターンを選択 <span className="text-red-400">*</span></p>
                  <div className="flex flex-col gap-2">
                    {([
                      { key: "estimate", label: "見積書おくる", sub: "条件確認した・見積書を送る" },
                      { key: "negotiation", label: "管理会社交渉", sub: "交渉した結果を報告する" },
                    ] as const).map(({ key, label, sub }) => (
                      <button
                        key={key}
                        onClick={() => { setMgmtCostType(key); setInputText(""); setPreview(""); }}
                        className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                          mgmtCostType === key
                            ? "border-teal-400 bg-teal-50"
                            : "border-[#e9edef] bg-[#f8f9fa]"
                        }`}
                      >
                        <div>
                          <div className={`text-[13px] font-bold ${mgmtCostType === key ? "text-teal-700" : "text-[#111b21]"}`}>{label}</div>
                          <div className="text-[10px] text-[#8696a0]">{sub}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 駐車場確認専用: 有無・料金・空き状況 */}
              {checkPattern === "mgmt_parking" && (
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#54656f]">駐車場の有無 <span className="text-red-400">*</span></p>
                    <div className="flex gap-2">
                      {(["あり", "なし"] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => { setMgmtParkingAvailability(v); setPreview(""); }}
                          className={`flex-1 rounded-xl border-2 py-2.5 text-xs font-bold transition ${
                            mgmtParkingAvailability === v
                              ? "border-teal-400 bg-teal-50 text-teal-700"
                              : "border-[#e9edef] bg-[#f8f9fa] text-[#9CA3AF]"
                          }`}
                        >
                          {v === "あり" ? "🚗 駐車場あり" : "駐車場なし"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {mgmtParkingAvailability === "あり" && (
                    <>
                      <div>
                        <p className="mb-1 text-xs font-bold text-[#54656f]">料金 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                        <input
                          type="text"
                          value={mgmtParkingFee}
                          onChange={(e) => { setMgmtParkingFee(e.target.value); setPreview(""); }}
                          placeholder="例：月3,000円"
                          className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-teal-400 placeholder:text-[#8696a0]"
                        />
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-bold text-[#54656f]">空き状況 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                        <div className="flex gap-1.5">
                          {(["空きあり", "空きなし", "要確認"] as const).map((v) => (
                            <button
                              key={v}
                              onClick={() => { setMgmtParkingVacancy(prev => prev === v ? null : v); setPreview(""); }}
                              className={`flex-1 rounded-xl border py-2 text-[11px] font-semibold transition ${
                                mgmtParkingVacancy === v
                                  ? "border-teal-400 bg-teal-50 text-teal-700"
                                  : "border-[#E5E7EB] text-[#9CA3AF]"
                              }`}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">補足 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <textarea
                      value={inputText}
                      onChange={(e) => { setInputText(e.target.value); setPreview(""); }}
                      placeholder="例：屋根付き、縦列2台目まで可 等"
                      rows={2}
                      className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                    />
                  </div>
                </div>
              )}

              {/* 近隣月極駐車場確認専用: 駐車場名・距離・月額料金・空き状況 */}
              {checkPattern === "nearby_parking" && (
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">駐車場名 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <input
                      type="text"
                      value={nearbyParkingName}
                      onChange={(e) => { setNearbyParkingName(e.target.value); setPreview(""); }}
                      placeholder="例：パーク竹田"
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-teal-400 placeholder:text-[#8696a0]"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">物件からの距離 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <input
                      type="text"
                      value={nearbyParkingDistance}
                      onChange={(e) => { setNearbyParkingDistance(e.target.value); setPreview(""); }}
                      placeholder="例：徒歩3分"
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-teal-400 placeholder:text-[#8696a0]"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">月額料金 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <input
                      type="text"
                      value={nearbyParkingFee}
                      onChange={(e) => { setNearbyParkingFee(e.target.value); setPreview(""); }}
                      placeholder="例：月8,000円"
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-teal-400 placeholder:text-[#8696a0]"
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#54656f]">空き状況 <span className="text-red-400">*</span></p>
                    <div className="flex gap-1.5">
                      {(["空きあり", "空きなし", "要確認"] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => { setNearbyParkingVacancy(v); setPreview(""); }}
                          className={`flex-1 rounded-xl border-2 py-2.5 text-xs font-bold transition ${
                            nearbyParkingVacancy === v
                              ? "border-teal-400 bg-teal-50 text-teal-700"
                              : "border-[#e9edef] bg-[#f8f9fa] text-[#9CA3AF]"
                          }`}
                        >
                          {v === "空きあり" ? "🚗 空きあり" : v}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">補足 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <textarea
                      value={inputText}
                      onChange={(e) => { setInputText(e.target.value); setPreview(""); }}
                      placeholder="例：屋根なし、砂利敷き、2台目相談可 等"
                      rows={2}
                      className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                    />
                  </div>
                </div>
              )}

              {/* ペット飼育確認専用: 可否・条件 */}
              {checkPattern === "mgmt_pet" && (
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="mb-2 text-xs font-bold text-[#54656f]">ペット飼育の可否 <span className="text-red-400">*</span></p>
                    <div className="flex gap-1.5">
                      {(["可", "不可", "相談可"] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => { setMgmtPetPolicy(v); setPreview(""); }}
                          className={`flex-1 rounded-xl border-2 py-2.5 text-xs font-bold transition ${
                            mgmtPetPolicy === v
                              ? "border-teal-400 bg-teal-50 text-teal-700"
                              : "border-[#e9edef] bg-[#f8f9fa] text-[#9CA3AF]"
                          }`}
                        >
                          {v === "可" ? "🐾 可" : v}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">条件 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <input
                      type="text"
                      value={mgmtPetCondition}
                      onChange={(e) => { setMgmtPetCondition(e.target.value); setPreview(""); }}
                      placeholder="例：小型犬のみ・敷金1ヶ月追加 等"
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-teal-400 placeholder:text-[#8696a0]"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">補足 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <textarea
                      value={inputText}
                      onChange={(e) => { setInputText(e.target.value); setPreview(""); }}
                      placeholder="例：2匹目は要相談、猫は不可 等"
                      rows={2}
                      className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                    />
                  </div>
                </div>
              )}

              {/* テキスト入力（初期費用は見積書以外で表示、保証会社確認・駐車場・ペット・他パターンは条件付き表示） */}
              {((checkPattern !== "mgmt_initial_cost" && checkPattern !== "mgmt_guarantor" && checkPattern !== "mgmt_parking" && checkPattern !== "mgmt_pet" && checkPattern !== "nearby_parking") || mgmtCostType === "negotiation") && (
                <div>
                  <p className="mb-1 text-xs font-bold text-[#54656f]">
                    {(checkPattern === "vacate_date" || checkPattern === "mgmt_move_in") ? "または直接入力・補足" : "確認した内容"}
                    {checkPattern === "mgmt_initial_cost" && <span className="text-red-400 ml-1">*</span>}
                  </p>
                  <textarea
                    value={inputText}
                    onChange={(e) => { setInputText(e.target.value); setPreview(""); }}
                    placeholder={
                      checkPattern === "vacate_date" ? "例：退去予定日：7月31日退去確定"
                      : checkPattern === "mgmt_move_in" ? "例：入居可能日：8月上旬〜"
                      : "例：礼金なし交渉成功、または礼金交渉できなかった等"
                    }
                    rows={2}
                    className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                  />
                  <p className="mt-1 text-[10px] text-[#8696a0]">
                    {checkPattern === "vacate_date"
                      ? "退去日を選ぶとAIが内覧可能時期も自動で計算します"
                      : checkPattern === "mgmt_move_in"
                      ? "「即入居可」「7月上旬〜」など管理会社から聞いた内容を入力"
                      : "交渉の結果を入力してください（例：礼金1→0に交渉成功）"}
                  </p>
                </div>
              )}

              {/* 物件資料アップロード（保証会社確認以外の mgmt パターン共通・任意） */}
              {checkPattern !== "mgmt_guarantor" && (
                <div className="mt-1">
                  <p className="mb-1 text-xs font-bold text-[#54656f]">{checkPattern === "nearby_parking" ? "駐車場資料（任意）" : "物件資料（任意）"}</p>
                  <input
                    type="file"
                    accept="image/*"
                    ref={mgmtDocInputRef}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setMgmtDocImage(f);
                      const reader = new FileReader();
                      reader.onload = (ev) => setMgmtDocPreview(ev.target?.result as string);
                      reader.readAsDataURL(f);
                      setPreview("");
                    }}
                  />
                  {mgmtDocPreview ? (
                    <div className="relative inline-block">
                      <img src={mgmtDocPreview} className="h-24 w-auto rounded-xl object-cover border border-[#d1d7db]" />
                      <button
                        onClick={() => { setMgmtDocImage(null); setMgmtDocPreview(""); setPreview(""); }}
                        className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white"
                      >×</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => mgmtDocInputRef.current?.click()}
                      className="flex items-center gap-1.5 rounded-xl bg-[#f0f2f5] px-3 py-2 text-xs text-[#54656f]"
                    >
                      <span>＋ 画像を選択</span>
                    </button>
                  )}
                </div>
              )}

              {/* 保証会社確認専用: テキスト入力 + タイプ選択 + 任意添付 + 任意誘導 */}
              {checkPattern === "mgmt_guarantor" && (
                <div className="flex flex-col gap-3 mt-1">
                  {/* テキスト入力欄 */}
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      placeholder="物件名（例: レジュールアッシュ梅田AXIA）"
                      value={mgmtGuarantorPropertyName}
                      onChange={e => { setMgmtGuarantorPropertyName(e.target.value); setPreview(""); }}
                      className="w-full rounded-xl border border-[#E5E7EB] bg-white px-3 py-2.5 text-sm placeholder-[#9CA3AF] outline-none focus:border-[#546E7A]"
                    />
                    <input
                      type="text"
                      placeholder="保証会社名（例: 株式会社日本トラストコーポレーション）"
                      value={mgmtGuarantorCompanyName}
                      onChange={e => { setMgmtGuarantorCompanyName(e.target.value); setPreview(""); }}
                      className="w-full rounded-xl border border-[#E5E7EB] bg-white px-3 py-2.5 text-sm placeholder-[#9CA3AF] outline-none focus:border-[#546E7A]"
                    />
                    {/* 保証会社の種類 */}
                    <div className="flex gap-1.5">
                      {(["独立系", "LICC系", "信販系", "不明"] as const).map(t => (
                        <button
                          key={t}
                          onClick={() => { setMgmtGuarantorType(prev => prev === t ? "" : t); setPreview(""); }}
                          className={`flex-1 rounded-xl border py-2 text-[11px] font-semibold transition ${
                            mgmtGuarantorType === t
                              ? t === "独立系" ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                : t === "LICC系" ? "border-blue-400 bg-blue-50 text-blue-700"
                                : t === "信販系" ? "border-red-400 bg-red-50 text-red-700"
                                : "border-[#546E7A] bg-[#ECEFF1] text-[#546E7A]"
                              : "border-[#E5E7EB] text-[#9CA3AF]"
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 物件資料アップロード（任意・読み取りで自動入力） */}
                  <div>
                    <p className="mb-1 text-[10px] text-[#8696a0]">📎 物件資料（任意・読み取りで自動入力）</p>
                    <input
                      type="file"
                      accept="image/*"
                      ref={mgmtDocInputRef}
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        setMgmtDocImage(f);
                        const reader = new FileReader();
                        reader.onload = ev => setMgmtDocPreview(ev.target?.result as string);
                        reader.readAsDataURL(f);
                        setPreview("");
                      }}
                    />
                    {mgmtDocPreview ? (
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <img src={mgmtDocPreview} className="h-16 w-auto rounded-xl object-cover border" />
                          <button
                            onClick={() => { setMgmtDocImage(null); setMgmtDocPreview(""); setPreview(""); }}
                            className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white"
                          >×</button>
                        </div>
                        {/* 読み取りボタン */}
                        <button
                          onClick={async () => {
                            if (!mgmtDocImage || mgmtDocOcrLoading) return;
                            setMgmtDocOcrLoading(true);
                            try {
                              const fd = new FormData();
                              fd.append("file", mgmtDocImage);
                              const res = await fetch("/api/extract-guarantor-info", { method: "POST", body: fd });
                              if (!res.ok) throw new Error(`HTTP ${res.status}`);
                              const ocrData = await res.json() as { ok?: boolean; property_name?: string; company_name?: string; guarantor_type?: string; error?: string };
                              if (!ocrData.ok) throw new Error(ocrData.error ?? "読み取り失敗");
                              if (ocrData.property_name) setMgmtGuarantorPropertyName(ocrData.property_name);
                              if (ocrData.company_name) setMgmtGuarantorCompanyName(ocrData.company_name);
                              if (ocrData.guarantor_type && (["独立系","LICC系","信販系","不明"] as string[]).includes(ocrData.guarantor_type)) {
                                setMgmtGuarantorType(ocrData.guarantor_type as "独立系" | "LICC系" | "信販系" | "不明");
                              }
                            } catch (err) {
                              console.error("[AixModal] OCR error:", err);
                              alert("読み取りに失敗しました。手動で入力してください。");
                            } finally { setMgmtDocOcrLoading(false); }
                          }}
                          disabled={mgmtDocOcrLoading}
                          className="flex items-center gap-1 rounded-xl bg-[#546E7A] px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                        >
                          {mgmtDocOcrLoading ? "読み取り中..." : "🔍 読み取る"}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => mgmtDocInputRef.current?.click()}
                        className="flex items-center gap-1.5 rounded-xl bg-[#f0f2f5] px-3 py-2 text-xs text-[#54656f]"
                      >
                        ＋ 物件資料を添付
                      </button>
                    )}
                  </div>

                  {/* 誘導方向（任意） */}
                  <div>
                    <p className="mb-1 text-[10px] text-[#8696a0]">誘導方向（任意・選択しない場合は報告のみ）</p>
                    <div className="flex gap-2">
                      {(["apply", "viewing"] as const).map(t => (
                        <button
                          key={t}
                          onClick={() => { setMgmtGuarantorPushType(prev => prev === t ? null : t); setPreview(""); }}
                          className={`flex-1 rounded-xl border py-2.5 text-xs font-semibold transition ${
                            mgmtGuarantorPushType === t
                              ? "border-[#546E7A] bg-[#ECEFF1] text-[#37474F]"
                              : "border-[#E5E7EB] text-[#9CA3AF]"
                          }`}
                        >
                          {t === "apply" ? "📝 申込誘導" : "🏠 内覧誘導"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : actionType === "property_check_result" ? (
            /* 物件確認した: パターン選択 + 任意画像 */
            <div className="mb-4 flex flex-col gap-3">
              <div>
                <p className="mb-2 text-xs font-bold text-[#54656f]">確認結果を選択</p>
                <div className="flex flex-col gap-2">
                  {([
                    { key: "available",       label: "物件あった",           sub: "入居可能",                       color: "emerald" },
                    { key: "alternative",     label: "別の部屋が募集してた", sub: "満室だが代替あり",               color: "blue"    },
                    { key: "unavailable",     label: "物件なかった",         sub: "満室・空きなし（画像不要）",     color: "orange"  },
                    { key: "exclusive",       label: "専任物件だった",       sub: "専任のためご紹介不可",           color: "red"     },
                    { key: "move_in_date",    label: "入居日確認した",       sub: "退去日から入居可能日を計算送信", color: "purple"  },
                    { key: "interior_photo",  label: "室内写真を確認した",   sub: "写真またはURLをお客さんに送る",  color: "pink"    },
                  ] as const).map((p) => (
                    <button
                      key={p.key}
                      onClick={() => {
                        setCheckPattern(p.key);
                        setPreview("");
                        setCheckAvailableApp(null);
                        setShowCheckCalendar(false);
                        if (p.key !== "exclusive") {
                          setExclusiveImageFile(null);
                          setExclusivePropName("");
                          setExclusiveRoomNo("");
                        }
                      }}
                      className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                        checkPattern === p.key
                          ? p.color === "emerald" ? "border-emerald-400 bg-emerald-50"
                          : p.color === "blue"    ? "border-blue-400 bg-blue-50"
                          : p.color === "purple"  ? "border-purple-400 bg-purple-50"
                          : p.color === "pink"    ? "border-pink-400 bg-pink-50"
                          : p.color === "red"     ? "border-red-400 bg-red-50"
                          :                         "border-orange-400 bg-orange-50"
                          : "border-[#e9edef] bg-[#f8f9fa]"
                      }`}
                    >
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 flex-shrink-0 ${
                        checkPattern === p.key
                          ? p.color === "emerald" ? "border-emerald-500 bg-emerald-500"
                          : p.color === "blue"    ? "border-blue-500 bg-blue-500"
                          : p.color === "purple"  ? "border-purple-500 bg-purple-500"
                          : p.color === "pink"    ? "border-pink-500 bg-pink-500"
                          : p.color === "red"     ? "border-red-500 bg-red-500"
                          :                         "border-orange-500 bg-orange-500"
                          : "border-[#d1d7db]"
                      }`}>
                        {checkPattern === p.key && <span className="h-2 w-2 rounded-full bg-white" />}
                      </span>
                      <div>
                        <div className="text-[13px] font-bold text-[#111b21]">{p.label}</div>
                        <div className="text-[10px] text-[#8696a0]">{p.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {/* 専任物件だった: スクショOCR + 物件名・号室 → 固定文送信（AI不要） */}
              {checkPattern === "exclusive" && (
                <div className="flex flex-col gap-3">
                  {/* 画像アップロード（OCR用・お客さんには送らない） */}
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">
                      物件スクショ <span className="font-normal text-[#90a4ae]">（任意・AIが物件名を読み取ります）</span>
                    </p>
                    <p className="mb-2 text-[10px] text-[#8696a0]">※ 画像はお客さんには送られません</p>
                    <button
                      onClick={() => { const el = document.getElementById("exclusive-image-input"); if (el) (el as HTMLInputElement).click(); }}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-red-200 py-5 text-sm font-semibold text-red-500 hover:bg-red-50"
                    >📷 物件スクショを選択</button>
                    <input
                      id="exclusive-image-input"
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setExclusiveImageFile(file);
                        setPreview("");
                        // Opus 4.8 OCRで物件名・号室を自動入力
                        setExclusiveOcrLoading(true);
                        try {
                          const base64 = await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve((reader.result as string).split(",")[1]);
                            reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
                            reader.readAsDataURL(file);
                          });
                          const res = await fetch("/api/aix/ocr-property", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ image_base64: base64, media_type: file.type }),
                          });
                          const data = await res.json();
                          if (data.prop_name) setExclusivePropName(data.prop_name);
                          if (data.room_no) setExclusiveRoomNo(data.room_no);
                        } catch {}
                        setExclusiveOcrLoading(false);
                      }}
                      className="hidden"
                    />
                    {exclusiveOcrLoading && (
                      <p className="mt-1 text-[11px] text-blue-500">物件名を読み取り中...</p>
                    )}
                    {exclusiveImageFile && !exclusiveOcrLoading && (
                      <p className="mt-1 text-[11px] text-green-600">✓ {exclusiveImageFile.name}</p>
                    )}
                  </div>
                  {/* 物件名（必須） */}
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">物件名 <span className="text-red-500">*</span></p>
                    <input
                      type="text"
                      value={exclusivePropName}
                      onChange={(e) => { setExclusivePropName(e.target.value); setPreview(""); }}
                      placeholder="例: GRAMM竹田"
                      className="w-full rounded-xl border border-[#d1d7db] px-4 py-3 text-[14px] outline-none focus:border-red-400"
                    />
                  </div>
                  {/* 号室（任意） */}
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">号室 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                    <input
                      type="text"
                      value={exclusiveRoomNo}
                      onChange={(e) => { setExclusiveRoomNo(e.target.value); setPreview(""); }}
                      placeholder="例: 101号室"
                      className="w-full rounded-xl border border-[#d1d7db] px-4 py-3 text-[14px] outline-none focus:border-red-400"
                    />
                  </div>
                  {exclusivePropName.trim() && (
                    <p className="text-[11px] text-[#8696a0]">
                      送信文: 「お送りいただきました{exclusivePropName.trim()}{exclusiveRoomNo.trim()}は専任のお部屋となっており...」
                    </p>
                  )}
                </div>
              )}

              {/* 室内写真を確認した: URLまたは写真 */}
              {checkPattern === "interior_photo" && (
                <div className="flex flex-col gap-3">
                  {/* URL入力 */}
                  <div>
                    <p className="mb-1 text-xs font-bold text-[#54656f]">室内イメージURL</p>
                    <input
                      type="url"
                      value={interiorPhotoUrl}
                      onChange={(e) => {
                        setInteriorPhotoUrl(e.target.value);
                        setInteriorPhotoFile(null);
                        setInteriorPhotoPreview("");
                        setPreview("");
                      }}
                      placeholder="https://suumo.jp/..."
                      className={`w-full rounded-xl border px-4 py-3 text-[14px] outline-none transition-colors ${interiorPhotoUrl ? "border-pink-400 bg-pink-50 text-pink-700 focus:border-pink-500" : "border-[#d1d7db] bg-white text-[#111b21] focus:border-[#2196F3]"}`}
                    />
                    {interiorPhotoUrl.trim() && (
                      <p className="mt-1 text-[11px] text-pink-600">
                        送信文: 「（室内イメージ）<br />{interiorPhotoUrl.trim()}」
                      </p>
                    )}
                  </div>

                  {/* 区切り */}
                  {!interiorPhotoUrl.trim() && (
                    <>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 border-t border-[#e9edef]" />
                        <span className="text-[11px] text-[#8696a0]">または</span>
                        <div className="flex-1 border-t border-[#e9edef]" />
                      </div>

                      {/* 写真アップロード */}
                      <div>
                        <p className="mb-1 text-xs font-bold text-[#54656f]">室内写真</p>
                        {interiorPhotoPreview ? (
                          <div className="relative overflow-hidden rounded-2xl border border-[#d1d7db]">
                            <img src={interiorPhotoPreview} alt="室内写真" className="max-h-44 w-full object-contain" />
                            <button
                              onClick={() => { setInteriorPhotoFile(null); setInteriorPhotoPreview(""); setPreview(""); }}
                              className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                            >変更</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { const el = document.getElementById("interior-photo-input"); if (el) (el as HTMLInputElement).click(); }}
                            className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-pink-200 py-5 text-sm font-semibold text-pink-500 hover:bg-pink-50"
                          >📷 室内写真を選択</button>
                        )}
                        <input
                          id="interior-photo-input"
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            setInteriorPhotoFile(f);
                            setInteriorPhotoUrl("");
                            const reader = new FileReader();
                            reader.onload = () => setInteriorPhotoPreview(String(reader.result ?? ""));
                            reader.readAsDataURL(f);
                          }}
                          className="hidden"
                        />
                      </div>

                      {/* 物件名入力（写真の場合のみ） */}
                      {interiorPhotoFile && (
                        <div>
                          <p className="mb-1 text-xs font-bold text-[#54656f]">物件名 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                          <input
                            type="text"
                            value={interiorPropertyName}
                            onChange={(e) => { setInteriorPropertyName(e.target.value); setPreview(""); }}
                            placeholder="例: ヴィーナス今里"
                            className="w-full rounded-xl border border-[#d1d7db] px-4 py-3 text-[14px] outline-none focus:border-[#2196F3]"
                          />
                          <p className="mt-1 text-[11px] text-[#8696a0]">
                            送信文: 「こちら{interiorPropertyName || "●●"}の室内写真となります😌！！」
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* 入居日確認した: 物件資料画像（テキストのみ送信・画像はAI読み込み用） */}
              {checkPattern === "move_in_date" && (
                <div>
                  <p className="mb-1 text-xs font-bold text-[#54656f]">
                    物件資料 <span className="font-normal text-[#90a4ae]">（AIが退去日・入居可能日を読み取ります）</span>
                  </p>
                  <p className="mb-2 text-[10px] text-[#8696a0]">※ 画像はお客さんには送られません</p>
                  {moveInImagePreview ? (
                    <div className="relative overflow-hidden rounded-2xl border border-[#d1d7db]">
                      <img src={moveInImagePreview} alt="物件資料" className="max-h-44 w-full object-contain" />
                      <button
                        onClick={() => { setMoveInImageFile(null); setMoveInImagePreview(""); setPreview(""); if (moveInImageInputRef.current) moveInImageInputRef.current.value = ""; }}
                        className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                      >変更</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => moveInImageInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-purple-200 py-5 text-sm font-semibold text-purple-500 hover:bg-purple-50"
                    >🏠 物件資料を選択</button>
                  )}
                  <input
                    ref={moveInImageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setMoveInImageFile(f);
                      const reader = new FileReader();
                      reader.onload = () => setMoveInImagePreview(String(reader.result ?? ""));
                      reader.readAsDataURL(f);
                    }}
                    className="hidden"
                  />
                </div>
              )}

              {/* 物件あった: 件数セレクター */}
              {checkPattern === "available" && (
                <div className="mb-1">
                  <p className="mb-1.5 text-xs font-bold text-[#54656f]">確認できた物件数</p>
                  <div className="flex gap-2">
                    {([1, 2, 3] as const).map((n) => (
                      <button
                        key={n}
                        onClick={() => setCheckPropertyCount(n)}
                        className={`flex-1 rounded-xl border py-2 text-sm font-bold transition ${checkPropertyCount === n ? "border-[#4CAF50] bg-[#e8f5e9] text-[#2e7d32]" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                      >{n}件</button>
                    ))}
                  </div>
                </div>
              )}

              {/* 物件あった: 申込状況 */}
              {checkPattern === "available" && (
                <div className="mb-1">
                  <p className="mb-1.5 text-xs font-bold text-[#54656f]">申込状況 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCheckAvailableApp(checkAvailableApp === "yes" ? null : "yes")}
                      className={`flex-1 rounded-xl border py-2 text-sm font-bold transition ${checkAvailableApp === "yes" ? "border-red-400 bg-red-50 text-red-600" : "border-[#d1d7db] bg-white text-red-400"}`}
                    >申込あり</button>
                    <button
                      onClick={() => setCheckAvailableApp(checkAvailableApp === "no" ? null : "no")}
                      className={`flex-1 rounded-xl border py-2 text-sm font-bold transition ${checkAvailableApp === "no" ? "border-blue-400 bg-blue-50 text-blue-600" : "border-[#d1d7db] bg-white text-blue-400"}`}
                    >申込なし</button>
                  </div>
                </div>
              )}

              {/* 別の部屋が募集してた: 階数・号室・間取り */}
              {checkPattern === "alternative" && (
                <div className="flex flex-col gap-3">
                  {/* 募集終了だったお部屋 */}
                  <div>
                    <p className="mb-1.5 text-xs font-bold text-[#54656f]">募集終了だったお部屋</p>
                    <div className="flex items-center gap-2">
                      <select
                        value={checkEndedFloor ?? ""}
                        onChange={(e) => setCheckEndedFloor(e.target.value === "" ? null : parseInt(e.target.value))}
                        className="rounded-xl border border-[#d1d7db] px-3 py-2 text-sm font-bold text-[#111b21] outline-none focus:border-[#2196F3] bg-white"
                      >
                        <option value="">階数（任意）</option>
                        {Array.from({ length: 15 }, (_, i) => i + 1).map((f) => (
                          <option key={f} value={f}>{f}階</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={checkEndedUnit}
                        onChange={(e) => setCheckEndedUnit(e.target.value)}
                        placeholder="号室（任意）"
                        className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-sm outline-none focus:border-[#2196F3] placeholder:text-[#90a4ae]"
                      />
                    </div>
                  </div>
                  {/* 間取り選択 */}
                  <div>
                    <p className="mb-1.5 text-xs font-bold text-[#54656f]">代替お部屋の間取り <span className={floorPlanTouched && !checkFloorPlan ? "text-red-500" : "text-[#90a4ae]"}>*必須</span></p>
                    <div className="flex gap-2">
                      {([{ key: "same", label: "同じ間取り" }, { key: "different", label: "違う間取り" }] as const).map((opt) => (
                        <button
                          key={opt.key}
                          onClick={() => { setCheckFloorPlan(opt.key); setFloorPlanTouched(false); }}
                          className={`flex-1 rounded-xl border py-2 text-sm font-bold transition ${checkFloorPlan === opt.key ? "border-[#1565C0] bg-[#e3f0ff] text-[#1565C0]" : (floorPlanTouched && checkFloorPlan === null) ? "border-[#e53935] bg-[#fff5f5] text-[#54656f]" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                        >{opt.label}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* 物件あった: 全件数で物件カード（1件含む） */}
              {checkPattern === "available" ? (
                <div className="flex flex-col gap-3">
                  {Array.from({ length: checkPropertyCount }, (_, pi) => (
                    <div key={pi} className={`rounded-2xl border p-3 ${checkRecommendProp === pi ? "border-[#FFB300] bg-[#fffde7]" : "border-[#d1d7db] bg-[#f8f9fa]"}`}>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-bold text-[#54656f]">{checkPropertyCount > 1 ? `物件${"①②③"[pi]}` : "物件情報"}</p>
                        {checkPropertyCount > 1 && (
                          <button
                            onClick={() => setCheckRecommendProp(checkRecommendProp === pi ? null : pi)}
                            className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition ${checkRecommendProp === pi ? "bg-[#FFB300] text-white" : "border border-[#d1d7db] bg-white text-[#90a4ae]"}`}
                          >
                            {checkRecommendProp === pi ? "⭐ オススメ中" : "☆ オススメ"}
                          </button>
                        )}
                      </div>
                      {/* 物件名 */}
                      <input
                        type="text"
                        placeholder="マンション名・号室（例: KTIレジデンス西中島II 202号室）"
                        value={checkPropNames[pi]}
                        onChange={(e) => {
                          const arr = [...checkPropNames];
                          arr[pi] = e.target.value;
                          setCheckPropNames(arr);
                        }}
                        className="mb-2 w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-xs outline-none focus:border-[#4CAF50]"
                      />
                      {/* 募集状況 */}
                      <div className="mb-2 flex gap-1">
                        {([
                          { k: "available", l: "空室" },
                          { k: "vacating", l: "退去予定" },
                          { k: "unavailable", l: "申込あり" },
                          { k: "alternative", l: "別の部屋" },
                        ] as const).map(s => (
                          <button key={s.k}
                            onClick={() => { const arr = [...checkPropStatuses]; arr[pi] = s.k; setCheckPropStatuses(arr); }}
                            className={`flex-1 rounded-xl py-1.5 text-[10px] font-bold border transition ${
                              checkPropStatuses[pi] === s.k
                                ? s.k === "available" ? "border-[#4CAF50] bg-[#e8f5e9] text-[#2e7d32]"
                                : s.k === "vacating" ? "border-[#FF9800] bg-[#fff8e1] text-[#e65100]"
                                : s.k === "unavailable" ? "border-[#e53935] bg-[#fff5f5] text-[#e53935]"
                                : "border-[#2196F3] bg-[#e3f0ff] text-[#1565C0]"
                                : "border-[#d1d7db] bg-white text-[#54656f]"
                            }`}
                          >{s.l}</button>
                        ))}
                      </div>
                      {/* 退去予定日: 退去予定ステータスの場合のみ */}
                      {checkPropStatuses[pi] === "vacating" && (
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[10px] text-[#90a4ae] shrink-0">退去予定日（任意）:</span>
                        <input
                          type="text"
                          placeholder="送信時に自動読み取り / 例: 7月下旬"
                          value={checkPropVacancyDates[pi]}
                          onChange={(e) => {
                            const arr = [...checkPropVacancyDates];
                            arr[pi] = e.target.value;
                            setCheckPropVacancyDates(arr);
                          }}
                          className="flex-1 rounded-xl border border-[#d1d7db] bg-white px-3 py-1.5 text-xs outline-none focus:border-[#4CAF50]"
                        />
                      </div>
                      )}
                      {/* 物件画像 */}
                      {checkPropImagePreviews[pi].length > 0 && (
                        <div className="mb-2 grid grid-cols-3 gap-2">
                          {checkPropImagePreviews[pi].map((src, j) => (
                            <div key={j} className="relative aspect-square overflow-hidden rounded-xl border border-[#d1d7db]">
                              <img src={src} alt={`物件${pi+1}-${j+1}`} className="h-full w-full object-cover" />
                              <button onClick={() => removePropImage(pi, j)} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] text-white">✕</button>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => checkPropFileRefs[pi].current?.click()}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#d1d7db] py-2 text-xs font-semibold text-[#90a4ae] hover:bg-white mb-2"
                      >📎 {checkPropImagePreviews[pi].length > 0 ? `資料追加（${checkPropImagePreviews[pi].length}枚）` : "資料画像を追加（スキップ可）"}</button>
                      <input ref={checkPropFileRefs[pi]} type="file" accept="image/*" multiple onChange={(e) => onSelectPropImages(pi, e)} className="hidden" />
                      {/* 見積書 */}
                      {checkPropEstimatePreviews[pi] ? (
                        <div className="relative overflow-hidden rounded-xl border border-[#d1d7db]">
                          <img src={checkPropEstimatePreviews[pi]} alt="見積書" className="max-h-28 w-full object-contain" />
                          <button onClick={() => removePropEstimate(pi)} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] text-white">✕</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => checkPropEstRefs[pi].current?.click()}
                          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#b3d0f7] py-2 text-xs font-semibold text-[#2196F3] hover:bg-blue-50"
                        >📎 見積書を追加（スキップ可）</button>
                      )}
                      <input ref={checkPropEstRefs[pi]} type="file" accept="image/*" onChange={(e) => onSelectPropEstimate(pi, e)} className="hidden" />
                    </div>
                  ))}
                </div>
              ) : checkPattern === "alternative" ? (
                // 別の部屋あった: 1件画像UI
                <div>
                  <p className="mb-1 text-xs font-bold text-[#54656f]">
                    物件・部屋の画像 <span className="font-normal text-[#90a4ae]">（複数選択可・任意）</span>
                  </p>
                  {checkImagePreviews.length > 0 && (
                    <div className="mb-2 grid grid-cols-3 gap-2">
                      {checkImagePreviews.map((src, i) => (
                        <div key={i} className="relative overflow-hidden rounded-xl border border-[#d1d7db] aspect-square">
                          <img src={src} alt={`物件${i + 1}`} className="h-full w-full object-cover" />
                          <button
                            onClick={() => removeCheckImage(i)}
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => checkFileInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#d1d7db] py-3 text-sm font-semibold text-[#90a4ae] hover:bg-[#f5f6f7]"
                  >
                    📎 {checkImagePreviews.length > 0 ? `追加する（現在${checkImagePreviews.length}枚）` : "画像を追加する（スキップ可）"}
                  </button>
                  <input ref={checkFileInputRef} type="file" accept="image/*" multiple onChange={onSelectCheckImages} className="hidden" />
                </div>
              ) : null}
              {/* 別の部屋あった: 見積書画像（任意） */}
              {checkPattern === "alternative" && (
                <div>
                  <p className="mb-1 text-xs font-bold text-[#54656f]">
                    見積書の画像 <span className="font-normal text-[#90a4ae]">（任意）</span>
                  </p>
                  {checkEstimatePreview ? (
                    <div className="relative overflow-hidden rounded-xl border border-[#d1d7db] mb-1">
                      <img src={checkEstimatePreview} alt="見積書" className="max-h-36 w-full object-contain" />
                      <button
                        onClick={() => { setCheckEstimateFile(null); setCheckEstimatePreview(""); if (checkEstimateInputRef.current) checkEstimateInputRef.current.value = ""; }}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                      >✕</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => checkEstimateInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#b3d0f7] py-3 text-sm font-semibold text-[#2196F3] hover:bg-blue-50"
                    >
                      📎 見積書を追加する（スキップ可）
                    </button>
                  )}
                  <input
                    ref={checkEstimateInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setCheckEstimateFile(f);
                      const reader = new FileReader();
                      reader.onload = () => setCheckEstimatePreview(String(reader.result ?? ""));
                      reader.readAsDataURL(f);
                    }}
                    className="hidden"
                  />
                </div>
              )}

              {/* 空室あり: 内覧誘導ボタン + カレンダー折りたたみ */}
              {checkPattern === "available" && (
                <div>
                  {/* 内覧誘導 あり/なし */}
                  <div className="flex items-center justify-between rounded-xl border border-[#d1d7db] bg-white px-3 py-2">
                    <span className="text-sm font-bold text-[#54656f]">内覧誘導</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => { setShowCheckCalendar(true); setCheckApplicationInvite(false); }}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${showCheckCalendar ? "bg-[#1565C0] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        あり
                      </button>
                      <button
                        onClick={() => setShowCheckCalendar(false)}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${!showCheckCalendar ? "bg-[#54656f] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        なし
                      </button>
                    </div>
                  </div>
                  {/* 申込誘導 あり/なし */}
                  <div className="mt-2 flex items-center justify-between rounded-xl border border-[#d1d7db] bg-white px-3 py-2">
                    <span className="text-sm font-bold text-[#54656f]">申込誘導</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => { setCheckApplicationInvite(true); setShowCheckCalendar(false); }}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${checkApplicationInvite ? "bg-[#06c755] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        あり
                      </button>
                      <button
                        onClick={() => setCheckApplicationInvite(false)}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${!checkApplicationInvite ? "bg-[#54656f] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        なし
                      </button>
                    </div>
                  </div>
                  {/* 全て募集してた あり/なし */}
                  <div className="mt-2 flex items-center justify-between rounded-xl border border-[#d1d7db] bg-white px-3 py-2">
                    <span className="text-sm font-bold text-[#54656f]">全て募集してた</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setCheckAllAvailable(true)}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${checkAllAvailable ? "bg-[#4CAF50] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        あり
                      </button>
                      <button
                        onClick={() => setCheckAllAvailable(false)}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${!checkAllAvailable ? "bg-[#54656f] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        なし
                      </button>
                    </div>
                  </div>
                  {/* 見積書テキスト同封 あり/なし */}
                  <div className="mt-2 flex items-center justify-between rounded-xl border border-[#d1d7db] bg-white px-3 py-2">
                    <span className="text-sm font-bold text-[#54656f]">見積書テキスト同封</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setCheckIncludeEstimateText(true)}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${checkIncludeEstimateText ? "bg-[#7B1FA2] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        あり
                      </button>
                      <button
                        onClick={() => setCheckIncludeEstimateText(false)}
                        className={`rounded-lg px-4 py-1 text-sm font-bold transition ${!checkIncludeEstimateText ? "bg-[#54656f] text-white" : "border border-[#d1d7db] bg-[#f0f2f5] text-[#54656f]"}`}
                      >
                        なし
                      </button>
                    </div>
                  </div>
                  {showCheckCalendar && (
                    <div className="mt-2 rounded-2xl border border-[#d1d7db] bg-[#f8f9fa] p-3">
                      <p className="mb-2 text-xs font-bold text-[#54656f]">内覧可能日時（自動取得）</p>
                      {checkCalendarLoading ? (
                        <p className="text-xs text-[#8696a0]">カレンダー取得中...</p>
                      ) : checkCalendarDays.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {checkCalendarDays.map((d, i) => (
                            <div key={i} className="text-xs">
                              <span className="font-semibold text-[#111b21]">{d.label}</span>
                              {d.fullyBooked ? (
                                <span className="ml-2 text-red-400">案内不可</span>
                              ) : (
                                <span className="ml-2 text-emerald-600">{d.slots[0]}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-[#8696a0]">取得できませんでした</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : estimateMultiMode ? (
            /* 見積書送る 複数件モード */
            <div className="mb-4">
              <label className="mb-2 block text-xs font-semibold text-[#54656f]">見積書（①〜③枚）</label>
              <div className="flex flex-col gap-2">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="rounded-xl border border-[#e9edef] bg-[#f8f9fa] px-3 py-2">
                    <p className="mb-1.5 text-xs font-bold text-[#54656f]">{"①②③"[idx]} 物件{idx + 1}</p>
                    {estimateMultiPreviews[idx] ? (
                      <div className="relative mb-1 overflow-hidden rounded-xl border border-[#d1d7db]">
                        <img src={estimateMultiPreviews[idx]} alt={`見積書${idx + 1}`} className="max-h-24 w-full object-contain" />
                        <button
                          onClick={() => {
                            setEstimateMultiFiles(prev => prev.filter((_, i) => i !== idx));
                            setEstimateMultiPreviews(prev => prev.filter((_, i) => i !== idx));
                            if (estimateMultiRefs[idx]?.current) estimateMultiRefs[idx].current!.value = "";
                          }}
                          className="absolute right-1 top-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white"
                        >削除</button>
                      </div>
                    ) : estimateMultiFiles.length > idx ? null : (
                      <button
                        onClick={() => estimateMultiRefs[idx]?.current?.click()}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#90a4ae] py-2 text-xs text-[#546e7a]"
                      >📎 見積書を追加{idx > 0 ? "（任意）" : ""}</button>
                    )}
                    <input
                      ref={estimateMultiRefs[idx]}
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const newFiles = [...estimateMultiFiles];
                        newFiles[idx] = f;
                        setEstimateMultiFiles(newFiles.filter(Boolean));
                        const r = new FileReader();
                        r.onload = () => {
                          const newPreviews = [...estimateMultiPreviews];
                          newPreviews[idx] = String(r.result ?? "");
                          setEstimateMultiPreviews(newPreviews);
                        };
                        r.readAsDataURL(f);
                      }}
                      className="hidden"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : config.requiresImage ? (
            /* その他の画像あきアクション */
            <div className="mb-4">
              {/* 見積書送る: 物件資料（任意）ピッカー */}
              {actionType === "estimate_sheet" && (
                <div className="mb-3">
                  <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                    物件資料 <span className="font-normal text-[#90a4ae]">（任意・一緒に送る場合）</span>
                  </label>
                  {estimatePropertyPreview ? (
                    <div className="relative mb-2 overflow-hidden rounded-2xl border border-[#d1d7db]">
                      <img src={estimatePropertyPreview} alt="物件資料" className="max-h-28 w-full object-contain" />
                      <button
                        onClick={() => { setEstimatePropertyFile(null); setEstimatePropertyPreview(""); if (estimatePropertyInputRef.current) estimatePropertyInputRef.current.value = ""; }}
                        className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                      >削除</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => estimatePropertyInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#90a4ae] py-2 text-xs font-semibold text-[#546e7a] hover:bg-gray-50"
                    >📎 物件資料を追加する（スキップ可）</button>
                  )}
                  <input
                    ref={estimatePropertyInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setEstimatePropertyFile(f);
                      const r = new FileReader();
                      r.onload = () => setEstimatePropertyPreview(String(r.result ?? ""));
                      r.readAsDataURL(f);
                    }}
                    className="hidden"
                  />
                </div>
              )}
              <label className="mb-1 block text-xs font-semibold text-[#54656f]">見積書画像</label>
              {imagePreview ? (
                <div className="relative mb-2 overflow-hidden rounded-2xl border border-[#d1d7db]">
                  <img src={imagePreview} alt="選択画像" className="max-h-48 w-full object-contain" />
                  <button
                    onClick={() => { setImageFile(null); setImagePreview(""); setPreview(""); setParsedEstimate(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                  >変更</button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-200 py-6 text-sm font-semibold text-[#2196F3] hover:bg-blue-50"
                >📷 {config.imageLabel}</button>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" onChange={onSelectImage} className="hidden" />
            </div>
          ) : null}

          {/* 追客: サブモード専用UI */}
          {actionType === "followup_revive" && followupSubMode === "apply_supplement" && (
            <div className="mb-3 rounded-xl border border-orange-200 bg-orange-50 p-3">
              <p className="mb-1 text-xs font-bold text-orange-700">📋 申込補足情報 催促モード</p>
              <p className="mb-2 text-[11px] text-orange-600 leading-relaxed">
                不足している書類・情報を確認してからAI生成してください。<br/>
                追記メモに「まだ頂けていない書類」を入力すると精度が上がります。
              </p>
            </div>
          )}
          {actionType === "followup_revive" && followupSubMode === "search_continue" && (
            <div className="mb-3">
              <div className="mb-2 rounded-xl border border-green-200 bg-green-50 p-3">
                <p className="mb-1 text-xs font-bold text-green-700">🏠 物件探し継続確認モード</p>
                <p className="text-[11px] text-green-600">新着物件をアナウンスして継続を確認するメッセージを生成します</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">新しい物件名<span className="ml-1 font-normal text-[#90a4ae]">（任意）</span></label>
                <input
                  value={followupPropertyName}
                  onChange={(e) => setFollowupPropertyName(e.target.value)}
                  placeholder="例：グランドコート渋谷 301号室"
                  className="w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-sm outline-none focus:border-green-400"
                />
              </div>
            </div>
          )}

          {/* 内覧へ！: 退去予定物件 / 内覧日指定ありトグル */}
          {actionType === "viewing_invite" && (
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setViewingIsVacancy(v => !v)}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${viewingIsVacancy ? "bg-orange-500 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}
                >
                  🏚️ 退去予定物件
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewingSpecificMode(prev => {
                      const next = !prev;
                      setViewingSpecificStart("");
                      setViewingSpecificEnd("");
                      if (next) {
                        // 内覧日指定あり ON: 会話から複数日を抽出してカレンダーに反映
                        const allText = (recentMessages || [])
                          .filter(m => m.sender === "customer" && m.text)
                          .map(m => m.text)
                          .join(" ");
                        const extracted = extractMultipleDates(allText);
                        if (extracted.length > 0) {
                          setViewingSpecificDate(extracted.join("・"));
                          // 抽出した日付に一致する日のみチェック（本日は指定がなければチェックしない）
                          setViewingSlotEnabled(slotsMatchingDates(viewingCalendarDays, extracted));
                        } else {
                          setViewingSpecificDate("");
                          // 抽出できない場合は本日以外をチェック
                          setViewingSlotEnabled(viewingCalendarDays.map((d, i) => i > 0 && !d.fullyBooked));
                        }
                      } else {
                        // OFF: 通常モードに戻す
                        setViewingSpecificDate("");
                        setViewingSlotEnabled(viewingCalendarDays.map(d => !d.fullyBooked));
                      }
                      return next;
                    });
                  }}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${viewingSpecificMode ? "bg-blue-500 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}
                >
                  📅 内覧日指定あり
                </button>
              </div>

              {viewingSpecificMode && (
                <div className="mt-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <p className="mb-2 text-xs font-bold text-blue-700">お客様が希望した日付で「はい！！◯日ですと〜」を生成します</p>
                  <div className="mb-2">
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">日程 <span className="text-red-400">*</span></label>
                    <input
                      value={viewingSpecificDate}
                      onChange={(e) => setViewingSpecificDate(e.target.value)}
                      placeholder="例：7月5日"
                      className="w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-semibold text-[#54656f]">開始時間</label>
                      <input
                        value={viewingSpecificStart}
                        onChange={(e) => setViewingSpecificStart(e.target.value)}
                        placeholder="13:00"
                        className="w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                      />
                    </div>
                    <span className="mt-4 text-sm text-[#54656f]">〜</span>
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-semibold text-[#54656f]">終了時間</label>
                      <input
                        value={viewingSpecificEnd}
                        onChange={(e) => setViewingSpecificEnd(e.target.value)}
                        placeholder="14:00"
                        className="w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                      />
                    </div>
                  </div>
                </div>
              )}

              {viewingIsVacancy && (
                <div className="mt-2 rounded-xl border border-orange-200 bg-orange-50 p-3">
                  {/* 物件資料OCR（任意） */}
                  <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                    物件資料<span className="ml-1 font-normal text-[#90a4ae]">（画像から物件名を自動取得・任意）</span>
                  </label>
                  {viewingVacancyPreview ? (
                    <div className="relative mb-2 overflow-hidden rounded-xl border border-orange-200">
                      <img src={viewingVacancyPreview} alt="物件資料" className="max-h-24 w-full object-contain" />
                      <button
                        onClick={() => { setViewingVacancyFile(null); setViewingVacancyPreview(""); setViewingVacancyName(""); }}
                        className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white"
                      >変更</button>
                      {viewingVacancyOcrLoading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-bold text-orange-600">
                          <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
                          読み取り中...
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => viewingVacancyInputRef.current?.click()}
                      className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-orange-300 bg-white py-3 text-xs font-bold text-orange-500"
                    >📸 物件資料を読み込む（スキップ可）</button>
                  )}
                  <input
                    ref={viewingVacancyInputRef}
                    type="file" accept="image/*" className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setViewingVacancyFile(f);
                      const reader = new FileReader();
                      reader.onload = async () => {
                        const dataUrl = String(reader.result ?? "");
                        setViewingVacancyPreview(dataUrl);
                        setViewingVacancyOcrLoading(true);
                        try {
                          const base64 = dataUrl.split(",")[1];
                          const mime = (dataUrl.split(";")[0].split(":")[1] || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
                          const res = await fetch("/api/extract-meeting-place", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ image_base64: base64, media_type: mime }),
                          });
                          await ensureOk(res);
                          const data = await res.json() as { ok: boolean; name?: string };
                          if (data.ok && data.name) setViewingVacancyName(data.name);
                        } catch (e) { console.error("[AixModal] 物件資料OCR失敗:", e); } finally { setViewingVacancyOcrLoading(false); }
                      };
                      reader.readAsDataURL(f);
                    }}
                  />

                  {/* 物件名 */}
                  <div className="mb-2">
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">物件名 <span className="text-red-400">*</span></label>
                    <input
                      value={viewingVacancyName}
                      onChange={(e) => setViewingVacancyName(e.target.value)}
                      placeholder="例：エムズ新大阪"
                      className="w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                    />
                  </div>

                  {/* 退去予定日 */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">退去予定日 <span className="text-red-400">*</span></label>
                    <input
                      value={viewingVacancyMoveOut}
                      onChange={(e) => setViewingVacancyMoveOut(e.target.value)}
                      placeholder="例：7月31日"
                      className="w-full rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 内覧へ！: カレンダースロット選択 */}
          {actionType === "viewing_invite" && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-bold text-[#54656f]">内覧可能日時（カレンダーから自動取得）</p>
              {viewingCalendarLoading ? (
                <div className="flex items-center gap-2 rounded-xl bg-[#f0f2f5] px-3 py-2.5 text-sm text-[#8696a0]">
                  <span className="inline-block animate-spin">⏳</span>
                  <span>カレンダー読み込み中...</span>
                </div>
              ) : viewingCalendarDays.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {viewingCalendarDays.map((d, i) => (
                    <div key={i} className={`rounded-xl px-3 py-2.5 transition-all ${
                      d.fullyBooked
                        ? viewingSlotOverride[i] ? "bg-emerald-50 border border-emerald-200" : "bg-red-50"
                        : viewingSlotEnabled[i] ? "bg-emerald-50 border border-emerald-200" : "bg-[#f0f2f5]"
                    }`}>
                      <div className="flex items-center gap-2">
                        {/* ON/OFF トグル */}
                        <button
                          onClick={() => {
                            if (d.fullyBooked) {
                              setViewingSlotOverride(prev => { const n = [...prev]; n[i] = !n[i]; return n; });
                              if (!viewingSlotStarts[i]) setViewingSlotStarts(prev => { const n = [...prev]; n[i] = "11:00"; return n; });
                              if (!viewingSlotEnds[i]) setViewingSlotEnds(prev => { const n = [...prev]; n[i] = "18:00"; return n; });
                            } else {
                              setViewingSlotEnabled(prev => { const n = [...prev]; n[i] = !n[i]; return n; });
                            }
                          }}
                          className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                            d.fullyBooked
                              ? viewingSlotOverride[i] ? "bg-emerald-500 text-white" : "bg-red-200 text-red-400"
                              : viewingSlotEnabled[i] ? "bg-emerald-500 text-white" : "bg-[#d1d7db] text-[#8696a0]"
                          }`}
                        >{d.fullyBooked ? (viewingSlotOverride[i] ? "✓" : "×") : viewingSlotEnabled[i] ? "✓" : "○"}</button>
                        {/* 日付チップ */}
                        <span className={`font-bold text-xs flex-shrink-0 ${
                          d.fullyBooked
                            ? viewingSlotOverride[i] ? "text-emerald-700" : "text-red-400"
                            : viewingSlotEnabled[i] ? "text-emerald-700" : "text-[#54656f]"
                        }`}>{d.label}</span>
                        {d.fullyBooked && !viewingSlotOverride[i] && (
                          <span className="text-red-400 text-[10px]">予定あり（タップで手動追加）</span>
                        )}
                      </div>
                      {(!d.fullyBooked || viewingSlotOverride[i]) && (
                        <div className="mt-2 flex items-center gap-1.5 pl-7">
                          <input
                            type="time"
                            value={viewingSlotStarts[i] ?? "11:00"}
                            onChange={(e) => { setViewingSlotStarts(prev => { const n = [...prev]; n[i] = e.target.value; return n; }); }}
                            onFocus={() => { if (!d.fullyBooked) setViewingSlotEnabled(prev => { const n = [...prev]; n[i] = true; return n; }); }}
                            className={`rounded-lg border px-2 py-1 text-xs font-bold outline-none ${
                              (d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i]) ? "border-emerald-300 bg-white text-emerald-700" : "border-[#d1d7db] bg-white text-[#54656f]"
                            }`}
                          />
                          <span className="text-[#8696a0] text-xs font-bold">〜</span>
                          <input
                            type="time"
                            value={viewingSlotEnds[i] ?? "18:00"}
                            onChange={(e) => { setViewingSlotEnds(prev => { const n = [...prev]; n[i] = e.target.value; return n; }); }}
                            onFocus={() => { if (!d.fullyBooked) setViewingSlotEnabled(prev => { const n = [...prev]; n[i] = true; return n; }); }}
                            className={`rounded-lg border px-2 py-1 text-xs font-bold outline-none ${
                              (d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i]) ? "border-emerald-300 bg-white text-emerald-700" : "border-[#d1d7db] bg-white text-[#54656f]"
                            }`}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl bg-[#f0f2f5] px-3 py-2 text-xs text-[#8696a0]">カレンダー情報を取得できませんでした</div>
              )}
            </div>
          )}

          {/* 待ち合わせ専用UI */}
          {actionType === "meeting_place" && (
            <div className="mb-4">
              {/* 物件資料画像 OCR */}
              <div className="mb-3">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                  物件資料<span className="ml-1 font-normal text-[#90a4ae]">（画像から物件名・住所を自動取得）</span>
                </label>
                {meetingPropertyPreview ? (
                  <div className="relative mb-2 overflow-hidden rounded-xl border border-sky-200">
                    <img src={meetingPropertyPreview} alt="物件資料" className="max-h-28 w-full object-contain" />
                    <button
                      onClick={() => { setMeetingPropertyFile(null); setMeetingPropertyPreview(""); setMeetingPropertyName(""); setMeetingPropertyAddress(""); }}
                      className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white"
                    >変更</button>
                    {meetingOcrLoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-bold text-sky-600">
                        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
                        読み取り中...
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => meetingPropertyInputRef.current?.click()}
                    className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-300 bg-sky-50 py-3 text-xs font-bold text-sky-600"
                  >📸 物件資料を読み込む（スキップ可）</button>
                )}
                <input
                  ref={meetingPropertyInputRef}
                  type="file" accept="image/*" className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setMeetingPropertyFile(f);
                    const reader = new FileReader();
                    reader.onload = async () => {
                      const dataUrl = String(reader.result ?? "");
                      setMeetingPropertyPreview(dataUrl);
                      setMeetingOcrLoading(true);
                      try {
                        const base64 = dataUrl.split(",")[1];
                        const mime = (dataUrl.split(";")[0].split(":")[1] || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
                        const res = await fetch("/api/extract-meeting-place", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ image_base64: base64, media_type: mime }),
                        });
                        await ensureOk(res);
                        const data = await res.json() as { ok: boolean; name?: string; address?: string };
                        if (data.ok) {
                          if (data.name) setMeetingPropertyName(data.name);
                          if (data.address) setMeetingPropertyAddress(data.address);
                        }
                      } catch (e) { console.error("[AixModal] 待ち合わせOCR失敗:", e); } finally { setMeetingOcrLoading(false); }
                    };
                    reader.readAsDataURL(f);
                  }}
                />
              </div>
              {/* 物件名 + 住所 */}
              <div className="mb-3">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">物件名 <span className="text-red-400">*</span></label>
                <input
                  value={meetingPropertyName}
                  onChange={(e) => setMeetingPropertyName(e.target.value)}
                  placeholder="例：クラウンハイム夕陽丘"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-sm outline-none focus:border-[#2196F3]"
                />
              </div>
              <div className="mb-3">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">住所<span className="ml-1 font-normal text-[#90a4ae]">（任意）</span></label>
                <input
                  value={meetingPropertyAddress}
                  onChange={(e) => setMeetingPropertyAddress(e.target.value)}
                  placeholder="例：大阪府大阪市天王寺区下寺町2丁目3-11"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-sm outline-none focus:border-[#2196F3]"
                />
              </div>
              {/* 日程 + 時間 */}
              <div className="mb-1">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">日程 <span className="text-red-400">*</span></label>
                <input
                  value={meetingDate}
                  onChange={(e) => setMeetingDate(e.target.value)}
                  placeholder="例：6/22（月）"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-sm outline-none focus:border-[#2196F3]"
                />
              </div>
              <div className="mb-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-semibold text-[#54656f]">
                    時間 <span className="font-normal text-[#90a4ae]">（任意）</span>
                  </label>
                  {meetingTime && (
                    <button
                      type="button"
                      onClick={() => setMeetingTime("")}
                      className="text-[11px] text-[#8696a0] underline"
                    >クリア</button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="time"
                    value={meetingTime}
                    onChange={(e) => setMeetingTime(e.target.value)}
                    className={`w-full rounded-xl border px-4 py-3 text-[15px] font-bold outline-none transition-colors ${meetingTime ? "border-sky-400 bg-sky-50 text-sky-700 focus:border-sky-500" : "border-[#d1d7db] bg-white text-[#111b21] focus:border-[#2196F3]"}`}
                  />
                  {!meetingTime && (
                    <span className="pointer-events-none absolute inset-0 flex items-center px-4 text-sm text-[#b0bec5]">
                      タップして時間を選択
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[10px] text-[#8696a0]">
                  {meetingTime
                    ? `✅ 「${meetingDate || "〇〇日"} ${meetingTime}に ... お待ち合わせで何卒よろしくお願い致します！！」`
                    : "💬 未選択 → AIがLINEの会話から待ち合わせ時間を自動読み取りして文を生成します"}
                </p>
              </div>
            </div>
          )}

          {/* テキスト入力欄（各アクション専用） */}
          {config.inputLabel && actionType !== "property_send" && actionType !== "viewing_invite" && actionType !== "meeting_place" && (
            <div className="mb-4">
              <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
                <label className="text-xs font-semibold text-[#54656f] shrink-0">{config.inputLabel}</label>
                {actionType === "property_recommendation" && (
                  <>
                    {(["家賃", "初期費用", "お部屋の条件", "設備", "地域・駅"] as const).map((pt) => {
                      const selected = recommendFocusPoints.includes(pt);
                      return (
                        <button
                          key={pt}
                          type="button"
                          onClick={() => {
                            setRecommendFocusPoints(prev =>
                              selected ? prev.filter(p => p !== pt) : [...prev, pt]
                            );
                            setPreview("");
                          }}
                          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold transition-colors ${
                            selected
                              ? "border-orange-400 bg-orange-400 text-white"
                              : "border-[#d1d7db] bg-white text-[#667781]"
                          }`}
                        >
                          {selected ? "✓ " : ""}{pt}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => { setRecSimpleMode(v => !v); setPreview(""); }}
                      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold transition-colors ${
                        recSimpleMode
                          ? "border-blue-500 bg-blue-500 text-white"
                          : "border-[#d1d7db] bg-white text-[#667781]"
                      }`}
                    >
                      {recSimpleMode ? "✓ " : ""}シンプル
                    </button>
                  </>
                )}
              </div>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={config.inputPlaceholder}
                rows={2}
                className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
              />
            </div>
          )}

          {/* プレビュー（生成後） */}
          {preview && (
            <div className="mb-4">
              <button
                onClick={() => { setPreviewBackup(preview); setPreviewExpanded(true); }}
                className="w-full rounded-2xl bg-[#f0f2f5] px-4 py-3 text-left active:bg-[#e8eaed] transition-colors"
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#667781]">送信プレビュー</span>
                  <div className="flex items-center gap-2">
                    <div className="flex overflow-hidden rounded-full border border-[#d1d7db] text-[10px] font-bold">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUseEmoji(true);
                          if (!aiDraft) return;
                          // 手動編集されていない場合のみAI原文を復元（編集内容を無警告で消さない）
                          if (preview === aiDraft || preview === stripEmoji(aiDraft)) {
                            setPreview(aiDraft);
                          } else {
                            setAixNotice("手動編集された文章を保持したため、絵文字の復元はスキップしました。絵文字が必要な場合は直接編集してください。");
                          }
                        }}
                        className={`px-2.5 py-0.5 transition-colors ${useEmoji ? "bg-[#2196F3] text-white" : "bg-white text-[#8696a0]"}`}
                      >絵文字あり</button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUseEmoji(false); setPreview(stripEmoji(preview)); }}
                        className={`px-2.5 py-0.5 transition-colors ${!useEmoji ? "bg-[#667781] text-white" : "bg-white text-[#8696a0]"}`}
                      >なし</button>
                    </div>
                    <span className="text-[10px] font-bold text-blue-500">✏️ タップして編集</span>
                  </div>
                </div>
                <p className="text-sm leading-6 text-[#111b21] line-clamp-4 whitespace-pre-wrap">{preview}</p>
              </button>
              {(preview.includes("[物件名]") || preview.includes("[物件名と号室]")) && (
                <div className="mt-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
                  ⚠️ 物件名が特定できませんでした。送信前に直接編集してください。
                </div>
              )}
              {aixNotice && (
                <div className="mt-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700 flex items-start gap-1.5">
                  <span className="mt-0.5 shrink-0">ℹ️</span>
                  <span>{aixNotice}</span>
                </div>
              )}
              {/* 物件オススメ: 強調ポイントを生成後にも選択できる */}
              {actionType === "property_recommendation" && (
                <div className="mt-3 rounded-2xl border border-[#e8eaed] bg-white px-3 py-2.5">
                  <p className="mb-2 text-[11px] font-semibold text-[#8696a0]">強調ポイントを変えて再生成</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(["家賃", "初期費用", "お部屋の条件", "設備", "地域・駅"] as const).map((pt) => {
                      const selected = recommendFocusPoints.includes(pt);
                      return (
                        <button
                          key={pt}
                          type="button"
                          onClick={() => {
                            setRecommendFocusPoints(prev =>
                              selected ? prev.filter(p => p !== pt) : [...prev, pt]
                            );
                            setPreview("");
                          }}
                          className={`rounded-full border px-3 py-1 text-[12px] font-bold transition-colors ${
                            selected
                              ? "border-orange-400 bg-orange-400 text-white"
                              : "border-[#d1d7db] bg-white text-[#667781] active:bg-[#f0f2f5]"
                          }`}
                        >
                          {selected ? "✓ " : ""}{pt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">
              <p>{error}</p>
              {error.includes("タイムアウト") && (
                <button
                  onClick={() => { setError(""); void generate(); }}
                  className="mt-2 flex items-center gap-1 rounded-full bg-red-500 px-4 py-1.5 text-xs font-bold text-white active:opacity-70"
                >
                  🔄 もう一度生成
                </button>
              )}
            </div>
          )}

          {/* ボタン */}
          <div className="flex gap-2">
            {preview ? (
              (() => {
                const isConfirmation = preview.includes("確認事項があります") || preview.includes("確認させてください");
                return (
                  <>
                    <button
                      onClick={() => void generate()}
                      disabled={loading || !canGenerate}
                      className="flex-1 rounded-full border border-[#d1d7db] py-3 text-sm font-semibold text-[#54656f] disabled:opacity-50"
                    >
                      {loading ? "生成中..." : "再生成"}
                    </button>
                    {isConfirmation ? (
                      <button
                        onClick={() => void generate({ skip_confirmation: true })}
                        disabled={loading}
                        className="flex-1 rounded-full bg-orange-500 py-3 text-sm font-bold text-white disabled:opacity-50"
                      >
                        {loading ? "生成中..." : "確認した・生成する"}
                      </button>
                    ) : (
                      <button
                        onClick={() => { if (aixLongPressedRef.current) { aixLongPressedRef.current = false; return; } void handleSend(); }}
                        onTouchStart={(e) => { e.preventDefault(); aixLongPressTimerRef.current = setTimeout(() => { aixLongPressedRef.current = true; openAixScheduleModal(); }, 600); }}
                        onTouchEnd={() => { if (aixLongPressTimerRef.current) { clearTimeout(aixLongPressTimerRef.current); aixLongPressTimerRef.current = null; } }}
                        onMouseDown={() => { aixLongPressTimerRef.current = setTimeout(() => { aixLongPressedRef.current = true; openAixScheduleModal(); }, 600); }}
                        onMouseUp={() => { if (aixLongPressTimerRef.current) { clearTimeout(aixLongPressTimerRef.current); aixLongPressTimerRef.current = null; } }}
                        onMouseLeave={() => { if (aixLongPressTimerRef.current) { clearTimeout(aixLongPressTimerRef.current); aixLongPressTimerRef.current = null; } }}
                        disabled={loading}
                        className="flex-1 rounded-full bg-[#06c755] py-3 text-sm font-bold text-white disabled:opacity-50 select-none"
                        style={{ WebkitUserSelect: "none", touchAction: "manipulation" }}
                        title="送信（長押しで予約送信）"
                      >
                        {loading
                          ? sendCountdown > 0
                            ? `見積書送信済み ✓ 本文まで${sendCountdown}秒...`
                            : "送信中..."
                          : "送信する"}
                      </button>
                    )}
                  </>
                );
              })()
            ) : (
              actionType === "viewing_invite" ||
              actionType === "application_push" ||
              actionType === "property_check_result" ||
              actionType === "meeting_place" ||
              actionType === "condition_hearing" ||
              actionType === "acknowledge_check" ||
              actionType === "followup_revive"
            ) ? (
              <div className="flex flex-col gap-2 w-full">
                <button
                  onClick={() => void generate({ conversation_match: true })}
                  disabled={loading || !canGenerate}
                  className="w-full rounded-2xl bg-[#546E7A] py-3.5 text-sm font-bold text-white disabled:opacity-40"
                >
                  {loading ? "生成中..." : "💬 会話を合わせる"}
                </button>
                <button
                  onClick={() => void generate()}
                  disabled={loading || !canGenerate}
                  className="w-full rounded-full bg-[#111b21] py-3 text-sm font-bold text-white disabled:opacity-50"
                >
                  {loading ? "生成中..." : "AIX 生成"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => void generate()}
                disabled={loading || !canGenerate}
                className="w-full rounded-full bg-[#111b21] py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {loading ? "生成中..." : "AIX 生成"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* テンプレート確認フルスクリーン */}
      {showTemplateInfo && (() => {
        const info = AIX_TEMPLATES[actionType];
        return (
          <div className="fixed inset-0 z-[60] flex flex-col bg-white"
            style={{ paddingTop: "max(env(safe-area-inset-top), 0px)", paddingBottom: "max(env(safe-area-inset-bottom), 0px)" }}>
            <div className="flex items-center justify-between border-b border-[#f0f2f5] px-4 py-3"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
              <button
                onClick={() => setShowTemplateInfo(false)}
                className="rounded-full bg-white/20 px-4 py-1.5 text-sm font-bold text-white active:opacity-70"
              >閉じる</button>
              <span className="text-sm font-bold text-white">📋 テンプレート確認</span>
              <div className="w-16" />
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
              {/* よく使われるフレーズバナー */}
              {topPhrases.length > 0 && (
                <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 px-4 py-3">
                  <p className="text-[11px] font-bold text-amber-700 mb-2">💡 よく使われるフレーズ（実績順）</p>
                  <ul className="space-y-1.5">
                    {topPhrases.map((p, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-amber-500 font-bold text-xs mt-0.5">{i + 1}</span>
                        <span className="text-[12px] text-[#333] flex-1 leading-snug">{p.phrase}</span>
                        <span className="text-[10px] text-amber-600 font-bold shrink-0">{p.usage_count}回</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <p className="mb-2 text-xs font-bold text-blue-700 uppercase tracking-wide">生成ルール</p>
                <ul className="space-y-1.5">
                  {info.rules.map((r, i) => (
                    <li key={i} className="text-sm text-[#333]">・{r}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-2 text-xs font-bold text-blue-700 uppercase tracking-wide">出力テンプレート</p>
                <pre className="whitespace-pre-wrap rounded-2xl bg-[#f0f2f5] px-4 py-4 text-sm leading-7 text-[#111b21]">{info.template}</pre>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 予約送信モーダル */}
      {showAixScheduleModal && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50">
          <div className="w-full max-w-md rounded-t-2xl bg-white shadow-2xl px-5 pt-5 pb-4">
            <p className="text-[15px] font-bold text-[#111b21] mb-1">📅 送信予約</p>
            <p className="text-[12px] text-[#8696a0] mb-3">指定した日時にLINEへ自動送信します（JST）</p>
            <p className="text-[13px] text-[#667781] bg-[#f0f2f5] rounded-xl px-3 py-2 max-h-20 overflow-y-auto whitespace-pre-wrap leading-snug mb-3">
              {preview.slice(0, 80)}{preview.length > 80 ? "…" : ""}
            </p>
            {(actionType === "property_send" ? sendImageFiles.length : actionType === "property_check_result" ? checkImageFiles.length : imageFile ? 1 : 0) > 0 && (
              <p className="text-[12px] text-[#667781] mb-3">📎 画像あり</p>
            )}
            <label className="text-[12px] font-bold text-[#667781] block mb-1">送信日時（JST）</label>
            <input
              type="datetime-local"
              value={aixScheduleDateTime}
              step="60"
              onChange={(e) => setAixScheduleDateTime(e.target.value)}
              className="w-full rounded-xl border border-[#e0e0e0] px-3 py-2.5 text-[14px] text-[#111b21] focus:outline-none focus:border-[#29B6F6]"
            />
            <div className="flex border-t border-[#f0f2f5] mt-4">
              <button onClick={() => setShowAixScheduleModal(false)} className="flex-1 py-3.5 text-[14px] font-semibold text-[#8696a0] border-r">キャンセル</button>
              <button onClick={executeAixScheduleSend} disabled={aixScheduleSaving || !aixScheduleDateTime} className="flex-1 py-3.5 text-[14px] font-bold text-[#1565C0] disabled:opacity-50">
                {aixScheduleSaving ? "予約中…" : "完了"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全画面編集オーバーレイ */}
      {previewExpanded && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-white"
          style={{ paddingTop: "max(env(safe-area-inset-top), 0px)", paddingBottom: "max(env(safe-area-inset-bottom), 0px)" }}>
          {/* ヘッダー */}
          <div className="flex items-center justify-between border-b border-[#f0f2f5] px-4 py-3"
            style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
            <button
              onClick={() => { setPreview(previewBackup); setPreviewExpanded(false); }}
              className="rounded-full bg-white/20 px-4 py-1.5 text-sm font-bold text-white active:opacity-70"
            >
              キャンセル
            </button>
            <span className="text-sm font-bold text-white">メッセージ編集</span>
            <button
              onClick={() => setPreviewExpanded(false)}
              className="rounded-full bg-white px-4 py-1.5 text-sm font-bold text-[#1565C0] active:opacity-70"
            >
              完了
            </button>
          </div>
          {/* 文字カウント */}
          <div className="flex items-center justify-between bg-[#f8f9fa] px-4 py-1.5">
            <span className="text-[11px] text-[#8696a0]">LINEで送信するメッセージを自由に編集できます</span>
            <span className="text-[11px] font-semibold text-[#8696a0]">{preview.length}文字</span>
          </div>
          {/* 大型テキストエリア */}
          <textarea
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
            autoFocus
            className="flex-1 resize-none px-5 py-4 text-[15px] leading-7 text-[#111b21] outline-none"
            style={{ fontFamily: "inherit" }}
          />
          {/* 送信ボタン（展開中も送信可） */}
          <div className="border-t border-[#f0f2f5] px-4 py-3">
            <button
              onClick={async () => { setPreviewExpanded(false); await handleSend(); }}
              disabled={loading || !preview.trim()}
              className="w-full rounded-full bg-[#06c755] py-3.5 text-sm font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform"
            >
              {loading ? "送信中..." : "このメッセージを送信する"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
