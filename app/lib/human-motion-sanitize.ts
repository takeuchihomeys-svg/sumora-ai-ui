/**
 * 人の動き・位置・操作ログ（human_motion_learn）から、
 * 1) DOM の破損名（#[object HTMLInputElement] 等）
 * 2) 他サイトの固有要素（リアプロ ↔ ITANDI の混入）
 * を送信時・受信時に自動除去するサニタイザ（純関数）。
 *
 * 根拠（2026-11-26 DB 実測）:
 *   - human_motion_learn #28319 (site=realpro, ext=2.8.309) に ITANDI 要素 #_r_5r_｜input.css-vm8hlm と #[object HTMLInputElement] が混入
 *   - human_motion_learn site=itandi 107件中11件にリアプロ要素 eq_rm[] / city_code[] / #top_free / #main_form 等が混入
 */

const GARBAGE_FIELD_RE = /^(?:#?\[object\s[^\]]*\]|undefined|null|\?|[-ー－_・=|/\\*~～]{2,}|input|select|textarea|button|span|div|label|iframe|id|form|table|tr|td|th|ul|li|body|html|img|#top_free|#main_form|div\.main_table|button\.history_btn)$/i;

/** 値セル・生CSSハッシュ単体・装飾画像だけの履歴ボタン等のゴミ欄名（どのサイトでも手順書に入れない） */
const GARBAGE_VALUE_OR_HASH_RE = new RegExp(
  [
    // 物件一覧の金額・月数・面積セルそのもの（例: 147,000円｜td.text_right, 1.5ヶ月｜td.text_right）
    "^[0-9０-９,.\\s]+(?:円|万円|ヶ月|カ月|ヵ月|年|㎡|階|棟|戸|%|％)(?:｜|$)",
    // td.text_right / td.list_... 等の表データセル（td.pager は次ページボタンなので別扱い）
    "｜td\\.(?!pager\\b)",
    // 表の巨大コンテナや拡張の履歴ボタン（例: 左の大阪2棟3戸並べ替え更新｜div.main_table, img→button.history_btn）
    "｜div\\.main_table(?:$|[^a-zA-Z0-9_])",
    "(?:^|→)button\\.history_btn(?:$|[^a-zA-Z0-9_])",
    // 日本語ラベル無しの生CSSハッシュ単体（例: input.css-1j76uus, div.css-abc123）
    "^(?:input|button|div|span|a|label|select|textarea)\\.(?:css|sc)-[a-z0-9_-]+$",
  ].join("|"),
  "i",
);

/** リアプロ固有の要素名・UI文言（site=itandi に入っていたら混入） */
const REALPRO_ONLY_FIELD_RE = new RegExp(
  [
    "^(?:eq_rm|city_code|town_code|route_id|station_id|room_layout_id|struct_id|exclusive_area)\\[",
    "^rental_cost[12]$",
    "^structured_date$",
    "^update_date$",
    "^(?:transportation_id|required_time)$",
    "^deposit_recommpence",
    "^#(?:top_free|main_form)$",
    "駅の設定へ進む|沿線の設定へ戻る|確定してリストへ|詳細な地域の設定へ進む|都道府県の設定",
    "\\.(?:one_city|one_town|one_line|one_station|go_search|pager|sort_detail)(?:[^a-zA-Z0-9_]|$)",
    "(?:沿線・駅絞り込み|所在地絞り込み|所在地を絞り込み|マップ検索|印刷用PDF|沿線リセット|市区郡リセット)",
    "(?:全部屋を表示|5部屋まで表示|表示棟数|即入物件で絞り込み|管理会社絞り込み|スタジオタイプ|問合せ履歴)",
    "(?:建物ごと|部屋ごと|閲覧履歴|並べ替え|並び替え|ピンポイント|広げて検索|大阪環状線|駅名から絞り込み|PDF出力|表示件数|×とじる)",
    "(?:駅からの移動手段|^移動手段$|^賃料下限$|^下限賃料$|^賃料上限$|^上限賃料$|^高→低$)",
    "^(?:リセット|最初|最後|変更|クリア|絞り込み|とじる|路線|駅)$",
    "^(?:(?:左|右|上|下|中央)の)?(?:区を選ぶ|沿線を選ぶ|駅を選ぶ|one_station|one_station_id|one_line|one_city|one_town)(?:｜|$)",
  ].join("|"),
);

/** ITANDI 固有の要素名・UI文言（site=realpro に入っていたら混入） */
const ITANDI_ONLY_FIELD_RE = new RegExp(
  [
    "^#?_r_[a-z0-9_]+_(?:｜|$)",
    "css-[a-z0-9]{4,}",
    "itandi-bb-ui",
    "^(?:rent|reikin|shikikin|room_layout|building_name|free_word|floor_area|floor_area_amount|station_walk_minutes|structure_type|option_id|offer_conditions_updated_at|building_age):(?:lteq|gteq|eq|in|match|not_eq)",
    "(?:小窓の確定|物件資料|募集中物確不要|路線・駅選択|^路線・駅で絞り込み|^物件情報・特徴)",
  ].join("|"),
  "i",
);

/**
 * 1枚の画像・操作束が別サイトの画面誤記録かを見抜くため、相手サイト固有の欄名に一致するかだけを返す（一般ゴミは false）。
 */
export function isCrossSiteFieldName(name: unknown, site: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const s = name.trim();
  if (!s) return false;
  const sc = String(site || "").toLowerCase();
  if (sc === "realpro") return ITANDI_ONLY_FIELD_RE.test(s);
  if (sc === "itandi") return REALPRO_ONLY_FIELD_RE.test(s);
  return false;
}

export function isAllowedMotionFieldName(name: unknown, site: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const s = name.trim();
  if (!s) return false;
  if (GARBAGE_FIELD_RE.test(s) || GARBAGE_VALUE_OR_HASH_RE.test(s) || /\[object\s+[A-Z]/i.test(s) || /路線・駅選択都道府県/.test(s)) return false;

  const sc = String(site || "").toLowerCase();
  if (sc === "realpro" && ITANDI_ONLY_FIELD_RE.test(s)) return false;
  if (sc === "itandi" && REALPRO_ONLY_FIELD_RE.test(s)) return false;
  return true;
}

/**
 * shots.learned / shots.learned_scene 等の画面マップから、指定サイトに不要なゴミ・他サイト混入を除く。
 */
export function sanitizeLearnedForSite(
  learned: unknown,
  site?: string | null,
): { learned: Record<string, unknown[]> | null; removed: number; samples: string[] } {
  if (!learned || typeof learned !== "object" || Array.isArray(learned)) {
    return { learned: null, removed: 0, samples: [] };
  }
  const sc = (site === "realpro" || site === "itandi") ? site : null;
  let removed = 0;
  const samples: string[] = [];
  const noteDrop = (name: unknown) => {
    removed++;
    const s = String(name ?? "").slice(0, 40);
    if (s && samples.length < 10 && !samples.includes(s)) samples.push(s);
  };
  const out: Record<string, unknown[]> = {};
  for (const [screen, arr] of Object.entries(learned as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue;
    const realproDrops: number[] = [];
    const kept0 = arr.filter((item) => {
      const rec = (item && typeof item === "object") ? (item as Record<string, unknown>) : null;
      const nm = rec?.name;
      const ok = isAllowedMotionFieldName(nm, sc);
      if (!ok) {
        noteDrop(nm);
        if (sc === "itandi" && typeof nm === "string" && REALPRO_ONLY_FIELD_RE.test(nm.trim())) {
          realproDrops.push(Number(rec?.n) || 0);
        }
      }
      return ok;
    });
    // #2514 以前のサイト未分離世代（リアプロ固有項目が高票で同居していた混載配列）は、同配列に積まれた旧共通名（n>=22）も一掃する
    const pollutedGeneration = sc === "itandi"
      && realproDrops.length >= 3
      && (realproDrops.filter((n) => n >= 50).length >= 2 || realproDrops.filter((n) => n >= 22).length >= 3);
    const kept = pollutedGeneration
      ? kept0.filter((item) => {
        const rec = (item && typeof item === "object") ? (item as Record<string, unknown>) : null;
        if ((Number(rec?.n) || 0) >= 22) {
          noteDrop(rec?.name);
          return false;
        }
        return true;
      })
      : kept0;
    if (kept.length) out[screen] = kept;
  }
  return { learned: Object.keys(out).length ? out : null, removed, samples };
}

/**
 * 既存の束（bundle）に古い蓄積・引き継ぎから混入したゴミ欄名・他サイト要素・爆発点（n > 5000 かつ 0.5,0.5）を取り除く。
 *   site が "realpro" / "itandi" 以外の時（"all" / null）もゴミ欄・爆発点は除去する。
 */
export function sanitizeBundleForSite(bundle: Record<string, unknown>, site?: string | null): {
  removed: number;
  samples: string[];
} {
  let removed = 0;
  const samples: string[] = [];
  const noteDrop = (name: unknown) => {
    removed++;
    const s = String(name ?? "").slice(0, 40);
    if (s && samples.length < 10 && !samples.includes(s)) samples.push(s);
  };
  const sc = (site === "realpro" || site === "itandi") ? site : null;

  if (bundle.points && typeof bundle.points === "object" && !Array.isArray(bundle.points)) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bundle.points as Record<string, unknown>)) {
      if (!isAllowedMotionFieldName(k, sc)) { noteDrop(k); continue; }
      if (!v || typeof v !== "object") continue;
      const pv = v as Record<string, unknown>;
      const rawN = Number(pv.n) || 0;
      if (rawN > 5000 && pv.x === 0.5 && pv.y === 0.5) {
        noteDrop(`${k}(n=${rawN}@0.5)`);
        continue;
      }
      clean[k] = rawN > 500 ? { ...pv, n: 500 } : pv;
    }
    bundle.points = clean;
  }

  for (const mapKey of ["opens", "next", "cursor_hand"] as const) {
    const m = bundle[mapKey];
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (!isAllowedMotionFieldName(k, sc)) { noteDrop(k); continue; }
        clean[k] = v;
      }
      bundle[mapKey] = clean;
    }
  }

  if (Array.isArray(bundle.buttons)) {
    bundle.buttons = bundle.buttons.filter((b) => {
      const name = (b && typeof b === "object") ? (b as Record<string, unknown>).name : b;
      const ok = isAllowedMotionFieldName(name, sc);
      if (!ok) noteDrop(name);
      return ok;
    });
  }

  if (Array.isArray(bundle.weak)) {
    bundle.weak = bundle.weak.filter((w) => {
      if (!w || typeof w !== "object") return true;
      const name = (w as Record<string, unknown>).name;
      if (typeof name !== "string") return true;
      const ok = isAllowedMotionFieldName(name, sc);
      if (!ok) noteDrop(name);
      return ok;
    });
  }

  if (Array.isArray(bundle.challenge_missing_in_bundle)) {
    bundle.challenge_missing_in_bundle = bundle.challenge_missing_in_bundle.filter((x) => {
      const ok = isAllowedMotionFieldName(x, sc);
      if (!ok) noteDrop(x);
      return ok;
    });
  }

  if (bundle.shots && typeof bundle.shots === "object" && !Array.isArray(bundle.shots)) {
    const sh = bundle.shots as Record<string, unknown>;
    if (sh.learned && typeof sh.learned === "object" && !Array.isArray(sh.learned)) {
      const slRes = sanitizeLearnedForSite(sh.learned, sc);
      removed += slRes.removed;
      for (const s of slRes.samples) {
        if (samples.length < 10 && !samples.includes(s)) samples.push(s);
      }
      sh.learned = slRes.learned ?? {};
    }
    if (sh.learned_scene && typeof sh.learned_scene === "object" && !Array.isArray(sh.learned_scene)) {
      const scRes = sanitizeLearnedForSite(sh.learned_scene, sc);
      removed += scRes.removed;
      for (const s of scRes.samples) {
        if (samples.length < 10 && !samples.includes(s)) samples.push(s);
      }
      if (scRes.learned) sh.learned_scene = scRes.learned;
      else delete sh.learned_scene;
    }
  }

  // scene_flows[].steps からもサイト外ステップ・ゴミ文言（itandi 内のリアプロ文言、路線・駅選択都道府県北海 等）を除く
  if (Array.isArray(bundle.scene_flows)) {
    const cleanFlows: Array<Record<string, unknown>> = [];
    for (const sf of bundle.scene_flows as Array<Record<string, unknown>>) {
      if (!sf || typeof sf !== "object") continue;
      const steps = Array.isArray(sf.steps) ? sf.steps : [];
      const keptSteps = steps.filter((st) => {
        const s = String(st ?? "").trim();
        if (!s) return false;
        const ok = isAllowedMotionFieldName(s, sc);
        if (!ok) noteDrop(s);
        return ok;
      });
      if (!keptSteps.length) continue;
      cleanFlows.push({ ...sf, steps: keptSteps });
    }
    bundle.scene_flows = cleanFlows;
  }

  return { removed, samples };
}

