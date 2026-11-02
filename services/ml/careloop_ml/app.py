"""Private, synthetic-only prediction service; callers retain all clinical authority."""
from __future__ import annotations

import hmac
import os
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from time import monotonic
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from .data import FEATURES, OUTCOME_DAY, PREDICTION_DAY
from .model import demo_model, fallback_prediction


class PredictionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    days_waiting: Annotated[int, Field(ge=0, le=7)]
    prior_no_shows: Annotated[int, Field(ge=0, le=20)]
    contact_attempts: Annotated[int, Field(ge=0, le=20)]
    referral_rejected: StrictBool
    patient_acknowledged: StrictBool
    transport_barrier: StrictBool

    def values(self) -> list[float]:
        return [float(getattr(self, feature)) for feature in FEATURES]


class Settings:
    def __init__(self, demo_mode: bool, internal_key: str, force_baseline: bool = False):
        if not demo_mode:
            raise ValueError("ML service requires DEMO_MODE=true; production use is disabled")
        if len(internal_key) < 32:
            raise ValueError("ML_INTERNAL_KEY must contain at least 32 characters")
        self.internal_key = internal_key
        self.force_baseline = force_baseline

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            demo_mode=os.environ.get("DEMO_MODE", os.environ.get("CARELOOP_DEMO_MODE")) == "true",
            internal_key=os.environ.get("ML_INTERNAL_KEY", ""),
            force_baseline=os.environ.get("ML_FORCE_BASELINE") == "true",
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        configuration = settings or Settings.from_environment()
        application.state.settings = configuration
        application.state.model = None
        if not configuration.force_baseline:
            try:
                application.state.model = demo_model()
            except (ValueError, RuntimeError, ImportError):
                # Fail visibly to operational baseline; no patient payload is logged.
                application.state.model = None
        yield

    application = FastAPI(
        title="CareLoop synthetic operational research",
        version="0.1.0",
        description="No clinical validation. Scores must never set medical urgency or close care episodes.",
        lifespan=lifespan,
    )
    requests: dict[str, deque[float]] = defaultdict(deque)

    @application.exception_handler(RequestValidationError)
    async def invalid_input(_request: Request, _error: RequestValidationError):
        # Do not reflect raw payloads, unknown field names, non-finite values or PHI.
        return JSONResponse(status_code=422, content={"detail": "Expected all six bounded operational features; unknown or invalid values are rejected"})

    @application.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def authorized(
        request: Request,
        x_internal_key: Annotated[str | None, Header()] = None,
    ) -> None:
        expected = request.app.state.settings.internal_key
        if x_internal_key is None or not hmac.compare_digest(x_internal_key, expected):
            raise HTTPException(401, "Internal service authentication required")
        # Single service identity, not patient identifiers; bounded one-key rate history.
        history = requests["internal"]
        now = monotonic()
        while history and history[0] < now - 60:
            history.popleft()
        if len(history) >= 120:
            raise HTTPException(429, "Prediction rate limit exceeded")
        history.append(now)

    @application.get("/health")
    async def health(request: Request):
        return {
            "status": "ok" if request.app.state.model is not None else "degraded",
            "mode": "synthetic-research",
            "fallback": request.app.state.model is None,
        }

    @application.get("/model", dependencies=[Depends(authorized)])
    async def model_info(request: Request):
        model = request.app.state.model
        return {
            "version": model.version if model else "synthetic-baseline-v1",
            "features": FEATURES,
            "prediction_day": PREDICTION_DAY,
            "outcome_day": OUTCOME_DAY,
            "target": "No completed referral encounter by day 30, among referrals open at day 7",
            "synthetic_only": True,
            "operational_only": True,
            "clinical_validation": False,
        }

    @application.post("/predict", dependencies=[Depends(authorized)])
    async def predict(payload: PredictionInput, request: Request):
        model = request.app.state.model
        values = payload.values()
        try:
            result = model.predict(values) if model else fallback_prediction(values)
        except (ValueError, RuntimeError, ArithmeticError):
            result = fallback_prediction(values)
        return {
            **result,
            "synthetic_only": True,
            "operational_only": True,
            "clinical_validation": False,
            "prediction_day": PREDICTION_DAY,
            "outcome_day": OUTCOME_DAY,
            "warning": "Synthetic operational research only. Not a diagnosis, urgency score, or clinical decision.",
        }

    return application


app = create_app()
