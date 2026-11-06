import socket
from types import SimpleNamespace

from fastapi.testclient import TestClient

from relax_ai_lab import __main__ as launcher
from relax_ai_lab import network
from relax_ai_lab.app import create_app
from relax_ai_lab.config import Settings


def test_connection_filters_loopback_public_down_and_ipv6(monkeypatch):
    def address(value, family=socket.AF_INET):
        return SimpleNamespace(family=family, address=value)

    monkeypatch.setattr(
        network.psutil,
        "net_if_addrs",
        lambda: {
            "lo0": [address("127.0.0.1")],
            "en0": [address("192.168.3.9"), address("fe80::1", socket.AF_INET6)],
            "wan": [address("8.8.8.8")],
            "down": [address("10.0.0.1")],
            "vpn": [address("10.8.0.2")],
        },
    )
    monkeypatch.setattr(
        network.psutil,
        "net_if_stats",
        lambda: {name: SimpleNamespace(isup=name != "down") for name in ("lo0", "en0", "wan", "down", "vpn")},
    )
    assert network.lan_addresses() == [
        {"interface": "en0", "address": "192.168.3.9"},
        {"interface": "vpn", "address": "10.8.0.2"},
    ]


def test_listener_mode_and_port_are_reflected(monkeypatch):
    monkeypatch.setattr(network, "lan_addresses", lambda: [{"interface": "en0", "address": "192.168.3.9"}])
    for host in ("127.0.0.1", "127.0.0.2", "localhost", "::1"):
        assert not network.connection_info(Settings(listen_host=host), "http://localhost:8765/")["lanEnabled"]
    info = network.connection_info(
        Settings(listen_host="0.0.0.0", listen_port=9876), "http://192.168.3.9:9876/"
    )
    assert info["lanEnabled"] and info["addresses"][0]["baseURL"] == "http://192.168.3.9:9876"
    assert info["requestBaseURL"] == "http://192.168.3.9:9876"


def test_lan_endpoint_and_same_origin_write(tmp_path, monkeypatch):
    monkeypatch.setattr(network, "lan_addresses", lambda: [])
    app = create_app(Settings(data_dir=tmp_path, listen_host="0.0.0.0", listen_port=9876))
    with TestClient(app, base_url="http://192.168.3.9:9876") as client:
        info = client.get("/lab/connection").json()
        assert info["listenHost"] == "0.0.0.0" and info["listenPort"] == 9876
        assert "api_key" not in info
        profile = client.get("/lab/profile").json()
        assert (
            client.put(
                "/lab/profile", json=profile, headers={"Origin": "http://192.168.3.9:9876"}
            ).status_code
            == 200
        )
        assert (
            client.put("/lab/profile", json=profile, headers={"Origin": "https://other.example"}).status_code
            == 403
        )


def test_cli_overrides_are_shared_with_factory(monkeypatch):
    calls = []
    monkeypatch.setattr(launcher.Settings, "from_env", lambda: Settings())
    monkeypatch.setattr(launcher.uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(launcher.os, "environ", {})
    monkeypatch.setattr("sys.argv", ["relax_ai_lab", "--host", "0.0.0.0", "--port", "9876"])
    launcher.main()
    assert calls[0][1]["host"] == "0.0.0.0" and calls[0][1]["port"] == 9876
    assert launcher.os.environ["LAB_HOST"] == "0.0.0.0" and launcher.os.environ["LAB_PORT"] == "9876"
