# Windows Security and Defender Notes

ChessRabbit should be distributed in a way that is transparent and easy for Windows security tools to inspect. Do not try to bypass Microsoft Defender, SmartScreen or antivirus products.

## Why Windows may warn

Windows can warn for two different reasons:

- **SmartScreen reputation warning:** common for new unsigned apps, even when they are clean. Reputation improves after releases are code-signed and downloaded by more users without reports.
- **Defender malware detection:** a stronger warning that should be investigated before promoting the release.

The current release is built from public source and publishes checksums, corresponding source and third-party notices. A warning can still happen because the installer is unsigned and includes a frozen Python backend plus bundled engine/database binaries.

## Release requirements

Before publishing or promoting a Windows installer:

1. Build on GitHub Actions or another clean Windows machine.
2. Run the installed app smoke test.
3. Run Microsoft Defender on the installer and unpacked app output.
4. Publish SHA-256 checksums beside the installer.
5. Publish corresponding source and third-party notices beside the installer.
6. Sign the installer and app when a certificate is available.
7. If Defender reports malware, stop the release and submit the file to Microsoft for analysis.

## Code signing

Code signing identifies the publisher; it does not guarantee that Windows will stop showing warnings. The build workflow passes the optional repository secrets `CSC_LINK` and `CSC_KEY_PASSWORD` to Electron Builder. Configure them with a trusted signing certificate when available, or integrate a secure signing service. Builds without signing credentials remain unsigned. Never commit a certificate or password to the repository.

After signing, verify the release on Windows:

```powershell
Get-AuthenticodeSignature .\dist\windows\ChessRabbit-Setup.exe
Get-FileHash .\dist\windows\ChessRabbit-Setup.exe -Algorithm SHA256
```

## Microsoft false-positive submission

The release workflow updates Defender signatures and scans both the installer and unpacked app before running installation tests. A missing scanner, failed scan or detection blocks publication and artifact upload. It uses Microsoft's [documented custom scan mode](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus) to inspect archives and ignore file exclusions. Passing this scan is evidence for that build and signature version, not a guarantee against all threats or future detections.

If Defender detects the installer or app as malware and you believe it is a false positive, submit the exact file to Microsoft Security Intelligence:

https://www.microsoft.com/en-us/wdsi/filesubmission

Include the GitHub release URL, SHA-256 checksum, source code URL and a short explanation that ChessRabbit is an Electron desktop app with a PyInstaller backend, local PostgreSQL runtime and Stockfish chess engine.

## What ChessRabbit should not do

ChessRabbit should not:

- Disable Defender, firewall or SmartScreen.
- Ask users to turn off antivirus.
- Download executable code at runtime without explicit user action.
- Hide processes, inject into other programs, mine crypto or install services silently.
- Run local engines chosen by the browser directly. Engine executable paths must come from trusted local desktop UI selection.
