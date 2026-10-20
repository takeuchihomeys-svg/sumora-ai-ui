// app/lib/screening-sensitive-server.ts
// 会話に審査の事情（screening-sensitive.ts）が出たかを、DB を読み直さずに引く口（サーバー専用）。
//
// 2026-10-20 竹内「個人情報が絡む部分はかならずクロードにする」の残りの穴（AIX・物件の経路・Jev）:
//   入口（generate-reply・aix/action）が読んだ物はリクエストの箱（deepseek-scope.screeningSensitive）に置き、中の呼び出しはそれを使う。
//   箱の外（裏の読み取り・Jev）は会話ごとに覚える: 当たった会話は以後もずっと当たる（事情はメモ・要約に残るので一度出たら戻さない）・
//   当たらない会話は短い間だけ覚える（その間に打ち明けられても入口の箱・送る窓の判定が先に当たる）。
//   読めなければ当たった側（Claude・送らない）に倒す（覚えない＝次の回で読み直す）。
import { currentDeepseekScope } from "./deepseek-scope";
import { loadScreeningSensitive, type ScreeningSensitiveHit } from "./screening-sensitive";

/** 読めない時の印（当たった側に倒す） */
export const SCREENING_SENSITIVE_UNREADABLE: ScreeningSensitiveHit = { category: "職業（夜の仕事・無職 等）", word: "(読めない)" };

/** 当たらなかった会話を覚えておく時間 */
export const SCREENING_SENSITIVE_MISS_TTL_MS = 2 * 60_000;

type Entry = { at: number; hit: ScreeningSensitiveHit | null };
const KEY = "__sumoraScreeningSensitiveCache";
function cache(): Map<string, Entry> {
  const g = globalThis as unknown as Record<string, Map<string, Entry> | undefined>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}
const inflight = new Map<string, Promise<ScreeningSensitiveHit | null>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };

/** 覚えた物を消す（テスト用） */
export function clearScreeningSensitiveCache(): void { cache().clear(); inflight.clear(); }

/**
 * 会話に審査の事情が出たか。① リクエストの箱に同じ会話の物があればそれ ② 覚えた物 ③ DB（loadScreeningSensitive）。
 * 読めなければ SCREENING_SENSITIVE_UNREADABLE（当たった側）。
 */
export async function screeningSensitiveForConversation(conversationId: string, opts: { sb?: Sb; now?: number; load?: (sb: Sb, id: string) => Promise<ScreeningSensitiveHit | null> } = {}): Promise<ScreeningSensitiveHit | null> {
  const scope = currentDeepseekScope();
  if (scope?.screeningSensitive && scope.conversationId === conversationId) {
    try { return await scope.screeningSensitive(); } catch { return SCREENING_SENSITIVE_UNREADABLE; }
  }
  const now = opts.now ?? Date.now();
  const c = cache();
  const e = c.get(conversationId);
  if (e && (e.hit || now - e.at < SCREENING_SENSITIVE_MISS_TTL_MS)) return e.hit;
  const running = inflight.get(conversationId);
  if (running) return running;
  const p = (async () => {
    try {
      const sb = opts.sb ?? (await import("./supabase")).supabase;
      const hit = await (opts.load ?? loadScreeningSensitive)(sb as Sb, conversationId);
      if (c.size > 5000) for (const [k, v] of c) if (!v.hit) c.delete(k);   // 当たらなかった物だけ捨てる（当たった会話は残す）
      c.set(conversationId, { at: now, hit });
      return hit;
    } catch (err) {
      console.warn("[screening-sensitive] 読めない → 当たった側に倒す", conversationId, err instanceof Error ? err.message : String(err));
      return SCREENING_SENSITIVE_UNREADABLE;
    } finally {
      inflight.delete(conversationId);
    }
  })();
  inflight.set(conversationId, p);
  return p;
}
