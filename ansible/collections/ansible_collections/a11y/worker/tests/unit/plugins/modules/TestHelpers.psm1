# Load a module's own FUNCTION DEFINITIONS from its real source, without running the module.
#
# Every plugin in ../../../plugins/modules opens with `$module = [Ansible.Basic.AnsibleModule]::Create(...)`
# at the top level -- correct for a script Ansible's exec wrapper runs on a Windows target, and fatal
# anywhere else: `Ansible.Basic.cs` itself references `System.Web.Script.Serialization`, a .NET Framework
# assembly that does not exist under .NET Core, so `Ansible.Basic.AnsibleModule` cannot be loaded on macOS
# or Linux pwsh at all. Verified by trying: `Add-Type -Path Ansible.Basic.cs` fails with
# `CS0234: The type or namespace name 'Script' does not exist in the namespace 'System.Web'`.
#
# So a module's file cannot be dot-sourced whole off Windows. What CAN run anywhere is a plain PowerShell
# function that never touches $module -- several of these files already have exactly one (Get-NvdaState,
# Get-AcTimeout), because the author separated "read the world" from "decide, using AnsibleModule" for
# reasons that had nothing to do with testing. This file extracts those functions from the PARSED AST of
# the real .ps1 and dot-sources their literal text -- never a hand-copied restatement, which is the "two
# copies of one fact, and they drifted" shape this whole repo keeps finding in other languages. A test
# built against a paraphrase of the function proves the paraphrase works, not the shipped file.
# Returns the scriptblock rather than dot-sourcing it ITSELF: a `.` inside this function only defines
# things in this function's own scope, which is gone the moment it returns -- proven by mutation, not
# assumed (a first version of this helper dot-sourced internally and every test using it "passed" by
# never finding the function at all, since Pester's `{ Get-NvdaState ... } | Should -Throw` reads a
# missing command as an exception too). The CALLER must dot-source the return value in ITS OWN scope
# (a Pester `BeforeAll` block, which is exactly where these tests do it).
function Get-ModuleFunctionScriptBlock {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [string] $Name
    )
    if (-not (Test-Path -LiteralPath $Path)) { throw "no such module file: $Path" }
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) {
        throw "parse error(s) in ${Path}: $($parseErrors -join '; ')"
    }
    $found = $ast.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    $match = $found | Where-Object { $_.Name -eq $Name }
    if (-not $match) {
        throw "function '$Name' not found in $Path -- named explicitly so a rename here fails loudly " +
            "rather than silently testing nothing"
    }
    # The function's own text, taken verbatim from the file's AST -- never retyped, so this can never
    # drift into testing a paraphrase of the shipped code instead of the code itself.
    return [scriptblock]::Create($match.Extent.Text)
}

Export-ModuleMember -Function Get-ModuleFunctionScriptBlock
