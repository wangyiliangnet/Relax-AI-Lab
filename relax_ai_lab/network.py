import ipaddress
import socket

import psutil

from .config import Settings

PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
    )
)


def lan_addresses():
    result = []
    try:
        states = psutil.net_if_stats()
        for interface, addresses in psutil.net_if_addrs().items():
            if interface not in states or not states[interface].isup:
                continue
            for address in addresses:
                if address.family != socket.AF_INET:
                    continue
                ip = ipaddress.ip_address(address.address)
                if any(ip in network for network in PRIVATE_NETWORKS):
                    result.append({"interface": interface, "address": str(ip)})
    except (OSError, psutil.Error):
        pass
    return sorted(result, key=lambda item: (item["interface"], item["address"]))


def connection_info(settings: Settings, request_url: str):
    try:
        bind_ip = ipaddress.ip_address(settings.listen_host)
    except ValueError:
        bind_ip = None
    enabled = settings.listen_host != "localhost" and not (bind_ip and bind_ip.is_loopback)
    addresses = lan_addresses()
    if bind_ip and not bind_ip.is_unspecified and enabled:
        addresses = [item for item in addresses if item["address"] == str(bind_ip)]
    candidates = [
        {**item, "baseURL": f"http://{item['address']}:{settings.listen_port}"} for item in addresses
    ]
    return {
        "listenHost": settings.listen_host,
        "listenPort": settings.listen_port,
        "lanEnabled": bool(enabled),
        "requestBaseURL": request_url.rstrip("/"),
        "addresses": candidates,
    }
