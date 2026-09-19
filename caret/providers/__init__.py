"""HTTP clients for the live providers.

Every one is constructed explicitly. None falls back to a canned response when
its key is missing: each ``from_env`` raises instead, so an unconfigured machine
produces a visible configuration error rather than output that looks like a
model result.

`JevJudge` and `GroqWriter` are the product defaults. The two Gateway presets
are an explicit alternative for exercising the loop with a single Vercel AI
Gateway key; `GatewayJudge` is an LLM classifier and not Jev.
"""

from .gateway import GatewayJudge, GatewayWriter
from .groq import GroqWriter
from .http import ProviderHTTPError
from .jev import JevJudge

__all__ = [
    "GatewayJudge",
    "GatewayWriter",
    "GroqWriter",
    "JevJudge",
    "ProviderHTTPError",
]
