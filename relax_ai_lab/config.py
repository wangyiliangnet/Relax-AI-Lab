import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    data_dir: Path = ROOT / "data"
    api_key: str = field(default="", repr=False)
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-flash"
    provider: str = "mock"
    timeout_seconds: float = 90
    listen_host: str = "127.0.0.1"
    listen_port: int = 8765

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env")
        base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or parsed.username or parsed.password or not parsed.hostname:
            raise ValueError("DEEPSEEK_BASE_URL must be an HTTPS URL without embedded credentials")
        provider = os.getenv("AI_PROVIDER", "mock")
        if provider not in {"mock", "deepseek"}:
            raise ValueError("AI_PROVIDER must be mock or deepseek")
        port = int(os.getenv("LAB_PORT", "8765"))
        if not 1 <= port <= 65535:
            raise ValueError("LAB_PORT must be between 1 and 65535")
        return cls(
            data_dir=(ROOT / os.getenv("LAB_DATA_DIR", "data")).resolve(),
            api_key=os.getenv("DEEPSEEK_API_KEY", "").strip(),
            base_url=base_url,
            model=os.getenv("DEEPSEEK_MODEL", "deepseek-flash"),
            provider=provider,
            timeout_seconds=max(1, float(os.getenv("DEEPSEEK_TIMEOUT_SECONDS", "90"))),
            listen_host=os.getenv("LAB_HOST", "127.0.0.1"),
            listen_port=port,
        )
