import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runBrainAndNotify, type BrainGateSnapshot } from "@/app/lib/brain-core";

export const maxDuration = 300;

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// brain-core/BRAIN_SKIP_STATUSES・line-webhook/BG_ASYNC_SKIP_STATUSESと同一集合を維持すること
const SKIP_STATUSES = new Set(["applying", "application", "screening", "contract", "closed_won", "closed_lost", "lost", "approved"]);

// ── 脳-DBブリッジ: condition_change_type 検出後にHaikuで条件を抽出しDB更新 ──────────────
// brain が suggested_aix_meta に condition_change_type を書き込んだ後、
// generate-reply のプロンプト注入だけでなく property_customers の実際のフィールドも更新する。
// P4 / autoParseFormat が既にバナーエントリを追加済みの場合は重複追加しない。

// プロンプトキャッシュ用静的システムメッセージ（全 condition_change_type 共通のルール部分）。
// 動的な focus.prompt・targetMessage は userメッセージ側に置く（cache_control なし）。
const CONDITION_EXTRACT_SYSTEM = `【条件カテゴリ定義】
rent_max: 月々の家賃・賃料の上限（例：「8万円以内」「月10万まで」→ 80000, 100000）
rent_min: 家賃の下限・最低希望額（「7万以上」→ 70000）
initial_cost_limit: 初期費用（敷金・礼金・仲介手数料等の合計）の上限（「初期費用30万以内」→ 300000）
desired_area: 希望エリア・地域・最寄り駅名（「渋谷区」「新宿から近い」「池袋駅」等）
floor_plan: 間取り（「1LDK」「2DK以上」「ワンルーム」等。複数の可能性は最も条件の緩いものを採用）
walk_minutes: 最寄り駅からの徒歩分数の上限（「駅から10分以内」→ 10）
commute_station: 通勤・通学先の最寄り駅名（「渋谷まで電車で行きたい」→「渋谷駅」）
commute_minutes: 通勤先まで電車での所要時間の上限（「30分以内で通える場所」→ 30）
move_in_time: 入居希望時期・開始日（「来月から」「3月入居」「すぐ」「〇月〇日から」等の文字列）
building_age: 築年数の上限（「築20年以内」→ 20。「新築」→ 1）
preferences: こだわり条件・設備要望（オートロック、浴室乾燥機、角部屋、ペット可、宅配ボックス等）
ng_points: NG条件・除外条件（「1階は嫌」「ガスコンロのみNG」「バストイレ同室NG」等）
other_requests: 上記カテゴリに属さないその他要望（駐車場付き、即入居可、フリーレント等）

【金額の文脈判断ルール】
金額のみ（「〇万円以内」等）で何の費用か不明な場合:
・「家賃/賃料/月々」に関する文脈 → rent_max
・「初期費用/敷金/礼金」に関する文脈 → initial_cost_limit
・文脈不明: 〜19万円→rent_max、20万円以上→initial_cost_limit
金額はすべて円単位整数（「8万」→80000）。

【徒歩 vs 通勤の区別】
「最寄り駅まで徒歩○分」→ walk_minutes
「○○駅まで電車で○分」「○○まで○分で行きたい」→ commute_station + commute_minutes

【条件変更検出：正例（条件変更と判断する）】
- 「家賃を8万以内に下げてほしい」→ rent_max: 80000
- 「渋谷エリアで探してください」→ desired_area: "渋谷"
- 「2LDKに変更します」→ floor_plan: "2LDK"
- 「エアコン必須で条件に追加してください」→ preferences に "エアコン" を追加
- 「駅から5分以内でお願いします」→ walk_minutes: 5
- 「来月から入居できる物件を」→ move_in_time: "来月"
- 「駐車場付きも含めてほしい」→ other_requests に "駐車場付き" を追加
- 「予算を少し上げて12万まで」→ rent_max: 120000

【条件変更検出：負例（条件変更と判断しない → 抽出不要・JSONは{}を返す）】
- 「いつ空きますか」→ 入居可能日の問い合わせ（条件変更なし）
- 「この物件の詳細を教えてください」→ 特定物件への質問（条件変更なし）
- 「ありがとうございます」→ 感謝・相槌（条件変更なし）
- 「内見したいです」→ 内見依頼（条件変更なし）
- 「申込書を送ります」→ 申込手続き（条件変更なし）
- 「今の物件に駐車場はありますか」→ 現物件設備確認（条件変更なし）

【出力JSONスキーマ仕様】
- 型: {"desired_area":"文字列","floor_plan":"文字列","rent_max":円整数,"rent_min":円整数,"walk_minutes":分数整数,"commute_station":"文字列","commute_minutes":分数整数,"move_in_time":"文字列","building_age":年数整数,"initial_cost_limit":円整数,"preferences":"こだわり条件の文字列","ng_points":"NG条件の文字列","other_requests":"その他要望の文字列"}
- 不明・言及なし項目は省略（nullではなく省略すること）
- 推測禁止: 明示された条件のみ。推測や補完は含めない
- preferences・ng_points・other_requests は既存値に追記する形（上書き禁止）
- JSONのみで返してください（前後に余分なテキスト・コードブロック記号不要）`;

