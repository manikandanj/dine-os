# DineOS

**Guest commitments and kitchen decisions, in sync.**

DineOS is a restaurant-level agent for the coordinator who connects what guests want with what the kitchen can deliver. A diner speaks with the table, the restaurant agent proposes a preparation sequence, deterministic code validates it, and a kitchen simulator acknowledges the action. Every participant sees the same operational state.

The demo combines a spacious diner surface and a compact coordinator view. It includes one recognized, explicitly seeded diner; three menu dishes; three existing tickets; and a timestamped simulated cook report reducing grill capacity.

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

Open **[http://127.0.0.1:5174/](http://127.0.0.1:5174/)**. The backend uses loopback port **8001**. The starter checks both ports and leaves existing services alone. Stop with Ctrl+C. To use other available ports:

```bash
./scripts/start --backend-port 8011 --frontend-port 5184
```

The starter sets the matching proxy/origin automatically. If you run services separately, keep `DINEOS_ALLOWED_ORIGIN`, `DINEOS_API_PROXY` and the selected ports consistent. Use one backend worker for this local demonstration. The SQLite boundary serializes competing commands, but this is not a production multi-worker job system.

Without an API key, deterministic screens, commands, and tests run; live voice is disabled and a planner request reports missing configuration instead of fabricating a model result.

## Rehearse the loop

1. Keep **Demo view** selected. Click **Reset service**, then **Talk to DineOS**.
2. Say: “Just me. I’m interested in the chicken, with food ready within 12 minutes.” This is interest, not an order.
3. Click **Simulate cook report**. The button sends a source-tagged fact, not a prewritten decision. The live planner should protect ticket B by moving it before A; the kitchen acknowledgment makes that plan active.
4. Ask: “What fits my time now?” The chicken is $24 / ~16 minutes; the mushroom bowl is $22 / ~8 minutes. Those are synthetic food-ready estimates.
5. Say: “I’ll take the mushroom bowl.” Review the exact dish, modifiers, price and timing, then **tap Confirm my order**.
6. Show **Kitchen acknowledged**, four commitments on track, and the coordinator’s pause control.

Start and stop voice with the visible button. Reconnect restores current structured state; it never resends an order. Clear voice confirmation is supported only after a server-recorded exact review. Tap confirmation is the deterministic recording path. If you change your mind, request a fresh review. Decline preserves any already-confirmed meal.

The **Table view** toggle shows only the diner experience. **Demo view** is an observer composite; a real diner would not see other tables’ operational details.

## Reset and recover

The browser’s **Reset service** invalidates old offers/actions, reseeds this app, and starts a fresh voice session if voice was connected. The shell equivalent targets only a verified DineOS service:

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
