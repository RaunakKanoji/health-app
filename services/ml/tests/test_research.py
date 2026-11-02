from dataclasses import replace
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from careloop_ml.app import Settings, create_app
from careloop_ml.data import PREDICTION_DAY, generate_cohort
from careloop_ml.evaluate import evaluate, metrics, render_markdown
from careloop_ml.model import demo_model, fallback_prediction, split_cohort, train_model

KEY = "synthetic-test-internal-key-minimum-32-characters"
VALID = {"days_waiting": 4, "prior_no_shows": 1, "contact_attempts": 2,
         "referral_rejected": False, "patient_acknowledged": True, "transport_barrier": False}


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app(Settings(True, KEY))) as value:
        yield value


def test_demo_requires_explicit_mode_and_secret():
    with pytest.raises(ValueError, match="DEMO_MODE"):
        Settings(False, KEY)
    with pytest.raises(ValueError, match="32"):
        Settings(True, "short")


def test_group_split_disjoint_and_censored_outcomes_excluded():
    cohort = generate_cohort(2026, 400)
    train, val, test, excluded = split_cohort(cohort, 2026)
    groups = [set(part.patient_ids) for part in (train, val, test)]
    assert not groups[0] & groups[1]
    assert not groups[0] & groups[2]
    assert not groups[1] & groups[2]
    assert excluded > 0
    assert len(train.y) + len(val.y) + len(test.y) + excluded == len(cohort.y)
    for part in (train, val, test):
        assert np.all(part.observed_days >= 30)
        assert np.all(part.feature_days <= PREDICTION_DAY)


def test_temporal_leakage_and_censored_training_rejected():
    cohort = generate_cohort(2026, 100)
    leaked = replace(cohort, feature_days=np.full(len(cohort.y), 8))
    with pytest.raises(ValueError, match="leakage"):
        split_cohort(leaked, 2026)
    with pytest.raises(ValueError, match="Censored"):
        train_model(cohort)


def test_training_and_evaluation_are_reproducible():
    first = evaluate(42, 160)
    second = evaluate(42, 160)
    assert first == second
    assert first["cohort"]["patient_overlap"] == 0
    assert first["synthetic_only"] and not first["clinical_validation"]
    assert first["models"]["deterministic_baseline"]["n"] == first["models"]["logistic_regression"]["n"]
    assert "No clinical validation" in render_markdown(first)


def test_explanation_reconstructs_probability():
    result = demo_model().predict([4, 1, 2, 0, 1, 0])
    logit = result["intercept_log_odds"] + sum(item["log_odds_contribution"] for item in result["factors"])
    assert abs(1 / (1 + math.exp(-logit)) - result["probability"]) < 1e-7
    assert result["explanation_method"].endswith("not SHAP")


def test_single_class_metrics_are_explicitly_undefined():
    result = metrics(np.array([0, 0, 0]), np.array([0.1, 0.2, 0.3]))
    assert result["auroc"] is None and result["auprc"] is None
    assert result["confusion_matrix"] == [[3, 0], [0, 0]]


def test_missing_wrong_credentials_and_extra_role_cannot_authorize(client):
    assert client.post("/predict", json=VALID).status_code == 401
    assert client.post("/predict", headers={"X-Internal-Key": "bad"}, json=VALID).status_code == 401
    assert client.get("/model").status_code == 401
    assert client.post("/predict", headers={"X-Internal-Key": KEY}, json={**VALID, "role": "clinician"}).status_code == 422


def test_authenticated_prediction_is_private_and_operational(client):
    response = client.post("/predict", headers={"X-Internal-Key": KEY}, json=VALID)
    assert response.status_code == 200
    result = response.json()
    assert 0 <= result["probability"] <= 1
    assert result["operational_only"] and result["synthetic_only"]
    assert not result["clinical_validation"]
    assert response.headers["cache-control"] == "no-store"
    assert "urgency" not in result and "diagnosis" not in result


@pytest.mark.parametrize("change", [
    {"days_waiting": 8}, {"prior_no_shows": -1}, {"contact_attempts": 500},
    {"patient_acknowledged": "true"}, {"transport_barrier": None},
    {"days_waiting": float("inf")},
])
def test_invalid_inputs_are_rejected(client, change):
    if change.get("days_waiting") == float("inf"):
        # NaN/Infinity are not valid JSON and must not be accepted as useful scores.
        response = client.post("/predict", headers={"X-Internal-Key": KEY, "Content-Type": "application/json"},
                               content='{"days_waiting": Infinity}')
    else:
        response = client.post("/predict", headers={"X-Internal-Key": KEY}, json={**VALID, **change})
    assert response.status_code == 422


def test_missing_data_is_not_imputed(client):
    body = {key: value for key, value in VALID.items() if key != "transport_barrier"}
    assert client.post("/predict", headers={"X-Internal-Key": KEY}, json=body).status_code == 422


def test_baseline_outage_mode_remains_explicit():
    with TestClient(create_app(Settings(True, KEY, force_baseline=True))) as client:
        assert client.get("/health").json()["status"] == "degraded"
        response = client.post("/predict", headers={"X-Internal-Key": KEY}, json=VALID)
        assert response.status_code == 200
        result = response.json()
        assert result["fallback"] and result["model"] == "deterministic_baseline"
        assert result["probability"] == fallback_prediction([4, 1, 2, 0, 1, 0])["probability"]


def test_runtime_model_failure_returns_marked_fallback(client, monkeypatch):
    def unavailable(_):
        raise RuntimeError("synthetic model unavailable")
    monkeypatch.setattr(client.app.state.model, "predict", unavailable)
    result = client.post("/predict", headers={"X-Internal-Key": KEY}, json=VALID).json()
    assert result["fallback"] and result["operational_only"]
