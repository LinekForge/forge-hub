#!/bin/bash
# Forge Hub ASR hook example — 语音入站识别
#
# Hub 调用协议（和 TTS hook 对称）：
#   $1 = 音频文件绝对路径（.ogg / .caf / .mp3 / .wav 等，各通道格式不同）
#   $2 = 期望输出的纯文本文件路径（UTF-8）
#   $3 = 通道名（"telegram" / "feishu" / "imessage"——按通道分流 provider）
#
# 成功判定：exit 0 且 $2 非空
#
# 启用：export FORGE_HUB_ASR_HOOK=/path/to/this/script.sh
# 加到 launchd plist EnvironmentVariables（见 配置.md §加 env 到 Hub 进程）

set -euo pipefail

AUDIO_FILE="$1"
OUTPUT_TEXT="$2"
CHANNEL="$3"

# 按通道分流 provider（删掉不要的 case，留一个做 default 即可）
case "$CHANNEL" in
  # ==========================================================
  # 示例 1 · 飞书原生 speech_to_text（参考 feishu-stream-asr.ts）
  # 需飞书 bot + lark-cli 已登录
  # **注意**：stream_recognize 同步阻塞 hook 进程几秒到十几秒
  # （60s 音频 ≈ 12s 阻塞）——因为 Hub 从 core 撤掉了飞书原生 ASR，
  # 这个阻塞发生在 hook 子进程里，不影响 Hub 主进程其他通道
  # ==========================================================
  feishu)
    exec bun "$(dirname "$0")/feishu-stream-asr.ts" "$@"
    ;;

  # ==========================================================
  # 示例 2 · OpenAI Whisper API
  # 云服务，准确度高，需 OPENAI_API_KEY env + 网络可达
  # ==========================================================
  telegram)
    # `.text // empty`：API error response 无 `.text` 字段时 jq 输出 nothing 而非字面 "null"，
    # 避免下面 `-s` check 误判为有内容把 "null" 当 ASR 结果返给 agent
    curl -sS -X POST https://api.openai.com/v1/audio/transcriptions \
      -F "file=@${AUDIO_FILE}" \
      -F "model=whisper-1" \
      -H "Authorization: Bearer ${OPENAI_API_KEY:?OPENAI_API_KEY not set}" \
      | jq -r '.text // empty' > "${OUTPUT_TEXT}"
    ;;

  # ==========================================================
  # 示例 3 · 本地 whisper.cpp
  # 无网络 / 隐私场景——iMessage 语音不想传云
  # 需先装：brew install whisper-cpp + 下载模型
  # ==========================================================
  imessage)
    # whisper.cpp 只接 16kHz WAV，先用 ffmpeg 转
    TMP_WAV=$(mktemp -t hub-asr-XXXXXX).wav
    trap 'rm -f "${TMP_WAV}"' EXIT
    ffmpeg -y -i "${AUDIO_FILE}" -ar 16000 -ac 1 "${TMP_WAV}" 2>/dev/null
    whisper-cli -m ~/.whisper/ggml-base.bin -f "${TMP_WAV}" --output-txt --no-prints \
      | head -n 1 > "${OUTPUT_TEXT}"
    ;;

  # ==========================================================
  # 示例 4（未启用）· MiniMax ASR
  # 替换 telegram/feishu 的 case 即可切到 MiniMax
  # ==========================================================
  # *)
  #   curl -sS -X POST https://api.minimax.chat/v1/speech_to_text \
  #     -H "Authorization: Bearer ${MINIMAX_API_KEY}" \
  #     -F "file=@${AUDIO_FILE}" \
  #     | jq -r '.text' > "${OUTPUT_TEXT}"
  #   ;;

  *)
    echo "Unsupported channel: ${CHANNEL}" >&2
    exit 1
    ;;
esac

# 验证输出非空（Hub 空文件也当失败处理）
if [ ! -s "${OUTPUT_TEXT}" ]; then
  echo "ASR 识别结果为空 (channel=${CHANNEL} audio=${AUDIO_FILE})" >&2
  exit 1
fi
