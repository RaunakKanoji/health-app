"""Deterministic baseline and transparent logistic research model."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .data import Cohort, FEATURES, OUTCOME_DAY, PREDICTION_DAY, generate_cohort

BASELINE_COEFFICIENTS = np.array([0.08, 0.35, 0.08, 0.75, -0.65, 0.45])
BASELINE_INTERCEPT = -0.8


def baseline_probability(values: list[float] | np.ndarray) -> float | np.ndarray:
    values_array = np.asarray(values, dtype=float)
    scores = BASELINE_INTERCEPT + values_array @ BASELINE_COEFFICIENTS
    return 1.0 / (1.0 + np.exp(-scores))


def split_cohort(cohort: Cohort, seed: int) -> tuple[Cohort, Cohort, Cohort, int]:
    """Split whole patients, including all their episodes; then censor per episode."""
    if np.any(cohort.feature_days > PREDICTION_DAY):
        raise ValueError("Temporal leakage: feature after prediction cutoff")
    indices = np.arange(len(cohort.y))
    outer = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed)
    train_val, test = next(outer.split(indices, groups=cohort.patient_ids))
    inner = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed + 1)
    train_local, val_local = next(inner.split(train_val, groups=cohort.patient_ids[train_val]))
    train, val = train_val[train_local], train_val[val_local]
    completed = cohort.observed_days >= OUTCOME_DAY
    excluded = int((~completed).sum())
    return tuple(cohort.subset(part[completed[part]]) for part in (train, val, test)) + (excluded,)


@dataclass
class ResearchModel:
    pipeline: Pipeline
    training_means: np.ndarray
    seed: int
    version: str

    def predict(self, values: list[float]) -> dict[str, Any]:
        array = np.asarray(values, dtype=float).reshape(1, -1)
        if array.shape[1] != len(FEATURES) or not np.all(np.isfinite(array)):
            raise ValueError("Expected six finite as-of operational features")
        probability = float(self.pipeline.predict_proba(array)[0, 1])
        scaler = self.pipeline.named_steps["scale"]
        classifier = self.pipeline.named_steps["classifier"]
        transformed = scaler.transform(array)[0]
        contributions = transformed * classifier.coef_[0]
        intercept = float(classifier.intercept_[0])
        factors = [
            {
                "feature": feature,
                "value": float(array[0, index]),
                "log_odds_contribution": round(float(contributions[index]), 8),
                "direction": "increases" if contributions[index] > 0 else "decreases",
            }
            for index, feature in enumerate(FEATURES)
        ]
        return {
            "probability": round(probability, 8),
            "model": "logistic_regression",
            "version": self.version,
            "factors": sorted(factors, key=lambda item: abs(item["log_odds_contribution"]), reverse=True),
            "intercept_log_odds": intercept,
            "explanation_method": "exact standardized linear log-odds contributions; not SHAP",
            "fallback": False,
        }


def train_model(cohort: Cohort, seed: int = 2026) -> ResearchModel:
    if np.any(cohort.feature_days > PREDICTION_DAY):
        raise ValueError("Temporal leakage: feature after prediction cutoff")
    if np.any(cohort.observed_days < OUTCOME_DAY):
        raise ValueError("Censored outcomes cannot be training labels")
    pipeline = Pipeline([
        ("scale", StandardScaler()),
        ("classifier", LogisticRegression(C=1.0, max_iter=500, random_state=seed)),
    ])
    pipeline.fit(cohort.x, cohort.y)
    fingerprint = hashlib.sha256(
        pipeline.named_steps["classifier"].coef_.tobytes()
        + pipeline.named_steps["classifier"].intercept_.tobytes()
        + pipeline.named_steps["scale"].mean_.tobytes()
        + pipeline.named_steps["scale"].scale_.tobytes()
    ).hexdigest()[:12]
    return ResearchModel(pipeline, cohort.x.mean(axis=0), seed, f"synthetic-logreg-v1-{fingerprint}")


def demo_model(seed: int = 2026) -> ResearchModel:
    train, _, _, _ = split_cohort(generate_cohort(seed=seed), seed)
    return train_model(train, seed)


def fallback_prediction(values: list[float]) -> dict[str, Any]:
    probability = float(baseline_probability(values))
    factors = [
        {"feature": name, "value": value,
         "log_odds_contribution": round(float(value * coefficient), 8),
         "direction": "increases" if value * coefficient > 0 else "decreases"}
        for name, value, coefficient in zip(FEATURES, values, BASELINE_COEFFICIENTS, strict=True)
    ]
    return {
        "probability": round(probability, 8),
        "model": "deterministic_baseline",
        "version": "synthetic-baseline-v1",
        "factors": sorted(factors, key=lambda item: abs(item["log_odds_contribution"]), reverse=True),
        "intercept_log_odds": BASELINE_INTERCEPT,
        "explanation_method": "handwritten synthetic operational baseline; not clinical evidence",
        "fallback": True,
    }
