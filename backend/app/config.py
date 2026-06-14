from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# .env lives at project root (parent of backend/)
_ENV_FILE = Path(__file__).parent.parent.parent / ".env"


class Settings(BaseSettings):
    database_url: str = "postgresql://labplot:labplot@localhost:5432/labplot"
    APP_BASE_URL: str = "https://labplotai.com"
    ALLOWED_ORIGINS: str = "https://labplotai.com,https://www.labplotai.com,http://localhost:3000,http://127.0.0.1:3000"

    # Auth / JWT
    JWT_SECRET: str = "change-me-in-production-use-a-long-random-string"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Root admin (seeded on startup)
    ROOT_EMAIL: str = "root"
    ROOT_PASSWORD: str = "root"

    # Uploads / storage
    max_upload_size_mb: int = 50
    upload_dir: str = "/app/backend/private/uploads"
    figures_dir: str = "/app/backend/static/figures"
    DATA_ENCRYPTION_KEY: str = ""
    DATA_ENCRYPTION_PREVIOUS_KEYS: str = ""

    # Optional error monitoring
    SENTRY_DSN: str = ""
    SENTRY_ENVIRONMENT: str = "production"
    SENTRY_RELEASE: str = ""

    # Password reset email. If SMTP_HOST is unset, reset links are not emailed.
    PASSWORD_RESET_EXPIRE_MINUTES: int = 30
    PASSWORD_RESET_LOG_TOKEN: bool = False
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "no-reply@labplotai.com"

    # AI provider (admin-switchable at runtime; these are the seed defaults)
    AI_ENABLED: bool = True
    AI_PROVIDER: str = "claude"  # "claude" | "gemini"
    # Claude / Anthropic
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-sonnet-4-6"
    # Google Gemini
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.5-flash"

    # R engine
    RSCRIPT_PATH: str = "/app/.pixi/envs/r-viz/bin/Rscript"
    RENDER_TIMEOUT_SEC: int = 120

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
