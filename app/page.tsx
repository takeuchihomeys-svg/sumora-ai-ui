"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AixModal, { type AixActionType } from "./components/AixModal";
import BottomNav from "./components/BottomNav";
import TemplateModal from "./components/TemplateModal";
import { supabase } from "./lib/supabase";
import { registerSW, requestNotifPermission, showNotif, subscribePush } from "./lib/notifications";

type Message = {
  id: string;
  sender: "customer" | "staff";
  text: string;
  imageUrl?: string;
  imageExpiresAt?: string;
  time: string;
  rawCreatedAt?: string;
};

type Conversation = {
  id: string;
  customerName: string;
  lastMessage: string;
  lastSender?: string;
  status: string;
  lineUserId: string;
  profileImageUrl?: string;
  updatedAt?: string;
  account?: string;
  propertyCustomerId?: string;
  isPostApply?: boolean;
  isHot?: boolean;
  isFlagged?: boolean;
  messages: Message[];
};

type SupabaseConversationRow = {
  id: string;
  customer_name: string | null;
  status: string | null;
  line_user_id: string;
  last_message?: string | null;
  last_sender?: string | null;
  updated_at?: string | null;
  profile_image_url?: string | null;
  account?: string | null;
  property_customer_id?: string | null;
  is_post_apply?: boolean | null;
  is_hot?: boolean | null;
  is_flagged?: boolean | null;
};

type SupabaseMessageRow = {
  id: string;
  conversation_id: string;
  sender: "customer" | "staff";
  text: string;
  image_url?: string | null;
  image_expires_at?: string | null;
  created_at: string;
};

