# Read the existing Nexus file description from the current version of a stable
# v3 mod-file group. v3 identifies the group; v1 exposes the displayed description.
function Get-NexusExistingDescription {
    param(
        [Parameter(Mandatory = $true)] [string]$ModFileId,
        [Parameter(Mandatory = $true)] [scriptblock]$GetJson,
        [string]$GameDomain = 'fallout76',
        [string]$GameModId = '4082'
    )

    $response = & $GetJson "/mod-files/$ModFileId/versions"
    if (@($response.data.versions | Where-Object { $_.category -eq 'old_version' }).Count -gt 0) {
        throw "Nexus group $ModFileId contains Old files. Move them to Archived manually before publishing."
    }
    $versions = @($response.data.versions) | Where-Object {
        $_.category -in @('main', 'update', 'optional', 'miscellaneous', 'archived')
    } | Sort-Object -Property @(
        @{ Expression = { if ($_.category -eq 'archived') { 1 } else { 0 } }; Descending = $false },
        @{ Expression = { [decimal]$_.position }; Descending = $true }
    )
    if ($versions.Count -eq 0) {
        throw "Nexus group $ModFileId has no existing version to copy a description from."
    }

    $listed = & $GetJson "/v1/games/$GameDomain/mods/$GameModId/files.json"
    $files = @($listed.files)
    foreach ($version in $versions) {
        $match = $files | Where-Object { [string]$_.file_id -eq [string]$version.game_scoped_id } | Select-Object -First 1
        if ($null -ne $match -and -not [string]::IsNullOrWhiteSpace([string]$match.description)) {
            return [string]$match.description
        }
    }
    throw "Could not read the existing Nexus description for group $ModFileId; upload cancelled."
}
