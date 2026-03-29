"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AixModal, { type AixActionType } from "./components/AixModal";
import BottomNav from "./components/BottomNav";
import TemplateModal from "./components/TemplateModal";
import { supabase } from "./lib/supabase";
import { registerSW, requestNotifPermission, showNotif } from "./lib/notifications";

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

// 画面表示用グループ（4種類）
const DISPLAY_GROUPS = [
  {
    key: "searching",
    label: "物件探し中",
    statuses: ["first_reply", "condition_hearing", "property_search", "property_recommendation", "viewing", "estimate_request", "availability_check", "application"],
    color: "bg-amber-100 text-amber-700",
    dot: "bg-amber-500",
    canonicalStatus: "property_search",
  },
  {
    key: "screening",
    label: "審査・契約",
    statuses: ["screening", "contract"],
    color: "bg-pink-100 text-pink-700",
    dot: "bg-pink-500",
    canonicalStatus: "screening",
  },
  {
    key: "closed",
    label: "ご成約",
    statuses: ["closed_won"],
    color: "bg-yellow-100 text-yellow-700",
    dot: "bg-yellow-400",
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

const URL_REGEX = /(https?:\/\/[^\s\u3000-\u9fff\uff00-\uffef]+)/g;

function isVideoUrl(url: string) {
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url);
}

function renderTextWithLinks(text: string) {
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) => {
    if (URL_REGEX.test(part)) {
      URL_REGEX.lastIndex = 0;
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer"
          className="text-[#1565C0] underline break-all">
          {part}
        </a>
      );
    }
    return part;
  });
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
  const [searchQuery, setSearchQuery] = useState("");
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false);
  const [currentAccount, setCurrentAccount] = useState<{ id: string; name: string; icon: string; profileImage?: string }>(() => {
    if (typeof window === "undefined") return { id: "sumora", name: "スモラ", icon: "🦄" };
    const saved = localStorage.getItem("sumora_account_profile");
    return saved ? JSON.parse(saved) : { id: "sumora", name: "スモラ", icon: "🦄", profileImage: "/icon-192.png" };
  });
  const accountImageInputRef = useRef<HTMLInputElement | null>(null);
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
  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [announcements, setAnnouncements] = useState<Message[]>([]);
  const [showAnnouncementList, setShowAnnouncementList] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number; text: string } | null>(null);
  const [partialCopyMessageId, setPartialCopyMessageId] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const lightboxSwipeX = useRef(0);
  const [flaggedConvIds, setFlaggedConvIds] = useState<Set<string>>(new Set());
  const convLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [memos, setMemos] = useState<Record<string, string>>({});
  const [memoModalConvId, setMemoModalConvId] = useState<string | null>(null);
  const [memoInput, setMemoInput] = useState("");
  const [viewingMemoConvId, setViewingMemoConvId] = useState<string | null>(null);
  const [convMenuConvId, setConvMenuConvId] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [assigneeModalConvId, setAssigneeModalConvId] = useState<string | null>(null);
  const [assigneeInput, setAssigneeInput] = useState("");
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiSearchIds, setAiSearchIds] = useState<string[] | null>(null);
  const [aiSearchMessageIds, setAiSearchMessageIds] = useState<Record<string, string[]>>({});
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  const [aixSearchMode, setAixSearchMode] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const aixFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAixTypeRef = useRef<AixActionType | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const notifiedCalendarIds = useRef<Set<string>>(new Set());
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [navHidden, setNavHidden] = useState(false);

  const handleListScroll = () => {
    setNavHidden(true);
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => setNavHidden(false), 600);
  };

  useEffect(() => {
    // SW登録 + 通知許可
    registerSW().then(() => requestNotifPermission());

    fetchConversationsAndMessages();

    // Supabase real-time: 新しいメッセージをリアルタイム反映
    const channel = supabase
      .channel("realtime-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          // お客様メッセージが届いたら通知
          if (payload.new && (payload.new as { sender: string }).sender === "customer") {
            const msgText = (payload.new as { text?: string }).text || "新しいメッセージが届きました";
            showNotif("AIX LINX — 新着メッセージ", msgText, "/");
          }
          fetchConversationsAndMessages();
        }
      )
      .subscribe((status) => {
        // realtime接続失敗時はポーリングで補完
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          fetchConversationsAndMessages();
        }
      });

    // フォールバック: 30秒ごとにポーリング（realtime漏れ対策）
    const pollInterval = setInterval(() => fetchConversationsAndMessages(), 30_000);

    // カレンダーアラーム（1分ごとに予定開始15分前・開始時刻を通知）
    const calendarAlarm = setInterval(async () => {
      const now = new Date();
      const from = now.toISOString();
      const to = new Date(now.getTime() + 16 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("calendar_events")
        .select("id, title, customer_name, start_at, event_type")
        .gte("start_at", from)
        .lte("start_at", to)
        .eq("all_day", false);
      if (!data) return;
      for (const ev of data) {
        const start = new Date(ev.start_at).getTime();
        const diff = start - now.getTime(); // ms
        const key15 = `15_${ev.id}`;
        const key0 = `0_${ev.id}`;
        const emoji = ev.event_type === "viewing" ? "🔍" : ev.event_type === "contract" ? "📝" : ev.event_type === "key_handover" ? "🔑" : "📌";
        if (diff >= 14 * 60 * 1000 && diff < 16 * 60 * 1000 && !notifiedCalendarIds.current.has(key15)) {
          notifiedCalendarIds.current.add(key15);
          showNotif(`${emoji} まもなく開始 — ${ev.title}`, `${ev.customer_name} の予定が15分後に始まります`, "/calendar");
        }
        if (diff >= 0 && diff < 2 * 60 * 1000 && !notifiedCalendarIds.current.has(key0)) {
          notifiedCalendarIds.current.add(key0);
          showNotif(`${emoji} 開始時刻です — ${ev.title}`, `${ev.customer_name} の予定が始まります`, "/calendar");
        }
      }
    }, 60 * 1000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(calendarAlarm);
      clearInterval(pollInterval);
    };
  }, []);

  // 会話を開いたとき：AI検索のマッチメッセージがあればそこへ、なければ最下部へ
  useEffect(() => {
    if (!selectedId) return;
    const matchedMsgIds = aiSearchMessageIds[selectedId] || [];
    if (matchedMsgIds.length > 0) {
      // 少し待ってからスクロール（DOM描画待ち）
      setTimeout(() => {
        const el = document.getElementById(`msg-${matchedMsgIds[0]}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (bottomRef.current) {
          bottomRef.current.scrollIntoView({ behavior: "instant" });
        }
      }, 100);
    } else {
      if (bottomRef.current) {
        bottomRef.current.scrollIntoView({ behavior: "instant" });
      }
    }
  }, [selectedId]);

  // 新しいメッセージが届いたとき：スムーズにスクロール
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversations]);

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
    let result = conversations;
    if (statusFilter !== "all") {
      const group = DISPLAY_GROUPS.find((g) => g.key === statusFilter);
      if (group) result = result.filter((c) => group.statuses.includes(c.status));
    }
    // AI検索結果がある場合はそちらを優先
    if (aiSearchIds !== null) {
      return result.filter((c) => aiSearchIds.includes(c.id));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (c) =>
          c.customerName.toLowerCase().includes(q) ||
          c.lastMessage.toLowerCase().includes(q) ||
          c.messages.some((m) => m.text?.toLowerCase().includes(q))
      );
    }
    return result;
  }, [conversations, statusFilter, searchQuery, aiSearchIds]);

  const needsReplyCount = useMemo(() => {
    return conversations.filter((c) => {
      const last = c.messages[c.messages.length - 1];
      return last?.sender === "customer" && c.status !== "closed_won";
    }).length;
  }, [conversations]);

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

  // replyDraftが変わったらtextareaの高さを自動調整
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [replyDraft]);

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

  const startLongPress = (messageId: string, messageText: string, e?: React.TouchEvent) => {
    longPressTimerRef.current = setTimeout(() => {
      const touch = e?.touches[0];
      setContextMenu({ messageId, x: touch?.clientX ?? 200, y: touch?.clientY ?? 300, text: messageText });
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  };

  // メモ・担当者をlocalStorageから読み込む
  useEffect(() => {
    try {
      const stored = localStorage.getItem("conv_memos");
      if (stored) setMemos(JSON.parse(stored));
    } catch {}
    try {
      const stored = localStorage.getItem("conv_assignees");
      if (stored) setAssignees(JSON.parse(stored));
    } catch {}
  }, []);

  const saveMemo = (convId: string, text: string) => {
    const next = { ...memos };
    if (text.trim()) next[convId] = text.trim();
    else delete next[convId];
    setMemos(next);
    try { localStorage.setItem("conv_memos", JSON.stringify(next)); } catch {}
    setMemoModalConvId(null);
  };

  const saveAssignee = (convId: string, name: string) => {
    const next = { ...assignees };
    if (name.trim()) next[convId] = name.trim();
    else delete next[convId];
    setAssignees(next);
    try { localStorage.setItem("conv_assignees", JSON.stringify(next)); } catch {}
    setAssigneeModalConvId(null);
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
    convLongPressTimerRef.current = setTimeout(() => {
      setConvMenuConvId(id);
    }, 500);
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

      // 全画像をアップロード（indexつきでパス衝突を防ぐ）
      const imageUrls: string[] = [];
      for (let i = 0; i < selectedImageFiles.length; i++) {
        const file = selectedImageFiles[i];
        const ext = file.name.split(".").pop() || "jpg";
        const path = `messages/${selectedConversation.id}/${Date.now()}_${i}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("property-images")
          .upload(path, file, { upsert: false });
        if (uploadError) throw new Error(`画像アップロード失敗: ${uploadError.message}`);
        const { data } = supabase.storage.from("property-images").getPublicUrl(path);
        imageUrls.push(data.publicUrl);
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

      // 画像は複数でも1メッセージ行にまとめて保存（JSON配列）
      if (imageUrls.length > 0) {
        const imageUrlData = imageUrls.length === 1 ? imageUrls[0] : JSON.stringify(imageUrls);
        const imgNow = new Date();
        const { data: imgRow, error: imgInsertError } = await supabase
          .from("messages")
          .insert({
            conversation_id: Number(selectedConversation.id),
            sender: "staff",
            text: "[画像]",
            image_url: imageUrlData,
            created_at: imgNow.toISOString(),
          })
          .select();
        if (imgInsertError) throw imgInsertError;
        newMessages.push({
          id: String(imgRow?.[0]?.id || crypto.randomUUID()),
          sender: "staff",
          text: "[画像]",
          imageUrl: imageUrlData,
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

  const handleAiSearch = async () => {
    if (!searchQuery.trim() || aiSearchLoading) return;
    setAiSearchLoading(true);
    setAiSearchIds(null);
    setAiSearchMessageIds({});
    try {
      const convData = conversations.map((c) => ({
        id: c.id,
        customerName: c.customerName,
        status: c.status,
        lastMessage: c.lastMessage,
        messages: c.messages.slice(-20).map((m) => ({ id: m.id, sender: m.sender, text: m.text || "" })),
      }));
      const res = await fetch("https://sumora-line-ai.takeuchi-homeys.workers.dev/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, conversations: convData }),
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.matchedIds)) {
        setAiSearchIds(data.matchedIds.map(String));
        setAiSearchMessageIds(data.matchedMessageIds || {});
      } else {
        setAiSearchIds([]);
      }
    } catch {
      setAiSearchIds([]);
    } finally {
      setAiSearchLoading(false);
    }
  };

  const sendMessageText = async (text: string, imageUrl?: string) => {
    if (!selectedConversation.id || (!text.trim() && !imageUrl)) return;
    const now = new Date();
    const newMessages: Message[] = [];

    // 画像が先、テキストが後の順で保存・送信
    if (imageUrl) {
      const imgNow = new Date();
      const { data: imgRow, error: imgError } = await supabase
        .from("messages")
        .insert({
          conversation_id: Number(selectedConversation.id),
          sender: "staff",
          text: "[画像]",
          image_url: imageUrl,
          created_at: imgNow.toISOString(),
        })
        .select();
      if (imgError) throw imgError;
      newMessages.push({
        id: String(imgRow?.[0]?.id || crypto.randomUUID()),
        sender: "staff",
        text: "[画像]",
        imageUrl,
        time: formatTime(imgNow.toISOString()),
        rawCreatedAt: imgNow.toISOString(),
      });
    }

    if (text.trim()) {
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
      newMessages.push({
        id: String(insertedRows?.[0]?.id || crypto.randomUUID()),
        sender: "staff",
        text: text.trim(),
        time: formatTime(now.toISOString()),
        rawCreatedAt: now.toISOString(),
      });
    }

    const lastText = text.trim() || "[画像]";
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

    // LINEに送信（画像→テキストの順）
    try {
      if (imageUrl) {
        await fetch("https://sumora-line-ai.takeuchi-homeys.workers.dev/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, image_url: imageUrl }),
        });
      }
      if (text.trim()) {
        await fetch("https://sumora-line-ai.takeuchi-homeys.workers.dev/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, message: text.trim() }),
        });
      }
    } catch {
      // LINE送信失敗しても管理画面の動作は続ける
    }
  };

  const onAccountImageSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const updated = { ...currentAccount, profileImage: String(reader.result) };
      setCurrentAccount(updated);
      localStorage.setItem("sumora_account_profile", JSON.stringify(updated));
    };
    reader.readAsDataURL(file);
    if (accountImageInputRef.current) accountImageInputRef.current.value = "";
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
      className="h-[100svh] overflow-hidden bg-[#111b21]"
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
          style={{ paddingBottom: "calc(30px + env(safe-area-inset-bottom))" }}
        >
          <div className="border-b border-[#e9edef] bg-white px-3 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
            {/* ステータスフィルター（上段）＋ハンバーガー左上 */}
            <div className="relative flex items-center justify-center mb-2">
              {/* ハンバーガー（左端） */}
              <button
                onClick={() => setShowHamburgerMenu(true)}
                className="absolute left-0 flex flex-col gap-[4px] px-1 py-1"
              >
                <span className="block h-[2px] w-[18px] rounded-full bg-[#555]" />
                <span className="block h-[2px] w-[18px] rounded-full bg-[#555]" />
                <span className="block h-[2px] w-[18px] rounded-full bg-[#555]" />
              </button>
              {/* AI検索ボタン（右端） */}
              <button
                onClick={() => { setAixSearchMode(true); setAiSearchIds(null); setAiSearchMessageIds({}); setSearchQuery(""); }}
                className="absolute right-0 flex items-center justify-center p-1"
                title="AIで検索"
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                  <circle cx="10" cy="10" r="7" stroke={aixSearchMode ? "#1565C0" : "#90caf9"} strokeWidth="2.5"/>
                  <line x1="15.2" y1="15.2" x2="21" y2="21" stroke={aixSearchMode ? "#1565C0" : "#90caf9"} strokeWidth="2.8" strokeLinecap="round"/>
                  <text x="10" y="10" textAnchor="middle" dominantBaseline="central" fontSize="6.5" fontWeight="bold" fill={aixSearchMode ? "#1565C0" : "#90caf9"}>AI</text>
                </svg>
              </button>
              {(() => {
                const lbl = statusFilter === "all" ? "すべて" : (DISPLAY_GROUPS.find((g) => g.key === statusFilter)?.label ?? "すべて");
                const fs = lbl.length >= 5 ? "text-[10px]" : lbl.length >= 4 ? "text-[11px]" : "text-[12px]";
                return (
                  <button
                    onClick={() => setShowGroupFilter((v) => !v)}
                    className={`flex w-[104px] items-center justify-center gap-1 rounded-full py-1.5 ${fs} font-bold shadow-sm transition-all`}
                    style={statusFilter !== "all"
                      ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white" }
                      : { background: "#f0f2f5", color: "#1565C0" }
                    }
                  >
                    {lbl}
                    <span className="text-[9px]">{showGroupFilter ? "▲" : "▼"}</span>
                  </button>
                );
              })()}
              {showGroupFilter && (
                <div className="absolute top-full z-30 mt-1 w-44 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
                  <button
                    onClick={() => { setStatusFilter("all"); setShowGroupFilter(false); }}
                    className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold border-b border-[#f0f2f5] ${statusFilter === "all" ? "text-[#2196F3]" : "text-[#111b21]"}`}
                  >
                    <span className="h-3 w-3 rounded-full bg-gray-300" />
                    すべて
                  </button>
                  {DISPLAY_GROUPS.map((g) => (
                    <button
                      key={g.key}
                      onClick={() => { setStatusFilter(g.key); setShowGroupFilter(false); }}
                      className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold border-b border-[#f0f2f5] last:border-b-0 ${statusFilter === g.key ? "text-[#2196F3]" : "text-[#111b21]"}`}
                    >
                      <span className={`h-3 w-3 rounded-full ${g.dot}`} />
                      {g.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 検索バー（スリム） */}
            <div className="flex items-center gap-2 rounded-2xl bg-[#f0f2f5] px-3 py-1.5">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!aixSearchMode) { setAiSearchIds(null); setAiSearchMessageIds({}); }
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && aixSearchMode) handleAiSearch(); }}
                placeholder={aixSearchMode ? "AIで検索（Enterで実行）" : "検索"}
                className={`min-w-0 flex-1 bg-transparent text-[13px] outline-none ${aixSearchMode ? "text-[#1565C0] font-medium placeholder:text-[#4BA8E8]" : "text-[#111b21] placeholder:text-[#aaa]"}`}
              />
              {aixSearchMode && aiSearchLoading && (
                <span className="shrink-0 text-[12px] text-[#4BA8E8] font-bold">…</span>
              )}
              {(searchQuery || aiSearchIds !== null || aixSearchMode) && (
                <button
                  onClick={() => { setSearchQuery(""); setAiSearchIds(null); setAiSearchMessageIds({}); setAixSearchMode(false); }}
                  className="shrink-0 text-[#aaa] text-sm"
                >✕</button>
              )}
            </div>

          </div>

          {/* アカウント名（検索欄とトーク一覧の間・左揃え） */}
          <div className="px-4 py-1.5 text-[10px] font-medium tracking-wide text-[#b0bec5] bg-white border-b border-[#f0f2f5]">
            {currentAccount.name} のメッセージ一覧
          </div>

          <div
            ref={listRef}
            className="flex-1 overflow-y-auto bg-white"
            onScroll={handleListScroll}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {isPulling && (
              <div className="py-2 text-center text-xs text-[#2196F3]">↓ 離して更新</div>
            )}
            {aiSearchIds !== null && (
              <div className="flex items-center gap-2 border-b border-[#d1d7db] bg-blue-50 px-4 py-2">
                <span className="text-[11px] font-bold text-[#2196F3]">✨ AI検索結果</span>
                <span className="text-[11px] text-[#667781]">「{searchQuery}」— {filteredConversations.length}件</span>
                <button
                  onClick={() => { setAiSearchIds(null); setAiSearchMessageIds({}); setAixSearchMode(false); setSearchQuery(""); }}
                  className="ml-auto text-[11px] text-[#aaa]"
                >クリア</button>
              </div>
            )}
            {pageLoading ? (
              <div className="p-4 text-sm text-[#667781]">読み込み中...</div>
            ) : filteredConversations.length === 0 ? (
              <div className="p-4 text-sm text-[#667781]">
                {aiSearchIds !== null ? "AIが条件に合う会話を見つけられませんでした" : "該当する会話がありません"}
              </div>
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
                    style={{ WebkitUserSelect: "none", userSelect: "none" }}
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
                      {groupMeta.key !== "searching" && (
                        <span
                          className={`absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-white ${groupMeta.dot}`}
                        />
                      )}
                      {memos[conversation.id] && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setViewingMemoConvId(conversation.id); }}
                          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white shadow-sm"
                          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5 truncate">
                          <span className="truncate text-[14px] font-semibold text-[#111b21]">
                            {conversation.customerName}
                          </span>
                          {assignees[conversation.id] && (
                            <span className="shrink-0 rounded-full bg-[#e3f2fd] px-1.5 py-0.5 text-[10px] font-bold text-[#1565C0]">
                              {assignees[conversation.id]}
                            </span>
                          )}
                          {flaggedConvIds.has(conversation.id) && (
                            <span className="shrink-0 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-600">
                              要対応
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-[11px] text-[#667781]">
                            {formatListTime(conversation.updatedAt)}
                          </span>
                          {needsReply && (
                            <span className="h-3 w-3 rounded-full bg-[#2196F3]" />
                          )}
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
          style={{ background: "linear-gradient(180deg, #e8f4fd 0%, #f0f8ff 50%, #f8fbff 100%)" }}
        >
          <header className="border-b border-[#e9edef] px-3 pb-3 pt-[max(14px,env(safe-area-inset-top))] backdrop-blur-md md:px-4"
            style={{ background: "rgba(218,238,253,0.88)" }}
          >
            <div className="relative flex items-center">
              {/* 左: 戻るボタン + 未返信バッジ */}
              <button
                onClick={() => setMobileView("list")}
                className="flex items-center gap-1.5 shrink-0 md:hidden"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111b21" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                {needsReplyCount > 0 && (
                  <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#2196F3] px-1 text-[11px] font-bold text-white leading-none">
                    {needsReplyCount}
                  </span>
                )}
              </button>

              {/* 中央: 名前（タップで更新） */}
              <div className="pointer-events-none absolute left-0 right-0 flex justify-center">
                <button
                  onClick={fetchConversationsAndMessages}
                  className="pointer-events-auto flex items-center max-w-[60%] active:opacity-60 transition-opacity"
                  title="タップして更新"
                >
                  <span className="truncate text-[15px] font-semibold text-[#111b21] text-center">
                    {selectedConversation.id ? selectedConversation.customerName : "会話を選択"}
                  </span>
                </button>
              </div>

              {/* 右: ステータス */}
              <div className="ml-auto flex items-center gap-1.5">
                <div className="relative shrink-0">
                  <button
                    onClick={() => {
                      setShowStatusMenu(!showStatusMenu);
                      setShowAixMenu(false);
                    }}
                    disabled={!selectedConversation.id || statusSaving}
                    className="rounded-full border border-[#e0e0e0] bg-white px-2 py-0.5 text-[10px] text-[#aaa] shadow-none"
                  >
                    {statusSaving ? "..." : statusMeta.label}
                  </button>

                  {showStatusMenu ? (
                    <div className="absolute right-0 top-full z-30 mt-2 w-40 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
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
            </div>
          </header>

          {announcements.length > 0 && (
            <button
              onClick={() => setShowAnnouncementList(true)}
              className="flex w-full items-center gap-2 border-b border-[#e9edef] bg-[#fffbe6] px-4 py-2.5 text-left"
            >
              <span className="shrink-0 text-base">📌</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-[#8696a0]">
                  {announcements[announcements.length - 1].text !== "[画像]"
                    ? announcements[announcements.length - 1].text
                    : "📷 画像"}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-[#f0a500] px-2 py-0.5 text-[10px] font-bold text-white">
                {announcements.length}件
              </span>
            </button>
          )}

          <div className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-3.5">
              {(() => {
                const q = aiSearchIds !== null ? "" : searchQuery.trim().toLowerCase();
                const displayMessages = q
                  ? selectedConversation.messages.filter((m) => m.text?.toLowerCase().includes(q))
                  : selectedConversation.messages;
                if (displayMessages.length === 0) {
                  return (
                    <div className="rounded-2xl bg-white px-4 py-6 text-center text-sm text-[#667781] shadow-sm">
                      {q ? `「${searchQuery}」に一致するメッセージがありません` : "メッセージがありません"}
                    </div>
                  );
                }
                let lastDate = "";
                return displayMessages.flatMap((message, idx) => {
                  const msgDate = message.rawCreatedAt
                    ? new Date(message.rawCreatedAt).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
                    : "";
                  const showDate = msgDate && msgDate !== lastDate;
                  if (showDate) lastDate = msgDate;
                  const isCustomer = message.sender === "customer";
                  const elems = [];
                  if (showDate) {
                    elems.push(
                      <div key={`date-${idx}`} className="flex items-center gap-3 py-2">
                        <div className="h-px flex-1 bg-[#e9edef]" />
                        <span className="rounded-full bg-[#e9edef] px-3 py-1 text-[11px] text-[#8696a0]">{msgDate}</span>
                        <div className="h-px flex-1 bg-[#e9edef]" />
                      </div>
                    );
                  }
                  const isAiMatch = selectedId
                    ? (aiSearchMessageIds[selectedId] || []).includes(message.id)
                    : false;
                  elems.push(
                    <div
                      key={message.id}
                      id={`msg-${message.id}`}
                      className={`flex flex-col gap-0.5 ${isCustomer ? "items-start" : "items-end"} ${isAiMatch ? "rounded-2xl ring-2 ring-[#2196F3] ring-offset-2" : ""}`}
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
                          style={{ userSelect: "none", WebkitUserSelect: "none" }}
                          onTouchStart={(e) => startLongPress(message.id, message.text, e)}
                          onTouchEnd={cancelLongPress}
                          onTouchMove={cancelLongPress}
                          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ messageId: message.id, x: e.clientX, y: e.clientY, text: message.text }); }}
                        >
                          <div
                            className={`rounded-2xl text-[15px] leading-6 shadow-sm ${
                              isCustomer
                                ? "rounded-bl-md bg-white text-[#3d4a52]"
                                : "rounded-br-md text-[#3d4a52]"
                            } ${flaggedIds.has(message.id) ? "ring-2 ring-orange-300" : ""}`}
                            style={!isCustomer ? { backgroundColor: "rgba(220,248,198,0.55)" } : undefined}
                          >
                            {message.imageUrl && (() => {
                              let imgs: string[];
                              try {
                                imgs = message.imageUrl!.startsWith("[")
                                  ? JSON.parse(message.imageUrl!)
                                  : [message.imageUrl!];
                              } catch {
                                imgs = [message.imageUrl!];
                              }
                              const hasText = message.text && message.text !== "[画像]" && message.text !== "[動画]";
                              const roundB = hasText ? "rounded-b-none" : "";
                              // 動画の場合
                              if (imgs.length === 1 && isVideoUrl(imgs[0])) {
                                return (
                                  <video
                                    src={imgs[0]}
                                    controls
                                    playsInline
                                    className={`max-h-72 w-full rounded-2xl object-cover ${roundB}`}
                                    style={{ background: "#000" }}
                                  />
                                );
                              }
                              const openLightbox = (idx: number) => {
                                setLightboxImages(imgs);
                                setLightboxIndex(idx);
                              };
                              if (imgs.length === 1) {
                                return (
                                  <img
                                    src={imgs[0]}
                                    alt="送信画像"
                                    onClick={() => openLightbox(0)}
                                    className={`max-h-56 w-full cursor-pointer rounded-2xl object-cover ${roundB}`}
                                  />
                                );
                              }
                              const cols = imgs.length === 2 ? "grid-cols-2" : "grid-cols-3";
                              return (
                                <div className={`grid ${cols} gap-0.5 overflow-hidden rounded-2xl ${roundB}`}>
                                  {imgs.map((url, idx) => (
                                    <img
                                      key={idx}
                                      src={url}
                                      alt={`画像${idx + 1}`}
                                      onClick={() => openLightbox(idx)}
                                      className="aspect-square w-full cursor-pointer object-cover"
                                    />
                                  ))}
                                </div>
                              );
                            })()}
                            {message.text && message.text !== "[画像]" && message.text !== "[動画]" && (
                              <div className="whitespace-pre-wrap break-words px-4 py-2.5">{renderTextWithLinks(message.text)}</div>
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
                  return elems;
                });
              })()}
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

          <div className="border-t border-[#e9edef] bg-white px-2 pt-1.5 md:px-3" style={{ paddingBottom: "max(10px, env(safe-area-inset-bottom))" }}>
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
                className="rounded-full border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-semibold text-[#111b21] shadow-sm disabled:opacity-40 active:scale-95 transition-transform duration-75"
              >
                {generating ? "作成中..." : "メッセージを作成"}
              </button>

              <button
                onClick={() => { setShowAixMenu(true); setShowStatusMenu(false); }}
                className="rounded-full border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#111b21] shadow-sm active:scale-95 transition-transform duration-75"
              >
                AIX
              </button>

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
            <div className={`flex items-center gap-2 rounded-[24px] bg-[#f0f2f5] px-4 py-2 transition-all ${inputFocused ? "rounded-[16px]" : ""}`}>
              <textarea
                ref={textareaRef}
                value={replyDraft}
                onChange={(e) => {
                  setReplyDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
                }}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                rows={1}
                placeholder="Aa"
                className="min-h-[22px] w-full resize-none overflow-hidden bg-transparent text-[14px] leading-6 text-[#111b21] outline-none placeholder:text-[#aaa]"
                style={{ height: "22px" }}
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
        <BottomNav unreadCount={needsReplyCount} hidden={navHidden} />
      </div>

      {/* トーク一覧 長押しメニュー */}
      {convMenuConvId && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20"
          onClick={() => setConvMenuConvId(null)}
        >
          <div
            className="overflow-hidden rounded-2xl bg-white shadow-2xl"
            style={{ minWidth: "270px", maxWidth: "310px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-3 text-center text-[13px] font-semibold text-[#111b21] border-b border-[#f0f2f5]">
              {conversations.find(c => c.id === convMenuConvId)?.customerName}
            </div>
            <div className="grid grid-cols-2">
              <button
                onClick={() => { setMemoModalConvId(convMenuConvId); setMemoInput(memos[convMenuConvId] || ""); setConvMenuConvId(null); }}
                className="flex flex-col items-center gap-2 px-4 py-5 active:bg-[#f0f2f5] border-r border-[#f0f2f5]"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </span>
                <div className="text-[13px] font-semibold text-[#111b21]">ノート</div>
                <div className="text-[10px] text-[#8696a0] text-center leading-tight">{memos[convMenuConvId] ? memos[convMenuConvId].slice(0, 16) + (memos[convMenuConvId].length > 16 ? "…" : "") : "ノートを追加"}</div>
              </button>
              <button
                onClick={() => { setAssigneeModalConvId(convMenuConvId); setAssigneeInput(assignees[convMenuConvId] || ""); setConvMenuConvId(null); }}
                className="flex flex-col items-center gap-2 px-4 py-5 active:bg-[#f0f2f5]"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </span>
                <div className="text-[13px] font-semibold text-[#111b21]">メモ</div>
                <div className="text-[10px] text-[#8696a0] text-center leading-tight">{assignees[convMenuConvId] ? `${assignees[convMenuConvId]}` : "名前を入力"}</div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 担当者入力モーダル */}
      {assigneeModalConvId && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setAssigneeModalConvId(null); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}>
              <div className="text-[16px] font-bold text-white">👤 メモ</div>
              <button onClick={() => setAssigneeModalConvId(null)} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white text-sm">✕</button>
            </div>
            <div className="p-4">
              <p className="mb-2 text-[12px] text-[#8696a0]">担当者の苗字を入力してください</p>
              <input
                value={assigneeInput}
                onChange={(e) => setAssigneeInput(e.target.value)}
                placeholder="例：竹内"
                className="w-full rounded-2xl border border-[#e9edef] bg-[#f0f2f5] px-4 py-3 text-[14px] text-[#111b21] outline-none"
                autoFocus
              />
              <div className="mt-3 flex gap-2">
                {assignees[assigneeModalConvId] && (
                  <button
                    onClick={() => saveAssignee(assigneeModalConvId, "")}
                    className="flex-1 rounded-full border border-[#e9edef] py-2.5 text-[13px] font-semibold text-[#667781]"
                  >
                    削除
                  </button>
                )}
                <button
                  onClick={() => saveAssignee(assigneeModalConvId, assigneeInput)}
                  className="flex-1 rounded-full py-2.5 text-[13px] font-bold text-white"
                  style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* メモ入力モーダル */}
      {memoModalConvId && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setMemoModalConvId(null); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}>
              <div className="text-[16px] font-bold text-white">
                📝 ノート — {conversations.find(c => c.id === memoModalConvId)?.customerName}
              </div>
              <button onClick={() => setMemoModalConvId(null)} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white text-sm">✕</button>
            </div>
            <div className="p-4">
              <textarea
                value={memoInput}
                onChange={(e) => setMemoInput(e.target.value)}
                placeholder="ノートを入力..."
                className="w-full rounded-2xl border border-[#e9edef] bg-[#f0f2f5] px-4 py-3 text-[14px] text-[#111b21] outline-none resize-none"
                rows={5}
                autoFocus
              />
              <div className="mt-3 flex gap-2">
                {memos[memoModalConvId] && (
                  <button
                    onClick={() => saveMemo(memoModalConvId, "")}
                    className="flex-1 rounded-full border border-[#e9edef] py-2.5 text-[13px] font-semibold text-[#667781]"
                  >
                    削除
                  </button>
                )}
                <button
                  onClick={() => saveMemo(memoModalConvId, memoInput)}
                  className="flex-1 rounded-full py-2.5 text-[13px] font-bold text-white"
                  style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* メモ全文表示ポップアップ */}
      {viewingMemoConvId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
          onClick={() => setViewingMemoConvId(null)}
        >
          <div className="w-full max-w-sm rounded-3xl bg-white shadow-2xl overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
              <span className="text-[14px] font-bold text-white">
                📝 {conversations.find(c => c.id === viewingMemoConvId)?.customerName}
              </span>
              <button onClick={() => setViewingMemoConvId(null)} className="text-white/80 text-sm">✕</button>
            </div>
            <div className="px-5 py-4">
              <p className="text-[14px] text-[#111b21] leading-relaxed whitespace-pre-wrap">{memos[viewingMemoConvId]}</p>
              <button
                onClick={() => { setMemoModalConvId(viewingMemoConvId); setMemoInput(memos[viewingMemoConvId] || ""); setViewingMemoConvId(null); }}
                className="mt-4 w-full rounded-full border border-[#e9edef] py-2 text-[12px] font-semibold text-[#1565C0]"
              >
                編集
              </button>
            </div>
          </div>
        </div>
      )}

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

      {showAnnouncementList && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAnnouncementList(false); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl">
            <div
              className="flex items-center justify-between rounded-t-3xl px-5 py-4"
              style={{ background: "linear-gradient(135deg, #f0a500, #f5c842)" }}
            >
              <div className="flex items-center gap-2 text-[17px] font-bold text-white">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
                アナウンス
              </div>
              <button
                onClick={() => setShowAnnouncementList(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
              >✕</button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4 flex flex-col gap-3">
              {announcements.map((ann) => (
                <div key={ann.id} className="flex items-start gap-3 rounded-2xl border border-[#e9edef] bg-[#fffbe6] px-4 py-3">
                  <span className="shrink-0 text-base">📌</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[#111b21] whitespace-pre-wrap break-words">
                      {ann.text !== "[画像]" ? ann.text : "📷 画像"}
                    </div>
                    <div className="mt-1 text-[10px] text-[#8696a0]">{ann.time}</div>
                  </div>
                  <button
                    onClick={() => setAnnouncements(prev => prev.filter(a => a.id !== ann.id))}
                    className="shrink-0 text-[#aaa] text-xs"
                  >✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ハンバーガーメニューモーダル */}
      {showHamburgerMenu && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) setShowHamburgerMenu(false); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl overflow-hidden">
            {/* ヘッダー：AIX Pro */}
            <div
              className="px-6 pt-6 pb-5"
              style={{ background: "linear-gradient(135deg, #0d1b3e, #1565C0, #2196F3)" }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[22px] font-black tracking-tight text-white">AIXLINX</span>
                    <span
                      className="rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white border border-white/50"
                      style={{ background: "rgba(255,255,255,0.15)" }}
                    >Pro</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/60 tracking-widest uppercase">Intelligent CRM</div>
                </div>
                <button
                  onClick={() => setShowHamburgerMenu(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:text-white"
                  style={{ background: "rgba(255,255,255,0.1)" }}
                >✕</button>
              </div>
            </div>

            {/* メニュー */}
            <div className="p-4 flex flex-col gap-3">
              {/* アカウント切替 */}
              <button
                onClick={() => { setShowHamburgerMenu(false); setShowAccountSwitcher(true); }}
                className="flex w-full items-center gap-4 rounded-2xl border border-[#e9edef] bg-[#f8f9fa] px-5 py-4 text-left active:scale-[0.98] transition-transform hover:bg-[#f0f2f5]"
              >
                {/* アバター */}
                <div className="shrink-0">
                  {currentAccount.profileImage ? (
                    <img src={currentAccount.profileImage} alt={currentAccount.name} className="h-11 w-11 rounded-full object-cover border-2 border-white shadow-sm" />
                  ) : (
                    <div className="flex h-11 w-11 items-center justify-center rounded-full text-2xl border-2 border-[#e9edef] bg-white shadow-sm">
                      {currentAccount.icon}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-bold text-[#111b21] truncate">{currentAccount.name}</div>
                  <div className="text-[11px] text-[#8696a0]">アカウント切替</div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M9 18l6-6-6-6" stroke="#aaa" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="pb-[max(20px,env(safe-area-inset-bottom))]" />
          </div>
        </div>
      )}

      {/* アカウント切替モーダル */}
      {showAccountSwitcher && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAccountSwitcher(false); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl">
            <div
              className="flex items-center justify-between rounded-t-3xl px-5 py-4"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
            >
              <div className="flex items-center gap-2">
                <div className="text-[17px] font-bold text-white">アカウント切替</div>
                <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-bold text-white border border-white/40">AIX Pro</span>
              </div>
              <button
                onClick={() => setShowAccountSwitcher(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
              >
                ✕
              </button>
            </div>
            <div className="p-5">
              <div className="mb-3 text-xs font-semibold text-[#8696a0]">使用中のアカウント</div>
              <div className={`flex w-full items-center gap-3 rounded-2xl border-2 px-4 py-3 mb-2 border-[#2196F3] bg-[#e3f2fd]`}>
                {/* プロフィール画像 */}
                <button
                  onClick={() => accountImageInputRef.current?.click()}
                  className="relative shrink-0"
                  title="画像を変更"
                >
                  {currentAccount.profileImage ? (
                    <img src={currentAccount.profileImage} alt={currentAccount.name} className="h-12 w-12 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#e3f2fd] text-2xl border-2 border-[#2196F3]">
                      {currentAccount.icon}
                    </div>
                  )}
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#2196F3] text-[9px] text-white font-bold">
                    ✎
                  </span>
                </button>
                <div className="flex-1">
                  <div className="text-sm font-bold text-[#1565C0]">{currentAccount.name}</div>
                  <div className="text-xs text-[#8696a0]">蓮産業株式会社 · 現在使用中</div>
                </div>
                <span className="text-[#2196F3] font-bold">✓</span>
              </div>
              <input
                ref={accountImageInputRef}
                type="file"
                accept="image/*"
                onChange={onAccountImageSelected}
                className="hidden"
              />
              <div className="mt-3 rounded-2xl bg-[#f0f2f5] px-4 py-3 text-center text-xs text-[#8696a0]">
                アカウントは順次追加予定です
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AIXメニュー（ボトムシート） */}
      {showAixMenu && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAixMenu(false); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl">
            <div
              className="flex items-center justify-between rounded-t-3xl px-5 py-4"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
            >
              <div className="text-[17px] font-bold text-white">AIX</div>
              <button
                onClick={() => setShowAixMenu(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
              >
                ✕
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              {[
                { icon: "🏠", label: "物件オススメ", sub: "おすすめ物件をAIが提案", action: () => { setShowAixMenu(false); openAixWithImagePicker("property_recommendation"); } },
                { icon: "💰", label: "見積書送る", sub: "費用の見積書を作成", action: () => { setShowAixMenu(false); openAixWithImagePicker("estimate_sheet"); } },
                { icon: "🔍", label: "内覧へ！", sub: "内覧の案内メッセージを作成", action: () => { setShowAixMenu(false); setAixInitialFile(null); setAixModalType("viewing_invite"); } },
                { icon: "✋", label: "申込へ！", sub: "申込のご案内メッセージを作成", action: () => { setShowAixMenu(false); setAixInitialFile(null); setAixModalType("application_push"); } },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="flex items-center gap-4 rounded-2xl border border-[#e9edef] bg-[#f8f9fa] px-4 py-3 text-left active:scale-[0.98] transition-transform"
                >
                  <span className="text-2xl">{item.icon}</span>
                  <div>
                    <div className="text-[14px] font-bold text-[#111b21]">{item.label}</div>
                    <div className="text-[11px] text-[#8696a0]">{item.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20"
          onClick={() => setContextMenu(null)}
        >
          <div
            className="overflow-hidden rounded-2xl bg-white shadow-2xl"
            style={{ minWidth: "270px", maxWidth: "310px" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* メッセージプレビュー */}
            {contextMenu.text && contextMenu.text !== "[画像]" && (
              <div className="border-b border-[#f0f2f5] px-4 py-3">
                <p className="line-clamp-2 text-[12px] leading-5 text-[#8696a0]">{contextMenu.text}</p>
              </div>
            )}
            {/* アクション横並び */}
            <div className="grid grid-cols-4 px-3 py-4">
              {[
                {
                  icon: (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#f5f5f5]">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                        <line x1="4" y1="22" x2="4" y2="15"/>
                      </svg>
                    </div>
                  ),
                  label: "要対応",
                  action: () => { toggleFlagged(contextMenu.messageId); setContextMenu(null); },
                },
                {
                  icon: (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#f5f5f5]">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                      </svg>
                    </div>
                  ),
                  label: "アナウンス",
                  action: () => {
                    const msg = selectedConversation.messages.find(m => m.id === contextMenu.messageId);
                    if (msg && !announcements.find(a => a.id === msg.id)) setAnnouncements(prev => [...prev, msg]);
                    setContextMenu(null);
                  },
                },
                {
                  icon: (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#f5f5f5]">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    </div>
                  ),
                  label: "コピー",
                  action: () => {
                    if (contextMenu.text && contextMenu.text !== "[画像]") navigator.clipboard.writeText(contextMenu.text);
                    setContextMenu(null);
                  },
                },
                {
                  icon: (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#f5f5f5]">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                      </svg>
                    </div>
                  ),
                  label: "部分コピー",
                  action: () => { setPartialCopyMessageId(contextMenu.messageId); setContextMenu(null); },
                },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="flex flex-col items-center gap-2 rounded-xl px-1 py-2 active:bg-[#f0f2f5]"
                >
                  {item.icon}
                  <span className="text-[11px] font-medium text-[#444]">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 部分コピーモーダル */}
      {partialCopyMessageId && (
        <div
          className="fixed inset-0 z-[91] flex items-center justify-center bg-black/60 px-6"
          onClick={() => setPartialCopyMessageId(null)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
              <div className="text-[15px] font-bold text-white">部分コピー</div>
              <div className="mt-0.5 text-[11px] text-white/70">テキストを長押しして選択→コピーしてください</div>
            </div>
            <div className="p-5">
              <p
                className="text-[15px] leading-6 text-[#111b21]"
                style={{ userSelect: "text", WebkitUserSelect: "text" }}
              >
                {selectedConversation.messages.find(m => m.id === partialCopyMessageId)?.text}
              </p>
            </div>
            <div className="px-5 pb-5">
              <button
                onClick={() => setPartialCopyMessageId(null)}
                className="w-full rounded-2xl py-3 text-[15px] font-bold text-white"
                style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
              >閉じる</button>
            </div>
          </div>
        </div>
      )}

      {/* 画像ライトボックス（スワイプ対応） */}
      {lightboxImages.length > 0 && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
          onClick={() => setLightboxImages([])}
          onTouchStart={(e) => { lightboxSwipeX.current = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            const delta = e.changedTouches[0].clientX - lightboxSwipeX.current;
            if (delta < -50 && lightboxIndex < lightboxImages.length - 1) {
              setLightboxIndex((i) => i + 1);
            } else if (delta > 50 && lightboxIndex > 0) {
              setLightboxIndex((i) => i - 1);
            }
          }}
        >
          <img
            src={lightboxImages[lightboxIndex]}
            alt="拡大画像"
            className="max-h-[90svh] max-w-[96vw] rounded-xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          {/* 左矢印 */}
          {lightboxIndex > 0 && (
            <button
              className="absolute left-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white text-xl"
              onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => i - 1); }}
            >
              ‹
            </button>
          )}
          {/* 右矢印 */}
          {lightboxIndex < lightboxImages.length - 1 && (
            <button
              className="absolute right-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white text-xl"
              onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => i + 1); }}
            >
              ›
            </button>
          )}
          {/* ドットインジケーター */}
          {lightboxImages.length > 1 && (
            <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-1.5">
              {lightboxImages.map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 w-1.5 rounded-full transition-all ${i === lightboxIndex ? "bg-white scale-125" : "bg-white/40"}`}
                />
              ))}
            </div>
          )}
          {/* 閉じるボタン */}
          <button
            onClick={() => setLightboxImages([])}
            className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white text-lg"
          >
            ✕
          </button>
        </div>
      )}
    </main>
  );
}