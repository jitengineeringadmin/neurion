; Neurion Node — Inno Setup installer.
; Build: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" neurion.iss
; Produces Output\NeurionNodeSetup.exe (per-user, no admin required).

#define AppName "Neurion Node"
#define AppVersion "0.1.0"
#define Publisher "Neurion"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\Neurion Node
DefaultGroupName=Neurion Node
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=NeurionNodeSetup
SetupIconFile=..\cmd\neurion-tray\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\neurion-tray.exe

[Files]
Source: "..\bin\neurion-tray.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\bin\neurion-node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\neurion-node.example.yaml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\Neurion Node"; Filename: "{app}\neurion-tray.exe"
Name: "{group}\Uninstall Neurion Node"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Neurion Node"; Filename: "{app}\neurion-tray.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start Neurion Node automatically at login"; GroupDescription: "Startup:"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "NeurionNode"; ValueData: """{app}\neurion-tray.exe"""; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\neurion-tray.exe"; Description: "Launch Neurion Node now"; Flags: nowait postinstall skipifsilent
