from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Discord
    discord_token: str = ""
    discord_guild_id: int = 0
    queue_channel_id: int = 0
    admin_channel_id: int = 0

    # OpenAI (for DM intent classification)
    openai_api_key: str = ""

    # Email verification (Resend)
    resend_api_key: str = ""
    verification_code_expiry_minutes: int = 10

    # Database
    database_path: str = "reserv.db"

    # Queue behaviour
    queue_reset_hour: int = 0  # midnight
    reminder_minutes: int = 30
    grace_minutes: int = 10
    agent_tick_seconds: int = 10

    # Public mode (skip email verification)
    public_mode: bool = True  # default True for MVP (no verification yet)

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
