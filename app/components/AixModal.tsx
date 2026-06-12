"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

export type AixActionType =
  | "property_recommendation"
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
  onClose: () => void;
  onSend: (text: string, imageUrl?: string) => Promise<void>;
}

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
    emoji: "🔍",
    requiresImage: false,
    imageLabel: "",
    description: "内覧の日程調整メッセージをLINEで送ります。",
    inputLabel: "候補日時（任意）",
    inputPlaceholder: "例：3/28（金）14時、3/29（土）午後...",
  },
  application_push: {
    title: "申込へ！",
    emoji: "✋",
    requiresImage: false,
    imageLabel: "",
    description: "申込を後押しするメッセージをLINEで送ります。",
    inputLabel: "補足情報（任意）",
    inputPlaceholder: "例：審査書類の準備が整っています...",
  },
  estimate_sheet: {
    title: "見積書送る",
    emoji: "💰",
    requiresImage: true,
    imageLabel: "見積書画像を選択",
    description: "見積書の画像をAIが読み取り、初期費用の内訳をLINEで送ります。",
  },
  property_check_result: {
    title: "物件確認した",
    emoji: "🔎",
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
  onClose,
  onSend,
}: AixModalProps) {
  const config = CONFIG[actionType];

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  // 物件オススメ専用: お客さんの条件スクショ
  const [conditionImageFile, setConditionImageFile] = useState<File | null>(null);
  const [conditionImagePreview, setConditionImagePreview] = useState<string>("");
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [aiDraft, setAiDraft] = useState<string>("");
  const [parsedEstimate, setParsedEstimate] = useState<Record<string, string> | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  // 物件確認した専用
  const [checkPattern, setCheckPattern] = useState<"available" | "alternative" | "unavailable" | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const conditionFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialImageFile) {
      setImageFile(initialImageFile);
      const reader = new FileReader();
      reader.onload = () => setImagePreview(String(reader.result ?? ""));
      reader.readAsDataURL(initialImageFile);
    }
  }, []);

  const onSelectImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(String(reader.result ?? ""));
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
      } else if (actionType === "property_check_result") {
        if (!checkPattern) throw new Error("確認結果を選択してください");
        body.check_pattern = checkPattern;
        if (imageFile) body.image_url = await uploadImage(imageFile);
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
    viewing_invite: "viewing",
    application_push: "application",
    estimate_sheet: "estimate_request",
    property_check_result: "proposing",
  };

  const handleSend = async () => {
    if (!preview.trim()) return;
    try {
      setLoading(true);
      // 物件オススメは物件資料画像をLINEに添付
      let uploadedImageUrl: string | undefined;
      if (actionType === "property_recommendation" && imageFile) {
        uploadedImageUrl = await uploadImage(imageFile);
      } else if (config.requiresImage && imageFile) {
        uploadedImageUrl = await uploadImage(imageFile);
      }
      await onSend(preview, uploadedImageUrl);

      // 学習ループに保存（fire-and-forget）
      fetch("/api/save-reply-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationState: ACTION_TO_STATE[actionType],
          customerMessage: inputText.trim() || `（AIX: ${config.title}）`,
          sentReply: preview,
          aiDraft,
        }),
      }).catch(() => {});

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
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30"
          >
            ✕
          </button>
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
                      onClick={() => { setCheckPattern(p.key); setPreview(""); }}
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
              {/* 物件あった・別の部屋: 任意画像 */}
              {(checkPattern === "available" || checkPattern === "alternative") && (
                <div>
                  <p className="mb-1 text-xs font-bold text-[#54656f]">
                    物件・部屋の画像 <span className="font-normal text-[#90a4ae]">（任意）</span>
                  </p>
                  {imagePreview ? (
                    <div className="relative overflow-hidden rounded-2xl border border-[#d1d7db]">
                      <img src={imagePreview} alt="物件画像" className="max-h-36 w-full object-contain" />
                      <button
                        onClick={() => { setImageFile(null); setImagePreview(""); setPreview(""); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                        className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                      >変更</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#d1d7db] py-4 text-sm font-semibold text-[#90a4ae] hover:bg-[#f5f6f7]"
                    >📷 画像を添付する（スキップ可）</button>
                  )}
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={onSelectImage} className="hidden" />
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
          {config.inputLabel && (
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
