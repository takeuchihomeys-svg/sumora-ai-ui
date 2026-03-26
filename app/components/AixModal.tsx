"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

export type AixActionType =
  | "property_recommendation"
  | "viewing_invite"
  | "application_push"
  | "estimate_sheet";

interface AixModalProps {
  actionType: AixActionType;
  conversationId: string;
  customerName: string;
  initialImageFile?: File;
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
};

const WORKERS_URL = "https://sumora-line-ai.takeuchi-homeys.workers.dev";

export default function AixModal({
  actionType,
  conversationId,
  customerName,
  initialImageFile,
  onClose,
  onSend,
}: AixModalProps) {
  const config = CONFIG[actionType];

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [parsedEstimate, setParsedEstimate] = useState<Record<string, string> | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

      let imageUrl: string | undefined;
      if (config.requiresImage && imageFile) {
        imageUrl = await uploadImage(imageFile);
      }

      const body: Record<string, unknown> = {
        action: actionType,
        conversation_id: conversationId,
        customer_name: customerName,
      };
      if (imageUrl) body.image_url = imageUrl;
      if (inputText.trim()) body.extra_input = inputText.trim();
      if (parsedEstimate) body.parsed_estimate = parsedEstimate;

      const res = await fetch(`${WORKERS_URL}/api/aix/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "生成に失敗しました");

      setPreview(data.message_text || "");
      if (data.parsed_estimate) setParsedEstimate(data.parsed_estimate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!preview.trim()) return;
    try {
      setLoading(true);
      // 画像ありアクション（物件オススメ・見積書）はimageUrlも一緒に送る
      let uploadedImageUrl: string | undefined;
      if (config.requiresImage && imageFile) {
        uploadedImageUrl = await uploadImage(imageFile);
      }
      await onSend(preview, uploadedImageUrl);
      onClose();
    } catch {
      setError("送信に失敗しました");
    } finally {
      setLoading(false);
    }
  };

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

          {/* 画像エリア */}
          {config.requiresImage && (
            <div className="mb-4">
              {imagePreview ? (
                <div className="relative mb-2 overflow-hidden rounded-2xl border border-[#d1d7db]">
                  <img
                    src={imagePreview}
                    alt="選択画像"
                    className="max-h-48 w-full object-contain"
                  />
                  <button
                    onClick={() => {
                      setImageFile(null);
                      setImagePreview("");
                      setPreview("");
                      setParsedEstimate(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="absolute right-2 top-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white"
                  >
                    変更
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-200 py-6 text-sm font-semibold text-[#2196F3] hover:bg-blue-50"
                >
                  📷 {config.imageLabel}
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onSelectImage}
                className="hidden"
              />
            </div>
          )}

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
            <div className="mb-4 rounded-2xl bg-[#f0f2f5] px-4 py-3">
              <div className="mb-1 text-xs font-semibold text-[#667781]">送信プレビュー</div>
              <textarea
                value={preview}
                onChange={(e) => setPreview(e.target.value)}
                rows={5}
                className="w-full resize-none bg-transparent text-sm leading-6 text-[#111b21] outline-none"
              />
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
                  disabled={loading || (config.requiresImage && !imageFile)}
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
                disabled={loading || (config.requiresImage && !imageFile)}
                className="w-full rounded-full bg-[#111b21] py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {loading ? "生成中..." : "✨ AIX 生成"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
