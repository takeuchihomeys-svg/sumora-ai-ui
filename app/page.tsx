"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";

type Message = {
  id: string;
  sender: "customer" | "staff";
  text: string;
  time: string;
};

type Conversation = {
  id: string;
  customerName: string;
  lastMessage: string;
  status: string;
  lineUserId: string;
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
  { key: "first_reply", label: "初回返信", color: "bg-sky-100 text-sky-700" },
  { key: "condition_hearing", label: "ヒアリング中", color: "bg-violet-100 text-violet-700" },
  { key: "property_search", label: "物件探し中", color: "bg-amber-100 text-amber-700" },
  { key: "property_recommendation", label: "提案中", color: "bg-emerald-100 text-emerald-700" },
  { key: "viewing", label: "内覧調整", color: "bg-cyan-100 text-cyan-700" },
  { key: "estimate_request", label: "見積送付後", color: "bg-orange-100 text-orange-700" },
  { key: "availability_check", label: "募集確認中", color: "bg-yellow-100 text-yellow-700" },
  { key: "application", label: "申込段階", color: "bg-rose-100 text-rose-700" },
  { key: "screening", label: "審査中", color: "bg-pink-100 text-pink-700" },
  { key: "contract", label: "契約前", color: "bg-indigo-100 text-indigo-700" },
  { key: "closed_won", label: "成約", color: "bg-green-100 text-green-700" },
];

