// YUMA で AIX テンプレートの2通目を複数パターン生成し、成約データ・直近の型と突き合わせる
//
// 2026-09-20 竹内「YUMA でテストして確認おねがい。設計知見と協力して実際の成約データや
//   直近の文のようになっているか確認」
//
// 基準は scripts/audit-second-message-style.ts の実測（AIX の2通目）:
//   長さ: 全体120字・4行 ／ 直近30日120字・4行 ／ **成約108字・3行**
//   要素（全体 / 直近30日 / 成約）:
//     名前呼びかけ 34.1/31.9/35.1 ／ 挨拶 11.9/11.2/8.8 ／ 物件名・号室 39.9/43.9/36.0
//     条件の復唱 38.3/36.5/30.7 ／ 箇条書き 21.7/21.6/20.2 ／ オススメの一言 16.9/15.4/13.2
//     内覧の誘導 7.2/8.2/6.1 ／ 申込の誘導 5.6/4.6/**8.8** ／ お気に召されましたら 10.2/9.3/9.6
//     気軽に言ってもらう締め 1.6/2.8/**0.0** ／ ご査収 17.2/16.6/14.0 ／ 何卒 2.7/2.5/**6.1**
//     全力サポート 0.7 ／ ごゆっくり 0.0 ／ 絵文字 57.5/63.0/51.8 ／ ！！ 61.5/64.2/**64.9**
//
// ⚠ 生成のみ。LINE へは送らない。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 実測の型（全体 / 直近30日 / 成約）*/
const ELEMENTS: Array<{ key: string; re: RegExp; all: number; recent: number; won: number }> = [
  { key: "名前呼びかけ（〇〇さん）", re: /さん/, all: 34.1, recent: 31.9, won: 35.1 },
  { key: "挨拶（お世話に／お待たせ）", re: /お世話になっております|お待たせ(?:致|いた)?しました/, all: 11.9, recent: 11.2, won: 8.8 },
  { key: "物件名・号室・🌟", re: /[0-9０-９]{2,4}号室|🌟/, all: 39.9, recent: 43.9, won: 36.0 },
  { key: "条件の復唱（万・LDK・築・徒歩）", re: /[0-9０-９]{1,3}[\.．]?[0-9０-９]{0,2}万|[0-9０-９]{1,2}[LDKSldks]{1,4}|築[0-9０-９]{1,2}|徒歩[0-9０-９]{1,2}/, all: 38.3, recent: 36.5, won: 30.7 },
  { key: "箇条書き（・2行以上）", re: /^[・･][^\n]*\n[\s\S]*^[・･]/m, all: 21.7, recent: 21.6, won: 20.2 },
  { key: "オススメの一言（特に／かなり）", re: /特に[^\n。！!]{0,20}(?:オススメ|おすすめ)|かなり[^\n。！!]{0,12}(?:オススメ|おすすめ)/, all: 16.9, recent: 15.4, won: 13.2 },
  { key: "内覧の誘導", re: /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧(?:頂|いただ)け/, all: 7.2, recent: 8.2, won: 6.1 },
  { key: "申込の誘導", re: /お?申(?:し)?込[^\n。！!]{0,14}(?:押さえ|抑え|完了|進め)/, all: 5.6, recent: 4.6, won: 8.8 },
  { key: "お気に召されましたら", re: /お気に召され/, all: 10.2, recent: 9.3, won: 9.6 },
  { key: "気軽に言ってもらう締め", re: /お気軽|お申し付け|いつでも(?:ご連絡|お知らせ)/, all: 1.6, recent: 2.8, won: 0.0 },
  { key: "ご査収", re: /ご査収/, all: 17.2, recent: 16.6, won: 14.0 },
  { key: "何卒よろしく", re: /何卒(?:よろしく|宜しく)/, all: 2.7, recent: 2.5, won: 6.1 },
  { key: "全力でサポート", re: /全力でサポート/, all: 0.7, recent: 0.7, won: 0.9 },
  { key: "ごゆっくりご検討", re: /ごゆっくりご(?:検討|確認|相談)/, all: 0.0, recent: 0.0, won: 0.0 },
  { key: "絵文字（😊😌🙇🌟）", re: /😊|😌|🙇|🌟/, all: 57.5, recent: 63.0, won: 51.8 },
  { key: "！！（二重）", re: /！！/, all: 61.5, recent: 64.2, won: 64.9 },
];

