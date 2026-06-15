from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse


class AppError(HTTPException):
    """Base application error with structured response."""

    error_code: str = "INTERNAL_ERROR"

    def __init__(self, status_code: int, detail: str, error_code: str | None = None):
        self.error_code = error_code or self.__class__.error_code
        super().__init__(status_code=status_code, detail=detail)


class UnauthorizedError(AppError):
    error_code = "UNAUTHORIZED"

    def __init__(self, detail: str = "Authentication required", error_code: str | None = None):
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=detail,
            error_code=error_code or self.error_code,
        )


class NotFoundError(AppError):
    error_code = "NOT_FOUND"

    def __init__(self, resource: str, resource_id: str | None = None):
        detail = f"{resource} not found"
        if resource_id:
            detail = f"{resource} with id '{resource_id}' not found"
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=detail,
            error_code=f"{resource.upper().replace(' ', '_')}_NOT_FOUND",
        )


class BadRequestError(AppError):
    error_code = "BAD_REQUEST"

    def __init__(self, detail: str, error_code: str | None = None):
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
            error_code=error_code or self.error_code,
        )


class ForbiddenError(AppError):
    error_code = "FORBIDDEN"

    def __init__(self, detail: str = "Permission denied"):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


class ConflictError(AppError):
    error_code = "CONFLICT"

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=detail)


class ValidationError(AppError):
    error_code = "VALIDATION_ERROR"

    def __init__(self, detail: str):
        super().__init__(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail
        )


class InternalError(AppError):
    error_code = "INTERNAL_ERROR"

    def __init__(self, detail: str = "Internal server error"):
        super().__init__(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail
        )


class FileTooLargeError(AppError):
    error_code = "FILE_TOO_LARGE"

    def __init__(self, max_size_mb: int):
        super().__init__(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File size exceeds maximum allowed size of {max_size_mb}MB",
        )


class CycleStateError(AppError):
    error_code = "CYCLE_STATE_ERROR"

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=detail)


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    """Structured error response handler matching design spec."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": {
                "code": exc.error_code,
                "message": exc.detail,
                "errors": [],
            }
        },
    )