function formatTime(dateString: string) {
  const date = new Date(dateString);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getStatusMeta(statusKey: string) {
  return (
    STATUS_LIST.find((status) => status.key === statusKey) || {
      key: statusKey,
      label: "未設定",
      color: "bg-gray-100 text-gray-700",
    }
  );
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
  const [showConversationDrawer, setShowConversationDrawer] = useState(false);

  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [selectedImagePreview, setSelectedImagePreview] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
        messages: relatedMessages,
      };
    });

    setConversations(formatted);

    if (formatted.length > 0) {
      setSelectedId((prev) => prev || formatted[0].id);
    }

    setPageLoading(false);
  };

  const selectedConversation = useMemo(() => {
    if (conversations.length === 0) {
      return {
        id: "",
        customerName: "",
        lastMessage: "",
        status: "first_reply",
        lineUserId: "",
        messages: [],
      };
    }

    return conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0];
  }, [conversations, selectedId]);

  useEffect(() => {
    setReplyDraft("");
    setError("");
    setShowStatusMenu(false);
    setShowAixMenu(false);
    setSelectedImageFile(null);
    setSelectedImagePreview("");
  }, [selectedConversation]);

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

      if (updateError) {
        throw updateError;
      }

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === selectedConversation.id
            ? { ...conversation, status: nextStatus }
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

  const generateReplyWithIntent = async (intent: string) => {
    if (!latestCustomerMessage.trim()) return;

    try {
      setGenerating(true);
      setError("");

      const promptText = `${latestCustomerMessage}\n\n今回の意図: ${intent}`;

      const res = await fetch(
        `https://sumora-line-ai.takeuchi-homeys.workers.dev/debug/reply?message=${encodeURIComponent(
          promptText
        )}&state=${encodeURIComponent(selectedConversation.status)}`
      );

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "返信案取得失敗");
      }

      setReplyDraft(data.ai_reply || "");
      setShowAixMenu(false);
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

      if (insertError) {
        throw insertError;
      }

      const inserted = insertedRows?.[0];

      const { error: updateError } = await supabase
        .from("conversations")
        .update({
          last_message: finalText,
          updated_at: now.toISOString(),
        })
        .eq("id", Number(selectedConversation.id));

      if (updateError) {
        throw updateError;
      }

      const newMessage: Message = {
        id: String(inserted?.id || crypto.randomUUID()),
        sender: "staff",
        text: finalText,
        time: formatTime(now.toISOString()),
      };

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === selectedConversation.id
            ? {
                ...conversation,
                lastMessage: finalText,
                messages: [...conversation.messages, newMessage],
              }
            : conversation
        )
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

  return (
    <main className="h-dvh overflow-hidden bg-[#9fc5e8]">
      <div className="flex h-full">
        {showConversationDrawer ? (
          <div
            className="fixed inset-0 z-40 bg-black/30 lg:hidden"
            onClick={() => setShowConversationDrawer(false)}
          />
        ) : null}

        <aside
          className={`fixed left-0 top-0 z-50 flex h-dvh w-[84%] max-w-[320px] flex-col bg-white shadow-2xl transition-transform duration-300 lg:static lg:w-[320px] lg:max-w-none lg:translate-x-0 lg:border-r lg:border-gray-200 lg:shadow-none ${
            showConversationDrawer ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-4">
            <div className="flex items-center gap-3">
              <h1 className="text-[28px] font-bold tracking-tight text-gray-900">スモラAI</h1>
              <div
                className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold text-white shadow-lg"
                style={{
                  background:
                    "linear-gradient(135deg, #050816 0%, #0b122f 35%, #1d4ed8 70%, #0f172a 100%)",
                }}
              >
                <span className="mr-1 text-[10px]">✦</span>
                AIXpro
              </div>
            </div>

            <button
              onClick={() => setShowConversationDrawer(false)}
              className="rounded-full p-2 text-gray-500 lg:hidden"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {pageLoading ? (
              <div className="p-4 text-sm text-gray-500">読み込み中...</div>
            ) : conversations.length === 0 ? (
              <div className="p-4 text-sm text-gray-500">会話データがありません</div>
            ) : (
              conversations.map((conversation) => {
                const isActive = conversation.id === selectedId;
                const itemStatusMeta = getStatusMeta(conversation.status);

                return (
                  <button
                    key={conversation.id}
                    onClick={() => {
                      setSelectedId(conversation.id);
                      setShowConversationDrawer(false);
                    }}
                    className={`w-full border-b border-gray-100 px-4 py-4 text-left ${
                      isActive ? "bg-[#eef7ea]" : "bg-white hover:bg-gray-50"
                    }`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[17px] font-semibold text-gray-900">
                          {conversation.customerName}
                        </div>
                      </div>

                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${itemStatusMeta.color}`}
                      >
                        {itemStatusMeta.label}
                      </span>
                    </div>

                    <div className="truncate text-sm text-gray-500">
                      {conversation.lastMessage}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-[#8fb8d8] bg-white px-3 py-3 sm:px-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowConversationDrawer(true)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-xl text-gray-700 shadow-sm lg:hidden"
              >
                ☰
              </button>

              <div className="min-w-0 flex-1">
                <div className="truncate text-[20px] font-bold text-gray-900">
                  {selectedConversation.customerName || "会話を選択"}
                </div>
                <div className="mt-0.5 text-sm text-gray-500">{statusMeta.label}</div>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    onClick={() => {
                      setShowStatusMenu(!showStatusMenu);
                      setShowAixMenu(false);
                    }}
                    disabled={!selectedConversation.id || statusSaving}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${statusMeta.color}`}
                  >
                    {statusSaving ? "更新中..." : "状態変更"}
                  </button>

                  {showStatusMenu ? (
                    <div className="absolute right-0 top-full z-30 mt-2 w-48 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
                      {STATUS_LIST.map((item) => (
                        <button
                          key={item.key}
                          onClick={() => updateConversationStatus(item.key)}
                          className="block w-full px-4 py-3 text-left text-sm hover:bg-gray-50"
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <button
                  onClick={fetchConversationsAndMessages}
                  className="hidden rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 sm:inline-flex"
                >
                  更新
                </button>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto bg-[#b7d4ea] px-3 py-4 sm:px-5">
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {selectedConversation.messages.length === 0 ? (
                <div className="rounded-2xl bg-white px-4 py-6 text-center text-sm text-gray-500 shadow-sm">
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
                      <div className="max-w-[86%] sm:max-w-[72%]">
                        <div
                          className={`rounded-[22px] px-4 py-3 text-[15px] leading-7 shadow-sm ${
                            isCustomer
                              ? "bg-white text-gray-900"
                              : "bg-[#8de055] text-gray-900"
                          }`}
                        >
                          {message.text}
                        </div>
                        <div
                          className={`mt-1 text-xs text-gray-600 ${
                            isCustomer ? "text-left" : "text-right"
                          }`}
                        >
                          {message.time}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="border-t border-[#8fb8d8] bg-white px-3 py-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-4">
            {error ? (
              <div className="mb-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">
                {error}
              </div>
            ) : null}

            {selectedImagePreview ? (
              <div className="mb-3 rounded-2xl border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium text-gray-700">添付画像</div>
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

            <div className="mb-3 flex items-center gap-2">
              <button
                onClick={generateReply}
                disabled={generating || !selectedConversation.id}
                className="rounded-full bg-[#06c755] px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
              >
                {generating ? "作成中..." : "返信案を作成"}
              </button>

              <div className="relative">
                <button
                  onClick={() => {
                    setShowAixMenu(!showAixMenu);
                    setShowStatusMenu(false);
                  }}
                  className="group relative overflow-hidden rounded-full px-5 py-2.5 text-sm font-bold tracking-[0.18em] text-white shadow-[0_10px_30px_rgba(0,0,0,0.35)] transition hover:scale-[1.02]"
                  style={{
                    background:
                      "linear-gradient(135deg, #050816 0%, #0b122f 35%, #1d4ed8 70%, #0f172a 100%)",
                  }}
                >
                  <span className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.28),transparent_45%)] opacity-80" />
                  <span className="absolute inset-[1px] rounded-full border border-white/15" />
                  <span className="relative z-10">AIX</span>
                </button>

                {showAixMenu ? (
                  <div className="absolute bottom-[54px] left-0 z-30 w-48 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
                    <button
                      onClick={() => {
                        alert("準備中です");
                        setShowAixMenu(false);
                      }}
                      className="block w-full border-b border-gray-100 px-4 py-3 text-left text-sm font-semibold text-gray-800 hover:bg-gray-50"
                    >
                      物件オススメする
                    </button>

                    <button
                      onClick={() => {
                        alert("準備中です");
                        setShowAixMenu(false);
                      }}
                      className="block w-full border-b border-gray-100 px-4 py-3 text-left text-sm font-semibold text-gray-800 hover:bg-gray-50"
                    >
                      初期費用送る
                    </button>

                    <button
                      onClick={() => generateReplyWithIntent("内覧誘導")}
                      className="block w-full border-b border-gray-100 px-4 py-3 text-left text-sm font-semibold text-gray-800 hover:bg-blue-50"
                    >
                      内覧
                    </button>

                    <button
                      onClick={() => generateReplyWithIntent("申込誘導")}
                      className="block w-full px-4 py-3 text-left text-sm font-semibold text-gray-800 hover:bg-red-50"
                    >
                      申込
                    </button>
                  </div>
                ) : null}
              </div>

              <button
                onClick={openImagePicker}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 bg-white text-[28px] leading-none text-gray-700 shadow-sm"
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

              <button
                onClick={sendReply}
                disabled={sending || (!replyDraft.trim() && !selectedImageFile)}
                className="ml-auto rounded-full bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
              >
                {sending ? "送信中..." : "送信"}
              </button>
            </div>

            <div className="rounded-[26px] border border-gray-200 bg-[#f5f5f5] px-4 py-3 shadow-inner">
              <textarea
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                rows={4}
                placeholder="ここに返信案が入ります。必要なら修正してから送信してください。"
                className="w-full resize-none bg-transparent text-[15px] leading-7 text-gray-900 outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}