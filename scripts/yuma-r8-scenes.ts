// scripts/yuma-r8-scenes.ts — 8巡目（10/08 竹内さんの決定）: 資料の契約条件を返信で答える・退去予定日が分かる内覧・車の内覧・シャーメゾン等の割引 を
//   YUMA のブレイン＋下書き（generate-reply の POST を同じプロセスで呼ぶ）で前後に並べる。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す）。
//   前＝8巡目の直しを全部 off／後＝既定。物件と資料は本番の売上サポの行（property_pickups・読むだけ）を名前で引く（お客様の情報は入れない）。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r8-scenes.ts --floor=<floor> [回数=1] [場面,..] [--versions=base,new] [--out=]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "base,new").split(",");
const OUT = arg("out", "scripts/.replay-out/r8-scenes.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "r8sc-";
/** 前＝8巡目の直しを全部止める */
const BASE_ENV: Record<string, string> = {
  CONTRACT_TERMS_ANSWER: "off", CONTRACT_TERMS_REPLY: "off", MATERIAL_ASSERTION_EXEMPT: "off", VIEWING_VACATING_DATE_ANSWER: "off",
  COMPANY_FACT_CAR_VISIT: "off", COMPANY_FACT_NO_AD_DISCOUNT: "off", PHRASE_CATEGORIES_DEFAULT: "off",
  STAFF_FREE_RENT: "off", FREE_RENT_EXIT: "off", MATERIAL_FACTS_TO_CHECK: "off",
};
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own = { msg: [] as string[], sip: [] as string[] };
type Row = { s: "staff" | "customer"; t: string; sec: number; img?: string; aix?: boolean };
type Prop = { name: string; room: string };

function rec(p: Prop, extra = ""): Row[] {
  return [
    { s: "staff", t: "[画像]", sec: 0, img: "p1", aix: true },
    { s: "staff", t: `🌟${p.name} ${p.room}号室\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！${extra ? `\n${extra}` : ""}\n\nお手隙の際にご査収ください😌！！`, sec: 1, aix: true },
  ];
}
const ESLEAD: Prop = { name: "エスリード難波レジデンス", room: "1406" };
const AVANTIO: Prop = { name: "Avantio Anhelo(アバンティオアネーロ)", room: "202" };
const SHICHIDO: Prop = { name: "七道駅前マンション", room: "00403" };
const ODESSA: Prop = { name: "ODESSA南船場", room: "0703" };
const SCENES: Record<string, { prop: Prop | null; rows: Row[]; expect: string }> = {
  guarantor: { prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ここは保証会社どこになりますか？", sec: 3600 }], expect: "後: 返信で エポスカード（資料のまま）" },
  person: { prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "これ保証人なしで行ける感じですか？！", sec: 3600 }], expect: "後: 返信で 保証人不要・緊急連絡先で審査" },
  mgmt: { prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "なるほどです🤔\n\nちなみにこの物件の管理会社ってどちらですか？？", sec: 3600 }], expect: "後: 返信で 株式会社エンリッチ" },
  keymoney: { prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "礼金はかかりますか？", sec: 3600 }], expect: "後: 返信で 礼金1ヶ月" },
  parking: { prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "こっちで前向きに考えたいかもです！\nこの物件は駐車場あります？", sec: 3600 }], expect: "後: 返信で 敷地内 空き1台 11,000円 軽のみ" },
  parking_none: { prop: SHICHIDO, rows: [...rec(SHICHIDO), { s: "customer", t: "ここ駐車場ありますか？？", sec: 3600 }], expect: "後: 返信で 駐車場無し・近隣の月極" },
  vacating: { prop: ODESSA, rows: [...rec(ODESSA, "10月31日退去予定のお部屋となります！！"), { s: "customer", t: "こちら内覧希望です", sec: 3600 }], expect: "後: 返信「10月31日退去予定のため、11月1日以降にご内覧可能です！！」／前: 内覧開始日の確認の約束" },
  vacating_q: { prop: ODESSA, rows: [...rec(ODESSA), { s: "customer", t: "ここはいつ退去予定ですか？", sec: 3600 }], expect: "後: 返信で 10/31 退去予定（資料のまま）" },
  car: { prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "内覧の日、車で行かせて頂いてもよろしかったですかね？😓", sec: 3600 }], expect: "後: お近くのパーキングにお停めください" },
  freerent_yes: { prop: AVANTIO, rows: [...rec(AVANTIO, "・フリーレント1ヶ月（家賃1ヶ月分免除）"), { s: "customer", t: "こちらもフリーレントでしょうか？", sec: 3600 }], expect: "後: 返信でスタッフの送付のとおり（フリーレント1ヶ月）" },
  freerent_none: { prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ここはフリーレントついてますか？", sec: 3600 }], expect: "後: 付くと言わない（確認の約束）" },
  shamaison: { prop: null, rows: [
    { s: "staff", t: "🌟シャーメゾンジオ白鷺 303\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・家賃123,000円・管理費12,000円（合計135,000円）\n・間取り：2LDK\n・ペット飼育可能", sec: 0, aix: true },
    { s: "customer", t: "シャーメゾンなんですね。割引とかってできますか？", sec: 3600 }], expect: "後: 割引の可否は断言せず御見積書（AD が出ない物件が多い）" },
};

