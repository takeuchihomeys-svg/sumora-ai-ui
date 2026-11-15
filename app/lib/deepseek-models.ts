/**
 * DeepSeek のモデル名（2026-11-15）
 *
 *   ⚠ モデル名は**1か所で持つ**（散らばると片方だけ古くなって静かに壊れる）。
 *   ⚠ 実際に使える名前は `/v1/models` で確認した（2026-11-15 実測）:
 *     `deepseek-flash` / `deepseek-v4-pro`
 */
export const DEEPSEEK_MODEL_FLASH = "deepseek-flash";
/** 思考が要る仕事用（統括の判断など）。⚠ 推論にトークンを使うので max_tokens は多めに */
export const DEEPSEEK_MODEL_PRO = "deepseek-v4-pro";

/** 推論モデルなので余裕を持つ（小さいと推論で使い切って答えが1文字も出ない・実測） */
export const DEEPSEEK_MAX_TOKENS_SAFE = 4000;
/**
 * ★ 2026-11-15 実測: 統括の判断（3行だけ答えさせたい）は **2,500** が最適。
 *   ⚠ 4000 だと推論が 6,900字まで伸びて **60秒を超えて時間切れ**になる事があった（実測）。
 *   ⚠ 2000 以下だと**推論で使い切って答えが0字**（実測: 700→0字・2000→0字）。
 *   → 2,500 で「答えが出る」と「60秒に収まる」の両方を満たす。
 */
export const DEEPSEEK_MAX_TOKENS_THINK = 2500;
