# sokuji × 自架 OpenAI-compatible realtime gateway：診斷與回歸測試

2026-11-04。端點 `http://<gateway-host>:8001`（模型 `translategemma:4b`，後接 ollama / llama.cpp）。
實際端點位址與金鑰不在本 repo；請以 `SOKUJI_ENDPOINT` / `SOKUJI_KEY` / `SOKUJI_MODEL` 環境變數帶入。

## 交付物

| 檔案 | 內容 | 狀態 |
|---|---|---|
| `src/providers/openai_compatible/multiturn.test.ts` | mock gateway 的多輪契約：每回合都有回應、兩種內容 modality、兩種拒絕碼 | 5 tests ✅ |
| `src/providers/openai_compatible/autoTurn.test.ts` | **auto 模式契約**：client 不發問、endpoint 必須自己收尾 | 3 tests ✅ |
| `src/providers/openai_compatible/gatewayContract.test.ts` | 同一份契約對**實機**跑 | 2 tests（見下） |
| `tools/GATEWAY-CONTRACT.md` | 你的 gateway 必須遵守的契約（已按實測校正） | — |
| `tools/probe_*.mjs` | 15 支可重現的實機探測腳本 | — |

實機契約測試（`SOKUJI_ENDPOINT` / `SOKUJI_KEY` / `SOKUJI_MODEL` 有值時才跑）：

- `answers every turn over one socket` → ✅ 通過（3 回合 23.8s）
- `ends the turn by itself under automatic turns` → ❌ **失敗**，診斷：
  `answered=0 frames=["out session.opened","in session.created","out session.update","in session.updated","out response.anchor","in response.created","in response.done"]`

## 根因

1. **gateway 沒有 server-side VAD**（主因）。
2. **拒絕錯誤缺 `code`** → sokuji 直接丟棄該請求。
3. **gateway 不回 input item / 轉寫** → 只有譯文，沒有原文。
4. gateway **不會主動斷線**（先前看到的 1005 是 probe 自己關的）。
5. gateway 一個回應要 **~17 秒**。

## 立即可用的解法

app 設定把全域 turn mode 從 `auto` 改成 **push-to-talk**（或 push-to-translate）。
兩者對 adapter 都是 manual turns → client 自己送 `commit` + `response.create` → 實測 3 回合全通。
