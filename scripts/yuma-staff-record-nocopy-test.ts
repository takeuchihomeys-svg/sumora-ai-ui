// scripts/yuma-staff-record-nocopy-test.ts — 「判断に使うが書かない」（竹内さん 10/14）の前後を DeepSeek で各1回（ブレイン→下書き）
//   電話・内覧で分かったスタッフの記録（他社でも検討中・見送りそう 等）は判断の材料に使うが、お客様への文に書き写さない。
//   前＝STAFF_RECORD_NO_COPY=off（指示なし）／後＝既定。テスト専用の会話（YUMA5・LINE なし）に場面を入れ、線（REPLAY_FLOOR_FILE）で過去を読まない。入れた行は消す
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-staff-record-nocopy-test.ts
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const FLOOR_FILE = resolve("scripts/.replay-out/nocopy-floor.json");
mkdirSync("scripts/.replay-out", { recursive: true });
writeFileSync(FLOOR_FILE, "{}");
process.env.REPLAY_FLOOR_FILE = FLOOR_FILE; // app の supabase を読み込む前に（線の包みは読み込みの時に決まる）

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PREFIX = "nocopy-";
const own = { msg: [] as string[], vh: [] as string[] };
/** 書き写し（お客様が言っていない見立て）の印 */
const COPY_RE = /他社|他の不動産|見送|ご検討中|迷って|奥様と|ご家族と/;

type Row = { s: "staff" | "customer"; t: string; sec: number; aix?: boolean };
const SCENES: Record<string, { rows: Row[]; call?: string; viewing?: string }> = {
  call: {
    rows: [
      { s: "staff", t: "[通話リクエスト] 電話をかけるボタン", sec: 0, aix: true },
      { s: "customer", t: "先ほどはお電話ありがとうございました！また連絡させて頂きます！", sec: 1800 },
    ],
    call: "【他社で検討中・家族と相談】 他社でも2件内覧予定。奥様と相談して週末に返事。駐車場を気にしている",
  },
  viewing: {
    rows: [
      { s: "staff", t: "YUMAさん\n本日お時間頂きありがとうございました！！\nお気に召されましたらお申込みでお部屋抑えさせて頂きます😊！！", sec: 0, aix: true },
      { s: "customer", t: "ありがとうございました！少し考えてまた連絡します", sec: 1800 },
    ],
    viewing: "内覧の結果: 見送りそう\n気になった点: 家賃・初期費用\n次の動き: 他の物件も見たい\n他社でも同じ建物を見ている",
  },
};

/** generate-reply の流れの本文（1行目のメタの JSON と <<<…>>> の印を外す・yuma-customer-memo-test と同じ） */
function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

async function main() {
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const { NO_LINE_TEST_CONVERSATIONS } = await import("../app/lib/test-conversations");
  const CONV = NO_LINE_TEST_CONVERSATIONS.find((c) => c.name === "YUMA5")!.id;
  const h = await setupLlmTest("yuma-staff-record-nocopy-test");
  h.assertTestConversation(CONV);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  const { applyMemoOps, EMPTY_MEMO } = await import("../app/lib/customer-memo");
  const { MSG_SEP } = await import("../app/lib/reply-context");
  const memoBox = new Map<string, import("../app/lib/customer-memo").StoredMemo>();
  (globalThis as { __customerMemoOverride?: unknown }).__customerMemoOverride = memoBox;
  process.env.CUSTOMER_MEMO_LLM = "off";
  const cleanup = async () => {
    if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
    if (own.vh.length) await sb.from("viewing_history").delete().in("id", own.vh);
    if (own.msg.length || own.vh.length) console.log(`   消した: messages ${own.msg.length}・viewing_history ${own.vh.length}`);
    own.msg = []; own.vh = [];
  };
  try {
    for (const [name, sc] of Object.entries(SCENES)) for (const ver of ["off", "on"] as const) {
      process.env.STAFF_RECORD_NO_COPY = ver === "off" ? "off" : "";
      await h.waitUntilYumaQuiet(own.msg, { conversationId: CONV });
      const last = Math.max(...sc.rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000;
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      writeFileSync(FLOOR_FILE, JSON.stringify({ conversationId: CONV, floor: new Date(t0 - 5_000).toISOString(), status: "proposing", messageIdPrefix: PREFIX }));
      try {
        const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: CONV, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}` }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
        memoBox.clear();
        if (sc.call) memoBox.set(CONV, applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "call", text: sc.call, at: at(600), by: "staff", certainty: "sure", ttlDays: null }], { origin: "staff", nowIso: at(600), newId: () => "c1" }).memo);
        if (sc.viewing) {
          const ymd = new Date(Date.parse(at(0)) + 9 * 3600_000).toISOString().slice(0, 10);
          const v = await sb.from("viewing_history").insert({ conversation_id: CONV, customer_name: "YUMA", scheduled_date: ymd, actual_date: ymd, status: "done", is_primary: false, viewing_report: sc.viewing, viewing_report_at: at(600), created_at: at(0), notes: "test nocopy" }).select("id");
          if (v.error) throw new Error(v.error.message);
          own.vh.push(...(v.data ?? []).map((x) => x.id as string));
        }
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: CONV, mark: { kind: "all" } });
          return analyzeConversation(CONV, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", mode: "full", layer: "combined", strategy: null });
        }) as unknown as Record<string, unknown> | null;
        const dir = String(meta?.reply_direction ?? "");
        const cust = sc.rows.filter((r) => r.s === "customer").map((r) => r.t);
        const body = {
          message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: CONV, customerName: "YUMA", hasViewed: name === "viewing", activeTaskTypes: [], hasStaffReplied: true,
          recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
          brainMetaDirect: { meta: { ...meta, reply_mode: meta?.reply_mode === "aix" ? "reply" : meta?.reply_mode }, customerName: "YUMA", conversationDirection: (meta?.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
          shadowNoWrite: true, testSceneMaterials: "on",
        };
        const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
        const ct = res.headers.get("content-type") ?? "";
        const draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）` : parseStream(await res.text());
        console.log(`\n[${name} ${ver === "off" ? "前（指示なし）" : "後"}] action=${meta?.action ?? "-"} reply_mode=${meta?.reply_mode ?? "-"}\n   方向: ${dir.replace(/\n/g, " ").slice(0, 200)}\n   下書き: ${draft.replace(/\n/g, " ／ ")}\n   書き写し: 方向=${COPY_RE.test(dir) ? "あり" : "なし"}・下書き=${COPY_RE.test(draft) ? "あり" : "なし"}`);
      } finally { writeFileSync(FLOOR_FILE, "{}"); await cleanup(); }
    }
  } finally { await cleanup(); await h.finish(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 800));
