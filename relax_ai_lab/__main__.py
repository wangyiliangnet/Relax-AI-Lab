import argparse
import os

import uvicorn

from .config import Settings


def main():
    settings = Settings.from_env()
    parser = argparse.ArgumentParser(description="Run the Relax AI development service")
    parser.add_argument("--host", default=settings.listen_host, help="0.0.0.0 enables IPv4 LAN access")
    parser.add_argument("--port", type=int, default=settings.listen_port)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    # The factory and reloader read the same effective configuration as the listener.
    os.environ["LAB_HOST"] = args.host
    os.environ["LAB_PORT"] = str(args.port)
    uvicorn.run(
        "relax_ai_lab.app:create_app", factory=True, host=args.host, port=args.port, reload=args.reload
    )


if __name__ == "__main__":
    main()
