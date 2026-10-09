// app/lib/test-conversations.ts
// テスト用の会話の一覧（1か所）。学習（返信の手本・行動・言い回し・勝ちパターン・差分学習・ナレッジ・AIX の学習・
// ブレインの改善・物件選びの学習）には**入れない**。画面・サーバーのどちらからも import 可（純粋な定数と関数だけ）。
//
// 2026-09-27 竹内さん「全部それで」: 9/27 の YUMA 実送信で save-reply-example が ai_reply_examples に
//   YUMA の行（entry_source=aix_action）を入れた。YUMA を外していたのは scoring-learning-server.ts だけだった。
//   → 一覧をここにまとめ、学習に入る全経路で isTestConversation / excludeTestConversations を通す。
//   足す時はこの配列に足すだけ（各経路は触らない）。

/** YUMA（竹内さん本人のテスト用 LINE・sumora） */
export const YUMA_CONVERSATION_ID = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

/**
 * スタッフ同士のやり取りの会話（お客様ではない）。見張り・学習から外す（テスト用の会話と同じ扱い）。
 * 2026-10-07 竹内さん「４スタッフ同士の会話外して良い」（AIX の判断のずれの調査で 469a614a の文がスタッフ同士＝「また井尻さんか！笑」等）。
 * ※ LLM のテストの歯止めは TEST_ONLY_CONVERSATION_IDS（YUMA＋テスト専用の会話）で別に見ているので、ここに足しても試しには使われない
 */
/**
 * お客様ではない会話の印（スタッフ同士・身内・業者・営業）。見張り・学習から外す（テスト用の会話と同じ扱い）。
 * 2026-10-07 5巡目（竹内さん「外す」＝身内・業者の会話を見張りから外す）: 種類と理由を1行ずつ持つ（足す・戻すはこの表だけ）。
 *   候補は scripts/audit-internal-conversations.ts [--all]（見張りの会話の文の印＝タメ口・社内の語・業者・営業・身内の呼び方を点にして並べる）で出し、
 *   竹内さんの確認で足す。外した会話は「お客様ではない」と決まった物だけ（グループでもお客様の会話＝黒明様・野口様は外さない）
 */
export type InternalConversationKind = "staff" | "family" | "vendor";
export const INTERNAL_CONVERSATIONS: ReadonlyArray<{ id: string; kind: InternalConversationKind; note: string }> = [
  { id: "469a614a-7518-45c7-88cc-814e674fa881", kind: "staff", note: "【グループ】緊急用・スタッフ同士（「また井尻さんか！笑」）10/07 竹内さん「４スタッフ同士の会話外して良い」" },
  { id: "afbd1b8b-6415-4edd-a324-700a3b0d9e78", kind: "staff", note: "【グループ】蓮産業株式会社【業務連絡用】・社内（「AD15000円やから、仲介手数料調整頼む！」）5巡目の候補" },
  { id: "56c4f0b0-456c-4bbc-a27c-0fb885960afc", kind: "vendor", note: "業者の営業（AI賃貸営業マン「賃太郎」の広告が繰り返し届く・こちらの返しは無し）5巡目の候補" },
];
export const STAFF_INTERNAL_CONVERSATION_IDS: readonly string[] = INTERNAL_CONVERSATIONS.map((c) => c.id);

/**
 * LINE につながっていないテスト専用の会話（YUMA2〜YUMA5）。
 * 2026-10-09 竹内さん承認「YUMA の他に、LINE につながっていないテスト専用の会話を数本作り、担当ごとに別の会話で並べて回す」:
 *   1巡＝試験121問を YUMA 1本で順番待ちして数時間かかっていた → 担当ごとに別の会話で並べる（scripts/lib/test-conv-lease.ts で占有）。
 *   行は竹内さんが SQL で作る（conversations＋property_customers・id はここと同じ）。送信先にならない形:
 *     line_user_id = "TEST-NOLINE-YUMAn"（LINE の ID の形でない＝line-target.checkSendTarget が invalid_target で止める・LINE の API も 400）
 *     send_blocked_reason = "test_no_line"・auto_send_enabled = false（自動返信の cron が拾わない）
 *   さらに送信の経路の歯止め（isNoLineTestConversation）で、宛先の形に関わらず送らない・要対応の登録／売上番長グループへの通知・自動の物件検索をしない。
 *   学習・手本・見張り・ターゲット一覧・一覧の印からは TEST_CONVERSATION_IDS で外れる。LLM のテスト（deepseek-all／final-claude）は YUMA と同じく通す（TEST_ONLY_CONVERSATION_IDS）。
 */