// ステータス（4段階）
const DETAIL_STATUSES = [
  { key: "hearing",    label: "初回対応",     color: "bg-blue-100 text-blue-700",     dot: "bg-blue-400" },
  { key: "proposing",  label: "物件提案中",   color: "bg-orange-100 text-orange-700", dot: "bg-orange-400" },
  { key: "applying",   label: "申込・審査中", color: "bg-pink-100 text-pink-700",     dot: "bg-pink-500" },
  { key: "closed_won", label: "ご成約",       color: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-400" },
];

// 旧ステータスキーの後方互換マッピング
const STATUS_ALIAS: Record<string, string> = {
  first_reply:             "hearing",
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

function getDetailStatusMeta(statusKey: string) {
  const key = STATUS_ALIAS[statusKey] ?? statusKey;
  return DETAIL_STATUSES.find((s) => s.key === key) ?? {
    key: statusKey,
    label: statusKey,
    color: "bg-gray-100 text-gray-700",
    dot: "bg-gray-400",
  };
}

// getGroupMeta は getDetailStatusMeta の別名（後方互換）
function getGroupMeta(statusKey: string) {
  return getDetailStatusMeta(statusKey);
}


function getInitial(name: string) {
  return name?.trim()?.charAt(0) || "?";
}

// \u30a2\u30ab\u30a6\u30f3\u30c8\u5b9a\u7fa9\uff08\u30d5\u30a3\u30eb\u30bf\u30fc\u30fb\u30d0\u30c3\u30b8\u30fb\u30d4\u30c3\u30ab\u30fc\u5171\u901a\uff09
const ACCOUNT_LIST = [
  { key: "sumora", label: "\u30b9\u30e2\u30e9",   icon: "\ud83e\udd95", image: "/images/sumora-mascot.png",  color: "bg-gray-100 text-gray-400" },
  { key: "ieyasu", label: "\u30a4\u30a8\u30e4\u30b9", icon: "\u26e9\ufe0f", image: "/images/ieyasu-mascot.png", color: "bg-gray-100 text-gray-400" },
  { key: "giga",   label: "\u30ae\u30ac\u8cc3\u8cb8", icon: "\ud83d\udc26", image: "/images/giga-mascot.png",   color: "bg-gray-100 text-gray-400" },
  { key: "hasu",   label: "\u30cf\u30b9",     icon: "\ud83c\udf38", image: null,                         color: "bg-gray-100 text-gray-400" },
] as const;
type AccountKey = typeof ACCOUNT_LIST[number]["key"];

function getAccountMeta(account?: string | null) {
  return ACCOUNT_LIST.find((a) => a.key === account) ?? ACCOUNT_LIST[0]; // \u672a\u8a2d\u5b9a\u306f\u30b9\u30e2\u30e9
}

type PropertyCustomerRow = {
  id: string;
  customer_name: string;
  status?: string | null;
  last_property_sent_at?: string | null;
  desired_area?: string | null;
  floor_plan?: string | null;
  rent_min?: number | null;
  rent_max?: number | null;
  move_in_time?: string | null;
  walk_minutes?: number | null;
  preferences?: string | null;
  ng_points?: string | null;
  other_requests?: string | null;
  building_age?: number | null;
  additional_conditions?: string | null;
  ai_summary?: string | null;
};

// 物件出しステータス（売上サポのStatusと対応）
const PROPERTY_STATUS_LABELS: Record<string, string> = {
  new_inquiry: "新規",
  hot: "毎日",
  property_search: "物件出し",
  pending: "検討中",
};
const PROPERTY_STATUS_COLORS: Record<string, string> = {
  new_inquiry: "bg-red-100 text-red-700",
  hot: "bg-orange-100 text-orange-700",
  property_search: "bg-blue-100 text-blue-700",
  pending: "bg-gray-100 text-gray-400",
};
function propertyNeedsAction(status: string, lastSentAt?: string | null): boolean {
  if (status === "pending") return false;
  if (status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (status === "hot") return !lastSentAt || new Date(lastSentAt) < todayStart;
  if (status === "property_search") {
    if (!lastSentAt) return true;
    return (now.getTime() - new Date(lastSentAt).getTime()) / 86400000 >= 3;
  }
  return false;
}

function formatConditions(customer: PropertyCustomerRow): string {
  const lines: string[] = [];
  if (customer.desired_area) lines.push(`\u30a8\u30ea\u30a2: ${customer.desired_area}`);
  if (customer.floor_plan) lines.push(`\u9593\u53d6\u308a: ${customer.floor_plan}`);
  const rentParts: string[] = [];
  if (customer.rent_min) rentParts.push(`${Math.floor(customer.rent_min / 10000)}\u4e07\u5186\u301c`);
  if (customer.rent_max) rentParts.push(`${Math.floor(customer.rent_max / 10000)}\u4e07\u5186\u4ee5\u5185`);
  if (rentParts.length > 0) lines.push(`\u5bb6\u8cc3: ${rentParts.join("")}`);
  if (customer.walk_minutes) lines.push(`\u99c5\u5f92\u6b69: ${customer.walk_minutes}\u5206\u4ee5\u5185`);
  if (customer.move_in_time) lines.push(`\u5165\u5c45: ${customer.move_in_time}`);
  if (customer.building_age) lines.push(`\u7bc9\u5e74\u6570: ${customer.building_age}\u5e74\u4ee5\u5185`);
  if (customer.preferences) lines.push(`\u5e0c\u671b: ${customer.preferences}`);
  if (customer.ng_points) lines.push(`NG: ${customer.ng_points}`);
  if (customer.other_requests) lines.push(`\u305d\u306e\u4ed6: ${customer.other_requests}`);
  if (customer.additional_conditions) {
    const cleanAdditional = customer.additional_conditions
      .split("\n")
      .map((line) => line.replace(/^\u3010[^\u3011]*\u3011/, "").trim())
      .filter(Boolean)
      .join("\u3001");
    if (cleanAdditional) lines.push(`\u8ffd\u52a0\u6761\u4ef6: ${cleanAdditional}`);
  }
  return lines.join("\n");
}

// \u9023\u7d9a\u753b\u50cf\u30e1\u30c3\u30bb\u30fc\u30b8\u30921\u4ef6\u306b\u307e\u3068\u3081\u3066\u30b0\u30ea\u30c3\u30c9\u8868\u793a\u3059\u308b\uff08LINE\u98a8\uff09
// \u540c\u4e00\u9001\u4fe1\u8005\u30fb30\u79d2\u4ee5\u5185\u30fb[\u753b\u50cf]\u30c6\u30ad\u30b9\u30c8\u306e\u307f \u2192 imageUrl\u3092JSON\u914d\u5217\u306b\u7d71\u5408
function groupImageMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let i = 0;
  const isImgOnly = (m: Message) => !!m.imageUrl && (m.text === "[\u753b\u50cf]" || m.text === "");
  const extractUrls = (url: string): string[] => {
    try { return url.startsWith("[") ? (JSON.parse(url) as string[]) : [url]; }
    catch { return [url]; }
  };
  while (i < messages.length) {
    const msg = messages[i];
    if (isImgOnly(msg)) {
      const urls = extractUrls(msg.imageUrl!);
      const sender = msg.sender;
      let j = i + 1;
      while (j < messages.length && urls.length < 9) {
        const nxt = messages[j];
        const diff = Math.abs(
          new Date(nxt.rawCreatedAt || "").getTime() -
          new Date(messages[j - 1].rawCreatedAt || "").getTime()
        );
        if (isImgOnly(nxt) && nxt.sender === sender && diff < 30000) {
          urls.push(...extractUrls(nxt.imageUrl!));
          j++;
        } else break;
      }
      result.push({ ...msg, imageUrl: urls.length === 1 ? urls[0] : JSON.stringify(urls) });
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
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
  const [starredMsgIds, setStarredMsgIds] = useState<Set<string>>(new Set());
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
  const chatSwipeStart = useRef<{ x: number; y: number } | null>(null);
  const [chatSwipeDelta, setChatSwipeDelta] = useState(0);
  const swipeBlockClickRef = useRef(false); // スワイプ直後の合成クリックをブロック

  const [selectedImageFiles, setSelectedImageFiles] = useState<File[]>([]);
  const [selectedImagePreviews, setSelectedImagePreviews] = useState<string[]>([]);
  const [aixModalType, setAixModalType] = useState<AixActionType | null>(null);
  const [aixInitialFile, setAixInitialFile] = useState<File | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [announcements, setAnnouncements] = useState<Message[]>([]);
  const [showAnnouncementList, setShowAnnouncementList] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number; text: string; sender: string } | null>(null);
  const [targetOverrideMessage, setTargetOverrideMessage] = useState<{ id: string; text: string } | null>(null);
  const [partialCopyMessageId, setPartialCopyMessageId] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const lightboxSwipeX = useRef(0);
  const [flaggedConvIds, setFlaggedConvIds] = useState<Set<string>>(new Set());
  const [hotConvIds, setHotConvIds] = useState<Set<string>>(new Set());
  const [manuallyReadAt, setManuallyReadAt] = useState<Record<string, string>>({});
  const convLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [memos, setMemos] = useState<Record<string, string>>({});
  const [memoModalConvId, setMemoModalConvId] = useState<string | null>(null);
  const [memoInput, setMemoInput] = useState("");
  const [viewingMemoConvId, setViewingMemoConvId] = useState<string | null>(null);
  const [convMenuConvId, setConvMenuConvId] = useState<string | null>(null);
  const [activeTasks, setActiveTasks] = useState<Record<string, Array<{ id: string; task_type: string; created_at: string; customer_name: string }>>>({});
  const [showKnowledgeModal, setShowKnowledgeModal] = useState(false);
  const [knowledgeRules, setKnowledgeRules] = useState<Array<{ id: string; content: string; conversation_state: string; created_at: string; title: string }>>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [accountChangeConvId, setAccountChangeConvId] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [assigneeModalConvId, setAssigneeModalConvId] = useState<string | null>(null);
  const [assigneeInput, setAssigneeInput] = useState("");
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiSearchIds, setAiSearchIds] = useState<string[] | null>(null);
  const [aiSearchMessageIds, setAiSearchMessageIds] = useState<Record<string, string[]>>({});
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  const [aixSearchMode, setAixSearchMode] = useState(false);
  const [accountFilter, setAccountFilter] = useState<"all" | "linked" | "sumora" | "ieyasu" | "giga">("all");
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");
  const [replyExamplesCount, setReplyExamplesCount] = useState<number | null>(null);
  const [linkedLineUserIds, setLinkedLineUserIds] = useState<Set<string>>(new Set());
  const [postApplyConvIds, setPostApplyConvIds] = useState<Set<string>>(new Set<string>());
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [linkModalConvId, setLinkModalConvId] = useState<string | null>(null);
  const [linkSearchQuery, setLinkSearchQuery] = useState("");
  const [propertyCustomers, setPropertyCustomers] = useState<Array<{ id: string; customer_name: string; desired_area?: string | null; floor_plan?: string | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null; ng_points?: string | null; walk_minutes?: number | null; other_requests?: string | null; rent_min?: number | null; building_age?: number | null }>>([]);
  // convId → linked property customer（条件テキスト含む）
  const [linkedCustomerMap, setLinkedCustomerMap] = useState<Record<string, { id: string; name: string; conditions: string; propertyStatus?: string; lastPropertySentAt?: string | null; ai_summary?: string | null }>>({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const aixFileInputRef = useRef<HTMLInputElement | null>(null);
  const accountLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAixTypeRef = useRef<AixActionType | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const justOpenedRef = useRef(false); // 会話を開いた直後フラグ（メッセージ取得完了後に最下部強制スクロール）
  const scrollAfterFetchRef = useRef<string>(""); // Effect1でfetch完了したconvId → Effect3でスクロール
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const notifiedCalendarIds = useRef<Set<string>>(new Set());
  const aiDraftRef = useRef<string>("");
  const replyTargetCustomerMsgRef = useRef<string>("");
  // 送信済みメッセージID → save-reply-example の ID（☆PATCH に使用）
  const savedExampleIdByMsgId = useRef<Map<string, string>>(new Map());
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  // 選択中会話にお客様メッセージが届いたとき強制スクロールするフラグ
  const forceScrollForCustomerMsgRef = useRef(false);
  // リアルタイムハンドラ内でのstale closure防止（selectedIdを常に最新に保つ）
  const selectedIdRef = useRef("");
  selectedIdRef.current = selectedId; // レンダリングごとに最新値を反映
  const handleListScroll = () => {
    // スクロール時もBottomNavは常に表示（pull-to-refreshトリガー用）
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  };

  // スワイプ直後の合成クリック（BottomNavリンク等への誤遷移）をドキュメントレベルでブロック
  // Next.js Linkはclickで動くのでclickのみブロック。touchstartは対象外（スクロール阻害を防ぐ）
  // お客さん一覧からのLINE画面直接遷移（?conv=<id>）
  const convParamRef = useRef<string | null>(null);
  useEffect(() => {
    const convParam = new URLSearchParams(window.location.search).get("conv");
    if (convParam) {
      convParamRef.current = convParam;
      setSelectedId(convParam);
      setMobileView("chat");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const block = (e: MouseEvent) => {
      if (swipeBlockClickRef.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener("click", block, { capture: true });
    return () => document.removeEventListener("click", block, { capture: true });
  }, []);

  useEffect(() => {
    // SW登録 + 通知許可 + Web Push登録
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotifPermission(Notification.permission);
    }
    registerSW().then(async () => {
      const granted = await requestNotifPermission();
      if (granted) {
        setNotifPermission("granted");
        await subscribePush();
      }
    });

    // LINE返信AI学習データ件数
    supabase.from("ai_reply_examples").select("id", { count: "exact", head: true })
      .then(({ count }) => { if (count !== null) setReplyExamplesCount(count); });

    // 紐付け済フィルター用：property_customersのline_user_idを取得
    fetch("/api/property-customers")
      .then((r) => r.ok ? r.json() : [])
      .then((data: { line_user_id?: string }[]) => {
        const ids = new Set(data.map((c) => c.line_user_id).filter(Boolean) as string[]);
        setLinkedLineUserIds(ids);
      })
      .catch(() => {});

    fetchConversationsAndMessages();

    // アクティブなタスク一覧を取得（Realtime フォールバック兼用）
    const refreshActiveTasks = () =>
      fetch("/api/line-tasks")
        .then((r) => r.ok ? r.json() : { tasks: [] })
        .then((d: { tasks: Array<{ id: string; conversation_id: string; task_type: string; created_at: string; customer_name: string }> }) => {
          const map: Record<string, Array<{ id: string; task_type: string; created_at: string; customer_name: string }>> = {};
          for (const t of d.tasks ?? []) {
            if (!map[t.conversation_id]) map[t.conversation_id] = [];
            map[t.conversation_id].push({ id: t.id, task_type: t.task_type, created_at: t.created_at, customer_name: t.customer_name });
          }
          setActiveTasks(map);
        })
        .catch(() => {});

    refreshActiveTasks();

    // Supabase real-time: 新しいメッセージ・会話をリアルタイム反映
    const channel = supabase
      .channel("realtime-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversations" },
        () => {
          // 新規会話が届いたらサイレントで全件再取得
          fetchConversationsAndMessages(true);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations" },
        () => {
          fetchConversationsAndMessages(true);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          // お客様メッセージが届いたら通知＋手動既読を解除
          if (payload.new && (payload.new as { sender: string }).sender === "customer") {
            const msgText = (payload.new as { text?: string }).text || "新しいメッセージが届きました";
            showNotif("AIX LINX — 新着メッセージ", msgText, "/");
            const cid = String((payload.new as { conversation_id: number }).conversation_id);
            // 返信入力中でも選択中の会話に届いたなら強制スクロール
            if (cid === selectedIdRef.current) forceScrollForCustomerMsgRef.current = true;
          }
          const newMsg = payload.new as { id: number; conversation_id: number; sender: string; text: string; image_url?: string; created_at: string };
          if (!newMsg?.id) {
            fetchConversationsAndMessages(true);
            return;
          }

          // refで会話が存在するか確認（setState内でfetchを呼ぶのを避けるため）
          const found = conversationsRef.current.some((c) => c.id === String(newMsg.conversation_id));
          if (!found) {
            // 新規会話のメッセージ → サイレントで全件再取得
            fetchConversationsAndMessages(true);
            return;
          }

          const msg = {
            id: String(newMsg.id),
            sender: newMsg.sender as "customer" | "staff",
            text: newMsg.text,
            imageUrl: newMsg.image_url || undefined,
            time: formatTime(newMsg.created_at),
            rawCreatedAt: newMsg.created_at,
          };

          setConversations((prev) => {
            const next = prev.map((c) => {
              if (c.id !== String(newMsg.conversation_id)) return c;
              if (c.messages.some((m) => m.id === String(newMsg.id))) {
                return { ...c, lastMessage: newMsg.text, lastSender: newMsg.sender, updatedAt: newMsg.created_at };
              }
              return { ...c, messages: [...c.messages, msg], lastMessage: newMsg.text, lastSender: newMsg.sender, updatedAt: newMsg.created_at };
            }).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
            conversationsRef.current = next;
            return next;
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages" },
        (payload) => {
          // image_url が後から埋まったとき（画像メッセージの非同期取得）に反映する
          const upd = payload.new as { id: number; conversation_id: number; image_url?: string; image_expires_at?: string };
          if (!upd?.id || !upd.image_url) return;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== String(upd.conversation_id)) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === String(upd.id) ? { ...m, imageUrl: upd.image_url, imageExpiresAt: upd.image_expires_at || undefined } : m
                ),
              };
            })
          );
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          fetchConversationsAndMessages(true);
        }
      });

    // フォールバック: 3秒ごとにポーリング（realtime漏れ対策・返信中に届いたメッセージも確実に反映）
    // タスクバッジも同期（Realtime publication 未設定 or 接続切れ時のフォールバック）
    const pollInterval = setInterval(() => {
      fetchConversationsAndMessages(true);
      refreshActiveTasks();
    }, 3_000);

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

    // line_tasks リアルタイム購読（自動検知タスクをUIに即時反映）
    const taskChannel = supabase
      .channel("realtime-line-tasks")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "line_tasks" },
        (payload) => {
          const t = payload.new as { id: string; conversation_id: string; task_type: string; created_at: string; customer_name: string; status: string };
          if (t.status === "pending") {
            setActiveTasks((prev) => {
              const existing = prev[t.conversation_id] ?? [];
              if (existing.some((x) => x.id === t.id)) return prev;
              return { ...prev, [t.conversation_id]: [...existing, { id: t.id, task_type: t.task_type, created_at: t.created_at, customer_name: t.customer_name }] };
            });
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "line_tasks" },
        (payload) => {
          const t = payload.new as { id: string; conversation_id: string; status: string };
          if (t.status === "completed" || t.status === "cancelled") {
            setActiveTasks((prev) => {
              const filtered = (prev[t.conversation_id] ?? []).filter((x) => x.id !== t.id);
              if (filtered.length === 0) {
                const next = { ...prev }; delete next[t.conversation_id]; return next;
              }
              return { ...prev, [t.conversation_id]: filtered };
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(taskChannel);
      clearInterval(calendarAlarm);
      clearInterval(pollInterval);
    };
  }, []);

  // 会話を開いたとき：その会話の全メッセージを再取得（90日制限を超える古い履歴も表示）
  useEffect(() => {
    if (!selectedId) return;
    supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", selectedId)
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          // 文字列IDで失敗した場合は数値IDでリトライ
          const convIdNum = Number(selectedId);
          if (!isNaN(convIdNum)) {
            supabase
              .from("messages")
              .select("*")
              .eq("conversation_id", convIdNum)
              .order("created_at", { ascending: true })
              .then(({ data: data2 }) => {
                if (!data2 || data2.length === 0) return;
                const msgs = data2.map((m: SupabaseMessageRow) => ({
                  id: String(m.id),
                  sender: m.sender,
                  text: m.text,
                  imageUrl: m.image_url || undefined,
                  imageExpiresAt: m.image_expires_at || undefined,
                  time: formatTime(m.created_at),
                  rawCreatedAt: m.created_at,
                }));
                setConversations((prev) =>
                  prev.map((c) => (c.id === selectedId ? { ...c, messages: msgs } : c))
                );
                scrollAfterFetchRef.current = selectedId;
                // DOM描画後に追加スクロール（フォールバック）
                setTimeout(() => { if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight; }, 80);
              });
          }
          return;
        }
        if (!data || data.length === 0) {
          // 空データで上書きしない（既存メッセージを保持）
          return;
        }
        const msgs = data.map((m: SupabaseMessageRow) => ({
          id: String(m.id),
          sender: m.sender,
          text: m.text,
          imageUrl: m.image_url || undefined,
          imageExpiresAt: m.image_expires_at || undefined,
          time: formatTime(m.created_at),
          rawCreatedAt: m.created_at,
        }));
        scrollAfterFetchRef.current = selectedId;
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, messages: msgs } : c))
        );
        // DOM描画後に追加スクロール（長い履歴がレンダリングされた後を保証）
        setTimeout(() => { if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight; }, 80);
      });
  }, [selectedId]);

  // scrollTop を直接セットする最確実スクロール（scrollIntoView より信頼性が高い）
  const scrollToBottom = () => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // 会話を開いたとき：DOM描画後に最下部へ（requestAnimationFrameで描画完了を待つ）
  useEffect(() => {
    if (!selectedId) return;
    const matchedMsgIds = aiSearchMessageIds[selectedId] || [];
    if (matchedMsgIds.length > 0) {
      // AI検索マッチがあればそのメッセージへ
      setTimeout(() => {
        const el = document.getElementById(`msg-${matchedMsgIds[0]}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        else scrollToBottom();
      }, 100);
    } else {
      // 描画完了後に最下部へ（hidden→flex切替後のレイアウト確定を待つため2段RAF+タイムアウト）
      justOpenedRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()));
      setTimeout(() => { if (justOpenedRef.current) { justOpenedRef.current = false; scrollToBottom(); } }, 120);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // メッセージ更新時スクロール
  useEffect(() => {
    if (!chatScrollRef.current) return;
    if (scrollAfterFetchRef.current) {
      // Effect1のfetch完了 → 確実に最下部へ（全メッセージ描画後）
      scrollAfterFetchRef.current = "";
      justOpenedRef.current = false;
      scrollToBottom();
      return;
    }
    if (justOpenedRef.current) {
      // 既存メッセージが先に更新された場合のフォールバック
      justOpenedRef.current = false;
      scrollToBottom();
      return;
    }
    // 選択中の会話にお客様メッセージが届いたら返信中でも強制スクロール
    if (forceScrollForCustomerMsgRef.current) {
      forceScrollForCustomerMsgRef.current = false;
      scrollToBottom();
      return;
    }
    // リアルタイム受信・ポーリング：下部付近にいるときだけスクロール
    const el = chatScrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 150) {
      el.scrollTop = el.scrollHeight;
    }
  }, [conversations]);

  const fetchConversationsAndMessages = async (silent = false) => {
    if (!silent) setPageLoading(true);
    if (!silent) setError("");

    const { data: conversationRows, error: conversationError } = await supabase
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (conversationError) {
      console.error(conversationError);
      setError("会話一覧の取得に失敗しました。");
      setPageLoading(false);
      return;
    }

    // 直近90日のメッセージのみ取得（新しい順で5000件 → 古いメッセージで枠が埋まるのを防ぐ）
    const since90Days = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: messageRows, error: messageError } = await supabase
      .from("messages")
      .select("*")
      .gte("created_at", since90Days)
      .order("created_at", { ascending: false })
      .limit(5000);

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
        .filter((message) => String(message.conversation_id) === String(conversation.id))
        .map((message) => ({
          id: String(message.id),
          sender: message.sender,
          text: message.text,
          imageUrl: message.image_url || undefined,
          imageExpiresAt: message.image_expires_at || undefined,
          time: formatTime(message.created_at),
          rawCreatedAt: message.created_at,
        }))
        .sort((a, b) => (a.rawCreatedAt || "").localeCompare(b.rawCreatedAt || ""));

      // 最新メッセージを使って lastMessage/lastSender/updatedAt を決定
      // DB の last_message は screening-admin 側の更新タイミングに依存するためズレが生じる
      // relatedMessages（直接取得）を優先し、DB値はフォールバックとして使う
      const latestMsg = relatedMessages.length > 0 ? relatedMessages[relatedMessages.length - 1] : null;
      const lastMessage = latestMsg?.text || conversation.last_message || "メッセージなし";
      const lastSender = latestMsg?.sender || conversation.last_sender || undefined;

      // effectiveUpdatedAt = max(DB updated_at, 最新メッセージ created_at)
      const latestMsgTime = latestMsg?.rawCreatedAt || null;
      const dbUpdatedAt = conversation.updated_at || null;
      const effectiveUpdatedAt =
        latestMsgTime && (!dbUpdatedAt || latestMsgTime > dbUpdatedAt)
          ? latestMsgTime
          : (dbUpdatedAt || undefined);

      // スタッフ返信なし → hearing（件数制限なし）
      const hasStaffReply = relatedMessages.some((m) => m.sender === "staff");
      const autoStatus =
        !hasStaffReply
          ? "hearing"
          : (conversation.status || "hearing");

      return {
        id: String(conversation.id),
        customerName: conversation.customer_name || "名称未設定",
        lastMessage,
        lastSender,
        status: autoStatus,
        lineUserId: conversation.line_user_id,
        profileImageUrl: conversation.profile_image_url || undefined,
        updatedAt: effectiveUpdatedAt,
        account: conversation.account || undefined,
        propertyCustomerId: conversation.property_customer_id || undefined,
        isPostApply: conversation.is_post_apply ?? false,
        isHot: conversation.is_hot ?? false,
        isFlagged: conversation.is_flagged ?? false,
        messages: relatedMessages,
      };
    });

    // 既存のメッセージ配列の方が長い場合は保持（ポーリングによる縮退を防ぐ）
    // メッセージを保持する場合もメタデータ（lastMessage等）は新しい値を使う
    setConversations((prev) => {
      const prevMap = new Map(prev.map((c) => [c.id, c]));
      const next = formatted.map((conv) => {
        const existing = prevMap.get(conv.id);
        if (existing && existing.messages.length > conv.messages.length) {
          // メッセージ数は既存を保持するが、lastMessage/lastSender/updatedAt は
          // 既存のメッセージ配列の末尾から再計算して常に最新を反映させる
          const latestExisting = existing.messages[existing.messages.length - 1];
          return {
            ...conv,
            messages: existing.messages,
            lastMessage: latestExisting?.text || conv.lastMessage,
            lastSender: latestExisting?.sender || conv.lastSender,
            updatedAt:
              latestExisting?.rawCreatedAt &&
              (!conv.updatedAt || latestExisting.rawCreatedAt > conv.updatedAt)
                ? latestExisting.rawCreatedAt
                : conv.updatedAt,
          };
        }
        return conv;
      }).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      conversationsRef.current = next;
      return next;
    });

    if (formatted.length > 0) {
      setSelectedId((prev) => prev || formatted[0].id);
    }

    // DBのis_post_applyをpostApplyConvIdsに反映
    setPostApplyConvIds(new Set(formatted.filter((c) => c.isPostApply).map((c) => c.id)));

    // DBのis_hotをhotConvIdsに反映（Supabaseが正）
    setHotConvIds(new Set(formatted.filter((c) => c.isHot).map((c) => c.id)));

    // DBのis_flaggedをflaggedConvIdsに反映（Supabaseが正）
    setFlaggedConvIds(new Set(formatted.filter((c) => c.isFlagged).map((c) => c.id)));

    // 紐付け済み物件顧客を取得してlinkedCustomerMapを構築
    const propCustomerIds = [...new Set(
      formatted.map((c) => c.propertyCustomerId).filter(Boolean) as string[]
    )];
    if (propCustomerIds.length > 0) {
      const { data: pcData } = await supabase
        .from("property_customers")
        .select("id,customer_name,status,last_property_sent_at,desired_area,floor_plan,rent_min,rent_max,move_in_time,preferences,ng_points,walk_minutes,other_requests,building_age,additional_conditions,ai_summary")
        .in("id", propCustomerIds);
      if (pcData) {
        const map: Record<string, { id: string; name: string; conditions: string; propertyStatus?: string; lastPropertySentAt?: string | null; ai_summary?: string | null }> = {};
        for (const conv of formatted) {
          if (!conv.propertyCustomerId) continue;
          const pc = (pcData as PropertyCustomerRow[]).find((d) => d.id === conv.propertyCustomerId);
          if (pc) {
            map[conv.id] = {
              id: pc.id,
              name: pc.customer_name,
              conditions: formatConditions(pc),
              propertyStatus: pc.status || undefined,
              lastPropertySentAt: pc.last_property_sent_at || null,
              ai_summary: pc.ai_summary || null,
            };
          }
        }
        setLinkedCustomerMap((prev) => ({ ...prev, ...map }));
      }
    }

    if (!silent) setPageLoading(false);
  };

  const filteredConversations = useMemo(() => {
    let result = conversations;
    // アカウントフィルター
    if (accountFilter === "linked") {
      result = result.filter((c) => !!linkedCustomerMap[c.id]);
    } else if (accountFilter !== "all") {
      result = result.filter((c) => (c.account ?? "sumora") === accountFilter);
    }
    if (statusFilter === "hot_flag") {
      result = result.filter((c) => hotConvIds.has(c.id));
    } else if (statusFilter !== "all") {
      // 5段階ステータスキーで直接フィルター（旧キーもエイリアスで統一）
      result = result.filter((c) => (STATUS_ALIAS[c.status] ?? c.status) === statusFilter);
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
  }, [conversations, statusFilter, searchQuery, aiSearchIds, accountFilter, linkedLineUserIds, hotConvIds]);

  const needsReplyCount = useMemo(() => {
    return conversations.filter((c) => {
      if (postApplyConvIds.has(c.id)) return false;
      const readAt = manuallyReadAt[c.id];
      if (readAt) {
        const msgs = c.messages;
        let lastCustTime: string | null = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].sender === "customer") { lastCustTime = msgs[i].rawCreatedAt ?? null; break; }
        }
        if (!lastCustTime || lastCustTime <= readAt) return false;
      }
      const sender = c.lastSender ?? c.messages[c.messages.length - 1]?.sender;
      return sender === "customer" && c.status !== "closed_won";
    }).length;
  }, [conversations, postApplyConvIds, manuallyReadAt]);

  useEffect(() => {
    if (filteredConversations.length === 0) return;
    // URLパラメータ指定の会話は自動上書きしない
    if (convParamRef.current && convParamRef.current === selectedId) return;
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
        status: "hearing",
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
    aiDraftRef.current = "";
    replyTargetCustomerMsgRef.current = "";
    setTargetOverrideMessage(null);
  }, [selectedConversation.id]);

  // replyDraftが変わったらtextareaの高さを自動調整
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 250)}px`;
  }, [replyDraft]);

  const latestCustomerMessage = useMemo(() => {
    const customerMessages = selectedConversation.messages.filter(
      (message) => message.sender === "customer"
    );
    return customerMessages[customerMessages.length - 1]?.text ?? "";
  }, [selectedConversation]);

  const detailStatusMeta = getDetailStatusMeta(selectedConversation.status);

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
        .eq("id", selectedConversation.id);

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
    if (!selectedConversation.id) return;

    const msgs = selectedConversation.messages;

    // 長押しで指定したメッセージがある場合：そのメッセージまでの会話履歴のみ渡す
    // → AIが「それ以降の会話」を見て混乱しないようにする
    let targetMessage: string;
    let contextMsgs: typeof msgs;

    if (targetOverrideMessage?.text?.trim()) {
      targetMessage = targetOverrideMessage.text.trim();
      // IDで正確にメッセージ位置を特定してそれ以降を除外（テキスト一致より確実）
      const idx = msgs.findLastIndex(
        (m) => m.id === targetOverrideMessage.id
      );
      contextMsgs = idx >= 0 ? msgs.slice(0, idx + 1) : msgs;
    } else {
      // 最後のスタッフ返信以降のお客さんメッセージを全部連結（最大3件）
      // 例: お客さんが①「この物件は？」②「あとこっちも」③「予算変わりました」→3件まとめてAIへ
      const lastStaffIdx = msgs.map((m, i) => m.sender === "staff" ? i : -1).filter(i => i >= 0).at(-1);
      const msgsAfterStaff = lastStaffIdx !== undefined ? msgs.slice(lastStaffIdx + 1) : msgs;
      const unrepliedCustomerMsgs = msgsAfterStaff
        .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .slice(-3);
      targetMessage = unrepliedCustomerMsgs.length > 0
        ? unrepliedCustomerMsgs.map((m) => m.text).join("\n")
        : latestCustomerMessage.trim() || msgs[msgs.length - 1]?.text || "";
      contextMsgs = msgs;
    }

    if (!targetMessage.trim()) {
      setError("メッセージが読み込まれていません。しばらく待ってから再試行してください。");
      return;
    }

    try {
      setGenerating(true);
      setError("");
      setReplyDraft("");

      // スタッフ返信ゼロ & 初回対応中 → first_reply としてAPIに渡す（初回挨拶文を生成するため）
      const hasAnyStaffMsg = selectedConversation.messages.some((m) => m.sender === "staff");
      const normalizedStatus = STATUS_ALIAS[selectedConversation.status] ?? selectedConversation.status;
      const effectiveState = !hasAnyStaffMsg && normalizedStatus === "hearing" ? "first_reply" : selectedConversation.status;

      const linkedCustomerForGen = linkedCustomerMap[selectedConversation.id];
      // 紐付き条件 → なければメモをフォールバック（80%の非紐付き会話でも条件が渡る）
      const genConditions = linkedCustomerForGen?.conditions || memos[selectedConversation.id] || undefined;
      const res = await fetch("/api/generate-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: targetMessage,
          state: effectiveState,
          customerName: selectedConversation.customerName,
          customerConditions: genConditions,
          customerSummary: linkedCustomerForGen?.ai_summary ?? undefined,
          recentMessages: (() => {
            const last20 = contextMsgs.slice(-20);
            // 直近20件にスタッフ返信がない場合のみ、最新のスタッフ返信を先頭に追加
            const hasStaffInLast20 = last20.some((m) => m.sender === "staff");
            const lastStaff = !hasStaffInLast20
              ? [...contextMsgs].reverse().find((m) => m.sender === "staff")
              : undefined;
            const finalMsgs = lastStaff ? [lastStaff, ...last20] : last20;
            return finalMsgs.map((m) => ({ sender: m.sender, text: m.text || "", imageUrl: m.imageUrl || undefined }));
          })(),
        }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({ error: "返信案取得失敗" })) as { error?: string };
        throw new Error(errData.error || "返信案取得失敗");
      }

      // ストリーミング読み取り
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let metaDone = false;
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        if (!metaDone) {
          buffer += chunk;
          const nl = buffer.indexOf("\n");
          if (nl >= 0) {
            const metaLine = buffer.slice(0, nl);
            const meta = JSON.parse(metaLine) as { ok: boolean; error?: string };
            if (!meta.ok) throw new Error(meta.error || "返信案取得失敗");
            metaDone = true;
            fullText = buffer.slice(nl + 1);
            if (fullText) setReplyDraft(fullText);
          }
        } else {
          fullText += chunk;
          setReplyDraft(fullText);
        }
      }

      const finalDraft = fullText.trim();
      aiDraftRef.current = finalDraft;
      replyTargetCustomerMsgRef.current = targetMessage;
      setReplyDraft(finalDraft);

      // 生成完了後にテキストエリアへフォーカスしてスクロール
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }, 50);
    } catch (requestError) {
      const msg = requestError instanceof Error ? requestError.message : "返信案の作成に失敗しました。";
      console.error("generateReply error:", msg);
      setError(`返信案の作成に失敗しました: ${msg}`);
    } finally {
      setGenerating(false);
      setTargetOverrideMessage(null); // 生成完了後にバナーをクリア
    }
  };

  const handleEnhanceReply = async () => {
    if (!replyDraft.trim() || enhancing) return;
    try {
      setEnhancing(true);
      const msgs = selectedConversation.messages;
      const linkedCustomerForEnhance = linkedCustomerMap[selectedConversation.id];
      const enhanceConditions = linkedCustomerForEnhance?.conditions || memos[selectedConversation.id] || undefined;
      const activeTasksForConv = activeTasks[selectedConversation.id] ?? [];
      const activeTaskTypes = activeTasksForConv.map((t) => t.task_type);
      const res = await fetch("/api/enhance-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentDraft: replyDraft,
          conversationState: selectedConversation.status,
          customerConditions: enhanceConditions,
          customerSummary: linkedCustomerForEnhance?.ai_summary ?? undefined,
          customerName: selectedConversation.customerName,
          recentMessages: msgs.slice(-15).map((m) => ({ sender: m.sender, text: m.text || "", imageUrl: m.imageUrl || undefined })),
          activeTasks: activeTaskTypes.length > 0 ? activeTaskTypes : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "改善失敗");
      const enhanced = data.enhanced || replyDraft;
      setReplyDraft(enhanced);
      // ✨が出した文をAI提案として記録（スタッフがさらに編集した差分を学習）
      aiDraftRef.current = enhanced;
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 250)}px`; }
      }, 50);
    } catch (err) {
      console.error("enhance-reply error:", err);
    } finally {
      setEnhancing(false);
    }
  };

  const starMessage = (msgId: string, staffText: string) => {
    if (starredMsgIds.has(msgId)) return; // 既にスター済みはスキップ

    // このスタッフメッセージより前の最後のお客様メッセージを探す
    const msgs = selectedConversation.messages;
    const msgIdx = msgs.findIndex((m) => m.id === msgId);
    const prevCustomerMsg = msgs
      .slice(0, msgIdx)
      .filter((m) => m.sender === "customer")
      .slice(-1)[0];

    if (!prevCustomerMsg) return;

    setStarredMsgIds((prev) => new Set([...prev, msgId]));

    const existingExampleId = savedExampleIdByMsgId.current.get(msgId);
    if (existingExampleId) {
      // 送信時に記録した example を PATCH → aiDraft が正しく保存されたまま☆を付ける
      fetch("/api/save-reply-example", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: existingExampleId, is_starred: true }),
      }).catch(() => {});
      // ☆をつけた = スタッフが承認した良い修正 → 差分を自動ナレッジ化
      fetch("/api/auto-knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ example_id: existingExampleId }),
      }).catch(() => {});
    } else {
      // 記録がない場合（古いメッセージや別セッション）は従来通り POST
      fetch("/api/save-reply-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationState: selectedConversation.status,
          customerMessage: prevCustomerMsg.text,
          sentReply: staffText,
          isStarred: true,
        }),
      }).catch(() => {});
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

  const startLongPress = (messageId: string, messageText: string, sender: string, e?: React.TouchEvent) => {
    longPressTimerRef.current = setTimeout(() => {
      const touch = e?.touches[0];
      setContextMenu({ messageId, x: touch?.clientX ?? 200, y: touch?.clientY ?? 300, text: messageText, sender });
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  };

  // メモ・担当者をlocalStorageから読み込む（🔥はSupabaseが正なので読み込まない）
  useEffect(() => {
    try {
      const stored = localStorage.getItem("conv_memos");
      if (stored) setMemos(JSON.parse(stored));
    } catch {}
    try {
      const stored = localStorage.getItem("conv_assignees");
      if (stored) setAssignees(JSON.parse(stored));
    } catch {}
    try {
      const stored = localStorage.getItem("conv_read_at");
      if (stored) setManuallyReadAt(JSON.parse(stored));
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
      const isNowFlagged = !prev.has(id);
      if (isNowFlagged) next.add(id); else next.delete(id);
      // Supabaseが唯一のソース（is_hotと同じ方式）
      supabase.from("conversations").update({ is_flagged: isNowFlagged }).eq("id", id).then(() => {});
      return next;
    });
  };

  const toggleHotConv = (id: string) => {
    setHotConvIds((prev) => {
      const next = new Set(prev);
      const isNowHot = !prev.has(id);
      if (isNowHot) next.add(id); else next.delete(id);
      // Supabaseが唯一のソース（localStorageは使わない）
      supabase.from("conversations").update({ is_hot: isNowHot }).eq("id", id).then(() => {});
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

  const createLineTask = async (taskType: "property_check" | "property_send") => {
    const conv = conversations.find((c) => c.id === convMenuConvId);
    if (!conv) return;
    setConvMenuConvId(null);
    const res = await fetch("/api/line-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conv.id, task_type: taskType, customer_name: conv.customerName }),
    });
    const data = await res.json() as { ok: boolean; id?: string; created_at?: string };
    if (data.ok && data.id && data.created_at) {
      setActiveTasks((prev) => {
        const existing = prev[conv.id] ?? [];
        if (existing.some((x) => x.task_type === taskType)) return prev;
        return { ...prev, [conv.id]: [...existing, { id: data.id!, task_type: taskType, created_at: data.created_at!, customer_name: conv.customerName }] };
      });
    }
  };

  const cancelLineTask = async (taskType: "property_check" | "property_send") => {
    const convId = convMenuConvId;
    if (!convId) return;
    const task = (activeTasks[convId] ?? []).find((t) => t.task_type === taskType);
    if (!task) return;
    setConvMenuConvId(null);
    await fetch("/api/line-tasks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: task.id }),
    });
    setActiveTasks((prev) => {
      const filtered = (prev[convId] ?? []).filter((x) => x.id !== task.id);
      if (filtered.length === 0) { const next = { ...prev }; delete next[convId]; return next; }
      return { ...prev, [convId]: filtered };
    });
  };

  const sendReply = () => {
    if (!selectedConversation.id) return;
    if (!replyDraft.trim() && selectedImageFiles.length === 0) return;
    setShowSendConfirm(true);
  };

  const executeSend = async () => {
    setShowSendConfirm(false);
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
            conversation_id: selectedConversation.id,
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
            conversation_id: selectedConversation.id,
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

      // ステータス自動制御
      const isFirstStaffReply = !selectedConversation.messages.some((m) => m.sender === "staff");
      const currentStatus = STATUS_ALIAS[selectedConversation.status] ?? selectedConversation.status;
      const isSendingImages = imageUrls.length > 0;
      const convUpdate: Record<string, unknown> = { last_message: lastText, last_sender: "staff", updated_at: now.toISOString() };
      if (isFirstStaffReply) convUpdate.status = "hearing";
      // 画像送信時 & 初回対応中 → 物件提案中に自動昇格
      if (isSendingImages && currentStatus === "hearing") convUpdate.status = "proposing";
      const newStatus = convUpdate.status as string | undefined;

      await supabase
        .from("conversations")
        .update(convUpdate)
        .eq("id", selectedConversation.id);

      setConversations((prev) =>
        prev
          .map((conversation) => {
            if (conversation.id !== selectedConversation.id) return conversation;
            // リアルタイムが既に追加済みの場合の重複防止（同じIDのメッセージを2回追加しない）
            const existingIds = new Set(conversation.messages.map((m) => m.id));
            const dedupedNew = newMessages.filter((m) => !existingIds.has(m.id));
            return {
              ...conversation,
              lastMessage: lastText,
              lastSender: "staff",
              ...(newStatus ? { status: newStatus } : {}),
              updatedAt: now.toISOString(),
              messages: [...conversation.messages, ...dedupedNew],
            };
          })
          .sort((a, b) => {
            const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return bTime - aTime;
          })
      );

      // LINEに送信（テキスト→画像の順）
      try {
        if (textToSend) {
          const lineRes = await fetch("/api/send-line-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, message: textToSend, account: selectedConversation.account }),
          });
          if (!lineRes.ok) {
            const lineErr = await lineRes.json().catch(() => ({ error: `HTTP ${lineRes.status}` })) as { error?: string };
            setError(`⚠️ LINE送信失敗: ${lineErr.error || lineRes.statusText}`);
          }
        }
        for (const imageUrl of imageUrls) {
          const lineRes = await fetch("/api/send-line-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, image_url: imageUrl, account: selectedConversation.account }),
          });
          if (!lineRes.ok) {
            const lineErr = await lineRes.json().catch(() => ({ error: `HTTP ${lineRes.status}` })) as { error?: string };
            setError(`⚠️ LINE画像送信失敗: ${lineErr.error || lineRes.statusText}`);
          }
        }
      } catch (lineEx) {
        console.error("LINE send error:", lineEx);
        setError(`⚠️ LINE送信エラー: ${lineEx instanceof Error ? lineEx.message : "通信エラー"}`);
      }

      // 学習データ保存（テキスト送信時のみ・バックグラウンド）
      if (textToSend) {
        // AI生成時はgenerate時点の顧客メッセージを使う（その後に新メッセージが届いても正しい対応先を記録）
        const lastCustomerMsg = replyTargetCustomerMsgRef.current || latestCustomerMessage;
        const capturedAiDraft = aiDraftRef.current || undefined;
        // 顧客メッセージがない場合（初回・プロアクティブ送信）も「（初回連絡）」として保存
        const customerMsgToSave = lastCustomerMsg || "（初回連絡）";
        // 送信したメッセージの example ID を記録して、後で☆を押したとき PATCH で更新できるようにする
        fetch("/api/save-reply-example", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationState: selectedConversation.status,
            customerMessage: customerMsgToSave,
            sentReply: textToSend,
            aiDraft: capturedAiDraft,
          }),
        }).then(async (r) => {
          if (!r.ok) return;
          const saved = await r.json() as { id?: string };
          // 直近の送信メッセージIDが確定してから記録（newMessages の最初のテキストメッセージ）
          const textMsgId = newMessages.find((m) => m.sender === "staff" && m.text === textToSend)?.id;
          if (saved.id && textMsgId) {
            savedExampleIdByMsgId.current.set(textMsgId, saved.id);
          }
        }).catch(() => {});

        aiDraftRef.current = "";
        replyTargetCustomerMsgRef.current = "";
      }

      setReplyDraft("");
      removeSelectedImage();

      // 送信完了後にAI要約をバックグラウンド更新（送信した文も含めた最新状態で要約）
      const linkedForSummary = linkedCustomerMap[selectedConversation.id];
      if (linkedForSummary?.id) {
        const convIdForSummary = selectedConversation.id;
        fetch("/api/customer-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_id:      linkedForSummary.id,
            previous_summary: linkedForSummary.ai_summary ?? null,
            conversation_id:  convIdForSummary,
            customer_name:    selectedConversation.customerName,
            fetch_from_db:    true,
          }),
        })
          .then((r) => r.json())
          .then((d: { summary?: string }) => {
            if (d.summary) {
              setLinkedCustomerMap((prev) => ({
                ...prev,
                [convIdForSummary]: { ...prev[convIdForSummary], ai_summary: d.summary },
              }));
            }
          })
          .catch(() => {});
      }

      // タスクの自動完了チェック（スタッフ2通送信でタスクごとに完了）
      const convIdForTask = selectedConversation.id;
      for (const pendingTask of activeTasks[convIdForTask] ?? []) {
        const staffMsgsAfterTask = selectedConversation.messages.filter(
          (m) => m.sender === "staff" && (m.rawCreatedAt ?? "") >= pendingTask.created_at
        ).length;
        if (staffMsgsAfterTask + 1 >= 2) {
          fetch("/api/line-tasks/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: pendingTask.id }),
          })
            .then(() => {
              setActiveTasks((prev) => {
                const filtered = (prev[convIdForTask] ?? []).filter((x) => x.id !== pendingTask.id);
                if (filtered.length === 0) { const next = { ...prev }; delete next[convIdForTask]; return next; }
                return { ...prev, [convIdForTask]: filtered };
              });
            })
            .catch(() => {});
        }
      }

      // 送信完了後に1.5秒後フェッチ: 送信中に届いたお客様メッセージを確実に反映
      setTimeout(() => fetchConversationsAndMessages(true), 1500);
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
      const res = await fetch("/api/ai-search", {
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
          conversation_id: selectedConversation.id,
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
          conversation_id: selectedConversation.id,
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
    // 画像送信時 & 初回対応中 → 物件提案中に自動昇格
    const sendTextCurrentStatus = STATUS_ALIAS[selectedConversation.status] ?? selectedConversation.status;
    const sendTextUpgrade = !!imageUrl && sendTextCurrentStatus === "hearing";
    const sendTextUpdate: Record<string, unknown> = { last_message: lastText, updated_at: now.toISOString() };
    if (sendTextUpgrade) sendTextUpdate.status = "proposing";
    await supabase
      .from("conversations")
      .update(sendTextUpdate)
      .eq("id", selectedConversation.id);

    setConversations((prev) =>
      prev
        .map((conversation) => {
          if (conversation.id !== selectedConversation.id) return conversation;
          // リアルタイムが既に追加済みの場合の重複防止
          const existingIds = new Set(conversation.messages.map((m) => m.id));
          const dedupedNew = newMessages.filter((m) => !existingIds.has(m.id));
          return {
            ...conversation,
            lastMessage: lastText,
            ...(sendTextUpgrade ? { status: "proposing" } : {}),
            updatedAt: now.toISOString(),
            messages: [...conversation.messages, ...dedupedNew],
          };
        })
        .sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        })
    );

    // LINEに送信（画像→テキストの順）
    try {
      if (imageUrl) {
        await fetch("/api/send-line-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, image_url: imageUrl, account: selectedConversation.account }),
        });
      }
      if (text.trim()) {
        await fetch("/api/send-line-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line_user_id: selectedConversation.lineUserId, message: text.trim(), account: selectedConversation.account }),
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

  const openAixDirect = (type: AixActionType) => {
    setAixInitialFile(null);
    setAixModalType(type);
  };

  // 内覧・申込: ワンタップで生成→下書き反映→確認ダイアログ表示
  const triggerAixOneTap = async (action: "viewing_invite" | "application_push") => {
    if (!selectedConversation?.id) return;
    try {
      setGenerating(true);
      setError("");
      const recentMessages = selectedConversation.messages
        .slice(-20)
        .map((m) => ({ sender: m.sender, text: m.text || "" }));
      const res = await fetch("/api/aix/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          account: selectedConversation.account,
          customer_name: selectedConversation.customerName,
          conversation_id: selectedConversation.id,
          recent_messages: recentMessages,
        }),
      });
      const data = await res.json() as { ok: boolean; message_text?: string; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "生成に失敗しました");
      const draft = data.message_text || "";
      setReplyDraft(draft);
      aiDraftRef.current = draft;
      setShowSendConfirm(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成に失敗しました");
    } finally {
      setGenerating(false);
    }
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

  // チャット画面：右スワイプで一覧に戻る（LINEと同じ挙動・画面全体対応）
  const onChatTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
      chatSwipeStart.current = null;
      return;
    }
    chatSwipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    setChatSwipeDelta(0);
  };
  const onChatTouchMove = (e: React.TouchEvent) => {
    if (!chatSwipeStart.current) return;
    const dx = e.touches[0].clientX - chatSwipeStart.current.x;
    const dy = e.touches[0].clientY - chatSwipeStart.current.y;
    // 右スワイプかつ水平が支配的なときだけ追跡（縦スクロールとの誤判定防止）
    if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 && dx > 8) {
      e.stopPropagation();
      setChatSwipeDelta(dx);
    }
  };
  const onChatTouchEnd = (e: React.TouchEvent) => {
    // 右に90px以上スワイプ → 一覧へ戻る
    if (chatSwipeDelta > 90) {
      // スワイプ後の合成クリック・タッチ（BottomNavリンク等）を500ms間ブロック
      swipeBlockClickRef.current = true;
      setTimeout(() => { swipeBlockClickRef.current = false; }, 500);
      e.preventDefault();
      setMobileView("list");
    }
    chatSwipeStart.current = null;
    setChatSwipeDelta(0);
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
          style={{ paddingBottom: "52px" }}
        >
          <div className="border-b border-[#e9edef] bg-white px-3 pb-1.5 pt-[max(10px,env(safe-area-inset-top))]">
            {/* ステータスフィルター（上段）＋ハンバーガー左上 */}
            <div className="relative flex items-center justify-center mb-1.5">
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
                  <circle cx="10" cy="10" r="7" stroke={aixSearchMode ? "#06C755" : "#aaaaaa"} strokeWidth="2.5"/>
                  <line x1="15.2" y1="15.2" x2="21" y2="21" stroke={aixSearchMode ? "#06C755" : "#aaaaaa"} strokeWidth="2.8" strokeLinecap="round"/>
                  <text x="10" y="10" textAnchor="middle" dominantBaseline="central" fontSize="6.5" fontWeight="bold" fill={aixSearchMode ? "#06C755" : "#aaaaaa"}>AI</text>
                </svg>
              </button>
              {(() => {
                const lbl = statusFilter === "all" ? "すべて" : (DETAIL_STATUSES.find((s) => s.key === statusFilter)?.label ?? "すべて");
                const fs = lbl.length >= 5 ? "text-[10px]" : lbl.length >= 4 ? "text-[11px]" : "text-[12px]";
                return (
                  <button
                    onClick={() => setShowGroupFilter((v) => !v)}
                    className={`flex items-center gap-0.5 ${fs} font-bold transition-all`}
                    style={{ color: "#111b21" }}
                  >
                    {lbl}
                    <span className="text-[9px] text-[#aaa]">{showGroupFilter ? "▲" : "▼"}</span>
                  </button>
                );
              })()}
              {showGroupFilter && (
                <div className="absolute top-full z-30 mt-1 w-44 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
                  <button
                    onClick={() => { setStatusFilter("all"); setShowGroupFilter(false); }}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] font-medium border-b border-[#f0f2f5] ${statusFilter === "all" ? "text-[#2196F3]" : "text-[#111b21]"}`}
                  >
                    <span className="h-2.5 w-2.5 rounded-full bg-gray-300" />
                    すべて
                  </button>
                  <button
                    onClick={() => { setStatusFilter("hot_flag"); setShowGroupFilter(false); }}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] font-medium border-b border-[#f0f2f5] ${statusFilter === "hot_flag" ? "text-[#2196F3]" : "text-[#111b21]"}`}
                  >
                    <span className="text-base leading-none">🔥</span>
                    あついお客さん
                    {hotConvIds.size > 0 && (
                      <span className="ml-auto text-[11px] font-bold text-orange-500">{hotConvIds.size}</span>
                    )}
                  </button>
                  {DETAIL_STATUSES.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => { setStatusFilter(s.key); setShowGroupFilter(false); }}
                      className={`flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] font-medium border-b border-[#f0f2f5] last:border-b-0 ${statusFilter === s.key ? "text-[#2196F3]" : "text-[#111b21]"}`}
                    >
                      <span className={`h-3 w-3 rounded-full ${s.dot}`} />
                      {s.label}
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

                const lastSenderVal = conversation.lastSender ?? conversation.messages[conversation.messages.length - 1]?.sender;
                const needsReply =
                  lastSenderVal === "customer" &&
                  conversation.status !== "closed_won";

                // 最後のスタッフ返信以降の連続するお客さんメッセージ数
                const unreadCount = (() => {
                  if (!needsReply) return 0;
                  if (postApplyConvIds.has(conversation.id)) return 0;
                  const readAt = manuallyReadAt[conversation.id];
                  if (readAt) {
                    const msgs = conversation.messages;
                    let lastCustTime: string | null = null;
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i].sender === "customer") { lastCustTime = msgs[i].rawCreatedAt ?? null; break; }
                    }
                    // 既読後に新しい顧客メッセージがなければ0
                    if (!lastCustTime || lastCustTime <= readAt) return 0;
                  }
                  const msgs = conversation.messages;
                  let count = 0;
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].sender === "customer") count++;
                    else break;
                  }
                  return count || 1;
                })();

                return (
                  <button
                    key={conversation.id}
                    onClick={() => openConversation(conversation.id)}
                    onTouchStart={() => startConvLongPress(conversation.id)}
                    onTouchEnd={cancelConvLongPress}
                    onTouchMove={cancelConvLongPress}
                    onContextMenu={(e) => { e.preventDefault(); toggleFlaggedConv(conversation.id); }}
                    style={{ WebkitUserSelect: "none", userSelect: "none" }}
                    className={`flex w-full items-center gap-3 px-4 py-[23px] text-left transition ${
                      isActive ? "bg-[#f0f2f5]" : postApplyConvIds.has(conversation.id) ? "bg-[#e3f2fd] hover:bg-[#daeaf8]" : "bg-white hover:bg-[#f5f6f6]"
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
                      {(groupMeta.key === "applying" || groupMeta.key === "closed_won") && (
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

                    <div className="relative min-w-0 flex-1 pr-10">
                      {/* 時間・未読バッジ: 絶対配置で高さに影響させない */}
                      <div className="absolute right-0 top-0 flex flex-col items-end gap-1">
                        <span className="text-[11px] text-[#667781]">
                          {formatListTime(conversation.updatedAt)}
                        </span>
                        {unreadCount > 0 && (
                          <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#06C755] px-1 text-[11px] font-bold text-white leading-none">
                            {unreadCount}
                          </span>
                        )}
                      </div>

                      {/* 名前行: 高さ固定で位置ブレなし */}
                      <div className="mb-0.5 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden">
                        <span className="truncate text-[14px] font-medium text-[#111b21]">
                          {conversation.customerName}
                        </span>
                        {(() => {
                          const acct = getAccountMeta(conversation.account);
                          return (
                            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${acct.color}`}>
                              {acct.label}
                            </span>
                          );
                        })()}
                        {(conversation.status === "applying" || conversation.status === "closed_won" || STATUS_ALIAS[conversation.status] === "applying") && (
                          <span className="shrink-0 rounded-full bg-pink-100 px-1.5 py-0.5 text-[9px] font-bold text-pink-700">
                            審査中
                          </span>
                        )}
                        {(() => {
                          const linked = linkedCustomerMap[conversation.id];
                          if (!linked?.propertyStatus) return null;
                          const label = PROPERTY_STATUS_LABELS[linked.propertyStatus] ?? linked.propertyStatus;
                          const color = PROPERTY_STATUS_COLORS[linked.propertyStatus] ?? "bg-gray-100 text-gray-400";
                          const needs = propertyNeedsAction(linked.propertyStatus, linked.lastPropertySentAt);
                          return (
                            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${color}`}>
                              {label}{needs ? " !" : " ✓"}
                            </span>
                          );
                        })()}
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
                        {hotConvIds.has(conversation.id) && (
                          <span className="shrink-0 leading-none text-sm">🔥</span>
                        )}
                        {(activeTasks[conversation.id] ?? []).map((task) => (
                          <span key={task.id} className="shrink-0 rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold text-purple-700">
                            {task.task_type === "property_check" ? "🔍確認中" : "🏠出し中"}
                          </span>
                        ))}
                      </div>

                      {/* 本文プレビュー: 薄色・右端に余白 */}
                      <div className="truncate text-[11px] text-[#b0b8be]">
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
            background: "linear-gradient(180deg, #e8f4fd 0%, #f0f8ff 50%, #f8fbff 100%)",
            transform: chatSwipeDelta > 0 ? `translateX(${Math.min(chatSwipeDelta * 0.7, 200)}px)` : "none",
            transition: chatSwipeDelta === 0 ? "transform 0.25s cubic-bezier(0.25,0.46,0.45,0.94)" : "none",
            touchAction: "pan-y",
          }}
          onTouchStart={onChatTouchStart}
          onTouchMove={onChatTouchMove}
          onTouchEnd={onChatTouchEnd}
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
                  <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#06C755] px-1 text-[11px] font-bold text-white leading-none">
                    {needsReplyCount}
                  </span>
                )}
              </button>

              {/* 中央: 名前（タップで更新） */}
              <div className="pointer-events-none absolute left-0 right-0 flex justify-center">
                <button
                  onClick={() => fetchConversationsAndMessages()}
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
                    className={`rounded-full border px-2 py-0.5 text-[10px] shadow-none ${detailStatusMeta.color} border-transparent`}
                  >
                    {statusSaving ? "..." : detailStatusMeta.label}
                  </button>

                  {showStatusMenu && (
                    <>
                      <div
                        className="fixed inset-0 z-20"
                        onClick={() => setShowStatusMenu(false)}
                      />
                      <div className="absolute right-0 top-full z-30 mt-2 w-44 overflow-hidden rounded-2xl border border-[#d1d7db] bg-white shadow-xl">
                        {DETAIL_STATUSES.map((s) => (
                          <button
                            key={s.key}
                            onClick={() => updateConversationStatus(s.key)}
                            className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] font-semibold hover:bg-[#f5f6f6] border-b border-[#f0f2f5] last:border-b-0 ${
                              selectedConversation.status === s.key ? "bg-[#f0f2f5]" : ""
                            }`}
                          >
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} />
                            <span>{s.label}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
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

          <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-3.5">
              {(() => {
                const q = aiSearchIds !== null ? "" : searchQuery.trim().toLowerCase();
                const displayMessages = q
                  ? selectedConversation.messages.filter((m) => m.text?.toLowerCase().includes(q))
                  : groupImageMessages(selectedConversation.messages);
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
                        {!isCustomer && message.text && message.text !== "[画像]" && message.text !== "[動画]" && (
                          <button
                            onClick={() => starMessage(message.id, message.text)}
                            className={`mb-0.5 shrink-0 text-[15px] leading-none transition-all duration-150 active:scale-110 ${starredMsgIds.has(message.id) ? "text-yellow-400" : "text-[#ccc] hover:text-yellow-300"}`}
                            title="良い返信例として★登録"
                          >
                            {starredMsgIds.has(message.id) ? "★" : "☆"}
                          </button>
                        )}
                        {!isCustomer && (
                          <span className="mb-0.5 shrink-0 text-[10px] leading-none text-[#667781]">
                            {message.time}
                          </span>
                        )}
                        <div
                          className="max-w-[86%] md:max-w-[74%]"
                          onTouchStart={(e) => startLongPress(message.id, message.text, message.sender, e)}
                          onTouchEnd={cancelLongPress}
                          onTouchMove={cancelLongPress}
                          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ messageId: message.id, x: e.clientX, y: e.clientY, text: message.text, sender: message.sender }); }}
                        >
                          <div
                            className={`rounded-2xl text-[15px] leading-6 shadow-sm ${
                              isCustomer
                                ? "rounded-bl-md bg-white text-[#3d4a52]"
                                : "rounded-br-md text-[#3d4a52]"
                            } ${flaggedIds.has(message.id) ? "ring-2 ring-orange-300" : ""}`}
                            style={!isCustomer ? { backgroundColor: "rgba(220,248,198,0.55)" } : undefined}
                          >
                            {/* 保存期間終了 */}
                            {!message.imageUrl && message.text === "[画像]" && message.imageExpiresAt && new Date(message.imageExpiresAt) < new Date() && (
                              <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] text-gray-400">
                                <span>🔒</span>
                                <span>保存期間が終了しました</span>
                              </div>
                            )}
                            {message.imageUrl && (() => {
                              // 期限切れチェック
                              if (message.imageExpiresAt && new Date(message.imageExpiresAt) < new Date()) {
                                return (
                                  <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] text-gray-400">
                                    <span>🔒</span>
                                    <span>保存期間が終了しました</span>
                                  </div>
                                );
                              }
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
                              if (imgs.length === 2) {
                                return (
                                  <div className={`grid grid-cols-2 gap-0.5 overflow-hidden rounded-2xl ${roundB}`}>
                                    {imgs.map((url, idx) => (
                                      <img key={idx} src={url} alt={`画像${idx + 1}`} onClick={() => openLightbox(idx)} className="aspect-square w-full cursor-pointer object-cover" />
                                    ))}
                                  </div>
                                );
                              }
                              if (imgs.length === 3) {
                                // LINE風: 左1枚大きく(60%) + 右2枚縦並び(40%)
                                return (
                                  <div className={`flex gap-0.5 overflow-hidden rounded-2xl ${roundB}`} style={{ height: 200 }}>
                                    <img src={imgs[0]} alt="画像1" onClick={() => openLightbox(0)} className="w-[60%] cursor-pointer object-cover" style={{ objectFit: "cover" }} />
                                    <div className="flex w-[40%] flex-col gap-0.5">
                                      <img src={imgs[1]} alt="画像2" onClick={() => openLightbox(1)} className="h-1/2 w-full cursor-pointer object-cover" />
                                      <img src={imgs[2]} alt="画像3" onClick={() => openLightbox(2)} className="h-1/2 w-full cursor-pointer object-cover" />
                                    </div>
                                  </div>
                                );
                              }
                              // 4枚以上: LINE風2列グリッド（全枚数表示）
                              return (
                                <div className={`grid grid-cols-2 gap-0.5 overflow-hidden rounded-2xl ${roundB}`}>
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

            {/* 返信対象メッセージ指定インジケーター */}
            {targetOverrideMessage && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold text-blue-500">この文に返信</p>
                  <p className="truncate text-[12px] text-blue-700">{targetOverrideMessage.text}</p>
                </div>
                <button
                  onClick={() => setTargetOverrideMessage(null)}
                  className="shrink-0 text-blue-400 active:text-blue-600"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            )}

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
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm disabled:opacity-40 active:scale-95 transition-all duration-75 ${generating ? "border-blue-300 bg-blue-50 text-blue-600" : "border-[#d1d7db] bg-white text-[#111b21]"}`}
              >
                {generating ? (
                  <>
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                    作成中...
                  </>
                ) : "AI文案を作成"}
              </button>

              <button
                onClick={() => { setShowAixMenu(true); setShowStatusMenu(false); }}
                className="rounded-full border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#111b21] shadow-sm active:scale-95 transition-transform duration-75"
              >
                AIX
              </button>

              {/* ✨改善ボタン（入力テキストがあるときのみ表示） */}
              {replyDraft.trim() && (
                <button
                  onClick={handleEnhanceReply}
                  disabled={enhancing}
                  className="flex h-8 items-center gap-1 rounded-full border border-[#c8b8ff] bg-gradient-to-r from-[#ede7ff] to-[#e3f0ff] px-3 text-xs font-bold text-[#6c3fc7] shadow-sm active:scale-95 transition-transform duration-75 disabled:opacity-60"
                  title="入力中の文をAIが改善"
                >
                  {enhancing ? <span className="text-[11px]">…</span> : "✨"}
                </button>
              )}

              {/* 文章クリアボタン（入力/AI文案があるときのみ表示） */}
              {replyDraft && (
                <button
                  onClick={() => { setReplyDraft(""); aiDraftRef.current = ""; }}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d1d7db] bg-white text-[#54656f] shadow-sm active:scale-95 transition-transform duration-75"
                  title="文章を消す"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}

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
              <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                {replyDraft && !inputFocused && (
                  <span className="text-[10px] font-bold text-blue-500 leading-none">AI文案</span>
                )}
                <textarea
                  ref={textareaRef}
                  value={replyDraft}
                  onChange={(e) => {
                    setReplyDraft(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
                  }}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  rows={1}
                  placeholder="Aa"
                  className="min-h-[22px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-6 text-[#111b21] outline-none placeholder:text-[#aaa]"
                  style={{ height: "22px" }}
                />
              </div>
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
        <BottomNav unreadCount={needsReplyCount} hidden={false} />
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
            <div className="grid grid-cols-3">
              <button
                onClick={() => { setMemoModalConvId(convMenuConvId); setMemoInput(memos[convMenuConvId] || ""); setConvMenuConvId(null); }}
                className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5] border-r border-[#f0f2f5]"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </span>
                <div className="text-[11px] font-semibold text-[#111b21]">ノート</div>
                <div className="text-[9px] text-[#8696a0] text-center leading-tight">{memos[convMenuConvId] ? memos[convMenuConvId].slice(0, 8) + (memos[convMenuConvId].length > 8 ? "…" : "") : "追加"}</div>
              </button>
              <button
                onClick={() => { setAssigneeModalConvId(convMenuConvId); setAssigneeInput(assignees[convMenuConvId] || ""); setConvMenuConvId(null); }}
                className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5] border-r border-[#f0f2f5]"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </span>
                <div className="text-[11px] font-semibold text-[#111b21]">メモ</div>
                <div className="text-[9px] text-[#8696a0] text-center leading-tight">{assignees[convMenuConvId] ? assignees[convMenuConvId].slice(0, 8) : "入力"}</div>
              </button>
              <button
                onClick={async () => {
                  setConvMenuConvId(null);
                  const { data } = await import("./lib/supabase").then(m => m.supabase.from("property_customers").select("id,customer_name,desired_area,floor_plan,rent_min,rent_max,move_in_time,preferences,ng_points,walk_minutes,other_requests,building_age").order("updated_at", { ascending: false }).limit(100));
                  setPropertyCustomers((data as typeof propertyCustomers) ?? []);
                  setLinkSearchQuery("");
                  setLinkModalConvId(convMenuConvId);
                }}
                className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5]"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                </span>
                <div className="text-[11px] font-semibold text-[#111b21]">紐付け</div>
                <div className="text-[9px] text-[#8696a0] text-center leading-tight">
                  {linkedCustomerMap[convMenuConvId]?.name?.slice(0, 6) ?? "未設定"}
                </div>
              </button>
            </div>
            <div className="border-t border-[#f0f2f5]">
              <button
                onClick={() => {
                  const convId = convMenuConvId!;
                  setManuallyReadAt(prev => {
                    const next = { ...prev };
                    if (next[convId]) {
                      delete next[convId];
                    } else {
                      next[convId] = new Date().toISOString();
                    }
                    try { localStorage.setItem("conv_read_at", JSON.stringify(next)); } catch {}
                    return next;
                  });
                  setConvMenuConvId(null);
                }}
                className="flex w-full items-center gap-3 px-5 py-3.5 active:bg-[#f0f2f5] border-b border-[#f0f2f5]"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${manuallyReadAt[convMenuConvId ?? ""] ? "bg-[#06C755]" : "bg-[#f0f2f5]"}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={manuallyReadAt[convMenuConvId ?? ""] ? "white" : "#667781"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                </span>
                <div>
                  <div className="text-[13px] font-medium text-[#111b21]">
                    {manuallyReadAt[convMenuConvId ?? ""] ? "未読に戻す" : "既読済みにする"}
                  </div>
                  <div className="text-[11px] text-[#8696a0]">未読バッジを消す</div>
                </div>
              </button>
              <button
                onClick={() => { toggleFlaggedConv(convMenuConvId!); setConvMenuConvId(null); }}
                className="flex w-full items-center gap-3 px-5 py-3.5 active:bg-[#f0f2f5] border-b border-[#f0f2f5]"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${flaggedConvIds.has(convMenuConvId ?? "") ? "bg-red-500" : "bg-[#f0f2f5]"}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill={flaggedConvIds.has(convMenuConvId ?? "") ? "white" : "#667781"} stroke="none">
                    <path d="M3 3h18v2H5v13.59L7.76 16H21v-2h1v4H7.24L3 21.41V3z"/>
                    <path d="M5 5v11.59L7.76 14H21V5H5z"/>
                  </svg>
                </span>
                <div>
                  <div className="text-[13px] font-medium text-[#111b21]">
                    {flaggedConvIds.has(convMenuConvId ?? "") ? "要対応を解除" : "要対応にする"}
                  </div>
                  <div className="text-[11px] text-[#8696a0]">フラグを立てる</div>
                </div>
              </button>
              <button
                onClick={() => { toggleHotConv(convMenuConvId!); setConvMenuConvId(null); }}
                className="flex w-full items-center gap-3 px-5 py-3.5 active:bg-[#f0f2f5]"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[18px] leading-none ${hotConvIds.has(convMenuConvId ?? "") ? "bg-orange-500" : "bg-[#f0f2f5]"}`}>
                  🔥
                </span>
                <div>
                  <div className="text-[13px] font-medium text-[#111b21]">
                    {hotConvIds.has(convMenuConvId ?? "") ? "🔥を外す" : "🔥あついお客さんにする"}
                  </div>
                  <div className="text-[11px] text-[#8696a0]">優先返信リストに追加</div>
                </div>
              </button>
            </div>
            <div className="border-t border-[#f0f2f5] grid grid-cols-2">
              {(() => {
                const isActive = (activeTasks[convMenuConvId ?? ""] ?? []).some((t) => t.task_type === "property_check");
                return (
                  <button
                    onClick={() => isActive ? cancelLineTask("property_check") : createLineTask("property_check")}
                    className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5] border-r border-[#f0f2f5]"
                  >
                    <span className={`flex h-10 w-10 items-center justify-center rounded-full ${isActive ? "bg-purple-300" : "bg-purple-500"}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                      </svg>
                    </span>
                    <div className="text-[11px] font-semibold text-[#111b21]">物件確認</div>
                    <div className={`text-[9px] text-center leading-tight ${isActive ? "text-purple-600 font-bold" : "text-[#8696a0]"}`}>
                      {isActive ? "依頼中・取消" : "依頼する"}
                    </div>
                  </button>
                );
              })()}
              {(() => {
                const isActive = (activeTasks[convMenuConvId ?? ""] ?? []).some((t) => t.task_type === "property_send");
                return (
                  <button
                    onClick={() => isActive ? cancelLineTask("property_send") : createLineTask("property_send")}
                    className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5]"
                  >
                    <span className={`flex h-10 w-10 items-center justify-center rounded-full ${isActive ? "bg-green-300" : "bg-green-500"}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
                      </svg>
                    </span>
                    <div className="text-[11px] font-semibold text-[#111b21]">物件出し</div>
                    <div className={`text-[9px] text-center leading-tight ${isActive ? "text-green-600 font-bold" : "text-[#8696a0]"}`}>
                      {isActive ? "依頼中・取消" : "依頼する"}
                    </div>
                  </button>
                );
              })()}
            </div>
            <div className="grid grid-cols-2 border-t border-[#f0f2f5]">
              <button
                onClick={() => { setAccountChangeConvId(convMenuConvId); setConvMenuConvId(null); }}
                className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5] border-r border-[#f0f2f5]"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-500">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  </svg>
                </span>
                <div className="text-[11px] font-semibold text-[#111b21]">会社</div>
                <div className="text-[9px] text-[#8696a0] text-center leading-tight">
                  {getAccountMeta(conversations.find(c => c.id === convMenuConvId)?.account).label}
                </div>
              </button>
              <button
                onClick={async () => {
                  const id = convMenuConvId!;
                  const isNowPostApply = !postApplyConvIds.has(id);
                  await supabase.from("conversations").update({ is_post_apply: isNowPostApply }).eq("id", id);
                  setPostApplyConvIds(prev => {
                    const next = new Set(prev);
                    if (next.has(id)) { next.delete(id); } else { next.add(id); }
                    return next;
                  });
                  setConvMenuConvId(null);
                }}
                className="flex flex-col items-center gap-1.5 px-2 py-4 active:bg-[#f0f2f5]"
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-full ${postApplyConvIds.has(convMenuConvId ?? "") ? "bg-[#1565C0]" : "bg-[#90caf9]"}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/>
                  </svg>
                </span>
                <div className="text-[11px] font-semibold text-[#111b21]">申込以降</div>
                <div className="text-[9px] text-[#8696a0] text-center leading-tight">
                  {postApplyConvIds.has(convMenuConvId ?? "") ? "解除" : "マーク"}
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* アカウント変更モーダル */}
      {accountChangeConvId && (() => {
        const conv = conversations.find(c => c.id === accountChangeConvId);
        const currentAccount = conv?.account ?? "sumora";
        return (
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30"
            onClick={() => setAccountChangeConvId(null)}
          >
            <div
              className="overflow-hidden rounded-2xl bg-white shadow-2xl"
              style={{ minWidth: "270px", maxWidth: "320px", width: "90vw" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 pt-4 pb-3 border-b border-[#f0f2f5]">
                <div className="text-[13px] font-bold text-[#111b21] text-center">アカウント変更</div>
                <div className="text-[11px] text-[#8696a0] text-center mt-0.5">{conv?.customerName}</div>
              </div>
              <div className="p-3 flex flex-col gap-2">
                {ACCOUNT_LIST.map((acc) => (
                  <button
                    key={acc.key}
                    onClick={async () => {
                      if (acc.key === currentAccount) { setAccountChangeConvId(null); return; }
                      const { error } = await supabase
                        .from("conversations")
                        .update({ account: acc.key, updated_at: new Date().toISOString() })
                        .eq("id", accountChangeConvId);
                      if (!error) {
                        setConversations(prev => prev.map(c =>
                          c.id === accountChangeConvId ? { ...c, account: acc.key } : c
                        ));
                      }
                      setAccountChangeConvId(null);
                    }}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all active:scale-95 ${
                      acc.key === currentAccount
                        ? "border-blue-500 bg-blue-50"
                        : "border-transparent bg-[#f0f2f5] active:bg-[#e9ecef]"
                    }`}
                  >
                    {"image" in acc && acc.image ? (
                      <img src={acc.image} alt={acc.label} className="rounded-full object-cover border border-white shadow-sm" style={{ width: 36, height: 36 }} />
                    ) : (
                      <span className="flex items-center justify-center rounded-full bg-[#e9edef] text-lg" style={{ width: 36, height: 36 }}>{acc.icon}</span>
                    )}
                    <span className="text-[14px] font-semibold text-[#111b21] flex-1 text-left">{acc.label}</span>
                    {acc.key === currentAccount && (
                      <svg className="text-blue-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setAccountChangeConvId(null)}
                className="w-full py-3 text-[13px] text-[#8696a0] border-t border-[#f0f2f5] active:bg-[#f0f2f5]"
              >
                キャンセル
              </button>
            </div>
          </div>
        );
      })()}

      {/* 紐付けモーダル */}
      {linkModalConvId && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setLinkModalConvId(null); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between" style={{ background: "linear-gradient(135deg, #059669, #10b981)" }}>
              <div className="text-[16px] font-bold text-white">
                🔗 紐付け — {conversations.find((c) => c.id === linkModalConvId)?.customerName}
              </div>
              <button onClick={() => setLinkModalConvId(null)} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white text-sm">✕</button>
            </div>

            {linkedCustomerMap[linkModalConvId] && (
              <div className="px-4 pt-3 pb-2 border-b border-[#f0f2f5]">
                <div className="mb-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2.5">
                  <div className="text-[12px] font-bold text-emerald-700">🔗 現在の紐付け</div>
                  <div className="text-[13px] text-[#111b21]">{linkedCustomerMap[linkModalConvId].name}</div>
                </div>
                <button
                  onClick={async () => {
                    const convId = linkModalConvId;
                    const res = await fetch("/api/link-conversation", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ conversationId: convId, propertyCustomerId: null }),
                    });
                    if ((await res.json()).ok) {
                      setConversations((prev) => prev.map((c) => c.id === convId ? { ...c, propertyCustomerId: undefined } : c));
                      setLinkedCustomerMap((prev) => { const next = { ...prev }; delete next[convId]; return next; });
                      setLinkModalConvId(null);
                    }
                  }}
                  className="w-full rounded-full border border-red-200 py-2 text-[13px] font-semibold text-red-500"
                >
                  紐付けを解除
                </button>
              </div>
            )}

            <div className="p-4">
              <input
                type="text"
                value={linkSearchQuery}
                onChange={(e) => setLinkSearchQuery(e.target.value)}
                placeholder="お客様名で検索..."
                className="mb-3 w-full rounded-2xl border border-[#e9edef] bg-[#f0f2f5] px-4 py-2.5 text-[13px] text-[#111b21] outline-none"
                autoFocus
              />
              <div className="max-h-[50vh] overflow-y-auto flex flex-col gap-2">
                {propertyCustomers
                  .filter((pc) => !linkSearchQuery.trim() || pc.customer_name.includes(linkSearchQuery.trim()))
                  .map((pc) => (
                    <button
                      key={pc.id}
                      onClick={async () => {
                        const convId = linkModalConvId;
                        const res = await fetch("/api/link-conversation", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ conversationId: convId, propertyCustomerId: pc.id }),
                        });
                        if ((await res.json()).ok) {
                          setConversations((prev) => prev.map((c) => c.id === convId ? { ...c, propertyCustomerId: pc.id } : c));
                          const conds = formatConditions(pc);
                          setLinkedCustomerMap((prev) => ({ ...prev, [convId]: { id: pc.id, name: pc.customer_name, conditions: conds } }));
                          setLinkModalConvId(null);
                        }
                      }}
                      className="flex w-full items-start gap-3 rounded-2xl border border-[#e9edef] bg-[#f8f9fa] px-4 py-3 text-left active:scale-[0.98] transition-transform"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-base font-bold text-emerald-700">
                        {pc.customer_name?.charAt(0) ?? "?"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold text-[#111b21]">{pc.customer_name}</div>
                        <div className="truncate text-[11px] text-[#8696a0]">
                          {[pc.desired_area, pc.floor_plan, pc.rent_max ? `〜${Math.floor(pc.rent_max / 10000)}万円` : null].filter(Boolean).join(" / ")}
                        </div>
                      </div>
                      {linkedCustomerMap[linkModalConvId]?.id === pc.id && (
                        <span className="shrink-0 text-emerald-500 font-bold text-lg">✓</span>
                      )}
                    </button>
                  ))}
                {propertyCustomers.filter((pc) => !linkSearchQuery.trim() || pc.customer_name.includes(linkSearchQuery.trim())).length === 0 && (
                  <div className="py-8 text-center text-[13px] text-[#8696a0]">
                    {linkSearchQuery.trim() ? "該当するお客様がいません" : "売上サポにお客様がいません"}
                  </div>
                )}
              </div>
            </div>
            <div className="pb-[max(20px,env(safe-area-inset-bottom))]" />
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
          customerName={selectedConversation.customerName}
          conversationState={selectedConversation.status}
          recentMessages={(selectedConversation.messages || []).slice(-15).map((m: Message) => ({
            sender: m.sender, text: m.text || "", imageUrl: m.imageUrl || undefined,
          }))}
          linkedCustomer={linkedCustomerMap[selectedConversation.id]}
        />
      )}

      {aixModalType && selectedConversation.id ? (
        <AixModal
          actionType={aixModalType}
          conversationId={selectedConversation.id}
          customerName={selectedConversation.customerName}
          account={selectedConversation.account ?? currentAccount.id}
          initialImageFile={aixInitialFile ?? undefined}
          linkedCustomer={aixModalType === "property_recommendation" ? linkedCustomerMap[selectedConversation.id] : undefined}
          recentMessages={(selectedConversation.messages || []).slice(-20).map((m: Message) => ({ sender: m.sender, text: m.text || "" }))}
          customerSummary={linkedCustomerMap[selectedConversation.id]?.ai_summary ?? null}
          onClose={() => {
            setAixModalType(null);
            setAixInitialFile(null);
          }}
          onSend={sendMessageText}
          onAfterSend={
            aixModalType === "property_check_result"
              ? () => {
                  const task = (activeTasks[selectedConversation.id] ?? []).find((t) => t.task_type === "property_check");
                  if (task) {
                    fetch("/api/line-tasks/complete", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: task.id }),
                    }).catch(() => {});
                  }
                }
              : undefined
          }
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
            {/* ヘッダー */}
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

            {/* アカウント選択 */}
            <div className="px-4 pt-4 pb-2">
              <p className="text-[11px] font-bold text-[#8696a0] mb-3 tracking-wide uppercase">表示アカウント</p>
              <div className="flex flex-col gap-2">
                {(
                  [
                    { key: "all",    label: "すべて",   icon: "🌐", image: null, sub: "全アカウントのトーク" },
                    { key: "linked", label: "紐付け済", icon: "🔗", image: null, sub: "物件出しツールと連携済み" },
                    ...ACCOUNT_LIST.map((a) => ({ key: a.key, label: a.label, icon: a.icon, image: "image" in a ? a.image : null, sub: `${a.label} LINEアカウント` })),
                  ] as { key: typeof accountFilter; label: string; icon: string; image: string | null; sub: string }[]
                ).map((item) => {
                  const isSelected = accountFilter === item.key;
                  const count = item.key === "all"
                    ? conversations.length
                    : item.key === "linked"
                    ? conversations.filter((c) => !!linkedCustomerMap[c.id]).length
                    : conversations.filter((c) => (c.account ?? "sumora") === item.key).length;
                  return (
                    <button
                      key={item.key}
                      onClick={() => { setAccountFilter(item.key); setShowHamburgerMenu(false); }}
                      className="flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all active:scale-[0.98]"
                      style={{
                        borderColor: isSelected ? "#2196F3" : "#e9edef",
                        background: isSelected ? "#e3f2fd" : "#f8f9fa",
                      }}
                    >
                      {item.image ? (
                        <img
                          src={item.image}
                          alt={item.label}
                          className="shrink-0 rounded-full object-cover border-2 border-white shadow-sm"
                          style={{ width: 44, height: 44 }}
                        />
                      ) : (
                        <span className="shrink-0 flex items-center justify-center rounded-full bg-[#e9edef] text-xl" style={{ width: 44, height: 44 }}>{item.icon}</span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-bold" style={{ color: isSelected ? "#1565C0" : "#111b21" }}>
                          {item.label}
                        </div>
                        <div className="text-[11px] text-[#8696a0]">{item.sub}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#e9edef] px-2 py-0.5 text-[11px] font-bold text-[#667781]">
                        {count}
                      </span>
                      {isSelected && (
                        <svg className="shrink-0 text-[#2196F3]" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 通知設定 */}
            <div className="px-4 pt-2 pb-4">
              <p className="text-[11px] font-bold text-[#8696a0] mb-3 tracking-wide uppercase">通知設定</p>
              {notifPermission === "granted" ? (
                <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <span className="text-xl">🔔</span>
                  <div>
                    <div className="text-[13px] font-bold text-emerald-700">通知オン</div>
                    <div className="text-[11px] text-emerald-600">LINEが届いたらプッシュ通知が来ます</div>
                  </div>
                </div>
              ) : notifPermission === "denied" ? (
                <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
                  <span className="text-xl">🔕</span>
                  <div>
                    <div className="text-[13px] font-bold text-red-700">通知がブロックされています</div>
                    <div className="text-[11px] text-red-600">ブラウザの設定から許可してください</div>
                  </div>
                </div>
              ) : (
                <button
                  onClick={async () => {
                    const granted = await requestNotifPermission();
                    if (granted) {
                      setNotifPermission("granted");
                      await subscribePush();
                    } else {
                      setNotifPermission(Notification.permission);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-left active:scale-[0.98] transition-all"
                >
                  <span className="text-xl">🔔</span>
                  <div>
                    <div className="text-[13px] font-bold text-[#1565C0]">通知を有効にする</div>
                    <div className="text-[11px] text-[#1565C0]/70">タップして通知を許可する</div>
                  </div>
                </button>
              )}
            </div>
            {/* AIナレッジ管理 */}
            <div className="px-4 pt-2 pb-4 border-t border-[#f0f2f5]">
              <p className="text-[11px] font-bold text-[#8696a0] mb-3 tracking-wide uppercase">AI学習管理</p>
              <button
                onClick={async () => {
                  setShowHamburgerMenu(false);
                  setShowKnowledgeModal(true);
                  setKnowledgeLoading(true);
                  const d = await fetch("/api/knowledge-review").then((r) => r.json()) as { rules: Array<{ id: string; content: string; conversation_state: string; created_at: string; title: string }> };
                  setKnowledgeRules(d.rules ?? []);
                  setKnowledgeLoading(false);
                }}
                className="flex w-full items-center gap-3 rounded-2xl border border-[#e9edef] bg-[#f8f9fa] px-4 py-3 text-left active:scale-[0.98] transition-all"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-500">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-bold text-[#111b21]">AIナレッジ管理</div>
                  <div className="text-[11px] text-[#8696a0]">自動抽出ルールを確認・削除・承認</div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </button>
            </div>
            {replyExamplesCount !== null && (
              <div className="px-4 pt-1 pb-2 text-center">
                <span className="text-[10px] text-[#aaa]">🤖 LINE返信AI：{replyExamplesCount.toLocaleString()}件学習済み</span>
              </div>
            )}
            <div className="pb-[max(20px,env(safe-area-inset-bottom))]" />
          </div>
        </div>
      )}

      {/* AIナレッジ管理モーダル */}
      {showKnowledgeModal && (
        <div
          className="fixed inset-0 z-[95] flex items-end justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) setShowKnowledgeModal(false); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl overflow-hidden flex flex-col" style={{ maxHeight: "85vh" }}>
            {/* ヘッダー */}
            <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-[#f0f2f5]">
              <div>
                <div className="text-[16px] font-bold text-[#111b21]">AIナレッジ管理</div>
                <div className="text-[11px] text-[#8696a0]">自動抽出ルール — 確認して不要なものを削除</div>
              </div>
              <button onClick={() => setShowKnowledgeModal(false)} className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f0f2f5] text-[#667781]">✕</button>
            </div>
            {/* ルール一覧 */}
            <div className="overflow-y-auto flex-1 px-4 py-3">
              {knowledgeLoading ? (
                <div className="flex items-center justify-center py-12 text-[13px] text-[#8696a0]">読み込み中...</div>
              ) : knowledgeRules.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-[13px] text-[#8696a0]">自動抽出ルールはまだありません</div>
              ) : (
                <div className="flex flex-col gap-3">
                  {knowledgeRules.map((rule) => {
                    const isApproved = rule.title.includes("承認済");
                    const stateLabel: Record<string, string> = { first_reply: "初回", hearing: "ヒアリング", proposing: "提案", applying: "申込" };
                    return (
                      <div key={rule.id} className={`rounded-2xl border px-4 py-3 ${isApproved ? "border-indigo-200 bg-indigo-50" : "border-[#e9edef] bg-[#f8f9fa]"}`}>
                        <div className="flex items-start gap-2 mb-2">
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold ${isApproved ? "bg-indigo-200 text-indigo-800" : "bg-[#e9edef] text-[#667781]"}`}>
                            {stateLabel[rule.conversation_state] ?? rule.conversation_state}
                          </span>
                          {isApproved && (
                            <span className="shrink-0 rounded-full bg-indigo-500 px-2 py-0.5 text-[9px] font-bold text-white">承認済</span>
                          )}
                          <span className="ml-auto shrink-0 text-[10px] text-[#8696a0]">
                            {new Date(rule.created_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}
                          </span>
                        </div>
                        <p className="text-[12px] text-[#111b21] leading-relaxed mb-3">{rule.content}</p>
                        <div className="flex gap-2">
                          {!isApproved && (
                            <button
                              onClick={async () => {
                                await fetch("/api/knowledge-review", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rule.id }) });
                                setKnowledgeRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, title: "差分学習 [承認済]" } : r));
                              }}
                              className="flex-1 rounded-xl bg-indigo-500 py-2 text-[12px] font-bold text-white active:opacity-80"
                            >
                              承認
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              await fetch("/api/knowledge-review", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rule.id }) });
                              setKnowledgeRules((prev) => prev.filter((r) => r.id !== rule.id));
                            }}
                            className="flex-1 rounded-xl bg-[#f0f2f5] py-2 text-[12px] font-bold text-red-500 active:opacity-80"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-[#f0f2f5] text-center">
              <span className="text-[11px] text-[#8696a0]">{knowledgeRules.length}件 / 承認済みはimportance 10になります</span>
            </div>
            <div className="pb-[max(12px,env(safe-area-inset-bottom))]" />
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

      {/* 送信確認ダイアログ */}
      {showSendConfirm && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50"
          onClick={() => setShowSendConfirm(false)}
        >
          <div
            className="mx-4 w-full max-w-xs rounded-2xl bg-white shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-4">
              <p className="text-[15px] font-bold text-[#111b21] mb-1.5">LINEに送信しますか？</p>
              {(() => {
                const acct = getAccountMeta(selectedConversation.account);
                return (
                  <p className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold mb-2 ${acct.color}`}>
                    送信元: {acct.label}
                  </p>
                );
              })()}
              {replyDraft.trim() && (
                <p className="text-[13px] text-[#667781] bg-[#f0f2f5] rounded-xl px-3 py-2 max-h-24 overflow-y-auto whitespace-pre-wrap leading-snug">
                  {replyDraft.trim()}
                </p>
              )}
              {selectedImageFiles.length > 0 && (
                <p className="text-[12px] text-[#667781] mt-1.5">
                  📷 画像 {selectedImageFiles.length}枚
                </p>
              )}
            </div>
            <div className="flex border-t border-[#f0f2f5]">
              <button
                onClick={() => setShowSendConfirm(false)}
                className="flex-1 py-3.5 text-[14px] font-semibold text-[#8696a0] border-r border-[#f0f2f5]"
              >
                キャンセル
              </button>
              <button
                onClick={executeSend}
                className="flex-1 py-3.5 text-[14px] font-bold text-[#1565C0]"
              >
                送信する
              </button>
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
            <div className="p-4 flex flex-col gap-2">
              {[
                { color: "#2196F3", label: "物件オススメ", sub: "おすすめ物件をAIが提案", action: () => { setShowAixMenu(false); openAixWithImagePicker("property_recommendation"); } },
                { color: "#4CAF50", label: "物件確認した", sub: "確認結果を3パターンでAIが報告文を生成", action: () => { setShowAixMenu(false); openAixDirect("property_check_result"); } },
                { color: "#FF9800", label: "見積書送る", sub: "費用の見積書を作成", action: () => { setShowAixMenu(false); openAixWithImagePicker("estimate_sheet"); } },
                { color: "#9C27B0", label: "内覧へ！", sub: "会話から最適な内覧訴求を生成→確認後送信", action: () => { setShowAixMenu(false); void triggerAixOneTap("viewing_invite"); } },
                { color: "#E53935", label: "申込へ！", sub: "会話から最適な申込訴求を生成→確認後送信", action: () => { setShowAixMenu(false); void triggerAixOneTap("application_push"); } },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="flex items-center gap-0 overflow-hidden rounded-xl border border-[#e9edef] bg-white text-left active:bg-[#f5f6f7] transition-colors"
                >
                  <span className="w-1 self-stretch flex-shrink-0" style={{ background: item.color }} />
                  <div className="px-4 py-3">
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
            {/* 顧客メッセージのみ：この文に返信ボタン */}
            {contextMenu.sender === "customer" && contextMenu.text && contextMenu.text !== "[画像]" && (
              <div className="border-t border-[#f0f2f5] px-3 pb-3 pt-2">
                <button
                  onClick={() => {
                    setTargetOverrideMessage({ id: contextMenu.messageId, text: contextMenu.text });
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 py-3 text-[13px] font-bold text-white active:bg-blue-600"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                  この文に返信
                </button>
              </div>
            )}
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