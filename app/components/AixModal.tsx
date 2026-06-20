"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchCalendarSlots } from "../lib/calendarSlots";

export type AixActionType =
  | "property_recommendation"
  | "property_send"
  | "viewing_invite"
  | "application_push"
  | "estimate_sheet"
  | "property_check_result";

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
  recentMessages?: Array<{ sender: string; text: string }>;
  customerSummary?: string | null;
  onClose: () => void;
  onSend: (text: string, imageUrl?: string) => Promise<void>;
  onAfterSend?: () => void;
}

const AIX_TEMPLATES: Record<AixActionType, { rules: string[]; template: string }> = {
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
    emoji: "📋",
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
    emoji: "✅",
    requiresImage: false,
    imageLabel: "物件・部屋の画像を選択（任意）",
    description: "物件確認の結果をお客さんにLINEで報告します。",
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
  onClose,
  onSend,
  onAfterSend,
}: AixModalProps) {
  const config = CONFIG[actionType];

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  // 物件オススメ専用: お客さんの条件スクショ
  const [conditionImageFile, setConditionImageFile] = useState<File | null>(null);
  const [conditionImagePreview, setConditionImagePreview] = useState<string>("");
  // 物件オススメ専用: 室内イメージURL（任意）
  const [propertyImageUrl, setPropertyImageUrl] = useState("");
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [aiDraft, setAiDraft] = useState<string>("");
  const [parsedEstimate, setParsedEstimate] = useState<Record<string, string> | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [showTemplateInfo, setShowTemplateInfo] = useState(false);
  const [floorPlanTouched, setFloorPlanTouched] = useState(false);
  // 物件確認した専用
  const [checkPattern, setCheckPattern] = useState<"available" | "alternative" | "unavailable" | null>(null);
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
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  // 退去確認ボタン専用: 構造化された退去予定物件リスト
  const [vacatingProperties, setVacatingProperties] = useState<Array<{name: string; moveOut: string; editingDate: boolean}>>([]);
  const [vacatingCheckLoading, setVacatingCheckLoading] = useState(false);
  const [calendarInfo, setCalendarInfo] = useState<string>("");
  const [calendarDays, setCalendarDays] = useState<Array<{
    label: string; slots: string[]; fullyBooked: boolean; noEvents: boolean;
  }>>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  // 物件送る専用: 内覧誘導 or 申込み誘導 モード + 編集可能スロット
  const [sendMode, setSendMode] = useState<"viewing" | "application">("viewing");
  const [editableCalendarSlots, setEditableCalendarSlots] = useState<string[]>([]);
  const [includeCalendar, setIncludeCalendar] = useState(true);
  // 申込へ！専用: 空室状況 + 退去予定日
  const [appVacancyStatus, setAppVacancyStatus] = useState<"vacant" | "scheduled" | null>(null);
  const [appMoveOutDate, setAppMoveOutDate] = useState("");
  // 物件オススメ専用: analyze-propertyで自動抽出した退去予定日
  const [propMoveOutDate, setPropMoveOutDate] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const conditionFileInputRef = useRef<HTMLInputElement | null>(null);
  const checkFileInputRef = useRef<HTMLInputElement | null>(null);
  const checkEstimateInputRef = useRef<HTMLInputElement | null>(null);
  const sendFileInputRef = useRef<HTMLInputElement | null>(null);

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

      // 画像から物件情報を自動解析
      setAnalyzeLoading(true);
      try {
        const images = dataUrls.map(url => {
          const [header, base64] = url.split(",");
          const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
          return { base64, mediaType };
        });
        const res = await fetch("/api/aix/analyze-property", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images }),
        });
        const data = await res.json() as { ok: boolean; vacating_note?: string };
        if (data.ok && data.vacating_note) {
          setVacatingNote(data.vacating_note);
        }
      } catch {
        // 解析失敗は無視
      } finally {
        setAnalyzeLoading(false);
      }
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
      .map((p) => `◎${p.name}は${p.moveOut ? p.moveOut + "退去予定" : "退去予定"}となりますのでお部屋ご案内出来ない形となります！！`)
      .join("\n");
    setVacatingNote(note);
  };

  // 退去確認ボタン: 全画像を分析して退去予定物件を構造化リストに展開
  const handleVacatingCheck = async () => {
    if (sendImagePreviews.length === 0 || vacatingCheckLoading) return;
    setVacatingCheckLoading(true);
    try {
      const images = sendImagePreviews.map((url) => {
        const [header, base64] = url.split(",");
        const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
        return { base64, mediaType };
      });
      const res = await fetch("/api/aix/analyze-property", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = await res.json() as { ok: boolean; properties?: Array<{name: string; status: string; move_out: string}> };
      if (data.ok && data.properties) {
        const scheduled = data.properties
          .filter((p) => p.status === "scheduled" && p.name)
          .map((p) => ({ name: p.name, moveOut: p.move_out || "", editingDate: false }));
        setVacatingProperties(scheduled);
        syncVacatingNote(scheduled);
      }
    } catch {
      // 失敗時は無視
    } finally {
      setVacatingCheckLoading(false);
    }
  };

  const uploadImage = async (file: File): Promise<string> => {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${conversationId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("property-images")
      .upload(path, file, { upsert: true });
    if (uploadError) throw new Error("画像のアップロードに失敗しました: " + uploadError.message);

    const { data } = supabase.storage.from("property-images").getPublicUrl(path);
    return data.publicUrl;
  };

  const generate = async () => {
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
            uploadImage(conditionImageFile),
            uploadImage(imageFile),
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
          const urls = await Promise.all(sendImageFiles.map(f => uploadImage(f)));
          body.image_urls = urls;
        }
        if (vacatingNote.trim()) body.vacating_note = vacatingNote.trim();
        body.send_mode = sendMode;
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
      } else if (actionType === "application_push") {
        if (!appVacancyStatus) throw new Error("空室状況を選択してください");
        body.vacancy_status = appVacancyStatus;
        if (appMoveOutDate.trim()) body.move_out_date = appMoveOutDate.trim();
        // 直近スタッフメッセージから見積書送信済みを自動検出
        const staffMsgs = (recentMessages || []).filter(m => m.sender === "staff").slice(-15);
        const hasEstimate = staffMsgs.some(m => /見積|御見積|初期費用/.test(m.text));
        body.has_estimate = hasEstimate;
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        if (customerSummary) body.customer_summary = customerSummary;
      } else if (actionType === "property_check_result") {
        if (!checkPattern) throw new Error("確認結果を選択してください");
        body.check_pattern = checkPattern;
        if (checkPattern === "alternative") {
          if (!checkFloorPlan) { setFloorPlanTouched(true); throw new Error("代替お部屋の間取りを選択してください"); }
          if (checkEndedFloor !== null) body.ended_floor = checkEndedFloor;
          if (checkEndedUnit.trim()) body.ended_unit = checkEndedUnit.trim();
          body.floor_plan_match = checkFloorPlan;
        }
        if (checkEstimateFile) body.estimate_image_url = await uploadImage(checkEstimateFile);
        if (checkImageFiles.length > 0) {
          const urls = await Promise.all(checkImageFiles.map(f => uploadImage(f)));
          body.image_urls = urls;
          body.image_url = urls[0];
        }
        if (checkPattern === "available" && showCheckCalendar && checkCalendarInfo) body.calendar_info = checkCalendarInfo;
        if (checkPattern === "available" && checkAvailableApp) body.available_application = checkAvailableApp;
        if (recentMessages && recentMessages.length > 0) body.recent_messages = recentMessages;
        if (customerSummary) body.customer_summary = customerSummary;
      } else if (config.requiresImage && imageFile) {
        body.image_url = await uploadImage(imageFile);
      }

      if (inputText.trim()) body.extra_input = inputText.trim();
      if (parsedEstimate) body.parsed_estimate = parsedEstimate;

      const res = await fetch("/api/aix/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "生成に失敗しました");

      setPreview(data.message_text || "");
      setAiDraft(data.message_text || "");
      if (data.parsed_estimate) setParsedEstimate(data.parsed_estimate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const ACTION_TO_STATE: Record<AixActionType, string> = {
    property_recommendation: "property_recommendation",
    property_send: "proposing",
    viewing_invite: "viewing",
    application_push: "application",
    estimate_sheet: "estimate_request",
    property_check_result: "proposing",
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
        // ①物件資料画像 → ②見積書画像 → ③文書 の順で送信
        for (const file of checkImageFiles) {
          const url = await uploadImage(file);
          await onSend("", url);
        }
        if (checkEstimateFile) {
          const estUrl = await uploadImage(checkEstimateFile);
          await onSend("", estUrl);
        }
        await onSend(preview);
      } else {
        // 物件オススメは物件資料画像をLINEに添付
        let uploadedImageUrl: string | undefined;
        if (actionType === "property_recommendation" && imageFile) {
          uploadedImageUrl = await uploadImage(imageFile);
        } else if (config.requiresImage && imageFile) {
          uploadedImageUrl = await uploadImage(imageFile);
        }
        await onSend(preview, uploadedImageUrl);

        // 室内イメージURLがあれば「（室内イメージ）\nURL」として別送信
        if (actionType === "property_recommendation" && propertyImageUrl.trim()) {
          await onSend(`（室内イメージ）\n${propertyImageUrl.trim()}`);
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

      onAfterSend?.();
      onClose();
    } catch {
      setError("送信に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  // 生成ボタンが押せるか
  const canGenerate = actionType === "property_recommendation"
    ? !!imageFile
    : actionType === "property_check_result"
    ? !!checkPattern
    : actionType === "property_send"
    ? true
    : actionType === "application_push"
    ? !!appVacancyStatus
    : !config.requiresImage || !!imageFile;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl md:rounded-3xl">
        {/* ヘッダー */}
        <div className="flex items-center justify-between rounded-t-3xl px-5 py-4"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          <div className="text-[17px] font-bold text-white">
            {config.emoji} {config.title}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTemplateInfo(v => !v)}
              className="flex items-center gap-1 rounded-full bg-white/20 px-3 py-1 text-xs font-medium text-white hover:bg-white/30"
            >
              📋 テンプレ確認
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30"
            >
              ✕
            </button>
          </div>
        </div>


        <div className="max-h-[75vh] overflow-y-auto p-5">
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
            </div>
          ) : actionType === "property_send" ? (
            /* 物件送る: モード選択 + カレンダー自動取得 + 複数画像 + 退去予定メモ */
            <div className="mb-4 flex flex-col gap-3">
              {/* モード選択 */}
              <div>
                <p className="mb-1.5 text-xs font-bold text-[#54656f]">送るモードを選択</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setSendMode("viewing"); setPreview(""); }}
                    className={`flex-1 rounded-full py-2.5 text-sm font-bold transition-all ${
                      sendMode === "viewing"
                        ? "bg-[#2196F3] text-white shadow-sm"
                        : "border border-[#d1d7db] bg-white text-[#54656f]"
                    }`}
                  >
                    内覧誘導
                  </button>
                  <button
                    onClick={() => { setSendMode("application"); setPreview(""); }}
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
                  📷 {sendImagePreviews.length > 0 ? `追加する（現在${sendImagePreviews.length}枚）` : "物件画像を追加する（スキップ可）"}
                </button>
                <input ref={sendFileInputRef} type="file" accept="image/*" multiple onChange={onSelectSendImages} className="hidden" />
              </div>
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
                      <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />確認中</>
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
                {/* 構造化リストがない場合はテキストエリア（手動編集用フォールバック） */}
                {vacatingProperties.length === 0 && (
                  <textarea
                    value={vacatingNote}
                    onChange={(e) => setVacatingNote(e.target.value)}
                    placeholder="退去確認ボタンで自動読み取り、または直接入力"
                    rows={2}
                    className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                  />
                )}
              </div>
            </div>
          ) : actionType === "application_push" ? (
            /* 申込へ！: 空室状況選択 + 見積書自動検出 */
            <div className="mb-4 flex flex-col gap-3">
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
                    { key: "available",    label: "物件あった",         sub: "入居可能",                  color: "emerald" },
                    { key: "alternative",  label: "別の部屋が募集してた", sub: "満室だが代替あり",          color: "blue"    },
                    { key: "unavailable",  label: "物件なかった",        sub: "満室・空きなし（画像不要）", color: "orange"  },
                  ] as const).map((p) => (
                    <button
                      key={p.key}
                      onClick={() => { setCheckPattern(p.key); setPreview(""); setCheckAvailableApp(null); setShowCheckCalendar(false); }}
                      className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-all ${
                        checkPattern === p.key
                          ? p.color === "emerald" ? "border-emerald-400 bg-emerald-50"
                          : p.color === "blue"    ? "border-blue-400 bg-blue-50"
                          :                         "border-orange-400 bg-orange-50"
                          : "border-[#e9edef] bg-[#f8f9fa]"
                      }`}
                    >
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 flex-shrink-0 ${
                        checkPattern === p.key
                          ? p.color === "emerald" ? "border-emerald-500 bg-emerald-500"
                          : p.color === "blue"    ? "border-blue-500 bg-blue-500"
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
              {/* 物件あった: 申込状況 */}
              {checkPattern === "available" && (
                <div className="mb-1">
                  <p className="mb-1.5 text-xs font-bold text-[#54656f]">申込状況 <span className="font-normal text-[#90a4ae]">（任意）</span></p>
                  <div className="flex gap-2">
                    {([{ key: "yes", label: "申込あり", icon: "🔴" }, { key: "no", label: "申込なし", icon: "🟢" }] as const).map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => setCheckAvailableApp(checkAvailableApp === opt.key ? null : opt.key)}
                        className={`flex-1 rounded-xl border py-2 text-sm font-bold transition ${checkAvailableApp === opt.key ? "border-[#1565C0] bg-[#e3f0ff] text-[#1565C0]" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                      >{opt.icon} {opt.label}</button>
                    ))}
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

              {/* 物件あった・別の部屋: 複数画像 */}
              {(checkPattern === "available" || checkPattern === "alternative") && (
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
                    📷 {checkImagePreviews.length > 0 ? `追加する（現在${checkImagePreviews.length}枚）` : "画像を追加する（スキップ可）"}
                  </button>
                  <input ref={checkFileInputRef} type="file" accept="image/*" multiple onChange={onSelectCheckImages} className="hidden" />
                </div>
              )}
              {/* 物件あった・別の部屋: 見積書画像（任意） */}
              {(checkPattern === "available" || checkPattern === "alternative") && (
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
                      📋 見積書を追加する（スキップ可）
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
                  <button
                    onClick={() => setShowCheckCalendar(v => !v)}
                    className={`w-full rounded-xl border py-2 text-sm font-bold transition ${showCheckCalendar ? "border-[#1565C0] bg-[#e3f0ff] text-[#1565C0]" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                  >
                    📅 内覧誘導{showCheckCalendar ? "（オン）" : "（オフ）"}
                  </button>
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

          {/* テキスト入力欄（各アクション専用） */}
          {config.inputLabel && actionType !== "property_send" && (
            <div className="mb-4">
              <label className="mb-1 block text-xs font-semibold text-[#54656f]">
                {config.inputLabel}
              </label>
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
                  <span className="text-[10px] font-bold text-blue-500">✏️ タップして編集</span>
                </div>
                <p className="text-sm leading-6 text-[#111b21] line-clamp-4 whitespace-pre-wrap">{preview}</p>
              </button>
              {(preview.includes("[物件名]") || preview.includes("[物件名と号室]")) && (
                <div className="mt-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
                  ⚠️ 物件名が特定できませんでした。送信前に直接編集してください。
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
          )}

          {/* ボタン */}
          <div className="flex gap-2">
            {preview ? (
              <>
                <button
                  onClick={generate}
                  disabled={loading || !canGenerate}
                  className="flex-1 rounded-full border border-[#d1d7db] py-3 text-sm font-semibold text-[#54656f] disabled:opacity-50"
                >
                  {loading ? "生成中..." : "再生成"}
                </button>
                <button
                  onClick={handleSend}
                  disabled={loading}
                  className="flex-1 rounded-full bg-[#06c755] py-3 text-sm font-bold text-white disabled:opacity-50"
                >
                  {loading ? "送信中..." : "送信する"}
                </button>
              </>
            ) : (
              <button
                onClick={generate}
                disabled={loading || !canGenerate}
                className="w-full rounded-full bg-[#111b21] py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {loading ? "生成中..." : "✨ AIX 生成"}
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
