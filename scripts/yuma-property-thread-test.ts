// scripts/yuma-property-thread-test.ts — 4巡目（10/07）: 物件ごとの状況の台帳（property-thread）と写真の依頼の約束を YUMA のブレインで前後比べる
//
// 場面（本番の会話の並びを写す・名前は YUMA・画像は架空の URL・物件名はそのまま）:
//   pt   … S❤（d3a56a97）: 4件の資料 → 「こちらの初期費用知りたい」（フェリオ永田の資料の引用）→ AIX 物件確認した（画像3枚・物件①＋シャーメゾン フェリシード）
//          → 「こちら礼金は少し安くなったり」（名前の無い見積書の画像の引用）＋「あとこちらの詳細も」（一津屋Ⅱの資料の引用）
//   photo… ゆなまる（63fa0c26）: AIX 物件確認した（シャーメゾン ソレイユ 募集中・見積同封）→ 「この部屋の中って写真もらう事とかってできますか？」
// pt は PROPERTY_THREAD_NOTE=off（前）と on（後）でブレインを回し、reply_direction の物件名を見る。photo は後だけ（ブレインの指示の文の写真の約束の形）。
// 書くのは YUMA の messages・sent_image_properties・aix_usage_logs の自分の行だけ（id を控えて消す）。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-property-thread-test.ts [回数=2] [pt,photo]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { requireTestServer } from "./lib/dev-server-test-guard";
import { MSG_SEP } from "../app/lib/reply-context";

const DRAFT_BASE = (process.argv.find((a) => a.startsWith("--draft=")) ?? "").slice(8);
function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PREFIX = "r4pt-";
const own = { msg: [] as string[], sip: [] as string[], aix: [] as string[] };

type Row = { s: "staff" | "customer"; t: string; sec: number; lmid?: string; quote?: string; img?: string; aix?: boolean };
function scene(name: string): { rows: Row[]; sip: Array<{ img: string; name: string; room: string }>; aix: Array<{ sec: number; names: string[]; sts: string[]; est: boolean; text: string }> } {
  if (name === "pt") return {
    rows: [
      { s: "staff", t: "[画像]", sec: 0, lmid: "s1", img: "ferio", aix: true },
      { s: "staff", t: "[画像]", sec: 0.3, lmid: "s2", img: "ichitsuya", aix: true },
      { s: "staff", t: "淀川よりも北側の北摂エリア含めた全域からペット飼育可能な2DK以上のお部屋をピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！", sec: 1, aix: true },
      { s: "customer", t: "こちらの初期費用知りたいです🙏🏻", sec: 25, lmid: "c1", quote: "s1" },
      { s: "staff", t: "かしこまりました！！\nお送りいただきましたお部屋の募集状況と一緒に最大限割引させていただいたお見積書お送りさせていただきます！！", sec: 30 },
      { s: "staff", t: "[画像]", sec: 50, lmid: "a1", img: "est1", aix: true },
      { s: "staff", t: "[画像]", sec: 51.2, lmid: "a2", img: "felicide", aix: true },
      { s: "staff", t: "[画像]", sec: 51.4, lmid: "a3", img: "est2", aix: true },
      { s: "staff", t: "お送り頂きました物件の中で\n・シャーメゾン フェリシード 101号室\nこちら1件現在募集中となります！！\n\n初期費用御見積書同封させて頂きました！！\nお手隙の際にご査収ください！！", sec: 51.6, aix: true },
      { s: "customer", t: "ありがとうございます🙏🏻\nこちら礼金は少し安くなったりはしないでしょうか？🙇🏻‍♀️", sec: 80, lmid: "c2", quote: "a1" },
      { s: "customer", t: "あとこちらの詳細もお願いします🙏", sec: 82, lmid: "c3", quote: "s2" },
    ],
    sip: [{ img: "ferio", name: "フェリオ永田", room: "101" }, { img: "ichitsuya", name: "クリエオーレ一津屋Ⅱ", room: "103" }, { img: "felicide", name: "シャーメゾン フェリシード", room: "101" }],
    aix: [{ sec: 54, names: ["物件①", "シャーメゾン フェリシード 101号室"], sts: ["available", "available"], est: true, text: "お送り頂きました物件の中で\n・シャーメゾン フェリシード 101号室\nこちら1件現在募集中となります！！" }],
  };
  return {
    rows: [
      { s: "customer", t: "[画像] 【物件の画面（ポータル）】\nシャーメゾン ソレイユ 0202号室\n7.3万円\n1LDK", sec: 0 },
      { s: "customer", t: "ここってどうですか", sec: 5 },
      { s: "staff", t: "[画像]", sec: 30, lmid: "p1", img: "est-soleil", aix: true },
      { s: "staff", t: "YUMAさん\nお世話になっております！！\n\n確認させていただきました！！\nシャーメゾン ソレイユ 0202号室現在募集中となります！！\n初期費用御見積書同封させて頂きました！！\n\nお手隙の際にご査収ください！！", sec: 31, aix: true },
      { s: "customer", t: "この部屋の中って写真もらう事とかってできますか？", sec: 60 },
    ],
    sip: [],
    aix: [{ sec: 33, names: ["シャーメゾン ソレイユ 0202号室"], sts: ["available"], est: true, text: "確認させていただきました！！" }],
  };
}

