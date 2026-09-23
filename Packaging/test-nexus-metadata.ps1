$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'nexus-file-metadata.ps1')

$description = Get-NexusExistingDescription -ModFileId 'group-a' -GetJson {
    param($path)
    if ($path -eq '/mod-files/group-a/versions') {
        return @{ data = @{ versions = @(
            @{ category = 'archived'; position = '9'; game_scoped_id = '99' },
            @{ category = 'main'; position = '3'; game_scoped_id = '33' },
            @{ category = 'main'; position = '2'; game_scoped_id = '22' }
        ) } }
    }
    if ($path -eq '/v1/games/fallout76/mods/4082/files.json') {
        return @{ files = @(
            @{ file_id = 22; description = 'Existing approved description' },
            @{ file_id = 99; description = 'Archived description' }
        ) }
    }
    throw "Unexpected path: $path"
}
if ($description -ne 'Existing approved description') { throw 'Did not retain the existing active description' }

$fallback = Get-NexusExistingDescription -ModFileId 'group-archive' -GetJson {
    param($path)
    if ($path -like '*/versions') {
        return @{ data = @{ versions = @(
            @{ category = 'main'; position = '3'; game_scoped_id = '33' },
            @{ category = 'archived'; position = '2'; game_scoped_id = '22' }
        ) } }
    }
    return @{ files = @(@{ file_id = 22; description = 'Previous Nexus description' }) }
}
if ($fallback -ne 'Previous Nexus description') { throw 'Did not fall back to a prior Nexus description' }

$failed = $false
try {
    Get-NexusExistingDescription -ModFileId 'group-b' -GetJson {
        param($path)
        if ($path -like '*/versions') {
            return @{ data = @{ versions = @(@{ category = 'main'; position = '1'; game_scoped_id = '1' }) } }
        }
        return @{ files = @() }
    } | Out-Null
} catch { $failed = $true }
if (-not $failed) { throw 'Missing Nexus description must block upload' }

$failed = $false
try {
    Get-NexusExistingDescription -ModFileId 'group-c' -GetJson {
        param($path)
        if ($path -like '*/versions') {
            return @{ data = @{ versions = @(
                @{ category = 'main'; position = '2'; game_scoped_id = '2' },
                @{ category = 'old_version'; position = '1'; game_scoped_id = '1' }
            ) } }
        }
        throw 'The Old files check should run before the v1 lookup'
    } | Out-Null
} catch { $failed = $_.Exception.Message -like '*Old files*' }
if (-not $failed) { throw 'Old files must block publish until manually archived' }
Write-Output 'Nexus metadata tests passed'
