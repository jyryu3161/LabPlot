from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# .env lives at project root (parent of backend/)
_ENV_FILE = Path(__file__).parent.parent.parent / ".env"


class Settings(BaseSettings):
    database_url: str = "postgresql://labplot:labplot@localhost:5432/labplot"

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
    upload_dir: str = "/app/backend/static/uploads"
    figures_dir: str = "/app/backend/static/figures"

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
