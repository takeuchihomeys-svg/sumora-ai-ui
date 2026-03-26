"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AixModal, { type AixActionType } from "./components/AixModal";
import { supabase } from "./lib/supabase";

type Message = {
  id: string;
  sender: "customer" | "staff";
  text: string;
  time: string;
  rawCreatedAt?: string;
};

type Conversation = {
  id: string;
  customerName: string;
  lastMessage: string;
  status: string;
  lineUserId: string;
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
};

type SupabaseMessageRow = {
  id: number;
  conversation_id: number;
  sender: "customer" | "staff";
  text: string;
  created_at: string;
};

const STATUS_LIST = [
  {
    key: "first_reply",
    label: "初回返信",
    color: "bg-sky-100 text-sky-700",
    dot: "bg-sky-500",
  },
  {
    key: "condition_hearing",
    label: "ヒアリング中",
    color: "bg-violet-100 text-violet-700",
    dot: "bg-violet-500",
  },
  {
    key: "property_search",
    label: "物件探し中",
    color: "bg-amber-100 text-amber-700",
    dot: "bg-amber-500",
  },
  {
    key: "property_recommendation",
    label: "提案中",
    color: "bg-emerald-100 text-emerald-700",
    dot: "bg-emerald-500",
  },
  {
    key: "viewing",
    label: "内覧調整",
    color: "bg-cyan-100 text-cyan-700",
    dot: "bg-cyan-500",
  },
  {
    key: "estimate_request",
    label: "見積送付後",
    color: "bg-orange-100 text-orange-700",
    dot: "bg-orange-500",
  },
  {
    key: "availability_check",
    label: "募集確認中",
    color: "bg-yellow-100 text-yellow-700",
    dot: "bg-yellow-500",
  },
  {
    key: "application",
    label: "申込段階",
    color: "bg-rose-100 text-rose-700",
    dot: "bg-rose-500",
  },
  {
    key: "screening",
    label: "審査中",
    color: "bg-pink-100 text-pink-700",
    dot: "bg-pink-500",
  },
  {
    key: "contract",
    label: "契約前",
    color: "bg-indigo-100 text-indigo-700",
    dot: "bg-indigo-500",
  },
  {
    key: "closed_won",
    label: "成約",
    color: "bg-green-100 text-green-700",
    dot: "bg-green-500",
  },
];

