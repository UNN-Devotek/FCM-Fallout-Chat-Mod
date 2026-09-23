#!/usr/bin/env python3
"""Regression test for the tracked widget SWF; CI checks compiled legacy output separately."""

from pathlib import Path
import sys

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from validate_swf import parse_swf  # noqa: E402


def main() -> None:
    root = TOOLS.parent
    artifacts = [root / "hudmodloader-chat" / "FCMChatWidget.swf"]
    for artifact in artifacts:
        result = parse_swf(artifact)
        assert result["signature"] == "FWS", f"{artifact} must be normalized to FWS"
        assert result["version"] == 32, f"{artifact} must target Scaleform SWF v32"
        assert result["endTag"] is True
        assert result["tagCount"] > 0
        assert result["frameCount"] > 0
        print(f"PASS: {artifact} FWS v32 tags={result['tagCount']}")


if __name__ == "__main__":
    main()
