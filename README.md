# Tinker & Spice

**A restaurant host who can feel the whole room.**

Tinker & Spice is a premium hackathon demo of DineOS, a restaurant-level agent that connects what a returning guest wants with what the kitchen can actually deliver. Mira remembers the useful parts of Alex's last visit, speaks like a warm human server, changes the diner tablet as the conversation moves, notices live timing tradeoffs and stays with the order until the kitchen acknowledges it.

The demo clearly separates Alex's framed diner tablet from an observer-only context rail. The rail shows the seeded guest memory, Mira's current reasoning, live kitchen timings and the operational safeguards behind the conversation.

## Run locally

Requirements: Node.js **22.12+**, pnpm **11.19.0**, Python **3.12+**. The runtime dependencies are pinned. No sibling prep folder or reference PoC is needed.

```bash
# From your clone of dine-os
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cp .env.example .env
```

The copy command is for a fresh clone; preserve an existing `.env`. Set your own `OPENAI_API_KEY` in `.env` with a local editor. It stays on the Python server. Never put it in a `VITE_` variable or commit it. `.env` is parsed as data with python-dotenv, not executed as a shell script.

```bash
./scripts/start
```

Open **[http://127.0.0.1:5174/](http://127.0.0.1:5174/)**. The backend uses loopback port **8001**. The starter checks both ports and leaves existing services alone. It also seeds the opening scene on every start, so a restart always returns to “Hey Alex.” Stop with Ctrl+C. To use other available ports:

```bash
./scripts/start --backend-port 8011 --frontend-port 5184
```

The starter sets the matching proxy/origin automatically. If you run services separately, keep `DINEOS_ALLOWED_ORIGIN`, `DINEOS_API_PROXY` and the selected ports consistent. Use one backend worker for this local demonstration. The SQLite boundary serializes competing commands, but this is not a production multi-worker job system.

Without an API key, deterministic screens, commands, and tests run; live voice is disabled and a planner request reports missing configuration instead of fabricating a model result.

## Rehearse the loop

1. Keep **Demo view** selected and click **Talk with Mira**. Mira greets Alex by name and remembers the chicken biryani from the last visit.
2. Say: “I want to try a different chicken dish. What do you recommend?” The tablet changes to three visual recommendations while the observer rail explains the use of context.
3. Ask: “What is chicken tikka masala?” Mira explains it as the tablet moves to the dish. Say: “I’d like to go for it.”
4. Mira should volunteer the real tradeoff: tikka masala is currently about **40 minutes**, while the similar-but-brighter kadai chicken is about **12 minutes**. The tablet shows both dishes side by side.
5. Choose kadai chicken, then say **medium** when Mira asks about spice. Review the exact dish, side, price and timing, then tap **Yes, send my order**.
6. Show the kitchen acknowledgment, the included basmati rice and Mira's natural “Would you like anything else?” close. Say “No, that's it for now.”

The visible buttons mirror every voice step, so the full story is still demonstrable if microphone access or an API key is unavailable. **Simulate a rush** in the observer rail is an optional second beat showing how a cook report reaches both the planner and Mira.

Start and stop voice with the visible button. Reconnect restores current structured state; it never resends an order. Clear voice confirmation is supported only after a server-recorded exact review. Tap confirmation is the deterministic recording path. If you change your mind, request a fresh review. Decline preserves any already-confirmed meal.

The **Guest only** toggle shows only the diner experience. **Demo view** is an observer composite; a real diner would not see other tables’ operational details.

## Reset and recover

The subtle restart icon in the top-right invalidates old offers/actions, reseeds this app, and starts a fresh voice session if voice was connected. Starting the app also reseeds the opening scene automatically. The shell equivalent targets only a verified DineOS service:

```bash
./scripts/reset
# Different backend port:
./scripts/reset --url http://127.0.0.1:8011
```

No generated data files need to be manually deleted. External shell reset disconnects old voice; use Start/Reconnect in the browser. Restarting the backend with the same database preserves state, command deduplication and pending actions. Queued planning work is durable and resumed at startup. Do not run two demos against the same database unless you intend shared state.

Coordinator controls expand below the kitchen panel: pause/resume, one-decision sequence override, source-tagged capacity correction, automatic/manual/fail-next acknowledgment, and fresh decision. Overrides use the same feasibility/commitment guards. Pause blocks new autonomous actions at the server boundary; it does not undo already acknowledged work. A held or failed request never becomes active. If an order acknowledgment fails, allocation is released, an exception is visible, and a new reviewed choice requires fresh consent.

## Configuration

| Variable | Default / use |
| --- | --- |
| `OPENAI_API_KEY` | Your server-held key; required for actual planner and Realtime calls |
| `DINEOS_PLANNER_MODEL` | `gpt-5-mini`; separate server-side Responses planner |
| `DINEOS_REALTIME_MODEL` | `gpt-realtime-2.1`; browser WebRTC voice |
| `DINEOS_VOICE` | `marin` |
| `DINEOS_SQLITE_PATH` | `backend/data/dineos.sqlite3` |
| `DINEOS_ALLOWED_ORIGIN` | `http://127.0.0.1:5174`; starter overrides for chosen frontend port |
| `DINEOS_API_PROXY` | `http://127.0.0.1:8001`; starter sets matching backend port |

## Verify

```bash
pnpm test
pnpm build
.venv/bin/python -m pytest -q
```

Tests use deterministic fixtures and injected planner doubles. They cover exact/stale/changed confirmation, atomic last-unit contention, duplicate/lost-response replay, interrupted generation rejection, failed acknowledgments, preserved commitments and started work, pause/override/correction, reset, persistence and the event → planner → validator → simulator loop. They do not prove live audio.

A bounded **real model call** with no demo-state mutation:

```bash
.venv/bin/python -m scripts.live_planner_probe
```

## Architecture and truth boundaries

```text
Diner speech ─ WebRTC / Realtime ─ validated restaurant UI tool
                                      │
Diner tap ─ exact offer confirmation ──┤
                                      ▼
           Versioned commands → SQLite state service
                                      │
Cook report ─ source-tagged fact ──────┤
                                      ▼
       Responses planner → typed proposal → deterministic validator
                                      │
                        requested simulator action
                                      │
                        acknowledged / failed result
                                      │
                 shared diner UI + kitchen + voice context
```

Operational state version, presentation revision and speech response generation are distinct. Every external mutation is a unique command with observed versions. Exact retries return stored results; changed payloads or stale terms conflict. Started work and accepted ready-by commitments are protected; impossible constraints become explicit exceptions. Only acknowledged sequence/order actions are active. Interest and review reserve nothing; confirmation atomically allocates stock and time. Confirmed meal contents are never silently substituted.

This is a **local hackathon prototype**, not a production restaurant integration. Kitchen inputs, workflow events, stock and prices are fixtures. The scenario clock is paused at a service checkpoint; durations are synthetic assumptions, not real-time ETA predictions or measured wait improvements. “Started” means the simulator reports preparation started; “ready” means ready for service, not served. No payments, live POS/KDS, production identity, allergy verification, multi-diner UI, audio/transcript retention, adoption claims or hardware deployment.

See [third-party credits](docs/THIRD_PARTY.md) for package attribution and license details.
