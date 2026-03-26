"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AixModal, { type AixActionType } from "./components/AixModal";
import BottomNav from "./components/BottomNav";
import TemplateModal from "./components/TemplateModal";
import { supabase } from "./lib/supabase";

type Message = {
  id: string;
  sender: "customer" | "staff";
  text: string;
  imageUrl?: string;
  time: string;
  rawCreatedAt?: string;
};

type Conversation = {
  id: string;
  customerName: string;
  lastMessage: string;
  status: string;
  lineUserId: string;
  profileImageUrl?: string;
  updatedAt?: string;
  messages: Message[];
};

type SupabaseConversationRow = {
  id: number;
  customer_name: string | null;
  status: string | null;
  line_user_id: string;
  last_message?: string | null;
  updated_at?: string | null;
  profile_image_url?: string | null;
};

type SupabaseMessageRow = {
  id: number;
  conversation_id: number;
  sender: "customer" | "staff";
  text: string;
  image_url?: string | null;
  created_at: string;
};

// 画面表示用グループ（5種類）
const DISPLAY_GROUPS = [
  {
    key: "initial",
    label: "初回応対",
    statuses: ["first_reply", "condition_hearing"],
    color: "bg-sky-100 text-sky-700",
    dot: "bg-sky-500",
    canonicalStatus: "first_reply",
  },
  {
    key: "searching",
    label: "物件探し中",
    statuses: ["property_search", "property_recommendation", "viewing", "estimate_request", "availability_check", "application"],
    color: "bg-amber-100 text-amber-700",
    dot: "bg-amber-500",
    canonicalStatus: "property_search",
  },
  {
    key: "screening",
    label: "審査中",
    statuses: ["screening"],
    color: "bg-pink-100 text-pink-700",
    dot: "bg-pink-500",
    canonicalStatus: "screening",
  },
  {
    key: "contract",
    label: "契約準備中",
    statuses: ["contract"],
    color: "bg-indigo-100 text-indigo-700",
    dot: "bg-indigo-500",
    canonicalStatus: "contract",
  },
  {
    key: "closed",
    label: "ご成約",
    statuses: ["closed_won"],
    color: "bg-green-100 text-green-700",
    dot: "bg-green-500",
    canonicalStatus: "closed_won",
  },
];

function getGroupMeta(statusKey: string) {
  return (
    DISPLAY_GROUPS.find((g) => g.statuses.includes(statusKey)) ?? {
      key: "unknown",
      label: "未設定",
      statuses: [],
      color: "bg-gray-100 text-gray-700",
      dot: "bg-gray-400",
      canonicalStatus: statusKey,
    }
  );
}

function getInitial(name: string) {
  return name?.trim()?.charAt(0) || "?";
}

