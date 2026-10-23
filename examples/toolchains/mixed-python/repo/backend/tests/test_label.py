import json
from pathlib import Path

from fx_backend import label

CONTRACT = json.loads((Path(__file__).parents[2] / "contract" / "label.json").read_text())


def test_backend_label_follows_contract():
    for n, expected in CONTRACT["examples"]:
        assert label(n) == expected
