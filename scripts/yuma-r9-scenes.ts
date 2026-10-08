// scripts/yuma-r9-scenes.ts — 9巡目（10/08）: 学習ルールの総点検（rules-review-r9）の段1／段2を、DB を変えずに重ねて（rules-overlay.ts）
//   YUMA のブレイン＋下書き＋最終チェックで前後に並べる（off＝今の DB／on＝段1／stage2＝段1＋段2）。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・未来の時刻・線（floor）で YUMA の過去を読まない・自分の行だけ id で消す・同時1本）。
//   場面: 8巡目の資料の質問 12（yuma-r8-scenes と同じ物件・本番の売上サポの資料を名前で引く）＋内覧（今見られる／退去予定 日付あり・なし／初めての日時）
//         ＋費用（もっと安く: 見積前／見積後）＋物件オススメ・新着への反応＋お礼・検討中。
//   ブレインは版ごとに走らせる（ルールの重ねで【絶対ルール】【線引き】行動の候補のルールが変わるため）。下書きは testFlags.rules_r9＝版。
//   最終チェックの指摘はトレーラー <<<FINAL_CHECK:..>>> から読む（codes・RULE_VIOLATION の数）。
// 実行: TEST_CLOCK_JST_HOUR=14 REPLAY_FLOOR_FILE=<floor> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r9-scenes.ts --floor=<floor> [回数=1] [場面,..] [--versions=off,on,stage2] [--out=]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { MSG_SEP } from "../app/lib/reply-context";
import { buildR9Overlay, runWithRulesOverlay, type RulesR9Mode } from "../app/lib/rules-overlay";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const VERSIONS = arg("versions", "off,on,stage2").split(",") as RulesR9Mode[];
const OUT = arg("out", "scripts/.replay-out/r9-scenes.jsonl");
const FLOOR_FILE = arg("floor");
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PREFIX = "r9sc-";
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
const EST_SENT = (p: Prop): Row => ({ s: "staff", t: `YUMAさん\n確認させていただきました！！\n${p.name} ${p.room}号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きますので、お手隙の際にご査収ください😊！！`, sec: 1800, aix: true });
const SCENES: Record<string, { prop: Prop | null; rows: Row[]; expect: string; group: string }> = {
  // ── 資料の質問（8巡目）──
  guarantor: { group: "資料", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ここは保証会社どこになりますか？", sec: 3600 }], expect: "返信で エポスカード（資料のまま）" },
  person: { group: "資料", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "これ保証人なしで行ける感じですか？！", sec: 3600 }], expect: "返信で 保証人不要・緊急連絡先で審査" },
  mgmt: { group: "資料", prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "なるほどです🤔\n\nちなみにこの物件の管理会社ってどちらですか？？", sec: 3600 }], expect: "返信で 株式会社エンリッチ" },
  keymoney: { group: "資料", prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "礼金はかかりますか？", sec: 3600 }], expect: "返信で 礼金1ヶ月（見積書の約束は頼まれていない）" },
  parking: { group: "資料", prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "こっちで前向きに考えたいかもです！\nこの物件は駐車場あります？", sec: 3600 }], expect: "返信で 敷地内 空き1台 11,000円 軽のみ" },
  parking_none: { group: "資料", prop: SHICHIDO, rows: [...rec(SHICHIDO), { s: "customer", t: "ここ駐車場ありますか？？", sec: 3600 }], expect: "返信で 駐車場無し（駐車場付きを探す約束はしない）" },
  vacating_q: { group: "資料", prop: ODESSA, rows: [...rec(ODESSA), { s: "customer", t: "ここはいつ退去予定ですか？", sec: 3600 }], expect: "返信で 10/31 退去予定（資料のまま）" },
  car: { group: "資料", prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "内覧の日、車で行かせて頂いてもよろしかったですかね？😓", sec: 3600 }], expect: "お近くのパーキングにお停めください" },
  freerent_yes: { group: "資料", prop: AVANTIO, rows: [...rec(AVANTIO, "・フリーレント1ヶ月（家賃1ヶ月分免除）"), { s: "customer", t: "こちらもフリーレントでしょうか？", sec: 3600 }], expect: "返信でスタッフの送付のとおり（フリーレント1ヶ月）" },
  freerent_none: { group: "資料", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ここはフリーレントついてますか？", sec: 3600 }], expect: "付くと言わない（確認の約束）" },
  shamaison: { group: "資料", prop: null, rows: [
    { s: "staff", t: "🌟シャーメゾンジオ白鷺 303\n\n1件新着でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・家賃123,000円・管理費12,000円（合計135,000円）\n・間取り：2LDK\n・ペット飼育可能", sec: 0, aix: true },
    { s: "customer", t: "シャーメゾンなんですね。割引とかってできますか？", sec: 3600 }], expect: "割引の可否は断言せず御見積書（AD が出ない物件が多い）" },
  // ── 内覧 ──
  viewing_now: { group: "内覧", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "こちら内覧希望です", sec: 3600 }], expect: "AIX【内覧調整】（今見られる部屋＝内覧誘導）" },
  vacating: { group: "内覧", prop: ODESSA, rows: [...rec(ODESSA, "10月31日退去予定のお部屋となります！！"), { s: "customer", t: "こちら内覧希望です", sec: 3600 }], expect: "返信「10月31日退去予定のため、11月1日以降にご内覧可能です！！」" },
  vacating_nodate: { group: "内覧", prop: null, rows: [
    { s: "staff", t: "🌟エスリード難波ザ・ブライト 1307号室\n\n新着でYUMAさんにかなりオススメ出来るお部屋となります！！\n退去予定のお部屋となります！！\n家賃管理費込78,000円の1K、敷金礼金なしで初期費用をかなり抑えてご入居頂けます！！", sec: 1, aix: true },
    { s: "customer", t: "こちら内覧希望です", sec: 3600 }], expect: "返信（退去予定のお部屋なので内覧開始日の確認の約束）" },
  dated_first: { group: "内覧", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "こちら10/12の14時から内覧希望です", sec: 3600 }], expect: "AIX【内覧調整】（初めての日時の指定も内覧調整）" },
  // ── 費用 ──
  cheaper_before: { group: "費用", prop: AVANTIO, rows: [...rec(AVANTIO), { s: "customer", t: "ここもう少し安くなったりしますか？", sec: 3600 }], expect: "最大限割引した初期費用の御見積書の約束（2段 estimate）か AIX【見積書送る】" },
  cheaper_after: { group: "費用", prop: AVANTIO, rows: [...rec(AVANTIO), EST_SENT(AVANTIO), { s: "customer", t: "もう少し安くなりませんか？", sec: 3600 }], expect: "交渉は確認の約束（結果は AIX）・金額を作らない" },
  // ── 物件オススメ・新着への反応 ──
  rec_like: { group: "オススメ", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ここめっちゃいいですね！", sec: 3600 }], expect: "刺さった→内覧の誘い（AIX 内覧調整 or 返信で内覧の誘い）" },
  rec_more: { group: "オススメ", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "他にも同じくらいの家賃のところありますか？", sec: 3600 }], expect: "ピックアップの約束（AIX 物件オススメ／物件送付）" },
  // ── お礼・検討中 ──
  thanks: { group: "お礼・検討", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ありがとうございます！", sec: 3600 }], expect: "短いお礼の返事（催促・作り事なし）" },
  considering: { group: "お礼・検討", prop: ESLEAD, rows: [...rec(ESLEAD), { s: "customer", t: "ちょっと家族と相談して考えます！", sec: 3600 }], expect: "検討中の返事（希少性・期限の作り事なし）" },
};

