// scripts/yuma-two-choice-now-test.ts — その場の側の2択（TWO_CHOICE_NOW_SIDE）: ブレインが AIX を選んだ番で右の「返信する（〇〇の約束）」を押した時、
//   generate-reply が約束の下書きを書くかを確かめる（テスト専用の会話・DeepSeek・ブレインは呼ばない＝判断はこの番の形に固定）。
//   2026-10-28 作業員5。版: base＝指定なし（今の手動の返信ボタン）・new＝promiseReplyHint を replyHint に（画面と同じ・replyHintAuto=false）。
//   見る物: 約束の文（確認させて／作成しお送り／ピックアップしお送り）があるか・AIX で送る中身（金額・募集中の断言・物件名）を書いていないか。
// 実行: REPLAY_FLOOR_FILE=scripts/.replay-out/tcnow-floor.json LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-two-choice-now-test.ts \
//         --floor=scripts/.replay-out/tcnow-floor.json --conv=YUMA5 [--only=pickup,estimate,check] [--versions=base,new]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { acquireTestConversation } from "./lib/test-conv-lease";
import { MSG_SEP } from "../app/lib/reply-context";
import { promiseReplyHint, type PromiseOrNowKind } from "../app/lib/two-choice";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const FLOOR_FILE = arg("floor");
const VERSIONS = arg("versions", "base,new").split(",");
const ONLY = arg("only").split(",").filter(Boolean);
const PREFIX = "tcnow-";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own: string[] = [];

// 作った場面（個人の値なし）。ブレインがその場の AIX を選んだ番の形
type Scene = { kind: PromiseOrNowKind; action: string; history: Array<{ sender: "customer" | "staff"; text: string; minAgo: number }> };
const SCENES: Scene[] = [
  { kind: "pickup", action: "property_send", history: [
    { sender: "staff", text: "YUMAさん\nご希望の条件に合ったお部屋お送りさせて頂きました😊！！\nお手隙の際にご査収下さい！！", minAgo: 60 },
    { sender: "customer", text: "ありがとうございます！\n他にも難波の辺りで7万円以内のお部屋あれば見たいです", minAgo: 2 },
  ] },
  { kind: "estimate", action: "estimate_sheet", history: [
    { sender: "staff", text: "YUMAさん\nこちらのお部屋現在募集中となります😊！！", minAgo: 90 },
    { sender: "customer", text: "よかったです！\nこのお部屋の初期費用はいくらくらいになりますか？", minAgo: 2 },
  ] },
  { kind: "check", action: "property_check_result", history: [
    { sender: "staff", text: "YUMAさん\nかしこまりました！！何卒宜しくお願い致します😊", minAgo: 120 },
    { sender: "customer", text: "https://suumo.jp/chintai/jnc_000000000000/\nこのお部屋まだ空いてますか？", minAgo: 2 },
  ] },
];
const PROMISE_RE: Record<PromiseOrNowKind, RegExp> = {
  check: /確認(?:させて|致し|いたし)/,
  estimate: /見積書[^。！!\n]{0,12}(?:作成|お送り)/,
  pickup: /(?:ピックアップ|お探し)[^。！!\n]{0,12}(?:お送り|させて)/,
};
// AIX で送る中身を本文に書いていないか（金額・募集中の断言）
const NOW_CONTENT_RE = /[0-9０-９,，]+円|募集中(?:です|となります|でございます)/;

function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
let h: LlmTestHarness | null = null;
let CONV = "";
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: CONV, floor, status: "proposing", messageIdPrefix: PREFIX } : {}));
}
async function cleanup() { if (own.length) await sb.from("messages").delete().in("id", own); own.length = 0; }

async function main() {
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする");
  const lease = acquireTestConversation(arg("conv", "YUMA5"), "yuma-two-choice-now-test");
  CONV = lease.id;
  h = await setupLlmTest("yuma-two-choice-now-test");
  h.assertTestConversation(CONV);
  const { POST } = await import("../app/api/generate-reply/route");
  const scenes = ONLY.length ? SCENES.filter((s) => ONLY.includes(s.kind)) : SCENES;
  let ok = 0, n = 0;
  for (const s of scenes) {
    await h.waitUntilYumaQuiet(own, { conversationId: CONV });
    const now = Date.now() + 60_000;
    const hist = s.history.map((m) => ({ ...m, createdAt: new Date(now - m.minAgo * 60_000).toISOString(), isAix: false }));
    const runId = randomUUID().slice(0, 8);
    try {
      const ins = await sb.from("messages").insert(hist.map((m, i) => ({ conversation_id: CONV, sender: m.sender, text: m.text, is_aix_generated: false, created_at: m.createdAt, line_message_id: `${PREFIX}${runId}-${i}` }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own.push(...(ins.data ?? []).map((x) => x.id as string));
      writeFloor(new Date(Date.parse(hist[0].createdAt) - 5_000).toISOString());
      await new Promise((r) => setTimeout(r, 1000));
      const lastCust = hist.filter((m) => m.sender === "customer").map((m) => m.text);
      const meta = { action: s.action, reply_mode: "aix", note: "", two_choice_mode: true, reply_direction_label: s.kind, two_choice_reply_kind: s.kind, two_choice_reply_hint: promiseReplyHint(s.kind), analyzed_msg_ts: hist[hist.length - 1].createdAt };
      for (const ver of VERSIONS) {
        const hint = ver === "new" ? promiseReplyHint(s.kind) : "";
        const body = {
          message: lastCust.join(MSG_SEP), customerMessages: lastCust, state: "proposing", conversationId: CONV, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
          recentMessages: hist.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: false })),
          replyHint: hint || undefined, replyHintAuto: false,
          brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: null, brainAnalyzedAt: new Date().toISOString() },
          shadowNoWrite: true, testSceneMaterials: "on",
        };
        const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
        const ct = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const draft = ct.includes("application/json") ? `(JSON: ${raw.slice(0, 120)})` : parseStream(raw);
        const promised = PROMISE_RE[s.kind].test(draft);
        const nowContent = NOW_CONTENT_RE.test(draft);
        if (ver === "new") { n++; if (promised && !nowContent) ok++; }
        console.log(`\n[${s.kind} ${ver}] 約束=${promised ? "○" : "✕"} AIXの中身=${nowContent ? "書いた✕" : "なし"}\n   ${draft.replace(/\n/g, "⏎").slice(0, 240)}`);
      }
    } catch (e) { console.error(`   失敗: ${e instanceof Error ? e.message : String(e)}`); }
    finally { writeFloor(null); await cleanup(); }
  }
  console.log(`\nnew: 約束の下書き ${ok}/${n}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { writeFloor(null); try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
