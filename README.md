![Splash image](./assets/splash.png)

agentic coding in 30 loc. a loop, three tools, and an llm.

## features

- `bash`, `read` and `write` tools
- chat REPL by default
- non-interactive mode with `-p 'prompt'` arg

## usage

```sh
# interactive repl
OPENAI_API_KEY=sk-... node index.mjs

# one-shot (run once, exit)
node index.mjs -p 'refactor auth.js to use bcrypt'

# local models via any openai-compatible api
MODEL=qwen3.5:4b OPENAI_BASE_URL=http://localhost:33821 node index.mjs
```

## env

| var | default | what |
|-----|---------|------|
| `OPENAI_API_KEY` | — | api key |
| `OPENAI_BASE_URL` | `https://api.openai.com` | api base url (ollama, lmstudio, litellm, etc) |
| `MODEL` | `gpt-5.4` | model name |
| `SYSTEM_PROMPT` | built-in agent prompt | override the system prompt entirely |
