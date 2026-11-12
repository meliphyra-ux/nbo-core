# keep-awake.ps1 -LockFile <path> [-MaxHours <n>]: keeps Windows from
# sleeping while <path> exists (checked every 15 s), for at most MaxHours
# (default 8), then exits. Used by rehearse-kubernetes.sh: a sleeping host
# freezes Docker Desktop's WSL VM, and on resume the job's disk went
# read-only (EROFS) and the engine died (SIGBUS, exit 125).
#
# SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) holds the
# request only while this process lives, so a killed helper releases it.
param(
  [Parameter(Mandatory = $true)][string]$LockFile,
  [double]$MaxHours = 8
)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace NboCi -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
if ([NboCi.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) -eq 0) {
  Write-Error 'keep-awake: SetThreadExecutionState failed'
  exit 1
}
$deadline = (Get-Date).AddHours($MaxHours)
try {
  while ((Test-Path -LiteralPath $LockFile) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 15
  }
} finally {
  [void][NboCi.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}