let h: LlmTestHarness | null = null;
async function cleanup() {
  if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
  if (own.sip.length) await sb.from("sent_image_properties").delete().in("image_url", own.sip);
  if (own.aix.length) await sb.from("aix_usage_logs").delete().in("id", own.aix);
  console.log(`片付け: messages ${own.msg.length}・sent_image_properties ${own.sip.length}・aix_usage_logs ${own.aix.length}`);
  own.msg = []; own.sip = []; own.aix = [];
}

async function main() {
  const reps = Math.max(0, Number(process.argv[2] ?? 2));
  const which = (process.argv[3] ?? "pt,photo").split(",");
  h = await setupLlmTest("yuma-property-thread-test");
  h.assertYuma(YUMA);
  if (DRAFT_BASE) await requireTestServer(DRAFT_BASE, "yuma-property-thread-test");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { propertyThreadNoteFor } = await import("../app/lib/property-thread-server");
  for (const name of which) {
    const sc = scene(name);
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    await h.waitUntilYumaQuiet([]);
    const t0 = Date.now() + 60_000;
    const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
    const runId = randomUUID().slice(0, 8);
    const url = (k: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${k}.jpg`; // 架空のファイル（読まない）
    const lm = (k: string) => `${PREFIX}${runId}-${k}`;
    const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({
      conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec),
      line_message_id: r.lmid ? lm(r.lmid) : lm(`n${i}`), quoted_message_id: r.quote ? lm(r.quote) : null, image_url: r.img ? url(r.img) : null,
    }))).select("id");
    if (ins.error) throw new Error(ins.error.message);
    own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
    if (sc.sip.length) {
      const r = await sb.from("sent_image_properties").insert(sc.sip.map((x) => ({ image_url: url(x.img), conversation_id: YUMA, property_name: x.name, room_no: x.room, source: "test", created_at: at(1) })));
      if (r.error) throw new Error(r.error.message);
      own.sip.push(...sc.sip.map((x) => url(x.img)));
    }
    const ax = await sb.from("aix_usage_logs").insert(sc.aix.map((a) => ({ conversation_id: YUMA, aix_type: "property_check_result", check_pattern: "available", property_names: a.names, prop_statuses: a.sts, estimate_sent: a.est, generated_text: a.text, created_at: at(a.sec), sent_at: at(a.sec) }))).select("id");
    if (ax.error) throw new Error(ax.error.message);
    own.aix.push(...(ax.data ?? []).map((x) => x.id as string));

    // 台帳の文（LLM なし）: 未来の時刻の行なので asOf を最後の通の後に
    const note = await propertyThreadNoteFor(YUMA, { asOf: at(200) });
    console.log(`\n===== ${name}: 台帳の文 =====\n${note || "（なし）"}`);
    const modes = name === "pt" ? ["off", "on"] : ["on"];
    for (let k = 0; k < reps; k++) {
      for (const mode of modes) {
        process.env.PROPERTY_THREAD_NOTE = mode;
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full" });
        }) as unknown as Record<string, unknown> | null;
        // reply_direction は決定論の型の文のことがある → ブレインの LLM が書いた欄も並べる
        const pick = (k: string) => { const v = meta?.[k]; return typeof v === "string" ? v : v ? JSON.stringify(v) : ""; };
        const dir = ["reply_direction", "current_property", "note", "key_topics", "customer_questions", "reasoning"].map(pick).filter(Boolean).join(" ｜ ").replace(/\n/g, " ");
        const act = `${meta?.action ?? "-"}${meta?.check_pattern ? `/${meta.check_pattern}` : ""}`;
        const nm = /フェリオ|ファリオ/.test(dir) ? "フェリオ永田" : /フェリシード/.test(dir) ? "フェリシード" : "名前なし";
        if (DRAFT_BASE && meta && meta.reply_mode !== "aix") {
          const lastStaff = sc.rows.map((r) => r.s).lastIndexOf("staff");
          const cust = sc.rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
          const body = { message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
            brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testFlags: { property_thread: mode } };
          const res = await fetch(`${DRAFT_BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
          const ct = res.headers.get("content-type") ?? "";
          const draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 120)}）` : parseStream(await res.text());
          console.log(`   下書き[${mode}]: ${draft.replace(/\n/g, " ／ ")}`);
        }
        console.log(`[${name} ${k + 1} ${mode}] action=${act} 礼金の物件=${name === "pt" ? nm : "-"} 撮影=${/撮影/.test(dir)}\n   方向: ${dir.slice(0, 900)}`);
      }
    }
    delete process.env.PROPERTY_THREAD_NOTE;
    await cleanup();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
