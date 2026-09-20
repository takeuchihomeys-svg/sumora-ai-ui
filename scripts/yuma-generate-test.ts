// YUMA で本番と同じ形の返信生成を回し、スタッフの言い回しになっているかを見る
//
// 2026-09-20 竹内「YUMAで一通りおくって会話実際のスタッフが送ってるような言い回しになるのか テストお願い」
//
// 設計知見:
//   「本番検証は画面が渡すのと同じ形で渡す」（形が違うと直す必要のない物を直す）
//   「本番の返信生成に会話 ID を渡すと下書き欄（ai_draft・ai_draft_check）が書き換わるので、
//     テスト用の会話でも元の値を控えて戻す」→ scripts/yuma-snapshot.ts save/restore
//
// 渡す body は app/page.tsx:3551 の fetch とまったく同じ形にする。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 一通りの流れ（実際のお客様がよく送る形） */
const SCENES: Array<{ id: string; msg: string }> = [
  { id: "①検討中", msg: "ありがとうございます！\n考えます(よろしく)" },
  { id: "②費用の質問", msg: "初期費用ってどれくらいかかりますか？" },
  { id: "③内覧希望", msg: "この物件内覧したいです！" },
  { id: "④条件の追加", msg: "もう少し駅近の物件ないですか？" },
  { id: "⑤申込の意思", msg: "申し込みお願いします" },
  { id: "⑥了承のみ", msg: "ありがとうございます" },
  { id: "⑦断り", msg: "やっぱり今回は見送ります" },
  { id: "⑧書類を送った", msg: "[画像] 本人確認書類" },
];

async function main() {
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  const { data: conv } = await sb.from("conversations")
    .select("id, customer_name, status, has_viewed").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;

  const { data: ms } = await sb.from("messages")
    .select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const all = (ms ?? []) as unknown as Array<Record<string, unknown>>;
  // page.tsx と同じ組み立て（直近25件＋スタッフ返信が無ければ最新のスタッフ発言を先頭に）
  const last20 = all.slice(-25);
  const hasStaff = last20.some((m) => m.sender === "staff");
  const lastStaff = !hasStaff ? [...all].reverse().find((m) => m.sender === "staff") : undefined;
  const finalMsgs = lastStaff ? [lastStaff, ...last20] : last20;
  const recentMessages = finalMsgs.map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    createdAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  console.log(`=== YUMA [${c.status}] 履歴 ${recentMessages.length}通を渡して生成 ===`);
  console.log(`   直前のスタッフ発言: 「${[...recentMessages].reverse().find((m) => m.sender === "staff")?.text.replace(/\n/g, " ").slice(0, 60) ?? "(なし)"}」\n`);

  for (const s of SCENES) {
    if (only && !only.some((o) => s.id.includes(o))) continue;
    const body = {
      message: s.msg,
      customerMessages: [s.msg],
      state: String(c.status ?? "proposing"),
      conversationId: YUMA,
      customerName: String(c.customer_name ?? "YUMA"),
      customerConditions: undefined,
      customerSummary: undefined,
      customerStructured: undefined,
      replyHint: undefined,
      hasViewed: !!c.has_viewed,
      activeTaskTypes: [] as string[],
      recentMessages: [...recentMessages, { sender: "customer", text: s.msg, createdAt: new Date().toISOString(), isAix: false }],
    };
    const t0 = Date.now();
    let text = "", meta: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`${BASE}/api/generate-reply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const raw = await res.text();
      const nl = raw.indexOf("\n");
      if (nl >= 0) {
        try { meta = JSON.parse(raw.slice(0, nl)) as Record<string, unknown>; } catch { meta = null; }
        text = raw.slice(nl + 1);
      } else text = raw;
    } catch (e) {
      text = `【エラー】${e instanceof Error ? e.message : String(e)}`;
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    // 内部タグを外して「お客様に見える文」にする
    const body2 = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
    console.log(`${"─".repeat(72)}`);
    console.log(`【${s.id}】客「${s.msg.replace(/\n/g, " ")}」  (${sec}s)`);
    if (meta && meta.ok === false) console.log(`   meta: ok=false reason=${meta.reason}`);
    else if (meta) {
      // 2026-09-20: ③で「ご都合よろしいお日にち」が再発した時、セルではなく **ブレインの note** が
      //   「候補日時を提示し」と渡していた。どちらの経路が言っているかを見るため meta を省略せず出す。
      console.log(`   meta.keys : ${Object.keys(meta).join(", ")}`);
      console.log(`   suggested_aix: ${JSON.stringify(meta.suggested_aix ?? null)}`);
      for (const k of ["brain_tier", "tier", "turn_pair", "turnPair", "rule_id", "reply_context_snapshot", "aix_meta"]) {
        if (meta[k] !== undefined) console.log(`   ${k}: ${JSON.stringify(meta[k]).slice(0, 400)}`);
      }
    }
    console.log(`\n${body2 || "（本文なし）"}\n`);
  }
  console.log(`${"─".repeat(72)}`);
  console.log(`\n※ 終わったら必ず: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore`);
}
main().catch((e) => { console.error(e); process.exit(1); });
