// scripts/yuma-r5-scenes.ts — 5巡目（10/07）: 竹内さんの答えの直しを YUMA のブレイン（＋下書き）で確かめる
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・自分の行だけ id で消す）。
//
// 場面（本番の会話の形を写す・名前は YUMA・画像は架空の URL）:
//   photo_ours    … こちらが送った物件（資料の記録あり）に「この部屋の中の写真ってもらえますか？」→ AIX【物件確認した→室内写真】を直接（手元にある）
//   photo_brought … ゆなまる（63fa0c26）の形: お客様の持ち込み（ポータルの画面）→ 募集中・見積同封 →「この部屋の中って写真もらう事とかってできますか？」→ 撮影の約束
//   guarantor     … H（d46290ff 10/01）の形: 連帯保証人の設定の依頼 →「連帯保証人には連絡行きますか？また必要な書類等はありますか？」→ 下書きに電話の可能性・実印・印鑑証明
//   viewing_wish  … 9b9b81ba（10/02）の形: 新着の物件 →「こちら内覧希望です」→ 内覧できるかの確認の約束（AIX なし）
//   viewing_dated … 同じ物件に「こちら10/12の14時から内覧希望です」→ AIX【内覧調整】を直接（日時の指定）
// 書くのは YUMA の messages・sent_image_properties・aix_usage_logs の自分の行だけ（id を控えて消す）。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r5-scenes.ts [回数=1] [場面,..] [--draft=http://localhost:3473]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { requireTestServer } from "./lib/dev-server-test-guard";
import { MSG_SEP } from "../app/lib/reply-context";