function formatTime(dateString: string) {
  const date = new Date(dateString);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatListTime(dateString?: string) {
  if (!dateString) return "";
  const date = new Date(dateString);
  const now = new Date();

  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isSameDay) {
    return formatTime(dateString);
  }

  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [replyDraft, setReplyDraft] = useState("");
  const [pageLoading, setPageLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [error, setError] = useState("");
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showAixMenu, setShowAixMenu] = useState(false);
  const [showGroupFilter, setShowGroupFilter] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [inputFocused, setInputFocused] = useState(false);
  const [pullStartY, setPullStartY] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [selectedImageFiles, setSelectedImageFiles] = useState<File[]>([]);
  const [selectedImagePreviews, setSelectedImagePreviews] = useState<string[]>([]);
  const [aixModalType, setAixModalType] = useState<AixActionType | null>(null);
  const [aixInitialFile, setAixInitialFile] = useState<File | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [flaggedConvIds, setFlaggedConvIds] = useState<Set<string>>(new Set());
  const convLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const aixFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAixTypeRef = useRef<AixActionType | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchConversationsAndMessages();

    // Supabase real-time: 新しいメッセージをリアルタイム反映
    const channel = supabase
      .channel("realtime-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        () => {
          fetchConversationsAndMessages();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [selectedId, conversations]);

  const fetchConversationsAndMessages = async () => {
    setPageLoading(true);
    setError("");

    const { data: conversationRows, error: conversationError } = await supabase
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false });

    if (conversationError) {
      console.error(conversationError);
      setError("会話一覧の取得に失敗しました。");
      setPageLoading(false);
      return;
    }

    const { data: messageRows, error: messageError } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true });

    if (messageError) {
      console.error(messageError);
      setError("メッセージの取得に失敗しました。");
      setPageLoading(false);
      return;
    }

    const conversationsData = (conversationRows || []) as SupabaseConversationRow[];
    const messagesData = (messageRows || []) as SupabaseMessageRow[];

    const formatted: Conversation[] = conversationsData.map((conversation) => {
      const relatedMessages = messagesData
        .filter((message) => message.conversation_id === conversation.id)
        .map((message) => ({
          id: String(message.id),
          sender: message.sender,
          text: message.text,
          imageUrl: message.image_url || undefined,
          time: formatTime(message.created_at),
          rawCreatedAt: message.created_at,
        }));

      const lastMessage =
        relatedMessages.length > 0
          ? relatedMessages[relatedMessages.length - 1].text
          : conversation.last_message || "メッセージなし";

      return {
        id: String(conversation.id),
        customerName: conversation.customer_name || "名称未設定",
        lastMessage,
        status: conversation.status || "first_reply",
        lineUserId: conversation.line_user_id,
        profileImageUrl: conversation.profile_image_url || undefined,
        updatedAt: conversation.updated_at || undefined,
        messages: relatedMessages,
      };
    });

    setConversations(formatted);

    if (formatted.length > 0) {
      setSelectedId((prev) => prev || formatted[0].id);
    }

    setPageLoading(false);
  };

  const filteredConversations = useMemo(() => {
    if (statusFilter === "all") return conversations;
    const group = DISPLAY_GROUPS.find((g) => g.key === statusFilter);
    if (!group) return conversations;
    return conversations.filter((c) => group.statuses.includes(c.status));
  }, [conversations, statusFilter]);

  useEffect(() => {
    if (filteredConversations.length === 0) return;

    const exists = filteredConversations.some((conversation) => conversation.id === selectedId);
    if (!exists) {
      setSelectedId(filteredConversations[0].id);
    }
  }, [filteredConversations, selectedId]);

  const selectedConversation = useMemo(() => {
    if (filteredConversations.length === 0) {
      return {
        id: "",
        customerName: "",
        lastMessage: "",
        status: "first_reply",
        lineUserId: "",
        updatedAt: "",
        messages: [],
      };
    }

    return (
      filteredConversations.find((conversation) => conversation.id === selectedId) ??
      filteredConversations[0]
    );
  }, [filteredConversations, selectedId]);

  useEffect(() => {
    setReplyDraft("");
    setError("");
    setShowStatusMenu(false);
    setShowAixMenu(false);
    setSelectedImageFiles([]);
    setSelectedImagePreviews([]);
  }, [selectedConversation.id]);

  const latestCustomerMessage = useMemo(() => {
    const customerMessages = selectedConversation.messages.filter(
      (message) => message.sender === "customer"
    );
    return customerMessages[customerMessages.length - 1]?.text ?? "";
  }, [selectedConversation]);

  const statusMeta = getGroupMeta(selectedConversation.status);

  const updateConversationStatus = async (nextStatus: string) => {
    if (!selectedConversation.id) return;

    try {
      setStatusSaving(true);
      setError("");

      const { error: updateError } = await supabase
        .from("conversations")
        .update({
          status: nextStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", Number(selectedConversation.id));

      if (updateError) throw updateError;

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === selectedConversation.id
            ? {
                ...conversation,
                status: nextStatus,
                updatedAt: new Date().toISOString(),
              }
            : conversation
        )
      );

      setShowStatusMenu(false);
    } catch (updateError) {
      console.error(updateError);
      setError("状態の更新に失敗しました。");
    } finally {
      setStatusSaving(false);
    }
  };

  const generateReply = async () => {
    if (!latestCustomerMessage.trim()) return;

    try {
      setGenerating(true);
      setError("");

      const res = await fetch(
        `https://sumora-line-ai.takeuchi-homeys.workers.dev/debug/reply?message=${encodeURIComponent(
          latestCustomerMessage
        )}&state=${encodeURIComponent(selectedConversation.status)}`
      );

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "返信案取得失敗");
      }

      setReplyDraft(data.ai_reply || "");
    } catch (requestError) {
      console.error(requestError);
      setError("返信案の作成に失敗しました。");
    } finally {
      setGenerating(false);
    }
  };

  const openImagePicker = () => {
    fileInputRef.current?.click();
  };

  const onSelectImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, 10);
    if (files.length === 0) return;
    setSelectedImageFiles(files);
    const previews: string[] = new Array(files.length).fill("");
    let loaded = 0;
    files.forEach((file, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        previews[i] = String(reader.result || "");
        loaded++;
        if (loaded === files.length) setSelectedImagePreviews([...previews]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeSelectedImage = (index?: number) => {
    if (index !== undefined) {
      setSelectedImageFiles((prev) => prev.filter((_, i) => i !== index));
      setSelectedImagePreviews((prev) => prev.filter((_, i) => i !== index));
    } else {
      setSelectedImageFiles([]);
      setSelectedImagePreviews([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const toggleFlagged = (id: string) => {
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startLongPress = (id: string) => {
    longPressTimerRef.current = setTimeout(() => toggleFlagged(id), 500);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  };

  const toggleFlaggedConv = (id: string) => {
    setFlaggedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startConvLongPress = (id: string) => {
    convLongPressTimerRef.current = setTimeout(() => toggleFlaggedConv(id), 500);
  };
  const cancelConvLongPress = () => {
    if (convLongPressTimerRef.current) clearTimeout(convLongPressTimerRef.current);
  };

  const uploadImageToStorage = async (file: File): Promise<string> => {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `messages/${selectedConversation.id}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("property-images")
      .upload(path, file, { upsert: false });
    if (uploadError) {
      throw new Error(`画像アップロード失敗: ${uploadError.message} [${uploadError.statusCode ?? ""}]`);
    }
    const { data } = supabase.storage.from("property-images").getPublicUrl(path);
    return data.publicUrl;
  };

  const sendReply = async () => {
    if (!selectedConversation.id) return;
    if (!replyDraft.trim() && selectedImageFiles.length === 0) return;

    try {
      setSending(true);
      setError("");

      const now = new Date();
      const textToSend = replyDraft.trim();

      // 全画像をアップロード
      const imageUrls: string[] = [];
      for (const file of selectedImageFiles) {
        const url = await uploadImageToStorage(file);
        imageUrls.push(url);
      }

      const newMessages: Message[] = [];

      // テキストメッセージを保存
      if (textToSend) {
        const { data: textRow, error: textInsertError } = await supabase
          .from("messages")
          .insert({
            conversation_id: Number(selectedConversation.id),
            sender: "staff",
            text: textToSend,
            created_at: now.toISOString(),
          })
          .select();
        if (textInsertError) throw textInsertError;
        newMessages.push({
          id: String(textRow?.[0]?.id || crypto.randomUUID()),
          sender: "staff",
          text: textToSend,
          time: formatTime(now.toISOString()),
          rawCreatedAt: now.toISOString(),
        });
      }

      // 画像メッセージを1枚ずつ保存
      for (const imageUrl of imageUrls) {
        const imgNow = new Date();
        const { data: imgRow, error: imgInsertError } = await supabase
          .from("messages")
          .insert({
            conversation_id: Number(selectedConversation.id),
            sender: "staff",
            text: "[画像]",
            image_url: imageUrl,
            created_at: imgNow.toISOString(),
          })
          .select();
        if (imgInsertError) throw imgInsertError;
        newMessages.push({
          id: String(imgRow?.[0]?.id || crypto.randomUUID()),
          sender: "staff",
          text: "[画像]",
          imageUrl: imageUrl,
          time: formatTime(imgNow.toISOString()),
          rawCreatedAt: imgNow.toISOString(),
        });
      }

      const lastText = imageUrls.length > 0 ? "[画像]" : textToSend;
      await supabase
        .from("conversations")
        .update({ last_message: lastText, updated_at: now.toISOString() })
        .eq("id", Number(selectedConversation.id));

      setConversations((prev) =>
        prev
          .map((conversation) =>
            conversation.id === selectedConversation.id
              ? {
                  ...conversation,
                  lastMessage: lastText,
                  updatedAt: now.toISOString(),
                  messages: [...conversation.messages, ...newMessages],
                }
              : conversation
          )
          .sort((a, b) => {
            const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return bTime - aTime;
          })
      );

      // LINEに送信（テキスト→画像の順）
      try {
        if (textToSend) {
          await fetch("https://sumora-line-ai.takeuchi-homeys.workers.dev/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, message: textToSend }),
          });
        }
        for (const imageUrl of imageUrls) {
          await fetch("https://sumora-line-ai.takeuchi-homeys.workers.dev/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, image_url: imageUrl }),
          });
        }
      } catch {
        // LINE送信失敗しても管理画面の動作は続ける
      }

      setReplyDraft("");
      removeSelectedImage();
    } catch (sendError) {
      console.error(sendError);
      setError(sendError instanceof Error ? sendError.message : "送信に失敗しました。");
    } finally {
      setSending(false);
    }
  };

  const sendMessageText = async (text: string) => {
    if (!selectedConversation.id || !text.trim()) return;
    const now = new Date();
    const { data: insertedRows, error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: Number(selectedConversation.id),
        sender: "staff",
        text: text.trim(),
        created_at: now.toISOString(),
      })
      .select();
    if (insertError) throw insertError;

    await supabase
      .from("conversations")
      .update({ last_message: text.trim(), updated_at: now.toISOString() })
      .eq("id", Number(selectedConversation.id));

    const inserted = insertedRows?.[0];
    const newMessage: Message = {
      id: String(inserted?.id || crypto.randomUUID()),
      sender: "staff",
      text: text.trim(),
      time: formatTime(now.toISOString()),
      rawCreatedAt: now.toISOString(),
    };

    setConversations((prev) =>
      prev
        .map((conversation) =>
          conversation.id === selectedConversation.id
            ? {
                ...conversation,
                lastMessage: text.trim(),
                updatedAt: now.toISOString(),
                messages: [...conversation.messages, newMessage],
              }
            : conversation
        )
        .sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        })
    );
  };

  const openAixWithImagePicker = (type: AixActionType) => {
    pendingAixTypeRef.current = type;
    setAixInitialFile(null);
    aixFileInputRef.current?.click();
  };

  const onAixImageSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pendingAixTypeRef.current) return;
    setAixInitialFile(file);
    setAixModalType(pendingAixTypeRef.current);
    pendingAixTypeRef.current = null;
    if (aixFileInputRef.current) aixFileInputRef.current.value = "";
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (listRef.current && listRef.current.scrollTop === 0) {
      setPullStartY(e.touches[0].clientY);
    }
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (pullStartY > 0 && e.touches[0].clientY - pullStartY > 60) {
      setIsPulling(true);
    }
  };
  const handleTouchEnd = () => {
    if (isPulling) fetchConversationsAndMessages();
    setPullStartY(0);
    setIsPulling(false);
  };

  const openConversation = (conversationId: string) => {
    setSelectedId(conversationId);
    setMobileView("chat");
  };

  const showListOnMobile = mobileView === "list";
  const showChatOnMobile = mobileView === "chat";

  return (
    <main
      className={`${showChatOnMobile ? "h-[100svh]" : "h-[calc(100svh-56px)]"} overflow-hidden bg-[#111b21]`}
      style={{
        WebkitTextSizeAdjust: "100%",
        touchAction: "manipulation",
      }}
    >
      <div className="mx-auto flex h-full w-full max-w-[1600px] overflow-hidden bg-white shadow-2xl">
        <aside
          className={`${
            showListOnMobile ? "flex" : "hidden"
          } w-full flex-col bg-white md:flex md:w-[390px] md:min-w-[390px] md:border-r md:border-[#dfe5e7]`}
        >
          <div className="border-b border-[#e9edef] bg-[#f0f2f5] px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
            <div className="relative flex items-center justify-between">
              <div className="text-[22px] font-bold tracking-tight text-[#111b21]">スモラ</div>
              <button
                onClick={() => setShowGroupFilter((v) => !v)}
                className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm"
                style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
              >
                {statusFilter === "all"
                  ? "すべて"
                  : DISPLAY_GROUPS.find((g) => g.key === statusFilter)?.label ?? "すべて"}
                <span className="text-xs">{showGroupFilter ? "▲" : "▼"}</span>
              </button>

              {showGroupFilter && (
                <div className="absolute right-0 top-full z-30 mt-2 w-44 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
                  <button
                    onClick={() => { setStatusFilter("all"); setShowGroupFilter(false); }}
                    className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold border-b border-[#f0f2f5] ${statusFilter === "all" ? "text-[#2196F3]" : "text-[#111b21]"} hover:bg-[#f5f6f6]`}
                  >
                    <span className="h-3 w-3 rounded-full bg-gray-300" />
                    すべて
                  </button>
                  {DISPLAY_GROUPS.map((g) => (
                    <button
                      key={g.key}
                      onClick={() => { setStatusFilter(g.key); setShowGroupFilter(false); }}
                      className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold border-b border-[#f0f2f5] last:border-b-0 ${statusFilter === g.key ? "text-[#2196F3]" : "text-[#111b21]"} hover:bg-[#f5f6f6]`}
                    >
                      <span className={`h-3 w-3 rounded-full ${g.dot}`} />
                      {g.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div
            ref={listRef}
            className="flex-1 overflow-y-auto bg-white"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {isPulling && (
              <div className="py-2 text-center text-xs text-[#2196F3]">↓ 離して更新</div>
            )}
            {pageLoading ? (
              <div className="p-4 text-sm text-[#667781]">読み込み中...</div>
            ) : filteredConversations.length === 0 ? (
              <div className="p-4 text-sm text-[#667781]">該当する会話がありません</div>
            ) : (
              filteredConversations.map((conversation) => {
                const isActive = conversation.id === selectedConversation.id;
                const groupMeta = getGroupMeta(conversation.status);

                const lastMsg = conversation.messages[conversation.messages.length - 1];
                const needsReply =
                  lastMsg?.sender === "customer" &&
                  conversation.status !== "closed_won";

                return (
                  <button
                    key={conversation.id}
                    onClick={() => openConversation(conversation.id)}
                    onTouchStart={() => startConvLongPress(conversation.id)}
                    onTouchEnd={cancelConvLongPress}
                    onTouchMove={cancelConvLongPress}
                    onContextMenu={(e) => { e.preventDefault(); toggleFlaggedConv(conversation.id); }}
                    className={`flex w-full items-center gap-3 border-b border-[#f0f2f5] px-4 py-3 text-left transition ${
                      isActive ? "bg-[#f0f2f5]" : "bg-white hover:bg-[#f5f6f6]"
                    }`}
                  >
                    <div className="relative shrink-0">
                      {conversation.profileImageUrl ? (
                        <img
                          src={conversation.profileImageUrl}
                          alt={conversation.customerName}
                          className="h-12 w-12 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-base font-bold text-[#0f8f44]">
                          {getInitial(conversation.customerName)}
                        </div>
                      )}
                      <span
                        className={`absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-white ${groupMeta.dot}`}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5 truncate">
                          <span className="truncate text-[14px] font-semibold text-[#111b21]">
                            {conversation.customerName}
                          </span>
                          {flaggedConvIds.has(conversation.id) && (
                            <span className="shrink-0 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-600">
                              要対応
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {needsReply && (
                            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                              style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                            >
                              未返信
                            </span>
                          )}
                          <span className="text-[11px] text-[#667781]">
                            {formatListTime(conversation.updatedAt)}
                          </span>
                        </div>
                      </div>

                      <div className="truncate text-[13px] text-[#667781]">
                        {conversation.lastMessage}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section
          className={`${
            showChatOnMobile ? "flex" : "hidden"
          } min-w-0 flex-1 flex-col md:flex`}
          style={{
            background: "linear-gradient(180deg, #deeeff 0%, #eef6ff 60%, #f5faff 100%)",
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <header className="border-b border-[#e9edef] px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))] backdrop-blur-md md:px-4"
            style={{ background: "rgba(255,255,255,0.88)" }}
          >
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMobileView("list")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[20px] text-[#111b21] md:hidden"
              >
                ←
              </button>

              {selectedConversation.id ? (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusMeta.dot}`} />
                    <span className="truncate text-[15px] font-semibold text-[#111b21]">
                      {selectedConversation.customerName}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="min-w-0 flex-1 text-[15px] font-semibold text-[#111b21]">会話を選択</div>
              )}

              {/* 更新ボタン */}
              <button
                onClick={fetchConversationsAndMessages}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] text-[#667781] hover:bg-[#f0f2f5]"
                title="最新メッセージを取得"
              >
                ↻
              </button>

              <div className="relative shrink-0">
                <button
                  onClick={() => {
                    setShowStatusMenu(!showStatusMenu);
                    setShowAixMenu(false);
                  }}
                  disabled={!selectedConversation.id || statusSaving}
                  className="rounded-full border border-[#d1d7db] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#111b21] shadow-sm"
                >
                  {statusSaving ? "更新中..." : statusMeta.label}
                </button>

                {showStatusMenu ? (
                  <div className="absolute right-0 top-full z-30 mt-2 w-44 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
                    {DISPLAY_GROUPS.map((g) => (
                      <button
                        key={g.key}
                        onClick={() => updateConversationStatus(g.canonicalStatus)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold hover:bg-[#f5f6f6] border-b border-[#f0f2f5] last:border-b-0 ${
                          g.statuses.includes(selectedConversation.status) ? "bg-[#f0f2f5]" : ""
                        }`}
                      >
                        <span className={`h-3 w-3 rounded-full ${g.dot}`} />
                        <span>{g.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
              {selectedConversation.messages.length === 0 ? (
                <div className="rounded-2xl bg-white px-4 py-6 text-center text-sm text-[#667781] shadow-sm">
                  メッセージがありません
                </div>
              ) : (
                selectedConversation.messages.map((message) => {
                  const isCustomer = message.sender === "customer";

                  return (
                    <div
                      key={message.id}
                      className={`flex flex-col gap-0.5 ${isCustomer ? "items-start" : "items-end"}`}
                    >
                      {flaggedIds.has(message.id) && (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-600">
                          ！要対応
                        </span>
                      )}
                      <div className={`flex items-end gap-1 ${isCustomer ? "justify-start" : "justify-end"}`}>
                        {!isCustomer && (
                          <span className="mb-0.5 shrink-0 text-[10px] leading-none text-[#667781]">
                            {message.time}
                          </span>
                        )}
                        <div
                          className="max-w-[86%] md:max-w-[74%]"
                          onTouchStart={() => startLongPress(message.id)}
                          onTouchEnd={cancelLongPress}
                          onTouchMove={cancelLongPress}
                          onContextMenu={(e) => { e.preventDefault(); toggleFlagged(message.id); }}
                        >
                          <div
                            className={`rounded-2xl text-[15px] leading-6 shadow-sm ${
                              isCustomer
                                ? "rounded-bl-md bg-white text-[#111b21]"
                                : "rounded-br-md bg-[#d9fdd3] text-[#111b21]"
                            } ${flaggedIds.has(message.id) ? "ring-2 ring-orange-300" : ""}`}
                          >
                            {message.imageUrl && (
                              <img
                                src={message.imageUrl}
                                alt="送信画像"
                                className="max-h-56 w-full rounded-2xl object-contain"
                                style={{ borderBottomLeftRadius: message.text ? 0 : undefined, borderBottomRightRadius: message.text ? 0 : undefined }}
                              />
                            )}
                            {message.text && message.text !== "[画像]" && (
                              <div className="whitespace-pre-wrap break-words px-4 py-2.5">{message.text}</div>
                            )}
                          </div>
                        </div>
                        {isCustomer && (
                          <span className="mb-0.5 shrink-0 text-[10px] leading-none text-[#667781]">
                            {message.time}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              {generating && (
                <div className="flex justify-end">
                  <div className="rounded-2xl rounded-br-md bg-white px-4 py-3 text-sm text-[#667781] shadow-sm">
                    返信案を生成中...
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          <div className="border-t border-[#d1d7db] bg-[#f0f2f5] px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 md:px-3">
            {error ? (
              <div className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
            ) : null}

            {selectedImagePreviews.length > 0 && (
              <div className="mb-2 flex gap-2 overflow-x-auto">
                {selectedImagePreviews.map((preview, i) => (
                  <div key={i} className="relative shrink-0">
                    <img src={preview} alt="preview" className="h-14 w-14 rounded-lg object-cover" />
                    <button
                      onClick={() => removeSelectedImage(i)}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* アクションボタン列（入力欄の上） */}
            <div className="mb-1.5 flex items-center gap-1.5">
              <button
                onClick={generateReply}
                disabled={generating || !selectedConversation.id}
                className="rounded-full border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-semibold text-[#8696a0] shadow-sm disabled:opacity-40"
              >
                {generating ? "生成中..." : "メッセージを作成"}
              </button>

              <div className="relative">
                <button
                  onClick={() => { setShowAixMenu(!showAixMenu); setShowStatusMenu(false); }}
                  className="rounded-full border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#111b21] shadow-sm"
                >
                  AIX
                </button>

                {showAixMenu && (
                  <div className="absolute bottom-[40px] left-0 z-30 w-48 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-2xl">
                    {[
                      { label: "🏠 物件オススメ", action: () => { setShowAixMenu(false); openAixWithImagePicker("property_recommendation"); } },
                      { label: "💰 見積書送る", action: () => { setShowAixMenu(false); openAixWithImagePicker("estimate_sheet"); } },
                      { label: "🔍 内覧へ！", action: () => { setShowAixMenu(false); setAixInitialFile(null); setAixModalType("viewing_invite"); } },
                      { label: "✋ 申込へ！", action: () => { setShowAixMenu(false); setAixInitialFile(null); setAixModalType("application_push"); } },
                    ].map((item, i, arr) => (
                      <button
                        key={item.label}
                        onClick={item.action}
                        className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-[#111b21] hover:bg-blue-50 ${i < arr.length - 1 ? "border-b border-blue-50" : ""}`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 辞書ボタン（本マークのみ） */}
              <button
                onClick={() => setShowTemplateModal(true)}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d1d7db] bg-white text-[#54656f] shadow-sm"
                title="テンプレート一覧"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                </svg>
              </button>

              {/* 画像添付（＋のみ） */}
              <button
                onClick={openImagePicker}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d1d7db] bg-white text-[20px] font-light leading-none text-[#54656f] shadow-sm"
                title="画像を添付（最大10枚）"
              >
                +
              </button>

              <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={onSelectImage} className="hidden" />
              <input ref={aixFileInputRef} type="file" accept="image/*" onChange={onAixImageSelected} className="hidden" />
            </div>

            {/* テキスト入力 */}
            <div className={`flex items-end gap-2 rounded-[24px] bg-white px-3 py-2 shadow-sm transition-all ${inputFocused ? "rounded-[16px]" : ""}`}>
              <textarea
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                rows={inputFocused ? 4 : 1}
                placeholder="Aa"
                className="min-h-[22px] w-full resize-none bg-transparent text-[13px] leading-5 text-[#111b21] outline-none placeholder:text-[#8696a0]"
                style={{ maxHeight: inputFocused ? "140px" : "72px", transition: "max-height 0.2s ease" }}
              />
              <button
                onClick={sendReply}
                disabled={sending || (!replyDraft.trim() && selectedImageFiles.length === 0)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#29B6F6] text-white shadow-sm disabled:opacity-50"
                title="送信"
              >
                {sending ? (
                  <span className="text-[10px] font-bold">…</span>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* チャット中(モバイル)は非表示、一覧表示中・PCは常に表示 */}
      <div className={showChatOnMobile ? "hidden md:block" : "block"}>
        <BottomNav />
      </div>

      {showTemplateModal && (
        <TemplateModal
          onClose={() => setShowTemplateModal(false)}
          onSelect={(text) => { setReplyDraft(text); setShowTemplateModal(false); }}
        />
      )}

      {aixModalType && selectedConversation.id ? (
        <AixModal
          actionType={aixModalType}
          conversationId={selectedConversation.id}
          customerName={selectedConversation.customerName}
          initialImageFile={aixInitialFile ?? undefined}
          onClose={() => {
            setAixModalType(null);
            setAixInitialFile(null);
          }}
          onSend={sendMessageText}
        />
      ) : null}
    </main>
  );
}