function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status: "proposing", messageIdPrefix: PREFIX } : {}));
}
let h: LlmTestHarness | null = null;
async function cleanup() {
  if (own.msg.length) await sb.from("messages").delete().in("id", own.msg);
  if (own.sip.length) await sb.from("sent_image_properties").delete().in("image_url", own.sip);
  own.msg = []; own.sip = [];
}

async function main() {
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする（YUMA の過去の記録を読まないため）");
  const reps = Math.max(1, Number(ARGS[0] ?? 1));
  const which = (ARGS[1] ?? Object.keys(SCENES).join(",")).split(",");
  h = await setupLlmTest("yuma-r8-scenes");
  h.assertYuma(YUMA);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const name of which) {
    const sc = SCENES[name];
    if (!sc) { console.warn(`場面なし: ${name}`); continue; }
    h.assertSceneSafe(sc.rows.map((r) => r.t), name);
    for (let k = 0; k < reps; k++) for (const ver of VERSIONS) {
      await h.waitUntilYumaQuiet(own.msg);
      const last = Math.max(...sc.rows.map((r) => r.sec));
      const t0 = Date.now() + 120_000 - last * 1000;
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      const runId = randomUUID().slice(0, 8);
      const url = (x: string) => `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/property-images/test/${PREFIX}${runId}-${x}.jpg`;
      const out: Record<string, unknown> = { scene: name, ver, rep: k + 1, expect: sc.expect };
      const prev = Object.fromEntries(Object.keys(BASE_ENV).map((key) => [key, process.env[key]]));
      try {
        const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
        if (sc.prop) {
          const r = await sb.from("sent_image_properties").insert([{ image_url: url("p1"), conversation_id: YUMA, property_name: sc.prop.name, room_no: sc.prop.room, source: "test", created_at: at(0) }]);
          if (r.error) throw new Error(r.error.message);
          own.sip.push(url("p1"));
        }
        writeFloor(new Date(t0 - 5_000).toISOString());
        await new Promise((r) => setTimeout(r, 1300));
        for (const [key, v] of Object.entries(BASE_ENV)) { if (ver === "base") process.env[key] = v; else delete process.env[key]; }
        h.assertYuma(YUMA, "brain");
        const meta = await runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        }) as unknown as Record<string, unknown> | null;
        const src = (meta?.decision_source as string | undefined) ?? (meta?.decision_source_no_aix as string | undefined) ?? "-";
        Object.assign(out, { action: meta?.action ?? null, reply_mode: meta?.reply_mode ?? null, src, dir: String(meta?.reply_direction ?? "").slice(0, 300) });
        console.log(`\n[${name} ${ver} ${k + 1}] 期待: ${sc.expect}\n   action=${meta?.action ?? "-"} reply_mode=${meta?.reply_mode ?? "-"} src=${src}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 220)}`);
        if (meta) {
          const lastStaff = sc.rows.map((r) => r.s).lastIndexOf("staff");
          const cust = sc.rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
          const body = {
            message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
            brainMetaDirect: { meta: { ...meta, reply_mode: meta.reply_mode === "aix" ? "reply" : meta.reply_mode }, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on",
          };
          const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
          const ct = res.headers.get("content-type") ?? "";
          const draft = ct.includes("application/json") ? `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）` : parseStream(await res.text());
          out.draft = draft;
          console.log(`   下書き: ${draft.replace(/\n/g, " ／ ")}`);
        }
      } catch (e) { out.error = e instanceof Error ? e.message : String(e); console.error(`   失敗: ${out.error}`); }
      finally {
        for (const [key, v] of Object.entries(prev)) { if (v === undefined) delete process.env[key]; else process.env[key] = v; }
        writeFloor(null);
        await cleanup();
      }
      appendFileSync(OUT, JSON.stringify(out) + "\n");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { writeFloor(null); try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
