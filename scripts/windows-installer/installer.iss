#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef NumericVersion
  #error NumericVersion is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif

[Setup]
AppId={{41A4B36D-24BE-4D42-9D59-3BCA77DECD41}
AppName=tscircuit Standalone
AppVersion={#AppVersion}
VersionInfoVersion={#NumericVersion}
AppPublisher=tscircuit
AppPublisherURL=https://tscircuit.com
DefaultDirName={localappdata}\Programs\tscircuit-standalone
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupArchitecture=x64
WizardStyle=modern dynamic windows11
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableDirPage=yes
OutputDir=.
OutputBaseFilename=tscircuit-standalone-windows-x64-setup
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
UninstallDisplayName=tscircuit Standalone
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PayloadDir}\tsci.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\tsci.exe"; DestDir: "{app}"; DestName: "tscircuit.exe"; Flags: ignoreversion
Source: "{#PayloadDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\THIRD_PARTY_NOTICES"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\licenses.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "setup.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Tasks]
Name: "replacecommands"; Description: "Use tscircuit standalone by running ""tscircuit"" or ""tsci"""; GroupDescription: "Existing tscircuit commands were found. Standalone will become the default for these commands; existing npm packages stay installed."; Flags: unchecked; Check: HasExternalCommands

[InstallDelete]
Type: files; Name: "{app}\tsci-standalone.exe"

[UninstallDelete]
Type: files; Name: "{app}\installer-state.json"
Type: files; Name: "{app}\installer-result.ini"

[Code]
var
  ExistingPaths: String;
  ExternalCommands: Boolean;
  CommandSetupOK: Boolean;

function PowerShellPath: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function HelperArgs(Mode: String): String;
begin
  Result := '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\setup.ps1') + '" -Mode ' + Mode +
    ' -InstallDir "' + ExpandConstant('{app}') + '"';
end;

function HasExternalCommands: Boolean;
begin
  Result := ExternalCommands;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if ExternalCommands and not WizardIsTaskSelected('replacecommands') then
    Result := 'Existing tscircuit commands were found. Confirm that standalone should become the default, or cancel setup. For unattended installation, explicitly pass /TASKS=replacecommands.';
end;

procedure InitializeWizard;
var
  ExitCode: Integer;
  Args, DetectionFile: String;
begin
  CommandSetupOK := False;
  ExtractTemporaryFile('setup.ps1');
  DetectionFile := ExpandConstant('{tmp}\detected.ini');
  Args := '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\setup.ps1') + '" -Mode Detect -InstallDir "' + WizardDirValue + '" -ResultFile "' + DetectionFile + '"';
  if not Exec(PowerShellPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    RaiseException('Setup could not check the existing tsci command. PowerShell could not be started.');
  if ExitCode <> 0 then
    RaiseException('Setup could not check the existing tsci command. No installation changes were made.');
  ExternalCommands := GetIniString('Detection', 'External', '0', DetectionFile) = '1';
  ExistingPaths := GetIniString('Detection', 'Paths', '', DetectionFile);
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo,
  MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := MemoDirInfo + NewLine + NewLine + MemoTasksInfo;
  if ExistingPaths <> '' then
    Result := Result + NewLine + NewLine + 'Existing tscircuit command(s):' + NewLine + Space + ExistingPaths;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Args: String;
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    Args := HelperArgs('Install') + ' -ResultFile "' + ExpandConstant('{app}\installer-result.ini') + '"';
    CommandSetupOK := Exec(PowerShellPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
    if CommandSetupOK then CommandSetupOK := ExitCode = 0;
    if not CommandSetupOK then
      if not WizardSilent then
        MsgBox('Files were installed, but command setup did not complete. Adjust the conflicting PATH entry or uninstall and retry.', mbError, MB_OK);

  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then begin
    if CommandSetupOK then
      WizardForm.FinishedLabel.Caption :=
        'tscircuit Standalone has been installed.' + #13#10#13#10 +
        'Use tscircuit standalone by running "tscircuit" or "tsci".' + #13#10#13#10 +
        'Open a new terminal first. You can check the installation with tsci --version.' + #13#10 +
        GetIniString('Result', 'Warning', '', ExpandConstant('{app}\installer-result.ini'))
    else
      WizardForm.FinishedLabel.Caption :=
        'Files were installed, but command setup did not complete. Adjust the conflicting PATH entry or uninstall and retry.';
  end;
end;

function InitializeUninstall: Boolean;
var
  ExitCode: Integer;
begin
  Result := Exec(PowerShellPath, HelperArgs('Uninstall'), '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if Result then Result := ExitCode = 0;
  if not Result then
    if not UninstallSilent then
      MsgBox('Command cleanup did not complete. Uninstallation has stopped so you can retry.', mbError, MB_OK);
end;

function GetCustomSetupExitCode: Integer;
begin
  if CommandSetupOK then Result := 0 else Result := 1;
end;
