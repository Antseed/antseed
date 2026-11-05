; Install attribution (see src/main/telemetry/attribution.ts and
; apps/download-proxy/src/attribution.ts).
;
; The download proxy stamps a signed attribution token into the installer's
; filename. Two things happen here so that token reaches the app:
;
;  1. The installer's own filename ($EXEFILE) is written next to the
;     executable. The app reads it on first launch and reports milestones to
;     the proxy under the same GA4 identity as the download.
;  2. A fire-and-forget beacon tells the proxy the installer actually ran
;     (`installer_started`), which separates "download finished but the
;     installer was never run or was blocked" from "installer ran, app never
;     launched". curl.exe ships with Windows 10 1803+; on older systems the
;     command silently fails and nothing else changes.
;
; Neither step touches the signed installer bytes: the stamp lives in the
; filename only, so Authenticode verification is unaffected.

!macro customInstall
  FileOpen $0 "$INSTDIR\installer-name.txt" w
  IfErrors +3
  FileWrite $0 "$EXEFILE"
  FileClose $0
  ClearErrors
  nsExec::Exec 'curl.exe -s -m 5 -o NUL "https://download.antseed.com/i?f=$EXEFILE"'
  Pop $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\installer-name.txt"
!macroend
