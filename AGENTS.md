# AGENTS.md

## Cursor Cloud specific instructions

This repo is the standard Emergent stack: a FastAPI backend (`backend/`), a MongoDB
datastore, and a Create React App + CRACO frontend (`frontend/`). The frontend product
is a standalone Web Audio Morse decoder (`frontend/src/components/MorseDecoder.jsx`) and
does not call the backend; the backend is a generic `/api` service (see `backend/server.py`).

### Services and how to run them (dev mode)

- MongoDB: must be running before the backend starts. Start with
  `mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017`.
- Backend (port 8001): `cd backend && uvicorn server:app --host 0.0.0.0 --port 8001 --reload`.
  Verify: `curl localhost:8001/api/` returns `{"message":"Hello World"}`.
- Frontend (port 3000): `cd frontend && BROWSER=none yarn start` (uses `craco start`).

### Non-obvious gotchas

- Env files are git-ignored and are NOT persisted on fresh VMs. The backend reads
  `MONGO_URL`, `DB_NAME`, and optional `CORS_ORIGINS` from `backend/.env` and crashes on
  startup if they are missing. The update script recreates `backend/.env` and `frontend/.env`
  if absent — do not rely on them being committed.
- `backend/requirements.txt` pins `emergentintegrations==0.2.0`, which is only available from
  Emergent's package index. Install it with
  `--extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/`. It is not imported by the
  app code, but pip needs the index to resolve the requirements file.
- Python packages install to `~/.local/bin` (user site). Ensure `~/.local/bin` is on `PATH`
  to use `uvicorn`, `pytest`, `flake8`, `black` directly.
- `backend/pytest.ini` pins `-n 2 --dist loadscope` (pytest-xdist). Run serial with `-n 0`
  (NOT `-p no:xdist`). Do not edit `addopts`. There are currently no backend tests.

### Testing the Morse decoder in the cloud VM (non-obvious)

The decoder does audio edge-detection inside `requestAnimationFrame`. The cloud VM's
software-rendered Chrome runs rAF at a low/irregular frame rate, so it CANNOT resolve the
bundled `frontend/public/sos.wav` / `sos_long.wav` (unit ≈ 80 ms) — decoding produces garbage
and the auto-unit calibration mis-converges. This is a headless-rendering limitation, not an
app bug; on normal hardware at 60 fps those files decode fine. To demonstrate a correct decode
in the VM, use a slow clip (unit ≥ ~300 ms). Recipe that reliably decodes "SOS": FILE tab →
load the slow clip → PLAY → click AUTO next to PITCH (locks ~700 Hz) → turn AUTO-UNIT OFF and
set UNIT to 300 ms → PLAY. Gotcha: the CLEAR button resets UNIT back to 80 ms, so re-set UNIT
after clearing. Screen recording of the computerUse browser does not reliably sync here; prefer
screenshots for evidence.

### Lint / test / build

- Backend lint: `flake8 server.py`, `black --check server.py` (report pre-existing style nits).
- Backend tests: `python3 -m pytest` (no tests defined yet).
- Frontend tests: `CI=true yarn test` (no tests defined yet; runner works).
- Frontend build: `yarn build`. Lint runs via CRACO/ESLint during `yarn start`/`yarn build`.
