# CareLoop operational research service

This is a **synthetic-data research demonstration**, not a clinical model. It predicts operational referral non-completion using non-clinical workflow features. Its outputs cannot set medical urgency, prescribe care, approve referrals, or close cases. The application remains usable when this optional service is unavailable.

## Run locally

From the application root (Python 3.12 or newer):

```sh
uv venv services/ml/.venv
uv pip install --python services/ml/.venv/bin/python -r services/ml/requirements.lock
uv pip install --python services/ml/.venv/bin/python --no-deps -e services/ml
DEMO_MODE=true ML_INTERNAL_KEY=local-synthetic-ml-key-2026-minimum32 services/ml/.venv/bin/uvicorn careloop_ml.app:app --app-dir services/ml --host 127.0.0.1 --port 8001
```

Without `uv`, use `python3 -m venv services/ml/.venv` and `services/ml/.venv/bin/python -m pip install -e 'services/ml[test]'`.

The demo flag must be explicit and the internal key must have at least 32 characters. The shown key is public and for a loopback-only synthetic demo. An absent/invalid key or disabled demo mode prevents service startup. `CARELOOP_DEMO_MODE=true` is supported as a compatibility alias. Set `ML_FORCE_BASELINE=true` to demonstrate the marked deterministic fallback. `GET /health` exposes only readiness and fallback mode; `/model` and `/predict` require `X-Internal-Key`.

```sh
curl http://127.0.0.1:8001/predict \
  -H 'X-Internal-Key: local-synthetic-ml-key-2026-minimum32' \
  -H 'Content-Type: application/json' \
  -d '{"days_waiting":4,"prior_no_shows":1,"contact_attempts":2,"referral_rejected":false,"patient_acknowledged":true,"transport_barrier":false}'
```

Only submit known facts at the documented prediction cutoff. Missing values are rejected and **must not be filled with invented zeros or false values by the caller**. Use an “insufficient data” state in the application instead. Input does not contain patient identifiers, clinical observations, protected subgroup attributes or future outcomes. The caller authenticates the user and authorizes access to source records before constructing features.

## Reproduce evaluation and tests

```sh
services/ml/.venv/bin/python -m pytest services/ml
services/ml/.venv/bin/python scripts/evaluate/ml.py --seed 2026 --patients 1200 --output docs/evaluation
```

The output is `model-results.json` and `model-results.md`; both explicitly identify synthetic results. Reports include fixed-threshold confusion matrices, calibration bins, subgroup summaries and excluded incomplete observation windows. To enable optional comparative or explanation libraries, install `services/ml[compare,explain]` and pass `--xgboost` or `--shap`. Missing optional libraries are reported as unavailable rather than fabricated.

The mandatory logistic model always exposes exact standardized linear log-odds contributions. These are **not SHAP values**. When the optional SHAP dependency is installed, evaluation additionally computes real `LinearExplainer` attributions in log-odds space.

## Operational boundaries

The private service uses a bounded shared-service request limit (120 authenticated requests/minute), strict schemas, constant-time key comparison, no request-body logging, and `no-store` responses. Bind it to loopback or a private network. Application users never receive its secret. The static research cohort is generated deterministically at startup; no model is downloaded, no untrusted pickle is loaded, and no clinical database is accessed directly.

This is not production service authentication or a clinical deployment. Workload rate limiting is per process and the research model is not externally validated. See [model methodology](../../docs/evaluation/model-methodology.md) and [limitations](../../docs/evaluation/model-limitations.md).

## Application research endpoint

The Fastify API exposes `POST /api/episodes/:id/research-risk` for an authenticated demonstration administrator with access to that episode. Supply an `Idempotency-Key` header and `{ "syntheticResearchSample": true, "features": { ...six known fields... } }`. This is an explicitly supplied synthetic research sample, not a score silently inferred from incomplete patient records. Successful model calls persist the model version and prediction; unavailable service responses remain visible without changing the episode, urgency or clinical tasks. The backend uses `ML_URL` (default `http://127.0.0.1:8001`) and `ML_INTERNAL_KEY`; the browser never receives the service key.
