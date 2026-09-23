// app/lib/own-property-server.ts
// お客様の最新の連投に含まれる物件（スクショ）が、こちらが前に送った物件かを DB の記録で照合する。
// 判定そのものは own-property-match.ts（純関数）。ここは記録を引いて渡すだけ。
// 2026-09-22 竹内（𝓡さん事例）「こっちが送った物件をお客さんが送ってくることもある。判断できるようにする」
import { supabase } from "@/app/lib/supabase";
import { extractScreenshotProperty, matchOwnProperty, buildOwnPropertyNote, type SentProperty, type OwnMatch, type ScreenshotProperty } from "@/app/lib/own-property-match";
import { isJevEnabled } from "@/app/lib/jev-client";
import { askOwnPropertyJev } from "@/app/lib/own-property-jev";
import { waitUntil } from "@vercel/functions";

type Msg = { sender: string; text?: string | null; createdAt?: string | null };

/**
 * 影の運用: 決定論で「こちらが送った部屋」と決まらなかった画像だけ Jev に聞いて記録する（判断は変えない）。
 * ブレイン・返信生成を待たせない（waitUntil）。鍵が無ければ何もしない。
 */
function shadowAskJev(
  conversationId: string,
  turn: ReadonlyArray<Msg>,
  results: ReadonlyArray<{ item: ScreenshotProperty; match: OwnMatch }>,
  sent: ReadonlyArray<SentProperty>,
): void {
  if (!isJevEnabled() || sent.length === 0) return;
  // 決定論で決まった物は聞かない（same_room）。画像の通のうち、決まらなかった物を対象にする
  const undecided = results.filter((r) => r.match.kind !== "same_room").length;
  const texts = turn.map((m) => m.text ?? "").filter((t) => /^\s*\[画像\]/.test(t));
  if (undecided === 0 || texts.length === 0) return;
  const job = (async () => {
    try {
      const { loadKnownCustomerNames } = await import("@/app/lib/pii-known-names");
      const { maskPII } = await import("@/app/lib/pii-mask");
      const names = await loadKnownCustomerNames().catch(() => [] as string[]);
      for (const raw of texts.slice(0, 2)) {
        const ev = await askOwnPropertyJev({
          transcript: maskPII(raw, names),
          sent: sent.map((s) => ({ name: s.name, room: s.room, sentAt: s.sentAt })),
          conversationId, timeoutMs: 5_000,
        });
        if (!ev) continue;
        const det = results.find((r) => r.match.kind === "same_room")?.match.sent?.name ?? null;
        await supabase.from("jev_shadow_logs").insert({
          kind: "own_property", conversation_id: conversationId,
          brain_action: det ? "same_room" : "none", brain_check_pattern: det,
          jev_picker: ev.decision.key, jev_picker_value: ev.decision.choice?.name ?? null,
          jev_picker_prob: ev.decision.prob, jev_confidence: ev.decision.confidence,
          jev_model: ev.raw.model, jev_ms: ev.raw.ms, answers: ev.raw.answers as Record<string, unknown>,
        }).then(({ error }) => { if (error) console.warn("[own-property-jev] 記録できない:", error.message); });
        console.log(JSON.stringify({ tag: "own-property:jev", conversationId, det, jev: ev.decision.choice?.name ?? "none", p: Number(ev.decision.prob.toFixed(2)), ms: ev.raw.ms }));
      }
    } catch (e) {
      console.warn("[own-property-jev] skipped:", e instanceof Error ? e.message : String(e));
    }
  })();
  try { waitUntil(job); } catch { /* Vercel 以外 */ }
}

export async function resolveOwnPropertyForTurn(
  conversationId: string | null | undefined,
  recentMessagesOldestFirst: ReadonlyArray<Msg>,
): Promise<{ note: string; all: boolean; items: number; ours: number } | null> {
  if (!conversationId) return null;
  // 最後のこちらの発言より後の、お客様の画像（スクショ）
  const msgs = [...recentMessagesOldestFirst];
  let i = msgs.length - 1;
  const turn: Msg[] = [];
  while (i >= 0 && msgs[i].sender === "customer") { turn.unshift(msgs[i]); i--; }
  const items = turn
    .map((m) => ({ m, item: extractScreenshotProperty(m.text ?? "") }))
    .filter((x): x is { m: Msg; item: NonNullable<ReturnType<typeof extractScreenshotProperty>> } => !!x.item);
  if (items.length === 0) return null;
  try {
    const [{ data: sp }, { data: sip }] = await Promise.all([
      supabase.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", conversationId).limit(300),
      supabase.from("sent_image_properties").select("property_name, room_no, created_at").eq("conversation_id", conversationId).limit(300),
    ]);
    const sent: SentProperty[] = [
      ...((sp ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string | null }>).map((r) => ({ name: r.property_name ?? "", room: r.room_no, sentAt: r.sent_at })),
      ...((sip ?? []) as Array<{ property_name: string | null; room_no: string | null; created_at: string }>).map((r) => ({ name: r.property_name ?? "", room: r.room_no, sentAt: r.created_at })),
    ].filter((s) => s.name);
    const results = items.map(({ m, item }) => ({
      item,
      // お客様が送るより前にこちらが送った物だけ
      match: matchOwnProperty(item, sent.filter((s) => !s.sentAt || !m.createdAt || s.sentAt < m.createdAt)),
    }));
    const ours = results.filter((r) => r.match.kind === "same_room").length;
    const note = buildOwnPropertyNote(results);
    console.log(JSON.stringify({ tag: "reply:own-property", conversationId, items: results.length, ours, sentKnown: sent.length }));
    // 2026-09-23 竹内「お客さんが送ってきた画像が、こちらから送った画像かどうかの判定も Jev でできるのかな」:
    //   決定論で決まらなかった物（取り出せない・建物までしか分からない）だけ Jev に聞いて**記録するだけ**（影の運用）。
    //   判断は変えない。答え合わせは scripts/audit-own-property-image.ts --jev（スタッフの実際の返しと突き合わせる）。
    //   ⚠ ブレインを待たせない（応答の後ろで走らせる）。鍵が無ければ何もしない。
    shadowAskJev(conversationId, turn, results, sent);
    return { note, all: ours > 0 && ours === results.length, items: results.length, ours };
  } catch (e) {
    console.warn("[own-property] 照合失敗（従来どおり）:", e instanceof Error ? e.message : e);
    return null;
  }
}
