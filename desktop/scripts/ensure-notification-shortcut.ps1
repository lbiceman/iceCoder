# Create Start Menu shortcut and set AppUserModelID for Windows toast header icon.
# Uses icon.ico generated from src/public/icons/logo.png (same as the homepage brand mark).
param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$IconLocation,
    [Parameter(Mandatory = $true)][string]$AppUserModelId,
    [Parameter(Mandatory = $true)][string]$Description
)

$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $ShortcutPath
if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.IconLocation = $IconLocation
$Shortcut.Description = $Description
$Shortcut.Save()

$typeName = 'IceCoderShortcutAppIdHelper'
if (-not ([System.Management.Automation.PSTypeName]$typeName).Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport(), Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile
{
    void GetClassID(out Guid pClassID);
    void IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile(out string ppszFileName);
}

[ComImport(), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore
{
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PropertyKey pkey);
    void GetValue(ref PropertyKey key, out PropVariant pv);
    void SetValue(ref PropertyKey key, ref PropVariant pv);
    void Commit();
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey
{
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport(), Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLinkCo { }

public static class IceCoderShortcutAppIdHelper
{
    [DllImport("ole32.dll")]
    public static extern int PropVariantClear(ref PropVariant pvar);

    public static void SetAppUserModelId(string shortcutPath, string appId)
    {
        var link = (IPersistFile)(new ShellLinkCo());
        link.Load(shortcutPath, 2);
        var propertyStore = (IPropertyStore)link;
        var key = new PropertyKey
        {
            fmtid = new Guid("9F4C2855-9F79-4F39-A8D0-E1D42DE1D5F3"),
            pid = 5
        };
        var pv = new PropVariant();
        pv.vt = 31;
        pv.pointerValue = Marshal.StringToCoTaskMemUni(appId);
        propertyStore.SetValue(ref key, ref pv);
        propertyStore.Commit();
        PropVariantClear(ref pv);
        link.Save(shortcutPath, true);
    }
}
"@ -Language CSharp
}

[IceCoderShortcutAppIdHelper]::SetAppUserModelId($ShortcutPath, $AppUserModelId)

$iconFile = ($IconLocation -split ',')[0]
$regKey = "Registry::HKEY_CURRENT_USER\Software\Classes\AppUserModelId\$AppUserModelId"
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name 'DisplayName' -Value $Description
Set-ItemProperty -Path $regKey -Name 'IconUri' -Value $iconFile

Write-Output 'OK'
