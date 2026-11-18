from typing import List, Literal, Optional
from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=2, max_length=120)
    institution: str = Field(default="", max_length=200)
    role: str = Field(default="Researcher", max_length=64)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class FirebaseLoginRequest(BaseModel):
    idToken: str = Field(min_length=10)


class AuthUserResponse(BaseModel):
    id: str
    uid: str
    email: str
    name: str
    institution: str
    role: str
    authProvider: str = "local"
    consentAnalytics: bool
    consentRetention: bool


class TokenResponse(BaseModel):
    token: str
    user: AuthUserResponse


class SettingsUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=120)
    institution: Optional[str] = Field(default=None, max_length=200)
    role: Optional[str] = Field(default=None, max_length=64)
    consentAnalytics: Optional[bool] = None
    consentRetention: Optional[bool] = None


class SectionItem(BaseModel):
    id: str
    heading: str
    content: str
    approved: Optional[bool] = None


class DocumentCreateTextRequest(BaseModel):
    title: str = Field(default="Untitled Manuscript", max_length=255)
    rawText: str = Field(min_length=10)
    format: str = "txt"
    citationStyle: Literal["IEEE", "APA"] = "IEEE"
    projectId: Optional[str] = None


class DocumentUpdateRequest(BaseModel):
    title: Optional[str] = None
    citationStyle: Optional[Literal["IEEE", "APA"]] = None
    sections: Optional[List[SectionItem]] = None
    references: Optional[List[str]] = None
    versionLabel: Optional[str] = None


class GithubProjectRequest(BaseModel):
    repoUrl: str = Field(min_length=12, max_length=512)
    title: Optional[str] = None
    domain: str = "Computer Science"


class CrossCheckRequest(BaseModel):
    projectId: str
    documentId: Optional[str] = None
    customText: Optional[str] = None


class GeneratePaperRequest(BaseModel):
    projectId: Optional[str] = None
    title: str = Field(min_length=3, max_length=255)
    synopsis: str = ""
    datasetNotes: str = ""
    experimentalResults: str = ""
    literatureNotes: str = ""
    citationStyle: Literal["IEEE", "APA"] = "IEEE"
    engineMode: Literal["gemini", "local"] = "gemini"


class SimilarityAnalyzeRequest(BaseModel):
    documentId: Optional[str] = None
    text: Optional[str] = None
    title: str = "Ad-hoc Similarity Scan"
    queryArxiv: bool = True


class WritingAnalyzeRequest(BaseModel):
    documentId: Optional[str] = None
    text: Optional[str] = None
    title: str = "Linguistic Telemetry Scan"


class CitationVerifyRequest(BaseModel):
    documentId: Optional[str] = None
    referencesText: Optional[str] = None
    claimText: Optional[str] = None
    sourceTitle: Optional[str] = None


class QualityEvaluateRequest(BaseModel):
    documentId: Optional[str] = None
    text: Optional[str] = None
    title: str = "Ad-hoc Manuscript Evaluation"
    includeLlmCritique: bool = False


class IntegrityAuditRequest(BaseModel):
    documentId: str
    projectId: Optional[str] = None


class RefinementStartRequest(BaseModel):
    documentId: str
    mode: Literal[
        "Academic Clarity",
        "Technical Precision",
        "Concise Academic Writing",
        "Formal Research Style",
        "Readability Improvement",
    ] = "Academic Clarity"
    scope: Literal["whole_paper", "selected_sections", "single_paragraph"] = "whole_paper"
    sectionIds: Optional[List[str]] = None
    paragraphIndex: Optional[int] = None
    preserveTerms: str = ""
    engineMode: Literal["gemini", "local"] = "gemini"


class RefinementApproveRequest(BaseModel):
    approvedSections: Optional[List[SectionItem]] = None
