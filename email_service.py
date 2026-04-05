"""Email service — sends verification codes via Resend."""

from __future__ import annotations

import logging

import resend

from config import settings

log = logging.getLogger(__name__)


async def send_verification_email(to: str, code: str) -> bool:
    """Send a verification code email. Returns True on success, False on failure."""
    if not settings.resend_api_key:
        log.error("RESEND_API_KEY not configured — cannot send verification email")
        return False

    resend.api_key = settings.resend_api_key

    try:
        resend.Emails.send({
            "from": "SCD Queue <verify@updates.illinois.edu>",
            "to": [to],
            "subject": "Your SCD Queue Verification Code",
            "html": (
                f"<h2>Your verification code</h2>"
                f"<p style='font-size:32px; font-weight:bold; letter-spacing:8px;'>{code}</p>"
                f"<p>Enter this code in your Discord DM with SCD Bot to verify your email.</p>"
                f"<p>This code expires in {settings.verification_code_expiry_minutes} minutes.</p>"
            ),
        })
        log.info("Verification email sent to %s", to)
        return True
    except Exception:
        log.exception("Failed to send verification email to %s", to)
        return False
