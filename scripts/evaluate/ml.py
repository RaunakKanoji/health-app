"""Run from the repository root with services/ml/.venv/bin/python."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "ml"))
from careloop_ml.evaluate import main

if __name__ == "__main__":
    main()
