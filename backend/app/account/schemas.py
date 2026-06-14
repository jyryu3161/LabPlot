from pydantic import BaseModel, Field


class AccountDeleteRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)
    confirm: str = Field(..., pattern="^DELETE$")