const BRAIN_CONDITION_FOCUS: Record<string, { fields: string[]; prompt: string; pattern: "add" | "change" }> = {
  area_change:      { fields: ["desired_area"], prompt: "エリア・地域・最寄り駅の変更", pattern: "change" },
  rent_change:      { fields: ["rent_min", "rent_max"], prompt: "家賃・予算の変更（万円単位に注意）", pattern: "change" },
  layout_change:    { fields: ["floor_plan"], prompt: "間取りの変更", pattern: "change" },
  equip_add:        { fields: ["preferences"], prompt: "設備・こだわり条件の追加", pattern: "add" },
  ng_add:           { fields: ["ng_points"], prompt: "NG条件・除外条件の追加", pattern: "add" },
  move_in_change:   { fields: ["move_in_time"], prompt: "入居時期・入居希望時期の変更", pattern: "change" },
  cost_change:      { fields: ["initial_cost_limit"], prompt: "初期費用上限の変更（万円単位に注意）", pattern: "change" },
  commute_change:   { fields: ["commute_station", "commute_minutes"], prompt: "通勤先駅・電車での通勤時間の変更（例: 難波まで30分以内）", pattern: "change" },
  condition_relax:  { fields: ["desired_area", "rent_max", "walk_minutes", "commute_minutes", "building_age"], prompt: "条件の緩和・選択肢の拡大", pattern: "change" },
  pickup_request:   { fields: ["desired_area", "floor_plan", "rent_max"], prompt: "物件ピックアップ依頼の条件確認", pattern: "change" },
  multi:            { fields: ["desired_area", "floor_plan", "rent_max", "rent_min", "walk_minutes", "commute_station", "commute_minutes", "move_in_time", "building_age", "preferences", "ng_points", "other_requests"], prompt: "複数条件の変更・追加", pattern: "change" },
};
const BRAIN_COND_LABELS: Record<string, string> = {
  desired_area: "エリア", floor_plan: "間取り", rent_max: "家賃上限", rent_min: "家賃下限",
  walk_minutes: "徒歩分数", commute_station: "通勤先駅", commute_minutes: "通勤時間",
  move_in_time: "入居時期", building_age: "築年数",
  initial_cost_limit: "初期費用上限", preferences: "こだわり", ng_points: "NG条件", other_requests: "その他",
};
const BRAIN_NUMERIC = new Set(["rent_min", "rent_max", "initial_cost_limit", "walk_minutes", "commute_minutes", "building_age"]);

async function applyBrainConditionChange(
  db: ReturnType<typeof getDb>,
  pcId: string,
  convId: string,
  targetMessage: string,
  conditionChangeType: string,
): Promise<void> {
  const focus = BRAIN_CONDITION_FOCUS[conditionChangeType];
  if (!focus) return;

  const { data: pc } = await db.from("property_customers")
    .select("additional_conditions, desired_area, floor_plan, rent_max, rent_min, walk_minutes, commute_station, commute_minutes, move_in_time, building_age, initial_cost_limit, preferences, ng_points, other_requests")
    .eq("id", pcId).maybeSingle();

  // プロンプトキャッシュ（2026-08）:
  // 静的ルール（CONDITION_EXTRACT_SYSTEM）を system メッセージに分離し cache_control を付与。
  // 動的な focus.prompt・targetMessage のみ user メッセージに残す。
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: [{ type: "text", text: CONDITION_EXTRACT_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: `お客さんのメッセージから「${focus.prompt}」に関する条件を抽出してください。\n\n【お客さんのメッセージ】\n${targetMessage.slice(0, 400)}` }],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return;

  const d = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const raw = (d.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "")
    .replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return;
  let extracted: Record<string, unknown>;
  try { extracted = JSON.parse(m[0]) as Record<string, unknown>; } catch { return; }

  // 家賃バリデーション（万円単位誤り自動修正）
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = extracted[f];
    if (typeof v === "number" && v > 0) {
      if (v <= 300) extracted[f] = v * 10000;
      else if (v > 500000 && f !== "initial_cost_limit") extracted[f] = v / 10;
    }
  }

  const updates: Record<string, unknown> = {};
  const changedFields: Record<string, unknown> = {};
  for (const f of focus.fields) {
    const v = extracted[f];
    if (v === null || v === undefined || v === "") continue;
    if (BRAIN_NUMERIC.has(f) && typeof v !== "number") continue;
    updates[f] = v;
    const existing = (pc as Record<string, unknown> | null)?.[f];
    if (existing !== v) changedFields[f] = v;
  }
  if (Object.keys(updates).length === 0) return;

  const conditionActuallyChanged = Object.keys(changedFields).length > 0;
  await db.from("property_customers")
    .update({ ...updates, updated_at: new Date().toISOString(), ...(conditionActuallyChanged ? { last_property_sent_at: null, rp_update_days: null } : {}) })
    .eq("id", pcId);

  // 条件が実際に変わった場合は会話を要対応にセット（スタッフが未読のまま解除していても再フラグ）
  if (conditionActuallyChanged) {
    await db.from("conversations").update({ is_flagged: true }).eq("id", convId);
  }
  console.log(`[bg-async] brain-condition-bridge: pcId=${pcId} convId=${convId} type=${conditionChangeType} fields=${Object.keys(updates).join(",")}`);

  // 既存pendingバナーエントリがない場合のみ追加（P4/autoParseFormat との重複防止）
  const hasPending = ((pc?.additional_conditions as string | null) ?? "")
    .split("\n").some(l => l.trim() && !l.startsWith("【"));
  if (!hasPending && Object.keys(changedFields).length > 0) {
    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const ts = `${String(jst.getMonth() + 1).padStart(2, "0")}/${String(jst.getDate()).padStart(2, "0")} ${String(jst.getHours()).padStart(2, "0")}:${String(jst.getMinutes()).padStart(2, "0")}`;
    const note = Object.entries(changedFields).map(([k, v]) => `${BRAIN_COND_LABELS[k] ?? k}: ${v}`).join("、");
    const pendingEntry = `[${ts}|auto] ${note}`;
    const { data: latest } = await db.from("property_customers")
      .select("additional_conditions").eq("id", pcId).maybeSingle();
    const prev = (latest?.additional_conditions as string | null) ?? "";
    await db.from("property_customers")
      .update({ additional_conditions: prev ? `${prev}\n${pendingEntry}` : pendingEntry })
      .eq("id", pcId);
  }
}

