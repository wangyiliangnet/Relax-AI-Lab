import json
from pathlib import Path

from relax_ai_lab.models import GenerationRequest, GenerationResponse

directory = Path(__file__).resolve().parent.parent / "contracts"
directory.mkdir(exist_ok=True)
for name, model in [("request", GenerationRequest), ("response", GenerationResponse)]:
    (directory / f"{name}.schema.json").write_text(
        json.dumps(model.model_json_schema(), ensure_ascii=False, indent=2) + "\n"
    )
