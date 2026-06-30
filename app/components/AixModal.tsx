"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchCalendarSlots } from "../lib/calendarSlots";

export type AixActionType =
  | "condition_hearing"
  | "property_recommendation"
  | "property_send"
  | "viewing_invite"
  | "application_push"
  | "estimate_sheet"
  | "property_check_result"
  | "meeting_place";

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
  initialViewingSpecificMode?: boolean;
  onClose: () => void;
  onSend: (text: string, imageUrl?: string) => Promise<void>;
  onAfterSend?: (meta?: { suggest2ndHand?: boolean; suggestViewingTemplate?: boolean; suggestViewing?: boolean; scheduled?: boolean; suggestInitialCostTemplate?: boolean }) => void;
  onDelayedSend?: (seconds: number, sendFn: () => Promise<void>) => void;
  onScheduled?: () => void;
  onVacatingDetected?: (date: string) => void;
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
    rules: ["空室 or 退去予定を選択", "見積書送信済みか会話から自動検出", "ワンタップで即生成 → 確認後送信"],
    template: "お申込みを進めて頂ければと思います！！\n[空室状況]\n審査は最短〇〇日で結果が出ます！！\nよろしければご検討ください！！",
  },
  meeting_place: {
    rules: ["物件資料画像から物件名・住所をAIが自動読み取り", "日程・時間を入力して待ち合わせ文を生成", "時間あり→確定文 / 時間なし→調整文 の2パターン対応"],
    template: "かしこまりました！！\n〇〇日ご案内させて頂きます！！\n\n〇〇日〇〇時に[物件名]\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: [住所]",
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
    title: "物件送る",
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
  initialViewingSpecificMode,
  onClose,
  onSend,
  onAfterSend,
  onDelayedSend,
  onScheduled,
  onVacatingDetected,
}: AixModalProps) {
  const config = CONFIG[actionType];

  const [showAixScheduleModal, setShowAixScheduleModal] = useState(false);
  const [aixScheduleDateTime, setAixScheduleDateTime] = useState("");
  const [aixScheduleSaving, setAixScheduleSaving] = useState(false);
  const aixLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aixLongPressedRef = useRef(false);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  // 物件オススメ専用: お客さんの条件スクショ
  const [conditionImageFile, setConditionImageFile] = useState<File | null>(null);
  const [conditionImagePreview, setConditionImagePreview] = useState<string>("");
  // 物件オススメ専用: 室内イメージURL（任意）
  const [propertyImageUrl, setPropertyImageUrl] = useState("");
  const [inputText, setInputText] = useState("");
  // 物件オススメ専用: 特に強調するポイント（複数選択可）。テンプレートモーダルから引き継ぐ場合は initialFocusPoints で渡す
  const [recommendFocusPoints, setRecommendFocusPoints] = useState<string[]>(initialFocusPoints ?? []);
  const [recSimpleMode, setRecSimpleMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [aiDraft, setAiDraft] = useState<string>("");
  const [aixNotice, setAixNotice] = useState<string>("");
  const [parsedEstimate, setParsedEstimate] = useState<Record<string, string> | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [useEmoji, setUseEmoji] = useState(true);
  const [showTemplateInfo, setShowTemplateInfo] = useState(false);
  const [topPhrases, setTopPhrases] = useState<{ phrase: string; usage_count: number }[]>([]);
  const [floorPlanTouched, setFloorPlanTouched] = useState(false);
  // 物件確認した専用
  const [checkPattern, setCheckPattern] = useState<"available" | "alternative" | "unavailable" | "move_in_date" | null>(null);
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
  // 物件送る専用: 複数画像 + 退去予定メモ + カレンダー自動取得
  const [sendImageFiles, setSendImageFiles] = useState<File[]>([]);
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
  // 物件送る専用: 新着物件 / 内覧誘導 / 申込み誘導 モード + 編集可能スロット（未選択 = null）
  const [sendMode, setSendMode] = useState<"viewing" | "application" | "new_arrival" | "short" | null>(null);
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
  const [appVacancyStatus, setAppVacancyStatus] = useState<"vacant" | "scheduled" | null>(null);
  const [appMoveOutDate, setAppMoveOutDate] = useState("");
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
  const [viewingIsVacancy, setViewingIsVacancy] = useState(false);
  const [viewingVacancyName, setViewingVacancyName] = useState("");
  const [viewingVacancyMoveOut, setViewingVacancyMoveOut] = useState("");
  const [viewingVacancyFile, setViewingVacancyFile] = useState<File | null>(null);
  const [viewingVacancyPreview, setViewingVacancyPreview] = useState("");
  const [viewingVacancyOcrLoading, setViewingVacancyOcrLoading] = useState(false);

  // 内覧へ！内覧日指定あり専用
  const [viewingSpecificMode, setViewingSpecificMode] = useState(!!initialViewingSpecificMode);
  const [viewingSpecificDate, setViewingSpecificDate] = useState("");
  const [viewingSpecificStart, setViewingSpecificStart] = useState("");
  const [viewingSpecificEnd, setViewingSpecificEnd] = useState("");

  // 物件オススメ専用: 見積書（任意）
  const [recommendEstimateFile, setRecommendEstimateFile] = useState<File | null>(null);
  const [recommendEstimatePreview, setRecommendEstimatePreview] = useState<string>("");
  // 見積書送る専用: 物件資料（任意）
  const [estimatePropertyFile, setEstimatePropertyFile] = useState<File | null>(null);
  const [estimatePropertyPreview, setEstimatePropertyPreview] = useState<string>("");

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
  const meetingPropertyInputRef = useRef<HTMLInputElement | null>(null);
  const viewingVacancyInputRef = useRef<HTMLInputElement | null>(null);

  // 会話が変わったらシンプルモードをリセット
  useEffect(() => {
    setRecSimpleMode(false);
    setPreview("");
    setAixNotice("");
  }, [conversationId]);

  useEffect(() => {
    if (initialImageFile) {
      setImageFile(initialImageFile);
      const reader = new FileReader();
      reader.onload = () => setImagePreview(String(reader.result ?? ""));
      reader.readAsDataURL(initialImageFile);
    }
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

  // 物件送る: 直近3日のカレンダー（calendar_events + daily_tasks）を取得して空き枠を計算
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

  // 内覧へ！: カレンダー取得
  useEffect(() => {
    if (actionType !== "viewing_invite") return;
    setViewingCalendarLoading(true);
    (async () => {
      try {
        const { days } = await fetchCalendarSlots();
        setViewingCalendarDays(days);
        setViewingSlotEnabled(days.map(d => !d.fullyBooked));
        // "11:00〜14:00" → start: "11:00", end: "14:00"
        const parseTime = (slot: string) => {
          const m = slot.match(/(\d{1,2}:\d{2})[〜~\-](\d{1,2}:\d{2})/);
          return m ? { start: m[1].padStart(5, "0"), end: m[2].padStart(5, "0") } : { start: "10:00", end: "18:00" };
        };
        setViewingSlotStarts(days.map(d => parseTime(d.slots[0] || "").start));
        setViewingSlotEnds(days.map(d => parseTime(d.slots[0] || "").end));
        setViewingSlotOverride(days.map(() => false));
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

  // 内覧日指定あり: ONになったら会話からお客様指定日を自動抽出
  useEffect(() => {
    if (!viewingSpecificMode || !recentMessages) return;
    if (viewingSpecificDate) return; // 既に入力済みならスキップ
    // お客様メッセージから日付を逆順に探す
    const customerMsgs = [...recentMessages].filter(m => m.sender === "customer" && m.text).reverse();
    for (const msg of customerMsgs) {
      const m = (msg.text || "").match(/(\d{1,2})月(\d{1,2})日/);
      if (m) { setViewingSpecificDate(`${m[1]}月${m[2]}日`); break; }
    }
    // カレンダーから時間をプリセット（最初の有効スロット）
    const firstSlot = viewingCalendarDays.find((d, i) => d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i]);
    const firstIdx = viewingCalendarDays.indexOf(firstSlot!);
    if (firstSlot) {
      if (!viewingSpecificStart) setViewingSpecificStart(viewingSlotStarts[firstIdx] || "");
      if (!viewingSpecificEnd)   setViewingSpecificEnd(viewingSlotEnds[firstIdx] || "");
    }
  }, [viewingSpecificMode]);

  // 待ち合わせ: 会話から日程・時間を自動抽出してプリセット（お客様確定メッセージ最優先）
  useEffect(() => {
    if (actionType !== "meeting_place") return;
    if (meetingDate) return; // 既に入力済みならスキップ

    const allMsgs = recentMessages || [];
    const customerMsgs = [...allMsgs].filter(m => m.sender === "customer" && m.text).reverse();
    const staffMsgs    = [...allMsgs].filter(m => m.sender === "staff"    && m.text).reverse();

    // スタッフの提示日程から月を取得（お客様が「2日」とだけ言った場合の補完用）
    let contextMonth = "";
    for (const s of staffMsgs.slice(0, 8)) {
      const mo = s.text.match(/(\d{1,2})[\/月]\d{1,2}/);
      if (mo) { contextMonth = mo[1]; break; }
    }
    // スタッフの提示スロットから曜日マップを構築: {"2": "木", "1": "水", "3": "金"} など
    const dayWeekMap: Record<string, string> = {};
    for (const s of staffMsgs.slice(0, 8)) {
      const dayWeekMatches = s.text.matchAll(/(\d{1,2})[\/月](\d{1,2})(?:日)?[（(]?([月火水木金土日])[）)]?/g);
      for (const m of dayWeekMatches) { dayWeekMap[m[2]] = m[3]; }
    }

    // ── Step1: お客様の確定メッセージから抽出（最優先）──
    // 例: "2日16時〜からお願いします" / "7/2 16時でお願いします" / "2日の16時でいきます"
    for (const m of customerMsgs.slice(0, 5)) {
      const text = m.text;
      const isConfirmation = /お願い|でいい|大丈夫|にします|でいきます|で行き|でお伺い|確定|にて/.test(text);
      if (!isConfirmation && !/\d+日.*\d+時|\d+時.*お願い/.test(text)) continue;

      // フルパターン: "7/2 16時" "7月2日16時"
      const fullMatch = text.match(/(\d{1,2})[\/月](\d{1,2})日?[^\d]*(\d{1,2})[時:]/);
      if (fullMatch) {
        const [, mo, day, hour] = fullMatch;
        const minMatch = text.slice(text.indexOf(fullMatch[3] + "時")).match(/[時:](\d{2})/);
        const min = (minMatch?.[1] || "00").padStart(2, "0");
        const wd = dayWeekMap[day];
        setMeetingDate(wd ? `${mo}/${day}（${wd}）` : `${mo}/${day}`);
        setMeetingTime(`${hour.padStart(2,"0")}:${min}`);
        return;
      }

      // 日のみ + 時間: "2日16時〜" "2日の16時"
      const dayTimeMatch = text.match(/(\d{1,2})日[^\d]*(\d{1,2})[時:]/);
      if (dayTimeMatch) {
        const [, day, hour] = dayTimeMatch;
        const minMatch = text.slice(text.indexOf(dayTimeMatch[2] + "時")).match(/[時:](\d{2})/);
        const min = (minMatch?.[1] || "00").padStart(2, "0");
        const mo = contextMonth;
        const wd = dayWeekMap[day];
        const dateStr = mo
          ? (wd ? `${mo}/${day}（${wd}）` : `${mo}/${day}`)
          : (wd ? `${day}日（${wd}）` : `${day}日`);
        setMeetingDate(dateStr);
        setMeetingTime(`${hour.padStart(2,"0")}:${min}`);
        return;
      }
    }

    // ── Step2: スタッフメッセージから最初のスロットを取得（フォールバック）──
    for (const m of staffMsgs) {
      const match = m.text.match(/(\d{1,2})[\/月](\d{1,2})(?:日)?(?:[（(]([月火水木金土日])[）)])?/);
      if (match) {
        const [, mo, day, wd] = match;
        const dateStr = wd ? `${mo}/${day}（${wd}）` : `${mo}/${day}`;
        setMeetingDate(dateStr);
        const timeMatch = m.text.match(/(\d{1,2})[時:](\d{2})?/);
        if (timeMatch) {
          const h = timeMatch[1].padStart(2, "0");
          const min = (timeMatch[2] || "00").padStart(2, "0");
          setMeetingTime(`${h}:${min}`);
        }
        break;
      }
    }
  }, [actionType]);

  // テンプレート画面を開いたときによく使われるフレーズを取得
  useEffect(() => {
    if (!showTemplateInfo) return;
    const status = conversationStatus ?? "hearing";
    fetch(`/api/learn-template-phrases?action_type=${encodeURIComponent(actionType)}&conversation_status=${encodeURIComponent(status)}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; phrases?: { phrase: string; usage_count: number }[] }) => {
        if (d.ok && d.phrases?.length) setTopPhrases(d.phrases);
      })
      .catch(() => {});
  }, [showTemplateInfo, actionType, conversationStatus]);

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
        }).then(res => res.json() as Promise<{ ok: boolean; properties?: Array<{ name: string; status: string; move_out: string }> }>)
          .then(data => {
            if (data.ok && data.properties?.length) {
              const prop = data.properties[0];
              if (prop.status === "scheduled" && prop.move_out) {
                setPropMoveOutDate(prop.move_out);
                onVacatingDetected?.(prop.move_out);
              }
            }
          }).catch(() => {});
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

  // 物件送る専用: 複数画像追加
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
    const results: Array<{name: string; moveOut: string; editingDate: boolean}> = [];
    const total = sendImagePreviews.length;

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
        const data = await res.json() as { ok: boolean; properties?: Array<{name: string; status: string; move_out: string}> };
        if (data.ok && data.properties) {
          const scheduled = data.properties
            .filter((p) => p.status === "scheduled" && p.name)
            .map((p) => ({ name: p.name, moveOut: (p.move_out || "").replace(/^\d{4}年/, ""), editingDate: false }));
          results.push(...scheduled);
          setVacatingProperties([...results]);
          syncVacatingNote([...results]);
        }
      } catch {
        // 1枚失敗しても続ける
      }
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
        if (sendMode === "viewing" && includeCalendar) {
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
        if (!appVacancyStatus) throw new Error("空室状況を選択してください");
        body.vacancy_status = appVacancyStatus;
        if (appMoveOutDate.trim()) body.move_out_date = appMoveOutDate.trim();
        if (appPropertyName.trim()) body.property_name = appPropertyName.trim();
        // 直近スタッフメッセージから見積書送信済みを自動検出
        const staffMsgs = (recentMessages || []).filter(m => m.sender === "staff").slice(-15);
        const hasEstimate = staffMsgs.some(m => /見積|御見積|初期費用/.test(m.text));
        body.has_estimate = hasEstimate;
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        if (customerSummary) body.customer_summary = customerSummary;
      } else if (actionType === "property_check_result") {
        if (!checkPattern) throw new Error("確認結果を選択してください");
        body.check_pattern = checkPattern;
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
        } else {
          if (checkEstimateFile) body.estimate_image_url = await uploadImage(checkEstimateFile);
          if (checkImageFiles.length > 0) {
            const urls = await Promise.all(checkImageFiles.map((f, i) => uploadImage(f, i)));
            body.image_urls = urls;
            body.image_url = urls[0];
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
      } else if (config.requiresImage && imageFile) {
        body.image_url = await uploadImage(imageFile);
      }

      // 内覧へ！内覧日指定ありモード → テンプレで即生成（AI不要）
      if (actionType === "viewing_invite" && viewingSpecificMode) {
        if (!viewingSpecificDate.trim()) throw new Error("日程を入力してください");
        const s = viewingSpecificStart.trim();
        const e = viewingSpecificEnd.trim();
        const timeText = s && e ? `${s}〜${e}` : s || "";
        const msg = `はい！！\n\n${viewingSpecificDate.trim()}ですと${timeText}ご内覧可能です！！\n\n${customerName}さんご都合如何でしょうか😌！！`;
        setAiDraft(msg);
        setPreview(useEmoji ? msg : stripEmoji(msg));
        setLoading(false);
        return;
      }

      // 内覧へ！退去予定物件モード → テンプレで即生成（AI不要）
      if (actionType === "viewing_invite" && viewingIsVacancy) {
        if (!viewingVacancyName.trim()) throw new Error("物件名を入力してください");
        if (!viewingVacancyMoveOut.trim()) throw new Error("退去予定日を入力してください");

        // 退去翌日を計算（◯月◯日 形式）
        const moveOutText = viewingVacancyMoveOut.trim();
        let viewingFromText = "";
        const jpMatch = moveOutText.match(/(\d{1,2})月(\d{1,2})日/);
        if (jpMatch) {
          const d = new Date(new Date().getFullYear(), parseInt(jpMatch[1]) - 1, parseInt(jpMatch[2]) + 1);
          viewingFromText = `${d.getMonth() + 1}月${d.getDate()}日`;
        }

        // カレンダースロット取得
        const selectedSlots = viewingCalendarDays
          .map((d, i) => {
            const isEnabled = d.fullyBooked ? viewingSlotOverride[i] : viewingSlotEnabled[i];
            if (!isEnabled) return "";
            const start = viewingSlotStarts[i] || "";
            const end = viewingSlotEnds[i] || "";
            if (!start) return "";
            return `${d.label} ${start}${end ? "〜" + end : ""}`;
          })
          .filter(Boolean);

        const fromLine = viewingFromText ? `${viewingFromText}以降ご内覧できます！！` : "退去後よりご内覧できます！！";
        let msg = `${viewingVacancyName.trim()} ${moveOutText}退去予定のお部屋となりますので\n${fromLine}\n${customerName}さん`;
        if (selectedSlots.length > 0) {
          msg += `直近ですと\n${selectedSlots.join("\n")}\nご都合如何でしょうか！！`;
        } else {
          msg += `ご都合如何でしょうか！！`;
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

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "生成に失敗しました");

      const generatedMsg = data.message_text || "";
      setAiDraft(generatedMsg);
      setPreview(useEmoji ? generatedMsg : stripEmoji(generatedMsg));
      setAixNotice(data.notice || "");
      if (data.parsed_estimate) setParsedEstimate(data.parsed_estimate);
      setEstimateTextReady(data.estimate_text || "");
      setSendCountdown(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const ACTION_TO_STATE: Record<AixActionType, string> = {
    condition_hearing: "hearing",
    property_recommendation: "property_recommendation",
    property_send: "proposing",
    viewing_invite: "viewing",
    application_push: "application",
    estimate_sheet: "estimate_request",
    property_check_result: "proposing",
    meeting_place: "viewing",
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
      if (conversationStatus) {
        const lastCustomerMsg = (recentMessages ?? [])
          .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]")
          .at(-1)?.text ?? "";
        fetch("/api/learn-action-patterns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "log",
            conversation_status: conversationStatus,
            action_type: actionType,
            customer_msg_summary: lastCustomerMsg.slice(0, 150),
          }),
        }).catch(() => {});
      }

      onAfterSend?.({
        suggest2ndHand: actionType === "property_check_result" && checkAvailableApp === "yes",
        suggestViewingTemplate: actionType === "viewing_invite",
        suggestViewing: actionType === "property_check_result" && checkPattern === "available" && checkAvailableApp !== "yes",
        suggestInitialCostTemplate: actionType === "property_recommendation" && recommendFocusPoints.includes("初期費用"),
        scheduled: true,
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
    try {
      setLoading(true);

      if (actionType === "property_send") {
        // 物件画像を先に送信 → テキストを後で送信
        for (const file of sendImageFiles) {
          const url = await uploadImage(file);
          await onSend("", url);
        }
        await onSend(preview);
      } else if (actionType === "property_check_result") {
        if (checkPattern === "move_in_date") {
          // 入居日確認: テキストのみ送信（物件資料はお客さんに送らない）
          await onSend(preview);
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
          // 物件ごとに: 資料画像 → 見積書画像 の順で送信
          for (let pi = 0; pi < checkPropertyCount; pi++) {
            for (const file of (checkPropImages[pi] ?? [])) {
              const url = await uploadImage(file, pi);
              await onSend("", url);
            }
            const ef = checkPropEstimates[pi];
            if (ef) {
              const estUrl = await uploadImage(ef);
              await onSend("", estUrl);
            }
          }
          // 見積書テキスト先送り → モーダルを閉じてバックグラウンドで30秒後に本文送信
          if (shouldSendEstimateFirst) {
            await onSend(estimateTextReady);
            setEstimateTextReady("");
            // 送信関数・本文をクロージャでキャプチャ（宛先が変わっても元の会話に送られる）
            const capturedOnSend = onSend;
            const capturedPreview = preview;
            const capturedOnAfterSend = onAfterSend;
            const sendFn = async () => {
              await capturedOnSend(capturedPreview);
              capturedOnAfterSend?.({
                suggest2ndHand: actionType === "property_check_result" && checkAvailableApp === "yes",
              });
            };
            onDelayedSend?.(30, sendFn); // 親がsetTimeoutを管理（キャンセル可能）
            setLoading(false);
            onClose();
            return;
          }
          await onSend(preview);
        } else {
          // alternative / その他: 物件資料画像 → 見積書 → 本文
          for (const file of checkImageFiles) {
            const url = await uploadImage(file);
            await onSend("", url);
          }
          if (checkEstimateFile) {
            const estUrl = await uploadImage(checkEstimateFile);
            await onSend("", estUrl);
          }
          await onSend(preview);
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
          if (uploadedImageUrl) await onSend("", uploadedImageUrl);
          if (recommendEstimateFile) {
            const estUrl = await uploadImage(recommendEstimateFile);
            await onSend("", estUrl);
          }
          if (propertyImageUrl.trim()) await onSend(`（室内イメージ）\n${propertyImageUrl.trim()}`);
          await onSend(preview);
        } else if (actionType === "estimate_sheet") {
          // 送信順: ①物件資料（任意）→ ②見積書 → ③テキスト
          if (estimatePropertyFile) {
            const propUrl = await uploadImage(estimatePropertyFile);
            await onSend("", propUrl);
          }
          if (uploadedImageUrl) await onSend("", uploadedImageUrl);
          await onSend(preview);
        } else {
          await onSend(preview, uploadedImageUrl);
        }
      }

      // 学習ループに保存（fire-and-forget）
      const lastCustomerMsg = (recentMessages ?? [])
        .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .at(-1)?.text;
      const lastStaffMsg = (recentMessages ?? [])
        .filter((m) => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .at(-1)?.text;
      fetch("/api/save-reply-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationState: ACTION_TO_STATE[actionType],
          customerMessage: lastCustomerMsg || inputText.trim() || `（AIX: ${config.title}）`,
          sentReply: preview,
          aiDraft,
          previousStaffMessage: lastStaffMsg,
          isStarred: true,
        }),
      }).catch(() => {});

      // テンプレートフレーズ学習ログ
      if (preview.trim()) {
        fetch("/api/learn-template-phrases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action_type: actionType,
            conversation_status: conversationStatus ?? "hearing",
            sent_text: preview,
          }),
        }).catch(() => {});
      }

      // 次アクション学習ログ（過去パターンとして蓄積）
      if (conversationStatus) {
        fetch("/api/learn-action-patterns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "log",
            conversation_status: conversationStatus,
            action_type: actionType,
            customer_msg_summary: (lastCustomerMsg || inputText.trim()).slice(0, 150),
          }),
        }).catch(() => {});
      }

      onAfterSend?.({
        suggest2ndHand: actionType === "property_check_result" && checkAvailableApp === "yes",
        suggestViewingTemplate: actionType === "viewing_invite",
        suggestViewing: actionType === "property_check_result" && checkPattern === "available" && checkAvailableApp !== "yes",
        suggestInitialCostTemplate: actionType === "property_recommendation" && recommendFocusPoints.includes("初期費用"),
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
    ? (checkPattern === "move_in_date" ? !!moveInImageFile : !!checkPattern)
    : actionType === "property_send"
    ? true
    : actionType === "application_push"
    ? !!appVacancyStatus
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
                <p className="mb-1 text-xs font-bold text-[#54656f]">② 物件資料</p>
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
            /* 物件送る: モード選択 + カレンダー自動取得 + 複数画像 + 退去予定メモ */
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
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => { setSendMode(sendMode === "new_arrival" ? null : "new_arrival"); setPreview(""); }}
                    className={`flex-1 rounded-full py-2.5 text-sm font-bold transition-all ${
                      sendMode === "new_arrival"
                        ? "bg-[#FF6F00] text-white shadow-sm"
                        : "border border-[#d1d7db] bg-white text-[#54656f]"
                    }`}
                  >
                    新着物件
                  </button>
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
                <div className="flex gap-2">
                  <button
                    onClick={() => { setSendMode(sendMode === "short" ? null : "short"); setPreview(""); }}
                    className={`flex-1 rounded-full py-2.5 text-sm font-bold transition-all ${
                      sendMode === "short"
                        ? "bg-[#607d8b] text-white shadow-sm"
                        : "border border-[#d1d7db] bg-white text-[#54656f]"
                    }`}
                  >
                    シンプル
                  </button>
                  <button
                    onClick={() => { setSendMode(sendMode === "viewing" ? null : "viewing"); setPreview(""); }}
                    className={`flex-1 rounded-full py-2.5 text-sm font-bold transition-all ${
                      sendMode === "viewing"
                        ? "bg-[#2196F3] text-white shadow-sm"
                        : "border border-[#d1d7db] bg-white text-[#54656f]"
                    }`}
                  >
                    内覧誘導
                  </button>
                  <button
                    onClick={() => { setSendMode(sendMode === "application" ? null : "application"); setPreview(""); }}
                    className={`flex-1 rounded-full py-2.5 text-sm font-bold transition-all ${
                      sendMode === "application"
                        ? "bg-[#06c755] text-white shadow-sm"
                        : "border border-[#d1d7db] bg-white text-[#54656f]"
                    }`}
                  >
                    申込み誘導
                  </button>
                </div>
              </div>
              {/* カレンダー自動取得（内覧誘導時のみ） */}
              {sendMode === "viewing" && (
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
              )}
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
              {/* 条件を広げた */}
              <div>
                <button
                  onClick={() => setShowExpandedCond(v => !v)}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-[13px] font-bold transition-colors ${sendExpandedConds.size > 0 ? "border-orange-400 bg-orange-50 text-orange-700" : "border-[#d1d7db] bg-white text-[#444]"}`}
                >
                  <span className="flex items-center gap-2">
                    条件を広げた
                    {sendExpandedConds.size > 0 && (
                      <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[10px] font-bold text-white">{Array.from(sendExpandedConds).join("・")}</span>
                    )}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                    className={`transition-transform duration-200 ${showExpandedCond ? "rotate-180" : ""}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {showExpandedCond && (
                  <div className="mt-2 flex gap-2">
                    {(["家賃", "礼金", "築年数"] as const).map((cond) => {
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
            /* 申込へ！: 物件名 + シンプルボタン + AI生成 */
            <div className="mb-4 flex flex-col gap-3">
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
              {/* シンプルボタン */}
              <button
                onClick={() => {
                  const name = customerName || "お客様";
                  const prop = appPropertyName.trim();
                  const text = prop
                    ? `はい！！\n${name}さん${prop}につきまして、お気に召されましたらお申込しお部屋抑えさせて頂きます😌！！\nお気軽にお申し付けください！！`
                    : `はい！！\n${name}さんお気に召されましたらお申込しお部屋抑えさせて頂きます😌！！\nお気軽にお申し付けください！！`;
                  setPreview(text);
                }}
                className="w-full rounded-2xl border-2 border-[#E53935] bg-[#fff5f5] px-4 py-3 text-left transition-all active:bg-[#ffebee]"
              >
                <div className="text-[13px] font-bold text-[#E53935]">⚡ シンプル送信</div>
                <div className="mt-0.5 text-[10px] text-[#8696a0]">
                  {appPropertyName.trim()
                    ? `はい！！ ${customerName || "〇〇"}さん${appPropertyName.trim()}につきまして、お気に召されましたら…`
                    : "はい！！〇〇さんお気に召されましたらお申込し…"}
                </div>
              </button>
              {/* 区切り */}
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-[#e9edef]" />
                <span className="text-[10px] text-[#8696a0]">またはAIで詳しく作成</span>
                <div className="h-px flex-1 bg-[#e9edef]" />
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
              {/* 空室状況選択 */}
              <div>
                <p className="mb-2 text-xs font-bold text-[#54656f]">空室状況を選択</p>
                <div className="flex flex-col gap-2">
                  {([
                    { key: "vacant",    label: "空室（内覧できる）",   sub: "お申込みで抑えてご内覧もできます", color: "emerald" },
                    { key: "scheduled", label: "退去予定（内覧不可）", sub: "先にお申込みでお部屋確保を推奨",   color: "orange"  },
                  ] as const).map((p) => (
                    <button
                      key={p.key}
                      onClick={() => { setAppVacancyStatus(p.key); setPreview(""); }}
                      className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                        appVacancyStatus === p.key
                          ? p.color === "emerald" ? "border-emerald-400 bg-emerald-50"
                          : "border-orange-400 bg-orange-50"
                          : "border-[#e9edef] bg-[#f8f9fa]"
                      }`}
                    >
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 flex-shrink-0 ${
                        appVacancyStatus === p.key
                          ? p.color === "emerald" ? "border-emerald-500 bg-emerald-500" : "border-orange-500 bg-orange-500"
                          : "border-[#d1d7db]"
                      }`}>
                        {appVacancyStatus === p.key && <span className="h-2 w-2 rounded-full bg-white" />}
                      </span>
                      <div>
                        <div className="text-[13px] font-bold text-[#111b21]">{p.label}</div>
                        <div className="text-[10px] text-[#8696a0]">{p.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {/* 退去予定日（退去予定選択時のみ） */}
              {appVacancyStatus === "scheduled" && (
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
            </div>
          ) : actionType === "property_check_result" ? (
            /* 物件確認した: パターン選択 + 任意画像 */
            <div className="mb-4 flex flex-col gap-3">
              <div>
                <p className="mb-2 text-xs font-bold text-[#54656f]">確認結果を選択</p>
                <div className="flex flex-col gap-2">
                  {([
                    { key: "available",    label: "物件あった",         sub: "入居可能",                       color: "emerald" },
                    { key: "alternative",  label: "別の部屋が募集してた", sub: "満室だが代替あり",              color: "blue"    },
                    { key: "unavailable",  label: "物件なかった",        sub: "満室・空きなし（画像不要）",     color: "orange"  },
                    { key: "move_in_date", label: "入居日確認した",      sub: "退去日から入居可能日を計算送信", color: "purple"  },
                  ] as const).map((p) => (
                    <button
                      key={p.key}
                      onClick={() => { setCheckPattern(p.key); setPreview(""); setCheckAvailableApp(null); setShowCheckCalendar(false); }}
                      className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                        checkPattern === p.key
                          ? p.color === "emerald" ? "border-emerald-400 bg-emerald-50"
                          : p.color === "blue"    ? "border-blue-400 bg-blue-50"
                          : p.color === "purple"  ? "border-purple-400 bg-purple-50"
                          :                         "border-orange-400 bg-orange-50"
                          : "border-[#e9edef] bg-[#f8f9fa]"
                      }`}
                    >
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 flex-shrink-0 ${
                        checkPattern === p.key
                          ? p.color === "emerald" ? "border-emerald-500 bg-emerald-500"
                          : p.color === "blue"    ? "border-blue-500 bg-blue-500"
                          : p.color === "purple"  ? "border-purple-500 bg-purple-500"
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
                  onClick={() => { setViewingSpecificMode(v => !v); setViewingSpecificDate(""); setViewingSpecificStart(""); setViewingSpecificEnd(""); }}
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
                          const data = await res.json() as { ok: boolean; name?: string };
                          if (data.ok && data.name) setViewingVacancyName(data.name);
                        } catch { /* silent */ } finally { setViewingVacancyOcrLoading(false); }
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
                        const data = await res.json() as { ok: boolean; name?: string; address?: string };
                        if (data.ok) {
                          if (data.name) setMeetingPropertyName(data.name);
                          if (data.address) setMeetingPropertyAddress(data.address);
                        }
                      } catch { /* silent */ } finally { setMeetingOcrLoading(false); }
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
                    {(["家賃", "初期費用", "お部屋の条件"] as const).map((pt) => {
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
                onClick={() => setPreviewExpanded(true)}
                className="w-full rounded-2xl bg-[#f0f2f5] px-4 py-3 text-left active:bg-[#e8eaed] transition-colors"
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#667781]">送信プレビュー</span>
                  <div className="flex items-center gap-2">
                    <div className="flex overflow-hidden rounded-full border border-[#d1d7db] text-[10px] font-bold">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUseEmoji(true); if (aiDraft) setPreview(aiDraft); }}
                        className={`px-2.5 py-0.5 transition-colors ${useEmoji ? "bg-[#2196F3] text-white" : "bg-white text-[#8696a0]"}`}
                      >絵文字あり</button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUseEmoji(false); if (aiDraft) setPreview(stripEmoji(aiDraft)); }}
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
                    {(["家賃", "初期費用", "お部屋の条件"] as const).map((pt) => {
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
              onClick={() => setPreviewExpanded(false)}
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
