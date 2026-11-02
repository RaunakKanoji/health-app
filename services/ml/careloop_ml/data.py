"""Deterministic synthetic operational cohorts with an explicit as-of boundary."""
from __future__ import annotations

from dataclasses import dataclass
import numpy as np

FEATURES = (
    "days_waiting",
    "prior_no_shows",
    "contact_attempts",
    "referral_rejected",
    "patient_acknowledged",
    "transport_barrier",
)
PREDICTION_DAY = 7
OUTCOME_DAY = 30


@dataclass(frozen=True)
class Cohort:
    x: np.ndarray
    y: np.ndarray
    patient_ids: np.ndarray
    language: np.ndarray
    provider: np.ndarray
    observed_days: np.ndarray
    feature_days: np.ndarray

    def subset(self, indices: np.ndarray) -> "Cohort":
        return Cohort(**{name: getattr(self, name)[indices] for name in self.__dataclass_fields__})


def generate_cohort(seed: int = 2026, patients: int = 1200) -> Cohort:
    """Two episodes per fictional patient; no Synthea or clinical efficacy claim.

    Every feature is available by day 7. Outcomes happen after the feature cutoff.
    Censored observation windows are retained for explicit exclusion in evaluation.
    """
    if patients < 40:
        raise ValueError("At least 40 synthetic patients are required")
    rng = np.random.default_rng(seed)
    n = patients * 2
    ids = np.repeat(np.arange(patients), 2)
    language_by_patient = rng.choice(["en", "ar"], patients)
    barrier_by_patient = rng.binomial(1, 0.24, patients)
    latent_by_patient = rng.normal(0, 0.55, patients)
    days = rng.integers(0, PREDICTION_DAY + 1, n)
    previous = np.clip(rng.poisson(0.6, n), 0, 5)
    contacts = np.minimum(rng.poisson(1.5, n), days + 1)
    rejected = rng.binomial(1, 0.17, n)
    ack = rng.binomial(1, 0.67, n)
    barrier = barrier_by_patient[ids]
    x = np.column_stack([days, previous, contacts, rejected, ack, barrier]).astype(float)
    # This is a data-generation assumption, not a medical relationship or treatment effect.
    logits = -1.15 + x @ np.array([0.12, 0.48, 0.12, 0.95, -1.05, 0.72])
    logits += latent_by_patient[ids]
    probability = 1 / (1 + np.exp(-logits))
    labels = rng.binomial(1, probability)
    observed_days = np.where(rng.random(n) < 0.08, rng.integers(8, 30, n), OUTCOME_DAY)
    return Cohort(
        x=x,
        y=labels,
        patient_ids=ids,
        language=language_by_patient[ids],
        provider=rng.choice(["screening-centre", "community-clinic"], n),
        observed_days=observed_days,
        feature_days=np.full(n, PREDICTION_DAY),
    )
