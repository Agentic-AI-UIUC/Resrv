"""Tests for the email service — Resend is mocked."""

from __future__ import annotations

from unittest.mock import patch, MagicMock
import pytest

from config import settings
from email_service import send_verification_email

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _fake_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure resend_api_key is set so the guard clause doesn't short-circuit."""
    monkeypatch.setattr(settings, "resend_api_key", "re_test_fake_key")


async def test_send_verification_email_calls_resend():
    """send_verification_email calls resend.Emails.send with correct params."""
    mock_resend = MagicMock()
    mock_resend.Emails.send.return_value = {"id": "fake-id"}

    with patch("email_service.resend", mock_resend):
        result = await send_verification_email("user@illinois.edu", "123456")

    assert result is True
    mock_resend.Emails.send.assert_called_once()
    call_args = mock_resend.Emails.send.call_args[0][0]
    assert call_args["to"] == ["user@illinois.edu"]
    assert "123456" in call_args["html"]


async def test_send_verification_email_handles_failure():
    """send_verification_email returns False on exception."""
    mock_resend = MagicMock()
    mock_resend.Emails.send.side_effect = Exception("API error")

    with patch("email_service.resend", mock_resend):
        result = await send_verification_email("user@illinois.edu", "123456")

    assert result is False