function parseStream(raw: string): { body: string; fc: Record<string, unknown> | null } {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  let fc: Record<string, unknown> | null = null;
  const m = body.match(/<<<FINAL_CHECK:([\s\S]*?)>>>(?=\n<<<|\s*$)/);
  if (m) { try { fc = JSON.parse(m[1]); } catch { /* */ } }
  return { body: body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim(), fc };
}
function fcSummary(fc: Record<string, unknown> | null) {
  const issues = (fc?.issues as Array<{ code?: string; severity?: string; evidence?: string; message?: string }> | undefined) ?? [];
  return {
    codes: issues.map((i) => `${i.code}:${i.severity}`),
    rv: issues.filter((i) => i.code === "RULE_VIOLATION").map((i) => `${i.severity}｜${String(i.message ?? "").slice(0, 80)}｜${String(i.evidence ?? "").slice(0, 60)}`),
    revised: Number(fc?.revision_count ?? 0), regen: Number(fc?.regen_count ?? 0), passed: fc?.passed ?? null,
    // 1回目の指摘（直し・再生成の前）。RULE_VIOLATION の誤発火はここで数える
    first: ((fc?.first_pass_issues ?? fc?.pre_revision_issues) as string[] | undefined) ?? [],
  };
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
  h = await setupLlmTest("yuma-r9-scenes");
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
      const out: Record<string, unknown> = { scene: name, group: sc.group, ver, rep: k + 1, expect: sc.expect };
      try {
        const ins = await sb.from("messages").insert(sc.rows.map((r, i) => ({ conversation_id: YUMA, sender: r.s, text: r.t, is_aix_generated: !!r.aix, created_at: at(r.sec), line_message_id: `${PREFIX}${runId}-${i}`, image_url: r.img ? url(r.img) : null }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own.msg.push(...(ins.data ?? []).map((x) => x.id as string));
        if (sc.prop && sc.rows.some((r) => r.img)) {
          const r = await sb.from("sent_image_properties").insert([{ image_url: url("p1"), conversation_id: YUMA, property_name: sc.prop.name, room_no: sc.prop.room, source: "test", created_at: at(0) }]);
          if (r.error) throw new Error(r.error.message);
          own.sip.push(url("p1"));
        }
        writeFloor(new Date(t0 - 5_000).toISOString());
        await new Promise((r) => setTimeout(r, 1300));
        h.assertYuma(YUMA, "brain");
        const ov = buildR9Overlay(ver);
        const meta = await runWithRulesOverlay(ov, () => runInDeepseekScope(async () => {
          setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
          return analyzeConversation(YUMA, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        })) as unknown as Record<string, unknown> | null;
        const src = (meta?.decision_source as string | undefined) ?? (meta?.decision_source_no_aix as string | undefined) ?? "-";
        Object.assign(out, { action: meta?.action ?? null, cp: meta?.check_pattern ?? null, reply_mode: meta?.reply_mode ?? null, src, dir: String(meta?.reply_direction ?? "").slice(0, 300) });
        console.log(`\n[${name} ${ver} ${k + 1}] 期待: ${sc.expect}\n   action=${meta?.action ?? "-"} reply_mode=${meta?.reply_mode ?? "-"} src=${src}\n   方向: ${String(meta?.reply_direction ?? "").replace(/\n/g, " ").slice(0, 220)}`);
        if (meta) {
          const lastStaff = sc.rows.map((r) => r.s).lastIndexOf("staff");
          const cust = sc.rows.slice(lastStaff + 1).filter((r) => r.s === "customer").map((r) => r.t);
          const body = {
            message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: sc.rows.map((r) => ({ sender: r.s, text: r.t, createdAt: at(r.sec), isAix: !!r.aix })),
            brainMetaDirect: { meta: { ...meta, reply_mode: meta.reply_mode === "aix" ? "reply" : meta.reply_mode }, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on", testFlags: { rules_r9: ver },
          };
          const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) out.draft = `（下書きなし: ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160)}）`;
          else { const p = parseStream(await res.text()); out.draft = p.body; out.fc = fcSummary(p.fc); }
          console.log(`   下書き: ${String(out.draft).replace(/\n/g, " ／ ")}`);
          if (out.fc) console.log(`   最終チェック: ${JSON.stringify(out.fc).slice(0, 300)}`);
        }
      } catch (e) { out.error = e instanceof Error ? e.message : String(e); console.error(`   失敗: ${out.error}`); }
      finally {
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