const DRAFT_BASE = (process.argv.find((a) => a.startsWith("--draft=")) ?? "").slice(8);
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PREFIX = "r5sc-";
const own = { msg: [] as string[], sip: [] as string[], aix: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Scene = { rows: Row[]; sip: Array<{ img: string; name: string; room: string }>; aix: Array<{ sec: number; type: string; cp: string | null; names: string[]; sts: string[]; est: boolean; text: string }>; expect: string };

const OURS: Row[] = [
  { s: "staff", t: "[画像]", sec: 0, img: "ours", aix: true },
  { s: "staff", t: "🌟エスリード難波ザ・ブライト 1307号室\n\n新着でYUMAさんにかなりオススメ出来るお部屋となります！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！", sec: 1, aix: true },
  { s: "staff", t: "1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\nお手隙の際にご査収ください😌！！", sec: 2, aix: true },
];
function scene(name: string): Scene {
  if (name === "photo_ours") return { rows: [...OURS, { s: "customer", t: "ありがとうございます！\nこの部屋の中の写真ってもらえますか？", sec: 120 }], sip: [{ img: "ours", name: "エスリード難波ザ・ブライト", room: "1307" }], aix: [], expect: "AIX property_check_result/interior_photo（手元にある）" };
  if (name === "photo_brought") return {
    rows: [
      { s: "customer", t: "[画像] 【物件の画面（ポータル）】\nシャーメゾン ソレイユ 0202号室\n7.3万円\n1LDK", sec: 0 },
      { s: "customer", t: "ここってどうですか", sec: 5 },
      { s: "staff", t: "[画像]", sec: 30, img: "est-soleil", aix: true },
      { s: "staff", t: "YUMAさん\nお世話になっております！！\n\n確認させていただきました！！\nシャーメゾン ソレイユ 0202号室現在募集中となります！！\n初期費用御見積書同封させて頂きました！！\n\nお手隙の際にご査収ください！！", sec: 31, aix: true },
      { s: "customer", t: "この部屋の中って写真もらう事とかってできますか？", sec: 60 },
    ],
    sip: [],
    aix: [{ sec: 33, type: "property_check_result", cp: "available", names: ["シャーメゾン ソレイユ 0202号室"], sts: ["available"], est: true, text: "確認させていただきました！！" }],
    expect: "返信（撮影の約束 room_photo_shoot）",
  };
  if (name === "guarantor") return {
    rows: [
      { s: "staff", t: "[画像]", sec: 0, img: "riemon", aix: true },
      { s: "staff", t: "【Riemon蛍池 204号室】\n\n初期費用さらに\n🌟56,000円割引させて頂き\n初期費用：155,900円", sec: 1, aix: true },
      { s: "customer", t: "ありがとうございます😊\nこちらで審査お願いできますか？", sec: 60 },
      { s: "staff", t: "かしこまりました！！\nRiemon蛍池204号室、お申込み手続きを進めさせて頂きます😊！！", sec: 90 },
      { s: "staff", t: "Riemon蛍池管理会社より、3親等以内で定期的な収入がある方での連帯保証人様の設定は可能でしょうかとのご連絡がございました！！\n\n連帯保証人様の設定は可能でしょうか！！", sec: 150 },
      { s: "customer", t: "連帯保証人には連絡行きますか？\nまた必要な書類等はありますか？", sec: 200 },
    ],
    sip: [{ img: "riemon", name: "Riemon蛍池", room: "204" }], aix: [], expect: "下書き: 電話の可能性・契約時に実印・印鑑証明（「連絡はございません」「本人確認書類のみ」が無い）",
  };
  if (name === "viewing_wish") return { rows: [...OURS, { s: "customer", t: "こちら内覧希望です", sec: 3600 }], sip: [{ img: "ours", name: "エスリード難波ザ・ブライト", room: "1307" }], aix: [], expect: "返信（内覧できるかの確認の約束 viewing_check）" };
  return { rows: [...OURS, { s: "customer", t: "こちら10/12の14時から内覧希望です", sec: 3600 }], sip: [{ img: "ours", name: "エスリード難波ザ・ブライト", room: "1307" }], aix: [], expect: "AIX viewing_invite（日時の指定は直接）" };
}

let h: LlmTestHarness | null = null;
async function cleanup() {
  if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
  if (own.sip.length) await sb.from("sent_image_properties").delete().in("image_url", own.sip);
  if (own.aix.length) await sb.from("aix_usage_logs").delete().in("id", own.aix);
  if (own.msg.length + own.sip.length + own.aix.length) console.log(`片付け: messages ${own.msg.length}・sent_image_properties ${own.sip.length}・aix_usage_logs ${own.aix.length}`);
  own.msg = []; own.sip = []; own.aix = [];
}

async function main() {
  const reps = Math.max(1, Number(ARGS[0] ?? 1));
  const which = (ARGS[1] ?? "photo_ours,photo_brought,guarantor,viewing_wish,viewing_dated").split(",");
  h = await setupLlmTest("yuma-r5-scenes");
  h.assertYuma(YUMA);
  if (DRAFT_BASE) await requireTestServer(DRAFT_BASE, "yuma-r5-scenes");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  for (const name of which) {
    const sc = scene(name);
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) {
      await h.waitUntilYumaQuiet(own.msg);
      const last = Math.max(...sc.rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000; // 最後の通を今＋2分に
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      const url = (x: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${x}.jpg`;
      const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
      if (sc.sip.length) {
        const r = await sb.from("sent_image_properties").insert(sc.sip.map((x) => ({ image_url: url(x.img), conversation_id: YUMA, property_name: x.name, room_no: x.room, source: "test", created_at: at(0) })));
        if (r.error) throw new Error(r.error.message);
        own.sip.push(...sc.sip.map((x) => url(x.img)));
      }
      if (sc.aix.length) {
        const ax = await sb.from("aix_usage_logs").insert(sc.aix.map((a) => ({ conversation_id: YUMA, aix_type: a.type, check_pattern: a.cp, property_names: a.names, prop_statuses: a.sts, estimate_sent: a.est, generated_text: a.text, created_at: at(a.sec), sent_at: at(a.sec) }))).select("id");
        if (ax.error) throw new Error(ax.error.message);
        own.aix.push(...(ax.data ?? []).map((x) => x.id as string));
      }
      const meta = await runInDeepseekScope(async () => {
        setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
        return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full" });
      }) as unknown as Record<string, unknown> | null;
      const src = (meta?.decision_source as string | undefined) ?? (meta?.decision_source_no_aix as string | undefined) ?? "-";
      console.log(`\n[${name} ${k + 1}] 期待: ${sc.expect}\n   action=${meta?.action ?? "-"}${meta?.check_pattern ? `/${meta.check_pattern}` : ""} reply_mode=${meta?.reply_mode ?? "-"} src=${src}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 300)}\n   話題: ${JSON.stringify(meta?.key_topics ?? null)}`);
      if (DRAFT_BASE && meta) {
        const lastStaff = sc.rows.map((r) => r.s).lastIndexOf("staff");
        const cust = sc.rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
        const body = { message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
          recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
          brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
          shadowNoWrite: true };
        const res = await fetch(`${DRAFT_BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
        const ct = res.headers.get("content-type") ?? "";
        const draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）` : parseStream(await res.text());
        console.log(`   下書き: ${draft.replace(/\n/g, " ／ ")}`);
      }
      await cleanup();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