export type SanitizeMotionInput = {
  site: string | null;
  fields: string[] | null;
  field_order: string[] | null;
  point_fields: Record<string, unknown> | null;
  opens: Record<string, unknown> | null;
  shot_ops: Array<Record<string, unknown>> | null;
};

export type SanitizeMotionResult = SanitizeMotionInput & {
  filtered_count: number;
  filtered_samples: string[];
};

export function sanitizeHumanMotionPayload(input: SanitizeMotionInput): SanitizeMotionResult {
  const samples: string[] = [];
  let filtered = 0;
  const recordDrop = (name: unknown) => {
    filtered++;
    const s = String(name ?? "").slice(0, 40);
    if (s && samples.length < 10 && !samples.includes(s)) samples.push(s);
  };

  const fields = Array.isArray(input.fields)
    ? input.fields.filter((f) => {
      const ok = isAllowedMotionFieldName(f, input.site);
      if (!ok) recordDrop(f);
      return ok;
    })
    : null;

  const field_order = Array.isArray(input.field_order)
    ? input.field_order.filter((f) => {
      const ok = isAllowedMotionFieldName(f, input.site);
      if (!ok) recordDrop(f);
      return ok;
    })
    : null;

  let point_fields: Record<string, unknown> | null = null;
  if (input.point_fields && typeof input.point_fields === "object" && !Array.isArray(input.point_fields)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.point_fields)) {
      if (isAllowedMotionFieldName(k, input.site)) out[k] = v;
      else recordDrop(k);
    }
    point_fields = Object.keys(out).length ? out : null;
  }

  let opens: Record<string, unknown> | null = null;
  if (input.opens && typeof input.opens === "object" && !Array.isArray(input.opens)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.opens)) {
      if (isAllowedMotionFieldName(k, input.site)) out[k] = v;
      else recordDrop(k);
    }
    opens = Object.keys(out).length ? out : null;
  }

  let shot_ops: Array<Record<string, unknown>> | null = null;
  if (Array.isArray(input.shot_ops)) {
    const out: Array<Record<string, unknown>> = [];
    for (const op of input.shot_ops) {
      if (op && typeof op.f === "string" && op.f && !isAllowedMotionFieldName(op.f, input.site)) {
        recordDrop(op.f);
        continue;
      }
      out.push(op);
    }
    shot_ops = out.length ? out : null;
  }

  return {
    site: input.site,
    fields: fields && fields.length ? fields : null,
    field_order: field_order && field_order.length ? field_order : null,
    point_fields,
    opens,
    shot_ops,
    filtered_count: filtered,
    filtered_samples: samples,
  };
}
