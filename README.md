# Self-Aware Downgrade Routing

Tự động chọn AI model phù hợp dựa trên phân tích câu hỏi người dùng.

## Cách hoạt động

```
IDE → Proxy (phân tích câu hỏi → swap model) → Antigravity Server
IDE → MCP Server (manual override)
```

1. **Orchestrator** phân tích câu hỏi user, phân loại intent
2. **Proxy** chỉ swap field `model`, mọi thứ khác đi nguyên xi
3. **MCP Server** cho phép manual override khi cần

## Cài đặt

```bash
# Clone & install
pip install -e ".[dev]"

# Copy và chỉnh config
cp .env.example .env
```

## Chạy

```bash
# Chạy cả MCP + Proxy
python -m src.main
```

## Cấu hình

| Biến | Mặc định | Mô tả |
|---|---|---|
| `UPSTREAM_URL` | `https://cloudcode-pa.googleapis.com` | Antigravity server |
| `PROXY_PORT` | `8080` | Port proxy local |
| `FLAG_TTL_SECONDS` | `10` | TTL cờ override |
| `ROUTING_RULES_PATH` | `src/routing_rules.yaml` | File routing rules |

## Routing Rules

Chỉnh file `src/routing_rules.yaml` để thêm/sửa intent patterns.

## MCP Tools

- `request_model_switch(target_model)` — gài cờ cho request tiếp theo
- `list_available_models()` — liệt kê models + rules
"# auto-change-model" 
"# auto-change-model" 
"# auto-change-model" 
"# auto-change-model" 