const STATUS_ALIAS: Record<string, string> = {
  first_reply:             "hearing",
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

function getBaseUrl(): string {
  // 優先順位: 手動設定 > 本番URL > デプロイURL > ローカル
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { conversation_id?: string; memo?: string; source?: "direct" | "ui" };
  const convId = body.conversation_id;
  const memo = body.memo || "";
  const source = body.source;
  if (!convId) return NextResponse.json({ ok: false }, { status: 400 });

  const db = getDb();

  // ── 同期プリチェック ──
  // スキップ理由をレスポンスの skipped フィールドで返し、UI側が「準備中...」を即座に解除できるようにする
  // （旧実装は全スキップがサイレント200で、UIが60秒待ちぼうけになるバグの原因だった）
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("status, property_customer_id, ai_draft, last_sender, customer_name, draft_fail_count")
    .eq("id", convId)
    .single();

  if (convErr || !conv) {
    console.error("[bg-async] conv fetch error:", convErr?.message ?? "not found", "convId:", convId);
    return NextResponse.json({ ok: true, skipped: "not_found" });
  }
  if (conv.last_sender !== "customer") return NextResponse.json({ ok: true, skipped: "not_customer_turn" });
  // "[AIX誘導中]" センチネルは初回バグで貼られた可能性があるため通過させて再生成を試みる
  if (conv.ai_draft && conv.ai_draft !== "[AIX誘導中]") return NextResponse.json({ ok: true, skipped: "already_has_draft" });
  if (SKIP_STATUSES.has(conv.status as string)) return NextResponse.json({ ok: true, skipped: "status" });

  let { data: msgs, error: msgsErr } = await db.from("messages")
    .select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", convId)
    .order("created_at", { ascending: false }).limit(20);

  if (msgsErr) {
    console.error("[bg-async] msgs fetch error:", msgsErr.message);
    return NextResponse.json({ ok: true, skipped: "msgs_fetch_error" });
  }

  type MsgRow = { sender: string; text: string | null; image_url: string | null; created_at?: string; is_aix_generated: boolean | null };
  let recentMsgs = ((msgs || []) as MsgRow[])
    .reverse()
    .map((m) => ({
      sender: m.sender,
      text: m.text || (m.image_url ? "[画像]" : ""),
      imageUrl: m.image_url ?? undefined,
      createdAt: m.created_at,
      isAix: m.is_aix_generated ?? false,
    }));

  // targetMessage は元のrecentMsgs（注入なし）から計算
  // ※旧3件上限 → 10件に拡張（物件5件+条件メッセージ等を切り落とさないため）
  const lastStaffIdx = recentMsgs.map((m, i) => m.sender === "staff" ? i : -1).filter((i) => i >= 0).at(-1);
  const msgsAfterStaff = lastStaffIdx !== undefined ? recentMsgs.slice(lastStaffIdx + 1) : recentMsgs;
  const unreplied = msgsAfterStaff
    .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-10);
  let targetMessage = unreplied.map((m) => m.text).join("\n");

  if (!targetMessage.trim()) {
    // 画像・動画のみで返信対象テキストなし → 生成不能。
    // draft_pending_at を残すとcronが永久リトライするためクリアして終了
    await db.from("conversations").update({ draft_pending_at: null }).eq("id", convId);
    return NextResponse.json({ ok: true, skipped: "no_text_message" });
  }

  // Atomic claim: 並列bg-asyncが同じ会話を重複生成するのを防ぐ
  // draft_attempted_atが5分以内に設定済みの場合はスキップ（別プロセスが生成中の可能性が高い）
  // 注: .or()を2回チェーンするとPostgRESTのURLに?or=...&or=...が生成され、
  // パーサー実装によっては最後のorパラメータのみが有効になるリスクがある。
  // 単一の.or()に全条件をANDを分配した形で展開することで確実なANDセマンティクスを保証する。
  // 条件: (ai_draft IS NULL OR ai_draft='[AIX誘導中]') AND (draft_attempted_at IS NULL OR draft_attempted_at < 5min前)
  // ↓ AND分配展開 ↓
  // (ai_draft IS NULL AND draft_attempted_at IS NULL)
  // OR (ai_draft IS NULL AND draft_attempted_at < 5min前)
  // OR (ai_draft='[AIX誘導中]' AND draft_attempted_at IS NULL)
  // OR (ai_draft='[AIX誘導中]' AND draft_attempted_at < 5min前)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: claimed } = await db.from("conversations")
    .update({ draft_attempted_at: new Date().toISOString() })
    .eq("id", convId)
    .or(
      `and(ai_draft.is.null,draft_attempted_at.is.null),` +
      `and(ai_draft.is.null,draft_attempted_at.lt.${fiveMinAgo}),` +
      `and(ai_draft.eq."[AIX誘導中]",draft_attempted_at.is.null),` +
      `and(ai_draft.eq."[AIX誘導中]",draft_attempted_at.lt.${fiveMinAgo})`
    )
    .select("id");
  if (!claimed?.length) {
    console.log("[bg-async] 同時生成をスキップ（atomic claim失敗）, convId:", convId);
    return NextResponse.json({ ok: true, skipped: "in_progress" });
  }

  // ── ここから重い処理は after() でバックグラウンド実行（Realtimeで通知） ──
  after(async () => {
    try {
      // ── バーストメッセージ対策（LINEからの直接トリガー時のみ）────────────────
      // LINEバースト送信（複数メッセージの短時間連続送信）では、2通目以降が
      // atomic claim でブロックされて skip される。8s sleep の間にバーストメッセージが
      // 全て DB に保存されるため、brain に全メッセージを渡せる（脳の入力精度向上）。
      // claim は sleep 前の同期処理で完了済みのため、atomic claim 整合性は変わらない。
      if (source === "direct") {
        await new Promise<void>((resolve) => setTimeout(resolve, 8000));
        try {
          const { data: burstMsgsData } = await db.from("messages")
            .select("sender, text, image_url, created_at, is_aix_generated")
            .eq("conversation_id", convId)
            .order("created_at", { ascending: false })
            .limit(20);
          if (burstMsgsData && burstMsgsData.length > 0) {
            type BurstMsgRow = { sender: string; text: string | null; image_url: string | null; created_at?: string; is_aix_generated: boolean | null };
            const burstList = (burstMsgsData as BurstMsgRow[]).reverse().map((m) => ({
              sender: m.sender,
              text: m.text || (m.image_url ? "[画像]" : ""),
              imageUrl: m.image_url ?? undefined,
              createdAt: m.created_at,
              isAix: m.is_aix_generated ?? false,
            }));
            const burstStaffIdx = burstList.map((m, i) => m.sender === "staff" ? i : -1).filter((i) => i >= 0).at(-1);
            const burstAfterStaff = burstStaffIdx !== undefined ? burstList.slice(burstStaffIdx + 1) : burstList;
            const burstUnreplied = burstAfterStaff
              .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
              .slice(-10);
            const burstTarget = burstUnreplied.map((m) => m.text).join("\n");
            if (burstTarget.trim()) {
              if (burstTarget !== targetMessage) {
                console.log("[bg-async] バースト再フェッチ: 追加メッセージ検出 convId:", convId,
                  "元:", JSON.stringify(targetMessage.slice(0, 80)),
                  "最新:", JSON.stringify(burstTarget.slice(0, 80)));
              }
              recentMsgs = burstList;
              targetMessage = burstTarget;
            }
          }
        } catch (burstErr) {
          console.warn("[bg-async] バースト再フェッチエラー（初期targetMessageで続行）:", burstErr);
        }
      }

      // ── brain直列実行（入り口・2026-08直列アーキテクチャ）─────────────────
      // 旧構成: webhookが brain を fire-and-forget 起動 + bg-async が draft 生成
      //   → 完了順序が保証されず suggested_aix_meta の書き込み競合が構造的に存在した。
      // 新構成: ここで brain を await してから draft 生成へ進む（brain完了→draft生成の直列保証）。
      //   成功時はスナップショットを generate-reply の brainMetaDirect へ直接渡し、
      //   generate-reply 側の DB フェッチ（チェックポイントA/B）をスキップさせる。
      //   required 通知も runBrainAndNotify 内で送信される（旧webhook brain after()から移設）。
      // 失敗（null）時は brainMetaDirect を渡さず従来どおり generate-reply 側 DB フェッチに
      // フォールバックする（生成自体は止めない）。
      // ※ cron fallback（generate-pending-drafts）は本ルートを経由せず generate-reply を直接叩く。
      //   そのため cron 側にも同じ brain 直列実行を実装済み（brain_analyzed_at の staleチェック付き
      //   = bg-async で実行済みの会話では再実行せず required 通知の重複を防ぐ）。
      let brainGateDirect: BrainGateSnapshot | null = null;
      try {
        brainGateDirect = await Promise.race([
          runBrainAndNotify(convId, targetMessage),
          // FIX(post-Fable5): 旧値 60_000ms は extended thinking の最悪ケース（最大60s）と同値の境界で、
          // brain 完了と同時にタイムアウトが勝つと T3 フォールバックに落ちていた。
          // 90s に延ばすことで境界衝突を解消（90+180+α < maxDuration=300s で収支は安全）。
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
        ]);
        console.log("[bg-async] brain serial done, convId:", convId, "gate:", brainGateDirect ? "fresh" : "null(fallback to DB fetch)");
        if (!brainGateDirect) {
          console.log(JSON.stringify({tag:"degradation:T3",stage:"brain-gate-timeout",conversationId:convId,reason:"brain_race_timeout_90s",staleAgeMs:null}));
        }
      } catch (brainErr) {
        console.warn("[bg-async] brain serial failed（従来フォールバックで続行）:", String(brainErr), "convId:", convId);
        console.log(JSON.stringify({tag:"degradation:T3",stage:"brain-gate-error",conversationId:convId,reason:"brain_exception",staleAgeMs:null,error:String(brainErr).slice(0,200)}));
      }

      // ── brain完了後: 短時間複数メッセージ対策（DB再取得でtargetMessageを更新）──
      // brainは30-90秒かかるため、その間に届いた追加メッセージをDB再取得で取り込む
      // （例: メッセージ1のbg-asyncがatomic claimでロック中にメッセージ2が届いた場合）
      let effectiveTargetMessage = targetMessage;
      let effectiveRecentMsgs = recentMsgs;
      try {
        const { data: latestMsgsData } = await db.from("messages")
          .select("sender, text, image_url, created_at, is_aix_generated")
          .eq("conversation_id", convId)
          .order("created_at", { ascending: false }).limit(20);
        if (latestMsgsData && latestMsgsData.length > 0) {
          type MsgRow = { sender: string; text: string | null; image_url: string | null; created_at?: string; is_aix_generated: boolean | null };
          const latestList = (latestMsgsData as MsgRow[]).reverse().map((m) => ({
            sender: m.sender,
            text: m.text || (m.image_url ? "[画像]" : ""),
            imageUrl: m.image_url ?? undefined,
            createdAt: m.created_at,
            isAix: m.is_aix_generated ?? false,
          }));
          const latestStaffIdx = latestList.map((m, i) => m.sender === "staff" ? i : -1).filter((i) => i >= 0).at(-1);
          const latestAfterStaff = latestStaffIdx !== undefined ? latestList.slice(latestStaffIdx + 1) : latestList;
          const latestUnreplied = latestAfterStaff
            .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
            .slice(-10);
          const latestTarget = latestUnreplied.map((m) => m.text).join("\n");
          if (latestTarget.trim()) {
            if (latestTarget !== targetMessage) {
              console.log("[bg-async] brain後DB再取得: 追加メッセージ検出 convId:", convId,
                "元:", JSON.stringify(targetMessage.slice(0, 80)),
                "最新:", JSON.stringify(latestTarget.slice(0, 80)));
            }
            effectiveTargetMessage = latestTarget;
            effectiveRecentMsgs = latestList;
          }
        }
      } catch (refreshErr) {
        console.warn("[bg-async] brain後DB再取得エラー（初期targetMessageで続行）:", refreshErr);
      }

      // 脳-DBブリッジ: 条件変更検出 → DB自動更新（返信プロンプト注入だけでなくDB側にも反映）
      if (brainGateDirect?.meta?.condition_change_type && conv.property_customer_id) {
        void applyBrainConditionChange(
          db,
          conv.property_customer_id as string,
          convId,
          effectiveTargetMessage,
          brainGateDirect.meta.condition_change_type as string,
        ).catch((e) => console.warn("[bg-async] brain-condition-bridge error:", e));
      }

      const { data: pc } = conv.property_customer_id
        ? await db.from("property_customers")
          .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points, walk_minutes, move_in_time, building_age, other_requests, additional_conditions, initial_cost_limit")
          .eq("id", conv.property_customer_id).single()
        : { data: null };

      // 直近20件に非AIXスタッフ返信があるか確認（brain-coreと同じ判定: AIX自動返信は除外）
      const hasStaffInLast20 = recentMsgs.some((m) => m.sender === "staff" && !m.isAix);

      // 直近20件にスタッフ返信がない場合: 全履歴から最新非AIXスタッフ返信を取得してコンテキストに注入
      // - hasAnyStaffMsg: 過去に返信済みか（effectiveState=first_reply 判定精度向上）
      // - 見つかれば先頭追加（generateReplyの inject last staff ロジックと統一）
      let hasAnyStaffMsg = hasStaffInLast20;
      let recentMsgsForGen = recentMsgs;
      if (!hasStaffInLast20) {
        const { data: lastStaffData } = await db.from("messages")
          .select("sender, text, created_at")
          .eq("conversation_id", convId)
          .eq("sender", "staff")
          .eq("is_aix_generated", false)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastStaffData) {
          hasAnyStaffMsg = true;
          recentMsgsForGen = [
            { sender: "staff", text: (lastStaffData.text as string) || "", imageUrl: undefined as string | undefined, createdAt: lastStaffData.created_at as string | undefined, isAix: false },
            ...recentMsgs,
          ];
        }
      }

      const normalizedStatus = STATUS_ALIAS[conv.status as string] ?? conv.status;
      const effectiveState = !hasAnyStaffMsg && normalizedStatus === "hearing" ? "first_reply" : (conv.status as string);

      type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string; walk_minutes?: number; move_in_time?: string; building_age?: number; other_requests?: string; additional_conditions?: string; initial_cost_limit?: number } | null;
      const pcData = pc as PC;
      // page.tsxのCustomerStructuredForGenと同じ構造（missingConditionsNote注入に必要）
      const customerStructured = pcData
        ? {
            move_in_time: pcData.move_in_time ?? null,
            rent_max: pcData.rent_max ?? null,
            desired_area: pcData.desired_area ?? null,
            walk_minutes: pcData.walk_minutes ?? null,
            floor_plan: pcData.floor_plan ?? null,
            initial_cost_limit: pcData.initial_cost_limit ?? null,
            building_age: pcData.building_age ?? null,
            other_requests: pcData.other_requests ?? null,
          }
        : null;
      // formatConditions と同じロジックで全フィールドを統一フォーマット
      const dbConditions = [
        pcData?.desired_area && `エリア: ${pcData.desired_area}`,
        pcData?.floor_plan && `間取り: ${pcData.floor_plan}`,
        (pcData?.rent_min || pcData?.rent_max) && `家賃: ${[pcData.rent_min ? Math.floor(pcData.rent_min / 10000) + "万円〜" : "", pcData.rent_max ? Math.floor(pcData.rent_max / 10000) + "万円以内" : ""].join("")}`,
        pcData?.walk_minutes && `駅徒歩: ${pcData.walk_minutes}分以内`,
        pcData?.move_in_time && `入居: ${pcData.move_in_time}`,
        pcData?.building_age && `築年数: ${pcData.building_age}年以内`,
        pcData?.preferences && `希望: ${pcData.preferences}`,
        pcData?.ng_points && `NG: ${pcData.ng_points}`,
        pcData?.other_requests && `その他: ${pcData.other_requests}`,
        pcData?.additional_conditions && (() => {
          const clean = pcData.additional_conditions!.split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
          return clean ? `追加条件: ${clean}` : null;
        })(),
      ].filter(Boolean).join("\n");
      const customerConditions = dbConditions || memo;

      // お客様メッセージから返信ヒントを自動抽出
      // ※ effectiveTargetMessage を使う（brain後DB再取得で追加メッセージが含まれている可能性がある）
      const msgLines = effectiveTargetMessage.split("\n").map((l) => l.trim()).filter(Boolean);

      // ① 箇条書き条件（3行以上の短い行）
      const shortLines = msgLines.filter((l) => l.length <= 25);
      const isBulletConditions = shortLines.length >= 3;

      // ② 条件変更・緩和キーワード（1〜2行でも発火）
      const COND_RE = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
      const ACT_RE = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
      const PICKUP_RE = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
      const hasConditionChange = msgLines.some((l) => COND_RE.test(l) && ACT_RE.test(l));
      const hasPickupRequest = msgLines.some((l) => PICKUP_RE.test(l));

      // ③ スタッフが申込フォーム説明を送った直後のお客様の短い確認質問
      // 例：「住居年数・勤務先名・携帯番号…」→「今の就職先ですか？？」
      // → フォームはまだ記入していない段階。送付催促は絶対NG。質問に端的に答えるだけ。
      const APPLY_FORM_RE = /住居年数|携帯番号|続柄|勤務先名|勤務先所在地|現住所|本人確認書類|運転免許証|マイナンバー|お申込|申込フォーム|入居審査|緊急連絡先|保証人/;
      const lastStaffMsgText = effectiveRecentMsgs.filter((m) => m.sender === "staff" && !m.isAix).at(-1)?.text ?? "";
      const staffJustSentFormInfo = APPLY_FORM_RE.test(lastStaffMsgText);
      const isShortClarifyingQ = effectiveTargetMessage.trim().length < 40 && /[？?]|ですか|でしょうか|でいい|でもいい/.test(effectiveTargetMessage);

      let replyHint = "";
      // first_reply は phase_guide の パターンA が最適対応（挨拶+条件復唱+ピックアップ宣言）
      // replyHint を渡すと指定生成モード「2〜3行制限」が発動してパターンAが潰されるため除外
      if (effectiveState !== "first_reply") {
        if (staffJustSentFormInfo && isShortClarifyingQ) {
          // ③ 申込説明直後の確認質問：送付催促・フォーム記入促進は絶対に書かない
          replyHint = `【⚠️ 申込フォーム説明への確認質問】スタッフが直前に申込必要書類を案内済み。お客様はフォームをまだ記入していない段階での確認質問。「記入完了したら送ってください」「お送りください」等の送付催促は絶対に書かない。質問に端的に答えるだけでよい。`;
        } else if (isBulletConditions) {
          replyHint = `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}`;
        } else if (hasConditionChange || hasPickupRequest) {
          replyHint = `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${msgLines.join("・")}`;
        }
      }

      const baseUrl = getBaseUrl();
      console.log("[bg-async] calling generate-reply at:", baseUrl, "convId:", convId, "state:", effectiveState);

      const { data: pendingTasks } = await db.from("line_tasks")
        .select("task_type")
        .eq("conversation_id", convId)
        .eq("status", "pending");
      const activeTaskTypes = (pendingTasks ?? []).map((t: { task_type: string }) => t.task_type);

      // AIX誘導タスクがある場合はdraft生成をスキップ（property_checkは短い返しを生成するため除外）
      const AIX_SKIP_TYPES = ["property_send", "estimate_sheet"];
      if (activeTaskTypes.some((t: string) => AIX_SKIP_TYPES.includes(t))) {
        await db.from("conversations")
          .update({ ai_draft: "[AIX誘導中]", draft_pending_at: null })
          .eq("id", convId)
          .is("ai_draft", null);
        console.log("[bg-async] AIXタスク進行中のためdraft生成スキップ:", convId, activeTaskTypes);
        return;
      }

      // brain が AIX を指示している場合は下書き生成をスキップ（line_tasks有無に関わらず）
      if (brainGateDirect?.meta?.reply_mode === "aix") {
        console.log("[bg-async] brain reply_mode=aix → draft skip, convId:", convId);
        await db.from("conversations")
          .update({ ai_draft: "[AIX誘導中]", draft_pending_at: null })
          .eq("id", convId)
          .is("ai_draft", null);
        return;
      }

      // 180秒タイムアウト: generate-replyはStep1(最大45s)+Step2(最大45s)+余裕=最大90s超。
      // 40秒では重い会話で構造的に常にタイムアウトするため150秒に引き上げ、
      // さらに brain直列実行（最大30s）が先行するようになった分を考慮して180秒へ拡大
      // （brain 30s + fetch 180s + 前後DB操作でも after() maxDuration=300s 内に収まる）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000);

      let draftRes: Response;
      try {
        draftRes = await fetch(`${baseUrl}/api/generate-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            message: effectiveTargetMessage,
            state: effectiveState,
            // 紐付き顧客名 → なければ conversationsの表示名（LINEの名前）をフォールバック
            customerName: pcData?.customer_name || (conv.customer_name as string) || "",
            // brain後DB再取得で追加メッセージが取り込まれている場合は effectiveRecentMsgs を優先
            recentMessages: effectiveRecentMsgs !== recentMsgs ? effectiveRecentMsgs : recentMsgsForGen,
            customerConditions,
            customerSummary: pcData?.ai_summary || "",
            // 条件ヒアリング状況（missingConditionsNote注入のために必要）
            ...(customerStructured ? { customerStructured } : {}),
            replyHint,
            activeTaskTypes,
            // RLHF断絶修正: conversationId を渡して generate-reply 側の logKnowledgeApply を発火させる
            // （knowledge_apply_log 記録 → text_retention / deal_outcome フィードバック対象化）
            // ※ generate-reply 側も ai_draft を保存するが同一内容の冪等上書きのため二重化の実害なし
            conversationId: convId,
            // reply_modeゲート有効化（brain判定がaixなら自動ドラフトを生成しない）
            enforceReplyModeGate: true,
            // brain直列実行の結果を直接渡す（generate-reply側のDBフェッチをスキップ）。
            // 直前に自分で書いた値なので鮮度保証あり。null時は渡さず従来のDBフェッチに任せる
            ...(brainGateDirect ? { brainMetaDirect: brainGateDirect } : {}),
          }),
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const isTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
        const errMsg = isTimeout ? "timeout (180s)" : String(fetchErr);
        console.error("[bg-async] fetch error:", errMsg, "baseUrl:", baseUrl, "convId:", convId);
        // 3回失敗までは draft_attempted_at をクリアして即リトライ可能にする
        // （残すとUIの再トリガー・cronが5分バックオフでサイレントスキップされ「準備中...」のまま止まる。
        //   UIのポーリングは draft_attempted_at=null を「生成失敗」として検知し再生成ボタンに切替える）
        const failCount = (conv.draft_fail_count ?? 0) + 1;
        await db.from("conversations").update({
          draft_fail_count: failCount,
          draft_last_error: errMsg.slice(0, 500),
          ...(failCount < 3 ? { draft_attempted_at: null } : {}),
        }).eq("id", convId);
        return;
      }

      if (!draftRes.ok || !draftRes.body) {
        const errMsg = `generate-reply non-ok: ${draftRes.status} ${draftRes.statusText}`;
        console.error("[bg-async]", errMsg, "convId:", convId);
        // 3回失敗までは draft_attempted_at をクリア（上のfetch errorと同じ理由）
        const failCount = (conv.draft_fail_count ?? 0) + 1;
        await db.from("conversations").update({
          draft_fail_count: failCount,
          draft_last_error: errMsg,
          ...(failCount < 3 ? { draft_attempted_at: null } : {}),
        }).eq("id", convId);
        return;
      }

      const reader = draftRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", metaDone = false, fullText = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!metaDone) {
            buffer += chunk;
            const nl = buffer.indexOf("\n");
            if (nl >= 0) {
              try {
                const meta = JSON.parse(buffer.slice(0, nl)) as { ok: boolean; reason?: string };
                if (!meta.ok) {
                  if (meta.reason === "aix_required") {
                    // ゲート側で ai_draft="[AIX誘導中]" + draft_pending_at=null 保存・スタッフ通知済み
                    console.log("[bg-async] reply_mode=aix のため自動ドラフトスキップ, convId:", convId);
                  } else {
                    console.error("[bg-async] generate-reply meta.ok=false, convId:", convId);
                  }
                  return;
                }
              } catch (parseErr) {
                console.error("[bg-async] meta parse error:", String(parseErr), "buffer:", buffer.slice(0, 100), "convId:", convId);
                return;
              }
              metaDone = true;
              fullText = buffer.slice(nl + 1);
            }
          } else {
            fullText += chunk;
          }
        }
      } catch (streamErr) {
        console.error("[bg-async] stream read error:", String(streamErr), "convId:", convId, "partial text length:", fullText.length);
        // 部分テキストがあれば保存を試みる（内部タグは除去のみ。suggested_aix_meta は brain（runBrainAndNotify）が書き込み済みのため触らない）
        const partialDraft = fullText
          .replace(/\n?<<<SUGGESTED_AIX:[\s\S]*?>>>/g, "")
          .replace(/\n?<<<STOP_REASON:[\w-]*>>>/g, "")
          .trim();
        if (partialDraft.length > 20) {
          await db.from("conversations").update({ ai_draft: partialDraft, draft_pending_at: null, draft_attempted_at: null }).eq("id", convId).is("ai_draft", null);
          console.log("[bg-async] saved partial draft:", partialDraft.length, "chars, convId:", convId);
        }
        return;
      }

      // 内部タグ（<<<SUGGESTED_AIX:{...}>>> / <<<STOP_REASON:xxx>>>）を本文から除去してから保存
      // （未除去のまま保存すると内部指示が顧客に届く事故になるため防御的に除去。
      //   suggested_aix_meta は brain（runBrainAndNotify）が draft 生成前に書き込み済みのため、ここでは書かない）
      const finalDraft = fullText
        .replace(/\n?<<<SUGGESTED_AIX:[\s\S]*?>>>/g, "")
        .replace(/\n?<<<STOP_REASON:[\w-]*>>>/g, "")
        .trim();
      if (finalDraft) {
        // ai_draft IS NULL ガード: 人間が編集中の場合は上書きしない
        const { error: saveErr } = await db.from("conversations")
          // draft_attempted_at: null でロック解放 → 次メッセージ到着時に after()B が即再claimできる
          .update({ ai_draft: finalDraft, draft_pending_at: null, draft_fail_count: 0, draft_attempted_at: null })
          .eq("id", convId)
          .is("ai_draft", null);
        if (saveErr) {
          console.error("[bg-async] save error:", saveErr.message, "convId:", convId);
        } else {
          console.log("[bg-async] draft saved OK, length:", finalDraft.length, "convId:", convId);
        }
      } else {
        console.error("[bg-async] empty draft, convId:", convId, "targetMessage:", targetMessage.slice(0, 50));
      }
    } catch (err) {
      console.error("[bg-async] unhandled error:", String(err), "convId:", convId);
    }
  });

  return NextResponse.json({ ok: true, started: true });
}
