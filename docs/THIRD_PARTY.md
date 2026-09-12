# Third-party credits

DineOS uses installed packages rather than copied vendor application code. Exact JavaScript resolutions are recorded in `pnpm-lock.yaml`; direct Python runtime pins are in `backend/requirements.txt`. Distributed license texts collected from the build environment are retained in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), including transitive packages. Regenerate with `.venv/bin/python scripts/third_party_notices.py` after installing both environments.

| Dependency | Role | License |
| --- | --- | --- |
| React / React DOM | Curated diner and coordinator interface | MIT |
| Vite / React Vite plugin | Local web server and build | MIT |
| TypeScript | Static type checking | Apache-2.0 |
| Zod | Browser tool validation | MIT |
| Lucide React | Interface icons | ISC |
| FastAPI / Starlette | Local API and lifecycle | MIT / BSD-3-Clause |
| Pydantic / pydantic-core | Typed command and planner contracts | MIT |
| HTTPX / HTTP Core | Server-side OpenAI requests | BSD-3-Clause |
| Uvicorn | Local ASGI server | BSD-3-Clause |
| python-dotenv | Safe environment-file parsing | BSD-3-Clause |
| Vitest / Testing Library / jsdom | Browser-client deterministic tests | MIT |
| pytest | Backend behavioral tests | MIT |
| SQLite | Durable local state engine via Python standard library | Public domain SQLite engine |

OpenAI supplies the Realtime/WebRTC and Responses APIs, and the generated illustrative dish assets. Service use is subject to the provider’s applicable terms; the APIs are not bundled source code.

API documentation: [Realtime call creation](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [gpt-realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [gpt-5-mini](https://developers.openai.com/api/docs/models/gpt-5-mini).
