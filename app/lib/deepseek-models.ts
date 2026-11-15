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
