"""Reproducible synthetic-only research report; no patient or clinical outcomes claim."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.metrics import (
    average_precision_score, brier_score_loss, confusion_matrix,
    precision_score, recall_score, roc_auc_score,
)

from .data import FEATURES, OUTCOME_DAY, PREDICTION_DAY, generate_cohort
from .model import baseline_probability, split_cohort, train_model


def metrics(y: np.ndarray, probability: np.ndarray, threshold: float = 0.5) -> dict[str, Any]:
    """Denominator: mature, held-out referrals; undefined discrimination is null."""
    prediction = (probability >= threshold).astype(int)
    two_classes = len(np.unique(y)) == 2
    calibration = []
    for lower in np.arange(0, 1, 0.1):
        upper = round(float(lower + 0.1), 10)
        mask = (probability >= lower) & (probability < upper if upper < 1 else probability <= upper)
        if int(mask.sum()):
            calibration.append({
                "lower": round(float(lower), 2), "upper": upper,
                "n": int(mask.sum()), "mean_predicted": float(probability[mask].mean()),
                "observed_fraction": float(y[mask].mean()),
            })
    ece = sum(bin_["n"] * abs(bin_["mean_predicted"] - bin_["observed_fraction"])
              for bin_ in calibration) / len(y)
    return {
        "n": len(y), "positive_n": int(y.sum()), "prevalence": float(y.mean()),
        "auroc": float(roc_auc_score(y, probability)) if two_classes else None,
        "auprc": float(average_precision_score(y, probability)) if two_classes else None,
        "brier_score": float(brier_score_loss(y, probability)),
        "threshold": threshold,
        "precision": float(precision_score(y, prediction, zero_division=0)),
        "recall": float(recall_score(y, prediction, zero_division=0)),
        "confusion_matrix": confusion_matrix(y, prediction, labels=[0, 1]).tolist(),
        "confusion_matrix_layout": "[[true_negative, false_positive], [false_negative, true_positive]]",
        "calibration": calibration, "expected_calibration_error_10_bins": float(ece),
        "precision_zero_division_policy": "0 when no positive prediction; denominator still reported",
        "predicted_positive_n": int(prediction.sum()),
    }


def evaluate(seed: int = 2026, patients: int = 1200, with_shap: bool = False,
             with_xgboost: bool = False) -> dict[str, Any]:
    cohort = generate_cohort(seed=seed, patients=patients)
    train, validation, test, censored = split_cohort(cohort, seed)
    model = train_model(train, seed)
    test_probabilities = model.pipeline.predict_proba(test.x)[:, 1]
    models = {
        "deterministic_baseline": metrics(test.y, np.asarray(baseline_probability(test.x))),
        "logistic_regression": metrics(test.y, test_probabilities),
    }
    subgroup_results = {}
    for attribute in ("language", "provider"):
        values = getattr(test, attribute)
        subgroup_results[attribute] = {
            str(group): metrics(test.y[values == group], test_probabilities[values == group])
            for group in np.unique(values)
        }
    explanations: dict[str, Any] = {
        "method": "exact standardized linear log-odds contributions",
        "example": model.predict(test.x[0].tolist()),
        "shap": {"status": "not_requested", "reason": "Optional dependency; exact linear contributions always available"},
    }
    if with_shap:
        try:
            import shap
            scaled_train = model.pipeline.named_steps["scale"].transform(train.x)
            scaled_test = model.pipeline.named_steps["scale"].transform(test.x)
            explainer = shap.LinearExplainer(model.pipeline.named_steps["classifier"], scaled_train)
            values = np.asarray(explainer.shap_values(scaled_test))
            explanations["shap"] = {
                "status": "computed", "output_space": "log_odds",
                "mean_absolute_contribution": dict(zip(FEATURES, np.abs(values).mean(axis=0).tolist(), strict=True)),
            }
        except ImportError:
            explanations["shap"] = {"status": "unavailable", "reason": "Install the explain extra to use SHAP"}
    optional_xgboost = {"status": "not_requested"}
    if with_xgboost:
        try:
            from xgboost import XGBClassifier
            comparative = XGBClassifier(n_estimators=80, max_depth=3, learning_rate=0.05,
                                        random_state=seed, n_jobs=1, eval_metric="logloss")
            comparative.fit(train.x, train.y)
            models["xgboost"] = metrics(test.y, comparative.predict_proba(test.x)[:, 1])
            optional_xgboost = {"status": "computed", "tuning": "fixed parameters; no test tuning"}
        except ImportError:
            optional_xgboost = {"status": "unavailable", "reason": "Install the compare extra"}
    sets = [set(part.patient_ids.tolist()) for part in (train, validation, test)]
    patient_overlap = len((sets[0] & sets[1]) | (sets[0] & sets[2]) | (sets[1] & sets[2]))
    return {
        "report_type": "C_predictive_model_performance",
        "synthetic_only": True,
        "clinical_validation": False,
        "seed": seed,
        "target": "No completed referral encounter by day 30 among referrals still open at day 7",
        "prediction_day": PREDICTION_DAY,
        "outcome_day": OUTCOME_DAY,
        "features": list(FEATURES),
        "excluded_features": ["future_encounter", "future_closure", "future_contact", "future_referral_response", "patient_id", "language", "provider"],
        "cohort": {
            "patients_generated": patients, "referrals_generated": len(cohort.y),
            "incomplete_windows_excluded": censored,
            "train_referrals": len(train.y), "validation_referrals": len(validation.y),
            "test_referrals": len(test.y),
            "train_patients": len(sets[0]), "validation_patients": len(sets[1]), "test_patients": len(sets[2]),
            "patient_overlap": patient_overlap,
        },
        "operating_threshold": {"value": 0.5, "selected": "prespecified demonstration threshold, not a clinical cutoff"},
        "model_version": model.version,
        "models": models,
        "validation_logistic_regression": metrics(validation.y, model.pipeline.predict_proba(validation.x)[:, 1]),
        "subgroups": subgroup_results,
        "explanations": explanations,
        "optional_xgboost": optional_xgboost,
        "limitations": [
            "Generated labels encode assumed operational relationships; these scores cannot estimate real-world effectiveness.",
            "No real patient data or prospective clinical validation; never use for clinical triage or case closure.",
            "Subgroup comparisons describe synthetic generation only and do not establish fairness.",
            "Patient-group split prevents repeated-patient leakage; prospective external temporal validation is still required.",
            "Confidence intervals and real-world drift monitoring are not estimated by this demonstration report.",
            "Incomplete 30-day observation windows are excluded, not assigned negative labels.",
        ],
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Synthetic operational model evaluation", "",
        "**Research demonstration only. No clinical validation or production approval.**", "",
        f"Seed: `{report['seed']}`. Model: `{report['model_version']}`.", "",
        report["target"] + ".", "",
        "The baseline and model are evaluated on the same patient-disjoint test referrals. "
        "The prespecified probability threshold is 0.5 and has no clinical meaning.", "",
        "| Model | Test referrals | AUROC | AUPRC | Brier | Precision | Recall |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for name, result in report["models"].items():
        lines.append(f"| {name} | {result['n']} | {result['auroc']:.4f} | {result['auprc']:.4f} | "
                     f"{result['brier_score']:.4f} | {result['precision']:.4f} | {result['recall']:.4f} |")
    lines.extend(["", "## Denominators and censoring", "", "```json",
                  json.dumps(report["cohort"], indent=2), "```", "",
                  "## Confusion matrices and calibration", ""])
    for name, result in report["models"].items():
        lines.extend([f"### {name}", "", f"`{result['confusion_matrix']}` (rows actual 0/1; columns predicted 0/1).", "",
                      f"10-bin expected calibration error: {result['expected_calibration_error_10_bins']:.4f}.", "",
                      "| Predicted interval | N | Mean prediction | Observed positive fraction |",
                      "|---|---:|---:|---:|"])
        for bin_ in result["calibration"]:
            lines.append(f"| {bin_['lower']:.1f}–{bin_['upper']:.1f} | {bin_['n']} | {bin_['mean_predicted']:.4f} | {bin_['observed_fraction']:.4f} |")
        lines.append("")
    lines.extend(["## Synthetic subgroup comparisons", "",
                  "| Attribute | Group | N | AUROC | Brier | Recall |",
                  "|---|---|---:|---:|---:|---:|"])
    for attribute, groups in report["subgroups"].items():
        for name, result in groups.items():
            auc = f"{result['auroc']:.4f}" if result["auroc"] is not None else "undefined"
            lines.append(f"| {attribute} | {name} | {result['n']} | {auc} | {result['brier_score']:.4f} | {result['recall']:.4f} |")
    lines.extend(["", "## Limitations", ""] + [f"- {item}" for item in report["limitations"]])
    lines.extend(["", "The JSON report includes validation-split results, calibration bins and explanations.", ""])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate synthetic operational research models")
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--patients", type=int, default=1200)
    parser.add_argument("--output", type=Path, default=Path("docs/evaluation"))
    parser.add_argument("--shap", action="store_true")
    parser.add_argument("--xgboost", action="store_true")
    args = parser.parse_args()
    report = evaluate(args.seed, args.patients, args.shap, args.xgboost)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "model-results.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    (args.output / "model-results.md").write_text(render_markdown(report))
    print(f"Synthetic evaluation written to {args.output}; patient overlap={report['cohort']['patient_overlap']}")


if __name__ == "__main__":
    main()
