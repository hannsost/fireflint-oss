# AI providers

FireFlint's AI features (workflow graph executor, chat copilot) are optional and vendor-neutral. Connectors are
configured per organisation by an owner in the admin UI or via `POST /api/orgs/{org}/ai/connectors`:

```json
{ "name": "Local Llama", "provider": "openai_compatible",
  "base_url": "http://localhost:11434/v1", "default_model": "llama3.2" }
```

| `provider` | Protocol | Notes |
| --- | --- | --- |
| `openai_compatible` | `POST {base_url}/chat/completions` | OpenAI, Mistral, OpenRouter, Groq, Together, vLLM, LM Studio, Ollama … API key optional (local runtimes). Default base URL: `https://api.openai.com/v1`. |
| `anthropic` | `POST {base_url}/v1/messages` | Anthropic native API, key required. |
| `mock` | – | Deterministic, key-free; used in tests and demos. |

## Egress allowlist

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_ALLOWED_PROVIDER_HOSTS` | *(empty)* | Extra approved hosts, comma-separated, e.g. `api.mistral.ai,openrouter.ai`. `api.openai.com` and `api.anthropic.com` are always approved. |
| `AI_ALLOW_PRIVATE_PROVIDERS` | `false` | Allow approved hosts on loopback/private networks over HTTP and custom ports — needed for Ollama, LM Studio or vLLM on your own network. |

Without these opt-ins, AI base URLs must be HTTPS on port 443 and resolve to public IPs. API keys are stored
encrypted with `AI_CONNECTOR_ENCRYPTION_KEY`, are never returned by the API, and provider error bodies are not
echoed (they could contain credentials).

## Examples

| Use case | `base_url` | `default_model` | Extra env |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | – |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` | `AI_ALLOWED_PROVIDER_HOSTS=api.mistral.ai` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` | `AI_ALLOWED_PROVIDER_HOSTS=openrouter.ai` |
| Ollama | `http://localhost:11434/v1` | `llama3.2` | `AI_ALLOWED_PROVIDER_HOSTS=localhost`, `AI_ALLOW_PRIVATE_PROVIDERS=true` |
| LM Studio | `http://localhost:1234/v1` | loaded model | same as Ollama |
| Anthropic | *(default)* | `claude-sonnet-4-6` | – |