export const NO_LINE_TEST_LINE_USER_ID_PREFIX = "TEST-NOLINE-";
export type NoLineTestConversation = { id: string; name: string; propertyCustomerId: string; lineUserId: string };
export const NO_LINE_TEST_CONVERSATIONS: ReadonlyArray<NoLineTestConversation> = [
  { id: "d040f80a-4fae-4fd0-abca-66eb2630906f", name: "YUMA2", propertyCustomerId: "89c6c607-86f0-4ca9-a81a-3a57193fc5f6", lineUserId: `${NO_LINE_TEST_LINE_USER_ID_PREFIX}YUMA2` },
  { id: "f7deb105-f908-41ad-95e7-f13aafdfa032", name: "YUMA3", propertyCustomerId: "c4dc3bed-141f-447c-8712-b69e7eb11e7b", lineUserId: `${NO_LINE_TEST_LINE_USER_ID_PREFIX}YUMA3` },
  { id: "40f0db25-5fa9-4b96-bc19-3e1e5aba20c2", name: "YUMA4", propertyCustomerId: "f322abdd-dcc0-4ef2-b67b-bfdec1f8b3ad", lineUserId: `${NO_LINE_TEST_LINE_USER_ID_PREFIX}YUMA4` },
  { id: "a7ac4c90-26f7-4b8d-bd19-81d831fc75e0", name: "YUMA5", propertyCustomerId: "8ec2138a-e733-4fce-872a-1bfceac2eaaa", lineUserId: `${NO_LINE_TEST_LINE_USER_ID_PREFIX}YUMA5` },
];
export const NO_LINE_TEST_CONVERSATION_IDS: readonly string[] = NO_LINE_TEST_CONVERSATIONS.map((c) => c.id);
const NO_LINE_SET: ReadonlySet<string> = new Set(NO_LINE_TEST_CONVERSATION_IDS);

/** LINE につながっていないテスト専用の会話か（送信・要対応の通知・自動検索をしない） */
export function isNoLineTestConversation(conversationId: string | null | undefined): boolean {
  return !!conversationId && NO_LINE_SET.has(String(conversationId).trim());
}
/** 宛先がテスト専用の会話の印（TEST-NOLINE-…）か */
export function isNoLineTestLineUserId(lineUserId: string | null | undefined): boolean {
  return String(lineUserId ?? "").trim().startsWith(NO_LINE_TEST_LINE_USER_ID_PREFIX);
}

/** LLM のテストを回してよい会話（YUMA＋テスト専用の会話）。スタッフ同士の会話は入れない（試しには使わない） */
export const TEST_ONLY_CONVERSATION_IDS: readonly string[] = [YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS];
const TEST_ONLY_SET: ReadonlySet<string> = new Set(TEST_ONLY_CONVERSATION_IDS);
export function isTestOnlyConversation(conversationId: string | null | undefined): boolean {
  return !!conversationId && TEST_ONLY_SET.has(String(conversationId).trim());
}
/** "YUMA2"・"yuma2"・id のどれでもテスト専用の会話（YUMA を含む）を引く。無ければ null */
export function resolveTestOnlyConversation(nameOrId: string | null | undefined): { id: string; name: string } | null {
  const s = String(nameOrId ?? "").trim();
  if (!s) return null;
  if (s === YUMA_CONVERSATION_ID || s.toUpperCase() === "YUMA") return { id: YUMA_CONVERSATION_ID, name: "YUMA" };
  const c = NO_LINE_TEST_CONVERSATIONS.find((x) => x.id === s || x.name.toUpperCase() === s.toUpperCase());
  return c ? { id: c.id, name: c.name } : null;
}

/** テスト用の会話の id（学習・見張りから外す会話＝YUMA＋テスト専用の会話＋スタッフ同士の会話） */
export const TEST_CONVERSATION_IDS: readonly string[] = [YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS];
const TEST_SET: ReadonlySet<string> = new Set(TEST_CONVERSATION_IDS);

/** テスト用の会話か（null・空は false） */
export function isTestConversation(conversationId: string | null | undefined): boolean {
  return !!conversationId && TEST_SET.has(String(conversationId).trim());
}

/** 行の配列からテスト用の会話の行を外す（conversation_id 列を見る） */
export function excludeTestConversations<T extends { conversation_id?: string | null }>(rows: ReadonlyArray<T> | null | undefined): T[] {
  return (rows ?? []).filter((r) => !isTestConversation(r?.conversation_id ?? null));
}

/** Supabase の `.not("conversation_id", "in", TEST_CONVERSATIONS_IN)` に渡す形（読む時点で外す） */
export const TEST_CONVERSATIONS_IN = `(${TEST_CONVERSATION_IDS.join(",")})`;
