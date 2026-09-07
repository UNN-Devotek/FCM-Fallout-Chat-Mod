#!/usr/bin/env python3
"""Regression tests for the dependency-free SWF structural validator."""

from pathlib import Path
import sys

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from validate_swf import parse_swf  # noqa: E402


def main() -> None:
    root = TOOLS.parent
    artifacts = [
        root / "FCMBridge.swf",
        root / "hudmodloader-chat" / "FCMChatWidget.swf",
    ]
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