/** 場面ごとの1通目（実送信の形をそのまま） */
const SCENES: Array<{ id: string; action: string; category: string; first: string }> = [
  {
    id: "① 物件ピックアップした の後",
    action: "property_send", category: "物件ピックアップした【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\n難波周辺全域からYUMAさんご希望の家賃10万円以内・1LDK・駅徒歩10分以内のお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！",
  },
  {
    id: "② 物件オススメ の後",
    action: "property_recommendation", category: "物件オススメ【AIX】",
    first: "🌟スプランディッド大阪EAST 204号室\n\n（オススメポイント）\n・家賃106,000円・管理費12,500円（合計118,500円）\n・間取り：2LDK（リビング11.5帖、洋室3.8帖）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・大阪環状線「玉造」徒歩5分",
  },
  {
    id: "③ 見積書送る の後",
    action: "estimate_sheet", category: "見積書送る【AIX】",
    first: "【スプランディッド大阪EAST 204号室】\n\n初期費用さらに\n🌟22,000円割引させて頂き\n初期費用：139,000円\n\nイエヤスなら一般的な不動産業者より90,310円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
  },
  {
    id: "④ 物件確認した の後",
    action: "property_check_result", category: "物件確認した【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\nスプランディッド大阪EAST 204号室、現在募集中で即日ご入居可能となります😊！！\n\n保証会社は日本セーフティーという比較的審査通過しやすい保証会社となっております！！",
  },
];

async function main() {
  const rounds = Number(process.env.ROUNDS ?? 2);
  const { data: conv } = await sb.from("conversations").select("customer_name, status").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const recentMessages = ((ms ?? []) as unknown as Array<Record<string, unknown>>).slice(-15).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  const results: Array<{ scene: string; text: string; ms: number }> = [];
  console.log(`=== YUMA で AIX テンプレートの2通目を ${SCENES.length}場面 × ${rounds}回 生成（送信しない）===\n`);

  for (const s of SCENES) {
    for (let r = 0; r < rounds; r++) {
      const t0 = Date.now();
      let text = "";
      try {
        const res = await fetch(`${BASE}/api/aix-template-generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: s.action, actionCategory: s.category, conversationId: YUMA,
            customerName: String(c.customer_name ?? "YUMA"), conversationState: String(c.status ?? "proposing"),
            recentMessages, customerConditions: "難波周辺・家賃10万円以内・1LDK・駅徒歩10分以内",
            noEmoji: false, staffMessagedToday: true, sentMessage: s.first,
          }),
        });
        const raw = await res.text();
        try { const j = JSON.parse(raw) as Record<string, unknown>; text = String(j.text ?? j.error ?? raw.slice(0, 200)); }
        catch { text = raw.slice(0, 200); }
      } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
      const ms2 = Date.now() - t0;
      results.push({ scene: s.id, text, ms: ms2 });
      const ln = text.split("\n").filter((x) => x.trim()).length;
      console.log(`${"─".repeat(72)}`);
      console.log(`【${s.id}】${r + 1}回目 (${(ms2 / 1000).toFixed(1)}s ・ ${text.length}字 ・ ${ln}行)\n`);
      console.log(text || "（本文なし）");
      console.log("");
    }
  }

  // ── 成約データ・直近の型と突き合わせ ──
  const ok = results.filter((r) => r.text.length > 10 && !r.text.startsWith("【エラー】"));
  console.log(`${"─".repeat(72)}`);
  console.log(`=== 実送信の型と突き合わせ（生成 ${ok.length}通）===\n`);
  const lens = ok.map((r) => r.text.length).sort((a, b) => a - b);
  const lns = ok.map((r) => r.text.split("\n").filter((x) => x.trim()).length).sort((a, b) => a - b);
  console.log(`   長さ: 生成 中央値 ${lens[Math.floor(lens.length / 2)]}字・${lns[Math.floor(lns.length / 2)]}行`);
  console.log(`         実送信 全体 120字・4行 ／ 直近30日 120字・4行 ／ **成約 108字・3行**`);
  const over = ok.filter((r) => r.text.length > 180).length;
  console.log(`   180字超え: ${over}通 / ${ok.length}通\n`);
  console.log(`   ${"要素".padEnd(32)} 生成    全体   直近30日  成約   判定`);
  for (const e of ELEMENTS) {
    const n = ok.filter((r) => e.re.test(r.text)).length;
    const gen = ok.length ? (n / ok.length) * 100 : 0;
    // 成約データから大きく外れていないか（±25ポイントを目安に印を付ける）
    const d = gen - e.won;
    const mark = Math.abs(d) >= 25 ? (d > 0 ? "  ⚠ 多い" : "  ⚠ 少ない") : "";
    console.log(`   ${e.key.padEnd(32)} ${(`${gen.toFixed(0)}%`).padStart(5)}  ${(`${e.all}%`).padStart(6)}  ${(`${e.recent}%`).padStart(6)}  ${(`${e.won}%`).padStart(6)}${mark}`);
  }
  console.log(`\n   ※ 生成は ${ok.length}通なので率はざっくり（0/25/50/75/100% しか取れない）。`);
  console.log(`     見るのは「実送信に無い形が出ていないか」「多すぎる形が無いか」。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
