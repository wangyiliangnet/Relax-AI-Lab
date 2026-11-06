import pytest
from fastapi.testclient import TestClient

from relax_ai_lab.app import create_app
from relax_ai_lab.config import Settings


@pytest.mark.parametrize("path", ["/deployment", "/prompts", "/simulate", "/history"])
def test_page_deep_links_return_html(tmp_path, path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert "<title>Relax AI Lab</title>" in response.text


def test_root_opens_simulator(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        response = client.get("/", follow_redirects=False)
        assert response.status_code == 307
        assert response.headers["location"] == "/simulate"
