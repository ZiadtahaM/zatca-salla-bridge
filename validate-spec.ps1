# validate-spec.ps1 - NotebookLM Grounding & Spec Verification Lever
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$Query,

    [switch]$Status,
    [switch]$Compile,
    [switch]$Bypass,
    [string]$Reason = "Developer manual bypass"
)

$GuardScript = "C:\Users\DevUser\.gemini\config\hooks\notebook_grounding_guard.py"

if ($Status) {
    & python $GuardScript --status
    exit $LASTEXITCODE
}

if ($Compile) {
    & python $GuardScript --compile-spec
    exit $LASTEXITCODE
}

if ($Bypass) {
    & python $GuardScript --bypass $Reason
    exit $LASTEXITCODE
}

if (-not $Query) {
    Write-Host "Usage: .\validate-spec.ps1 '<question to verify against NotebookLM>'"
    Write-Host "       .\validate-spec.ps1 -Status"
    Write-Host "       .\validate-spec.ps1 -Compile"
    Write-Host "       .\validate-spec.ps1 -Bypass -Reason '<emergency note>'"
    exit 1
}

& python $GuardScript --validate $Query
exit $LASTEXITCODE
