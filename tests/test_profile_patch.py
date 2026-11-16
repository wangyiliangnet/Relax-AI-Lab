import copy

import pytest
from fastapi.testclient import TestClient

from relax_ai_lab.app import create_app
from relax_ai_lab.config import Settings
from relax_ai_lab.models import ProfilePatch


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        profile = client.get("/lab/profile").json()
        profile.update(
            isPro=True, freeCredits=12.5, proCredits=180, usedCredits=3.5, creditsPerGeneration=2.5
        )
        profile["options"].update(model="mock-test-model", temperature=1.2, maxTokens=4096)
        assert client.put("/lab/profile", json=profile).status_code == 200
        yield client


def test_nested_options_patch_preserves_unspecified_values(client):
    before = client.get("/lab/profile").json()
    response = client.patch("/lab/profile", json={"options": {"maxTokens": 512}})
    assert response.status_code == 200
    expected = copy.deepcopy(before)
    expected["options"]["maxTokens"] = 512
    assert response.json() == expected
    assert client.get("/lab/profile").json() == expected
    assert client.get("/lab/runs").json() == []


def test_entitlement_patch_preserves_generation_config_and_limits(client):
    before = client.get("/lab/profile").json()
    response = client.patch("/lab/profile", json={"isPro": False, "usedCredits": 0})
    assert response.status_code == 200
    assert response.json() == {**before, "isPro": False, "usedCredits": 0}
    assert client.get("/v1/ai/entitlement").json()["usedCredits"] == 0


def test_limits_and_options_can_be_updated_together(client):
    before = client.get("/lab/profile").json()
    response = client.patch(
        "/lab/profile",
        json={
            "freeCredits": 0,
            "creditsPerGeneration": 0.5,
            "options": {"provider": "mock"},
        },
    )
    assert response.status_code == 200
    assert response.json() == {**before, "freeCredits": 0, "creditsPerGeneration": 0.5}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"options": {}},
        {"options": None},
        {"usedCredits": None},
        {"usedCredits": -1},
        {"usedCredits": True},
        {"isPro": 1},
        {"creditsPerGeneration": 0},
        {"options": {"maxTokens": True}},
        {"options": {"temperature": 3}},
        {"options": {"model": "not valid"}},
        {"options": {"unknown": "field"}},
        {"unknown": "field"},
    ],
)
def test_invalid_patch_leaves_profile_unchanged(client, body):
    before = client.get("/lab/profile").json()
    assert client.patch("/lab/profile", json=body).status_code == 422
    assert client.get("/lab/profile").json() == before
    assert client.get("/lab/runs").json() == []


def test_unknown_prompt_does_not_apply_any_fields(client):
    before = client.get("/lab/profile").json()
    response = client.patch("/lab/profile", json={"usedCredits": 0, "options": {"promptVersion": "missing"}})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unknown_prompt"
    assert client.get("/lab/profile").json() == before


def test_patch_model_serializes_only_explicit_fields():
    patch = ProfilePatch.model_validate({"isPro": False, "options": {"provider": "mock"}})
    assert patch.model_dump(exclude_unset=True) == {"isPro": False, "options": {"provider": "mock"}}


def test_original_put_and_get_shape_remain_compatible(client):
    profile = client.get("/lab/profile").json()
    profile["usedCredits"] = 7
    response = client.put("/lab/profile", json=profile)
    assert response.status_code == 200 and response.json() == profile
    assert set(client.get("/lab/profile").json()) == set(profile)


def test_partial_profile_survives_service_restart(tmp_path):
    settings = Settings(data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        expected = client.patch("/lab/profile", json={"isPro": True, "usedCredits": 2.5}).json()
    with TestClient(create_app(settings)) as client:
        assert client.get("/lab/profile").json() == expected
