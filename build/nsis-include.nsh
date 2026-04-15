; Custom NSIS include for LatentMail — registers as a Windows mail client
; so the app appears in Settings > Default Apps > Email on Windows 10/11.

!macro customInstall
  ; 1. Create a ProgId for the mailto URL handler
  WriteRegStr SHCTX "Software\Classes\LatentMail.Url.mailto" "" "LatentMail URL"
  WriteRegStr SHCTX "Software\Classes\LatentMail.Url.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\LatentMail.Url.mailto\DefaultIcon" "" "$INSTDIR\LatentMail.exe,0"
  WriteRegStr SHCTX "Software\Classes\LatentMail.Url.mailto\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\LatentMail.Url.mailto\shell\open\command" "" '"$INSTDIR\LatentMail.exe" "%1"'

  ; 2. Register as a mail client (Clients\Mail — the Email category in Default Apps)
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail" "" "LatentMail"
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail\DefaultIcon" "" "$INSTDIR\LatentMail.exe,0"
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail\shell\open\command" "" '"$INSTDIR\LatentMail.exe"'

  ; 3. Declare application capabilities under the mail client key
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail\Capabilities" "ApplicationName" "LatentMail"
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail\Capabilities" "ApplicationDescription" "Desktop email client with AI integration"
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail\Capabilities" "ApplicationIcon" "$INSTDIR\LatentMail.exe,0"
  WriteRegStr SHCTX "Software\Clients\Mail\LatentMail\Capabilities\URLAssociations" "mailto" "LatentMail.Url.mailto"

  ; 4. Add to RegisteredApplications (Windows 10/11 Default Apps reads this list)
  WriteRegStr SHCTX "Software\RegisteredApplications" "LatentMail" "Software\Clients\Mail\LatentMail\Capabilities"

  ; 5. Notify the shell that file associations have changed
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Remove mail client registration
  DeleteRegKey SHCTX "Software\Classes\LatentMail.Url.mailto"
  DeleteRegKey SHCTX "Software\Clients\Mail\LatentMail"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "LatentMail"

  ; Notify the shell that file associations have changed
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
