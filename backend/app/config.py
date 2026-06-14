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
    STORAGE_BACKEND: str = "local"  # local | s3 | filesystem_object
    OBJECT_STORAGE_BUCKET: str = ""
    OBJECT_STORAGE_PREFIX: str = "labplot"
    OBJECT_STORAGE_REGION: str = "us-east-1"
    OBJECT_STORAGE_ENDPOINT_URL: str = ""
    OBJECT_STORAGE_ACCESS_KEY_ID: str = ""
    OBJECT_STORAGE_SECRET_ACCESS_KEY: str = ""
    OBJECT_STORAGE_SSE: str = "AES256"
    OBJECT_STORAGE_KMS_KEY_ID: str = ""
    OBJECT_STORAGE_PUBLIC_BASE_URL: str = ""
    OBJECT_STORAGE_LOCAL_DIR: str = "/app/backend/private/object-store"
    OBJECT_STORAGE_CACHE_DIR: str = "/app/backend/private/object-cache"

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
    ALLOW_INSECURE_DEV_CONFIG: bool = False

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    def validate_runtime_security(self) -> None:
        """Fail fast when deployment secrets are still development defaults."""
        if self.ALLOW_INSECURE_DEV_CONFIG:
            return

        errors: list[str] = []
        jwt = (self.JWT_SECRET or "").strip()
        root_password = (self.ROOT_PASSWORD or "").strip()
        data_key = (self.DATA_ENCRYPTION_KEY or "").strip()
        default_jwt = "change-me-in-production-use-a-long-random-string"

        if not jwt or jwt == default_jwt or "change-me" in jwt.lower() or len(jwt) < 32:
            errors.append("JWT_SECRET must be a long non-default secret")

        weak_root_values = {"root", "admin", "password", "changeme", "change-me"}
        if (
            not root_password
            or root_password.lower() in weak_root_values
            or "change-me" in root_password.lower()
            or len(root_password) < 10
        ):
            errors.append("ROOT_PASSWORD must be a strong non-default password")

        if not data_key or data_key == jwt or "change-me" in data_key.lower() or len(data_key) < 32:
            errors.append("DATA_ENCRYPTION_KEY must be set and distinct from JWT_SECRET")

        if errors:
            raise RuntimeError("Unsafe LabPlot configuration: " + "; ".join(errors))


settings = Settings()
