"""Custom exceptions for the Deep Research Agent."""

from typing import Optional


class DeepResearchError(Exception):
    """Base exception for all research errors."""
    
    def __init__(self, message: str, details: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.details = details
    
    def __str__(self) -> str:
        if self.details:
            return f"{self.message}: {self.details}"
        return self.message


class ConfigurationError(DeepResearchError):
    """Configuration or environment errors."""
    pass


class PlanningError(DeepResearchError):
    """Errors during research planning phase."""
    pass


class SearchError(DeepResearchError):
    """Errors during web search phase."""
    pass


class RateLimitError(SearchError):
    """Rate limit exceeded on external API."""
    
    def __init__(
        self, 
        message: str = "Rate limit exceeded", 
        retry_after: int = 60,
        service: str = "unknown"
    ):
        super().__init__(message)
        self.retry_after = retry_after
        self.service = service


class ContentExtractionError(DeepResearchError):
    """Failed to extract content from URL."""
    
    def __init__(self, message: str, url: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.url = url
        self.status_code = status_code


class SynthesisError(DeepResearchError):
    """Errors during finding synthesis phase."""
    pass


class ReportGenerationError(DeepResearchError):
    """Errors during report generation phase."""
    pass


class CircuitOpenError(DeepResearchError):
    """Circuit breaker is open, service temporarily unavailable."""
    
    def __init__(self, service: str, retry_after: float):
        super().__init__(f"Circuit breaker open for {service}")
        self.service = service
        self.retry_after = retry_after


class ValidationError(DeepResearchError):
    """Data validation errors."""
    pass


class LLMError(DeepResearchError):
    """Errors from LLM providers."""
    
    def __init__(
        self, 
        message: str, 
        provider: str,
        model: Optional[str] = None,
        is_retryable: bool = True
    ):
        super().__init__(message)
        self.provider = provider
        self.model = model
        self.is_retryable = is_retryable