function getStatusMeta(statusKey: string) {
  return (
    STATUS_LIST.find((status) => status.key === statusKey) || {
      key: statusKey,
      label: "未設定",
      color: "bg-gray-100 text-gray-700",
      dot: "bg-gray-400",
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
  const [aiSuggestion, setAiSuggestion] = useState("");
  const [pageLoading, setPageLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [error, setError] = useState("");
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showAixMenu, setShowAixMenu] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");

  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [selectedImagePreview, setSelectedImagePreview] = useState<string>("");
  const [aixModalType, setAixModalType] = useState<AixActionType | null>(null);
  const [aixInitialFile, setAixInitialFile] = useState<File | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const aixFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAixTypeRef = useRef<AixActionType | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchConversationsAndMessages();
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
    return conversations.filter((conversation) => conversation.status === statusFilter);
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
    setAiSuggestion("");
    setError("");
    setShowStatusMenu(false);
    setShowAixMenu(false);
    setSelectedImageFile(null);
    setSelectedImagePreview("");
  }, [selectedConversation.id]);

  const latestCustomerMessage = useMemo(() => {
    const customerMessages = selectedConversation.messages.filter(
      (message) => message.sender === "customer"
    );
    return customerMessages[customerMessages.length - 1]?.text ?? "";
  }, [selectedConversation]);

  const statusMeta = getStatusMeta(selectedConversation.status);

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

      setAiSuggestion(data.ai_reply || "");
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
    const file = event.target.files?.[0];
    if (!file) return;

    setSelectedImageFile(file);

    const reader = new FileReader();
    reader.onload = () => {
      setSelectedImagePreview(String(reader.result || ""));
    };
    reader.readAsDataURL(file);
  };

  const removeSelectedImage = () => {
    setSelectedImageFile(null);
    setSelectedImagePreview("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const sendReply = async () => {
    if (!selectedConversation.id) return;
    if (!replyDraft.trim() && !selectedImageFile) return;

    try {
      setSending(true);
      setError("");

      const now = new Date();
      let finalText = replyDraft.trim();

      if (selectedImageFile && !finalText) {
        finalText = `[画像添付予定] ${selectedImageFile.name}`;
      } else if (selectedImageFile && finalText) {
        finalText = `${finalText}\n[画像添付予定] ${selectedImageFile.name}`;
      }

      const { data: insertedRows, error: insertError } = await supabase
        .from("messages")
        .insert({
          conversation_id: Number(selectedConversation.id),
          sender: "staff",
          text: finalText,
          created_at: now.toISOString(),
        })
        .select();

      if (insertError) throw insertError;

      const inserted = insertedRows?.[0];

      const { error: updateError } = await supabase
        .from("conversations")
        .update({
          last_message: finalText,
          updated_at: now.toISOString(),
        })
        .eq("id", Number(selectedConversation.id));

      if (updateError) throw updateError;

      const newMessage: Message = {
        id: String(inserted?.id || crypto.randomUUID()),
        sender: "staff",
        text: finalText,
        time: formatTime(now.toISOString()),
        rawCreatedAt: now.toISOString(),
      };

      setConversations((prev) =>
        prev
          .map((conversation) =>
            conversation.id === selectedConversation.id
              ? {
                  ...conversation,
                  lastMessage: finalText,
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

      setReplyDraft("");
      removeSelectedImage();
    } catch (sendError) {
      console.error(sendError);
      setError("送信に失敗しました。");
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

  const openConversation = (conversationId: string) => {
    setSelectedId(conversationId);
    setMobileView("chat");
  };

  const showListOnMobile = mobileView === "list";
  const showChatOnMobile = mobileView === "chat";

  return (
    <main
      className="h-[calc(100svh-56px)] overflow-hidden bg-[#111b21]"
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
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[22px] font-bold tracking-tight text-[#111b21]">トーク</div>
              <button
                onClick={fetchConversationsAndMessages}
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#111b21] shadow-sm"
              >
                更新
              </button>
            </div>

            <div className="overflow-x-auto">
              <div className="flex min-w-max gap-2 pb-1">
                <button
                  onClick={() => setStatusFilter("all")}
                  style={statusFilter === "all" ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)" } : {}}
                  className={`rounded-full px-3 py-2 text-xs font-semibold whitespace-nowrap ${
                    statusFilter === "all"
                      ? "text-white"
                      : "bg-white text-[#54656f]"
                  }`}
                >
                  すべて
                </button>

                {STATUS_LIST.map((status) => (
                  <button
                    key={status.key}
                    onClick={() => setStatusFilter(status.key)}
                    className={`rounded-full px-3 py-2 text-xs font-semibold whitespace-nowrap ${
                      statusFilter === status.key ? "bg-[#111b21] text-white" : "bg-white text-[#54656f]"
                    }`}
                  >
                    {status.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto bg-white">
            {pageLoading ? (
              <div className="p-4 text-sm text-[#667781]">読み込み中...</div>
            ) : filteredConversations.length === 0 ? (
              <div className="p-4 text-sm text-[#667781]">該当する会話がありません</div>
            ) : (
              filteredConversations.map((conversation) => {
                const isActive = conversation.id === selectedConversation.id;
                const itemStatusMeta = getStatusMeta(conversation.status);

                return (
                  <button
                    key={conversation.id}
                    onClick={() => openConversation(conversation.id)}
                    className={`flex w-full items-center gap-3 border-b border-[#f0f2f5] px-4 py-3 text-left transition ${
                      isActive ? "bg-[#f0f2f5]" : "bg-white hover:bg-[#f5f6f6]"
                    }`}
                  >
                    <div className="relative shrink-0">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-base font-bold text-[#0f8f44]">
                        {getInitial(conversation.customerName)}
                      </div>
                      <span
                        className={`absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-white ${itemStatusMeta.dot}`}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div className="truncate text-[16px] font-semibold text-[#111b21]">
                          {conversation.customerName}
                        </div>
                        <div className="shrink-0 text-[11px] text-[#667781]">
                          {formatListTime(conversation.updatedAt)}
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
          <header className="border-b border-[#1a7fe8]/30 px-3 pb-3 pt-[max(10px,env(safe-area-inset-top))] backdrop-blur-sm md:px-4"
            style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
          >
            <div className="flex items-center gap-3">
              <button
                onClick={() => setMobileView("list")}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[22px] text-white md:hidden"
              >
                ←
              </button>

              {selectedConversation.id ? (
                <>
                  <div className="relative shrink-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-base font-bold text-[#0f8f44]">
                      {getInitial(selectedConversation.customerName)}
                    </div>
                    <span
                      className={`absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-white ${statusMeta.dot}`}
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[17px] font-semibold text-white">
                      {selectedConversation.customerName}
                    </div>
                    <div className="truncate text-xs text-white/70">{statusMeta.label}</div>
                  </div>
                </>
              ) : (
                <div className="text-[18px] font-semibold text-white">会話を選択</div>
              )}

              <div className="relative">
                <button
                  onClick={() => {
                    setShowStatusMenu(!showStatusMenu);
                    setShowAixMenu(false);
                  }}
                  disabled={!selectedConversation.id || statusSaving}
                  className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-[#111b21] shadow-sm"
                >
                  {statusSaving ? "更新中..." : statusMeta.label}
                </button>

                {showStatusMenu ? (
                  <div className="absolute right-0 top-full z-30 mt-2 w-56 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
                    {STATUS_LIST.map((item) => (
                      <button
                        key={item.key}
                        onClick={() => updateConversationStatus(item.key)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-[#f5f6f6] ${
                          item.key === selectedConversation.status ? "bg-[#f0f2f5]" : ""
                        }`}
                      >
                        <span className={`h-3 w-3 rounded-full ${item.dot}`} />
                        <span>{item.label}</span>
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
                      className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}
                    >
                      <div className="max-w-[88%] md:max-w-[72%]">
                        <div
                          className={`rounded-2xl px-4 py-2.5 text-[15px] leading-7 shadow-sm ${
                            isCustomer
                              ? "rounded-bl-md bg-white text-[#111b21]"
                              : "rounded-br-md bg-[#d9fdd3] text-[#111b21]"
                          }`}
                        >
                          <div className="whitespace-pre-wrap break-words">{message.text}</div>
                          <div className="mt-1 text-right text-[11px] leading-none text-[#667781]">
                            {message.time}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              {/* 返信案カード — クリックで入力欄に自動入力 */}
              {aiSuggestion && !generating && (
                <div className="flex justify-end">
                  <div className="max-w-[88%] md:max-w-[72%]">
                    <div className="mb-1 text-right text-xs text-[#667781]">返信案（タップで入力）</div>
                    <button
                      onClick={() => {
                        setReplyDraft(aiSuggestion);
                        setAiSuggestion("");
                      }}
                      className="w-full rounded-2xl rounded-br-md border border-blue-200 bg-white px-4 py-3 text-left text-[14px] leading-6 text-[#333] shadow-sm hover:bg-blue-50 active:bg-blue-100"
                    >
                      <div className="whitespace-pre-wrap break-words">{aiSuggestion}</div>
                    </button>
                  </div>
                </div>
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

          <div className="border-t border-[#d1d7db] bg-[#f0f2f5] px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-3 md:px-4">
            {error ? (
              <div className="mb-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">
                {error}
              </div>
            ) : null}

            {selectedImagePreview ? (
              <div className="mb-3 rounded-2xl border border-[#d1d7db] bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium text-[#54656f]">添付画像</div>
                  <button
                    onClick={removeSelectedImage}
                    className="text-sm font-semibold text-red-500"
                  >
                    削除
                  </button>
                </div>
                <img
                  src={selectedImagePreview}
                  alt="preview"
                  className="max-h-40 rounded-xl object-contain"
                />
              </div>
            ) : null}

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                onClick={generateReply}
                disabled={generating || !selectedConversation.id}
                className="rounded-full bg-[#06c755] px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
              >
                {generating ? "作成中..." : "返信案"}
              </button>

              <div className="relative">
                <button
                  onClick={() => {
                    setShowAixMenu(!showAixMenu);
                    setShowStatusMenu(false);
                  }}
                  className="rounded-full px-4 py-2 text-sm font-bold text-white shadow-sm"
                  style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
                >
                  AIX
                </button>

                {showAixMenu ? (
                  <div className="absolute bottom-[52px] left-0 z-30 w-52 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-2xl">
                    <button
                      onClick={() => {
                        setShowAixMenu(false);
                        openAixWithImagePicker("property_recommendation");
                      }}
                      className="flex w-full items-center gap-2 border-b border-blue-50 px-4 py-3 text-left text-sm font-semibold text-[#111b21] hover:bg-blue-50"
                    >
                      🏠 物件オススメ
                    </button>

                    <button
                      onClick={() => {
                        setShowAixMenu(false);
                        openAixWithImagePicker("estimate_sheet");
                      }}
                      className="flex w-full items-center gap-2 border-b border-blue-50 px-4 py-3 text-left text-sm font-semibold text-[#111b21] hover:bg-blue-50"
                    >
                      💰 見積書送る
                    </button>

                    <button
                      onClick={() => {
                        setShowAixMenu(false);
                        setAixInitialFile(null);
                        setAixModalType("viewing_invite");
                      }}
                      className="flex w-full items-center gap-2 border-b border-blue-50 px-4 py-3 text-left text-sm font-semibold text-[#111b21] hover:bg-blue-50"
                    >
                      🔍 内覧へ！
                    </button>

                    <button
                      onClick={() => {
                        setShowAixMenu(false);
                        setAixInitialFile(null);
                        setAixModalType("application_push");
                      }}
                      className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-[#111b21] hover:bg-blue-50"
                    >
                      ✋ 申込へ！
                    </button>
                  </div>
                ) : null}
              </div>

              <button
                onClick={openImagePicker}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-[26px] leading-none text-[#54656f] shadow-sm"
                aria-label="画像を添付"
                title="画像を添付"
              >
                ＋
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onSelectImage}
                className="hidden"
              />

              <input
                ref={aixFileInputRef}
                type="file"
                accept="image/*"
                onChange={onAixImageSelected}
                className="hidden"
              />

              <button
                onClick={sendReply}
                disabled={sending || (!replyDraft.trim() && !selectedImageFile)}
                className="ml-auto rounded-full bg-[#06c755] px-5 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
              >
                {sending ? "送信中..." : "送信"}
              </button>
            </div>

            <div className="flex items-end gap-2 rounded-[28px] bg-white px-4 py-3 shadow-sm">
              <textarea
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                rows={1}
                placeholder="メッセージを入力"
                className="max-h-36 min-h-[24px] w-full resize-none bg-transparent text-[15px] leading-6 text-[#111b21] outline-none placeholder:text-[#8696a0]"
              />
            </div>
          </div>
        </section>
      </div>

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